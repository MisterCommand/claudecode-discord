import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GEMINI_BUSINESS_PROVIDER_VALUE, geminiBusinessProvider, geminiBusinessUrl,
  parseProxyConfig, proxyConfigPath, readProxyConfig,
} from "./config.js";
import { geminiBusinessCredentialEnvironmentOverrides } from "./credentials.js";
import { withGeminiBusinessProvider } from "../utils/config.js";

const valid = `
server:
  api_keys:
    - sk-local-1
pool:
  rotation_strategy: least-used
`;

function parsed(source = valid) {
  const result = parseProxyConfig(source);
  if (!result.config) throw new Error(`expected a valid config: ${result.problems.join(", ")}`);
  return result.config;
}

describe("proxy.yaml parsing", () => {
  it("applies the documented defaults for omitted optional fields", () => {
    const config = parsed();
    expect(config.server).toEqual({
      host: "127.0.0.1",
      port: 8000,
      api_keys: ["sk-local-1"],
      default_model: "gemini-3.8-flash",
    });
    expect(config.pool).toEqual({
      rotation_strategy: "least-used",
      max_retries: 3,
      retry_delay: 1000,
      error_threshold: 3,
    });
    expect(config.sso).toEqual({ enabled: true });
  });

  it("does not accept accounts, which are captured rather than configured", () => {
    const problems = parseProxyConfig(`${valid}accounts: []\n`).problems.join("\n");
    expect(problems).toMatch(/Unrecognized key/);
    expect(problems).toMatch(/accounts/);
  });

  it("requires at least one API key so the pool is never unauthenticated", () => {
    const result = parseProxyConfig(valid.replace("    - sk-local-1", "    []"));
    expect(result.problems.join("\n")).toMatch(/api_keys/);
    expect(result.problems.join("\n")).toMatch(/at least one/);
  });

  it("requires the server section, which gates authentication", () => {
    expect(parseProxyConfig("sso: {}\n").problems.join("\n")).toMatch(/server/);
    // An empty section must still fail its inner constraints.
    expect(parseProxyConfig("server: {}\n").problems.join("\n")).toMatch(/api_keys/);
  });

  it("parses the sso section that drives startup sign-in", () => {
    const config = parsed(`${valid}
sso:
  provider: locations/global/workforcePools/p/providers/idp
  team_id: 11111111-2222-3333-4444-555555555555
  name: primary
`);
    expect(config.sso).toEqual({
      enabled: true,
      provider: "locations/global/workforcePools/p/providers/idp",
      team_id: "11111111-2222-3333-4444-555555555555",
      name: "primary",
    });
  });

  it("rejects unknown keys and an invalid sso section", () => {
    expect(parseProxyConfig(`${valid}extra: true\n`).problems.join("\n")).toMatch(/Unrecognized key/);
    expect(parseProxyConfig(`${valid}sso:\n  enabled: sometimes\n`).problems.join("\n"))
      .toMatch(/sso\.enabled/);
    // The sign-in secrets belong in the environment, never in trusted policy.
    expect(parseProxyConfig(`${valid}sso:\n  password: hunter2\n`).problems.join("\n"))
      .toMatch(/Unrecognized key/);
  });

  it("reports an invalid rotation strategy instead of falling back silently", () => {
    expect(parseProxyConfig(valid.replace("least-used", "spread")).problems.join("\n"))
      .toMatch(/round-robin, least-used, or random/);
  });

  it("rejects an out-of-range port instead of letting the server fail later", () => {
    expect(parseProxyConfig(valid.replace("server:\n", "server:\n  port: 70000\n")).problems.join("\n"))
      .toMatch(/port/);
  });
});

describe("proxy config file resolution", () => {
  const directory = path.join(process.cwd(), "tmp-proxy-config-test");

  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it("reads proxy.yaml from the trusted configuration directory", () => {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(proxyConfigPath(directory), valid);
    expect(readProxyConfig(directory).server.api_keys).toEqual(["sk-local-1"]);
  });

  it("reports invalid content by path instead of throwing a bare parse error", () => {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(proxyConfigPath(directory), "server: {}\n");
    expect(() => readProxyConfig(directory)).toThrow(/Invalid .*proxy\.yaml/);
    expect(() => readProxyConfig(directory)).toThrow(/api_keys/);
  });

  it("names the missing file when proxy.yaml cannot be read", () => {
    expect(() => readProxyConfig(directory)).toThrow(/Cannot read .*proxy\.yaml/);
  });
});

describe("provider injection", () => {
  it("points the /model entry at the pool's own address and key", () => {
    const config = parsed(valid.replace("  api_keys:\n    - sk-local-1", "  api_keys:\n    - sk-local-1\n  port: 9123"));
    expect(geminiBusinessProvider(config)).toEqual({
      value: GEMINI_BUSINESS_PROVIDER_VALUE,
      label: "Gemini Business (embedded proxy)",
      api_key: "sk-local-1",
      base_url: "http://127.0.0.1:9123",
      default_model: "gemini-3.8-flash",
    });
  });

  it("gives a wildcard bind address a loopback client URL", () => {
    expect(geminiBusinessUrl(parsed(valid.replace("server:\n", "server:\n  host: 0.0.0.0\n"))))
      .toBe("http://127.0.0.1:8000");
  });

  it("prepends the pool so it is the default for channels without an override", () => {
    const claude = withGeminiBusinessProvider(
      { providers: [{ value: "subscription", label: "Claude subscription" }] },
      parsed(valid),
    );
    expect(claude.providers.map((provider) => provider.value))
      .toEqual([GEMINI_BUSINESS_PROVIDER_VALUE, "subscription"]);
  });

  it("lets config.yaml replace the injected entry entirely", () => {
    const custom = {
      value: GEMINI_BUSINESS_PROVIDER_VALUE,
      label: "Pool via config.yaml",
      api_key: "sk-other",
      base_url: "http://pool.internal:9000",
    };
    const claude = withGeminiBusinessProvider(
      { default_provider: GEMINI_BUSINESS_PROVIDER_VALUE, providers: [custom] },
      parsed(valid),
    );
    expect(claude.providers).toEqual([custom]);
  });
});

describe("credential isolation", () => {
  it("claims every sign-in variable so it is removed from the Claude subprocess", () => {
    const overrides = geminiBusinessCredentialEnvironmentOverrides();
    for (const name of ["GEMINI_SSO_EMAIL", "GEMINI_SSO_PASSWORD", "GEMINI_SSO_TOTP_SECRET", "GEMINI_SSO_TEAM_ID", "GEMINI_SSO_PROVIDER"]) {
      expect(overrides[name]).toBeUndefined();
      expect(overrides).toHaveProperty(name);
    }
  });
});
