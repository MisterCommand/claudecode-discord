import { afterEach, describe, expect, it, vi } from "vitest";
import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import { startTurnObservation } from "../observability/telemetry.js";
import { DISCORD_HISTORY_SYSTEM_PROMPT } from "../discord/tools.js";
import { sessionManager, type TurnRequest } from "./session-manager.js";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>(),
  query: vi.fn(),
}));
vi.mock("../utils/config.js", () => ({
  getConfig: () => ({
    BASE_PROJECT_DIR: "/workspace",
    access: { admin_channels: [], protected_repositories: [] },
    tools: { denied: ["WebFetch"], restricted_denied: ["Bash"] },
    claude: { providers: [{ value: "default", label: "Default" }] },
    discord_summary: { excluded_channels: ["100000000000000009"] },
  }),
}));
vi.mock("../db/database.js", () => ({
  getChain: vi.fn(), mapMessage: vi.fn(), updateChainSession: vi.fn(), updateChainStatus: vi.fn(),
}));
vi.mock("../db/channel-providers.js", () => ({ channelProviders: { get: vi.fn() } }));

afterEach(() => vi.clearAllMocks());

describe("SessionManager Discord history wiring", () => {
  it.each(["interactive", "schedule"] as const)("registers history tools for a non-Admin %s turn", async (source) => {
    const channelId = "100000000000000002";
    const status = { id: "status", edit: vi.fn() };
    status.edit.mockResolvedValue(status);
    const observation = startTurnObservation({ source, channelId });
    const finish = vi.spyOn(observation, "finish");
    vi.mocked(query).mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield {
          type: "result", subtype: "success", is_error: false, result: "Report complete.",
          duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0,
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    } as Query);

    await sessionManager.sendMessage({
      source,
      chain: { id: `chain-${source}`, label: "S-TEST", channel_id: channelId, session_id: null },
      channel: { id: channelId, guild: {}, send: vi.fn().mockResolvedValue(status) },
      prompt: "Summarize the past seven days using discord_history.collect_server_history.",
      observation,
      ...(source === "schedule" ? { scheduleName: "Weekly project summary" } : {}),
    } as unknown as TurnRequest);

    const options = vi.mocked(query).mock.calls.at(-1)?.[0].options;
    expect(options?.mcpServers?.discord_history).toMatchObject({ type: "sdk", name: "discord_history" });
    expect(options?.systemPrompt).toMatchObject({ append: expect.stringContaining(DISCORD_HISTORY_SYSTEM_PROMPT) });
    expect(options?.disallowedTools).toEqual(["AskUserQuestion", "WebFetch", "Bash"]);
    expect(options?.mcpServers?.exchange_email).toBeUndefined();
    expect(finish).toHaveBeenCalledWith("success", expect.stringContaining("Report complete."));
  });
});
