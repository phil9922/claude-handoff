#!/usr/bin/env node
'use strict';

/**
 * Self-contained checks for the parsing, state and history logic, plus
 * end-to-end hook runs against a throwaway project. No network, no installer.
 *
 *   node test/run.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const checklist = require('../lib/checklist');
const history = require('../lib/history');

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

function tmpdir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `handoff-${label}-`));
}

/** Run a hook the way Claude Code does: JSON on stdin, JSON or nothing on stdout. */
function runHook(script, input, env = {}) {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'hooks', script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (!out.trim()) return null;
  return JSON.parse(out);
}

console.log('\nchecklist parsing');

test('parses tiers, estimates and checked state', () => {
  const md = [
    '## P0 — Required to work',
    '- [ ] [45m] Wire auth middleware',
    '- [x] [2h] Fix the build',
    '## P1 — Good ideas',
    '- [ ] [1.5h] Add retry to webhook sender',
    '## P2 — Extras',
    '- [ ] [30m] Dark mode',
  ].join('\n');
  const { items } = checklist.parse(md);
  assert.strictEqual(items.length, 4);
  assert.strictEqual(items[0].tier, 'P0');
  assert.strictEqual(items[0].estMinutes, 45);
  assert.strictEqual(items[1].checked, true);
  assert.strictEqual(items[2].estMinutes, 90);
  assert.strictEqual(items[3].tier, 'P2');
});

test('ignores prose and malformed lines', () => {
  const md = [
    '# Checklist',
    '> - [ ] [45m] this is inside a quote',
    '- [ ] no estimate here',
    '- [ ] [45] missing unit',
    'random text',
    '## P0 — Required to work',
    '- [ ] [10m] Real item',
  ].join('\n');
  const { items } = checklist.parse(md);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].text, 'Real item');
});

test('detects only unchecked -> checked transitions', () => {
  const before = '## P0 — Required to work\n- [ ] [45m] Task A\n- [x] [1h] Task B';
  const after = '## P0 — Required to work\n- [x] [45m] Task A\n- [x] [1h] Task B\n- [x] [5m] Task C';
  const snap = checklist.snapshot(before);
  const done = checklist.newlyCompleted(snap, after);
  assert.strictEqual(done.length, 1, 'already-done and newly-added-ticked items must not count');
  assert.strictEqual(done[0].text, 'Task A');
});

test('prioritizes by tier, preserving written order within a tier', () => {
  const md = [
    '## P2 — Extras',
    '- [ ] [5m] Extra quick',
    '## P0 — Required to work',
    '- [ ] [2h] Big blocker listed first on purpose',
    '- [ ] [10m] Small blocker',
  ].join('\n');
  const order = checklist.prioritize(checklist.openItems(md)).map((i) => i.text);
  assert.deepStrictEqual(order, [
    'Big blocker listed first on purpose',
    'Small blocker',
    'Extra quick',
  ]);
});

test('formats totals readably', () => {
  assert.strictEqual(checklist.formatMinutes(45), '45m');
  assert.strictEqual(checklist.formatMinutes(120), '2h');
  assert.strictEqual(checklist.formatMinutes(90), '1.5h');
});

console.log('\nhistory seeding');

const validLine = (over = {}) =>
  JSON.stringify({
    display: 'do a thing',
    pastedContents: {},
    timestamp: Date.now(),
    project: '/some/project',
    sessionId: 'abc',
    ...over,
  });

test('appends one entry to a well-formed file', () => {
  const dir = tmpdir('hist');
  const file = path.join(dir, 'history.jsonl');
  fs.writeFileSync(file, `${validLine()}\n${validLine()}\n`);
  const before = fs.readFileSync(file, 'utf8');

  const res = history.seed({ project: '/some/project', sessionId: 's1', file });
  assert.strictEqual(res.seeded, true);

  const after = fs.readFileSync(file, 'utf8');
  assert.ok(after.startsWith(before), 'existing lines must be preserved byte-for-byte');
  const lines = after.trim().split('\n');
  assert.strictEqual(lines.length, 3);
  const added = JSON.parse(lines[2]);
  assert.strictEqual(added.display, 'update the handoff');
  assert.strictEqual(added.project, '/some/project');
});

test('does not double-seed when it is already the latest for that project', () => {
  const dir = tmpdir('hist2');
  const file = path.join(dir, 'history.jsonl');
  fs.writeFileSync(file, `${validLine({ display: 'update the handoff' })}\n`);
  const res = history.seed({ project: '/some/project', file });
  assert.strictEqual(res.seeded, false);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1);
});

