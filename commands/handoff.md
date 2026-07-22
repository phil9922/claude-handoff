---
description: Write the session handoff now — update the log, checklist and current focus
allowed-tools: Read, Edit, Write, Bash(git status:*), Bash(git diff:*), Bash(git log:*)
---

Update the handoff files for this project. This is bookkeeping — keep it fast and small, and do not
re-explore the codebase to compile it. Use what is already in context plus `.handoff/.state.json`,
which lists the files touched and commands run this session.

If `.handoff/` does not exist, run `/handoff-init` instead.

1. **`.handoff/LOG.md`** — add or extend today's `## YYYY-MM-DD` section at the TOP of the file.
   One bullet per thing actually finished since the last entry: what changed, why, and which files.
   Concrete and past tense. If nothing was completed, say so in one line rather than padding it.

2. **`.handoff/HANDOFF.md`** — rewrite Current focus, Blockers, Next step and Open questions so a
   fresh session could pick up cold with no other context. Delete whatever is no longer true.

3. **`.handoff/CHECKLIST.md`** — tick off anything now done, add anything the work surfaced, and
   re-tier or re-estimate items whose scope changed. Keep the exact format:

   ```
   ## P0 — Required to work
   - [ ] [45m] Task description
   ```

   Tiers are P0 (project is broken or incomplete without it), P1 (clear value, not blocking),
   P2 (nice to have). Estimates are your own time to complete: `45m`, `2h`, `1.5h`.

4. **`.handoff/ACTIVE.md`** — if a plan is in progress, tick the steps actually finished so the
   resume point is accurate. If every step is done, tick the parent item in `CHECKLIST.md` and delete
   `ACTIVE.md`, carrying anything worth keeping from its Notes into the log.

5. **`.handoff/PROJECT.md`** — only if this session produced a real decision or revealed a new hard
   constraint. Append one dated line to Decisions. Don't restate the task list here; this file is the
   *why*, and it should change rarely.

6. **`README.md` / `CLAUDE.md`** — only if this work changed what they document: setup, commands,
   dependencies, architecture, env vars, or public behavior. Skip them for internal refactors and
   bugfixes. Never create them if they don't already exist.

Finish with a one-line summary of what you recorded. Do not paste the files back.
