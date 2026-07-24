# Claude Code Handoff

Session continuity for Claude Code. Every project gets a dated log of what was completed and a
prioritized checklist of what's left, with time estimates. Reopen the folder — in a terminal or in
Cursor — and Claude immediately shows where you left off and asks what to work on next.

Installs once, applies to every project. Linux and macOS.

## Install

```sh
git clone https://github.com/phil9922/claude-handoff.git
cd claude-handoff
node install.js          # or ./install.sh
```

Re-running is safe. Hooks from other tools are never touched, and `~/.claude/settings.json` is
backed up to `~/.claude/backups/` first.

```sh
node uninstall.js        # removes hooks + program files, keeps your .handoff/ notes
```

### Or install as a plugin

```
/plugin marketplace add phil9922/claude-handoff
/plugin install handoff@claude-handoff
```

One command, auto-updating, no clone. Two differences from the full install:

- Commands are namespaced by the plugin — `/handoff:handoff-next` instead of `/handoff-next`. The
  hooks notice which install they're running under and name the right form.
- Plugins can't set a statusline or touch your shell startup files, so the [statusline](#statusline)
  and the [bare-`claude` recap wrapper](#opening-on-the-recap) come only with the full install.
  Everything else — tracking, the recap, the picker, the crash fallback — works identically.

Plugin hooks invoke `node` from `PATH`. If your Node comes from a version manager and hooks can't
find it, use the full install, which bakes in the absolute path instead.

Use one install or the other, not both — otherwise every hook runs twice.

## How it works

Open a project with no tracking and Claude offers to set it up. Accept, and it surveys the codebase
and writes three files to `.handoff/` — added to `.git/info/exclude`, so they stay local without
touching your repo's `.gitignore`:

| File | What it holds |
| --- | --- |
| `HANDOFF.md` | Current focus, blockers, exact next step |
| `LOG.md` | What was completed, by date, newest first |
| `CHECKLIST.md` | What's left, tiered and estimated |
| `PROJECT.md` | Why the project exists and what must never break |
| `ACTIVE.md` | The plan for the item being worked right now |

**On session start** you get a recap of last session and a multi-select picker of what to do next,
highest priority first, each option showing its time estimate. If a task was left half-finished,
resuming it leads the picker — naming the exact step you stopped on, not just the task.

**Project memory** (`/handoff-project`) is a short interview, not a form: Claude reads the codebase
first, then asks a handful of informed questions — what this is, who it's for, what must never break,
what "done" means. The answers become `PROJECT.md`, injected into every session as standing
constraints, so future sessions inherit the *why* and not just the task list.

**Plans survive interruption** (`/handoff-plan`). Before starting a substantial item, Claude breaks
it into independently resumable steps in `ACTIVE.md` and ticks them as it goes. A context reset,
a closed laptop, or a week away resumes at "step 3 of 5 — next: …" instead of starting over.

**When you tick a checklist item**, the handoff updates itself — a log entry, a refreshed focus, and
`README.md`/`CLAUDE.md` only if the work actually changed what they document. It triggers on real
completed work rather than a timer, so it costs a turn only when something lands.

**Any time**, run `/handoff` to write it up now, or accept the `update the handoff` suggestion that
appears as ghost text in your prompt (→ then Enter).

**If a window is closed hard**, a deterministic fallback still records the files touched and the
working-tree diffstat, so a session is never lost entirely.

## The checklist format

Three tiers, and an estimate on every item. The hooks parse these lines, so the format matters:

```markdown
## P0 — Required to work
- [ ] [45m] Wire auth middleware to session store

## P1 — Good ideas
- [ ] [2h] Add retry/backoff to the webhook sender

## P2 — Extras
- [ ] [30m] Dark mode toggle
```

Estimates are minutes (`45m`) or hours (`2h`, `1.5h`). Anything that doesn't match is left alone —
add prose, notes and sub-bullets freely.

An item can optionally declare how to prove it's done, as a sub-bullet (`✓`, or `v:` / `verify:` if
the glyph is awkward to type):

```markdown
- [ ] [45m] Wire auth middleware to session store
  - ✓ login survives a server restart (integration test passes)
```

Ticking an item that declares a criterion triggers a verification gate: the handoff prompt demands
evidence it was checked this session, or the item gets un-ticked. `/handoff-plan` pins a criterion
on an item before breaking it into steps.

Teams that don't think in P0/P1/P2 can rename the tiers in `.handoff/config.json` — display only,
the file format is unchanged:

```json
{ "tiers": { "P0": "Now", "P1": "Soon", "P2": "Later" } }
```

