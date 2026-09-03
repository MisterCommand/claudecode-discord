import { randomBytes, randomUUID } from "node:crypto";
import { createChain } from "../db/database.js";
import type { SessionChain } from "../db/types.js";

export function createNewChain(guildId: string, channelId: string): SessionChain {
  for (let attempt = 0; attempt < 10; attempt++) {
    const chain: SessionChain = {
      id: randomUUID(),
      label: `S-${randomBytes(4).toString("base64url").toUpperCase().slice(0, 6)}`,
      guild_id: guildId,
      channel_id: channelId,
      session_id: null,
      status: "idle",
      last_activity: null,
      created_at: new Date().toISOString(),
      deleted_at: null,
    };
    try {
      createChain(chain);
      return chain;
    } catch (error) {
      if (!/unique|constraint/i.test(error instanceof Error ? error.message : String(error))) throw error;
    }
  }
  throw new Error("Could not allocate a unique session label");
}
