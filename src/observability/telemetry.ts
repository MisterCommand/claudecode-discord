import {
  context, metrics, SpanKind, SpanStatusCode, trace,
  type Attributes, type Context, type Span,
} from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import packageJson from "../../package.json";
import type { Config } from "../utils/config.js";

const HOST_SERVICE_NAME = "claude-code-discord-controller";
const AGENT_SERVICE_NAME = "claude-code-discord-agent";
const INSTRUMENTATION_NAME = "claude-code-discord-controller";
export const CONVERSATION_CONTENT_LIMIT_BYTES = 60 * 1024;

const tracer = trace.getTracer(INSTRUMENTATION_NAME, packageJson.version);
const meter = metrics.getMeter(INSTRUMENTATION_NAME, packageJson.version);
const turnCounter = meter.createCounter("claudecode_discord.turns", { unit: "{turn}" });
const turnDuration = meter.createHistogram("claudecode_discord.turn.duration", { unit: "ms" });
const activeTurns = meter.createUpDownCounter("claudecode_discord.turn.active", { unit: "{turn}" });
const queuedTurns = meter.createUpDownCounter("claudecode_discord.queue.depth", { unit: "{turn}" });
const queueWaitDuration = meter.createHistogram("claudecode_discord.queue.wait.duration", { unit: "ms" });
const toolCallCounter = meter.createCounter("claudecode_discord.tool.calls", { unit: "{call}" });
const agentCostCounter = meter.createCounter("claudecode_discord.agent.cost", { unit: "USD" });
const agentTokenCounter = meter.createCounter("claudecode_discord.agent.tokens", { unit: "{token}" });
const agentTurnCount = meter.createHistogram("claudecode_discord.agent.turns", { unit: "{turn}" });

let telemetrySdk: NodeSDK | undefined;

export interface TurnObservationStart {
  source: "interactive" | "schedule";
  guildId?: string;
  channelId: string;
  userId?: string;
  messageId?: string;
  scheduleId?: string;
  scheduleName?: string;
}

export interface AgentResultSummary {
  durationMs: number;
  apiDurationMs: number;
  numTurns: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  isError: boolean;
  subtype: string;
}

export interface CapturedContent {
  value: string;
  originalBytes: number;
  capturedBytes: number;
  truncated: boolean;
}

function turnMetricAttributes(
  source: TurnObservationStart["source"],
  accessProfile?: string,
  outcome?: string,
): Attributes {
  return {
    "turn.source": source,
    ...(accessProfile ? { "access.profile": accessProfile } : {}),
    ...(outcome ? { "turn.outcome": outcome } : {}),
  };
}

function endpoint(base: string, signal: "traces" | "metrics"): string {
  return `${base}/v1/${signal}`;
}

export function initializeTelemetry(config: Config): boolean {
  if (!config.HONEYCOMB_API_KEY || telemetrySdk) return Boolean(telemetrySdk);

  const headers = { "x-honeycomb-team": config.HONEYCOMB_API_KEY };
  try {
    telemetrySdk = new NodeSDK({
      resource: defaultResource().merge(resourceFromAttributes({
        "service.name": HOST_SERVICE_NAME,
        "service.version": packageJson.version,
        "deployment.environment.name": process.env.NODE_ENV ?? "development",
      })),
      traceExporter: new OTLPTraceExporter({
        url: endpoint(config.HONEYCOMB_API_ENDPOINT, "traces"),
        headers,
      }),
      metricReaders: [new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: endpoint(config.HONEYCOMB_API_ENDPOINT, "metrics"),
          headers,
        }),
        exportIntervalMillis: 15_000,
      })],
    });
    telemetrySdk.start();
    console.log(`Honeycomb observability enabled for ${HOST_SERVICE_NAME}`);
    return true;
  } catch (error) {
    telemetrySdk = undefined;
    console.warn("Honeycomb observability could not be initialized; continuing without host telemetry:", error);
    return false;
  }
}

export async function shutdownTelemetry(): Promise<void> {
  const sdk = telemetrySdk;
  telemetrySdk = undefined;
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch (error) {
    console.warn("Honeycomb observability could not flush cleanly:", error);
  }
}