In a git repository, completing an item also asks for an atomic commit of just that item's tracked
files — never the whole tree, never `.handoff/`. Two more `config.json` booleans control it:
`"commit": false` turns it off, `"review": true` adds a self-review of the diff against the item's
criterion before committing. Non-git projects skip all of this silently.

## Statusline

Installed alongside the hooks, showing the current model and what's outstanding here:

```
Opus 4.8 (1M context) │ 2 P0 · ~8.1h │ lead-router │ 14%
Opus 4.8 (1M context) │ ▸ 2/3 Add a --help flag │ lead-router │ 31%
```

Model, then outstanding work (or the resume point when a plan is in progress), then the directory
and context used. Projects without `.handoff/` just show model, directory and context. If you
already have a statusline, the installer leaves it alone and prints the command to switch by hand.

## Opening on the recap

A `SessionStart` hook can only add context — it can't make Claude speak first, so the recap sits in
context waiting for you to type something. Passing a first prompt on the command line does make
Claude speak first, in a session that stays interactive.

So the installer adds a `claude` shell function to `.bashrc` / `.zshrc`. Inside a tracked project,
a bare `claude` becomes `claude "Where did we leave off?"` and the session opens on the recap and
the picker. Anything with arguments — a prompt, `--continue`, `-p` — is passed straight through.

```sh
claude --raw ...              # run the real binary untouched
HANDOFF_NO_AUTOSTART=1        # disable it for a shell or a single command
HANDOFF_OPENING_PROMPT="..."  # use your own opening prompt
```

The startup file is backed up before it's touched, the block is fenced by
`# >>> claude-handoff >>>` markers so re-running can't stack duplicates, and `uninstall.js` takes it
back out. There's no equivalent for `/clear`, which can't launch a process — type `/handoff-next`
after clearing.

## Commands

| Command | Does |
| --- | --- |
| `/handoff` | Write the handoff now |
| `/handoff-next` | Re-show the prioritized picker |
| `/handoff-init` | Set up `.handoff/` in this project |
| `/handoff-project` | Interview you to capture project memory |
| `/handoff-plan` | Break an item into resumable steps |
| `/handoff-log` | Browse past sessions — recent digest, one day, or a keyword search |
| `/handoff-all` | Cross-project dashboard: open P0s and remaining estimate everywhere |

## Cost

The tracking, the session-start recap and the crash fallback are plain Node scripts and cost
nothing. The only paid work is one short turn when a checklist item is completed, and it's told to
use the recorded evidence rather than re-read your code.

## Hooks it installs

| Event | Script | Role |
| --- | --- | --- |
| `SessionStart` | `session-start.js` | Injects the recap and picker instructions |
| `PostToolUse` | `track.js` | Records edits; watches for ticked checklist items |
| `Stop` | `stop.js` | Asks Claude to write the handoff after a completion |
| `SessionEnd` | `session-end.js` | Deterministic fallback log entry |

## Notes

- Hook scripts are wired with an absolute path to the Node binary that ran the installer, since
  hooks run in a non-login shell where a version-manager `PATH` may be missing.
- The ghost-text suggestion works by appending one line to `~/.claude/history.jsonl`, an internal
  Claude Code file. The writer validates the format first, only ever appends, and never rewrites an
  existing line. If the format ever changes it stops writing and shows a plain reminder instead.
- Every hook is wrapped so a failure exits quietly — a bug here can't break your session.
- A hook only ever acts on the project named in the payload's `cwd`. A payload without one does
  nothing at all, rather than falling back to whatever directory the process happens to be in.
- Fallback log entries are placeholders. Once a real write-up lands in the same day's section, the
  next session start removes the placeholder — but a day whose only record is a fallback keeps it.
- LOG.md sections older than 90 days roll into a collapsed `## Archive` block at session start, so
  the recap stays cheap to parse no matter how long a project lives.
- Two sessions open in the same project are safe: `.state.json` writes merge instead of clobbering,
  so neither session loses the other's tracked edits.
- A `git worktree` checkout resolves to the main checkout's `.handoff/` instead of starting its own
  empty one. Submodules keep their own.
- `HANDOFF_DEBUG=1` surfaces hook errors on stderr.

## Tests

```sh
node test/run.js
```

Covers checklist parsing, completion detection, history seeding and its fallback, and every hook
end-to-end against a throwaway project.

## Support

Free and MIT-licensed. If it saves you time, [a coffee](https://ko-fi.com/phil9922) or a
[sponsorship](https://github.com/sponsors/phil9922) is appreciated — but never required, and the
tool will never nag you about it.

## License

[MIT](LICENSE)
