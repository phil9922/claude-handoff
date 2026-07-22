'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const HANDOFF_DIR = '.handoff';

/**
 * A git worktree's `.git` is a file, not a directory, naming the real gitdir:
 *   gitdir: <main>/.git/worktrees/<name>
 * Resolve that to <main> so the worktree shares the main checkout's .handoff.
 * Returns null for anything we don't recognise — a submodule (gitdir points at
 * `.git/modules/...`), a malformed/unreadable file, or a target that isn't on
 * disk — so the caller keeps its current behaviour. Never throws.
 */
function worktreeMainRoot(gitFile, dir) {
  try {
    const match = fs.readFileSync(gitFile, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m);
    if (!match) return null;
    let gitdir = match[1];
    if (!path.isAbsolute(gitdir)) gitdir = path.resolve(dir, gitdir);
    // Expect <main>/.git/worktrees/<name>; walk up to the dir holding .git.
    const worktreesDir = path.dirname(gitdir); // <main>/.git/worktrees
    const gitDir = path.dirname(worktreesDir); // <main>/.git
    const mainRoot = path.dirname(gitDir); //     <main>
    if (path.basename(worktreesDir) !== 'worktrees') return null;
    if (path.basename(gitDir) !== '.git') return null;
    if (!fs.existsSync(mainRoot)) return null;
    return mainRoot;
  } catch {
    return null;
  }
}

/**
 * Walk up from `start` looking for a .git entry. A .git directory marks the
 * root; a .git file marks a worktree, which resolves to the main checkout.
 * Falls back to `start` itself so the addon still works outside a repo.
 */
function findProjectRoot(start) {
  let dir = path.resolve(start);
  const { root } = path.parse(dir);
  while (true) {
    const gitEntry = path.join(dir, '.git');
    let stat = null;
    try {
      if (fs.existsSync(gitEntry)) stat = fs.statSync(gitEntry);
    } catch {
      stat = null;
    }
    if (stat) {
      if (stat.isFile()) {
        const main = worktreeMainRoot(gitEntry, dir);
        if (main) return main;
      }
      return dir;
    }
    if (dir === root) return path.resolve(start);
    dir = path.dirname(dir);
  }
}

function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function historyPath() {
  return process.env.HANDOFF_HISTORY_PATH || path.join(claudeHome(), 'history.jsonl');
}

function paths(cwd) {
  const projectRoot = findProjectRoot(cwd || process.cwd());
  const dir = path.join(projectRoot, HANDOFF_DIR);
  return {
    projectRoot,
    dir,
    handoff: path.join(dir, 'HANDOFF.md'),
    log: path.join(dir, 'LOG.md'),
    checklist: path.join(dir, 'CHECKLIST.md'),
    project: path.join(dir, 'PROJECT.md'),
    active: path.join(dir, 'ACTIVE.md'),
    state: path.join(dir, '.state.json'),
    gitExclude: path.join(projectRoot, '.git', 'info', 'exclude'),
  };
}

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

module.exports = { HANDOFF_DIR, paths, findProjectRoot, claudeHome, historyPath, exists };
