---
description: Show what to work on next — prioritized checklist picker with time estimates
allowed-tools: Read, AskUserQuestion
---

Read `.handoff/CHECKLIST.md` and help the user choose what to do next.

1. Summarize in one or two lines: how many items are open, roughly how much time they add up to, and
   whether anything is P0.

2. Call `AskUserQuestion` with `multiSelect: true`. Offer up to 4 open items, highest priority first
   — all P0 items before any P1, all P1 before any P2, and within a tier the quickest first. Label
   each option with its tier and estimate, e.g. `[P0 · 45m] Wire auth middleware`, and use the
   description to say what finishing it unblocks.

3. Start on whatever is selected, in the order listed.

If there are no open items, don't call the tool with an empty list — say the checklist is clear and
ask whether to add new work.
