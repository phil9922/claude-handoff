'use strict';

const fs = require('fs');
const checklist = require('./checklist');

/**
 * Reconcile CHECKLIST.md against the last snapshot we took.
 *
 * PostToolUse only sees edits Claude makes, so a box ticked in vim, Cursor, or
 * by `sed` is invisible to it. Every entry point calls this instead of trusting
 * the hook payload, which makes external edits first-class: whoever ticks the
 * box, the completion is recorded.
 *
 * Gated on mtime so the common case costs a single stat().
 */
function syncChecklist(paths, state, { force = false } = {}) {
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(paths.checklist).mtimeMs;
  } catch {
    return []; // no checklist yet
  }

  if (!force && state.checklistMtime === mtimeMs) return [];

  let content = '';
  try {
    content = fs.readFileSync(paths.checklist, 'utf8');
  } catch {
    return [];
  }

  // A null snapshot means we've never seen this file; baseline it silently
  // rather than reporting every already-ticked item as just-completed.
  const completed = checklist.newlyCompleted(state.checklistSnapshot, content);

  state.checklistSnapshot = checklist.snapshot(content);
  state.checklistMtime = mtimeMs;

  if (completed.length) {
    const pending = state.completedPending || [];
    const seen = new Set(pending.map((c) => c.key));
    for (const item of completed) {
      if (seen.has(item.key)) continue;
      seen.add(item.key);
      pending.push({ key: item.key, text: item.text, tier: item.tier, est: item.est });
    }
    state.completedPending = pending;
    // When the completion was noticed — lets Stop tell "already written up" from
    // "still outstanding" by comparing against LOG.md's mtime.
    if (!state.completedAt) state.completedAt = Date.now();
  }

  return completed;
}

module.exports = { syncChecklist };
