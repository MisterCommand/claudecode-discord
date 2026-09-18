import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { getConfig, type ClaudeProvider } from "../../utils/config.js";
import { channelProviders } from "../../db/channel-providers.js";
import { resolveClaudeProvider } from "../../claude/providers.js";

const config = getConfig();
const defaultProvider = resolveClaudeProvider(config.claude, undefined);

function describeProvider(provider: ClaudeProvider): string {
  return provider.default_model
    ? `\`${provider.label}\` (${provider.default_model})`
    : `\`${provider.label}\``;
}

export const data = new SlashCommandBuilder()
  .setName("model")
  .setDescription("Show or switch the Claude provider (endpoint, key, and model) used in this channel or thread")
  .addStringOption((option) => option
    .setName("provider")
    .setDescription("Provider to use in this channel or thread")
    .addChoices(config.claude.providers.map((provider) => ({ name: provider.label, value: provider.value }))))
  .addBooleanOption((option) => option
    .setName("reset")
    .setDescription("Remove this channel's provider override"));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const channelId = interaction.channelId;

  if (interaction.options.getBoolean("reset")) {
    channelProviders.clear(channelId);
    await interaction.editReply(`Cleared the provider override for this channel. Using ${describeProvider(defaultProvider)}.`);
    return;
  }

  const selected = interaction.options.getString("provider");
  if (selected) {
    channelProviders.set(channelId, selected);
    await interaction.editReply(`Provider for this channel set to ${describeProvider(resolveClaudeProvider(config.claude, selected))}. It applies from the next message.`);
    return;
  }

  const stored = channelProviders.get(channelId);
  const provider = resolveClaudeProvider(config.claude, stored);
  const origin = stored === undefined
    ? "the configured default"
    : provider.value === stored
      ? "an override for this channel"
      : `the configured default, because the stored override \`${stored}\` is no longer configured`;
  await interaction.editReply(`Current provider for this channel: ${describeProvider(provider)} (${origin}).`);
}
