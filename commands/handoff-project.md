---
description: Interview me to capture project memory — goals, constraints, and what must never break
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(git log:*), Bash(git remote:*), AskUserQuestion
---

Capture what this project is *for*, so future sessions resume knowing why the work matters — not
just what's next on the list. The output is `.handoff/PROJECT.md`.

If it already exists, this is an update: read it first, and ask only about what's missing, stale, or
contradicted by the code. Never re-ask something already answered there.

## 1. Look before you ask

Spend a moment on the codebase first — README, package manifests, entrypoints, deploy config,
recent commits, obvious integrations. The point is that your questions arrive **already informed**:
you should be proposing specific answers to confirm, not asking the user to describe their own
project from scratch. A question whose options you derived from their actual code is worth ten
generic ones.

## 2. Interview via AskUserQuestion

Ask through `AskUserQuestion` — tapping an option beats typing an essay. Batch up to 4 questions per
call; two calls is usually the whole interview. Every option must be a concrete, plausible answer
drawn from what you just read. "Other" is always available automatically, so never add it yourself.

Cover these, adapted to what you found — skip anything the code already answers unambiguously:

- **What it is and who uses it.** Internal tool, client deliverable, product, experiment? Who breaks
  if it goes down — you, a team, paying customers?
- **What must never break.** The invariants. Name the actual flows you found: lead delivery, OTP
  verification, payment capture, a cron that must not double-fire. `multiSelect: true` here.
- **Hard constraints.** Deploy target, runtime versions, budget or deadline, compliance, things that
  cannot be rewritten, deliberate technology choices to respect.
- **What "done" means for the current milestone.** Shipped to production? Demoed to a client?
  Passing a specific test? Be concrete enough that a future session can check it.

If an answer reveals something surprising or contradicts the code, ask one focused follow-up rather
than assuming — but keep the whole interview under about six questions. This is a conversation, not
a form.

## 3. Write `.handoff/PROJECT.md`

```markdown
# Project

## What this is
One or two sentences. Plain language, no marketing.

## Who it's for
Who uses it and who is hurt when it breaks.

## Must never break
- Invariant, and what failure looks like in practice

## Constraints
- Hard limits: deploy target, versions, deadlines, compliance, deliberate choices

## Definition of done
What "finished" means for the current milestone, concretely enough to verify.

## Decisions
- 2026-07-21 — Decision, and the reason behind it
```

Write only what the user actually told you or what the code plainly shows. Do not invent
constraints, and do not pad thin answers into prose — a short, true file beats a comprehensive
guess. Leave a section out entirely rather than filling it with placeholder text.

## 4. Confirm

Show the user the finished file's headings and one line each, and ask whether anything is wrong.
Getting this right matters more than getting it fast — every future session inherits it.
