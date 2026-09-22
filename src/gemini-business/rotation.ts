/**
 * Account rotation for one upstream chat turn.
 *
 * Kept out of the HTTP layer so `cli.ts` stays thin and the retry policy is
 * unit-testable: pick an account, refresh its session when stale, call upstream,
 * and fail over to the next account on error.
 *
 * A rejected credential is repaired before it is charged to an account. Upstream
 * reports "Session has expired" while the cookies behind it still look current
 * locally, so the cached session is reissued first and, only when that is not
 * enough, the account is signed in again. A failure that survives repair is what
 * counts toward `pool.error_threshold`, which is what keeps one expiry from
 * taking an account out of rotation for good.
 */

import type { AccountManager } from './account-manager.js';
import { GeminiBusinessAPI, SESSION_TTL_MS, UpstreamRequestRejection } from './gemini-business-api.js';
import type {
  ChatCompletionRequest, ChatCompletionResponse, ConfiguredAccount, GeminiBusinessAccount,
} from './types.js';

/**
 * Upstream's way of saying the session, or the credential behind it, is gone.
 *
 * Deliberately narrow: a quota failure, an overloaded model, or a content
 * refusal must never match, because every match can open a browser sign-in.
 */
export function isSessionExpiredError(message: string): boolean {
  return /session[ _-]*(has[ _-]+)?expired|invalid session|session not found|failed to (get xsrf token|create session): 40[13]|jwt retrieval failed:[\s\S]*40[13]/i.test(
    message,
  );
}

/** Repairs attempted per account, per turn: one session reissue, then one sign-in. */
export const MAX_CREDENTIAL_REPAIRS = 2;

/** The upstream surface rotation needs, so the repair policy tests without a network. */
export interface UpstreamApi {
  needsSessionRefresh(): boolean;
  refreshSession(): Promise<void>;
  chatCompletion(
    request: ChatCompletionRequest,
    signal?: AbortSignal,
  ): Promise<ChatCompletionResponse | AsyncIterable<ChatCompletionResponse>>;
}

/** Signing in again for an account whose stored credential upstream rejected. */
export interface RotationRecovery {
  /**
   * Re-authenticate the account and return the capture to adopt, or null when no
   * sign-in is possible (sign-in disabled, unconfigured, or it failed).
   */
  reauthenticate(account: GeminiBusinessAccount): Promise<ConfiguredAccount | null>;
}

export interface RotationOptions {
  recovery?: RotationRecovery;
  /** Builds the client for one account; injectable so the repair path is testable. */
  createApi?: (account: GeminiBusinessAccount) => UpstreamApi;
}

/** One upstream call, opened: the client it came from and the response it returned. */
interface OpenedTurn {
  api: UpstreamApi;
  response: ChatCompletionResponse | AsyncIterable<ChatCompletionResponse>;
}

// `Promise.withResolvers` is Node 22+; the supported floor is Node 18.
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(messageOf(error));
}

/**
 * Repair one rejected credential, cheapest step first.
 *
 * A session is also refused when it was minted from a credential whose backing
 * ticket has since been renewed, so reissuing it comes before anything opens a
 * browser. When the reissue itself is rejected — upstream refuses the XSRF token
 * or the session creation — the cookie itself is dead and the only repair left is
 * a sign-in. Returns false when no repair is available, so the caller surfaces
 * the upstream failure instead of pretending the account recovered.
 */
async function repairCredential(
  api: UpstreamApi,
  account: GeminiBusinessAccount,
  accountManager: AccountManager,
  options: RotationOptions,
): Promise<boolean> {
  try {
    await api.refreshSession();
    accountManager.updateSession(account.name, account.session_id!, SESSION_TTL_MS);
    console.warn(`Gemini Business session for account "${account.name}" was rejected; issued a new one.`);
    return true;
  } catch (error) {
    if (!isSessionExpiredError(messageOf(error))) throw error;
  }

  const capture = await options.recovery?.reauthenticate(account);
  if (!capture) return false;

  // The session and JWT built from the replaced cookie go with it, so the next
  // attempt mints both from the capture.
  accountManager.updateCredentials(account.name, capture);
  return true;
}

/**
 * Start one upstream call, reissuing a rejected session and re-authenticating a
 * rejected credential until the call opens or the repairs run out.
 *
 * The session refresh that `needsSessionRefresh()` asks for is proactive (the
 * cached session is nearly 50 minutes old); everything here is reactive.
 */