test('re-seeds when newer prompts have outranked it', () => {
  const dir = tmpdir('hist3');
  const file = path.join(dir, 'history.jsonl');
  fs.writeFileSync(
    file,
    `${validLine({ display: 'update the handoff' })}\n${validLine({ display: 'something else' })}\n`
  );
  assert.strictEqual(history.seed({ project: '/some/project', file }).seeded, true);
});

test('refuses to write when the format is unfamiliar', () => {
  const dir = tmpdir('hist4');
  const file = path.join(dir, 'history.jsonl');
  const contents = JSON.stringify({ someNewSchema: true, text: 'hi' });
  fs.writeFileSync(file, `${contents}\n`);
  const res = history.seed({ project: '/p', file });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), `${contents}\n`, 'file must be untouched');
});

test('refuses when the file is missing entirely', () => {
  const res = history.seed({ project: '/p', file: path.join(tmpdir('hist5'), 'nope.jsonl') });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'missing');
});

test('repairs a missing trailing newline instead of corrupting the last line', () => {
  const dir = tmpdir('hist6');
  const file = path.join(dir, 'history.jsonl');
  fs.writeFileSync(file, validLine()); // no trailing \n
  history.seed({ project: '/some/project', file });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 2);
  lines.forEach((l) => JSON.parse(l)); // both must still parse
});

console.log('\nproject memory + active plans');

const activeLib = require('../lib/active');
const projectLib = require('../lib/project');

test('an unfilled PROJECT.md template is treated as absent', () => {
  const tpl = fs.readFileSync(path.join(ROOT, 'templates', 'PROJECT.md'), 'utf8');
  assert.strictEqual(projectLib.isPopulated(tpl), false);
  const dir = tmpdir('proj');
  const file = path.join(dir, 'PROJECT.md');
  fs.writeFileSync(file, tpl);
  assert.strictEqual(projectLib.forInjection(file), null);
});

test('a populated PROJECT.md is injected without its guidance blockquote', () => {
  const dir = tmpdir('proj2');
  const file = path.join(dir, 'PROJECT.md');
  fs.writeFileSync(file, '# Project\n\n> guidance to strip\n\n## Must never break\n\n- Lead delivery to the CRM\n');
  const text = projectLib.forInjection(file);
  assert.ok(text.includes('Lead delivery to the CRM'));
  assert.ok(!text.includes('guidance to strip'));
});

test('active plan reports position, not just progress', () => {
  const plan = activeLib.parse(
    [
      '# Active: Add the --help flag',
      '',
      'Approach: minimal, no arg parser dependency',
      '',
      '## Steps',
      '- [x] [10m] Write the usage text',
      '- [ ] [20m] Wire it into argv handling',
      '- [ ] [15m] Cover it with a test',
    ].join('\n')
  );
  assert.strictEqual(plan.title, 'Add the --help flag');
  assert.strictEqual(plan.approach, 'minimal, no arg parser dependency');
  assert.strictEqual(plan.done, 1);
  assert.strictEqual(plan.total, 3);
  assert.strictEqual(plan.complete, false);
  assert.strictEqual(plan.current.text, 'Wire it into argv handling');
  assert.strictEqual(plan.remainingMinutes, 35);
  const summary = activeLib.summarize(plan);
  assert.ok(summary.includes('step 2 of 3'));
  assert.ok(summary.includes('Wire it into argv handling'));
});

test('a fully ticked plan is flagged as needing close-out', () => {
  const plan = activeLib.parse('# Active: Ship it\n\n## Steps\n- [x] [5m] One\n- [x] [5m] Two');
  assert.strictEqual(plan.complete, true);
  assert.ok(activeLib.summarize(plan).includes('needs closing out'));
});

console.log('\nstatusline');

const statusline = require('../hooks/statusline');
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('shows the model name first, always', () => {
  const line = strip(
    statusline.render({
      model: { display_name: 'Opus 4.8 (1M context)' },
      workspace: { current_dir: tmpdir('sl') },
    })
  );
  assert.ok(line.startsWith('Opus 4.8 (1M context)'), line);
});

test('falls back to a model name when given nothing at all', () => {
  assert.strictEqual(strip(statusline.render({})).split(' │ ')[0], 'Claude');
});

test('summarizes outstanding work and context use', () => {
  const p = project('sl2');
  const line = strip(
    statusline.render({
      model: { display_name: 'Opus 4.8' },
      workspace: { current_dir: p.dir },
      context_window: { remaining_percentage: 86 },
    })
  );
  assert.ok(line.includes('2 P0'), line);
  assert.ok(line.includes('~2.8h'), line);
  assert.ok(line.includes('14%'), line);
});

