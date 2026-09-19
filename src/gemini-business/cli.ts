/**
 * `gemini login` — capture a Gemini Business account.
 *
 * The bot signs in on its own at startup, so this command exists for a
 * deliberate capture: a first account on a machine with no display, a workspace
 * the automation has not seen, or a manual sign-in for an MFA prompt it cannot
 * clear. The captured account goes to the runtime store the bot reads, so
 * startup finds it immediately; `proxy.yaml` never holds accounts.
 *
 * The browser is headless, so it works on a server with no display; the Google
 * Workforce Identity Federation provider name and the Microsoft Entra ID form
 * are filled in from `GEMINI_SSO_*`, including the authenticator-app code.
 */

import path from "node:path";
import { BrowserAuth } from "./browser-auth.js";
import {
  GEMINI_ACCOUNTS_FILE_NAME, GeminiAccountStore,
} from "./account-store.js";
import {
  GEMINI_BUSINESS_PROVIDER_VALUE,
  geminiBusinessUrl, proxyConfigPath, readProxyConfig,
  type GeminiBusinessConfig,
} from "./config.js";
import { geminiSsoCredentials } from "./credentials.js";
import { checkAccountCredentials } from "./signin.js";
import type { ConfiguredAccount } from "./types.js";

const USAGE = [
  "Usage: npm run gemini -- login [account-name] [--force] [--no-sso] [--provider <name>] [--team-id <uuid>]",
  "",
  "  Sign in to Gemini Business in a headless Chrome window and store the",
  `  account in ${GEMINI_ACCOUNTS_FILE_NAME}, which the bot reads at startup.`,
  "",
  "  --force            skip the stored-credential check and always open the browser",
  "  --no-sso           do not drive the identity-provider form; sign in by hand",
  "  --provider <name>  Workforce Identity Federation provider (default GEMINI_SSO_PROVIDER)",
  "  --team-id <uuid>   workspace id after /cid/ in the app URL (default GEMINI_SSO_TEAM_ID)",
].join("\n");

interface ParsedFlags {
  name?: string;
  force: boolean;
  noSso: boolean;
  provider?: string;
  teamId?: string;
}

function parseFlags(args: string[]): ParsedFlags {
  const flags: ParsedFlags = { force: false, noSso: false };
  const positional: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--force") { flags.force = true; continue; }
    if (flag === "--no-sso") { flags.noSso = true; continue; }
    if (flag === "--provider" || flag === "--team-id") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Missing value for ${flag}`);
      }
      if (flag === "--provider") flags.provider = value; else flags.teamId = value;
      index++;
      continue;
    }
    if (flag.startsWith("--")) throw new Error(`Unknown option: ${flag}`);
    positional.push(flag);
  }

  flags.name = positional[0];
  if (positional.length > 1) throw new Error(`Unexpected argument: ${positional[1]}`);
  return flags;
}

async function login(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const configDirectory = process.env.BOT_CONFIG_DIR?.trim();
  if (!configDirectory) {
    throw new Error("BOT_CONFIG_DIR must be set to locate proxy.yaml (see .env.example).");
  }

  const sso = geminiSsoCredentials();
  let existing: GeminiBusinessConfig | undefined;
  try {
    existing = readProxyConfig(configDirectory);
  } catch (error) {
    // A missing or not-yet-valid proxy.yaml only means there is nothing to check yet.
    console.log(`No usable ${proxyConfigPath(configDirectory)}: ${error instanceof Error ? error.message : error}`);
  }

  const accountName = flags.name ?? existing?.sso.name ?? `account-${Date.now()}`;
  if (!flags.force) {
    const stored = new GeminiAccountStore().read().find((account) => account.name === accountName);
    if (stored) {
      console.log(`Checking stored credentials for ${stored.name}...`);
      const check = await checkAccountCredentials(stored);
      if (check.ok) {
        console.log("Credentials are still valid — no sign-in needed.");
        return;
      }
      console.log(`Stored credentials were rejected: ${check.error.split("\n")[0]}`);
    }
  }

  const teamId = flags.teamId ?? sso.teamId ?? existing?.sso.team_id;
  const provider = flags.provider ?? sso.provider ?? existing?.sso.provider;

  console.log("Gemini Business sign-in");
  console.log("-----------------------");
  if (flags.noSso) {
    // Nothing is automated, so the window must be visible for a person to use.
    console.log("A Chrome window will open. Sign in and open the Gemini Business chat there:");
    console.log("the workspace id is read from the app's own network requests.");
  } else {
    console.log("A headless Chrome window will sign in automatically.");
  }
  if (!flags.noSso && (!sso.email || !sso.password)) {
    console.log("GEMINI_SSO_EMAIL and GEMINI_SSO_PASSWORD are not both set, so the sign-in");
    console.log("form cannot be filled in automatically. Set them, or use --no-sso and sign in yourself.");
  }

  // The interactive flow honours `--no-sso`, which the shared helper does not
  // express; everything else about the capture is identical.
  const auth = new BrowserAuth({
    name: accountName,
    headless: !flags.noSso,
    disableSso: flags.noSso,
    ...(provider || teamId ? { sso: { provider, teamId } } : {}),
  });
  const credentials = await auth.captureCredentials((message) => console.log(message));
  const account: ConfiguredAccount = {
    name: accountName,
    team_id: credentials.team_id,
    cookies: credentials.cookies,
    csesidx: credentials.csesidx,
    user_agent: credentials.user_agent,
    enabled: true,
  };

  new GeminiAccountStore().save(account);
  console.log(`\nSaved "${account.name}" to ${path.join(process.cwd(), GEMINI_ACCOUNTS_FILE_NAME)}.`);
  console.log("The bot signs this account in again automatically when its cookies expire.");
}

/**
 * Minimal CLI surface. Only `login` is exposed: the bot owns the pool at
 * runtime, so `serve` and the account listings have no separate meaning here.
 */
export async function geminiCli(args: string[]): Promise<void> {
  const command = args[0];
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }

  if (command === "login") {
    await login(args.slice(1));
    return;
  }

  if (command === "check") {
    const configDirectory = process.env.BOT_CONFIG_DIR?.trim();
    if (!configDirectory) throw new Error("BOT_CONFIG_DIR must be set to locate proxy.yaml.");
    const config = readProxyConfig(configDirectory);
    console.log(`Pool: ${geminiBusinessUrl(config)} (provider "${GEMINI_BUSINESS_PROVIDER_VALUE}")`);
    console.log(`Default model: ${config.server.default_model}`);

    // Check exactly what the pool would serve: the captured accounts.
    const accounts = new GeminiAccountStore().read();
    if (accounts.length === 0) {
      console.log("No accounts captured yet. Run `npm run gemini -- login`, or set GEMINI_SSO_EMAIL and GEMINI_SSO_PASSWORD for startup sign-in.");
      process.exitCode = 1;
      return;
    }
    for (const account of accounts) {
      const result = await checkAccountCredentials(account);
      console.log(`${result.ok ? "ok" : "failed"}  ${account.name}${result.ok ? "" : `  ${result.error.split("\n")[0]}`}`);
    }
    return;
  }

  if (command === "validate") {
    const configDirectory = process.env.BOT_CONFIG_DIR?.trim();
    if (!configDirectory) throw new Error("BOT_CONFIG_DIR must be set to locate proxy.yaml.");
    try {
      readProxyConfig(configDirectory);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
      return;
    }
    console.log(`${proxyConfigPath(configDirectory)} is valid.`);
    return;
  }

  throw new Error(`Unknown command: ${command}\n\n${USAGE}`);
}
