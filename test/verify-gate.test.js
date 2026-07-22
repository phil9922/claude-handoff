'use strict';

/**
 * Phase 3 — "verify before ticking". An item may carry an OPTIONAL success
 * criterion as a sub-bullet:
 *
 *   - [ ] [45m] Wire auth middleware to session store
 *     - ✓ login survives a server restart (integration test passes)
 *
 * The `✓` marker also accepts the ASCII fallbacks `v:` / `verify:`. Items with a
 * criterion get a verification gate in the Stop instruction; items without behave
 * byte-for-byte as they did before.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

module.exports = ({ test, tmpdir, runHook, ROOT }) => {
  const checklist = require(path.join(ROOT, 'lib', 'checklist'));

  // A throwaway tracked project. Mirrors the in-repo helper but lets each test
  // choose the CHECKLIST.md body so criteria can be present or absent.
  function project(label, body) {
    const dir = tmpdir(label);
    const handoff = path.join(dir, '.handoff');
    fs.mkdirSync(handoff, { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'templates', 'LOG.md'), path.join(handoff, 'LOG.md'));
    fs.copyFileSync(path.join(ROOT, 'templates', 'HANDOFF.md'), path.join(handoff, 'HANDOFF.md'));
    fs.writeFileSync(path.join(handoff, 'CHECKLIST.md'), body);
    return { dir, handoff, checklist: path.join(handoff, 'CHECKLIST.md') };
  }

  const readState = (p) => JSON.parse(fs.readFileSync(path.join(p.handoff, '.state.json'), 'utf8'));

  // (1) Parsing: ✓, ASCII fallbacks, absent, and non-criterion sub-bullets.
  test('verify-gate: parses a criterion from ✓, v: and verify: markers', () => {
    const md = [
      '## P0 — Required to work',
      '- [ ] [45m] Alpha',
      '  - ✓ alpha survives a restart',
      '- [ ] [30m] Bravo',
      '  - v: bravo returns 200',
      '- [ ] [30m] Charlie',
      '  - Verify: charlie is idempotent',
      '- [ ] [30m] Delta',
      '  - just a free-form note, not a criterion',
      '- [ ] [30m] Echo',
    ].join('\n');
    const { items } = checklist.parse(md);
    assert.strictEqual(items.length, 5, 'criterion sub-bullets are not counted as items');
    assert.strictEqual(items[0].criterion, 'alpha survives a restart');
    assert.strictEqual(items[1].criterion, 'bravo returns 200', 'v: fallback');
    assert.strictEqual(items[2].criterion, 'charlie is idempotent', 'verify: fallback, case-insensitive');
    assert.strictEqual(items[3].criterion, undefined, 'a free-form note is not a criterion');
    assert.strictEqual(items[4].criterion, undefined, 'no sub-bullet means no criterion');
  });

  test('verify-gate: a free-form note before the criterion does not detach it; first wins', () => {
    const withNote = ['## P0 — x', '- [ ] [10m] Item', '  - some prose note first', '  - ✓ the real criterion'].join('\n');
    assert.strictEqual(checklist.parse(withNote).items[0].criterion, 'the real criterion');

    const two = ['## P0 — x', '- [ ] [10m] Item', '  - ✓ first', '  - ✓ second'].join('\n');
    assert.strictEqual(checklist.parse(two).items[0].criterion, 'first', 'only the first criterion is taken');
  });

  test('verify-gate: a tier heading ends the association, so an orphan criterion attaches to nothing', () => {
    const md = ['## P0 — x', '- [ ] [10m] Item', '## P1 — y', '  - ✓ orphaned'].join('\n');
    const { items } = checklist.parse(md);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].criterion, undefined, 'a heading resets the current item');
  });

  test('verify-gate: an item line is never mistaken for a criterion', () => {
    // "- [ ] [45m] verify: ..." is a real item, not a criterion sub-bullet.
    const md = ['## P0 — x', '- [ ] [45m] verify: this is the task text'].join('\n');
    const { items } = checklist.parse(md);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].text, 'verify: this is the task text');
    assert.strictEqual(items[0].criterion, undefined);
  });

  // (2) track.js threads criterion presence onto completedPending.
  test('verify-gate: track records the criterion string on a gated tick and null on an ungated one', () => {
    const p = project(
      'vg-track',
      [
        '## P0 — Required to work',
        '- [ ] [45m] Gated task',
        '  - ✓ gated task survives a restart',
        '- [ ] [2h] Plain task',
      ].join('\n')
    );
    runHook('session-start.js', { cwd: p.dir, session_id: 's1' });

    // Both boxes ticked; the criterion sub-bullet stays under the gated item.
    fs.writeFileSync(
      p.checklist,
      [
        '## P0 — Required to work',
        '- [x] [45m] Gated task',
        '  - ✓ gated task survives a restart',
        '- [x] [2h] Plain task',
      ].join('\n')
    );
    runHook('track.js', { cwd: p.dir, session_id: 's1', tool_name: 'Edit', tool_input: { file_path: p.checklist } });

    const pending = readState(p).completedPending;
    const byKey = Object.fromEntries(pending.map((c) => [c.key, c]));
    assert.strictEqual(byKey['gated task'].criterion, 'gated task survives a restart', 'string recorded');
    assert.strictEqual(byKey['plain task'].criterion, null, 'absence recorded as null, not missing');
  });

  // (3a) Stop's instruction gains the verification requirement for a gated item.
  test('verify-gate: stop demands quoted-criterion evidence for a gated completion', () => {
    const p = project(
      'vg-stop-gated',
      ['## P0 — Required to work', '- [ ] [45m] Gated task', '  - ✓ login survives a server restart'].join('\n')
    );
    runHook('session-start.js', { cwd: p.dir, session_id: 's1' });
    fs.writeFileSync(
      p.checklist,
      ['## P0 — Required to work', '- [x] [45m] Gated task', '  - ✓ login survives a server restart'].join('\n')
    );
    runHook('track.js', { cwd: p.dir, session_id: 's1', tool_name: 'Edit', tool_input: { file_path: p.checklist } });

    const out = runHook('stop.js', { cwd: p.dir, session_id: 's1' });
    const text = out.hookSpecificOutput.additionalContext;
    assert.ok(text.includes('Verification gate'), 'gate section present');
    assert.ok(text.includes('login survives a server restart'), 'quotes the criterion');
    assert.ok(/evidence/i.test(text), 'requires evidence');
    assert.ok(text.includes('un-tick'), 'requires un-ticking when not verified');
    assert.ok(text.includes('this session'), 'evidence must be from this session');
    // The normal bookkeeping is still there too.
    assert.ok(text.includes('Gated task') && text.includes('LOG.md') && text.includes('HANDOFF.md'));
  });

  // (3b) An ungated item keeps today's instruction with no gate.
  test('verify-gate: stop keeps today\'s instruction and no gate for an item without a criterion', () => {
    const p = project('vg-stop-plain', ['## P0 — Required to work', '- [ ] [45m] Plain task', '- [ ] [2h] Task B'].join('\n'));
    runHook('session-start.js', { cwd: p.dir, session_id: 's1' });
    fs.writeFileSync(p.checklist, ['## P0 — Required to work', '- [x] [45m] Plain task', '- [ ] [2h] Task B'].join('\n'));
    runHook('track.js', { cwd: p.dir, session_id: 's1', tool_name: 'Edit', tool_input: { file_path: p.checklist } });

    const out = runHook('stop.js', { cwd: p.dir, session_id: 's1' });
    const text = out.hookSpecificOutput.additionalContext;
    assert.ok(!text.includes('Verification gate'), 'no gate when nothing declared a criterion');
    assert.ok(!/criterion/i.test(text), 'the word criterion never appears');
    // Today's markers, unchanged.
    assert.ok(text.includes('Plain task'));
    assert.ok(text.includes('LOG.md') && text.includes('HANDOFF.md'));
    assert.ok(text.includes('ONLY if'), 'README/CLAUDE.md guidance still conditional');
  });

  // (4) End-to-end via the fallback path: an externally-ticked box (no track.js
  // run at all) still gets gated, because Stop re-derives criteria from the file.
  test('verify-gate: stop re-derives the criterion for an externally ticked box', () => {
    const p = project(
      'vg-external',
      ['## P0 — Required to work', '- [ ] [45m] Gated task', '  - verify: cache invalidation clears stale keys'].join('\n')
    );
    runHook('session-start.js', { cwd: p.dir, session_id: 's1' });
    // Editor tick — no Claude edit, no track.js.
    fs.writeFileSync(
      p.checklist,
      ['## P0 — Required to work', '- [x] [45m] Gated task', '  - verify: cache invalidation clears stale keys'].join('\n')
    );
    // An unrelated tool call is the only nudge the hooks get.
    runHook('track.js', {
      cwd: p.dir,
      session_id: 's1',
      tool_name: 'Write',
      tool_input: { file_path: path.join(p.dir, 'unrelated.js') },
    });

    const out = runHook('stop.js', { cwd: p.dir, session_id: 's1' });
    const text = out.hookSpecificOutput.additionalContext;
    assert.ok(text.includes('Verification gate'), 'gate still fires from the file, not just tracked state');
    assert.ok(text.includes('cache invalidation clears stale keys'), 'criterion re-derived from CHECKLIST.md');
  });

  // (5) The pre-existing no-criterion flow is unchanged: tick -> Stop once,
  // and a project that never uses criteria never sees the word.
  test('verify-gate: the no-criterion flow fires exactly once and mentions no criterion', () => {
    const p = project('vg-once', ['## P0 — Required to work', '- [ ] [45m] Task A', '- [ ] [2h] Task B'].join('\n'));
    runHook('session-start.js', { cwd: p.dir, session_id: 's1' });
    fs.writeFileSync(p.checklist, ['## P0 — Required to work', '- [x] [45m] Task A', '- [ ] [2h] Task B'].join('\n'));
    runHook('track.js', { cwd: p.dir, session_id: 's1', tool_name: 'Edit', tool_input: { file_path: p.checklist } });

    const first = runHook('stop.js', { cwd: p.dir, session_id: 's1' });
    assert.strictEqual(first.hookSpecificOutput.hookEventName, 'Stop');
    assert.ok(first.hookSpecificOutput.additionalContext.includes('Task A'));
    assert.ok(!/criterion|Verification gate/i.test(first.hookSpecificOutput.additionalContext));

    const second = runHook('stop.js', { cwd: p.dir, session_id: 's1' });
    assert.ok(!second || !second.hookSpecificOutput, 'must not fire again for the same completion');
  });
};
