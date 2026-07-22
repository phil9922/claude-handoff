---
description: Survey open work across every tracked project — one table of P0s, open items and time left
allowed-tools: Bash, Read
---

Give the user a single cross-project view of where open work stands. This is **read-only** — never
modify any project's files.

1. Read the registry of tracked projects. It lives outside any one project, at
   `<claudeHome>/handoff/projects.json` (where `claudeHome` honours `CLAUDE_CONFIG_DIR`, else
   `~/.claude`). Get it with exactly this one-liner, which prints the JSON array or `[]`:

   ```
   node -e "const p=require('path'),os=require('os');const h=process.env.CLAUDE_CONFIG_DIR||p.join(os.homedir(),'.claude');try{process.stdout.write(require('fs').readFileSync(p.join(h,'handoff','projects.json'),'utf8'))}catch{process.stdout.write('[]')}"
   ```

   Each entry is `{ root, name, lastSeen }`. If the array is empty, say there are no tracked projects
   yet and that a project appears here after its first session-start with tracking (`/handoff-init`
   to set one up). Stop there.

2. For each entry, read `<root>/.handoff/CHECKLIST.md`. Skip — silently — any entry whose file no
   longer exists (a project may have been moved or deleted since it was last seen). From each
   checklist, an **open item** is a line `- [ ] [<est>] <text>` (an unchecked box); a checked `[x]`
   is done and doesn't count. Items sit under tier headings `## P0`, `## P1`, `## P2`.
   - **Open P0 count**: unchecked items under the `## P0` heading.
   - **Total open items**: all unchecked items, any tier.
   - **Remaining estimate**: sum the bracketed estimates on the open items — `<n>m` is minutes,
     `<n>h` is hours — and show the total compactly (e.g. `90m`, `2.5h`).

   If `<root>/.handoff/config.json` exists it may rename the tiers (e.g. `{"tiers":{"P0":"Now"}}`);
   the canonical key is still P0, so count items under the renamed heading as P0.

3. Print one compact table, one row per project: **project name · open P0s · total open · time left**.
   Sort projects with open P0s first (most P0s first), then the rest by `lastSeen`, newest first.
   Below the table, add a one-line takeaway — e.g. which project has the most P0s, or that everything
   is clear. Keep it tight; this is a dashboard, not a report.
