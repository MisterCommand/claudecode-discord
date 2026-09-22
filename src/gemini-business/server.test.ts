import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from './server.js';
import { UpstreamRequestRejection } from './gemini-business-api.js';
import type { ChatCompletionRequest, ChatCompletionResponse } from './types.js';

const API_KEY = 'sk-test-123';

function completion(content: string, toolCalls = false): ChatCompletionResponse {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 0,
    model: 'gemini-3.8-flash',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: toolCalls ? null : content,
          ...(toolCalls
            ? { tool_calls: [{ id: 'call_1', type: 'function' as const, function: { name: 'read', arguments: '{}' } }] }
            : {}),
        },
        finish_reason: toolCalls ? 'tool_calls' : 'stop',
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

async function* chunks(): AsyncIterable<ChatCompletionResponse> {
  yield {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'gemini-3.8-flash',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'pong' }, finish_reason: null }],
  };
  yield {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'gemini-3.8-flash',
    choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
  };
}

let running: RunningServer | undefined;
const seen: ChatCompletionRequest[] = [];

afterEach(async () => {
  await running?.close();
  running = undefined;
  seen.length = 0;
});

async function serve(): Promise<string> {
  running = await startServer(
    { host: '127.0.0.1', port: 0, api_keys: [API_KEY], default_model: 'gemini-3.8-flash' },
    {
      chatCompletion: async (request) => {
        seen.push(request);
        return request.stream ? chunks() : completion('pong');
      },
    }
  );
  return `http://127.0.0.1:${running.port}`;
}

function post(base: string, path: string, body: unknown, key?: string) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { 'x-api-key': key } : {}),
    },
    body: JSON.stringify(body),
  });
}

const userTurn = { model: 'claude-sonnet-4-5', max_tokens: 64, messages: [{ role: 'user', content: 'ping' }] };

