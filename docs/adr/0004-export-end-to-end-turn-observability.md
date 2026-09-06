# Export end-to-end Turn observability through OpenTelemetry

When explicitly enabled, each accepted Discord or scheduled Turn is represented by a stable bot-owned trace that covers preparation, queueing, agent execution, and Discord delivery; Claude Code's beta model and tool spans join that trace through propagated context. The bot and Claude Code export traces, metrics, and agent events directly to Honeycomb over vendor-neutral OTLP, without a bundled Collector, because native and Docker deployments should gain the same observability without another required service or inbound port.

## Consequences

Conversation Content and raw Discord correlation identifiers are intentionally exported. Prompt and final-response values preserve their beginning and end within a 60 KB limit; tool inputs, tool outputs, and raw model traffic remain excluded. Honeycomb is opt-in and export failures do not prevent Turns, while the accepted beta Claude span schema is treated as external and no bot behavior depends on its exact fields.
