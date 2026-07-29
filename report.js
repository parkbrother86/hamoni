// Report orchestration.
//
// Two-step UX:
//   1. Right-click a message -> Report  => showReportModal() opens a reason modal
//   2. Modal submit                      => handleReportSubmit() judges + enforces
//
// Enforcement reuses the existing delete-propagation machinery: deleting the
// SOURCE message fires messageDelete, which removes all relayed copies.

const {
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  EmbedBuilder,
} = require('discord.js');

const {
  CHANNELS,
  LANG_BY_CHANNEL_ID,
  WARN_TEMPLATES,
  TIMEOUT_TEMPLATES,
  ESCALATION_NOTE,
  MODERATION,
} = require('./config');
const store = require('./store');
const rules = require('./rules');
const strikes = require('./strikes');
const abuse = require('./abuse');
const roles = require('./roles');
const moderation = require('./moderation');
const modlog = require('./modlog');
const stats = require('./stats');

function fill(tpl, values) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (values[k] != null ? values[k] : ''));
}

// Resolve the reported message (original or relayed copy) to its source origin.
// Returns { sourceChannelId, sourceMessageId, authorId } or { error }.
function resolveTarget(target) {
  if (target.webhookId) {
    const rev = store.resolveReverse(target.id);
    if (!rev) return { error: '이 번역 메시지의 원본을 찾을 수 없습니다 (시간이 지났을 수 있어요).' };
    return rev;
  }
  const lang = LANG_BY_CHANNEL_ID[target.channelId];
  if (!lang) return { error: '이 채널의 메시지는 신고 대상이 아닙니다.' };
  return {
    sourceChannelId: target.channelId,
    sourceMessageId: target.id,
    authorId: target.author?.id,
  };
}

