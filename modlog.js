// Mod-log poster. Every moderation event becomes two cards:
//   - the unified log (all languages): Korean labels, and the member's text
//     with a Korean translation under it when it was not written in Korean
//   - the log of the event's language (로그-kr/en/jp/cn): labels and the
//     judge's reason in that language, the member's text as written
// The two cards are twins: closing one (an action was taken) closes the other.
// No-op when no log channel is configured, so the feature degrades cleanly.

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const { MODERATION } = require('./config');
const forums = require('./forums');
const cardstore = require('./cardstore');

// Fixed card text per language. Free text (judge reason, report-load summary)
// is machine-translated instead.
const L10N = {
  en: {
    '🟡 신고 처리 — 운영자 검토 필요': '🟡 Report — needs moderator review',
    '🚨 신고 처리 — 위반': '🚨 Report — violation',
    '✅ 신고 처리 — 위반 아님': '✅ Report — no violation',
    '👁️ 프리스크린 감지 (자동조치 없음)': '👁️ Pre-screen flag (no action taken)',
    '⚠️ 신고 누적 검토 요청': '⚠️ Repeated reports — review requested',
    신고자: 'Reporter', 대상: 'Member', 채널: 'Channel', 규칙: 'Rule', 심각도: 'Severity',
    확신도: 'Confidence', '도발 정황': 'Provoked', 조치: 'Action', '판단 사유': 'Reason',
    '신고자 사유': 'Reporter note', 메시지: 'Message', 작성자: 'Author', '추정 규칙': 'Likely rule',
    원문: 'Original', '✅ 처리됨': '✅ Handled', '있음 (감경 사유)': 'Yes (mitigating)', 없음: 'No',
    '(내용 없음)': '(no text)', '자동 조치는 수행되지 않았습니다. 검토 후 판단해 주세요.': 'No automatic action was taken. Please review and decide.',
    'strike 취소': 'Cancel strike', '타임아웃 해제': 'Lift timeout', 이력: 'History', '경고 부여': 'Warn',
    타임아웃: 'Timeout', '관찰 지정': 'Watch', '전체 이력': 'Full history', '패턴 분석': 'Pattern', 무시: 'Dismiss',
    '정밀 판정': 'Full judgment', 언어: 'Language',
  },
  jp: {
    '🟡 신고 처리 — 운영자 검토 필요': '🟡 通報 — 運営の確認が必要',
    '🚨 신고 처리 — 위반': '🚨 通報 — 違反',
    '✅ 신고 처리 — 위반 아님': '✅ 通報 — 違反なし',
    '👁️ 프리스크린 감지 (자동조치 없음)': '👁️ 事前検知（自動措置なし）',
    '⚠️ 신고 누적 검토 요청': '⚠️ 通報の累積 — 確認依頼',
    신고자: '通報者', 대상: '対象', 채널: 'チャンネル', 규칙: '規則', 심각도: '深刻度',
    확신도: '確信度', '도발 정황': '挑発の状況', 조치: '措置', '판단 사유': '判断理由',
    '신고자 사유': '通報理由', 메시지: 'メッセージ', 작성자: '投稿者', '추정 규칙': '推定規則',
    원문: '原文', '✅ 처리됨': '✅ 処理済み', '있음 (감경 사유)': 'あり（軽減事由）', 없음: 'なし',
    '(내용 없음)': '（内容なし）', '자동 조치는 수행되지 않았습니다. 검토 후 판단해 주세요.': '自動措置は行われていません。確認のうえ判断してください。',
    'strike 취소': '警告取消', '타임아웃 해제': 'タイムアウト解除', 이력: '履歴', '경고 부여': '警告',
    타임아웃: 'タイムアウト', '관찰 지정': '観察指定', '전체 이력': '全履歴', '패턴 분석': 'パターン分析', 무시: '無視',
    '정밀 판정': '精密判定', 언어: '言語',
  },
  cn: {
    '🟡 신고 처리 — 운영자 검토 필요': '🟡 举报 — 需要管理员审核',
    '🚨 신고 처리 — 위반': '🚨 举报 — 违规',
    '✅ 신고 처리 — 위반 아님': '✅ 举报 — 未违规',
    '👁️ 프리스크린 감지 (자동조치 없음)': '👁️ 预筛检测（未自动处理）',
    '⚠️ 신고 누적 검토 요청': '⚠️ 举报累积 — 请求审核',
    신고자: '举报人', 대상: '对象', 채널: '频道', 규칙: '规则', 심각도: '严重程度',
    확신도: '置信度', '도발 정황': '挑衅情况', 조치: '处理', '판단 사유': '判断理由',
    '신고자 사유': '举报理由', 메시지: '消息', 작성자: '作者', '추정 규칙': '推测规则',
    원문: '原文', '✅ 처리됨': '✅ 已处理', '있음 (감경 사유)': '有（减轻情节）', 없음: '无',
    '(내용 없음)': '（无内容）', '자동 조치는 수행되지 않았습니다. 검토 후 판단해 주세요.': '未执行自动处理。请审核后决定。',
    'strike 취소': '撤销警告', '타임아웃 해제': '解除禁言', 이력: '记录', '경고 부여': '警告',
    타임아웃: '禁言', '관찰 지정': '观察', '전체 이력': '全部记录', '패턴 분석': '模式分析', 무시: '忽略',
    '정밀 판정': '精确判定', 언어: '语言',
  },
};
const FLAG = { kr: '🇰🇷 KR', en: '🇺🇸 EN', jp: '🇯🇵 JP', cn: '🇨🇳 CN' };
const tr = (lang, text) => (lang && L10N[lang]?.[text]) || text;

