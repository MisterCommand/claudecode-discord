import type { Client } from "discord.js";
import { createNewChain } from "../claude/session-chain.js";
import { sessionManager } from "../claude/session-manager.js";
import { startTurnObservation } from "../observability/telemetry.js";
import { effectiveTimezone } from "./parser.js";
import { scheduleService } from "./service.js";
import type { ScheduleDefinition } from "./types.js";

async function runScheduledTurn(client: Client, definition: ScheduleDefinition): Promise<void> {
  const observation = startTurnObservation({
    source: "schedule",
    channelId: definition.discordChannel,
    scheduleId: definition.id,
    scheduleName: definition.name,
  });
  let transferred = false;
  try {
    const channel = await observation.runChild(
      "claudecode_discord.schedule.destination.resolve",
      () => client.channels.fetch(definition.discordChannel),
    );
    if (!channel || !channel.isSendable() || !("guildId" in channel)) {
      throw new Error(`Discord channel ${definition.discordChannel} is unavailable or not sendable`);
    }

    const chain = createNewChain(channel.guildId, channel.id);
    const prompt = [
      "[Scheduled task — run unattended and make reasonable assumptions instead of asking questions]",
      `Name: ${definition.name}`,
      `Schedule ID: ${definition.id}`,
      `Cron: ${definition.cron}`,
      `Time zone: ${effectiveTimezone(definition.timezone)}${definition.timezone ? "" : " (host local)"}`,
      `Triggered at: ${new Date().toISOString()}`,
      "",
      "[Task prompt]",
      definition.prompt,
    ].join("\n");
    observation.setAttributes({
      "discord.guild.id": channel.guildId,
      "session.chain.id": chain.id,
      "session.chain.label": chain.label,
    });
    observation.recordConversation("input", prompt);
    transferred = true;
    await sessionManager.sendMessage({
      chain,
      channel,
      prompt,
      observation,
      source: "schedule",
      scheduleName: definition.name,
    });
  } catch (error) {
    if (!transferred) observation.finish("error", undefined, error);
    throw error;
  }
}

export async function startScheduleRuntime(client: Client): Promise<void> {
  await scheduleService.start(client, (definition) => runScheduledTurn(client, definition));
}
