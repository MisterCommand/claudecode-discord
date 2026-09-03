# CLAUDE.md

This file is a guide for Claude Code (claude.ai/code) when working in this repository.

## Project Overview

A bot that manages Claude Code sessions for multiple projects on Discord (desktop/web/mobile). Maps independent Claude Agent SDK sessions to project directories per Discord channel. Write tools (Edit, Write, Bash) require Discord button approval/denial; read-only tools are auto-approved. The AskUserQuestion tool sends questions via Discord buttons/select menus and collects answers (also supports direct text input). File attachments (images, documents, code files) are downloaded to `.claude-uploads/` in the project directory and passed to the Read tool. Dangerous executables (.exe, .bat, etc.) are blocked, 25MB size limit applies. Runs as a foreground Node.js process or Docker container on macOS, Linux, Windows, and headless servers.

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

**Core data flow:** Message sent to registered channel → `message.ts` handler validates auth/rate limiting → if waiting for custom input, treat as AskUserQuestion answer → concurrent session check (reject if active) → file attachment download (images + docs) → `SessionManager.sendMessage()` creates/resumes Agent SDK `query()` → streaming response edited into Discord message at 1.5s intervals → before text output, heartbeat every 15s shows progress (tool name, elapsed time, tool usage count) → Stop button on progress message for immediate stop → on tool use, `canUseTool` callback sends AskUserQuestion UI, auto-approves read-only, or sends Discord button embed → user approve/deny → promise resolve → result embed (cost/duration) sent.

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
│   │   └── guard.ts        # Auth, rate limit, path validation
│   └── utils/
│       └── config.ts       # Environment variable validation (zod v4)
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
- **`src/bot/handlers/message.ts`** — Passes channel messages to SessionManager after security validation. If waiting for AskUserQuestion custom input, treats as answer (does not forward to Claude). On image/document attachments, downloads to `.claude-uploads/` and adds file path to prompt. Rejects concurrent messages while session is active. Blocks dangerous files (.exe, .bat, etc.), 25MB size limit
- **`src/bot/handlers/interaction.ts`** — Handles button interactions (approve/deny/stop/session-delete/session-cancel) and StringSelectMenu (session selection → Delete/Cancel buttons). Shows last conversation preview on session selection. Handles AskUserQuestion option buttons (ask-opt), custom input modal (ask-other), multi-select menu (ask-select)
- **`src/claude/session-manager.ts`** — Singleton managing per-channel active sessions. Implements approval workflow via Agent SDK `query()` and `canUseTool` callback. Manages pending approvals via requestId-based Map (5 min timeout). On AskUserQuestion tool detection, shows Discord button/select menu UI, injects user answers into `updatedInput.answers` and returns. Supports free-text answers via custom input modal. Multiple questions processed sequentially. Supports session resume via SDK session ID. Auto-resumes on bot restart by loading session_id from DB. Shows progress via heartbeat (15s interval) before text output. Stop button on progress message for immediate stop. Cleans up active sessions in finally block
- **`src/claude/output-formatter.ts`** — Splits messages for Discord 2000 char limit (preserving markdown code block fences). Creates tool approval request and result embeds. Creates AskUserQuestion embed + option buttons/select menus. Stop button factory. Reflects SHOW_COST setting in result embed
- **`src/db/database.ts`** — SQLite WAL mode. Auto-creates data.db. 2 tables: `projects` (channel→project path mapping, auto_approve flag), `sessions` (session state tracking, SDK session_id storage)
- **`src/security/guard.ts`** — User whitelist (ALLOWED_USER_IDS), in-memory sliding window rate limiting, path traversal (`..`) blocking
- **`src/utils/config.ts`** — Environment variable validation via Zod v4 schema, singleton pattern

### Tool Approval Logic (`canUseTool`)

1. AskUserQuestion → Send Discord question UI (buttons/select menu), collect user answer, inject into `updatedInput.answers` and return allow (5 min timeout, deny if no response)
2. Read-only tools (Read, Glob, Grep, WebSearch, WebFetch, TodoWrite) → Always auto-approve
3. Channel has `auto_approve` enabled → Auto-approve
4. Otherwise → Send Discord button embed, wait for user response (5 min timeout, deny if no response)

### Session States

- **🟢 online** — Claude is working
- **🟡 waiting** — Waiting for tool use approval
- **⚪ idle** — Task complete, waiting for next input
- **🔴 offline** — No session

### Multi-PC Support

Create separate Discord bots per PC and invite them to the same guild. Each bot independently registers projects in different channels.

## Development Principles (Important)

This project is **public open source** and used by many users without technical backgrounds. All design and implementation must follow these principles:

- **No manual intervention**: "Tell the user to run this command" is not a solution. Individual guidance for hundreds of users is impossible. Problems must be automatically resolved through code
- **CLI-first operation**: Keep runtime behavior independent of native platform UI. Docker and standard process managers are supported deployment options.
- **Existing user compatibility**: New updates must not block users on previous versions. Preserve environment variables, database data, session state, and documented CLI/Docker workflows when changing the project.
- **User guidance on error**: When errors occur, the cause and solution must be automatically shown to the user (e.g., auto-display `claude login` guidance message when login expires)

## TypeScript Conventions

- ESM modules (`"type": "module"`), use `.js` extension for local imports
- Strict mode, `noUnusedLocals` and `noUnusedParameters` enabled
- Target: ES2022, moduleResolution: bundler
- Use Zod v4 (note API differences from v3)
- Use `path.join()`, `path.resolve()` for path handling (Windows compatibility)
- Use `split(/[\\/]/)` for filename extraction (supports both macOS/Windows path separators)

## Environment Setup

Copy `.env.example` to `.env` and set values. Required: `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `ALLOWED_USER_IDS`, `BASE_PROJECT_DIR`. Optional: `RATE_LIMIT_PER_MINUTE` (default 10), `SHOW_COST` (default true, recommended false for Max plan users). data.db is auto-created on first run.
