/**
 * In-memory account pool with rotation.
 *
 * Accounts come from `config.ts` and are identified by their configured `name`.
 * Nothing here touches the filesystem: health and session state are process-local.
 */

import type { AppConfig, ConfiguredAccount, GeminiBusinessAccount } from './types.js';

export class AccountManager {
  private readonly config: AppConfig;
  private readonly accounts: GeminiBusinessAccount[];
  private currentIndex = 0;

  constructor(config: AppConfig) {
    this.config = config;
    this.accounts = config.accounts.map((account) => ({
      ...account,
      enabled: account.enabled !== false,
      error_count: 0,
    }));

    const names = new Set<string>();
    for (const account of this.accounts) {
      if (names.has(account.name)) {
        throw new Error(`config.ts: duplicate account name "${account.name}"`);
      }
      names.add(account.name);
    }
  }

  /**
   * Get next available account based on rotation strategy
   */
  getNextAccount(): GeminiBusinessAccount | null {
    const enabledAccounts = this.accounts.filter(acc => acc.enabled);

    if (enabledAccounts.length === 0) {
      console.error('No enabled accounts available');
      return null;
    }

    let account: GeminiBusinessAccount;

    switch (this.config.pool.rotation_strategy) {
      case 'round-robin':
        account = enabledAccounts[this.currentIndex % enabledAccounts.length];
        this.currentIndex++;
        break;

      case 'least-used':
        account = enabledAccounts.reduce((least, current) => {
          const leastUsed = least.last_used || 0;
          const currentUsed = current.last_used || 0;
          return currentUsed < leastUsed ? current : least;
        });
        break;

      case 'random':
        account = enabledAccounts[Math.floor(Math.random() * enabledAccounts.length)];
        break;

      default:
        account = enabledAccounts[0];
    }

    // Update last used timestamp
    account.last_used = Date.now();
    return account;
  }

  /**
   * Mark account as failed; disables it at the configured error threshold
   */
  markAccountError(name: string, error: string): void {
    const account = this.accounts.find(acc => acc.name === name);
    if (!account) return;

    account.error_count = (account.error_count || 0) + 1;
    account.last_error = error;
    console.log(error)

    if (account.error_count >= this.config.pool.error_threshold) {
      account.enabled = false;
      console.warn(`Account ${account.name} (${name}) disabled after ${account.error_count} errors`);
    }
  }

  /**
   * Reset account errors (e.g., after successful request)
   */
  resetAccountErrors(name: string): void {
    const account = this.accounts.find(acc => acc.name === name);
    if (!account) return;

    account.error_count = 0;
    account.last_error = undefined;
  }

  /**
   * Remember the upstream session id issued for this account
   */
  updateSession(name: string, sessionId: string, expiresIn: number): void {
    const account = this.accounts.find(acc => acc.name === name);
    if (!account) return;

    account.session_id = sessionId;
    account.session_expires = Date.now() + expiresIn;
  }

  /**
   * Adopt a fresh capture for an account that was signed in again.
   *
   * The session and JWT minted from the credentials being replaced go with them:
   * they were built from the rejected cookie, so reusing them would rebuild the
   * same failure.
   */
  updateCredentials(name: string, capture: ConfiguredAccount): void {
    const account = this.accounts.find(acc => acc.name === name);
    if (!account) return;

    account.team_id = capture.team_id;
    account.cookies = capture.cookies;
    account.csesidx = capture.csesidx;
    account.user_agent = capture.user_agent;
    account.session_id = undefined;
    account.session_expires = undefined;
    account.cached_jwt = undefined;
    account.cached_jwt_expires = undefined;
  }

  /**
   * Get all accounts
   */
  getAccounts(): GeminiBusinessAccount[] {
    return this.accounts;
  }

  /**
   * Get config
   */
  getConfig(): AppConfig {
    return this.config;
  }
}
