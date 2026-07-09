# Good morning — here's what got built overnight ☀️

## Update 6 — Ask: talk to your activity, and hand off unfinished work

The header of the app now has an **Ask bar**: *"what was I trying to achieve this morning across my applications — did I solve it by the afternoon?"* It interprets the observed trail (not just stats), cites day+time, supports follow-ups, and — the good part — when it finds an unfinished goal it offers **🚀 Work on this**, which opens a Claude session preloaded with the goal and everything you already tried.

Verified on your real day: asked the benchmark question and it correctly inferred the "how should the daemon run persistently" design thread (from your Google search + return to Claude), judged it unresolved at that point, then on the follow-up traced the fix through your afternoon — reading your own messages off the screen — and correctly declined to offer a handoff because it was already solved. A synthetic handoff then ran the full loop: button → Terminal session → the work actually got done. Also fixed for real: model calls no longer freeze the daemon (async), proven by a fresh heartbeat throughout a 2-minute answer. 99 tests. `ctxlayer ask "…"` works from the terminal too.

---


## Update 5 — it's an app now, and automations actually run

Four big things landed on `ambient` (all tests green — 93; each phase its own commit):

- **Its own application.** Context Autopilot opens as a real macOS window (dock icon, ⌘W, remembers its size) — no browser, no tabs. The dashboard lives inside it. The menu-bar eye stays for at-a-glance state; "Open in browser" is still there if you want it. *One-time toll:* re-toggle Screen Recording for "Context Autopilot" once more (the bundle contents changed for the WebKit window; after this the content-stable builder keeps your grant).
- **Automations that RUN (Tier 1).** Every automation now executes for real in a visible Claude session — web workflows via `claude --chrome` so it drives the browser; desktop ones plain. Each run leaves a **receipt** the agent writes itself ("Sent the weekly summary…"), shown on the card with ✓/✗ and duration. And you can **schedule** them (day-of-week + time → a background job). Verified end-to-end: a test automation ran and wrote its own receipt.
- **A smarter brain (Tier 2).** A **weekly digest** (Sunday 6pm, or "Review my week") — verified live, it correctly called last week a "recovery week after a promotional push." **Time-aware triggers** so a workflow only offers when it actually recurs ("weekday mornings"). And **"not a pattern" now teaches** — dismiss a suggestion and lookalikes stop resurfacing, not just that exact title.
- **Deeper senses (Tier 4).** It now notices **file saves** (Desktop/Documents/Downloads → "saved invoice.pdf") and **clipboard copies** (searchable — "what did I copy earlier?"). Both are 100% local and obey the same blocklist: verified live that a copy made inside a blocklisted app is dropped. Clipboard is ON by default; toggle it in Controls.

Everything below is the earlier history.

---


**TL;DR:** Context Autopilot now has its Phase 3: **ambient screen observation.** It watches how you *work* (not just how you prompt), finds workflows you repeat across days, and offers to take them over. It's on a branch called `ambient` (a draft PR is open for you to review), and there's a **zero-permission demo you can run in 10 seconds** to see the whole thing work.

Everything is local. Nothing was published to npm, nothing was merged to `main`, the live site is untouched.

---

## Update — browser adapter added (and verified on your live Chrome)

Since the first build, one more layer landed on the `ambient` branch: **the browser adapter.** When the front app is a browser, the observer now reads the **active tab's real URL** alongside the screenshot. Why it matters:

- Web work is observed as precise addresses (`docs.google.com/spreadsheets`) instead of drifting window titles — so a repeated web workflow keeps matching across days even as counts, subjects, and doc ids change.
- The live take-over offer for a web workflow triggers on the **URL** ("you just opened `mail.google.com`"), not a fuzzy title — much more precise.
- The approved procedure carries the exact URL the agent should start at.

Privacy held to the same bar: **private/incognito tabs are never read**, and a URL that hits your blocklist (bank, login, …) is skipped *before* any capture. Verified live this morning — it read the active tab off your running Chrome correctly, and the full suite is now **56 tests, all green**.

---

## See it work right now (no permissions, 10 seconds)

