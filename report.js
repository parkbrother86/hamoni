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

// Reporter-facing copy, keyed by the language of the channel they reported
// from. Everything the reporter sees is localized together — a card that is
// Korean except for one translated field reads worse than either extreme.
// The moderation log stays Korean regardless, so operators can scan it.
const T = {
  kr: {
    guildOnly: '서버 채널에서만 신고할 수 있습니다.',
    tooOld: '{mins}분이 지난 메시지는 신고할 수 없습니다.',
    notReportable: '이 채널의 메시지는 신고 대상이 아닙니다.',
    originMissing: '이 번역 메시지의 원본을 찾을 수 없습니다 (시간이 지났을 수 있어요).',
    already: '이미 처리된 메시지입니다.',
    inFlight: '이미 다른 신고가 처리 중인 메시지입니다.',
    limitReporter: '시간당 신고 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.',
    limitGlobal: '지금 신고가 많아 잠시 대기가 필요합니다. 잠시 후 다시 시도해 주세요.',
    sourceMissing: '원본 메시지를 찾을 수 없습니다 (이미 삭제되었을 수 있어요).',
    noText: '텍스트가 없는 메시지는 판단할 수 없습니다.',
    judgeFailed: '판단에 실패했습니다. 잠시 후 다시 시도해 주세요.',
    modalTitle: '메시지 신고',
    modalRule: '해당 규칙 (선택)',
    modalRulePh: '예: 욕설 / 스팸 / 괴롭힘 / 광고',
    modalReason: '신고 사유 (선택)',
    modalReasonPh: '어떤 점이 문제인지 적어주세요.',
    titleViolation: '🚨 신고 처리 완료 — 위반',
    titleCleared: '✅ 신고 처리 완료 — 위반 아님',
    clearedBody: '검토 결과 규정 위반이 아닙니다. 신고해 주셔서 감사합니다.',
    fieldRule: '규칙',
    fieldAction: '조치',
    fieldReason: '사유',
    cleared: '검토 결과: 규정 위반이 아닙니다.',
    mitigated: '해당 메시지는 삭제되었습니다. 다만 도발에 대한 반응으로 판단되어 경고는 부과하지 않았습니다.',
    queued: '신고가 접수되어 운영자 검토 대기 중입니다. 확인 후 조치됩니다.',
  },
  en: {
    guildOnly: 'Reports can only be made in a server channel.',
    tooOld: 'Messages older than {mins} minutes cannot be reported.',
    notReportable: 'Messages in this channel cannot be reported.',
    originMissing: "Couldn't find the original of this translated message (it may be too old).",
    already: 'This message has already been handled.',
    inFlight: 'Another report for this message is already being processed.',
    limitReporter: "You've hit the hourly report limit. Please try again later.",
    limitGlobal: 'Reports are backed up right now. Please try again shortly.',
    sourceMissing: "Couldn't find the original message (it may already be deleted).",
    noText: 'A message with no text cannot be judged.',
    judgeFailed: 'The review failed. Please try again shortly.',
    modalTitle: 'Report message',
    modalRule: 'Which rule (optional)',
    modalRulePh: 'e.g. profanity / spam / harassment / advertising',
    modalReason: 'Reason (optional)',
    modalReasonPh: 'Tell us what the problem is.',
    titleViolation: '🚨 Report handled — violation',
    titleCleared: '✅ Report handled — no violation',
    clearedBody: 'This was not a rule violation. Thanks for reporting.',
    fieldRule: 'Rule',
    fieldAction: 'Action',
    fieldReason: 'Reason',
    cleared: 'Reviewed: this is not a rule violation.',
    mitigated: 'The message was removed. No warning was issued, as it read as a reaction to provocation.',
    queued: 'Your report was received and is awaiting operator review.',
  },
  jp: {
    guildOnly: 'サーバーのチャンネルからのみ通報できます。',
    tooOld: '{mins}分が経過したメッセージは通報できません。',
    notReportable: 'このチャンネルのメッセージは通報対象ではありません。',
    originMissing: 'この翻訳メッセージの原文が見つかりません（時間が経過している可能性があります）。',
    already: 'すでに処理済みのメッセージです。',
    inFlight: 'このメッセージは別の通報を処理中です。',
    limitReporter: '1時間あたりの通報上限に達しました。しばらくしてからお試しください。',
    limitGlobal: '現在通報が混み合っています。しばらくしてからお試しください。',
    sourceMissing: '元のメッセージが見つかりません（すでに削除された可能性があります）。',
    noText: 'テキストのないメッセージは判定できません。',
    judgeFailed: '判定に失敗しました。しばらくしてからお試しください。',
    modalTitle: 'メッセージを通報',
    modalRule: '該当する規約（任意）',
    modalRulePh: '例：暴言 / スパム / 嫌がらせ / 宣伝',
    modalReason: '通報理由（任意）',
    modalReasonPh: '何が問題かをご記入ください。',
    titleViolation: '🚨 通報処理完了 — 違反',
    titleCleared: '✅ 通報処理完了 — 違反なし',
    clearedBody: '確認の結果、規約違反ではありませんでした。ご報告ありがとうございます。',
    fieldRule: '規約',
    fieldAction: '措置',
    fieldReason: '理由',
    cleared: '確認の結果：規約違反ではありません。',
    mitigated: '該当メッセージは削除しました。ただし挑発への反応と判断したため、警告は付与していません。',
    queued: '通報を受け付けました。運営の確認待ちです。',
  },
  cn: {
    guildOnly: '只能在服务器频道内举报。',
    tooOld: '超过 {mins} 分钟的消息无法举报。',
    notReportable: '本频道的消息不在举报范围内。',
    originMissing: '找不到该翻译消息的原文（可能已过去太久）。',
    already: '该消息已处理过。',
    inFlight: '该消息的另一个举报正在处理中。',
    limitReporter: '已达到每小时举报上限，请稍后再试。',
    limitGlobal: '当前举报较多，请稍后再试。',
    sourceMissing: '找不到原始消息（可能已被删除）。',
    noText: '没有文字的消息无法判定。',
    judgeFailed: '判定失败，请稍后再试。',
    modalTitle: '举报消息',
    modalRule: '对应规则（选填）',
    modalRulePh: '例：辱骂 / 刷屏 / 骚扰 / 广告',
    modalReason: '举报理由（选填）',
    modalReasonPh: '请说明问题所在。',
    titleViolation: '🚨 举报处理完成 — 违规',
    titleCleared: '✅ 举报处理完成 — 未违规',
    clearedBody: '经审核未违反规则。感谢您的举报。',
    fieldRule: '规则',
    fieldAction: '处理',
    fieldReason: '理由',
    cleared: '审核结果：未违反规则。',
    mitigated: '该消息已删除。但因判定为受挑衅后的回应，未记入警告。',
    queued: '举报已受理，正在等待管理员审核。',
  },
};