describe('POST /v1/messages', () => {
  it('answers a non-streaming request in Anthropic format', async () => {
    const base = await serve();
    const response = await post(base, '/v1/messages', userTurn, API_KEY);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');

    const body = await response.json();
    expect(body.type).toBe('message');
    expect(body.role).toBe('assistant');
    expect(body.model).toBe('claude-sonnet-4-5');
    expect(body.content).toEqual([{ type: 'text', text: 'pong' }]);
    expect(body.stop_reason).toBe('end_turn');
    expect(seen[0].model).toBe('gemini-3.8-flash');
  });

  it('ignores query strings, so Claude Code’s ?beta=true routes', async () => {
    const base = await serve();
    const response = await post(base, '/v1/messages?beta=true', userTurn, API_KEY);

    expect(response.status).toBe(200);
    expect((await response.json()).type).toBe('message');
  });

  it('streams named Anthropic events', async () => {
    const base = await serve();
    const response = await post(base, '/v1/messages', { ...userTurn, stream: true }, API_KEY);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const body = await response.text();
    expect(body).toContain('event: message_start');
    expect(body).toContain('event: content_block_delta');
    expect(body).toContain('event: message_delta');

    const frames = body.split('\n\n').filter((frame) => frame.trim() !== '');
    expect(frames.map((frame) => frame.split('\n')[0])).toEqual([
      'event: message_start',
      'event: content_block_start',
      'event: content_block_delta',
      'event: content_block_stop',
      'event: message_delta',
      'event: message_stop',
    ]);
  });

  it('reports a mid-stream upstream failure as an error event', async () => {
    running = await startServer(
      { host: '127.0.0.1', port: 0, api_keys: [], default_model: 'gemini-3.8-flash' },
      {
        chatCompletion: async (request) => {
          if (!request.stream) {
            return completion('pong');
          }
          return (async function* () {
            yield {
              id: 'chatcmpl-1',
              object: 'chat.completion.chunk' as const,
              created: 0,
              model: 'gemini-3.8-flash',
              choices: [{ index: 0, delta: { role: 'assistant', content: 'po' }, finish_reason: null }],
            };
            throw new Error('upstream died');
          })();
        },
      }
    );

    const response = await post(`http://127.0.0.1:${running.port}`, '/v1/messages', {
      ...userTurn,
      stream: true,
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('event: content_block_delta');
    expect(body).toContain('"text":"po"');
    expect(body).toContain('event: error');
    expect(body).toContain('upstream died');
  });

  it('rejects an empty messages array', async () => {
    const base = await serve();
    const response = await post(base, '/v1/messages', {}, API_KEY);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('invalid_request_error');
  });

  it('requires the API key when keys are configured', async () => {
    const base = await serve();

    const missing = await post(base, '/v1/messages', userTurn);
    expect(missing.status).toBe(401);
    expect((await missing.json()).error.type).toBe('authentication_error');

    const wrong = await post(base, '/v1/messages', userTurn, 'sk-nope');
    expect(wrong.status).toBe(401);

    expect((await post(base, '/v1/messages', userTurn, API_KEY)).status).toBe(200);
  });
});

describe('POST /v1/chat/completions', () => {
  it('streams OpenAI chunks terminated by [DONE]', async () => {
    const base = await serve();
    const response = await post(
      base,
      '/v1/chat/completions',
      { model: 'gemini-3.8-flash', stream: true, messages: [{ role: 'user', content: 'ping' }] },
      API_KEY
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"object":"chat.completion.chunk"');
    expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('requires an array of messages', async () => {
    const base = await serve();
    const response = await post(base, '/v1/chat/completions', { model: 'gemini-3.8-flash' }, API_KEY);

    expect(response.status).toBe(400);
    expect((await response.json()).error.type).toBe('invalid_request_error');
  });
});

describe('GET /v1/models', () => {
  it('lists the supported models', async () => {
    const base = await serve();
    const response = await fetch(`${base}/v1/models`, { headers: { 'x-api-key': API_KEY } });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.object).toBe('list');
    expect(body.data.map((model: { id: string }) => model.id)).toContain('gemini-3.8-flash');
  });

  it('requires the API key when keys are configured', async () => {
    const base = await serve();
    expect((await fetch(`${base}/v1/models`)).status).toBe(401);
  });
});

describe('routing', () => {
  it('404s an unknown path', async () => {
    const base = await serve();
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it('reports upstream failures as a 500 in the route dialect', async () => {
    running = await startServer(
      { host: '127.0.0.1', port: 0, api_keys: [], default_model: 'gemini-3.8-flash' },
      {
        chatCompletion: async () => {
          throw new Error('no available accounts');
        },
      }
    );

    const response = await post(`http://127.0.0.1:${running.port}`, '/v1/messages', userTurn);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toEqual({ type: 'api_error', message: 'no available accounts' });
  });

  it('reports a refused request as invalid_request_error so the client can recover', async () => {
    running = await startServer(
      { host: '127.0.0.1', port: 0, api_keys: [], default_model: 'gemini-3.8-flash' },
      {
        chatCompletion: async () => {
          throw new UpstreamRequestRejection('Chat completion failed: 400 Bad Request\nPROMPT_TOO_LARGE');
        },
      }
    );

    const base = `http://127.0.0.1:${running.port}`;
    const response = await post(base, '/v1/messages', userTurn);

    // Claude Code only treats a refusal as a context overflow — and compacts the
    // conversation — when the dialect is invalid_request_error and the message
    // reads as a size problem. An api_error would only be reported as a fault.
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('PROMPT_TOO_LARGE');

    // The OpenAI-dialect route classifies the same failure identically.
    const openai = await post(base, '/v1/chat/completions', {
      model: 'gemini-3.8-flash',
      messages: [{ role: 'user', content: 'ping' }],
    });
    expect(openai.status).toBe(400);
    expect((await openai.json()).error.type).toBe('invalid_request_error');
  });

  it('serves without auth when no keys are configured', async () => {
    running = await startServer(
      { host: '127.0.0.1', port: 0, api_keys: [], default_model: 'gemini-3.8-flash' },
      { chatCompletion: async () => completion('hi') }
    );

    const response = await post(`http://127.0.0.1:${running.port}`, '/v1/messages', userTurn);
    expect(response.status).toBe(200);
  });
});
