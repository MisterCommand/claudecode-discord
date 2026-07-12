import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} from "discord.js";

const MAX_DISCORD_LENGTH = 1900; // leave room for formatting

export function formatStreamChunk(text: string): string {
  if (text.length <= MAX_DISCORD_LENGTH) return text;
  return text.slice(0, MAX_DISCORD_LENGTH) + "\n" + "... (truncated)";
}

export function splitMessage(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_DISCORD_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline
    let splitAt = remaining.lastIndexOf("\n", MAX_DISCORD_LENGTH);
    if (splitAt === -1 || splitAt < MAX_DISCORD_LENGTH / 2) {
      splitAt = MAX_DISCORD_LENGTH;
    }

    let chunk = remaining.slice(0, splitAt);
    remaining = remaining.slice(splitAt);

    // Check if we're splitting inside an unclosed code block
    const fenceRegex = /^```/gm;
    let insideBlock = false;
    let blockLang = "";
    let match;
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
      // Close the code block in this chunk, reopen in the next
      chunk += "\n```";
      remaining = "```" + blockLang + "\n" + remaining;
    }

    chunks.push(chunk);
  }

  return chunks;
}

export function createStopButton(
  chainId: string,
): ActionRowBuilder<ButtonBuilder> {
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

export function createToolApprovalEmbed(
  toolName: string,
  input: Record<string, unknown>,
  requestId: string,
): { embed: EmbedBuilder; row: ActionRowBuilder<ButtonBuilder> } {
  const embed = new EmbedBuilder()
    .setTitle(`🔧 Tool Use: ${toolName}`)
    .setColor(0xffa500)
    .setTimestamp();

  // Add relevant fields based on tool type
  if (toolName === "Edit" || toolName === "Write") {
    const filePath = (input.file_path as string) ?? "unknown";
    embed.addFields({ name: "File", value: `\`${filePath}\``, inline: false });

    if (input.old_string && input.new_string) {
      const diff = `\`\`\`diff\n- ${String(input.old_string).slice(0, 500)}\n+ ${String(input.new_string).slice(0, 500)}\n\`\`\``;
      embed.addFields({ name: "Changes", value: diff, inline: false });
    } else if (input.content) {
      const preview = String(input.content).slice(0, 500);
      embed.addFields({
        name: "Content Preview",
        value: `\`\`\`\n${preview}\n\`\`\``,
        inline: false,
      });
    }
  } else if (toolName === "Bash") {
    const command = (input.command as string) ?? "unknown";
    const description = (input.description as string) ?? "";
    embed.addFields(
      { name: "Command", value: `\`\`\`bash\n${command}\n\`\`\``, inline: false },
    );
    if (description) {
      embed.addFields({ name: "Description", value: description, inline: false });
    }
  } else {
    // Generic tool display - skip empty input
    const summary = JSON.stringify(input, null, 2);
    if (summary && summary !== "{}") {
      embed.addFields({
        name: "Input",
        value: `\`\`\`json\n${summary.slice(0, 800)}\n\`\`\``,
        inline: false,
      });
    }
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`approve:${requestId}`)
      .setLabel("Approve")
      .setStyle(ButtonStyle.Success)
      .setEmoji("✅"),
    new ButtonBuilder()
      .setCustomId(`deny:${requestId}`)
      .setLabel("Deny")
      .setStyle(ButtonStyle.Danger)
      .setEmoji("❌"),
  );

  return { embed, row };
}

export interface AskQuestionData {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

export function createAskUserQuestionEmbed(
  questionData: AskQuestionData,
  requestId: string,
  questionIndex: number,
  totalQuestions: number,
): { embed: EmbedBuilder; components: ActionRowBuilder<any>[] } {
  const title =
    totalQuestions > 1
      ? `❓ ${questionData.header} (${questionIndex + 1}/${totalQuestions})`
      : `❓ ${questionData.header}`;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(questionData.question)
    .setColor(0x7c3aed)
    .setTimestamp();

  // Add option descriptions as embed fields
  for (const opt of questionData.options) {
    embed.addFields({
      name: opt.label,
      value: opt.description || "\u200b",
      inline: false,
    });
  }

  const components: ActionRowBuilder<any>[] = [];

  if (questionData.multiSelect) {
    // Use StringSelectMenu for multi-select
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`ask-select:${requestId}`)
      .setPlaceholder("Select options...")
      .setMinValues(1)
      .setMaxValues(questionData.options.length)
      .addOptions(
        questionData.options.map((opt, i) => ({
          label: opt.label.slice(0, 100),
          value: String(i),
          ...(opt.description
            ? { description: opt.description.slice(0, 100) }
            : {}),
        })),
      );

    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu),
    );

    // Custom input button in separate row
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`ask-other:${requestId}`)
          .setLabel("Custom input")
          .setStyle(ButtonStyle.Secondary)
          .setEmoji("✏️"),
      ),
    );
  } else {
    // Use buttons for single select
    const buttons: ButtonBuilder[] = questionData.options.map((opt, i) =>
      new ButtonBuilder()
        .setCustomId(`ask-opt:${requestId}:${i}`)
        .setLabel(opt.label.slice(0, 80))
        .setStyle(i === 0 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    );

    // Custom input button
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`ask-other:${requestId}`)
        .setLabel("Custom input")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("✏️"),
    );

    // Discord max 5 buttons per row
    for (let i = 0; i < buttons.length; i += 5) {
      components.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          ...buttons.slice(i, i + 5),
        ),
      );
    }
  }

  return { embed, components };
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

  const embed = new EmbedBuilder()
    .setTitle("✅ Task Complete")
    .setDescription(result.slice(0, 4000))
    .setColor(0x00ff00)
    .setFooter({ text: footer })
    .setTimestamp();

  return embed;
}
