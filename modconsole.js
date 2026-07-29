// Ops console: plain-text moderation commands typed in the mod-log channel.
//
// Only messages in MODERATION.modLogChannelId, from a member with the Moderate
// Members permission, are interpreted. Everything else is ignored (so the
// channel still works as a normal log channel).
//
// Commands (prefix-less; the channel itself is the gate):
//   strikes @user|<id>       현재 누적 경고 + 이력 조회
//   reset   @user|<id>       경고 전체 초기화 + 타임아웃 해제 (완전 사면)
//   set     @user|<id> <n>   누적 경고를 n으로 설정
//   untimeout @user|<id>     타임아웃만 해제
//   help                     명령어 목록

const { PermissionFlagsBits, EmbedBuilder } = require('discord.js');

const { MODERATION } = require('./config');
const strikes = require('./strikes');
const roles = require('./roles');

const HELP = [
  '**모더레이션 콘솔** (이 채널 전용, 멤버 관리 권한 필요)',
  '`strikes @유저` — 누적 경고 + 이력 조회',
  '`reset @유저` — 경고 전체 초기화 + 타임아웃 해제',
  '`set @유저 <n>` — 누적 경고를 n으로 설정',
  '`untimeout @유저` — 타임아웃만 해제',
  '유저는 멘션 또는 ID 숫자로 지정',
].join('\n');

// Pull a target user id from a mention or a raw snowflake token.
function resolveUserId(message, token) {
  const mentioned = message.mentions?.users?.first();
  if (mentioned) return mentioned.id;
  if (token && /^\d{5,25}$/.test(token)) return token;
  return null;
}

function historyText(userId) {
  const count = strikes.get(userId);
  const hist = strikes.getHistory(userId);
  if (hist.length === 0) return `<@${userId}> — 누적 경고: **${count}회** · 기록 없음`;
  const lines = hist
    .slice(-10)
    .map((h) => `• ${h.ruleId || '—'} · ${h.ts ? `<t:${Math.floor(h.ts / 1000)}:R>` : '—'}`)
    .join('\n');
  return `<@${userId}> — 누적 경고: **${count}회**\n${lines}`;
}

async function reply(message, content) {
  try {
    await message.reply({ content, allowedMentions: { parse: [] } });
  } catch {
    // ignore reply failures
  }
}

async function clearTimeout(message, userId) {
  const member = await message.guild.members.fetch(userId).catch(() => null);
  if (!member) return false;
  try {
    await member.timeout(null, `manual clear by ${message.author.tag}`);
    return true;
  } catch (err) {
    console.error('modconsole: timeout clear failed —', err?.message || err);
    return false;
  }
}

async function syncRoles(message, userId, count) {
  const member = await message.guild.members.fetch(userId).catch(() => null);
  await roles.syncWarnRole(member, count);
}

async function handleLogMessage(message) {
  if (!MODERATION.modLogChannelId) return;
  if (message.channelId !== MODERATION.modLogChannelId) return;
  if (message.author?.bot || message.webhookId) return;
  if (!message.guild) return;
  if (!message.member?.permissions?.has(PermissionFlagsBits.ModerateMembers)) return;

  const raw = message.content?.trim();
  if (!raw) return;
  const tokens = raw.split(/\s+/);
  const cmd = tokens[0].toLowerCase();
  if (!['strikes', 'reset', 'set', 'untimeout', 'help', '조회', '초기화'].includes(cmd)) return;

  if (cmd === 'help') {
    await reply(message, HELP);
    return;
  }

  // Second token is usually the mention/id; for `set`, count is the last token.
  const userId = resolveUserId(message, tokens[1]);
  if (!userId) {
    await reply(message, '대상 유저를 멘션 또는 ID로 지정해 주세요. `help` 로 사용법 확인.');
    return;
  }

  if (cmd === 'strikes' || cmd === '조회') {
    const embed = new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle('경고 조회')
      .setDescription(historyText(userId))
      .setTimestamp();
    await message.reply({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
    return;
  }

  if (cmd === 'reset' || cmd === '초기화') {
    strikes.reset(userId);
    await syncRoles(message, userId, 0);
    const cleared = await clearTimeout(message, userId);
    await reply(
      message,
      `✅ <@${userId}> 경고 초기화 완료 (0회)${cleared ? ' · 타임아웃 해제됨' : ''}`
    );
    return;
  }

  if (cmd === 'untimeout') {
    const cleared = await clearTimeout(message, userId);
    await reply(message, cleared ? `✅ <@${userId}> 타임아웃 해제됨` : `타임아웃 해제 실패 (대상/권한 확인)`);
    return;
  }

  if (cmd === 'set') {
    const n = tokens[tokens.length - 1];
    if (!/^\d+$/.test(n)) {
      await reply(message, '숫자를 지정해 주세요. 예: `set @유저 2`');
      return;
    }
    const count = strikes.set(userId, n);
    await syncRoles(message, userId, count);
    await reply(message, `✅ <@${userId}> 누적 경고를 **${count}회**로 설정했습니다.`);
    return;
  }
}

module.exports = {
  handleLogMessage,
};
