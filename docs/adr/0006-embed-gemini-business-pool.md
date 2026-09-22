# Embed the Gemini Business pool in-process

The bot optionally runs the vendored `gemini-business-api` pool inside its own
process, started before Discord connects and closed during shutdown, and makes it
selectable from `/model`. Running it in-process keeps lifecycle, logging, and
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

The same repair runs while the pool serves, for the same reason: upstream retires
a session well before its stored cookies look stale locally, so an account that
was healthy at startup can be rejected mid-run. A rejected session is reissued
for that account and the turn retried; a stored credential upstream refuses even
after that is replaced by a fresh sign-in, and the capture is persisted as
usual. Repairs never count toward `pool.error_threshold`, because an expiry that
one sign-in fixes must not remove an account from rotation, and a streaming turn
is only restarted while nothing has been forwarded — a half-written answer cannot
be replayed without duplicating it in the client. `sso.enabled: false` keeps its
meaning at runtime: the pool reports the rejected credential and the failure
rather than opening a browser.

A failure is charged to an account only when the account could plausibly answer
differently. Upstream also refuses a request that is itself unacceptable — most
visibly `PROMPT_TOO_LARGE`, once the flattened transcript outgrows the model's
window — and that refusal arrives as an ordinary 400 that a naive retry loop
cannot tell from a broken credential. Retrying it consumes the account's quota
for an answer that cannot change, and counting it toward `pool.error_threshold`
retires a healthy account over a defect in the caller's prompt: a long
conversation eventually disables every account in the pool, after which each turn
fails with an empty pool instead of reporting the real problem. Request-side
refusals are therefore typed apart from account-side failures. They are not
retried, not failed over, and not counted, and they leave rotation untouched so
later turns keep working; the pool answers them as a client error in the route
dialect, and spells the cause out in plain words, because the client decides
between "compact and continue" and "give up" by matching that wording rather than
the upstream wire code.

## Consequences

`proxy.yaml` starts the pool but never writes to the `/model` list: reaching the
pool requires a `claude.providers` entry in `config.yaml` that names its URL and
key, so there is exactly one readable source for what a channel can switch to and
no hidden provider whose endpoint lives in a second file. A running pool that no
provider points at is reported at startup, which keeps a missing entry from
silently dropping the pool from `/model`. The same entry shape also reaches a
pool running outside the bot, because the provider is defined by its URL rather
than by its origin.
