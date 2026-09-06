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
BOT_CONFIG_DIR=/Users/yourname/claude-discord-config
RATE_LIMIT_PER_MINUTE=10
SHOW_COST=true
# CLAUDE_MODEL=claude-sonnet-4-6
```

| Variable | Description |
|----------|-------------|
| `DISCORD_BOT_TOKEN` | Bot token from the Discord Developer Portal |
| `DISCORD_GUILD_ID` | Optional server ID used for configuration context |
| `BASE_PROJECT_DIR` | Workspace root for registered projects |
| `BOT_CONFIG_DIR` | Absolute directory containing the required read-only `config.yaml`; must be outside `BASE_PROJECT_DIR` |
| `RATE_LIMIT_PER_MINUTE` | Per-user message limit; defaults to `10` |
| `SHOW_COST` | Show estimated task cost; defaults to `true` |
| `CLAUDE_MODEL` | Optional Claude model override |

To copy a server ID, enable **Developer Mode** in Discord's advanced settings,
then right-click the server name or long-press it on mobile.

![Copy Server ID](docs/copy-server-id-en.png)

## 5. Create the bot configuration

Copy `config.example.yaml` to `config.yaml` in the directory specified by
`BOT_CONFIG_DIR`, then enter exact Discord channel or thread IDs and protected
repositories. IDs must remain quoted.

```yaml
version: 1

access:
  admin_channels:
    - "123456789012345678"
  protected_repositories:
    - USThing/USThingServer

tools:
  denied: []
  restricted_denied: []
```

Admin classification uses only the exact destination ID. A thread does not
inherit Admin access from its parent channel. `tools.denied` applies to both
profiles; `tools.restricted_denied` applies only to Restricted. Both profiles
automatically execute every tool not denied by these lists or a policy hook.
Keep GitHub MCP connection settings and credentials in Claude Code's normal MCP
configuration. This file contains policy only and assumes the MCP server is
named `github`.

After editing, make the directory and file read-only and own them from an
account other than the non-root bot account. On macOS or Linux:

```bash
sudo chown -R root /absolute/path/to/claude-discord-config
sudo chmod 444 /absolute/path/to/claude-discord-config/config.yaml
sudo chmod 555 /absolute/path/to/claude-discord-config
```

A root bot process is accepted only when the config is on a read-only mount.

On Windows, keep the directory owned by an administrative account, use a
dedicated non-owner bot account, and grant that account read-and-execute access
without write access. Run this from an elevated terminal, replacing the path
and account:

```powershell
icacls "C:\claude-discord-config" /inheritance:r
icacls "C:\claude-discord-config" /grant:r "MACHINE\claude-bot:(OI)(CI)RX"
```

Keep an administrative account with permission to restore or edit the ACL.
Stop the bot before changing the file, restore read-only access, and restart;
configuration is loaded once and is not hot-reloaded. The bot refuses to start
if the directory or file is missing, writable, linked, or invalid.

## 6. Build and Run

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
  --env BOT_CONFIG_DIR=/config \
  --mount type=bind,source=/absolute/path/to/projects,target=/projects \
  --mount type=bind,source=/absolute/path/to/config-directory,target=/config,readonly \
  --mount type=volume,source=claude-discord-home,target=/home/node \
  --mount type=volume,source=claude-discord-data,target=/data \
  "$IMAGE"
```

Or use the included Compose example:

```bash
docker compose -f compose.example.yml run --rm bot claude login
docker compose -f compose.example.yml up -d
```

The Compose example reads the host config directory from `BOT_CONFIG_DIR`,
mounts it at `/config` read-only, and supplies `/config` to the container.

## 7. Use the Bot

Mention the bot in a channel it can access to start a session:

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

### Profiles and controls

- The exact destination channel or thread selects Restricted or Admin.
- All non-denied tools execute without Discord approval prompts.
- `AskUserQuestion` is hidden; Claude asks for clarification in a normal reply.
- The Stop button cancels only the session represented by its progress message.

## 8. Recurring Schedules

Ask the bot to create, update, disable, or delete a schedule. Schedules are
stored as Markdown files in the gitignored `schedules/` directory and are
reloaded while the bot is running.

Each schedule requires `name`, a five-field `cron`, a quoted
`discord_channel`, and a non-empty Markdown prompt. Optional fields include
`description`, `enabled`, and an IANA `timezone`.

A scheduled turn uses the profile of its exact destination channel ID. Schedule
management may target an Admin channel even when requested from a Restricted
channel; the work and output occur in the destination channel.

## 9. Troubleshooting

### The bot does not respond

- Confirm **Message Content Intent** is enabled.
- Confirm `DISCORD_BOT_TOKEN`, `BASE_PROJECT_DIR`, and `BOT_CONFIG_DIR` are set in `.env`.
- Confirm `BOT_CONFIG_DIR/config.yaml` passes the strict schema and read-only checks shown at startup.
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

## 10. Development Checks

```bash
npm test
npm run build
npx tsc --noEmit
```

See [docs/TESTING.md](docs/TESTING.md) for the test layout and coverage.
