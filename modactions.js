// Admin moderation actions: mod-log recovery buttons + /strikes lookup.
// All gated behind the Moderate Members permission.

const {
  PermissionFlagsBits,
  MessageFlags,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} = require('discord.js');

const strikes = require('./strikes');
const roles = require('./roles');
const rules = require('./rules');
const enforce = require('./enforce');
const reportload = require('./reportload');
const moderation = require('./moderation');

// Alerts already acted on, so a second operator clicking a stale card cannot
// double-punish. In-memory: a restart re-opens them, which is the safe default.
const handledAlerts = new Set();

function isMod(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers);
}

async function deny(interaction) {
  await interaction.reply({
    content: '이 작업에는 멤버 관리 권한이 필요합니다.',
    flags: MessageFlags.Ephemeral,
  });
}

function historyText(userId) {
  const count = strikes.get(userId);
  const hist = strikes.getHistory(userId);
  if (hist.length === 0) return `누적 경고: **${count}회** · 기록 없음`;
  const lines = hist
    .slice(-10)
    .map((h) => {
      const when = h.ts ? `<t:${Math.floor(h.ts / 1000)}:R>` : '—';
      return `• ${h.ruleId || '—'} · ${when}`;
    })
    .join('\n');
  return `누적 경고: **${count}회**\n${lines}`;
}

