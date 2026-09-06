import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";

const MAX_DISCORD_LENGTH = 1900;

export function formatStreamChunk(text: string): string {
  if (text.length <= MAX_DISCORD_LENGTH) return text;
  return text.slice(0, MAX_DISCORD_LENGTH) + "\n... (truncated)";
}

export function splitMessage(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_DISCORD_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n", MAX_DISCORD_LENGTH);
    if (splitAt === -1 || splitAt < MAX_DISCORD_LENGTH / 2) splitAt = MAX_DISCORD_LENGTH;

    let chunk = remaining.slice(0, splitAt);
    remaining = remaining.slice(splitAt);
    const fenceRegex = /^```/gm;
    let insideBlock = false;
    let blockLang = "";
    let match: RegExpExecArray | null;
    while ((match = fenceRegex.exec(chunk)) !== null) {
      if (insideBlock) {
        insideBlock = false;
        blockLang = "";
      } else {
        insideBlock = true;
        const lineEnd = chunk.indexOf("\n", match.index);
        blockLang = chunk.slice(match.index + 3, lineEnd === -1 ? undefined : lineEnd).trim();
      }
    }

    if (insideBlock) {
      chunk += "\n```";
      remaining = `\`\`\`${blockLang}\n${remaining}`;
    }
    chunks.push(chunk);
  }

  return chunks;
}

export function createStopButton(chainId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`stop:${chainId}`)
      .setLabel("Stop")
      .setStyle(ButtonStyle.Danger)
      .setEmoji("⏹️"),
  );
}

export function createCompletedButton(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("completed")
      .setLabel("Completed")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("✅")
      .setDisabled(true),
  );
}

export function createResultEmbed(
  result: string,
  costUsd: number,
  durationMs: number,
  showCost: boolean = true,
): EmbedBuilder {
  const duration = `${(durationMs / 1000).toFixed(1)}s`;
  const footer = showCost
    ? `Cost (est.) : $${costUsd.toFixed(4)}  |  Duration : ${duration}`
    : `Duration : ${duration}`;

  return new EmbedBuilder()
    .setTitle("✅ Task Complete")
    .setDescription(result.slice(0, 4000))
    .setColor(0x00ff00)
    .setFooter({ text: footer })
    .setTimestamp();
}
