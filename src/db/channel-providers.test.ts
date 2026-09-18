import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelProviderStore } from "./channel-providers.js";

let directory: string;
let store: ChannelProviderStore;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-channel-providers-"));
  store = new ChannelProviderStore(directory);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("ChannelProviderStore", () => {
  it("reads a missing file as empty and persists overrides in channel-providers.json", () => {
    expect(store.get("123")).toBeUndefined();
    store.set("123", "kimi");
    expect(store.get("123")).toBe("kimi");
    expect(JSON.parse(fs.readFileSync(path.join(directory, "channel-providers.json"), "utf8"))).toEqual({ 123: "kimi" });
  });

  it("replaces an entry and clears only the requested channel", () => {
    store.set("a", "kimi");
    store.set("a", "glm");
    store.set("b", "opus");
    expect(store.get("a")).toBe("glm");

    store.clear("a");
    expect(store.get("a")).toBeUndefined();
    expect(store.get("b")).toBe("opus");
    expect(JSON.parse(fs.readFileSync(path.join(directory, "channel-providers.json"), "utf8"))).toEqual({ b: "opus" });
  });

  it("treats a corrupt file as no override and repairs it on the next write", () => {
    fs.writeFileSync(path.join(directory, "channel-providers.json"), "not json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(store.get("ch")).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Ignoring invalid channel provider file"));

    store.set("ch", "kimi");
    expect(store.get("ch")).toBe("kimi");
  });

  it("ignores non-string entries in an otherwise valid file", () => {
    fs.writeFileSync(path.join(directory, "channel-providers.json"), JSON.stringify({ good: "kimi", bad: 7 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(store.get("good")).toBe("kimi");
    expect(store.get("bad")).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Ignoring invalid channel provider entry"));
  });
});
