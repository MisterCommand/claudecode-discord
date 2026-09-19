import { describe, expect, it } from 'vitest';
import { JsonArrayScanner } from './json-stream.js';

/** Feeds a body in fixed-size slices and returns the elements seen, per slice. */
function feed(body: string, size: number): unknown[][] {
  const scanner = new JsonArrayScanner();
  const perSlice: unknown[][] = [];
  for (let index = 0; index < body.length; index += size) {
    perSlice.push(scanner.push(body.slice(index, index + size)));
  }
  return perSlice;
}

const body = '[\n{"uToken": "a", "streamAssistResponse": {"answer": {"state": "IN_PROGRESS"}}},\n{"n": 2}\n]';

describe('JsonArrayScanner', () => {
  it('emits each element as soon as it completes', () => {
    const elements = feed(body, body.length).flat();
    expect(elements).toHaveLength(2);
    expect(elements[0]).toMatchObject({ uToken: 'a' });
    expect(elements[1]).toEqual({ n: 2 });
  });

  it('emits an element only once its closing bracket arrives', () => {
    const scanner = new JsonArrayScanner();
    for (const char of '[{"a": 1') {
      expect(scanner.push(char)).toEqual([]);
    }
    expect(scanner.push('}')).toEqual([{ a: 1 }]);
  });

  it('survives arbitrary chunk sizes', () => {
    for (const size of [1, 3, 7, 64, 4096]) {
      const elements = feed(body, size).flat();
      expect(elements).toHaveLength(2);
    }
  });

  it('does not wait for the closing bracket to surface an element', () => {
    const scanner = new JsonArrayScanner();
    expect(scanner.push('[{"a": 1}')).toEqual([{ a: 1 }]);
    expect(scanner.done).toBe(false);
  });

  it('ignores trailing commas, whitespace and nested brackets', () => {
    const scanner = new JsonArrayScanner();
    const elements = scanner.push('[\n  {"a": [1, {"b": "}]"}]},\n  {}\n]');
    expect(elements).toEqual([{ a: [1, { b: '}]' }] }, {}]);
    expect(scanner.done).toBe(true);
  });

  it('reports a non-array body instead of guessing', () => {
    const scanner = new JsonArrayScanner();
    expect(scanner.push('{"streamAssistResponse": {}}')).toEqual([]);
    expect(scanner.done).toBe(true);
    expect(scanner.push('[{"late": 1}]')).toEqual([]);
  });

  it('stays empty until the array actually starts', () => {
    const scanner = new JsonArrayScanner();
    expect(scanner.push(' \n')).toEqual([]);
    expect(scanner.done).toBe(false);
    expect(scanner.push('[{"a":1}]')).toEqual([{ a: 1 }]);
  });
});
