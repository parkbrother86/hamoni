// Staff post drafts: write once in Korean, preview the translations, publish
// to the same menu in all four languages.
//
// Flow (channel "draft" in data/forums.json → "staff": { "draft": "<id>" }):
//   1. A staff member (Manage Server) writes a Korean post in the draft channel.
//      For a forum target the first line "제목: ..." is the post title.
//   2. The bot answers with a preview: the three translations (quality model,
//      in parallel), a menu to pick where it goes, and buttons
//      [게시] [다시 번역] [취소].
//   3. [게시] posts the Korean text and the translations under the writer's
//      name into the chosen menu of all four languages. Forum posts are linked
//      as a thread group, so comments are translated like any other post.
//   4. Editing the draft after publishing re-translates and edits all copies.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  MessageFlags,
  PermissionFlagsBits,
  AttachmentBuilder,
} = require('discord.js');

const forums = require('./forums');
const { getWebhook } = require('./webhook');

const LANG_FLAG = { kr: '🇰🇷', en: '🇺🇸', jp: '🇯🇵', cn: '🇨🇳' };
const TARGETS = [
  { value: 'announce', label: '📢 공지사항', type: 'channel' },
  { value: 'roadmap', label: '🗺 로드맵', type: 'channel' },
  { value: 'rules', label: '📜 커뮤니티규칙', type: 'channel' },
  { value: 'devnotes', label: '🛠 개발노트', type: 'forum' },
  { value: 'technotes', label: '🔧 기술노트', type: 'forum' },
];
const OTHER = ['en', 'jp', 'cn'];

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'drafts.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS drafts (
    draft_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    preview_id TEXT,
    target TEXT,
    state TEXT NOT NULL,          -- preview | published | cancelled
    data TEXT NOT NULL,           -- JSON: { title, body, tr: {lang: {title, body}}, posted: {lang: {channelId, threadId, ids[]}} }
    updated INTEGER NOT NULL
  );
`);
const stmtGet = db.prepare('SELECT * FROM drafts WHERE draft_id = ?');
const stmtByPreview = db.prepare('SELECT * FROM drafts WHERE preview_id = ?');
const stmtPut = db.prepare(
  'INSERT OR REPLACE INTO drafts VALUES (@draft_id, @channel_id, @preview_id, @target, @state, @data, @updated)'
);
const load = (row) => (row ? { ...row, data: JSON.parse(row.data) } : null);
const save = (d) => stmtPut.run({ ...d, data: JSON.stringify(d.data), updated: Date.now() });

function draftChannelId() {
  return forums.staffConfig().draft || null;
}

function isStaff(memberPermissions) {
  return Boolean(memberPermissions?.has(PermissionFlagsBits.ManageGuild));
}

// "제목: ..." on the first line is the title; the rest is the body.
function parseDraft(content) {
  const text = (content || '').trim();
  const m = text.match(/^제목\s*[:：]\s*(.+)\n?([\s\S]*)$/);
  if (m) return { title: m[1].trim(), body: m[2].trim() };
  const firstLine = text.split('\n')[0].replace(/^#+\s*/, '').trim();
  return { title: firstLine.slice(0, 100), body: text };
}

function splitForDiscord(text) {
  return require('./relay').splitForDiscord(text);
}

async function translateAll(draft, { noCache = false } = {}) {
  const { translateText } = require('./translator');
  const out = {};
  await Promise.all(
    OTHER.map(async (lang) => {
      const [title, body] = await Promise.all([
        draft.title ? translateText(draft.title, 'kr', lang, null, { quality: true, noCache }) : '',
        draft.body ? translateText(draft.body, 'kr', lang, null, { quality: true, noCache }) : '',
      ]);
      out[lang] = { title: title.slice(0, 100), body };
    })
  );
  return out;
}

function previewPayload(d) {
  const t = TARGETS.find((x) => x.value === d.target);
  const posted = d.state === 'published';
  const embeds = [
    new EmbedBuilder()
      .setTitle(posted ? '✅ 게시됨' : d.state === 'cancelled' ? '✖️ 취소됨' : '📝 번역 미리보기')
      .setColor(posted ? 0x2ecc71 : d.state === 'cancelled' ? 0x95a5a6 : 0x3498db)
      .setDescription(
        [
          `게시할 곳: **${t ? t.label : '아래에서 고르세요'}**`,
          t?.type === 'forum' ? `포럼 제목: **${d.data.title || '—'}**` : '',
          posted
            ? Object.entries(d.data.posted || {})
                .map(([l, p]) => `${LANG_FLAG[l]} <#${p.threadId || p.channelId}>`)
                .join(' · ')
            : '전체 번역은 첨부 파일에 있습니다. 원문을 고치면 다시 번역합니다.',
        ]
          .filter(Boolean)
          .join('\n')
      ),
    ...OTHER.map((lang) => {
      const tr = d.data.tr?.[lang];
      const body = tr?.body || '(번역 중…)';
      return new EmbedBuilder()
        .setTitle(`${LANG_FLAG[lang]} ${tr?.title || ''}`.slice(0, 256))
        .setDescription(body.length > 1200 ? `${body.slice(0, 1200)}…` : body);
    }),
  ];
  const files = d.data.tr
    ? [
        new AttachmentBuilder(
          Buffer.from(
            OTHER.map((l) => `## ${l}\n${d.data.tr[l].title}\n\n${d.data.tr[l].body}`).join('\n\n---\n\n'),
            'utf8'
          ),
          { name: 'translations.md' }
        ),
      ]
    : [];
  const components =
    d.state === 'preview'
      ? [
          new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(`draft|target|${d.draft_id}`)
              .setPlaceholder('게시할 곳')
              .addOptions(TARGETS.map((x) => ({ label: x.label, value: x.value, default: x.value === d.target })))
          ),
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`draft|publish|${d.draft_id}`).setLabel('게시').setStyle(ButtonStyle.Success).setDisabled(!d.target || !d.data.tr),
            new ButtonBuilder().setCustomId(`draft|retranslate|${d.draft_id}`).setLabel('다시 번역').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`draft|cancel|${d.draft_id}`).setLabel('취소').setStyle(ButtonStyle.Danger)
          ),
        ]
      : [];
  return { embeds, components, files, allowedMentions: { parse: [] } };
}

