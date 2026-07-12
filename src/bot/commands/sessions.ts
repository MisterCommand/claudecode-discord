import {
  ActionRowBuilder, ChatInputCommandInteraction, SlashCommandBuilder, StringSelectMenuBuilder,
} from "discord.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getChainsForChannel } from "../../db/database.js";

export const data = new SlashCommandBuilder()
  .setName("sessions")
  .setDescription("Show conversation sessions in this channel or thread");

export function findSessionDir(projectPath: string): string | null {
  const root = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(root)) return null;
  const simple = path.join(root, projectPath.replace(/[\\/_]/g, "-"));
  if (fs.existsSync(simple)) return simple;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    const file = fs.readdirSync(directory).find((name) => name.endsWith(".jsonl"));
    if (!file) continue;
    try {
      const head = fs.readFileSync(path.join(directory, file), "utf8").split("\n").slice(0, 10);
      if (head.some((line) => { try { return JSON.parse(line).cwd === projectPath; } catch { return false; } })) return directory;
    } catch { /* inaccessible session */ }
  }
  return null;
}

export function sessionFilePath(projectPath: string, sessionId: string): string | null {
  const directory = findSessionDir(projectPath);
  return directory ? path.join(directory, `${sessionId}.jsonl`) : null;
}

export function sessionFileExists(projectPath: string, sessionId: string): boolean {
  const file = sessionFilePath(projectPath, sessionId);
  return file !== null && fs.existsSync(file);
}

export function deleteSessionFile(projectPath: string, sessionId: string): void {
  const file = sessionFilePath(projectPath, sessionId);
  if (file && fs.existsSync(file)) fs.unlinkSync(file);
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const chains = getChainsForChannel(interaction.channelId);
  if (!chains.length) {
    await interaction.editReply("No sessions in this channel yet. Mention the bot to start one.");
    return;
  }
  const options = chains.slice(0, 25).map((chain) => ({
    label: `${chain.status === "online" ? "🟢" : chain.status === "waiting" ? "🟡" : "⚪"} ${chain.label}`,
    description: `${chain.status} • ${chain.last_activity ?? chain.created_at}`.slice(0, 100),
    value: chain.id,
  }));
  const menu = new StringSelectMenuBuilder()
    .setCustomId("session-select")
    .setPlaceholder("Select a session…")
    .addOptions(options);
  await interaction.editReply({
    embeds: [{
      title: "Conversation sessions",
      description: `Found ${chains.length} session(s) in this channel.`,
      color: 0x7c3aed,
    }],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
  });
}