// Language of the channel the report was filed from.
function langOf(interaction) {
  return LANG_BY_CHANNEL_ID[interaction.channelId] || 'kr';
}

function t(lang, key, vars) {
  let s = (T[lang] || T.kr)[key] || T.kr[key] || '';
  if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : ''));
  return s;
}

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
function resolveTarget(target, lang) {
  if (target.webhookId) {
    const rev = store.resolveReverse(target.id);
    if (!rev) return { error: t(lang, 'originMissing') };
    return rev;
  }
  if (!LANG_BY_CHANNEL_ID[target.channelId]) {
    return { error: t(lang, 'notReportable') };
  }
  return {
    sourceChannelId: target.channelId,
    sourceMessageId: target.id,
    authorId: target.author?.id,
  };
}

// Step 1: open the reason modal (or short-circuit if already processed).
async function showReportModal(interaction) {
  const lang = langOf(interaction);

  if (!interaction.guild) {
    await interaction.reply({
      content: t(lang, 'guildOnly'),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Age gate: block reports on old messages (no retroactive reporting).
  const ageMs = Date.now() - interaction.targetMessage.createdTimestamp;
  if (ageMs > MODERATION.reportMaxAgeMs) {
    await interaction.reply({
      content: t(lang, 'tooOld', {
        mins: Math.round(MODERATION.reportMaxAgeMs / 60000),
      }),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const resolved = resolveTarget(interaction.targetMessage, lang);
  if (resolved.error) {
    await interaction.reply({ content: resolved.error, flags: MessageFlags.Ephemeral });
    return;
  }

  const { sourceChannelId, sourceMessageId, authorId } = resolved;

  const cached = abuse.getCached(sourceMessageId);
  if (cached) {
    stats.increment('reportBlocked');
    await interaction.reply({
      content: `${t(lang, 'already')}\n${cached}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`rpt|${sourceChannelId}|${sourceMessageId}|${authorId}`)
    .setTitle(t(lang, 'modalTitle'));

  const ruleInput = new TextInputBuilder()
    .setCustomId('rule')
    .setLabel(t(lang, 'modalRule'))
    .setPlaceholder(t(lang, 'modalRulePh'))
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(60);

  const reasonInput = new TextInputBuilder()
    .setCustomId('reason')
    .setLabel(t(lang, 'modalReason'))
    .setPlaceholder(t(lang, 'modalReasonPh'))
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(MODERATION.reasonMaxLength);

  modal.addComponents(
    new ActionRowBuilder().addComponents(ruleInput),
    new ActionRowBuilder().addComponents(reasonInput)
  );

  await interaction.showModal(modal);
}

function resultEmbed({ violation, ruleTitle, action, reason, lang }) {
  return new EmbedBuilder()
    .setColor(violation ? 0xe74c3c : 0x2ecc71)
    .setTitle(t(lang, violation ? 'titleViolation' : 'titleCleared'))
    .setDescription(
      violation
        ? `**${t(lang, 'fieldRule')}:** ${ruleTitle}\n` +
          `**${t(lang, 'fieldAction')}:** ${action}\n` +
          `**${t(lang, 'fieldReason')}:** ${reason || '—'}`
        : t(lang, 'clearedBody')
    )
    .setTimestamp();
}

// Step 2: judge + enforce on modal submit.
async function handleReportSubmit(interaction) {
  const client = interaction.client;
  const lang = langOf(interaction);
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
    await interaction.editReply({ content: `${t(lang, 'already')}\n${cached}` });
    return;
  }

  // In-flight claim: block concurrent reports of the SAME message while its
  // judgment is running, so a message reported by many people at once cannot
  // rack up multiple strikes.
  if (!abuse.claim(sourceMessageId)) {
    stats.increment('reportBlocked');
    await interaction.editReply({ content: t(lang, 'inFlight') });
    return;
  }

  try {
    const gate = abuse.reserve(interaction.user.id);
    if (!gate.ok) {
      stats.increment('reportBlocked');
      await interaction.editReply({
        content: t(lang, gate.reason === 'reporter' ? 'limitReporter' : 'limitGlobal'),
      });
      return;
    }

    let sourceChannel;
    let sourceMessage;
    try {
      sourceChannel = await client.channels.fetch(sourceChannelId);
      sourceMessage = await sourceChannel.messages.fetch(sourceMessageId);
    } catch {
      await interaction.editReply({ content: t(lang, 'sourceMissing') });
      return;
    }

    const content = sourceMessage.content?.trim() || '';
    if (!content) {
      await interaction.editReply({ content: t(lang, 'noText') });
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
      replyLang: lang,
    });

    if (verdict.error) {
      // Release so it can be retried; nothing was enforced.
      abuse.release(sourceMessageId);
      await interaction.editReply({ content: t(lang, 'judgeFailed') });
      return;
    }

    let action = '없음 (위반 아님)';
    let replyText = t(lang, 'cleared');
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
      replyText = t(lang, 'mitigated');
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
      replyText = t(lang, 'queued');
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
          lang,
          violation: verdict.violation,
          // Rule title and reason both in the reporter's language.
          ruleTitle: verdict.violation ? rules.getTitle(verdict.ruleId, lang) : '',
          action,
          reason: verdict.reasonLocal,
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
