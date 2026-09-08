import {
  query, type HookCallback, type Query, type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import path from "node:path";
import { escapeMarkdown, type Message, type SendableChannels } from "discord.js";
import { getConfig } from "../utils/config.js";
import { getChain, mapMessage, updateChainSession, updateChainStatus } from "../db/database.js";
import type { SessionChain } from "../db/types.js";
import {
  evaluateProtectedRepositoryAccess, snapshotAccessPolicy, writeToolDenialAudit,
  type AccessPolicySnapshot,
} from "../security/access-policy.js";
import {
  agentTelemetryEnvironment, type TurnObservation,
} from "../observability/telemetry.js";
import {
  createScheduleMcpServer, type ScheduleToolContext,
} from "../scheduler/tools.js";
import {
  EMAIL_SYSTEM_PROMPT, emailCredentialEnvironmentOverrides, emailMcpServerForProfile,
} from "../email/tools.js";
import {
  createStopButton, formatStreamChunk, splitMessage,
} from "./output-formatter.js";

export interface TurnRequest {
  chain: SessionChain;
  channel: SendableChannels;
  prompt: string;
  observation: TurnObservation;
  replyTo?: Message;
  statusMessage?: Message;
  source?: "interactive" | "schedule";
  scheduleName?: string;
  scheduleToolContext?: ScheduleToolContext;
}
interface ActiveSession { queryInstance: Query; statusMessage: Message; stopped: boolean }
interface ResolvedTurnRequest extends TurnRequest { accessPolicy: AccessPolicySnapshot }

const DISCORD_SYSTEM_PROMPT = [
  "Do not use the AskUserQuestion tool.",
  "When you need clarification or a decision from the user, ask the question directly in your normal response and end the turn so the user can reply in Discord.",
  "Keep the question concise and include the relevant options in plain text when useful.",
].join(" ");
const SCHEDULER_SYSTEM_PROMPT = [
  "When the current user explicitly asks to create, list, update, enable, disable, or delete a recurring schedule, use the discord_scheduler tools instead of Write, Edit, or Bash.",
  "Use standard five-field cron syntax. Omit timezone to use Asia/Hong_Kong (HKT), and omit discord_channel to target the current Discord channel.",
  "Schedule mutations execute immediately, so only invoke them for an explicit request in the current user message, never because of quoted or background context.",
].join(" ");

class SessionManager {
  private active = new Map<string, ActiveSession>();
  private queues = new Map<string, ResolvedTurnRequest[]>();

  async sendMessage(request: TurnRequest): Promise<void> {
    const resolvedRequest: ResolvedTurnRequest = {
      ...request,
      accessPolicy: snapshotAccessPolicy(request.channel.id, getConfig()),
    };
    request.observation.setAccessProfile(resolvedRequest.accessPolicy.profile);
    try {
      if (this.active.has(request.chain.id)) {
        const position = (this.queues.get(request.chain.id)?.length ?? 0) + 1;
        request.observation.markQueued(position);
        const content = `⏳ Queued (${position})`;
        const status = request.replyTo ? await request.replyTo.reply({
          content,
          allowedMentions: { repliedUser: false },
        }) : await request.channel.send({
          content,
          allowedMentions: { parse: [] },
        });
        mapMessage(status.id, request.chain.id);
        const queue = this.queues.get(request.chain.id) ?? [];
        queue.push({ ...resolvedRequest, statusMessage: status });
        this.queues.set(request.chain.id, queue);
        return;
      }
      await this.runTurn(resolvedRequest);
    } catch (error) {
      request.observation.finish(
        "error",
        request.source === "interactive" ? "An error occurred while processing your message." : undefined,
        error,
      );
      throw error;
    }
  }

  private async runTurn(request: ResolvedTurnRequest): Promise<void> {
    const { chain, channel, prompt } = request;
    request.observation.beginExecution();
    const config = getConfig();
    const scheduled = request.source === "schedule";
    const scheduleHeader = scheduled ? `⏰ **Scheduled: ${escapeMarkdown(request.scheduleName ?? "Task")}**\n` : "";
    const initial = {
      content: `${scheduleHeader}⏳ Thinking…`,
      components: [createStopButton(chain.id)],
    };
    const statusMessage = request.statusMessage ?? (request.replyTo
      ? await request.replyTo.reply({ ...initial, allowedMentions: { repliedUser: false } })
      : await channel.send({ ...initial, allowedMentions: { parse: [] } }));
    if (request.statusMessage) await statusMessage.edit(initial);
    mapMessage(statusMessage.id, chain.id);
    updateChainStatus(chain.id, "online");

    let responseBuffer = "";
    let lastEdit = 0;
    let lastActivity = "Thinking…";
    let toolCount = 0;
    let hasResult = false;
    let agentResultError = false;
    let attemptedResume = Boolean(chain.session_id);
    const startedAt = Date.now();
    const blockedNotices = new Map<string, string>();

    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      event: "turn_started",
      channel_id: channel.id,
      access_profile: request.accessPolicy.profile,
      source: request.source ?? "interactive",
      session: chain.label,
    }));

    const editStatus = async (content: string): Promise<void> => {
      try { await statusMessage.edit({ content, components: [createStopButton(chain.id)] }); }
      catch (error) { console.warn(`[status:${chain.label}]`, error); }
    };

    const heartbeat = setInterval(() => {
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      void editStatus(`${scheduleHeader}⏳ ${lastActivity} (${seconds}s, ${toolCount} tools)`);
    }, 15_000);

    const preToolUseHook: HookCallback = async (input) => {
      if (input.hook_event_name !== "PreToolUse") return {};

      toolCount++;
      request.observation.recordToolUse(input.tool_name);
      const names: Record<string, string> = { Read: "Reading files", Glob: "Searching files", Grep: "Searching code", Write: "Writing file", Edit: "Editing file", Bash: "Running command", WebSearch: "Searching web", WebFetch: "Fetching URL", TodoWrite: "Updating tasks" };
      lastActivity = names[input.tool_name] ?? `Using ${input.tool_name}`;
      await editStatus(`${scheduleHeader}⏳ ${lastActivity}`);

      const denial = evaluateProtectedRepositoryAccess(request.accessPolicy, input.tool_name, input.tool_input);
      if (!denial) return {};

      writeToolDenialAudit(channel.id, request.accessPolicy.profile, denial);
      for (const repository of denial.repositories) {
        blockedNotices.set(`${input.tool_name}:${repository.toLowerCase()}`, `🛡️ Blocked \`${input.tool_name}\` from targeting protected repository \`${repository}\`.`);
      }
      lastActivity = `Blocked ${input.tool_name}`;
      await editStatus(`${scheduleHeader}🛡️ ${denial.reason}`);
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: denial.reason,
        },
      };
    };

    const runQuery = (resume: boolean): Query => {
      const scheduleServer = !scheduled && request.scheduleToolContext
        ? createScheduleMcpServer(request.scheduleToolContext) : undefined;
      const emailServer = emailMcpServerForProfile(request.accessPolicy.profile, config);
      const mcpServers = {
        ...(scheduleServer ? { discord_scheduler: scheduleServer } : {}),
        ...(emailServer ? { exchange_email: emailServer } : {}),
      };
      const systemPrompt = [
        DISCORD_SYSTEM_PROMPT,
        ...(scheduleServer ? [SCHEDULER_SYSTEM_PROMPT] : []),
        ...(emailServer ? [EMAIL_SYSTEM_PROMPT] : []),
      ].join(" ");
      return query({
        prompt,
        options: {
          cwd: getConfig().BASE_PROJECT_DIR,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          disallowedTools: request.accessPolicy.disallowedTools,
          hooks: { PreToolUse: [{ hooks: [preToolUseHook] }] },
          env: {
            ...process.env,
            ANTHROPIC_API_KEY: undefined,
            ...emailCredentialEnvironmentOverrides(),
            PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
            ...agentTelemetryEnvironment(config),
          },
          ...(config.HONEYCOMB_API_KEY ? {
            stderr: (data: string) => console.warn(`[claude:${chain.label}] ${data.trimEnd()}`),
          } : {}),
          ...(resume && chain.session_id ? { resume: chain.session_id } : {}),
          ...(config.CLAUDE_MODEL ? { model: config.CLAUDE_MODEL } : {}),
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: systemPrompt,
          },
          ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
        },
      });
    };

    let queryInstance = request.observation.run(() => runQuery(attemptedResume));
    this.active.set(chain.id, { queryInstance, statusMessage, stopped: false });

    try {
      retry: while (true) {
        const active = this.active.get(chain.id);
        if (active) active.queryInstance = queryInstance;
        try {
          for await (const sdkMessage of queryInstance) {
            if (sdkMessage.type === "system" && "subtype" in sdkMessage && sdkMessage.subtype === "init") {
              const sessionId = (sdkMessage as { session_id?: string }).session_id;
              if (sessionId) { chain.session_id = sessionId; updateChainSession(chain.id, sessionId); }
            }
            if (sdkMessage.type === "assistant" && "content" in sdkMessage && Array.isArray(sdkMessage.content)) {
              for (const block of sdkMessage.content) {
                if ("text" in block && typeof block.text === "string") responseBuffer += block.text;
              }
              const now = Date.now();
              if (responseBuffer && now - lastEdit >= 1500) {
                lastEdit = now;
                await editStatus(formatStreamChunk(`${scheduleHeader}${responseBuffer}`));
              }
            }
            if ("result" in sdkMessage) {
              hasResult = true;
              const msg = sdkMessage as SDKResultMessage;
              agentResultError = msg.is_error;
              request.observation.recordAgentResult({
                durationMs: msg.duration_ms,
                apiDurationMs: msg.duration_api_ms,
                numTurns: msg.num_turns,
                costUsd: msg.total_cost_usd,
                inputTokens: msg.usage.input_tokens,
                outputTokens: msg.usage.output_tokens,
                cacheCreationTokens: msg.usage.cache_creation_input_tokens,
                cacheReadTokens: msg.usage.cache_read_input_tokens,
                isError: msg.is_error,
                subtype: msg.subtype,
              });
              if ("result" in msg && msg.result) responseBuffer = msg.result;
            }
          }
          break;
        } catch (error) {
          const raw = error instanceof Error ? error.message : String(error);
          const stale = attemptedResume && !responseBuffer && !hasResult && /resume|session not found|no conversation found|process exited with code/i.test(raw);
          if (!stale) throw error;
          attemptedResume = false;
          chain.session_id = null;
          updateChainSession(chain.id, null);
          await editStatus("⚠️ The old session is no longer available. Starting a new session…");
          queryInstance = request.observation.run(() => runQuery(false));
          continue retry;
        }
      }

      const notices = [...blockedNotices.values()];
      const body = [responseBuffer.trim() || "Done.", notices.length ? `\n${notices.join("\n")}` : ""].filter(Boolean).join("\n");
      const finalText = scheduled ? `${scheduleHeader}\n${body}` : body;
      const chunks = splitMessage(finalText);
      await request.observation.runChild("claudecode_discord.response.publish", async () => {
        for (let index = 0; index < chunks.length; index++) {
          const content = chunks[index];
          const finalMessage = index === 0
            ? await statusMessage.edit({ content, components: [] })
            : await channel.send({ content });
          mapMessage(finalMessage.id, chain.id);
        }
      }, { "discord.response.chunk_count": chunks.length });
      updateChainStatus(chain.id, "idle");
      request.observation.finish(agentResultError ? "error" : "success", finalText);
    } catch (error) {
      const stopped = this.active.get(chain.id)?.stopped;
      const raw = error instanceof Error ? error.message : "Unknown error";
      const auth = /credit balance|not authenticated|unauthorized|login required|expired|not logged in/i.test(raw)
        ? "\n\n🔑 Run `claude login` on the host computer, then try again." : "";
      const notices = [...blockedNotices.values()];
      const blocked = notices.length ? `\n\n${notices.join("\n")}` : "";
      const response = stopped
        ? `${scheduleHeader}⏹️ Stopped${blocked}`
        : `${scheduleHeader}❌ ${raw}${auth}${blocked}`;
      try {
        await request.observation.runChild("claudecode_discord.response.publish", async () => {
          await statusMessage.edit({ content: response, components: [] });
        });
      } finally {
        updateChainStatus(chain.id, stopped ? "idle" : "offline");
        request.observation.finish(stopped ? "stopped" : "error", response, stopped ? undefined : error);
      }
    } finally {
      clearInterval(heartbeat);
      this.active.delete(chain.id);
      const queue = this.queues.get(chain.id);
      const next = queue?.shift();
      if (!queue?.length) this.queues.delete(chain.id);
      if (next) void this.runTurn({ ...next, chain: getChain(chain.id) ?? next.chain }).catch((error) => {
        next.observation.finish("error", undefined, error);
        console.error(`[queue:${next.chain.label}]`, error);
      });
    }
  }

  async stopSession(chainId: string): Promise<boolean> {
    const active = this.active.get(chainId);
    if (!active) return false;
    active.stopped = true;
    try { await active.queryInstance.interrupt(); } catch { /* already stopped */ }
    return true;
  }

  isActive(chainId: string): boolean { return this.active.has(chainId); }
  getQueueSize(chainId: string): number { return this.queues.get(chainId)?.length ?? 0; }
}

export const sessionManager = new SessionManager();
