---
name: surplus
description: Use the Surplus CLI to inspect included subscription usage, configure user-chosen premium routing, or troubleshoot Surplus for Claude Code, Codex, Hermes, and Pi. Use when the request concerns Surplus itself, not generic provider model selection.
---

# Surplus

Surplus chooses a user-configured model or effort for a new interactive session only when the relevant subscription usage window supports it. It leaves the original client settings in place when quota data is missing, stale, invalid, or below the routing threshold. It does not change billing settings or guarantee that paid overage is disabled.

## Choose the task

- For a status check, use `surplus status claude|codex|hermes|pi`. Codex status fetches usage and may save its snapshot and history locally for later routing; it does not change provider settings. `surplus demo` shows a deterministic example without account access. Report the decision, remaining allowance, reset time, and any unavailable data as shown; do not infer a zero balance from missing data.
- For a user-requested premium target, ask for a model only if the user has not supplied one. Do not infer which model is "premium" from its name. Use the exact choice with `surplus configure claude --premium MODEL`, `surplus configure codex --premium MODEL --effort LEVEL`, or `surplus configure hermes --premium MODEL --effort LEVEL`. The effort flag is optional.
- For Pi, configure Claude and Codex independently with `surplus configure pi --source claude|codex --premium MODEL [--effort LEVEL]`. Pi must use OAuth for that provider and the same account as the corresponding Claude Code or Codex CLI quota reader. If that match cannot be established, explain the assumption instead of claiming verified account identity.
- For a user-requested allowance reserve, use `surplus forecast claude|codex PERCENT` or `surplus forecast claude|codex status|clear`. The forecast is scoped to the current reset window.

## Install or diagnose

For a fresh installation, follow the [README installation flow](https://github.com/oleg-koval/surplus#install): check its supported Node versions, install the CLI with `npm install --global surplus-cli` (or use its source-package flow), then run `surplus install`. Check the installed package version with `surplus --version` or `surplus -v`. The installer changes shell startup files and adds managed wrappers and hooks; Claude statusline capture is enabled by default. Run it when the user asks to install or enable Surplus, and explain the affected files before acting. `surplus uninstall` removes Surplus-owned entries.

Automatic routing applies only to fresh, fully interactive launches. Explicit model or effort choices, config or profile overrides, resumed, background or cloud sessions, noninteractive launches, API-key or third-party Claude billing, and utility commands retain the original client behavior. Hermes uses its own `hermes usage --json` subscription view; Pi uses the matching Claude or Codex quota reader. A Pi project `.pi/settings.json` also makes routing pass through because it can override the selected provider. For an otherwise eligible Hermes or Pi launch that passes through unexpectedly, inspect `surplus status hermes|pi` and retry with `SURPLUS_DEBUG=1` for a concise diagnostic. Do not print credentials, account identifiers, prompts, or transcripts.

For implementation work in the Surplus repository, follow [CONTRIBUTING.md](https://github.com/oleg-koval/surplus/blob/main/CONTRIBUTING.md) and verify behavior against the current code. This skill describes operating the CLI; it is not a substitute for code review.
