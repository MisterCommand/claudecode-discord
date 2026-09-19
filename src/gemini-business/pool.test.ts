import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiAccountStore } from "./account-store.js";
import { startGeminiBusinessPool } from "./pool.js";
import type { GeminiBusinessConfig } from "./config.js";
import type { ConfiguredAccount } from "./types.js";
import type { CredentialCheck, SignInOptions } from "./signin.js";

function config(overrides: Partial<GeminiBusinessConfig> = {}): GeminiBusinessConfig {
  return {
    server: { host: "127.0.0.1", port: 0, api_keys: ["sk-test"], default_model: "gemini-3.8-flash" },
    pool: { rotation_strategy: "round-robin", max_retries: 3, retry_delay: 1000, error_threshold: 3 },
    sso: { enabled: true },
    ...overrides,
  };
}

function account(name: string, enabled = true): ConfiguredAccount {
  return {
    name,
    team_id: `team-${name}`,
    cookies: { secure_c_ses: `${name}-ses`, host_c_oses: `${name}-oses` },
    csesidx: "1",
    enabled,
  };
}

/** Seed the runtime store, which is the only account source. */
function storeAccounts(directory: string, accounts: ConfiguredAccount[]): void {
  const store = new GeminiAccountStore(directory);
  for (const entry of accounts) store.save(entry);
}

const captured: ConfiguredAccount = {
  name: "refreshed",
  team_id: "team-new",
  cookies: { secure_c_ses: "CSE.new", host_c_oses: "COS.new" },
  csesidx: "999",
  user_agent: "agent/1",
  enabled: true,
};

/** A credential probe that reports the stored cookies still work. */
function okCheck() {
  return vi.fn(async (_account: ConfiguredAccount): Promise<CredentialCheck> => ({ ok: true }));
}

/** A sign-in stub that records how it was called. */
function signInMock(result: ConfiguredAccount = captured) {
  return vi.fn(async (_options: SignInOptions) => result);
}

