import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
describe("config", () => {
  const original = { ...process.env };
  beforeEach(() => { vi.resetModules(); process.env.DISCORD_BOT_TOKEN="token"; process.env.DISCORD_GUILD_ID="guild"; process.env.BASE_PROJECT_DIR="/projects"; delete process.env.RATE_LIMIT_PER_MINUTE; });
  afterEach(() => { process.env = { ...original }; });
  it("does not require an allowlist", async () => { const { loadConfig } = await import("./config.js"); expect(loadConfig().BASE_PROJECT_DIR).toBe("/projects"); });
  it("keeps rate limiting enabled by default", async () => { const { loadConfig } = await import("./config.js"); expect(loadConfig().RATE_LIMIT_PER_MINUTE).toBe(10); });
});
