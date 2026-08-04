// Shared enforcement actions.
//
// Extracted from report.js because three paths now enforce: the automatic
// report verdict, the operator's decision on a low-confidence review item, and
// the operator's decision on a report-load alert. They must apply strikes,
// timeouts, role tags and public notices identically, or the escalation ladder
// and the public record diverge depending on which path acted.

const {
  CHANNELS,
  WARN_TEMPLATES,
  TIMEOUT_TEMPLATES,
  ESCALATION_NOTE,
} = require('./config');
const rules = require('./rules');
const strikes = require('./strikes');
const roles = require('./roles');
const campaign = require('./campaign');
const stats = require('./stats');

function fill(tpl, values) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (values[k] != null ? values[k] : ''));
}

// Post a localized, plaintext notice into every channel in that channel's own
// language. The offender is @mentioned only in their own source channel; the
// other channels name them without a ping.
async function announce(client, { sourceChannelId, authorId, name, ruleId, count, hours }) {
  const nextIsTimeout = hours === 0 && strikes.timeoutHours(count + 1) > 0;

  await Promise.all(
    Object.entries(CHANNELS).map(async ([lang, channelId]) => {
      const rule = rules.getTitle(ruleId, lang);
      const tpl = hours > 0 ? TIMEOUT_TEMPLATES[lang] : WARN_TEMPLATES[lang];
      if (!tpl) return;

      const isOwn = channelId === sourceChannelId;
      const displayName = isOwn && authorId ? `<@${authorId}>` : name;
      let content = fill(tpl, { name: displayName, rule, count, hours });
      if (nextIsTimeout && ESCALATION_NOTE[lang]) content += ESCALATION_NOTE[lang];

      try {
        const channel = await client.channels.fetch(channelId);
        await channel.send({
          content,
          allowedMentions: isOwn && authorId ? { users: [authorId] } : { parse: [] },
        });
        // A norm reminder right after a warning reads as piling on.
        campaign.markNotice(channelId);
      } catch (err) {
        console.error(`enforce: announce failed channel=${channelId}`, err?.message || err);
      }
    })
  );
}

async function resolveMember(guild, userId) {
  if (!guild) return null;
  return guild.members.fetch(userId).catch(() => null);
}

function displayNameOf(member, fallback) {
  return member?.displayName || fallback || 'user';
}

// Add a strike and apply the escalation ladder: delete the offending message if
// one is supplied, timeout once the ladder reaches it, sync the warn-count role
// and post the public notice.
// Returns { count, hours, deleted, timedOut }.
async function applyStrike(client, {
  guild,
  userId,
  displayName,
  ruleId,
  messageId,
  sourceChannelId,
  message,
  reasonNote,
}) {
  const member = await resolveMember(guild, userId);
  const name = displayNameOf(member, displayName);

  strikes.add(userId, { ruleId, messageId: messageId || null });
  // The ladder and the public notice both use the ACTIVE count (expired strikes
  // excluded), so "경고 N회" always matches the action actually taken.
  const count = strikes.activeCount(userId);
  const hours = strikes.timeoutHours(count);

  let deleted = false;
  if (message) {
    try {
      await message.delete();
      deleted = true;
      stats.increment('moderationDeletes');
    } catch (err) {
      console.error('enforce: delete failed —', err?.message || err);
    }
  }

  let timedOut = false;
  if (hours > 0 && member) {
    try {
      await member.timeout(
        hours * 60 * 60 * 1000,
        reasonNote || `rule ${ruleId}, strike ${count}`
      );
      timedOut = true;
      stats.increment('timeouts');
    } catch (err) {
      console.error('enforce: timeout failed —', err?.message || err);
    }
  }

  await roles.syncWarnRole(member, count);
  await announce(client, {
    sourceChannelId,
    authorId: userId,
    name,
    ruleId,
    count,
    hours,
  });

  return { count, hours, deleted, timedOut };
}

// Direct timeout without touching the strike ladder — operator discretion.
// Returns { timedOut }.
async function applyTimeout(client, {
  guild,
  userId,
  displayName,
  hours,
  ruleId,
  sourceChannelId,
  reasonNote,
}) {
  const member = await resolveMember(guild, userId);
  const name = displayNameOf(member, displayName);

  let timedOut = false;
  if (member) {
    try {
      await member.timeout(hours * 60 * 60 * 1000, reasonNote || 'manual timeout');
      timedOut = true;
      stats.increment('timeouts');
    } catch (err) {
      console.error('enforce: manual timeout failed —', err?.message || err);
    }
  }

  if (timedOut) {
    await announce(client, {
      sourceChannelId,
      authorId: userId,
      name,
      ruleId,
      count: strikes.activeCount(userId),
      hours,
    });
  }

  return { timedOut };
}

module.exports = {
  announce,
  applyStrike,
  applyTimeout,
};
