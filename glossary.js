// Glossary: deterministic term substitution via placeholders.
//
// Terms in data/glossary.json get replaced with ⟪T*⟫ placeholders BEFORE the
// LLM call, then restored to the target-language canonical form AFTER. The
// LLM never sees the actual terms — it only round-trips opaque placeholders.
//
// Consequence: the system prompt is never modified by glossary growth, and
// every term is restored to its canonical target-language form 100% of the
// time, regardless of which model is used.
//
// File format (data/glossary.json):
// [
//   {
//     "id": "elancia",
//     "forms": {
//       "kr": ["일랜시아", "엘란시아"],
//       "en": ["Elancia"],
//       "jp": ["エランシア"],
//       "cn": ["伊兰西亚"]
//     }
//   },
//   ...
// ]
//
// First entry in each form array is the CANONICAL form (used on restore).
// Remaining entries are aliases (also matched on input).

const fs = require('fs');
const path = require('path');

const GLOSSARY_PATH = path.join(__dirname, 'data', 'glossary.json');
const EXAMPLE_PATH = path.join(__dirname, 'glossary.example.json');

let TERMS = [];

function load() {
  try {
    // Prefer data/glossary.json (user-managed), fall back to example
    let raw = null;
    if (fs.existsSync(GLOSSARY_PATH)) {
      raw = fs.readFileSync(GLOSSARY_PATH, 'utf8');
    } else if (fs.existsSync(EXAMPLE_PATH)) {
      raw = fs.readFileSync(EXAMPLE_PATH, 'utf8');
      console.log(
        'glossary: data/glossary.json not found, using glossary.example.json'
      );
    } else {
      TERMS = [];
      return;
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error('glossary.json must be a JSON array');
    }
    TERMS = parsed.filter(
      (t) => t && typeof t.id === 'string' && t.forms && typeof t.forms === 'object'
    );
    console.log(`glossary: loaded ${TERMS.length} term(s)`);
  } catch (err) {
    console.error('glossary: load failed —', err?.message || err);
    TERMS = [];
  }
}

load();

// Hot-reload on file change (debounced).
try {
  const dir = path.dirname(GLOSSARY_PATH);
  if (fs.existsSync(dir)) {
    let pending = null;
    const watcher = fs.watch(dir, (_event, filename) => {
      if (filename !== 'glossary.json') return;
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => {
        pending = null;
        load();
      }, 200);
    });
    // unref so the watcher doesn't keep short-lived scripts (tests etc.) alive
    watcher.unref?.();
  }
} catch {
  // fs.watch can fail on some filesystems — silently ignore, hot-reload disabled
}

// Find non-overlapping matches in `text` for the given source language.
// Returns: [{ termId, start, end }] sorted by `start`.
// Longest forms are preferred to avoid "일랜" matching inside "일랜시아".
function findMatches(text, sourceLang) {
  if (!sourceLang) return [];
  const allForms = [];
  for (const term of TERMS) {
    const list = term.forms?.[sourceLang];
    if (!Array.isArray(list)) continue;
    for (const form of list) {
      if (typeof form === 'string' && form.length > 0) {
        allForms.push({ termId: term.id, form });
      }
    }
  }
  if (allForms.length === 0) return [];

  // Longer forms first, so "일랜시아" claims its characters before "일랜" tries.
  allForms.sort((a, b) => b.form.length - a.form.length);

  const taken = new Array(text.length).fill(false);
  const matches = [];
  for (const { termId, form } of allForms) {
    let idx = 0;
    while (true) {
      const found = text.indexOf(form, idx);
      if (found < 0) break;
      const end = found + form.length;
      // Skip if any character is already taken
      let overlap = false;
      for (let i = found; i < end; i++) {
        if (taken[i]) { overlap = true; break; }
      }
      if (!overlap) {
        matches.push({ termId, start: found, end });
        for (let i = found; i < end; i++) taken[i] = true;
      }
      idx = end;
    }
  }
  matches.sort((a, b) => a.start - b.start);
  return matches;
}

// Look up the canonical form for `termId` in `lang`.
function getCanonical(termId, lang) {
  const term = TERMS.find((t) => t.id === termId);
  if (!term) return null;
  const list = term.forms?.[lang];
  if (!Array.isArray(list) || list.length === 0) return null;
  return list[0];
}

function size() {
  return TERMS.length;
}

module.exports = {
  findMatches,
  getCanonical,
  size,
  _reload: load, // exported for tests
};
