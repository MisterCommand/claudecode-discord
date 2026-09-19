/**
 * Account rotation for one upstream chat turn.
 *
 * Kept out of the HTTP layer so `cli.ts` stays thin and the retry policy is
 * unit-testable: pick an account, refresh its session when stale, call upstream,
 * and fail over to the next account on error.
 */

import type { AccountManager } from './account-manager.js';
import { GeminiBusinessAPI, SESSION_TTL_MS } from './gemini-business-api.js';
import type { ChatCompletionRequest, ChatCompletionResponse } from './types.js';

/** Runs one upstream chat turn with account selection, session refresh, retry and failover. */
export async function chatCompletionWithRotation(
  accountManager: AccountManager,
  request: ChatCompletionRequest,
  signal?: AbortSignal
): Promise<ChatCompletionResponse | AsyncIterable<ChatCompletionResponse>> {
  const pool = accountManager.getConfig().pool;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < pool.max_retries; attempt++) {
    const account = accountManager.getNextAccount();
    if (!account) {
      // An empty pool is a configuration problem, not a transient failure.
      throw new Error('No available accounts');
    }

    try {
      const api = new GeminiBusinessAPI(account);

      if (api.needsSessionRefresh()) {
        await api.refreshSession();
        accountManager.updateSession(account.name, account.session_id!, SESSION_TTL_MS);
      }

      const response = await api.chatCompletion(request, signal);
      accountManager.resetAccountErrors(account.name);
      return response;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      accountManager.markAccountError(account.name, errorMessage);
      lastError = error instanceof Error ? error : new Error(errorMessage);

      if (attempt < pool.max_retries - 1) {
        // `Promise.withResolvers` is Node 22+; the supported floor is Node 18.
        await new Promise((resolve) => setTimeout(resolve, pool.retry_delay));
      }
    }
  }

  throw new Error(`Gemini Business API Error after ${pool.max_retries} attempts: ${lastError?.message}`);
}