const directories: string[] = [];
function tempDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pool-signin-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("startup sign-in", () => {
  const sso = { email: "a@b.com", password: "secret" };

  it("keeps working credentials and never opens a browser", async () => {
    const directory = tempDirectory();
    storeAccounts(directory, [account("alive")]);
    const signIn = signInMock();
    const pool = await startGeminiBusinessPool(config(), {
      dataDirectory: directory,
      sso,
      deps: { checkCredentials: async () => ({ ok: true }), signIn },
    });

    try {
      expect(pool.accountNames()).toEqual(["alive"]);
      expect(signIn).not.toHaveBeenCalled();
    } finally {
      await pool.close();
    }
  });

  it("signs in and persists the account when the stored cookies are rejected", async () => {
    const directory = tempDirectory();
    storeAccounts(directory, [account("stale")]);
    const signIn = signInMock();
    const pool = await startGeminiBusinessPool(config(), {
      dataDirectory: directory,
      sso,
      deps: { checkCredentials: async () => ({ ok: false, error: "401" }), signIn },
    });

    try {
      // The pool serves the refreshed credential from this run onward...
      expect(signIn).toHaveBeenCalledOnce();
      expect(signIn.mock.calls[0][0]).toMatchObject({ name: "stale", headless: true });
      // ...stored under the same name, so the next start finds it without a browser.
      expect(new GeminiAccountStore(directory).read()).toEqual([{ ...captured, name: "stale" }]);
    } finally {
      await pool.close();
    }
  });

  it("does not sign in when sso.enabled is false, and reports why", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const signIn = signInMock();
    const directory = tempDirectory();
    storeAccounts(directory, [account("stale")]);
    const pool = await startGeminiBusinessPool(
      config({ sso: { enabled: false } }),
      { dataDirectory: directory, sso, deps: { checkCredentials: async () => ({ ok: false, error: "401" }), signIn } },
    );

    try {
      expect(signIn).not.toHaveBeenCalled();
      expect(pool.accountNames()).toEqual(["stale"]);
      expect(warn.mock.calls.flat().join(" ")).toMatch(/sso\.enabled/);
    } finally {
      await pool.close();
    }
  });

  it("explains how to enable sign-in when no credentials are configured", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const directory = tempDirectory();
    storeAccounts(directory, [account("stale")]);
    const pool = await startGeminiBusinessPool(config(), {
      dataDirectory: directory,
      deps: { checkCredentials: async () => ({ ok: false, error: "401" }), signIn: signInMock() },
    });

    try {
      expect(warn.mock.calls.flat().join(" ")).toMatch(/GEMINI_SSO_EMAIL/);
    } finally {
      await pool.close();
    }
  });

  it("captures a first account from sso when none is configured", async () => {
    const directory = tempDirectory();
    const signIn = signInMock();
    const pool = await startGeminiBusinessPool(config({ sso: { enabled: true, name: "primary" } }), {
      dataDirectory: directory,
      sso,
      deps: { checkCredentials: okCheck(), signIn },
    });

    try {
      expect(pool.accountNames()).toEqual(["refreshed"]);
      expect(signIn.mock.calls[0][0]).toMatchObject({ name: "primary" });
      expect(new GeminiAccountStore(directory).read()).toHaveLength(1);
    } finally {
      await pool.close();
    }
  });

  it("fails with a runnable message when nothing can supply an account", async () => {
    await expect(startGeminiBusinessPool(config(), {
      dataDirectory: tempDirectory(),
      deps: { checkCredentials: okCheck(), signIn: signInMock() },
    })).rejects.toThrow(/GEMINI_SSO_EMAIL/);
  });

  it("keeps the pool running when a sign-in fails, and reports the reason", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const signIn = vi.fn(async () => {
      throw new Error("Sign-in was rejected: account isn't in our system.\nHint: check the address.");
    });

    const directory = tempDirectory();
    storeAccounts(directory, [account("stale")]);
    const pool = await startGeminiBusinessPool(config(), {
      dataDirectory: directory,
      sso,
      deps: { checkCredentials: async () => ({ ok: false, error: "401" }), signIn },
    });

    try {
      // The account keeps its previous credentials rather than the bot dying.
      expect(pool.accountNames()).toEqual(["stale"]);
      const message = warn.mock.calls.flat().join(" ");
      expect(message).toMatch(/isn't in our system/);
      // The hint line is dropped, and the operator is told what to do next.
      expect(message).not.toMatch(/Hint:/);
      expect(message).toMatch(/--no-sso/);
    } finally {
      await pool.close();
    }
  });

  it("never echoes the sign-in password into the logs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const secret = "super-secret-password";
    const signIn = vi.fn(async () => {
      throw new Error(`Sign-in was rejected: the password ${secret} is incorrect.`);
    });

    const directory = tempDirectory();
    storeAccounts(directory, [account("stale")]);
    const pool = await startGeminiBusinessPool(config(), {
      dataDirectory: directory,
      sso: { email: "a@b.com", password: secret },
      deps: { checkCredentials: async () => ({ ok: false, error: "401" }), signIn },
    });

    try {
      const logged = [...warn.mock.calls.flat(), ...log.mock.calls.flat()].join(" ");
      expect(logged).not.toContain(secret);
      expect(logged).toContain("[redacted]");
    } finally {
      await pool.close();
    }
  });

  it("treats a failed first sign-in as fatal, with the provider's explanation", async () => {
    const signIn = vi.fn(async () => {
      throw new Error("Sign-in was rejected: account is locked.");
    });

    await expect(startGeminiBusinessPool(config(), {
      dataDirectory: tempDirectory(),
      sso,
      deps: { checkCredentials: vi.fn(), signIn },
    })).rejects.toThrow(/account is locked/);
  });

  it("serves a previously captured account without an environment password", async () => {
    const directory = tempDirectory();
    new GeminiAccountStore(directory).save(captured);

    // A captured account only needs its stored cookies to be probed successfully.
    const pool = await startGeminiBusinessPool(config(), {
      dataDirectory: directory,
      deps: { checkCredentials: okCheck(), signIn: signInMock() },
    });

    try {
      expect(pool.accountNames()).toEqual(["refreshed"]);
    } finally {
      await pool.close();
    }
  });

  it("does not let a rejected account stop the pool from starting", async () => {
    const directory = tempDirectory();
    storeAccounts(directory, [account("stale")]);
    const pool = await startGeminiBusinessPool(config(), {
      dataDirectory: directory,
      deps: { checkCredentials: async () => ({ ok: false, error: "401" }), signIn: signInMock() },
    });

    try {
      // No credentials to sign in with, so the pool still starts and the
      // eventual request fails with an actionable upstream error.
      expect(pool.accountNames()).toEqual(["stale"]);
    } finally {
      await pool.close();
    }
  });
});

describe("GeminiAccountStore", () => {
  it("rejects a structurally invalid capture instead of loading it", () => {
    const directory = tempDirectory();
    fs.writeFileSync(path.join(directory, "gemini-accounts.json"), JSON.stringify([{ name: "broken" }]));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(new GeminiAccountStore(directory).read()).toEqual([]);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/Ignoring invalid captured account/);
  });

  it("treats a corrupt file as empty rather than crashing startup", () => {
    const directory = tempDirectory();
    fs.writeFileSync(path.join(directory, "gemini-accounts.json"), "{not json");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(new GeminiAccountStore(directory).read()).toEqual([]);
  });

  it("replaces an entry by name instead of accumulating entries", () => {
    const directory = tempDirectory();
    const store = new GeminiAccountStore(directory);
    store.save(captured);
    store.save({ ...captured, csesidx: "1234" });

    const stored = store.read();
    expect(stored).toHaveLength(1);
    expect(stored[0].csesidx).toBe("1234");
  });
});
