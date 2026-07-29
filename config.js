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

  // Deterministic per-user history gathered as judge context.
  historyLimit: 15, // recent messages from the reported user handed to the judge
  historyScan: 100, // channel messages fetched, then filtered by author

  // Report-abuse defense (protects the reasoner path from flooding).
  limits: {
    perReporterPerHour: 5, // one reporter's report cap
    globalPerMinute: 20, // global reasoner-call cap (token bucket)
    verdictCacheMs: 10 * 60 * 1000, // same message re-report -> cached outcome
  },

  strike: {
    timeoutStartStrike: 3, // strike count at which timeouts begin (3 -> 1h, 4 -> 2h ...)
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
