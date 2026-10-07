# Surplus

**Saved allowance. Stronger settings.**

Surplus watches the included usage windows exposed by Claude Code and Codex CLI. Near a weekly reset, it can start a new interactive session with a model or reasoning level you choose when fresh allowance data confirms enough weekly headroom.

## Install

Requires Node.js 20.10 or newer, plus Claude Code and/or Codex CLI.

Codex usage and model discovery were verified with Codex CLI 0.160.1 and its app-server protocol. Older Codex clients that do not expose the required protocol fields safely keep their normal settings.

```sh
npm install --global https://github.com/oleg-koval/surplus/releases/download/v0.1.0/surplus-cli-0.1.0.tgz
surplus install
```

For a source install before the v0.1.0 release is published, use `npm install --global github:oleg-koval/surplus`.

Open a new terminal. Then use `claude` or `codex` as usual. Surplus installs small managed wrappers ahead of the original commands. It also chains Claude Code's existing command statusline so future usage readings are cached. Run `surplus uninstall` to restore the prior statusline and remove Surplus-owned shell entries and wrappers.

The first Claude session after install only seeds its local reading after Claude returns rate-limit data. Surplus needs that reading before it can make an automatic choice. Codex usage is read live from Codex's local app-server.

To install command wrappers without changing Claude's statusline, use `surplus install --no-claude-capture`. Claude automatic selection then remains unavailable until a captured sample exists.

## What it does

At each new interactive launch, Surplus checks the provider's weekly window and actual reset time, telemetry age, included-usage availability, and your configured reserves. Claude and Codex sessions use the five-hour window when the provider reports it. Codex can use weekly-only data only when its app-server reports exactly one weekly window and explicitly confirms included usage is allowed. The default policy considers a premium launch only during the final 48 hours of the weekly window, with at least 25% weekly allowance left and the configured reserve plus expected usage budget still covered; where a five-hour window is present, it also requires at least 25% remaining. A 5% hysteresis band avoids flipping decisions between consecutive launches.

Claude's default premium target is `opus`; outside a premium window, Surplus passes the original command through unchanged, including your normal model choice. Codex keeps the model selected by the user's effective Codex config and raises reasoning effort to `high` only when Codex's live model catalog confirms that effort for that exact model. Set a specific Codex premium model once with `surplus configure codex --premium MODEL` if you want model selection as well.

Explicit model or effort flags, config/profile overrides, resumed sessions, background sessions, cloud sessions, noninteractive output, API-key or third-party Claude billing, and provider utility commands pass through unchanged. Surplus never edits the provider's model settings and never makes a model call to measure usage.

## Commands

```sh
surplus status claude                 # latest captured sample and policy decision
surplus status codex                  # fresh read-only Codex usage and decision
surplus configure claude --premium opus
surplus configure codex --premium MODEL --effort high
surplus demo                          # deterministic sample, no account access
surplus uninstall
```

Configuration lives in `${XDG_CONFIG_HOME:-~/.config}/surplus/config.json`. Local usage, account identity hashes, policy state, and a premium-launch count live under `${XDG_STATE_HOME:-~/.local/state}/surplus`. Files are private to your account. Surplus sends no analytics or usage events; Codex's app-server fetches usage metadata through its normal provider connection.

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

Building and testing require Node.js 20.19 or newer. The packaged CLI runtime supports Node.js 20.10 or newer. Please file bugs without credentials, transcripts, prompts, or account identifiers. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
