import { describe, expect, it, vi } from "vitest";
import type { BotFileConfig } from "../utils/config.js";
import {
  evaluateProtectedRepositoryAccess, normalizeRepository, profileLabel,
  resolveAccessProfile, snapshotAccessPolicy, writeToolDenialAudit,
} from "./access-policy.js";

const adminChannel = "123456789012345678";
const config: BotFileConfig = {
  version: 1,
  access: {
    admin_channels: [adminChannel],
    protected_repositories: ["USThing/USThingServer"],
  },
  tools: {
    denied: ["WebFetch"],
    restricted_denied: ["Bash", "mcp__dangerous__*"],
  },
};

describe("access profile selection", () => {
  it("selects Admin only for an exact configured channel or thread ID", () => {
    expect(resolveAccessProfile(adminChannel, config)).toBe("admin");
    expect(resolveAccessProfile(`${adminChannel}0`, config)).toBe("restricted");
    expect(resolveAccessProfile("999999999999999999", config)).toBe("restricted");
  });

  it("uses the destination ID for scheduled and interactive policy snapshots", () => {
    expect(snapshotAccessPolicy(adminChannel, config).profile).toBe("admin");
    expect(snapshotAccessPolicy("999999999999999999", config).profile).toBe("restricted");
  });

  it("composes global and Restricted-only denials while hiding questions", () => {
    expect(snapshotAccessPolicy(adminChannel, config).disallowedTools).toEqual(["AskUserQuestion", "WebFetch"]);
    expect(snapshotAccessPolicy("999999999999999999", config).disallowedTools)
      .toEqual(["AskUserQuestion", "WebFetch", "Bash", "mcp__dangerous__*"]);
    expect(profileLabel("admin")).toBe("Admin");
    expect(profileLabel("restricted")).toBe("Restricted");
  });
});

describe("protected GitHub repositories", () => {
  const restricted = snapshotAccessPolicy("999999999999999999", config);
  const admin = snapshotAccessPolicy(adminChannel, config);

  it("normalizes exact owner/repository, URL, SCP, and .git forms", () => {
    expect(normalizeRepository("USThing/USThingServer")).toBe("USThing/USThingServer");
    expect(normalizeRepository("https://github.com/USThing/USThingServer.git")).toBe("USThing/USThingServer");
    expect(normalizeRepository("git@github.com:USThing/USThingServer.git")).toBe("USThing/USThingServer");
  });

  it("denies recognized owner/repo and item_owner/item_repo targets case-insensitively", () => {
    expect(evaluateProtectedRepositoryAccess(restricted, "mcp__github__get_file_contents", {
      owner: "usthing", repo: "USTHINGSERVER", path: "README.md",
    })?.repositories).toEqual(["usthing/USTHINGSERVER"]);
    expect(evaluateProtectedRepositoryAccess(restricted, "mcp__github__sub_issue_write", {
      item_owner: "USThing", item_repo: "USThingServer",
    })).toBeDefined();
    expect(evaluateProtectedRepositoryAccess(restricted, "mcp__github__issue_dependency_write", {
      owner: "someone", repo: "public", related_owner: "USThing", related_repo: "USThingServer",
    })).toBeDefined();
    expect(evaluateProtectedRepositoryAccess(restricted, "mcp__github__actions_get", {
      owner: "USThing", repo: "USThingServer",
    })).toBeDefined();
    expect(evaluateProtectedRepositoryAccess(restricted, "mcp__github__list_workflows", {
      owner: "USThing", repo: "USThingServer",
    })).toBeDefined();
  });

  it("denies direct URL fields and repo: search qualifiers", () => {
    expect(evaluateProtectedRepositoryAccess(restricted, "mcp__github__fork_repository", {
      repository_url: "https://github.com/USThing/USThingServer.git",
    })).toBeDefined();
    expect(evaluateProtectedRepositoryAccess(restricted, "mcp__github__search_code", {
      query: "needle repo:USThing/USThingServer language:ts",
    })).toBeDefined();
  });

  it("allows every protected target under the Admin profile", () => {
    expect(evaluateProtectedRepositoryAccess(admin, "mcp__github__get_issue", {
      owner: "USThing", repo: "USThingServer", issue_number: 1,
    })).toBeUndefined();
  });

  it("allows unscoped searches, non-targeting mentions, forks, and other routes", () => {
    expect(evaluateProtectedRepositoryAccess(restricted, "mcp__github__search_code", { query: "USThingServer" })).toBeUndefined();
    expect(evaluateProtectedRepositoryAccess(restricted, "mcp__github__get_issue", {
      owner: "someone", repo: "public", body: "See USThing/USThingServer",
    })).toBeUndefined();
    expect(evaluateProtectedRepositoryAccess(restricted, "mcp__github__get_issue", {
      owner: "USThing", repo: "USThingServer-fork",
    })).toBeUndefined();
    expect(evaluateProtectedRepositoryAccess(restricted, "WebFetch", {
      url: "https://github.com/USThing/USThingServer",
    })).toBeUndefined();
  });

  it("allows search_repositories and unknown GitHub tool schemas", () => {
    expect(evaluateProtectedRepositoryAccess(restricted, "mcp__github__search_repositories", {
      query: "repo:USThing/USThingServer",
    })).toBeUndefined();
    expect(evaluateProtectedRepositoryAccess(restricted, "mcp__github__future_tool", {
      owner: "USThing", repo: "USThingServer",
    })).toBeUndefined();
  });

  it("writes a minimal structured audit record", () => {
    const denial = evaluateProtectedRepositoryAccess(restricted, "mcp__github__get_issue", {
      owner: "USThing", repo: "USThingServer", token: "secret",
    });
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    writeToolDenialAudit("999999999999999999", "restricted", denial!);
    const record = JSON.parse(String(write.mock.calls[0][0]));
    expect(record).toMatchObject({
      event: "tool_denied",
      channel_id: "999999999999999999",
      access_profile: "restricted",
      tool: "mcp__github__get_issue",
      repository: "USThing/USThingServer",
    });
    expect(record).not.toHaveProperty("input");
    expect(JSON.stringify(record)).not.toContain("secret");
  });
});
