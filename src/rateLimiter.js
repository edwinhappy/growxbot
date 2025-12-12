import { RateLimit } from './database.js';
import { ADMIN_ID, RATE_LIMIT_WINDOW, MAX_REQUESTS } from './config.js';
import mongoose from 'mongoose';

export async function checkRateLimit(userId, bypassAdmin = false) {
    if (bypassAdmin && userId === ADMIN_ID) return true; // Bypass for admin

    // If DB not connected, fail open (allow request)
    if (mongoose.connection.readyState !== 1) {
        console.warn("⚠️  DB not connected, skipping rate limit");
        return true;
    }

    const now = new Date();
    // Try to increment usage for current valid window
    const result = await RateLimit.findOneAndUpdate(
        {
            user_id: userId,
            reset_time: { $gt: now }
        },
        { $inc: { count: 1 } },
        { new: true }
    );

    if (result) {
        return result.count <= MAX_REQUESTS;
    }

    // New or expired rate limit: create new window
    await RateLimit.updateOne(
        { user_id: userId },
        {
            count: 1,
            reset_time: new Date(now.getTime() + RATE_LIMIT_WINDOW)
        },
        { upsert: true }
    );

    return true;
}
