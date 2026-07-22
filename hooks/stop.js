#!/usr/bin/env node
'use strict';

/**
 * The only place an LLM-quality handoff gets written.
 *
 * It fires on a real event — a checklist item being ticked off — rather than a
 * timer, so it costs a turn only when work actually lands. `additionalContext`
 * is the documented gentle form of Stop feedback: the conversation continues
 * and the transcript labels it "Stop hook feedback" instead of a hook error.
 */

const fs = require('fs');
const path = require('path');

const { paths, exists } = require('../lib/paths');
const state = require('../lib/state');
const { syncChecklist } = require('../lib/sync');
const checklist = require('../lib/checklist');
const active = require('../lib/active');
const history = require('../lib/history');
const { run, context, slashCommand } = require('../lib/hook');

const NUDGE = `⏲  handoff pending — type "update the handoff" or ${slashCommand('handoff')}`;

/** True when LOG.md was written after the completion was detected. */
function loggedSince(logPath, completedAt) {
  if (!completedAt) return false;
  try {
    return require('fs').statSync(logPath).mtimeMs > completedAt;
  } catch {
    return false;
  }
}

/**
 * Read the live criterion for every item, keyed the same way completions are.
 * completedPending entries carry their own `criterion` when track.js stamped it,
 * but an externally-ticked box may have been caught by Stop's own sync with no
 * criterion recorded — so we re-derive from CHECKLIST.md as the source of truth.
 * A read/parse failure degrades to an empty map (no gate), never a throw.
 */
function criteriaFromChecklist(p) {
  const map = {};
  let content;
  try {
    content = fs.readFileSync(p.checklist, 'utf8');
  } catch {
    return map;
  }
  for (const item of checklist.parse(content).items) {
    if (item.criterion) map[item.key] = item.criterion;
  }
  return map;
}

/**
 * Decide whether the Stop instruction should carry git-commit guidance, and
 * whether a review pass precedes it. Deterministic and cheap: a project is "git"
 * when its root holds a `.git` entry (a directory for a normal checkout, a file
 * for a worktree — both make `exists` true). `config.commit === false` opts the
 * whole section out; review is added only on `config.review === true`, and only
 * when committing at all. Any error reading the tree or the config degrades to
 * `{}` — today's instruction — so this can never break the session.
 */
function commitOptions(p) {
  try {
    const isGit = exists(path.join(p.projectRoot, '.git'));
    if (!isGit) return {};
    const config = checklist.loadConfig(p.dir);
    const commit = config.commit !== false; // default on for a git project
    if (!commit) return {};
    return { commit: true, review: config.review === true };
  } catch {
    return {};
  }
}

