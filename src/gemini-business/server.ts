/**
 * HTTP surface of the pool.
 *
 * Three routes, `node:http` only:
 *   POST /v1/messages          — Anthropic Messages API (real wire format)
 *   POST /v1/chat/completions  — OpenAI-compatible chat completions
 *   GET  /v1/models            — model list
 *
 * The upstream pipeline is injected (`ServerDeps`) so the routes can be tested
 * without accounts or network, and so `cli.ts` stays the only place that wires
 * the account pool in.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type {
  AnthropicMessagesRequest,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelInfo,
} from './types.js';
import { SUPPORTED_MODELS, UpstreamRequestRejection } from './gemini-business-api.js';
import { anthropicStreamEvents, toAnthropicMessage, toAnthropicSSE, toChatCompletionRequest } from './anthropic.js';

export interface ServerOptions {
  host: string;
  port: number;
  api_keys: string[];
  default_model: string;
}

/** The seam that keeps the server testable without accounts or network. */
export interface ServerDeps {
  chatCompletion(
    request: ChatCompletionRequest,
    signal?: AbortSignal
  ): Promise<ChatCompletionResponse | AsyncIterable<ChatCompletionResponse>>;
}

export interface RunningServer {
  host: string;
  port: number;
  close(): Promise<void>;
}

export async function startServer(options: ServerOptions, deps: ServerDeps): Promise<RunningServer> {
  const server = createServer((req, res) => {
    void handleRequest(options, deps, req, res);
  });

  if (options.api_keys.length === 0 && !isLoopback(options.host)) {
    console.warn(
      `WARNING: no API keys configured — the pool is unauthenticated on ${options.host}.`
    );
  }

  // `Promise.withResolvers` is Node 22+; the supported floor is Node 18.
  await new Promise<void>((resolve, reject) => {
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };

    server.once('listening', onListening);
    server.once('error', onError);
    server.listen(options.port, options.host);
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;

  return {
    host: options.host,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // Keep-alive sockets from a client pool would otherwise hold `close()` open.
        server.closeIdleConnections?.();
      }),
  };
}

type Json = Record<string, unknown>;

async function handleRequest(
  options: ServerOptions,
  deps: ServerDeps,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');

  // A client that goes away mid-turn must stop the upstream request too.
  const controller = new AbortController();
  res.on('close', () => controller.abort());

  try {
    if (req.method === 'POST' && url.pathname === '/v1/messages') {
      await handleMessages(options, deps, req, res, controller.signal);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      await handleChatCompletions(options, deps, req, res, controller.signal);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      handleModels(options, req, res);
      return;
    }

    sendJson(res, 404, openaiError('invalid_request_error', 'Not found'));
  } catch (error) {
    // Route handlers report their own failures; this is the last-resort guard.
    if (!res.headersSent) {
      sendJson(res, 500, openaiError('api_error', messageOf(error)));
    } else {
      endResponse(res);
    }
  }
}

async function handleMessages(
  options: ServerOptions,
  deps: ServerDeps,
  req: IncomingMessage,
  res: ServerResponse,
  signal: AbortSignal
): Promise<void> {
  if (!authorize(options, req)) {
    sendJson(res, 401, anthropicError('authentication_error', 'Invalid API key'));
    return;
  }

  const parsed = await readJsonBody(req);
  if ('failure' in parsed) {
    sendJson(res, 400, anthropicError('invalid_request_error', 'Request body must be a JSON object'));
    return;
  }

  const body = parsed.body;
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    sendJson(res, 400, anthropicError('invalid_request_error', '`messages` must be a non-empty array'));
    return;
  }

  const request = toChatCompletionRequest(body as AnthropicMessagesRequest, options.default_model);
  const model = typeof body.model === 'string' && body.model ? body.model : options.default_model;

  let result: ChatCompletionResponse | AsyncIterable<ChatCompletionResponse>;
  try {
    result = await deps.chatCompletion(request, signal);
  } catch (error) {
    const { status, type } = failureDialect(error);
    sendJson(res, status, anthropicError(type, messageOf(error)));
    return;
  }

  // `deps` mirrors `request.stream`, so a non-stream request widens to a whole response.
  if (!request.stream) {
    sendJson(res, 200, toAnthropicMessage(result as ChatCompletionResponse, model));
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  try {
    for await (const event of anthropicStreamEvents(result as AsyncIterable<ChatCompletionResponse>, model)) {
      await writeFrame(res, toAnthropicSSE(event));
    }
  } catch (error) {
    const { type } = failureDialect(error);
    await writeFrame(res, `event: error\ndata: ${JSON.stringify(anthropicError(type, messageOf(error)))}\n\n`).catch(
      () => {}
    );
  }
  endResponse(res);
}

