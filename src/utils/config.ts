import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import {
  GEMINI_BUSINESS_PROVIDER_VALUE, geminiBusinessProvider,
  proxyConfigExists, proxyConfigPath, readProxyConfig,
  type GeminiBusinessConfig, type ProviderChoice,
} from "../gemini-business/config.js";

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
const optionalTrimmedString = z.preprocess(
  (value) => typeof value === "string" ? value.trim() || undefined : value,
  z.string().optional(),
);
const optionalEmail = z.preprocess(
  (value) => typeof value === "string" ? value.trim() || undefined : value,
  z.string().email("must be a valid email address").optional(),
);
const optionalPassword = z.preprocess(
  (value) => value === "" ? undefined : value,
  z.string().min(1, "must not be empty").optional(),
);

const claudeModelValueSchema = z.string()
  .min(1, "must not be empty")
  .max(100, "must not exceed 100 characters")
  .refine((value) => value.trim() === value, "must not have surrounding whitespace");

const optionalBaseUrl = z.preprocess(
  (value) => typeof value === "string" ? value.trim() || undefined : value,
  z.string()
    .refine((value) => {
      try {
        const protocol = new URL(value).protocol;
        return protocol === "http:" || protocol === "https:";
      } catch {
        return false;
      }
    }, "must be a valid http:// or https:// URL")
    .transform((value) => value.replace(/\/+$/, ""))
    .optional(),
);

/** Base32 as accepted by the RFC 6238 implementation in the sign-in flow. */
const optionalTotpSecret = z.preprocess(
  (value) => typeof value === "string" ? value.trim() || undefined : value,
  z.string()
    .refine((value) => /^[A-Za-z2-7\s=-]+$/.test(value), "must be a base32 authenticator secret")
    .optional(),
);

const optionalModelValue = z.preprocess(
  (value) => typeof value === "string" ? value.trim() || undefined : value,
  claudeModelValueSchema.optional(),
);

const optionalEffortLevel = z.preprocess(
  (value) => typeof value === "string" ? value.trim().toLowerCase() || undefined : value,
  z.enum(["low", "medium", "high", "xhigh"], "must be one of low, medium, high, or xhigh").optional(),
);

const claudeProviderSchema = z.strictObject({
  value: z.string()
    .min(1, "must not be empty")
    .max(32, "must not exceed 32 characters")
    .regex(/^[a-z0-9][a-z0-9._-]*$/, "must use lowercase letters, digits, dots, dashes, or underscores"),
  label: z.string()
    .min(1, "must not be empty")
    .max(100, "must not exceed 100 characters")
    .refine((value) => value.trim() === value, "must not have surrounding whitespace"),
  api_key: optionalTrimmedString,
  base_url: optionalBaseUrl,
  default_model: optionalModelValue,
  subagent_model: optionalModelValue,
  effort_level: optionalEffortLevel,
});

export type ClaudeProvider = z.infer<typeof claudeProviderSchema>;

const DEFAULT_CLAUDE_PROVIDERS: ClaudeProvider[] = [
  { value: "default", label: "Claude Code default (host login)" },
];

const claudeProvidersSchema = z.array(claudeProviderSchema)
  .min(1, "must list at least one provider")
  .max(25, "Discord accepts at most 25 choices")
  .superRefine((providers, context) => {
    const seen = new Set<string>();
    for (let index = 0; index < providers.length; index++) {
      const key = providers[index].value;
      if (seen.has(key)) context.addIssue({ code: "custom", message: "duplicate provider", path: [index] });
      seen.add(key);
    }
  })
  .default(() => DEFAULT_CLAUDE_PROVIDERS.map((provider) => ({ ...provider })));

const claudeConfigSchema = z.strictObject({
  default_provider: optionalTrimmedString,
  providers: claudeProvidersSchema,
}).superRefine((config, context) => {
  if (config.default_provider !== undefined && !config.providers.some((provider) => provider.value === config.default_provider)) {
    context.addIssue({ code: "custom", message: "must match one of claude.providers values", path: ["default_provider"] });
  }
});

export type ClaudeConfig = z.infer<typeof claudeConfigSchema>;

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
  claude: z.preprocess((value) => value ?? {}, claudeConfigSchema),
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
  EWS_URL: optionalTrimmedString,
  EWS_EMAIL: optionalEmail,
  EWS_PASSWORD: optionalPassword,
  GEMINI_SSO_EMAIL: optionalEmail,
  GEMINI_SSO_PASSWORD: optionalPassword,
  GEMINI_SSO_TOTP_SECRET: optionalTotpSecret,
  GEMINI_SSO_TEAM_ID: optionalTrimmedString,
  GEMINI_SSO_PROVIDER: optionalTrimmedString,
  CHROME_PATH: optionalTrimmedString,
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
}).superRefine((config, context) => {
  const keys = ["EWS_URL", "EWS_EMAIL", "EWS_PASSWORD"] as const;
  const configured = keys.filter((key) => config[key] !== undefined);
  if (configured.length > 0 && configured.length < keys.length) {
    for (const key of keys) {
      if (config[key] === undefined) context.addIssue({
        code: "custom",
        message: `${key} is required when Exchange email retrieval is configured`,
        path: [key],
      });
    }
  }
  if (config.EWS_URL !== undefined) {
    try {
      const url = new URL(config.EWS_URL);
      if (url.protocol !== "https:") throw new Error("not HTTPS");
    } catch {
      context.addIssue({
        code: "custom",
        message: "must be a valid https:// URL",
        path: ["EWS_URL"],
      });
    }
  }

  // Headless sign-in drives the identity-provider form itself, so the email and
  // password are required together and neither is useful alone.
  const ssoKeys = ["GEMINI_SSO_EMAIL", "GEMINI_SSO_PASSWORD"] as const;
  const configuredSso = ssoKeys.filter((key) => config[key] !== undefined);
  if (configuredSso.length > 0 && configuredSso.length < ssoKeys.length) {
    for (const key of ssoKeys) {
      if (config[key] === undefined) context.addIssue({
        code: "custom",
        message: `${key} is required when the Gemini Business sign-in credentials are configured`,
        path: [key],
      });
    }
  }
});

