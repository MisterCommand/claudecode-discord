import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import {
  type Client, type GuildMember, PermissionFlagsBits, type SendableChannels,
} from "discord.js";
import { z } from "zod";
import { effectiveTimezone } from "./parser.js";
import { scheduleService } from "./service.js";
import type { ScheduleDefinition, ScheduleUpdateInput } from "./types.js";

export interface ScheduleToolContext {
  client: Client;
  guildId: string;
  channelId: string;
  member: GuildMember | null;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
}

function channelIdFromInput(value: string | undefined, fallback: string): string {
  if (!value?.trim()) return fallback;
  const match = /^(?:<#)?(\d{17,20})>?$/.exec(value.trim());
  if (!match) throw new Error("Discord channel must be a channel mention or 17-20 digit channel ID");
  return match[1];
}

async function resolveTargetChannel(context: ScheduleToolContext, input?: string): Promise<SendableChannels> {
  const channelId = channelIdFromInput(input, context.channelId);
  const channel = await context.client.channels.fetch(channelId);
  if (!channel || !channel.isSendable() || !("guildId" in channel) || channel.guildId !== context.guildId) {
    throw new Error("Target channel must be a sendable channel in the current Discord server");
  }

  if (channelId !== context.channelId) {
    if (!context.member || !("permissionsFor" in channel)) throw new Error("Could not verify access to the target channel");
    const permissions = channel.permissionsFor(context.member);
    if (!permissions?.has(PermissionFlagsBits.ViewChannel)) throw new Error("You cannot create or manage schedules for that channel");
  }

  if ("permissionsFor" in channel && "guild" in channel) {
    const botMember = channel.guild.members.me;
    const permissions = botMember ? channel.permissionsFor(botMember) : null;
    const sendPermission = channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
    if (!permissions?.has(PermissionFlagsBits.ViewChannel) || !permissions.has(sendPermission)) {
      throw new Error("The bot cannot view or send messages in the target channel");
    }
  }
  return channel;
}

function describeSchedule(definition: ScheduleDefinition): string {
  const lines = [
    `${definition.name} (${definition.id})`,
    `Cron: ${definition.cron}`,
    `Channel: ${definition.discordChannel}`,
    `Time zone: ${effectiveTimezone(definition.timezone)}${definition.timezone ? "" : " (host local)"}`,
    `Enabled: ${definition.enabled ? "yes" : "no"}`,
  ];
  if (definition.enabled) {
    const next = scheduleService.previewNextRuns(definition, 3);
    if (next.length) lines.push(`Next runs: ${next.map((date) => date.toISOString()).join(", ")}`);
  }
  return lines.join("\n");
}

async function accessibleDefinition(context: ScheduleToolContext, identifier: string): Promise<ScheduleDefinition> {
  await scheduleService.reconcile();
  const definition = scheduleService.getDefinition(identifier);
  if (!definition) throw new Error(`Schedule not found: ${identifier}`);
  await resolveTargetChannel(context, definition.discordChannel);
  return definition;
}

export function isScheduleManagementTool(toolName: string): boolean {
  return /^(?:mcp__discord_scheduler__)?(?:list|create|update|delete)_schedules?$/.test(toolName);
}

export function createScheduleMcpServer(context: ScheduleToolContext) {
  return createSdkMcpServer({
    name: "discord_scheduler",
    version: "1.0.0",
    alwaysLoad: true,
    tools: [
      tool("list_schedules", "List schedules for a Discord channel. Omit discord_channel for the current channel.", {
        discord_channel: z.string().optional(),
      }, async ({ discord_channel }) => {
        try {
          const channel = await resolveTargetChannel(context, discord_channel);
          const statuses = scheduleService.getStatuses(channel.id);
          if (!statuses.length) return textResult("No schedules are configured for this channel.");
          return textResult(statuses.map((status) => status.definition
            ? describeSchedule(status.definition)
            : `${status.id}\nDisabled by validation error: ${status.error}`).join("\n\n"));
        } catch (error) {
          return textResult(error instanceof Error ? error.message : String(error), true);
        }
      }),
      tool("create_schedule", "Create a recurring schedule. Use a standard five-field cron expression. Omit timezone to use host local time and omit discord_channel to use the current channel.", {
        name: z.string().min(1).max(100),
        description: z.string().max(500).optional(),
        cron: z.string().min(1),
        discord_channel: z.string().optional(),
        enabled: z.boolean().optional(),
        timezone: z.string().optional(),
        prompt: z.string().min(1),
      }, async (args) => {
        try {
          const channel = await resolveTargetChannel(context, args.discord_channel);
          const created = await scheduleService.create({
            name: args.name, description: args.description, cron: args.cron,
            discordChannel: channel.id, enabled: args.enabled, timezone: args.timezone, prompt: args.prompt,
          });
          return textResult(`Schedule created.\n${describeSchedule(created)}`);
        } catch (error) {
          return textResult(error instanceof Error ? error.message : String(error), true);
        }
      }),
      tool("update_schedule", "Update an existing schedule by its filename ID or exact name. Omitted fields remain unchanged; null removes description or timezone.", {
        schedule: z.string().min(1),
        name: z.string().min(1).max(100).optional(),
        description: z.string().max(500).nullable().optional(),
        cron: z.string().min(1).optional(),
        discord_channel: z.string().optional(),
        enabled: z.boolean().optional(),
        timezone: z.string().nullable().optional(),
        prompt: z.string().min(1).optional(),
      }, async ({ schedule, discord_channel, ...args }) => {
        try {
          await accessibleDefinition(context, schedule);
          const patch: ScheduleUpdateInput = { ...args };
          if (discord_channel !== undefined) patch.discordChannel = (await resolveTargetChannel(context, discord_channel)).id;
          const updated = await scheduleService.update(schedule, patch);
          return textResult(`Schedule updated.\n${describeSchedule(updated)}`);
        } catch (error) {
          return textResult(error instanceof Error ? error.message : String(error), true);
        }
      }),
      tool("delete_schedule", "Permanently delete an existing schedule by its filename ID or exact name.", {
        schedule: z.string().min(1),
      }, async ({ schedule }) => {
        try {
          const definition = await accessibleDefinition(context, schedule);
          await scheduleService.delete(definition.id);
          return textResult(`Deleted schedule ${definition.name} (${definition.id}). Any run already in progress will continue.`);
        } catch (error) {
          return textResult(error instanceof Error ? error.message : String(error), true);
        }
      }),
    ],
  });
}