// Lazy require: translator pulls in the API client; tests load modlog without it.
async function machineTranslate(text, from, to) {
  if (!text || from === to) return text;
  try {
    const { translateText } = require('./translator');
    return await translateText(text, from, to, null, { quality: false });
  } catch (err) {
    console.error('modlog: translate failed —', err?.message || err);
    return null;
  }
}

const MEMBER_TEXT_FIELDS = ['메시지', '신고자 사유'];
const FREE_TEXT_FIELDS = ['판단 사유'];

// Unified card: Korean card, member text gets a Korean line under it.
async function buildUnified(embed, lang) {
  const out = EmbedBuilder.from(embed.toJSON());
  const fields = out.data.fields || [];
  await Promise.all(
    fields.map(async (f) => {
      if (!lang || lang === 'kr' || !MEMBER_TEXT_FIELDS.includes(f.name)) return;
      if (!f.value || f.value === '—' || f.value === '(내용 없음)') return;
      const ko = await machineTranslate(f.value, lang, 'kr');
      if (ko) f.value = `${f.value}\n> 🇰🇷 ${ko}`.slice(0, 1024);
    })
  );
  if (lang) out.addFields({ name: '언어', value: FLAG[lang], inline: true });
  return out;
}

// Language card: fixed text from L10N, judge reason / summary translated.
async function buildLocal(embed, lang) {
  const out = EmbedBuilder.from(embed.toJSON());
  const d = out.data;
  if (lang === 'kr') return out;
  if (d.title) d.title = tr(lang, d.title);
  if (d.footer?.text) d.footer.text = tr(lang, d.footer.text);
  if (d.description) d.description = (await machineTranslate(d.description, 'kr', lang)) || d.description;
  await Promise.all(
    (d.fields || []).map(async (f) => {
      const orig = f.name;
      f.name = tr(lang, f.name);
      if (FREE_TEXT_FIELDS.includes(orig) && f.value && f.value !== '—') {
        f.value = ((await machineTranslate(f.value, 'kr', lang)) || f.value).slice(0, 1024);
      } else if (!MEMBER_TEXT_FIELDS.includes(orig)) {
        f.value = tr(lang, f.value);
      }
    })
  );
  return out;
}

function localizeComponents(components, lang) {
  if (!components?.length || lang === 'kr') return components || [];
  return components.map((row) => {
    const json = row.toJSON();
    json.components = json.components.map((c) => ({ ...c, label: c.label ? tr(lang, c.label) : c.label }));
    return json;
  });
}

async function postTo(client, channelId, embed, components) {
  const channel = await client.channels.fetch(channelId);
  return channel.send({
    embeds: [embed],
    components: components || [],
    allowedMentions: { parse: [] },
  });
}

