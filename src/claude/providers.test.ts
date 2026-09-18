import { describe, expect, it } from "vitest";
import type { ClaudeConfig } from "../utils/config.js";
import { claudeEnvironmentOverrides, resolveClaudeProvider } from "./providers.js";

const claude: ClaudeConfig = {
  default_provider: "kimi",
  providers: [
    { value: "claude-default", label: "Claude subscription" },
    {
      value: "kimi",
      label: "Moonshot Kimi",
      api_key: "sk-kimi",
      base_url: "https://api.moonshot.example/anthropic",
      default_model: "kimi-k2",
      subagent_model: "haiku",
      effort_level: "xhigh",
    },
    { value: "glm", label: "GLM", api_key: "sk-glm", base_url: "https://api.glm.example" },
  ],
};

describe("claudeEnvironmentOverrides", () => {
  it("forwards the selected provider's credentials and tunables", () => {
    expect(claudeEnvironmentOverrides(claude.providers[1])).toEqual({
      ANTHROPIC_API_KEY: "sk-kimi",
      ANTHROPIC_BASE_URL: "https://api.moonshot.example/anthropic",
      CLAUDE_CODE_SUBAGENT_MODEL: "haiku",
      CLAUDE_CODE_EFFORT_LEVEL: "xhigh",
    });
  });

  it("always claims the credentials so a blank provider falls back to OAuth login", () => {
    expect(claudeEnvironmentOverrides(claude.providers[0]))
      .toEqual({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_BASE_URL: undefined });
  });

  it("leaves the Claude Code tunables to the inherited environment when the provider omits them", () => {
    const environment = claudeEnvironmentOverrides(claude.providers[2]);
    expect(environment.ANTHROPIC_API_KEY).toBe("sk-glm");
    expect(environment).not.toHaveProperty("CLAUDE_CODE_SUBAGENT_MODEL");
    expect(environment).not.toHaveProperty("CLAUDE_CODE_EFFORT_LEVEL");
  });
});

describe("resolveClaudeProvider", () => {
  it("prefers the channel override over the configured default", () => {
    expect(resolveClaudeProvider(claude, "glm").value).toBe("glm");
  });

  it("falls back to the configured default provider", () => {
    expect(resolveClaudeProvider(claude, undefined).value).toBe("kimi");
  });

  it("ignores a stored provider that is no longer configured", () => {
    expect(resolveClaudeProvider(claude, "removed-provider").value).toBe("kimi");
  });

  it("uses the first provider when no default is configured", () => {
    const withoutDefault: ClaudeConfig = { providers: claude.providers };
    expect(resolveClaudeProvider(withoutDefault, undefined).value).toBe("claude-default");
  });
});
