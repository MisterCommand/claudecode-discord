/**
 * The `proxy.yaml` schema for the embedded Gemini Business pool.
 *
 * The bot owns this file's location (`BOT_CONFIG_DIR`) and its trust checks,
 * exactly like `config.yaml`; this module only shapes and validates the parsed
 * YAML, so it stays free of filesystem and bot-config imports.
 */

import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";

export const PROXY_CONFIG_FILE_NAME = "proxy.yaml";

/** Provider value the bot injects for the embedded pool, matching the provider identifier rules. */
export const GEMINI_BUSINESS_PROVIDER_VALUE = "gemini-business";

/** Upstream model used for `/v1/messages` requests that do not name a `gemini-*` id. */
export const DEFAULT_GEMINI_BUSINESS_MODEL = "gemini-3.8-flash";

export const DEFAULT_GEMINI_BUSINESS_HOST = "127.0.0.1";
export const DEFAULT_GEMINI_BUSINESS_PORT = 8000;

const trimmedString = z.preprocess(
  (value) => typeof value === "string" ? value.trim() || undefined : value,
  z.string().optional(),
);

const requiredString = z.string()
  .min(1, "must not be empty")
  .refine((value) => value.trim() === value, "must not have surrounding whitespace");

/** `csesidx` is a number in the app URL; an unquoted YAML scalar is accepted and normalized. */
const csesidxSchema = z.preprocess(
  (value) => typeof value === "number" ? String(value) : value,
  requiredString,
);

/**
 * One Gemini Business account as the runtime store persists it.
 *
 * Accounts are never written in `proxy.yaml`: the bot captures them through the
 * startup sign-in and keeps them in `gemini-accounts.json`.
 */
export const configuredAccountSchema = z.strictObject({
  name: requiredString,
  team_id: requiredString,
  cookies: z.strictObject({
    secure_c_ses: requiredString,
    host_c_oses: requiredString,
  }),
  csesidx: csesidxSchema,
  user_agent: trimmedString,
  enabled: z.boolean().default(true),
});

/**
 * Automated re-login at startup.
 *
 * The email, password, and authenticator secret are never written here: they
 * live in the environment, so this section only decides whether the bot signs in
 * and which workspace it targets.
 */
const ssoSchema = z.strictObject({
  enabled: z.boolean().default(true),
  /** Workforce Identity Federation provider name; defaults to GEMINI_SSO_PROVIDER. */
  provider: trimmedString,
  /** Account name to record when no account exists yet; defaults to "default". */
  name: trimmedString,
  /** Workspace id for a brand-new account; defaults to GEMINI_SSO_TEAM_ID. */
  team_id: trimmedString,
});

const proxyConfigSchema = z.strictObject({
  // `server` is required rather than defaulted: a defaulted section bypasses its
  // own inner constraints, and an unvalidated `api_keys` would silently produce
  // an unauthenticated pool that any local process could drive.
  server: z.strictObject({
    host: requiredString.default(DEFAULT_GEMINI_BUSINESS_HOST),
    port: z.coerce.number().int("must be a whole number").min(1, "must be between 1 and 65535")
      .max(65535, "must be between 1 and 65535").default(DEFAULT_GEMINI_BUSINESS_PORT),
    api_keys: z.array(requiredString).min(1, "must list at least one API key"),
    default_model: requiredString.default(DEFAULT_GEMINI_BUSINESS_MODEL),
  }),
  // Tuning only: every default below is valid, so omitting the section is safe.
  pool: z.strictObject({
    rotation_strategy: z.enum(["round-robin", "least-used", "random"], "must be round-robin, least-used, or random")
      .default("round-robin"),
    max_retries: z.coerce.number().int("must be a whole number").min(1, "must be at least 1").default(3),
    retry_delay: z.coerce.number().int("must be a whole number").min(0, "must not be negative").default(1000),
    error_threshold: z.coerce.number().int("must be a whole number").min(1, "must be at least 1").default(3),
  }).default(() => ({
    rotation_strategy: "round-robin" as const,
    max_retries: 3,
    retry_delay: 1000,
    error_threshold: 3,
  })),
  // Optional. Accounts are not configured here: they are captured at startup or
  // by `npm run gemini -- login` and held in the runtime store, because this
  // file is read-only trusted policy the bot must never write.
  sso: ssoSchema.default(() => ({ enabled: true })),
});

export type GeminiBusinessConfig = z.infer<typeof proxyConfigSchema>;

/**
 * Shape of one `/model` choice, duplicated structurally so this module never
 * imports the bot's configuration module back.
 */
export interface ProviderChoice {
  value: string;
  label: string;
  api_key?: string;
  base_url?: string;
  default_model?: string;
}

/** Loopback address for a client of a pool bound to every interface. */
function clientHost(host: string): string {
  if (host === "0.0.0.0" || host === "::") return "127.0.0.1";
  // A hostname such as "localhost" is already usable as-is.
  return host;
}

export function geminiBusinessUrl(config: GeminiBusinessConfig): string {
  return `http://${clientHost(config.server.host)}:${config.server.port}`;
}

/**
 * The `/model` choice for the embedded pool. The operator can override it by
 * declaring the same provider value in `config.yaml`.
 */
export function geminiBusinessProvider(config: GeminiBusinessConfig): ProviderChoice {
  return {
    value: GEMINI_BUSINESS_PROVIDER_VALUE,
    label: "Gemini Business (embedded proxy)",
    api_key: config.server.api_keys[0],
    base_url: geminiBusinessUrl(config),
    default_model: config.server.default_model,
  };
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join(".") || "proxy"}: ${issue.message}`);
}

/**
 * Validate a `proxy.yaml` document. Never throws: the problems are returned so
 * the caller can wrap them in the bot's configuration error.
 */
export function parseProxyConfig(source: string): { config?: GeminiBusinessConfig; problems: string[] } {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length) {
    return { problems: document.errors.map((error) => error.message) };
  }

  const result = proxyConfigSchema.safeParse(document.toJS());
  if (!result.success) {
    return { problems: formatIssues(result.error) };
  }

  return { config: result.data, problems: [] };
}

export function proxyConfigPath(configDirectory: string): string {
  return path.join(configDirectory, PROXY_CONFIG_FILE_NAME);
}

export function proxyConfigExists(configDirectory: string): boolean {
  return fs.existsSync(proxyConfigPath(configDirectory));
}

/**
 * Read and validate `<configDirectory>/proxy.yaml`.
 *
 * Throws a plain `Error` carrying every problem, so both the bot (which wraps
 * it in its configuration error) and the local `login` command can report the
 * same details.
 */
export function readProxyConfig(configDirectory: string): GeminiBusinessConfig {
  const file = proxyConfigPath(configDirectory);
  let source: string;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read ${file}: ${detail}`);
  }

  const { config, problems } = parseProxyConfig(source);
  if (!config) throw new Error(`Invalid ${file}:\n  - ${problems.join("\n  - ")}`);
  return config;
}
