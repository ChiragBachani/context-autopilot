# Context Autopilot

**Automated context collection for coding agents.** Mines your real agent sessions — every instruction you repeated, every correction you made, every tool call you rejected — and distills them into `CLAUDE.md` / `AGENTS.md` rules you approve.

Part of [The Context Layer](https://thecontextlayer.ai).

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
| `ctxlayer stale` | Find context-file references the repo has outgrown — missing files, removed npm scripts. Exits 1 on findings, so it drops straight into CI |
| `ctxlayer export` | Export distilled entries as Agent Operating Procedure JSON |

Options: `--project <path>`, `--source claude-code|cursor|all`, `--model <model>`, `--min-score <n>`, `--yes`, `--json`.

Cursor session mining reads Cursor's local SQLite storage via Node's built-in `node:sqlite` (Node 22+; on older Node the Cursor source is skipped gracefully).

### Claude Code plugin

```
/plugin marketplace add chiragbachani/context-autopilot
/plugin install context-autopilot@the-context-layer
```

Then ask Claude to "update project context from my session history."

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

Exposes `list_observable_projects`, `scan_context_signals`, `distill_context_proposals`, and `find_stale_context`.

## Privacy

Everything runs on your machine. Transcripts are parsed locally; only the extracted signals (short quotes of your own instructions) are sent to the model you already use for coding. Nothing is uploaded anywhere else, ever.

## Roadmap

Coding agents are chapter one. The engine is source-agnostic — it distills *observations of work* into Agent Operating Procedures (AOPs):

- **Now:** Claude Code + Cursor sessions → CLAUDE.md / AGENTS.md; staleness detection (`ctxlayer stale`)
- **Next:** team-shared context; a GitHub Action for context linting in CI
- **Later:** browser-workflow observation → AOPs for web tasks; ambient capture — until agents absorb the work you repeat, without you ever "building an agent"

## License

MIT © [The Context Layer](https://thecontextlayer.ai)
