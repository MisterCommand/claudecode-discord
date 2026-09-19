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

/** Suggested `claude.providers` value for the embedded pool, matching the provider identifier rules. */
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
 * startup sign-in and keeps them in `gemini-accounts.json`. `team_id` records
 * which workspace the capture belongs to, and the pool refuses a capture from
 * any workspace other than the configured `workspace_id`.
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
 * and how the provider is reached.
 */
const ssoSchema = z.strictObject({
  enabled: z.boolean().default(true),
  /** Workforce Identity Federation provider name; defaults to GEMINI_SSO_PROVIDER. */
  provider: trimmedString,
  /** Account name to record for the first capture; defaults to "default". */
  name: trimmedString,
});

const proxyConfigSchema = z.strictObject({
  // The one workspace this deployment serves. Every upstream call and every
  // sign-in targets it, so it is a fixed fact of the deployment rather than
  // something read back from each captured session.
  workspace_id: requiredString,
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

/** Loopback address for a client of a pool bound to every interface. */
function clientHost(host: string): string {
  if (host === "0.0.0.0" || host === "::") return "127.0.0.1";
  // A hostname such as "localhost" is already usable as-is.
  return host;
}

export function geminiBusinessUrl(config: GeminiBusinessConfig): string {
  return `http://${clientHost(config.server.host)}:${config.server.port}`;
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
