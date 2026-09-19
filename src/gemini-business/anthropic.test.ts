import { describe, expect, it } from 'vitest';
import {
  anthropicStreamEvents,
  resolveAnthropicModel,
  toAnthropicMessage,
  toChatCompletionRequest,
} from './anthropic.js';
import type { ChatCompletionResponse } from './types.js';

describe('resolveAnthropicModel', () => {
  it('routes non-Gemini names to the configured default', () => {
    expect(resolveAnthropicModel('claude-sonnet-4-5', 'gemini-3.8-flash')).toBe('gemini-3.8-flash');
    expect(resolveAnthropicModel(undefined, 'gemini-3.8-flash')).toBe('gemini-3.8-flash');
  });

  it('passes gemini ids and auto through', () => {
    expect(resolveAnthropicModel('gemini-3-flash', 'gemini-3.8-flash')).toBe('gemini-3-flash');
    expect(resolveAnthropicModel('auto', 'gemini-3.8-flash')).toBe('auto');
  });
});

describe('toChatCompletionRequest', () => {
  const request = toChatCompletionRequest(
    {
      model: 'claude-sonnet-4-5',
      max_tokens: 256,
      system: [
        { type: 'text', text: 'A' },
        { type: 'text', text: 'B' },
      ],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hi' },
            { type: 'tool_result', tool_use_id: 'call_1', content: 'boom', is_error: true },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'ok' },
            { type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a' } },
          ],
        },
      ],
      tools: [{ name: 'read', input_schema: { type: 'object' } }],
      tool_choice: { type: 'tool', name: 'read', disable_parallel_tool_use: true },
    },
    'gemini-3.8-flash'
  );

  it('maps the model and system prompt', () => {
    expect(request.model).toBe('gemini-3.8-flash');
    expect(request.messages[0]).toEqual({ role: 'system', content: 'A\n\nB' });
    expect(request.max_tokens).toBe(256);
    expect(request.stream).toBe(false);
  });

  it('splits a user turn into a text part and a tool result', () => {
    expect(request.messages[1]).toEqual({ role: 'user', content: [{ type: 'text', text: 'hi' }] });
    expect(request.messages[2]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'Error: boom' });
  });

  it('maps assistant tool_use blocks to tool_calls', () => {
    expect(request.messages[3].tool_calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } },
    ]);
  });

  it('maps tools and a forced tool_choice', () => {
    expect(request.tools).toEqual([
      { type: 'function', function: { name: 'read', parameters: { type: 'object' } } },
    ]);
    expect(request.tool_choice).toEqual({ type: 'function', function: { name: 'read' } });
    expect(request.parallel_tool_calls).toBe(false);
  });
});

describe('toAnthropicMessage', () => {
  it('renders text plus tool_use with a tool_use stop reason', () => {
    const message = toAnthropicMessage(
      {
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 0,
        model: 'gemini-3.8-flash',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'hi',
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      },
      'gemini-3.8-flash'
    );

    expect(message.type).toBe('message');
    expect(message.role).toBe('assistant');
    expect(message.model).toBe('gemini-3.8-flash');
    expect(message.content).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a' } },
    ]);
    expect(message.stop_reason).toBe('tool_use');
    expect(message.stop_sequence).toBeNull();
  });
});

function textChunk(content: string): ChatCompletionResponse {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'gemini-3.8-flash',
    choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
  };
}

function toolCallChunk(id: string, name: string, args: string): ChatCompletionResponse {
  return {
    id: 'chatcmpl-2',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'gemini-3.8-flash',
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }],
        },
        finish_reason: null,
      },
    ],
  };
}

function finishChunk(reason: string): ChatCompletionResponse {
  return {
    id: 'chatcmpl-3',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'gemini-3.8-flash',
    choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: reason }],
  };
}

async function* stream(chunks: ChatCompletionResponse[]): AsyncIterable<ChatCompletionResponse> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

describe('anthropicStreamEvents', () => {
  it('emits a faithful block sequence for text followed by a tool call', async () => {
    const events = [];
    for await (const event of anthropicStreamEvents(
      stream([
        textChunk('He'),
        textChunk('llo'),
        toolCallChunk('call_1', 'read', '{"path":"a"}'),
        finishChunk('tool_calls'),
      ]),
      'gemini-3.8-flash'
    )) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);

    const toolBlock = events[6];
    expect(toolBlock).toEqual({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"path":"a"}' },
    });

    const toolStart = events[5];
    expect(toolStart).toMatchObject({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'call_1', name: 'read' },
    });

    const messageDelta = events[8];
    expect(messageDelta).toMatchObject({
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
    });
  });

  it('ends a text-only turn with end_turn', async () => {
    const events = [];
    for await (const event of anthropicStreamEvents(stream([textChunk('pong'), finishChunk('stop')]), 'm')) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    expect(events[4]).toMatchObject({ delta: { stop_reason: 'end_turn' } });
  });
});
