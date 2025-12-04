import mongoose from 'mongoose';
import { MONGO_URI, ADMIN_ID } from './config.js';

// Define User Schema
const userSchema = new mongoose.Schema({
    telegram_id: { type: Number, required: true, unique: true },
    telegram_name: String,
    x_username: String,
    verified: { type: Boolean, default: false },
    timestamp: { type: Date, default: Date.now },
    last_active: { type: Date, default: Date.now },
    profiles_received: { type: Number, default: 0 },
    profiles_sent: { type: Number, default: 0 },
    profiles_followed: { type: Number, default: 0 },
    verified_follows: { type: [Number], default: [] },
    mutual_follows: { type: [Number], default: [] },
    skips_count: { type: Number, default: 0 },
    warnings_count: { type: Number, default: 0 },
    is_banned: { type: Boolean, default: false },
    last_skip_reset: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// Define Match History Schema
const matchSchema = new mongoose.Schema({
    user_id: { type: Number, required: true },
    matched_with: { type: Number, required: true },
    timestamp: { type: Date, default: Date.now }
});
matchSchema.index({ user_id: 1, matched_with: 1 }, { unique: true });

const Match = mongoose.model('Match', matchSchema);

export class Database {
    constructor() {
        this.users = {};
    }

    async load() {
        if (!MONGO_URI) {
            console.error("❌ MONGO_URI is missing in .env! Exiting...");
            process.exit(1);
        }

        try {
            await mongoose.connect(MONGO_URI);
            console.log("✅ Connected to MongoDB");

            // Load all users into memory for sync access compatibility
            const allUsers = await User.find({});
            this.users = {};
            allUsers.forEach(u => {
                this.users[u.telegram_id] = u.toObject();
            });
            console.log(`✅ Loaded ${allUsers.length} users into memory.`);

        } catch (error) {
            console.error("❌ MongoDB Connection Error:", error);
            process.exit(1);
        }
    }

    async save() {
        // No-op for MongoDB
    }

    // ===========================
    // USER METHODS
    // ===========================
    async addUser(telegramId, telegramName, xUsername) {
        try {
            const newUser = await User.findOneAndUpdate(
                { telegram_id: telegramId },
                {
                    telegram_name: telegramName,
                    x_username: xUsername,
                    verified: true,
                    timestamp: new Date(),
                    last_active: new Date()
                },
                { upsert: true, new: true }
            );
            this.users[telegramId] = newUser.toObject();
        } catch (err) {
            console.error("Error adding user:", err);
        }
    }

    async removeUser(telegramId) {
        try {
            await User.deleteOne({ telegram_id: telegramId });
            delete this.users[telegramId];
        } catch (err) {
            console.error("Error removing user:", err);
        }
    }

    getUser(telegramId) {
        return this.users[telegramId];
    }

    getVerifiedUsers() {
        // Exclude banned users AND the Admin (so they don't get profiles)
        return Object.values(this.users).filter(u => u.verified && !u.is_banned && u.telegram_id !== ADMIN_ID);
    }

    async getUnmatchedUsers(userId, limit = 10) {
        // Get all verified users (already excludes Admin)
        const candidates = this.getVerifiedUsers().filter(u => u.telegram_id !== userId);

        // Optimization: Get all matches for this user in one query
        const matches = await Match.find({ user_id: userId }).select('matched_with');
        const matchedIds = new Set(matches.map(m => m.matched_with));

        const unmatched = candidates.filter(u => !matchedIds.has(u.telegram_id));

        // Shuffle and slice
        return unmatched.sort(() => 0.5 - Math.random()).slice(0, limit);
    }

    getStats() {
        const users = Object.values(this.users);
        const verified = users.filter(u => u.verified);

        const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
        const activeToday = users.filter(u => new Date(u.last_active).getTime() > oneDayAgo).length;

        const oneWeekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
        const activeWeek = users.filter(u => new Date(u.last_active).getTime() > oneWeekAgo).length;

        const totalMatches = users.reduce((acc, u) => acc + (u.profiles_sent || 0), 0);

        return {
            totalUsers: verified.length,
            activeToday,
            activeWeek,
            totalMatches
        };
    }

    async updateLastActive(telegramId) {
        if (this.users[telegramId]) {
            await User.updateOne({ telegram_id: telegramId }, { last_active: new Date() });
            this.users[telegramId].last_active = new Date();
        }
    }

    async incrementProfilesReceived(telegramId) {
        if (this.users[telegramId]) {
            await User.updateOne({ telegram_id: telegramId }, { $inc: { profiles_received: 1 } });
            this.users[telegramId].profiles_received = (this.users[telegramId].profiles_received || 0) + 1;
        }
    }

    async incrementProfilesSent(telegramId) {
        if (this.users[telegramId]) {
            await User.updateOne({ telegram_id: telegramId }, { $inc: { profiles_sent: 1 } });
            this.users[telegramId].profiles_sent = (this.users[telegramId].profiles_sent || 0) + 1;
        }
    }

    async incrementProfilesFollowed(telegramId) {
        if (this.users[telegramId]) {
            await User.updateOne({ telegram_id: telegramId }, { $inc: { profiles_followed: 1 } });
            this.users[telegramId].profiles_followed = (this.users[telegramId].profiles_followed || 0) + 1;
        }
    }

    async incrementSkips(telegramId) {
        if (!this.users[telegramId]) return 0;

        const now = Date.now();
        const lastReset = new Date(this.users[telegramId].last_skip_reset || 0).getTime();
        const oneDay = 24 * 60 * 60 * 1000;

        if (now - lastReset > oneDay) {
            this.users[telegramId].skips_count = 0;
            this.users[telegramId].last_skip_reset = new Date();
        }

        await User.updateOne(
            { telegram_id: telegramId },
            {
                skips_count: (this.users[telegramId].skips_count || 0) + 1,
                last_skip_reset: this.users[telegramId].last_skip_reset
            }
        );
        this.users[telegramId].skips_count = (this.users[telegramId].skips_count || 0) + 1;

        return this.users[telegramId].skips_count;
    }

    async addWarning(telegramId) {
        if (this.users[telegramId]) {
            await User.updateOne({ telegram_id: telegramId }, { $inc: { warnings_count: 1 } });
            this.users[telegramId].warnings_count = (this.users[telegramId].warnings_count || 0) + 1;
        }
    }

    async banUser(telegramId) {
        if (this.users[telegramId]) {
            await User.updateOne({ telegram_id: telegramId }, { is_banned: true });
            this.users[telegramId].is_banned = true;
        }
    }

    async unbanUser(telegramId) {
        if (this.users[telegramId]) {
            await User.updateOne({ telegram_id: telegramId }, { is_banned: false });
            this.users[telegramId].is_banned = false;
        }
    }

    async addVerifiedFollow(userId, followedId) {
        if (this.users[userId]) {
            if (!this.users[userId].verified_follows) this.users[userId].verified_follows = [];
            if (!this.users[userId].verified_follows.includes(followedId)) {
                await User.updateOne({ telegram_id: userId }, { $addToSet: { verified_follows: followedId } });
                this.users[userId].verified_follows.push(followedId);
            }
        }
    }

    hasUserFollowed(userId, targetId) {
        return this.users[userId]?.verified_follows?.includes(targetId) || false;
    }

    async recordMutualFollow(userId1, userId2) {
        if (this.users[userId1] && this.users[userId2]) {
            if (!this.users[userId1].mutual_follows) this.users[userId1].mutual_follows = [];
            if (!this.users[userId2].mutual_follows) this.users[userId2].mutual_follows = [];

            if (!this.users[userId1].mutual_follows.includes(userId2)) {
                await User.updateOne({ telegram_id: userId1 }, { $addToSet: { mutual_follows: userId2 } });
                this.users[userId1].mutual_follows.push(userId2);
            }
            if (!this.users[userId2].mutual_follows.includes(userId1)) {
                await User.updateOne({ telegram_id: userId2 }, { $addToSet: { mutual_follows: userId1 } });
                this.users[userId2].mutual_follows.push(userId1);
            }
        }
    }

    async hasMatched(userId, targetId) {
        const existing = await Match.exists({ user_id: userId, matched_with: targetId });
        return !!existing;
    }

    async recordMatch(userId, targetId) {
        try {
            await Match.create({ user_id: userId, matched_with: targetId });
        } catch (e) {
            // Ignore duplicate errors
        }
    }

    async resetMatchHistory(userId = null) {
        if (userId) {
            await Match.deleteMany({ user_id: userId });
        } else {
            await Match.deleteMany({});
        }
    }
}

export const db = new Database();
