import {
  ActionRowBuilder, ButtonBuilder, ButtonInteraction, ButtonStyle, ModalBuilder,
  ModalSubmitInteraction, StringSelectMenuInteraction, TextInputBuilder, TextInputStyle,
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

  if (action === "approve" || action === "deny") {
    await interaction.deferUpdate();
    const message = sessionManager.resolveApproval(requestId, action);
    if (message) await message.delete().catch(() => undefined);
    else await interaction.followUp({ content: "This approval expired.", ephemeral: true });
    return;
  }

  if (action === "ask-opt") {
    const separator = requestId.lastIndexOf(":");
    const id = requestId.slice(0, separator);
    const label = "label" in interaction.component ? interaction.component.label ?? "" : "";
    await interaction.deferUpdate();
    const message = sessionManager.resolveQuestion(id, label);
    if (message) await message.delete().catch(() => undefined);
    return;
  }

  if (action === "ask-other") {
    const modal = new ModalBuilder().setCustomId(`ask-modal:${requestId}`).setTitle("Custom answer");
    const input = new TextInputBuilder().setCustomId("answer").setLabel("Answer").setStyle(TextInputStyle.Paragraph).setRequired(true);
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await interaction.showModal(modal);
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
  if (interaction.customId.startsWith("ask-select:")) {
    const id = interaction.customId.slice("ask-select:".length);
    const options = interaction.component.options;
    const answer = interaction.values.map((value) => options.find((option) => option.value === value)?.label ?? value).join(", ");
    await interaction.deferUpdate();
    const message = sessionManager.resolveQuestion(id, answer);
    if (message) await message.delete().catch(() => undefined);
    return;
  }
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

export async function handleModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
  if (!interaction.customId.startsWith("ask-modal:")) return;
  const id = interaction.customId.slice("ask-modal:".length);
  const answer = interaction.fields.getTextInputValue("answer");
  await interaction.deferUpdate();
  const message = sessionManager.resolveQuestion(id, answer);
  if (message) await message.delete().catch(() => undefined);
}
