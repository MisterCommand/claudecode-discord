import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Message } from "discord.js";
import { getConfig } from "../utils/config.js";
import { getChain, mapMessage, updateChainSession, updateChainStatus } from "../db/database.js";
import type { SessionChain } from "../db/types.js";
import {
  createAskUserQuestionEmbed, createStopButton, createToolApprovalEmbed,
  formatStreamChunk, splitMessage, type AskQuestionData,
} from "./output-formatter.js";

export interface TurnRequest { chain: SessionChain; trigger: Message; prompt: string; statusMessage?: Message }
interface ActiveSession { queryInstance: Query; statusMessage: Message; stopped: boolean }
interface PendingDecision<T> { resolve: (value: T) => void; chainId: string; message: Message }

const pendingApprovals = new Map<string, PendingDecision<{ behavior: "allow" | "deny"; message?: string }>>();
const pendingQuestions = new Map<string, PendingDecision<string | null>>();

class SessionManager {
  private active = new Map<string, ActiveSession>();
  private queues = new Map<string, TurnRequest[]>();

  async sendMessage(request: TurnRequest): Promise<void> {
    if (this.active.has(request.chain.id)) {
      const status = await request.trigger.reply({
        content: `⏳ Queued for **${request.chain.label}** (${(this.queues.get(request.chain.id)?.length ?? 0) + 1})`,
        allowedMentions: { repliedUser: false },
      });
      mapMessage(status.id, request.chain.id);
      const queue = this.queues.get(request.chain.id) ?? [];
      queue.push({ ...request, statusMessage: status });
      this.queues.set(request.chain.id, queue);
      return;
    }
    await this.runTurn(request);
  }

