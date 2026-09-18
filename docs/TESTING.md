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
| `src/utils/config.test.ts` | 26 | Environment/YAML schema (including the optional `claude` provider section and retired `CLAUDE_MODEL`), trusted filesystem validation, and load-once lifecycle | Pure parsing + filesystem metadata mocks |
| `src/db/database.test.ts` | 4 | Conversation-chain and message-mapping CRUD | In-memory SQLite via `better-sqlite3` constructor mock |
| `src/db/channel-providers.test.ts` | 4 | Per-channel `/model` provider override file, entry replacement, corrupt-file recovery | Real temporary directories |
| `src/scheduler/parser.test.ts` | 8 | Markdown/YAML parsing, cron, channels, time zones, IDs, serialization | Pure parsing with Croner validation |
| `src/scheduler/service.test.ts` | 7 | Schedule CRUD, collisions, invalid edits, duplicate names, channel validation, next-run enumeration, concurrency | Real temporary directories |
| `src/bot/commands/schedules.test.ts` | 2 | Empty, valid, and invalid `/schedules` rendering | Mock scheduler statuses |
| `src/bot/commands/model.test.ts` | 6 | Registered `/model` provider choices and set/show/stale/reset replies | Mock config and channel provider store |
| `src/claude/providers.test.ts` | 7 | Provider resolution order and subprocess environment mapping, including OAuth-preserving blanks | Pure functions, no child process |
| `src/observability/telemetry.test.ts` | 4 | Attribute bounds, secret removal, trace propagation, and lifecycle export | OpenTelemetry span exporter and SDK mocks |
| `src/email/tools.test.ts` | 7 | Admin-only exposure, EWS NTLM setup, read operations, untrusted-result labels, and secret redaction | Fake EWS service and reader; no network |
| **Total** | **117** | | |

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

### config (26 tests)

- Required environment values and defaults
- Optional all-or-none Exchange variables, HTTPS enforcement, and email validation
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

## Adding New Tests

1. Create `<module>.test.ts` next to the source file
2. Import from the source using `.js` extension (ESM convention)
3. Mock external dependencies (`vi.mock()`) — avoid mocking the module under test
4. Run `npm test` to verify
