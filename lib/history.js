'use strict';

const fs = require('fs');
const { historyPath } = require('./paths');

/**
 * Claude Code offers previously-submitted prompts back as inline ghost text,
 * matched against the current project path. Planting one entry reproduces that
 * suggestion in a project the phrase was never typed in.
 *
 * history.jsonl is an INTERNAL, UNDOCUMENTED file. Everything here is
 * defensive: we validate the shape first, we only ever append, and we never
 * rewrite or reorder an existing line. If anything looks unfamiliar we report
 * failure and the caller falls back to a plain visible reminder.
 */
const PHRASE = 'update the handoff';
const REQUIRED_KEYS = ['display', 'pastedContents', 'timestamp', 'project', 'sessionId'];
const TAIL_BYTES = 64 * 1024;
const SCAN_LINES = 40;

function readTail(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    const length = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    const text = buf.toString('utf8');
    // A partial first line is likely if we started mid-file.
    return size > length ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

function looksLikeEntry(obj) {
  return (
    obj &&
    typeof obj === 'object' &&
    !Array.isArray(obj) &&
    REQUIRED_KEYS.every((k) => k in obj) &&
    typeof obj.display === 'string' &&
    typeof obj.project === 'string'
  );
}

/**
 * @returns {{ok: boolean, reason?: string, entries?: object[], endsWithNewline?: boolean}}
 */
function inspect(file) {
  if (!fs.existsSync(file)) return { ok: false, reason: 'missing' };
  let tail;
  try {
    tail = readTail(file);
  } catch (err) {
    return { ok: false, reason: `unreadable: ${err.code || err.message}` };
  }
  if (!tail.trim()) return { ok: false, reason: 'empty' };

  const lines = tail.split('\n').filter((l) => l.trim());
  const recent = lines.slice(-SCAN_LINES);
  const entries = [];
  let sawObject = false;

  for (const line of recent) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // tolerate a torn line from a concurrent writer
    }
    sawObject = true;
    if (!looksLikeEntry(obj)) return { ok: false, reason: 'unexpected entry shape' };
    entries.push(obj);
  }

  if (!sawObject) return { ok: false, reason: 'no parseable entries' };
  return { ok: true, entries, endsWithNewline: tail.endsWith('\n') };
}

/**
 * Plant the phrase for `project` unless it is already the most recent prompt
 * recorded for that project (in which case the suggestion already works).
 */
function seed({ project, sessionId, file = historyPath(), phrase = PHRASE }) {
  const info = inspect(file);
  if (!info.ok) return { seeded: false, ok: false, reason: info.reason };

  const forProject = info.entries.filter((e) => e.project === project);
  const last = forProject[forProject.length - 1];
  if (last && last.display.trim() === phrase) {
    return { seeded: false, ok: true, reason: 'already suggested' };
  }

  const entry = {
    display: phrase,
    pastedContents: {},
    timestamp: Date.now(),
    project,
    sessionId: sessionId || null,
  };

  try {
    const prefix = info.endsWithNewline ? '' : '\n';
    fs.appendFileSync(file, `${prefix}${JSON.stringify(entry)}\n`);
  } catch (err) {
    return { seeded: false, ok: false, reason: `append failed: ${err.code || err.message}` };
  }

  return { seeded: true, ok: true };
}

module.exports = { PHRASE, REQUIRED_KEYS, inspect, looksLikeEntry, seed };
