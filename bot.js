import { Telegraf } from 'telegraf';
import { BOT_TOKEN, ADMIN_ID } from './src/config.js';
import { setupHandlers, shutdown } from './src/setupHandlers.js';
import { checkRateLimit } from './src/rateLimiter.js';
import { db } from './src/setupHandlers.js';
import express from 'express';

const bot = new Telegraf(BOT_TOKEN);

// Initialize Express health check (doesn't need DB)
const app = express();
app.get("/health", (req, res) => res.json({ status: "OK", timestamp: Date.now() }));
app.listen(process.env.PORT || 3000, () => {
  console.log(`🌐 Health check running on port ${process.env.PORT || 3000}`);
});

// ============================================
// CRITICAL: Initialize DB first to prevent Race Conditions
// ============================================
async function initializeBot() {
  try {
    console.log("🔄 Connecting to database...");
    await db.load(); // Wait for DB connection
    console.log("✅ Database connected");

    // NOW register middleware that uses DB
    bot.use(async (ctx, next) => {
      if (!ctx.from) return next();

      if (!await checkRateLimit(ctx.from.id, ctx.from.id === ADMIN_ID)) {
        try {
          if (ctx.callbackQuery) {
            return await ctx.answerCbQuery("⏰ Rate limit exceeded. Chill out fam.", true);
          } else {
            return await ctx.reply("⏰ Rate limit exceeded. Please wait a minute.");
          }
        } catch (e) {
          console.error("Rate limit reply failed:", e);
        }
      }
      return next();
    });

    // Setup other handlers (admin, profile, verification, etc.)
    await setupHandlers(bot);

    // Start bot
    console.log("🚀 Starting X Verification & Growth Bot...");
    bot.launch().then(() => {
      console.log("✅ Bot is running!");
    }).catch(err => {
      console.error("❌ Failed to launch bot:", err);
      process.exit(1);
    });

    // Graceful shutdown
    process.once("SIGINT", async () => {
      await shutdown();
      bot.stop("SIGINT");
      process.exit(0);
    });
    process.once("SIGTERM", async () => {
      await shutdown();
      bot.stop("SIGTERM");
      process.exit(0);
    });

    // Global Error Handlers
    process.on('unhandledRejection', (reason, promise) => {
      console.error('🚨 Unhandled Rejection:', reason);
    });
    process.on('uncaughtException', (error) => {
      console.error('🚨 Uncaught Exception:', error);
      process.exit(1);
    });

  } catch (error) {
    console.error("❌ Fatal error during initialization:", error);
    process.exit(1);
  }
}

// Start everything
initializeBot();
