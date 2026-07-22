---
description: Break a checklist item into steps before starting it, so progress survives a context reset
argument-hint: [task text or checklist item]
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(git log:*), AskUserQuestion
---

Turn one checklist item into a plan you can be interrupted in the middle of. The output is
`.handoff/ACTIVE.md`, which holds the plan for the **one** item currently being worked.

Target item: `$ARGUMENTS` — if empty, read `.handoff/CHECKLIST.md` and use the highest-priority open
item (P0 before P1 before P2, and within a tier the order written in the file is the priority).

If `ACTIVE.md` already exists and is unfinished, do NOT overwrite it. Say what's in progress and ask
whether to resume it, park it, or abandon it.

## 1. Understand the item first

Read enough of the codebase to plan concretely: the files it touches, existing patterns to follow,
and anything that makes it harder than it looks. Also read `.handoff/PROJECT.md` if present — a plan
that violates a stated invariant is a bad plan no matter how elegant.

## 2. Ask about approach when it genuinely matters

If there's a real fork — two defensible designs with different trade-offs — put it to the user with
`AskUserQuestion` before planning: name each approach, what it costs, and what it rules out. Lead
with your recommendation.

If there's an obvious right way, don't manufacture a choice. Say which way you're going and move on.

## 3. Pin a success criterion on the item

Before planning the steps, decide how you'll *know* the item is done — one checkable
outcome, not "it works". A passing integration test, a command whose output flips, an
observable behavior. If `CHECKLIST.md` doesn't already give this item a criterion, add
it as a `- ✓` sub-bullet directly under the item (leave an existing one alone):

```markdown
- [ ] [2h] Wire auth middleware to session store
  - ✓ login survives a server restart (integration test passes)
```

The `✓` marker also accepts `v:` or `verify:` if you can't type the glyph. This is what
the Stop hook will hold the tick to: when the item is checked off, it demands the
evidence that this criterion was actually met this session, so make it something you can
genuinely verify. If the item truly has no checkable outcome, say so instead of inventing
a hollow one.

## 4. Write `.handoff/ACTIVE.md`

```markdown
# Active: <the checklist item text, verbatim>

Item: <the checklist item text, verbatim>
Started: YYYY-MM-DD
Approach: <one line — the chosen approach, or "direct" if there was no fork>

## Steps
- [ ] [30m] First step
- [ ] [45m] Second step

## Notes
- Anything learned mid-task that the next session would need
```

Rules for steps:
- Same format as the checklist: `- [ ] [30m] text`. The estimate is required.
- Each step should be **independently resumable**. "Wire the parser into session-start" is a step;
  "work on the parser" is not. If a step can't be picked up cold by someone reading only its text,
  rewrite it.
- Three to seven steps. Fewer means the item didn't need a plan; more means it should be split into
  separate checklist items instead.
- The estimates should roughly add up to the parent item's estimate. If they don't, the original
  estimate was wrong — say so, and update `CHECKLIST.md`.

## 5. Work the plan

Tick each step in `ACTIVE.md` as you finish it, immediately — that tick *is* the resume point, and an
untick step you actually finished is worse than no plan. Add to Notes when you learn something the
next session would otherwise rediscover.

When every step is ticked: tick the item in `CHECKLIST.md`, delete `ACTIVE.md`, and the handoff
update fires automatically from there.
