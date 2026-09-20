/**
 * Lifecycle for the embedded Gemini Business pool.
 *
 * The pool is an in-process HTTP service: `index.ts` starts it before the
 * Discord bot and closes it during shutdown, so one process owns both and the
 * operator sees a single set of logs.
 *
 * Accounts come from the runtime store, where every sign-in captures them, and
 * startup refreshes them: stored cookies are probed first, and a browser runs
 * only when they no longer work. That keeps an unattended bot serving as long as
 * the cookies outlive the process, and repairs itself when they do not.
 */

import { AccountManager } from "./account-manager.js";
import { chatCompletionWithRotation, type RotationRecovery, type UpstreamApi } from "./rotation.js";
import { startServer, type RunningServer } from "./server.js";
import { geminiBusinessUrl, type GeminiBusinessConfig } from "./config.js";
import {
  checkAccountCredentials, signInAccount,
  type CredentialCheck, type SignInOptions,
} from "./signin.js";
import { GeminiAccountStore } from "./account-store.js";
import type { ConfiguredAccount, GeminiBusinessAccount } from "./types.js";

/** Provider name used when neither `proxy.yaml` nor the environment sets one. */
const DEFAULT_SSO_PROVIDER = "locations/global/workforcePools/hkust-saml-pool/providers/entra-id-oidc";

export interface GeminiBusinessPoolOptions {
  /** Where captured accounts are persisted; defaults to the process working directory. */
  dataDirectory?: string;
  /** Sign-in credentials; absent means startup sign-in is skipped. */
  sso?: {
    email?: string;
    password?: string;
    totpSecret?: string;
    provider?: string;
  };
  /**
   * Credential probe, browser sign-in, and upstream client. Injectable so the
   * startup policy — probe first, sign in only on failure — is testable without
   * a network or a browser, exactly like the server's request handler.
   */
  deps?: {
    checkCredentials(account: ConfiguredAccount): Promise<CredentialCheck>;
    signIn(options: SignInOptions): Promise<ConfiguredAccount>;
    createApi?(account: GeminiBusinessAccount): UpstreamApi;
  };
}

const REAL_DEPS: NonNullable<GeminiBusinessPoolOptions["deps"]> = {
  checkCredentials: (account) => checkAccountCredentials(account),
  signIn: (options) => signInAccount(options),
};

export interface RunningGeminiBusinessPool {
  url: string;
  /** Enabled account names in rotation order, after any startup sign-in. */
  accountNames(): string[];
  close(): Promise<void>;
}

/**
 * Re-authentication for a running pool.
 *
 * The startup policy answers "which accounts can serve this run"; this answers
 * the same question mid-run, when upstream rejects a credential that was still
 * accepted when the process started. It shares the startup sign-in path, so one
 * deployment has exactly one way to obtain an account.
 */
interface PoolRecoveryDeps extends GeminiBusinessPoolOptions {
  store: GeminiAccountStore;
  config: GeminiBusinessConfig;
}

/** Opens the browser sign-in for one account, exactly as startup does. */
function signInForAccount(
  config: GeminiBusinessConfig,
  options: GeminiBusinessPoolOptions,
  name: string,
): Promise<ConfiguredAccount> {
  const deps = options.deps ?? REAL_DEPS;
  return deps.signIn({
    name,
    provider: config.sso.provider ?? options.sso?.provider ?? DEFAULT_SSO_PROVIDER,
    teamId: config.workspace_id,
    headless: true,
    log: (message) => console.log(`[gemini-business:${name}] ${message}`),
  });
}

