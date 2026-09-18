import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export class ChannelProviderStore {
  private readonly filePath: string;

  constructor(directory = process.cwd()) {
    this.filePath = path.join(directory, "channel-providers.json");
  }

  get(channelId: string): string | undefined {
    return this.read()[channelId];
  }

  set(channelId: string, provider: string): void {
    const providers = this.read();
    providers[channelId] = provider;
    this.write(providers);
  }

  clear(channelId: string): void {
    const providers = this.read();
    delete providers[channelId];
    this.write(providers);
  }

  private read(): Record<string, string> {
    let source: string;
    try {
      source = fs.readFileSync(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`Ignoring unreadable channel provider file ${this.filePath}: ${detail}`);
      return {};
    }
    try {
      const parsed: unknown = JSON.parse(source);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("must be a JSON object of channel IDs to provider IDs");
      }
      const providers: Record<string, string> = {};
      for (const [channelId, provider] of Object.entries(parsed)) {
        if (typeof provider !== "string" || !provider) {
          console.warn(`Ignoring invalid channel provider entry for ${channelId} in ${this.filePath}`);
          continue;
        }
        providers[channelId] = provider;
      }
      return providers;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`Ignoring invalid channel provider file ${this.filePath}: ${detail}`);
      return {};
    }
  }

  private write(providers: Record<string, string>): void {
    const temporary = path.join(path.dirname(this.filePath), `.${path.basename(this.filePath)}.${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(providers, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      fs.renameSync(temporary, this.filePath);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
}

export const channelProviders = new ChannelProviderStore();
