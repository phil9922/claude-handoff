#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { paths, exists, HANDOFF_DIR } = require('../lib/paths');
const checklist = require('../lib/checklist');
const state = require('../lib/state');
const projectMemory = require('../lib/project');
const active = require('../lib/active');
const { syncChecklist } = require('../lib/sync');
const { run, context, slashCommand } = require('../lib/hook');
const logfile = require('../lib/logfile');
const registry = require('../lib/registry');

const MAX_PICKER_ITEMS = 4; // AskUserQuestion allows at most 4 options
const MAX_LISTED = 12;

/** Keep .handoff/ out of git without touching the repo's tracked .gitignore. */
function ensureGitExcluded(p) {
  try {
    if (!exists(path.join(p.projectRoot, '.git'))) return;
    const entry = `${HANDOFF_DIR}/`;
    let current = '';
    if (exists(p.gitExclude)) current = fs.readFileSync(p.gitExclude, 'utf8');
    const already = current.split(/\r?\n/).some((l) => l.trim() === entry || l.trim() === HANDOFF_DIR);
    if (already) return;
    fs.mkdirSync(path.dirname(p.gitExclude), { recursive: true });
    const prefix = !current || current.endsWith('\n') ? '' : '\n';
    fs.appendFileSync(p.gitExclude, `${prefix}${entry}\n`);
  } catch {
    /* non-fatal */
  }
}

