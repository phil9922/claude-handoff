'use strict';

const fs = require('fs');

/**
 * PROJECT.md is the "why" — goals, users, invariants, constraints, decisions.
 * It changes rarely, so it is injected whole at session start rather than
 * summarized, and kept short by the interview that writes it.
 */
const MAX_INJECTED = 3000;

function read(projectPath) {
  try {
    return fs.readFileSync(projectPath, 'utf8');
  } catch {
    return '';
  }
}

/** Strip template blockquote guidance and unfilled placeholders. */
function clean(content) {
  return content
    .split(/\r?\n/)
    .filter((l) => !l.startsWith('> '))
    .filter((l) => !/^_.*_$/.test(l.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** True when the file exists and has real content beyond headings. */
function isPopulated(content) {
  const body = clean(content)
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith('#'));
  return body.length > 0;
}

function forInjection(projectPath) {
  const raw = read(projectPath);
  if (!raw || !isPopulated(raw)) return null;
  const text = clean(raw);
  return text.length > MAX_INJECTED ? `${text.slice(0, MAX_INJECTED)}\n\n…(truncated)` : text;
}

module.exports = { read, clean, isPopulated, forInjection, MAX_INJECTED };
