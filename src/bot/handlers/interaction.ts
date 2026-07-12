import {
  ActionRowBuilder, ButtonBuilder, ButtonInteraction, ButtonStyle, ModalBuilder,
  ModalSubmitInteraction, StringSelectMenuInteraction, TextInputBuilder, TextInputStyle,
} from "discord.js";
import { getChain, markChainDeleted } from "../../db/database.js";
import { getConfig } from "../../utils/config.js";
import { L } from "../../utils/i18n.js";
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
      await interaction.followUp({ content: L("This session is no longer active.", "이 세션은 더 이상 활성 상태가 아닙니다."), ephemeral: true });
    }
    return;
  }

  if (action === "approve" || action === "deny") {
    await interaction.deferUpdate();
    const message = sessionManager.resolveApproval(requestId, action);
    if (message) await message.delete().catch(() => undefined);
    else await interaction.followUp({ content: L("This approval expired.", "이 승인은 만료되었습니다."), ephemeral: true });
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
    const modal = new ModalBuilder().setCustomId(`ask-modal:${requestId}`).setTitle(L("Custom answer", "직접 답변"));
    const input = new TextInputBuilder().setCustomId("answer").setLabel(L("Answer", "답변")).setStyle(TextInputStyle.Paragraph).setRequired(true);
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await interaction.showModal(modal);
    return;
  }

  if (action === "session-delete") {
    const chain = getChain(requestId);
    if (!chain || chain.channel_id !== interaction.channelId) {
      await interaction.update({ content: L("Session not found.", "세션을 찾을 수 없습니다."), embeds: [], components: [] });
      return;
    }
    if (sessionManager.isActive(chain.id)) await sessionManager.stopSession(chain.id);
    if (chain.session_id) deleteSessionFile(getConfig().BASE_PROJECT_DIR, chain.session_id);
    markChainDeleted(chain.id);
    await interaction.update({ content: L(`Deleted session ${chain.label}.`, `${chain.label} 세션을 삭제했습니다.`), embeds: [], components: [] });
    return;
  }

  if (action === "session-cancel") {
    await interaction.update({ content: L("Cancelled.", "취소되었습니다."), embeds: [], components: [] });
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
      await interaction.update({ content: L("Session not found.", "세션을 찾을 수 없습니다."), embeds: [], components: [] });
      return;
    }
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`session-delete:${chain.id}`).setLabel(L("Delete session", "세션 삭제")).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("session-cancel:_").setLabel(L("Cancel", "취소")).setStyle(ButtonStyle.Secondary),
    );
    await interaction.update({
      embeds: [{ title: chain.label, description: L(`Status: ${chain.status}\nLast activity: ${chain.last_activity ?? "unknown"}\n\nDelete this session permanently?`, `상태: ${chain.status}\n마지막 활동: ${chain.last_activity ?? "알 수 없음"}\n\n이 세션을 영구 삭제할까요?`), color: 0x7c3aed }],
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
