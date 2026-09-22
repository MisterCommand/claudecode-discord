import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiBusinessAPI, UpstreamRequestRejection } from './gemini-business-api.js';
import { ChatCompletionRequest, GeminiBusinessAccount } from './types.js';

const mockAccount: GeminiBusinessAccount = {
  name: 'Test Account',
  team_id: 'team-123',
  cookies: { secure_c_ses: 'test', host_c_oses: 'test' },
  csesidx: '1',
  enabled: true,
};

// Access private method for testing
function mapModelId(model?: string): string {
  const api = new GeminiBusinessAPI(mockAccount);
  return (api as any).mapModelId(model);
}

function convertToGeminiFormat(model: string): any {
  const api = new GeminiBusinessAPI(mockAccount);
  return (api as any).convertToGeminiFormat(
    { model, messages: [{ role: 'user', content: 'test' }] },
    'session-123'
  );
}

describe('mapModelId', () => {
  it('maps gemini-2.5-flash', () => {
    expect(mapModelId('gemini-2.5-flash')).toBe('gemini-2.5-flash');
  });

  it('maps gemini-2.5-pro', () => {
    expect(mapModelId('gemini-2.5-pro')).toBe('gemini-2.5-pro');
  });

  it('maps gemini-3-flash to preview', () => {
    expect(mapModelId('gemini-3-flash')).toBe('gemini-3-flash-preview');
  });

  it('maps gemini-3.1-pro to preview', () => {
    expect(mapModelId('gemini-3.1-pro')).toBe('gemini-3.1-pro-preview');
  });

  it('maps gemini-3.1-pro-preview as passthrough', () => {
    expect(mapModelId('gemini-3.1-pro-preview')).toBe('gemini-3.1-pro-preview');
  });

  it('maps auto to empty string', () => {
    expect(mapModelId('auto')).toBe('');
  });

  it('passes through gemini-3-pro unmapped (removed alias)', () => {
    expect(mapModelId('gemini-3-pro')).toBe('gemini-3-pro');
  });

  it('passes through unknown model names', () => {
    expect(mapModelId('some-future-model')).toBe('some-future-model');
  });

  it('defaults to gemini-2.5-flash when undefined', () => {
    expect(mapModelId(undefined)).toBe('gemini-2.5-flash');
  });
});

describe('convertToGeminiFormat auto-select', () => {
  it('omits modelId when auto is selected', () => {
    const result = convertToGeminiFormat('auto');
    expect(result.streamAssistRequest.assistGenerationConfig).toEqual({});
  });

  it('includes modelId for regular models', () => {
    const result = convertToGeminiFormat('gemini-2.5-pro');
    expect(result.streamAssistRequest.assistGenerationConfig).toEqual({
      modelId: 'gemini-2.5-pro',
    });
  });
});

// Access private method for testing
function convertToOpenAIFormat(data: any, model: string): any {
  const api = new GeminiBusinessAPI(mockAccount);
  return (api as any).convertToOpenAIFormat(data, model);
}

describe('convertToOpenAIFormat', () => {
  it('extracts text from array of stream chunks', () => {
    const data = [
      {
        streamAssistResponse: {
          answer: {
            replies: [
              { groundedContent: { content: { text: 'Hello', thought: false } } },
            ],
          },
        },
      },
      {
        streamAssistResponse: {
          answer: {
            replies: [
              { groundedContent: { content: { text: ' World', thought: false } } },
            ],
          },
        },
      },
    ];

    const result = convertToOpenAIFormat(data, 'gemini-2.5-flash');
    expect(result.choices[0].message.content).toBe('Hello World');
  });

  it('handles single object response (non-array)', () => {
    const data = {
      streamAssistResponse: {
        answer: {
          replies: [
            { groundedContent: { content: { text: 'Single response', thought: false } } },
          ],
        },
      },
    };

    const result = convertToOpenAIFormat(data, 'gemini-2.5-flash');
    expect(result.choices[0].message.content).toBe('Single response');
  });

  it('filters out thought content', () => {
    const data = [
      {
        streamAssistResponse: {
          answer: {
            replies: [
              { groundedContent: { content: { text: 'thinking...', thought: true } } },
              { groundedContent: { content: { text: 'Actual answer', thought: false } } },
            ],
          },
        },
      },
    ];

    const result = convertToOpenAIFormat(data, 'gemini-2.5-pro');
    expect(result.choices[0].message.content).toBe('Actual answer');
  });

  it('returns empty content for unrecognized format', () => {
    const data = { unexpected: 'format' };
    const result = convertToOpenAIFormat(data, 'gemini-2.5-flash');
    expect(result.choices[0].message.content).toBe('');
  });
});

describe('chatCompletion refusal typing', () => {
  /** A stable account with a live session, so only the POST under test runs. */
  function liveApi(): GeminiBusinessAPI {
    const api = new GeminiBusinessAPI({
      ...mockAccount,
      session_id: 'session-123',
      session_expires: Date.now() + 60_000,
      cached_jwt: 'jwt',
      cached_jwt_expires: Date.now() + 60_000,
    });
    return api;
  }

  const request: ChatCompletionRequest = {
    model: 'gemini-3.8-flash',
    messages: [{ role: 'user', content: 'hi' }],
  };

  function respondWith(response: Response): void {
    vi.stubGlobal('fetch', vi.fn(async () => response));
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('types a 400 as a request rejection', async () => {
    respondWith(new Response(
      '[{"error":{"code":400,"status":"INVALID_ARGUMENT","details":[{"reason":"PROMPT_TOO_LARGE"}]}}]',
      { status: 400, statusText: 'Bad Request' },
    ));

    const failure = await liveApi().chatCompletion(request).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(UpstreamRequestRejection);
    expect((failure as Error).message).toContain('PROMPT_TOO_LARGE');
  });

  it('spells out the refusal so the client recognises and recovers from it', async () => {
    // Claude Code classifies such an error as `prompt_too_long` — the branch that
    // compacts the conversation and retries — by matching these two phrases
    // against the lowercased message. An underscored wire code such as
    // PROMPT_TOO_LARGE matches neither, and an unrecognised 400 is surfaced as a
    // dead end instead of being recovered from.
    const lower = (message: string) => message.toLowerCase();
    const isPromptTooLong = (message: string) =>
      lower(message).includes('prompt is too long')
      || lower(message).includes('input length and `max_tokens` exceed context limit');

    respondWith(new Response(
      '[{"error":{"code":400,"status":"INVALID_ARGUMENT","details":[{"reason":"PROMPT_TOO_LARGE"}]}}]',
      { status: 400, statusText: 'Bad Request' },
    ));

    const failure = await liveApi().chatCompletion(request).catch((error: unknown) => error);
    expect(isPromptTooLong((failure as Error).message)).toBe(true);
  });

  it('keeps an account-side failure a plain error, so retry and failover still apply', async () => {
    respondWith(new Response('quota exhausted', { status: 429, statusText: 'Too Many Requests' }));

    const failure = await liveApi().chatCompletion(request).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(UpstreamRequestRejection);
    expect((failure as Error).message).toContain('429');
  });

  it('keeps a server failure a plain error', async () => {
    respondWith(new Response('planner exploded', { status: 500, statusText: 'Internal Server Error' }));

    const failure = await liveApi().chatCompletion(request).catch((error: unknown) => error);
    expect(failure).not.toBeInstanceOf(UpstreamRequestRejection);
  });
});
