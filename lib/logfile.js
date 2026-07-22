'use strict';

/**
 * Shared handling of the auto-generated fallback entries SessionEnd writes.
 *
 * A fallback block is a placeholder: it exists so a session that ended without
 * a write-up still leaves a record. It is not meant to outlive the real entry
 * it stood in for.
 */

const AUTO_MARKER = '_auto-generated — session ended before this was written up_';
const AUTO_HEADING = /^###\s+Unwritten session/;
const DATE_HEADING = /^##\s+\d{4}-\d{2}-\d{2}/;

/** Index ranges of every auto block within `[from, to)`, as [start, end) pairs. */
function autoBlocks(lines, from, to) {
  const blocks = [];
  for (let i = from; i < to; i += 1) {
    if (!AUTO_HEADING.test(lines[i])) continue;
    let end = i + 1;
    while (end < to && !/^#{1,3}\s/.test(lines[end])) end += 1;
    blocks.push([i, end]);
    i = end - 1;
  }
  return blocks;
}

/**
 * Remove every auto block in `[from, to)` unconditionally. SessionEnd uses this
 * before writing a fresh one, so repeated firings replace rather than stack.
 */
function stripAutoBlocks(lines, from, to) {
  const drop = new Set();
  for (const [start, end] of autoBlocks(lines, from, to)) {
    for (let i = start; i < end; i += 1) drop.add(i);
  }
  return drop.size ? lines.filter((_, i) => !drop.has(i)) : lines;
}

/** The `## YYYY-MM-DD` sections of the log, as [start, end) line ranges. */
function dateSections(lines) {
  const starts = [];
  lines.forEach((line, i) => {
    if (DATE_HEADING.test(line)) starts.push(i);
  });
  return starts.map((start, n) => ({
    start,
    end: n + 1 < starts.length ? starts[n + 1] : lines.length,
  }));
}

/**
 * Drop placeholders that a real write-up has since superseded.
 *
 * A day whose only content is the placeholder keeps it — that session really
 * was never written up, and the auto entry is the only record of it. A day that
 * also has real content does not: the placeholder has been answered, and left
 * alone it would ride along in every future recap.
 */
function pruneSuperseded(text) {
  if (!text || !text.includes(AUTO_MARKER)) return text;
  let lines = text.split(/\r?\n/);

  // Back to front, so a section's line numbers survive edits to later ones.
  const sections = dateSections(lines);
  for (let s = sections.length - 1; s >= 0; s -= 1) {
    const { start, end } = sections[s];
    const blocks = autoBlocks(lines, start, end);
    if (!blocks.length) continue;

    const placeholder = new Set();
    for (const [from, to] of blocks) {
      for (let i = from; i < to; i += 1) placeholder.add(i);
    }

    let hasRealEntry = false;
    for (let i = start + 1; i < end && !hasRealEntry; i += 1) {
      if (!placeholder.has(i) && lines[i].trim()) hasRealEntry = true;
    }
    if (!hasRealEntry) continue;

    lines = lines.filter((_, i) => !placeholder.has(i));
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Fold sessions older than the cutoff into a single collapsed Archive block at
 * the foot of the log, so SessionStart keeps parsing a short list of recent
 * days rather than the project's entire history.
 *
 * Everything from the first `## Archive` heading onward is treated as already
 * filed and is never re-examined: the newly-old sections are lifted out of the
 * active list and prepended to whatever the archive already holds, keeping the
 * whole file newest-first. Sections whose heading is not a real date, and days
 * inside the cutoff, are left exactly where they are.
 *
 * On any doubt it returns the input untouched — a log that is too long is a
 * nuisance, but one this rewrote wrongly would lose notes. When there is
 * nothing to move it returns the original string byte-for-byte, so the caller's
 * "did anything change?" check stays honest.
 */
const ARCHIVE_DAYS = 90;
const ARCHIVE_HEADING = /^##\s+Archive\s*$/;
const ARCHIVE_SUMMARY = '<details><summary>Older sessions</summary>';
const ARCHIVE_MARKER = /<\/?(?:details|summary)/i;
const MS_PER_DAY = 86_400_000;

/** Epoch ms at UTC midnight for a `## YYYY-MM-DD` heading, or null if unreal. */
function headingDate(line) {
  const m = /^##\s+(\d{4})-(\d{2})-(\d{2})/.exec(line || '');
  if (!m) return null;
  const [, y, mo, d] = m.map(Number);
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    return null; // e.g. 2026-13-40 — parseable digits, impossible day
  }
  return ms;
}

/** Drop leading and trailing blank lines, keeping the content between verbatim. */
function trimBlank(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start += 1;
  while (end > start && !lines[end - 1].trim()) end -= 1;
  return lines.slice(start, end);
}

/** The date-section blocks already inside a `## Archive` region, order intact. */
function archivedBlocks(region) {
  const inner = region.filter((l) => !ARCHIVE_HEADING.test(l) && !ARCHIVE_MARKER.test(l));
  return dateSections(inner).map(({ start, end }) => trimBlank(inner.slice(start, end)));
}

function archiveOld(text, now = new Date()) {
  if (!text || !text.trim()) return text;
  try {
    const lines = text.split(/\r?\n/);

    // The archive is off-limits: past the first "## Archive" nothing is re-filed.
    let boundary = lines.length;
    for (let i = 0; i < lines.length; i += 1) {
      if (ARCHIVE_HEADING.test(lines[i])) {
        boundary = i;
        break;
      }
    }

    const head = lines.slice(0, boundary);
    const cutoff = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
      - ARCHIVE_DAYS * MS_PER_DAY;

    const drop = new Set();
    const moved = []; // document order == newest-first
    for (const { start, end } of dateSections(head)) {
      const when = headingDate(head[start]);
      if (when === null) continue; // unparseable heading: leave it be
      if (when >= cutoff) continue; // inside the window: still an active day
      moved.push(trimBlank(head.slice(start, end)));
      for (let i = start; i < end; i += 1) drop.add(i);
    }

    if (!moved.length) return text; // nothing aged out — hand back the original

    const remaining = trimBlank(head.filter((_, i) => !drop.has(i)));
    const existing = archivedBlocks(lines.slice(boundary));
    const body = [...moved, ...existing].map((b) => b.join('\n')).join('\n\n');

    const archive = ['## Archive', '', ARCHIVE_SUMMARY, '', body, '', '</details>'].join('\n');
    return `${remaining.join('\n')}\n\n${archive}\n`;
  } catch {
    return text;
  }
}

module.exports = {
  AUTO_MARKER,
  AUTO_HEADING,
  autoBlocks,
  stripAutoBlocks,
  pruneSuperseded,
  archiveOld,
};
