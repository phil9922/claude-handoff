'use strict';

/**
 * The installer appends the `claude` wrapper (shell/handoff.sh) to BOTH .bashrc
 * and .zshrc, but only bash was ever exercised. zsh is macOS's default shell,
 * so the wrapper has to behave identically there. These tests re-run the
 * stub-PATH sandbox from run.js ("shell wrapper" block) under zsh instead of
 * bash.
 *
 * zsh is not always installed. When it is missing the file loads cleanly and
 * registers a single visible skip rather than a failure, with the install hint.
 * Point HANDOFF_ZSH at a zsh binary to force a specific one.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/** Find a runnable zsh: explicit override, then PATH. Returns a path or null. */
function findZsh() {
  const candidates = [];
  if (process.env.HANDOFF_ZSH) candidates.push(process.env.HANDOFF_ZSH);
  try {
    const found = execFileSync('command', ['-v', 'zsh'], {
      encoding: 'utf8',
      shell: '/bin/sh',
    }).trim();
    if (found) candidates.push(found);
  } catch (_) {
    /* not on PATH */
  }
  for (const bin of candidates) {
    try {
      const out = execFileSync(bin, ['-f', '-c', 'echo ok'], { encoding: 'utf8' });
      if (out.trim() === 'ok') return bin;
    } catch (_) {
      /* not runnable */
    }
  }
  return null;
}

module.exports = ({ test, tmpdir, ROOT }) => {
  const ZSH = findZsh();

  if (!ZSH) {
    test('zsh not installed — skipped', () => {
      console.log(
        '       zsh not found on PATH. To exercise the zsh wrapper tests, run:\n' +
          '         sudo apt-get install -y zsh   # (macOS ships zsh already)\n' +
          '       then re-run: node test/run.js'
      );
      assert.ok(true);
    });
    return;
  }

  const SCRIPT = path.join(ROOT, 'shell', 'handoff.sh');

  // A tracked project: any directory containing a .handoff/ marker.
  function trackedProject(label) {
    const dir = tmpdir(label);
    fs.mkdirSync(path.join(dir, '.handoff'));
    return dir;
  }

  /**
   * Drive the wrapper under zsh with a stub `claude` on PATH that prints its own
   * argv (arg count, then each arg on its own line), so we assert on exactly
   * what the real binary would have received.
   */
  function wrapper(cwd, command) {
    const bin = tmpdir('zbin');
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nprintf "%s\\n" "$#" "$@"\n');
    fs.chmodSync(path.join(bin, 'claude'), 0o755);
    // -f skips user rc files so the sandbox is hermetic; we source the wrapper
    // explicitly, exactly as .zshrc would.
    const out = execFileSync(ZSH, ['-f', '-c', `cd '${cwd}' && . '${SCRIPT}' && ${command}`], {
      encoding: 'utf8',
      env: { HOME: os.homedir(), PATH: `${bin}:/usr/bin:/bin` },
    });
    const lines = out.trim().split('\n');
    return { count: Number(lines[0]), args: lines.slice(1) };
  }

  test('zsh: a bare `claude` in a tracked project opens on the recap', () => {
    const dir = trackedProject('zwrap');
    const deep = path.join(dir, 'src', 'nested');
    fs.mkdirSync(deep, { recursive: true });

    for (const cwd of [dir, deep]) {
      const run = wrapper(cwd, 'claude');
      assert.strictEqual(run.count, 1, 'exactly one argument — the opening prompt');
      assert.ok(/leave off/i.test(run.args[0]), `expected an opening prompt, got ${run.args[0]}`);
    }
  });

  test('zsh: arguments are passed through untouched', () => {
    const dir = trackedProject('zwrap-args');
    assert.deepStrictEqual(wrapper(dir, 'claude --continue').args, ['--continue']);
    assert.deepStrictEqual(wrapper(dir, 'claude "fix the bug"').args, ['fix the bug']);
    assert.deepStrictEqual(wrapper(dir, 'claude --resume -p hi').args, ['--resume', '-p', 'hi']);
  });

  test('zsh: `--raw` bypasses the wrapper and forwards the rest', () => {
    const dir = trackedProject('zwrap-raw');
    // A bare --raw yields no injected prompt.
    assert.strictEqual(wrapper(dir, 'claude --raw').count, 0);
    // And --raw is stripped, everything after it survives verbatim.
    assert.deepStrictEqual(wrapper(dir, 'claude --raw -p hi').args, ['-p', 'hi']);
  });

  test('zsh: HANDOFF_NO_AUTOSTART=1 disables injection', () => {
    const dir = trackedProject('zwrap-noauto');
    assert.strictEqual(wrapper(dir, 'HANDOFF_NO_AUTOSTART=1 claude').count, 0);
  });

  test('zsh: HANDOFF_OPENING_PROMPT overrides the opening prompt', () => {
    const dir = trackedProject('zwrap-prompt');
    assert.deepStrictEqual(wrapper(dir, 'HANDOFF_OPENING_PROMPT=status claude').args, ['status']);
  });

  test('zsh: an untracked directory does nothing', () => {
    const untracked = tmpdir('zwrap-untracked');
    assert.strictEqual(wrapper(untracked, 'claude').count, 0);
  });

  test('zsh: the parent walk terminates at the filesystem root', () => {
    assert.strictEqual(wrapper('/', 'claude').count, 0);
  });
};
