import { Markup } from "telegraf";
import { createWorker } from "tesseract.js";
import path from "path";
import { fileURLToPath } from "url";
import { db } from "./database.js";
import { escapeHtml, logger } from "./utils.js";
import { validateProfileLayout } from "./ocr.js";
import {
    ADMIN_ID,
    ADMIN_GROUP_ID,
    OWNER_X,
    MAX_SKIPS_PER_DAY,
    MAX_WARNINGS,
    MAX_VERIFICATION_ATTEMPTS
} from "./config.js";

// ===========================
// TESSERACT WORKER (SINGLETON)
// ===========================
let tesseractWorker = null;

async function getWorker() {
    if (tesseractWorker) return tesseractWorker;

    console.log("⚙️ Initializing Tesseract Worker...");
    try {
        const __dirname = path.dirname(fileURLToPath(import.meta.url));
        // Resolve absolute path to the root directory where eng.traineddata is located
        const langPath = path.resolve(__dirname, "../");

        console.log(`📂 Tesseract Lang Path: ${langPath}`);

        tesseractWorker = await createWorker("eng", 1, {
            langPath: langPath,
            gzip: false, // CRITICAL: Tell Tesseract we have the uncompressed .traineddata file
            cachePath: path.join(__dirname, "../.tesseract_cache"),
            logger: m => {
                if (m.status === 'recognizing text') {
                    // console.log(`OCR Progress: ${Math.round(m.progress * 100)}%`);
                }
            }
        });
        console.log("✅ Tesseract Worker Ready!");
        return tesseractWorker;
    } catch (error) {
        console.error("❌ Failed to init Tesseract:", error);
        throw error;
    }
}

// ===========================
// SESSION MANAGEMENT
// ===========================
const userSessions = {};
const SESSION_TIMEOUT = 10 * 60 * 1000;

export const resetSession = (userId) => {
    userSessions[userId] = {
        step: "username",
        username: null,
        attempts: 0,
        startTime: Date.now()
    };
};

setInterval(() => {
    const now = Date.now();
    for (const [userId, session] of Object.entries(userSessions)) {
        if (now - session.startTime > SESSION_TIMEOUT) {
            delete userSessions[userId];
        }
    }
}, 5 * 60 * 1000);

// ===========================
// HELPER: SEND PROFILES TO USER
// ===========================
async function sendProfilesToUser(bot, targetUser, profileCount) {
    const unmatchedUsers = await db.getUnmatchedUsers(targetUser.telegram_id, profileCount);

    if (unmatchedUsers.length === 0) {
        return { success: false, reason: 'no_profiles', count: 0 };
    }

    try {
        await bot.telegram.sendMessage(
            targetUser.telegram_id,
            `🎯 <b>New Profiles!</b>\n\n` +
            `Got ${unmatchedUsers.length} verified peeps for you. ` +
            `Follow 'em to grow! 🚀`,
            { parse_mode: "HTML" }
        );

        for (const profile of unmatchedUsers) {
            try {
                const profilePicUrl = `https://unavatar.io/twitter/${profile.x_username}`;

                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.url(`🔗 View Profile`, `https://x.com/${profile.x_username}`)],
                    [
                        Markup.button.callback('✅ I Followed', `followed_${profile.telegram_id}`),
                        Markup.button.callback('⏭️ Skip', `skip_${profile.telegram_id}`)
                    ]
                ]);

                await bot.telegram.sendPhoto(
                    targetUser.telegram_id,
                    profilePicUrl,
                    {
                        caption:
                            `👤 <b>${escapeHtml(profile.telegram_name)}</b>\n` +
                            `🐦 @${escapeHtml(profile.x_username)}\n` +
                            `✅ Verified: ${new Date(profile.timestamp).toLocaleDateString()}\n` +
                            `📊 Shared: ${profile.profiles_sent || 0}x\n\n` +
                            `Drop a follow 👇`,
                        parse_mode: "HTML",
                        ...keyboard
                    }
                );
            } catch (photoError) {
                logger.log(`Could not fetch profile pic for @${profile.x_username}, using text fallback`);

                await bot.telegram.sendMessage(
                    targetUser.telegram_id,
                    `👤 <b>${escapeHtml(profile.telegram_name)}</b>\n` +
                    `🐦 @${escapeHtml(profile.x_username)}\n` +
                    `✅ Verified: ${new Date(profile.timestamp).toLocaleDateString()}\n` +
                    `📊 Shared: ${profile.profiles_sent || 0}x\n\n` +
                    `Drop a follow 👇`,
                    {
                        parse_mode: "HTML",
                        ...Markup.inlineKeyboard([
                            [Markup.button.url(`🔗 View Profile`, `https://x.com/${profile.x_username}`)],
                            [
                                Markup.button.callback('✅ Followed', `followed_${profile.telegram_id}`),
                                Markup.button.callback('⏭️ Skip', `skip_${profile.telegram_id}`)
                            ]
                        ])
                    }
                );
            }

            await db.recordMatch(targetUser.telegram_id, profile.telegram_id);
            await db.incrementProfilesReceived(targetUser.telegram_id);
            await db.incrementProfilesSent(profile.telegram_id);

            await new Promise(resolve => setTimeout(resolve, 150));
        }

        return { success: true, count: unmatchedUsers.length };
    } catch (error) {
        return { success: false, reason: 'error', error: error.message, count: 0 };
    }
}

