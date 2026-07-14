# The Context Layer — Ambient observer product (`ambient` branch)

Two products share this git repo but live in **separate folders on separate branches. Do not switch branches in either folder.**

| Folder | Branch | Product |
|---|---|---|
| `The Context Layer-ambient/` (this one) | `ambient` | **Ambient observer** — macOS screen observation → workflow AOPs. Unpublished; separate product from the npm package. |
| `The Context Layer/` | `main` | **Context Autopilot** — the published npm/MCP/plugin product. All releases happen there. |

## Critical: the live observer runs from THIS folder
`~/.ctxlayer/bin/start-observer.sh` launches `node <this folder>/dist/cli.js observe --agent` (menu bar app's restart uses the same script; backup at `start-observer.sh.bak`).
- **Never delete or move this folder**, never check out another branch here, and after changing `src/`, run `npm run build` — the observer runs from `dist/`, then restart via the menu bar or `sh ~/.ctxlayer/bin/start-observer.sh`.
- Observer state/data: `~/.ctxlayer/ambient/` (config.json, daemon.log, day folders, heartbeat, menubar.pid). Dashboard: http://localhost:4780. Swift helpers: `~/.ctxlayer/bin/` (ctxhelper OCR, ctxmenubar).
- Menu bar app bundle: `/Applications/Context Autopilot.app` (wraps ctxmenubar).

## Rules
- This branch may pull from `main` (shared engine fixes) but ambient code must never merge INTO `main`.
- Do not publish this branch to npm. **Version caution:** `main` already shipped **0.6.0** (chat-first + promote-to-global). The `ambient` branch's old "v0.6.0 prep" stamp is STALE — when ambient eventually versions, it must be **≥0.7.0**; never reuse a 0.6.x number.
- Privacy invariants (do not weaken without the user): capture is local-only, blocklisted apps/URLs skipped pre-capture, incognito never read, key/click COUNTS only — no keystroke content unless the user explicitly opts in later.

Full project history: the CommandFort project's memory directory (`project-context-layer.md`).
