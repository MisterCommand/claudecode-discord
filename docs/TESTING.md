# Testing Guide

## Overview

This project uses [Vitest](https://vitest.dev/) v2 as the test runner. All tests are co-located with source files (`*.test.ts`).

## Running Tests

```bash
npm test              # Run all tests once
npm run test:watch    # Run in watch mode (re-runs on file changes)
npx tsc --noEmit      # Type check only (no build output)
```

## Test Structure

| Test File | Tests | Target Module | Strategy |
|---|---|---|---|
| `src/claude/output-formatter.test.ts` | 20 | Message splitting, code block fence handling, result embeds, Stop/completion buttons | No mocking — pure logic + discord.js constructors work natively |
| `src/security/guard.test.ts` | 12 | Sliding-window rate limiting and BASE_PROJECT_DIR path validation | Mock `getConfig()`, `vi.spyOn(fs)`, `vi.useFakeTimers()` |
| `src/security/access-policy.test.ts` | 10 | Exact profile selection, denylist composition, GitHub repository protection, audit records | Pure policy evaluation + stderr spy |
| `src/utils/config.test.ts` | 28 | Environment/YAML schema (including the optional `claude` provider section, the Gemini Business sign-in variables, and retired `CLAUDE_MODEL`), trusted filesystem validation, and load-once lifecycle | Pure parsing + filesystem metadata mocks |
| `src/db/database.test.ts` | 4 | Conversation-chain and message-mapping CRUD | In-memory SQLite via `better-sqlite3` constructor mock |
| `src/db/channel-providers.test.ts` | 4 | Per-channel `/model` provider override file, entry replacement, corrupt-file recovery | Real temporary directories |
| `src/scheduler/parser.test.ts` | 8 | Markdown/YAML parsing, cron, channels, time zones, IDs, serialization | Pure parsing with Croner validation |
| `src/scheduler/service.test.ts` | 7 | Schedule CRUD, collisions, invalid edits, duplicate names, channel validation, next-run enumeration, concurrency | Real temporary directories |
| `src/bot/commands/schedules.test.ts` | 2 | Empty, valid, and invalid `/schedules` rendering | Mock scheduler statuses |
| `src/bot/commands/model.test.ts` | 6 | Registered `/model` provider choices and set/show/stale/reset replies | Mock config and channel provider store |
| `src/claude/providers.test.ts` | 7 | Provider resolution order and subprocess environment mapping, including OAuth-preserving blanks | Pure functions, no child process |
| `src/observability/telemetry.test.ts` | 4 | Attribute bounds, secret removal, trace propagation, and lifecycle export | OpenTelemetry span exporter and SDK mocks |
| `src/email/tools.test.ts` | 7 | Admin-only exposure, EWS NTLM setup, read operations, untrusted-result labels, and secret redaction | Fake EWS service and reader; no network |
| `src/gemini-business/*.test.ts` | 139 | Vendored pool plus integration glue: Anthropic/OpenAI translation, streaming tool-call emulation, incremental JSON reading, rotation and session-expiry recovery, HTTP routes, `proxy.yaml` schema, startup sign-in policy, account capture store, and container-aware browser launch | Pure functions, injected sign-in deps and upstream client, mocked filesystem/browser discovery, and a real server on an ephemeral port |
| `src/utils/proxy-integration.test.ts` | 9 | Startup wiring: pool left disabled without `proxy.yaml`, the `/model` list left to `config.yaml` with it, the unwired-pool warning and its URL matching, and fatal errors for an invalid or unreadable file | Mocked trusted config directory, fresh module per scenario |
| **Total** | **267** | | |

## What Each Test Covers

### output-formatter (20 tests)

- **formatStreamChunk**: Truncation at 1900 chars, empty string handling
- **splitMessage**: Newline-based splitting, forced split for long lines, code block fence preservation (with/without language specifier), multiple code blocks
- **createResultEmbed**: Cost display toggle, duration formatting, description truncation
- **createStopButton / createCompletedButton**: CustomId format, disabled state

### guard (12 tests)

- **checkRateLimit**: Within-limit requests, over-limit blocking, 60s window reset, per-user independence
- **validateProjectPath**: Path traversal (`..`) blocking before fs calls, BASE_PROJECT_DIR scope enforcement, non-existent path, non-directory path, valid directory

### access-policy (10 tests)

- Exact channel/thread ID classification with no inheritance
- Global plus Restricted-only denylist composition and hidden `AskUserQuestion`
- Case-insensitive direct target matching across owner/repo, URL, `.git`, paired fields, and `repo:` qualifiers
- Admin bypass, unscoped and incidental searches, route scoping, and unknown-schema fail-open behavior
- Minimal JSON audit records without unrelated tool input

### config (28 tests)

- Required environment values and defaults
- Optional all-or-none Exchange variables, HTTPS enforcement, and email validation
- Optional all-or-none Gemini Business sign-in credentials, base32 TOTP validation, and trimming of `GEMINI_SSO_PROVIDER`/`CHROME_PATH`
- Strict version 1 YAML, required arrays, unknown/duplicate keys, quoted Discord IDs, and unique values
- Repository and Claude tool-rule syntax
- Default, empty, trimmed, and normalized `claude` provider sections plus rejected provider identifiers, base URLs, effort levels, duplicates, and defaults
- Refusal of the retired `CLAUDE_MODEL` variable
- Read-only directory/file enforcement, non-owner POSIX checks, symlink/junction rejection, and `BASE_PROJECT_DIR` separation
- Docker read-only mount detection
- Required-file failure and load-once/no-hot-reload behavior

### database (4 tests)

- Conversation-chain creation, status/session updates, deletion tombstones, and Discord message mappings

### provider selection, /model, and subprocess environment (17 tests)

- Missing, corrupt, partially invalid, and rewritten `channel-providers.json` content
- Resolution order: stored override, then `claude.default_provider`, then the first provider, ignoring a stored provider that is no longer configured
- `/model` registered choices and set/show/stale-override/reset reply text
- Provider credentials and tunables mapped to the subprocess environment, with blanks keeping `claude login` and the inherited `CLAUDE_CODE_*` values

### scheduler (18 tests)

- YAML front matter, five-field cron and IANA time-zone validation, safe schedule IDs, and serialization
- File-backed CRUD, case-insensitive name collisions, invalid direct edits, disabled timers, and next-run enumeration

### Exchange email (7 tests)

- Complete credential resolution and credential environment removal
- Admin-only MCP exposure for configured mailboxes
- NTLM authentication and exact-mailbox routing configuration
- Newest-first Inbox listing and plain-text message binding without attachment downloads
- Untrusted mailbox-content labels and secret redaction in tool errors

## Embedded Gemini Business pool (139 tests)

- Anthropic Messages API ↔ OpenAI chat-completion translation, including system prompts, images, tool use, and tool results
- Anthropic SSE block sequences for text-then-tool turns and text-only turns
- Prompt-space tool-call emulation: fenced and `<tool_call>` blocks, split chunks, forced/parallel choices, history replay, and refusal to call undeclared tools
- Incremental JSON-array reading at arbitrary chunk sizes, plus upstream failures embedded in HTTP 200 bodies
- Streaming chunks split mid tool call, SSE-framed deployments, and thought-reply filtering
- Account rotation, disabled-account skipping, the error threshold, and per-account session caching
- Session-expiry recovery: the expired-session pattern matching the messages the real client produces (and not a quota skip or a rate limit), a rejected session reissued without opening a browser, a dead cookie repaired by a sign-in that replaces the stored capture, a repaired expiry staying out of the account's error count, repairs bounded per turn, per-account retry and failover to a healthy account, streaming that restarts only while nothing was emitted, and an unrecoverably rejected credential reported with the re-login command
- HTTP routes: auth by `x-api-key`/`Bearer`, Anthropic streaming frames, `[DONE]` termination, 400/401/500 dialects, and unknown paths
- `proxy.yaml` schema: the required `workspace_id`, documented defaults, a mandatory API key, a rejected `accounts` section, and `sso.team_id` staying out of scope
- Chrome discovery order (explicit path, `CHROME_PATH`, detected installation) and the descriptive failure
- Container detection driving the `--no-sandbox`/`--disable-dev-shm-usage` flags, and that a desktop host keeps its sandbox
- Startup sign-in policy: healthy cookies never open a browser, a rejected credential signs in and persists, `sso.enabled: false` and missing credentials never open one, a first account is captured when none exists, and a failed sign-in is reported without taking the bot down
- Captured-account persistence: replacement by name, structural rejection of a malformed capture, and corrupt-file recovery
- Workspace binding: a capture from another workspace is never probed or served, is re-captured against the configured workspace, and a same-workspace stale account stays in rotation
- Secret redaction in sign-in failures
- Runtime recovery over the real HTTP route: an expiry mid-run re-authenticates and rewrites the store entry, and a pool with sign-in disabled reports the setting instead of opening a browser

## Embedded pool startup wiring (9 tests)

- The pool stays disabled and the `/model` list stays at the `config.yaml` default without `proxy.yaml`
- `proxy.yaml` starts the pool and exposes it on `config.geminiBusiness` while leaving the `/model` list untouched
- A pool provider declared in `config.yaml` reaches `config.claude` exactly as written
- The unwired-pool warning names the pool URL and the provider value, stays silent once a provider reaches that URL, treats a loopback spelling as reaching it, and warns about another port
- Invalid and unreadable `proxy.yaml` remain fatal instead of silently skipping the pool

## Adding New Tests

1. Create `<module>.test.ts` next to the source file
2. Import from the source using `.js` extension (ESM convention)
3. Mock external dependencies (`vi.mock()`) — avoid mocking the module under test
4. Run `npm test` to verify
