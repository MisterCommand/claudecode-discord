import { z } from "zod";

export const summaryChannelIds = z.array(z.string().regex(/^\d{17,20}$/, "must be a quoted Discord channel or category ID"))
  .refine((ids) => new Set(ids).size === ids.length, "duplicate excluded channel ID");

export const discordHistorySchema = z.strictObject({
  lookback_hours: z.number().positive().max(24 * 90).default(168),
  excluded_channels: summaryChannelIds.default([]),
  include_bots: z.boolean().default(true),
  max_messages_per_channel: z.number().int().min(100).max(10_000).default(2_000),
});

export type DiscordHistoryOptions = z.infer<typeof discordHistorySchema>;
