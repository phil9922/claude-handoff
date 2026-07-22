#!/usr/bin/env node
'use strict';

/**
 * Installs the handoff addon into ~/.claude and wires it into user-scope hooks,
 * so it applies to every project folder on any OS.
 *
 * Safe to re-run: hook entries are keyed by path and replaced, never duplicated.
 * settings.json is backed up before it is touched, and existing hooks from other
 * tools are left exactly as they are.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const DEST = path.join(HOME, 'handoff');
const SETTINGS = path.join(HOME, 'settings.json');
const BACKUPS = path.join(HOME, 'backups');
const COMMANDS = path.join(HOME, 'commands');
const SRC = __dirname;

// Matches our own hook commands on both POSIX and Windows separators.
const OURS = /handoff[\\/]hooks[\\/]/;

const log = (msg) => console.log(msg);

function nodeBin() {
  // Hooks run in a non-login shell where a version-manager PATH may be absent,
  // so bake in the interpreter that is running this installer.
  const bin = process.execPath;
  return bin && fs.existsSync(bin) ? bin : 'node';
}

function hookCommand(script) {
  return `"${nodeBin()}" "${path.join(DEST, 'hooks', script)}"`;
}

function entry(script, timeout, matcher) {
  const group = { hooks: [{ type: 'command', command: hookCommand(script), timeout }] };
  if (matcher) group.matcher = matcher;
  return group;
}

// timeout is in seconds. SessionEnd defaults to 1.5s, which is too tight for a
// git call, and a per-hook timeout also raises the overall SessionEnd budget.
function hookConfig() {
  return {
    SessionStart: entry('session-start.js', 10),
    PostToolUse: entry('track.js', 5, 'Write|Edit|MultiEdit|Bash'),
    Stop: entry('stop.js', 10),
    SessionEnd: entry('session-end.js', 10),
  };
}

function copyTree() {
  if (path.resolve(SRC) === path.resolve(DEST)) {
    log('• Source is already the install directory — skipping copy');
    return;
  }
  fs.mkdirSync(DEST, { recursive: true });
  for (const dir of ['lib', 'hooks', 'templates', 'commands', 'shell']) {
    const from = path.join(SRC, dir);
    if (!fs.existsSync(from)) continue;
    fs.rmSync(path.join(DEST, dir), { recursive: true, force: true });
    fs.cpSync(from, path.join(DEST, dir), { recursive: true });
  }
  for (const file of ['install.js', 'uninstall.js', 'README.md']) {
    const from = path.join(SRC, file);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(DEST, file));
  }
  log(`• Installed to ${DEST}`);
}

function installCommands() {
  fs.mkdirSync(COMMANDS, { recursive: true });
  const from = path.join(SRC, 'commands');
  if (!fs.existsSync(from)) return;
  const installed = [];
  for (const file of fs.readdirSync(from)) {
    if (!file.endsWith('.md')) continue;
    fs.copyFileSync(path.join(from, file), path.join(COMMANDS, file));
    installed.push(`/${path.basename(file, '.md')}`);
  }
  log(`• Commands available: ${installed.sort().join(', ')}`);
}

const SHELL_BEGIN = '# >>> claude-handoff >>>';
const SHELL_END = '# <<< claude-handoff <<<';

/** Drop a previously installed block so re-running can't stack duplicates. */
function stripShellBlock(text) {
  const block = new RegExp(`\\n*${SHELL_BEGIN}[\\s\\S]*?${SHELL_END}\\n*`, 'g');
  return text.replace(block, '\n');
}

/**
 * Sources the `claude` wrapper from the user's shell startup file.
 *
 * SessionStart hooks can only add context — they can't make Claude speak first.
 * Passing a first prompt on the command line can, so a bare `claude` inside a
 * tracked project becomes `claude "Where did we leave off?"` and the session
 * opens on the recap rather than an empty box.
 */
