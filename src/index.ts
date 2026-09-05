import "dotenv/config";
import { loadConfig } from "./utils/config.js";
import { initDatabase } from "./db/database.js";
import { startBot } from "./bot/client.js";
import { scheduleService } from "./scheduler/service.js";

async function main() {
  process.on("exit", () => { scheduleService.stop(); });
  process.on("SIGINT", () => { scheduleService.stop(); process.exit(0); });
  process.on("SIGTERM", () => { scheduleService.stop(); process.exit(0); });

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
  loadConfig();
  console.log("Config loaded");

  // Initialize database
  initDatabase();
  console.log("Database initialized");

  // Start Discord bot
  await startBot();
  console.log("Bot is running!");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
