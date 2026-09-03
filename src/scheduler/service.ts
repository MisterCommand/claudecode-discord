import { createHash, randomUUID } from "node:crypto";
import fs, { type FSWatcher } from "node:fs";
import path from "node:path";
import { Cron } from "croner";
import { PermissionFlagsBits, type Client } from "discord.js";
import {
  createCron, parseScheduleFile, scheduleIdFromName, ScheduleParseError, serializeSchedule,
} from "./parser.js";
import type { ScheduleCreateInput, ScheduleDefinition, ScheduleStatus, ScheduleUpdateInput } from "./types.js";

interface ActiveJob { job: Cron; sourceHash: string }
interface RegistryRecord {
  id: string;
  filePath: string;
  sourceHash: string;
  definition?: ScheduleDefinition;
  error?: string;
  discordChannel?: string;
}

export type ScheduleRunner = (definition: ScheduleDefinition) => Promise<void>;

export class ScheduleService {
  private records = new Map<string, RegistryRecord>();
  private jobs = new Map<string, ActiveJob>();
  private notifiedErrors = new Map<string, string>();
  private watcher?: FSWatcher;
  private reconciliationTimer?: NodeJS.Timeout;
  private debounceTimer?: NodeJS.Timeout;
  private reconciliationQueue: Promise<void> = Promise.resolve();
  private client?: Client;
  private runner?: ScheduleRunner;
  private started = false;

  constructor(
    public readonly directory = path.join(process.cwd(), "schedules"),
    private readonly reconciliationMs = 60_000,
  ) {}