```bash
cd "/Users/chiragbachani/Claude/Projects/The Context Layer"
node dist/cli.js observe --demo
```

This replays three synthetic Tuesday mornings through the **real** pipeline — real screenshots rendered natively, real on-device OCR reading the text back off them, real workflow mining, and a real distillation through your `claude` CLI. It ends by opening the dashboard and firing a real macOS notification. Then:

1. Go to the **Patterns** tab → you'll see "Weekly metrics report" with its evidence. Click **Approve**.
2. Go to **Automations** → it's now a saved automation with a step-by-step procedure.
3. Click **Run now** → a Claude Code session opens in Terminal, preloaded to actually do the workflow.

That's the entire loop: *observe → find a pattern → you approve → it takes over.*

---

## Update 2 — the codebase map (turns the tool on the agent itself)

You made a sharp point: when I have to "figure out how Run it works" by grepping the code, *that's* the problem Context Autopilot exists to kill — the MCP should already have that context so no one re-derives it. So I built it.

**`ctxlayer map`** mines your Claude Code transcripts for what agents actually navigate — the files they read/edit most across sessions, and the symbols they keep grepping ("how does X work?") — and distills a concise **architecture note** into a managed block in `CLAUDE.md` / `AGENTS.md`. Next session starts warm instead of cold-reading the repo.

I ran it on this very repo. From nothing but real navigation evidence + each file's header, it produced things like:
- *"Pipeline flow: SourceAdapter → Observation → buildSignals → distill → Proposal → propose.ts writes into CLAUDE.md."*
- *"engine.ts:getAdapters() is the single place new source adapters get registered."*
- *"cli.ts and mcp.ts are two front-ends over the same pipeline — keep new features usable from both."*

That's exactly the orientation I had to reconstruct by hand. It even flagged that `codemap.ts` was new and not yet in its own map — honest about its freshness.

**To write the map into this repo's context files yourself** (I deliberately didn't — seeding your repo's first CLAUDE.md is your call):
```bash
cd "/Users/chiragbachani/Claude/Projects/The Context Layer"
node dist/cli.js map --yes     # generates + writes CLAUDE.md + AGENTS.md; omit --yes to preview first
```

It's the same evidence-based, approve-first, staleness-checked philosophy as the rest of the product — and it's exposed over MCP too (`distill_codebase_map` → `apply_codebase_map`), so an agent can offer it in chat when you open an unfamiliar repo.

---

## Update 3 — it's a real app now (the seamless-intent pass)

You asked me to verify the intent — "open the application, it observes, within 5 hours it's useful" — is actually met. It wasn't, so I closed the gaps:

- **`/Applications/Context Autopilot.app` exists on your Mac right now.** Open it like any app (Spotlight → "Context Autopilot"): it starts the observer and puts the eye in your menu bar. No terminal. One macOS catch on first open: the app is a new identity to macOS, so grant it **Screen Recording + Accessibility** once (it opens the right Settings pane and notifies you), then click the menu bar eye → *Turn observation on*.
- **The menu bar toggle now actually starts the observer** if it's dead — before, it only flipped a config bit.
- **The first-win moment:** after ~3 hours of observed active work in a day, Autopilot generates your recap *unprompted* and notifies you. Usefulness announces itself.
- **Recaps persist** — the dashboard shows the last recap instantly (with its timestamp); the ✨ button regenerates.
- **Bonus bug the tests caught:** evening data (after 5pm Pacific) was being filed into *tomorrow's* UTC folder and vanishing from "today" — fixed, and tonight's misfiled records migrated back.

## Update 4 — the robustness pass (Activity tab, one-click automation, search, self-healing)

Your feedback: document actions even before they're patterns, with a button to automate them manually; and make the miner read everything. All built:

