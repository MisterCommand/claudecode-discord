import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountManager } from './account-manager.js';
import { UpstreamRequestRejection } from './gemini-business-api.js';
import {
  chatCompletionWithRotation, isSessionExpiredError, MAX_CREDENTIAL_REPAIRS,
  type RotationRecovery, type UpstreamApi,
} from './rotation.js';
import type {
  AppConfig, ChatCompletionRequest, ChatCompletionResponse, ConfiguredAccount, GeminiBusinessAccount,
} from './types.js';

const WORKSPACE = '45e94c0b-fb14-4185-8b4b-5a365c8bc047';

function makeConfig(accounts: AppConfig['accounts'] = [], overrides: Partial<AppConfig['pool']> = {}): AppConfig {
  return {
    server: { host: '127.0.0.1', port: 0, api_keys: ['sk-test'], default_model: 'gemini-3.8-flash' },
    pool: { rotation_strategy: 'round-robin', max_retries: 3, retry_delay: 0, error_threshold: 3, ...overrides },
    accounts,
  };
}

function account(name: string, enabled = true): ConfiguredAccount {
  return {
    name,
    team_id: WORKSPACE,
    cookies: { secure_c_ses: `${name}-ses`, host_c_oses: `${name}-oses` },
    csesidx: name,
    enabled,
  };
}

const captured: ConfiguredAccount = {
  name: 'primary',
  team_id: WORKSPACE,
  cookies: { secure_c_ses: 'CSE.new', host_c_oses: 'COS.new' },
  csesidx: '999',
  user_agent: 'agent/1',
  enabled: true,
};

function completion(text = 'pong'): ChatCompletionResponse {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 0,
    model: 'gemini-3.8-flash',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function request(stream = false): ChatCompletionRequest {
  return { model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'hi' }], stream };
}

/** Assistant text of a whole (non-streaming) rotation result. */
function completionText(result: ChatCompletionResponse | AsyncIterable<ChatCompletionResponse>): string {
  return (result as ChatCompletionResponse).choices[0]?.message?.content ?? '';
}

/** The upstream error this whole path exists for. */
const EXPIRED = 'Chat completion request failed: Gemini Business error: 13 INTERNAL Session has expired';

/**
 * A scripted upstream client: each `chatCompletion` consumes the next outcome.
 * Records how often the session was reissued, which is the cheap repair.
 *
 * An outcome carries a plain `string` (wrapped in an `Error`, as the api layer
 * does for an account-side failure) or a ready `Error` (which is how a refusal
 * arrives, so its type survives to the rotation policy).
 */
function scriptedApi(outcomes: Array<{ error: string | Error } | { text: string }>) {
  const state = { refreshes: 0, calls: 0 };
  const createApi = (): UpstreamApi => ({
    needsSessionRefresh: () => false,
    refreshSession: async () => {
      state.refreshes++;
    },
    chatCompletion: async () => {
      const outcome = outcomes[Math.min(state.calls++, outcomes.length - 1)];
      if ('error' in outcome) throw outcome.error;
      return completion(outcome.text);
    },
  });
  return { state, createApi };
}

/** An API whose session reissue is always rejected: only a sign-in can repair it. */
function deadCookieApi(outcomes: Array<{ error: string } | { text: string }>) {
  const state = { refreshes: 0, calls: 0 };
  const createApi = (): UpstreamApi => ({
    needsSessionRefresh: () => false,
    refreshSession: async () => {
      state.refreshes++;
      throw new Error('JWT retrieval failed: Error: Failed to get XSRF token: 401 Unauthorized');
    },
    chatCompletion: async () => {
      const outcome = outcomes[Math.min(state.calls++, outcomes.length - 1)];
      if ('error' in outcome) throw new Error(outcome.error);
      return completion(outcome.text);
    },
  });
  return { state, createApi };
}

function recovery(result: ConfiguredAccount | null = captured): RotationRecovery & { calls: number } {
  const spy = {
    calls: 0,
    async reauthenticate(): Promise<ConfiguredAccount | null> {
      spy.calls++;
      return result;
    },
  };
  return spy;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isSessionExpiredError', () => {
  it('recognises an expired session reported inside an HTTP 200 body', () => {
    expect(isSessionExpiredError(EXPIRED)).toBe(true);
    expect(isSessionExpiredError('Gemini Business answer state FAILED (SESSION_EXPIRED)')).toBe(true);
  });

  it('recognises a credential rejected while renewing its session', () => {
    expect(isSessionExpiredError('Failed to create session: 403 Forbidden')).toBe(true);
    expect(isSessionExpiredError('Failed to get XSRF token: 401 Unauthorized')).toBe(true);
  });

  it('never matches a failure a sign-in could not fix', () => {
    expect(isSessionExpiredError('Chat completion failed: 429 Too Many Requests')).toBe(false);
    expect(isSessionExpiredError('Gemini Business answer state SKIPPED (QUOTA_EXCEEDED)')).toBe(false);
    expect(isSessionExpiredError('fetch failed')).toBe(false);
    expect(isSessionExpiredError('Chat completion failed: 500 Internal Server Error')).toBe(false);
  });
});

