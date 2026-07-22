'use strict';

const fs = require('fs');
const path = require('path');

const { claudeHome } = require('./paths');

/**
 * A cross-project index of every checkout that has run a tracked SessionStart,
 * so a single command can survey open work everywhere. It lives OUTSIDE any one
 * project — at `<claudeHome>/handoff/projects.json`, where claudeHome honours
 * CLAUDE_CONFIG_DIR — so it is shared across projects and easy to sandbox in a
 * test. It is a convenience cache, never a source of truth: every read tolerates
 * a missing or corrupt file, and every write is best-effort. Nothing here throws.
 */

// Keep the list bounded no matter how many projects a machine accumulates. The
// most-recently-seen entries are the ones worth surfacing, so those are kept.
const MAX_PROJECTS = 100;

function registryPath() {
  return path.join(claudeHome(), 'handoff', 'projects.json');
}

/** The parsed registry, or [] on a missing/corrupt/never-created file. */
function list() {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath(), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** True only when `<root>/.handoff` still exists — a moved/deleted project prunes. */
function stillTracked(root) {
  try {
    return typeof root === 'string' && fs.existsSync(path.join(root, '.handoff'));
  } catch {
    return false;
  }
}

/**
 * Record (or refresh) `projectRoot` in the registry. Deduped by root, capped at
 * MAX_PROJECTS keeping the most-recently-seen, and pruned of any entry whose
 * `.handoff/` has since vanished. Written atomically (tmp + rename) so a killed
 * process can never leave a half-written file. Best-effort: returns false rather
 * than throwing on any failure, so a registry problem can never reach the caller.
 */
function upsert(projectRoot) {
  try {
    if (!projectRoot || typeof projectRoot !== 'string') return false;
    const root = path.resolve(projectRoot);
    const entry = { root, name: path.basename(root), lastSeen: new Date().toISOString() };

    // Rebuild from disk: drop the entry we're refreshing plus any dead projects,
    // put this one on top, sort newest-first, then cap.
    const kept = list().filter(
      (e) => e && typeof e.root === 'string' && e.root !== root && stillTracked(e.root)
    );
    let next = [entry, ...kept].sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : 0));
    if (next.length > MAX_PROJECTS) next = next.slice(0, MAX_PROJECTS);

    const file = registryPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, file); // atomic
    return true;
  } catch {
    return false;
  }
}

module.exports = { upsert, list, registryPath, MAX_PROJECTS };
