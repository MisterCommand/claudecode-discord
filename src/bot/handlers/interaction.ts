import {
  ActionRowBuilder, ButtonBuilder, ButtonInteraction, ButtonStyle, StringSelectMenuInteraction,
} from "discord.js";
import { getChain, markChainDeleted } from "../../db/database.js";
import { getConfig } from "../../utils/config.js";
import { sessionManager } from "../../claude/session-manager.js";
import { deleteSessionFile } from "../commands/sessions.js";

function parseCustomId(customId: string): [string, string] {
  const index = customId.indexOf(":");
  return index < 0 ? [customId, ""] : [customId.slice(0, index), customId.slice(index + 1)];
}

export async function handleButtonInteraction(interaction: ButtonInteraction): Promise<void> {
  const [action, requestId] = parseCustomId(interaction.customId);
  if (!requestId) return;

  if (action === "stop") {
    await interaction.deferUpdate();
    if (!await sessionManager.stopSession(requestId)) {
      await interaction.followUp({ content: "This session is no longer active.", ephemeral: true });
    }
    return;
  }

  if (action === "session-delete") {
    const chain = getChain(requestId);
    if (!chain || chain.channel_id !== interaction.channelId) {
      await interaction.update({ content: "Session not found.", embeds: [], components: [] });
      return;
    }
    if (sessionManager.isActive(chain.id)) await sessionManager.stopSession(chain.id);
    if (chain.session_id) deleteSessionFile(getConfig().BASE_PROJECT_DIR, chain.session_id);
    markChainDeleted(chain.id);
    await interaction.update({ content: `Deleted session ${chain.label}.`, embeds: [], components: [] });
    return;
  }

  if (action === "session-cancel") {
    await interaction.update({ content: "Cancelled.", embeds: [], components: [] });
  }
}

export async function handleSelectMenuInteraction(interaction: StringSelectMenuInteraction): Promise<void> {
  if (interaction.customId === "session-select") {
    const chain = getChain(interaction.values[0]);
    if (!chain || chain.channel_id !== interaction.channelId) {
      await interaction.update({ content: "Session not found.", embeds: [], components: [] });
      return;
    }
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`session-delete:${chain.id}`).setLabel("Delete session").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("session-cancel:_").setLabel("Cancel").setStyle(ButtonStyle.Secondary),
    );
    await interaction.update({
      embeds: [{ title: chain.label, description: `Status: ${chain.status}\nLast activity: ${chain.last_activity ?? "unknown"}\n\nDelete this session permanently?`, color: 0x7c3aed }],
      components: [row],
    });
  }
}