  private async runTurn(request: TurnRequest): Promise<void> {
    const { chain, trigger, prompt } = request;
    if (!trigger.channel.isSendable()) throw new Error("Discord channel is not sendable");
    const channel = trigger.channel;
    const statusMessage = request.statusMessage ?? await trigger.reply({
      content: `⏳ Thinking…  •  **${chain.label}**`,
      components: [createStopButton(chain.id)],
      allowedMentions: { repliedUser: false },
    });
    mapMessage(statusMessage.id, chain.id);
    updateChainStatus(chain.id, "online");

    let responseBuffer = "";
    let lastEdit = 0;
    let lastActivity = "Thinking…";
    let toolCount = 0;
    let hasResult = false;
    let attemptedResume = Boolean(chain.session_id);
    const startedAt = Date.now();

    const editStatus = async (content: string): Promise<void> => {
      try { await statusMessage.edit({ content, components: [createStopButton(chain.id)] }); }
      catch (error) { console.warn(`[status:${chain.label}]`, error); }
    };

    const heartbeat = setInterval(() => {
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      void editStatus(`⏳ ${lastActivity} (${seconds}s, ${toolCount} tools)  •  **${chain.label}**`);
    }, 15_000);

    const runQuery = (resume: boolean): Query => query({
      prompt,
      options: {
        cwd: getConfig().BASE_PROJECT_DIR,
        permissionMode: "default",
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: undefined,
          PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
        },
        ...(resume && chain.session_id ? { resume: chain.session_id } : {}),
        ...(getConfig().CLAUDE_MODEL ? { model: getConfig().CLAUDE_MODEL } : {}),
        canUseTool: async (toolName: string, input: Record<string, unknown>) => {
          toolCount++;
          const names: Record<string, string> = { Read: "Reading files", Glob: "Searching files", Grep: "Searching code", Write: "Writing file", Edit: "Editing file", Bash: "Running command", WebSearch: "Searching web", WebFetch: "Fetching URL", TodoWrite: "Updating tasks" };
          lastActivity = names[toolName] ?? `Using ${toolName}`;
          await editStatus(`⏳ ${lastActivity}  •  **${chain.label}**`);

          if (toolName === "AskUserQuestion") {
            const questions = (input.questions as AskQuestionData[]) ?? [];
            const answers: Record<string, string> = {};
            for (let index = 0; index < questions.length; index++) {
              const requestId = randomUUID();
              const ui = createAskUserQuestionEmbed(questions[index], requestId, index, questions.length);
              const questionMessage = await channel.send({ embeds: [ui.embed], components: ui.components });
              updateChainStatus(chain.id, "waiting");
              const answer = await new Promise<string | null>((resolve) => {
                const timeout = setTimeout(() => {
                  pendingQuestions.delete(requestId);
                  void questionMessage.delete().catch(() => undefined);
                  resolve(null);
                }, 5 * 60_000);
                pendingQuestions.set(requestId, {
                  chainId: chain.id, message: questionMessage,
                  resolve: (value) => { clearTimeout(timeout); pendingQuestions.delete(requestId); resolve(value); },
                });
              });
              updateChainStatus(chain.id, "online");
              if (answer === null) return { behavior: "deny" as const, message: "Question timed out" };
              answers[questions[index].header] = answer;
            }
            return { behavior: "allow" as const, updatedInput: { ...input, answers } };
          }

          if (["Read", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite"].includes(toolName)) {
            return { behavior: "allow" as const, updatedInput: input };
          }

          const requestId = randomUUID();
          const ui = createToolApprovalEmbed(toolName, input, requestId);
          const approvalMessage = await channel.send({ embeds: [ui.embed], components: [ui.row] });
          updateChainStatus(chain.id, "waiting");
          return new Promise((resolve) => {
            const timeout = setTimeout(() => {
              pendingApprovals.delete(requestId);
              void approvalMessage.delete().catch(() => undefined);
              updateChainStatus(chain.id, "online");
              resolve({ behavior: "deny" as const, message: "Approval timed out" });
            }, 5 * 60_000);
            pendingApprovals.set(requestId, {
              chainId: chain.id, message: approvalMessage,
              resolve: (decision) => {
                clearTimeout(timeout); pendingApprovals.delete(requestId); updateChainStatus(chain.id, "online");
                resolve(decision.behavior === "allow"
                  ? { behavior: "allow" as const, updatedInput: input }
                  : { behavior: "deny" as const, message: decision.message ?? "Denied by user" });
              },
            });
          });
        },
      },
    });

    let queryInstance = runQuery(attemptedResume);
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
                await editStatus(`${formatStreamChunk(responseBuffer)}\n\n-# ${chain.label} • working`);
              }
            }
            if ("result" in sdkMessage) {
              hasResult = true;
              const msg = sdkMessage as { result?: string };
              if (msg.result) responseBuffer = msg.result;
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
          await editStatus(`⚠️ The old session is no longer available. Starting a new session…  •  **${chain.label}**`);
          queryInstance = runQuery(false);
          continue retry;
        }
      }

      const finalText = responseBuffer.trim() || "Done.";
      const chunks = splitMessage(finalText);
      for (let index = 0; index < chunks.length; index++) {
        const content = `${chunks[index]}\n\n-# Session ${chain.label}`;
        const finalMessage = index === 0
          ? await statusMessage.edit({ content, components: [] })
          : await channel.send({ content });
        mapMessage(finalMessage.id, chain.id);
      }
      updateChainStatus(chain.id, "idle");
    } catch (error) {
      const stopped = this.active.get(chain.id)?.stopped;
      const raw = error instanceof Error ? error.message : "Unknown error";
      const auth = /credit balance|not authenticated|unauthorized|login required|expired|not logged in/i.test(raw)
        ? "\n\n🔑 Run `claude login` on the host computer, then try again." : "";
      await statusMessage.edit({ content: stopped ? `⏹️ Stopped  •  **${chain.label}**` : `❌ ${raw}${auth}\n\n-# Session ${chain.label}`, components: [] });
      updateChainStatus(chain.id, stopped ? "idle" : "offline");
    } finally {
      clearInterval(heartbeat);
      this.active.delete(chain.id);
      for (const [id, pending] of pendingApprovals) if (pending.chainId === chain.id) { pendingApprovals.delete(id); void pending.message.delete().catch(() => undefined); }
      for (const [id, pending] of pendingQuestions) if (pending.chainId === chain.id) { pendingQuestions.delete(id); void pending.message.delete().catch(() => undefined); }
      const queue = this.queues.get(chain.id);
      const next = queue?.shift();
      if (!queue?.length) this.queues.delete(chain.id);
      if (next) void this.runTurn({ ...next, chain: getChain(chain.id) ?? next.chain });
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

  resolveApproval(requestId: string, decision: "approve" | "deny"): Message | undefined {
    const pending = pendingApprovals.get(requestId);
    if (!pending) return undefined;
    pending.resolve(decision === "approve" ? { behavior: "allow" } : { behavior: "deny", message: "Denied by user" });
    return pending.message;
  }

  resolveQuestion(requestId: string, answer: string): Message | undefined {
    const pending = pendingQuestions.get(requestId);
    if (!pending) return undefined;
    pending.resolve(answer);
    return pending.message;
  }
}

export const sessionManager = new SessionManager();
