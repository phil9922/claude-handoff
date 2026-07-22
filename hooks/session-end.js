#!/usr/bin/env node
'use strict';

/**
 * Deterministic safety net. SessionEnd has no decision control and cannot ask
 * Claude for anything, so this writes a raw, auto-generated log entry from
 * tracked evidence — guaranteeing a record even when a window is closed hard
 * and no Stop hook ever fired.
 */

const fs = require('fs');
const { execFileSync } = require('child_process');

const { paths, exists } = require('../lib/paths');
const state = require('../lib/state');
const { run } = require('../lib/hook');
const { AUTO_MARKER, stripAutoBlocks } = require('../lib/logfile');

function gitDiffStat(cwd) {
  try {
    const out = execFileSync('git', ['diff', '--stat', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().split(/\r?\n/).slice(-1)[0] || '';
  } catch {
    return '';
  }
}

/** True if LOG.md was written after this session began — Claude already did it. */
function alreadySummarized(logPath, sessionStart) {
  try {
    if (!sessionStart) return false;
    const started = Date.parse(sessionStart);
    if (!isFinite(started)) return false;
    return fs.statSync(logPath).mtimeMs > started;
  } catch {
    return false;
  }
}

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Add today's block to LOG.md. If today already has a section — whether Claude
 * wrote it or a previous fallback did — the block is appended inside it rather
 * than creating a second heading for the same date.
 */
function prependEntry(logPath, date, block) {
  let existing = '';
  try {
    existing = fs.readFileSync(logPath, 'utf8');
  } catch {
    existing = '# Log\n';
  }
  let lines = existing.split(/\r?\n/);
  const isDated = (l) => /^##\s+\d{4}-\d{2}-\d{2}/.test(l);
  const today = lines.findIndex((l) => l.trim() === `## ${date}`);

  let next;
  if (today >= 0) {
    let end = lines.findIndex((l, i) => i > today && /^##\s/.test(l));
    if (end < 0) end = lines.length;
    // SessionEnd can fire more than once for one stretch of work, so the latest
    // fallback replaces the earlier one instead of stacking a near-identical entry.
    lines = stripAutoBlocks(lines, today, end);
    // The section may have shrunk, so recompute where it ends.
    end = lines.findIndex((l, i) => i > today && /^##\s/.test(l));
    if (end < 0) end = lines.length;
    next = [...lines.slice(0, end), ...block.split('\n'), '', ...lines.slice(end)];
  } else {
    let insertAt = lines.findIndex(isDated);
    if (insertAt < 0) insertAt = lines.length;
    const entry = [`## ${date}`, '', ...block.split('\n')];
    next = [...lines.slice(0, insertAt), ...entry, '', ...lines.slice(insertAt)];
  }

  fs.writeFileSync(logPath, next.join('\n').replace(/\n{3,}/g, '\n\n'));
}

// `/clear` and interactive `/resume` end a session but not the work — the user
// is still sitting there and a proper write-up is still coming.
const NOT_REALLY_OVER = new Set(['clear', 'resume']);

run(async (input) => {
  if (NOT_REALLY_OVER.has(input.reason)) return null;

  const p = paths(input.cwd);
  if (!exists(p.dir)) return null;

  const s = state.read(p.state);
  if (s.sessionId && input.session_id && s.sessionId !== input.session_id) return null;
  if (!s.dirty) return null;
  if (alreadySummarized(p.log, s.sessionStart)) return null;

  const files = s.editedFiles || [];
  const commands = s.commands || [];
  if (!files.length && !commands.length) return null;

  const stat = gitDiffStat(p.projectRoot);
  const reason = input.reason ? ` (${input.reason})` : '';

  const details = [];
  if (files.length) details.push(`- Files touched (${files.length}): ${files.slice(-30).join(', ')}`);
  if (commands.length) {
    // Shell one-liners can be enormous; the point is a hint at what ran.
    const shown = commands.slice(-5).map((c) => (c.length > 80 ? `${c.slice(0, 80)}…` : c));
    details.push(`- Commands run: ${shown.join(' | ')}`);
  }
  if (stat) details.push(`- Working tree: ${stat}`);

  const block = [`### Unwritten session${reason}`, '', AUTO_MARKER, '', ...details].join('\n');

  prependEntry(p.log, today(), block);

  s.dirty = false;
  state.write(p.state, s);
  return null;
});
