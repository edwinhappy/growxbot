import { Telegraf } from "telegraf";
import { BOT_TOKEN, ADMIN_ID, ADMIN_GROUP_ID, OWNER_X, ENABLE_LOGS } from "./src/config.js";
import { db } from "./src/database.js";
import { logger, checkRateLimit } from "./src/utils.js";
import { setupHandlers } from "./src/handlers.js";

import express from "express";

const bot = new Telegraf(BOT_TOKEN);

// ===========================
// DUMMY SERVER FOR RENDER
// ===========================
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/health", (req, res) => res.send("OK"));

app.listen(PORT, () => {
  console.log(`🌐 Web server running on port ${PORT}`);
});

// ===========================
// RATE LIMIT MIDDLEWARE
// ===========================
bot.use((ctx, next) => {
  if (ctx.from && !checkRateLimit(ctx.from.id)) {
    return ctx.reply("⏰ Whoa, slow down fam. Give it a minute.");
  }
  return next();
});

// ===========================
// SETUP HANDLERS
// ===========================
setupHandlers(bot);

// ===========================
// STARTUP
// ===========================
async function start() {
  console.log("🚀 Starting X Verification & Growth Bot...");
  console.log("=".repeat(60));

  try {
    await db.load();
    const stats = db.getStats();
    console.log(`✅ Database loaded: ${stats.totalUsers} verified users`);
    console.log(`🔗 Total matches made: ${stats.totalMatches}`);
  } catch (error) {
    logger.error("❌ Failed to load database:", error.message);
    process.exit(1);
  }

  try {
    await bot.launch();
    console.log("✅ Bot is running and ready!");
    console.log(`📝 Owner X account: @${OWNER_X}`);
    console.log(`👤 Admin ID: ${ADMIN_ID}`);
    console.log(`👥 Admin Group: ${ADMIN_GROUP_ID}`);
    console.log(`🔇 Verbose logging: ${ENABLE_LOGS ? 'ENABLED' : 'DISABLED'}`);
    console.log("\n📋 Admin Commands:");
    console.log("   /distribute [count] - Send profiles to all users");
    console.log("   /send_to @username [count] - Send to specific user");
    console.log("   /adminstats - View statistics");
    console.log("   /list_users - List all verified users");
    console.log("   /reset_matches - Reset match history");
    console.log("   /broadcast - Send announcement");
    console.log("\n📨 Waiting for messages...\n");
    console.log("=".repeat(60));
  } catch (error) {
    logger.error("❌ Failed to launch bot:", error.message);
    process.exit(1);
  }

  process.once("SIGINT", () => {
    console.log("\n⏹️  Shutting down gracefully...");
    bot.stop("SIGINT");
  });

  process.once("SIGTERM", () => {
    console.log("\n⏹️  Shutting down gracefully...");
    bot.stop("SIGTERM");
  });
}

start().catch((error) => {
  logger.error("❌ Fatal error:", error);
  process.exit(1);
});
