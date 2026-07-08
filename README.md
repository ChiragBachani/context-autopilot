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
| `ctxlayer export` | Export distilled entries as Agent Operating Procedure JSON |

### Global mode

```bash
ctxlayer distill --global
```

Project context files hold repo conventions — but some feedback is about *you*: "explain things in plain English", "don't build while I'm brainstorming", "run independent work in parallel". Global mode mines **all** your projects across **all** your tools for exactly that, and maintains a managed block in your personal `~/.claude/CLAUDE.md`, so every future session in every project starts already knowing how you like to work. Rules that mention a specific project are excluded by design — those belong in the project's own context file.

Options: `--project <path>`, `--global`, `--source claude-code|cursor|all`, `--model <model>`, `--min-score <n>`, `--yes`, `--json`.

Cursor session mining reads Cursor's local SQLite storage via Node's built-in `node:sqlite` (Node 22+; on older Node the Cursor source is skipped gracefully).

### Claude Code plugin

```
/plugin marketplace add chiragbachani/context-autopilot
/plugin install context-autopilot@the-context-layer
```

Then ask Claude to "update project context from my session history" — or don't ask at all: the plugin ships a **SessionStart hook** that runs `ctxlayer check` (fast, no model call) when a session begins. If enough new signals have accumulated since the last distillation, Claude gets a nudge to offer distillation at a natural pause. No new signals → complete silence.

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

Exposes `list_observable_projects`, `scan_context_signals`, `distill_context_proposals`, `distill_global_context`, `apply_context_proposals`, and `find_stale_context`.

The approval loop closes entirely inside chat: distill tools return each proposal with its evidence and instruct the agent to ask you which to accept; `apply_context_proposals` then writes **exactly** the titles you approved, remembers the ones you rejected (never re-proposed), and leaves the rest pending. No tool ever touches a context file without your explicit decision.

## Ambient observation (macOS) — agents that absorb your work

Coding transcripts are chapter one. `ctxlayer observe` is chapter two: it watches how you *work* — not just how you prompt — and turns repeated manual workflows into automations you approve.

```
$ ctxlayer observe --demo    # see the whole pipeline on synthetic data, zero permissions
$ ctxlayer observe           # the real thing (walks you through the two macOS permission toggles)
$ ctxlayer observe --install # background at login + nightly pattern mining
```

How it works:

1. **Observe** — captures the screen at *intentional moments* only: the end of a burst of activity, dwelling on one window, switching context after real work. Never on a timer, never during video calls or anything blocklisted, and input activity is measured only as idle-time — no keylogging, ever. When the front app is a browser, it also reads the **active tab's URL** so web work is observed as precise domains, not fuzzy window titles (private/incognito tabs are never read, and a URL that trips the blocklist is skipped before any capture).
2. **Parse** — every capture is OCR'd **on-device** with Apple Vision. Screenshots never leave your Mac; they auto-delete after 14 days (or instantly, in text-only mode).
3. **Mine** — sequences of app/window steps that recur across days become workflow candidates. Web steps cluster by host + path (e.g. `docs.google.com/spreadsheets`), so a workflow keeps matching across days even as titles, counts, and doc ids change.
4. **Surface** — candidates are distilled (via your own `claude` CLI) into Agent Operating Procedures — trigger, step-by-step procedure, evidence — and wait for your approval on the local dashboard at `http://localhost:4780`.
5. **Automate** — approve one, and the next time you *start* that workflow, a notification offers to take over: one click opens a Claude Code session preloaded with the procedure. For web workflows the trigger is the URL itself (e.g. "you just opened `mail.google.com`"), so the offer is precise; the procedure carries the exact address the agent should start at.

The dashboard (100% local, served from the observer itself) shows a live timeline of what was observed, patterns awaiting review, your automations, and the controls: a master **OFF** switch (instant, persistent), pause, blocklists, and delete-everything. `ctxlayer off` does the same from the terminal.

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

- **Now:** Claude Code + Cursor sessions → CLAUDE.md / AGENTS.md; global cross-project rules (`--global`); staleness detection (`ctxlayer stale`); **ambient screen observation → workflow AOPs with live take-over offers (macOS)**
- **Next:** team-shared context; a GitHub Action for context linting in CI; browser-workflow adapter
- **Later:** fully hands-off AOP execution — agents absorb the work you repeat, without you ever "building an agent"

## License

MIT © [The Context Layer](https://thecontextlayer.ai)
