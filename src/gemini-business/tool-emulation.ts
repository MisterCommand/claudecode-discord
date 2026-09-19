/**
 * Emulated tool calling for the Gemini Business widget API.
 *
 * `widgetStreamAssist` has no native function calling: `toolsSpec` only exposes
 * web grounding, image and video generation, and `vertexAiSearchSpec`
 * (see GoogleCloudDiscoveryengineV1alphaStreamAssistRequestToolsSpec). Function
 * declarations sent by an OpenAI-compatible client are silently ignored.
 *
 * Arbitrary tools are therefore emulated in the prompt:
 *   - `buildToolPreamble` injects the JSON schemas plus the output protocol;
 *   - `renderToolCalls` / `renderToolResult` replay prior turns in that protocol;
 *   - `ToolCallScanner` parses the fenced `tool_call` blocks the model emits back
 *     into OpenAI `tool_calls`, incrementally so streaming still works.
 *
 * A parsed block is only accepted when its tool name is one of the declared
 * tools, which keeps ordinary ```json code blocks from being mistaken for calls.
 */

import { ToolCall, ToolChoice, ToolDefinition } from './types.js';
import { findJsonValueEnd, isJsonGap } from './json-stream.js';

const FENCE = '```';
const ALT_OPEN = '<tool_call>';
const ALT_CLOSE = '</tool_call>';

/** Fence tags accepted as tool-call wrappers (` ```json ` is what models drift to). */
const TOOL_FENCE_TAGS: Record<string, true> = {
  '': true,
  tool_call: true,
  tool_calls: true,
  tool_call_json: true,
  json: true,
};

const MAX_FENCE_TAG_LENGTH = 24;
/** Give up on a region that never terminates rather than buffering forever. */
const MAX_HELD_REGION_LENGTH = 64 * 1024;

export interface ScanEvents {
  /** Text safe to forward to the client as assistant content. */
  text: string;
  /** Tool calls completed by this scan step. */
  toolCalls: ToolCall[];
}

/**
 * Build the prompt section that teaches the model the tool protocol.
 * Returns an empty string when there are no usable tools.
 */
export function buildToolPreamble(
  tools: ToolDefinition[],
  toolChoice?: ToolChoice,
  parallelToolCalls?: boolean
): string {
  const usable = tools.filter((tool) => tool?.function?.name);
  if (usable.length === 0) {
    return '';
  }

  const mandatory =
    toolChoice === 'required'
      ? 'You MUST call at least one tool in this reply.'
      : typeof toolChoice === 'object' && toolChoice !== null
        ? `You MUST call the tool "${toolChoice.function.name}" in this reply.`
        : '';

  const parallel =
    parallelToolCalls === false
      ? 'Emit at most one tool_call block per reply.'
      : 'To call several tools, emit one block per call, in order, and nothing else.';

  const listing = usable
    .map((tool) =>
      [
        `### ${tool.function.name}`,
        tool.function.description || '(no description)',
        `parameters: ${JSON.stringify(tool.function.parameters ?? { type: 'object', properties: {} })}`,
      ].join('\n')
    )
    .join('\n\n');

  const lines = [
    '# Tool calling',
    'This API has no native function calling, so tool calls MUST be written as text.',
    'To call a tool, reply with a single fenced block and nothing else:',
    '',
    `${FENCE}tool_call`,
    '{"name": "<tool_name>", "arguments": { }}',
    FENCE,
    '',
    parallel,
    'The "arguments" value MUST be a JSON object matching that tool\'s parameters schema.',
    'Never invent a tool name; use only the tools listed below, exactly as written.',
    'A message with role "tool" carries the result of a previous tool call: use it and continue.',
    'When no listed tool is needed, answer normally without any tool_call block.',
  ];

  if (mandatory) {
    lines.push(mandatory);
  }
  lines.push('', '# Tools', listing);

  return lines.join('\n');
}

/** Replay assistant tool calls from conversation history in the prompt protocol. */
export function renderToolCalls(toolCalls: ToolCall[]): string {
  return toolCalls
    .map((call) => {
      const args = normalizeArgumentsValue(call.function.arguments) ?? '{}';
      return [
        `${FENCE}tool_call`,
        `{"name": ${JSON.stringify(call.function.name)}, "arguments": ${args}}`,
        FENCE,
      ].join('\n');
    })
    .join('\n');
}

