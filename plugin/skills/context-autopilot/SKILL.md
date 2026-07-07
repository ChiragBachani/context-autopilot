---
name: context-autopilot
description: Mine this project's past agent sessions for repeated instructions, corrections, and rejected actions, then distill them into CLAUDE.md / AGENTS.md proposals the user approves. Use when the user asks to update project context/memory from history, invokes /context-autopilot, OR proactively — when the user has corrected you more than once this session, when they repeat an instruction they've clearly given before, or when a session-start notice reports accumulated context signals.
---

# Context Autopilot

Turn the user's real session history into durable agent context. The pipeline
mines `~/.claude/projects` transcripts and Cursor sessions for three kinds of
evidence — repeated instructions, corrections, and rejected tool calls — then
distills them into evidence-backed rules for the project's context files.

## Proactive use

Don't wait to be asked. Offer to run this when:
- the user has corrected you **more than once** in the current session;
- the user repeats an instruction they have clearly given in past sessions;
- a session-start notice says new context signals have accumulated;
- a long working session is wrapping up.

Always **offer first** at a natural pause ("Want me to distill what I've been
getting wrong into CLAUDE.md so future sessions start with it?") — never
interrupt mid-task, and never apply anything without explicit approval.
A quick way to judge whether it's worth offering: `npx -y context-autopilot check`
(fast, no model call — reports how many signals are new since the last run).

## Workflow

1. **Scan** the current project for signals:

   ```bash
   npx -y context-autopilot scan
   ```

   Briefly summarize the signal kinds and counts for the user.

2. **Distill** signals into proposals (takes up to a minute; it runs a model):

   ```bash
   npx -y context-autopilot distill
   ```

   Proposals are saved to `.ctxlayer/proposals.json` in the project.
   Add `--global` to mine ALL projects for cross-project rules about how the
   user works (written to `~/.claude/CLAUDE.md` instead).

3. **Review with the user.** Present each proposal's rule, rationale, and
   evidence quotes. Ask which to accept — do not decide for them. The user's
   own words are the evidence; quote them.

4. **Apply exactly what they approved.** Edit `.ctxlayer/proposals.json`
   statuses to match their decisions (`accepted` / `rejected`), then run:

   ```bash
   npx -y context-autopilot apply --yes
   ```

   (`apply --yes` only writes proposals whose status is still pending by
   accepting them — so set rejected ones first. If the user approved
   everything, just run it directly.)

Accepted rules land in a managed block (`<!-- ctxlayer:begin -->` …
`<!-- ctxlayer:end -->`) in CLAUDE.md and AGENTS.md — hand-written content is
never touched, and re-runs update the block idempotently. Rejected proposals
are remembered and never re-proposed.

## Notes

- Signals build up over time; a brand-new project may have nothing to distill.
- If the CLI reports no sessions for the project, run
  `npx -y context-autopilot projects` to list observable projects and pass one
  with `--project <path>`.
