/**
 * Incremental reader for the widget endpoint's response body.
 *
 * `widgetStreamAssist` answers with `Transfer-Encoding: chunked` and
 * `Content-Type: application/json` — one JSON array of
 * `{uToken, streamAssistResponse: {…}}` entries, pretty-printed across many
 * network chunks. The bytes arrive progressively, so elements are parsed (and
 * forwarded as OpenAI deltas) as soon as each one completes instead of waiting
 * for the whole body.
 */

/** Space, tab, CR or LF — the only separators JSON allows between tokens. */
export function isJsonGap(char: string): boolean {
  return char === ' ' || char === '\n' || char === '\r' || char === '\t';
}

/**
 * Index just past the balanced JSON value starting at/after `start`, or -1 when
 * the value is absent or still open. Non-JSON bodies are rejected immediately so
 * plain text is never buffered.
 */
export function findJsonValueEnd(text: string, start: number, limit: number): number {
  let index = start;
  while (index < limit && isJsonGap(text[index])) index++;
  if (index >= limit) return -1;

  const first = text[index];
  if (first !== '{' && first !== '[') return -1;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (; index < limit; index++) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{' || char === '[') {
      depth++;
    } else if (char === '}' || char === ']') {
      depth--;
      if (depth === 0) return index + 1;
    }
  }

  return -1;
}

/** Splits a top-level JSON array into its elements while it is still arriving. */
export class JsonArrayScanner {
  private buffer = '';
  private cursor = 0;
  private opened = false;
  private closed = false;

  /** True once the array's closing bracket has been seen (or the body was not an array). */
  get done(): boolean {
    return this.closed;
  }

  /** Parsed elements completed by this chunk. Incomplete elements stay buffered. */
  push(chunk: string): unknown[] {
    if (this.closed) {
      return [];
    }

    this.buffer += chunk;

    if (!this.opened) {
      let index = 0;
      while (index < this.buffer.length && isJsonGap(this.buffer[index])) index++;
      if (index >= this.buffer.length) {
        return [];
      }
      if (this.buffer[index] !== '[') {
        // Not an array body — let the caller fall back to whole-body parsing.
        this.closed = true;
        return [];
      }
      this.opened = true;
      this.cursor = index + 1;
    }

    const elements: unknown[] = [];

    for (;;) {
      let index = this.cursor;
      while (index < this.buffer.length && (isJsonGap(this.buffer[index]) || this.buffer[index] === ',')) {
        index++;
      }
      if (index >= this.buffer.length) {
        this.cursor = index;
        break;
      }
      if (this.buffer[index] === ']') {
        this.closed = true;
        this.cursor = index;
        break;
      }

      const end = findJsonValueEnd(this.buffer, index, this.buffer.length);
      if (end === -1) {
        this.cursor = index;
        break;
      }

      const raw = this.buffer.slice(index, end);
      this.cursor = end;
      try {
        elements.push(JSON.parse(raw));
      } catch {
        // A malformed element is dropped rather than poisoning the whole stream.
      }
    }

    if (this.cursor > 0) {
      this.buffer = this.buffer.slice(this.cursor);
      this.cursor = 0;
    }

    return elements;
  }
}
