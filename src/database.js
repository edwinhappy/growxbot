import mongoose from 'mongoose';
import { MONGO_URI, ADMIN_ID, SKIP_RESET_HOURS } from './config.js';

// ===========================
// SCHEMAS
// ===========================

// User Schema with enhanced security and indexes
const userSchema = new mongoose.Schema({
    telegram_id: { type: Number, required: true, unique: true, index: true },
    telegram_name: {
        type: String,
        trim: true,
        set: v => v?.replace(/[<>$]/g, '').substring(0, 100) // Security: strip dangerous chars
    },
    x_username: {
        type: String,
        required: true,
        index: true,
        match: /^[a-zA-Z0-9_]{1,15}$/
    },
    verified: { type: Boolean, default: false, index: true },
    is_banned: { type: Boolean, default: false, index: true },
    timestamp: { type: Date, default: Date.now, index: true },
    last_active: { type: Date, default: Date.now, index: true },
    profiles_received: { type: Number, default: 0 },
    profiles_sent: { type: Number, default: 0 },
    profiles_followed: { type: Number, default: 0 },
    verified_follows: [{ type: Number, index: true }], // List of Telegram IDs
    mutual_follows: [{ type: Number, index: true }],   // List of Telegram IDs
    skips_count: { type: Number, default: 0 },
    warnings_count: { type: Number, default: 0 },
    last_skip_reset: { type: Date, default: Date.now }
});

// Auto-cleanup for matches after 90 days
const matchSchema = new mongoose.Schema({
    user_id: { type: Number, required: true, index: true },
    matched_with: { type: Number, required: true, index: true },
    timestamp: { type: Date, default: Date.now, index: { expires: '90d' } }
});
matchSchema.index({ user_id: 1, matched_with: 1 }, { unique: true });

// Persistent Sessions with 15m expiry
const sessionSchema = new mongoose.Schema({
    user_id: { type: Number, required: true, unique: true, index: true },
    data: { type: mongoose.Schema.Types.Mixed, required: true },
    last_activity: { type: Date, default: Date.now, index: { expires: '15m' } }
});

// Rate Limit Schema (Used by utils.js)
const rateLimitSchema = new mongoose.Schema({
    user_id: { type: Number, required: true }, // Not unique globally anymore
    key: { type: String, index: true },
    count: { type: Number, default: 0 },
    reset_time: { type: Date, required: true }
});
rateLimitSchema.index({ reset_time: 1 }, { expireAfterSeconds: 60 });
rateLimitSchema.index({ user_id: 1, key: 1 }, { unique: true, sparse: true });

// Job Queue Schema for background tasks
const jobSchema = new mongoose.Schema({
    type: { type: String, required: true, index: true },
    admin_id: { type: Number, required: true },
    data: { type: mongoose.Schema.Types.Mixed, required: true },
    status: {
        type: String,
        enum: ['queued', 'running', 'completed', 'failed'],
        default: 'queued',
        index: true
    },
    progress: { type: mongoose.Schema.Types.Mixed, default: {} },
    created_at: { type: Date, default: Date.now },
    completed_at: { type: Date }
});

const User = mongoose.model('User', userSchema);
const Match = mongoose.model('Match', matchSchema);
const Session = mongoose.model('Session', sessionSchema);
const RateLimit = mongoose.model('RateLimit', rateLimitSchema);
const Job = mongoose.model('Job', jobSchema);

// ===========================
// DATABASE SERVICE
// ===========================

import Redis from 'ioredis';
// ... previous imports ...

export class Database {
    constructor() {
        this.redis = null;
    }

