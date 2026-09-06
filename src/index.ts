import "dotenv/config";
import { loadConfig } from "./utils/config.js";
import { initDatabase } from "./db/database.js";
import { startBot } from "./bot/client.js";
import { scheduleService } from "./scheduler/service.js";
import { initializeTelemetry, shutdownTelemetry } from "./observability/telemetry.js";

let shuttingDown = false;

async function shutdown(exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  scheduleService.stop();
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

  // Start Discord bot
  await startBot();
  console.log("Bot is running!");
}

main().catch(async (error) => {
  console.error("Fatal error:", error);
  await shutdown(1);
});
