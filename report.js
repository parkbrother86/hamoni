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

const { LANG_BY_CHANNEL_ID, MODERATION } = require('./config');
const store = require('./store');
const rules = require('./rules');
const abuse = require('./abuse');
const enforce = require('./enforce');
const reportload = require('./reportload');
const moderation = require('./moderation');
const modlog = require('./modlog');
const stats = require('./stats');

const CONF_ORDER = { high: 3, medium: 2, low: 1 };

// Graduated rollout gate. A confirmed violation only auto-enforces when its
// rule has graduated out of flag-only AND the judge was confident enough;
// otherwise it goes to the operator review queue instead of deleting silently.
function shouldAutoEnforce(verdict) {
  if (MODERATION.flagOnlyRules.includes(verdict.ruleId)) return false;
  const need = CONF_ORDER[MODERATION.autoActionMinConfidence] || 3;
  return (CONF_ORDER[verdict.confidence] || 0) >= need;
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

  // Age gate: block reports on old messages (no retroactive reporting).
  const ageMs = Date.now() - interaction.targetMessage.createdTimestamp;
  if (ageMs > MODERATION.reportMaxAgeMs) {
    const mins = Math.round(MODERATION.reportMaxAgeMs / 60000);
    await interaction.reply({
      content: `${mins}분이 지난 메시지는 신고할 수 없습니다.`,
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

  // Re-check dedup (another reporter may have finished it since the modal opened).
  const cached = abuse.getCached(sourceMessageId);
  if (cached) {
    stats.increment('reportBlocked');
    await interaction.editReply({ content: `이미 처리된 메시지입니다.\n${cached}` });
    return;
  }

  // In-flight claim: block concurrent reports of the SAME message while its
  // judgment is running, so a message reported by many people at once cannot
  // rack up multiple strikes.
  if (!abuse.claim(sourceMessageId)) {
    stats.increment('reportBlocked');
    await interaction.editReply({ content: '이미 다른 신고가 처리 중인 메시지입니다.' });
    return;
  }

  try {
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

    const ctx = await moderation.gatherContext(sourceChannel, sourceMessage);
    // A bystander's report carries more signal than one from the person the
    // reporter was already arguing with.
    const bystander = !ctx.participants.has(interaction.user.id);

    const verdict = await moderation.judge({
      content,
      context: ctx.text,
      authorName: offenderName,
      hint: { reason, suspectedRule },
    });

    if (verdict.error) {
      // Release so it can be retried; nothing was enforced.
      abuse.release(sourceMessageId);
      await interaction.editReply({ content: '판단에 실패했습니다. 잠시 후 다시 시도해 주세요.' });
      return;
    }

    let action = '없음 (위반 아님)';
    let replyText = '검토 결과: 규정 위반이 아닙니다.';
    let review = false;

    // Provoked reaction: take the message down but do not let it accrue toward
    // a timeout. Deliberately asymmetric — erring toward leniency costs one
    // mild violation, whereas erring toward accusing the other party of baiting
    // would brand a possibly-innocent minority voice as a troll.
    const mitigate =
      verdict.violation &&
      MODERATION.mitigateProvoked &&
      verdict.provoked &&
      verdict.severity !== 'high';

    if (verdict.violation && mitigate) {
      stats.increment('mitigated');
      let deleted = false;
      try {
        await sourceMessage.delete();
        deleted = true;
        stats.increment('moderationDeletes');
      } catch (err) {
        console.error('report: source delete failed —', err?.message || err);
      }
      action = `${deleted ? '삭제' : '삭제 실패(봇 권한 확인)'} · 도발 정황으로 경고 미부여`;
      replyText =
        '해당 메시지는 삭제되었습니다. 다만 도발에 대한 반응으로 판단되어 경고는 부과하지 않았습니다.';
    } else if (verdict.violation && shouldAutoEnforce(verdict)) {
      stats.increment('reportViolations');
      const { count, hours, deleted, timedOut } = await enforce.applyStrike(client, {
        guild: interaction.guild,
        userId: authorId,
        displayName: offenderName,
        ruleId: verdict.ruleId,
        messageId: sourceMessageId,
        sourceChannelId,
        message: sourceMessage,
      });

      const deleteNote = deleted ? '삭제' : '삭제 실패(봇 권한 확인)';
      action =
        hours > 0
          ? `${deleteNote} + 경고 ${count}회 + 타임아웃 ${hours}시간${timedOut ? '' : ' (권한 부족으로 실패)'}`
          : `${deleteNote} + 경고 ${count}회`;
      replyText = `처리 완료: ${rules.getTitle(verdict.ruleId, 'kr')} 위반 · ${action}`;
    } else if (verdict.violation) {
      // Violation found, but the rule is still flag-only or the judge was not
      // confident. Nothing is deleted or counted — an operator decides.
      review = true;
      stats.increment('reviewQueued');
      action = `운영자 검토 대기 (확신도 ${verdict.confidence})`;
      replyText =
        '신고가 접수되어 운영자 검토 대기 중입니다. 확인 후 조치됩니다.';
    }

    abuse.setCached(sourceMessageId, replyText);

    // Every report is recorded, cleared ones included — that is what makes a
    // pattern of "repeatedly reported, never actionable" visible at all.
    reportload.record({
      userId: authorId,
      reporterId: interaction.user.id,
      messageId: sourceMessageId,
      verdict: verdict.violation ? 'upheld' : 'cleared',
      ruleId: verdict.ruleId,
      suspectedRule: suspectedRule || reason,
      bystander,
      excerpt: content,
    });

    modlog.postVerdict(client, {
      reporterTag: interaction.user.tag,
      reporterReason: reason || suspectedRule || null,
      offenderTag,
      offenderId: authorId,
      channelName: sourceChannel.name,
      content,
      verdict,
      action,
      review,
      sourceChannelId,
      sourceMessageId,
    });

    if (reportload.shouldAlert(authorId)) {
      modlog.postReportLoadAlert(client, {
        userId: authorId,
        userTag: offenderTag,
        summary: reportload.summarize(authorId),
      });
    }

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
  } finally {
    // setCached already cleared the claim on success; this covers early
    // returns / throws so a message is never left permanently locked.
    abuse.release(sourceMessageId);
  }
}

module.exports = {
  showReportModal,
  handleReportSubmit,
};