test('an in-progress plan replaces the counts with the resume point', () => {
  const p = project('sl3');
  fs.writeFileSync(
    path.join(p.handoff, 'ACTIVE.md'),
    '# Active: Add a --help flag\n\n## Steps\n- [x] [10m] One\n- [ ] [5m] Two\n- [ ] [5m] Three'
  );
  const line = strip(
    statusline.render({ model: { display_name: 'Opus' }, workspace: { current_dir: p.dir } })
  );
  assert.ok(line.includes('▸ 2/3'), line);
  assert.ok(line.includes('Add a --help flag'), line);
});

test('says nothing about work in untracked projects', () => {
  const dir = tmpdir('sl4');
  const line = strip(
    statusline.render({ model: { display_name: 'Opus' }, workspace: { current_dir: dir } })
  );
  assert.strictEqual(line, `Opus │ ${path.basename(dir)}`);
});

test('a broken checklist cannot break the statusline', () => {
  const p = project('sl5');
  fs.writeFileSync(p.checklist, '   not markdown at all');
  const line = strip(
    statusline.render({ model: { display_name: 'Opus' }, workspace: { current_dir: p.dir } })
  );
  assert.ok(line.startsWith('Opus'), line);
});

console.log('\nhooks (end to end)');

function project(label) {
  const dir = tmpdir(label);
  const handoff = path.join(dir, '.handoff');
  fs.mkdirSync(handoff);
  fs.copyFileSync(path.join(ROOT, 'templates', 'LOG.md'), path.join(handoff, 'LOG.md'));
  fs.copyFileSync(path.join(ROOT, 'templates', 'HANDOFF.md'), path.join(handoff, 'HANDOFF.md'));
  fs.writeFileSync(
    path.join(handoff, 'CHECKLIST.md'),
    ['## P0 — Required to work', '- [ ] [45m] Task A', '- [ ] [2h] Task B'].join('\n')
  );
  return { dir, handoff, checklist: path.join(handoff, 'CHECKLIST.md') };
}

test('session-start emits a recap and orders the picker P0 first', () => {
  const p = project('start');
  const out = runHook('session-start.js', { cwd: p.dir, session_id: 's1' });
  const text = out.hookSpecificOutput.additionalContext;
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.ok(text.includes('AskUserQuestion'), 'must instruct the picker');
  assert.ok(text.includes('multiSelect: true'));
  assert.ok(text.indexOf('Task A') < text.indexOf('Task B'), 'quicker P0 item first');
  assert.ok(text.includes('~2.8h') || text.includes('2.8h'), 'shows a total estimate');
});

test('session-start invites bootstrap when .handoff is absent', () => {
  const dir = tmpdir('cold');
  const out = runHook('session-start.js', { cwd: dir, session_id: 's1' });
  const text = out.hookSpecificOutput.additionalContext;
  assert.ok(text.includes('/handoff-init'));
  assert.ok(!fs.existsSync(path.join(dir, '.handoff')), 'must not create anything unasked');
});

test('session-start injects project memory as standing constraints', () => {
  const p = project('memory');
  fs.writeFileSync(
    path.join(p.handoff, 'PROJECT.md'),
    '# Project\n\n## Must never break\n\n- OTP verification for new leads\n'
  );
  const out = runHook('session-start.js', { cwd: p.dir, session_id: 's1' });
  const text = out.hookSpecificOutput.additionalContext;
  assert.ok(text.includes('## Project memory'));
  assert.ok(text.includes('OTP verification for new leads'));
  assert.ok(text.includes('standing constraints'));
  assert.ok(!text.includes('No project memory yet'));
});

test('session-start offers the interview when there is no project memory', () => {
  const p = project('nomemory');
  const out = runHook('session-start.js', { cwd: p.dir, session_id: 's1' });
  const text = out.hookSpecificOutput.additionalContext;
  assert.ok(text.includes('No project memory yet'));
  assert.ok(text.includes('/handoff-project'));
  assert.ok(text.includes('Do not push it twice'));
});