/** Replay a tool result from conversation history in the prompt protocol. */
export function renderToolResult(content: string, toolCallId?: string, name?: string): string {
  const labels = [
    name ? `name=${name}` : '',
    toolCallId ? `tool_call_id=${toolCallId}` : '',
  ].filter((label) => label !== '');
  return labels.length > 0 ? `Tool result (${labels.join(', ')}):\n${content}` : `Tool result:\n${content}`;
}

/**
 * Incrementally splits model output into assistant text and tool calls.
 * Feeding the whole output in one `push` yields the same result as feeding it
 * byte by byte, so the streaming and non-streaming paths share one parser.
 */
export class ToolCallScanner {
  private readonly allowedNames: Set<string>;
  private buffer = '';
  private completed: ToolCall[] = [];
  private sequence = 0;

  constructor(tools: ToolDefinition[]) {
    this.allowedNames = new Set(
      tools
        .map((tool) => tool?.function?.name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0)
    );
  }

  /** False when no tools were declared — callers can then skip parsing entirely. */
  get enabled(): boolean {
    return this.allowedNames.size > 0;
  }

  push(chunk: string): ScanEvents {
    if (!this.enabled) {
      return { text: chunk, toolCalls: [] };
    }

    this.buffer += chunk;
    return this.scan(false);
  }

  flush(): ScanEvents {
    if (!this.enabled) {
      return { text: '', toolCalls: [] };
    }

    const events = this.scan(true);
    const text = events.text + this.buffer;
    this.buffer = '';
    return { text, toolCalls: events.toolCalls };
  }

  /**
   * Consumes every complete region in the buffer. With `atEnd`, a balanced body
   * whose closing fence may still arrive is accepted instead of waiting.
   */
  private scan(atEnd: boolean): ScanEvents {
    let text = '';

    for (;;) {
      const opening = findOpening(this.buffer);
      if (opening === null) {
        const held = holdbackLength(this.buffer);
        if (this.buffer.length > held) {
          text += this.buffer.slice(0, this.buffer.length - held);
          this.buffer = this.buffer.slice(this.buffer.length - held);
        }
        break;
      }

      const before = this.buffer.slice(0, opening.index);
      const rest = this.buffer.slice(opening.index);
      const region =
        opening.kind === 'fence' ? this.readFenceRegion(rest, atEnd) : this.readAltRegion(rest, atEnd);

      if (region === 'incomplete') {
        break;
      }

      if (region.calls.length > 0) {
        // Whitespace between prose and a call is formatting, not assistant content.
        text += before.replace(/[ \t\r\n]+$/, '');
        this.completed.push(...region.calls);
      } else {
        text += before + rest.slice(0, region.consumed);
      }
      this.buffer = rest.slice(region.consumed);
    }

    return { text, toolCalls: this.takeCompleted() };
  }

  /** Returns how much of the buffer was consumed, or `incomplete` while more input is needed. */
  private readFenceRegion(rest: string, atEnd: boolean): RegionResult | 'incomplete' {
    const newline = rest.indexOf('\n');
    if (newline === -1) {
      return rest.length <= FENCE.length + MAX_FENCE_TAG_LENGTH
        ? 'incomplete'
        : { consumed: FENCE.length, calls: [] };
    }

    const tag = rest.slice(FENCE.length, newline).trim().toLowerCase();
    if (TOOL_FENCE_TAGS[tag] !== true) {
      return { consumed: FENCE.length, calls: [] };
    }

    const bodyStart = newline + 1;
    const closeIndex = rest.indexOf(FENCE, bodyStart);
    const limit = closeIndex === -1 ? rest.length : closeIndex;
    const bodyEnd = findJsonValueEnd(rest, bodyStart, limit);

    if (bodyEnd === -1) {
      return limit - bodyStart > MAX_HELD_REGION_LENGTH
        ? { consumed: FENCE.length, calls: [] }
        : 'incomplete';
    }

    // Without a closing fence, wait while the tail could still become one.
    if (closeIndex === -1 && !atEnd && couldStillClose(rest.slice(bodyEnd), FENCE)) {
      return 'incomplete';
    }

    const calls = this.parseCalls(rest.slice(bodyStart, bodyEnd));
    const regionEnd = closeIndex === -1 ? bodyEnd : closeIndex + FENCE.length;

    return calls.length > 0
      ? { consumed: skipTrailingWhitespace(rest, regionEnd), calls }
      : { consumed: Math.max(bodyEnd, regionEnd), calls: [] };
  }

