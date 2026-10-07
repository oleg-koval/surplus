# Surplus launch

Launch runbook. Do not announce availability until the release download and installation have been verified. Verified publication outcomes belong in the [GitHub release notes](https://github.com/oleg-koval/surplus/releases), so this plan does not present preparation as completed distribution.

## Positioning

Saved allowance. Stronger settings.

Surplus is for Claude Code and Codex CLI subscribers who finish a usage week with spare allowance. It checks reported headroom before a new terminal session and applies stronger settings when reset is close. Install once, then keep using your usual commands.

The difference from a usage dashboard is the action: Surplus changes the next session's settings. It does not create allowance, change a subscription, or make requests just to spend capacity.

## Release gates

1. Verify policy, provider protocol, override handling, install preservation, and uninstall in isolated homes.
2. Verify a built package from a clean temporary installation. Test ordinary commands through the installed shell integration, including fallback without telemetry.
3. Open a feature PR, run Codex review against its exact head, verify findings, and resolve addressed threads. Passing CI alone is insufficient. Merge and verify the merge before tagging a release.
4. Upload the built package to the GitHub release and verify the public download and installation command. Publish the interactive example as GitHub Pages if available.
5. Publish one announcement per authenticated personal developer account, starting with X and LinkedIn. Record the actual URLs below. Do not use unrelated company accounts, unsolicited DMs, paid promotion, or manufactured engagement.

The first release is a preview. State exactly which terminal clients and operating systems were tested. Describe Codex's default behavior as higher supported reasoning effort if automatic premium model ranking is unavailable. Do not advertise desktop coverage, switching during an active session, a guaranteed reserve, or guaranteed savings.

## Proof and share loop

- Link to the runnable release, the policy source, and an interactive example clearly labeled as simulated data.
- Show the transition from normal to surplus mode as reset approaches, then show fallback when headroom is low or data is missing.
- Invite users to open a compatibility issue or share their first successful upgrade. Never request auth files, full transcripts, credentials, or private project names.
- A GitHub star is an optional way to follow releases. Installation and features never depend on starring or sharing.

## Announcement variants

Use these only after checking their claims against the released version. Replace the installation link with the actual release URL. Avoid unsupported claims about cost or precise token balances.

### X: primary

Saving your Claude/Codex allowance all week, then leaving it unused at reset?

I built Surplus: automatic stronger settings for new CLI sessions when spare allowance meets a near-reset policy.

Local-first. Open source.

https://github.com/oleg-koval/surplus

### X: implementation follow-up

Surplus makes the decision locally. No LLM call to decide whether you can afford an LLM call.

Fresh usage + reset time + headroom → stronger settings for the next session.

Missing data? Keep the client's normal settings.

https://github.com/oleg-koval/surplus

### LinkedIn

You spend the start of the week conserving your AI coding allowance. Then reset approaches and a large chunk is still unused.

That was the idea behind Surplus, an open-source tool for Claude Code and Codex CLI.

After a one-time setup, it checks usage before new terminal sessions. When reset is close and the configured headroom is available, it selects stronger settings. Otherwise, it leaves the client's normal settings in place.

The first release focuses on new CLI sessions. It respects explicit launch choices, falls back when usage data is unavailable, and doesn't enable paid overage or buy credits. Its reserve is a routing threshold, not a hard spending cap for a running session.

I'm looking for feedback on the install experience and compatibility across subscription plans.

Try it, report friction, or star the repo to follow releases:
https://github.com/oleg-koval/surplus

### Bluesky

Built Surplus for Claude Code and Codex CLI: spare weekly allowance + an approaching reset can automatically mean stronger settings for your next session.

One-time setup, local decisions, conservative fallback. Preview release:
https://github.com/oleg-koval/surplus

### Reddit: community-specific draft

Title: I built a local tool that uses spare weekly allowance for stronger CLI sessions

I wanted an automatic way to use stronger settings near reset after conserving allowance earlier in the week. Surplus checks reported usage and reset times, then chooses settings for a new Claude Code or Codex CLI session.

It's an MIT-licensed preview. The README lists the supported integrations and limitations. It doesn't switch an active conversation or enforce a hard spending cap. I'd particularly appreciate reports about setup friction or missing usage fields on different plans.

Source and installation: https://github.com/oleg-koval/surplus

Check the specific community's current self-promotion and bot rules before posting. Do not cross-post identical text across communities or post without an appropriate existing account.

## Other channels

Hacker News explicitly prohibits automated posting and generated submission/comment text. The founder must write and submit their own text and be available to discuss the implementation. Do not paste a generated Show HN submission. Read https://news.ycombinator.com/newsguidelines.html and https://news.ycombinator.com/showhn.html first.

Product Hunt and Dev.to are later experiments once real activation feedback exists. Do not create accounts, accept platform terms, or invent testimonials to fill a launch page.

For opt-in creator outreach, prioritize people who already discuss subscription usage management and CLI workflows. Respond to direct interest with the README and a specific answer. No scraped contact lists or unsolicited mass messages.

## Metrics and response plan

These are experiment targets, not forecasts or claimed traction:

| Window | Question | Evidence | Initial target |
| --- | --- | --- | --- |
| Launch day | Can people install it? | Installation issues and voluntary first-run reports | Resolve reproducible installation failures |
| Seven days | Does the idea attract the right users? | GitHub stars, release asset downloads, substantive feedback | 50 stars; 20 voluntary activation reports |
| Next reset | Do people keep using it? | Voluntary reports of a second successful surplus window | Learn why users keep or remove it |

Activation means a genuine session launched with Surplus-selected settings, not running the simulated demo. A share event is a voluntary public link. Conversion means installation followed by activation. Retention means returning for a later reset period.

Release downloads are not unique users. Stars are not active usage. No background user analytics are implied by these metrics. Collect only public repository metrics and voluntary feedback unless a separate explicit opt-in analytics feature is introduced.

On launch day, read issues and replies after publication and fix verified problems. At 24 hours, prioritize installation failures over adding features. Review results seven days after the actual publication timestamp, then again after another reset cycle. Do not auto-post replies or fabricate answers to feedback.

## Publication record

Record the reviewed PR and merged head, downloadable package, live demo, actual social post URLs, publication timestamp, and seven-day review date in the corresponding GitHub release notes. Keep unsuccessful or unavailable channels explicitly separate from published ones.

The npm registry package `surplus-cli` is the distribution path. Releases are cut by semantic-release (`.releaserc.yml`, extending `semantic-release-npm-github-publish`) from conventional commits: every push to `main` publishes a stable version, every push to `beta` publishes a `beta` prerelease. The workflow runs CI and the package smoke test, a release dry run, then publishes to npm with provenance, creates the GitHub release, and commits `CHANGELOG.md` and the version bump. Verify `npm view surplus-cli version` and a clean `npm install --global surplus-cli` before announcing.
