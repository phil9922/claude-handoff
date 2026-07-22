#!/usr/bin/env node
'use strict';

/**
 * Removes the addon's hooks and files. Other tools' hooks are untouched, and
 * per-project .handoff/ directories are deliberately left alone — they're your
 * notes, not the addon's.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const DEST = path.join(HOME, 'handoff');
const SETTINGS = path.join(HOME, 'settings.json');
const BACKUPS = path.join(HOME, 'backups');
const COMMANDS = path.join(HOME, 'commands');

const OURS = /handoff[\\/]hooks[\\/]/;

/**
 * Derived from what was actually installed rather than a hardcoded list, so a
 * command added later can't be orphaned here. Falls back to the naming prefix
 * if the program directory is already gone.
 */
function ourCommands() {
  try {
    return fs.readdirSync(path.join(DEST, 'commands')).filter((f) => f.endsWith('.md'));
  } catch {
    try {
      return fs.readdirSync(COMMANDS).filter((f) => /^handoff(-[a-z]+)?\.md$/.test(f));
    } catch {
      return [];
    }
  }
}

const log = (msg) => console.log(msg);

function cleanSettings() {
  if (!fs.existsSync(SETTINGS)) return;
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  } catch (err) {
    throw new Error(`${SETTINGS} is not valid JSON (${err.message}); not touching it.`);
  }
  if (!settings.hooks && !settings.statusLine) return;

  fs.mkdirSync(BACKUPS, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const saved = path.join(BACKUPS, `settings.json.${stamp}.handoff-uninstall.bak`);
  fs.copyFileSync(SETTINGS, saved);

  if (settings.statusLine && /handoff[\\/]hooks[\\/]statusline/.test(settings.statusLine.command || '')) {
    delete settings.statusLine;
    log('• Removed the statusline (Claude Code default restored)');
  }

  let removed = 0;
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((group) => {
        const hooks = (group.hooks || []).filter((h) => {
          const ours = OURS.test(String(h.command || ''));
          if (ours) removed += 1;
          return !ours;
        });
        return { ...group, hooks };
      })
      .filter((group) => group.hooks.length > 0);

    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }

  fs.writeFileSync(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
  log(`• Removed ${removed} hook(s) from settings.json (backup: ${saved})`);
}

const SHELL_BEGIN = '# >>> claude-handoff >>>';
const SHELL_END = '# <<< claude-handoff <<<';

/** Take the `claude` wrapper back out of the shell startup files it was added to. */
function cleanShell() {
  const block = new RegExp(`\\n*${SHELL_BEGIN}[\\s\\S]*?${SHELL_END}\\n*`, 'g');
  let cleaned = 0;

  for (const name of ['.bashrc', '.zshrc']) {
    const file = path.join(os.homedir(), name);
    if (!fs.existsSync(file)) continue;
    const current = fs.readFileSync(file, 'utf8');
    const stripped = current.replace(block, '\n');
    if (stripped === current) continue;

    fs.mkdirSync(BACKUPS, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(file, path.join(BACKUPS, `${name.replace(/^\./, '')}.${stamp}.handoff-uninstall.bak`));
    fs.writeFileSync(file, `${stripped.replace(/\n+$/, '')}\n`);
    cleaned += 1;
  }

  if (cleaned) log(`• Removed the \`claude\` wrapper from ${cleaned} shell startup file(s)`);
}

function removeFiles() {
  const commands = ourCommands();
  for (const file of commands) {
    const p = path.join(COMMANDS, file);
    if (fs.existsSync(p)) fs.rmSync(p);
  }
  if (fs.existsSync(DEST)) fs.rmSync(DEST, { recursive: true, force: true });
  log(`• Removed ${commands.length} command(s) and the program files`);
}

try {
  log('Uninstalling Claude Code handoff addon…\n');
  cleanSettings();
  cleanShell();
  removeFiles();
  log('\nDone. Your .handoff/ folders were left in place.');
} catch (err) {
  console.error(`\nUninstall failed: ${err.message}`);
  process.exit(1);
}
