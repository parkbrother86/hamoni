// Mod-log poster: writes moderation audit entries to a private admin channel.
// No-op if MODERATION.modLogChannelId is unset, so the feature degrades cleanly.

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const { MODERATION } = require('./config');

async function send(client, embed, components) {
  const id = MODERATION.modLogChannelId;
  if (!id) return;
  try {
    const channel = await client.channels.fetch(id);
    await channel.send({
      embeds: [embed],
      components: components || [],
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    console.error('modlog: post failed —', err?.message || err);
  }
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
async function postReportLoadAlert(client, { userId, userTag, summary }) {
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

  await send(client, embed, enforcementButtons('rl', userId));
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
  await send(client, embed, components);
}

// A passive pre-screen flag (no action taken — for human review).
async function postPrescreenFlag(client, { authorTag, authorId, channelName, ruleId, content }) {
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
  await send(client, embed);
}

module.exports = {
  postVerdict,
  postPrescreenFlag,
  postReportLoadAlert,
};
