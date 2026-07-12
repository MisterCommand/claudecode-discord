import { describe, expect, it, beforeEach, vi } from "vitest";
vi.mock("better-sqlite3", async () => {
  const actual = await vi.importActual("better-sqlite3") as { default: new (path: string) => unknown };
  const RealDatabase = actual.default;
  return { default: function MemoryDatabase() { return new RealDatabase(":memory:"); } };
});
import { createChain, deleteChain, getChain, getChainByMessage, getChainsForChannel, initDatabase, mapMessage, markChainDeleted, replaceMissingSession, updateChainSession, updateChainStatus } from "./database.js";

describe("conversation-chain database", () => {
  beforeEach(() => initDatabase());
  it("maps any Discord message to its chain", () => {
    createChain({ id: "c1", label: "S-ABC123", guild_id: "g", channel_id: "ch", session_id: null, status: "idle" });
    mapMessage("m1", "c1");
    expect(getChainByMessage("m1")?.label).toBe("S-ABC123");
  });
  it("tracks independent chains in one channel", () => {
    createChain({ id: "c1", label: "S-ABC123", guild_id: "g", channel_id: "ch", session_id: null, status: "idle" });
    createChain({ id: "c2", label: "S-DEF456", guild_id: "g", channel_id: "ch", session_id: null, status: "idle" });
    expect(getChainsForChannel("ch")).toHaveLength(2);
  });
  it("keeps deleted mappings as hidden restart tombstones", () => {
    createChain({ id: "c1", label: "S-ABC123", guild_id: "g", channel_id: "ch", session_id: "sdk", status: "idle" });
    mapMessage("m1", "c1");
    markChainDeleted("c1");
    expect(getChainsForChannel("ch")).toHaveLength(0);
    expect(getChainByMessage("m1")?.deleted_at).not.toBeNull();
    replaceMissingSession("c1");
    expect(getChainsForChannel("ch")).toHaveLength(1);
  });  it("updates and deletes a chain with cascading mappings", () => {
    createChain({ id: "c1", label: "S-ABC123", guild_id: "g", channel_id: "ch", session_id: null, status: "idle" });
    mapMessage("m1", "c1"); updateChainSession("c1", "sdk"); updateChainStatus("c1", "online");
    expect(getChain("c1")?.session_id).toBe("sdk");
    expect(deleteChain("c1")).toBe(true);
    expect(getChainByMessage("m1")).toBeUndefined();
  });
});
