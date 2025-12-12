import { Markup } from "telegraf";
import pLimit from "p-limit";
import { db, Session } from "./database.js";
import { escapeHtml, escapeRegex, logger } from "./utils.js";
import { sessionManager, resetSession } from "./verificationHandler.js";
import { sendProfilesToUser } from "./profileHandler.js";
import {
    ADMIN_ID,
    OWNER_X,
    BATCH_DELAY
} from "./config.js";
import { JobQueue } from "./JobQueue.js";

// ===========================
// BACKGROUND JOB PROCESSING
// ===========================
const jobQueue = new JobQueue();

async function processDistributionJob(jobId, bot) {
    try {
        const job = await jobQueue.get(jobId);
        if (!job) return;

        await jobQueue.update(jobId, { status: 'running' });
        logger.info(`Starting distribution job ${jobId}`);

        const users = await db.getVerifiedUsers();
        let progress = { sent: 0, failed: 0, skipped: 0, total: users.length };

        for (const user of users) {
            try {
                const result = await sendProfilesToUser(bot, user, job.data.profileCount);
                if (result.success) progress.sent++;
                else if (result.reason === 'no_profiles') progress.skipped++;
                else progress.failed++;
            } catch (e) {
                progress.failed++;
            }

            // Update progress every 10 users to avoid db thrashing
            if ((progress.sent + progress.failed + progress.skipped) % 10 === 0) {
                await jobQueue.update(jobId, { progress });
            }

            // Slight delay to prevent flooding
            await new Promise(r => setTimeout(r, BATCH_DELAY));
        }

        await jobQueue.update(jobId, { status: 'completed', progress, completedAt: new Date() });
        logger.info(`Distribution job ${jobId} completed`);

        // Notify admin
        try {
            await bot.telegram.sendMessage(
                job.admin_id,
                `✅ <b>Distribution Job Complete!</b>\n\n` +
                `🆔 Job: ${jobId}\n` +
                `📨 Sent: ${progress.sent}\n` +
                `⏭️ Skipped: ${progress.skipped}\n` +
                `❌ Failed: ${progress.failed}`,
                { parse_mode: "HTML" }
            );
        } catch (e) {
            logger.error("Failed to notify admin of job completion", e);
        }
    } catch (error) {
        logger.error(`Job ${jobId} failed:`, error);
        await jobQueue.update(jobId, { status: 'failed', error: error.message });
    }
}

