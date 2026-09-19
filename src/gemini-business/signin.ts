/**
 * Account sign-in shared by the startup path and `npm run gemini -- login`.
 *
 * One place owns the two-step policy: try the stored cookies first, and only
 * open a browser when they no longer refresh. Startup calls it to keep the pool
 * alive unattended; the CLI calls it for a deliberate capture.
 */

import { BrowserAuth } from "./browser-auth.js";
import { GeminiBusinessAPI } from "./gemini-business-api.js";
import type { ConfiguredAccount, GeminiBusinessAccount } from "./types.js";

/** Bounds a credential check so a stalled network call cannot hold up startup. */
export const DEFAULT_CREDENTIAL_CHECK_TIMEOUT_MS = 45_000;
export const DEFAULT_SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

export interface SignInOptions {
  name: string;
  provider?: string;
  /** The deployment's configured workspace; recorded on the captured account. */
  teamId?: string;
  headless?: boolean;
  timeoutMs?: number;
  log?: (message: string) => void;
}

/** Runtime account shape the API client expects; configured accounts omit the flag when defaulted. */
export function asPoolAccount(account: ConfiguredAccount): GeminiBusinessAccount {
  return { ...account, enabled: account.enabled !== false };
}

export type CredentialCheck = { ok: true } | { ok: false; error: string };

/**
 * Probe stored cookies against upstream. A hung or unreachable network counts as
 * a failure, so the caller falls through to a real sign-in rather than waiting.
 */
export async function checkAccountCredentials(
  account: ConfiguredAccount,
  timeoutMs = DEFAULT_CREDENTIAL_CHECK_TIMEOUT_MS,
): Promise<CredentialCheck> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<CredentialCheck>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: `credential check timed out after ${timeoutMs}ms` }), timeoutMs);
    timer.unref?.();
  });

  try {
    return await Promise.race([
      new GeminiBusinessAPI(asPoolAccount(account)).checkCredentials(),
      expiry,
    ]);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** Run the browser flow and return an account ready to persist. */
export async function signInAccount(options: SignInOptions): Promise<ConfiguredAccount> {
  const log = options.log ?? (() => {});
  const auth = new BrowserAuth({
    name: options.name,
    headless: options.headless ?? true,
    timeout: options.timeoutMs ?? DEFAULT_SIGN_IN_TIMEOUT_MS,
    ...(options.provider || options.teamId ? { sso: { provider: options.provider, teamId: options.teamId } } : {}),
  });

  const credentials = await auth.captureCredentials(log);
  return {
    name: options.name,
    // The configured workspace, not the session's own report: the deployment
    // serves one workspace, and every request is issued against this value.
    team_id: options.teamId ?? credentials.team_id,
    cookies: credentials.cookies,
    csesidx: credentials.csesidx,
    user_agent: credentials.user_agent,
    enabled: true,
  };
}
