'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  sessionId: null,
  sessionStart: null,
  dirty: false,
  editedFiles: [],
  commands: [],
  completedPending: [],
  completedAt: null,
  checklistSnapshot: null,
  checklistMtime: null,
  seededSession: false,
  activeClosePrompted: null,
  historyBroken: false,
  lastSummaryAt: null,
};

// Caps so .state.json can never grow without bound in a long session.
const MAX_FILES = 200;
const MAX_COMMANDS = 100;

function read(statePath) {
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULTS };
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

// Fold a value into a pushCapped list without disturbing its ordering/caps.
function mergeCapped(base, extra, max) {
  let out = Array.isArray(base) ? base.slice() : [];
  for (const v of Array.isArray(extra) ? extra : []) out = pushCapped(out, v, max);
  return out;
}

// Union two completedPending lists, deduped by the checklist key sync.js stamps
// on each item (falling back to the item itself for hand-built entries). Stop is
// the only writer that clears this field, and it always clears it wholesale, so
// an empty writer list means "flushed to a summary" — honour that rather than
// resurrecting what it deliberately resolved.
function mergePending(disk, mem) {
  const memList = Array.isArray(mem) ? mem : [];
  if (!memList.length) return [];
  const out = [];
  const seen = new Set();
  for (const item of [...(Array.isArray(disk) ? disk : []), ...memList]) {
    if (!item) continue;
    const key = item.key != null ? item.key : item.text != null ? item.text : item;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

// Whichever timestamp is later; nulls lose. Works for both the ms number in
// completedAt and the ISO string in lastSummaryAt (both sort correctly with >).
function newest(a, b) {
  if (a == null) return b;
  if (b == null) return a;
  return a > b ? a : b;
}

/**
 * Two Claude Code sessions in one project share this file. Re-read whatever the
 * other session last wrote and fold it into `state` so a plain last-writer-wins
 * rename can't silently drop its tracked work. A corrupt or absent file read()s
 * as DEFAULTS, which is neutral to every rule here, so the merge then degrades
 * to writing `state` unchanged — exactly the old behaviour.
 */
function merge(statePath, state) {
  const disk = read(statePath);
  return {
    // Session-scoped fields (identity, per-session flags, and the checklist
    // baseline this writer just computed) stay as the writer left them — a stale
    // disk copy from a concurrent session must not resurrect them.
    ...state,
    // Cross-session work: never lose the other session's edits or completions.
    editedFiles: mergeCapped(disk.editedFiles, state.editedFiles, MAX_FILES),
    commands: mergeCapped(disk.commands, state.commands, MAX_COMMANDS),
    completedPending: mergePending(disk.completedPending, state.completedPending),
    completedAt: newest(disk.completedAt, state.completedAt),
    lastSummaryAt: newest(disk.lastSummaryAt, state.lastSummaryAt),
    dirty: Boolean(disk.dirty) || Boolean(state.dirty),
  };
}

function write(statePath, state) {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const merged = merge(statePath, state);
    const tmp = `${statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
    fs.renameSync(tmp, statePath); // atomic, so a killed process can't truncate it
    return true;
  } catch {
    return false;
  }
}

/**
 * Session-scoped fields (dirty, edited files, seeding) reset when the session
 * id changes. Cross-session fields (checklistSnapshot, completedPending,
 * lastSummaryAt) survive.
 */
function forSession(statePath, sessionId) {
  const state = read(statePath);
  if (sessionId && state.sessionId !== sessionId) {
    state.sessionId = sessionId;
    state.sessionStart = new Date().toISOString();
    state.dirty = false;
    state.editedFiles = [];
    state.commands = [];
    state.seededSession = false;
    state.historyBroken = false;
  }
  return state;
}

function pushCapped(list, value, max) {
  if (!value) return list;
  const next = list.filter((v) => v !== value);
  next.push(value);
  return next.length > max ? next.slice(next.length - max) : next;
}

const addFile = (state, file) => {
  state.editedFiles = pushCapped(state.editedFiles || [], file, MAX_FILES);
};
const addCommand = (state, cmd) => {
  state.commands = pushCapped(state.commands || [], cmd, MAX_COMMANDS);
};

module.exports = { DEFAULTS, read, write, forSession, addFile, addCommand };
