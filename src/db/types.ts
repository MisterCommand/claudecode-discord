export type SessionStatus = "online" | "offline" | "waiting" | "idle";

export interface SessionChain {
  id: string;
  label: string;
  guild_id: string;
  channel_id: string;
  session_id: string | null;
  status: SessionStatus;
  last_activity: string | null;
  created_at: string;
  deleted_at: string | null;
}

export interface MessageMapping {
  message_id: string;
  chain_id: string;
  created_at: string;
}