async function send(client, embed, components, { sourceChannelId } = {}) {
  const logs = forums.logChannels();
  const unifiedId = logs.all || MODERATION.modLogChannelId;
  const lang = await forums.langOfChannel(client, sourceChannelId);
  const localId = lang ? logs[lang] : null;
  if (!unifiedId && !localId) return;

  const [unifiedEmbed, localEmbed] = await Promise.all([
    unifiedId ? buildUnified(embed, lang) : null,
    localId ? buildLocal(embed, lang) : null,
  ]);
  const [u, l] = await Promise.all([
    unifiedId
      ? postTo(client, unifiedId, unifiedEmbed, components).catch((err) => {
          console.error('modlog: unified post failed —', err?.message || err);
          return null;
        })
      : null,
    localId
      ? postTo(client, localId, localEmbed, localizeComponents(components, lang)).catch((err) => {
          console.error(`modlog: ${lang} post failed —`, err?.message || err);
          return null;
        })
      : null,
  ]);
  if (u && l) {
    cardstore.set({ message_id: u.id, twin_channel_id: l.channelId, twin_message_id: l.id, twin_lang: lang });
    cardstore.set({ message_id: l.id, twin_channel_id: u.channelId, twin_message_id: u.id, twin_lang: 'kr' });
  }
}

// Close the twin of a card that was just handled. Returns the twin's message
// id (so callers can mark it handled too), or null.
async function closeTwin(client, messageId, resultLine) {
  const row = cardstore.get(messageId);
  if (!row) return null;
  try {
    const ch = await client.channels.fetch(row.twin_channel_id);
    const msg = await ch.messages.fetch(row.twin_message_id);
    const embed = EmbedBuilder.from(msg.embeds[0] || {});
    embed.addFields({ name: tr(row.twin_lang, '✅ 처리됨'), value: resultLine.slice(0, 1024) });
    await msg.edit({ embeds: [embed], components: [] });
  } catch (err) {
    console.error('modlog: twin close failed —', err?.message || err);
  }
  return row.twin_message_id;
}

function twinOf(messageId) {
  return cardstore.get(messageId)?.twin_message_id || null;
}

// Admin one-click recovery buttons for a verdict entry. customId carries the
// offender id so the button handler can act without extra state.
function verdictButtons(offenderId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`mod|strike_cancel|${offenderId}`)
      .setLabel('strike 취소')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`mod|timeout_clear|${offenderId}`)
      .setLabel('타임아웃 해제')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`mod|history|${offenderId}`)
      .setLabel('이력')
      .setStyle(ButtonStyle.Primary)
  );
}

// Enforcement buttons for an item awaiting an operator decision — either a
// low-confidence / flag-only verdict, or a report-load alert. `ref` carries the
// channel and message when a specific message can still be deleted.
function enforcementButtons(prefix, userId, ref) {
  const suffix = ref ? `|${ref.channelId}|${ref.messageId}` : '';
  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${prefix}|warn|${userId}${suffix}`)
        .setLabel('경고 부여')
        .setEmoji('⚠️')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`${prefix}|timeout|${userId}`)
        .setLabel('타임아웃')
        .setEmoji('⛔')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`${prefix}|watch|${userId}`)
        .setLabel('관찰 지정')
        .setEmoji('👁️')
        .setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${prefix}|history|${userId}`)
        .setLabel('전체 이력')
        .setEmoji('📋')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`${prefix}|brief|${userId}`)
        .setLabel('패턴 분석')
        .setEmoji('🔍')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`${prefix}|ignore|${userId}`)
        .setLabel('무시')
        .setEmoji('✖️')
        .setStyle(ButtonStyle.Secondary)
    ),
  ];
  return rows;
}

// Report accumulation alert. Purely a request for operator review — no action
// has been or will be taken automatically.
async function postReportLoadAlert(client, { userId, userTag, summary, sourceChannelId }) {
  const reasons = summary.reasons.length
    ? summary.reasons.map(([k, n]) => `${k}(${n})`).join(', ')
    : '—';
  const lines = [
    `최근 ${summary.total}건 · 서로 다른 신고자 **${summary.distinctReporters}명** (제3자 ${summary.bystanderReporters}명)`,
    `판정: 위반 아님 ${summary.cleared} / 위반 ${summary.upheld} · 가중치 ${summary.weightedScore}`,
    summary.burst ? '⚠️ 단시간 집중 신고 — 조직적 신고 가능성 있음' : '',
    `주요 사유: ${reasons}`,
  ].filter(Boolean);

  if (summary.excerpts.length) {
    lines.push('', '최근 신고 메시지:', ...summary.excerpts.map((e) => `> ${e}`));
  }

  const embed = new EmbedBuilder()
    .setTitle('⚠️ 신고 누적 검토 요청')
    .setColor(0xe67e22)
    .setDescription(`**${userTag || '—'}** (${userId})\n\n${lines.join('\n')}`)
    .setFooter({ text: '자동 조치는 수행되지 않았습니다. 검토 후 판단해 주세요.' })
    .setTimestamp();

  await send(client, embed, enforcementButtons('rl', userId), { sourceChannelId });
}

