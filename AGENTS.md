# AGENTS.md

This file is a guide for Codex (Codex.ai/code) when working in this repository.

## Project Overview

A bot that manages Claude Agent SDK sessions on Discord (desktop/web/mobile). Independent sessions run in `BASE_PROJECT_DIR`. Each turn snapshots a Restricted or Admin Access Profile from its exact destination channel/thread ID. Both profiles use bypass permissions, configured deny rules hide unavailable tools, and a pre-use hook blocks recognized GitHub MCP calls that directly target Protected Repositories from Restricted channels. File attachments are downloaded to `.claude-uploads/`; dangerous executables are blocked and a 25MB limit applies. Runs as a foreground Node.js process or Docker container on macOS, Linux, Windows, and headless servers.

## Commands

```bash
npm run dev          # Development run (tsx)
npm run build        # Production build (tsup, ESM)
npm start            # Run built files
npm test             # Run tests (vitest)
npm run test:watch   # Test watch mode
npx tsc --noEmit     # Type check only
./install.sh         # macOS/Linux CLI bootstrap and build
install.bat          # Windows CLI bootstrap and build
```

## Architecture

```
[Discord] ←→ [Discord Bot (discord.js v14)] ←→ [SessionManager] ←→ [Claude Agent SDK]
                              ↕
                        [SQLite (better-sqlite3)]
```

**Core data flow:** Message sent to a visible channel → `message.ts` validates rate limiting → session chain resolution → attachment download → `SessionManager.sendMessage()` snapshots the exact-channel Access Profile and creates/resumes Agent SDK `query()` → denied tools are omitted → `PreToolUse` tracks progress and blocks protected GitHub targets for Restricted → streaming response is edited into Discord every 1.5s → heartbeat every 15s shows tool count and profile → Stop button can interrupt immediately → final response includes the profile footer and policy denial notices.

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
│   │   ├── commands/       # Slash commands (3)
│   │   │   ├── status.ts
│   │   │   ├── sessions.ts
│   │   │   └── usage.ts
│   │   └── handlers/
│   │       ├── message.ts      # Message handling, file downloads
│   │       └── interaction.ts  # Button/select menu handling
│   ├── claude/
│   │   ├── session-manager.ts  # Session lifecycle, progress display
│   │   └── output-formatter.ts # Discord output formatting
│   ├── db/
│   │   ├── database.ts     # SQLite init & queries
│   │   └── types.ts
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
- **`src/bot/commands/`** — 4 slash commands: status, sessions, usage, and schedules
- **`src/bot/handlers/message.ts`** — Resolves chains and context, then downloads safe attachments to `.claude-uploads/`
- **`src/bot/handlers/interaction.ts`** — Handles Stop and session delete/cancel controls plus session selection; there are no approval or question interactions
- **`src/claude/session-manager.ts`** — Snapshots Access Profile per turn, passes profile denials through `disallowedTools`, enforces Protected Repositories with `PreToolUse`, runs remaining tools in bypass mode, logs profile/audit events, streams responses, resumes SDK sessions, and queues per chain
- **`src/claude/output-formatter.ts`** — Splits messages for Discord's length limit while preserving code fences and creates Stop/completion UI
- **`src/db/database.ts`** — SQLite WAL mode. Auto-creates `data.db` with `session_chains` and Discord `message_mappings`
- **`src/security/guard.ts`** — In-memory sliding-window rate limiting and project path validation
- **`src/security/access-policy.ts`** — Exact channel-to-profile classification, global plus Restricted denylist composition, GitHub MCP direct-target matching, and minimal stderr audit records
- **`src/utils/config.ts`** — Environment settings plus mandatory versioned `BOT_CONFIG_DIR/config.yaml`; rejects invalid, writable, linked, or in-workspace configuration and does not hot reload

### Access Policy

1. Exact destination channel/thread ID in `access.admin_channels` → Admin; otherwise Restricted. There is no parent inheritance
2. `AskUserQuestion` and `tools.denied` are hidden from both profiles
3. `tools.restricted_denied` is additionally hidden from Restricted
4. Restricted `mcp__github__*` calls using reviewed schemas are denied when a direct target matches `access.protected_repositories` case-insensitively
5. All remaining tools execute through `bypassPermissions` without Discord approval
6. Scheduled turns use the exact destination ID and follow the same policy

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

Copy `.env.example` to `.env` and set values. Required: `DISCORD_BOT_TOKEN`, `BASE_PROJECT_DIR`, and `BOT_CONFIG_DIR`; `DISCORD_GUILD_ID` is optional. `BOT_CONFIG_DIR` must be an absolute, non-linked, read-only directory outside `BASE_PROJECT_DIR` containing strict version 1 `config.yaml`. Optional: `RATE_LIMIT_PER_MINUTE` (default 10), `SHOW_COST` (default true), and `CLAUDE_MODEL`. Invalid configuration prevents startup.
