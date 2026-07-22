#!/usr/bin/env node
'use strict';

/**
 * Statusline: what model am I talking to, and what's outstanding here.
 *
 *   Opus 4.8 (1M context) │ 2 P0 · ~8.1h │ claude-handoff │ 14%
 *   Opus 4.8 (1M context) │ ▸ 2/3 Add a --help flag │ lead-router │ 31%
 *
 * Runs on every render, so it must be fast and silent: two small file reads,
 * everything wrapped, and any failure still prints the model rather than
 * nothing. Input arrives as JSON on stdin.
 */

const path = require('path');

const { paths, exists } = require('../lib/paths');
const checklist = require('../lib/checklist');
const active = require('../lib/active');
const projectMemory = require('../lib/project');

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const SEP = ` ${DIM}│${RESET} `;
const MAX_TASK = 30;

function truncate(text, max) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Outstanding work in the current project, or '' when it isn't tracked. */
function handoffSegment(cwd) {
  const p = paths(cwd);
  if (!exists(p.dir)) return '';

  const plan = active.load(p.active);
  if (plan && plan.total) {
    if (plan.complete) return `▸ ${plan.total}/${plan.total} ready to close`;
    return `▸ ${plan.done + 1}/${plan.total} ${truncate(plan.title, MAX_TASK)}`;
  }

  const config = checklist.loadConfig(p.dir);
  let open = [];
  try {
    open = checklist.openItems(require('fs').readFileSync(p.checklist, 'utf8'), config);
  } catch {
    return '';
  }
  if (!open.length) return '✓ clear';

  const p0 = open.filter((i) => i.tier === 'P0').length;
  const total = checklist.formatMinutes(open.reduce((n, i) => n + i.estMinutes, 0));
  const lead = p0 ? `${p0} ${checklist.displayName('P0', config)}` : `${open.length} open`;
  return `${lead} · ~${total}`;
}

function contextSegment(data) {
  const remaining = data.context_window?.remaining_percentage;
  if (remaining == null) return '';
  const used = Math.max(0, Math.min(100, Math.round(100 - remaining)));
  return `${used}%`;
}

function render(data) {
  const model = data.model?.display_name || 'Claude';
  const cwd = data.workspace?.current_dir || process.cwd();

  const segments = [`${DIM}${model}${RESET}`];

  let handoff = '';
  try {
    handoff = handoffSegment(cwd);
  } catch {
    /* never let the project state break the line */
  }
  if (handoff) segments.push(handoff);

  segments.push(`${DIM}${path.basename(cwd)}${RESET}`);

  const ctx = contextSegment(data);
  if (ctx) segments.push(`${DIM}${ctx}${RESET}`);

  return segments.join(SEP);
}

function main() {
  let input = '';
  const finish = () => {
    let out;
    try {
      out = render(JSON.parse(input || '{}'));
    } catch {
      out = `${DIM}Claude${RESET}`;
    }
    process.stdout.write(out);
    process.exit(0);
  };

  if (process.stdin.isTTY) return finish();
  const guard = setTimeout(finish, 2000);
  guard.unref?.();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    input += c;
  });
  process.stdin.on('end', () => {
    clearTimeout(guard);
    finish();
  });
  process.stdin.on('error', finish);
}

if (require.main === module) main();

module.exports = { render, handoffSegment };