function readIfPresent(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Drop fallback entries that a real write-up has since answered, and return the
 * log either way. Left in place a placeholder rides along in every future
 * recap, describing work that is already recorded properly just below it.
 *
 * The modification time is put back afterwards. Stop and SessionEnd both
 * compare it against the session start to decide whether a write-up already
 * happened, so touching it here would quietly disarm the safety net for the
 * rest of the session.
 */
function pruneLog(file) {
  const before = readIfPresent(file);
  try {
    const after = logfile.archiveOld(logfile.pruneSuperseded(before));
    if (after === before) return before;
    const { atime, mtime } = fs.statSync(file);
    fs.writeFileSync(file, after);
    fs.utimesSync(file, atime, mtime);
    return after;
  } catch {
    return before;
  }
}

/** Push embedded headings below our own so the recap reads as one document. */
function demote(text) {
  return text
    .split(/\r?\n/)
    .filter((l) => !/^#\s+/.test(l))
    .map((l) => (/^#{2,5}\s+/.test(l) ? `#${l}` : l))
    .join('\n')
    .trim();
}

/** The most recent dated block from LOG.md (entries are newest-first). */
function latestLogEntry(log) {
  if (!log.trim()) return '';
  const lines = log.split(/\r?\n/);
  const starts = [];
  lines.forEach((l, i) => {
    if (/^##\s+\d{4}-\d{2}-\d{2}/.test(l)) starts.push(i);
  });
  if (!starts.length) return '';
  const end = starts.length > 1 ? starts[1] : lines.length;
  return lines.slice(starts[0], end).join('\n').trim();
}

/** Strip the template's explanatory blockquote so the recap stays tight. */
function focusBlock(handoff) {
  return handoff
    .split(/\r?\n/)
    .filter((l) => !l.startsWith('> '))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function bootstrapContext() {
  return [
    '# Handoff: not set up in this project',
    '',
    `There is no \`${HANDOFF_DIR}/\` directory here yet.`,
    '',
    'Do NOT create it silently. Instead, at the start of your first reply, offer it in one or two sentences:',
    'you can set up session handoff tracking for this project — a dated log of what gets completed, plus a',
    'prioritized checklist with time estimates that survives across sessions.',
    '',
    `If the user accepts, run \`${slashCommand('handoff-init')}\`, or do the equivalent yourself:`,
    `1. Explore the project enough to judge its state (README, package manifests, entrypoints, TODO/FIXME markers, recent git log).`,
    `2. Create \`${HANDOFF_DIR}/HANDOFF.md\`, \`LOG.md\` and \`CHECKLIST.md\`.`,
    '3. Populate CHECKLIST.md with real, specific work you found, sorted into exactly three tiers:',
    '   `## P0 — Required to work` (the project is broken or incomplete without it),',
    '   `## P1 — Good ideas` (clear value, not blocking), `## P2 — Extras` (nice to have).',
    '4. Every item MUST use this exact format so the hooks can parse it:',
    '   `- [ ] [45m] Specific, actionable task description`',
    '   The bracketed estimate is required: minutes (`45m`) or hours (`2h`, `1.5h`). Estimate the',
    '   time for you to do the work, not a human, and be honest about uncertainty in the task text.',
    '',
    'If the user declines, drop it and do not ask again this session.',
  ].join('\n');
}

function recapContext(p, s) {
  const handoff = demote(focusBlock(readIfPresent(p.handoff)));
  const last = demote(latestLogEntry(pruneLog(p.log)));
  const config = checklist.loadConfig(p.dir);
  const checklistRaw = readIfPresent(p.checklist);
  const open = checklist.prioritize(checklist.openItems(checklistRaw, config));
  const groups = checklist.groupByTier(open);

  const memory = projectMemory.forInjection(p.project);
  const plan = active.load(p.active);

  const out = ['# Handoff: where we left off', ''];
  out.push('Open the conversation by presenting this to the user before anything else.', '');

  if (memory) {
    out.push(
      '## Project memory',
      '',
      'Why this project exists and what it must not break. Treat these as standing constraints on',
      'everything you do here — if a request conflicts with one, say so before acting.',
      '',
      demote(memory),
      ''
    );
  }

  if (handoff) out.push('## Current state', '', handoff, '');

  if (plan) {
    out.push('## Task in progress', '', active.summarize(plan), '');
    if (plan.approach) out.push(`Chosen approach: ${plan.approach}`, '');
    out.push('Steps:');
    for (const step of plan.steps) {
      out.push(`- [${step.checked ? 'x' : ' '}] [${step.est}] ${step.text}`);
    }
    out.push('', 'The full plan is in `.handoff/ACTIVE.md`. Resume from the first unchecked step —',
      'do not re-plan work that is already ticked off.', '');
  }

  if (last) out.push('## Last session', '', last, '');

  if (open.length) {
    const totalMin = open.reduce((sum, i) => sum + i.estMinutes, 0);
    out.push(
      `## Remaining work — ${open.length} open, ~${checklist.formatMinutes(totalMin)} total`,
      ''
    );
    for (const tier of ['P0', 'P1', 'P2']) {
      const items = groups[tier];
      if (!items.length) continue;
      out.push(`**${checklist.displayName(tier, config)} — ${checklist.TIERS[tier].label}**`);
      for (const item of items.slice(0, MAX_LISTED)) out.push(`- [${item.est}] ${item.text}`);
      if (items.length > MAX_LISTED) out.push(`- …and ${items.length - MAX_LISTED} more`);
      out.push('');
    }
  } else {
    out.push('## Remaining work', '', 'The checklist has no open items.', '');
  }

  // Resuming a half-finished task beats starting anything new, so it leads.
  const options = [];
  if (plan && plan.complete) {
    options.push(`Close out "${plan.title}" — all steps done; tick it off and record it`);
  } else if (plan && plan.current) {
    options.push(
      `Resume "${plan.title}" — step ${plan.done + 1} of ${plan.total}: ${plan.current.text} [${plan.current.est}]`
    );
  }
  for (const item of open.slice(0, MAX_PICKER_ITEMS)) {
    if (options.length >= MAX_PICKER_ITEMS) break;
    if (plan && plan.title && plan.title.trim() === item.text.trim()) continue; // already offered
    options.push(`[${checklist.displayName(item.tier, config)} · ${item.est}] ${item.text}`);
  }

  out.push('## What to do now', '');
  out.push(
    '1. Print a short recap: the current focus, what was completed last session, and how much is left.',
    '   Keep it to a few lines — the detail is above, do not restate all of it.'
  );

  if (options.length) {
    out.push(
      '2. Then immediately call AskUserQuestion with `multiSelect: true` so the user can choose what to',
      `   work on. Use ${
        options.length === 1 ? 'this option' : `these ${options.length} options in this order`
      }, each described by what it actually unblocks:`,
      ...options.map((o, n) => `   ${n + 1}. ${o}`),
      '3. Start on whatever the user selects. If they pick several, do them in the listed order.',
      '',
      'Do not ask permission to show the picker and do not offer a plain-text list instead — call the tool.'
    );
  } else {
    out.push(
      '2. There is nothing open, so instead ask whether to add new work to the checklist or close out the project.',
      '   Do not call AskUserQuestion with an empty list.'
    );
  }

  if (!memory) {
    out.push(
      '',
      '## No project memory yet',
      '',
      'There is no `.handoff/PROJECT.md`, so you know what the tasks are but not why they matter or',
      'what must never break. Once, and only if the user is doing substantial work here, mention that',
      `\`${slashCommand('handoff-project')}\` runs a short interview to capture it. Do not push it twice, and do not`,
      'interrupt the picker above to ask.'
    );
  }

  if (s.completedPending && s.completedPending.length) {
    out.push(
      '',
      '## Unrecorded completions',
      '',
      'These were ticked off but never written to the log — fold them into LOG.md as part of your first update:',
      ...s.completedPending.map((c) => `- ${c.text || c}`)
    );
  }

  return out.join('\n');
}

run(async (input) => {
  const p = paths(input.cwd);
  ensureGitExcluded(p);

  if (!exists(p.dir)) return context('SessionStart', bootstrapContext());

  // Note this tracked project in the cross-project registry for /handoff-all.
  // Isolated and swallowed on purpose: a registry problem must never touch the
  // recap below (upsert is already non-throwing; the guard is belt-and-braces).
  try {
    registry.upsert(p.projectRoot);
  } catch {
    /* non-fatal */
  }

  const s = state.forSession(p.state, input.session_id);
  // Reconcile against the previous session's snapshot BEFORE rebaselining —
  // anything ticked off between sessions (in an editor, or by hand) surfaces
  // here instead of being silently absorbed.
  syncChecklist(p, s, { force: true });
  state.write(p.state, s);

  return context('SessionStart', recapContext(p, s));
});
