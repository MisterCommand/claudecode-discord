import { ChannelType, PermissionFlagsBits, type Guild, type GuildBasedChannel, type Message } from "discord.js";
import type { DiscordHistoryOptions } from "./history-options.js";

const DISCORD_EPOCH = 1_420_070_400_000;
const MAX_REQUESTS = 1_000;
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

export interface HistoryMessage {
  id: string;
  at: string;
  author: string;
  authorId: string;
  bot: boolean;
  url: string;
  replyTo?: string;
  text: string;
  attachments: Array<{ name: string; url: string }>;
}

export interface ChannelHistory {
  id: string;
  name: string;
  topic?: string | null;
  messages: HistoryMessage[];
  partial: boolean;
}

export interface DiscordHistory {
  start: string;
  end: string;
  channels: ChannelHistory[];
  notices: string[];
}

function snowflakeAt(timestamp: number): string {
  return (BigInt(Math.max(0, Math.floor(timestamp) - DISCORD_EPOCH)) << 22n).toString();
}

function serializeMessage(message: Message): HistoryMessage {
  const embeds = message.embeds.map((embed) => [
    embed.title, embed.description, ...embed.fields.map((field) => `${field.name}: ${field.value}`), embed.url,
  ].filter(Boolean).join("\n")).filter(Boolean);
  return {
    id: message.id,
    at: message.createdAt.toISOString(),
    author: message.member?.displayName ?? message.author.displayName,
    authorId: message.author.id,
    bot: message.author.bot,
    url: message.url,
    replyTo: message.reference?.messageId,
    text: [message.content, ...embeds].filter(Boolean).join("\n"),
    attachments: [...message.attachments.values()].map((attachment) => ({ name: attachment.name, url: attachment.url })),
  };
}

