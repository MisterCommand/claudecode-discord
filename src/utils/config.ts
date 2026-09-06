import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";

const discordIdSchema = z.custom<string>(
  (value) => typeof value === "string" && /^\d{17,20}$/.test(value),
  "must be a quoted 17-20 digit Discord ID",
);
const repositorySchema = z.string()
  .refine((value) => value.trim() === value, "must not have surrounding whitespace")
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]+$/, "must use owner/repository format");
const toolRuleSchema = z.string()
  .min(1, "must not be empty")
  .refine((value) => value.trim() === value, "must not have surrounding whitespace")
  .regex(/^(?:[A-Za-z][A-Za-z0-9_]*(?:\([^()\r\n]+\))?|mcp__[A-Za-z0-9_]+__\*)$/, "must be a valid Claude tool deny rule");

function uniqueStrings(message: string, caseInsensitive = false) {
  return <T extends z.ZodType<string>>(item: T) => z.array(item).superRefine((values, context) => {
    const seen = new Set<string>();
    for (let index = 0; index < values.length; index++) {
      const key = caseInsensitive ? values[index].toLowerCase() : values[index];
      if (seen.has(key)) context.addIssue({ code: "custom", message, path: [index] });
      seen.add(key);
    }
  });
}

const botConfigSchema = z.strictObject({
  version: z.literal(1),
  access: z.strictObject({
    admin_channels: uniqueStrings("duplicate Discord channel ID")(discordIdSchema),
    protected_repositories: uniqueStrings("duplicate protected repository", true)(repositorySchema),
  }),
  tools: z.strictObject({
    denied: uniqueStrings("duplicate tool deny rule", true)(toolRuleSchema),
    restricted_denied: uniqueStrings("duplicate Restricted tool deny rule", true)(toolRuleSchema),
  }),
}).superRefine((config, context) => {
  const globalDenials = new Set(config.tools.denied.map((rule) => rule.toLowerCase()));
  for (let index = 0; index < config.tools.restricted_denied.length; index++) {
    if (globalDenials.has(config.tools.restricted_denied[index].toLowerCase())) {
      context.addIssue({
        code: "custom",
        message: "tool deny rule already applies globally",
        path: ["tools", "restricted_denied", index],
      });
    }
  }
});

const envSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1, "DISCORD_BOT_TOKEN is required"),
  DISCORD_GUILD_ID: z.string().optional(),
  BASE_PROJECT_DIR: z.string().min(1, "BASE_PROJECT_DIR is required"),
  BOT_CONFIG_DIR: z.string().min(1, "BOT_CONFIG_DIR is required"),
  HONEYCOMB_API_KEY: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
  HONEYCOMB_API_ENDPOINT: z
    .enum(["https://api.honeycomb.io", "https://api.eu1.honeycomb.io"])
    .default("https://api.honeycomb.io"),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
  SHOW_COST: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  CLAUDE_MODEL: z
    .string()
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined)),
});

