import { createHash } from "node:crypto";
import path from "node:path";
import { Cron } from "croner";
import YAML from "yaml";
import { z } from "zod";
import type { ScheduleCreateInput, ScheduleDefinition } from "./types.js";

const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const DISCORD_CHANNEL_ID = /^\d{17,20}$/;

const metadataSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(100, "name must be at most 100 characters"),
  description: z.string().trim().min(1, "description cannot be empty").max(500, "description must be at most 500 characters").optional(),
  cron: z.string().trim().min(1, "cron is required"),
  discord_channel: z.string({ error: "discord_channel must be a quoted Discord channel ID" }).trim()
    .regex(DISCORD_CHANNEL_ID, "discord_channel must be a 17-20 digit Discord channel ID"),
  enabled: z.boolean({ error: "enabled must be true or false" }).default(true),
  timezone: z.string().trim().min(1, "timezone cannot be empty").optional(),
}).strict();

export class ScheduleParseError extends Error {
  constructor(message: string, public readonly discordChannel?: string) {
    super(message);
    this.name = "ScheduleParseError";
  }
}

function hashSource(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function extractFrontMatter(source: string): { metadata: unknown; prompt: string; discordChannel?: string } {
  const input = source.startsWith("\uFEFF") ? source.slice(1) : source;
  const opening = /^---[ \t]*(?:\r?\n)/.exec(input);
  if (!opening) throw new ScheduleParseError("file must begin with YAML front matter delimited by ---");

  const closing = /^---[ \t]*(?:\r?\n|$)/gm;
  closing.lastIndex = opening[0].length;
  const match = closing.exec(input);
  if (!match) throw new ScheduleParseError("YAML front matter is missing its closing --- delimiter");

  const yamlSource = input.slice(opening[0].length, match.index);
  let metadata: unknown;
  try {
    const document = YAML.parseDocument(yamlSource, { uniqueKeys: true });
    if (document.errors.length) throw document.errors[0];
    metadata = document.toJS();
  } catch (error) {
    throw new ScheduleParseError(`invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }

  const raw = metadata && typeof metadata === "object" ? metadata as Record<string, unknown> : {};
  const discordChannel = typeof raw.discord_channel === "string" && DISCORD_CHANNEL_ID.test(raw.discord_channel.trim())
    ? raw.discord_channel.trim() : undefined;
  return { metadata, prompt: input.slice(match.index + match[0].length), discordChannel };
}

export function validateTimezone(timezone: string | undefined): void {
  if (!timezone) return;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error(`timezone must be a valid IANA name, received ${timezone}`);
  }
}

export function createCron(pattern: string, timezone?: string, paused = true): Cron {
  if (pattern.trim().split(/\s+/).length !== 5) {
    throw new Error("cron must use exactly five fields: minute hour day-of-month month day-of-week");
  }
  validateTimezone(timezone);
  try {
    return new Cron(pattern, { timezone, paused, mode: "5-part" });
  } catch (error) {
    throw new Error(`invalid cron expression: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parseScheduleFile(filePath: string, source: string): ScheduleDefinition {
  const fileStem = path.basename(filePath, path.extname(filePath));
  const id = fileStem.toLowerCase();
  if (fileStem !== id || !SAFE_ID.test(id)) {
    throw new ScheduleParseError("filename must use only lowercase letters, numbers, dots, hyphens, or underscores (maximum 64 characters)");
  }

  const sourceHash = hashSource(source);
  let extracted: ReturnType<typeof extractFrontMatter>;
  try {
    extracted = extractFrontMatter(source);
  } catch (error) {
    if (error instanceof ScheduleParseError) throw error;
    throw new ScheduleParseError(error instanceof Error ? error.message : String(error));
  }

  const result = metadataSchema.safeParse(extracted.metadata);
  if (!result.success) {
    const detail = result.error.issues.map((issue) => `${issue.path.join(".") || "front matter"}: ${issue.message}`).join("; ");
    throw new ScheduleParseError(detail, extracted.discordChannel);
  }

  const prompt = extracted.prompt.trim();
  if (!prompt) throw new ScheduleParseError("Markdown prompt body cannot be empty", result.data.discord_channel);
  try {
    const cron = createCron(result.data.cron, result.data.timezone);
    cron.stop();
  } catch (error) {
    throw new ScheduleParseError(error instanceof Error ? error.message : String(error), result.data.discord_channel);
  }

  return {
    id,
    filePath,
    sourceHash,
    name: result.data.name,
    description: result.data.description,
    cron: result.data.cron,
    discordChannel: result.data.discord_channel,
    enabled: result.data.enabled,
    timezone: result.data.timezone,
    prompt,
  };
}

export function serializeSchedule(input: ScheduleCreateInput): string {
  const metadata: Record<string, unknown> = {
    name: input.name.trim(),
  };
  if (input.description?.trim()) metadata.description = input.description.trim();
  metadata.cron = input.cron.trim();
  metadata.discord_channel = input.discordChannel;
  metadata.enabled = input.enabled ?? true;
  if (input.timezone?.trim()) metadata.timezone = input.timezone.trim();
  return `---\n${YAML.stringify(metadata, { lineWidth: 0 }).trimEnd()}\n---\n\n${input.prompt.trim()}\n`;
}

export function scheduleIdFromName(name: string): string {
  const id = name.toLowerCase().trim()
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/g, "");
  if (!id || !SAFE_ID.test(id)) throw new Error("name must contain at least one ASCII letter or number to create a filename");
  return id;
}

export function effectiveTimezone(timezone?: string): string {
  return timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "host local time";
}
