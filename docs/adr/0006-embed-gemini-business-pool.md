# Embed the Gemini Business pool in-process

The bot optionally runs the vendored `gemini-business-api` pool inside its own
process, started before Discord connects and closed during shutdown, and exposes
it as a `/model` provider. Running it in-process keeps lifecycle, logging, and
shutdown in one place: a separate child service would need its own supervision,
port management, and log plumbing for no isolation benefit, because the pool
already speaks HTTP and holds nothing the bot process does not. The pool's
configuration lives in `proxy.yaml` beside `config.yaml` and is held to the same
ownership, read-only, and no-hot-reload rules, so it remains trusted policy
outside an agent's authority; the sign-in secrets stay in the environment and are
removed from the Claude subprocess.

Startup refreshes accounts itself: it probes each account's stored cookies, and
only when they no longer work does it drive a headless browser sign-in through
the provider-specific automation. That ordering is what keeps the feature
unattended — a healthy bot never opens a browser, and an expired one repairs
itself instead of failing every turn — while `sso.enabled: false` and the
`npm run gemini -- login` command keep the deliberate, human-in-the-loop paths
available. Because captures cannot be written back to read-only trusted policy, accounts are
not configured in `proxy.yaml` at all: every captured account is persisted to
`gemini-accounts.json`, bot-owned runtime state beside `data.db`, which is the
single source of accounts for the pool.