test('an in-progress plan leads the picker and shows the resume point', () => {
  const p = project('resume');
  fs.writeFileSync(
    path.join(p.handoff, 'ACTIVE.md'),
    [
      '# Active: Task A',
      'Approach: direct',
      '## Steps',
      '- [x] [10m] Step one',
      '- [ ] [20m] Step two',
      '- [ ] [15m] Step three',
    ].join('\n')
  );
  const out = runHook('session-start.js', { cwd: p.dir, session_id: 's1' });
  const text = out.hookSpecificOutput.additionalContext;

  assert.ok(text.includes('## Task in progress'));
  assert.ok(text.includes('step 2 of 3'));
  assert.ok(text.includes('do not re-plan work that is already ticked off'));

  const opts = text.split('work on. Use these')[1];
  assert.ok(/1\. Resume "Task A"/.test(opts), 'resume must be the first option');
  assert.ok(opts.includes('Step two'), 'and it must name the next step');
  // The parent item is already represented by the resume option.
  assert.strictEqual((opts.match(/Task A/g) || []).length, 1, 'must not offer the item twice');
});

test('a finished plan prompts close-out once, then stays quiet', () => {
  const p = project('closeout');
  runHook('session-start.js', { cwd: p.dir, session_id: 's1' });
  fs.writeFileSync(
    path.join(p.handoff, 'ACTIVE.md'),
    '# Active: Task A\n\n## Steps\n- [x] [10m] Step one\n- [x] [20m] Step two'
  );

  const first = runHook('stop.js', { cwd: p.dir, session_id: 's1' });
  const text = first.hookSpecificOutput.additionalContext;
  assert.ok(text.includes('Active task finished'));
  assert.ok(text.includes('CHECKLIST.md'));
  assert.ok(text.includes('untick'), 'must offer the escape hatch if it is not really done');

  const second = runHook('stop.js', { cwd: p.dir, session_id: 's1' });
  assert.ok(!second || !second.hookSpecificOutput, 'must not nag every turn');
});

test('ticking the item after a plan completes still writes the handoff', () => {
  const p = project('planthentick');
  runHook('session-start.js', { cwd: p.dir, session_id: 's1' });
  fs.writeFileSync(
    path.join(p.handoff, 'ACTIVE.md'),
    '# Active: Task A\n\n## Steps\n- [x] [10m] Step one'
  );
  runHook('stop.js', { cwd: p.dir, session_id: 's1' }); // close-out prompt

  // Claude follows the instruction: ticks the item, removes the plan.
  fs.writeFileSync(p.checklist, '## P0 — Required to work\n- [x] [45m] Task A\n- [ ] [2h] Task B');
  fs.rmSync(path.join(p.handoff, 'ACTIVE.md'));
  runHook('track.js', {
    cwd: p.dir,
    session_id: 's1',
    tool_name: 'Edit',
    tool_input: { file_path: p.checklist },
  });

  const out = runHook('stop.js', { cwd: p.dir, session_id: 's1' });
  assert.ok(out && out.hookSpecificOutput, 'the normal completion flow must still fire');
  assert.ok(out.hookSpecificOutput.additionalContext.includes('Task A'));
});

test('ticking an item makes Stop ask for a handoff update, exactly once', () => {
  const p = project('tick');
  runHook('session-start.js', { cwd: p.dir, session_id: 's1' });

  fs.writeFileSync(
    p.checklist,
    ['## P0 — Required to work', '- [x] [45m] Task A', '- [ ] [2h] Task B'].join('\n')
  );
  runHook('track.js', {
    cwd: p.dir,
    session_id: 's1',
    tool_name: 'Edit',
    tool_input: { file_path: p.checklist },
  });

  const first = runHook('stop.js', { cwd: p.dir, session_id: 's1', stop_hook_active: false });
  const text = first.hookSpecificOutput.additionalContext;
  assert.strictEqual(first.hookSpecificOutput.hookEventName, 'Stop');
  assert.ok(text.includes('Task A'), 'names the completed item');
  assert.ok(text.includes('LOG.md') && text.includes('HANDOFF.md'));
  assert.ok(text.includes('ONLY if'), 'README/CLAUDE.md must be conditional');

  const second = runHook('stop.js', { cwd: p.dir, session_id: 's1', stop_hook_active: false });
  assert.ok(!second || !second.hookSpecificOutput, 'must not fire again for the same completion');
});

test('catches a box ticked in an external editor mid-session', () => {
  const p = project('external');
  runHook('session-start.js', { cwd: p.dir, session_id: 's1' });

  // Simulates vim/Cursor/sed: the file changes with no Claude edit behind it.
  fs.writeFileSync(
    p.checklist,
    ['## P0 — Required to work', '- [x] [45m] Task A', '- [ ] [2h] Task B'].join('\n')
  );
  // An unrelated tool call — the only signal the hooks get.
  runHook('track.js', {
    cwd: p.dir,
    session_id: 's1',
    tool_name: 'Write',
    tool_input: { file_path: path.join(p.dir, 'unrelated.js') },
  });

  const out = runHook('stop.js', { cwd: p.dir, session_id: 's1' });
  assert.ok(out && out.hookSpecificOutput, 'external tick must still trigger the handoff');
  assert.ok(out.hookSpecificOutput.additionalContext.includes('Task A'));
});

