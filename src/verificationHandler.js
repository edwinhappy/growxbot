import { Markup } from "telegraf";
import { createWorker, createScheduler } from "tesseract.js";
import path from "path";
import { fileURLToPath } from "url";
import { db } from "./database.js";
import { escapeHtml, logger } from "./utils.js";
import { validateProfileLayout, normalizeText } from "./ocr.js";
import { SessionManager } from "./SessionManager.js"; // Import new manager
import {
    ADMIN_ID,
    ADMIN_GROUP_ID,
    OWNER_X,
    OCR_POOL_SIZE
} from "./config.js";
import sharp from "sharp";
import fs from "fs/promises";
import os from "os";


// ===========================
// TESSERACT SCHEDULER (POOL)
// ===========================
class OCRSchedulerManager {
    constructor() {
        this.scheduler = null;
        this.initializationPromise = null; // Single source of truth
        this.maxInitAttempts = 3;
    }

    async getScheduler() {
        if (this.scheduler) return this.scheduler;

        if (this.initializationPromise) {
            return this.initializationPromise; // Wait for ongoing init
        }

        this.initializationPromise = this.initializeScheduler();
        return this.initializationPromise;
    }

    async initializeScheduler() {
        let attempts = 0;
        while (attempts < this.maxInitAttempts) {
            try {
                console.log(`⚙️ Initializing Tesseract with ${OCR_POOL_SIZE} workers...`);
                const scheduler = createScheduler();

                const __dirname = path.dirname(fileURLToPath(import.meta.url));
                const langPath = path.resolve(__dirname, "../"); // Original path logic
                const cachePath = path.join(__dirname, "../.tesseract_cache");

                const workerPromises = Array.from({ length: OCR_POOL_SIZE }, async (_, i) => {
                    const worker = await createWorker("eng", 1, {
                        langPath,
                        cachePath,
                        gzip: false,
                        logger: () => { } // Silent logger
                    });
                    scheduler.addWorker(worker);
                    console.log(`✅ Worker ${i + 1} Ready`);
                });

                await Promise.all(workerPromises);
                console.log("✅ OCR Scheduler Ready!");

                this.scheduler = scheduler;
                this.initializationPromise = null;
                return scheduler;
            } catch (error) {
                attempts++;
                console.error(`❌ Init attempt ${attempts} failed:`, error.message);
                if (attempts >= this.maxInitAttempts) throw error;
                await new Promise(r => setTimeout(r, 2000 * attempts)); // Exponential backoff
            }
        }
    }

    async terminate() {
        if (this.scheduler) {
            await this.scheduler.terminate();
            this.scheduler = null;
            this.initializationPromise = null;
        }
    }
}

export const ocrManager = new OCRSchedulerManager();

export const sessionManager = new SessionManager();

export const resetSession = async (userId) => {
    await sessionManager.createSession(userId);
};

// ===========================
// HELPER: FORWARD TO ADMIN
// ===========================
async function forwardToAdmin(bot, ctx, session, photo, status) {
    const username = session.username || "Unknown";
    const firstName = ctx.from.first_name || '';
    const lastName = ctx.from.last_name || '';
    const fullName = escapeHtml((firstName + (lastName ? ' ' + lastName : '')).trim());
    const telegramUsername = ctx.from.username ? escapeHtml(ctx.from.username) : 'none';
    const escapedUsername = escapeHtml(username);

    const caption =
        `📸 <b>New Request</b>\n\n` +
        `👤 ${fullName}\n` +
        `🆔 ${ctx.from.id}\n` +
        `👤 @${telegramUsername}\n` +
        `🐦 @${escapedUsername}\n` +
        `⏰ ${new Date().toLocaleString()}\n` +
        `ℹ️ <b>${status}</b>\n\n` +
        `<b>Verify?</b>`;

    try {
        await bot.telegram.sendPhoto(ADMIN_GROUP_ID, photo, {
            caption,
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([
                [Markup.button.url(`🔗 View @${username} on X`, `https://x.com/${username}`)],
                [Markup.button.callback('✅ Verify', `verify_${ctx.from.id}`), Markup.button.callback('❌ Decline', `decline_${ctx.from.id}`)]
            ])
        });

        await ctx.reply(
            `📨 <b>Received!</b>\n\n` +
            `ℹ️ Status: ${status}\n` +
            `⏳ Admin checking it now.\n` +
            `We'll ping you soon!\n\n` +
            `📊 Check /status later`,
            { parse_mode: "HTML" }
        );

    } catch (error) {
        logger.error("Error forwarding to admin:", error);
        await ctx.reply("❌ Error. Contact support.");
    }
}

