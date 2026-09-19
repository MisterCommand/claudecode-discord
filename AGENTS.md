# AGENTS.md

This file is a guide for Codex (Codex.ai/code) when working in this repository.

## Project Overview

A bot that manages Claude Agent SDK sessions on Discord (desktop/web/mobile). Independent sessions run in `BASE_PROJECT_DIR`. Each turn snapshots a Restricted or Admin Access Profile from its exact destination channel/thread ID. Both profiles use bypass permissions, configured deny rules hide unavailable tools, and a pre-use hook blocks recognized GitHub MCP calls that directly target Protected Repositories from Restricted channels. Admin turns may also receive optional read-only access to one on-premises Exchange Inbox. File attachments are downloaded to `.claude-uploads/`; dangerous executables are blocked and a 25MB limit applies. An optional embedded Gemini Business pool runs in the same process and is offered as a `/model` provider; its accounts are captured through a headless Chrome sign-in. Runs as a foreground Node.js process or Docker container on macOS, Linux, Windows, and headless servers.

## Commands

```bash
npm run dev          # Development run (tsx)
npm run build        # Production build (tsup, ESM)
npm start            # Run built files
npm test             # Run tests (vitest)
npm run test:watch   # Test watch mode
npx tsc --noEmit     # Type check only
npm run gemini -- login    # Headless browser sign-in; prints a proxy.yaml block
npm run gemini -- check    # Refresh every pool account's credentials
npm run gemini -- validate # Validate proxy.yaml without starting the bot
./install.sh         # macOS/Linux CLI bootstrap and build
install.bat          # Windows CLI bootstrap and build
```

## Architecture

```
[Discord] ←→ [Discord Bot (discord.js v14)] ←→ [SessionManager] ←→ [Claude Agent SDK]
                              ↕
                        [SQLite (better-sqlite3)]
```

**Core data flow:** Message sent to a visible channel → `message.ts` validates rate limiting → session chain resolution → attachment download → `SessionManager.sendMessage()` snapshots the exact-channel Access Profile and creates/resumes Agent SDK `query()` → denied tools are omitted → `PreToolUse` tracks progress and blocks protected GitHub targets for Restricted → streaming response is edited into Discord every 1.5s → heartbeat every 15s shows tool count → Stop button can interrupt immediately → final response includes policy denial notices without exposing profile or session labels.

### File Structure

```
claudecode-discord/
├── .env.example            # Environment variable template
├── Dockerfile              # Production container image
├── compose.example.yml     # Docker Compose example
├── src/
│   ├── index.ts            # Entry point
│   ├── bot/
│   │   ├── client.ts       # Discord bot init & event routing
│   │   ├── commands/       # Slash commands (5)
│   │   │   ├── status.ts
│   │   │   ├── sessions.ts
│   │   │   ├── usage.ts
│   │   │   ├── schedules.ts
│   │   │   └── model.ts
│   │   └── handlers/
│   │       ├── message.ts      # Message handling, file downloads
│   │       └── interaction.ts  # Button/select menu handling
│   ├── claude/
│   │   ├── session-manager.ts  # Session lifecycle, progress display
│   │   ├── providers.ts        # Provider selection and subprocess environment
│   │   └── output-formatter.ts # Discord output formatting
│   ├── db/
│   │   ├── database.ts     # SQLite init & queries
│   │   ├── channel-providers.ts # Per-channel /model provider overrides
│   │   └── types.ts
│   ├── email/
│   │   └── tools.ts        # Admin-only read-only Exchange Inbox MCP tools
│   ├── gemini-business/    # Vendored gemini-business-api pool (see its LICENSE)
│   │   ├── config.ts       # proxy.yaml schema, provider injection, file loading
│   │   ├── credentials.ts  # GEMINI_SSO_* sign-in credentials and subprocess isolation
│   │   ├── pool.ts         # In-process pool lifecycle for index.ts
│   │   ├── cli.ts          # `npm run gemini -- login|check|validate`
│   │   ├── server.ts       # Anthropic + OpenAI-compatible HTTP routes
│   │   ├── browser-auth.ts # Headless Chrome credential capture
│   │   └── sso-auth.ts     # Workforce Identity Federation / Entra ID automation
│   ├── security/
│   │   ├── access-policy.ts # Access profiles and GitHub MCP protection
│   │   └── guard.ts         # Rate limit and path validation
│   └── utils/
│       └── config.ts       # Environment + trusted YAML validation (zod v4)
├── SETUP.md                # Cross-platform CLI setup guide
├── docs/
│   └── TESTING.md          # Test layout and coverage
├── README.md
├── package.json
└── tsconfig.json
```

