import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serializeSchedule } from "./parser.js";
import { ScheduleService } from "./service.js";

const channel = "123456789012345678";
let directory: string;
let service: ScheduleService;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-schedules-"));
  service = new ScheduleService(directory, 60_000);
});

afterEach(() => {
  service.stop();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("ScheduleService", () => {
  it("creates, updates, lists, and deletes Markdown schedules", async () => {
    const created = await service.create({
      name: "Daily summary", cron: "0 8 * * *", discordChannel: channel, prompt: "Summarize changes.",
    });
    expect(created.id).toBe("daily-summary");
    expect(fs.readFileSync(path.join(directory, "daily-summary.md"), "utf8")).toContain("discord_channel");
    expect(service.getStatuses(channel)).toHaveLength(1);
    expect(service.getStatuses(channel)[0].nextRun).toBeInstanceOf(Date);

    const updated = await service.update("Daily summary", { enabled: false, timezone: "Asia/Hong_Kong" });
    expect(updated).toMatchObject({ enabled: false, timezone: "Asia/Hong_Kong" });
    expect(service.getStatuses(channel)[0].nextRun).toBeNull();

    await service.delete(created.id);
    expect(service.getStatuses(channel)).toHaveLength(0);
    expect(fs.existsSync(path.join(directory, "daily-summary.md"))).toBe(false);
  });

  it("rejects filename and schedule-name collisions", async () => {
    await service.create({ name: "Daily summary", cron: "0 8 * * *", discordChannel: channel, prompt: "One" });
    await expect(service.create({ name: "Daily-summary", cron: "0 9 * * *", discordChannel: channel, prompt: "Two" }))
      .rejects.toThrow(/already exists/);
    await expect(service.create({ name: "DAILY SUMMARY", cron: "0 9 * * *", discordChannel: channel, prompt: "Two" }))
      .rejects.toThrow(/already exists/);
  });

  it("disables a previously valid timer after an invalid direct edit", async () => {
    await service.create({ name: "Daily summary", cron: "0 8 * * *", discordChannel: channel, prompt: "One" });
    fs.writeFileSync(path.join(directory, "daily-summary.md"), "---\nname: Broken\n---\nPrompt\n");
    await service.reconcile();
    const [status] = service.getStatuses();
    expect(status.definition).toBeUndefined();
    expect(status.error).toMatch(/cron|discord_channel/);
    expect(status.nextRun).toBeNull();
  });

  it("disables every file with a duplicate case-insensitive name", async () => {
    const body = (name: string, time: string) => `---\nname: ${name}\ncron: "${time}"\ndiscord_channel: "${channel}"\n---\nPrompt\n`;
    fs.writeFileSync(path.join(directory, "one.md"), body("Digest", "0 8 * * *"));
    fs.writeFileSync(path.join(directory, "two.md"), body("digest", "0 9 * * *"));
    await service.reconcile();
    expect(service.getStatuses()).toHaveLength(2);
    expect(service.getStatuses().every((status) => status.error?.includes("duplicate schedule name"))).toBe(true);
  });

  it("keeps explicit and host-local schedules independently enumerable", async () => {
    const local = await service.create({ name: "Local", cron: "0 8 * * *", discordChannel: channel, prompt: "Local" });
    const zoned = await service.create({ name: "Zoned", cron: "0 8 * * *", discordChannel: channel, timezone: "America/New_York", prompt: "Zoned" });
    expect(service.previewNextRuns(local, 2)).toHaveLength(2);
    expect(service.previewNextRuns(zoned, 2)).toHaveLength(2);
  });

  it("allows concurrent occurrences of the same schedule", async () => {
    const definition = await service.create({ name: "Frequent", cron: "* * * * *", discordChannel: channel, prompt: "Run" });
    const runner = vi.fn(async () => new Promise<void>(() => undefined));
    const client = { channels: { fetch: vi.fn() } } as unknown as Client;
    await service.start(client, runner);
    const jobs = (service as unknown as { jobs: Map<string, { job: { trigger: () => Promise<void> } }> }).jobs;
    await jobs.get(definition.id)!.job.trigger();
    await jobs.get(definition.id)!.job.trigger();
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("disables a definition whose Discord channel cannot be fetched", async () => {
    fs.writeFileSync(path.join(directory, "missing-channel.md"), serializeSchedule({
      name: "Missing channel", cron: "0 8 * * *", discordChannel: channel, prompt: "Run",
    }));
    const client = { channels: { fetch: vi.fn().mockResolvedValue(null) } } as unknown as Client;
    await service.start(client, async () => undefined);
    const [status] = service.getStatuses(channel);
    expect(status.definition).toBeUndefined();
    expect(status.error).toContain("unavailable or not sendable");
  });
});