- **Activity tab** (localhost:4780/#activity): every episode of work, browsable by day — time range, app flow, URLs, what was on screen. **⚡ Automate this** on any episode: AI writes the procedure + trigger and it lands in Automations *enabled*, instantly. Verified on your real day: it turned your 130-minute research block into a 6-step automation (it noticed you googled "what is a daemon" and offered to spare you the search).
- **The miner now consumes ALL context** — dense activity log merged with OCR captures. There's a test proving a pattern surfaces from the activity log alone, with zero screenshots.
- **History search**: the box at the top of Activity (plus `ctxlayer search` and the `search_screen_history` MCP tool). Searched "daemon" live: found your exact Google search with the on-screen text.
- **Automations are fully yours now**: Edit, ＋ New automation (hand-written), Delete — all in the dashboard.
- **Self-healing**: if the observer dies while observation is on, the menu bar app revives it automatically (verified live: killed the daemon, back in 36s, no click). One macOS reality: revival spawned *by the app* needs the app's Screen Recording grant — one more reason to flip that toggle for "Context Autopilot".
- Tabs are deep-linkable now (`/#activity`, `/#autos`…).

## Turn it on for real (the actual product)

Three paste-able commands. After this, you never need the terminal again — the dashboard and notifications are the whole interface.

```bash
node dist/cli.js observe        # 1. starts observing + opens the dashboard
                                #    (it detects the ONE missing permission and
                                #     opens the exact System Settings toggle for you)
node dist/cli.js observe --install   # 2. (optional) run in the background at login
                                     #    + auto-mine your day for patterns at 9pm
node dist/cli.js off            # 3. the OFF switch, any time — instant + permanent
```

### The one permission you need to grant
Last night I checked: **Accessibility is already granted** to your terminal, but **Screen Recording is not** (that's expected — only you can grant it). When you run `observe`, it opens the right pane for you. Flip the toggle, **quit and reopen your terminal** (macOS requires the restart), and run `observe` again. That's the only setup click.

---

## What it does (and the promises it keeps)

- **Captures only at intentional moments** — the end of a burst of typing, dwelling on a window, or switching apps after real work. Never on a dumb timer.
- **Never watches what it shouldn't** — password managers and video-call apps (Zoom, Meet, Teams, FaceTime, Webex) are blocklisted out of the box, plus any window title with "bank", "login", "incognito", etc. Fully editable on the Controls tab.
- **No keylogging** — it only measures *seconds since your last input* (to detect a pause). It never reads keystrokes.
- **On-device OCR** — text is read off screenshots with Apple's Vision framework, on your Mac. Screenshots never leave the machine and auto-delete after 14 days (or instantly, in text-only mode).
- **You approve everything** — no workflow is ever automated until you click Approve. Rejected ones are remembered and never suggested again.
- **The OFF switch is real** — `ctxlayer off` or the big button on the Controls tab stops all capture instantly and survives restarts.

---

## The dashboard (localhost:4780)

- **Today** — live timeline of what was observed, with thumbnails and per-app time
- **Patterns** — detected workflows with evidence + Approve / Reject
- **Automations** — your approved AOPs, with Run now + enable/disable
- **Controls** — master OFF switch, pause, blocklist editor, delete-all-data, text-only mode

---

## Honest limitations (so nothing surprises you)

- **macOS only** for now (uses `screencapture`, Apple Vision, `osascript`).
- **"Run it" scope:** workflows an agent can do with files/code/terminal run fully. Browser-heavy workflows are now *observed* precisely (real URLs), but to *execute* them the agent still needs your Chrome extension connected to click around — the procedure and start URL are correct either way; v1 hands you a preloaded Claude session rather than fully driving Chrome unattended. Full hands-off browser execution is the next step.
- The live "offer to take over" fires on an app match plus a title *or URL* pattern; it's intentionally conservative (throttled, with a "don't ask again").

---

## For the record: what's on the branch

- New code under `src/ambient/` (observer, config, records, workflows, dashboard, demo, native Swift helper, **browser**) + `src/sources/screen.ts`
- **All 56 tests pass** (the original 19 untouched; 29 added for ambient, 8 for the browser adapter)
- README section + this file
- Version bumped to 0.6.0
- A **draft PR** is open on GitHub for you to review at your own pace. Nothing merges until you say so.

## If you want to keep going
- Review the PR, then `git checkout main` whenever you want to drop back.
- The natural next build: **browser execution** — wire the approved web AOPs to actually drive Chrome via the claude.ai extension, so "Run it" completes a web workflow unattended (observation of those workflows is already done).