async function refreshPreview(client, d) {
  const ch = await client.channels.fetch(d.channel_id);
  const msg = await ch.messages.fetch(d.preview_id);
  await msg.edit({ ...previewPayload(d), attachments: [] });
}

async function handleDraftMessage(message) {
  try {
    if (message.author?.bot || message.webhookId) return;
    if (!draftChannelId() || message.channelId !== draftChannelId()) return;
    if (!isStaff(message.member?.permissions)) return;
    if (!message.content?.trim() && !message.attachments?.size) return;

    const parsed = parseDraft(message.content);
    const d = {
      draft_id: message.id,
      channel_id: message.channelId,
      preview_id: null,
      target: null,
      state: 'preview',
      data: { ...parsed, tr: null, posted: null },
    };
    const preview = await message.reply(previewPayload(d));
    d.preview_id = preview.id;
    save(d);
    d.data.tr = await translateAll(parsed);
    save(d);
    await refreshPreview(message.client, d);
  } catch (err) {
    console.error('drafts: new draft failed —', err?.message || err);
  }
}

function attachmentUrls(msg) {
  return msg?.attachments?.size ? [...msg.attachments.values()].map((a) => a.url) : [];
}

function authorOf(member, user) {
  return {
    username: (member?.displayName || user.globalName || user.username).slice(0, 80),
    avatarURL: (member || user).displayAvatarURL({ extension: 'png', size: 128 }),
  };
}

// Post one language copy. Returns { channelId, threadId, ids }.
async function postCopy(client, target, lang, { title, body }, files, who) {
  const t = TARGETS.find((x) => x.value === target);
  const destId =
    t.type === 'forum' ? forums.GROUPS()[target]?.forums[lang] : forums.staffChannelIds(target)?.[lang];
  if (!destId) throw new Error(`no ${lang} channel for ${target}`);
  const dest = await client.channels.fetch(destId);
  const webhook = await getWebhook(dest);
  const parts = splitForDiscord(body || '');
  const ids = [];
  let threadId;
  for (const [i, part] of parts.entries()) {
    const opts = { content: part || '​', username: who.username, avatarURL: who.avatarURL, allowedMentions: { parse: [] } };
    if (i === 0 && files.length) opts.files = files;
    if (t.type === 'forum') {
      if (threadId) opts.threadId = threadId;
      else opts.threadName = (title || 'Post').slice(0, 100);
    }
    const m = await webhook.send(opts);
    if (t.type === 'forum' && !threadId) threadId = m.channelId;
    ids.push(m.id);
  }
  return { channelId: destId, threadId: threadId || null, ids };
}

