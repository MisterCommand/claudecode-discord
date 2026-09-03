<p align="center">
  <img src="docs/icon-rounded.png" alt="Claude Code Discord Controller" width="120">
</p>

# Claude Code Discord Controller

[![CI](https://github.com/chadingTV/claudecode-discord/actions/workflows/ci.yml/badge.svg)](https://github.com/chadingTV/claudecode-discord/actions)

Control Claude Code from your phone — a multi-machine agent hub via Discord.
**No API key needed — works with your existing Claude Pro or Max subscription.**

<p align="center">
  <img src="docs/demo.gif" alt="Demo — start and continue Claude sessions from Discord" width="300">
</p>

## Why This Bot? — vs Official Remote Control

Anthropic's [Remote Control](https://code.claude.com/docs/en/remote-control) lets you view a running local session from your phone. This bot goes further — it's a **multi-machine agent hub** that creates new sessions on demand, supports team collaboration, and can run persistently under Docker or a process manager.

|                              | This Bot | Official Remote |
|------------------------------|:--------:|:---------------:|
| Start new session from phone | ✅       | ❌              |
| Persistent process deployment | ✅   | ❌              |
| Multi-machine hub            | ✅       | ❌              |
| Concurrent sessions per machine | ✅    | ❌              |
| Push notifications           | ✅       | ❌              |
| Team collaboration           | ✅       | ❌              |
| Zero open ports              | ✅       | ✅              |

### Multi-PC Hub

Create a separate Discord bot per machine, invite them all to the same server, and assign channels:

```
Your Discord Server
├── #work-mac-frontend     ← Bot on work Mac
├── #work-mac-backend      ← Bot on work Mac
├── #home-pc-sideproject   ← Bot on home PC
├── #cloud-server-infra    ← Bot on cloud server
```

**Control every machine's Claude Code from a single phone.** The channel list itself becomes your real-time status dashboard across all machines and projects.

## Why Discord?

Discord isn't just a chat app — it's a surprisingly perfect fit for controlling AI agents:

- **Already on your phone.** No new app to install, no web UI to bookmark. Open Discord and go.
- **Push notifications for free.** Get alerted instantly when Claude needs approval or finishes a task — even with the phone locked.
- **Conversation chains = sessions.** Mention the bot for a new session, or reply anywhere in an existing chain to continue it.
- **Rich UI out of the box.** Buttons, select menus, embeds, file uploads — Discord provides the interactive components, so the bot doesn't need its own frontend.
- **Team-ready by default.** Invite teammates to your server. They can watch Claude work, approve tool calls, or queue tasks — no extra auth layer needed.
- **Cross-platform.** Windows, macOS, Linux, iOS, Android, web browser — Discord runs everywhere.

## Features

- 💰 **No API key** — runs on Claude Code CLI with your Pro or Max subscription
- 📱 Remote control Claude Code from Discord (desktop/web/mobile)
- 🔀 Multiple independent conversation-chain sessions in every channel or thread
- ✅ Tool use approve/deny via Discord button UI
- ❓ Interactive question UI (selectable options + custom text input)
- ⏹️ Session-specific Stop button and per-chain queueing
- 📎 File attachments support (images, documents, code files)
- 🔄 Session resume/delete/new (persist across bot restarts, last conversation preview)
- ⏱️ Real-time progress display (tool usage, elapsed time)
- 🔒 Per-user rate limiting, fixed workspace, attachment filtering, duplicate instance prevention
- 📊 **Claude Code usage dashboard** in Discord — Session (5hr), Weekly (7day), and Weekly Sonnet usage with progress bars
- 🗓️ Markdown-based recurring schedules with natural-language Discord management

## Tech Stack

| Category | Technology |
|----------|------------|
| Runtime | Node.js 20+, TypeScript |
| Discord | discord.js v14 |
| AI | @anthropic-ai/claude-agent-sdk |
| DB | better-sqlite3 (SQLite) |
| Validation | zod v4 |
| Scheduling | Croner + YAML front matter |
| Build | tsup (ESM) |
| Test | vitest |

## Installation

```bash
git clone https://github.com/chadingTV/claudecode-discord.git
cd claudecode-discord
npm install
cp .env.example .env   # Windows PowerShell: Copy-Item .env.example .env
# Edit .env, then:
npm run build
npm start
```

The optional `install.sh` and `install.bat` scripts perform the same CLI setup
and build steps. They do not install or launch a desktop application.

### Setup Guides

See **[SETUP.md](SETUP.md)** for the complete cross-platform CLI setup guide.

### Docker

Images are published to GitHub Container Registry for AMD64 and ARM64. Replace
`<owner>` with the lowercase GitHub account that owns your repository.

```bash
export IMAGE=ghcr.io/<owner>/claudecode-discord:latest

# Authenticate Claude Code once. The login and session state persist in this volume.
docker volume create claude-discord-home
docker run --rm -it \
  --mount type=volume,source=claude-discord-home,target=/home/node \
  "$IMAGE" claude login

# Run the bot. An existing .env can be reused; the container path overrides its
# host-specific BASE_PROJECT_DIR value.
docker volume create claude-discord-data
docker run -d --name claude-discord --restart unless-stopped \
  --env-file .env \
  --env BASE_PROJECT_DIR=/projects \
  --mount type=bind,source=/absolute/path/to/projects,target=/projects \
  --mount type=volume,source=claude-discord-home,target=/home/node \
  --mount type=volume,source=claude-discord-data,target=/data \
  "$IMAGE"
```

Alternatively, use the included Compose example. It uses `BASE_PROJECT_DIR`
from `.env` as the host bind-mount source while setting the path seen by the
container to `/projects`.

```bash
# Optional when using an image published from a different repository:
export DOCKER_IMAGE=ghcr.io/<owner>/claudecode-discord:latest

# Authenticate once, then start the bot in the background.
docker compose -f compose.example.yml run --rm bot claude login
docker compose -f compose.example.yml up -d
```

The container runs as UID/GID `1000:1000`; mounted projects must be writable by
that user. The data volume stores the SQLite database, and the home volume stores
Claude authentication and resumable session data. Containerized agent commands
run inside the image. A general agent toolchain is included: standard Unix text
and file tools, Git and SSH, curl and wget, Node.js with npm/npx/pnpm/Yarn/Bun,
Python with pip, C++ build tools, search/data/archive utilities, SQLite, rsync,
and common process and network diagnostics. Install any additional
project-specific tools in a derived image if needed.

<details>
<summary><strong>Project Structure</strong></summary>

```
claudecode-discord/
├── install.sh / install.bat    # Optional CLI bootstrap scripts
├── src/
│   ├── index.ts                # Entry point
│   ├── bot/
│   │   ├── client.ts           # Discord bot init & events
│   │   ├── commands/           # /sessions, /status, /usage, /schedules
│   │   └── handlers/           # Message & interaction handlers
│   ├── claude/
│   │   ├── session-manager.ts  # Session lifecycle
│   │   └── output-formatter.ts # Discord output formatting
│   ├── db/                     # SQLite (better-sqlite3)
│   ├── security/               # Rate limiting and path validation
│   ├── scheduler/              # Markdown schedules, Croner registry, Agent tools
│   └── utils/                  # Config (zod)
├── SETUP.md                    # Cross-platform CLI setup guide
├── Dockerfile                  # Production container image
├── compose.example.yml         # Docker Compose example
├── docs/                       # Setup and testing documentation
└── package.json
```

</details>

## Usage

Mention the bot in any server channel it can access to start a new session:

```text
@Claude investigate this test failure
```

Reply to any user or bot message already mapped to that conversation to continue its latest session state. To include preceding human conversation explicitly, add `w/N` anywhere in the message (for example, `@Claude w/20 summarize and act`). There is no automatic ambient context.

Replying to an otherwise unrelated human message while mentioning the bot starts a new session and includes only that referenced message. Text, files, and images on the triggering message are passed through; `w/N` context includes all images from the selected messages.

| Command | Description |
|---------|-------------|
| `/status` | Show sessions in the current channel or thread |
| `/sessions` | Inspect or delete sessions in the current channel or thread |
| `/usage` | Show Claude Code usage |
| `/schedules` | Show recurring schedules for the current channel or thread |

### Recurring schedules

Ask the bot to manage a schedule in normal language:

```text
@Claude every day at 8 a.m., summarize code changes and pull requests
@Claude disable the Daily engineering summary schedule
@Claude delete the Daily engineering summary schedule
```

The bot translates explicit scheduling requests into built-in schedule tools. Creating, updating, and deleting schedules happens immediately without another approval prompt. Each scheduled occurrence starts a fresh session; reply to its Discord result to continue that specific session.

Schedules are stored as one Markdown file per task in the automatically created, gitignored `schedules/` directory. For normal installations this is inside the installation directory. In Docker it is `/data/schedules`, which is covered by the existing data volume. Files can also be edited directly while the bot is running; changes are detected automatically.

```markdown
---
name: Daily engineering summary
description: Summarize code and pull-request activity
cron: "0 8 * * *"
discord_channel: "123456789012345678"
enabled: true
timezone: "Asia/Hong_Kong"
---

Summarize code changes and pull requests since the previous day.
Highlight anything that needs attention.
```

- The filename stem is the schedule ID and must contain only lowercase ASCII letters, numbers, dots, hyphens, or underscores.
- `name`, `cron`, `discord_channel`, and a non-empty Markdown prompt are required. Channel IDs must be quoted so YAML does not round large Discord IDs.
- Cron expressions use exactly five fields: minute, hour, day of month, month, and day of week.
- `enabled` defaults to `true`. `description` and `timezone` are optional.
- Without `timezone`, the host machine's local time zone is used. Docker hosts commonly use UTC, so set an IANA zone when wall-clock time matters.
- Occurrences missed while the bot is offline are skipped. Overlapping occurrences are allowed and run as separate sessions.
- All scheduled work runs in `BASE_PROJECT_DIR`.

> [!WARNING]
> Schedules are trusted, unattended automations. Scheduled turns automatically approve all executable tools, including Bash, Write, and Edit. Anyone who can ask this bot to create a schedule can establish recurring full-access work in `BASE_PROJECT_DIR`. Scheduled turns cannot create or modify other schedules.

During a turn, one Discord reply is edited in place with progress and streaming output. Approval and question prompts appear separately and are deleted after resolution. On success, the progress reply becomes the final answer; oversized answers continue in mapped follow-up messages.

### In-Progress Controls

- **Stop** cancels only the session shown on that progress message.
- Different chains can run concurrently in the same channel.
- Messages targeting a busy chain are queued for that chain.
- Any user with channel access can continue sessions and use approval, question, stop, and deletion controls.
<details>
<summary><strong>Architecture</strong></summary>

```
[Mobile Discord] ←→ [Discord Bot] ←→ [Session Manager] ←→ [Claude Agent SDK]
                          ↕
                     [SQLite DB]
```

- Independent sessions per Discord conversation chain
- Claude Agent SDK runs Claude Code as subprocess (shares existing auth)
- Write and shell tools require Discord approval
- A single progress reply is edited during streaming and becomes the final answer
- Heartbeat progress display every 15s until text output begins
- Markdown code blocks preserved across message splits

**Session States:** 🟢 working · 🟡 waiting for approval · ⚪ idle · 🔴 offline

</details>

## Security

### Zero External Attack Surface

This bot **does not open any HTTP servers, ports, or API endpoints.** It connects to Discord via an outbound WebSocket — there is no inbound listener, so there is no network path for external attackers to reach this bot.

```
Typical web server:  External → [Port open, waiting] → Receives requests  (inbound)
This bot:            Bot → [Connects to Discord] → Receives events         (outbound only)
```

### Self-Hosted Architecture

The bot runs entirely on your own PC/server. No external servers involved, and no data leaves your machine except through Discord and the Anthropic API (which uses your own Claude Code login session).

### Access Control

- Access follows Discord channel and thread permissions
- Per-user request rate limiting remains enabled
- All agent work is fixed to `BASE_PROJECT_DIR`

### Execution Protection

- Tool use default: file modifications, command execution, etc. **require user approval each time** (Discord buttons)
- Path traversal (`..`) blocked
- File attachments: executable files (.exe, .bat, etc.) blocked, 25MB size limit

### Precautions

- The `.env` file contains your bot token — **never share it publicly.** If compromised, immediately Reset Token in Discord Developer Portal
- Every write or shell action requires explicit approval from a user who can access the channel
- Scheduled turns are the exception: their executable tools are auto-approved so they can finish unattended. Treat access to schedule creation and the local `schedules/` directory as full workspace access.

## Running the Bot

The bot runs in the foreground so logs are visible and operation is consistent
across macOS, Linux, Windows, and headless servers. Use Docker or your preferred
process manager when it must run unattended.

## Development

```bash
npm run dev          # Development mode via tsx
npm run build        # Production build
npm start            # Run the production build
npm test             # Tests (vitest)
npm run test:watch   # Test watch mode
```

## License

[MIT License](LICENSE) - Free to use, modify, and distribute commercially. Attribution required: include the original copyright notice and link to [this repository](https://github.com/chadingTV/claudecode-discord).

---

If you find this project useful, please consider giving it a ⭐ — it helps others discover it!