export type BotFileConfig = z.infer<typeof botConfigSchema>;
export type EnvironmentConfig = z.infer<typeof envSchema>;
export type Config = EnvironmentConfig & BotFileConfig & {
  BOT_CONFIG_FILE: string;
  /** Read-only `proxy.yaml` beside `config.yaml`; absent when the pool is not configured. */
  PROXY_CONFIG_FILE: string;
  /** Embedded Gemini Business pool settings, present only when `proxy.yaml` exists. */
  geminiBusiness?: GeminiBusinessConfig;
};

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
  label = "Bot configuration file",
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
  if (fileStats.isSymbolicLink()) throw new ConfigurationError(`${label} must not be a symlink or junction: ${configFile}`);
  if (!fileStats.isFile()) throw new ConfigurationError(`${label} is not a regular file: ${configFile}`);

  const realDirectory = fs.realpathSync(configDirectory);
  const realFile = fs.realpathSync(configFile);
  if (!isWithin(realDirectory, realFile, platform)) throw new ConfigurationError(`${label} escaped BOT_CONFIG_DIR: ${configFile}`);
  if (fs.existsSync(baseProjectDirectory)) {
    const realBase = fs.realpathSync(baseProjectDirectory);
    if (isWithin(realBase, realDirectory, platform)) {
      throw new ConfigurationError(`BOT_CONFIG_DIR must resolve outside BASE_PROJECT_DIR: ${configDirectory}`);
    }
  }

  assertReadOnly(configDirectory, directoryStats, "BOT_CONFIG_DIR", platform);
  assertReadOnly(configFile, fileStats, label, platform);
}

/**
 * Add the embedded Gemini Business pool to the `/model` list.
 *
 * The provider is prepended so it also becomes the default for channels without
 * an override — `proxy.yaml` only exists because an operator asked for it — and
 * an entry with the same `value` in `config.yaml` replaces it entirely.
 */
export function withGeminiBusinessProvider(claude: ClaudeConfig, pool: GeminiBusinessConfig): ClaudeConfig {
  if (claude.providers.some((provider) => provider.value === GEMINI_BUSINESS_PROVIDER_VALUE)) return claude;
  const injected: ProviderChoice = geminiBusinessProvider(pool);
  return { ...claude, providers: [injected, ...claude.providers] };
}

let cachedConfig: Config | null = null;

function assertRetiredEnvironmentVariables(environment: NodeJS.ProcessEnv): void {
  if (environment.CLAUDE_MODEL?.trim()) {
    throw new ConfigurationError(
      "CLAUDE_MODEL is no longer read. Set default_model on a claude.providers entry in config.yaml instead.",
    );
  }
  if (environment.ANTHROPIC_API_KEY?.trim()) {
    console.warn("ANTHROPIC_API_KEY is ignored. Set api_key on a claude.providers entry to use an API key.");
  }
  if (environment.ANTHROPIC_BASE_URL?.trim()) {
    console.warn("ANTHROPIC_BASE_URL is ignored. Set base_url on a claude.providers entry to use a custom endpoint.");
  }
}

export function loadConfig(): Config {
  if (cachedConfig) return cachedConfig;

  const environment = parseEnvironment(process.env);
  assertRetiredEnvironmentVariables(process.env);
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

  const botConfig = parseBotConfig(source);
  const proxyFile = proxyConfigPath(configDirectory);

  // `proxy.yaml` is optional, but when it exists it is trusted policy exactly
  // like `config.yaml`: same ownership and read-only rules, no hot reload.
  let geminiBusiness: GeminiBusinessConfig | undefined;
  if (proxyConfigExists(configDirectory)) {
    assertTrustedConfigLocation(
      configDirectory, proxyFile, environment.BASE_PROJECT_DIR, process.platform, "Proxy configuration file",
    );
    try {
      geminiBusiness = readProxyConfig(configDirectory);
    } catch (error) {
      throw new ConfigurationError(error instanceof Error ? error.message : String(error));
    }
  }

  cachedConfig = {
    ...environment,
    ...botConfig,
    claude: geminiBusiness ? withGeminiBusinessProvider(botConfig.claude, geminiBusiness) : botConfig.claude,
    BOT_CONFIG_DIR: configDirectory,
    BOT_CONFIG_FILE: configFile,
    PROXY_CONFIG_FILE: proxyFile,
    geminiBusiness,
  };
  return cachedConfig;
}

export function getConfig(): Config {
  if (!cachedConfig) return loadConfig();
  return cachedConfig;
}
