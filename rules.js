// Community moderation rule sheet.
//
// rules.json is a PUBLIC, git-tracked policy file (see .gitignore — plain .json
// is committed). Publish the same sheet to the server announcement so users can
// see exactly what is enforced. The judge LLM reads these rules and infers which
// specific rule (if any) a reported message violates.
//
// Hot-reloaded via fs.watch (same pattern as glossary.js), so editing rules.json
// updates enforcement live without a restart.
//
// File format (rules.json):
// {
//   "version": "YYYY-MM-DD",
//   "rules": [
//     {
//       "id": "profanity",
//       "title": { "kr": "...", "en": "...", "jp": "...", "cn": "..." },
//       "description": "English canonical description read by the judge LLM."
//     }
//   ]
// }

const fs = require('fs');
const path = require('path');

const RULES_PATH = path.join(__dirname, 'rules.json');

let VERSION = '';
let RULES = [];

function load() {
  try {
    if (!fs.existsSync(RULES_PATH)) {
      VERSION = '';
      RULES = [];
      console.error('rules: rules.json not found — moderation judgments disabled');
      return;
    }
    const parsed = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
    const list = Array.isArray(parsed?.rules) ? parsed.rules : [];
    RULES = list.filter(
      (r) => r && typeof r.id === 'string' && typeof r.description === 'string'
    );
    VERSION = typeof parsed?.version === 'string' ? parsed.version : '';
    console.log(`rules: loaded ${RULES.length} rule(s) (version ${VERSION || 'n/a'})`);
  } catch (err) {
    console.error('rules: load failed —', err?.message || err);
    // Keep the previous good copy on parse error rather than wiping enforcement.
  }
}

load();

// Hot-reload on file change (debounced), mirroring glossary.js.
try {
  const dir = path.dirname(RULES_PATH);
  let pending = null;
  const watcher = fs.watch(dir, (_event, filename) => {
    if (filename !== 'rules.json') return;
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      load();
    }, 200);
  });
  watcher.unref?.();
} catch {
  // fs.watch can fail on some filesystems — hot-reload disabled, load() already ran.
}

// Formatted rule list injected into the judge prompt (id + description).
function getRulesForPrompt() {
  if (RULES.length === 0) return '(no rules defined)';
  return RULES.map((r) => `- ${r.id}: ${r.description}`).join('\n');
}

// Localized, user-facing title for a rule id. Falls back en -> id.
function getTitle(ruleId, lang) {
  const rule = RULES.find((r) => r.id === ruleId);
  if (!rule) return ruleId || 'unknown';
  const t = rule.title;
  if (t && typeof t === 'object') {
    return t[lang] || t.en || ruleId;
  }
  return ruleId;
}

// Whether a rule id is known — used to reject judge output that cites a rule
// outside the sheet (the spec requires a specific, real matching rule).
function has(ruleId) {
  return RULES.some((r) => r.id === ruleId);
}

function version() {
  return VERSION;
}

function count() {
  return RULES.length;
}

module.exports = {
  getRulesForPrompt,
  getTitle,
  has,
  version,
  count,
  _reload: load,
};