export function setupHandlers(bot) {
    // ===========================
    // CALLBACK HANDLERS
    // ===========================
    bot.action(/^followed_(\d+)$/, async (ctx) => {
        const profileUserId = parseInt(ctx.match[1]);
        const userId = ctx.from.id;

        try {
            const follower = db.getUser(userId);
            const followed = db.getUser(profileUserId);

            if (!follower || !followed) {
                return ctx.answerCbQuery('❌ User gone or missing data');
            }

            // Ask the followed user for confirmation
            try {
                await bot.telegram.sendMessage(
                    profileUserId,
                    `🔔 <b>New Follower!</b>\n\n` +
                    `👤 <b>${escapeHtml(follower.telegram_name)}</b> says they followed you.\n` +
                    `🐦 @${escapeHtml(follower.x_username)}\n\n` +
                    `<b>Did they actually follow?</b>`,
                    {
                        parse_mode: "HTML",
                        ...Markup.inlineKeyboard([
                            [
                                Markup.button.callback('✅ Yup', `confirm_follow_${userId}`),
                                Markup.button.callback('❌ Nope', `deny_follow_${userId}`)
                            ],
                            [Markup.button.url(`🔗 Check @${follower.x_username}`, `https://x.com/${follower.x_username}`)]
                        ])
                    }
                );

                await ctx.answerCbQuery('✅ Sent! Waiting for them to confirm.');

                await ctx.editMessageCaption(
                    ctx.callbackQuery.message.caption + '\n\n⏳ <b>Waiting for confirmation...</b>',
                    {
                        parse_mode: "HTML",
                        ...Markup.inlineKeyboard([
                            [Markup.button.url(`🔗 View Profile`, `https://x.com/${followed.x_username}`)]
                        ])
                    }
                );
            } catch (dmError) {
                logger.error(`Failed to send confirmation request to user ${profileUserId}:`, dmError.message);
                await ctx.answerCbQuery('❌ Could not reach user (they might have blocked the bot)');
            }
        } catch (error) {
            logger.error('Error handling followed action:', error);
            await ctx.answerCbQuery('❌ Something broke');
        }
    });

    bot.action(/^confirm_follow_(\d+)$/, async (ctx) => {
        const followerId = parseInt(ctx.match[1]);
        const userId = ctx.from.id; // The person being followed

        try {
            const follower = db.getUser(followerId);
            const me = db.getUser(userId);

            if (!follower || !me) {
                return ctx.answerCbQuery('❌ User missing');
            }

            await db.incrementProfilesFollowed(followerId);
            await db.addVerifiedFollow(followerId, userId); // Record verified follow

            // Check for mutual follow
            const isMutual = db.hasUserFollowed(userId, followerId);
            if (isMutual) {
                await db.recordMutualFollow(followerId, userId);
            }

            // Notify the follower
            try {
                let msg = `🎉 <b>Confirmed!</b>\n\n` +
                    `@${escapeHtml(me.x_username)} confirmed you followed.\n` +
                    `Stats updated! 📈`;

                if (isMutual) {
                    msg += `\n\n🤝 <b>It's a Mutual!</b> You both follow each other.`;
                }

                await bot.telegram.sendMessage(followerId, msg, { parse_mode: "HTML" });
            } catch (e) { }

            await ctx.answerCbQuery('✅ Confirmed!');

            let replyMsg = `✅ <b>You confirmed @${escapeHtml(follower.x_username)}.</b>\nStats updated.`;
            if (isMutual) {
                replyMsg += `\n\n🤝 <b>It's a Mutual!</b>`;
            }

            await ctx.editMessageText(replyMsg, { parse_mode: "HTML" });

        } catch (error) {
            logger.error('Error confirming follow:', error);
            await ctx.answerCbQuery('❌ Error confirming follow');
        }
    });

    bot.action(/^deny_follow_(\d+)$/, async (ctx) => {
        const followerId = parseInt(ctx.match[1]);
        const userId = ctx.from.id;

        try {
            const follower = db.getUser(followerId);

            if (!follower) return ctx.answerCbQuery('❌ User gone');

            const warnings = await db.addWarning(followerId);

            // Notify the liar
            try {
                await bot.telegram.sendMessage(
                    followerId,
                    `⚠️ <b>Follow Not Found</b>\n\n` +
                    `User said you didn't follow.\n` +
                    `Please actually follow before clicking "I Followed".\n\n` +
                    `⚠️ Warning ${warnings}/${MAX_WARNINGS}`,
                    { parse_mode: "HTML" }
                );
            } catch (e) { }

            if (warnings >= MAX_WARNINGS) {
                // Auto-ban logic could go here, or just notify admin
                await bot.telegram.sendMessage(ADMIN_GROUP_ID, `🚨 <b>User Hit Max Warnings</b>\nUser: @${follower.x_username} (ID: ${followerId})`, { parse_mode: "HTML" });
            }

            await ctx.answerCbQuery('❌ Marked as not followed.');
            await ctx.editMessageText(
                `❌ <b>You reported @${escapeHtml(follower.x_username)} didn't follow.</b>\n` +
                `They got a warning.`,
                { parse_mode: "HTML" }
            );

        } catch (error) {
            logger.error('Error denying follow:', error);
            await ctx.answerCbQuery('❌ Error denying follow');
        }
    });

    bot.action(/^skip_(\d+)$/, async (ctx) => {
        const userId = ctx.from.id;
        try {
            const skips = await db.incrementSkips(userId);

            if (skips > MAX_SKIPS_PER_DAY) {
                return ctx.answerCbQuery(`⚠️ Daily skip limit hit! Just follow 'em.`);
            }

            await ctx.answerCbQuery('⏭️ Skipped!');

            await ctx.editMessageCaption(
                ctx.callbackQuery.message.caption + '\n\n⏭️ <i>Skipped</i>',
                {
                    parse_mode: "HTML",
                    ...Markup.inlineKeyboard([])
                }
            );
        } catch (error) {
            logger.error('Error handling skip action:', error);
            await ctx.answerCbQuery('⏭️ Skipped!');
        }
    });

    // ADMIN ACTIONS
    bot.action(/^verify_(\d+)$/, async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("⚠️ Admin only");

        const targetId = parseInt(ctx.match[1]);
        const session = userSessions[targetId];
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

            if (userSessions[targetId]) delete userSessions[targetId];

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

            if (userSessions[targetId]) delete userSessions[targetId];

        } catch (error) {
            logger.error("Error rejecting user:", error);
            ctx.answerCbQuery("❌ Error rejecting user");
        }
    });

    // ===========================
    // BOT COMMANDS
    // ===========================
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

        const existingUser = db.getUser(userId);
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

        resetSession(userId);

        const welcomeMsg =
            `👋 <b>Welcome to X Growth!</b>\n\n` +
            `Get verified, get followers. Simple.\n\n` +
            `<b>📝 Steps:</b>\n` +
            `1️⃣ Follow @${escapeHtml(OWNER_X)}\n` +
            `2️⃣ Send your X username\n` +
            `3️⃣ Send proof (screenshot)\n` +
            `4️⃣ Wait for approval\n` +
            `5️⃣ Profit 🚀\n\n` +
            `<b>Ready?</b> Send your X username (e.g., @yourhandle)`;

        await ctx.reply(welcomeMsg, { parse_mode: "HTML" });
    });

    bot.action("i_have_followed", async (ctx) => {
        const userId = ctx.from.id;
        if (!userSessions[userId] || !userSessions[userId].username) {
            return ctx.reply("⚠️ Session expired. /start again.");
        }

        userSessions[userId].step = "screenshot";
        await ctx.replyWithPhoto(
            { source: "assets/example_screenshot.png" },
            {
                caption:
                    `📸 <b>Bet. Send the screenshot.</b>\n\n` +
                    `Show you follow @${escapeHtml(OWNER_X)}.\n` +
                    `Make sure "Following" is visible.\n` +
                    `See the example above for the required layout.`,
                parse_mode: "HTML"
            }
        );
        await ctx.answerCbQuery();
    });

    bot.command("cancel", async (ctx) => {
        resetSession(ctx.from.id);
        await ctx.reply("🔄 Cancelled. Type /start to restart.");
    });

    bot.command("status", async (ctx) => {
        const user = db.getUser(ctx.from.id);
        const isAdmin = ctx.from.id === ADMIN_ID;

        if (!user?.verified && !isAdmin) {
            return ctx.reply(
                "❌ Not verified yet.\n\n" +
                "Type /start to join."
            );
        }

        if (isAdmin && !user) {
            return ctx.reply("👑 <b>Status: ADMIN</b>\n\nYou are the boss.", { parse_mode: "HTML" });
        }

        await db.updateLastActive(ctx.from.id);

        await ctx.reply(
            `✅ <b>Status: VERIFIED</b>\n\n` +
            `📋 <b>Profile:</b>\n` +
            `👤 Telegram: ${escapeHtml(user.telegram_name)}\n` +
            `🐦 X: @${escapeHtml(user.x_username)}\n` +
            `⏰ Since: ${new Date(user.timestamp).toLocaleDateString()}\n` +
            `🔗 Link: https://x.com/${escapeHtml(user.x_username)}\n\n` +
            `📊 <b>Activity:</b>\n` +
            `📨 Received: ${user.profiles_received || 0}\n` +
            `📤 Shared: ${user.profiles_sent || 0}x\n` +
            `✅ Followed: ${user.profiles_followed || 0}\n` +
            `🤝 Mutuals: ${user.mutual_follows?.length || 0}\n\n` +
            `Hang tight for more profiles!`,
            { parse_mode: "HTML" }
        );
    });

    bot.command("profile", async (ctx) => {
        const user = db.getUser(ctx.from.id);
        const isAdmin = ctx.from.id === ADMIN_ID;

        if (!user?.verified && !isAdmin) {
            return ctx.reply(
                "❌ Not verified yet.\n\n" +
                "Type /start to join."
            );
        }

        if (isAdmin && !user) {
            return ctx.reply("👑 <b>Profile: ADMIN</b>\n\nNo profile data needed.", { parse_mode: "HTML" });
        }

        await db.updateLastActive(ctx.from.id);

        await ctx.reply(
            `✅ <b>Verification Status: VERIFIED</b>\n\n` +
            `📋 <b>Your Profile:</b>\n` +
            `👤 Telegram: ${escapeHtml(user.telegram_name)}\n` +
            `🐦 X Username: @${escapeHtml(user.x_username)}\n` +
            `⏰ Verified: ${new Date(user.timestamp).toLocaleDateString()}\n` +
            `🔗 Profile: https://x.com/${escapeHtml(user.x_username)}\n\n` +
            `📊 <b>Network Activity:</b>\n` +
            `📨 Profiles received: ${user.profiles_received || 0}\n` +
            `📤 Your profile shared: ${user.profiles_sent || 0} times\n` +
            `✅ Profiles you followed: ${user.profiles_followed || 0}\n` +
            `🤝 Mutual connections: ${user.mutual_follows?.length || 0}\n\n` +
            `Wait for admin to send you profiles to follow!`,
            { parse_mode: "HTML" }
        );
    });

    bot.command("stats", async (ctx) => {
        const user = db.getUser(ctx.from.id);
        if (!user) return ctx.reply("❌ Not verified.");

        await ctx.reply(
            `📊 <b>Your Stats</b>\n\n` +
            `✅ Followed: ${user.profiles_followed || 0}\n` +
            `👥 Followed you: ${user.mutual_follows?.length || 0}\n` +
            `📨 Received: ${user.profiles_received || 0}\n` +
            `⚠️ Warnings: ${user.warnings_count || 0}/${MAX_WARNINGS}\n` +
            `⏭️ Skips today: ${user.skips_count || 0}/${MAX_SKIPS_PER_DAY}`,
            { parse_mode: "HTML" }
        );
    });

    bot.command("rules", async (ctx) => {
        await ctx.reply(
            `📘 <b>Rules</b>\n\n` +
            `1. Follow @${escapeHtml(OWNER_X)}\n` +
            `2. Follow who we send\n` +
            `3. Follow back\n` +
            `4. Don’t skip too much\n` +
            `5. Don’t unfollow\n` +
            `6. Be honest\n\n` +
            `<i>Break rules = Ban 💀</i>`,
            { parse_mode: "HTML" }
        );
    });

    bot.command("leave", async (ctx) => {
        await ctx.reply(
            `⚠️ <b>Leave?</b>\n\n` +
            `Sure? You'll lose everything and stop growing.`,
            {
                parse_mode: "HTML",
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('✅ Yes, Leave', 'confirm_leave'), Markup.button.callback('❌ Cancel', 'cancel_leave')]
                ])
            }
        );
    });

    bot.action("confirm_leave", async (ctx) => {
        try {
            await db.removeUser(ctx.from.id);
            await ctx.editMessageText("👋 You left. Type /start to come back.");
        } catch (error) {
            logger.error('Error confirming leave:', error);
            await ctx.answerCbQuery('❌ Error leaving network');
        }
    });

    bot.action("cancel_leave", async (ctx) => {
        try {
            await ctx.editMessageText("✅ Cancelled. You're staying.");
        } catch (error) {
            logger.error('Error cancelling leave:', error);
            await ctx.answerCbQuery('❌ Error cancelling leave');
        }
    });

    bot.command("help", async (ctx) => {
        const isAdmin = ctx.from.id === ADMIN_ID;

        let helpMsg =
            `🆘 <b>Help</b>\n\n` +
            `<b>Commands:</b>\n` +
            `/start - Join/Restart\n` +
            `/status - Check status\n` +
            `/profile - View profile\n` +
            `/stats - View stats\n` +
            `/rules - Read rules\n` +
            `/leave - Leave network\n` +
            `/cancel - Cancel action\n` +
            `/help - This message\n\n`;

        if (isAdmin) {
            helpMsg +=
                `<b>Admin:</b>\n` +
                `/admin - Dashboard\n` +
                `/adminstats - Stats\n` +
                `/distribute [n] - Send profiles\n` +
                `/send_to @user [n] - Send to one\n` +
                `/verify @user - Verify manual\n` +
                `/ban @user - Ban hammer\n` +
                `/broadcast - Send msg\n` +
                `/reset_matches - Reset history\n` +
                `/list_users - List all\n\n`;
        }

        helpMsg += `<b>Support?</b> DM @${escapeHtml(OWNER_X)}`;

        await ctx.reply(helpMsg, { parse_mode: "HTML" });
    });

    // ===========================
    // USER DASHBOARD
    // ===========================
    bot.command("dashboard", async (ctx) => {
        await showUserDashboard(ctx);
    });

    async function showUserDashboard(ctx, isEdit = false) {
        const user = db.getUser(ctx.from.id);
        const isAdmin = ctx.from.id === ADMIN_ID;

        if (!user?.verified && !isAdmin) return ctx.reply("❌ Not verified. /start to join.");

        const name = user ? escapeHtml(user.telegram_name) : "Boss";
        const msg = `🚀 <b>X Growth Dashboard</b>\n\n` +
            `Welcome, <b>${name}</b>!\n` +
            `What would you like to do?`;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('👤 My Profile', 'dashboard_profile'), Markup.button.callback('📊 My Stats', 'dashboard_stats')],
            [Markup.button.callback('📘 Rules', 'dashboard_rules'), Markup.button.callback('🆘 Help', 'dashboard_help')],
            [Markup.button.callback('🚪 Leave Network', 'leave_confirm_prompt')]
        ]);

        if (isEdit) {
            try {
                await ctx.editMessageText(msg, { parse_mode: "HTML", ...keyboard });
            } catch (e) { }
        } else {
            await ctx.reply(msg, { parse_mode: "HTML", ...keyboard });
        }
    }

    bot.action("dashboard_main", async (ctx) => {
        await showUserDashboard(ctx, true);
    });

    bot.action("dashboard_profile", async (ctx) => {
        const user = db.getUser(ctx.from.id);
        const msg = `📋 <b>Your Profile</b>\n\n` +
            `👤 Telegram: ${escapeHtml(user.telegram_name)}\n` +
            `🐦 X: @${escapeHtml(user.x_username)}\n` +
            `⏰ Verified: ${new Date(user.timestamp).toLocaleDateString()}\n` +
            `🔗 Link: https://x.com/${escapeHtml(user.x_username)}`;

        await ctx.editMessageText(msg, {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'dashboard_main')]])
        });
    });

    bot.action("dashboard_stats", async (ctx) => {
        const user = db.getUser(ctx.from.id);
        const msg = `📊 <b>Your Stats</b>\n\n` +
            `✅ Followed: ${user.profiles_followed || 0}\n` +
            `👥 Mutuals: ${user.mutual_follows?.length || 0}\n` +
            `📨 Received: ${user.profiles_received || 0}\n` +
            `⚠️ Warnings: ${user.warnings_count || 0}/${MAX_WARNINGS}\n` +
            `⏭️ Skips today: ${user.skips_count || 0}/${MAX_SKIPS_PER_DAY}`;

        await ctx.editMessageText(msg, {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'dashboard_main')]])
        });
    });

    bot.action("dashboard_rules", async (ctx) => {
        const msg = `📘 <b>Rules</b>\n\n` +
            `1. Follow @${escapeHtml(OWNER_X)}\n` +
            `2. Follow who we send\n` +
            `3. Follow back\n` +
            `4. Don’t skip too much\n` +
            `5. Don’t unfollow\n` +
            `6. Be honest\n\n` +
            `<i>Break rules = Ban 💀</i>`;

        await ctx.editMessageText(msg, {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'dashboard_main')]])
        });
    });

    bot.action("dashboard_help", async (ctx) => {
        const msg = `🆘 <b>Help</b>\n\n` +
            `Need support? DM @${escapeHtml(OWNER_X)}\n\n` +
            `<b>Commands:</b>\n` +
            `/dashboard - Open this menu\n` +
            `/start - Restart bot`;

        await ctx.editMessageText(msg, {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'dashboard_main')]])
        });
    });

    bot.action("leave_confirm_prompt", async (ctx) => {
        const msg = `⚠️ <b>Leave Network?</b>\n\n` +
            `Are you sure? You will stop receiving followers and lose your progress.`;

        await ctx.editMessageText(msg, {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✅ Yes, Leave', 'confirm_leave'), Markup.button.callback('❌ Cancel', 'dashboard_main')]
            ])
        });
    });

    bot.command("adminstats", async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;

        const stats = db.getStats();
        const users = db.getVerifiedUsers();

        const recentUsers = users
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
            .slice(0, 5)
            .map(u => `  • @${escapeHtml(u.x_username)} (${new Date(u.timestamp).toLocaleDateString()})`)
            .join('\n');

        const topReceivers = users
            .sort((a, b) => (b.profiles_received || 0) - (a.profiles_received || 0))
            .slice(0, 5)
            .map(u => `  • @${escapeHtml(u.x_username)}: ${u.profiles_received || 0} profiles`)
            .join('\n');

        await ctx.reply(
            `📊 <b>Admin Stats</b>\n\n` +
            `✅ Verified: ${stats.totalUsers}\n` +
            `🟢 Active Today: ${stats.activeToday}\n` +
            `📅 Active Week: ${stats.activeWeek}\n` +
            `🔗 Matches: ${stats.totalMatches}\n\n` +
            `<b>Newest:</b>\n${recentUsers || '  None'}\n\n` +
            `<b>Top Receivers:</b>\n${topReceivers || '  None'}`,
            { parse_mode: "HTML" }
        );
    });

    bot.command("distribute", async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;

        const args = ctx.message.text.split(" ");
        const profileCount = parseInt(args[1]) || 3;

        if (profileCount < 1 || profileCount > 10) {
            return ctx.reply("⚠️ 1-10 profiles only.\n\nUsage: <code>/distribute 3</code>", { parse_mode: "HTML" });
        }

        const users = db.getVerifiedUsers();

        if (users.length < 2) {
            return ctx.reply("❌ Need 2+ users.");
        }

        await ctx.reply(`📤 Sending ${profileCount} profiles to ${users.length} users...`);

        let sent = 0;
        let failed = 0;
        let skipped = 0;

        for (const user of users) {
            const result = await sendProfilesToUser(bot, user, profileCount);

            if (result.success) {
                sent++;
            } else if (result.reason === 'no_profiles') {
                logger.log(`⏭️  Skipping user ${user.telegram_id} - no unmatched profiles`);
                skipped++;
            } else {
                failed++;
                logger.error(`Failed to send to ${user.telegram_id}:`, result.error || result.reason);
            }

            await new Promise(resolve => setTimeout(resolve, 50));
        }

        await ctx.reply(
            `✅ <b>Done!</b>\n\n` +
            `📨 Sent: ${sent}\n` +
            `⏭️  Skipped: ${skipped}\n` +
            `❌ Failed: ${failed}`,
            { parse_mode: "HTML" }
        );
    });

    bot.command("send_to", async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;

        const args = ctx.message.text.split(" ");

        if (args.length < 2) {
            return ctx.reply(
                "⚠️ <b>Usage:</b>\n" +
                "<code>/send_to @username 5</code>\n" +
                "<code>/send_to @username</code> (default 3)",
                { parse_mode: "HTML" }
            );
        }

        const targetUsername = args[1].replace("@", "").toLowerCase();
        const profileCount = parseInt(args[2]) || 3;

        if (profileCount < 1 || profileCount > 10) {
            return ctx.reply("⚠️ 1-10 profiles only.");
        }

        const targetUser = db.getVerifiedUsers().find(
            u => u.x_username.toLowerCase() === targetUsername
        );

        if (!targetUser) {
            return ctx.reply(`❌ User @${escapeHtml(targetUsername)} not found.`, { parse_mode: "HTML" });
        }

        const result = await sendProfilesToUser(bot, targetUser, profileCount);

        if (result.success) {
            await ctx.reply(
                `✅ Sent ${result.count} profiles to @${escapeHtml(targetUsername)}!`,
                { parse_mode: "HTML" }
            );
        } else if (result.reason === 'no_profiles') {
            await ctx.reply(`⚠️ No profiles for @${escapeHtml(targetUsername)}.`, { parse_mode: "HTML" });
        } else {
            await ctx.reply(`❌ Error: ${escapeHtml(result.error || result.reason)}`, { parse_mode: "HTML" });
        }
    });

    bot.command("broadcast", async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;

        const message = ctx.message.text.replace("/broadcast", "").trim();

        if (!message) {
            return ctx.reply(
                "📢 <b>Broadcast</b>\n\n" +
                "Usage: <code>/broadcast Your message</code>",
                { parse_mode: "HTML" }
            );
        }

        const users = db.getVerifiedUsers();
        let sent = 0;
        let failed = 0;

        await ctx.reply(`📤 Sending to ${users.length} users...`);

        for (const user of users) {
            try {
                await bot.telegram.sendMessage(
                    user.telegram_id,
                    `📢 <b>Update from @${escapeHtml(OWNER_X)}:</b>\n\n${escapeHtml(message)}`,
                    { parse_mode: "HTML" }
                );
                sent++;
                await new Promise(resolve => setTimeout(resolve, 35));
            } catch (error) {
                failed++;
                logger.error(`Failed to send to ${user.telegram_id}:`, error.message);
            }
        }

        await ctx.reply(
            `✅ <b>Done!</b>\n\n` +
            `📨 Sent: ${sent}\n` +
            `❌ Failed: ${failed}`
        );
    });

    bot.command("reset_matches", async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;

        const args = ctx.message.text.split(" ");

        if (args[1]) {
            const username = args[1].replace("@", "").toLowerCase();
            const user = db.getVerifiedUsers().find(u => u.x_username.toLowerCase() === username);

            if (!user) {
                return ctx.reply(`❌ User @${escapeHtml(username)} not found.`, { parse_mode: "HTML" });
            }

            await db.resetMatchHistory(user.telegram_id);
            await ctx.reply(`✅ Matches reset for @${escapeHtml(username)}`, { parse_mode: "HTML" });
        } else {
            await db.resetMatchHistory();
            await ctx.reply(`✅ All matches reset. Users can see old profiles again.`);
        }
    });

    bot.command("list_users", async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;

        const users = db.getVerifiedUsers();

        if (users.length === 0) {
            return ctx.reply("❌ No users yet.");
        }

        const userList = users
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
            .map((u, i) =>
                `${i + 1}. @${escapeHtml(u.x_username)} (ID: ${u.telegram_id})\n` +
                `   📨 Received: ${u.profiles_received || 0} | 📤 Sent: ${u.profiles_sent || 0}\n` +
                `   ⏰ ${new Date(u.timestamp).toLocaleDateString()}`
            )
            .join('\n\n');

        const chunks = [];
        let currentChunk = `📋 <b>Users (${users.length})</b>\n\n`;

        for (const line of userList.split('\n\n')) {
            if ((currentChunk + line).length > 4000) {
                chunks.push(currentChunk);
                currentChunk = line + '\n\n';
            } else {
                currentChunk += line + '\n\n';
            }
        }
        chunks.push(currentChunk);

        for (const chunk of chunks) {
            await ctx.reply(chunk, { parse_mode: "HTML" });
        }
    });

    bot.command("verify", async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;
        const username = ctx.message.text.split(" ")[1]?.replace("@", "");
        if (!username) return ctx.reply("Usage: /verify @username");

        let foundId = null;
        for (const [id, session] of Object.entries(userSessions)) {
            if (session.username?.toLowerCase() === username.toLowerCase()) {
                foundId = id;
                break;
            }
        }

        if (foundId) {
            await db.addUser(foundId, "Manually Verified", username);
            await bot.telegram.sendMessage(foundId, `✅ <b>Admin verified you!</b>`, { parse_mode: "HTML" });
            await ctx.reply(`✅ Verified @${username}`);
            delete userSessions[foundId];
        } else {
            ctx.reply("❌ User not found in pending sessions.");
        }
    });

    bot.command("ban", async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;
        const username = ctx.message.text.split(" ")[1]?.replace("@", "");
        if (!username) return ctx.reply("Usage: /ban @username");

        const user = db.getVerifiedUsers().find(u => u.x_username.toLowerCase() === username.toLowerCase());
        if (user) {
            await db.banUser(user.telegram_id);
            await ctx.reply(`🚫 Banned @${username}`);
        } else {
            ctx.reply("❌ User not found.");
        }
    });

    // ===========================
    // ADMIN DASHBOARD
    // ===========================
    bot.command("admin", async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;
        await showAdminDashboard(ctx);
    });

    async function showAdminDashboard(ctx, isEdit = false) {
        const stats = db.getStats();
        const msg = `👮‍♂️ <b>Admin Dashboard</b>\n\n` +
            `👥 Users: ${stats.totalUsers}\n` +
            `🟢 Active: ${stats.activeToday}\n` +
            `🔗 Matches: ${stats.totalMatches}\n\n` +
            `What's the move?`;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('📊 Detailed Stats', 'admin_stats'), Markup.button.callback('📤 Distribute', 'admin_distribute')],
            [Markup.button.callback('📢 Broadcast', 'admin_broadcast'), Markup.button.callback('👥 Manage Users', 'admin_users')],
            [Markup.button.callback('🔄 Refresh', 'admin_refresh')]
        ]);

        if (isEdit) {
            try {
                await ctx.editMessageText(msg, { parse_mode: "HTML", ...keyboard });
            } catch (error) {
                if (!error.description?.includes("message is not modified")) {
                    throw error;
                }
            }
        } else {
            await ctx.reply(msg, { parse_mode: "HTML", ...keyboard });
        }
    }

    bot.action("admin_back", async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;
        await showAdminDashboard(ctx, true);
    });

    bot.action("admin_refresh", async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;
        await showAdminDashboard(ctx, true);
        await ctx.answerCbQuery("🔄 Refreshed");
    });

    bot.action("admin_stats", async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;
        const stats = db.getStats();
        const users = db.getVerifiedUsers();

        const topReceivers = users
            .sort((a, b) => (b.profiles_received || 0) - (a.profiles_received || 0))
            .slice(0, 3)
            .map(u => `• @${escapeHtml(u.x_username)}: ${u.profiles_received}`)
            .join('\n');

        const msg = `📊 <b>Stats</b>\n\n` +
            `👥 Verified: ${stats.totalUsers}\n` +
            `🟢 Active Today: ${stats.activeToday}\n` +
            `📅 Active Week: ${stats.activeWeek}\n` +
            `🔗 Matches: ${stats.totalMatches}\n\n` +
            `<b>Top Receivers:</b>\n${topReceivers || 'None'}`;

        await ctx.editMessageText(msg, {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'admin_back')]])
        });
    });

    bot.action("admin_distribute", async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;

        const msg = `📤 <b>Distribute</b>\n\n` +
            `How many per user?`;

        await ctx.editMessageText(msg, {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([
                [Markup.button.callback('1 Profile', 'dist_1'), Markup.button.callback('3 Profiles', 'dist_3')],
                [Markup.button.callback('5 Profiles', 'dist_5'), Markup.button.callback('10 Profiles', 'dist_10')],
                [Markup.button.callback('🔙 Back', 'admin_back')]
            ])
        });
    });

    bot.action(/^dist_(\d+)$/, async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;
        const count = parseInt(ctx.match[1]);

        await ctx.editMessageText(`⏳ Sending ${count} profiles...`);

        // Reuse existing distribution logic
        // We need to mock the context or refactor the command. 
        // For simplicity, let's just call the logic directly.
        const users = db.getVerifiedUsers();
        let sent = 0;
        let skipped = 0;
        let failed = 0;

        for (const user of users) {
            const result = await sendProfilesToUser(bot, user, count);
            if (result.success) sent++;
            else if (result.reason === 'no_profiles') skipped++;
            else failed++;
            await new Promise(r => setTimeout(r, 50));
        }

        await ctx.editMessageText(
            `✅ <b>Done!</b>\n\n` +
            `📨 Sent: ${sent}\n` +
            `⏭️ Skipped: ${skipped}\n` +
            `❌ Failed: ${failed}`,
            {
                parse_mode: "HTML",
                ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'admin_back')]])
            }
        );
    });

    bot.action("admin_broadcast", async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;

        resetSession(ADMIN_ID);
        userSessions[ADMIN_ID].step = "broadcast_msg";

        await ctx.editMessageText(
            `📢 <b>Broadcast</b>\n\n` +
            `Send the message text.\n` +
            `Type /cancel to stop.`,
            {
                parse_mode: "HTML",
                ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'admin_back')]])
            }
        );
    });

    bot.action("admin_users", async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;

        const users = db.getVerifiedUsers().slice(0, 5); // Show top 5 recent for now

        const buttons = users.map(u => [
            Markup.button.url(`@${u.x_username}`, `https://x.com/${u.x_username}`),
            Markup.button.callback(u.is_banned ? '✅ Unban' : '🚫 Ban', `ban_toggle_${u.telegram_id}`)
        ]);

        buttons.push([Markup.button.callback('🔙 Back', 'admin_back')]);

        await ctx.editMessageText(
            `👥 <b>Manage Users</b>\nShowing recent 5 users:`,
            {
                parse_mode: "HTML",
                ...Markup.inlineKeyboard(buttons)
            }
        );
    });

    bot.action(/^ban_toggle_(\d+)$/, async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;
        const targetId = parseInt(ctx.match[1]);
        const user = db.getUser(targetId);

        if (user) {
            if (user.is_banned) {
                await db.unbanUser(targetId);
                await ctx.answerCbQuery(`✅ Unbanned @${user.x_username}`);
            } else {
                await db.banUser(targetId);
                await ctx.answerCbQuery(`🚫 Banned @${user.x_username}`);
            }
            // Refresh list
            // For simplicity, just go back to users menu
            // Or re-render. Let's re-trigger admin_users logic.
            // We can't easily re-call the handler function directly if it's anonymous.
            // So we'll just edit the message again.
            // Actually, let's just go back to users menu.
            const users = db.getVerifiedUsers().slice(0, 5);
            const buttons = users.map(u => [
                Markup.button.url(`@${u.x_username}`, `https://x.com/${u.x_username}`),
                Markup.button.callback(u.is_banned ? '✅ Unban' : '🚫 Ban', `ban_toggle_${u.telegram_id}`)
            ]);
            buttons.push([Markup.button.callback('🔙 Back', 'admin_back')]);

            await ctx.editMessageText(
                `👥 <b>Manage Users</b>\nShowing recent 5 users:`,
                {
                    parse_mode: "HTML",
                    ...Markup.inlineKeyboard(buttons)
                }
            );
        }
    });

    // ===========================
    // MESSAGE HANDLERS
    // ===========================

    // ===========================
    // MESSAGE HANDLERS
    // ===========================
    bot.on("message", async (ctx) => {
        const userId = ctx.from.id;

        // ADMIN BROADCAST HANDLER
        if (ctx.from.id === ADMIN_ID && userSessions[ADMIN_ID]?.step === "broadcast_msg") {
            const message = ctx.message.text;
            if (!message) return ctx.reply("Send text fam.");

            const users = db.getVerifiedUsers();
            let sent = 0;
            let failed = 0;

            await ctx.reply(`📤 Sending to ${users.length} users...`);

            for (const user of users) {
                try {
                    await bot.telegram.sendMessage(
                        user.telegram_id,
                        `📢 <b>Update from @${escapeHtml(OWNER_X)}:</b>\n\n${escapeHtml(message)}`,
                        { parse_mode: "HTML" }
                    );
                    sent++;
                    await new Promise(resolve => setTimeout(resolve, 35));
                } catch (error) {
                    failed++;
                }
            }

            await ctx.reply(
                `✅ Done!\n\n` +
                `📨 Sent: ${sent}\n` +
                `❌ Failed: ${failed}`
            );

            delete userSessions[ADMIN_ID];
            return;
        }

        // ADMIN REPLY HANDLER (In Admin Group)
        if (ctx.chat.id === ADMIN_GROUP_ID && ctx.message.reply_to_message) {
            if (ctx.from.id !== ADMIN_ID) return;

            const reply = ctx.message.text?.toLowerCase().trim();
            if (reply !== "yes" && reply !== "no") {
                return ctx.reply("⚠️ Please reply with 'yes' or 'no' only.");
            }

            const caption = ctx.message.reply_to_message.caption || "";
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
                }
            } catch (error) {
                logger.error("Error processing verification:", error);
                ctx.reply("⚠️ Error processing verification. User may have blocked the bot.");
            }

            return;
        }

        // USER FLOW HANDLER (DMs only)
        if (ctx.chat.type !== "private") return;

        if (!userSessions[userId]) {
            return ctx.reply("👋 Type /start to get verified!");
        }

        const session = userSessions[userId];

        // STEP 1: GET X USERNAME
        if (session.step === "username" && ctx.message.text) {
            let username = ctx.message.text.trim().replace(/^@/, "");

            if (username.length < 1 || username.length > 15) {
                return ctx.reply("❌ Bad username. 1-15 chars.");
            }

            if (!/^[a-zA-Z0-9_]+$/.test(username)) {
                return ctx.reply("❌ Letters, numbers, underscores only.");
            }

            session.username = username;
            session.step = "follow_check";

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

            const caption =
                `📸 <b>New Verification Request</b>\n\n` +
                `👤 Telegram: ${fullName}\n` +
                `🆔 Telegram ID: ${userId}\n` +
                `👤 TG Username: @${telegramUsername}\n` +
                `🐦 X Username: @${escapedUsername}\n` +
                `⏰ Submitted: ${new Date().toLocaleString()}\n\n` +
                `<b>Reply 'yes' or 'no' to this message to verify.</b>`;

            const photo = ctx.message.photo[ctx.message.photo.length - 1].file_id;
            const fileLink = await bot.telegram.getFileLink(photo);

            await ctx.reply("🔍 Checking... one sec.");

            try {
                // Use singleton worker
                const worker = await getWorker();
                const ret = await worker.recognize(fileLink.href);
                // Do NOT terminate the worker! We reuse it.
                // await worker.terminate();

                // Extract dimensions from hocr
                // Format: title='image "..." 0 0 W H'
                const hocr = ret.data.hocr;
                // Try to match 'bbox 0 0 W H' or 'image "..." 0 0 W H'
                let dimMatch = hocr.match(/bbox 0 0 (\d+) (\d+)/);
                if (!dimMatch) {
                    dimMatch = hocr.match(/title='image "[^"]*" 0 0 (\d+) (\d+)/);
                }

                let width = 1000; // Fallback
                let height = 2000; // Fallback
                if (dimMatch) {
                    width = parseInt(dimMatch[1]);
                    height = parseInt(dimMatch[2]);
                }

                const validation = validateProfileLayout(ret.data, width, height);
                const confidence = ret.data.confidence;

                // Check if we found the owner's username anywhere in the text as a safety check
                const fullText = ret.data.text.toLowerCase();
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

                    delete userSessions[userId];

                } else {
                    // MANUAL REVIEW NEEDED
                    session.step = "done";
                    let reason = validation.reason;
                    if (validation.followState === "not_following") reason = "Detected 'Follow' button (Not Following)";
                    if (!hasOwner) reason += " | Owner username not found";

                    await ctx.reply(
                        `⏳ <b>Verification Pending</b>\n\n` +
                        `Admin is reviewing your screenshot.\n` +
                        `Sit tight!`,
                        { parse_mode: "HTML" }
                    );

                    await bot.telegram.sendPhoto(ADMIN_GROUP_ID, photo, {
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
                session.step = "done";
                await ctx.reply("⚠️ Error checking image. Admin will review manually.");
                // Forward to admin on error too
                await bot.telegram.sendPhoto(ADMIN_GROUP_ID, photo, {
                    caption: `🚨 <b>OCR Error - Manual Review</b>\nUser: @${escapeHtml(session.username)}\nError: ${error.message}`,
                    parse_mode: "HTML",
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('✅ Verify', `verify_${userId}`), Markup.button.callback('❌ Reject', `decline_${userId}`)]
                    ])
                });
            }
            return;
        }

        // HANDLE INVALID INPUTS
        if (session.step === "username") {
            await ctx.reply("❌ Send text only.");
        } else if (session.step === "screenshot") {
            await ctx.reply("❌ Send a photo.");
        } else if (session.step === "done") {
            await ctx.reply(
                "⏳ Pending admin review.\n\n" +
                "Sit tight."
            );
        } else {
            await ctx.reply("❗ Type /start.");
        }
    });

    // ===========================
    // HELPER: FORWARD TO ADMIN
    // ===========================
    async function forwardToAdmin(ctx, session, photo, status) {
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

    // ===========================
    // ERROR HANDLING
    // ===========================
    bot.catch((err, ctx) => {
        logger.error("❌ Bot error:", err);
        try {
            ctx.reply("⚠️ Glitch. Try again.").catch(() => { });
        } catch (e) {
            logger.error("Could not send error message:", e.message);
        }
    });
}
