## Unreleased

### ✨ Features

* Claude launches routed to the premium model now add an estimated per-launch debit (`premiumLaunchDebitPercent`, default 1, 0 disables) to the cached weekly reading until the next statusline sample, limiting burst overshoot.

### 🐛 Bug Fixes

* `surplus forecast claude <N>` now explains that only a running Claude session's statusline saves a reading when none exists, instead of pointing at `surplus status claude`.

## [0.4.3](https://github.com/oleg-koval/surplus/compare/v0.4.2...v0.4.3) (2026-10-10)


### 📚 Documentation

* add FAQ and document the burst limit ([#16](https://github.com/oleg-koval/surplus/issues/16)) ([9e92aa7](https://github.com/oleg-koval/surplus/commit/9e92aa7f47221023af1c54150e90bc912a81b6e4))

## [0.4.2](https://github.com/oleg-koval/surplus/compare/v0.4.1...v0.4.2) (2026-10-09)


### 🐛 Bug Fixes

* Codex discovery, version flags, and silent automatic updates ([#14](https://github.com/oleg-koval/surplus/issues/14)) ([bbb4a73](https://github.com/oleg-koval/surplus/commit/bbb4a738b97d4547672a7ab0ec34748dae80de35))

## [0.4.1](https://github.com/oleg-koval/surplus/compare/v0.4.0...v0.4.1) (2026-10-09)


### 📚 Documentation

* add Surplus agent skill and guidance ([#13](https://github.com/oleg-koval/surplus/issues/13)) ([6a6cf3f](https://github.com/oleg-koval/surplus/commit/6a6cf3fdfa0f159aa59290230a48f3a295766d89))

# [0.4.0](https://github.com/oleg-koval/surplus/compare/v0.3.0...v0.4.0) (2026-10-09)


### ✨ Features

* add Hermes and Pi subscription routing ([#12](https://github.com/oleg-koval/surplus/issues/12)) ([b657953](https://github.com/oleg-koval/surplus/commit/b6579532e54e0e070eb6c6be81463a54e81abda3))

# [0.3.0](https://github.com/oleg-koval/surplus/compare/v0.2.0...v0.3.0) (2026-10-09)


### ✨ Features

* add reset-scoped workload forecasts ([#11](https://github.com/oleg-koval/surplus/issues/11)) ([caf75b1](https://github.com/oleg-koval/surplus/commit/caf75b155bd55f75a2dba3b0012eee5bfed3958a)), closes [#10](https://github.com/oleg-koval/surplus/issues/10)

# [0.2.0](https://github.com/oleg-koval/surplus/compare/v0.1.2...v0.2.0) (2026-10-08)


### ✨ Features

* pace-based routing and in-TUI notices ([#7](https://github.com/oleg-koval/surplus/issues/7)) ([#8](https://github.com/oleg-koval/surplus/issues/8)) ([cfb87d9](https://github.com/oleg-koval/surplus/commit/cfb87d9ef3e9a2cf66906ee28d3072f6cf103bcb))

# [0.2.0-beta.3](https://github.com/oleg-koval/surplus/compare/v0.2.0-beta.2...v0.2.0-beta.3) (2026-10-08)


### 🐛 Bug Fixes

* address PR [#7](https://github.com/oleg-koval/surplus/issues/7) review comments ([#9](https://github.com/oleg-koval/surplus/issues/9)) ([586e627](https://github.com/oleg-koval/surplus/commit/586e627694ca061e1a38cb900e1c36827567007a))

# [0.2.0-beta.2](https://github.com/oleg-koval/surplus/compare/v0.2.0-beta.1...v0.2.0-beta.2) (2026-10-08)


### 🐛 Bug Fixes

* reject invalid usage windows and malformed history samples ([763cff9](https://github.com/oleg-koval/surplus/commit/763cff90cbff1b8be4d197fb641b9332298fa15e))

# [0.2.0-beta.1](https://github.com/oleg-koval/surplus/compare/v0.1.2...v0.2.0-beta.1) (2026-10-08)


### ✨ Features

* pace-based routing and in-TUI notices ([#7](https://github.com/oleg-koval/surplus/issues/7)) ([56356db](https://github.com/oleg-koval/surplus/commit/56356db6f72b6bc6a7bdd68f3a247ac0a3e0fef4))

## [0.1.2](https://github.com/oleg-koval/surplus/compare/v0.1.1...v0.1.2) (2026-10-07)


### 🐛 Bug Fixes

* release complete uninstall cleanup ([2284d11](https://github.com/oleg-koval/surplus/commit/2284d112d3e88417a10721b0a79d89b8b682c59a))

## [0.1.1](https://github.com/oleg-koval/surplus/compare/v0.1.0...v0.1.1) (2026-10-07)


### ⚙️ Continuous Integrations

* publish to npm with trusted publishing ([bf7ad2c](https://github.com/oleg-koval/surplus/commit/bf7ad2c9cfa0f122de248d9d0121604f6c51d37f))
* publish to npm with trusted publishing ([54dfb1e](https://github.com/oleg-koval/surplus/commit/54dfb1ee6c3f2deb1489ac5e3302bd02c9362251))

# [0.1.0](https://github.com/oleg-koval/surplus/compare/v0.0.0...v0.1.0) (2026-10-07)


### ⚙️ Continuous Integrations

* release with semantic-release ([a464c02](https://github.com/oleg-koval/surplus/commit/a464c02d2bb4a7d42bdeb4e46d0fcb951fac89ea))
* release with semantic-release ([a49aa02](https://github.com/oleg-koval/surplus/commit/a49aa02d541e32dd1a9474c6282b5efb70842d93))


### ✨ Features

* add automatic Surplus model windows ([87edad6](https://github.com/oleg-koval/surplus/commit/87edad6839ed12356ea83776891079454f615d6d))
* **site:** redesign Surplus landing page ([2d436d2](https://github.com/oleg-koval/surplus/commit/2d436d25d8fdf16969cfc0be2aa2681e82e8fc35))


### 🐛 Bug Fixes

* preserve install state on capture failures ([3af5a02](https://github.com/oleg-koval/surplus/commit/3af5a02398bb1bfd47caffbdb431361487b21af2))
* tighten interactive routing and weekly-only Codex support ([6b0fba4](https://github.com/oleg-koval/surplus/commit/6b0fba41a0aeef8c147dfc12123735bdbf8a8e6a))


### 📚 Documentation

* add privacy-safe bug report template ([e7635d3](https://github.com/oleg-koval/surplus/commit/e7635d38a1da9acec9b0b7089ea600aeca08cbf8))
