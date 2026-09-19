import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { AccountManager } from './account-manager.js';
import type { AppConfig } from './types.js';

function makeConfig(accounts: AppConfig['accounts'] = []): AppConfig {
  return {
    server: { host: '127.0.0.1', port: 8000, api_keys: [], default_model: 'gemini-3.8-flash' },
    pool: {
      rotation_strategy: 'round-robin',
      max_retries: 3,
      retry_delay: 1000,
      error_threshold: 3,
    },
    accounts,
  };
}

function account(name: string, enabled?: boolean) {
  return {
    name,
    team_id: `team-${name}`,
    cookies: { secure_c_ses: `${name}-ses`, host_c_oses: `${name}-oses` },
    csesidx: name,
    enabled,
  };
}

describe('AccountManager', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when the pool is empty', () => {
    const manager = new AccountManager(makeConfig());
    expect(manager.getNextAccount()).toBeNull();
  });

  it('rejects duplicate account names', () => {
    expect(() => new AccountManager(makeConfig([account('main'), account('main')]))).toThrow(
      'duplicate account name "main"'
    );
  });

  it('round-robins through enabled accounts', () => {
    const manager = new AccountManager(makeConfig([account('a'), account('b')]));

    expect(manager.getNextAccount()?.name).toBe('a');
    expect(manager.getNextAccount()?.name).toBe('b');
    expect(manager.getNextAccount()?.name).toBe('a');
  });

  it('skips disabled accounts and honours the default enabled state', () => {
    const manager = new AccountManager(makeConfig([account('disabled', false), account('implicit')]));

    const picked = manager.getNextAccount();
    expect(picked?.name).toBe('implicit');
    expect(picked?.enabled).toBe(true);
  });

  it('disables an account once consecutive errors reach the threshold', () => {
    const manager = new AccountManager(makeConfig([account('a'), account('b')]));

    manager.markAccountError('a', 'err 1');
    manager.markAccountError('a', 'err 2');
    expect(manager.getAccounts().find(a => a.name === 'a')?.enabled).toBe(true);

    manager.markAccountError('a', 'err 3');
    expect(manager.getAccounts().find(a => a.name === 'a')?.enabled).toBe(false);
    expect(manager.getAccounts().find(a => a.name === 'a')?.last_error).toBe('err 3');

    // The only remaining enabled account is now 'b'.
    expect(manager.getNextAccount()?.name).toBe('b');
  });

  it('resets error state after a success', () => {
    const manager = new AccountManager(makeConfig([account('a')]));

    manager.markAccountError('a', 'boom');
    manager.resetAccountErrors('a');

    const stored = manager.getAccounts()[0];
    expect(stored.error_count).toBe(0);
    expect(stored.last_error).toBeUndefined();
  });

  it('stores the upstream session per account', () => {
    const manager = new AccountManager(makeConfig([account('a')]));

    manager.updateSession('a', 'session-1', 1000);

    const stored = manager.getAccounts()[0];
    expect(stored.session_id).toBe('session-1');
    expect(stored.session_expires).toBeGreaterThan(Date.now());
  });
});
