/**
 * Gemini Business API Client - handles direct API communication with Gemini Business
 *
 * Uses correct endpoints:
 * - https://vertexaisearch.cloud.google/auth/getoxsrf (XSRF token)
 * - https://content-discoveryengine.googleapis.com/v1alpha/locations/global/widgetCreateSession (session)
 * - https://content-discoveryengine.googleapis.com/v1alpha/locations/global/widgetStreamAssist (chat)
 */

import { createHmac } from 'node:crypto';
import {
  GeminiBusinessAccount,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ToolCall,
  ToolDefinition,
} from './types.js';
import {
  buildToolPreamble,
  renderToolCalls,
  renderToolResult,
  ToolCallScanner,
} from './tool-emulation.js';
import { JsonArrayScanner } from './json-stream.js';

// Gemini Business API Endpoints
const BASE_URL = 'https://content-discoveryengine.googleapis.com/v1alpha/locations/global';
const CREATE_SESSION_URL = `${BASE_URL}/widgetCreateSession`;
const STREAM_ASSIST_URL = `${BASE_URL}/widgetStreamAssist`;
const GETOXSRF_URL = 'https://vertexaisearch.cloud.google/auth/getoxsrf';

// Timing constants
export const SESSION_TTL_MS = 50 * 60 * 1000;       // 50 minutes
const JWT_CACHE_TTL_MS = 4.5 * 60 * 1000;    // 4.5 minutes (JWT expires at 5 min)
const SESSION_REFRESH_THRESHOLD_MS = 5 * 60 * 1000; // Refresh if < 5 min remaining

/**
 * Deadline for the short upstream calls (XSRF token, session creation). The chat
 * stream is deliberately left unbounded: it is a progressive response, and a
 * fixed deadline would cut off a long but healthy answer.
 */
const SHORT_REQUEST_TIMEOUT_MS = 30_000;

/** Signal that aborts on the given deadline, or the caller's signal when that is sooner. */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`upstream request timed out after ${timeoutMs}ms`)), timeoutMs);
  timer.unref?.();

  const forward = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) forward();
    else signal.addEventListener("abort", forward, { once: true });
  }

  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forward);
    },
  };
}

/** Client-facing model id -> Gemini Business `modelId`. */
export const MODEL_ID_MAP: Record<string, string> = {
  'gemini-2.5-pro': 'gemini-2.5-pro',
  'gemini-2.5-flash': 'gemini-2.5-flash',
  'gemini-3-flash': 'gemini-3-flash-preview',
  'gemini-3.1-pro': 'gemini-3.1-pro-preview',
  'gemini-3.8-flash': 'gemini-3.8-flash',
  'auto': '',
};

/** Model ids advertised by `GET /v1/models`. */
export const SUPPORTED_MODELS: string[] = Object.keys(MODEL_ID_MAP);

/**
 * Upstream refused the request itself, not the account serving it.
 *
 * `widgetStreamAssist` answers 400 `INVALID_ARGUMENT` with reason
 * `PROMPT_TOO_LARGE` once the flattened prompt outgrows the model's window. Every
 * account sends the same prompt, so retrying, failing over, or signing in again
 * reproduces the identical rejection: the caller must surface it instead of
 * charging it to an account.
 */
export class UpstreamRequestRejection extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamRequestRejection';
  }
}

/** Upstream's own reason for refusing a request body. */
const REQUEST_REJECTION_REASON = /PROMPT_TOO_LARGE/;

/**
 * Spells out a refusal whose cause the client must recognise.
 *
 * The client recognises an over-large prompt by matching plain phrases in the
 * message — `prompt is too long` (lowercased) or `input length and \`max_tokens\`
 * exceed context limit` — and only then compacts the conversation and retries the
 * turn. Upstream's own reason is an underscored wire code (`PROMPT_TOO_LARGE`)
 * that matches neither, so the phrase is stated outright rather than left
 * implied. Without it the client sees an unclassifiable client error and the
 * conversation stays stuck instead of recovering.
 */
