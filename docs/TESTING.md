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
| `src/claude/output-formatter.test.ts` | 29 | Message splitting, code block fence handling, Discord embed/button creation | No mocking — pure logic + discord.js constructors work natively |
| `src/security/guard.test.ts` | 12 | Sliding-window rate limiting and BASE_PROJECT_DIR path validation | Mock `getConfig()`, `vi.spyOn(fs)`, `vi.useFakeTimers()` |
| `src/utils/config.test.ts` | 2 | Required/default config parsing | `vi.resetModules()` + dynamic `import()` per test |
| `src/db/database.test.ts` | 4 | Conversation-chain and message-mapping CRUD | In-memory SQLite via `better-sqlite3` constructor mock |
| `src/scheduler/parser.test.ts` | 8 | Markdown/YAML parsing, cron, channels, time zones, IDs, serialization | Pure parsing with Croner validation |
| `src/scheduler/service.test.ts` | 7 | Schedule CRUD, collisions, invalid edits, duplicate names, channel validation, next-run enumeration, concurrency | Real temporary directories |
| `src/scheduler/tools.test.ts` | 1 | Scheduler tool permission routing | Pure tool-name classification |
| `src/bot/commands/schedules.test.ts` | 2 | Empty, valid, and invalid `/schedules` rendering | Mock scheduler statuses |
| **Total** | **65** | | |

## What Each Test Covers

### output-formatter (29 tests)

- **formatStreamChunk**: Truncation at 1900 chars, empty string handling
- **splitMessage**: Newline-based splitting, forced split for long lines, code block fence preservation (with/without language specifier), multiple code blocks
- **createToolApprovalEmbed**: Field generation per tool type (Edit, Bash, Write, generic), button customId format, content truncation
- **createResultEmbed**: Cost display toggle, duration formatting, description truncation
- **createAskUserQuestionEmbed**: Single-select (buttons), multi-select (StringSelectMenu), question indexing, row splitting (5 buttons per row)
- **createStopButton / createCompletedButton**: CustomId format, disabled state

### guard (12 tests)

- **isAllowedUser**: Whitelist match, case sensitivity, empty string rejection
- **checkRateLimit**: Within-limit requests, over-limit blocking, 60s window reset, per-user independence
- **validateProjectPath**: Path traversal (`..`) blocking before fs calls, BASE_PROJECT_DIR scope enforcement, non-existent path, non-directory path, valid directory

### config (2 tests)

- Valid config parsing from `process.env`
- `ALLOWED_USER_IDS` comma+space splitting
- `RATE_LIMIT_PER_MINUTE` integer coercion, `SHOW_COST` boolean coercion
- `process.exit(1)` on missing required variables
- Singleton caching (same reference on repeated calls)

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