async function openTurn(
  account: GeminiBusinessAccount,
  accountManager: AccountManager,
  request: ChatCompletionRequest,
  signal: AbortSignal | undefined,
  options: RotationOptions,
): Promise<OpenedTurn> {
  const createApi = options.createApi ?? ((candidate) => new GeminiBusinessAPI(candidate));

  for (let repairs = 0; ; repairs++) {
    const api = createApi(account);
    try {
      if (api.needsSessionRefresh()) {
        await api.refreshSession();
        accountManager.updateSession(account.name, account.session_id!, SESSION_TTL_MS);
      }
      return { api, response: await api.chatCompletion(request, signal) };
    } catch (error) {
      if (repairs >= MAX_CREDENTIAL_REPAIRS || !isSessionExpiredError(messageOf(error))) throw error;
      if (!(await repairCredential(api, account, accountManager, options))) throw error;
    }
  }
}

/**
 * The frames of an opened stream, with the same repair applied to a rejection
 * that only arrives inside the response body.
 *
 * A rejection before the first frame is transparent: the credential is repaired
 * and the turn restarts. Once a frame has been forwarded the turn cannot be
 * replayed without duplicating it in the client, so the failure is reported as-is
 * — and the repair runs detached, because making the client wait on a browser
 * sign-in to receive an error helps nobody.
 */
async function* repairedFrames(
  opened: OpenedTurn,
  account: GeminiBusinessAccount,
  accountManager: AccountManager,
  request: ChatCompletionRequest,
  signal: AbortSignal | undefined,
  options: RotationOptions,
): AsyncIterable<ChatCompletionResponse> {
  let repairCount = 0;
  let emitted = false;

  for (;;) {
    try {
      for await (const frame of opened.response as AsyncIterable<ChatCompletionResponse>) {
        emitted = true;
        yield frame;
      }
      return;
    } catch (error) {
      if (repairCount >= MAX_CREDENTIAL_REPAIRS || !isSessionExpiredError(messageOf(error))) throw error;

      if (emitted) {
        void repairCredential(opened.api, account, accountManager, options).catch((repairFailure) => {
          console.warn(`Could not repair Gemini Business account "${account.name}": ${messageOf(repairFailure)}`);
        });
        throw error;
      }

      if (!(await repairCredential(opened.api, account, accountManager, options))) throw error;
      repairCount++;
      opened = await openTurn(account, accountManager, request, signal, options);
    }
  }
}

/** Hands a failure to the account's health, then waits before the next attempt. */
async function failOver(
  accountManager: AccountManager,
  account: GeminiBusinessAccount,
  error: unknown,
  attempt: number,
  maxRetries: number,
  retryDelay: number,
): Promise<Error> {
  const failure = asError(error);
  accountManager.markAccountError(account.name, failure.message);
  if (attempt < maxRetries - 1) await delay(retryDelay);
  return failure;
}

function exhaustedAttempts(maxRetries: number, lastError: Error | undefined, accountName: string): Error {
  const hint = isSessionExpiredError(lastError?.message ?? '')
    ? `\n\n🔑 The stored Gemini Business credentials for "${accountName}" were rejected and could not be renewed.`
      + ' Run `npm run gemini -- login` on the host computer, then try again.'
    : '';
  return new Error(`Gemini Business API Error after ${maxRetries} attempts: ${lastError?.message}${hint}`);
}

/**
 * Runs one upstream chat turn with account selection, credential repair, retry
 * and failover.
 *
 * A streaming turn is opened before returning, so a failure while the call is
 * being established still fails over to another account instead of reaching the
 * client as an error inside an empty stream.
 */
export async function chatCompletionWithRotation(
  accountManager: AccountManager,
  request: ChatCompletionRequest,
  signal?: AbortSignal,
  options: RotationOptions = {},
): Promise<ChatCompletionResponse | AsyncIterable<ChatCompletionResponse>> {
  const pool = accountManager.getConfig().pool;
  const streaming = request.stream === true;
  let lastError: Error | undefined;
  let lastAccountName = '';

  for (let attempt = 0; attempt < pool.max_retries; attempt++) {
    const account = accountManager.getNextAccount();
    if (!account) {
      // An empty pool is a configuration problem, not a transient failure.
      throw new Error('No available accounts');
    }
    lastAccountName = account.name;

    try {
      const opened = await openTurn(account, accountManager, request, signal, options);
      accountManager.resetAccountErrors(account.name);
      return streaming
        ? repairedFrames(opened, account, accountManager, request, signal, options)
        : opened.response as ChatCompletionResponse;
    } catch (error) {
      // Upstream refused the request body, not the account. Every account would
      // refuse the same prompt, so retrying burns the pool's quota and failover
      // charges a healthy account for a defect in the caller's prompt. An
      // unrepaired credential is reported by the api layer as a plain Error and
      // still takes the account-health path below.
      if (error instanceof UpstreamRequestRejection) throw error;
      lastError = await failOver(accountManager, account, error, attempt, pool.max_retries, pool.retry_delay);
    }
  }

  throw exhaustedAttempts(pool.max_retries, lastError, lastAccountName);
}