// Step 1: open the reason modal (or short-circuit if already processed).
async function showReportModal(interaction) {
  if (!interaction.guild) {
    await interaction.reply({
      content: '서버 채널에서만 신고할 수 있습니다.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const resolved = resolveTarget(interaction.targetMessage);
  if (resolved.error) {
    await interaction.reply({ content: resolved.error, flags: MessageFlags.Ephemeral });
    return;
  }

  const { sourceChannelId, sourceMessageId, authorId } = resolved;

  const cached = abuse.getCached(sourceMessageId);
  if (cached) {
    stats.increment('reportBlocked');
    await interaction.reply({
      content: `이미 처리된 메시지입니다.\n${cached}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`rpt|${sourceChannelId}|${sourceMessageId}|${authorId}`)
    .setTitle('메시지 신고');

  const ruleInput = new TextInputBuilder()
    .setCustomId('rule')
    .setLabel('해당 규칙 (선택)')
    .setPlaceholder('예: 욕설 / 스팸 / 괴롭힘 / 광고')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(60);

  const reasonInput = new TextInputBuilder()
    .setCustomId('reason')
    .setLabel('신고 사유 (선택)')
    .setPlaceholder('어떤 점이 문제인지 적어주세요.')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(MODERATION.reasonMaxLength);

  modal.addComponents(
    new ActionRowBuilder().addComponents(ruleInput),
    new ActionRowBuilder().addComponents(reasonInput)
  );

  await interaction.showModal(modal);
}

// Post a localized, plaintext moderation notice into every channel in that
// channel's own language. The offender is @mentioned only in their OWN source
// channel; elsewhere they are named without a ping.
async function announce(client, { sourceChannelId, authorId, name, ruleId, count, hours }) {
  const nextIsTimeout = hours === 0 && strikes.timeoutHours(count + 1) > 0;

  await Promise.all(
    Object.entries(CHANNELS).map(async ([lang, channelId]) => {
      const rule = rules.getTitle(ruleId, lang);
      const tpl = hours > 0 ? TIMEOUT_TEMPLATES[lang] : WARN_TEMPLATES[lang];
      if (!tpl) return;

      const isOwn = channelId === sourceChannelId;
      const displayName = isOwn ? `<@${authorId}>` : name;
      let content = fill(tpl, { name: displayName, rule, count, hours });
      if (nextIsTimeout && ESCALATION_NOTE[lang]) content += ESCALATION_NOTE[lang];

      try {
        const channel = await client.channels.fetch(channelId);
        await channel.send({
          content,
          allowedMentions: isOwn ? { users: [authorId] } : { parse: [] },
        });
      } catch (err) {
        console.error(`report: announce failed channel=${channelId}`, err?.message || err);
      }
    })
  );
}

function resultEmbed({ violation, ruleTitle, action, reason }) {
  return new EmbedBuilder()
    .setColor(violation ? 0xe74c3c : 0x2ecc71)
    .setTitle(violation ? '🚨 신고 처리 완료 — 위반' : '✅ 신고 처리 완료 — 위반 아님')
    .setDescription(
      violation
        ? `**규칙:** ${ruleTitle}\n**조치:** ${action}\n**사유:** ${reason || '—'}`
        : '검토 결과 규정 위반이 아닙니다. 신고해 주셔서 감사합니다.'
    )
    .setTimestamp();
}

// Step 2: judge + enforce on modal submit.
async function handleReportSubmit(interaction) {
  const client = interaction.client;
  stats.increment('reports');

  const parts = interaction.customId.split('|');
  const sourceChannelId = parts[1];
  const sourceMessageId = parts[2];
  const authorId = parts[3];

  const suspectedRule = interaction.fields.getTextInputValue('rule')?.trim() || '';
  const reason = interaction.fields.getTextInputValue('reason')?.trim() || '';

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Re-check dedup (another reporter may have processed it since the modal opened).
  const cached = abuse.getCached(sourceMessageId);
  if (cached) {
    stats.increment('reportBlocked');
    await interaction.editReply({ content: `이미 처리된 메시지입니다.\n${cached}` });
    return;
  }

  const gate = abuse.reserve(interaction.user.id);
  if (!gate.ok) {
    stats.increment('reportBlocked');
    await interaction.editReply({
      content:
        gate.reason === 'reporter'
          ? '시간당 신고 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.'
          : '지금 신고가 많아 잠시 대기가 필요합니다. 잠시 후 다시 시도해 주세요.',
    });
    return;
  }

  let sourceChannel;
  let sourceMessage;
  try {
    sourceChannel = await client.channels.fetch(sourceChannelId);
    sourceMessage = await sourceChannel.messages.fetch(sourceMessageId);
  } catch {
    await interaction.editReply({
      content: '원본 메시지를 찾을 수 없습니다 (이미 삭제되었을 수 있어요).',
    });
    return;
  }

  const content = sourceMessage.content?.trim() || '';
  if (!content) {
    await interaction.editReply({ content: '텍스트가 없는 메시지는 판단할 수 없습니다.' });
    return;
  }

  const member = await interaction.guild.members.fetch(authorId).catch(() => null);
  const offenderName =
    member?.displayName ||
    sourceMessage.member?.displayName ||
    sourceMessage.author?.globalName ||
    sourceMessage.author?.username ||
    'user';
  const offenderTag = sourceMessage.author?.tag || offenderName;

  const history = await moderation.gatherUserHistory(sourceChannel, authorId);

  const verdict = await moderation.judge({
    content,
    history,
    authorName: offenderName,
    hint: { reason, suspectedRule },
  });

  if (verdict.error) {
    await interaction.editReply({ content: '판단에 실패했습니다. 잠시 후 다시 시도해 주세요.' });
    return;
  }

  let action = '없음 (위반 아님)';
  let replyText = '검토 결과: 규정 위반이 아닙니다.';

  if (verdict.violation) {
    stats.increment('reportViolations');
    const count = strikes.add(authorId, { ruleId: verdict.ruleId, messageId: sourceMessageId });
    const hours = strikes.timeoutHours(count);

    try {
      await sourceMessage.delete();
      stats.increment('moderationDeletes');
    } catch (err) {
      console.error('report: source delete failed —', err?.message || err);
    }

    let timedOut = false;
    if (hours > 0 && member) {
      try {
        await member.timeout(hours * 60 * 60 * 1000, `rule ${verdict.ruleId}, strike ${count}`);
        timedOut = true;
        stats.increment('timeouts');
      } catch (err) {
        console.error('report: timeout failed —', err?.message || err);
      }
    }

    await roles.syncWarnRole(member, count);
    await announce(client, {
      sourceChannelId,
      authorId,
      name: offenderName,
      ruleId: verdict.ruleId,
      count,
      hours,
    });

    action =
      hours > 0
        ? `삭제 + 경고 ${count}회 + 타임아웃 ${hours}시간${timedOut ? '' : ' (권한 부족으로 실패)'}`
        : `삭제 + 경고 ${count}회`;
    replyText = `처리 완료: ${rules.getTitle(verdict.ruleId, 'kr')} 위반 · ${action}`;
  }

  abuse.setCached(sourceMessageId, replyText);

  modlog.postVerdict(client, {
    reporterTag: interaction.user.tag,
    reporterReason: reason || suspectedRule || null,
    offenderTag,
    offenderId: authorId,
    channelName: sourceChannel.name,
    content,
    verdict,
    action,
  });

  await interaction.editReply({
    embeds: [
      resultEmbed({
        violation: verdict.violation,
        ruleTitle: verdict.violation ? rules.getTitle(verdict.ruleId, 'kr') : '',
        action,
        reason: verdict.reason,
      }),
    ],
  });
}

module.exports = {
  showReportModal,
  handleReportSubmit,
};
