'use strict';

const fs = require('fs');
const checklist = require('./checklist');

/**
 * ACTIVE.md holds the plan for the ONE checklist item currently being worked.
 * Its steps use the same `- [ ] [30m] text` format as CHECKLIST.md, so the same
 * parser handles both and there is only one syntax to remember.
 *
 * Its job is position: after a context reset or a week away, "step 3 of 5, next
 * is X" is the difference between resuming and restarting.
 */
function read(activePath) {
  try {
    return fs.readFileSync(activePath, 'utf8');
  } catch {
    return '';
  }
}

function field(lines, name) {
  const re = new RegExp(`^\\s*(?:\\*\\*)?${name}(?:\\*\\*)?\\s*:\\s*(.+?)\\s*$`, 'i');
  for (const line of lines) {
    const m = re.exec(line);
    if (m) return m[1].trim();
  }
  return '';
}

function parse(content) {
  if (!content || !content.trim()) return null;
  const lines = content.split(/\r?\n/);

  const titleLine = lines.find((l) => /^#\s+/.test(l)) || '';
  const title = titleLine.replace(/^#\s+/, '').replace(/^Active:\s*/i, '').trim();

  const steps = checklist.parse(content).items;
  if (!title && !steps.length) return null;

  const done = steps.filter((s) => s.checked).length;
  const current = steps.find((s) => !s.checked) || null;
  const remaining = steps.filter((s) => !s.checked);

  return {
    title,
    approach: field(lines, 'Approach'),
    started: field(lines, 'Started'),
    item: field(lines, 'Item') || title,
    steps,
    done,
    total: steps.length,
    current,
    remainingMinutes: remaining.reduce((n, s) => n + s.estMinutes, 0),
    complete: steps.length > 0 && done === steps.length,
  };
}

function load(activePath) {
  return parse(read(activePath));
}

/** One-line status for the recap, e.g. "step 3 of 5 — Wire it into session-start". */
function summarize(plan) {
  if (!plan) return '';
  if (plan.complete) return `${plan.title} — all ${plan.total} steps done, needs closing out`;
  const next = plan.current ? ` — next: ${plan.current.text}` : '';
  const left = plan.remainingMinutes
    ? ` (~${checklist.formatMinutes(plan.remainingMinutes)} left)`
    : '';
  return `${plan.title} — step ${plan.done + 1} of ${plan.total}${next}${left}`;
}

module.exports = { read, parse, load, summarize };
