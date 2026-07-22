---
description: Browse past sessions from the log — recent digest, a single day, or a keyword search
argument-hint: [date | keyword — empty for the recent digest]
allowed-tools: Read
---

Read `.handoff/LOG.md` and help the user look back over past sessions without opening the file by
hand. This is **read-only** — never modify `LOG.md`, whatever the argument.

If `.handoff/LOG.md` does not exist, this project isn't tracked yet. Say so in one line and suggest
`/handoff-init`. Stop there.

The log is newest-first `## YYYY-MM-DD` sections of markdown bullets. Days older than 90 days may be
folded into a trailing `## Archive` block wrapped in `<details>` — treat those as real sessions too.

Pick behavior from `$ARGUMENTS`:

**No argument** — summarize the most recent ~5 dated sessions. For each: the date, then a 1-2 line
digest of that day's bullets (the gist, not a reprint). Then note how many older sessions remain,
counting archived ones, without listing them — e.g. "12 earlier sessions (3 archived) not shown".

**A date** (`2026-07-03`, or a natural fragment like `july 3` or `last tuesday`) — resolve it to a
`## YYYY-MM-DD` heading and show that day's entries in full, verbatim. If nothing matches, say so and
name the nearest dated sessions on either side.

**A keyword** (anything not a date) — search every section, the Archive block included, and show the
matching bullets grouped by date, newest first, with the date as a heading above each group. Match
case-insensitively. If nothing matches, say so plainly rather than guessing.

Keep it tight — this is a lookup, not a report. Don't paste the whole file back.
