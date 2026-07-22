'use strict';

/**
 * Capping LOG.md growth: sessions older than 90 days are folded into a single
 * collapsed `## Archive` block so SessionStart keeps parsing a short log.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const logfile = require('../lib/logfile');

/** A `## YYYY-MM-DD` heading `days` before `ref` (default: today). */
function heading(days, ref = new Date()) {
  const d = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - days);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

module.exports = ({ test, tmpdir, runHook, ROOT }) => {
  const NOW = new Date('2026-07-22T12:00:00Z');

  test('archives sections older than 90 days and leaves recent ones in place', () => {
    const recent = heading(10, NOW); // well inside the window
    const old = heading(200, NOW); // long past the cutoff
    const log = [
      '# Log',
      '',
      '> newest first',
      '',
      `## ${recent}`,
      '',
      '- Shipped the recap picker.',
      '',
      `## ${old}`,
      '',
      '- Original bootstrap work.',
      '- A second bullet, kept verbatim.',
      '',
    ].join('\n');

    const out = logfile.archiveOld(log, NOW);

    assert.ok(out.includes('## Archive'), 'an Archive section is created');
    assert.ok(out.includes('<details><summary>Older sessions</summary>'), 'with a collapsible summary');
    assert.ok(out.includes('</details>'), 'and a closing tag');

    // The recent day stays in the active list, above the archive.
    assert.ok(out.indexOf(`## ${recent}`) < out.indexOf('## Archive'), 'recent day stays active');
    assert.ok(out.includes('- Shipped the recap picker.'));

    // The old day moved into the archive, content preserved verbatim.
    assert.ok(out.indexOf(`## ${old}`) > out.indexOf('## Archive'), 'old day moved into archive');
    assert.ok(out.includes('- Original bootstrap work.'));
    assert.ok(out.includes('- A second bullet, kept verbatim.'));
  });

  test('archiving is idempotent — a second pass changes nothing', () => {
    const log = [
      '# Log',
      '',
      `## ${heading(5, NOW)}`,
      '',
      '- Recent.',
      '',
      `## ${heading(120, NOW)}`,
      '',
      '- Old.',
      '',
    ].join('\n');

    const once = logfile.archiveOld(log, NOW);
    const twice = logfile.archiveOld(once, NOW);
    assert.strictEqual(twice, once, 'a second run must be a no-op');

    // A newly-aged section merges into the existing archive, newest-first.
    const grown = once.replace(`## ${heading(5, NOW)}`, `## ${heading(100, NOW)}`);
    const merged = logfile.archiveOld(grown, NOW);
    const first = merged.indexOf(`## ${heading(100, NOW)}`);
    const second = merged.indexOf(`## ${heading(120, NOW)}`);
    assert.ok(first > merged.indexOf('## Archive'), 'the newly-old day is now archived');
    assert.ok(first < second, 'and sits above the older archived day (newest-first)');
    assert.strictEqual((merged.match(/## Archive/g) || []).length, 1, 'still one Archive section');
    assert.strictEqual(logfile.archiveOld(merged, NOW), merged, 'and it is idempotent too');
  });

  test('a log with no old sections is returned byte-for-byte', () => {
    const log = [
      '# Log',
      '',
      '> keep this exact',
      '',
      `## ${heading(1, NOW)}`,
      '',
      '- Today.',
      '',
      `## ${heading(89, NOW)}`,
      '',
      '- Just inside the window.',
      '',
    ].join('\n');
    assert.strictEqual(logfile.archiveOld(log, NOW), log, 'nothing aged out, so nothing changes');

    // The template log (heading + blockquote, no dated days) is left alone too.
    const tpl = fs.readFileSync(path.join(ROOT, 'templates', 'LOG.md'), 'utf8');
    assert.strictEqual(logfile.archiveOld(tpl, NOW), tpl);
  });

  test('a section with an unparseable date heading is left where it is', () => {
    const log = [
      '# Log',
      '',
      `## 2026-13-40`, // digits parse, the day does not
      '',
      '- Impossible date, must not move.',
      '',
      `## ${heading(300, NOW)}`,
      '',
      '- Genuinely old.',
      '',
    ].join('\n');
    const out = logfile.archiveOld(log, NOW);
    assert.ok(out.indexOf('## 2026-13-40') < out.indexOf('## Archive'), 'bad heading stays active');
    assert.ok(out.indexOf(`## ${heading(300, NOW)}`) > out.indexOf('## Archive'), 'valid old day moves');
  });

  test('never throws on garbage input', () => {
    for (const bad of [undefined, null, '', '   ', '# Log\n\nnot a section', '## Archive\n<details>']) {
      assert.doesNotThrow(() => logfile.archiveOld(bad, NOW));
    }
  });

  // ---- end to end through the real SessionStart hook ---------------------

  function project(label) {
    const dir = tmpdir(label);
    const handoff = path.join(dir, '.handoff');
    fs.mkdirSync(handoff);
    fs.copyFileSync(path.join(ROOT, 'templates', 'HANDOFF.md'), path.join(handoff, 'HANDOFF.md'));
    fs.writeFileSync(
      path.join(handoff, 'CHECKLIST.md'),
      ['## P0 — Required to work', '- [ ] [45m] Task A'].join('\n')
    );
    return { dir, handoff, log: path.join(handoff, 'LOG.md') };
  }

  test('session-start archives an old day and preserves LOG.md mtime', () => {
    const p = project('archive-e2e');
    // Dates are relative to the real clock, since the hook uses `new Date()`.
    const log = [
      '# Log',
      '',
      '> newest first',
      '',
      `## ${heading(3)}`,
      '',
      '- Recent work.',
      '',
      `## ${heading(400)}`,
      '',
      '- Ancient history worth keeping.',
      '',
    ].join('\n');
    fs.writeFileSync(p.log, log);
    const stale = new Date(Date.now() - 3_600_000);
    fs.utimesSync(p.log, stale, stale);

    const out = runHook('session-start.js', { cwd: p.dir, session_id: 's1' });
    const after = fs.readFileSync(p.log, 'utf8');

    assert.ok(after.includes('## Archive'), 'the old day is filed on disk');
    assert.ok(after.includes('<details><summary>Older sessions</summary>'));
    assert.ok(after.includes('- Ancient history worth keeping.'), 'its content survives');
    assert.ok(after.indexOf(`## ${heading(3)}`) < after.indexOf('## Archive'), 'recent day stays active');
    assert.ok(after.indexOf(`## ${heading(400)}`) > after.indexOf('## Archive'), 'old day archived');

    // The recap only surfaces the latest (recent) day, not the archived one.
    const recap = out.hookSpecificOutput.additionalContext;
    assert.ok(recap.includes('Recent work.'), 'recap shows the latest session');
    assert.ok(!recap.includes('Ancient history worth keeping.'), 'archived work stays out of the recap');

    assert.strictEqual(
      Math.round(fs.statSync(p.log).mtimeMs / 1000),
      Math.round(stale.getTime() / 1000),
      'mtime must be preserved — Stop and SessionEnd read it to detect a write-up'
    );
  });
};
