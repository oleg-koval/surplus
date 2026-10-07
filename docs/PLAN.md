# Surplus implementation plan

## Goal

Use available included coding-assistant allowance before a weekly reset by selecting an opt-in stronger model or reasoning level for a new interactive session when the provider's observed weekly allowance has enough headroom.

## Product rules

- Provider telemetry is read locally and is never guessed from transcripts, tokens, plan names, or web APIs.
- Automatic selection requires fresh weekly data, a known reset time, and provider confirmation that included usage is allowed. A reported short window must also be fresh and valid; only Codex may omit it when the app-server reports exactly one weekly window.
- Promotion requires at least 25% weekly allowance remaining, a weekly reset within 48 hours, and room for the configured 5% reserve plus 5% expected-use budget. A reported five-hour window must have at least 25% remaining.
- Hysteresis reduces rapid flip-flopping between launches. A new provider reset starts a new decision window.
- When telemetry or model support is ambiguous, Surplus leaves provider defaults alone.
- A user's CLI flags, config/profile overrides, billing path, and resumed or scripted sessions take precedence.
- The tool makes no model calls, changes no billing settings, and sends no usage telemetry.

## v0.1 scope

1. Claude Code: parse documented `statusLine` rate limits, chain an existing command statusline, hash account metadata without retaining raw identifiers, and default the premium choice to the documented `opus` alias.
2. Codex CLI: use the local app-server `account/read`, `account/rateLimits/read`, `config/read`, and paginated `model/list` protocol. Match reasoning support to the effective configured model. Do not use model migration recommendations as quality rankings.
3. Launch routing: shell wrappers intercept ordinary interactive `claude` and `codex` commands. Explicit choices, resume/background/cloud modes, and machine output bypass selection.
4. Safety: validated config, atomic private files, conservative fallbacks, reversible statusline/shell setup, and isolated-home installer coverage.
5. Adoption: GitHub-first installation, a self-contained sample-data explainer, no default telemetry, and a local premium launch-attempt counter with voluntary reporting.

## Delivery gates

- Unit tests cover reset boundaries, stale/missing inputs, available and absent short-window data, reserve and hysteresis behavior, telemetry parsing, override preservation, and install/uninstall ownership.
- CI runs strict typecheck, lint, tests, and build on Node.js 22.21+ and 24.10+. POSIX provider launches use stable `process.execve` so the provider keeps the original PID and foreground process group; automatic model selection remains limited to fully interactive terminals.
- `npm pack` installs into a clean fixture and starts the bundled CLI.
- Live protocol smoke reads Codex metadata only; no model turn is sent. The verified Codex CLI baseline is 0.160.1; older clients missing required fields safely retain their normal settings.
- Launch materials distinguish actual release/download/star evidence from targets and hypotheses.

## Deferred

Mid-session model switching, desktop-app interception, model-price optimization, paid-usage controls, telemetry uploads, provider billing changes, and automatic model ranking are out of scope. Model-specific quota guarantees are not available from the supported telemetry, so the app does not claim them.