test('catches a box ticked between sessions', () => {
  const p = project('between');
  runHook('session-start.js', { cwd: p.dir, session_id: 's1' });

  // Editor tick with Claude not running at all.
  fs.writeFileSync(p.checklist, '## P0 — Required to work\n- [x] [45m] Task A\n- [ ] [2h] Task B');

  const start = runHook('session-start.js', { cwd: p.dir, session_id: 's2' });
  const text = start.hookSpecificOutput.additionalContext;
  assert.ok(text.includes('Unrecorded completions'), 'recap must surface it');
  assert.ok(text.includes('Task A'));

  const out = runHook('stop.js', { cwd: p.dir, session_id: 's2' });
  assert.ok(out && out.hookSpecificOutput, 'and it must still get written up');
});

test('external sync does not fire on a first-ever look at the checklist', () => {
  const p = project('firstlook');
  // Pre-ticked before the addon ever saw the file — not a completion.
  fs.writeFileSync(p.checklist, '## P0 — Required to work\n- [x] [45m] Already done\n- [ ] [1h] Task B');
  runHook('session-start.js', { cwd: p.dir, session_id: 's1' });
  const out = runHook('stop.js', { cwd: p.dir, session_id: 's1' });
  assert.strictEqual(out, null, 'pre-existing ticks must not be reported as completed');
});

test('no re-prompt when the log was already written in the same turn', () => {
  const p = project('alreadylogged');
  runHook('session-start.js', { cwd: p.dir, session_id: 's1' });

  fs.writeFileSync(p.checklist, '## P0 — Required to work\n- [x] [45m] Task A\n- [ ] [2h] Task B');
  runHook('track.js', {
    cwd: p.dir,
    session_id: 's1',
    tool_name: 'Edit',
    tool_input: { file_path: p.checklist },
  });

  // Claude ticks the item AND writes the log before going idle.
  fs.writeFileSync(path.join(p.handoff, 'LOG.md'), '# Log\n\n## 2026-07-22\n\n- Did Task A.\n');

  const out = runHook('stop.js', { cwd: p.dir, session_id: 's1' });
  assert.strictEqual(out, null, 'must not ask for bookkeeping that already happened');
});

test('still prompts when the item was ticked but nothing was logged', () => {
  const p = project('notlogged');
  runHook('session-start.js', { cwd: p.dir, session_id: 's1' });
  fs.writeFileSync(p.checklist, '## P0 — Required to work\n- [x] [45m] Task A\n- [ ] [2h] Task B');
  runHook('track.js', {
    cwd: p.dir,
    session_id: 's1',
    tool_name: 'Edit',
    tool_input: { file_path: p.checklist },
  });
  const out = runHook('stop.js', { cwd: p.dir, session_id: 's1' });
  assert.ok(out && out.hookSpecificOutput, 'an unrecorded completion must still be chased');
});

test('stop respects stop_hook_active', () => {
  const p = project('loop');
  runHook('session-start.js', { cwd: p.dir, session_id: 's1' });
  fs.writeFileSync(p.checklist, '## P0 — Required to work\n- [x] [45m] Task A');
  runHook('track.js', {
    cwd: p.dir,
    session_id: 's1',
    tool_name: 'Edit',
    tool_input: { file_path: p.checklist },
  });
  const out = runHook('stop.js', { cwd: p.dir, session_id: 's1', stop_hook_active: true });
  assert.strictEqual(out, null);
});

test('a plain edit seeds the ghost-text phrase instead of nagging', () => {
  const p = project('seed');
  const file = path.join(p.dir, 'history.jsonl');
  fs.writeFileSync(file, `${validLine()}\n`);
  const env = { HANDOFF_HISTORY_PATH: file };

  runHook('session-start.js', { cwd: p.dir, session_id: 's1' }, env);
  runHook(
    'track.js',
    { cwd: p.dir, session_id: 's1', tool_name: 'Write', tool_input: { file_path: path.join(p.dir, 'src.js') } },
    env
  );
  const out = runHook('stop.js', { cwd: p.dir, session_id: 's1' }, env);

  assert.strictEqual(out, null, 'no visible output when seeding works');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(JSON.parse(lines[1]).display, 'update the handoff');

  const again = runHook('stop.js', { cwd: p.dir, session_id: 's1' }, env);
  assert.strictEqual(again, null);
  assert.strictEqual(
    fs.readFileSync(file, 'utf8').trim().split('\n').length,
    2,
    'at most one seed per session'
  );
});