function installShell() {
  const script = path.join(DEST, 'shell', 'handoff.sh');
  if (process.platform === 'win32') {
    log('• Skipped the shell wrapper (POSIX shells only)');
    return;
  }

  const targets = ['.bashrc', '.zshrc']
    .map((name) => path.join(os.homedir(), name))
    .filter((file) => fs.existsSync(file));

  if (!targets.length) {
    log('• No .bashrc or .zshrc found — to open sessions on the recap, add:');
    log(`    . "${script}"`);
    return;
  }

  const block = [SHELL_BEGIN, `[ -f "${script}" ] && . "${script}"`, SHELL_END].join('\n');

  for (const file of targets) {
    const current = fs.readFileSync(file, 'utf8');
    const stripped = stripShellBlock(current);
    if (stripped === current) {
      fs.mkdirSync(BACKUPS, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      // Without the leading dot, so the backup isn't hidden inside backups/.
      const name = path.basename(file).replace(/^\./, '');
      fs.copyFileSync(file, path.join(BACKUPS, `${name}.${stamp}.handoff-install.bak`));
    }
    fs.writeFileSync(file, `${stripped.replace(/\n+$/, '')}\n\n${block}\n`);
  }

  log(`• A bare \`claude\` now opens on the recap (${targets.map((f) => path.basename(f)).join(', ')})`);
  log('  Reload with `exec bash`, or use `claude --raw` to bypass it');
}

function readSettings() {
  if (!fs.existsSync(SETTINGS)) return {};
  const raw = fs.readFileSync(SETTINGS, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${SETTINGS} is not valid JSON (${err.message}). Fix it before installing — ` +
        'refusing to touch it so nothing is lost.'
    );
  }
}

function backup() {
  if (!fs.existsSync(SETTINGS)) return null;
  fs.mkdirSync(BACKUPS, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(BACKUPS, `settings.json.${stamp}.handoff-install.bak`);
  fs.copyFileSync(SETTINGS, dest);
  return dest;
}

/** Drop any previous handoff entries from an event, keeping everyone else's. */
function stripOurs(groups) {
  return (Array.isArray(groups) ? groups : [])
    .map((group) => {
      const hooks = (group.hooks || []).filter((h) => !OURS.test(String(h.command || '')));
      return { ...group, hooks };
    })
    .filter((group) => group.hooks.length > 0);
}

/**
 * Claude Code allows one statusline, so an existing one from another tool is
 * left alone rather than silently replaced. Ours is recognized by its path.
 */
function mergeStatusline(settings) {
  const command = `"${nodeBin()}" "${path.join(DEST, 'hooks', 'statusline.js')}"`;
  const current = settings.statusLine?.command;

  if (current && !/handoff[\\/]hooks[\\/]statusline/.test(current)) {
    log('• Left your existing statusline alone (only one is supported)');
    log(`  To use this one instead, set statusLine.command to: ${command}`);
    return;
  }

  settings.statusLine = { type: 'command', command };
  log('• Statusline shows model, outstanding work, directory and context use');
}

function mergeSettings() {
  const settings = readSettings();
  const saved = backup();
  if (saved) log(`• Backed up settings to ${saved}`);

  settings.hooks = settings.hooks || {};
  const config = hookConfig();
  let preserved = 0;

  for (const [event, group] of Object.entries(config)) {
    const existing = stripOurs(settings.hooks[event]);
    preserved += existing.reduce((n, g) => n + g.hooks.length, 0);
    settings.hooks[event] = [...existing, group];
  }

  mergeStatusline(settings);

  fs.writeFileSync(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
  log(`• Wired 4 hooks into ${SETTINGS} (${preserved} pre-existing hooks on those events kept)`);
}

function main() {
  log('Installing Claude Code handoff addon…\n');
  copyTree();
  installCommands();
  mergeSettings();
  installShell();
  log('\nDone. Open any project and Claude will offer to set up handoff tracking.');
  log('Already-tracked projects show the recap and a "what next" picker on start.');
  log(`\nTo remove: node "${path.join(DEST, 'uninstall.js')}"`);
  log('If this tool saves you time, you can support it: https://ko-fi.com/phil9922');
}

try {
  main();
} catch (err) {
  console.error(`\nInstall failed: ${err.message}`);
  process.exit(1);
}
