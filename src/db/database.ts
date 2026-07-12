import Database from "better-sqlite3";
import path from "node:path";
import type { MessageMapping, SessionChain, SessionStatus } from "./types.js";

const DB_PATH = path.join(process.cwd(), "data.db");
const SCHEMA_VERSION = 3;
let db: Database.Database;

export function initDatabase(): void {
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version < SCHEMA_VERSION) {
    db.exec(`DROP TABLE IF EXISTS message_mappings; DROP TABLE IF EXISTS session_chains; DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS projects;`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_chains (
      id TEXT PRIMARY KEY, label TEXT NOT NULL UNIQUE, guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL, session_id TEXT, status TEXT NOT NULL DEFAULT 'idle',
      last_activity TEXT DEFAULT (datetime('now')), created_at TEXT DEFAULT (datetime('now')), deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS message_mappings (
      message_id TEXT PRIMARY KEY,
      chain_id TEXT NOT NULL REFERENCES session_chains(id) ON DELETE CASCADE,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_chains_channel ON session_chains(channel_id, last_activity DESC);
    CREATE INDEX IF NOT EXISTS idx_message_chain ON message_mappings(chain_id);
    PRAGMA user_version = ${SCHEMA_VERSION};
  `);
}

export function getDb(): Database.Database { return db; }
export function createChain(chain: Omit<SessionChain, "created_at" | "last_activity" | "deleted_at">): void {
  db.prepare(`INSERT INTO session_chains (id,label,guild_id,channel_id,session_id,status) VALUES (?,?,?,?,?,?)`)
    .run(chain.id, chain.label, chain.guild_id, chain.channel_id, chain.session_id, chain.status);
}
export function getChain(id: string): SessionChain | undefined {
  return db.prepare("SELECT * FROM session_chains WHERE id = ?").get(id) as SessionChain | undefined;
}
export function getChainByMessage(messageId: string): SessionChain | undefined {
  return db.prepare(`SELECT c.* FROM session_chains c JOIN message_mappings m ON m.chain_id=c.id WHERE m.message_id=?`)
    .get(messageId) as SessionChain | undefined;
}
export function getChainsForChannel(channelId: string): SessionChain[] {
  return db.prepare(`SELECT * FROM session_chains WHERE channel_id=? AND deleted_at IS NULL ORDER BY datetime(last_activity) DESC, datetime(created_at) DESC`)
    .all(channelId) as SessionChain[];
}
export function mapMessage(messageId: string, chainId: string): void {
  db.prepare(`INSERT INTO message_mappings (message_id,chain_id) VALUES (?,?) ON CONFLICT(message_id) DO UPDATE SET chain_id=excluded.chain_id`)
    .run(messageId, chainId);
}
export function getMessageMapping(messageId: string): MessageMapping | undefined {
  return db.prepare("SELECT * FROM message_mappings WHERE message_id=?").get(messageId) as MessageMapping | undefined;
}
export function updateChainSession(chainId: string, sessionId: string | null): void {
  db.prepare(`UPDATE session_chains SET session_id=?,last_activity=datetime('now') WHERE id=?`).run(sessionId, chainId);
}
export function updateChainStatus(chainId: string, status: SessionStatus): void {
  db.prepare(`UPDATE session_chains SET status=?,last_activity=datetime('now') WHERE id=?`).run(status, chainId);
}
export function deleteChain(chainId: string): boolean {
  return db.prepare("DELETE FROM session_chains WHERE id=?").run(chainId).changes > 0;
}
export function markChainDeleted(chainId: string): void {
  db.prepare(`UPDATE session_chains SET session_id=NULL,status='offline',deleted_at=datetime('now'),last_activity=datetime('now') WHERE id=?`).run(chainId);
}

export function replaceMissingSession(chainId: string): void {
  db.prepare(`UPDATE session_chains SET session_id=NULL,status='idle',deleted_at=NULL,last_activity=datetime('now') WHERE id=?`).run(chainId);
}