    async load() {
        if (!MONGO_URI) throw new Error('MONGO_URI missing in config');

        try {
            await mongoose.connect(MONGO_URI);
            console.log("✅ Connected to MongoDB");

            // Optional Redis connection
            try {
                // Initialize with specific options and error handling to prevent crashes
                this.redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
                    maxRetriesPerRequest: 3,
                    lazyConnect: true, // Don't crash on startup if missing, wait for use
                    retryStrategy: (times) => {
                        if (times > 3) return null; // Stop retrying after 3 attempts
                        return Math.min(times * 50, 2000);
                    },
                });

                // Attach error listener BEFORE connecting to catch early errors
                this.redis.on('error', (err) => {
                    console.warn("⚠️  Redis error (cache disabled):", err.message);
                    // We don't nullify this.redis here for 'error' events usually, 
                    // as ioredis handles reconnection, but for this specific "optional" requirement:
                    // If it's a connection refused, we might want to just stop using it.
                    // However, the user request specifically asked to set `this.redis = null` on error.
                    // Doing so might break future attempts if ioredis was trying to reconnect.
                    // But adhering to user request for graceful degradation:
                    this.redis.disconnect(); // Ensure it stops trying
                    this.redis = null;
                });

                this.redis.on('connect', () => console.log("✅ Connected to Redis"));

                // Trigger connection
                await this.redis.connect().catch(() => { });

            } catch (e) {
                console.warn("⚠️  Redis initialization failed, using DB-only mode");
                this.redis = null;
            }

        } catch (error) {
            console.error("❌ Connection Error:", error);
            process.exit(1);
        }
    }

    // USER OPERATIONS
    async getUser(telegramId) {
        return User.findOne({ telegram_id: telegramId }).lean();
    }

    async getVerifiedUsers() {
        // Cache Layer
        if (this.redis) {
            try {
                const cacheKey = 'verified_users';
                const cached = await this.redis.get(cacheKey);
                if (cached) return JSON.parse(cached);
            } catch (e) {
                console.error("Redis get error:", e);
            }
        }

        const users = await User.find({
            verified: true,
            is_banned: false,
            telegram_id: { $ne: ADMIN_ID }
        }).lean();

        if (this.redis) {
            try {
                await this.redis.setex('verified_users', 30, JSON.stringify(users)); // 30s TTL
            } catch (e) {
                console.error("Redis set error:", e);
            }
        }

        return users;
    }

    async addUser(telegramId, telegramName, xUsername) {
        return User.findOneAndUpdate(
            { telegram_id: telegramId },
            {
                telegram_name: telegramName?.trim() || 'Unknown',
                x_username: xUsername.toLowerCase().trim(),
                verified: true,
                timestamp: new Date(),
                last_active: new Date()
            },
            { upsert: true, new: true }
        );
    }

    async removeUser(telegramId) {
        await Promise.all([
            User.deleteOne({ telegram_id: telegramId }),
            Match.deleteMany({ $or: [{ user_id: telegramId }, { matched_with: telegramId }] }),
            Session.deleteOne({ user_id: telegramId }),
            RateLimit.deleteOne({ user_id: telegramId })
        ]);
    }

    // MATCHING LOGIC
    async getUnmatchedUsers(userId, limit = 10) {
        // 1. Get Set of excluded IDs
        const matches = await Match.find({
            $or: [
                { user_id: userId },
                { matched_with: userId }
            ]
        }).select('user_id matched_with').lean();

        const excludedIds = [userId, ADMIN_ID];
        matches.forEach(m => {
            excludedIds.push(m.user_id);
            excludedIds.push(m.matched_with);
        });

        // 2. Use Aggregation with $sample for efficient random selection
        const candidates = await User.aggregate([
            {
                $match: {
                    verified: true,
                    is_banned: false,
                    telegram_id: { $nin: excludedIds }
                }
            },
            { $sample: { size: Math.min(limit * 2, 100) } },
            { $limit: limit }
        ]);

        return candidates;
    }

    // STATS & UTILS
    async getStats() {
        const oneDayAgo = new Date(Date.now() - (SKIP_RESET_HOURS * 60 * 60 * 1000));
        const oneWeekAgo = new Date(Date.now() - (7 * 24 * 60 * 60 * 1000));

        const [totalUsers, activeToday, activeWeek, totalMatches] = await Promise.all([
            User.countDocuments({ verified: true }),
            User.countDocuments({ last_active: { $gte: oneDayAgo } }),
            User.countDocuments({ last_active: { $gte: oneWeekAgo } }),
            Match.countDocuments({})
        ]);

        return { totalUsers, activeToday, activeWeek, totalMatches };
    }

    async updateLastActive(telegramId) {
        await User.updateOne({ telegram_id: telegramId }, { last_active: new Date() });
    }

    async incrementProfilesReceived(telegramId) {
        await User.updateOne({ telegram_id: telegramId }, { $inc: { profiles_received: 1 } });
    }

    async incrementProfilesSent(telegramId) {
        await User.updateOne({ telegram_id: telegramId }, { $inc: { profiles_sent: 1 } });
    }

    async incrementProfilesFollowed(telegramId) {
        await User.updateOne({ telegram_id: telegramId }, { $inc: { profiles_followed: 1 } });
    }

    async incrementSkips(telegramId) {
        // 1. Try to reset if > 24 hours have passed since last_skip_reset
        const resetResult = await User.findOneAndUpdate(
            {
                telegram_id: telegramId,
                last_skip_reset: { $lt: new Date(Date.now() - SKIP_RESET_HOURS * 60 * 60 * 1000) }
            },
            {
                $set: { skips_count: 1, last_skip_reset: new Date() }
            },
            { new: true }
        );

        if (resetResult) return 1; // It was reset, so count is now 1

        // 2. If no reset was needed (still within 24h window), just increment
        const updated = await User.findOneAndUpdate(
            { telegram_id: telegramId },
            { $inc: { skips_count: 1 } },
            { new: true }
        );

        return updated?.skips_count || 0;
    }

    async addWarning(telegramId) {
        const res = await User.findOneAndUpdate(
            { telegram_id: telegramId },
            { $inc: { warnings_count: 1 } },
            { new: true }
        );
        return res ? res.warnings_count : 0;
    }

    async banUser(telegramId) {
        await User.updateOne({ telegram_id: telegramId }, { is_banned: true });
    }

    async unbanUser(telegramId) {
        await User.updateOne({ telegram_id: telegramId }, { is_banned: false });
    }

    async addVerifiedFollow(userId, followedId) {
        await User.updateOne(
            { telegram_id: userId },
            { $addToSet: { verified_follows: followedId } }
        );
    }

    async hasUserFollowed(userId, targetId) {
        const user = await User.findOne({ telegram_id: userId }, { verified_follows: 1 }).lean();
        return user?.verified_follows?.includes(targetId) || false;
    }

    async recordMutualFollow(userId1, userId2) {
        await Promise.all([
            User.updateOne({ telegram_id: userId1 }, { $addToSet: { mutual_follows: userId2 } }),
            User.updateOne({ telegram_id: userId2 }, { $addToSet: { mutual_follows: userId1 } })
        ]);
    }

    async hasMatched(userId, targetId) {
        // Check if a match record exists between these two users
        const exists = await Match.exists({
            $or: [
                { user_id: userId, matched_with: targetId },
                { user_id: targetId, matched_with: userId }
            ]
        });
        return !!exists;
    }

    async recordMatch(userId, targetId) {
        try {
            // Ensure unique match record
            await Match.findOneAndUpdate(
                { user_id: userId, matched_with: targetId },
                { user_id: userId, matched_with: targetId },
                { upsert: true }
            );
        } catch (e) {
            console.error("Error recording match:", e);
        }
    }

    async resetMatchHistory(userId = null) {
        if (userId) {
            await Match.deleteMany({
                $or: [{ user_id: userId }, { matched_with: userId }]
            });
        } else {
            await Match.deleteMany({});
        }
    }

    // IDEMPOTENCY LOCK (Using RateLimit schema)
    async acquireIdempotencyLock(key, ttlSeconds = 60) {
        try {
            // Attempt to create a unique record. If it exists, it fails.
            // We use RateLimit schema which has 'key' and 'reset_time'.
            await RateLimit.create({
                user_id: 0, // Placeholder/dummy for generic locks
                key: key,
                reset_time: new Date(Date.now() + ttlSeconds * 1000)
            });
            return true; // Lock acquired
        } catch (error) {
            if (error.code === 11000) {
                // Duplicate key means lock held
                return false;
            }
            // Cleanup expired if any (optional, purely for robustness if index fail)
            // But TTL index handles cleanup mostly.
            throw error;
        }
    }
}

export const db = new Database();
export { Session, RateLimit, User, Match, Job };
