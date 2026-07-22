'use strict';

const fs = require('fs');
const path = require('path');

/**
 * CHECKLIST.md is the machine-readable contract between the human, Claude and
 * the hooks. Anything that doesn't match ITEM_RE is left completely alone, so
 * the file stays free-form editable.
 *
 *   ## P0 — Required to work
 *   - [ ] [45m] Wire auth middleware to session store
 */
const ITEM_RE = /^\s*[-*]\s+\[([ xX])\]\s+\[(\d+(?:\.\d+)?)(m|h)\]\s+(.+?)\s*$/;
const TIER_RE = /^\s*##\s+(P[0-2])\b/;

/**
 * An optional success criterion for the item directly above it, written as a
 * sub-bullet:
 *
 *   - [ ] [45m] Wire auth middleware to session store
 *     - ✓ login survives a server restart (integration test passes)
 *
 * The `✓` marker also accepts the ASCII fallbacks `v:` and `verify:` (any case),
 * so a criterion is writable without the Unicode glyph. Only the first criterion
 * under an item is taken. Sub-bullets that don't match this stay free-form notes
 * and are ignored, exactly as any unrecognized line is today.
 */
const CRITERION_RE = /^\s*[-*]\s+(?:✓|v:|verify:)\s*(.+?)\s*$/i;

const TIER_KEYS = ['P0', 'P1', 'P2'];

const TIERS = {
  P0: { key: 'P0', label: 'Required to work' },
  P1: { key: 'P1', label: 'Good ideas' },
  P2: { key: 'P2', label: 'Extras' },
};

/**
 * The whole per-project config, read from `<dir>/config.json`. Tier display
 * names are the original feature:
 *
 *   { "tiers": { "P0": "Now", "P1": "Soon", "P2": "Later" } }
 *
 * The canonical keys (P0/P1/P2) are what the code and files are keyed on — only
 * the DISPLAY changes. Partial maps are fine. Other recognized top-level keys
 * (currently the booleans `commit` and `review`, which gate the Stop hook's
 * git-commit guidance) are passed through untouched when present and well-typed.
 *
 * A missing file, invalid JSON, or a non-object body all degrade to `{ tiers: {} }`;
 * this never throws, so a broken file simply falls back to every default. Unknown
 * or wrongly-typed keys are dropped rather than surfaced, so callers can trust the
 * shape of what they read back.
 */
function loadConfig(dir) {
  const empty = { tiers: {} };
  if (!dir) return empty;
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
  } catch {
    return empty;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;

  // Tier names: identical semantics to before. A missing or wrong-shaped `tiers`
  // simply yields an empty map, never discarding the rest of the config.
  const tiers = {};
  const src = parsed.tiers;
  if (src && typeof src === 'object' && !Array.isArray(src)) {
    for (const key of TIER_KEYS) {
      const name = src[key];
      if (typeof name === 'string' && name.trim()) tiers[key] = name.trim();
    }
  }

  // Pass through recognized top-level flags only when they are booleans, so a
  // junk value can never masquerade as an opt-out. Absent keys stay absent, which
  // callers read as "use the default".
  const out = { tiers };
  if (typeof parsed.commit === 'boolean') out.commit = parsed.commit;
  if (typeof parsed.review === 'boolean') out.review = parsed.review;
  return out;
}

