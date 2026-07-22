'use strict';

/**
 * The cross-project registry (lib/registry.js) and its SessionStart wiring.
 * claudeHome is sandboxed per test via CLAUDE_CONFIG_DIR pointing at a tmpdir:
 * in-process calls set it on process.env, the end-to-end hook runs receive it
 * through runHook's env argument.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const registry = require('../lib/registry');

module.exports = ({ test, tmpdir, runHook }) => {
  // Run `fn` with CLAUDE_CONFIG_DIR set to `home`, restoring it afterwards, so
  // registry.upsert/list resolve their file under the sandbox home.
  function withHome(home, fn) {
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = home;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  }

  // A throwaway project directory with a .handoff/ so it counts as tracked.
  function trackedProject(label) {
    const dir = tmpdir(label);
    fs.mkdirSync(path.join(dir, '.handoff'));
    fs.writeFileSync(
      path.join(dir, '.handoff', 'CHECKLIST.md'),
      ['## P0 — Required to work', '- [ ] [30m] A task'].join('\n')
    );
    return dir;
  }

  // Read the on-disk registry directly, independent of process.env.
  function readRegistry(home) {
    try {
      return JSON.parse(fs.readFileSync(path.join(home, 'handoff', 'projects.json'), 'utf8'));
    } catch {
      return [];
    }
  }

  // Busy-wait so a subsequent ISO timestamp is strictly later.
  function spin(ms) {
    const t = Date.now();
    while (Date.now() - t < ms) {
      /* burn a couple of milliseconds */
    }
  }

  test('upsert dedupes by root and refreshes lastSeen', () => {
    const home = tmpdir('reg-dedupe');
    const proj = trackedProject('reg-p');
    withHome(home, () => {
      assert.strictEqual(registry.upsert(proj), true);
      const first = registry.list();
      assert.strictEqual(first.length, 1, 'one entry after the first upsert');
      assert.strictEqual(first[0].root, path.resolve(proj));
      assert.strictEqual(first[0].name, path.basename(proj));
      const seen1 = first[0].lastSeen;

      spin(5);
      registry.upsert(proj);
      const second = registry.list();
      assert.strictEqual(second.length, 1, 'still one entry — deduped by root');
      assert.ok(second[0].lastSeen > seen1, 'lastSeen advanced on re-upsert');
    });
  });

  test('upsert prunes projects whose .handoff has vanished', () => {
    const home = tmpdir('reg-prune');
    const a = trackedProject('reg-a');
    const b = trackedProject('reg-b');
    withHome(home, () => {
      registry.upsert(a);
      registry.upsert(b);
      assert.strictEqual(registry.list().length, 2, 'both tracked');

      fs.rmSync(path.join(b, '.handoff'), { recursive: true, force: true });
      registry.upsert(a); // any write triggers a prune pass

      const roots = registry.list().map((e) => e.root);
      assert.ok(roots.includes(path.resolve(a)), 'the live project stays');
      assert.ok(!roots.includes(path.resolve(b)), 'the project with no .handoff is pruned');
    });
  });

  test('corrupt projects.json reads as [] and the next upsert rewrites it cleanly', () => {
    const home = tmpdir('reg-corrupt');
    const proj = trackedProject('reg-c');
    withHome(home, () => {
      const file = registry.registryPath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '{ not: valid json ]');

      assert.deepStrictEqual(registry.list(), [], 'garbage reads as an empty list, no throw');

      assert.strictEqual(registry.upsert(proj), true, 'upsert recovers over the corrupt file');
      const after = registry.list();
      assert.strictEqual(after.length, 1);
      assert.strictEqual(after[0].root, path.resolve(proj));
      // The file is now valid JSON again.
      assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, 'utf8')));
    });
  });

  test('session-start registers a tracked project but not an untracked one', () => {
    const home = tmpdir('reg-e2e-home');
    const tracked = trackedProject('reg-e2e-tracked');
    runHook('session-start.js', { cwd: tracked, session_id: 's1' }, { CLAUDE_CONFIG_DIR: home });

    const entries = readRegistry(home);
    assert.strictEqual(entries.length, 1, 'the tracked project was recorded');
    assert.strictEqual(entries[0].name, path.basename(tracked));
    assert.strictEqual(entries[0].root, path.resolve(tracked));

    const untrackedHome = tmpdir('reg-e2e-home2');
    const untracked = tmpdir('reg-e2e-untracked'); // no .handoff/
    const out = runHook(
      'session-start.js',
      { cwd: untracked, session_id: 's2' },
      { CLAUDE_CONFIG_DIR: untrackedHome }
    );
    assert.deepStrictEqual(readRegistry(untrackedHome), [], 'no .handoff, so nothing recorded');
    assert.ok(out.hookSpecificOutput.additionalContext.includes('not set up'), 'still gets the bootstrap');
  });

  test('a registry failure cannot break session-start', () => {
    const tracked = trackedProject('reg-fail-proj');
    // Point claudeHome at a regular FILE, so the registry cannot create its
    // directory under it — upsert fails, and the hook must carry on regardless.
    const badHome = path.join(tmpdir('reg-fail'), 'not-a-dir');
    fs.writeFileSync(badHome, 'x');

    const out = runHook(
      'session-start.js',
      { cwd: tracked, session_id: 's3' },
      { CLAUDE_CONFIG_DIR: badHome }
    );
    assert.ok(out, 'the hook still produced output');
    assert.ok(
      out.hookSpecificOutput.additionalContext.includes('where we left off'),
      'the recap is delivered despite the registry write failing'
    );
  });
};
