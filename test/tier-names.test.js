'use strict';

/**
 * Optional custom tier names via .handoff/config.json:
 *   { "tiers": { "P0": "Now", "P1": "Soon", "P2": "Later" } }
 *
 * The canonical keys (P0/P1/P2) never change — only the DISPLAY does — and a
 * project with no config.json must behave byte-for-byte as it does today.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

module.exports = ({ test, tmpdir, ROOT }) => {
  const checklist = require(path.join(ROOT, 'lib', 'checklist'));
  const statusline = require(path.join(ROOT, 'hooks', 'statusline'));
  const runHook = (script, input, env = {}) => {
    // Local runHook: the shared one JSON.parses stdout, which statusline is not.
    const { execFileSync } = require('child_process');
    const out = execFileSync(process.execPath, [path.join(ROOT, 'hooks', script)], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    return out.trim() ? JSON.parse(out) : null;
  };

  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

  // Two open P0 items (45m + 2h = 2.8h), matching the shape the in-repo tests use.
  const TWO_P0 = ['## P0 — Required to work', '- [ ] [45m] Task A', '- [ ] [2h] Task B'].join('\n');

  function project(label, opts = {}) {
    const dir = tmpdir(label);
    const handoff = path.join(dir, '.handoff');
    fs.mkdirSync(handoff, { recursive: true });
    fs.writeFileSync(path.join(handoff, 'CHECKLIST.md'), opts.checklist || TWO_P0);
    if (opts.config !== undefined) {
      const body = typeof opts.config === 'string' ? opts.config : JSON.stringify(opts.config);
      fs.writeFileSync(path.join(handoff, 'config.json'), body);
    }
    return { dir, handoff, checklist: path.join(handoff, 'CHECKLIST.md') };
  }

  const renderFor = (dir) =>
    strip(statusline.render({ model: { display_name: 'Opus' }, workspace: { current_dir: dir } }));

  // (1) Parsing renamed headings when config maps them.
  test('tier-names: renamed headings normalize to canonical tiers with config', () => {
    const md = [
      '## Now — Required to work',
      '- [ ] [45m] Ship the thing',
      '## Soon — Good ideas',
      '- [ ] [30m] Nice follow-up',
      '## Later — Extras',
      '- [ ] [10m] Someday',
    ].join('\n');
    const config = { tiers: { P0: 'Now', P1: 'Soon', P2: 'Later' } };

    const { items } = checklist.parse(md, config);
    assert.strictEqual(items.length, 3);
    assert.strictEqual(items[0].tier, 'P0', 'Now -> P0');
    assert.strictEqual(items[1].tier, 'P1', 'Soon -> P1');
    assert.strictEqual(items[2].tier, 'P2', 'Later -> P2');

    // Without config the renamed headings are not recognized, so items fall back
    // to the default tier exactly as an unrecognized heading does today.
    const plain = checklist.parse(md).items;
    assert.ok(plain.every((i) => i.tier === 'P1'), 'no config -> renamed headings ignored');
  });

  test('tier-names: a heading matching two configured names is ambiguous and ignored', () => {
    const md = ['## Now — heading', '- [ ] [5m] Item'].join('\n');
    const config = { tiers: { P0: 'Now', P1: 'Now' } };
    const { items } = checklist.parse(md, config);
    assert.strictEqual(items[0].tier, 'P1', 'ambiguous heading behaves as unrecognized');
  });

  test('tier-names: a bare display name (## Now) matches but ## Nowhere does not', () => {
    const config = { tiers: { P0: 'Now' } };
    assert.strictEqual(checklist.tierOf('## Now', config), 'P0');
    assert.strictEqual(checklist.tierOf('## Now — x', config), 'P0');
    assert.strictEqual(checklist.tierOf('## Nowhere — x', config), null);
    assert.strictEqual(checklist.tierOf('## P0 — x', config), 'P0', 'canonical still wins');
  });

  // (2) Statusline shows display names with config, P0 without.
  test('tier-names: statusline shows the display name with config, P0 without', () => {
    const withCfg = project('sl-cfg', { config: { tiers: { P0: 'Now', P1: 'Soon', P2: 'Later' } } });
    const noCfg = project('sl-nocfg');

    const a = renderFor(withCfg.dir);
    assert.ok(a.includes('2 Now'), a);
    assert.ok(!a.includes('2 P0'), a);
    assert.ok(a.includes('~2.8h'), a);

    const b = renderFor(noCfg.dir);
    assert.ok(b.includes('2 P0'), b);
    assert.ok(!b.includes('Now'), b);
  });

  test('tier-names: statusline counts renamed headings too and shows the display name', () => {
    const md = ['## Now — Required to work', '- [ ] [45m] A', '- [ ] [2h] B'].join('\n');
    const p = project('sl-renamed', { checklist: md, config: { tiers: { P0: 'Now' } } });
    const line = renderFor(p.dir);
    assert.ok(line.includes('2 Now'), line);
    assert.ok(line.includes('~2.8h'), line);
  });

  // (3) Invalid config is ignored silently — output identical to no config.
  test('tier-names: invalid config.json is ignored, output identical to no config', () => {
    const noCfg = project('inv-nocfg');
    const badJson = project('inv-badjson', { config: '{ this is : not json' });
    const wrongShape = project('inv-wrongshape', { config: { tiers: ['P0', 'nope'] } });
    const emptyTiers = project('inv-empty', { config: { tiers: {} } });

    const base = renderFor(noCfg.dir);
    assert.ok(base.includes('2 P0'), base);
    for (const p of [badJson, wrongShape, emptyTiers]) {
      // Compare after dropping the trailing project-basename segment, which
      // differs only because the throwaway dirs have different names.
      const drop = (s) => s.split(' │ ').slice(0, -1).join(' │ ');
      assert.strictEqual(drop(renderFor(p.dir)), drop(base), `${path.basename(p.dir)} must match no-config`);
    }

    // loadConfig itself never throws and yields an empty map for junk input.
    assert.deepStrictEqual(checklist.loadConfig(badJson.handoff), { tiers: {} });
    assert.deepStrictEqual(checklist.loadConfig(wrongShape.handoff), { tiers: {} });
    assert.deepStrictEqual(checklist.loadConfig('/no/such/dir'), { tiers: {} });
  });

  test('tier-names: invalid config yields a session-start recap identical to no config', () => {
    const cl = ['## P0 — Required to work', '- [ ] [45m] Alpha', '## P1 — Good ideas', '- [ ] [30m] Beta'].join('\n');
    const noCfg = project('ss-nocfg', { checklist: cl });
    const badCfg = project('ss-badcfg', { checklist: cl, config: 'not json at all' });

    const a = runHook('session-start.js', { cwd: noCfg.dir, session_id: 's1' }).hookSpecificOutput.additionalContext;
    const b = runHook('session-start.js', { cwd: badCfg.dir, session_id: 's1' }).hookSpecificOutput.additionalContext;
    assert.strictEqual(b, a, 'broken config must not change the recap text');
    assert.ok(a.includes('**P0 — Required to work**'), a);
  });

  // (4) Partial config — only P0 renamed.
  test('tier-names: partial config renames only P0, leaves P1/P2 canonical', () => {
    const cl = [
      '## P0 — Required to work',
      '- [ ] [45m] Alpha',
      '## P1 — Good ideas',
      '- [ ] [30m] Beta',
    ].join('\n');
    const p = project('partial', { checklist: cl, config: { tiers: { P0: 'Now' } } });

    // Statusline: P0 count uses the renamed label.
    assert.ok(renderFor(p.dir).includes('2 Now') === false, 'only one open P0 here'); // sanity: single P0
    assert.ok(renderFor(p.dir).includes('1 Now'), renderFor(p.dir));

    const text = runHook('session-start.js', { cwd: p.dir, session_id: 's1' }).hookSpecificOutput.additionalContext;
    assert.ok(text.includes('**Now — Required to work**'), 'renamed P0 group heading');
    assert.ok(text.includes('**P1 — Good ideas**'), 'un-renamed P1 group heading stays P0/P1/P2');
    assert.ok(/\[Now · 45m\] Alpha/.test(text), 'picker option for P0 uses display name');
    assert.ok(/\[P1 · 30m\] Beta/.test(text), 'picker option for P1 unchanged');
  });

  // (5) No config anywhere — output matches today's known behavior.
  test('tier-names: no config end-to-end matches current P0/P1/P2 behavior', () => {
    const cl = [
      '## P0 — Required to work',
      '- [ ] [45m] Task A',
      '- [ ] [2h] Task B',
      '## P1 — Good ideas',
      '- [ ] [30m] Task C',
    ].join('\n');
    const p = project('today', { checklist: cl });

    // Statusline: the current format is "<n> P0 · ~<total>".
    const line = renderFor(p.dir);
    assert.ok(line.includes('2 P0'), line);

    // Session-start: current group headings and picker labels use P0/P1/P2.
    const text = runHook('session-start.js', { cwd: p.dir, session_id: 's1' }).hookSpecificOutput.additionalContext;
    assert.ok(text.includes('**P0 — Required to work**'), text);
    assert.ok(text.includes('**P1 — Good ideas**'), text);
    assert.ok(/\[P0 · 45m\] Task A/.test(text), 'picker still labels tiers P0');

    // And an explicit empty config file is byte-for-byte the same recap.
    const pEmpty = project('today-empty', { checklist: cl, config: { tiers: {} } });
    const textEmpty = runHook('session-start.js', { cwd: pEmpty.dir, session_id: 's1' })
      .hookSpecificOutput.additionalContext;
    assert.strictEqual(textEmpty, text, 'empty config must equal no config');
  });
};
