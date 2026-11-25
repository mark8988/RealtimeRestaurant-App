# Repository Guidelines

This repository contains a Flutter Android restaurant kiosk and a Node.js menu service with a Python speech provider. Read the root README for entry points, setup, and validation.

## Project Structure

Document the application entry points and the locations of source code, tests, and assets in the root README. When adding a module, follow the layout of the closest existing module and place its tests where the test runner discovers them.

## Build, Test, and Development

Once a checkout is available, use the commands defined by its build manifests, scripts, or CI configuration. Record the prerequisites and exact commands for installing dependencies, running locally, building, and testing. State the working directory for commands that run from a subdirectory.

## Coding Style and Naming

Use the project's formatter and linter once configured. Match nearby files for indentation, filename casing, and naming. Keep formatting changes scoped to the files you are already editing.

## Testing

Run the tests for the behavior you changed. Add regression coverage for bug fixes where the test suite can exercise the failure. Follow the existing test filenames and use test descriptions that state the expected behavior. Record any coverage threshold enforced by CI once it is available.

## Commits and Pull Requests

Check recent subjects with `git log -10 --format=%s` and follow the established pattern. Keep commits focused. In the pull request, summarize the change, list the checks you ran, and link the issue when applicable. Include a screenshot or short recording for visible changes.

## Agent Instructions

When the user invokes `/graphify`, read and follow the installed graphify skill before starting the requested work.

### Finishing Work

Work through verification before handing back. While awaiting a decision, continue independent work. Diagnose ordinary failures and try safe retries or alternate tools. Respect explicit restrictions and safety boundaries. If still blocked, explain the blocker and what remains.

### Approvals and Client Data

Get approval before deleting data, force-pushing, deploying to production, spending money, or sending or publishing anything outside this computer. Act on approval already given for that step. Reading files, running tests and read-only commands, editing project files, and safe retries require no additional approval within existing permissions. Never upload client source code, data, or documents to third-party services.

### Updates and Language

Start with a one-line update and share brief progress notes during work. End with a self-contained recap covering findings, completed work, and remaining steps. Put key points first. Use Traditional Chinese for reports and explanations unless the project is English-only. Preserve relevant root causes, exact errors, filenames, and numbers.

### Brain Workflow

When the user explicitly types `$brain`, read [the brain workflow](brain-codex/.agents/skills/brain/SKILL.md) and apply it from this project root. Use this project's available design documents and the user's acceptance criteria. Apply the phase rules only when this project has a phase plan.

Prefer the named native roles when registered. Otherwise read the corresponding role file under [the bundled agent definitions](brain-codex/.codex/agents/) and spawn a fresh subagent with its developer instructions, model, and reasoning effort when the host supports those settings. Use the bundled builder file for the high-effort retry. Report any requested model setting or independent review the host cannot provide.
