import { describe, expect, it } from "vitest";
import type { Config } from "../utils/config.js";
import {
  agentTelemetryEnvironment, captureConversationContent, CONVERSATION_CONTENT_LIMIT_BYTES,
} from "./telemetry.js";

describe("conversation content capture", () => {
  it("keeps content below the limit unchanged", () => {
    expect(captureConversationContent("hello 👋")).toEqual({
      value: "hello 👋",
      originalBytes: 10,
      capturedBytes: 10,
      truncated: false,
    });
  });

  it("caps UTF-8 content while preserving both ends", () => {
    const source = `${"a".repeat(CONVERSATION_CONTENT_LIMIT_BYTES)}middle${"界".repeat(100)}`;
    const captured = captureConversationContent(source);
    expect(captured.truncated).toBe(true);
    expect(captured.value.startsWith("aaaa")).toBe(true);
    expect(captured.value.endsWith("界界界界")).toBe(true);
    expect(captured.value).toContain("[content truncated]");
    expect(captured.capturedBytes).toBeLessThanOrEqual(CONVERSATION_CONTENT_LIMIT_BYTES);
    expect(captured.originalBytes).toBe(Buffer.byteLength(source, "utf8"));
  });
});

describe("Claude telemetry environment", () => {
  it("enables all Claude signals and execution content without exposing the dedicated Honeycomb key", () => {
    const environment = agentTelemetryEnvironment({
      HONEYCOMB_API_KEY: "secret-key",
      HONEYCOMB_API_ENDPOINT: "https://api.eu1.honeycomb.io",
    } as Config);

    expect(environment.HONEYCOMB_API_KEY).toBeUndefined();
    expect(environment.OTEL_TRACES_EXPORTER).toBe("otlp");
    expect(environment.OTEL_METRICS_EXPORTER).toBe("otlp");
    expect(environment.OTEL_LOGS_EXPORTER).toBe("otlp");
    expect(environment.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBe("https://api.eu1.honeycomb.io/v1/traces");
    expect(environment.OTEL_EXPORTER_OTLP_HEADERS).toBe("x-honeycomb-team=secret-key");
    expect(environment.OTEL_LOG_USER_PROMPTS).toBe("1");
    expect(environment.OTEL_LOG_ASSISTANT_RESPONSES).toBe("1");
    expect(environment.OTEL_LOG_TOOL_DETAILS).toBe("1");
    expect(environment.OTEL_LOG_TOOL_CONTENT).toBe("1");
    expect(environment.OTEL_LOG_RAW_API_BODIES).toBe("1");
    expect(environment.CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH).toBe("61440");
  });

  it("does not activate Claude telemetry without a Honeycomb key", () => {
    expect(agentTelemetryEnvironment({
      HONEYCOMB_API_ENDPOINT: "https://api.honeycomb.io",
    } as Config)).toEqual({ HONEYCOMB_API_KEY: undefined });
  });
});
