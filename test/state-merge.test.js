'use strict';

/**
 * write() merges the on-disk copy before persisting, so two Claude Code sessions
 * sharing one project's .state.json can't clobber each other's tracked work.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const state = require('../lib/state');

module.exports = ({ test, tmpdir }) => {
  const statePath = (label) => path.join(tmpdir(label), '.state.json');

  test('interleaved writes union both sessions edits and commands', () => {
    const sp = statePath('merge-interleave');

    // Both sessions read the same (empty) baseline, then edit different things.
    const a = state.forSession(sp, 'A');
    state.addFile(a, 'a.js');
    state.addCommand(a, 'npm test');
    const b = state.forSession(sp, 'B');
    state.addFile(b, 'b.js');
    state.addCommand(b, 'npm run build');

    // A writes, then B writes last — classic last-writer-wins territory.
    state.write(sp, a);
    state.write(sp, b);

    const disk = state.read(sp);
    assert.ok(disk.editedFiles.includes('a.js'), "A's edit must survive B writing last");
    assert.ok(disk.editedFiles.includes('b.js'));
    assert.ok(disk.commands.includes('npm test'), "A's command must survive");
    assert.ok(disk.commands.includes('npm run build'));
    // B is the writer of record; its identity must win over the stale disk copy.
    assert.strictEqual(disk.sessionId, 'B');
  });

  test('caps stay enforced after a merge, most-recent-last', () => {
    const sp = statePath('merge-caps');

    const first = { ...state.DEFAULTS, sessionId: 'A' };
    for (let i = 0; i < 250; i += 1) state.addFile(first, `f${i}`);
    for (let i = 0; i < 150; i += 1) state.addCommand(first, `c${i}`);
    state.write(sp, first);
    assert.strictEqual(state.read(sp).editedFiles.length, 200, 'baseline already at the file cap');
    assert.strictEqual(state.read(sp).commands.length, 100, 'baseline already at the command cap');

    const second = { ...state.DEFAULTS, sessionId: 'B' };
    for (let i = 0; i < 10; i += 1) state.addFile(second, `g${i}`);
    for (let i = 0; i < 10; i += 1) state.addCommand(second, `d${i}`);
    state.write(sp, second);

    const disk = state.read(sp);
    assert.strictEqual(disk.editedFiles.length, 200, 'still capped after merge');
    assert.strictEqual(disk.commands.length, 100, 'still capped after merge');
    assert.strictEqual(disk.editedFiles[disk.editedFiles.length - 1], 'g9', 'newest file is last');
    assert.strictEqual(disk.commands[disk.commands.length - 1], 'd9', 'newest command is last');
  });

  test('completedPending unions across sessions but honours a flush to empty', () => {
    const sp = statePath('merge-pending');

    const a = { ...state.DEFAULTS, sessionId: 'A', completedPending: [{ key: 'k1', text: 'Task A' }] };
    state.write(sp, a);

    // A concurrent session adds a different completion.
    const b = {
      ...state.DEFAULTS,
      sessionId: 'B',
      completedPending: [{ key: 'k1', text: 'Task A' }, { key: 'k2', text: 'Task B' }],
    };
    state.write(sp, b);
    let disk = state.read(sp);
    assert.strictEqual(disk.completedPending.length, 2, 'deduped union of both completions');
    assert.deepStrictEqual(disk.completedPending.map((c) => c.key).sort(), ['k1', 'k2']);

    // Stop flushes: an empty writer list must not resurrect the disk items.
    const flush = { ...state.DEFAULTS, sessionId: 'B', completedPending: [] };
    state.write(sp, flush);
    disk = state.read(sp);
    assert.strictEqual(disk.completedPending.length, 0, 'a deliberate flush stays flushed');
  });

  test('a corrupt existing file does not throw and the write still lands', () => {
    const sp = statePath('merge-corrupt');
    fs.writeFileSync(sp, 'not json at all {{{');

    let ok;
    assert.doesNotThrow(() => {
      ok = state.write(sp, { ...state.DEFAULTS, sessionId: 'A', editedFiles: ['x.js'], dirty: true });
    });
    assert.strictEqual(ok, true, 'write reports success despite the unparseable prior file');

    const disk = state.read(sp);
    assert.ok(disk.editedFiles.includes('x.js'), 'the in-memory state was written');
    assert.strictEqual(disk.dirty, true);
  });

  test('a stale sessionId on disk does not overwrite the current writer session fields', () => {
    const sp = statePath('merge-stale');
    fs.writeFileSync(
      sp,
      JSON.stringify({
        sessionId: 'stale',
        sessionStart: '2000-01-01T00:00:00.000Z',
        seededSession: true,
        historyBroken: true,
        activeClosePrompted: 'Old task',
        checklistSnapshot: 'STALE',
        checklistMtime: 111,
        editedFiles: ['old.js'],
      })
    );

    state.write(sp, {
      ...state.DEFAULTS,
      sessionId: 'fresh',
      sessionStart: '2026-07-22T00:00:00.000Z',
      seededSession: false,
      historyBroken: false,
      activeClosePrompted: null,
      checklistSnapshot: 'FRESH',
      checklistMtime: 999,
      editedFiles: ['new.js'],
    });

    const disk = state.read(sp);
    assert.strictEqual(disk.sessionId, 'fresh', 'writer identity wins');
    assert.strictEqual(disk.sessionStart, '2026-07-22T00:00:00.000Z');
    assert.strictEqual(disk.seededSession, false);
    assert.strictEqual(disk.historyBroken, false);
    assert.strictEqual(disk.activeClosePrompted, null);
    assert.strictEqual(disk.checklistSnapshot, 'FRESH', 'the writer\'s fresh baseline is not resurrected away');
    assert.strictEqual(disk.checklistMtime, 999);
    // Cross-session work is still unioned even while session fields are not.
    assert.ok(disk.editedFiles.includes('old.js') && disk.editedFiles.includes('new.js'));
  });

  test('the newest completedAt and lastSummaryAt win', () => {
    const sp = statePath('merge-timestamps');
    fs.writeFileSync(
      sp,
      JSON.stringify({ completedAt: 5000, lastSummaryAt: '2026-07-20T00:00:00.000Z' })
    );

    // Writer carries an older completedAt but a newer lastSummaryAt.
    state.write(sp, {
      ...state.DEFAULTS,
      sessionId: 'A',
      completedAt: 3000,
      lastSummaryAt: '2026-07-22T00:00:00.000Z',
    });

    const disk = state.read(sp);
    assert.strictEqual(disk.completedAt, 5000, 'keeps the later completion time');
    assert.strictEqual(disk.lastSummaryAt, '2026-07-22T00:00:00.000Z', 'keeps the later summary time');
  });
};