export function setupAdminHandlers(bot) {
    // ===========================
    // ADMIN DASHBOARD
    // ===========================
    bot.command("admin", async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;
        await showAdminDashboard(ctx);
    });

    async function showAdminDashboard(ctx, isEdit = false) {
        const stats = await db.getStats();
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
        const stats = await db.getStats();
        const users = await db.getVerifiedUsers();

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

        try {
            const users = await db.getVerifiedUsers();
            const jobId = await jobQueue.add({
                type: 'distribute',
                adminId: ctx.from.id,
                profileCount: count,
                status: 'queued'
            });

            await ctx.editMessageText(
                `Working... Job ID: ${jobId}\n` +
                `Sending ${count} profiles to ${users.length} users.`,
                {
                    parse_mode: "HTML",
                    ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'admin_back')]])
                }
            );

            // Trigger background processing
            processDistributionJob(jobId, bot).catch(err => {
                logger.error(`Job ${jobId} failed completely:`, err);
            });

        } catch (error) {
            logger.error("Failed to queue job:", error);
            await ctx.answerCbQuery("❌ Error starting job");
        }
    });

    bot.action("admin_broadcast", async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;

        await resetSession(ADMIN_ID);
        const session = await sessionManager.getSession(ADMIN_ID);
        if (session) await sessionManager.updateSession(ADMIN_ID, { step: "broadcast_msg" });

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

        const users = (await db.getVerifiedUsers()).slice(0, 5); // Show top 5 recent for now

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
        const user = await db.getUser(targetId);

        if (user) {
            if (user.is_banned) {
                await db.unbanUser(targetId);
                await ctx.answerCbQuery(`✅ Unbanned @${user.x_username}`);
            } else {
                await db.banUser(targetId);
                await ctx.answerCbQuery(`🚫 Banned @${user.x_username}`);
            }

            // Go back to users menu
            const users = (await db.getVerifiedUsers()).slice(0, 5);
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

    bot.command("adminstats", async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;

        const stats = await db.getStats();
        const users = await db.getVerifiedUsers();

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
        // Limit profile count to reasonable bounds (1-10)
        const profileCount = Math.min(Math.max(parseInt(args[1]) || 3, 1), 10);

        const users = await db.getVerifiedUsers();
        if (users.length < 2) {
            return ctx.reply("❌ Need at least 2 verified users to distribute.");
        }

        try {
            const jobId = await jobQueue.add({
                type: 'distribute',
                adminId: ctx.from.id,
                profileCount,
                status: 'queued'
            });

            await ctx.reply(
                `📥 <b>Job Queued!</b>\n\n` +
                `🆔 Job ID: <code>${jobId}</code>\n` +
                `📦 Profiles: ${profileCount}\n` +
                `👥 Targets: ${users.length}\n\n` +
                `Processing in background...`,
                { parse_mode: "HTML" }
            );

            // Trigger background processing (fire and forget from request perspective)
            processDistributionJob(jobId, bot).catch(err => {
                logger.error(`Job ${jobId} failed completely:`, err);
            });

        } catch (error) {
            logger.error("Failed to queue job:", error);
            ctx.reply("❌ Error queuing job.");
        }
    });

    bot.command("job_status", async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;
        const jobId = ctx.message.text.split(" ")[1];
        if (!jobId) return ctx.reply("Usage: /job_status [jobId]");

        const job = await jobQueue.get(jobId);
        if (!job) return ctx.reply("❌ Job not found.");

        const p = job.progress || { sent: 0, failed: 0, skipped: 0 };
        await ctx.reply(
            `📊 <b>Job Status</b>\n\n` +
            `🆔 ID: <code>${job._id}</code>\n` +
            `ℹ️ Status: <b>${job.status.toUpperCase()}</b>\n` +
            `📨 Sent: ${p.sent}\n` +
            `⏭️ Skipped: ${p.skipped}\n` +
            `❌ Failed: ${p.failed}`,
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

        const users = await db.getVerifiedUsers();
        const targetUser = users.find(
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

        // Preview
        await ctx.reply(
            `📢 <b>Broadcast Preview</b>\n\n${escapeHtml(message)}\n\n` +
            `<i>Ready to send?</i>`,
            {
                parse_mode: "HTML",
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('✅ Send Now', 'confirm_broadcast'), Markup.button.callback('❌ Cancel', 'cancel_broadcast')]
                ])
            }
        );

        await sessionManager.createSession(ADMIN_ID, {
            step: "broadcast_confirm",
            message: message
        });
    });

    bot.action("cancel_broadcast", async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;

        await sessionManager.deleteSession(ADMIN_ID);
        await ctx.editMessageText("❌ Broadcast cancelled.");
    });

    bot.action("confirm_broadcast", async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;

        const session = await sessionManager.getSession(ADMIN_ID);
        if (!session || session.step !== "broadcast_confirm") {
            return ctx.answerCbQuery("❌ Session expired. Start over.");
        }

        const message = session.message;
        await sessionManager.deleteSession(ADMIN_ID);

        // Send with progress bar
        const users = await db.getVerifiedUsers();
        let sent = 0, failed = 0;

        const editThrottle = pLimit(1); // Only 1 edit at a time
        let lastEdit = 0;

        // Initial status update
        await ctx.editMessageText(`📤 Sending to ${users.length} users...`);

        for (const user of users) {
            try {
                await bot.telegram.sendMessage(
                    user.telegram_id,
                    `📢 <b>Update from @${escapeHtml(OWNER_X)}:</b>\n\n${escapeHtml(message)}`,
                    { parse_mode: "HTML" }
                );
                sent++;
            } catch (e) {
                failed++;
            }

            // Update progress every 20, throttled to 1s
            if ((sent + failed) % 20 === 0 && Date.now() - lastEdit > 1000) {
                await editThrottle(async () => {
                    try {
                        await ctx.editMessageText(`📤 ${sent}/${users.length} sent...`);
                        lastEdit = Date.now();
                    } catch (e) {
                        // Ignore "message is not modified"
                    }
                });
            }

            await new Promise(r => setTimeout(r, 35));
        }

        try {
            await ctx.editMessageText(
                `✅ <b>Broadcast Complete!</b>\n\n` +
                `📨 Sent: ${sent}\n` +
                `❌ Failed: ${failed}`,
                { parse_mode: "HTML" }
            );
        } catch (e) {
            // Fallback if edit fails
            await ctx.reply(`✅ Job Done.\nSent: ${sent}, Failed: ${failed}`);
        }
    });

    bot.command("reset_matches", async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;

        const args = ctx.message.text.split(" ");

        if (args[1]) {
            const username = args[1].replace("@", "").toLowerCase();
            const users = await db.getVerifiedUsers();
            const user = users.find(u => u.x_username.toLowerCase() === username);

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

        const users = await db.getVerifiedUsers();

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

        const dbSession = await Session.findOne({ "data.username": new RegExp(`^${escapeRegex(username)}$`, 'i') });
        if (dbSession) {
            foundId = dbSession.user_id;
        }

        if (foundId) {
            await db.addUser(foundId, "Manually Verified", username);
            await bot.telegram.sendMessage(foundId, `✅ <b>Admin verified you!</b>`, { parse_mode: "HTML" });
            await ctx.reply(`✅ Verified @${username}`);
            await sessionManager.deleteSession(foundId);
        } else {
            ctx.reply("❌ User not found in pending sessions.");
        }
    });

    bot.command("ban", async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;
        const username = ctx.message.text.split(" ")[1]?.replace("@", "");
        if (!username) return ctx.reply("Usage: /ban @username");

        const users = await db.getVerifiedUsers();
        const user = users.find(u => u.x_username.toLowerCase() === username.toLowerCase());
        if (user) {
            await db.banUser(user.telegram_id);
            await ctx.reply(`🚫 Banned @${username}`);
        } else {
            ctx.reply("❌ User not found.");
        }
    });

    // ===========================
    // MESSAGE HANDLER FOR BROADCAST
    // ===========================
    bot.on("message", async (ctx, next) => {
        if (ctx.from.id !== ADMIN_ID) return next();

        // Check if we are in broadcast mode
        const adminSession = await sessionManager.getSession(ADMIN_ID);
        if (adminSession?.step === "broadcast_msg") {
            const message = ctx.message.text;
            if (!message) return ctx.reply("Send text fam.");

            const users = await db.getVerifiedUsers();
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

            await sessionManager.deleteSession(ADMIN_ID);
            return; // Stop here, handled.
        }

        // If not handled, pass to next
        return next();
    });
}
