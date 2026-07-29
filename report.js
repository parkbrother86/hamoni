// Report orchestration: resolve target -> dedup/rate-limit -> judge -> enforce.
//
// Enforcement reuses the existing delete-propagation machinery: deleting the
// SOURCE message fires messageDelete, which removes all relayed copies. We only
// delete the source and let relay.js handle the fan-out cleanup.

const { MessageFlags } = require('discord.js');

const {
  CHANNELS,
  LANG_BY_CHANNEL_ID,
  WARN_TEMPLATES,
  TIMEOUT_TEMPLATES,
} = require('./config');
const store = require('./store');
const rules = require('./rules');
const strikes = require('./strikes');
const abuse = require('./abuse');
const moderation = require('./moderation');
const modlog = require('./modlog');
const stats = require('./stats');

function fill(tpl, values) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (values[k] != null ? values[k] : ''));
}

// Post a localized, plaintext moderation notice into every channel in that
// channel's own language.
async function announce(client, { name, ruleId, count, hours }) {
  await Promise.all(
    Object.entries(CHANNELS).map(async ([lang, channelId]) => {
      const rule = rules.getTitle(ruleId, lang);
      const tpl = hours > 0 ? TIMEOUT_TEMPLATES[lang] : WARN_TEMPLATES[lang];
      if (!tpl) return;
      const content = fill(tpl, { name, rule, count, hours });
      try {
        const channel = await client.channels.fetch(channelId);
        await channel.send({ content, allowedMentions: { parse: [] } });
      } catch (err) {
        console.error(
          `report: announce failed channel=${channelId}`,
          err?.message || err
        );
      }
    })
  );
}

// Resolve the reported message (original or relayed copy) to the source
// message origin. Returns { sourceChannelId, sourceMessageId, authorId } or a
// { error } string reason.
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

async function handleReport(interaction) {
  const client = interaction.client;
  stats.increment('reports');

  if (!interaction.guild) {
    await interaction.reply({
      content: '서버 채널에서만 신고할 수 있습니다.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const target = interaction.targetMessage;
  const resolved = resolveTarget(target);
  if (resolved.error) {
    await interaction.reply({ content: resolved.error, flags: MessageFlags.Ephemeral });
    return;
  }

  const { sourceChannelId, sourceMessageId, authorId } = resolved;

  // Cached outcome? Same message already judged -> instant, no LLM, no strike.
  const cached = abuse.getCached(sourceMessageId);
  if (cached) {
    stats.increment('reportBlocked');
    await interaction.reply({
      content: `이미 처리된 메시지입니다.\n${cached}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Reasoner is slow — defer immediately (3s interaction deadline).
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Rate-limit the reasoner path.
  const gate = abuse.reserve(interaction.user.id);
  if (!gate.ok) {
    stats.increment('reportBlocked');
    const msg =
      gate.reason === 'reporter'
        ? '시간당 신고 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.'
        : '지금 신고가 많아 잠시 대기가 필요합니다. 잠시 후 다시 시도해 주세요.';
    await interaction.editReply({ content: msg });
    return;
  }

  // Fetch the source message + author for canonical content and identity.
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
    await interaction.editReply({
      content: '텍스트가 없는 메시지는 판단할 수 없습니다.',
    });
    return;
  }

  const member = await interaction.guild.members
    .fetch(authorId)
    .catch(() => null);
  const offenderName =
    member?.displayName ||
    sourceMessage.member?.displayName ||
    sourceMessage.author?.globalName ||
    sourceMessage.author?.username ||
    'user';
  const offenderTag = sourceMessage.author?.tag || offenderName;

  // Gather deterministic per-user history as judge context.
  const history = await moderation.gatherUserHistory(sourceChannel, authorId);

  // Authoritative judgment.
  const verdict = await moderation.judge({
    content,
    history,
    authorName: offenderName,
  });

  if (verdict.error) {
    await interaction.editReply({
      content: '판단에 실패했습니다. 잠시 후 다시 시도해 주세요.',
    });
    return;
  }

  let action = '없음 (위반 아님)';
  let replyText = '검토 결과: 규정 위반이 아닙니다. 신고해 주셔서 감사합니다.';

  if (verdict.violation) {
    stats.increment('reportViolations');
    const count = strikes.add(authorId, {
      ruleId: verdict.ruleId,
      messageId: sourceMessageId,
    });
    const hours = strikes.timeoutHours(count);

    // Delete the source message — relay.js propagates deletion to all copies.
    try {
      await sourceMessage.delete();
      stats.increment('moderationDeletes');
    } catch (err) {
      console.error('report: source delete failed —', err?.message || err);
    }

    // Escalated timeout (strike >= start).
    let timedOut = false;
    if (hours > 0 && member) {
      try {
        await member.timeout(
          hours * 60 * 60 * 1000,
          `rule ${verdict.ruleId}, strike ${count}`
        );
        timedOut = true;
        stats.increment('timeouts');
      } catch (err) {
        console.error('report: timeout failed —', err?.message || err);
      }
    }

    await announce(client, { name: offenderName, ruleId: verdict.ruleId, count, hours });

    action =
      hours > 0
        ? `삭제 + 경고 ${count}회 + 타임아웃 ${hours}시간${timedOut ? '' : ' (권한 부족으로 실패)'}`
        : `삭제 + 경고 ${count}회`;
    replyText = `처리 완료: ${rules.getTitle(verdict.ruleId, 'kr')} 위반 · ${action}`;
  }

  abuse.setCached(sourceMessageId, replyText);

  modlog.postVerdict(client, {
    reporterTag: interaction.user.tag,
    offenderTag,
    offenderId: authorId,
    channelName: sourceChannel.name,
    content,
    verdict,
    action,
  });

  await interaction.editReply({ content: replyText });
}

module.exports = {
  handleReport,
};