function summaryInstruction(s, criteria = {}, opts = {}) {
  // Git-commit guidance is opt-in on the caller's terms: `commit` is only true
  // for a git project that hasn't disabled it, `review` only when it also asked
  // for a self-review pass. Both default off, which reproduces today's text
  // byte-for-byte — the sections below are pure additions, never edits.
  const commit = opts.commit === true;
  const review = opts.review === true;

  const done = s.completedPending || [];
  const files = (s.editedFiles || []).slice(-40);
  const commands = (s.commands || []).slice(-10);

  const evidence = [files.length ? `Files touched: ${files.join(', ')}` : 'Files touched: none recorded'];
  if (commands.length) evidence.push(`Commands run: ${commands.join(' | ')}`);

  // Completed items that declared a success criterion. The tick doesn't count
  // until the criterion is checked THIS session — the gate below enforces that.
  const gated = done
    .map((c) => ({ item: c, criterion: c.criterion || criteria[c.key] || null }))
    .filter((g) => g.criterion);

  const lines = [
    '# Handoff update required',
    '',
    `${done.length} checklist item${done.length === 1 ? ' was' : 's were'} just completed. Record this before you finish.`,
    '',
    '## Completed',
    ...done.map((c) => `- [${c.tier || 'P1'} · ${c.est || '?'}] ${c.text || c.key}`),
    '',
  ];

  if (gated.length) {
    lines.push(
      '## Verification gate',
      '',
      `${gated.length} of these declared a success criterion. A criterion is NOT met until it has been`,
      'checked this session. Before you log anything, for EACH item below:',
      '',
      '- Quote the criterion verbatim.',
      '- Show the evidence you checked it THIS session — the test that ran and its output, the exact',
      '  command and what it printed, or the behavior you observed. An assertion with no evidence does not count.',
      '- If it was NOT verified this session: un-tick the item in `.handoff/CHECKLIST.md` (change its `- [x]`',
      '  back to `- [ ]`), state plainly what is still missing to verify it, and do NOT log it as completed.',
      '',
      ...gated.map((g) => `- ${g.item.text || g.item.key} — criterion: ${g.criterion}`),
      ''
    );
  }

  // Ordering is deliberate: the verification gate (above) proves the work is
  // done, the review reads the change, and only then does the commit record it —
  // all before the bookkeeping steps below. Each block is appended whole, so a
  // project that opts out of git keeps the instruction exactly as it is today.
  if (commit && review) {
    lines.push(
      '## Review',
      '',
      'Self-review before you commit. For each completed item:',
      '',
      '- Re-read the diff of the files you are about to stage: `git diff -- <paths>`, then `git diff --cached`',
      '  once they are staged. Read it as a reviewer would, not as the author.',
      '- Hold it to the item\'s success criterion when it declared one — the same criterion the verification',
      '  gate lists above. The diff must actually satisfy the criterion, not merely look plausible.',
      '- Fix anything the review surfaces before committing. If a problem is real but out of scope, write it',
      '  into the handoff instead of committing over it.',
      ''
    );
  }

  if (commit) {
    lines.push(
      '## Commit',
      '',
      'This project is a git repository. Turn each completed item into its own atomic commit.',
      '',
      '- Stage ONLY the files you changed this session (the ones listed under Evidence below) that still',
      '  exist and sit inside the project. Never stage anything under `.handoff/` — the handoff notes are not',
      '  part of the item\'s change; leave them out unless this repo already tracks them deliberately, and',
      '  even then commit them separately.',
      '- Stage with plain `git add` naming the explicit paths, so `.gitignore` is respected. Do NOT force',
      '  with `-f`, do NOT stage the whole working tree, and do NOT use `git commit -a` — stage the exact',
      '  paths for the item and nothing else.',
      '- One commit per completed item: the subject is the item text with the estimate tag removed, and the',
      '  body is the single line `Completed via handoff checklist.`',
      '- If several items completed together, split the staged files by the item they belong to and commit',
      '  them one item at a time. If a file genuinely can\'t be attributed to a single item, make one combined',
      '  commit and say so in its body.',
      ''
    );
  }

  lines.push(
    '## Evidence from this session',
    ...evidence,
    '',
    'Use the evidence above and what you already have in context. Do NOT re-read source files to',
    'compile this — it is a bookkeeping step, keep it small and fast.',
    '',
    '## Do exactly this',
    '',
    '1. `.handoff/LOG.md` — add today\'s entry (`## YYYY-MM-DD`) at the TOP of the file, or append to',
    '   today\'s existing heading. One bullet per completed item: what changed and why, and the files',
    '   involved. Concrete, past tense, no filler.',
    '2. `.handoff/HANDOFF.md` — rewrite the current focus, blockers, and the exact next step so a fresh',
    '   session could pick up cold. Delete anything the completed work made untrue.',
    '3. `.handoff/CHECKLIST.md` — the items are already ticked; leave them. Re-tier or re-estimate any',
    '   remaining item this work changed, and add anything new the work surfaced. Keep the exact format:',
    '   `- [ ] [45m] Task description` under a `## P0 — Required to work` / `## P1 — Good ideas` /',
    '   `## P2 — Extras` heading.',
    '4. `README.md` and `CLAUDE.md` — update these ONLY if the completed work changed what they document:',
    '   setup steps, commands, dependencies, architecture, env vars, or public behavior. For an internal',
    '   refactor or a bugfix that changes nothing a reader would rely on, leave both files alone. Do not',
    '   create either file if it does not already exist.',
    '',
    'Then stop. Report what you recorded in one line — do not paste the file contents back.'
  );

  return lines.join('\n');
}

run(async (input) => {
  // Claude Code is already continuing because of a stop hook; never stack on it.
  if (input.stop_hook_active) return null;

  const p = paths(input.cwd);
  if (!exists(p.dir)) return null;

  const s = state.forSession(p.state, input.session_id);
  // Catches a box ticked externally since the last tool call.
  syncChecklist(p, s);

  if (s.completedPending && s.completedPending.length) {
    // The write-up may have happened in the same turn as the tick — a tidy
    // session ticks the item and updates the log together. Asking for it again
    // wastes a turn and invites a duplicate entry.
    if (loggedSince(p.log, s.completedAt)) {
      s.completedPending = [];
      s.completedAt = null;
      s.lastSummaryAt = new Date().toISOString();
      state.write(p.state, s);
      return null;
    }

    const instruction = summaryInstruction(s, criteriaFromChecklist(p), commitOptions(p));
    s.completedPending = [];
    s.lastSummaryAt = new Date().toISOString();
    state.write(p.state, s);
    return context('Stop', instruction);
  }

  // Every step of the active plan is ticked but the checklist item isn't, so
  // the work is done and only the bookkeeping is outstanding. Prompt once per
  // plan — the flag is keyed by title so the next plan still gets its turn.
  const plan = active.load(p.active);
  if (plan && plan.complete && s.activeClosePrompted !== plan.title) {
    s.activeClosePrompted = plan.title;
    state.write(p.state, s);
    return context(
      'Stop',
      [
        '# Active task finished',
        '',
        `All ${plan.total} steps of "${plan.title}" are ticked off, but the item is still open in`,
        '`.handoff/CHECKLIST.md`. Close it out now:',
        '',
        '1. Tick the matching item in `.handoff/CHECKLIST.md`.',
        '2. Delete `.handoff/ACTIVE.md` — carry anything worth keeping from its Notes into the log.',
        '',
        'Ticking the item is what triggers the handoff write-up, so do that first and let the rest follow.',
        'If the work is NOT actually finished, untick the steps that are still outstanding instead.',
      ].join('\n')
    );
  }

  // Nothing completed, but there is unsaved work: make the reminder available
  // as ghost text the user can accept with the right arrow key.
  if (s.dirty && !s.seededSession) {
    const result = history.seed({ project: p.projectRoot, sessionId: input.session_id });
    s.seededSession = true;
    s.historyBroken = !result.ok;
    state.write(p.state, s);

    if (!result.ok) {
      if (process.env.HANDOFF_DEBUG) console.error('[handoff] seed failed:', result.reason);
      return { systemMessage: NUDGE };
    }
  }

  return null;
});
