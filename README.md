# Surplus

**Saved allowance. Stronger settings.**

Surplus watches the included usage windows exposed by Claude Code and Codex CLI. When your usage pace says part of the weekly allowance would otherwise go unused, it can start a new interactive session with a model or reasoning level you choose, and it can tell you inside Claude Code and Codex when a premium window is open.

## Install

Requires POSIX Node.js 22.21+ or 24.10+, plus Claude Code and/or Codex CLI. POSIX wrappers use stable `process.execve` for provider launches, preserving the provider PID, terminal signals, and job control. Automatic model selection remains limited to fully interactive terminals. Windows integration is unsupported; shell installation supports zsh and bash.

Codex usage and model discovery were verified with Codex CLI 0.160.1 and its app-server protocol. Older Codex clients that do not expose the required protocol fields safely keep their normal settings.

```sh
npm install --global surplus-cli
surplus install
```

To install from source instead, build a package and install that. Do not use `npm install --global github:oleg-koval/surplus`: npm runs a git dependency's `prepare` step in global mode without dev dependencies, so the build fails with `tsup: command not found`.

```sh
git clone https://github.com/oleg-koval/surplus.git
cd surplus
npm ci
npm install --global "./$(npm pack --silent | tail -n 1)"
surplus install
```

Open a new terminal. Then use `claude` or `codex` as usual. Surplus installs small managed wrappers ahead of the original commands. It also chains Claude Code's existing command statusline so future usage readings are cached, and it adds a session-start hook to Claude Code and Codex (see [Notices](#notices-and-features)). Run `surplus uninstall` to restore the prior statusline and remove Surplus-owned shell entries, wrappers and hooks.

Surplus honors Claude Code's `CLAUDE_CONFIG_DIR` when reading or updating `settings.json`. Its statusline backup is bound to that exact settings path, so use the same `CLAUDE_CONFIG_DIR` value when uninstalling; Surplus refuses to restore a backup into a different profile.

For zsh, install uses the effective `$ZDOTDIR/.zshrc` (including a value assigned in `.zshenv`). Uninstall checks the current ZDOTDIR and HOME startup files; if you change ZDOTDIR after installing, set it to the original directory when uninstalling.

The first Claude session after install only seeds its local reading after Claude returns rate-limit data. Surplus needs that reading before it can make an automatic choice. Codex usage is read live from Codex's local app-server.

To install command wrappers without changing Claude's statusline, use `surplus install --no-claude-capture`. Claude automatic selection then remains unavailable until a captured sample exists. To skip the Claude Code and Codex hooks, use `surplus install --no-hooks`.

## What it does

At each new interactive launch, Surplus checks the provider's weekly window and actual reset time, telemetry age, included-usage availability, and your configured reserves. Claude and Codex sessions use the five-hour window when the provider reports it. Codex can use weekly-only data only when its app-server reports exactly one weekly window and explicitly confirms included usage is allowed. By default the policy is pace-based. It takes your average burn rate this week (and your last 24 hours, when Surplus has at least two hours of samples) and projects how much allowance would be left unused at the reset if premium usage burns faster (1.5x for Claude, 1.3x for Codex; these are assumptions you can change). It goes premium when the projection leaves at least the 5% reserve plus a 10% margin unused. The existing guards still apply: at least 25% weekly allowance left, the reserve plus expected usage budget covered, and, where a five-hour window is present, at least 25% remaining there. A 5% hysteresis band avoids flipping decisions between consecutive launches. In the first 24 hours of a window there is too little data, so Surplus uses the older rule: premium only during the final 48 hours of the weekly window. You can keep that older rule everywhere by setting `"strategy": "near-reset"` for a provider in the config file. Other pace knobs in the provider config are `premiumBurnMultiplier`, `paceMarginPercent` and `minPaceElapsedMinutes`.
You can reserve more allowance for a heavier remainder of the current week with a reset-scoped forecast. For example, `surplus forecast claude 20` tells Surplus to budget 20% expected usage before the current reset. Surplus takes the safer maximum of that forecast and the configured `expectedUsageUntilResetPercent` baseline, so a forecast cannot weaken the normal guard. Forecasts are local, provider-specific, and automatically ignored after the reset window changes; Surplus does not inspect prompts, repositories, or task text.

