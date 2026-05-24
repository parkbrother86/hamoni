const {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');

const { snapshot } = require('./stats');
const { readRecent, summarize } = require('./metrics');

const statsCommand = new SlashCommandBuilder()
  .setName('stats')
  .setDescription('번역 봇 통계 보기');

function formatDuration(ms) {
  const sec = Math.floor(ms / 1000);
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (mins) parts.push(`${mins}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

function formatMs(n) {
  if (!n) return '—';
  if (n < 1000) return `${Math.round(n)}ms`;
  return `${(n / 1000).toFixed(2)}s`;
}

function renderSection(label, summary) {
  if (summary.total === 0) {
    return `**${label}**\n데이터 없음`;
  }
  const hitRatePct = (summary.hitRate * 100).toFixed(1);
  return [
    `**${label}**`,
    `콜수 \`${summary.total}\` · hit rate \`${hitRatePct}%\` · errors \`${summary.errors}\``,
    `p50 \`${formatMs(summary.latency.p50)}\` · p95 \`${formatMs(summary.latency.p95)}\` · p99 \`${formatMs(summary.latency.p99)}\` · avg \`${formatMs(summary.latency.avg)}\``,
  ].join('\n');
}

function renderByPair(summary) {
  const entries = Object.entries(summary.byPair);
  if (entries.length === 0) return '데이터 없음';
  entries.sort(([, a], [, b]) => b.p95 - a.p95);
  return entries
    .map(([pair, s]) => `\`${pair}\` p95 ${formatMs(s.p95)} (n=${s.count})`)
    .join('\n');
}

async function handleStats(interaction) {
  const s = snapshot();

  const [events1h, events24h] = await Promise.all([
    readRecent(60 * 60 * 1000),
    readRecent(24 * 60 * 60 * 1000),
  ]);
  const summary1h = summarize(events1h);
  const summary24h = summarize(events24h);

  const baseSection = [
    '**현재 세션**',
    `가동 \`${formatDuration(s.uptimeMs)}\` · rate limit drops \`${s.rateLimitDrops}\``,
    `edits \`${s.editsSync}\` · deletes \`${s.deletesSync}\``,
  ].join('\n');

  const description = [
    baseSection,
    '',
    renderSection('최근 1시간', summary1h),
    '',
    renderSection('최근 24시간', summary24h),
    '',
    '**언어쌍별 p95 (24h, 느린 순)**',
    renderByPair(summary24h),
  ].join('\n');

  const embed = new EmbedBuilder()
    .setTitle('번역 봇 통계')
    .setColor(0x3498DB)
    .setDescription(description.slice(0, 4000))
    .setTimestamp();

  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
  });
}

async function registerCommands(client) {
  if (!client.application) return;
  const payload = [statsCommand.toJSON()];

  if (client.guilds.cache.size === 0) {
    await client.application.commands.set(payload);
    console.log('Slash commands registered globally: /stats');
    return;
  }

  for (const guild of client.guilds.cache.values()) {
    try {
      await guild.commands.set(payload);
      console.log(
        `Slash commands registered on guild ${guild.name}: /stats`
      );
    } catch (err) {
      console.error(
        `Failed to register on guild ${guild.id}`,
        err?.message || err
      );
    }
  }
}

async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'stats') {
    try {
      await handleStats(interaction);
    } catch (err) {
      console.error('Stats command failed', err?.message || err);
    }
  }
}

module.exports = {
  registerCommands,
  handleInteraction,
};
