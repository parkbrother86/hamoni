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

module.exports = {
  CHANNELS,
  LANG_BY_CHANNEL_ID,
  LANG_LABEL,
  LANG_NATIVE,
  LANG_RULE,
  SOURCE_LANG_FLAG,
  MAX_MESSAGE_LENGTH,
};