### Key Modules

- **`src/bot/client.ts`** — Discord.js client initialization, event routing, per-guild slash command registration
- **`src/bot/commands/`** — 5 slash commands: status, sessions, usage, schedules, and model
- **`src/bot/handlers/message.ts`** — Resolves chains and context, then downloads safe attachments to `.claude-uploads/`
- **`src/bot/handlers/interaction.ts`** — Handles Stop and session delete/cancel controls plus session selection; there are no approval or question interactions
- **`src/claude/session-manager.ts`** — Snapshots Access Profile per turn, passes profile denials through `disallowedTools`, enforces Protected Repositories with `PreToolUse`, runs remaining tools in bypass mode, applies the channel's resolved provider to the SDK subprocess (credentials, model, subagent model, effort level), logs profile/audit events, streams responses, resumes SDK sessions, and queues per chain
- **`src/claude/providers.ts`** — Resolves a channel's provider (stored override → `claude.default_provider` → first entry) and maps the selected provider to the subprocess `ANTHROPIC_*` credentials plus optional `CLAUDE_CODE_SUBAGENT_MODEL`/`CLAUDE_CODE_EFFORT_LEVEL`
- **`src/claude/output-formatter.ts`** — Splits messages for Discord's length limit while preserving code fences and creates Stop/completion UI
- **`src/db/database.ts`** — SQLite WAL mode. Auto-creates `data.db` with `session_chains` and Discord `message_mappings`
- **`src/db/channel-providers.ts`** — JSON-file store for per-channel `/model` provider overrides in `channel-providers.json` beside `data.db`; malformed content degrades to "no override"
- **`src/email/tools.ts`** — Optional in-process `exchange_email` MCP server for Admin turns; lists/searches the configured Inbox and retrieves plain-text messages plus attachment metadata without mailbox mutations
- **`src/security/guard.ts`** — In-memory sliding-window rate limiting and project path validation
- **`src/gemini-business/`** — Vendored `gemini-business-api` pool. `config.ts` owns the `proxy.yaml` schema and injects the `gemini-business` provider; `pool.ts` starts/stops the in-process HTTP server and runs the startup sign-in over the captured accounts; `signin.ts` holds the shared probe-then-browser policy; `account-store.ts` persists captures to `gemini-accounts.json` beside `data.db` (mode 0600), because `proxy.yaml` is read-only; `credentials.ts` isolates `GEMINI_SSO_*` from the Claude subprocess; `cli.ts` backs `npm run gemini -- login|check|validate`. Treat the rest as upstream code, including its tests.
- **`src/security/access-policy.ts`** — Exact channel-to-profile classification, global plus Restricted denylist composition, GitHub MCP direct-target matching, and minimal stderr audit records
- **`src/utils/config.ts`** — Environment settings plus mandatory versioned `BOT_CONFIG_DIR/config.yaml`, including the optional `claude` section that lists the `/model` providers (identifier, label, API key, base URL, default/subagent model, effort level) and the default provider; rejects invalid, writable, linked, or in-workspace configuration, refuses the retired `CLAUDE_MODEL` variable, and does not hot reload

### Access Policy

