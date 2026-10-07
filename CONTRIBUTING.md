# Contributing

1. Open an issue describing the provider behavior and the smallest reproducible case. Do not attach credentials, prompts, transcripts, account emails, or organization IDs.
2. Keep provider protocol handling separate from the pure policy. Unknown telemetry must lead to the provider's normal choice.
3. Add focused tests for changed behavior and run `npm run ci` plus `npm run build`.
4. Keep generated binaries, local usage state, and user configuration out of commits.

Provider protocol changes should link to official documentation or a versioned schema fixture. Do not add direct HTTP usage polling or hidden analytics.