describe('chatCompletionWithRotation credential repair', () => {
  it('reissues the session when upstream rejects it, without opening a browser', async () => {
    const manager = new AccountManager(makeConfig([account('primary')]));
    const { state, createApi } = scriptedApi([{ error: EXPIRED }, { text: 'recovered' }]);
    const recoverySpy = recovery();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await chatCompletionWithRotation(manager, request(), undefined, {
      createApi, recovery: recoverySpy,
    });

    expect(completionText(result)).toBe('recovered');
    expect(state.refreshes).toBe(1);
    expect(recoverySpy.calls).toBe(0);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/issued a new one/);
  });

  it('signs the account in again when the stored cookie itself is rejected', async () => {
    const manager = new AccountManager(makeConfig([account('primary')]));
    const { state, createApi } = deadCookieApi([{ error: EXPIRED }, { text: 'recovered' }]);
    const recoverySpy = recovery();
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await chatCompletionWithRotation(manager, request(), undefined, {
      createApi, recovery: recoverySpy,
    });

    expect(completionText(result)).toBe('recovered');
    expect(state.refreshes).toBe(1);
    expect(recoverySpy.calls).toBe(1);
    // The session minted from the rejected cookie must not survive the sign-in.
    const stored = manager.getAccounts()[0];
    expect(stored.cookies.secure_c_ses).toBe('CSE.new');
    expect(stored.csesidx).toBe('999');
    expect(stored.session_id).toBeUndefined();
  });

  it('reports an actionable re-login when no repair is available', async () => {
    const manager = new AccountManager(makeConfig([account('primary')]));
    const { createApi } = deadCookieApi([{ error: EXPIRED }]);
    const recoverySpy = recovery(null);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(chatCompletionWithRotation(manager, request(), undefined, {
      createApi, recovery: recoverySpy,
    })).rejects.toThrow(/npm run gemini -- login/);
  });

  it('keeps an expiry out of the account error count when a sign-in repairs it', async () => {
    const manager = new AccountManager(makeConfig([account('primary')]));
    const { createApi } = deadCookieApi([{ error: EXPIRED }, { text: 'recovered' }]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await chatCompletionWithRotation(manager, request(), undefined, { createApi, recovery: recovery() });

    const stored = manager.getAccounts()[0];
    expect(stored.error_count).toBe(0);
    expect(stored.enabled).toBe(true);
  });

  it('stops repairing and charges the account after the repairs are exhausted', async () => {
    const manager = new AccountManager(makeConfig([account('primary')]));
    const { state, createApi } = deadCookieApi([{ error: EXPIRED }]);
    const recoverySpy = recovery();
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(chatCompletionWithRotation(manager, request(), undefined, {
      createApi, recovery: recoverySpy,
    })).rejects.toThrow(/after 3 attempts/);

    // Each repair round reissues the session and then signs in, and the round is
    // retried up to MAX_CREDENTIAL_REPAIRS times per attempt — across all three.
    expect(state.refreshes).toBe(MAX_CREDENTIAL_REPAIRS * 3);
    expect(recoverySpy.calls).toBe(MAX_CREDENTIAL_REPAIRS * 3);
  });

  it('fails over to another account when one account cannot be repaired', async () => {
    const manager = new AccountManager(makeConfig([account('broken'), account('healthy')]));
    const api = scriptedApi([{ error: EXPIRED }, { text: 'from healthy' }]);
    // Round-robin hands 'broken' the first attempt; its credential stays dead.
    const createApi = (candidate: GeminiBusinessAccount) =>
      candidate.name === 'broken' ? deadCookieApi([{ error: EXPIRED }]).createApi() : api.createApi();
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await chatCompletionWithRotation(manager, request(), undefined, {
      createApi, recovery: recovery(null),
    });

    expect(completionText(result)).toBe('from healthy');
  });

  it('keeps a non-credential failure on the existing retry and failover path', async () => {
    const manager = new AccountManager(makeConfig([account('primary')]));
    const { state, createApi } = scriptedApi([{ error: 'Chat completion failed: 429 Too Many Requests' }]);
    const recoverySpy = recovery();

    await expect(chatCompletionWithRotation(manager, request(), undefined, {
      createApi, recovery: recoverySpy,
    })).rejects.toThrow(/429/);

    // A rate limit is not repaired: it must not open a browser or reissue a session.
    expect(recoverySpy.calls).toBe(0);
    expect(state.refreshes).toBe(0);
  });
});

