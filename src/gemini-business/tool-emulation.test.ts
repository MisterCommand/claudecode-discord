import { describe, expect, it } from 'vitest';
import { buildToolPreamble, renderToolCalls, renderToolResult, ToolCallScanner } from './tool-emulation.js';
import { ToolDefinition } from './types.js';

const tools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from disk',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: { name: 'list_dir', description: 'List a directory' },
  },
];

const call = ['```tool_call', '{"name": "read_file", "arguments": {"path": "a.txt"}}', '```'].join('\n');

function scanAll(chunks: string[], scanner = new ToolCallScanner(tools)) {
  let text = '';
  const toolCalls = [];
  for (const chunk of chunks) {
    const events = scanner.push(chunk);
    text += events.text;
    toolCalls.push(...events.toolCalls);
  }
  const final = scanner.flush();
  text += final.text;
  toolCalls.push(...final.toolCalls);
  return { text, toolCalls };
}

describe('ToolCallScanner', () => {
  it('extracts a tool call and drops the surrounding block from text', () => {
    const result = scanAll([call]);
    expect(result.text).toBe('');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe('read_file');
    expect(JSON.parse(result.toolCalls[0].function.arguments)).toEqual({ path: 'a.txt' });
  });

  it('yields the same result when the block is split across chunks', () => {
    const chunks = call.match(/[\s\S]{1,3}/g) ?? [];
    const result = scanAll(chunks);
    expect(result.text).toBe('');
    expect(result.toolCalls).toHaveLength(1);
    expect(JSON.parse(result.toolCalls[0].function.arguments)).toEqual({ path: 'a.txt' });
  });

  it('keeps prose around a tool call and trims the block boundaries', () => {
    const result = scanAll([`Let me look.\n\n${call}\n`]);
    expect(result.text).toBe('Let me look.');
    expect(result.toolCalls).toHaveLength(1);
  });

  it('leaves ordinary answers untouched', () => {
    const result = scanAll(['Hello. ', 'How can I help?']);
    expect(result.text).toBe('Hello. How can I help?');
    expect(result.toolCalls).toEqual([]);
  });

  it('does not treat an unknown tool name as a call', () => {
    const result = scanAll(['```json\n{"name": "delete_everything", "arguments": {}}\n```']);
    expect(result.text).toBe('```json\n{"name": "delete_everything", "arguments": {}}\n```');
    expect(result.toolCalls).toEqual([]);
  });

  it('does not parse a plain code block without a declared tool name', () => {
    const result = scanAll(['```json\n{"traits": ["fast"]}\n```']);
    expect(result.toolCalls).toEqual([]);
    expect(result.text).toContain('"traits"');
  });

  it('preserves a non-call code block byte for byte', () => {
    const source = 'Answer:\n\n```json\n{"traits": ["fast"]}\n```\n\nDone.';
    const result = scanAll([source]);
    expect(result.text).toBe(source);
    expect(result.toolCalls).toEqual([]);
  });

  it('accepts arguments given as a JSON string and the parameters alias', () => {
    const result = scanAll([
      '```json\n{"name": "read_file", "arguments": "{\\"path\\": \\"b.txt\\"}"}\n```',
      '<tool_call>{"name": "list_dir", "parameters": {"path": "src"}}</tool_call>',
    ]);
    expect(result.toolCalls.map((entry) => entry.function.name)).toEqual(['read_file', 'list_dir']);
    expect(JSON.parse(result.toolCalls[0].function.arguments)).toEqual({ path: 'b.txt' });
    expect(JSON.parse(result.toolCalls[1].function.arguments)).toEqual({ path: 'src' });
  });

  it('extracts several calls emitted in sequence', () => {
    const result = scanAll([call, '\n', call.replace('a.txt', 'b.txt')]);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls.map((entry) => JSON.parse(entry.function.arguments).path)).toEqual(['a.txt', 'b.txt']);
  });

  it('never parses when no tools were declared', () => {
    const scanner = new ToolCallScanner([]);
    const result = scanAll([call], scanner);
    expect(result.text).toBe(call);
    expect(result.toolCalls).toEqual([]);
  });

  it('emits unterminated blocks as text when the stream ends', () => {
    const result = scanAll(['```tool_call\n{"name": "read_file", "argum']);
    expect(result.toolCalls).toEqual([]);
    expect(result.text).toContain('read_file');
  });
});

describe('buildToolPreamble', () => {
  it('is empty without tools', () => {
    expect(buildToolPreamble([])).toBe('');
  });

  it('lists every tool with its schema and the output protocol', () => {
    const preamble = buildToolPreamble(tools);
    expect(preamble).toContain('### read_file');
    expect(preamble).toContain('### list_dir');
    expect(preamble).toContain('"path":{"type":"string"}');
    expect(preamble).toContain('```tool_call');
  });

  it('restricts the listing to a forced tool and demands the call', () => {
    const preamble = buildToolPreamble(tools, { type: 'function', function: { name: 'list_dir' } });
    expect(preamble).toContain('You MUST call the tool "list_dir"');
  });

  it('forbids parallel calls when the client asks for one', () => {
    expect(buildToolPreamble(tools, 'auto', false)).toContain('at most one tool_call block');
  });
});

describe('history replay', () => {
  it('renders tool calls the scanner reads back identically', () => {
    const toolCalls = [{ id: 'call_1', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }];
    const result = scanAll([renderToolCalls(toolCalls)]);
    expect(result.toolCalls[0].function.name).toBe('read_file');
    expect(result.toolCalls[0].function.arguments).toBe('{"path":"a.txt"}');
  });

  it('labels tool results with their call id and name', () => {
    expect(renderToolResult('contents', 'call_1', 'read_file')).toBe(
      'Tool result (name=read_file, tool_call_id=call_1):\ncontents'
    );
  });
});
