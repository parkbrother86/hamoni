const CHANNELS = {
  kr: '1469534211252682853',
  en: '1507806267522154669',
  jp: '1507806237096677376',
  cn: '1507807121159491604',
};

const LANG_BY_CHANNEL_ID = Object.fromEntries(
  Object.entries(CHANNELS).map(([lang, channelId]) => [
    channelId,
    lang,
  ])
);

const LANG_LABEL = {
  kr: 'Korean',
  en: 'English',
  jp: 'Japanese',
  cn: 'Simplified Chinese',
};

const LANG_NATIVE = {
  kr: '한국어',
  en: 'English',
  jp: '日本語',
  cn: '简体中文',
};

const LANG_RULE = {
  kr: 'Output MUST be written in Korean Hangul.',
  en: 'Output MUST be written in English.',
  jp: 'Output MUST be written in Japanese.',
  cn: 'Output MUST be written in Simplified Chinese characters. Do not output Korean.',
};

const SOURCE_LANG_FLAG = {
  kr: 'KR',
  en: 'EN',
  jp: 'JP',
  cn: 'ZH',
};

const MAX_MESSAGE_LENGTH = 300;

// Moderation / reporting subsystem.
const MODERATION = {
  // Private admin-only channel for verdict audit logs + prescreen flags.
  // Empty string disables mod-log posting (feature degrades gracefully).
  modLogChannelId: process.env.MODLOG_CHANNEL_ID || '1469540952598253669',

  // Report-triggered judge: reasoning model, off the hot path.
  judgeModel: 'deepseek-v4-pro',
  // Passive per-message pre-screen: cheap flash model, fired non-blocking.
  prescreenModel: 'deepseek-v4-flash',
  prescreenEnabled: process.env.PRESCREEN_ENABLED !== '0',

  // Only messages younger than this can be reported (no retroactive reports on
  // ancient messages).
  reportMaxAgeMs: 60 * 60 * 1000, // 1 hour

  // Conversation context gathered AROUND the reported message (all speakers),
  // handed to the judge so it reads the message in situ, not in isolation.
  contextBefore: 20, // lines before the reported message
  contextAfter: 10, // lines after the reported message

  // Report-abuse defense (protects the reasoner path from flooding).
  limits: {
    perReporterPerHour: 5, // one reporter's report cap
    globalPerMinute: 20, // global reasoner-call cap (token bucket)
    verdictCacheMs: 10 * 60 * 1000, // same message re-report -> cached outcome
  },

  strike: {
    timeoutStartStrike: 3, // strike count at which timeouts begin (3 -> 1h, 4 -> 2h ...)
    // Strikes older than this stop counting toward escalation (history is kept).
    // Without expiry a long-standing member who slipped twice months apart sits
    // permanently one step from a timeout, while a provocateur who never gets a
    // confirmed violation is unaffected.
    strikeExpiryDays: 90,
  },

  // Graduated rollout. A verdict only auto-enforces when its rule is not
  // flag-only AND its confidence clears the bar; everything else goes to the
  // mod-log review queue with enforcement buttons. Newly added rules start
  // flag-only so a broadened rule sheet cannot silently delete real
  // conversation — remove ids here once their false-positive rate is known.
  autoActionMinConfidence: 'high', // 'high' | 'medium' | 'low'

  // A violation that reads as a reaction to provocation is deleted but accrues
  // no strike (unless severity is high). This is the deliberate asymmetry: the
  // system declines to convict the provoker — mislabelling an unpopular voice
  // as a troll is far costlier than letting one mild reaction pass — and
  // instead simply stops over-punishing whoever took the bait.
  mitigateProvoked: true,
  flagOnlyRules: [
    'mental_health_slur',
    'dehumanizing_language',
    'appearance_harassment',
    'directed_profanity',
  ],

  // Norm-setting reminders, fired by message volume rather than a clock so they
  // land while people are actually talking. minIntervalMin is a floor that
  // stops a burst from firing several in a row.
  campaign: {
    enabled: true,
    everyMessages: 150, // per channel
    minIntervalMin: 60,
    quietAfterNoticeMin: 10, // don't stack onto a warning or cooldown nudge
  },

  // Blame-free cooldown on heated two-person exchanges. Assigns no fault, so it
  // needs no value judgment about who provoked whom — it just removes the tempo
  // that makes baiting pay.
  cooldown: {
    enabled: true,
    windowSec: 120,
    minExchanges: 8, // combined messages from the pair inside the window
    minEach: 3, // each of the two must be this active (rules out a monologue)
    minAlternations: 4, // turn changes required — a real exchange, not a spammer
    nudgeCooldownMin: 15,
    slowmodeSec: 0, // >0 applies channel slowmode; off by default (hits bystanders)
    slowmodeDurationMin: 5,
  },

  // Report accumulation: reports received regardless of verdict. Operator
  // visibility ONLY — never drives an automatic action, and is never shown to
  // the judge (that would let accusations sway verdicts, i.e. brigading).
  reportLoad: {
    windowDays: 7,
    alertDistinctReporters: 3, // distinct reporters -> alert
    alertBystanderReporters: 2, // uninvolved third parties -> stronger signal
    watchDistinctReporters: 2, // lowered threshold once flagged for watching
    burstWindowMin: 30, // reports clustered this tightly look coordinated
    ignoreDays: 30, // '무시' suppression window
    historyMaxDays: 90,
    excerptMaxLength: 100,
  },

  // Optional public "warning count" role tags shown next to the offender's name.
  // Highest tier whose `atLeast` <= cumulative strike count is applied; lower
  // warn-tier roles are removed. Empty by default (feature off until role ids
  // are filled in). Requires the bot to have Manage Roles and a role positioned
  // above the tier roles.
  //   warnRoleTiers: [
  //     { atLeast: 1, roleId: '...' },
  //     { atLeast: 3, roleId: '...' },
  //   ],
  warnRoleTiers: [],

  // Max characters accepted from the reporter's free-text reason.
  reasonMaxLength: 300,
};

