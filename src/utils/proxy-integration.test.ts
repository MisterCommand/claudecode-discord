import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `loadConfig()` memoizes, so every scenario needs its own module instance.
 * These tests drive the real startup path — environment, `config.yaml`, and the
 * optional `proxy.yaml` — and assert what the rest of the bot observes.
 */

const validYaml = `version: 1
access:
  admin_channels:
    - "123456789012345678"
  protected_repositories:
    - USThing/USThingServer
tools:
  denied: []
  restricted_denied: []
`;

const proxyYaml = `workspace_id: 45e94c0b-fb14-4185-8b4b-5a365c8bc047
server:
  port: 18123
  api_keys:
    - sk-local-1
`;

function fakeStats(type: "directory" | "file", mode: number): fs.Stats {
  return {
    mode,
    uid: -1,
    isDirectory: () => type === "directory",
    isFile: () => type === "file",
    isSymbolicLink: () => false,
  } as fs.Stats;
}

/** Mock an owner-controlled read-only config directory holding the given files. */
function mockTrustedDirectory(files: Record<string, string>, unreadable: string[] = []): void {
  const realReadFileSync = fs.readFileSync.bind(fs);
  vi.spyOn(fs, "lstatSync").mockImplementation((target) => (
    fakeStats(String(target).endsWith(".yaml") ? "file" : "directory", 0o444)
  ));
  vi.spyOn(fs, "realpathSync").mockImplementation((target) => String(target));
  vi.spyOn(fs, "existsSync").mockImplementation((target) => {
    const file = String(target);
    return Object.keys(files).some((name) => file.endsWith(name));
  });
  vi.spyOn(fs, "readFileSync").mockImplementation((target, ...rest) => {
    const file = String(target);
    if (file === "/proc/self/mountinfo") return "" as never;
    if (unreadable.some((name) => file.endsWith(name))) {
      throw Object.assign(new Error(`EACCES: ${file}`), { code: "EACCES" });
    }
    for (const [name, content] of Object.entries(files)) {
      if (file.endsWith(name)) return content as never;
    }
    // Module loading and anything else the real loader needs must still work.
    return realReadFileSync(target, ...rest as [never]) as never;
  });
  vi.spyOn(fs, "accessSync").mockImplementation(() => {
    throw Object.assign(new Error("read only"), { code: "EACCES" });
  });
}

const originalEnvironment = { ...process.env };
const configDirectory = path.join(path.parse(process.cwd()).root, "trusted-bot-config");

beforeEach(() => {
  vi.resetModules();
  process.env = {
    ...originalEnvironment,
    DISCORD_BOT_TOKEN: "token",
    BASE_PROJECT_DIR: path.join(path.parse(process.cwd()).root, "projects"),
    BOT_CONFIG_DIR: configDirectory,
  };
});

afterEach(() => {
  process.env = originalEnvironment;
  vi.restoreAllMocks();
});

async function loadConfig() {
  return (await import("./config.js")).loadConfig();
}

describe("embedded Gemini Business pool startup", () => {
  it("keeps the pool disabled and the provider list untouched without proxy.yaml", async () => {
    mockTrustedDirectory({ "config.yaml": validYaml });

    const config = await loadConfig();
    expect(config.geminiBusiness).toBeUndefined();
    expect(config.claude.providers.map((provider) => provider.value)).toEqual(["default"]);
  });

  it("exposes the pool as a working /model provider when proxy.yaml is present", async () => {
    mockTrustedDirectory({ "config.yaml": validYaml, "proxy.yaml": proxyYaml });

    const config = await loadConfig();
    expect(config.geminiBusiness?.server.port).toBe(18123);
    expect(config.geminiBusiness?.workspace_id).toBe("45e94c0b-fb14-4185-8b4b-5a365c8bc047");
    expect(config.claude.providers[0]).toEqual({
      value: "gemini-business",
      label: "Gemini Business (embedded proxy)",
      api_key: "sk-local-1",
      base_url: "http://127.0.0.1:18123",
      default_model: "gemini-3.8-flash",
    });
    // The injected provider has no default_provider set, so it is the default.
    expect(config.claude.default_provider).toBeUndefined();
  });

  it("refuses to start with a clear message when proxy.yaml is invalid", async () => {
    mockTrustedDirectory({ "config.yaml": validYaml, "proxy.yaml": "server: {}\n" });

    await expect(loadConfig()).rejects.toThrow(/proxy\.yaml/);
    await expect(loadConfig()).rejects.toThrow(/api_keys/);
  });

  it("treats an unreadable proxy.yaml as fatal rather than silently skipping the pool", async () => {
    mockTrustedDirectory({ "config.yaml": validYaml, "proxy.yaml": proxyYaml }, ["proxy.yaml"]);

    await expect(loadConfig()).rejects.toThrow(/Cannot read .*proxy\.yaml/);
  });
});