Claude's default premium target is `opus`; outside a premium window, Surplus passes the original command through unchanged, including your normal model choice. Codex keeps the model selected by the user's effective Codex config and raises reasoning effort to `high` only when Codex's live model catalog confirms that effort for that exact model. Set a specific Codex premium model once with `surplus configure codex --premium MODEL` if you want model selection as well.

Explicit model or effort flags, config/profile overrides, resumed sessions, background sessions, cloud sessions, noninteractive output, API-key or third-party Claude billing, and provider utility commands pass through unchanged. Surplus never edits the provider's model settings and never makes a model call to measure usage.

## Notices and features

Surplus can tell you about a premium window from inside the session, which also covers IDE and desktop sessions that did not start through the wrapper. Each feature has a setting:

| Setting | Default | What it does |
| --- | --- | --- |
| `--session-notice` | on | When a session starts, prints one `surplus:` line only if a premium window is open (with a `/model` hint, or `(active)` if the session is already on it) or if you are on pace to run out before the reset. Silent otherwise. |
| `--prompt-nudge` | off | On each prompt, speaks only when the state changed since it last told that session. It never switches the model for you. |
| `--statusline-segment` | off | Adds `⚡ opus 41% 1.8d` (premium open) and/or `⚠ pace` (on pace to run out) to the first line of the Claude Code statusline. |

```sh
surplus configure features --session-notice on --prompt-nudge on --statusline-segment on
```

Changing a setting re-syncs the hooks: Surplus adds its own entry to `hooks.SessionStart` / `hooks.UserPromptSubmit` in Claude Code's `settings.json` (honouring `CLAUDE_CONFIG_DIR`) and Codex's `$CODEX_HOME/hooks.json` (default `~/.codex/hooks.json`). Other hooks in those files are left as they are, and `surplus uninstall` removes only Surplus's entries. A hook never blocks a session: it exits 0 within about three seconds and prints nothing on any failure. The hook command stores the absolute `node` and Surplus paths at install time, so re-run `surplus install` after upgrading Node or moving Surplus.

Codex may ask you to review/trust the new hook on first start. Codex 0.160 labels new hooks "New hook - review required" and says hooks that need review cannot run until reviewed; Surplus does not write that trust entry for you.

## Commands

```sh
surplus status claude                 # latest captured sample and policy decision
surplus status codex                  # fresh read-only Codex usage and decision
surplus forecast claude 20            # reserve 20% expected usage until this reset
surplus forecast claude status        # inspect the saved forecast
surplus forecast claude clear         # remove the reset-scoped forecast
surplus configure claude --premium opus
surplus configure codex --premium MODEL --effort high
surplus configure features --session-notice on|off --prompt-nudge on|off --statusline-segment on|off
surplus demo                          # deterministic sample, no account access
surplus uninstall
```

Configuration lives in `${XDG_CONFIG_HOME:-~/.config}/surplus/config.json`. Local usage, a short usage history (current window only, at most 300 samples per provider), reset-scoped workload forecasts, per-session notice memory, account identity hashes, and policy state live under `${XDG_STATE_HOME:-~/.local/state}/surplus`. Files are private to your account. Surplus sends no analytics or usage events; Codex's app-server fetches usage metadata through its normal provider connection.

## Important limits

Provider usage windows are shared allowance signals, not a promise that a particular model has a separate premium bucket. Surplus only uses Claude's documented five-hour and seven-day subscription rate limits, or Codex's app-server windows and `ordinaryUsageAllowed` result. Missing, stale, malformed, or disallowed data selects the provider's normal defaults.

Surplus cannot prevent charges from paid-overage settings already enabled in a provider account. It does not change billing settings. Codex model discovery describes supported models and reasoning options; it does not reliably label which model is “premium,” so Surplus does not infer a model ranking. A configured premium model is your choice. If Codex does not report a valid weekly window or does not confirm included usage, Surplus keeps the normal settings. A present but malformed short window also disables automatic selection.

See [the implementation plan](docs/PLAN.md), [launch and measurement plan](docs/LAUNCH.md), [security notes](SECURITY.md), and [the interactive demo](docs/index.html).

## Contributing

```sh
npm ci
npm run ci
npm run build
```

Building and testing require Node.js 22.21+ or 24.10+. Please file bugs without credentials, transcripts, prompts, or account identifiers. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
