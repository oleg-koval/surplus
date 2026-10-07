# Surplus implementation plan

## Goal

Use available included coding-assistant allowance before a weekly reset by selecting an opt-in stronger model or reasoning level for a new interactive session when the provider's observed weekly and five-hour windows have enough headroom.

## Product rules

- Provider telemetry is read locally and is never guessed from transcripts, tokens, plan names, or web APIs.
- Automatic selection requires a fresh weekly reading, a fresh five-hour reading, a known reset time, and provider confirmation that included usage is allowed.
- Promotion requires at least 25% weekly allowance remaining, at least 25% of the five-hour allowance remaining, a weekly reset within 48 hours, and room for the configured 5% reserve plus 5% expected-use budget.
- Hysteresis reduces rapid flip-flopping between launches. A new provider reset starts a new decision window.
- When telemetry or model support is ambiguous, Surplus leaves provider defaults alone.
- A user's CLI flags, config/profile overrides, billing path, and resumed or scripted sessions take precedence.
- The tool makes no model calls, changes no billing settings, and sends no usage telemetry.

## v0.1 scope

1. Claude Code: parse documented `statusLine` rate limits, chain an existing command statusline, hash account metadata without retaining raw identifiers, and default the premium choice to the documented `opus` alias.
2. Codex CLI: use the local app-server `account/read`, `account/rateLimits/read`, `config/read`, and paginated `model/list` protocol. Match reasoning support to the effective configured model. Do not use model migration recommendations as quality rankings.
3. Launch routing: shell wrappers intercept ordinary interactive `claude` and `codex` commands. Explicit choices, resume/background/cloud modes, and machine output bypass selection.
4. Safety: validated config, atomic private files, conservative fallbacks, reversible statusline/shell setup, and isolated-home installer coverage.
5. Adoption: GitHub-first installation, a self-contained sample-data explainer, no default telemetry, and a voluntary local launch counter.

## Delivery gates

- Unit tests cover reset boundaries, stale/missing inputs, both usage windows, reserve and hysteresis behavior, telemetry parsing, override preservation, and install/uninstall ownership.
- CI runs strict typecheck, lint, tests, and build on supported Node.js.
- `npm pack` installs into a clean fixture and starts the bundled CLI.
- Live protocol smoke reads Codex metadata only; no model turn is sent.
- Launch materials distinguish actual release/download/star evidence from targets and hypotheses.

## Deferred

Mid-session model switching, desktop-app interception, model-price optimization, paid-usage controls, telemetry uploads, provider billing changes, and automatic model ranking are out of scope. Model-specific quota guarantees are not available from the supported telemetry, so the app does not claim them.
