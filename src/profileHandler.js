import pLimit from 'p-limit';
import { Markup } from "telegraf";
import { db, User, Match } from "./database.js";
import { escapeHtml, logger } from "./utils.js";
import mongoose from "mongoose";
import {
    ADMIN_ID,
    OWNER_X,
    MAX_SKIPS_PER_DAY,
    MAX_WARNINGS
} from "./config.js";

// ===========================
// HELPER: SEND PROFILES TO USER
// ===========================

export async function sendProfilesToUser(bot, targetUser, profileCount) {
    try {
        const unmatchedUsers = await db.getUnmatchedUsers(targetUser.telegram_id, profileCount);

        if (unmatchedUsers.length === 0) {
            return { success: false, reason: 'no_profiles', count: 0 };
        }

        await bot.telegram.sendMessage(
            targetUser.telegram_id,
            `🎯 <b>New Profiles!</b>\n\n` +
            `Got ${unmatchedUsers.length} verified peeps for you. ` +
            `Follow 'em to grow! 🚀`,
            { parse_mode: "HTML" }
        );

        // 1. Send messages concurrently (limit 5)
        const limit = pLimit(5);
        const sentProfiles = [];

        const sendPromises = unmatchedUsers.map(profile =>
            limit(async () => {
                try {
                    await sendSingleProfile(bot, targetUser, profile);
                    sentProfiles.push(profile);
                } catch (profileError) {
                    logger.error(`Failed to send profile ${profile.telegram_id}:`, profileError);
                }
            })
        );

        await Promise.all(sendPromises);

        if (sentProfiles.length === 0) {
            return { success: false, reason: 'send_failed', count: 0 };
        }

        // 2. Then update DB atomically
        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            const matchDocs = [];
            const operations = [];

            for (const profile of sentProfiles) {
                matchDocs.push({
                    user_id: targetUser.telegram_id,
                    matched_with: profile.telegram_id
                });

                operations.push(
                    User.updateOne(
                        { telegram_id: targetUser.telegram_id },
                        { $inc: { profiles_received: 1 } },
                        { session }
                    ),
                    User.updateOne(
                        { telegram_id: profile.telegram_id },
                        { $inc: { profiles_sent: 1 } },
                        { session }
                    )
                );
            }

            if (matchDocs.length > 0) {
                await Match.insertMany(matchDocs, { session, ordered: false });
                await Promise.all(operations);
            }

            await session.commitTransaction();
            return { success: true, count: sentProfiles.length };

        } catch (dbError) {
            await session.abortTransaction();
            logger.error("DB update failed, messages already sent:", dbError);
            // In a real production system, you might want to retry DB updates here or log for manual reconciliation
            // But separating prevents the "sent but DB locked" causing duplicated sends later if we didn't update history
            // Wait, if DB fails here, users received profiles but we didn't record it.
            // This is "at least once" delivery which is safer for growth than "at most once".
            // They might get them again, but that's better than crashing.
            return { success: false, reason: 'db_error', error: dbError.message, count: sentProfiles.length };
        } finally {
            await session.endSession();
        }

    } catch (error) {
        logger.error("Critical error in sendProfilesToUser:", error);
        return { success: false, reason: 'error', error: error.message, count: 0 };
    }
}

async function sendSingleProfile(bot, targetUser, profile) {
    const profilePicUrl = `https://unavatar.io/twitter/${profile.x_username}`;
    const timestamp = Date.now();
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.url('🔗 View Profile', `https://x.com/${profile.x_username}`)],
        [
            Markup.button.callback('✅ I Followed', `followed_${profile.telegram_id}_${timestamp}`),
            Markup.button.callback('⏭️ Skip', `skip_${profile.telegram_id}_${timestamp}`)
        ]
    ]);

    try {
        await bot.telegram.sendPhoto(targetUser.telegram_id, profilePicUrl, {
            caption: `👤 <b>${escapeHtml(profile.telegram_name)}</b>\n🐦 @${escapeHtml(profile.x_username)}`,
            parse_mode: "HTML",
            ...keyboard
        });
    } catch (photoError) {
        // Fallback to text
        await bot.telegram.sendMessage(
            targetUser.telegram_id,
            `👤 <b>${escapeHtml(profile.telegram_name)}</b>\n🐦 @${escapeHtml(profile.x_username)}`,
            { parse_mode: "HTML", ...keyboard }
        );
    }
}

export function setupProfileHandlers(bot) {
    bot.command("status", async (ctx) => {
        const user = await db.getUser(ctx.from.id);
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
        const user = await db.getUser(ctx.from.id);
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
        const user = await db.getUser(ctx.from.id);
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
    async function showUserDashboard(ctx, isEdit = false) {
        const user = await db.getUser(ctx.from.id);
        const isAdmin = ctx.from.id === ADMIN_ID;

        if ((!user?.verified || user?.is_banned) && !isAdmin) {
            return ctx.reply("❌ Not verified or banned. Contact admin.");
        }

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

    bot.command("dashboard", async (ctx) => {
        await showUserDashboard(ctx);
    });

    bot.action("dashboard_main", async (ctx) => {
        await showUserDashboard(ctx, true);
    });

    bot.action("dashboard_profile", async (ctx) => {
        const user = await db.getUser(ctx.from.id);
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
        const user = await db.getUser(ctx.from.id);
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
}
