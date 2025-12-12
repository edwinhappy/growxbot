import { Markup } from "telegraf";
import { db, Match } from "./database.js";
import { escapeHtml, logger } from "./utils.js";
import { sessionManager } from "./verificationHandler.js";
import {
    ADMIN_ID,
    ADMIN_GROUP_ID,
    OWNER_X,
    MAX_SKIPS_PER_DAY,
    MAX_WARNINGS
} from "./config.js";

export function setupInteractionHandlers(bot) {
    // Middleware to validate user state
    async function validateUserCallback(ctx, next) {
        try {
            const user = await db.getUser(ctx.from.id);

            if (!user?.verified) {
                try {
                    return await ctx.answerCbQuery("❌ Not verified. Complete /start first.", true);
                } catch (e) {
                    logger.error("Callback answer failed:", e);
                    return;
                }
            }

            if (user.is_banned) {
                try {
                    return await ctx.answerCbQuery("🚫 You are banned.", true);
                } catch (e) {
                    logger.error("Callback answer failed:", e);
                    return;
                }
            }

            ctx.state.user = user; // Pass validated user to handlers
            return next();
        } catch (error) {
            logger.error("Error in validateUserCallback:", error);
            try {
                return await ctx.answerCbQuery("❌ Error validating user.", true);
            } catch (e) {
                logger.error("Callback answer failed:", e);
                return;
            }
        }
    }

    // ===========================
    // CALLBACK HANDLERS
    // ===========================
    bot.action(/^followed_(\d+)_(\d+)$/, validateUserCallback, async (ctx) => {
        // Answer immediately to prevent timeout
        await ctx.answerCbQuery('✅ Sent! Waiting for them to confirm.').catch(() => { });

        const profileUserId = parseInt(ctx.match[1]);
        const follower = ctx.state.user; // Validated user

        try {
            const followed = await db.getUser(profileUserId);
            // Timestamp validation (1 hour)
            const timestamp = parseInt(ctx.match[2]);
            if (Date.now() - timestamp > 60 * 60 * 1000) {
                // Too late to really error out the UI, but we stop logic
                return;
            }

            if (!followed) {
                // Already answered, so maybe send ephemeral or just stop
                return;
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
                                Markup.button.callback('✅ Yup', `confirm_follow_${follower.telegram_id}_${Date.now()}`),
                                Markup.button.callback('❌ Nope', `deny_follow_${follower.telegram_id}_${Date.now()}`)
                            ],
                            [Markup.button.url(`🔗 Check @${follower.x_username}`, `https://x.com/${follower.x_username}`)]
                        ])
                    }
                );

                // Update message to show pending state
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

                // Update the original message to reflect the failure
                await ctx.editMessageCaption(
                    ctx.callbackQuery.message.caption + '\n\n❌ <b>Failed to notify user</b>',
                    {
                        parse_mode: "HTML",
                        ...Markup.inlineKeyboard([
                            [Markup.button.url(`🔗 View Profile`, `https://x.com/${followed.x_username}`)]
                        ])
                    }
                );
            }
        } catch (error) {
            logger.error('Error handling followed action:', error);
        }
    });

    // Helper for mutual follows
    async function handleMutualFollow(userId1, userId2) {
        await db.recordMutualFollow(userId1, userId2);

        const [user1, user2] = await Promise.all([
            db.getUser(userId1),
            db.getUser(userId2)
        ]);

        // Notify both parties
        await Promise.all([
            bot.telegram.sendMessage(
                userId1,
                `🤝 <b>Mutual Follow Confirmed!</b>\n\nYou and @${escapeHtml(user2.x_username)} now follow each other.`,
                { parse_mode: "HTML" }
            ),
            bot.telegram.sendMessage(
                userId2,
                `🤝 <b>Mutual Follow Confirmed!</b>\n\nYou and @${escapeHtml(user1.x_username)} now follow each other.`,
                { parse_mode: "HTML" }
            )
        ]);
    }

    bot.action(/^confirm_follow_(\d+)_(\d+)$/, validateUserCallback, async (ctx) => {
        await ctx.answerCbQuery('✅ Confirmed!').catch(() => { });

        const followerId = parseInt(ctx.match[1]);
        // Timestamp validation (48 hours)
        const timestamp = parseInt(ctx.match[2]);
        if (Date.now() - timestamp > 48 * 60 * 60 * 1000) return;

        const userId = ctx.from.id; // The person being followed (validated)
        const me = ctx.state.user;
        const lockKey = `confirm:${userId}:${followerId}`;

        if (!(await db.acquireIdempotencyLock(lockKey, 3600))) return;

        try {
            const follower = await db.getUser(followerId);
            if (!follower) return;

            await db.incrementProfilesFollowed(followerId);
            await db.addVerifiedFollow(followerId, userId); // Record verified follow

            // Check for mutual follow
            const isMutual = await db.hasUserFollowed(userId, followerId);

            if (isMutual) {
                await handleMutualFollow(followerId, userId);
                await ctx.editMessageText(
                    `✅ <b>You confirmed @${escapeHtml(follower.x_username)}.</b>\n` +
                    `🤝 <b>It's a Mutual!</b>`,
                    { parse_mode: "HTML" }
                );
            } else {
                // Notify the follower (Standard one-way)
                try {
                    await bot.telegram.sendMessage(
                        followerId,
                        `🎉 <b>Confirmed!</b>\n\n` +
                        `@${escapeHtml(me.x_username)} confirmed you followed.\n` +
                        `Stats updated! 📈`,
                        { parse_mode: "HTML" }
                    );
                } catch (e) { }

                await ctx.editMessageText(
                    `✅ <b>You confirmed @${escapeHtml(follower.x_username)}.</b>\nStats updated.`,
                    { parse_mode: "HTML" }
                );
            }

        } catch (error) {
            logger.error('Error confirming follow:', error);
        }
    });

    bot.action(/^deny_follow_(\d+)_(\d+)$/, validateUserCallback, async (ctx) => {
        const followerId = parseInt(ctx.match[1]);
        // Timestamp validation (48 hours)
        const timestamp = parseInt(ctx.match[2]);
        if (Date.now() - timestamp > 48 * 60 * 60 * 1000) {
            return await ctx.answerCbQuery('❌ Request expired.', true); // Legit denial to click
        }

        // Immediate answer
        await ctx.answerCbQuery('❌ Marked as not followed.').catch(() => { });

        const lockKey = `deny:${ctx.from.id}:${followerId}`;

        if (!(await db.acquireIdempotencyLock(lockKey, 3600))) return;

        try {
            const follower = await db.getUser(followerId);
            if (!follower) return;

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
                try {
                    await bot.telegram.sendMessage(ADMIN_GROUP_ID, `🚨 <b>User Hit Max Warnings</b>\nUser: @${follower.x_username} (ID: ${followerId})`, { parse_mode: "HTML" });
                } catch (e) { }
            }

            await ctx.editMessageText(
                `❌ <b>You reported @${escapeHtml(follower.x_username)} didn't follow.</b>\n` +
                `They got a warning.`,
                { parse_mode: "HTML" }
            );

        } catch (error) {
            logger.error('Error denying follow:', error);
        }
    });

    bot.action(/^skip_(\d+)_(\d+)$/, validateUserCallback, async (ctx) => {
        // Timestamp validation (1 hour)
        const timestamp = parseInt(ctx.match[2]);
        if (Date.now() - timestamp > 60 * 60 * 1000) {
            return await ctx.answerCbQuery('❌ Request expired.', true);
        }

        // Immediate answer
        await ctx.answerCbQuery('⏭️ Skipped!').catch(() => { });

        try {
            const skips = await db.incrementSkips(ctx.from.id);

            if (skips > MAX_SKIPS_PER_DAY) {
                // If limit reached, we want to maybe alert. redundant answer ok because we catch error on first one
                try {
                    // Since we already answered, we can't alert with answerCbQuery easily if we want to change text.
                    // But we can just send a message or edit.
                    // Actually, if we already answered "Skipped", showing an error now is weird.
                    // But the request was to answer immediately.
                    // We will keep the skip, but maybe notify user in chat if limit reached?
                    // Or just silently fail to skip more?
                    // Let's just edit message to say limit reached.
                    return await ctx.editMessageCaption(
                        ctx.callbackQuery.message.caption + '\n\n⚠️ <b>Daily Skip Limit Hit!</b>',
                        { parse_mode: "HTML", ...Markup.inlineKeyboard([]) }
                    );
                } catch (e) { return; }
            }

            await ctx.editMessageCaption(
                ctx.callbackQuery.message.caption + '\n\n⏭️ <i>Skipped</i>',
                {
                    parse_mode: "HTML",
                    ...Markup.inlineKeyboard([])
                }
            );
        } catch (error) {
            logger.error('Error handling skip action:', error);
        }
    });
}
