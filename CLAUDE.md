# The Context Layer — MCP/CLI product (`main` branch)

Two products share this git repo but live in **separate folders on separate branches. Do not switch branches in either folder.**

| Folder | Branch | Product |
|---|---|---|
| `The Context Layer/` (this one) | `main` | **Context Autopilot** — the published npm package: CLI + MCP server + Claude Code plugin. Mines Claude Code/Cursor session history → CLAUDE.md/AGENTS.md rules with evidence. |
| `The Context Layer-ambient/` | `ambient` | **Ambient observer** — unpublished macOS screen-observation product (menu bar app, dashboard :4780, workflow AOPs). |

## Rules for this folder
- Stays on `main`. Releases (npm publish, MCP Registry, GitHub releases, the thecontextlayer.ai site in `site/` — Vercel auto-deploys from `main`) all happen here.
- **Never check out `ambient` here** — and never delete `The Context Layer-ambient/`: the user's live screen observer runs from that folder's `dist/` (launched by `~/.ctxlayer/bin/start-observer.sh`, restartable from the "Context Autopilot" menu bar app). Breaking it silently kills the observer (bug hit on 2026-07-13).
- Ambient-only code (`src/ambient/`, screen source) must not be merged into `main` — the products are deliberately separate.

## Release checklist (this product)
1. Bump version in `package.json`, `server.json` (both fields), `manifest.json`.
2. `npm run build && npm test` → commit → push (site auto-deploys).
3. User runs `npm publish` (needs their browser auth; stale-token 404/E404 → `npm login` first).
4. `mcp-publisher publish` for the registry (GitHub device-code login; namespace is case-sensitive: `io.github.ChiragBachani/...` must match npm's `mcpName` exactly).
5. `npx -y @anthropic-ai/mcpb pack . context-autopilot-<v>.mcpb` → `gh release create v<v> <file>` → site download button href in `site/index.html`.

Launch copy/drafts live in gitignored `launch/`. Full project history: the CommandFort project's memory directory (`project-context-layer.md`).