// A resolved report verdict (violation or not).
async function postVerdict(client, {
  reporterTag,
  reporterReason,
  offenderTag,
  offenderId,
  channelName,
  content,
  verdict,
  action,
  review,
  sourceChannelId,
  sourceMessageId,
}) {
  const color = review ? 0xf1c40f : verdict.violation ? 0xe74c3c : 0x2ecc71;
  const embed = new EmbedBuilder()
    .setTitle(
      review
        ? '🟡 신고 처리 — 운영자 검토 필요'
        : verdict.violation
          ? '🚨 신고 처리 — 위반'
          : '✅ 신고 처리 — 위반 아님'
    )
    .setColor(color)
    .addFields(
      { name: '신고자', value: reporterTag || '—', inline: true },
      { name: '대상', value: `${offenderTag || '—'} (${offenderId || '—'})`, inline: true },
      { name: '채널', value: channelName || '—', inline: true },
      { name: '규칙', value: verdict.ruleId || '—', inline: true },
      { name: '심각도', value: verdict.severity || '—', inline: true },
      { name: '확신도', value: verdict.confidence || '—', inline: true },
      { name: '도발 정황', value: verdict.provoked ? '있음 (감경 사유)' : '없음', inline: true },
      { name: '조치', value: action || '—', inline: true },
      { name: '판단 사유', value: (verdict.reason || '—').slice(0, 1024) },
      { name: '신고자 사유', value: (reporterReason || '—').slice(0, 1024) },
      { name: '메시지', value: (content || '(내용 없음)').slice(0, 1024) },
    )
    .setTimestamp();

  // Review items get enforcement buttons (nothing was applied yet); enforced
  // ones get recovery buttons; cleared ones get neither.
  let components = [];
  if (review) {
    components = enforcementButtons('rv', offenderId, {
      channelId: sourceChannelId,
      messageId: sourceMessageId,
    });
  } else if (verdict.violation) {
    components = [verdictButtons(offenderId)];
  }
  await send(client, embed, components, { sourceChannelId });
}

// A passive pre-screen flag (no action taken — for human review).
async function postPrescreenFlag(client, {
  authorTag,
  authorId,
  channelName,
  ruleId,
  content,
  guildId,
  channelId,
  messageId,
}) {
  const hasRef = Boolean(channelId && messageId);
  const embed = new EmbedBuilder()
    .setTitle('👁️ 프리스크린 감지 (자동조치 없음)')
    .setColor(0xf39c12)
    .addFields(
      { name: '작성자', value: `${authorTag || '—'} (${authorId || '—'})`, inline: true },
      { name: '채널', value: channelName || '—', inline: true },
      { name: '추정 규칙', value: ruleId || '—', inline: true },
      { name: '메시지', value: (content || '—').slice(0, 1024) },
    )
    .setTimestamp();
  if (guildId && hasRef) {
    embed.addFields({
      name: '원문',
      value: `https://discord.com/channels/${guildId}/${channelId}/${messageId}`,
    });
  }

  // The prescreen is a flash model reading ONE line: no conversation context,
  // no stated reason, no confidence. That is too thin to hang a strike on, so
  // the card leads with 정밀 판정 — the reasoner re-reads the same message with
  // the full context window and replaces this flag with a real verdict. The
  // rest are the same operator actions the review queue already carries.
  const components = [];
  if (authorId && hasRef) {
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`ps|judge|${authorId}|${channelId}|${messageId}`)
          .setLabel('정밀 판정')
          .setEmoji('🔬')
          .setStyle(ButtonStyle.Primary)
      )
    );
  }
  if (authorId) {
    components.push(
      ...enforcementButtons('ps', authorId, hasRef ? { channelId, messageId } : undefined)
    );
  }
  await send(client, embed, components, { sourceChannelId: channelId });
}

module.exports = {
  postVerdict,
  postPrescreenFlag,
  postReportLoadAlert,
  closeTwin,
  twinOf,
};
