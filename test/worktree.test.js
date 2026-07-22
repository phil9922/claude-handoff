'use strict';

/**
 * Git worktrees have a `.git` *file* (not a directory) pointing at
 * <main>/.git/worktrees/<name>. findProjectRoot must resolve that back to the
 * main checkout so the worktree shares its .handoff — while leaving plain
 * repos, submodules and malformed files alone.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

module.exports = ({ test, tmpdir }) => {
  const { findProjectRoot } = require('../lib/paths');

  // Build a fake main checkout with a real `.git` directory and a worktree
  // registration under it. Returns the paths involved.
  function mainCheckout(label) {
    const main = tmpdir(label);
    const gitDir = path.join(main, '.git');
    fs.mkdirSync(path.join(gitDir, 'worktrees', 'wt'), { recursive: true });
    return { main, gitDir };
  }

  test('a worktree .git file resolves to the main root', () => {
    const { main, gitDir } = mainCheckout('wt-main');
    const wt = tmpdir('wt-checkout');
    fs.writeFileSync(
      path.join(wt, '.git'),
      `gitdir: ${path.join(gitDir, 'worktrees', 'wt')}\n`
    );
    assert.strictEqual(findProjectRoot(wt), main);
  });

  test('a relative gitdir resolves against the .git file directory', () => {
    const { main, gitDir } = mainCheckout('wt-rel');
    const wt = tmpdir('wt-rel-checkout');
    const rel = path.relative(wt, path.join(gitDir, 'worktrees', 'wt'));
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${rel}\n`);
    assert.strictEqual(findProjectRoot(wt), main);
  });

  test('a malformed .git file falls back to the worktree dir', () => {
    const wt = tmpdir('wt-bad');
    fs.writeFileSync(path.join(wt, '.git'), 'this is not a gitdir line\n');
    assert.strictEqual(findProjectRoot(wt), wt);
  });

  test('a real .git directory still resolves to that directory', () => {
    const dir = tmpdir('wt-plain');
    fs.mkdirSync(path.join(dir, '.git'));
    assert.strictEqual(findProjectRoot(dir), dir);
  });

  test('a submodule-style gitdir (.git/modules/...) is not redirected', () => {
    const { gitDir } = mainCheckout('wt-sub');
    const sub = tmpdir('wt-submodule');
    fs.writeFileSync(
      path.join(sub, '.git'),
      `gitdir: ${path.join(gitDir, 'modules', 'sub')}\n`
    );
    assert.strictEqual(findProjectRoot(sub), sub);
  });

  test('a worktree pointing at a nonexistent main root falls back to itself', () => {
    const wt = tmpdir('wt-gone');
    fs.writeFileSync(
      path.join(wt, '.git'),
      `gitdir: ${path.join(wt, 'nope', '.git', 'worktrees', 'wt')}\n`
    );
    assert.strictEqual(findProjectRoot(wt), wt);
  });
};
