// Mod-log poster: writes moderation audit entries to a private admin channel.
// No-op if MODERATION.modLogChannelId is unset, so the feature degrades cleanly.

const { EmbedBuilder } = require('discord.js');

const { MODERATION } = require('./config');

async function send(client, embed) {
  const id = MODERATION.modLogChannelId;
  if (!id) return;
  try {
    const channel = await client.channels.fetch(id);
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (err) {
    console.error('modlog: post failed —', err?.message || err);
  }
}

// A resolved report verdict (violation or not).
async function postVerdict(client, {
  reporterTag,
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
      { name: '사유', value: (verdict.reason || '—').slice(0, 1024) },
      { name: '메시지', value: (content || '(내용 없음)').slice(0, 1024) },
    )
    .setTimestamp();
  await send(client, embed);
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