1. Exact destination channel/thread ID in `access.admin_channels` → Admin; otherwise Restricted. There is no parent inheritance
2. `AskUserQuestion` and `tools.denied` are hidden from both profiles
3. `tools.restricted_denied` is additionally hidden from Restricted
4. Restricted `mcp__github__*` calls using reviewed schemas are denied when a direct target matches `access.protected_repositories` case-insensitively
5. All remaining tools execute through `bypassPermissions` without Discord approval
6. Configured Exchange email tools exist only for Admin turns; credentials are not forwarded to the Claude subprocess and mailbox content remains untrusted
7. Scheduled turns use the exact destination ID and follow the same policy
8. An optional `proxy.yaml` in `BOT_CONFIG_DIR` (required `workspace_id` plus pool settings) starts the embedded Gemini Business pool in-process and prepends a `gemini-business` provider to `/model`; it is trusted policy with the same ownership and read-only rules as `config.yaml`, and its sign-in secrets live in the environment and are removed from the Claude subprocess
9. The pool refreshes its accounts at startup: stored cookies are probed first, and a headless browser sign-in runs only when they are rejected. Accounts are never listed in `proxy.yaml`; every capture persists to `gemini-accounts.json` beside `data.db`, which is the sole account source, and a capture from any workspace other than the configured `workspace_id` is excluded from rotation

### Session States

- **🟢 online** — Claude is working
- **⚪ idle** — Task complete, waiting for next input
- **🔴 offline** — No session

### Multi-PC Support

Create separate Discord bots per PC and invite them to the same guild. Each bot independently registers projects in different channels.

## Development Principles (Important)

This project is **public open source** and used by many users without technical backgrounds. All design and implementation must follow these principles:

- **No manual intervention**: "Tell the user to run this command" is not a solution. Individual guidance for hundreds of users is impossible. Problems must be automatically resolved through code
- **CLI-first operation**: Keep runtime behavior independent of native platform UI. Docker and standard process managers are supported deployment options.
- **Existing user compatibility**: Preserve environment variables, database data, session state, and documented CLI/Docker workflows unless a requirement explicitly accepts a breaking migration. The mandatory trusted YAML configuration is one such accepted migration.
- **User guidance on error**: When errors occur, the cause and solution must be automatically shown to the user (e.g., auto-display `codex login` guidance message when login expires)

## TypeScript Conventions

- ESM modules (`"type": "module"`), use `.js` extension for local imports
- Strict mode, `noUnusedLocals` and `noUnusedParameters` enabled
- Target: ES2022, moduleResolution: bundler
- Use Zod v4 (note API differences from v3)
- Use `path.join()`, `path.resolve()` for path handling (Windows compatibility)
- Use `split(/[\\/]/)` for filename extraction (supports both macOS/Windows path separators)

## Environment Setup

Copy `.env.example` to `.env` and set values. Required: `DISCORD_BOT_TOKEN`, `BASE_PROJECT_DIR`, and `BOT_CONFIG_DIR`; `DISCORD_GUILD_ID` is optional. `BOT_CONFIG_DIR` must be an absolute, non-linked, read-only directory outside `BASE_PROJECT_DIR` containing strict version 1 `config.yaml`. Optional: `RATE_LIMIT_PER_MINUTE` (default 10), `SHOW_COST` (default true), and the all-or-none `EWS_URL`/`EWS_EMAIL`/`EWS_PASSWORD` group for Admin-only on-premises Exchange email retrieval. The Gemini Business sign-in reads the all-or-none `GEMINI_SSO_EMAIL`/`GEMINI_SSO_PASSWORD` pair plus optional `GEMINI_SSO_TOTP_SECRET`, `GEMINI_SSO_PROVIDER`, and `CHROME_PATH`; the running pool reads accounts from the captured `gemini-accounts.json` runtime store, never from `BOT_CONFIG_DIR/proxy.yaml`. Invalid configuration prevents startup.
