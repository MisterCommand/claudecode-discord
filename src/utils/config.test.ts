import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertTrustedConfigLocation, isPathOnReadOnlyMount, loadConfig, parseBotConfig, parseEnvironment,
} from "./config.js";

const validYaml = `version: 1
access:
  admin_channels:
    - "123456789012345678"
  protected_repositories:
    - USThing/USThingServer
tools:
  denied: []
  restricted_denied:
    - Bash
`;

function fakeStats(type: "directory" | "file" | "symlink", mode: number): fs.Stats {
  return {
    mode,
    uid: -1,
    isDirectory: () => type === "directory",
    isFile: () => type === "file",
    isSymbolicLink: () => type === "symlink",
  } as fs.Stats;
}

function mockLocation(directoryMode = 0o555, fileMode = 0o444, linked?: "directory" | "file"): void {
  vi.spyOn(fs, "lstatSync").mockImplementation((target) => {
    if (String(target).endsWith("config.yaml")) return fakeStats(linked === "file" ? "symlink" : "file", fileMode);
    return fakeStats(linked === "directory" ? "symlink" : "directory", directoryMode);
  });
  vi.spyOn(fs, "realpathSync").mockImplementation((target) => String(target));
  vi.spyOn(fs, "existsSync").mockReturnValue(false);
}

afterEach(() => vi.restoreAllMocks());

describe("environment configuration", () => {
  it("requires BOT_CONFIG_DIR and keeps rate limiting enabled by default", () => {
    const parsed = parseEnvironment({
      DISCORD_BOT_TOKEN: "token",
      BASE_PROJECT_DIR: "/projects",
      BOT_CONFIG_DIR: "/bot-config",
    });
    expect(parsed.BOT_CONFIG_DIR).toBe("/bot-config");
    expect(parsed.RATE_LIMIT_PER_MINUTE).toBe(10);
    expect(parsed.HONEYCOMB_API_KEY).toBeUndefined();
    expect(parsed.HONEYCOMB_API_ENDPOINT).toBe("https://api.honeycomb.io");
  });

  it("accepts Honeycomb US and EU endpoints and treats a blank key as disabled", () => {
    const base = {
      DISCORD_BOT_TOKEN: "token",
      BASE_PROJECT_DIR: "/projects",
      BOT_CONFIG_DIR: "/bot-config",
    };
    expect(parseEnvironment({
      ...base,
      HONEYCOMB_API_KEY: "  ",
      HONEYCOMB_API_ENDPOINT: "https://api.eu1.honeycomb.io",
    })).toMatchObject({
      HONEYCOMB_API_KEY: undefined,
      HONEYCOMB_API_ENDPOINT: "https://api.eu1.honeycomb.io",
    });
    expect(() => parseEnvironment({ ...base, HONEYCOMB_API_ENDPOINT: "https://example.com" }))
      .toThrow(/HONEYCOMB_API_ENDPOINT/);
  });

  it("rejects a missing BOT_CONFIG_DIR", () => {
    expect(() => parseEnvironment({ DISCORD_BOT_TOKEN: "token", BASE_PROJECT_DIR: "/projects" }))
      .toThrow(/BOT_CONFIG_DIR/);
  });
});

describe("YAML bot configuration", () => {
  it("parses the complete version 1 schema", () => {
    expect(parseBotConfig(validYaml)).toMatchObject({
      version: 1,
      access: { admin_channels: ["123456789012345678"], protected_repositories: ["USThing/USThingServer"] },
      tools: { denied: [], restricted_denied: ["Bash"] },
    });
  });

  it("accepts required arrays when they are empty and rejects other versions", () => {
    const empty = validYaml
      .replace('    - "123456789012345678"', "    []")
      .replace("    - USThing/USThingServer", "    []")
      .replace("  restricted_denied:\n    - Bash", "  restricted_denied: []");
    expect(parseBotConfig(empty).access.admin_channels).toEqual([]);
    expect(() => parseBotConfig(validYaml.replace("version: 1", "version: 2"))).toThrow(/version/);
  });

  it("rejects unknown and missing keys", () => {
    expect(() => parseBotConfig(`${validYaml}unexpected: true\n`)).toThrow(/Unrecognized key/);
    expect(() => parseBotConfig(validYaml.replace("  denied: []\n", ""))).toThrow(/tools.denied/);
  });

  it("rejects duplicate YAML keys", () => {
    expect(() => parseBotConfig(validYaml.replace("version: 1", "version: 1\nversion: 1"))).toThrow(/Map keys must be unique/);
  });

  it("requires quoted Discord IDs", () => {
    expect(() => parseBotConfig(validYaml.replace('"123456789012345678"', "123456789012345678")))
      .toThrow(/quoted 17-20 digit/);
  });

  it("rejects case-insensitive repository and deny-rule duplicates", () => {
    expect(() => parseBotConfig(validYaml.replace(
      "    - USThing/USThingServer",
      "    - USThing/USThingServer\n    - usthing/usthingserver",
    ))).toThrow(/duplicate protected repository/);
    expect(() => parseBotConfig(validYaml.replace("  denied: []", "  denied:\n    - bash")))
      .toThrow(/already applies globally/);
  });

  it("rejects invalid repository and tool-rule syntax", () => {
    expect(() => parseBotConfig(validYaml.replace("USThing/USThingServer", "https://github.com/USThing/USThingServer")))
      .toThrow(/owner\/repository/);
    expect(() => parseBotConfig(validYaml.replace("    - Bash", "    - 'bad rule()'")))
      .toThrow(/valid Claude tool deny rule/);
  });
});