test('falls back to a visible reminder when history is unreadable', () => {
  const p = project('fallback');
  const file = path.join(p.dir, 'history.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ totally: 'different' })}\n`);
  const env = { HANDOFF_HISTORY_PATH: file };

  runHook('session-start.js', { cwd: p.dir, session_id: 's1' }, env);
  runHook(
    'track.js',
    { cwd: p.dir, session_id: 's1', tool_name: 'Write', tool_input: { file_path: path.join(p.dir, 'a.js') } },
    env
  );
  const out = runHook('stop.js', { cwd: p.dir, session_id: 's1' }, env);

  assert.ok(out && out.systemMessage, 'must surface a reminder');
  assert.ok(out.systemMessage.includes('handoff'));
  assert.strictEqual(
    fs.readFileSync(file, 'utf8'),
    `${JSON.stringify({ totally: 'different' })}\n`,
    'unfamiliar file must be left untouched'
  );
});

test('session-end writes a raw entry when nothing was summarized', () => {
  const p = project('end');
  runHook('session-start.js', { cwd: p.dir, session_id: 's1' });
  runHook('track.js', {
    cwd: p.dir,
    session_id: 's1',
    tool_name: 'Write',
    tool_input: { file_path: path.join(p.dir, 'server.js') },
  });
  runHook('session-end.js', { cwd: p.dir, session_id: 's1', reason: 'other' });

  const log = fs.readFileSync(path.join(p.handoff, 'LOG.md'), 'utf8');
  assert.ok(/^##\s+\d{4}-\d{2}-\d{2}/m.test(log), 'dated section added');
  assert.ok(log.includes('server.js'));
  assert.ok(log.includes('auto-generated'));
});

test('session-end merges into today rather than duplicating the date heading', () => {
  const p = project('merge');
  const logPath = path.join(p.handoff, 'LOG.md');
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
  fs.writeFileSync(logPath, `# Log\n\n## ${today}\n\n- Earlier work today.\n\n## 2026-01-01\n\n- Old.\n`);

  runHook('session-start.js', { cwd: p.dir, session_id: 's1' });
  runHook('track.js', {
    cwd: p.dir,
    session_id: 's1',
    tool_name: 'Write',
    tool_input: { file_path: path.join(p.dir, 'x.js') },
  });
  // Force the fallback path: pretend the log predates the session.
  const statePath = path.join(p.handoff, '.state.json');
  const st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  st.sessionStart = new Date(Date.now() + 60_000).toISOString();
  fs.writeFileSync(statePath, JSON.stringify(st));

  runHook('session-end.js', { cwd: p.dir, session_id: 's1', reason: 'other' });

  const log = fs.readFileSync(logPath, 'utf8');
  const headings = log.split('\n').filter((l) => l.trim() === `## ${today}`);
  assert.strictEqual(headings.length, 1, 'must not create a second heading for the same date');
  assert.ok(log.includes('Earlier work today.'), 'existing content preserved');
  assert.ok(log.includes('x.js'));
  assert.ok(log.indexOf('x.js') < log.indexOf('## 2026-01-01'), 'appended inside today, not after');
});

test('repeated session-end calls replace the fallback instead of stacking it', () => {
  const p = project('idempotent');
  const logPath = path.join(p.handoff, 'LOG.md');
  runHook('session-start.js', { cwd: p.dir, session_id: 's1' });

  for (const file of ['a.js', 'b.js']) {
    runHook('track.js', {
      cwd: p.dir,
      session_id: 's1',
      tool_name: 'Write',
      tool_input: { file_path: path.join(p.dir, file) },
    });
    const st = JSON.parse(fs.readFileSync(path.join(p.handoff, '.state.json'), 'utf8'));
    st.sessionStart = new Date(Date.now() + 60_000).toISOString(); // force the fallback path
    st.dirty = true;
    fs.writeFileSync(path.join(p.handoff, '.state.json'), JSON.stringify(st));
    runHook('session-end.js', { cwd: p.dir, session_id: 's1', reason: 'other' });
  }

  const log = fs.readFileSync(logPath, 'utf8');
  const blocks = log.split('\n').filter((l) => l.startsWith('### Unwritten session'));
  assert.strictEqual(blocks.length, 1, 'only the latest fallback block should remain');
  assert.ok(log.includes('b.js'), 'and it should be the newest one');
});

test('session-end ignores /clear and /resume, which are not real endings', () => {
  const p = project('notover');
  runHook('session-start.js', { cwd: p.dir, session_id: 's1' });
  runHook('track.js', {
    cwd: p.dir,
    session_id: 's1',
    tool_name: 'Write',
    tool_input: { file_path: path.join(p.dir, 'a.js') },
  });
  const before = fs.readFileSync(path.join(p.handoff, 'LOG.md'), 'utf8');
  for (const reason of ['clear', 'resume']) {
    runHook('session-end.js', { cwd: p.dir, session_id: 's1', reason });
  }
  assert.strictEqual(fs.readFileSync(path.join(p.handoff, 'LOG.md'), 'utf8'), before);
});

test('session-end stays quiet when the log was already updated', () => {
  const p = project('end2');
  runHook('session-start.js', { cwd: p.dir, session_id: 's1' });
  runHook('track.js', {
    cwd: p.dir,
    session_id: 's1',
    tool_name: 'Write',
    tool_input: { file_path: path.join(p.dir, 'server.js') },
  });
  const logPath = path.join(p.handoff, 'LOG.md');
  fs.writeFileSync(logPath, '# Log\n\n## 2026-07-21\n\n- Claude wrote this up properly.\n');
  const before = fs.readFileSync(logPath, 'utf8');
  runHook('session-end.js', { cwd: p.dir, session_id: 's1', reason: 'prompt_input_exit' });
  assert.strictEqual(fs.readFileSync(logPath, 'utf8'), before);
});

test('hooks do nothing in projects that never opted in', () => {
  const dir = tmpdir('optout');
  assert.strictEqual(runHook('track.js', { cwd: dir, tool_name: 'Write', tool_input: { file_path: 'x.js' } }), null);
  assert.strictEqual(runHook('stop.js', { cwd: dir }), null);
  assert.strictEqual(runHook('session-end.js', { cwd: dir }), null);
  assert.strictEqual(fs.readdirSync(dir).length, 0, 'must not create files');
});

test('survives garbage input without failing the tool call', () => {
  for (const script of ['track.js', 'stop.js', 'session-end.js', 'session-start.js']) {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'hooks', script)], {
      input: 'not json at all',
      encoding: 'utf8',
    });
    assert.ok(typeof out === 'string');
  }
});

