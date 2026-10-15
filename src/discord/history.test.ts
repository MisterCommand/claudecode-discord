import { ChannelType, Collection, PermissionFlagsBits, type Guild, type Message } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { collectDiscordHistory } from "./history.js";
import { discordHistorySchema } from "./history-options.js";

const end = new Date("2026-10-15T00:00:00Z");
const start = new Date("2026-10-08T00:00:00Z");
const botId = "999999999999999999";
function idAt(date: Date, sequence = 0): string {
  return ((BigInt(date.getTime() - 1_420_070_400_000) << 22n) + BigInt(sequence)).toString();
}
function message(date: Date, text: string, sequence = 0, authorBot = false, authorId = "111111111111111111"): Message {
  return {
    id: idAt(date, sequence), createdTimestamp: date.getTime(), createdAt: date,
    author: { id: authorId, displayName: "Alex", bot: authorBot }, member: null,
    content: text, url: `https://discord.com/channels/123/456/${idAt(date, sequence)}`,
    embeds: [], attachments: new Collection(), reference: null,
  } as unknown as Message;
}
function page(messages: Message[]) { return new Collection(messages.map((item) => [item.id, item])); }
function channel(id: string, messages: Message[] = [], extra: Record<string, unknown> = {}) {
  return {
    id, name: `project-${id}`, type: ChannelType.GuildText, parentId: null, parent: null,
    permissionsFor: () => ({ has: () => true }),
    isTextBased: () => true, isThread: () => false,
    messages: { fetch: vi.fn().mockResolvedValue(page(messages)) },
    ...extra,
  };
}
function guild(channels: ReturnType<typeof channel>[], threads: ReturnType<typeof channel>[] = []): Guild {
  return {
    id: "123456789012345678",
    members: { me: { id: botId } },
    channels: {
      fetch: vi.fn().mockResolvedValue(new Collection(channels.map((entry) => [entry.id, entry]))),
      fetchActiveThreads: vi.fn().mockResolvedValue({ threads: new Collection(threads.map((entry) => [entry.id, entry])) }),
    },
  } as unknown as Guild;
}

