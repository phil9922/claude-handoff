'use strict';

/**
 * The plugin packaging (.claude-plugin/ + hooks/hooks.json) and the
 * slash-command namespacing that depends on how the hooks were installed.
 * Plugin hooks run with CLAUDE_PLUGIN_ROOT set; settings.json hooks do not.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

module.exports = ({ test, tmpdir, runHook, ROOT }) => {
  const readJson = (...parts) => JSON.parse(fs.readFileSync(path.join(ROOT, ...parts), 'utf8'));

  test('plugin.json is valid and points at real files', () => {
    const plugin = readJson('.claude-plugin', 'plugin.json');
    assert.strictEqual(plugin.name, 'handoff', 'the name is the command namespace — changing it breaks /handoff:*');
    assert.ok(/^[a-z0-9-]+$/.test(plugin.name), 'kebab-case, no spaces');
    assert.ok(plugin.version, 'users only receive updates when this is bumped');
    assert.ok(fs.existsSync(path.join(ROOT, plugin.hooks)), `hooks manifest missing: ${plugin.hooks}`);
  });

  test('marketplace.json serves this repo as its own marketplace', () => {
    const market = readJson('.claude-plugin', 'marketplace.json');
    assert.ok(market.name && market.owner && market.owner.name);
    const entry = market.plugins.find((p) => p.name === 'handoff');
    assert.ok(entry, 'the handoff plugin must be listed');
    assert.strictEqual(entry.source, './', 'the repo root is the plugin root');
  });

  test('hooks.json mirrors the installer wiring exactly', () => {
    const { hooks } = readJson('hooks', 'hooks.json');
    // Same events, matchers and timeouts as install.js hookConfig().
    const expected = {
      SessionStart: { script: 'session-start.js', timeout: 10 },
      PostToolUse: { script: 'track.js', timeout: 5, matcher: 'Write|Edit|MultiEdit|Bash' },
      Stop: { script: 'stop.js', timeout: 10 },
      SessionEnd: { script: 'session-end.js', timeout: 10 },
    };
    assert.deepStrictEqual(Object.keys(hooks).sort(), Object.keys(expected).sort());
    for (const [event, want] of Object.entries(expected)) {
      const groups = hooks[event];
      assert.strictEqual(groups.length, 1, `${event}: one group`);
      assert.strictEqual(groups[0].matcher, want.matcher, `${event}: matcher`);
      const [hook] = groups[0].hooks;
      assert.strictEqual(hook.type, 'command');
      assert.strictEqual(hook.command, 'node', 'exec form avoids shell parsing of the plugin path');
      assert.strictEqual(hook.timeout, want.timeout, `${event}: timeout`);
      assert.deepStrictEqual(hook.args, [`\${CLAUDE_PLUGIN_ROOT}/hooks/${want.script}`]);
      assert.ok(fs.existsSync(path.join(ROOT, 'hooks', want.script)), `${want.script} must exist`);
    }
  });

  test('slashCommand namespaces only under a plugin install', () => {
    const { slashCommand } = require('../lib/hook');
    const prev = process.env.CLAUDE_PLUGIN_ROOT;
    try {
      delete process.env.CLAUDE_PLUGIN_ROOT;
      assert.strictEqual(slashCommand('handoff-init'), '/handoff-init');
      process.env.CLAUDE_PLUGIN_ROOT = '/somewhere/plugins/handoff';
      assert.strictEqual(slashCommand('handoff-init'), '/handoff:handoff-init');
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
      else process.env.CLAUDE_PLUGIN_ROOT = prev;
    }
  });

  test('injected context names the namespaced commands under a plugin install', () => {
    const env = { CLAUDE_PLUGIN_ROOT: '/somewhere/plugins/handoff' };

    // Bootstrap offer in an untracked project.
    const cold = runHook('session-start.js', { cwd: tmpdir('plug-cold'), session_id: 's1' }, env);
    const coldText = cold.hookSpecificOutput.additionalContext;
    assert.ok(coldText.includes('/handoff:handoff-init'), coldText.slice(0, 200));
    assert.ok(!coldText.includes('`/handoff-init`'), 'must not name a command that does not exist');

    // Interview offer in a tracked project without PROJECT.md.
    const dir = tmpdir('plug-warm');
    fs.mkdirSync(path.join(dir, '.handoff'));
    fs.writeFileSync(
      path.join(dir, '.handoff', 'CHECKLIST.md'),
      '## P0 — Required to work\n- [ ] [45m] Task A'
    );
    const warm = runHook('session-start.js', { cwd: dir, session_id: 's1' }, env);
    assert.ok(warm.hookSpecificOutput.additionalContext.includes('/handoff:handoff-project'));
  });
};