export function setupVerificationHandlers(bot) {
    bot.action(/^verify_(\d+)$/, async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("⚠️ Admin only");

        const targetId = parseInt(ctx.match[1]);
        const session = await sessionManager.getSession(targetId);
        const username = session?.username || "Unknown";

        try {
            await db.addUser(targetId, "Verified User", username);

            await bot.telegram.sendMessage(
                targetId,
                `✅ <b>Verified!</b>\n\n` +
                `🐦 @${escapeHtml(username)}\n` +
                `⏰ ${new Date().toLocaleString()}\n\n` +
                `🎉 You're in!\n\n` +
                `Admin will send you profiles soon. ` +
                `Follow 'em to grow! 🚀`,
                { parse_mode: "HTML" }
            );

            await ctx.answerCbQuery("✅ Verified");
            await ctx.editMessageCaption(
                ctx.callbackQuery.message.caption + `\n\n✅ <b>VERIFIED</b>`,
                { parse_mode: "HTML", ...Markup.inlineKeyboard([]) }
            );

            await sessionManager.deleteSession(targetId);

        } catch (error) {
            logger.error("Error verifying user:", error);
            ctx.answerCbQuery("❌ Error verifying user");
        }
    });

    bot.action(/^decline_(\d+)$/, async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("⚠️ Admin only");

        const targetId = parseInt(ctx.match[1]);

        try {
            await bot.telegram.sendMessage(
                targetId,
                `❌ <b>Verification Rejected</b>\n\n` +
                `Didn't pass check.\n\n` +
                `<b>Why?</b>\n` +
                `• Screenshot didn't show "Following"\n` +
                `• Username mismatch\n` +
                `• Blurry/Edited\n` +
                `• You didn't follow @${escapeHtml(OWNER_X)}\n\n` +
                `Type /start to try again.`,
                { parse_mode: "HTML" }
            );

            await ctx.answerCbQuery("❌ Rejected");
            await ctx.editMessageCaption(
                ctx.callbackQuery.message.caption + `\n\n❌ <b>REJECTED</b>`,
                { parse_mode: "HTML", ...Markup.inlineKeyboard([]) }
            );

            await sessionManager.deleteSession(targetId);

        } catch (error) {
            logger.error("Error rejecting user:", error);
            ctx.answerCbQuery("❌ Error rejecting user");
        }
    });

    bot.start(async (ctx) => {
        const userId = ctx.from.id;

        if (userId === ADMIN_ID) {
            return ctx.reply(
                `👑 <b>Welcome Boss!</b>\n\n` +
                `You are the admin. You have full access.\n` +
                `Type /admin for the dashboard.`,
                { parse_mode: "HTML" }
            );
        }

        const existingUser = await db.getUser(userId);
        if (existingUser?.verified) {
            return ctx.reply(
                `✅ <b>Already verified!</b>\n\n` +
                `📋 You:\n` +
                `🐦 @${escapeHtml(existingUser.x_username)}\n` +
                `⏰ Since: ${new Date(existingUser.timestamp).toLocaleDateString()}\n` +
                `📨 Received: ${existingUser.profiles_received || 0}\n\n` +
                `Sit tight, profiles coming soon!`,
                { parse_mode: "HTML" }
            );
        }

        await resetSession(userId);

        const welcomeMsg =
            `👋 <b>Welcome to GROWOURX!</b>\n\n` +
            `Get verified, get followers. Simple.\n\n` +
            `<b>📝 HOW TO GET IN:</b>\n` +
            `1️⃣ Follow @${escapeHtml(OWNER_X)}\n\n` +
            `2️⃣ Send your X username\n\n` +
            `3️⃣ Send screenshot(CROPPED AS NEEDED)\n\n` +
            `4️⃣ Wait for approval\n\n` +
            `5️⃣ GROW YOUR ACCOUNT\n\n` +
            `<b>Ready?</b> Send your X username RN`;

        await ctx.reply(welcomeMsg, { parse_mode: "HTML" });
    });

    bot.action("i_have_followed", async (ctx) => {
        const userId = ctx.from.id;
        const session = await sessionManager.getSession(userId);
        if (!session || !session.username) {
            return ctx.reply("⚠️ Session expired. /start again.");
        }

        await sessionManager.updateSession(userId, { step: "screenshot", username: session.username });
        await ctx.replyWithPhoto(
            { source: "assets/example_screenshot.png" },
            {
                caption:
                    `📸 <b>Bet. Send the screenshot asap.</b>\n\n` +
                    `Show you follow @${escapeHtml(OWNER_X)}.\n\n` +
                    `Make sure "Following" is visible.\n\n` +
                    `See the EXAMPLE above for the required SCREENSHOT.`,
                parse_mode: "HTML"
            }
        );
        await ctx.answerCbQuery();
    });

    bot.command("cancel", async (ctx) => {
        await resetSession(ctx.from.id);
        await ctx.reply("🔄 Cancelled. Type /start to restart.");
    });

    // ===========================
    // MESSAGE HANDLERS for verification
    // ===========================
    bot.on("message", async (ctx, next) => {
        // Skip if not private chat or if unrelated command
        if (ctx.chat.type !== "private") return next();
        if (ctx.message.text && ctx.message.text.startsWith("/")) return next();

        const userId = ctx.from.id;
        const session = await sessionManager.getSession(userId);

        // If no session or unrelated, pass to next handler (which might be null, but safe in Telegraf)
        if (!session) return next();

        // STEP 1: GET X USERNAME
        if (session.step === "username" && ctx.message.text) {
            let username = ctx.message.text.trim().replace(/^@/, "");

            if (username.length < 1 || username.length > 15) {
                return ctx.reply("❌ Bad username. 1-15 chars.");
            }

            if (!/^[a-zA-Z0-9_]+$/.test(username)) {
                return ctx.reply("❌ Letters, numbers, underscores only.");
            }

            await sessionManager.updateSession(userId, { username, step: "follow_check" });

            await ctx.reply(
                `✅ <b>Saved: @${escapeHtml(username)}</b>\n\n` +
                `Follow @${escapeHtml(OWNER_X)} to join.\n\n` +
                `👇 Click when done.`,
                {
                    parse_mode: "HTML",
                    ...Markup.inlineKeyboard([
                        [Markup.button.url(`Follow @${OWNER_X}`, `https://x.com/${OWNER_X}`)],
                        [Markup.button.callback('✅ I Have Followed', 'i_have_followed')]
                    ])
                }
            );
            return;
        }

        // STEP 2: GET SCREENSHOT
        if (session.step === "screenshot" && ctx.message.photo) {
            const username = session.username || "Unknown";

            const firstName = ctx.from.first_name || '';
            const lastName = ctx.from.last_name || '';
            const fullName = escapeHtml((firstName + (lastName ? ' ' + lastName : '')).trim());
            const telegramUsername = ctx.from.username ? escapeHtml(ctx.from.username) : 'none';
            const escapedUsername = escapeHtml(username);

            const photo = ctx.message.photo[ctx.message.photo.length - 1];

            const firstPhoto = ctx.message.photo[0];
            if (firstPhoto.mime_type && !firstPhoto.mime_type.startsWith('image/')) {
                return ctx.reply("❌ Invalid file type. Send an image.");
            }

            // Security: Check file size (Telegram limit is 10MB, we want less, e.g. 5MB)
            if (photo.file_size > 5 * 1024 * 1024) {
                return ctx.reply("❌ Image too large. Send under 5MB.");
            }

            const fileLink = await bot.telegram.getFileLink(photo.file_id);

            await ctx.reply("🔍 Checking... one sec.");

            try {
                // Preprocess: resize, normalize, convert to optimal format
                const imageResponse = await fetch(fileLink.href);
                const imageArrayBuffer = await imageResponse.arrayBuffer();
                const imageBuffer = Buffer.from(imageArrayBuffer);

                // Security: Validate metadata BEFORE processing
                const metadata = await sharp(imageBuffer).metadata();

                // 1. ALLOWED FORMATS ONLY
                // Reject GIFs (even if renamed), SVGs, TIFFs, etc.
                const allowedFormats = ['jpeg', 'png', 'jpg', 'webp'];
                if (!allowedFormats.includes(metadata.format)) {
                    return ctx.reply("❌ Invalid format. Send a JPG or PNG screenshot.");
                }

                // 2. DIMENSION CHECK (DoS Prevention)
                // Reject incredibly large dimensions that zip bombs or Tesseract chokes on
                if (metadata.width > 5000 || metadata.height > 5000) {
                    return ctx.reply("❌ Image dimensions too large.");
                }

                const processedBuffer = await sharp(imageBuffer)
                    .resize(800, 1200, { fit: 'inside', withoutEnlargement: true })
                    .normalize() // Improve contrast
                    .jpeg({ quality: 85 })
                    .toBuffer();

                // Temp file for Tesseract
                const tempPath = path.join(os.tmpdir(), `ocr_${userId}_${Date.now()}.jpg`);
                await fs.writeFile(tempPath, processedBuffer);

                // Extend session during long OCR operation to prevent cleanup race condition
                await sessionManager.updateSession(userId, { lastActivity: Date.now() + 10 * 60 * 1000 }); // +10 mins

                // Use OCR with Timeout
                const scheduler = await ocrManager.getScheduler();

                const ocrJob = scheduler.addJob('recognize', tempPath);
                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('OCR timeout after 30s')), 30000)
                );

                const ret = await Promise.race([ocrJob, timeoutPromise]);

                // Reset session activity to now
                await sessionManager.updateSession(userId, { lastActivity: Date.now() });

                // Robust Cleanup
                try {
                    await fs.unlink(tempPath);
                } catch (e) {
                    // Retry once after delay if locked
                    setTimeout(() => fs.unlink(tempPath).catch(() => { }), 1000);
                }

                // Get dimensions from Sharp metadata for validation
                const processedMetadata = await sharp(processedBuffer).metadata();
                const validation = validateProfileLayout(ret.data, processedMetadata.width, processedMetadata.height);
                const confidence = ret.data.confidence;

                // Check if we found the owner's username anywhere in the text as a safety check
                const fullText = normalizeText(ret.data.text);
                const hasOwner = fullText.includes(OWNER_X.toLowerCase());

                if (validation.isValid && validation.followState === "following" && hasOwner) {
                    // AUTO-VERIFY
                    await db.addUser(userId, fullName, session.username);

                    await ctx.reply(
                        `✅ <b>Verified!</b>\n\n` +
                        `🐦 @${escapeHtml(session.username)}\n` +
                        `⏰ ${new Date().toLocaleString()}\n\n` +
                        `🎉 You're in!\n\n` +
                        `Admin will send you profiles soon. ` +
                        `Follow 'em to grow! 🚀`,
                        { parse_mode: "HTML" }
                    );

                    // Notify Admin of Auto-Verify
                    await bot.telegram.sendMessage(
                        ADMIN_GROUP_ID,
                        `🤖 <b>Auto-Verified User</b>\n` +
                        `👤 ${fullName} (@${telegramUsername})\n` +
                        `🐦 X: @${escapeHtml(session.username)}\n` +
                        `📊 Confidence: ${Math.round(confidence)}%\n` +
                        `✅ Layout Valid & Following`,
                        { parse_mode: "HTML" }
                    );

                    await sessionManager.deleteSession(userId);

                } else {
                    // MANUAL REVIEW NEEDED
                    await sessionManager.updateSession(userId, { step: "done" });
                    let reason = validation.reason;
                    if (validation.followState === "not_following") reason = "Detected 'Follow' button (Not Following)";
                    if (!hasOwner) reason += " | Owner username not found";

                    await ctx.reply(
                        `⏳ <b>Verification Pending</b>\n\n` +
                        `Admin is reviewing your screenshot.\n` +
                        `Sit tight!`,
                        { parse_mode: "HTML" }
                    );

                    await bot.telegram.sendPhoto(ADMIN_GROUP_ID, photo.file_id, {
                        caption:
                            `⚠️ <b>Manual Review Needed</b>\n\n` +
                            `👤 ${fullName} (@${telegramUsername})\n` +
                            `🐦 X: @${escapeHtml(session.username)}\n` +
                            `📊 Confidence: ${Math.round(confidence)}%\n` +
                            `❓ Reason: ${reason}\n` +
                            `🔍 Follow State: ${validation.followState}\n\n` +
                            `Verify this user?`,
                        parse_mode: "HTML",
                        ...Markup.inlineKeyboard([
                            [Markup.button.callback('✅ Verify', `verify_${userId}`), Markup.button.callback('❌ Reject', `decline_${userId}`)]
                        ])
                    });
                }

            } catch (error) {
                logger.error("OCR Error:", error);
                await sessionManager.updateSession(userId, { step: "done" });
                await ctx.reply("⚠️ Error checking image. Admin will review manually.");
                // Forward to admin on error too
                await bot.telegram.sendPhoto(ADMIN_GROUP_ID, photo.file_id, {
                    caption: `🚨 <b>OCR Error - Manual Review</b>\nUser: @${escapeHtml(session.username)}\nError: ${error.message}`,
                    parse_mode: "HTML",
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('✅ Verify', `verify_${userId}`), Markup.button.callback('❌ Reject', `decline_${userId}`)]
                    ])
                });
            }
            return;
        }

        // HANDLE INVALID INPUTS FOR SESSION
        if (session.step === "username" && ctx.chat.type === "private") {
            // Only reply if we are sure it was meant for us (handled by session check roughly)
            // But we need to be careful not to spam if the user sends something else.
            await ctx.reply("❌ Send text only.");
        } else if (session.step === "screenshot" && ctx.chat.type === "private") {
            await ctx.reply("❌ Send a photo.");
        } else if (session.step === "done" && ctx.chat.type === "private") {
            await ctx.reply(
                "⏳ Pending admin review.\n\n" +
                "Sit tight."
            );
        }

        return next();
    });

    // ADMIN GROUP REPLY HANDLER for Verification (YES/NO)
    bot.on("message", async (ctx, next) => {
        if (ctx.chat.id === ADMIN_GROUP_ID && ctx.message.reply_to_message && ctx.message.text) {
            const reply = ctx.message.text.toLowerCase().trim();

            // Only handle yes/no for verification. Other replies might be for other things or chat.
            // We'll check if the replied message looks like a verification request
            const caption = ctx.message.reply_to_message.caption || "";
            if (!caption.includes("Manual Review Needed") && !caption.includes("New Verification Request")) {
                return next();
            }

            if (ctx.from.id !== ADMIN_ID) return next();

            if (reply !== "yes" && reply !== "no") {
                // If it matches our caption but isn't yes/no, maybe we shouldn't interfere?
                // But the original logic replied "Please reply with yes or no".
                return ctx.reply("⚠️ Please reply with 'yes' or 'no' only.");
            }

            const idMatch = caption.match(/🆔 (\d+)/);
            const usernameMatch = caption.match(/🐦 @?([^\n]+)/);
            const nameMatch = caption.match(/👤 ([^\n]+)/);

            if (!idMatch) {
                return ctx.reply("⚠️ Could not extract user ID from message.");
            }

            const targetId = parseInt(idMatch[1]);
            const xUsername = usernameMatch ? usernameMatch[1].trim() : "Unknown";
            const telegramName = nameMatch ? nameMatch[1].trim() : "Unknown";

            try {
                if (reply === "yes") {
                    await db.addUser(targetId, telegramName, xUsername);

                    await bot.telegram.sendMessage(
                        targetId,
                        `✅ <b>Congratulations! You've been verified!</b>\n\n` +
                        `🐦 X Username: @${escapeHtml(xUsername)}\n` +
                        `⏰ Verified at: ${new Date().toLocaleString()}\n\n` +
                        `🎉 You're now part of our growth network!\n\n` +
                        `Our admin will periodically send you verified profiles to follow. ` +
                        `Follow them to grow your X presence organically! 🚀`,
                        { parse_mode: "HTML" }
                    );

                    await ctx.reply(`✅ Verified user: @${escapeHtml(xUsername)} (ID: ${targetId})`, { parse_mode: "HTML" });
                    await sessionManager.deleteSession(targetId);
                } else {
                    await bot.telegram.sendMessage(
                        targetId,
                        `❌ <b>Verification Rejected</b>\n\n` +
                        `Your verification was not approved.\n\n` +
                        `<b>Possible reasons:</b>\n` +
                        `• Screenshot doesn't show follow confirmation\n` +
                        `• Username doesn't match screenshot\n` +
                        `• Screenshot is unclear or edited\n` +
                        `• You haven't followed @${escapeHtml(OWNER_X)} yet\n\n` +
                        `Please type /start to try again with a valid screenshot.`,
                        { parse_mode: "HTML" }
                    );

                    await ctx.reply(`❌ Rejected user: @${escapeHtml(xUsername)} (ID: ${targetId})`, { parse_mode: "HTML" });
                    await sessionManager.deleteSession(targetId);
                }
            } catch (error) {
                logger.error("Error processing verification:", error);
                ctx.reply("⚠️ Error processing verification. User may have blocked the bot.");
            }
            return;
        }
        return next();
    });
}
