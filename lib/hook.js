'use strict';

/**
 * Shared plumbing for the four hooks. A hook must never break the session it
 * runs in, so every failure path here ends in a silent exit 0.
 */

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    };
    if (process.stdin.isTTY) return resolve({});
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      data += c;
    });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
    setTimeout(done, 2000).unref?.();
  });
}

function emit(payload) {
  if (payload) process.stdout.write(JSON.stringify(payload));
}

function context(eventName, text) {
  return { hookSpecificOutput: { hookEventName: eventName, additionalContext: text } };
}

/**
 * Every hook acts on the project Claude Code names in `cwd`. Without one there
 * is no target, and `paths()` would fall back to the process's own directory —
 * so a truncated, malformed or empty payload would read and write a project the
 * hook was never invoked for, purely because that is where the process happened
 * to be standing. No cwd, no work.
 */
function targeted(input) {
  return Boolean(input && typeof input.cwd === 'string' && input.cwd.trim());
}

/**
 * User-facing name of one of our slash commands. Installed via install.js the
 * commands are global (`/handoff-init`); installed as a plugin they are
 * namespaced by the plugin name (`/handoff:handoff-init`). Plugin hooks run
 * with CLAUDE_PLUGIN_ROOT set, which is how the two installs are told apart.
 */
function slashCommand(name) {
  return process.env.CLAUDE_PLUGIN_ROOT ? `/handoff:${name}` : `/${name}`;
}

/** Run `fn(input)`; anything it returns is emitted as JSON. Errors are swallowed. */
function run(fn) {
  readStdin()
    .then((input) => (targeted(input) ? fn(input) : null))
    .then((out) => {
      emit(out);
      process.exit(0);
    })
    .catch((err) => {
      if (process.env.HANDOFF_DEBUG) console.error('[handoff]', err);
      process.exit(0);
    });
}

module.exports = { readStdin, emit, context, run, targeted, slashCommand };
