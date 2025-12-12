import { Telegraf } from 'telegraf';
import { BOT_TOKEN, ADMIN_ID } from './src/config.js';
import { setupHandlers, shutdown } from './src/setupHandlers.js';
import { checkRateLimit } from './src/rateLimiter.js';
import express from 'express';

const bot = new Telegraf(BOT_TOKEN);

// Express health check
const app = express();
app.get("/health", (req, res) => res.json({ status: "OK", timestamp: Date.now() }));
app.listen(process.env.PORT || 3000, () => {
  console.log(`🌐 Health check running on port ${process.env.PORT || 3000}`);
});


// Rate limiting (bypass admin)
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

// Setup handlers
// Setup handlers
try {
  await setupHandlers(bot);
} catch (error) {
  console.error("❌ Fatal error during setup:", error);
  process.exit(1);
}

// Global Error Handlers
process.on('unhandledRejection', (reason, promise) => {
  console.error('🚨 Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('🚨 Uncaught Exception:', error);
  process.exit(1);
});

// Start bot
console.log("🚀 Starting X Verification & Growth Bot...");
bot.launch().then(() => {
  console.log("✅ Bot is running!");
}).catch(err => {
  console.error("❌ Failed to launch bot:", err);
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
