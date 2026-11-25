---
name: brain
description: "Orchestrate a substantial project task with a dedicated builder, independent checker, and batch worker. Use only when explicitly invoked as $brain."
---

# Brain

Use the user's prompt as the brief. The main agent owns planning, architecture, root-cause analysis, integration, and the final decision. The intended main model is GPT-6.2 Astra at high reasoning effort. Choose it in the client before invoking this skill. In the CLI, launch with `codex -m gpt-6.2-astra -c 'model_reasoning_effort="high"'`. The skill uses the current session's model.

## Plan and delegate

1. Read the applicable `AGENTS.md`, `ARCHITECTURE.md`, and the phase specification under `cc-workspace/docs/specs/`. Identify the deliverable and acceptance criteria from the user's brief and relevant project documents. Start with a short plan that names the parts, their owners, and the execution order.
2. Use the native Codex subagent tool to spawn the custom roles below by name. Start each with fresh context when supported. Give each a self-contained brief with its goal, exact files, allowed edits, acceptance criteria, relevant spec sections, and expected evidence. Ask for concise reports and file references.
3. Delegate independent work, bounded implementation too large for one session, or repetitive work with easy-to-check output. Handle short, dependent work yourself. Treat Phase 0–6 as a dependency chain and assign at most one builder to a phase at a time. Never assign overlapping file edits. Check the current diff before handing off files. Share a one-line progress update every few steps.
4. If the builder fails the same part twice, diagnose the failure, then retry once with GPT-6.2 Astra at high effort if the host supports explicit spawn settings. Use the default agent role for this retry and include the builder instructions from `.codex/agents/brain-builder.toml` in its brief, because the custom role pins medium effort. If the retry fails or the host cannot start it at high effort, finish that part yourself.

| Custom role | Assignment |
| --- | --- |
| `brain_builder` | Implement the agreed scope and report edits and checks. |
| `brain_checker` | Independently review the result and run safe validation. Leave source and tracked files untouched. |
| `brain_batch_worker` | Process batches of non-code items with an explicit output format. |

## Verify before completion

After integration, spawn `brain_checker` with the original goal, phase acceptance criteria, affected files, and the completed diff or its Git reference. Resolve actionable findings and ask the checker to verify affected checks again. Flag any device, environment, or user-dependent validation that remains. If the checker role cannot run, continue with local validation and report that independent review remains pending. Close with the outcome, checks run, and any genuine blockers.

## Approvals

Follow the applicable repository and session permission rules. Get the user's approval before deleting data, force-pushing, or modifying anything outside this project. Reading files, running safe tests, editing in-scope project files, starting the named subagents for this workflow, and safely retrying commands need no additional confirmation within existing permissions.
