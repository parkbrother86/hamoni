// Admin moderation actions: mod-log recovery buttons + /strikes lookup.
// All gated behind the Moderate Members permission.

const {
  PermissionFlagsBits,
  MessageFlags,
  EmbedBuilder,
} = require('discord.js');

const strikes = require('./strikes');
const roles = require('./roles');

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
  handleStrikesCommand,
};
