/**
 * Anthropic Messages API <-> internal (OpenAI-compatible) translation.
 *
 * Both dialects share one upstream pipeline: `/v1/messages` bodies are reshaped
 * into `ChatCompletionRequest`, and the widget replies are reshaped back into
 * real Anthropic wire types — `content_block_delta` frames included, so any
 * Anthropic client can parse them.
 *
 * Tool calling rides the existing prompt-emulation protocol: `tool_use` blocks
 * become OpenAI `tool_calls` (ids preserved, so `tool_result.tool_use_id` maps
 * back to `tool_call_id`), and vice versa.
 */

import type {
  AnthropicContentBlock,
  AnthropicImageBlock,
  AnthropicMessage,
  AnthropicMessageResponse,
  AnthropicMessagesRequest,
  AnthropicResponseBlock,
  AnthropicStopReason,
  AnthropicStreamEvent,
  AnthropicTextBlock,
  AnthropicToolChoice,
  AnthropicToolDefinition,
  AnthropicToolResultBlock,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ToolCall,
  ToolChoice,
  ToolDefinition,
} from './types.js';

/** Upstream model used when the client asks for a Claude/other model name. */
export const DEFAULT_ANTHROPIC_MODEL = 'gemini-3.8-flash';

/** Claude/other names -> configured default; `gemini-*` ids and `auto` pass through to mapModelId. */
export function resolveAnthropicModel(requested: string | undefined, defaultModel: string): string {
  if (requested && (requested.startsWith('gemini-') || requested === 'auto')) {
    return requested;
  }
  return defaultModel || DEFAULT_ANTHROPIC_MODEL;
}

export function toChatCompletionRequest(
  req: AnthropicMessagesRequest,
  defaultModel: string
): ChatCompletionRequest {
  const messages: ChatMessage[] = [];

  const system = renderSystem(req.system);
  if (system) {
    messages.push({ role: 'system', content: system });
  }

  for (const message of req.messages ?? []) {
    if (message.role === 'assistant') {
      messages.push(toAssistantMessage(message.content));
    } else {
      messages.push(...toUserMessages(message.content));
    }
  }

  const request: ChatCompletionRequest = {
    model: resolveAnthropicModel(req.model, defaultModel),
    messages,
    stream: req.stream === true,
  };

  if (req.temperature !== undefined) request.temperature = req.temperature;
  if (req.top_p !== undefined) request.top_p = req.top_p;
  if (req.max_tokens !== undefined) request.max_tokens = req.max_tokens;

  const tools = toToolDefinitions(req.tools);
  if (tools.length > 0) {
    request.tools = tools;
  }

  const choice = toToolChoice(req.tool_choice);
  if (choice) {
    request.tool_choice = choice.toolChoice;
    if (choice.parallelToolCalls !== undefined) {
      request.parallel_tool_calls = choice.parallelToolCalls;
    }
  }

  return request;
}

function renderSystem(system: AnthropicMessagesRequest['system']): string {
  if (typeof system === 'string') {
    return system;
  }
  if (Array.isArray(system)) {
    return system.map((block) => block.text).join('\n\n');
  }
  return '';
}

/** One `text` block, or null when the block is of any other type. */
function textBlock(block: AnthropicContentBlock): AnthropicTextBlock | null {
  return block.type === 'text' && 'text' in block && typeof block.text === 'string' ? block : null;
}

function toAssistantMessage(content: AnthropicMessage['content']): ChatMessage {
  if (typeof content === 'string') {
    return { role: 'assistant', content: content || null };
  }

  const texts: string[] = [];
  const toolCalls: ToolCall[] = [];

  for (const block of content) {
    const text = textBlock(block);
    if (text) {
      texts.push(text.text);
      continue;
    }

    if (block.type === 'tool_use' && 'id' in block && 'name' in block) {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }

  return {
    role: 'assistant',
    content: texts.join('\n') || null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

/**
 * One user turn becomes one user message plus one `tool` message per
 * `tool_result` block, in the order the client sent them.
 */
function toUserMessages(content: AnthropicMessage['content']): ChatMessage[] {
  if (typeof content === 'string') {
    return [{ role: 'user', content }];
  }

  const messages: ChatMessage[] = [];
  let parts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [];

  const flush = () => {
    if (parts.length > 0) {
      messages.push({ role: 'user', content: parts });
      parts = [];
    }
  };

  for (const block of content) {
    const text = textBlock(block);
    if (text) {
      parts.push({ type: 'text', text: text.text });
      continue;
    }

    if (block.type === 'image' && 'source' in block) {
      const url = imageUrl(block.source);
      if (url) {
        parts.push({ type: 'image_url', image_url: { url } });
      }
      continue;
    }

    if (block.type === 'tool_result' && 'tool_use_id' in block) {
      flush();
      messages.push({
        role: 'tool',
        tool_call_id: block.tool_use_id,
        content: renderToolResult(block),
      });
    }
    // `thinking`, `document`, unknown blocks: nothing the upstream prompt has a slot for.
  }

  flush();
  return messages;
}

function imageUrl(source: AnthropicImageBlock['source']): string | null {
  if (source.type === 'url') {
    return source.url;
  }
  return `data:${source.media_type};base64,${source.data}`;
}

/**
 * The upstream prompt protocol has no error channel, so a failed tool result is
 * prefixed literally — otherwise the model would never learn the tool failed.
 */
function renderToolResult(block: AnthropicToolResultBlock): string {
  const content =
    typeof block.content === 'string'
      ? block.content
      : Array.isArray(block.content)
        ? block.content.map((part) => part.text).join('\n')
        : '';

  return block.is_error === true ? `Error: ${content}` : content;
}

function toToolDefinitions(tools: AnthropicToolDefinition[] | undefined): ToolDefinition[] {
  return (tools ?? [])
    .filter((tool) => typeof tool?.name === 'string')
    .map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema ?? {},
      },
    }));
}

