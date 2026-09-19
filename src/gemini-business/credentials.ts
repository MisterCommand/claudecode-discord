/**
 * Sign-in credentials for the Gemini Business browser flow.
 *
 * The pool itself is configured in `proxy.yaml`; only the identity-provider
 * secrets live in the environment, so they follow the same rules as every other
 * secret the bot holds: they stay in the bot process and are removed from the
 * Claude subprocess.
 */

export const GEMINI_SSO_EMAIL = "GEMINI_SSO_EMAIL";
export const GEMINI_SSO_PASSWORD = "GEMINI_SSO_PASSWORD";
export const GEMINI_SSO_TOTP_SECRET = "GEMINI_SSO_TOTP_SECRET";
export const GEMINI_SSO_TEAM_ID = "GEMINI_SSO_TEAM_ID";
export const GEMINI_SSO_PROVIDER = "GEMINI_SSO_PROVIDER";

export const GEMINI_SSO_ENVIRONMENT_VARIABLES = [
  GEMINI_SSO_EMAIL,
  GEMINI_SSO_PASSWORD,
  GEMINI_SSO_TOTP_SECRET,
  GEMINI_SSO_TEAM_ID,
  GEMINI_SSO_PROVIDER,
] as const;

export interface GeminiSsoCredentials {
  email?: string;
  password?: string;
  totpSecret?: string;
  teamId?: string;
  provider?: string;
}

/** Credentials the sign-in flow needs, read from the environment. */
export function geminiSsoCredentials(environment: NodeJS.ProcessEnv = process.env): GeminiSsoCredentials {
  return {
    email: environment.GEMINI_SSO_EMAIL?.trim() || undefined,
    password: environment.GEMINI_SSO_PASSWORD || undefined,
    totpSecret: environment.GEMINI_SSO_TOTP_SECRET?.trim() || undefined,
    teamId: environment.GEMINI_SSO_TEAM_ID?.trim() || undefined,
    provider: environment.GEMINI_SSO_PROVIDER?.trim() || undefined,
  };
}

/** Always-claimed keys, so a value exported in the parent shell never reaches an agent turn. */
export function geminiBusinessCredentialEnvironmentOverrides(): NodeJS.ProcessEnv {
  return Object.fromEntries(GEMINI_SSO_ENVIRONMENT_VARIABLES.map((name) => [name, undefined]));
}
