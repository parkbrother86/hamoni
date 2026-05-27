function sanitizeDiscordText(text) {
  return text
    .replace(/@everyone/gi, '@ everyone')
    .replace(/@here/gi, '@ here')
    .replace(/<@&\d+>/g, '[role mention]')
    .replace(/<@!?\d+>/g, '[user mention]')
    .replace(/<#\d+>/g, '[channel]')
    .trim();
}

function normalizeTranslatedText(text) {
  return sanitizeDiscordText(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join('\n');
}

const EMOJI_ONLY_RE =
  /^[\p{Extended_Pictographic}\p{Emoji_Component}\s]+$/u;
const URL_ONLY_RE =
  /^https?:\/\/\S+(?:\s+https?:\/\/\S+)*$/;
const NUMBER_ONLY_RE = /^[\d\s.,]+$/;
const CUSTOM_EMOJI_RE = /<a?:\w+:\d+>/g;

function isTranslatable(text) {
  const stripped = text.replace(CUSTOM_EMOJI_RE, '').trim();
  if (!stripped) return false;
  if (EMOJI_ONLY_RE.test(stripped)) return false;
  if (URL_ONLY_RE.test(stripped)) return false;
  if (NUMBER_ONLY_RE.test(stripped)) return false;
  return true;
}

function detectScript(text) {
  const cleaned = text.replace(CUSTOM_EMOJI_RE, '');
  let hangul = 0;
  let kana = 0;
  let han = 0;
  let latin = 0;
  let total = 0;

  for (const ch of cleaned) {
    const code = ch.codePointAt(0);
    if (
      (code >= 0xAC00 && code <= 0xD7AF) ||
      (code >= 0x1100 && code <= 0x11FF) ||
      (code >= 0x3130 && code <= 0x318F)
    ) {
      hangul++;
      total++;
    } else if (
      (code >= 0x3040 && code <= 0x309F) ||
      (code >= 0x30A0 && code <= 0x30FF)
    ) {
      kana++;
      total++;
    } else if (code >= 0x4E00 && code <= 0x9FFF) {
      han++;
      total++;
    } else if (
      (code >= 0x41 && code <= 0x5A) ||
      (code >= 0x61 && code <= 0x7A)
    ) {
      latin++;
      total++;
    }
  }

  if (total === 0) return null;

  if (kana > 0 && kana / total >= 0.2) return 'jp';

  const counts = { kr: hangul, cn: han, en: latin };
  let dominant = null;
  let max = 0;
  for (const [lang, count] of Object.entries(counts)) {
    if (count > max) {
      max = count;
      dominant = lang;
    }
  }

  if (max / total >= 0.6) return dominant;
  return null;
}

function renderMentions(text, message) {
  if (!message?.mentions) return text;
  let result = text;

  for (const [id, user] of message.mentions.users || []) {
    const member = message.mentions.members?.get(id);
    const name =
      member?.displayName ||
      user.globalName ||
      user.username ||
      'user';
    result = result
      .split(`<@${id}>`)
      .join(`@${name}`)
      .split(`<@!${id}>`)
      .join(`@${name}`);
  }

  for (const [id, role] of message.mentions.roles || []) {
    result = result.split(`<@&${id}>`).join(`@${role.name}`);
  }

  for (const [id, channel] of message.mentions.channels || []) {
    result = result.split(`<#${id}>`).join(`#${channel.name}`);
  }

  return result;
}

const glossary = require('./glossary');

function preprocessForTranslation(text, message, sourceLang) {
  const tokens = [];
  let result = text;
  let counter = 0;
  const nextPlaceholder = () => `⟪T${counter++}⟫`;

  if (message?.mentions) {
    for (const [id, user] of message.mentions.users || []) {
      const member = message.mentions.members?.get(id);
      const name =
        member?.displayName ||
        user.globalName ||
        user.username ||
        'user';
      const p = nextPlaceholder();
      tokens.push({ placeholder: p, original: `@${name}` });
      result = result
        .split(`<@${id}>`)
        .join(p)
        .split(`<@!${id}>`)
        .join(p);
    }

    for (const [id, role] of message.mentions.roles || []) {
      const p = nextPlaceholder();
      tokens.push({ placeholder: p, original: `@${role.name}` });
      result = result.split(`<@&${id}>`).join(p);
    }

    for (const [id, channel] of message.mentions.channels || []) {
      const p = nextPlaceholder();
      tokens.push({ placeholder: p, original: `#${channel.name}` });
      result = result.split(`<#${id}>`).join(p);
    }
  }

  result = result.replace(CUSTOM_EMOJI_RE, (match) => {
    const p = nextPlaceholder();
    tokens.push({ placeholder: p, original: match });
    return p;
  });

  // Glossary substitution: known terms → placeholders. The LLM never sees the
  // term itself; postprocessTranslation restores the canonical target form.
  if (sourceLang) {
    const matches = glossary.findMatches(result, sourceLang);
    // Process from the end so earlier indices stay valid as we splice in
    // placeholders of differing lengths.
    for (let i = matches.length - 1; i >= 0; i--) {
      const m = matches[i];
      const p = nextPlaceholder();
      tokens.push({ placeholder: p, termId: m.termId });
      result = result.slice(0, m.start) + p + result.slice(m.end);
    }
  }

  return { processed: result, tokens };
}

function postprocessTranslation(text, tokens, targetLang) {
  let result = text;
  for (const t of tokens) {
    let replacement;
    if (t.termId) {
      // Glossary token — restore to target-language canonical form.
      // Fallback to the placeholder itself if no canonical exists, so we
      // never silently drop it.
      replacement = glossary.getCanonical(t.termId, targetLang);
      if (replacement === null || replacement === undefined) {
        replacement = t.placeholder;
      }
    } else {
      // Mention / emoji token — restore the original text verbatim.
      replacement = t.original;
    }
    result = result.split(t.placeholder).join(replacement);
  }
  return result;
}

module.exports = {
  sanitizeDiscordText,
  normalizeTranslatedText,
  isTranslatable,
  detectScript,
  renderMentions,
  preprocessForTranslation,
  postprocessTranslation,
};