export function agentTelemetryEnvironment(config: Config): NodeJS.ProcessEnv {
  if (!config.HONEYCOMB_API_KEY) return {
    HONEYCOMB_API_KEY: undefined,
  };

  const resourceAttributes = [
    `service.version=${encodeURIComponent(packageJson.version)}`,
    `deployment.environment.name=${encodeURIComponent(process.env.NODE_ENV ?? "development")}`,
  ].join(",");
  const headers = `x-honeycomb-team=${config.HONEYCOMB_API_KEY}`;
  return {
    // Keep the dedicated key out of the Claude process. Claude Code strips the
    // OTEL_* variables below before launching Bash, hooks, MCP servers, or LSPs.
    HONEYCOMB_API_KEY: undefined,
    OTEL_CONFIG_FILE: undefined,
    OTEL_SDK_DISABLED: "false",
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
    CLAUDE_CODE_OTEL_DIAG_STDERR: "1",
    OTEL_TRACES_EXPORTER: "otlp",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: endpoint(config.HONEYCOMB_API_ENDPOINT, "traces"),
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: endpoint(config.HONEYCOMB_API_ENDPOINT, "metrics"),
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${config.HONEYCOMB_API_ENDPOINT}/v1/logs`,
    OTEL_EXPORTER_OTLP_HEADERS: headers,
    OTEL_SERVICE_NAME: AGENT_SERVICE_NAME,
    OTEL_RESOURCE_ATTRIBUTES: resourceAttributes,
    OTEL_METRIC_EXPORT_INTERVAL: "15000",
    OTEL_LOGS_EXPORT_INTERVAL: "5000",
    OTEL_TRACES_EXPORT_INTERVAL: "5000",
    // Export full Claude execution content. Raw API bodies use inline mode so
    // they reach Honeycomb rather than being written to host-local files.
    OTEL_LOG_USER_PROMPTS: "1",
    OTEL_LOG_ASSISTANT_RESPONSES: "1",
    OTEL_LOG_TOOL_DETAILS: "1",
    OTEL_LOG_TOOL_CONTENT: "1",
    OTEL_LOG_RAW_API_BODIES: "1",
    CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH: "61440",
  };
}

function bufferSliceWithoutReplacement(bytes: Buffer, start: number, end: number): string {
  return bytes.subarray(start, end).toString("utf8").replace(/^\uFFFD+|\uFFFD+$/g, "");
}

export function captureConversationContent(
  value: string,
  limitBytes = CONVERSATION_CONTENT_LIMIT_BYTES,
): CapturedContent {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= limitBytes) {
    return { value, originalBytes: bytes.length, capturedBytes: bytes.length, truncated: false };
  }

  const marker = "\n… [content truncated] …\n";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (limitBytes <= markerBytes) {
    const captured = bufferSliceWithoutReplacement(bytes, 0, limitBytes);
    return {
      value: captured,
      originalBytes: bytes.length,
      capturedBytes: Buffer.byteLength(captured, "utf8"),
      truncated: true,
    };
  }

  const contentBudget = limitBytes - markerBytes;
  const prefixBudget = Math.ceil(contentBudget / 2);
  const suffixBudget = Math.floor(contentBudget / 2);
  const captured = `${bufferSliceWithoutReplacement(bytes, 0, prefixBudget)}${marker}${bufferSliceWithoutReplacement(bytes, bytes.length - suffixBudget, bytes.length)}`;
  return {
    value: captured,
    originalBytes: bytes.length,
    capturedBytes: Buffer.byteLength(captured, "utf8"),
    truncated: true,
  };
}

function errorRecord(error: unknown): { name: string; message: string } {
  const detail = error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: String(error) };
  return { ...detail, message: captureConversationContent(detail.message).value };
}

export class TurnObservation {
  private readonly rootSpan: Span;
  private readonly rootContext: Context;
  private readonly startedAt = Date.now();
  private readonly source: TurnObservationStart["source"];
  private accessProfile?: string;
  private queueSpan?: Span;
  private queuedAt?: number;
  private toolCount = 0;
  private finished = false;

  constructor(start: TurnObservationStart) {
    this.source = start.source;
    this.rootSpan = tracer.startSpan("claudecode_discord.turn", {
      kind: SpanKind.CONSUMER,
      attributes: {
        "messaging.system": "discord",
        "turn.source": start.source,
        "discord.channel.id": start.channelId,
        ...(start.guildId ? { "discord.guild.id": start.guildId } : {}),
        ...(start.userId ? { "enduser.id": start.userId } : {}),
        ...(start.messageId ? { "discord.message.id": start.messageId } : {}),
        ...(start.scheduleId ? { "schedule.id": start.scheduleId } : {}),
        ...(start.scheduleName ? { "schedule.name": start.scheduleName } : {}),
      },
    });
    this.rootContext = trace.setSpan(context.active(), this.rootSpan);
    activeTurns.add(1, turnMetricAttributes(this.source));
  }

  run<T>(callback: () => T): T {
    return context.with(this.rootContext, callback);
  }

  async runChild<T>(name: string, callback: () => Promise<T>, attributes: Attributes = {}): Promise<T> {
    if (!this.rootSpan.isRecording()) return callback();
    const span = tracer.startSpan(name, { attributes }, this.rootContext);
    const childContext = trace.setSpan(this.rootContext, span);
    try {
      const result = await context.with(childContext, callback);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      const detail = errorRecord(error);
      span.recordException(detail);
      span.setStatus({ code: SpanStatusCode.ERROR, message: detail.message });
      throw error;
    } finally {
      span.end();
    }
  }

  setAttributes(attributes: Attributes): void {
    this.rootSpan.setAttributes(attributes);
  }

  setAccessProfile(profile: string): void {
    this.accessProfile = profile;
    this.rootSpan.setAttribute("access.profile", profile);
  }

  recordConversation(kind: "input" | "output", content: string): void {
    if (!this.rootSpan.isRecording()) return;
    const captured = captureConversationContent(content);
    this.rootSpan.addEvent(`conversation.${kind}`, {
      "content.body": captured.value,
      "content.original_size_bytes": captured.originalBytes,
      "content.captured_size_bytes": captured.capturedBytes,
      "content.truncated": captured.truncated,
    });
  }

  markQueued(position: number): void {
    if (this.queuedAt !== undefined) return;
    this.queuedAt = Date.now();
    this.rootSpan.setAttribute("queue.position", position);
    if (this.rootSpan.isRecording()) {
      this.queueSpan = tracer.startSpan("claudecode_discord.queue.wait", {
        attributes: { "queue.position": position },
      }, this.rootContext);
    }
    queuedTurns.add(1, turnMetricAttributes(this.source, this.accessProfile));
  }

  beginExecution(): void {
    if (this.queuedAt !== undefined) {
      const waitMs = Date.now() - this.queuedAt;
      this.rootSpan.setAttribute("queue.wait_ms", waitMs);
      queueWaitDuration.record(waitMs, turnMetricAttributes(this.source, this.accessProfile));
      this.queueSpan?.setStatus({ code: SpanStatusCode.OK });
      this.queueSpan?.end();
      this.queueSpan = undefined;
      this.queuedAt = undefined;
      queuedTurns.add(-1, turnMetricAttributes(this.source, this.accessProfile));
    } else {
      this.rootSpan.setAttribute("queue.wait_ms", 0);
    }
  }

  recordToolUse(toolName: string): void {
    this.toolCount++;
    this.rootSpan.setAttribute("agent.tool.count", this.toolCount);
    toolCallCounter.add(1, {
      ...turnMetricAttributes(this.source, this.accessProfile),
      "tool.name": toolName,
    });
  }

  recordAgentResult(result: AgentResultSummary): void {
    this.rootSpan.setAttributes({
      "agent.result.subtype": result.subtype,
      "agent.result.is_error": result.isError,
      "agent.duration_ms": result.durationMs,
      "agent.api_duration_ms": result.apiDurationMs,
      "agent.turn.count": result.numTurns,
      "agent.cost_usd": result.costUsd,
      "agent.tokens.input": result.inputTokens,
      "agent.tokens.output": result.outputTokens,
      "agent.tokens.cache_creation": result.cacheCreationTokens,
      "agent.tokens.cache_read": result.cacheReadTokens,
    });
    const attributes = turnMetricAttributes(this.source, this.accessProfile);
    agentCostCounter.add(result.costUsd, attributes);
    agentTurnCount.record(result.numTurns, attributes);
    agentTokenCounter.add(result.inputTokens, { ...attributes, "token.type": "input" });
    agentTokenCounter.add(result.outputTokens, { ...attributes, "token.type": "output" });
    agentTokenCounter.add(result.cacheCreationTokens, { ...attributes, "token.type": "cache_creation" });
    agentTokenCounter.add(result.cacheReadTokens, { ...attributes, "token.type": "cache_read" });
  }

  finish(outcome: "success" | "error" | "stopped", response?: string, error?: unknown): void {
    if (this.finished) return;
    this.finished = true;
    if (response !== undefined) this.recordConversation("output", response);
    this.rootSpan.setAttributes({
      "turn.outcome": outcome,
      "agent.tool.count": this.toolCount,
    });
    if (error !== undefined) {
      const detail = errorRecord(error);
      this.rootSpan.recordException(detail);
      this.rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: detail.message });
    } else if (outcome === "error") {
      this.rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: "Agent turn failed" });
    } else {
      this.rootSpan.setStatus({ code: SpanStatusCode.OK });
    }

    if (this.queuedAt !== undefined) {
      this.queueSpan?.setStatus({ code: SpanStatusCode.ERROR, message: "Turn ended before queue execution" });
      this.queueSpan?.end();
      this.queueSpan = undefined;
      this.queuedAt = undefined;
      queuedTurns.add(-1, turnMetricAttributes(this.source, this.accessProfile));
    }
    const attributes = turnMetricAttributes(this.source, this.accessProfile, outcome);
    const durationMs = Date.now() - this.startedAt;
    turnCounter.add(1, attributes);
    turnDuration.record(durationMs, attributes);
    activeTurns.add(-1, turnMetricAttributes(this.source));
    this.rootSpan.end();
  }
}

export function startTurnObservation(start: TurnObservationStart): TurnObservation {
  return new TurnObservation(start);
}