function toToolChoice(
  choice: AnthropicToolChoice | undefined
): { toolChoice: ToolChoice; parallelToolCalls?: boolean } | null {
  if (!choice) {
    return null;
  }

  const parallelToolCalls = (variant: { disable_parallel_tool_use?: boolean }) =>
    variant.disable_parallel_tool_use === undefined ? undefined : !variant.disable_parallel_tool_use;

  switch (choice.type) {
    case 'auto':
      return { toolChoice: 'auto', parallelToolCalls: parallelToolCalls(choice) };
    case 'any':
      return { toolChoice: 'required', parallelToolCalls: parallelToolCalls(choice) };
    case 'tool':
      return {
        toolChoice: { type: 'function', function: { name: choice.name } },
        parallelToolCalls: parallelToolCalls(choice),
      };
    case 'none':
      return { toolChoice: 'none' };
    default:
      return null;
  }
}

export function toAnthropicMessage(res: ChatCompletionResponse, model: string): AnthropicMessageResponse {
  const choice = res.choices[0];
  const text = choice?.message?.content ?? null;
  const calls = choice?.message?.tool_calls ?? [];

  const content: AnthropicResponseBlock[] = [];
  if (text) {
    content.push({ type: 'text', text });
  }
  for (const call of calls) {
    content.push({
      type: 'tool_use',
      id: call.id,
      name: call.function.name,
      input: parseArguments(call.function.arguments),
    });
  }

  return {
    id: messageId(),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: toStopReason(choice?.finish_reason ?? null) ?? 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: res.usage?.prompt_tokens ?? 0,
      output_tokens: res.usage?.completion_tokens ?? 0,
    },
  };
}

function parseArguments(argumentsJson: string): unknown {
  try {
    return JSON.parse(argumentsJson);
  } catch {
    return {};
  }
}

function toStopReason(finishReason: string | null): AnthropicStopReason | null {
  switch (finishReason) {
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'stop':
      return 'end_turn';
    default:
      return null;
  }
}

function messageId(): string {
  return `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * State machine over the internal chunk stream.
 *
 * The internal stream delivers each tool call whole (`toToolCallChunk` carries
 * id, name and full arguments) and restarts `delta.tool_calls[].index` at 0 in
 * every frame, so blocks are numbered in arrival order, never by `delta.index`.
 */
export async function* anthropicStreamEvents(
  chunks: AsyncIterable<ChatCompletionResponse>,
  model: string
): AsyncIterable<AnthropicStreamEvent> {
  yield {
    type: 'message_start',
    message: {
      id: messageId(),
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  };

  let index = -1;
  let open: 'text' | null = null;
  let stopReason: AnthropicStopReason | null = null;

  for await (const chunk of chunks) {
    const choice = chunk.choices[0];
    if (!choice) {
      continue;
    }

    const text = choice.delta?.content;
    if (text) {
      if (open !== 'text') {
        index++;
        yield { type: 'content_block_start', index, content_block: { type: 'text', text: '' } };
        open = 'text';
      }
      yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text } };
    }

    for (const call of choice.delta?.tool_calls ?? []) {
      if (open === 'text') {
        yield { type: 'content_block_stop', index };
        open = null;
      }

      index++;
      yield {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: call.id ?? `toolu_${index}`,
          name: call.function?.name ?? '',
          input: {},
        },
      };
      yield {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: call.function?.arguments ?? '{}' },
      };
      yield { type: 'content_block_stop', index };
    }

    if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
      stopReason = toStopReason(choice.finish_reason);
    }
  }

  if (open === 'text') {
    yield { type: 'content_block_stop', index };
  }

  yield {
    type: 'message_delta',
    delta: { stop_reason: stopReason ?? 'end_turn', stop_sequence: null },
    usage: { output_tokens: 0 },
  };
  yield { type: 'message_stop' };
}

/** One Anthropic SSE frame: named event plus its JSON payload. */
export function toAnthropicSSE(event: AnthropicStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
