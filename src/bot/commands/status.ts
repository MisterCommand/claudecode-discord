import { ChatInputCommandInteraction, EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { getChainsForChannel } from "../../db/database.js";
import { L } from "../../utils/i18n.js";

const emoji: Record<string, string> = { online: "🟢", waiting: "🟡", idle: "⚪", offline: "🔴" };
export const data = new SlashCommandBuilder().setName("status").setDescription("Show session status in this channel or thread");
export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const chains = getChainsForChannel(interaction.channelId);
  if (!chains.length) { await interaction.editReply(L("No sessions in this channel.", "이 채널에 세션이 없습니다.")); return; }
  const embed = new EmbedBuilder().setTitle(L("Session status", "세션 상태")).setColor(0x7c3aed).setTimestamp();
  for (const chain of chains.slice(0, 25)) {
    embed.addFields({ name: `${emoji[chain.status] ?? "⚪"} ${chain.label}`, value: `${chain.status} • ${chain.last_activity ?? chain.created_at}` });
  }
  await interaction.editReply({ embeds: [embed] });
}
