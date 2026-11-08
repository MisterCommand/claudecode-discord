import path from "node:path";
import { ChatInputCommandInteraction, EmbedBuilder, escapeMarkdown, SlashCommandBuilder } from "discord.js";
import { effectiveTimezone } from "../../scheduler/parser.js";
import { scheduleService } from "../../scheduler/service.js";

export const data = new SlashCommandBuilder()
  .setName("schedules")
  .setDescription("Show schedules or run one now in this channel or thread")
  .addStringOption((option) => option
    .setName("run")
    .setDescription("Run a schedule now by its ID or exact name, including paused schedules"));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const identifier = interaction.options.getString("run");
  if (identifier !== null) {
    try {
      const definition = await scheduleService.runNow(identifier, interaction.channelId);
      await interaction.editReply({
        content: `Starting **${escapeMarkdown(definition.name)}** now. Results will appear in this channel or thread.`,
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await interaction.editReply({
        content: `Could not start the schedule: ${message}`,
        allowedMentions: { parse: [] },
      });
    }
    return;
  }

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
    const zone = effectiveTimezone(definition.timezone);
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