function describeRejection(detail: string): string {
  if (!REQUEST_REJECTION_REASON.test(detail)) return detail;
  return `${detail}\nPrompt is too long: this request exceeds the model's context window `
    + '(the input length and `max_tokens` exceed context limit). '
    + 'The conversation is too large and must be compacted or trimmed before it can be sent.';
}

/**
 * Types a refused response.
 *
 * A 4xx that is not the account's own condition (401/403 refused credential,
 * 429 quota, 408 retryable) says upstream refused this request body, so every
 * account would refuse it identically. The body is searched too, because a
 * refusal can also arrive inside an HTTP 200 answer chunk.
 */
function refusedResponse(status: number, statusText: string, body: string): Error {
  const detail = `Chat completion failed: ${status} ${statusText}\n${body}`;
  const accountCondition = status === 401 || status === 403 || status === 408 || status === 429;
  const requestSide = status >= 400 && status < 500 && !accountCondition;
  return requestSide || REQUEST_REJECTION_REASON.test(body)
    ? new UpstreamRequestRejection(describeRejection(detail))
    : new Error(detail);
}

/** Throws a failure carried inside an HTTP 200 body, keeping a refused request typed. */
function throwElementFailure(failure: string): never {
  throw REQUEST_REJECTION_REASON.test(failure)
    ? new UpstreamRequestRejection(describeRejection(failure))
    : new Error(failure);
}

export class GeminiBusinessAPI {
  private account: GeminiBusinessAccount;

  constructor(account: GeminiBusinessAccount) {
    this.account = account;
  }

  /**
   * Create JWT token from xsrfToken and keyId
   */
  private createJWT(xsrfToken: string, keyId: string): string {
    const now = Math.floor(Date.now() / 1000);

    const header = {
      alg: 'HS256',
      typ: 'JWT',
      kid: keyId,
    };

    const payload = {
      iss: 'https://vertexaisearch.cloud.google',
      aud: 'https://content-discoveryengine.googleapis.com',
      sub: `csesidx/${this.account.csesidx}`,
      iat: now,
      exp: now + 300, // 5 minutes
      nbf: now,
    };

    // Base64url encode
    const base64url = (str: string) =>
      Buffer.from(str).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

    const headerB64 = base64url(JSON.stringify(header));
    const payloadB64 = base64url(JSON.stringify(payload));
    const message = `${headerB64}.${payloadB64}`;

    // Decode xsrfToken to get key bytes
    const padding = '='.repeat((4 - (xsrfToken.length % 4)) % 4);
    const keyBytes = Buffer.from(xsrfToken + padding, 'base64url');

    // Create HMAC signature
    const signature = createHmac('sha256', keyBytes).update(message).digest();
    const signatureB64 = signature.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

    return `${message}.${signatureB64}`;
  }

