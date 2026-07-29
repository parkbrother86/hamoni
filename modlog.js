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
}) {
  const color = verdict.violation ? 0xe74c3c : 0x2ecc71;
  const embed = new EmbedBuilder()
    .setTitle(verdict.violation ? '🚨 신고 처리 — 위반' : '✅ 신고 처리 — 위반 아님')
    .setColor(color)
    .addFields(
      { name: '신고자', value: reporterTag || '—', inline: true },
      { name: '대상', value: `${offenderTag || '—'} (${offenderId || '—'})`, inline: true },
      { name: '채널', value: channelName || '—', inline: true },
      { name: '규칙', value: verdict.ruleId || '—', inline: true },
      { name: '심각도', value: verdict.severity || '—', inline: true },
      { name: '조치', value: action || '—', inline: true },
      { name: '판단 사유', value: (verdict.reason || '—').slice(0, 1024) },
      { name: '신고자 사유', value: (reporterReason || '—').slice(0, 1024) },
      { name: '메시지', value: (content || '(내용 없음)').slice(0, 1024) },
    )
    .setTimestamp();
  // Recovery buttons only make sense when a strike/timeout was actually applied.
  const components = verdict.violation ? [verdictButtons(offenderId)] : [];
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
};
