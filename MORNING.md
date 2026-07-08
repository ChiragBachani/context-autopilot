# Good morning — here's what got built overnight ☀️

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