  async start(client: Client, runner: ScheduleRunner): Promise<void> {
    this.client = client;
    this.runner = runner;
    fs.mkdirSync(this.directory, { recursive: true });
    if (this.started) {
      await this.reconcile();
      return;
    }
    this.started = true;
    try { await this.reconcile(); }
    catch (error) {
      this.started = false;
      throw error;
    }

    try {
      this.watcher = fs.watch(this.directory, () => this.scheduleReconcile());
      this.watcher.on("error", (error) => console.error("Schedule directory watcher error:", error));
    } catch (error) {
      console.error("Could not watch the schedule directory; periodic reconciliation remains active:", error);
    }
    this.reconciliationTimer = setInterval(() => { void this.reconcile(); }, this.reconciliationMs);
    this.reconciliationTimer.unref();
    console.log(`Loaded ${[...this.records.values()].filter((record) => record.definition).length} schedule(s) from ${this.directory}`);
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.reconciliationTimer) clearInterval(this.reconciliationTimer);
    this.debounceTimer = undefined;
    this.reconciliationTimer = undefined;
    for (const active of this.jobs.values()) active.job.stop();
    this.jobs.clear();
    this.started = false;
  }

  private scheduleReconcile(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.reconcile();
    }, 500);
  }

  reconcile(): Promise<void> {
    const next = this.reconciliationQueue.then(() => this.performReconcile());
    this.reconciliationQueue = next.catch(() => undefined);
    return next;
  }

  private async performReconcile(): Promise<void> {
    fs.mkdirSync(this.directory, { recursive: true });
    const nextRecords = new Map<string, RegistryRecord>();
    const files = fs.readdirSync(this.directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .map((entry) => path.join(this.directory, entry.name))
      .sort((a, b) => a.localeCompare(b));

    for (const filePath of files) {
      let source = "";
      let id = path.basename(filePath, path.extname(filePath)).toLowerCase();
      try {
        source = fs.readFileSync(filePath, "utf8");
        const definition = parseScheduleFile(filePath, source);
        id = definition.id;
        nextRecords.set(id, {
          id, filePath, sourceHash: definition.sourceHash, definition,
          discordChannel: definition.discordChannel,
        });
      } catch (error) {
        const sourceHash = createHash("sha256").update(source || filePath).digest("hex");
        nextRecords.set(id, {
          id, filePath, sourceHash,
          error: error instanceof Error ? error.message : String(error),
          discordChannel: error instanceof ScheduleParseError ? error.discordChannel : undefined,
        });
      }
    }

    const names = new Map<string, RegistryRecord[]>();
    for (const record of nextRecords.values()) {
      if (!record.definition) continue;
      const key = record.definition.name.toLocaleLowerCase();
      const matches = names.get(key) ?? [];
      matches.push(record);
      names.set(key, matches);
    }
    for (const matches of names.values()) {
      if (matches.length < 2) continue;
      for (const record of matches) {
        record.error = `duplicate schedule name: ${record.definition!.name}`;
        record.discordChannel = record.definition!.discordChannel;
        record.definition = undefined;
      }
    }

    if (this.client) {
      for (const record of nextRecords.values()) {
        if (!record.definition) continue;
        const previous = this.records.get(record.id);
        if (previous?.definition && previous.sourceHash === record.sourceHash) continue;
        const channelError = await this.validateTargetChannel(record.definition.discordChannel);
        if (channelError) {
          record.error = channelError;
          record.discordChannel = record.definition.discordChannel;
          record.definition = undefined;
        }
      }
    }

    for (const [id, active] of this.jobs) {
      const record = nextRecords.get(id);
      if (!record?.definition?.enabled || record.sourceHash !== active.sourceHash) {
        active.job.stop();
        this.jobs.delete(id);
      }
    }

    this.records = nextRecords;
    for (const record of this.records.values()) {
      if (this.started && record.definition?.enabled && !this.jobs.has(record.id)) this.startJob(record.definition);
      if (record.error) void this.notifyValidationFailure(record);
      else this.notifiedErrors.delete(record.id);
    }
  }

  private startJob(definition: ScheduleDefinition): void {
    const job = new Cron(definition.cron, {
      timezone: definition.timezone,
      mode: "5-part",
      protect: false,
      unref: true,
      catch: (error) => console.error(`[schedule:${definition.id}]`, error),
    }, () => {
      const current = this.records.get(definition.id)?.definition;
      if (!current || current.sourceHash !== definition.sourceHash || !current.enabled || !this.runner) return;
      void this.runner(current).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[schedule:${current.id}] ${message}`);
        void this.sendChannelNotice(current.discordChannel, `❌ Scheduled task **${current.name}** could not start: ${message}`);
      });
    });
    this.jobs.set(definition.id, { job, sourceHash: definition.sourceHash });
  }

  private async notifyValidationFailure(record: RegistryRecord): Promise<void> {
    const fingerprint = `${record.sourceHash}:${record.error}`;
    if (this.notifiedErrors.get(record.id) === fingerprint) return;
    this.notifiedErrors.set(record.id, fingerprint);
    console.error(`[schedule:${record.id}] ${record.error}`);
    if (record.discordChannel) {
      await this.sendChannelNotice(
        record.discordChannel,
        `⚠️ Schedule file **${path.basename(record.filePath)}** is disabled: ${record.error}`,
      );
    }
  }

  private async sendChannelNotice(channelId: string, content: string): Promise<void> {
    if (!this.client) return;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel?.isSendable()) await channel.send({ content: content.slice(0, 1900), allowedMentions: { parse: [] } });
    } catch (error) {
      console.error(`[schedule:${channelId}] Could not send Discord notice:`, error);
    }
  }

  private async validateTargetChannel(channelId: string): Promise<string | undefined> {
    if (!this.client) return undefined;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isSendable() || !("guildId" in channel)) {
        return `discord_channel ${channelId} is unavailable or not sendable`;
      }
      if ("permissionsFor" in channel && "guild" in channel) {
        const botMember = channel.guild.members.me;
        const permissions = botMember ? channel.permissionsFor(botMember) : null;
        const sendPermission = channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
        if (!permissions?.has(PermissionFlagsBits.ViewChannel) || !permissions.has(sendPermission)) {
          return `the bot cannot view or send messages in discord_channel ${channelId}`;
        }
      }
      return undefined;
    } catch (error) {
      return `discord_channel ${channelId} could not be fetched: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  getStatuses(channelId?: string): ScheduleStatus[] {
    return [...this.records.values()]
      .filter((record) => !channelId || record.definition?.discordChannel === channelId || record.discordChannel === channelId)
      .map((record) => ({
        id: record.id,
        filePath: record.filePath,
        definition: record.definition,
        error: record.error,
        discordChannel: record.definition?.discordChannel ?? record.discordChannel,
        nextRun: record.definition?.enabled ? this.jobs.get(record.id)?.job.nextRun() ?? this.previewNextRuns(record.definition, 1)[0] ?? null : null,
      }))
      .sort((a, b) => (a.definition?.name ?? a.id).localeCompare(b.definition?.name ?? b.id));
  }

  getDefinition(identifier: string): ScheduleDefinition | undefined {
    const direct = this.records.get(identifier.toLowerCase())?.definition;
    if (direct) return direct;
    const normalized = identifier.trim().toLocaleLowerCase();
    return [...this.records.values()].find((record) => record.definition?.name.toLocaleLowerCase() === normalized)?.definition;
  }

  previewNextRuns(definition: Pick<ScheduleDefinition, "cron" | "timezone">, count = 3): Date[] {
    const cron = createCron(definition.cron, definition.timezone);
    try { return cron.nextRuns(count); }
    finally { cron.stop(); }
  }

  async create(input: ScheduleCreateInput): Promise<ScheduleDefinition> {
    await this.reconcile();
    const id = scheduleIdFromName(input.name);
    const target = this.pathForId(id);
    if (fs.existsSync(target)) throw new Error(`schedule file already exists: ${id}.md`);
    this.assertUniqueName(input.name);
    const source = serializeSchedule(input);
    parseScheduleFile(target, source);
    await this.atomicWrite(target, source);
    await this.reconcile();
    const created = this.records.get(id)?.definition;
    if (!created) throw new Error(`schedule ${id} could not be loaded after creation`);
    return created;
  }

  async update(identifier: string, patch: ScheduleUpdateInput): Promise<ScheduleDefinition> {
    await this.reconcile();
    const current = this.getDefinition(identifier);
    if (!current) throw new Error(`schedule not found: ${identifier}`);
    const input: ScheduleCreateInput = {
      name: patch.name ?? current.name,
      description: patch.description === null ? undefined : patch.description ?? current.description,
      cron: patch.cron ?? current.cron,
      discordChannel: patch.discordChannel ?? current.discordChannel,
      enabled: patch.enabled ?? current.enabled,
      timezone: patch.timezone === null ? undefined : patch.timezone ?? current.timezone,
      prompt: patch.prompt ?? current.prompt,
    };
    this.assertUniqueName(input.name, current.id);
    const source = serializeSchedule(input);
    parseScheduleFile(current.filePath, source);
    await this.atomicWrite(current.filePath, source);
    await this.reconcile();
    const updated = this.records.get(current.id)?.definition;
    if (!updated) throw new Error(`schedule ${current.id} could not be loaded after update`);
    return updated;
  }

  async delete(identifier: string): Promise<ScheduleDefinition> {
    await this.reconcile();
    const current = this.getDefinition(identifier);
    if (!current) throw new Error(`schedule not found: ${identifier}`);
    await fs.promises.unlink(current.filePath);
    await this.reconcile();
    return current;
  }

  private assertUniqueName(name: string, exceptId?: string): void {
    const normalized = name.trim().toLocaleLowerCase();
    const duplicate = [...this.records.values()].find((record) =>
      record.definition && record.id !== exceptId && record.definition.name.toLocaleLowerCase() === normalized);
    if (duplicate) throw new Error(`schedule name already exists: ${name}`);
  }

  private pathForId(id: string): string {
    const target = path.resolve(this.directory, `${id}.md`);
    if (path.dirname(target) !== path.resolve(this.directory)) throw new Error("invalid schedule ID");
    return target;
  }

  private async atomicWrite(target: string, source: string): Promise<void> {
    const temporary = path.join(this.directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
    try {
      await fs.promises.writeFile(temporary, source, { encoding: "utf8", flag: "wx" });
      await fs.promises.rename(temporary, target);
    } finally {
      await fs.promises.unlink(temporary).catch(() => undefined);
    }
  }
}

export const scheduleService = new ScheduleService();