describe("Discord server history collection", () => {
  it("paginates a fixed period, includes its lower boundary, and orders messages chronologically", async () => {
    const recent = Array.from({ length: 100 }, (_, i) => message(new Date(end.getTime() - 60_000 - i * 1000), `Recent ${i}`));
    const source = channel("123456789012345678");
    source.messages.fetch.mockResolvedValueOnce(page(recent)).mockResolvedValueOnce(page([
      message(start, "Start boundary"), message(new Date(start.getTime() - 1), "Too old"),
    ]));
    const result = await collectDiscordHistory(guild([source]), discordHistorySchema.parse({}), [], end);
    expect(source.messages.fetch).toHaveBeenNthCalledWith(1, { before: idAt(end), limit: 100, cache: false });
    expect(source.messages.fetch).toHaveBeenNthCalledWith(2, expect.objectContaining({ before: recent[99].id }));
    expect(result.channels[0].messages).toHaveLength(101);
    expect(result.channels[0].messages[0].text).toBe("Start boundary");
    expect(result.channels[0].messages.at(-1)?.text).toBe("Recent 0");
    expect(result.channels[0].partial).toBe(false);
  });

  it("always excludes configured IDs and their category/channel descendants, including active threads", async () => {
    const category = channel("100000000000000001", [], { type: ChannelType.GuildCategory, isTextBased: () => false });
    const child = channel("100000000000000002", [], { parentId: category.id, parent: category });
    const thread = channel("100000000000000003", [], { parentId: child.id, parent: child, isThread: () => true, viewable: true });
    const extraExcluded = channel("100000000000000004");
    const visible = channel("100000000000000005");
    const result = await collectDiscordHistory(guild([category, child, extraExcluded, visible], [thread]),
      discordHistorySchema.parse({ excluded_channels: [extraExcluded.id] }), [category.id], end);
    expect(result.channels.map((entry) => entry.id)).toEqual([visible.id]);
    for (const entry of [category, child, thread, extraExcluded]) expect(entry.messages.fetch).not.toHaveBeenCalled();
  });

  it("includes bot-authored project updates by default, with an option for human-only history", async () => {
    const source = channel("123456789012345678", [
      message(new Date(end.getTime() - 1000), "Human", 0),
      message(new Date(end.getTime() - 2000), "Build shipped", 0, true),
      message(new Date(end.getTime() - 3000), "Agent project progress", 0, true, botId),
    ]);
    const result = await collectDiscordHistory(guild([source]), discordHistorySchema.parse({}), [], end);
    expect(result.channels[0].messages.map((entry) => entry.text)).toEqual(["Agent project progress", "Build shipped", "Human"]);
    const humanOnly = await collectDiscordHistory(guild([source]), discordHistorySchema.parse({ include_bots: false }), [], end);
    expect(humanOnly.channels[0].messages.map((entry) => entry.text)).toEqual(["Human"]);
  });

  it("discovers forum posts and archived threads, including joined private archive ID paging", async () => {
    const archived = channel("100000000000000003", [message(start, "Forum progress")], {
      parentId: "100000000000000001", isThread: () => true, viewable: true, archiveTimestamp: end.getTime() - 1000,
    });
    const publicFetch = vi.fn().mockResolvedValue({ threads: new Collection([[archived.id, archived]]), hasMore: false });
    const forum = channel("100000000000000001", [], {
      type: ChannelType.GuildForum, isTextBased: () => false, threads: { fetchArchived: publicFetch },
    });
    const privateThread = channel("100000000000000004", [message(start, "Private progress")], {
      parentId: "100000000000000002", isThread: () => true, viewable: true, archiveTimestamp: null,
    });
    const privateFetch = vi.fn().mockImplementation(async ({ type, before }) => ({
      threads: type === "private" && !before ? new Collection([[privateThread.id, privateThread]]) : new Collection(),
      hasMore: type === "private" && !before,
    }));
    const text = channel("100000000000000002", [], {
      threads: { fetchArchived: privateFetch },
      permissionsFor: () => ({ has: (permission: unknown) => permission !== PermissionFlagsBits.ManageThreads }),
    });
    const result = await collectDiscordHistory(guild([forum, text]), discordHistorySchema.parse({}), [], end);
    expect(result.channels.find((entry) => entry.id === archived.id)?.messages[0].text).toBe("Forum progress");
    expect(result.channels.find((entry) => entry.id === privateThread.id)?.messages[0].text).toBe("Private progress");
    expect(privateFetch).toHaveBeenCalledWith({ type: "private", fetchAll: false, before: privateThread.id, limit: 100 }, false);
  });

  it("skips unreadable channels, retains embed/attachment metadata, and reports partial failures", async () => {
    const unreadable = channel("100000000000000001", [], { permissionsFor: () => ({ has: () => false }) });
    const rich = message(start, "Deployed");
    Object.assign(rich, {
      embeds: [{ title: "Release", description: "Version 2", fields: [{ name: "State", value: "Done" }], url: "https://example.com/release" }],
      attachments: new Collection([["a", { name: "progress.pdf", url: "https://example.com/progress.pdf" }]]),
      reference: { messageId: "100000000000000010" },
    });
    const source = channel("100000000000000002", [rich]);
    const failed = channel("100000000000000003");
    failed.messages.fetch.mockRejectedValue(new Error("Secret upstream error"));
    const result = await collectDiscordHistory(guild([unreadable, source, failed]), discordHistorySchema.parse({}), [], end);
    expect(unreadable.messages.fetch).not.toHaveBeenCalled();
    expect(result.channels[0].messages[0]).toMatchObject({
      text: "Deployed\nRelease\nVersion 2\nState: Done\nhttps://example.com/release",
      attachments: [{ name: "progress.pdf", url: "https://example.com/progress.pdf" }], replyTo: "100000000000000010",
    });
    expect(result.channels[1].partial).toBe(true);
    expect(result.notices.join(" ")).toContain("Read Message History");
    expect(JSON.stringify(result)).not.toContain("Secret upstream error");
  });

  it("reports per-channel limits and uses a caller-specified exact period", async () => {
    const source = channel("100000000000000001", Array.from({ length: 100 }, (_, i) => message(new Date(end.getTime() - 1000), `Update ${i}`, i)));
    const since = new Date(end.getTime() - 3_600_000);
    const result = await collectDiscordHistory(guild([source]), discordHistorySchema.parse({ max_messages_per_channel: 100 }), [], end, since);
    expect(result.start).toBe(since.toISOString());
    expect(result.channels[0].messages).toHaveLength(100);
    expect(result.channels[0].partial).toBe(true);
    expect(result.notices.join(" ")).toContain("partial coverage");
    expect(source.messages.fetch).toHaveBeenCalledOnce();
  });

  it("bounds transcript memory and marks omitted messages as partial coverage", async () => {
    let sequence = 10_000;
    const source = channel("100000000000000001");
    source.messages.fetch.mockImplementation(async () => page(Array.from({ length: 100 }, () =>
      message(new Date(end.getTime() - 1000), "x".repeat(12_000), sequence--))));
    const result = await collectDiscordHistory(guild([source]), discordHistorySchema.parse({}), [], end);
    const bytes = result.channels[0].messages.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item), "utf8"), 0);
    expect(bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(result.channels[0].partial).toBe(true);
    expect(result.notices.join(" ")).toContain("8 MiB transcript limit");
    expect(source.messages.fetch.mock.calls.length).toBeLessThan(10);
  });

  it("bounds archive discovery even if Discord continually returns more threads", async () => {
    let sequence = 0;
    const fetchArchived = vi.fn().mockImplementation(async () => {
      const thread = channel(String(100000000000000000n + BigInt(++sequence)), [], {
        isThread: () => true, viewable: true, archiveTimestamp: end.getTime() - sequence,
      });
      return { threads: new Collection([[thread.id, thread]]), hasMore: true };
    });
    const source = channel("200000000000000001", [], { threads: { fetchArchived } });
    const result = await collectDiscordHistory(guild([source]), discordHistorySchema.parse({}), [], end);
    expect(fetchArchived).toHaveBeenCalledTimes(1_000);
    expect(source.messages.fetch).not.toHaveBeenCalled();
    expect(result.notices.join(" ")).toContain("1,000-page collection limit");
    expect(result.channels.every((entry) => entry.partial)).toBe(true);
  });
});
