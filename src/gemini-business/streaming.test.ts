import { describe, expect, it } from 'vitest';
import { GeminiBusinessAPI } from './gemini-business-api.js';
import { ChatCompletionResponse, GeminiBusinessAccount, ToolDefinition } from './types.js';

const mockAccount: GeminiBusinessAccount = {
  name: 'Test Account',
  team_id: 'team-123',
  cookies: { secure_c_ses: 'test', host_c_oses: 'test' },
  csesidx: '1',
  enabled: true,
};

const tools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from disk',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
];

/** handleStreamResponse is private; this is the seam the streaming tests drive. */
interface StreamingAPI {
  handleStreamResponse(
    response: Response,
    model: string,
    tools?: ToolDefinition[]
  ): AsyncIterable<ChatCompletionResponse>;
}

function streamBody(body: string, withTools = true): Promise<ChatCompletionResponse[]> {
  const api = new GeminiBusinessAPI(mockAccount) as unknown as StreamingAPI;
  const response = new Response(body, { headers: { 'Content-Type': 'application/json' } });
  return collect(api.handleStreamResponse(response, 'gemini-2.5-flash', withTools ? tools : []));
}

async function collect(chunks: AsyncIterable<ChatCompletionResponse>): Promise<ChatCompletionResponse[]> {
  const result: ChatCompletionResponse[] = [];
  for await (const chunk of chunks) result.push(chunk);
  return result;
}

/** Element text as the endpoint splits it: one reply per array entry. */
function element(text: string, thought = false, state = 'IN_PROGRESS'): unknown {
  return {
    uToken: 'token',
    streamAssistResponse: {
      answer: { state, replies: [{ groundedContent: { content: { role: 'model', text, thought } } }] },
    },
  };
}

function widgetBody(elements: unknown[]): string {
  return JSON.stringify(elements, null, 2);
}

function deltas(chunks: ChatCompletionResponse[]) {
  return chunks.flatMap((chunk) => chunk.choices[0]?.delta?.tool_calls ?? []);
}

function textOf(chunks: ChatCompletionResponse[]): string {
  return chunks.map((chunk) => chunk.choices[0]?.delta?.content ?? '').join('');
}

function finishReasons(chunks: ChatCompletionResponse[]): (string | null)[] {
  return chunks.map((chunk) => chunk.choices[0]?.finish_reason ?? null).filter((reason) => reason !== null);
}

describe('streaming tool calls', () => {
  it('emits one tool call when the block is split across array elements', async () => {
    // The live endpoint splits a single reply across entries like this.
    const body = widgetBody([
      element('', false),
      element('```tool_call\n{"name": "read_file", "arguments": {"path": "C:/Users/'),
      element('project/package.json"}}\n'),
      element('```\n'),
      element('', false, 'SUCCEEDED'),
    ]);

    const chunks = await streamBody(body);
    const calls = deltas(chunks);

    expect(calls).toHaveLength(1);
    expect(calls[0].function?.name).toBe('read_file');
    expect(JSON.parse(calls[0].function!.arguments!)).toEqual({ path: 'C:/Users/project/package.json' });
    expect(finishReasons(chunks)).toEqual(['tool_calls']);
  });

  it('does not re-emit tool calls from the whole-body fallback', async () => {
    const body = widgetBody([element('```tool_call\n{"name": "read_file", "arguments": {}}\n```')]);
    const chunks = await streamBody(body);

    expect(new Set(deltas(chunks).map((call) => call.id)).size).toBe(1);
    expect(finishReasons(chunks)).toEqual(['tool_calls']);
  });

  it('passes assistant text through and closes with a stop reason', async () => {
    const body = widgetBody([element('Hello '), element('world'), element('', false, 'SUCCEEDED')]);
    const chunks = await streamBody(body);

    expect(textOf(chunks)).toBe('Hello world');
    expect(deltas(chunks)).toEqual([]);
    expect(finishReasons(chunks)).toEqual(['stop']);
  });

  it('keeps code blocks in the text instead of calling an undeclared tool', async () => {
    const body = widgetBody([element('See:\n```json\n{"name": "delete_all", "arguments": {}}\n```')]);
    const chunks = await streamBody(body);

    expect(deltas(chunks)).toEqual([]);
    expect(textOf(chunks)).toContain('delete_all');
    expect(finishReasons(chunks)).toEqual(['stop']);
  });

  it('filters thought replies out of the stream', async () => {
    const body = widgetBody([element('planning…', true), element('Answer')]);
    const chunks = await streamBody(body);

    expect(textOf(chunks)).toBe('Answer');
  });

  it('still parses SSE-framed deployments', async () => {
    const payload = JSON.stringify(element('```tool_call\n{"name": "read_file", "arguments": {"path": "a"}}\n```'));
    const body = `data: ${payload}\n\ndata: [DONE]\n\n`;
    const chunks = await streamBody(body);

    expect(deltas(chunks)).toHaveLength(1);
    expect(finishReasons(chunks)).toEqual(['tool_calls']);
  });

  it('ignores tools when none were declared', async () => {
    const body = widgetBody([element('```tool_call\n{"name": "read_file", "arguments": {}}\n```')]);
    const chunks = await streamBody(body, false);

    expect(deltas(chunks)).toEqual([]);
    expect(textOf(chunks)).toContain('read_file');
    expect(finishReasons(chunks)).toEqual(['stop']);
  });
});

describe('upstream failures inside a 200 body', () => {
  it('throws with the upstream error code, status and message', async () => {
    const body = widgetBody([
      { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'model id: nope is invalid' } },
    ]);

    await expect(streamBody(body)).rejects.toThrow(/400 INVALID_ARGUMENT model id: nope is invalid/);
  });

  it('throws for a FAILED answer instead of reporting an empty success', async () => {
    const failed = {
      streamAssistResponse: { answer: { state: 'FAILED', replies: [] } },
    };

    await expect(streamBody(widgetBody([failed]))).rejects.toThrow(/state FAILED/);
  });

  it('reports skipped chit-chat with its reason', async () => {
    const skipped = {
      streamAssistResponse: {
        answer: { state: 'SKIPPED', replies: [], assistSkippedReasons: ['NON_ASSIST_SEEKING_QUERY_IGNORED'] },
      },
    };

    await expect(streamBody(widgetBody([skipped]))).rejects.toThrow(/SKIPPED \(NON_ASSIST_SEEKING_QUERY_IGNORED\)/);
  });

  it('accepts a legitimate SUCCEEDED answer with no text', async () => {
    const empty = { streamAssistResponse: { answer: { state: 'SUCCEEDED', replies: [{ groundedContent: {} }] } } };
    const chunks = await streamBody(widgetBody([empty]));

    expect(textOf(chunks)).toBe('');
    expect(finishReasons(chunks)).toEqual(['stop']);
  });

  it('reports failures that arrive after a successful text chunk', async () => {
    const body = widgetBody([
      element('partial answer'),
      { error: { code: 500, status: 'INTERNAL', message: 'planner exploded' } },
    ]);

    await expect(streamBody(body)).rejects.toThrow(/500 INTERNAL planner exploded/);
  });
});
