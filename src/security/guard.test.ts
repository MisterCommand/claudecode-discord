import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";

vi.mock("../utils/config.js", () => ({
  getConfig: vi.fn(() => ({
    DISCORD_BOT_TOKEN: "t",
    DISCORD_GUILD_ID: "g",
    BASE_PROJECT_DIR: "/projects",
    RATE_LIMIT_PER_MINUTE: 3,
    SHOW_COST: true,
  })),
}));

import { checkRateLimit, validateProjectPath } from "./guard.js";

// ─── checkRateLimit ───

describe("checkRateLimit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests within the rate limit", () => {
    expect(checkRateLimit("rl-user1")).toBe(true);
    expect(checkRateLimit("rl-user1")).toBe(true);
    expect(checkRateLimit("rl-user1")).toBe(true);
  });

  it("blocks requests exceeding the rate limit", () => {
    for (let i = 0; i < 3; i++) checkRateLimit("rl-user2");
    expect(checkRateLimit("rl-user2")).toBe(false);
  });

  it("resets after the 1-minute window expires", () => {
    for (let i = 0; i < 3; i++) checkRateLimit("rl-user3");
    expect(checkRateLimit("rl-user3")).toBe(false);

    vi.advanceTimersByTime(61_000);

    expect(checkRateLimit("rl-user3")).toBe(true);
  });

  it("tracks rate limits per user independently", () => {
    for (let i = 0; i < 3; i++) checkRateLimit("rl-user4");
    expect(checkRateLimit("rl-user4")).toBe(false);
    expect(checkRateLimit("rl-user5")).toBe(true);
  });
});

// ─── validateProjectPath ───

describe("validateProjectPath", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns error for paths containing '..'", () => {
    const result = validateProjectPath("/projects/../etc/passwd");
    expect(result).toBe("Path must not contain '..'");
  });

  it("does not call fs when path contains '..'", () => {
    const spy = vi.spyOn(fs, "existsSync");
    validateProjectPath("/a/../b");
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns error when path is outside BASE_PROJECT_DIR", () => {
    const result = validateProjectPath("/etc/passwd");
    expect(result).toContain("Path must be within");
  });

  it("does not call fs when path is outside BASE_PROJECT_DIR", () => {
    const spy = vi.spyOn(fs, "existsSync");
    validateProjectPath("/other/dir");
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns error when path does not exist", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const result = validateProjectPath("/projects/nonexistent");
    expect(result).toContain("Path does not exist");
  });

  it("returns error when path is not a directory", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "statSync").mockReturnValue({ isDirectory: () => false } as fs.Stats);
    const result = validateProjectPath("/projects/file.txt");
    expect(result).toContain("Path is not a directory");
  });

  it("returns null for valid directory path within BASE_PROJECT_DIR", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "statSync").mockReturnValue({ isDirectory: () => true } as fs.Stats);
    const result = validateProjectPath("/projects/my-app");
    expect(result).toBeNull();
  });

  it("allows BASE_PROJECT_DIR itself", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "statSync").mockReturnValue({ isDirectory: () => true } as fs.Stats);
    const result = validateProjectPath("/projects");
    expect(result).toBeNull();
  });
});
