---
description: Set up handoff tracking in this project — creates .handoff/ with a real, prioritized checklist
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(git log:*), Bash(git status:*)
---

Set up session handoff tracking for this project.

**First, survey the project** enough to write a checklist that reflects reality, not boilerplate:
README and docs, package manifests and scripts, entrypoints, obvious gaps, `TODO`/`FIXME`/`XXX`
markers, failing or missing tests, and the last ~20 commits for direction. Keep this proportionate —
you're scoping work, not auditing.

**Then create three files in `.handoff/`:**

`HANDOFF.md` — Current focus, Blockers, Next step, Open questions. Fill in what's actually true now.

`LOG.md` — start with a `# Log` heading and today's `## YYYY-MM-DD` section noting that tracking
was set up. If git history shows meaningful recent work, summarize it as a prior entry.

`CHECKLIST.md` — the important one. Real, specific, actionable items sorted into exactly three tiers:

```
## P0 — Required to work
- [ ] [45m] Task the project is broken or incomplete without

## P1 — Good ideas
- [ ] [2h] Clear value, but nothing is blocked on it

## P2 — Extras
- [ ] [30m] Nice to have
```

Rules for items:
- The bracketed estimate is required — minutes (`45m`) or hours (`2h`, `1.5h`). Estimate your own
  time to do the work. If a task is too vague to estimate, it's too vague to list: split it.
- Be specific. "Add error handling to the webhook receiver" beats "improve error handling".
- Don't invent work to fill tiers. A project that runs fine can legitimately have an empty P0.

**Finally**, show the user the tier counts and total estimated time. Then offer two things, briefly:

- `/handoff-project` — a short interview capturing why the project exists and what must never break,
  so future sessions inherit the reasoning and not just the task list. Worth doing once, now.
- Starting on the top P0 item.

Don't dump the whole checklist back at them, and don't run the interview without being asked.
