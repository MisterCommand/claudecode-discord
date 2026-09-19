import "dotenv/config";
import { loadConfig } from "./utils/config.js";
import { initDatabase } from "./db/database.js";
import { startBot } from "./bot/client.js";
import { scheduleService } from "./scheduler/service.js";
import { initializeTelemetry, shutdownTelemetry } from "./observability/telemetry.js";
import { startGeminiBusinessPool, type RunningGeminiBusinessPool } from "./gemini-business/pool.js";

let shuttingDown = false;
let geminiBusinessPool: RunningGeminiBusinessPool | undefined;

async function shutdown(exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  scheduleService.stop();
  await geminiBusinessPool?.close().catch((error) => console.error("Failed to stop the Gemini Business pool:", error));
  await shutdownTelemetry();
  process.exit(exitCode);
}

async function main() {
  process.on("exit", () => { scheduleService.stop(); });
  process.on("SIGINT", () => { void shutdown(0); });
  process.on("SIGTERM", () => { void shutdown(0); });

  // Global error handlers — prevent silent hangs from unhandled errors
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled promise rejection:", reason);
  });
  process.on("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);
    // Don't exit — let the bot keep running for non-fatal errors
  });

  console.log("Starting Claude Code Discord Controller...");

  // Load and validate config
  const config = loadConfig();
  console.log("Config loaded");
  initializeTelemetry(config);

  // Initialize database
  initDatabase();
  console.log("Database initialized");

  // Start the embedded Gemini Business pool before Discord, so the
  // `gemini-business` provider is already answering when the first turn runs.
  // Startup refreshes expired accounts through the browser sign-in, which is why
  // this is awaited rather than raced with the bot.
  if (config.geminiBusiness) {
    geminiBusinessPool = await startGeminiBusinessPool(config.geminiBusiness, {
      dataDirectory: process.cwd(),
      sso: {
        email: config.GEMINI_SSO_EMAIL,
        password: config.GEMINI_SSO_PASSWORD,
        totpSecret: config.GEMINI_SSO_TOTP_SECRET,
        provider: config.GEMINI_SSO_PROVIDER,
      },
    });
  }

  // Start Discord bot
  await startBot();
  console.log("Bot is running!");
}

main().catch(async (error) => {
  console.error("Fatal error:", error);
  await shutdown(1);
});
