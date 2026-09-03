# Claude Code Discord Bot Setup

This guide covers the CLI setup for macOS, Linux, Windows, and headless
servers. The bot runs as a Node.js process and is controlled through Discord.

## 1. Prerequisites

### Node.js

Node.js 20 or newer is required:

```bash
node -v
```

Install it from [nodejs.org](https://nodejs.org), or use your operating
system's package manager.

### Claude Code

Install and authenticate the Claude Code CLI:

```bash
npm install -g @anthropic-ai/claude-code
claude --version
claude
```

Complete the browser login when prompted. The bot uses the existing Claude Code
OAuth session; no `ANTHROPIC_API_KEY` is required.

## 2. Install the Project

Clone the repository and install dependencies:

```bash
git clone https://github.com/chadingTV/claudecode-discord.git
cd claudecode-discord
npm install
```

Optional CLI bootstrap scripts perform the prerequisite checks, dependency
installation, environment-file setup, and build:

```bash
./install.sh                 # macOS/Linux
./install.bat                # Windows Command Prompt
.\install.bat                # Windows PowerShell
```

These scripts do not create shortcuts, launch desktop applications, or manage
background services.

## 3. Create and Invite the Discord Bot

### Create the application

1. Open [Discord Developer Applications](https://discord.com/developers/applications).
2. Select **New Application** and give it a name.
3. Open **Bot**, select **Reset Token**, and save the token as
   `DISCORD_BOT_TOKEN`.
4. Under **Privileged Gateway Intents**, enable **Message Content Intent**.

   ![Message Content Intent](docs/message-content-intent.png)

### Invite the bot

1. Open **OAuth2 > URL Generator**.
2. Select the `bot` and `applications.commands` scopes.

   ![Discord OAuth2 Scopes](docs/discord-scopes.png)

3. Select these bot permissions: `Send Messages`, `Add Reactions`, `Embed
   Links`, `Read Message History`, and `Use Slash Commands`.

   ![Discord Bot Permissions](docs/discord-bot-permissions.png)

4. Open the generated URL and authorize the bot in your server.

## 4. Configure the Environment

Copy the example file:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Edit `.env`:

```env
DISCORD_BOT_TOKEN=your_bot_token_here
DISCORD_GUILD_ID=your_server_id_here
BASE_PROJECT_DIR=/Users/yourname/projects
RATE_LIMIT_PER_MINUTE=10
SHOW_COST=true
# CLAUDE_MODEL=claude-sonnet-4-6
```

| Variable | Description |
|----------|-------------|
| `DISCORD_BOT_TOKEN` | Bot token from the Discord Developer Portal |
| `DISCORD_GUILD_ID` | Optional server ID used for configuration context |
| `BASE_PROJECT_DIR` | Workspace root for registered projects |
| `RATE_LIMIT_PER_MINUTE` | Per-user message limit; defaults to `10` |
| `SHOW_COST` | Show estimated task cost; defaults to `true` |
| `CLAUDE_MODEL` | Optional Claude model override |

To copy a server ID, enable **Developer Mode** in Discord's advanced settings,
then right-click the server name or long-press it on mobile.

![Copy Server ID](docs/copy-server-id-en.png)

## 5. Build and Run

```bash
npm run build
npm start
```

For development:

```bash
npm run dev
```

The bot runs in the foreground and logs to the terminal. Stop it with
`Ctrl+C`. For unattended operation, use Docker or a process manager already
supported by your operating system.

### Docker

The image is published for AMD64 and ARM64. The image includes the Claude Code
runtime, and the `/home/node` volume preserves authentication and resumable
session data:

```bash
export IMAGE=ghcr.io/<owner>/claudecode-discord:latest
docker volume create claude-discord-home
docker volume create claude-discord-data

docker run --rm -it \
  --mount type=volume,source=claude-discord-home,target=/home/node \
  "$IMAGE" claude login

docker run -d --name claude-discord --restart unless-stopped \
  --env-file .env \
  --env BASE_PROJECT_DIR=/projects \
  --mount type=bind,source=/absolute/path/to/projects,target=/projects \
  --mount type=volume,source=claude-discord-home,target=/home/node \
  --mount type=volume,source=claude-discord-data,target=/data \
  "$IMAGE"
```

Or use the included Compose example:

```bash
docker compose -f compose.example.yml run --rm bot claude login
docker compose -f compose.example.yml up -d
```

## 6. Use the Bot

Mention the bot in a registered channel to start a session:

```text
@Claude investigate this test failure
```

Reply to a mapped conversation message to continue its session. Add `w/N` to
include preceding human messages. Images, documents, and code attachments are
passed to Claude for analysis.

### Register a project

Send a project registration request in the target Discord channel. Project paths
may be a folder name under `BASE_PROJECT_DIR`, a relative path, or an absolute
path within the configured workspace root.

### Slash commands

| Command | Description |
|---------|-------------|
| `/status` | Show session status in the current channel or thread |
| `/sessions` | Inspect, resume, or delete sessions |
| `/usage` | Show Claude Code Session, Weekly, and Sonnet usage |
| `/schedules` | Show recurring schedules |

### Approvals and controls

- Write, edit, and shell tools require approval through Discord buttons unless
  channel auto-approval is enabled.
- Read-only tools are approved automatically.
- AskUserQuestion prompts appear as Discord controls or a text-input dialog.
- The Stop button cancels only the session represented by its progress message.

## 7. Recurring Schedules

Ask the bot to create, update, disable, or delete a schedule. Schedules are
stored as Markdown files in the gitignored `schedules/` directory and are
reloaded while the bot is running.

Each schedule requires `name`, a five-field `cron`, a quoted
`discord_channel`, and a non-empty Markdown prompt. Optional fields include
`description`, `enabled`, and an IANA `timezone`.

Scheduled turns automatically approve executable tools, including Bash, Write,
and Edit. Treat schedule creation and the schedules directory as full workspace
access.

## 8. Troubleshooting

### The bot does not respond

- Confirm **Message Content Intent** is enabled.
- Confirm `DISCORD_BOT_TOKEN` and `BASE_PROJECT_DIR` are set in `.env`.
- Confirm the bot can view and send messages in the channel.

### Slash commands are missing

- Reinvite the bot with the `applications.commands` scope.
- Restart the bot so commands are registered again.
- Discord may take time to refresh globally registered commands.

### Claude Code authentication fails

Run `claude` in the same environment used by the bot and complete login again.
For Docker, authenticate inside the persistent `/home/node` volume.

### Native SQLite installation fails

`better-sqlite3` may require a C/C++ build toolchain when no prebuilt binary is
available. Install the build tools for your operating system, then run:

```bash
npm rebuild better-sqlite3
npm run build
```

## 9. Development Checks

```bash
npm test
npm run build
npx tsc --noEmit
```

See [docs/TESTING.md](docs/TESTING.md) for the test layout and coverage.