  private readAltRegion(rest: string, atEnd: boolean): RegionResult | 'incomplete' {
    const bodyStart = ALT_OPEN.length;
    const closeIndex = rest.indexOf(ALT_CLOSE, bodyStart);
    const limit = closeIndex === -1 ? rest.length : closeIndex;
    const bodyEnd = findJsonValueEnd(rest, bodyStart, limit);

    if (bodyEnd === -1) {
      return limit - bodyStart > MAX_HELD_REGION_LENGTH
        ? { consumed: ALT_OPEN.length, calls: [] }
        : 'incomplete';
    }

    if (closeIndex === -1 && !atEnd && couldStillClose(rest.slice(bodyEnd), ALT_CLOSE)) {
      return 'incomplete';
    }

    const calls = this.parseCalls(rest.slice(bodyStart, bodyEnd));
    const regionEnd = closeIndex === -1 ? bodyEnd : closeIndex + ALT_CLOSE.length;

    return calls.length > 0
      ? { consumed: skipTrailingWhitespace(rest, regionEnd), calls }
      : { consumed: Math.max(bodyEnd, regionEnd), calls: [] };
  }

  /** Parses a block body; only calls naming a declared tool are accepted. */
  private parseCalls(body: string): ToolCall[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return [];
    }

    const calls = collectToolCalls(parsed).filter((call) => this.allowedNames.has(call.name));
    if (calls.length === 0) {
      return [];
    }

    return calls.map((call) => ({
      id: `call_${(this.sequence++).toString(36)}${Date.now().toString(36)}`,
      type: 'function' as const,
      function: { name: call.name, arguments: call.arguments },
    }));
  }

  private takeCompleted(): ToolCall[] {
    return this.completed.splice(0, this.completed.length);
  }
}

interface ParsedCall {
  name: string;
  arguments: string;
}

interface RegionResult {
  consumed: number;
  calls: ToolCall[];
}

interface Opening {
  index: number;
  kind: 'fence' | 'alt';
}

function findOpening(buffer: string): Opening | null {
  const fence = buffer.indexOf(FENCE);
  const alt = buffer.indexOf(ALT_OPEN);

  if (fence === -1 && alt === -1) return null;
  if (fence === -1) return { index: alt, kind: 'alt' };
  if (alt === -1 || fence < alt) return { index: fence, kind: 'fence' };
  return { index: alt, kind: 'alt' };
}

/** Length of the trailing buffer that could still grow into an opening marker. */
function holdbackLength(buffer: string): number {
  let held = 0;
  for (const marker of [FENCE, ALT_OPEN]) {
    for (let length = Math.min(marker.length - 1, buffer.length); length > 0; length--) {
      if (buffer.endsWith(marker.slice(0, length))) {
        if (length > held) held = length;
        break;
      }
    }
  }
  return held;
}

/**
 * True while `trailing` could still grow into a closing marker: only gaps, or
 * gaps followed by a prefix of the closer. Anything else means no closer is coming.
 */
function couldStillClose(trailing: string, closer: string): boolean {
  const rest = trailing.replace(/^[ \t\r\n]*/, '');
  return rest === '' || closer.startsWith(rest);
}

/** Gaps directly after a call's closing fence belong to the call, not to the text. */
function skipTrailingWhitespace(text: string, from: number): number {
  let index = from;
  while (index < text.length && isJsonGap(text[index])) index++;
  return index;
}

/** Accepts a single call, an array of calls, or an OpenAI-style `{tool_calls:[…]}`. */
function collectToolCalls(parsed: unknown): ParsedCall[] {
  if (Array.isArray(parsed)) {
    return parsed.flatMap((entry) => collectToolCalls(entry));
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return [];
  }

  if ('tool_calls' in parsed && Array.isArray(parsed.tool_calls)) {
    return parsed.tool_calls.flatMap((entry) => collectToolCalls(entry));
  }

  const call = parseCall(parsed);
  return call === null ? [] : [call];
}

function parseCall(value: object): ParsedCall | null {
  if ('function' in value && typeof value.function === 'object' && value.function !== null) {
    return parseCall(value.function);
  }

  if (!('name' in value) || typeof value.name !== 'string' || value.name.length === 0) {
    return null;
  }

  const raw = 'arguments' in value ? value.arguments : 'parameters' in value ? value.parameters : undefined;
  const args = normalizeArgumentsValue(raw);
  return args === null ? null : { name: value.name, arguments: args };
}

/** Normalizes a call's arguments (object or JSON string) to a JSON object string. */
function normalizeArgumentsValue(raw: unknown): string | null {
  if (raw === undefined || raw === null) return '{}';

  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return normalizeArgumentsValue(parsed);
    } catch {
      return null;
    }
  }

  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return JSON.stringify(raw);
  }

  return null;
}