console.log('\nfallback entries');

const logfile = require('../lib/logfile');

const AUTO = ['### Unwritten session', '', logfile.AUTO_MARKER, '', '- Files touched (1): a.js'];

test('a placeholder is dropped once a real write-up answers it', () => {
  const log = ['# Log', '', '## 2026-07-21', '', '- Claude wrote this up properly.', '', ...AUTO, ''].join('\n');
  const out = logfile.pruneSuperseded(log);
  assert.ok(!out.includes('Unwritten session'), 'placeholder should be gone');
  assert.ok(out.includes('Claude wrote this up properly.'), 'the real entry must survive');
  assert.ok(out.includes('## 2026-07-21'), 'and so must the date heading');
});

test('a placeholder is kept when it is the only record of that day', () => {
  const log = ['# Log', '', '## 2026-07-22', '', ...AUTO, ''].join('\n');
  assert.strictEqual(logfile.pruneSuperseded(log), log, 'nothing has superseded it yet');
});

test('pruning is per-day — an answered placeholder goes, an unanswered one stays', () => {
  const log = [
    '# Log', '',
    '## 2026-07-22', '', '### Unwritten session', '', logfile.AUTO_MARKER, '', '- Files touched (1): new.js', '',
    '## 2026-07-21', '', '- A real entry.', '', ...AUTO, '',
  ].join('\n');
  const out = logfile.pruneSuperseded(log);
  assert.ok(out.includes('new.js'), "today's placeholder is still the only record");
  assert.ok(!out.includes('a.js'), "yesterday's was superseded");
  assert.ok(out.includes('- A real entry.'));
});

test('session-start prunes the log without disturbing its mtime', () => {
  const p = project('prune');
  const logPath = path.join(p.handoff, 'LOG.md');
  fs.writeFileSync(logPath, ['# Log', '', '## 2026-07-21', '', '- Real work.', '', ...AUTO, ''].join('\n'));
  const stale = new Date(Date.now() - 3_600_000);
  fs.utimesSync(logPath, stale, stale);

  const out = runHook('session-start.js', { cwd: p.dir, session_id: 's1' });
  const after = fs.readFileSync(logPath, 'utf8');

  assert.ok(!after.includes('Unwritten session'), 'the superseded placeholder is removed from disk');
  assert.ok(!/Unwritten session/.test(JSON.stringify(out)), 'and does not reach the recap');
  assert.strictEqual(
    Math.round(fs.statSync(logPath).mtimeMs / 1000),
    Math.round(stale.getTime() / 1000),
    'mtime must be preserved — Stop and SessionEnd read it to detect a write-up'
  );
});