// mod|<action>|<offenderId>
async function handleButton(interaction) {
  if (!interaction.customId.startsWith('mod|')) return;
  if (!isMod(interaction)) return deny(interaction);

  const [, action, offenderId] = interaction.customId.split('|');

  if (action === 'history') {
    const embed = new EmbedBuilder()
      .setTitle(`경고 이력 · ${offenderId}`)
      .setColor(0x3498db)
      .setDescription(historyText(offenderId))
      .setTimestamp();
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    return;
  }

  if (action === 'strike_cancel') {
    const newCount = strikes.decrement(offenderId);
    const member = await interaction.guild.members.fetch(offenderId).catch(() => null);
    await roles.syncWarnRole(member, newCount);
    await interaction.reply({
      content: `✅ strike 취소됨 — 현재 누적 **${newCount}회** (${offenderId})`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (action === 'timeout_clear') {
    const member = await interaction.guild.members.fetch(offenderId).catch(() => null);
    if (!member) {
      await interaction.reply({
        content: '해당 멤버를 찾을 수 없습니다.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    try {
      await member.timeout(null, `manual clear by ${interaction.user.tag}`);
      await interaction.reply({
        content: `✅ 타임아웃 해제됨 (${offenderId})`,
        flags: MessageFlags.Ephemeral,
      });
    } catch (err) {
      await interaction.reply({
        content: `타임아웃 해제 실패: ${err?.message || err}`,
        flags: MessageFlags.Ephemeral,
      });
    }
    return;
  }
}

// ---------------------------------------------------------------------------
// Operator enforcement on review items (`rv|`) and report-load alerts (`rl|`)
// ---------------------------------------------------------------------------

function reportLoadText(userId) {
  const s = reportload.summarize(userId);
  const hist = reportload.history(userId, 10);
  const lines = [
    `누적 경고: **${strikes.get(userId)}회** (활성 ${strikes.activeCount(userId)}회)`,
    `신고 누적(${s.total}건): 서로 다른 ${s.distinctReporters}명 · 제3자 ${s.bystanderReporters}명 · 위반 ${s.upheld} / 아님 ${s.cleared}`,
  ];
  if (hist.length) {
    lines.push('', '최근 신고:');
    for (const ev of hist) {
      const when = ev.ts ? `<t:${Math.floor(ev.ts / 1000)}:R>` : '—';
      const mark = ev.verdict === 'upheld' ? '🚨' : '·';
      lines.push(`${mark} ${when} ${ev.suspectedRule || '—'}${ev.bystander ? ' (제3자)' : ''}`);
    }
  }
  return lines.join('\n');
}

// Mark the source card as handled and disable its buttons so a second operator
// does not act on the same case.
async function closeCard(interaction, resultLine) {
  try {
    const msg = interaction.message;
    if (!msg) return;
    handledAlerts.add(msg.id);
    const embed = EmbedBuilder.from(msg.embeds[0] || {});
    embed.addFields({
      name: '✅ 처리됨',
      value: `${resultLine} · by ${interaction.user.tag}`,
    });
    await msg.edit({ embeds: [embed], components: [] });
  } catch (err) {
    console.error('modactions: card close failed —', err?.message || err);
  }
}

// rv|<action>|<userId>[|<channelId>|<messageId>]   review item
// rl|<action>|<userId>                              report-load alert
async function handleEnforceButton(interaction) {
  if (!isMod(interaction)) return deny(interaction);

  const [prefix, action, userId, channelId, messageId] =
    interaction.customId.split('|');

  if (handledAlerts.has(interaction.message?.id) &&
      ['warn', 'timeout'].includes(action)) {
    await interaction.reply({
      content: '이미 처리된 건입니다.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (action === 'history') {
    const embed = new EmbedBuilder()
      .setTitle(`전체 이력 · ${userId}`)
      .setColor(0x3498db)
      .setDescription(reportLoadText(userId))
      .setTimestamp();
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    return;
  }

  if (action === 'watch') {
    const on = reportload.setWatch(userId, true);
    await interaction.reply({
      content: on ? `👁️ 관찰 지정됨 — 이후 더 낮은 임계값으로 알림됩니다.` : '해제됨',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (action === 'ignore') {
    reportload.ignore(userId);
    await closeCard(interaction, '무시 처리');
    await interaction.reply({
      content: '✖️ 무시 처리됨 — 일정 기간 재알림되지 않습니다.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (action === 'brief') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const brief = await moderation.patternBrief(interaction, userId);
    await interaction.editReply({
      content: brief
        ? `🔍 **패턴 분석** (판정이 아닌 참고 자료입니다)\n\n${brief}`
        : '패턴 분석에 실패했습니다.',
    });
    return;
  }

  // warn / timeout -> modal, so the operator's rationale is on the record.
  // These punish someone the judge did not convict, so the reason matters.
  if (action === 'warn' || action === 'timeout') {
    const modal = new ModalBuilder()
      .setCustomId(
        `${prefix}m|${action}|${userId}` +
          (channelId ? `|${channelId}|${messageId}` : '')
      )
      .setTitle(action === 'warn' ? '경고 부여' : '타임아웃');

    const first =
      action === 'warn'
        ? new TextInputBuilder()
            .setCustomId('rule')
            .setLabel('적용 규칙 id')
            .setPlaceholder('예: targeted_harassment')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(40)
        : new TextInputBuilder()
            .setCustomId('hours')
            .setLabel('타임아웃 시간 (시간 단위)')
            .setPlaceholder('예: 1')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(4);

    const reasonInput = new TextInputBuilder()
      .setCustomId('reason')
      .setLabel('사유 (기록에 남습니다)')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(300);

    modal.addComponents(
      new ActionRowBuilder().addComponents(first),
      new ActionRowBuilder().addComponents(reasonInput)
    );
    await interaction.showModal(modal);
  }
}

// rvm|<action>|<userId>[|<channelId>|<messageId>]
async function handleEnforceModal(interaction) {
  if (!isMod(interaction)) return deny(interaction);

  const [, action, userId, channelId, messageId] =
    interaction.customId.split('|');
  const reason = interaction.fields.getTextInputValue('reason')?.trim() || '';

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Delete the offending message when the card carried one.
  let message = null;
  if (channelId && messageId) {
    try {
      const ch = await interaction.client.channels.fetch(channelId);
      message = await ch.messages.fetch(messageId);
    } catch {
      message = null;
    }
  }

  if (action === 'warn') {
    const ruleId = interaction.fields.getTextInputValue('rule')?.trim();
    if (!rules.has(ruleId)) {
      await interaction.editReply({
        content: `규칙 id \`${ruleId}\` 를 찾을 수 없습니다. rules.json에 있는 id를 입력해 주세요.`,
      });
      return;
    }
    const { count, hours, deleted, timedOut } = await enforce.applyStrike(
      interaction.client,
      {
        guild: interaction.guild,
        userId,
        ruleId,
        messageId: messageId || null,
        sourceChannelId: channelId || null,
        message,
        reasonNote: `manual by ${interaction.user.tag}: ${reason}`,
      }
    );
    const summary =
      `경고 부여 (${ruleId}) → 누적 ${count}회` +
      (hours > 0 ? ` · 타임아웃 ${hours}시간${timedOut ? '' : '(실패)'}` : '') +
      (message ? (deleted ? ' · 메시지 삭제' : ' · 삭제 실패') : '');
    await closeCard(interaction, summary);
    await interaction.editReply({ content: `✅ ${summary}` });
    return;
  }

  if (action === 'timeout') {
    const hours = Number(interaction.fields.getTextInputValue('hours')?.trim());
    if (!Number.isFinite(hours) || hours <= 0 || hours > 672) {
      await interaction.editReply({ content: '시간은 1~672 사이 숫자로 입력해 주세요.' });
      return;
    }
    const { timedOut } = await enforce.applyTimeout(interaction.client, {
      guild: interaction.guild,
      userId,
      hours,
      ruleId: 'targeted_harassment',
      sourceChannelId: channelId || null,
      reasonNote: `manual by ${interaction.user.tag}: ${reason}`,
    });
    const summary = timedOut
      ? `타임아웃 ${hours}시간`
      : '타임아웃 실패 (권한/역할 위계 확인)';
    await closeCard(interaction, summary);
    await interaction.editReply({ content: `${timedOut ? '✅' : '⚠️'} ${summary}` });
  }
}

async function handleStrikesCommand(interaction) {
  if (!isMod(interaction)) return deny(interaction);
  const user = interaction.options.getUser('user', true);
  const embed = new EmbedBuilder()
    .setTitle(`경고 조회 · ${user.tag}`)
    .setColor(0x3498db)
    .setDescription(historyText(user.id))
    .setTimestamp();
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

module.exports = {
  handleButton,
  handleEnforceButton,
  handleEnforceModal,
  handleStrikesCommand,
};
