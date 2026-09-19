#!/usr/bin/env node

/**
 * Local CLI for the embedded Gemini Business pool.
 *
 * The bot owns the pool at runtime; this entry exists for the one task that
 * cannot happen inside a turn — signing an account in through a headless
 * browser and printing the `proxy.yaml` block it produces.
 */

import "dotenv/config";
import { geminiCli } from "./gemini-business/cli.js";

geminiCli(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