/** The label to show for a tier key, honoring any configured name. */
function displayName(tier, config) {
  const tiers = (config && config.tiers) || {};
  return tiers[tier] || tier;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolve a line to a canonical tier key, or null when it is not a tier heading
 * we recognise. A canonical `## P0` always wins. When display names are
 * configured, a heading whose text starts with a configured name (followed by a
 * word boundary) normalizes to that tier, so a team that renamed the headings in
 * their CHECKLIST.md still parses. A heading that matches names for more than one
 * tier is ambiguous and treated as not a heading (returns null), exactly as an
 * unrecognized heading is today.
 */
function tierOf(line, config) {
  const canonical = TIER_RE.exec(line);
  if (canonical) return canonical[1];
  const tiers = (config && config.tiers) || {};
  let found = null;
  for (const key of TIER_KEYS) {
    const name = tiers[key];
    if (!name) continue;
    const re = new RegExp(`^\\s*##\\s+${escapeRe(name)}(?=\\s|$)`);
    if (re.test(line)) {
      if (found && found !== key) return null; // ambiguous — behave as today
      found = key;
    }
  }
  return found;
}

function toMinutes(value, unit) {
  const n = parseFloat(value);
  if (!isFinite(n)) return 0;
  return unit === 'h' ? Math.round(n * 60) : Math.round(n);
}

function formatMinutes(min) {
  if (!min || min <= 0) return '0m';
  if (min < 60) return `${min}m`;
  const h = min / 60;
  return Number.isInteger(h) ? `${h}h` : `${h.toFixed(1)}h`;
}

/** Stable identity for an item: its text, case/space normalized. */
function keyOf(text) {
  return String(text).toLowerCase().replace(/\s+/g, ' ').trim();
}

function parse(content, config) {
  const items = [];
  if (!content) return { items };
  const lines = String(content).split(/\r?\n/);
  let tier = 'P1'; // items before any heading are treated as "good ideas"
  // The item a criterion sub-bullet attaches to. A heading ends the association;
  // a new item starts a fresh one. Free-form sub-bullets in between are ignored
  // and do not detach it, so a criterion can follow other notes under the item.
  let lastItem = null;

  lines.forEach((line, i) => {
    const t = tierOf(line, config);
    if (t) {
      tier = t;
      lastItem = null;
      return;
    }
    const m = ITEM_RE.exec(line);
    if (m) {
      const [, box, amount, unit, text] = m;
      const item = {
        tier,
        checked: box.toLowerCase() === 'x',
        estMinutes: toMinutes(amount, unit),
        est: `${amount}${unit}`,
        text: text.trim(),
        key: keyOf(text),
        line: i + 1,
      };
      items.push(item);
      lastItem = item;
      return;
    }
    // Attach the first criterion found under the current item; later ones and
    // non-matching sub-bullets are left as free-form notes.
    const c = CRITERION_RE.exec(line);
    if (c && lastItem && !lastItem.criterion) lastItem.criterion = c[1].trim();
  });

  return { items };
}

/** Map of key -> checked, used as the snapshot we diff against. */
function snapshot(content) {
  const out = {};
  for (const item of parse(content).items) out[item.key] = item.checked;
  return out;
}

/**
 * Items that went from unchecked to checked. Items absent from the previous
 * snapshot are ignored: a brand new line that arrives already ticked was never
 * "completed" during this session, it was just written down that way.
 */
function newlyCompleted(prevSnapshot, content) {
  if (!prevSnapshot) return [];
  const done = [];
  for (const item of parse(content).items) {
    if (!item.checked) continue;
    if (prevSnapshot[item.key] === false) done.push(item);
  }
  return done;
}

function openItems(content, config) {
  return parse(content, config).items.filter((i) => !i.checked);
}

function groupByTier(items) {
  const groups = { P0: [], P1: [], P2: [] };
  for (const item of items) (groups[item.tier] || groups.P1).push(item);
  return groups;
}

/**
 * P0 first, then P1, then P2. Within a tier the order written in the file is
 * preserved — that ordering is the author's stated priority, and sorting by
 * estimate would bury an important two-hour item under trivial cleanups.
 */
function prioritize(items) {
  const order = { P0: 0, P1: 1, P2: 2 };
  return items.slice().sort((a, b) => order[a.tier] - order[b.tier]); // Array#sort is stable
}

module.exports = {
  ITEM_RE,
  CRITERION_RE,
  TIERS,
  loadConfig,
  displayName,
  tierOf,
  parse,
  snapshot,
  newlyCompleted,
  openItems,
  groupByTier,
  prioritize,
  formatMinutes,
  keyOf,
};
