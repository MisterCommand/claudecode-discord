import path from "node:path";
import { ChatInputCommandInteraction, EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { effectiveTimezone } from "../../scheduler/parser.js";
import { scheduleService } from "../../scheduler/service.js";

export const data = new SlashCommandBuilder()
  .setName("schedules")
  .setDescription("Show recurring schedules for this channel or thread");

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const statuses = scheduleService.getStatuses(interaction.channelId);
  if (!statuses.length) {
    await interaction.editReply("No schedules are configured for this channel. Ask the bot to create one, or add a Markdown file to the schedules directory.");
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle("Recurring schedules")
    .setDescription(statuses.length > 25 ? `Showing 25 of ${statuses.length} schedules in this channel.` : `${statuses.length} schedule(s) in this channel.`)
    .setColor(0x7c3aed)
    .setTimestamp();

  for (const status of statuses.slice(0, 25)) {
    if (!status.definition) {
      embed.addFields({
        name: `⚠️ ${status.id}`,
        value: `Disabled by validation error\n${status.error ?? "Unknown error"}\nFile: \`${path.basename(status.filePath)}\``.slice(0, 1024),
      });
      continue;
    }

    const definition = status.definition;
    const zone = `${effectiveTimezone(definition.timezone)}${definition.timezone ? "" : " (host local)"}`;
    const next = status.nextRun ? `<t:${Math.floor(status.nextRun.getTime() / 1000)}:F> (<t:${Math.floor(status.nextRun.getTime() / 1000)}:R>)` : "Disabled";
    const lines = [
      definition.description,
      `Cron: \`${definition.cron}\``,
      `Time zone: ${zone}`,
      `Next: ${next}`,
      `ID: \`${definition.id}\``,
    ].filter(Boolean);
    embed.addFields({
      name: `${definition.enabled ? "🟢" : "⏸️"} ${definition.name}`.slice(0, 256),
      value: lines.join("\n").slice(0, 1024),
    });
  }
  await interaction.editReply({ embeds: [embed] });
}
