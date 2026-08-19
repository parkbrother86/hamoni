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
  // hours may arrive as a formatted string once a timeout is stacked; only the
  // no-timeout case (numeric 0) can precede a first mute.
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

// Two reports on two DIFFERENT messages by the same author are judged
// concurrently — abuse.js dedups per message, not per member — so their
// enforcement raced. Both read the member before either timeout landed, and
// whichever call reached Discord last won, which was often the shorter one: a
// burst of reports could come out lighter than a single one. Serialize per
// offender so each strike sees what the previous strike actually applied.
const chains = new Map();

function serialize(userId, fn) {
  const prev = chains.get(userId) || Promise.resolve();
  const next = prev.then(fn, fn); // run regardless of how the previous one ended
  chains.set(userId, next);
  // Drop the entry once this call is the tail and has settled, so the map does
  // not accumulate an entry per offender ever seen.
  next
    .catch(() => {})
    .finally(() => {
      if (chains.get(userId) === next) chains.delete(userId);
    });
  return next;
}

async function resolveMember(guild, userId) {
  if (!guild) return null;
  // force: a cached member carries a stale communicationDisabledUntil, and the
  // stacking below is only as good as that timestamp. discord.js patches a
  // clone on edit(), so the cache does not see a timeout applied moments ago.
  const fresh = await guild.members.fetch({ user: userId, force: true }).catch(() => null);
  return fresh || guild.members.fetch(userId).catch(() => null);
}

// A Discord timeout is an absolute expiry timestamp, not a duration that adds:
// a second call REPLACES the first. Extend from whatever is still running so a
// burst of violations costs the sum of its strikes rather than just the last.
function stackedTimeoutMs(member, addHours) {
  const now = Date.now();
  const until = member.communicationDisabledUntilTimestamp || 0;
  const remaining = until > now ? until - now : 0;
  return Math.min(remaining + addHours * 60 * 60 * 1000, strikes.MAX_TIMEOUT_HOURS * 60 * 60 * 1000);
}

// The public notice must state the time actually served, not the ladder step,
// or a stacked mute reads as shorter than it is. Stays a Number so the `> 0`
// checks downstream keep working; interpolation renders 5 as "5" and 5.8 as
// "5.8" on its own.
function servedHoursOf(ms) {
  return Math.round((ms / (60 * 60 * 1000)) * 10) / 10;
}

function displayNameOf(member, fallback) {
  return member?.displayName || fallback || 'user';
}

// Add a strike and apply the escalation ladder: delete the offending message if
// one is supplied, timeout once the ladder reaches it, sync the warn-count role
// and post the public notice.
// Returns { count, hours, deleted, timedOut }.
async function applyStrike(client, opts) {
  return serialize(opts.userId, () => applyStrikeInner(client, opts));
}

async function applyStrikeInner(client, {
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
  // What the member ends up serving: the ladder step plus whatever is left of a
  // timeout already running. Announced and reported in place of the raw step.
  let servedHours = hours;
  if (hours > 0 && member) {
    const ms = stackedTimeoutMs(member, hours);
    servedHours = servedHoursOf(ms);
    try {
      await member.timeout(ms, reasonNote || `rule ${ruleId}, strike ${count}`);
      timedOut = true;
      stats.increment('timeouts');
    } catch (err) {
      console.error('enforce: timeout failed —', err?.message || err);
      servedHours = hours;
    }
  }

  await roles.syncWarnRole(member, count);
  await announce(client, {
    sourceChannelId,
    authorId: userId,
    name,
    ruleId,
    count,
    hours: servedHours,
  });

  return { count, hours: servedHours, stepHours: hours, deleted, timedOut };
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
