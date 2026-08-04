// Blame-free cooldown for heated exchanges.
//
// The point of this module is what it does NOT do. Distinguishing a rage-baiter
// from someone who is merely unpopular requires a value judgment, and getting
// it wrong in the accusing direction brands a minority voice as a troll. So
// this assigns no fault at all: when two people start trading messages rapidly,
// it simply slows the exchange down.
//
// That is enough, because rage-baiting only pays off if it produces reactions.
// Remove the tempo and the payoff disappears without anyone having to prove
// intent — and the person holding an unpopular opinion is not punished either,
// since nothing here is a punishment.

const { MODERATION, LANG_BY_CHANNEL_ID } = require('./config');

const CFG = MODERATION.cooldown;

// channelId -> [{ userId, ts, repliedTo }]
const recent = new Map();
// "channelId:a|b" -> ts of last nudge, so a pair is not nudged repeatedly
const nudged = new Map();

const NUDGE = {
  kr: '🧊 잠시 속도를 늦춰주세요. 대화가 과열되고 있습니다.',
  en: '🧊 Please slow down — this exchange is heating up.',
  jp: '🧊 少しペースを落としてください。やり取りが白熱しています。',
  cn: '🧊 请稍微放慢节奏，对话有些激烈了。',
};

function pairKey(channelId, a, b) {
  return `${channelId}:${[a, b].sort().join('|')}`;
}

function prune(list, now) {
  const cutoff = now - CFG.windowSec * 1000;
  return list.filter((e) => e.ts >= cutoff);
}

// Record a message and report whether this channel just crossed into a heated
// two-person exchange. Returns { heated, a, b } — never a verdict about who is
// at fault, because that question is deliberately not asked.
function observe(message) {
  if (!CFG.enabled) return { heated: false };
  const channelId = message.channelId;
  if (!LANG_BY_CHANNEL_ID[channelId]) return { heated: false };

  const now = Date.now();
  const list = prune(recent.get(channelId) || [], now);
  list.push({
    userId: message.author.id,
    ts: now,
    repliedTo: message.reference?.messageId ? true : false,
    mentions: message.mentions?.users?.size || 0,
  });
  recent.set(channelId, list);

  // Count messages per author inside the window.
  const counts = new Map();
  for (const e of list) counts.set(e.userId, (counts.get(e.userId) || 0) + 1);
  const ranked = [...counts.entries()].sort((x, y) => y[1] - x[1]);
  if (ranked.length < 2) return { heated: false };

  const [[aId, aN], [bId, bN]] = ranked;
  if (aN + bN < CFG.minExchanges) return { heated: false };
  if (Math.min(aN, bN) < CFG.minEach) return { heated: false };

  // The pair must dominate the channel, otherwise this is just a busy channel.
  const others = ranked.slice(2).reduce((s, [, n]) => s + n, 0);
  if (others > aN + bN) return { heated: false };

  // Require actual turn-taking. Counting messages alone would pair a lone
  // spammer with whoever else happened to be talking; a real back-and-forth
  // alternates, a monologue does not.
  const seq = list
    .filter((e) => e.userId === aId || e.userId === bId)
    .map((e) => e.userId);
  let alternations = 0;
  for (let i = 1; i < seq.length; i++) {
    if (seq[i] !== seq[i - 1]) alternations++;
  }
  if (alternations < CFG.minAlternations) return { heated: false };

  // And some sign they are addressing each other rather than coincidentally
  // talking at once.
  const directed = list.some(
    (e) => (e.userId === aId || e.userId === bId) && (e.repliedTo || e.mentions > 0)
  );
  if (!directed) return { heated: false };

  const key = pairKey(channelId, aId, bId);
  const last = nudged.get(key) || 0;
  if (now - last < CFG.nudgeCooldownMin * 60 * 1000) return { heated: false };
  nudged.set(key, now);

  return { heated: true, a: aId, b: bId, channelId };
}

// Post a neutral, non-accusatory nudge. No one is named.
async function nudge(client, channelId) {
  const lang = LANG_BY_CHANNEL_ID[channelId] || 'kr';
  try {
    const channel = await client.channels.fetch(channelId);
    await channel.send({
      content: NUDGE[lang] || NUDGE.kr,
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    console.error('cooldown: nudge failed —', err?.message || err);
  }

  // Optional channel-wide slowmode. Off by default: it slows uninvolved people
  // too, so it is the operator's call whether that trade is worth it.
  if (CFG.slowmodeSec > 0) {
    try {
      const channel = await client.channels.fetch(channelId);
      const previous = channel.rateLimitPerUser || 0;
      await channel.setRateLimitPerUser(CFG.slowmodeSec, 'heated exchange cooldown');
      setTimeout(() => {
        channel
          .setRateLimitPerUser(previous, 'cooldown expired')
          .catch(() => {});
      }, CFG.slowmodeDurationMin * 60 * 1000).unref?.();
    } catch (err) {
      console.error('cooldown: slowmode failed —', err?.message || err);
    }
  }
}

module.exports = {
  observe,
  nudge,
};