describe('chatCompletionWithRotation request refusal', () => {
  /** The refusal the api layer raises for a prompt that outgrew the model window. */
  const TOO_LARGE = () => new UpstreamRequestRejection(
    'Chat completion failed: 400 Bad Request\n[{"error":{"code":400,"message":"Request contains an invalid argument.",'
    + '"status":"INVALID_ARGUMENT","details":[{"reason":"PROMPT_TOO_LARGE"}]}}]',
  );

  it('does not retry, fail over, or charge the account for an oversized prompt', async () => {
    const manager = new AccountManager(makeConfig([account('only')]));
    const { state, createApi } = scriptedApi([{ error: TOO_LARGE() }]);
    const recoverySpy = recovery();

    await expect(chatCompletionWithRotation(manager, request(), undefined, {
      createApi, recovery: recoverySpy,
    })).rejects.toThrow(/PROMPT_TOO_LARGE/);

    // Every account receives the same prompt, so neither a retry nor a sign-in can
    // change the answer: exactly one upstream call, and the account stays healthy.
    expect(state.calls).toBe(1);
    expect(recoverySpy.calls).toBe(0);
    expect(state.refreshes).toBe(0);
    const stored = manager.getAccounts()[0];
    expect(stored.error_count).toBe(0);
    expect(stored.enabled).toBe(true);
  });

  it('keeps the account in rotation for the next turn after a refusal', async () => {
    const manager = new AccountManager(makeConfig([account('only')]));
    const tooLarge = scriptedApi([{ error: TOO_LARGE() }]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(chatCompletionWithRotation(manager, request(), undefined, {
      createApi: tooLarge.createApi,
    })).rejects.toThrow(/PROMPT_TOO_LARGE/);

    // Three refusals used to disable the pool's only account, so the turn after
    // them failed with "No available accounts" instead of serving the request.
    const healthy = scriptedApi([{ text: 'next turn works' }]);
    const result = await chatCompletionWithRotation(manager, request(), undefined, {
      createApi: healthy.createApi,
    });

    expect(completionText(result)).toBe('next turn works');
    expect(manager.getAccounts()[0].enabled).toBe(true);
  });
});

describe('chatCompletionWithRotation streaming repair', () => {
  function chunk(text: string): ChatCompletionResponse {
    return {
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'gemini-3.8-flash',
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
    };
  }

  function streamed(...texts: string[]): AsyncIterable<ChatCompletionResponse> {
    return (async function* () {
      for (const text of texts) yield chunk(text);
    })();
  }

  it('repairs a rejected session before the first frame reaches the client', async () => {
    const manager = new AccountManager(makeConfig([account('primary')]));
    let calls = 0;
    const createApi = (): UpstreamApi => ({
      needsSessionRefresh: () => false,
      refreshSession: async () => {},
      chatCompletion: async () => {
        if (calls++ === 0) throw new Error(EXPIRED);
        return streamed('hello', ' world');
      },
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const stream = await chatCompletionWithRotation(manager, request(true), undefined, {
      createApi, recovery: recovery(),
    }) as AsyncIterable<ChatCompletionResponse>;

    const texts: string[] = [];
    for await (const chunk of stream) texts.push(chunk.choices[0].delta?.content ?? '');
    expect(texts.join('')).toBe('hello world');
    expect(calls).toBe(2);
  });

  it('signs in again and restarts the stream when no frame was sent yet', async () => {
    const manager = new AccountManager(makeConfig([account('primary')]));
    let calls = 0;
    const createApi = (): UpstreamApi => ({
      needsSessionRefresh: () => false,
      refreshSession: async () => {
        throw new Error('Failed to create session: 403 Forbidden');
      },
      chatCompletion: async () => {
        if (calls++ === 0) throw new Error(EXPIRED);
        return streamed('recovered stream');
      },
    });
    const recoverySpy = recovery();
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const stream = await chatCompletionWithRotation(manager, request(true), undefined, {
      createApi, recovery: recoverySpy,
    }) as AsyncIterable<ChatCompletionResponse>;

    const texts: string[] = [];
    for await (const chunk of stream) texts.push(chunk.choices[0].delta?.content ?? '');
    expect(texts.join('')).toBe('recovered stream');
    expect(recoverySpy.calls).toBe(1);
  });

  it('never rewinds a stream that already reached the client', async () => {
    const manager = new AccountManager(makeConfig([account('primary')]));
    let repairsStarted = 0;
    const createApi = (): UpstreamApi => ({
      needsSessionRefresh: () => false,
      refreshSession: async () => {
        repairsStarted++;
        throw new Error('Failed to create session: 403 Forbidden');
      },
      chatCompletion: async () => ({
        async *[Symbol.asyncIterator]() {
          yield chunk('partial');
          throw new Error(EXPIRED);
        },
      }),
    });
    const recoverySpy = recovery();
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const stream = await chatCompletionWithRotation(manager, request(true), undefined, {
      createApi, recovery: recoverySpy,
    }) as AsyncIterable<ChatCompletionResponse>;

    const texts: string[] = [];
    await expect((async () => {
      for await (const chunk of stream) texts.push(chunk.choices[0].delta?.content ?? '');
    })()).rejects.toThrow(/Session has expired/);

    // The duplicate the client would otherwise see never arrives...
    expect(texts.join('')).toBe('partial');

    // ...and the error was not held back for a sign-in: the repair runs detached,
    // so the account is healthy again by the next turn.
    for (let tick = 0; tick < 10 && recoverySpy.calls === 0; tick++) await Promise.resolve();
    expect(repairsStarted).toBe(1);
    expect(recoverySpy.calls).toBe(1);
    expect(manager.getAccounts()[0].cookies.secure_c_ses).toBe('CSE.new');
  });
});
