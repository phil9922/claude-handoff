'use strict';

/**
 * Phase 4 — "commits and review". When a checklist item completes in a project
 * that is a git repository, the Stop instruction additionally directs an atomic
 * commit per completed item; an optional review pass gates it.
 *
 *   - Git detection is deterministic and cheap: a `.git` entry at the project
 *     root (dir or worktree file).
 *   - `.handoff/config.json`:
 *       { "commit": false }  disables the whole section in a git project.
 *       { "review": true }   adds a self-review step before the commit.
 *   - A non-git project (or a disabled one) keeps today's instruction
 *     BYTE-FOR-BYTE, with no git wording at all.
 *   - Any error reading the tree or config degrades to today's instruction.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

module.exports = ({ test, tmpdir, runHook, ROOT }) => {
  // A throwaway tracked project. Mirrors the in-repo helper but lets each test
  // choose the CHECKLIST.md body, opt into git, and drop a config.json.
  function project(label, opts = {}) {
    const dir = tmpdir(label);
    const handoff = path.join(dir, '.handoff');
    fs.mkdirSync(handoff, { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'templates', 'LOG.md'), path.join(handoff, 'LOG.md'));
    fs.copyFileSync(path.join(ROOT, 'templates', 'HANDOFF.md'), path.join(handoff, 'HANDOFF.md'));
    fs.writeFileSync(path.join(handoff, 'CHECKLIST.md'), opts.checklist || TWO_TASKS);
    if (opts.git) execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
    if (opts.config !== undefined) {
      const body = typeof opts.config === 'string' ? opts.config : JSON.stringify(opts.config);
      fs.writeFileSync(path.join(handoff, 'config.json'), body);
    }
    return { dir, handoff, checklist: path.join(handoff, 'CHECKLIST.md') };
  }

  const TWO_TASKS = ['## P0 — Required to work', '- [ ] [45m] Task A', '- [ ] [2h] Task B'].join('\n');

  // Drive a completion identically every time so the resulting instruction text
  // is a pure function of the checklist body and edited files — never the dir,
  // which is what lets the byte-identical assertions below hold across projects.
  function completeTaskA(p, { checklistAfter, editSource = true } = {}) {
    runHook('session-start.js', { cwd: p.dir, session_id: 's1' });
    if (editSource) {
      // A real source edit so state.editedFiles carries a file OUTSIDE .handoff/,
      // which the commit section must scope its staging to.
      runHook('track.js', {
        cwd: p.dir,
        session_id: 's1',
        tool_name: 'Write',
        tool_input: { file_path: path.join(p.dir, 'src', 'auth.js') },
      });
    }
    fs.writeFileSync(
      p.checklist,
      checklistAfter || ['## P0 — Required to work', '- [x] [45m] Task A', '- [ ] [2h] Task B'].join('\n')
    );
    runHook('track.js', {
      cwd: p.dir,
      session_id: 's1',
      tool_name: 'Edit',
      tool_input: { file_path: p.checklist },
    });
    const out = runHook('stop.js', { cwd: p.dir, session_id: 's1' });
    return out.hookSpecificOutput.additionalContext;
  }

  // (1) A git project gets the commit section, scoped to tracked edited files,
  // with .handoff/ excluded and no bare "stage everything" instruction.
  test('commit-review: a git project gets a commit section scoped to the tracked edits', () => {
    const p = project('cr-git', { git: true });
    const text = completeTaskA(p);

    assert.ok(text.includes('## Commit'), 'commit section present in a git project');
    assert.ok(text.includes('This project is a git repository'), 'names the git condition');

    // Scoped to the session's tracked edits: the source file shows up as evidence
    // the commit is told to stage from, and the checklist under .handoff/ is
    // explicitly excluded.
    assert.ok(text.includes(path.join('src', 'auth.js')), 'evidence lists the tracked source edit');
    assert.ok(text.includes('listed under Evidence below'), 'commit staging is scoped to those edits');
    assert.ok(/Never stage anything under `\.handoff\/`/.test(text), '.handoff/ is excluded from commits');

    // Uses plain `git add` and forbids the blunt instruments.
    assert.ok(text.includes('git add'), 'uses git add');
    assert.ok(!text.includes('git add -A'), 'never emits a stage-everything command');
    assert.ok(!text.includes('git add .'), 'and never stages the working directory wholesale');
    assert.ok(text.includes('git commit -a'), 'names git commit -a as forbidden');
    assert.ok(text.includes('-f'), 'forbids the force flag');

    // Message shape: subject = item text, fixed body line.
    assert.ok(text.includes('Completed via handoff checklist.'), 'fixed commit body line');

    // No review pass unless asked for.
    assert.ok(!text.includes('## Review'), 'review is opt-in, absent by default');

    // The normal bookkeeping still follows the commit section.
    assert.ok(text.includes('LOG.md') && text.includes('HANDOFF.md'), 'bookkeeping steps still present');
    assert.ok(text.indexOf('## Commit') < text.indexOf('## Do exactly this'), 'commit precedes bookkeeping');
  });

  // (2) A non-git project keeps today's instruction, byte-for-byte, with no git
  // wording — proven by equality against a git project that disabled the section.
  test('commit-review: a non-git project keeps today\'s instruction, byte-for-byte', () => {
    const nonGit = project('cr-nongit');
    const disabled = project('cr-disabled', { git: true, config: { commit: false } });

    const a = completeTaskA(nonGit);
    const b = completeTaskA(disabled);

    // No git words anywhere in the non-git instruction.
    assert.ok(!/git/i.test(a), 'the word git never appears');
    assert.ok(!/commit/i.test(a), 'the word commit never appears');
    assert.ok(!a.includes('## Commit') && !a.includes('## Review'), 'neither section is present');

    // Non-git and commit-disabled produce identical text: both are today's.
    assert.strictEqual(b, a, 'a disabled git project is byte-identical to a non-git one');
  });

  // (3) { "commit": false } disables the section in a git project.
  test('commit-review: {"commit": false} disables the section in a git project', () => {
    const enabled = project('cr-enabled', { git: true });
    const disabled = project('cr-off', { git: true, config: { commit: false } });

    const on = completeTaskA(enabled);
    const off = completeTaskA(disabled);

    assert.ok(on.includes('## Commit'), 'enabled by default for a git project');
    assert.ok(!off.includes('## Commit'), 'the config flag turns it off');
    assert.ok(!/git/i.test(off), 'no git wording at all once disabled');
  });

  // (4) { "review": true } adds the review step, ordered AFTER the verification
  // gate and BEFORE the commit.
  test('commit-review: {"review": true} adds a review step after the gate and before the commit', () => {
    const p = project('cr-review', {
      git: true,
      config: { review: true },
      checklist: ['## P0 — Required to work', '- [ ] [45m] Task A', '  - ✓ login survives a restart', '- [ ] [2h] Task B'].join('\n'),
    });
    const text = completeTaskA(p, {
      checklistAfter: ['## P0 — Required to work', '- [x] [45m] Task A', '  - ✓ login survives a restart', '- [ ] [2h] Task B'].join('\n'),
    });

    assert.ok(text.includes('## Review'), 'review section present when opted in');
    assert.ok(text.includes('git diff'), 'directs re-reading the diff');
    assert.ok(text.includes('## Commit'), 'commit still present alongside review');

    const gate = text.indexOf('## Verification gate');
    const review = text.indexOf('## Review');
    const commit = text.indexOf('## Commit');
    assert.ok(gate !== -1, 'the gated item still produces a verification gate');
    assert.ok(gate < review, 'review comes after the verification gate');
    assert.ok(review < commit, 'review comes before the commit');
  });

  // (5) Multiple completed items in one turn get per-item commit guidance.
  test('commit-review: multiple completions get per-item commit guidance', () => {
    const p = project('cr-multi', { git: true });
    const text = completeTaskA(p, {
      checklistAfter: ['## P0 — Required to work', '- [x] [45m] Task A', '- [x] [2h] Task B'].join('\n'),
    });

    assert.ok(text.includes('2 checklist items were just completed'), 'both completions are recorded');
    assert.ok(text.includes('## Commit'), 'commit section present');
    assert.ok(text.includes('One commit per completed item'), 'one atomic commit per item');
    assert.ok(text.includes('split the staged files by the item'), 'splits files across items when several land together');
    assert.ok(text.includes('combined'), 'falls back to one combined commit when a file can\'t be attributed');
  });

  // (6) A corrupt config.json behaves as the default (git => enabled) and never
  // throws.
  test('commit-review: a corrupt config.json falls back to the default and never throws', () => {
    const p = project('cr-corrupt', { git: true, config: '{ this is : not valid json' });
    let text;
    assert.doesNotThrow(() => {
      text = completeTaskA(p);
    }, 'a broken config must not break the hook');
    assert.ok(text.includes('## Commit'), 'defaults to enabled for a git project');
    assert.ok(!text.includes('## Review'), 'and to no review, since nothing valid asked for it');
  });
};