describe("trusted configuration location", () => {
  it("accepts a real read-only directory and file outside the workspace", () => {
    mockLocation();
    expect(() => assertTrustedConfigLocation("/bot-config", "/bot-config/config.yaml", "/projects", "linux"))
      .not.toThrow();
  });

  it("rejects writable directories and files", () => {
    mockLocation(0o755, 0o444);
    expect(() => assertTrustedConfigLocation("/bot-config", "/bot-config/config.yaml", "/projects", "linux"))
      .toThrow(/write bits/);
    vi.restoreAllMocks();
    mockLocation(0o555, 0o644);
    expect(() => assertTrustedConfigLocation("/bot-config", "/bot-config/config.yaml", "/projects", "linux"))
      .toThrow(/write bits/);
  });

  it("rejects POSIX config objects owned by the bot process", () => {
    const effectiveUserId = process.geteuid?.();
    if (effectiveUserId === undefined || effectiveUserId === 0) return;
    mockLocation();
    vi.mocked(fs.lstatSync).mockImplementation((target) => ({
      ...fakeStats(String(target).endsWith("config.yaml") ? "file" : "directory", 0o444),
      uid: effectiveUserId,
    }) as fs.Stats);
    expect(() => assertTrustedConfigLocation("/bot-config", "/bot-config/config.yaml", "/projects", "linux"))
      .toThrow(/owned by a different account/);
  });

  it("rejects linked directories and files", () => {
    mockLocation(0o555, 0o444, "directory");
    expect(() => assertTrustedConfigLocation("/bot-config", "/bot-config/config.yaml", "/projects", "linux"))
      .toThrow(/symlink or junction/);
    vi.restoreAllMocks();
    mockLocation(0o555, 0o444, "file");
    expect(() => assertTrustedConfigLocation("/bot-config", "/bot-config/config.yaml", "/projects", "linux"))
      .toThrow(/symlink or junction/);
  });

  it("rejects configuration inside BASE_PROJECT_DIR", () => {
    expect(() => assertTrustedConfigLocation("/projects/config", "/projects/config/config.yaml", "/projects", "linux"))
      .toThrow(/outside BASE_PROJECT_DIR/);
  });

  it("rejects a missing directory or config.yaml", () => {
    vi.spyOn(fs, "lstatSync").mockImplementation(() => {
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    });
    expect(() => assertTrustedConfigLocation("/bot-config", "/bot-config/config.yaml", "/projects", "linux"))
      .toThrow(/required bot configuration/);
  });

  it("accepts a read-only Docker mount even when host mode bits are writable", () => {
    const mountInfo = [
      "20 1 0:1 / / rw,relatime - overlay overlay rw",
      "21 20 0:2 /source /config ro,relatime - ext4 /dev/sda ro",
    ].join("\n");
    expect(isPathOnReadOnlyMount("/config/config.yaml", mountInfo)).toBe(true);
    expect(isPathOnReadOnlyMount("/projects/file", mountInfo)).toBe(false);
  });
});

describe("configuration lifecycle", () => {
  it("loads and merges config once without hot reload", () => {
    const originalEnvironment = { ...process.env };
    const root = path.parse(process.cwd()).root;
    const configDirectory = path.join(root, "trusted-bot-config");
    const baseDirectory = path.join(root, "projects");
    process.env = {
      ...originalEnvironment,
      DISCORD_BOT_TOKEN: "token",
      BASE_PROJECT_DIR: baseDirectory,
      BOT_CONFIG_DIR: configDirectory,
    };
    mockLocation();
    const read = vi.spyOn(fs, "readFileSync").mockImplementation((target) => (
      String(target) === "/proc/self/mountinfo" ? "" : validYaml
    ) as never);
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw Object.assign(new Error("read only"), { code: "EACCES" });
    });

    try {
      const first = loadConfig();
      read.mockImplementation(() => "version: 2" as never);
      const second = loadConfig();
      expect(second).toBe(first);
      expect(second.access.protected_repositories).toEqual(["USThing/USThingServer"]);
    } finally {
      process.env = originalEnvironment;
    }
  });
});