async function publish(interaction, d) {
  const draftMsg = await (await interaction.client.channels.fetch(d.channel_id)).messages.fetch(d.draft_id).catch(() => null);
  const who = authorOf(draftMsg?.member, draftMsg?.author || interaction.user);
  const files = attachmentUrls(draftMsg);
  const copies = { kr: { title: d.data.title, body: d.data.body }, ...d.data.tr };
  const posted = {};
  await Promise.all(
    forums.LANGS.map(async (lang) => {
      posted[lang] = await postCopy(interaction.client, d.target, lang, copies[lang], files, who);
    })
  );
  const t = TARGETS.find((x) => x.value === d.target);
  if (t.type === 'forum') {
    forums.saveThreadGroup({
      group: d.target,
      originLang: 'kr',
      threads: Object.fromEntries(forums.LANGS.map((l) => [l, posted[l].threadId])),
    });
  }
  d.data.posted = posted;
  d.state = 'published';
  save(d);
}

// Re-translate an edited draft and edit every published copy.
async function updatePublished(client, d) {
  d.data.tr = await translateAll(d.data);
  const copies = { kr: { title: d.data.title, body: d.data.body }, ...d.data.tr };
  await Promise.all(
    forums.LANGS.map(async (lang) => {
      const p = d.data.posted[lang];
      if (!p) return;
      const dest = await client.channels.fetch(p.channelId);
      const webhook = await getWebhook(dest);
      const parts = splitForDiscord(copies[lang].body || '');
      for (let i = 0; i < Math.max(parts.length, p.ids.length); i++) {
        const extra = p.threadId ? { threadId: p.threadId } : {};
        if (i < p.ids.length) {
          await webhook.editMessage(p.ids[i], { content: parts[i] || '​', allowedMentions: { parse: [] }, ...extra });
        } else {
          const m = await webhook.send({ content: parts[i], allowedMentions: { parse: [] }, ...extra });
          p.ids.push(m.id);
        }
      }
      if (p.threadId && copies[lang].title) {
        const th = await client.channels.fetch(p.threadId);
        if (th.name !== copies[lang].title) await th.setName(copies[lang].title.slice(0, 100));
      }
    })
  );
  save(d);
}

async function handleDraftEdit(oldMessage, newMessage) {
  try {
    if (!draftChannelId() || newMessage.channelId !== draftChannelId()) return;
    if (newMessage.partial) newMessage = await newMessage.fetch();
    const d = load(stmtGet.get(newMessage.id));
    if (!d || d.state === 'cancelled') return;
    if (oldMessage && !oldMessage.partial && oldMessage.content === newMessage.content) return;
    Object.assign(d.data, parseDraft(newMessage.content));
    if (d.state === 'published') {
      await updatePublished(newMessage.client, d);
      console.log(`drafts: republished edit ${d.draft_id}`);
    } else {
      d.data.tr = null;
      save(d);
      await refreshPreview(newMessage.client, d);
      d.data.tr = await translateAll(d.data);
      save(d);
    }
    await refreshPreview(newMessage.client, d);
  } catch (err) {
    console.error('drafts: edit failed —', err?.message || err);
  }
}

// draft|<action>|<draftId>
async function handleDraftInteraction(interaction) {
  const [, action, draftId] = interaction.customId.split('|');
  if (!isStaff(interaction.memberPermissions)) {
    await interaction.reply({ content: '서버 관리 권한이 필요합니다.', flags: MessageFlags.Ephemeral });
    return;
  }
  const d = load(stmtGet.get(draftId));
  if (!d || d.state !== 'preview') {
    await interaction.reply({ content: '이미 처리된 초안입니다.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (action === 'target') {
    d.target = interaction.values[0];
    save(d);
    await interaction.update(previewPayload(d));
    return;
  }
  if (action === 'cancel') {
    d.state = 'cancelled';
    save(d);
    await interaction.update(previewPayload(d));
    return;
  }
  if (action === 'retranslate') {
    await interaction.deferUpdate();
    d.data.tr = null;
    save(d);
    await refreshPreview(interaction.client, d);
    d.data.tr = await translateAll(d.data, { noCache: true });
    save(d);
    await refreshPreview(interaction.client, d);
    return;
  }
  if (action === 'publish') {
    if (!d.target || !d.data.tr) {
      await interaction.reply({ content: '게시할 곳을 고르고 번역이 끝난 뒤에 눌러 주세요.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferUpdate();
    try {
      await publish(interaction, d);
      console.log(`drafts: published ${d.draft_id} to ${d.target}`);
    } catch (err) {
      console.error('drafts: publish failed —', err?.message || err);
      await interaction.followUp({ content: `게시 중 오류: ${err?.message || err}`, flags: MessageFlags.Ephemeral });
    }
    await refreshPreview(interaction.client, d);
    return;
  }
}

module.exports = {
  handleDraftMessage,
  handleDraftEdit,
  handleDraftInteraction,
  parseDraft,
};
