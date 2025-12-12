import mongoose from 'mongoose';
import { db } from './database.js';
import { sessionManager, ocrManager, setupVerificationHandlers } from './verificationHandler.js';
import { setupProfileHandlers } from './profileHandler.js';
import { setupAdminHandlers } from './adminHandler.js';
import { setupInteractionHandlers } from './callbackHandler.js';
import { logger } from './utils.js';
import { ADMIN_ID } from './config.js';

// Re-export singletons for consistency
export { db, sessionManager, ocrManager };

export async function setupHandlers(bot) {
    // Attach managers to bot for access in handlers
    bot.context.db = db;
    bot.context.sessionManager = sessionManager;
    bot.context.ocrManager = ocrManager;

    // Setup all module handlers
    setupVerificationHandlers(bot);
    setupProfileHandlers(bot);
    setupAdminHandlers(bot);
    setupInteractionHandlers(bot);

    // Global error handler
    bot.catch(async (err, ctx) => {
        logger.error(`❌ Bot error for ${ctx.updateType}:`, err);

        // Alert admin on critical errors
        try {
            if (ctx.from?.id === ADMIN_ID) {
                await ctx.reply(`🚨 <b>Admin Error</b>\n${err.message}`, { parse_mode: "HTML" });
            }
        } catch (e) {
            // Ignore if reply fails
        }
    });
}

// Graceful shutdown
export async function shutdown() {
    console.log("\n⏹️  Shutting down...");
    try {
        await ocrManager.terminate();
        await mongoose.connection.close();
        if (sessionManager.destroy) sessionManager.destroy();
    } catch (e) {
        console.error("Error during shutdown:", e);
    }
}
