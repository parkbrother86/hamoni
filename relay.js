const {
  CHANNELS,
  LANG_BY_CHANNEL_ID,
  SOURCE_LANG_FLAG,
  MAX_MESSAGE_LENGTH,
  DISCORD_MESSAGE_LIMIT,
} = require('./config');
const forums = require('./forums');
const {
  sanitizeDiscordText,
  isTranslatable,
  detectScript,
  renderMentions,
  preprocessForTranslation,
  postprocessTranslation,
} = require('./text');
const { translateText } = require('./translator');
const { getWebhook } = require('./webhook');
const {
  recordRelay,
  getRelays,
  removeRelays,
  markDeleted,
  wasDeleted,
} = require('./store');
const stats = require('./stats');
const corpusLog = require('./corpus_log');
const contextBuffer = require('./context');
const moderation = require('./moderation');
const modlog = require('./modlog');
const cooldown = require('./cooldown');
const campaign = require('./campaign');
const { MODERATION } = require('./config');

// Passive per-message pre-screen. Fired non-blocking so it never adds latency
// to the translation relay. High-confidence flags go to mod-log for human
// review only — the prescreen NEVER deletes or punishes (that is the report +
// reasoner path). Failures are swallowed.
function firePrescreen(message, rendered) {
  if (!MODERATION.prescreenEnabled) return;
  if (!rendered) return;
  moderation
    .prescreen(rendered)
    .then((result) => {
      if (!result?.suspect) return;
      stats.increment('prescreenFlags');
      const displayName =
        message.member?.displayName ||
        message.author?.globalName ||
        message.author?.username;
      return modlog.postPrescreenFlag(message.client, {
        authorTag: message.author?.tag || displayName,
        authorId: message.author?.id,
        channelName: message.channel?.name,
        ruleId: result.ruleId,
        content: rendered,
        // Without these the card is unactionable: no message to delete, no
        // link to read it in situ, and no target for a second-pass judgment.
        guildId: message.guildId,
        channelId: message.channel?.id,
        messageId: message.id,
      });
    })
    .catch(() => {});
}

const MAX_INFLIGHT_PER_USER = 5;
const userInFlight = new Map();

const LONG_NOTICE = {
  kr: '메시지가 너무 길어 번역되지 않았습니다',
  en: 'Message too long to translate',
  jp: 'メッセージが長すぎて翻訳されません',
  cn: '消息过长,未翻译',
};

function getDisplayInfo(message) {
  const displayName =
    message.member?.displayName ||
    message.author.globalName ||
    message.author.username;

  const avatarURL =
    message.member?.displayAvatarURL?.({
      extension: 'png',
      size: 128,
    }) ||
    message.author.displayAvatarURL({
      extension: 'png',
      size: 128,
    });

  return { displayName, avatarURL };
}

function buildJumpLink(message) {
  if (!message.guildId) return null;
  return `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`;
}