export type BotFileConfig = z.infer<typeof botConfigSchema>;
export type EnvironmentConfig = z.infer<typeof envSchema>;
export type Config = EnvironmentConfig & BotFileConfig & { BOT_CONFIG_FILE: string };

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join(".") || "config"}: ${issue.message}`)
    .join("\n");
}

export function parseEnvironment(environment: NodeJS.ProcessEnv): EnvironmentConfig {
  const result = envSchema.safeParse(environment);
  if (!result.success) throw new ConfigurationError(`Environment configuration error:\n${formatZodError(result.error)}`);
  return result.data;
}

export function parseBotConfig(source: string): BotFileConfig {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length) {
    const details = document.errors.map((error) => `  - ${error.message}`).join("\n");
    throw new ConfigurationError(`YAML configuration error:\n${details}`);
  }

  const result = botConfigSchema.safeParse(document.toJS());
  if (!result.success) throw new ConfigurationError(`Bot configuration error:\n${formatZodError(result.error)}`);
  return result.data;
}

function isWithin(parent: string, candidate: string, platform = process.platform): boolean {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const normalize = (value: string) => platform === "win32" ? value.toLowerCase() : value;
  const relative = pathApi.relative(normalize(pathApi.resolve(parent)), normalize(pathApi.resolve(candidate)));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative));
}

function decodeMountPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

export function isPathOnReadOnlyMount(target: string, mountInfo: string): boolean {
  const resolvedTarget = path.posix.resolve(target);
  let bestMatch: { mountPoint: string; readOnly: boolean } | undefined;

  for (const line of mountInfo.split("\n")) {
    const fields = line.trim().split(" ");
    const separator = fields.indexOf("-");
    if (separator < 6) continue;
    const mountPoint = decodeMountPath(fields[4]);
    if (!isWithin(mountPoint, resolvedTarget, "linux")) continue;
    const readOnly = fields[5].split(",").includes("ro");
    if (!bestMatch || mountPoint.length > bestMatch.mountPoint.length) bestMatch = { mountPoint, readOnly };
  }

  return bestMatch?.readOnly ?? false;
}

function isOnReadOnlyMount(target: string, platform: NodeJS.Platform): boolean {
  if (platform !== "linux") return false;
  try {
    return isPathOnReadOnlyMount(target, fs.readFileSync("/proc/self/mountinfo", "utf8"));
  } catch {
    return false;
  }
}

function assertReadOnly(target: string, stats: fs.Stats, label: string, platform: NodeJS.Platform): void {
  if (isOnReadOnlyMount(target, platform)) return;

  if (platform === "win32") {
    try {
      fs.accessSync(target, fs.constants.W_OK);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM" || code === "EROFS") return;
      throw error;
    }
    throw new ConfigurationError(`${label} must deny write access to the bot process through Windows ACLs: ${target}`);
  }

  const effectiveUserId = process.geteuid?.();
  if (effectiveUserId === 0) {
    throw new ConfigurationError(`${label} cannot be protected from a root bot process unless it is on a read-only mount: ${target}`);
  }
  if (effectiveUserId !== undefined && stats.uid === effectiveUserId) {
    throw new ConfigurationError(`${label} must be owned by a different account so the bot cannot restore write permission: ${target}`);
  }
  if ((stats.mode & 0o222) !== 0) {
    throw new ConfigurationError(`${label} must not have owner, group, or other write bits set: ${target}`);
  }
}

export function assertTrustedConfigLocation(
  configDirectory: string,
  configFile: string,
  baseProjectDirectory: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(configDirectory)) throw new ConfigurationError("BOT_CONFIG_DIR must be an absolute path");
  if (isWithin(baseProjectDirectory, configDirectory, platform)) {
    throw new ConfigurationError(`BOT_CONFIG_DIR must be outside BASE_PROJECT_DIR: ${configDirectory}`);
  }

  let directoryStats: fs.Stats;
  let fileStats: fs.Stats;
  try {
    directoryStats = fs.lstatSync(configDirectory);
    fileStats = fs.lstatSync(configFile);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigurationError(`Cannot inspect required bot configuration: ${detail}`);
  }

  if (directoryStats.isSymbolicLink()) throw new ConfigurationError(`BOT_CONFIG_DIR must not be a symlink or junction: ${configDirectory}`);
  if (!directoryStats.isDirectory()) throw new ConfigurationError(`BOT_CONFIG_DIR is not a directory: ${configDirectory}`);
  if (fileStats.isSymbolicLink()) throw new ConfigurationError(`Bot configuration file must not be a symlink or junction: ${configFile}`);
  if (!fileStats.isFile()) throw new ConfigurationError(`Bot configuration is not a regular file: ${configFile}`);

  const realDirectory = fs.realpathSync(configDirectory);
  const realFile = fs.realpathSync(configFile);
  if (!isWithin(realDirectory, realFile, platform)) throw new ConfigurationError(`Bot configuration file escaped BOT_CONFIG_DIR: ${configFile}`);
  if (fs.existsSync(baseProjectDirectory)) {
    const realBase = fs.realpathSync(baseProjectDirectory);
    if (isWithin(realBase, realDirectory, platform)) {
      throw new ConfigurationError(`BOT_CONFIG_DIR must resolve outside BASE_PROJECT_DIR: ${configDirectory}`);
    }
  }

  assertReadOnly(configDirectory, directoryStats, "BOT_CONFIG_DIR", platform);
  assertReadOnly(configFile, fileStats, "Bot configuration file", platform);
}

let cachedConfig: Config | null = null;

export function loadConfig(): Config {
  if (cachedConfig) return cachedConfig;

  const environment = parseEnvironment(process.env);
  if (!path.isAbsolute(environment.BOT_CONFIG_DIR)) {
    throw new ConfigurationError("BOT_CONFIG_DIR must be an absolute path");
  }
  const configDirectory = path.resolve(environment.BOT_CONFIG_DIR);
  const configFile = path.join(configDirectory, "config.yaml");
  assertTrustedConfigLocation(configDirectory, configFile, environment.BASE_PROJECT_DIR);

  let source: string;
  try {
    source = fs.readFileSync(configFile, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigurationError(`Cannot read required bot configuration: ${detail}`);
  }

  cachedConfig = {
    ...environment,
    ...parseBotConfig(source),
    BOT_CONFIG_DIR: configDirectory,
    BOT_CONFIG_FILE: configFile,
  };
  return cachedConfig;
}

export function getConfig(): Config {
  if (!cachedConfig) return loadConfig();
  return cachedConfig;
}
