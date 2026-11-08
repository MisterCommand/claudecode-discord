# Share Discord history across Access Profiles

The Discord History Capability is available to both Restricted and Admin Turns
in server channels and threads, including scheduled Turns. Requiring an exact
Admin destination prevented reports scheduled in other channels from collecting
any conversations. Access Profile classification no longer controls whether the
built-in `discord_history` MCP server is registered for a Turn.

## Consequences

Collection remains read-only and scoped to the destination's server. The bot's
Discord read permissions, configured tool denials, and always-excluded sources
still apply. Direct messages have no server history tools. Server reports can
include private conversations the bot can read, so operators use
`discord_summary.excluded_channels` to omit sources from every collection.
