import { describe, expect, it, vi } from "vitest";
import type { Guild, SendableChannels } from "discord.js";
import type { BotFileConfig } from "../utils/config.js";
import { discordHistorySchema } from "./history-options.js";
import { DiscordHistoryReader, discordHistoryMcpServerForChannel } from "./tools.js";
import type { DiscordHistory } from "./history.js";

const channelId = "123456789012345678";
function snapshot(): DiscordHistory {
  return {
    start: "2026-10-08T00:00:00.000Z", end: "2026-10-15T00:00:00.000Z", notices: ["Some threads unavailable"],
    channels: [{
      id: channelId, name: "group-discussion", topic: "Project A and Project B", partial: true,
      messages: Array.from({ length: 4 }, (_, i) => ({
        id: String(i), at: "2026-10-10T00:00:00.000Z", author: "Alex", authorId: "user-id", bot: false,
        url: `https://discord.com/channels/guild/channel/${i}`, text: "Progress".repeat(1_000), attachments: [],
      })),
    }],
  };
}

describe("Discord history tool snapshots", () => {
  it("keeps configured exclusions on every collection and passes an exact period to the collector", async () => {
    const collect = vi.fn().mockResolvedValue(snapshot());
    const guild = {} as Guild;
    const excluded = ["100000000000000001"];
    const reader = new DiscordHistoryReader(guild, excluded, collect);
    const options = discordHistorySchema.parse({ excluded_channels: ["100000000000000002"] });
    const result = await reader.fetch(options, "2026-01-01T00:00:00Z", "2026-01-08T00:00:00Z");
    expect(collect).toHaveBeenCalledWith(guild, options, excluded, new Date("2026-01-08T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    expect(result).toMatchObject({
      notices: ["Some threads unavailable"],
      channels: [{ channel_id: channelId, topic: "Project A and Project B", message_count: 4, partial: true }],
    });
    await reader.fetch(discordHistorySchema.parse({}));
    expect(collect.mock.calls[1][2]).toEqual(excluded);
  });

  it("pages large transcripts without dropping messages and refuses non-collected channels", async () => {
    const reader = new DiscordHistoryReader({} as Guild, [], vi.fn().mockResolvedValue(snapshot()));
    expect(() => reader.read(channelId, 0, 50)).toThrow(/collect_server_history/);
    await reader.fetch(discordHistorySchema.parse({}));
    expect(reader.read(channelId, 0, 50)).toMatchObject({
      untrusted: true, partial: true, next_offset: 2,
    });
    const first = reader.read(channelId, 0, 50) as { messages: Array<{ id: string }> };
    const second = reader.read(channelId, 2, 50) as { messages: Array<{ id: string }>; next_offset: number | null };
    expect([...first.messages, ...second.messages].map((message) => message.id)).toEqual(["0", "1", "2", "3"]);
    expect(second.next_offset).toBeNull();
    expect(() => reader.read("excluded-channel", 0, 50)).toThrow(/excluded or inaccessible/);
    expect(() => reader.read(channelId, 99, 50)).toThrow(/offset/);
    const independent = new DiscordHistoryReader({} as Guild, [], vi.fn().mockResolvedValue(snapshot()));
    expect(() => independent.read(channelId, 0, 50)).toThrow(/collect_server_history/);
  });

  it("rejects invalid windows and never exposes a stale snapshot after a failed replacement", async () => {
    const collect = vi.fn().mockResolvedValueOnce(snapshot()).mockRejectedValue(new Error("Could not fetch"));
    const reader = new DiscordHistoryReader({} as Guild, [], collect);
    const options = discordHistorySchema.parse({});
    await reader.fetch(options);
    await expect(reader.fetch(options)).rejects.toThrow("Could not fetch");
    expect(() => reader.read(channelId, 0, 50)).toThrow(/collect_server_history/);
    await expect(reader.fetch(options, "2026-01-02T00:00:00Z", "2026-01-01T00:00:00Z")).rejects.toThrow(/since must be before/);
    await expect(reader.fetch(options, "2026-01-01T00:00:00Z", "2026-05-01T00:00:00Z")).rejects.toThrow(/at most 90 days/);
    await expect(reader.fetch(options, undefined, "2999-01-01T00:00:00Z")).rejects.toThrow(/valid past period/);
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it("exposes tools only in exact Admin destinations with a guild, including scheduled turn destinations", () => {
    const config = { access: { admin_channels: [channelId] }, discord_summary: { excluded_channels: [] } } as unknown as BotFileConfig;
    const channel = { id: channelId, guild: {} } as SendableChannels;
    expect(discordHistoryMcpServerForChannel(channel, config)).toMatchObject({ type: "sdk", name: "discord_history" });
    expect(discordHistoryMcpServerForChannel({ id: "100000000000000002", guild: {}, parentId: channelId } as unknown as SendableChannels, config)).toBeUndefined();
    expect(discordHistoryMcpServerForChannel({ id: channelId } as SendableChannels, config)).toBeUndefined();
  });
});
