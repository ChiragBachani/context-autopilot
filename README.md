# Context Autopilot

**Automated context collection for coding agents.** Mines your real agent sessions — every instruction you repeated, every correction you made, every tool call you rejected — and distills them into `CLAUDE.md` / `AGENTS.md` rules you approve.

Part of [The Context Layer](https://thecontextlayer.ai).

Run in your terminal (it's a plain CLI — don't paste this into a chat):

```
$ npx context-autopilot scan

Scanned 3 session(s) for ~/projects/my-app
Found 26 signal(s):

  [CORRECTION] ×2 across 2 session(s)  (score 9)
      "There are still so many buttons that dont work, like the publish…"
  [REPEATED] ×4 across 3 session(s)  (score 10)
      "Do not reference the legacy directory. Only work within…"

$ npx context-autopilot distill

[1/8] Perform click-and-type tests before reporting UI work complete  (confidence: high)
    + Before declaring any screen done, click every button and verify it works.
    evidence:
      · 2026-06-27 — "There are still so many buttons that dont work…"

$ npx context-autopilot apply
```

## Why

Every session starts blank, so you re-teach your agent the same conventions — and when you forget, it repeats the same mistakes. Hand-writing context files works but nobody keeps them current. And naive auto-generation is worse: [research on LLM-generated context files](https://todatabeyond.substack.com/p/do-agentsmdclaudemd-files-help-coding) found they *reduce* task success and raise cost, because repo scans produce generic filler.

Context Autopilot takes a third path: **evidence**. Your session history is a literal record of what the agent got wrong and what you said to fix it. Autopilot mines that record and only proposes rules your own words support — each one shipped with the quotes that justify it.

## How it works

1. **Observe** — `ctxlayer scan` parses your local Claude Code transcripts (`~/.claude/projects`) and Cursor sessions and extracts three signal types: instructions repeated across sessions, corrections after the agent went wrong, and rejected tool calls. Runs 100% locally.
2. **Distill** — `ctxlayer distill` sends the signals (not your history) through Claude — via your existing `claude` CLI, no API key needed — and gets back imperative, project-specific rules with evidence and confidence ratings.
3. **Approve** — `ctxlayer apply` walks you through each proposal. Accepted rules land in a managed block:

```markdown
<!-- ctxlayer:begin -->
## Learned conventions (Context Autopilot)

- **Staff login cannot access admin view** — When authenticated as staff, the admin role toggle must be hidden or disabled.
<!-- ctxlayer:end -->
```

Hand-written content is never touched; re-runs update the block idempotently. Rules are written to both `CLAUDE.md` and `AGENTS.md`, so Claude Code, Cursor, Copilot, Codex, and every AGENTS.md-aware agent benefits.

## Install

```bash
npm install -g context-autopilot   # or use npx, no install
```

### Commands

| Command | What it does |
|---------|--------------|
| `ctxlayer projects` | List projects with observable session history (Claude Code + Cursor) |
| `ctxlayer scan` | Mine signals from this project's sessions |
| `ctxlayer distill` | Distill signals into proposals (`.ctxlayer/proposals.json`) |
| `ctxlayer apply` | Review proposals interactively; write accepted ones |
| `ctxlayer check` | Fast, model-free: how many new signals since the last distill? `--hook` prints a nudge only past `--threshold` (default 3), else stays silent |
| `ctxlayer stale` | Find context-file references the repo has outgrown — missing files, removed npm scripts. Exits 1 on findings, so it drops straight into CI |
| `ctxlayer map` | Distill an architecture note from what agents keep looking up (files read/edited, symbols grepped) into a managed block in CLAUDE.md / AGENTS.md |
| `ctxlayer export` | Export distilled entries as Agent Operating Procedure JSON |

### Global mode

```bash
ctxlayer distill --global
```

Project context files hold repo conventions — but some feedback is about *you*: "explain things in plain English", "don't build while I'm brainstorming", "run independent work in parallel". Global mode mines **all** your projects across **all** your tools for exactly that, and maintains a managed block in your personal `~/.claude/CLAUDE.md`, so every future session in every project starts already knowing how you like to work. Rules that mention a specific project are excluded by design — those belong in the project's own context file.

Options: `--project <path>`, `--global`, `--source claude-code|cursor|all`, `--model <model>`, `--min-score <n>`, `--yes`, `--json`.

Cursor session mining reads Cursor's local SQLite storage via Node's built-in `node:sqlite` (Node 22+; on older Node the Cursor source is skipped gracefully).

### Codebase map

```bash
ctxlayer map
```

Every fresh session, an agent cold-reads your repo — the same files, the same "where does X live?" greps, over and over. That re-derivation is repeated work, and repeated work is exactly what Autopilot absorbs. `ctxlayer map` mines your Claude Code transcripts for what agents *actually navigate* — the files read and edited most across sessions, and the symbols repeatedly searched — and distills a concise architecture note (key files + "where things live") into a managed block in `CLAUDE.md` / `AGENTS.md`, so the next session starts warm.

It's evidence-based like everything else: roles are grounded in each file's real header, not guessed from its path; file accesses are attributed by where the file physically lives (so edits made from a parent-directory session still count); and the map's file references are picked up by `ctxlayer stale`, so it's flagged the moment a listed file moves. Nothing is written until you approve.

### Claude Code plugin

```
/plugin marketplace add chiragbachani/context-autopilot
/plugin install context-autopilot@the-context-layer
```

Then ask Claude to "update project context from my session history" — or don't ask at all: the plugin ships a **SessionStart hook** that runs `ctxlayer check` (fast, no model call) when a session begins. If enough new signals have accumulated since the last distillation, Claude gets a nudge to offer distillation at a natural pause — and if the repo has substantial agent navigation but no codebase map yet, it's nudged to offer `ctxlayer map` too. Nothing to surface → complete silence.

### MCP server

```json
{
  "mcpServers": {
    "context-autopilot": {
      "command": "npx",
      "args": ["-y", "-p", "context-autopilot", "ctxlayer-mcp"]
    }
  }
}
```

Exposes `list_observable_projects`, `scan_context_signals`, `distill_context_proposals`, `distill_global_context`, `apply_context_proposals`, `find_stale_context`, `distill_codebase_map`, and `apply_codebase_map` (plus the ambient tools `scan_ambient_activity`, `distill_workflow_proposals`, `approve_aop`).

The approval loop closes entirely inside chat: distill tools return each proposal with its evidence and instruct the agent to ask you which to accept; `apply_context_proposals` then writes **exactly** the titles you approved, remembers the ones you rejected (never re-proposed), and leaves the rest pending. No tool ever touches a context file without your explicit decision.

## Ambient observation (macOS) — agents that absorb your work

Coding transcripts are chapter one. `ctxlayer observe` is chapter two: it watches how you *work* — not just how you prompt — and turns repeated manual workflows into automations you approve.

```
$ ctxlayer app               # install /Applications/Context Autopilot.app — then just open it:
                             # observing starts, the eye appears in your menu bar, done.
$ ctxlayer observe --demo    # see the whole pipeline on synthetic data, zero permissions
$ ctxlayer observe           # terminal flavor of the same thing
$ ctxlayer observe --install # background at login (mining runs on its own as you work)
$ ctxlayer summary           # today at a glance: time per app, focus, cadence (--narrate for a recap)
```

**The first hours, unprompted:** the summary card fills in live; the Activity tab documents every episode (automate any of them with one click — no waiting for recurrence); patterns are mined every couple of hours (same-day repetition counts); and once ~3 hours of active work have been observed, Autopilot generates your day recap on its own and notifies you — you don't have to know where to look. The menu bar app **self-heals**: if the observer ever dies while observation is on, it's revived within seconds, no click. The only setup macOS requires is one Screen Recording + Accessibility grant on first launch (it opens the exact Settings pane for you).

```
```

How it works:

1. **Observe** — two streams. Screenshots at *intentional moments* only (settling on a new page or document, the end of a typing burst, dwelling on a window, a real context switch — never a timer, never during video calls or anything blocklisted). And a **dense activity log**: every tick records the foreground app/window/URL, whether you're active, and key/click **counts** — cadence only, never the keys themselves (the OS exposes just an integer tally) — folded into continuous work segments. Blocklisted apps and private/incognito tabs are never recorded in either stream.
2. **Parse** — every screenshot is OCR'd **on-device** with Apple Vision. Screenshots never leave your Mac; they auto-delete after 14 days (or instantly, in text-only mode). The activity log powers an instant **day summary** (time per app, top sites, focus, cadence) with an optional plain-English recap — so you can see it working before any workflow has recurred.
3. **Mine** — sequences of app/window steps that recur become workflow candidates: across days, or even twice within the same day, so results show up on day one. The miner consumes **all** context — the dense activity log merged with the OCR captures, never screenshots alone. Mining runs automatically every couple of hours — at moments you've stepped away, never mid-flow — with a nightly sweep as backstop. Web steps cluster by host + path (e.g. `docs.google.com/spreadsheets`), so a workflow keeps matching across days even as titles, counts, and doc ids change. And you never have to wait for recurrence: the **Activity tab** documents every episode of work as it happens, and **⚡ Automate this** on any episode turns that single occurrence into an automation instantly — your click is the approval.
4. **Surface** — candidates are distilled (via your own `claude` CLI) into Agent Operating Procedures — trigger, step-by-step procedure, evidence — and wait for your approval on the local dashboard at `http://localhost:4780`.
5. **Automate** — approve one, and the next time you *start* that workflow, a notification offers to take over: one click opens a Claude Code session preloaded with the procedure. For web workflows the trigger is the URL itself (e.g. "you just opened `mail.google.com`"), so the offer is precise; the procedure carries the exact address the agent should start at.

Context Autopilot runs as its **own macOS app** — a native window (via the menu-bar agent) rendering the local dashboard, no browser required. The dashboard (100% local) shows your day summary, a **weekly digest** with trends, a live timeline, the **Activity** tab (every episode of work, browsable by day, with one-click automation and **history search** — "when did I see that error?" / "what did I copy?" across everything ever observed: OCR text, titles, URLs, **filenames, and clipboard**; also `ctxlayer search` and the `search_screen_history` MCP tool), patterns awaiting review (with a **Mine now** button; dismissing one suppresses lookalikes too), your automations — mined, promoted from Activity, or **written and edited by hand** — and the controls: a master **OFF** switch (instant, persistent), pause, blocklists, clipboard toggle, and delete-everything.

**Ask it anything.** The bar at the top of the app answers intent-level questions about your own work — *"what was I trying to achieve this morning, and did I solve it by the afternoon?"* — by interpreting the observed trail (searches typed, errors on screen, files saved, app sequences), citing day + time, with follow-up memory. When the answer surfaces an unfinished goal, a **🚀 Work on this** button hands that goal — plus everything you already tried — to a live Claude session that picks up where you left off. Also `ctxlayer ask "…"`.

**Automations that run.** An approved automation executes for real in a visible Claude session — web workflows via `claude --chrome` to drive the browser, desktop workflows plain — and the agent writes a **receipt** of what it did. Automations can fire on a live **trigger** (app/URL, optionally scoped to a recurring time window), on a **schedule** (weekday + time), or on demand. Beyond the screen, the observer also senses **file saves** and **clipboard** copies — all local, all subject to the same blocklist (a copy inside a password manager is never recorded). A **menu bar icon** mirrors all of this in the top bar — green eye when observing, slashed when off, yellow when paused — and its menu toggles recording or opens the dashboard without a terminal. `ctxlayer off` does the same from the terminal.

## FAQ

**How is this different from Claude Code's `/insights`?**
`/insights` is the same core observation — instructions you repeat belong in CLAUDE.md — shipped as a personal usage *report*: an HTML page with suggestions you copy-paste by hand, Claude Code only. Context Autopilot is the pipeline version: it also mines **Cursor** history, attaches your **verbatim quotes as evidence** to every rule, runs an explicit **approve/reject** flow, writes accepted rules into **managed blocks** in both CLAUDE.md *and* AGENTS.md (so Codex/Copilot/Cursor benefit), maintains a **global cross-project rules file**, and adds a **CI staleness check**. Fully open source and local.

**How is this different from Claude Code's auto-memory?**
Auto-memory captures what the model notices *live, in the moment*, in one harness. Autopilot is retroactive and systematic: it mines months of existing history across tools, and finds cross-session patterns (you said it 6× in 4 sessions) that no single live session can see.

## Troubleshooting

- **"Skill not found" / agent can't see the tools** — MCP servers load at session start. After installing, start a **new** session (resumed/old sessions won't have the tools), and say "MCP tools" rather than a slash command: *"Using the context-autopilot MCP tools, distill this project's context proposals."*
- Everything else (evidence presentation, approval flow, error hints) is built into the server itself — the tool results tell the agent exactly what to show and when to ask you.

## Privacy

Everything runs on your machine. Transcripts are parsed locally; only the extracted signals (short quotes of your own instructions) are sent to the model you already use for coding. Nothing is uploaded anywhere else, ever. Ambient observation holds the same line: screenshots are OCR'd on-device and never leave your Mac, active-tab URLs are read locally (private/incognito tabs never, blocklisted pages never), and only the distilled workflow candidates — not your screens — are sent to your own `claude` CLI.

## Roadmap

Coding agents are chapter one. The engine is source-agnostic — it distills *observations of work* into Agent Operating Procedures (AOPs):

- **Now:** Claude Code + Cursor sessions → CLAUDE.md / AGENTS.md; global cross-project rules (`--global`); staleness detection (`ctxlayer stale`); **codebase map from agent navigation (`ctxlayer map`)**; **ambient screen observation → workflow AOPs with live take-over offers (macOS)** with active-tab URL enrichment
- **Next:** team-shared context; a GitHub Action for context linting in CI; browser-workflow execution (drive Chrome for approved web AOPs)
- **Later:** fully hands-off AOP execution — agents absorb the work you repeat, without you ever "building an agent"

## License

MIT © [The Context Layer](https://thecontextlayer.ai)
