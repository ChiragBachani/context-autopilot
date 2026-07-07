---
name: context-autopilot
description: Mine this project's past agent sessions for repeated instructions, corrections, and rejected actions, then distill them into CLAUDE.md / AGENTS.md proposals the user approves. Use when the user asks to update project context/memory from history, wonders why they keep repeating themselves to the agent, or invokes /context-autopilot.
---

# Context Autopilot

Turn the user's real session history into durable agent context. The pipeline
mines `~/.claude/projects` transcripts for three kinds of evidence — repeated
instructions, corrections, and rejected tool calls — then distills them into
evidence-backed rules for the project's context files.

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

3. **Review with the user.** Present each proposal's rule, rationale, and
   evidence quotes. Ask which to accept — do not decide for them. The user's
   own words are the evidence; quote them.

4. **Apply** accepted proposals:

   ```bash
   npx -y context-autopilot apply --yes
   ```

   Only run with `--yes` after the user has explicitly approved specific
   proposals in step 3. If they approved a subset, instead run
   `npx -y context-autopilot apply` in an interactive terminal, or edit
   `.ctxlayer/proposals.json` statuses accordingly first.

Accepted rules land in a managed block (`<!-- ctxlayer:begin -->` …
`<!-- ctxlayer:end -->`) in CLAUDE.md and AGENTS.md — hand-written content is
never touched, and re-runs update the block idempotently.

## Notes

- Signals build up over time; a brand-new project may have nothing to distill.
- If the CLI reports no sessions for the project, run
  `npx -y context-autopilot projects` to list observable projects and pass one
  with `--project <path>`.