/** Fetch only from this guild; every page is bounded by the same fixed end time. */
export async function collectDiscordHistory(
  guild: Guild,
  options: DiscordHistoryOptions,
  alwaysExcluded: readonly string[],
  end = new Date(),
  start = new Date(end.getTime() - options.lookback_hours * 3_600_000),
): Promise<DiscordHistory> {
  const endMs = end.getTime();
  const startMs = start.getTime();
  const result: DiscordHistory = { start: new Date(startMs).toISOString(), end: end.toISOString(), channels: [], notices: [] };
  const excluded = new Set([...alwaysExcluded, ...options.excluded_channels]);
  const bot = guild.members.me ?? await guild.members.fetchMe();
  const channels = new Map<string, GuildBasedChannel>();
  const available = await guild.channels.fetch();
  for (const channel of available.values()) if (channel) channels.set(channel.id, channel);
  let requests = 0;
  let transcriptBytes = 0;
  let sizeLimited = false;
  const unreadable = new Set<string>();

  function isExcluded(channel: GuildBasedChannel): boolean {
    let current: GuildBasedChannel | undefined = channel;
    const visited = new Set<string>();
    while (current && !visited.has(current.id)) {
      if (excluded.has(current.id)) return true;
      visited.add(current.id);
      if (current.parentId && excluded.has(current.parentId)) return true;
      current = current.parentId ? channels.get(current.parentId) ?? current.parent ?? undefined : undefined;
    }
    return false;
  }

  function readable(channel: GuildBasedChannel): boolean {
    if (isExcluded(channel)) return false;
    const allowed = channel.permissionsFor(bot)?.has([
      PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory,
    ]) === true;
    if (!allowed) unreadable.add(channel.id);
    return allowed;
  }

  try {
    const active = await guild.channels.fetchActiveThreads(false);
    for (const thread of active.threads.values()) channels.set(thread.id, thread);
  } catch {
    result.notices.push("Active thread discovery failed; thread coverage may be incomplete. Check the bot's channel permissions.");
  }

  // A forum/media channel contains posts (threads), rather than its own messages.
  for (const parent of [...channels.values()]) {
    if (!("threads" in parent) || !readable(parent)) continue;
    const types: Array<"public" | "private"> = parent.type === ChannelType.GuildText ? ["public", "private"] : ["public"];
    for (const type of types) {
      const fetchAll = type === "private" && parent.permissionsFor(bot)?.has(PermissionFlagsBits.ManageThreads) === true;
      let before: Date | string | undefined;
      while (requests < MAX_REQUESTS) {
        requests++;
        try {
          const page = await parent.threads.fetchArchived({ type, fetchAll, before, limit: 100 }, false);
          const threads = [...page.threads.values()];
          for (const thread of threads) {
            if (thread.archiveTimestamp === null || thread.archiveTimestamp >= startMs) channels.set(thread.id, thread);
          }
          if (!page.hasMore || !threads.length) break;
          const last = threads[threads.length - 1];
          // Joined private archives use an ID cursor, sorted by ID rather than archive time.
          const next = type === "private" && !fetchAll ? last.id : last.archiveTimestamp ? new Date(last.archiveTimestamp) : undefined;
          const repeated = next instanceof Date && before instanceof Date ? next.getTime() === before.getTime() : next === before;
          if (next === undefined || repeated) {
            result.notices.push(`Archived ${type} thread pagination stopped in channel ${parent.id}; coverage is incomplete.`);
            break;
          }
          if ((type === "public" || fetchAll) && last.archiveTimestamp !== null && last.archiveTimestamp < startMs) break;
          before = next;
        } catch {
          result.notices.push(`Could not list archived ${type} threads in channel ${parent.id}. Check Read Message History and thread access.`);
          break;
        }
      }
    }
  }

  for (const channel of [...channels.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!channel.isTextBased() || !readable(channel)) continue;
    // Some archived/private threads are not visible to the bot; never join or unarchive them.
    if (channel.isThread() && !channel.viewable) { unreadable.add(channel.id); continue; }
    const history: ChannelHistory = {
      id: channel.id,
      name: channel.isThread() ? `${channel.parent?.name ?? channel.parentId}/${channel.name}` : channel.name,
      topic: "topic" in channel ? channel.topic : undefined,
      messages: [], partial: false,
    };
    result.channels.push(history);
    if (requests >= MAX_REQUESTS || transcriptBytes >= MAX_TRANSCRIPT_BYTES) { history.partial = true; continue; }
    let before = snowflakeAt(endMs);
    let scanned = 0;
    try {
      while (requests < MAX_REQUESTS && transcriptBytes < MAX_TRANSCRIPT_BYTES) {
        requests++;
        const limit = Math.min(100, options.max_messages_per_channel - scanned);
        const page = await channel.messages.fetch({ limit, before, cache: false });
        const messages = [...page.values()].sort((a, b) => a.id === b.id ? 0 : BigInt(a.id) > BigInt(b.id) ? -1 : 1);
        if (!messages.length) break;
        for (const message of messages) {
          if (message.createdTimestamp < startMs || message.createdTimestamp >= endMs) continue;
          if (!options.include_bots && message.author.bot) continue;
          const serialized = serializeMessage(message);
          const bytes = Buffer.byteLength(JSON.stringify(serialized), "utf8");
          if (transcriptBytes + bytes > MAX_TRANSCRIPT_BYTES) { history.partial = true; sizeLimited = true; break; }
          history.messages.push(serialized);
          transcriptBytes += bytes;
        }
        scanned += page.size;
        const last = messages[messages.length - 1];
        if (last.createdTimestamp < startMs || page.size < limit) break;
        if (last.id === before || scanned >= options.max_messages_per_channel || requests >= MAX_REQUESTS || transcriptBytes >= MAX_TRANSCRIPT_BYTES || history.partial) {
          history.partial = true;
          if (scanned >= options.max_messages_per_channel) result.notices.push(`Channel ${channel.id} reached the ${options.max_messages_per_channel}-message scan limit. Use a shorter period or increase max_messages_per_channel for fuller coverage.`);
          break;
        }
        before = last.id;
      }
    } catch {
      history.partial = true;
      result.notices.push(`Message history could not be fully fetched for channel ${channel.id}. Check View Channel / Read Message History and retry.`);
    }
    history.messages.reverse();
  }
  if (unreadable.size) result.notices.push(`Skipped ${unreadable.size} channel(s)/thread(s) without history access. Check the bot's View Channel / Read Message History permissions and private thread access.`);
  if (sizeLimited || transcriptBytes >= MAX_TRANSCRIPT_BYTES) result.notices.push("The 8 MiB transcript limit was reached; some messages were omitted. Use a shorter period or more exclusions.");
  if (requests >= MAX_REQUESTS) result.notices.push("The 1,000-page collection limit was reached; some history or threads were omitted. Use a shorter period or more exclusions.");
  if (transcriptBytes >= MAX_TRANSCRIPT_BYTES || result.channels.some((channel) => channel.partial)) {
    result.notices.push("Some channels have partial coverage (message, size, request limit, or retrieval failure). Do not describe this report as exhaustive.");
  }
  return result;
}
