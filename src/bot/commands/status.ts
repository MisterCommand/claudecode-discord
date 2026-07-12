import { ChatInputCommandInteraction, EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { getChainsForChannel } from "../../db/database.js";

const emoji: Record<string, string> = { online: "🟢", waiting: "🟡", idle: "⚪", offline: "🔴" };
export const data = new SlashCommandBuilder().setName("status").setDescription("Show session status in this channel or thread");
export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const chains = getChainsForChannel(interaction.channelId);
  if (!chains.length) { await interaction.editReply("No sessions in this channel."); return; }
  const embed = new EmbedBuilder().setTitle("Session status").setColor(0x7c3aed).setTimestamp();
  for (const chain of chains.slice(0, 25)) {
    embed.addFields({ name: `${emoji[chain.status] ?? "⚪"} ${chain.label}`, value: `${chain.status} • ${chain.last_activity ?? chain.created_at}` });
  }
  await interaction.editReply({ embeds: [embed] });
}
