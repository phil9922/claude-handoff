#!/usr/bin/env node
'use strict';

/**
 * PostToolUse bookkeeping. Costs zero tokens and runs on every edit, so it is
 * deliberately tiny: record what changed, and watch CHECKLIST.md for items
 * being ticked off. Never blocks, never emits output.
 */

const path = require('path');

const { paths, exists } = require('../lib/paths');
const state = require('../lib/state');
const { syncChecklist } = require('../lib/sync');
const { run } = require('../lib/hook');

const IGNORED = new Set(['.state.json']);

/**
 * Stamp each just-completed item's success criterion onto its completedPending
 * entry, so Stop can hold the tick to its stated criterion. sync.js builds those
 * entries with {key, text, tier, est}; we thread `criterion` (the string, or null
 * when the item declared none) onto them here, matched by the same key sync.js
 * and state-merge dedup on. Adding one field keeps that dedup-by-key intact.
 */
function recordCriteria(state, completed) {
  if (!completed || !completed.length) return;
  const byKey = new Map(completed.map((it) => [it.key, it.criterion || null]));
  for (const entry of state.completedPending || []) {
    if (byKey.has(entry.key)) entry.criterion = byKey.get(entry.key);
  }
}

run(async (input) => {
  const p = paths(input.cwd);
  // No .handoff/ means the project hasn't opted in. Do nothing at all.
  if (!exists(p.dir)) return null;

  const s = state.forSession(p.state, input.session_id);
  const tool = input.tool_name || '';
  const args = input.tool_input || {};

  // Runs on every tool use, not just checklist edits, so a box ticked in an
  // external editor is still caught. Costs one stat() when nothing changed.
  const completed = syncChecklist(p, s);
  recordCriteria(s, completed);
  let changed = completed.length > 0;

  if (tool === 'Bash') {
    const cmd = (args.command || '').trim();
    if (cmd) {
      state.addCommand(s, cmd.length > 300 ? `${cmd.slice(0, 300)}…` : cmd);
      // Commands can change the tree in ways we can't see; assume they did.
      s.dirty = true;
      changed = true;
    }
  } else {
    const file = args.file_path || args.path;
    if (file && !IGNORED.has(path.basename(file))) {
      const rel = path.relative(p.projectRoot, file) || file;
      state.addFile(s, rel.startsWith('..') ? file : rel);
      s.dirty = true;
      changed = true;

      // Claude just wrote the checklist; mtime may not have advanced within the
      // same millisecond, so re-read unconditionally.
      if (path.resolve(file) === path.resolve(p.checklist)) recordCriteria(s, syncChecklist(p, s, { force: true }));
    }
  }

  if (changed) state.write(p.state, s);
  return null;
});
