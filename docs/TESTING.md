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
| `src/utils/config.test.ts` | 17 | Environment/YAML schema, trusted filesystem validation, and load-once lifecycle | Pure parsing + filesystem metadata mocks |
| `src/db/database.test.ts` | 4 | Conversation-chain and message-mapping CRUD | In-memory SQLite via `better-sqlite3` constructor mock |
| `src/scheduler/parser.test.ts` | 8 | Markdown/YAML parsing, cron, channels, time zones, IDs, serialization | Pure parsing with Croner validation |
| `src/scheduler/service.test.ts` | 7 | Schedule CRUD, collisions, invalid edits, duplicate names, channel validation, next-run enumeration, concurrency | Real temporary directories |
| `src/bot/commands/schedules.test.ts` | 2 | Empty, valid, and invalid `/schedules` rendering | Mock scheduler statuses |
| **Total** | **80** | | |

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

### config (17 tests)

- Required environment values and defaults
- Strict version 1 YAML, required arrays, unknown/duplicate keys, quoted Discord IDs, and unique values
- Repository and Claude tool-rule syntax
- Read-only directory/file enforcement, non-owner POSIX checks, symlink/junction rejection, and `BASE_PROJECT_DIR` separation
- Docker read-only mount detection
- Required-file failure and load-once/no-hot-reload behavior

### database (4 tests)

- Conversation-chain creation, status/session updates, deletion tombstones, and Discord message mappings

### scheduler (18 tests)

- YAML front matter, five-field cron and IANA time-zone validation, safe schedule IDs, and serialization
- File-backed CRUD, case-insensitive name collisions, invalid direct edits, disabled timers, and next-run enumeration

## Adding New Tests

1. Create `<module>.test.ts` next to the source file
2. Import from the source using `.js` extension (ESM convention)
3. Mock external dependencies (`vi.mock()`) — avoid mocking the module under test
4. Run `npm test` to verify
