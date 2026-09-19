/**
 * Durable store for Gemini Business accounts.
 *
 * `proxy.yaml` is trusted, hand-written, read-only policy: the bot must never
 * write it, and accounts are not configured there at all. Every account is a
 * capture, so this file is the single source of accounts for the pool. It is
 * bot-owned runtime state next to `data.db` — 0600, atomically replaced, and
 * never read from the agent workspace.
 *
 * The store is strictly additive: each login overwrites the entry with the same
 * account name, so an account can be refreshed indefinitely without growing the
 * file.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { configuredAccountSchema } from "./config.js";
import type { ConfiguredAccount } from "./types.js";

export const GEMINI_ACCOUNTS_FILE_NAME = "gemini-accounts.json";

export class GeminiAccountStore {
  private readonly filePath: string;

  constructor(directory = process.cwd()) {
    this.filePath = path.join(directory, GEMINI_ACCOUNTS_FILE_NAME);
  }

  /** Stored accounts, newest state per name. Corrupt content is reported and ignored. */
  read(): ConfiguredAccount[] {
    let source: string;
    try {
      source = fs.readFileSync(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      console.warn(`Ignoring unreadable captured-account file ${this.filePath}: ${String(error)}`);
      return [];
    }

    try {
      const parsed: unknown = JSON.parse(source);
      if (!Array.isArray(parsed)) throw new Error("must be a JSON array of accounts");

      const accounts: ConfiguredAccount[] = [];
      const seen = new Set<string>();
      for (const entry of parsed) {
        const result = configuredAccountSchema.safeParse(entry);
        if (!result.success) {
          console.warn(`Ignoring invalid captured account in ${this.filePath}: ${result.error.issues[0]?.message}`);
          continue;
        }
        if (seen.has(result.data.name)) continue;
        seen.add(result.data.name);
        accounts.push(result.data);
      }
      return accounts;
    } catch (error) {
      console.warn(`Ignoring invalid captured-account file ${this.filePath}: ${error instanceof Error ? error.message : error}`);
      return [];
    }
  }

  /**
   * Record one captured account, replacing any stored entry with the same name.
   * Writing is best effort: a failure costs a future re-login, not this run.
   */
  save(account: ConfiguredAccount): void {
    const accounts = this.read().filter((candidate) => candidate.name !== account.name);
    accounts.push(account);

    const temporary = path.join(path.dirname(this.filePath), `.${path.basename(this.filePath)}.${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(accounts, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, this.filePath);
    } catch (error) {
      console.warn(`Could not persist the captured Gemini Business account to ${this.filePath}: ${String(error)}`);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
}