  /**
   * Get JWT token (created from XSRF token)
   * Tokens are cached for 5 minutes
   */
  private async getJWT(): Promise<string> {
    // Check if cached JWT is still valid
    if (this.account.cached_jwt && this.account.cached_jwt_expires) {
      if (Date.now() < this.account.cached_jwt_expires) {
        return this.account.cached_jwt;
      }
    }

    try {
      const url = `${GETOXSRF_URL}?csesidx=${this.account.csesidx}`;
      const deadline = withTimeout(undefined, SHORT_REQUEST_TIMEOUT_MS);
      let response;
      try {
        response = await fetch(url, {
          method: 'GET',
          headers: {
            'Cookie': this.buildCookieHeader(),
            'User-Agent': this.getUserAgent(),
          },
          signal: deadline.signal,
        });
      } finally {
        deadline.done();
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to get XSRF token: ${response.status} ${response.statusText}\n${errorText}`);
      }

      let text = await response.text();

      // Remove XSS protection prefix )]}'
      if (text.startsWith(")]}'\n")) {
        text = text.substring(5);
      }

      const data = JSON.parse(text) as { xsrfToken: string; keyId: string };

      // Create JWT from xsrfToken and keyId
      const jwt = this.createJWT(data.xsrfToken, data.keyId);

      // Cache JWT for 4.5 minutes (JWT expires in 5 minutes)
      this.account.cached_jwt = jwt;
      this.account.cached_jwt_expires = Date.now() + JWT_CACHE_TTL_MS;

      return jwt;
    } catch (error) {
      throw new Error(`JWT retrieval failed: ${error}`);
    }
  }

  /**
   * Create session with widgetCreateSession
   * Sessions are cached for 50 minutes
   */
  private async createSession(): Promise<string> {
    // Check if cached session is still valid
    if (this.account.session_id && this.account.session_expires) {
      if (Date.now() < this.account.session_expires) {
        return this.account.session_id;
      }
    }

    try {
      const jwt = await this.getJWT();

      // Generate random session ID
      const sessionId = Math.random().toString(36).substring(2, 14);

      const body = {
        configId: this.account.team_id,
        additionalParams: { token: '-' },
        createSessionRequest: {
          session: {
            name: sessionId,
            displayName: sessionId,
          },
        },
      };

      const deadline = withTimeout(undefined, SHORT_REQUEST_TIMEOUT_MS);
      let response;
      try {
        response = await fetch(CREATE_SESSION_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${jwt}`,
            'User-Agent': this.getUserAgent(),
            'Origin': 'https://vertexaisearch.cloud.google',
            'Referer': 'https://vertexaisearch.cloud.google/',
          },
          body: JSON.stringify(body),
          signal: deadline.signal,
        });
      } finally {
        deadline.done();
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to create session: ${response.status} ${response.statusText}\n${errorText}`);
      }

      const data = (await response.json()) as { session: { name: string } };

      // Cache session for 50 minutes
      this.account.session_id = data.session.name;
      this.account.session_expires = Date.now() + SESSION_TTL_MS;

      return data.session.name;
    } catch (error) {
      throw new Error(`Session creation failed: ${error}`);
    }
  }

  /**
   * Send chat completion request to widgetStreamAssist
   */
  async chatCompletion(
    request: ChatCompletionRequest,
    signal?: AbortSignal
  ): Promise<ChatCompletionResponse | AsyncIterable<ChatCompletionResponse>> {
    try {
      const sessionId = await this.createSession();
      const xsrfToken = await this.getJWT();

      // Gemini Business has no native function calling: tools travel in the prompt
      // and the model's fenced `tool_call` blocks are parsed back out.
      const tools = this.selectTools(request);

      // Convert OpenAI format to Gemini Business format
      const geminiRequest = this.convertToGeminiFormat(request, sessionId, tools);

      // The caller's signal is forwarded as-is: it carries client cancellation,
      // and the response streams long after this call resolves. A fixed deadline
      // here would abort a healthy but slow answer.
      const response = await fetch(STREAM_ASSIST_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${xsrfToken}`,
          'Origin': 'https://vertexaisearch.cloud.google',
          'Referer': 'https://vertexaisearch.cloud.google/',
          'User-Agent': this.getUserAgent(),
        },
        body: JSON.stringify(geminiRequest),
        signal,
      });

      if (!response.ok) {
        throw refusedResponse(response.status, response.statusText, await response.text());
      }

      // Handle streaming response
      if (request.stream) {
        return this.handleStreamResponse(response, request.model, tools);
      }

      // Handle non-streaming response
      const data = await response.json();
      return this.convertToOpenAIFormat(data, request.model, tools);
    } catch (error) {
      // A refusal is already typed for the caller; re-wrapping it would erase the
      // distinction between "this prompt is unacceptable" and "this account failed".
      if (error instanceof UpstreamRequestRejection) throw error;
      throw new Error(`Chat completion request failed: ${error}`);
    }
  }

  /**
   * Tools actually offered to the model.
   * `tool_choice: "none"` disables tool calling entirely; naming a single
   * function narrows the offered set to that function.
   */
  private selectTools(request: ChatCompletionRequest): ToolDefinition[] {
    if (request.tool_choice === 'none') {
      return [];
    }

    const tools = request.tools ?? [];
    const forcedName =
      typeof request.tool_choice === 'object' && request.tool_choice !== null
        ? request.tool_choice.function?.name
        : undefined;

    const usable = tools.filter((tool) => typeof tool?.function?.name === 'string');
    return forcedName ? usable.filter((tool) => tool.function.name === forcedName) : usable;
  }

  /**
   * Build cookie header string
   */
  private buildCookieHeader(): string {
    return `__Secure-C_SES=${this.account.cookies.secure_c_ses}; __Host-C_OSES=${this.account.cookies.host_c_oses}`;
  }

  /**
   * Get user agent string
   */
  private getUserAgent(): string {
    return (
      this.account.user_agent ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
  }

  /**
   * Convert OpenAI format to Gemini Business format
   */
  private convertToGeminiFormat(
    request: ChatCompletionRequest,
    sessionId: string,
    tools: ToolDefinition[] = []
  ): any {
    // Build query parts from messages, with the emulated tool protocol up front
    const preamble = buildToolPreamble(tools, request.tool_choice, request.parallel_tool_calls);
    const queryParts = this.buildQueryParts(request.messages, preamble);

    // Map model name to Gemini internal model ID
    const modelId = this.mapModelId(request.model);

    return {
      configId: this.account.team_id,
      additionalParams: { token: '-' },
      streamAssistRequest: {
        session: sessionId,
        query: { parts: queryParts },
        filter: '',
        fileIds: [],
        answerGenerationMode: 'NORMAL',
        assistGenerationConfig: {
          ...(modelId ? { modelId } : {}),
        },
        toolsSpec: {
          webGroundingSpec: {},
          toolRegistry: 'default_tool_registry',
          imageGenerationSpec: {},
          videoGenerationSpec: {},
        },
        languageCode: 'en-US',
        userMetadata: { timeZone: 'Etc/GMT' },
        assistSkippingMode: 'REQUEST_ASSIST',
      },
    };
  }

  /**
   * Build query parts from OpenAI messages array.
   *
   * The widget API takes a single text prompt, so history is flattened into a
   * role-tagged transcript. Assistant tool calls and tool results are replayed
   * in the same fenced protocol the preamble asks the model to use.
   */
  private buildQueryParts(messages: ChatMessage[], preamble: string): Array<{ text: string }> {
    const sections: string[] = [];
    if (preamble) {
      sections.push(preamble);
    }

    for (const msg of messages) {
      const text = this.renderMessageContent(msg.content);

      if (msg.role === 'tool') {
        sections.push(renderToolResult(text, msg.tool_call_id, msg.name));
        continue;
      }

      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        sections.push(`Assistant: ${[text, renderToolCalls(msg.tool_calls)].filter(Boolean).join('\n')}`);
        continue;
      }

      const role = msg.role === 'assistant' ? 'Assistant' : msg.role === 'system' ? 'System' : 'User';
      sections.push(`${role}: ${text}`);
    }

    return [{ text: sections.join('\n\n') }];
  }

  /** Flatten string or multimodal message content to text (images are not supported upstream). */
  private renderMessageContent(content: ChatMessage['content']): string {
    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      return content
        .filter((part) => part.type === 'text' && part.text)
        .map((part) => part.text)
        .join(' ');
    }

    return '';
  }

  /**
   * Map OpenAI model names to Gemini internal model IDs
   */
  private mapModelId(model?: string): string {
    return MODEL_ID_MAP[model || 'gemini-2.5-flash'] ?? model ?? 'gemini-2.5-flash';
  }

  /**
   * Convert Gemini Business format to OpenAI format
   */
  private convertToOpenAIFormat(
    data: unknown,
    model: string,
    tools: ToolDefinition[] = []
  ): ChatCompletionResponse {
    const failure = responseFailure(data);
    if (failure) {
      throwElementFailure(failure);
    }

    const fullText = extractResponseText(data);
    const scanner = new ToolCallScanner(tools);
    const head = scanner.push(fullText);
    const tail = scanner.flush();
    const toolCalls = [...head.toolCalls, ...tail.toolCalls];
    const content = `${head.text}${tail.text}`.trim();

    return {
      id: `chatcmpl-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: content.length > 0 ? content : toolCalls.length > 0 ? null : '',
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
        },
      ],
      usage: {
        prompt_tokens: 0, // Gemini Business doesn't provide token counts
        completion_tokens: 0,
        total_tokens: 0,
      },
    };
  }

  /**
   * Handle streaming SSE response
   */
  private async *handleStreamResponse(
    response: Response,
    model: string,
    tools: ToolDefinition[] = []
  ): AsyncIterable<ChatCompletionResponse> {
    // Native fetch bodies are byte streams; a TextDecoder keeps multi-byte
    // characters intact when a network chunk splits one.
    if (!response.body) {
      throw new Error('Gemini Business returned a response without a body');
    }
    const reader = response.body;
    const decoder = new TextDecoder();
    const scanner = new ToolCallScanner(tools);
    const arrayScanner = new JsonArrayScanner();
    let buffer = '';
    let fullBody = '';
    // Set once any delta has been forwarded; the whole-body fallback must not re-emit them.
    let produced = false;
    let producedToolCalls = false;
    // The endpoint answers with a chunked JSON array; some deployments use SSE lines.
    let mode: 'unknown' | 'sse' | 'json' = 'unknown';

    const toChunk = (content: string, finishReason: string | null = null): ChatCompletionResponse => ({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            content,
          },
          finish_reason: finishReason,
        },
      ],
    });

    const toToolCallChunk = (calls: ToolCall[]): ChatCompletionResponse => ({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: calls.map((call, index) => ({
              index,
              id: call.id,
              type: 'function' as const,
              function: call.function,
            })),
          },
          finish_reason: null,
        },
      ],
    });

    try {
      for await (const chunk of reader) {
        const chunkText = decoder.decode(chunk, { stream: true });
        fullBody += chunkText;

        if (mode === 'unknown') {
          const head = chunkText.replace(/^\s+/, '');
          if (head.length >= 5) {
            mode = head.startsWith('data:') ? 'sse' : 'json';
          } else if (head.length > 0 && !'data:'.startsWith(head)) {
            mode = 'json';
          }
        }

        // Frames produced by this network chunk, yielded once it is fully consumed.
        const frames: ChatCompletionResponse[] = [];
        const collect = (payload: unknown) => {
          const failure = elementFailure(payload);
          if (failure) {
            throwElementFailure(failure);
          }

          const content = extractChunkText(payload);
          if (!content) return;

          const events = scanner.push(content);
          if (events.text) {
            produced = true;
            frames.push(toChunk(events.text, null));
          }
          if (events.toolCalls.length > 0) {
            produced = true;
            producedToolCalls = true;
            frames.push(toToolCallChunk(events.toolCalls));
          }
        };

        if (mode === 'sse') {
          buffer += chunkText;
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();

            // Skip empty lines and [DONE] marker
            if (!trimmed || trimmed === 'data: [DONE]') continue;

            // Parse SSE data
            if (trimmed.startsWith('data: ')) {
              const jsonStr = trimmed.slice(6);
              if (jsonStr === '[DONE]') continue;

              let data: unknown;
              try {
                data = JSON.parse(jsonStr);
              } catch (error) {
                console.error('Failed to parse SSE data:', error);
                continue;
              }
              collect(data);
            } else {
              // Some Gemini Business deployments return plain JSON lines instead of SSE.
              let data: unknown;
              try {
                data = JSON.parse(trimmed);
              } catch {
                continue; // Ignore non-JSON lines
              }
              collect(data);
            }
          }
        } else if (mode === 'json') {
          for (const element of arrayScanner.push(chunkText)) {
            collect(element);
          }
        }

        for (const frame of frames) {
          yield frame;
        }
      }

      // Release anything the scanner held back while waiting for a full block.
      const final = scanner.flush();
      if (final.text) {
        produced = true;
        yield toChunk(final.text, null);
      }
      if (final.toolCalls.length > 0) {
        produced = true;
        producedToolCalls = true;
        yield toToolCallChunk(final.toolCalls);
      }

      if (producedToolCalls) {
        yield toChunk('', 'tool_calls');
        return;
      }

      if (produced) {
        yield toChunk('', 'stop');
        return;
      }

      // Fallback: the body shape was neither recognized JSON array nor SSE.
      let parsed: unknown;
      try {
        parsed = JSON.parse(fullBody);
      } catch {
        throw new Error('Gemini Business stream contained no assistant content');
      }

      // Throws for upstream failures; a SUCCEEDED-but-empty answer is legal.
      const completion = this.convertToOpenAIFormat(parsed, model, tools);
      const choice = completion.choices[0];
      const text = choice?.message?.content?.trim() || '';
      const calls = choice?.message?.tool_calls ?? [];

      if (calls.length > 0) {
        yield toToolCallChunk(calls);
        yield toChunk('', 'tool_calls');
        return;
      }

      yield toChunk(text, null);
      yield toChunk('', 'stop');
    } catch (error) {
      console.error('Stream reading error:', error);
      throw error;
    }
  }

  /**
   * Test account credentials and connectivity
   */
  async testAccount(): Promise<{ success: boolean; error?: string }> {
    try {
      // Test 1: Get XSRF token
      await this.getJWT();

      // Test 2: Create session
      await this.createSession();

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check the stored cookies are still accepted, refreshing the JWT and session
   * on the way. Used before opening a browser: if this succeeds the cookies are
   * alive and a re-login would be wasted work.
   *
   * The cached JWT is dropped first so the check always reaches the network — a
   * cache hit would report success without proving the cookie still works.
   */
  async checkCredentials(): Promise<{ ok: true } | { ok: false; error: string }> {
    this.account.cached_jwt = undefined;
    this.account.cached_jwt_expires = undefined;
    this.account.session_id = undefined;
    this.account.session_expires = undefined;

    try {
      await this.getJWT();
      await this.createSession();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Check if session needs refresh
   */
  needsSessionRefresh(): boolean {
    if (!this.account.session_id || !this.account.session_expires) {
      return true;
    }

    const now = Date.now();
    const expiresIn = this.account.session_expires - now;

    // Refresh if less than 5 minutes remaining
    return expiresIn < SESSION_REFRESH_THRESHOLD_MS;
  }

  /**
   * Force refresh session
   */
  async refreshSession(): Promise<void> {
    // Clear the cached session and JWT: a session is only rejected because the
    // credential behind it is stale, and the cached JWT was minted from the same
    // credential, so reusing it would rebuild a session that fails the same way.
    this.account.session_id = undefined;
    this.account.session_expires = undefined;
    this.account.cached_jwt = undefined;
    this.account.cached_jwt_expires = undefined;

    // Create new session
    await this.createSession();
  }
}

/**
 * Assistant text of one widget reply chunk.
 * `streamAssistResponse.answer.replies[].groundedContent.content` carries the
 * model output; replies flagged `thought` are chain-of-thought and excluded.
 * The payload is external JSON, so every level is checked.
 */
function chunkReplyText(chunk: unknown): string {
  if (typeof chunk !== 'object' || chunk === null || !('streamAssistResponse' in chunk)) {
    return '';
  }
  const response = chunk.streamAssistResponse;
  if (typeof response !== 'object' || response === null || !('answer' in response)) {
    return '';
  }
  const answer = response.answer;
  if (typeof answer !== 'object' || answer === null || !('replies' in answer)) {
    return '';
  }
  const replies = answer.replies;
  if (!Array.isArray(replies)) {
    return '';
  }

  let text = '';
  for (const reply of replies) {
    if (typeof reply !== 'object' || reply === null || !('groundedContent' in reply)) {
      continue;
    }
    const grounded = reply.groundedContent;
    if (typeof grounded !== 'object' || grounded === null || !('content' in grounded)) {
      continue;
    }
    const content = grounded.content;
    if (typeof content !== 'object' || content === null) {
      continue;
    }

    const value = 'text' in content ? content.text : undefined;
    const thought = 'thought' in content ? content.thought : undefined;
    if (typeof value === 'string' && value.length > 0 && thought !== true) {
      text += value;
    }
  }

  return text;
}

/** Assistant text of a whole (non-streaming) response: an array of chunks or a single chunk. */
function extractResponseText(data: unknown): string {
  const chunks = Array.isArray(data) ? data : [data];
  let text = '';
  for (const chunk of chunks) {
    text += chunkReplyText(chunk);
  }
  return text;
}

/** Assistant text of a single SSE payload, including the plain `{text}`/`{content}` shapes. */
function extractChunkText(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null) {
    if ('text' in payload && typeof payload.text === 'string') return payload.text;
    if ('content' in payload && typeof payload.content === 'string') return payload.content;
  }
  return chunkReplyText(payload);
}

/**
 * Upstream failures that arrive inside an HTTP 200 body: `{"error": {…}}` chunks
 * and terminal `FAILED` / `SKIPPED` answer states. Without this a broken turn is
 * reported to the client as a successful-but-empty answer.
 */
function elementFailure(element: unknown): string | null {
  if (typeof element !== 'object' || element === null) {
    return null;
  }

  if ('error' in element) {
    const error = element.error;
    if (typeof error !== 'object' || error === null) {
      return 'Gemini Business returned an unspecified error';
    }
    const code = 'code' in error ? error.code : undefined;
    const status = 'status' in error ? error.status : undefined;
    const message = 'message' in error ? error.message : undefined;
    // The machine-readable cause (`PROMPT_TOO_LARGE`, `QUOTA_EXCEEDED`, …) lives
    // in `details[].reason`, not in the human-readable `message`.
    const details = 'details' in error && Array.isArray(error.details) ? error.details : [];
    const reasons = details
      .map((detail) => (typeof detail === 'object' && detail !== null && 'reason' in detail ? detail.reason : undefined))
      .filter((reason) => reason !== undefined && reason !== null)
      .map(String);
    const parts = [code, status, message, ...reasons]
      .filter((part) => part !== undefined && part !== null)
      .map((part) => String(part));
    return `Gemini Business error: ${parts.join(' ') || 'unspecified'}`;
  }

  if (!('streamAssistResponse' in element)) {
    return null;
  }
  const response = element.streamAssistResponse;
  if (typeof response !== 'object' || response === null || !('answer' in response)) {
    return null;
  }
  const answer = response.answer;
  if (typeof answer !== 'object' || answer === null || !('state' in answer)) {
    return null;
  }

  const state = answer.state;
  if (state !== 'FAILED' && state !== 'SKIPPED') {
    return null;
  }

  const reasons =
    'assistSkippedReasons' in answer && Array.isArray(answer.assistSkippedReasons)
      ? answer.assistSkippedReasons.map(String).join(', ')
      : '';
  return `Gemini Business answer state ${String(state)}${reasons ? ` (${reasons})` : ''}`;
}

/** First failure in a whole response (array of chunks or one chunk), if any. */
function responseFailure(data: unknown): string | null {
  const elements = Array.isArray(data) ? data : [data];
  for (const element of elements) {
    const failure = elementFailure(element);
    if (failure) {
      return failure;
    }
  }
  return null;
}