function makeRecovery({ config, store, ...options }: PoolRecoveryDeps): RotationRecovery {
  const ssoConfigured = Boolean(options.sso?.email && options.sso?.password);
  const allowed = config.sso.enabled && ssoConfigured;
  // Concurrent turns can reach the same dead account together; one sign-in
  // serves them all rather than opening a browser per request.
  const inFlight = new Map<string, Promise<ConfiguredAccount | null>>();

  const signIn = async (name: string): Promise<ConfiguredAccount | null> => {
    try {
      const captured = await signInForAccount(config, options, name);
      if (captured.team_id !== config.workspace_id) {
        logSignIn("gemini_business_account_workspace_mismatch", name, {
          captured_workspace: captured.team_id,
          configured_workspace: config.workspace_id,
        });
        return null;
      }
      // One account is one store entry, whatever the sign-in flow reports back.
      const refreshed = { ...captured, name };
      store.save(refreshed);
      logSignIn("gemini_business_account_refreshed", name, { team_id: refreshed.team_id });
      return refreshed;
    } catch (error) {
      const detail = cleanSignInError(error, signInSecrets(options));
      logSignIn("gemini_business_account_sign_in_failed", name, { reason: detail });
      console.warn(
        `Sign-in for Gemini Business account "${name}" failed: ${detail}. `
        + "Run `npm run gemini -- login --no-sso` to sign in by hand.",
      );
      return null;
    }
  };

  return {
    async reauthenticate(account) {
      if (!allowed) {
        const reason = !config.sso.enabled
          ? "startup sign-in is disabled by sso.enabled in proxy.yaml"
          : "set GEMINI_SSO_EMAIL and GEMINI_SSO_PASSWORD to enable automatic sign-in";
        logSignIn("gemini_business_account_expired", account.name, { reason: "credentials rejected" });
        console.warn(
          `Gemini Business credentials for account "${account.name}" were rejected by upstream `
          + `and this pool cannot sign in again (${reason}); it stays in rotation but will keep failing.`,
        );
        return null;
      }

      logSignIn("gemini_business_account_expired", account.name, { reason: "credentials rejected" });
      let pending = inFlight.get(account.name);
      if (!pending) {
        pending = signIn(account.name).finally(() => inFlight.delete(account.name));
        inFlight.set(account.name, pending);
      }
      return pending;
    },
  };
}

function logSignIn(event: string, account: string, detail: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event, account, ...detail }));
}

/**
 * One readable line for a failed sign-in.
 *
 * The flow throws multi-line messages carrying both the reason and a hint; the
 * reason is the part an operator needs. Secrets are stripped first, because a
 * provider error can quote the submitted form value back.
 */
function cleanSignInError(error: unknown, secrets: Array<string | undefined>): string {
  let raw = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret) raw = raw.split(secret).join("[redacted]");
  }
  return raw.split("\n").map((value) => value.trim()).find((value) => value.length > 0) ?? "unknown error";
}

function signInSecrets(options: GeminiBusinessPoolOptions): Array<string | undefined> {
  return [options.sso?.password, options.sso?.email, options.sso?.totpSecret];
}

/**
 * Bring every account to a working credential, signing in where needed.
 *
 * Returns the accounts the pool should serve, with any refreshed entry replacing
 * the stale one in place. A capture is stored under the name that was refreshed,
 * so one account is always one store entry regardless of what the sign-in flow
 * reports back.
 */