console.log('\nhooks are scoped to the project they are given');

test('a payload with no cwd touches nothing, even from inside a tracked project', () => {
  const p = project('nocwd');
  const logPath = path.join(p.handoff, 'LOG.md');
  fs.writeFileSync(path.join(p.handoff, '.state.json'), JSON.stringify({
    sessionId: 'someone-else', sessionStart: '2026-01-01T00:00:00.000Z',
    dirty: true, editedFiles: ['secret.js'], commands: ['deploy --prod'],
  }));
  const stale = new Date(Date.now() - 3_600_000);
  fs.utimesSync(logPath, stale, stale);
  const before = fs.readFileSync(logPath, 'utf8');

  // Running from within the project is what makes process.cwd() a plausible
  // — and wrong — stand-in for the cwd the payload failed to name.
  for (const [script, input] of [
    ['session-end.js', 'not json at all'],
    ['session-end.js', '{}'],
    ['session-end.js', JSON.stringify({ session_id: 's1', reason: 'other' })],
    ['track.js', JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'x.js' } })],
    ['stop.js', '{}'],
    ['session-start.js', '{}'],
  ]) {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'hooks', script)], {
      input, encoding: 'utf8', cwd: p.dir,
    });
    assert.strictEqual(out.trim(), '', `${script} must stay silent without a cwd`);
  }

  assert.strictEqual(fs.readFileSync(logPath, 'utf8'), before, 'no project may be written by accident');
});

console.log('\nshell wrapper');

/**
 * Drive the wrapper with a stub `claude` on PATH that prints its own argv, so
 * we assert on what the real binary would have received.
 */
function wrapper(cwd, command) {
  const bin = tmpdir('bin');
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nprintf "%s\\n" "$#" "$@"\n');
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  const script = path.join(ROOT, 'shell', 'handoff.sh');
  const out = execFileSync('bash', ['-c', `cd '${cwd}' && . '${script}' && ${command}`], {
    encoding: 'utf8',
    env: { HOME: os.homedir(), PATH: `${bin}:/usr/bin:/bin` },
  });
  const lines = out.trim().split('\n');
  return { count: Number(lines[0]), args: lines.slice(1) };
}

test('a bare `claude` in a tracked project opens on the recap', () => {
  const p = project('wrap');
  const deep = path.join(p.dir, 'src', 'nested');
  fs.mkdirSync(deep, { recursive: true });

  for (const cwd of [p.dir, deep]) {
    const run = wrapper(cwd, 'claude');
    assert.strictEqual(run.count, 1, 'exactly one argument — the opening prompt');
    assert.ok(/leave off/i.test(run.args[0]), `expected an opening prompt, got ${run.args[0]}`);
  }
});

test('the wrapper stays out of the way when it has nothing to add', () => {
  const p = project('wrap2');
  const untracked = tmpdir('untracked');

  const cases = [
    [untracked, 'claude', 'no .handoff anywhere up the tree'],
    [p.dir, 'claude --raw', 'explicit bypass'],
    [p.dir, 'HANDOFF_NO_AUTOSTART=1 claude', 'opt-out variable'],
  ];
  for (const [cwd, cmd, why] of cases) {
    assert.strictEqual(wrapper(cwd, cmd).count, 0, why);
  }

  // Anything already saying what it wants is passed through untouched.
  assert.deepStrictEqual(wrapper(p.dir, 'claude --continue').args, ['--continue']);
  assert.deepStrictEqual(wrapper(p.dir, 'claude "fix the bug"').args, ['fix the bug']);
  assert.deepStrictEqual(wrapper(p.dir, 'claude --raw -p hi').args, ['-p', 'hi']);
  assert.deepStrictEqual(wrapper(p.dir, 'HANDOFF_OPENING_PROMPT=status claude').args, ['status']);
});

test('the parent walk terminates at the filesystem root', () => {
  assert.strictEqual(wrapper('/', 'claude').count, 0);
});

// Feature test files: each test/<name>.test.js exports a function taking the
// harness, so new coverage can land without editing this file.
for (const file of fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort()) {
  console.log(`\n${file}`);
  require(path.join(__dirname, file))({ test, tmpdir, runHook, ROOT });
}

console.log(`\n${passed} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