async function handleChatCompletions(
  options: ServerOptions,
  deps: ServerDeps,
  req: IncomingMessage,
  res: ServerResponse,
  signal: AbortSignal
): Promise<void> {
  if (!authorize(options, req)) {
    sendJson(res, 401, openaiError('unauthorized', 'Invalid API key'));
    return;
  }

  const parsed = await readJsonBody(req);
  if ('failure' in parsed) {
    sendJson(res, 400, openaiError('invalid_request_error', 'Request body must be a JSON object'));
    return;
  }

  const body = parsed.body;
  if (!Array.isArray(body.messages)) {
    sendJson(res, 400, openaiError('invalid_request_error', '`messages` must be an array'));
    return;
  }

  // Boundary cast: the body is client-supplied JSON and the route validates the
  // one field it can (`messages`); everything else is optional passthrough.
  const request = body as unknown as ChatCompletionRequest;
  const streaming = request.stream === true;

  let result: ChatCompletionResponse | AsyncIterable<ChatCompletionResponse>;
  try {
    result = await deps.chatCompletion(request, signal);
  } catch (error) {
    const { status, type } = failureDialect(error);
    sendJson(res, status, openaiError(type, messageOf(error)));
    return;
  }

  if (!streaming) {
    sendJson(res, 200, result as ChatCompletionResponse);
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  try {
    for await (const chunk of result as AsyncIterable<ChatCompletionResponse>) {
      await writeFrame(res, `data: ${JSON.stringify(chunk)}\n\n`);
    }
    await writeFrame(res, 'data: [DONE]\n\n');
  } catch (error) {
    const { type } = failureDialect(error);
    await writeFrame(res, `data: ${JSON.stringify(openaiError(type, messageOf(error)))}\n\n`).catch(() => {});
  }
  endResponse(res);
}

function handleModels(options: ServerOptions, req: IncomingMessage, res: ServerResponse): void {
  if (!authorize(options, req)) {
    sendJson(res, 401, openaiError('unauthorized', 'Invalid API key'));
    return;
  }

  const data: ModelInfo[] = SUPPORTED_MODELS.map((id) => ({
    id,
    object: 'model',
    created: 0,
    owned_by: 'gemini-business',
  }));

  sendJson(res, 200, { object: 'list', data });
}

/** Accepts the key from `x-api-key` or `Authorization: Bearer <key>`. */
function authorize(options: ServerOptions, req: IncomingMessage): boolean {
  if (options.api_keys.length === 0) {
    return true;
  }

  const header = req.headers['x-api-key'];
  const candidates = [
    typeof header === 'string' ? header : '',
    bearerToken(req.headers.authorization),
  ].filter((candidate) => candidate !== '');

  return candidates.some((candidate) => matchesKey(candidate, options.api_keys));
}

function bearerToken(header: string | undefined): string {
  if (!header) {
    return '';
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : '';
}

function matchesKey(candidate: string, keys: string[]): boolean {
  const candidateBuffer = Buffer.from(candidate);
  return keys.some((key) => {
    const keyBuffer = Buffer.from(key);
    return candidateBuffer.length === keyBuffer.length && timingSafeEqual(candidateBuffer, keyBuffer);
  });
}

async function readJsonBody(req: IncomingMessage): Promise<{ body: Json } | { failure: true }> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }

  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (raw === '') {
    return { failure: true };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { failure: true };
    }
    return { body: parsed as Json };
  } catch {
    return { failure: true };
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

/** Writes one SSE frame, waiting for `drain` and giving up if the client is gone. */
function writeFrame(res: ServerResponse, frame: string): Promise<void> {
  // `Promise.withResolvers` is Node 22+; the supported floor is Node 18.
  return new Promise((resolve, reject) => {
    if (res.write(frame)) {
      resolve();
      return;
    }

    const cleanup = () => {
      res.off('drain', onDrain);
      res.off('close', onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error('Client closed the connection'));
    };

    res.on('drain', onDrain);
    res.on('close', onClose);
  });
}

function endResponse(res: ServerResponse): void {
  if (!res.writableEnded && !res.destroyed) {
    res.end();
  }
}

function anthropicError(type: string, message: string): { type: 'error'; error: { type: string; message: string } } {
  return { type: 'error', error: { type, message } };
}

function openaiError(type: string, message: string): { error: { message: string; type: string } } {
  return { error: { message, type } };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Error dialect for a failed turn.
 *
 * A refusal is the caller's request being unacceptable — Claude Code reads
 * `invalid_request_error` plus the "too large"/"exceeds" wording as a full
 * context and compacts the conversation, where `api_error` only reports a
 * provider fault. Everything else stays a provider-side `api_error`.
 */
function failureDialect(error: unknown): { status: number; type: 'invalid_request_error' | 'api_error' } {
  return error instanceof UpstreamRequestRejection
    ? { status: 400, type: 'invalid_request_error' }
    : { status: 500, type: 'api_error' };
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}