async function refreshAccounts(
  accounts: ConfiguredAccount[],
  config: GeminiBusinessConfig,
  options: GeminiBusinessPoolOptions,
): Promise<ConfiguredAccount[]> {
  const store = new GeminiAccountStore(options.dataDirectory);
  const deps = options.deps ?? REAL_DEPS;
  const sso = options.sso;
  const ssoConfigured = Boolean(sso?.email && sso?.password);
  // `proxy.yaml` owns the decision; the environment only supplies the secrets.
  const signInEnabled = config.sso.enabled;

  const result: ConfiguredAccount[] = [];
  for (const account of accounts) {
    if (!account.enabled) {
      result.push(account);
      continue;
    }

    // A capture for another workspace cannot serve this deployment: the tokens
    // and session are workspace-scoped, so reusing it would fail every request.
    // Treat it as missing credentials and capture a fresh account instead.
    const foreignWorkspace = account.team_id !== config.workspace_id;

    let check: CredentialCheck = foreignWorkspace
      ? { ok: false, error: `captured for workspace ${account.team_id}` }
      : { ok: false, error: "not checked" };
    if (!foreignWorkspace) {
      try {
        check = await deps.checkCredentials(account);
      } catch (error) {
        check = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }

    if (check.ok) {
      logSignIn("gemini_business_account_ready", account.name, { source: "stored" });
      result.push(account);
      continue;
    }

    if (foreignWorkspace) {
      logSignIn("gemini_business_account_workspace_mismatch", account.name, {
        captured_workspace: account.team_id,
        configured_workspace: config.workspace_id,
      });
    }

    // Without credentials there is nothing to sign in with, so never open a
    // browser: report what to set and let the upstream failure surface per turn.
    if (!ssoConfigured || !signInEnabled) {
      // A stale cookie may recover on its own, so it stays in rotation. A
      // capture from another workspace never can, so it is dropped instead of
      // failing every turn.
      const reason = !ssoConfigured
        ? "set GEMINI_SSO_EMAIL and GEMINI_SSO_PASSWORD to enable automatic sign-in, or run `npm run gemini -- login` to capture a fresh account"
        : "startup sign-in is disabled by sso.enabled in proxy.yaml";
      if (foreignWorkspace) {
        console.warn(
          `Gemini Business account "${account.name}" was captured for workspace ${account.team_id}, but this deployment serves `
          + `${config.workspace_id}. It is excluded from rotation; ${reason}.`,
        );
        continue;
      }
      console.warn(`Gemini Business account "${account.name}" could not be refreshed (${check.error.split("\n")[0]}); ${reason}.`);
      result.push(account);
      continue;
    }

    logSignIn("gemini_business_account_expired", account.name, { reason: check.error.split("\n")[0] });
    let captured: ConfiguredAccount;
    try {
      captured = await signInForAccount(config, options, account.name);
    } catch (error) {
      // A failed sign-in must not take the bot down: other accounts may still
      // work, and the operator can fix the credentials and restart.
      const detail = cleanSignInError(error, signInSecrets(options));
      logSignIn("gemini_business_account_sign_in_failed", account.name, { reason: detail });
      if (foreignWorkspace) {
        // Keeping it would keep failing every turn for a workspace that can
        // never be reached from this deployment.
        console.warn(
          `Gemini Business account "${account.name}" belongs to workspace ${account.team_id}, not ${config.workspace_id}, `
          + `and re-capturing it failed: ${detail}. It is excluded from rotation.`,
        );
        continue;
      }
      console.warn(
        `Sign-in for Gemini Business account "${account.name}" failed: ${detail}. `
        + "The account keeps its previous credentials; run `npm run gemini -- login --no-sso` to sign in by hand.",
      );
      result.push(account);
      continue;
    }
    // Stored and served under the same name, so one account is one store entry
    // whatever the sign-in flow reports back.
    const refreshed = { ...captured, name: account.name };
    store.save(refreshed);
    logSignIn("gemini_business_account_refreshed", account.name, { team_id: refreshed.team_id });
    result.push(refreshed);
  }

  // No account at all: the sign-in is the only way to get one.
  if (accounts.length === 0) {
    if (!ssoConfigured) {
      throw new Error(
        "No Gemini Business accounts are captured yet and no sign-in credentials are available. "
        + "Set GEMINI_SSO_EMAIL and GEMINI_SSO_PASSWORD (and optionally GEMINI_SSO_TOTP_SECRET) so the bot can sign in at startup, "
        + "or run `npm run gemini -- login` to capture an account by hand.",
      );
    }
    if (!signInEnabled) {
      throw new Error("No Gemini Business accounts are captured yet and startup sign-in is disabled by sso.enabled in proxy.yaml.");
    }

    const name = config.sso.name ?? "default";
    logSignIn("gemini_business_account_expired", name, { reason: "no account configured" });
    let captured: ConfiguredAccount;
    try {
      captured = await signInForAccount(config, options, name);
    } catch (error) {
      // Without an account the pool has nothing to serve, so this is fatal —
      // but the operator gets the provider's own explanation.
      throw new Error(`Gemini Business sign-in failed for "${name}": ${cleanSignInError(error, signInSecrets(options))}`);
    }
    store.save(captured);
    logSignIn("gemini_business_account_refreshed", name, { team_id: captured.team_id });
    result.push(captured);
  }

  return result;
}

/** Start the pool on the address `proxy.yaml` asks for. */
export async function startGeminiBusinessPool(
  config: GeminiBusinessConfig,
  options: GeminiBusinessPoolOptions = {},
): Promise<RunningGeminiBusinessPool> {
  const store = new GeminiAccountStore(options.dataDirectory);
  // The store is the only account source: `proxy.yaml` is read-only policy and
  // never lists accounts.
  const served = await refreshAccounts(store.read(), config, options);

  // The pool's own type only carries the runtime fields it needs.
  const manager = new AccountManager({ ...config, accounts: served });
  const recovery = makeRecovery({ config, store, ...options });
  const running: RunningServer = await startServer(
    {
      host: config.server.host,
      port: config.server.port,
      api_keys: config.server.api_keys,
      default_model: config.server.default_model,
    },
    {
      chatCompletion: (request, signal) => chatCompletionWithRotation(manager, request, signal, {
        recovery,
        ...(options.deps?.createApi ? { createApi: options.deps.createApi } : {}),
      }),
    },
  );

  const url = geminiBusinessUrl(config, running.port);
  const enabled = manager.getAccounts().filter((account) => account.enabled);
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    event: "gemini_business_pool_started",
    url,
    default_model: config.server.default_model,
    accounts: enabled.map((account) => account.name),
    rotation_strategy: config.pool.rotation_strategy,
  }));

  return {
    url,
    accountNames: () => manager.getAccounts().filter((account) => account.enabled).map((account) => account.name),
    close: async () => {
      await running.close();
    },
  };
}
