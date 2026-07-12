import {
  Client, Collection, GatewayIntentBits, REST, Routes,
  type ChatInputCommandInteraction, type Interaction,
} from "discord.js";
import { getConfig } from "../utils/config.js";
import { handleMessage } from "./handlers/message.js";
import { handleButtonInteraction, handleModalSubmit, handleSelectMenuInteraction } from "./handlers/interaction.js";
import * as statusCmd from "./commands/status.js";
import * as sessionsCmd from "./commands/sessions.js";
import * as usageCmd from "./commands/usage.js";

const commands = [statusCmd, sessionsCmd, usageCmd];
const commandMap = new Collection<string, { execute: (interaction: ChatInputCommandInteraction) => Promise<void> }>();
for (const command of commands) commandMap.set(command.data.name, command);

export async function startBot(): Promise<Client> {
  const config = getConfig();
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
  client.on("ready", async () => {
    console.log(`Bot logged in as ${client.user?.tag}`);
    try {
      const rest = new REST({ version: "10" }).setToken(config.DISCORD_BOT_TOKEN);
      const app = await rest.get(Routes.currentApplication()) as { id: string };
      await rest.put(Routes.applicationGuildCommands(app.id, config.DISCORD_GUILD_ID), { body: commands.map((command) => command.data.toJSON()) });
      console.log(`Registered ${commands.length} slash commands`);
    } catch (error) { console.error("Failed to register slash commands:", error); }
  });
  client.on("interactionCreate", async (interaction: Interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        await interaction.deferReply();
        await commandMap.get(interaction.commandName)?.execute(interaction);
      } else if (interaction.isButton()) await handleButtonInteraction(interaction);
      else if (interaction.isStringSelectMenu()) await handleSelectMenuInteraction(interaction);
      else if (interaction.isModalSubmit()) await handleModalSubmit(interaction);
    } catch (error) {
      console.error("Interaction error:", error);
      if (interaction.isRepliable()) {
        const content = "An error occurred while processing the interaction.";
        if (interaction.replied || interaction.deferred) await interaction.followUp({ content, ephemeral: true }).catch(() => undefined);
        else await interaction.reply({ content, ephemeral: true }).catch(() => undefined);
      }
    }
  });
  client.on("messageCreate", async (message) => {
    try { await handleMessage(message); }
    catch (error) {
      console.error("messageCreate error:", error);
      await message.reply("An error occurred while processing your message.").catch(() => undefined);
    }
  });
  client.on("error", (error) => console.error("Discord client error:", error));
  client.on("warn", (warning) => console.warn("Discord warning:", warning));
  client.on("shardError", (error, shardId) => console.error(`Shard ${shardId} error:`, error));
  await loginWithRetry(client, config.DISCORD_BOT_TOKEN);
  return client;
}

async function loginWithRetry(client: Client, token: string): Promise<void> {
  const delays = [5, 10, 15, 30];
  let attempt = 0;
  while (true) {
    try { await client.login(token); return; }
    catch (error) {
      const delay = delays[Math.min(attempt++, delays.length - 1)];
      console.error(`Discord login failed: ${(error as Error).message}. Retrying in ${delay}s…`);
      await new Promise((resolve) => setTimeout(resolve, delay * 1000));
    }
  }
}
