# Security policy

Report security issues privately through GitHub's repository security advisory feature.

Surplus reads usage through supported local provider interfaces. It does not read or copy provider tokens, request secrets, send telemetry, alter billing, or start background services. Local configuration and state are written with owner-only permissions when the platform supports them. Account metadata used to bind cached Claude usage is stored only as a SHA-256 hash.

Installer and uninstaller changes are limited to Surplus-owned shell markers, wrapper files, and its exact Claude statusline command. If a user edits an owned file after installation, uninstall leaves that edit in place.