// Appended to a warning notice when the NEXT strike would trigger a timeout.
const ESCALATION_NOTE = {
  kr: '\n⏳ 다음 위반 시 채팅이 일시 제한됩니다.',
  en: '\n⏳ Next violation may result in a mute.',
  jp: '\n⏳ 次回の違反でミュートの可能性があります。',
  cn: '\n⏳ 再次违规可能会被禁言。',
};

// Public localized moderation notices posted plaintext into every channel in
// that channel's language. Placeholders: {name} {rule} {count} {hours}.
const WARN_TEMPLATES = {
  kr: '⚠️ **{name}**님 · 커뮤니티 규정 위반({rule}) · 경고 **{count}회**입니다.',
  en: '⚠️ **{name}** · community rule violation ({rule}) · warning **#{count}**.',
  jp: '⚠️ **{name}** さん · コミュニティ規約違反（{rule}）· 警告 **{count}回**目です。',
  cn: '⚠️ **{name}** · 违反社区规则（{rule}）· 第 **{count}** 次警告。',
};

const TIMEOUT_TEMPLATES = {
  kr: '⛔ **{name}**님 · 규정 위반({rule}) 누적 **{count}회** · **{hours}시간** 채팅이 제한됩니다.',
  en: '⛔ **{name}** · {count} total violations ({rule}) · muted for **{hours}h**.',
  jp: '⛔ **{name}** さん · 規約違反（{rule}）累計 **{count}回** · **{hours}時間** ミュートです。',
  cn: '⛔ **{name}** · 累计违规 **{count}** 次（{rule}）· 禁言 **{hours}** 小时。',
};

module.exports = {
  CHANNELS,
  LANG_BY_CHANNEL_ID,
  LANG_LABEL,
  LANG_NATIVE,
  LANG_RULE,
  SOURCE_LANG_FLAG,
  MAX_MESSAGE_LENGTH,
  MODERATION,
  WARN_TEMPLATES,
  TIMEOUT_TEMPLATES,
  ESCALATION_NOTE,
};