// Split text into Discord-sized parts at paragraph, then line, boundaries.
function splitForDiscord(text, max = DISCORD_MESSAGE_LIMIT - 10) {
  if (!text || text.length <= max) return [text || ''];
  const parts = [];
  let cur = '';
  const push = (piece, sep) => {
    const next = cur ? cur + sep + piece : piece;
    if (next.length <= max) {
      cur = next;
      return;
    }
    if (cur) parts.push(cur);
    cur = piece;
  };
  for (const para of text.split('\n\n')) {
    if (para.length <= max) {
      push(para, '\n\n');
      continue;
    }
    for (const line of para.split('\n')) {
      if (line.length <= max) push(line, '\n');
      else for (let i = 0; i < line.length; i += max) push(line.slice(i, i + max), '');
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

// Where a relay goes: a text channel, or a thread (sent through its parent
// forum's webhook with threadId).
async function getSink(client, targetChannelId) {
  const ch = await client.channels.fetch(targetChannelId);
  if (ch.isThread?.()) {
    const parent = ch.parent || (await client.channels.fetch(ch.parentId));
    return { webhook: await getWebhook(parent), threadId: ch.id, channel: ch };
  }
  return { webhook: await getWebhook(ch), threadId: undefined, channel: ch };
}

// Map a thread's applied tags to another forum by tag position. The four
// language forums of a group keep their tags in the same order.
function mapTags(sourceForum, targetForum, appliedTagIds) {
  const src = sourceForum?.availableTags || [];
  const dst = targetForum?.availableTags || [];
  return (appliedTagIds || [])
    .map((id) => src.findIndex((t) => t.id === id))
    .filter((i) => i >= 0 && i < dst.length)
    .map((i) => dst[i].id);
}

// Resolve how a message should be relayed.
//   chat:    one of the four translation chat channels
//   newpost: the first message of a new post in a grouped forum
//   comment: a message in a post that already has mirrors
function resolveRoute(message) {
  const channel = message.channel;
  const chatLang = LANG_BY_CHANNEL_ID[channel.id];
  if (chatLang) {
    const targets = Object.entries(CHANNELS)
      .filter(([l]) => l !== chatLang)
      .map(([lang, id]) => ({ lang, id }));
    return { mode: 'chat', sourceLang: chatLang, targets };
  }
  const staff = forums.staffChannel(channel.id);
  if (staff) {
    return { mode: 'staff', sourceLang: staff.lang, targets: staff.targets };
  }
  if (!channel.isThread?.()) return null;
  const finfo = forums.forumInfo(channel.parentId);
  if (!finfo) return null;
  const row = forums.findThreadGroup(channel.id);
  if (!row) {
    if (message.id !== channel.id) return null; // old post without mirrors
    return { mode: 'newpost', sourceLang: finfo.lang, finfo, targets: [] };
  }
  const sourceLang = forums.langOfThread(row, channel.id);
  const targets = forums.LANGS.filter((l) => l !== sourceLang && row[l]).map(
    (lang) => ({ lang, id: row[lang] })
  );
  return { mode: 'comment', sourceLang, finfo, row, targets };
}

function getAttachmentUrls(message) {
  if (!message.attachments?.size) return [];
  return Array.from(message.attachments.values()).map(
    (a) => a.url
  );
}

// Best-effort: fetch the source message this one is replying to, so the
// translator can resolve referents/addressee. Returns null on any failure.
async function fetchReplyContext(message) {
  const ref = message.reference;
  if (!ref?.messageId) return null;
  try {
    const channel =
      ref.channelId && ref.channelId !== message.channel.id
        ? await message.client.channels.fetch(ref.channelId)
        : message.channel;
    const refMsg = await channel.messages.fetch(ref.messageId);
    if (refMsg.webhookId) return null;
    if (!refMsg.content?.trim()) return null;
    const name =
      refMsg.member?.displayName ||
      refMsg.author?.globalName ||
      refMsg.author?.username ||
      'user';
    const text = contextBuffer.sanitizeLine(
      renderMentions(refMsg.content, refMsg)
    );
    if (!text) return null;
    return { name: contextBuffer.sanitizeName(name), text };
  } catch {
    return null;
  }
}

function buildContextText(entries, replyEntry) {
  const lines = [];
  if (replyEntry) {
    lines.push(`[in reply to] ${replyEntry.name}: ${replyEntry.text}`);
  }
  for (const e of entries) {
    lines.push(`${e.name}: ${e.text}`);
  }
  return lines.join('\n');
}

async function buildTranslatedBody({
  message,
  rendered,
  sourceLang,
  targetLang,
  isLong,
  hasContent,
  contextText,
  targetSpeaker,
  quality,
}) {
  if (!hasContent) return '';

  if (isLong) {
    return `${sanitizeDiscordText(rendered)}\n-# ${LONG_NOTICE[targetLang]}`;
  }

  if (!isTranslatable(rendered)) {
    return sanitizeDiscordText(rendered);
  }

  if (detectScript(rendered) === targetLang) {
    return sanitizeDiscordText(rendered);
  }

  const { processed, tokens } = preprocessForTranslation(
    message.content,
    message,
    sourceLang
  );
  const translated = await translateText(
    processed,
    sourceLang,
    targetLang,
    { contextText, targetSpeaker },
    { quality }
  );
  return postprocessTranslation(translated, tokens, targetLang);
}

function composeFinalContent({
  translated,
  message,
  targetChannelId,
  jumpLink,
  hasContent,
}) {
  let out = translated;

  if (message.reference?.messageId) {
    const refRelays = getRelays(
      message.reference.channelId || message.channelId,
      message.reference.messageId
    );
    const match = refRelays.find(
      (r) => r.targetChannelId === targetChannelId
    );
    if (match?.snippet) {
      out = out
        ? `> ${match.snippet}\n${out}`
        : `> ${match.snippet}`;
    }
  }

  if (hasContent && jumpLink) {
    out = out
      ? `${out} [[⤴]](${jumpLink})`
      : `[[⤴]](${jumpLink})`;
  }

  return out;
}

// Send a relay as one or more parts. Attachments ride on the last part, or on
// the first when the send creates a new forum post (the starter message is the
// post's preview). Returns the sent messages in order.
async function sendRelay({
  webhook,
  threadId,
  webhookName,
  avatarURL,
  content,
  attachmentUrls,
  threadName,
  appliedTags,
}) {
  const parts = splitForDiscord(content);
  const sent = [];
  let tid = threadId;
  for (const [i, part] of parts.entries()) {
    const opts = {
      content: part,
      username: webhookName,
      avatarURL,
      allowedMentions: { parse: [] },
    };
    const filesHere = threadName ? i === 0 : i === parts.length - 1;
    if (filesHere && attachmentUrls.length > 0) opts.files = attachmentUrls;
    if (tid) opts.threadId = tid;
    else if (threadName) {
      opts.threadName = threadName.slice(0, 100);
      if (appliedTags?.length) opts.appliedTags = appliedTags;
    }
    if (!opts.content && !opts.files) continue;
    const msg = await webhook.send(opts);
    if (!tid && threadName) tid = msg.channelId;
    sent.push(msg);
  }
  return { sent, threadId: tid };
}

async function relayToTarget({
  message,
  rendered,
  sourceLang,
  targetLang,
  targetChannelId,
  displayName,
  avatarURL,
  isLong,
  hasContent,
  attachmentUrls,
  jumpLink,
  contextText,
  targetSpeaker,
  quality,
  staff, // staff channel: post under the author's plain name, no back-link
  newPost, // { forumId, title, appliedTags } when creating a mirrored post
}) {
  const translated = await buildTranslatedBody({
    message,
    rendered,
    sourceLang,
    targetLang,
    isLong,
    hasContent,
    contextText,
    targetSpeaker,
    quality,
  });

  const finalContent = composeFinalContent({
    translated,
    message,
    targetChannelId,
    jumpLink: staff ? null : jumpLink,
    hasContent,
  });

  let sink;
  let threadName;
  if (newPost) {
    const forum = await message.client.channels.fetch(newPost.forumId);
    sink = { webhook: await getWebhook(forum), threadId: undefined };
    threadName = newPost.title
      ? await translateText(newPost.title, sourceLang, targetLang, null, { quality })
      : 'Post';
  } else {
    sink = await getSink(message.client, targetChannelId);
  }

  const sourceFlag = SOURCE_LANG_FLAG[sourceLang] || '🌐';
  const webhookName = staff
    ? displayName.slice(0, 80)
    : `[${sourceFlag}] ${displayName}`.slice(0, 80);

  const { sent, threadId } = await sendRelay({
    webhook: sink.webhook,
    threadId: sink.threadId,
    webhookName,
    avatarURL,
    content: finalContent,
    attachmentUrls,
    threadName,
    appliedTags: newPost?.appliedTags,
  });
  const relayChannelId = newPost ? threadId : targetChannelId;

  // Race-guard: if the source was deleted (e.g. Dyno auto-mod) while we were
  // translating, delete the relay we just sent instead of recording it.
  if (wasDeleted(message.channelId, message.id)) {
    try {
      if (newPost && threadId) {
        const th = await message.client.channels.fetch(threadId);
        await th.delete();
      } else {
        for (const m of sent) await sink.webhook.deleteMessage(m.id, sink.threadId);
      }
      stats.increment('deletesSync');
      console.log(
        `Source deleted during translation - removed relay ${sourceLang} -> ${targetLang} channel=${relayChannelId}`
      );
    } catch (err) {
      stats.increment('errors');
      console.error(
        `Tombstone cleanup failed channel=${relayChannelId}`,
        err?.message || err
      );
    }
    return null;
  }

  const snippet =
    (translated.split('\n')[0] || '').slice(0, 60) ||
    (attachmentUrls.length > 0 ? '(attachment)' : '');

  sent.forEach((m, part) =>
    recordRelay({
      sourceChannelId: message.channelId,
      sourceMessageId: message.id,
      targetChannelId: relayChannelId,
      webhookMessageId: m.id,
      snippet,
      authorId: message.author.id,
      targetLang,
      part,
    })
  );

  console.log(
    `Translated ${sourceLang} -> ${targetLang}: ${translated || '(attachment only)'}`
  );

  return { translated, threadId };
}

async function handleMessage(message) {
  try {
    if (message.author?.bot) return;
    if (message.webhookId) return;

    const hasContent = !!message.content?.trim();
    const hasAttachments = (message.attachments?.size || 0) > 0;
    if (!hasContent && !hasAttachments) return;

    const route = resolveRoute(message);
    if (!route) return;
    const { sourceLang, mode } = route;

    const userId = message.author.id;
    const inflight = userInFlight.get(userId) || 0;
    if (inflight >= MAX_INFLIGHT_PER_USER) {
      stats.increment('rateLimitDrops');
      console.log(
        `Rate limited user ${userId}: ${inflight} in flight`
      );
      return;
    }
    userInFlight.set(userId, inflight + 1);

    try {
      const rendered = hasContent
        ? renderMentions(message.content, message)
        : '';
      const isLong =
        hasContent && rendered.length > MAX_MESSAGE_LENGTH;
      const { displayName, avatarURL } = getDisplayInfo(message);
      const attachmentUrls = getAttachmentUrls(message);
      const jumpLink = buildJumpLink(message);
      // Staff notes posts use the quality model; comments and chat do not.
      const quality =
        mode === 'staff' || (mode === 'newpost' && route.finfo?.kind === 'notes');

      console.log(
        `[${sourceLang}${mode === 'chat' ? '' : ` ${mode}`}] ${displayName}: ${rendered || '(attachment)'}`
      );

      // Backward-looking context: prior source lines (+ reply target) shared
      // across all fan-out targets. Built before this message is added to the
      // buffer, so it never includes the line being translated.
      const replyEntry = await fetchReplyContext(message);
      const contextText = buildContextText(
        contextBuffer.recent(message.channel.id),
        replyEntry
      );
      const targetSpeaker = contextBuffer.sanitizeName(displayName);

      // New post: mirror it into the other three forums of the group.
      let targets = route.targets;
      let newPostFor = () => undefined;
      if (mode === 'newpost') {
        const group = forums.GROUPS()[route.finfo.group];
        const sourceForum = message.channel.parent ||
          (await message.client.channels.fetch(message.channel.parentId));
        const forumObjs = {};
        for (const l of forums.LANGS) {
          if (l === sourceLang) continue;
          forumObjs[l] = await message.client.channels.fetch(group.forums[l]);
        }
        targets = Object.keys(forumObjs).map((lang) => ({ lang, id: group.forums[lang] }));
        newPostFor = (lang) => ({
          forumId: group.forums[lang],
          title: message.channel.name,
          appliedTags: mapTags(sourceForum, forumObjs[lang], message.channel.appliedTags),
        });
      }

      const translations = {};
      const mirrorThreads = { [sourceLang]: message.channel.id };
      await Promise.all(
        targets.map(({ lang: targetLang, id: targetChannelId }) =>
            relayToTarget({
              message,
              rendered,
              sourceLang,
              targetLang,
              targetChannelId,
              displayName,
              avatarURL,
              isLong,
              hasContent,
              attachmentUrls,
              jumpLink,
              contextText,
              targetSpeaker,
              quality,
              staff: mode === 'staff',
              newPost: newPostFor(targetLang),
            })
              .then((res) => {
                if (res?.translated) translations[targetLang] = res.translated;
                if (res?.threadId) mirrorThreads[targetLang] = res.threadId;
              })
              .catch((err) => {
                stats.increment('errors');
                console.error(
                  `Failed ${sourceLang} -> ${targetLang} channel=${targetChannelId}`,
                  err?.message || err
                );
              })
          )
      );

      if (mode === 'newpost') {
        forums.saveThreadGroup({
          group: route.finfo.group,
          originLang: sourceLang,
          threads: mirrorThreads,
        });
        console.log(`Mirrored post ${route.finfo.group}: ${JSON.stringify(mirrorThreads)}`);
      }

      // Persist the full parallel translation set for offline analysis.
      // No-op if there was no textual content (attachment-only messages).
      if (hasContent && Object.keys(translations).length > 0) {
        corpusLog.record({
          sourceChannelId: message.channelId,
          sourceLang,
          sourceText: message.content,
          translations,
        });
      }

      // Add this message to the channel context buffer for future lines.
      if (hasContent) {
        contextBuffer.push(message.channel.id, displayName, rendered);
      }

      // Passive moderation pre-screen — non-blocking, flag-only.
      if (hasContent && mode !== 'staff') {
        firePrescreen(message, rendered);
      }

      // Heated-exchange cooldown and campaign reminders are for the chat
      // channels only, not forum posts.
      if (mode === 'chat') try {
        const heat = cooldown.observe(message);
        if (heat.heated) {
          cooldown.nudge(message.client, heat.channelId).catch(() => {});
          campaign.markNotice(message.channel.id);
          stats.increment('cooldowns');
        }
      } catch (err) {
        console.error('cooldown observe failed', err?.message || err);
      }

      // Volume-triggered norm reminder.
      if (mode === 'chat') try {
        const entry = campaign.observe(message.channel.id);
        if (entry) {
          campaign.post(message.client, message.channel.id, entry).catch(() => {});
          stats.increment('campaigns');
        }
      } catch (err) {
        console.error('campaign observe failed', err?.message || err);
      }
    } finally {
      const remaining = (userInFlight.get(userId) || 1) - 1;
      if (remaining <= 0) userInFlight.delete(userId);
      else userInFlight.set(userId, remaining);
    }
  } catch (err) {
    stats.increment('errors');
    console.error('messageCreate fatal error', err);
  }
}

async function handleMessageUpdate(oldMessage, newMessage) {
  try {
    if (newMessage.partial) {
      try {
        newMessage = await newMessage.fetch();
      } catch {
        return;
      }
    }

    if (newMessage.author?.bot) return;
    if (newMessage.webhookId) return;
    if (
      oldMessage &&
      !oldMessage.partial &&
      oldMessage.content === newMessage.content
    )
      return;
    if (!newMessage.content?.trim()) return;

    const relays = getRelays(newMessage.channelId, newMessage.id);
    if (relays.length === 0) return;

    const route = resolveRoute(newMessage);
    const sourceLang =
      route?.sourceLang || LANG_BY_CHANNEL_ID[newMessage.channelId];
    if (!sourceLang) return;
    const isStaff = route?.mode === 'staff';
    const quality =
      isStaff ||
      (newMessage.id === newMessage.channelId && route?.finfo?.kind === 'notes');

    const rendered = renderMentions(newMessage.content, newMessage);
    const isLong = rendered.length > MAX_MESSAGE_LENGTH;
    const jumpLink = isStaff ? null : buildJumpLink(newMessage);
    const { displayName, avatarURL } = getDisplayInfo(newMessage);
    const webhookName = isStaff
      ? displayName.slice(0, 80)
      : `[${SOURCE_LANG_FLAG[sourceLang] || '🌐'}] ${displayName}`.slice(0, 80);

    // Group the relay parts by target.
    const byTarget = new Map();
    for (const r of relays) {
      if (!byTarget.has(r.targetChannelId)) byTarget.set(r.targetChannelId, []);
      byTarget.get(r.targetChannelId).push(r);
    }

    await Promise.all(
      [...byTarget.entries()].map(async ([targetChannelId, parts]) => {
        try {
          parts.sort((a, b) => (a.part || 0) - (b.part || 0));
          const targetLang =
            parts[0].targetLang || LANG_BY_CHANNEL_ID[targetChannelId];
          if (!targetLang) return;

          const translated = await buildTranslatedBody({
            message: newMessage,
            rendered,
            sourceLang,
            targetLang,
            isLong,
            hasContent: true,
            quality,
          });

          const finalContent = composeFinalContent({
            translated,
            message: newMessage,
            targetChannelId,
            jumpLink,
            hasContent: true,
          });

          const sink = await getSink(newMessage.client, targetChannelId);
          const chunks = splitForDiscord(finalContent);
          for (let i = 0; i < Math.max(chunks.length, parts.length); i++) {
            if (i < parts.length && i < chunks.length) {
              await sink.webhook.editMessage(parts[i].webhookMessageId, {
                content: chunks[i],
                allowedMentions: { parse: [] },
                ...(sink.threadId ? { threadId: sink.threadId } : {}),
              });
            } else if (i < parts.length) {
              // The new translation needs fewer parts: blank the extra ones.
              await sink.webhook.editMessage(parts[i].webhookMessageId, {
                content: '\u200b',
                ...(sink.threadId ? { threadId: sink.threadId } : {}),
              });
            } else {
              const last = parts[parts.length - 1];
              const msg = await sink.webhook.send({
                content: chunks[i],
                username: webhookName,
                avatarURL,
                allowedMentions: { parse: [] },
                ...(sink.threadId ? { threadId: sink.threadId } : {}),
              });
              recordRelay({
                sourceChannelId: newMessage.channelId,
                sourceMessageId: newMessage.id,
                targetChannelId,
                webhookMessageId: msg.id,
                snippet: last.snippet,
                authorId: newMessage.author.id,
                targetLang,
                part: i,
              });
            }
          }

          stats.increment('editsSync');
          console.log(
            `Edited ${sourceLang} -> ${targetLang}: ${translated}`
          );
        } catch (err) {
          stats.increment('errors');
          console.error(
            `Edit sync failed channel=${targetChannelId}`,
            err?.message || err
          );
        }
      })
    );
  } catch (err) {
    stats.increment('errors');
    console.error('messageUpdate fatal error', err);
  }
}

async function handleMessageDelete(message) {
  try {
    // Mark before reading relays so any in-flight translation that finishes
    // after this point will see the tombstone and self-clean.
    markDeleted(message.channelId, message.id);

    const relays = getRelays(message.channelId, message.id);
    if (relays.length === 0) return;

    await Promise.all(
      relays.map(async ({ targetChannelId, webhookMessageId }) => {
        try {
          const sink = await getSink(message.client, targetChannelId);
          await sink.webhook.deleteMessage(webhookMessageId, sink.threadId);
          stats.increment('deletesSync');
          console.log(
            `Deleted relay channel=${targetChannelId} msg=${webhookMessageId}`
          );
        } catch (err) {
          stats.increment('errors');
          console.error(
            `Delete sync failed channel=${targetChannelId}`,
            err?.message || err
          );
        }
      })
    );

    removeRelays(message.channelId, message.id);
  } catch (err) {
    stats.increment('errors');
    console.error('messageDelete fatal error', err);
  }
}

// Post-level sync for mirrored forum posts.
//   - title and tags follow the post that was written first (origin)
//   - closing (archive) and locking follow whichever copy was changed
async function handleThreadUpdate(oldThread, newThread) {
  try {
    const row = forums.findThreadGroup(newThread.id);
    if (!row) return;
    const lang = forums.langOfThread(row, newThread.id);
    const isOrigin = lang === row.origin_lang;
    const others = forums.LANGS.filter((l) => l !== lang && row[l]);

    const nameChanged = isOrigin && oldThread?.name !== newThread.name;
    const tagsChanged =
      isOrigin &&
      JSON.stringify(oldThread?.appliedTags || []) !==
        JSON.stringify(newThread.appliedTags || []);
    const archivedChanged = oldThread?.archived !== newThread.archived;
    const lockedChanged = oldThread?.locked !== newThread.locked;
    if (!nameChanged && !tagsChanged && !archivedChanged && !lockedChanged) return;

    const finfo = forums.forumInfo(newThread.parentId);
    const quality = finfo?.kind === 'notes';
    const sourceForum = newThread.parent;

    await Promise.all(
      others.map(async (l) => {
        try {
          const th = await newThread.client.channels.fetch(row[l]);
          const edit = {};
          if (nameChanged) {
            edit.name = (
              await translateText(newThread.name, lang, l, null, { quality })
            ).slice(0, 100);
          }
          if (tagsChanged) {
            const targetForum = th.parent || (await newThread.client.channels.fetch(th.parentId));
            edit.appliedTags = mapTags(sourceForum, targetForum, newThread.appliedTags);
          }
          if (lockedChanged && th.locked !== newThread.locked) edit.locked = newThread.locked;
          if (archivedChanged && th.archived !== newThread.archived) edit.archived = newThread.archived;
          // An archived thread must be reopened before other edits apply.
          if (th.archived && Object.keys(edit).some((k) => k !== 'archived')) {
            await th.setArchived(false);
          }
          if (Object.keys(edit).length) await th.edit(edit);
        } catch (err) {
          stats.increment('errors');
          console.error(`Thread sync failed ${lang} -> ${l}`, err?.message || err);
        }
      })
    );
    console.log(`Thread sync ${row.grp} from ${lang}: ${[nameChanged && 'name', tagsChanged && 'tags', archivedChanged && 'archived', lockedChanged && 'locked'].filter(Boolean).join(',')}`);
  } catch (err) {
    stats.increment('errors');
    console.error('threadUpdate fatal error', err);
  }
}

// Deleting the original post deletes its mirrors. Deleting a mirror only
// removes that copy.
async function handleThreadDelete(thread) {
  try {
    const row = forums.findThreadGroup(thread.id);
    if (!row) return;
    const lang = forums.langOfThread(row, thread.id);
    if (lang !== row.origin_lang) return;
    for (const l of forums.LANGS) {
      if (l === lang || !row[l]) continue;
      try {
        const th = await thread.client.channels.fetch(row[l]);
        await th.delete();
      } catch (err) {
        console.error(`Mirror delete failed ${l}`, err?.message || err);
      }
    }
    forums.deleteThreadGroup(row);
    console.log(`Deleted mirrored post group ${row.grp}`);
  } catch (err) {
    stats.increment('errors');
    console.error('threadDelete fatal error', err);
  }
}

async function handleMessageDeleteBulk(messages) {
  // Dyno's purge / spam-wave cleanups arrive as bulk deletes. discord.js
  // emits a Collection here; fan out to the single-delete handler so each
  // message gets a tombstone and its relays are removed.
  for (const message of messages.values()) {
    await handleMessageDelete(message);
  }
}

module.exports = {
  handleMessage,
  handleMessageUpdate,
  handleMessageDelete,
  handleMessageDeleteBulk,
  handleThreadUpdate,
  handleThreadDelete,
  splitForDiscord,
};
