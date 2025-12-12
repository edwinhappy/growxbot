import { Session } from './database.js';
import { logger } from './utils.js';

export class SessionManager {
    constructor() {
        this.cache = new Map();
        this.CACHE_TIMEOUT = 14 * 60 * 1000; // 14 min, slightly less than DB's 15m TTL
        this.cleanupInterval = setInterval(() => this.cleanup(), 60 * 1000);
        this.setupChangeStream();
    }

    setupChangeStream() {
        const startStream = () => {
            try {
                // Watch for changes to sync cache across instances
                // fullDocument: 'updateLookup' gives us the document on updates
                this.changeStream = Session.watch([], { fullDocument: 'updateLookup' });

                this.changeStream.on('change', (change) => {
                    try {
                        if (change.operationType === 'insert' || change.operationType === 'update' || change.operationType === 'replace') {
                            const doc = change.fullDocument;
                            if (doc && doc.user_id) {
                                // Update local cache if exists
                                if (this.cache.has(doc.user_id)) {
                                    this.cache.set(doc.user_id, {
                                        data: doc.data,
                                        ts: Date.now(),
                                        _id: doc._id.toString()
                                    });
                                }
                            }
                        } else if (change.operationType === 'delete') {
                            const deletedId = change.documentKey._id.toString();
                            for (const [userId, cacheEntry] of this.cache.entries()) {
                                if (cacheEntry._id === deletedId) {
                                    this.cache.delete(userId);
                                    break;
                                }
                            }
                        }
                    } catch (err) {
                        logger.error("Error processing session change stream:", err);
                    }
                });

                this.changeStream.on('error', (err) => {
                    logger.error("Session change stream error, restarting in 5s:", err);
                    this.changeStream = null;
                    setTimeout(() => startStream(), 5000);
                });

            } catch (error) {
                logger.warn("Change stream unavailable, using cache-only mode");
                this.changeStream = null;
            }
        };

        startStream();
    }

    async getSession(userId) {
        // Check cache
        const cached = this.cache.get(userId);
        if (cached && Date.now() - cached.ts < this.CACHE_TIMEOUT) {
            return cached.data;
        }

        // Load from DB
        const dbSession = await Session.findOne({ user_id: userId });
        const session = dbSession?.data || null;

        if (session) {
            this.cache.set(userId, {
                data: session,
                ts: Date.now(),
                _id: dbSession._id.toString()
            });
        }

        return session;
    }

    async createSession(userId, initialData = {}) {
        const session = {
            step: "username",
            username: null,
            attempts: 0,
            startTime: Date.now(),
            lastActivity: Date.now(),
            ...initialData
        };

        const doc = await Session.findOneAndUpdate(
            { user_id: userId },
            { data: session, last_activity: new Date() },
            { upsert: true, new: true }
        );

        this.cache.set(userId, {
            data: session,
            ts: Date.now(),
            _id: doc._id.toString()
        });
        return session;
    }

    async updateSession(userId, updates) {
        const session = await this.getSession(userId);
        if (!session) return null;

        Object.assign(session, updates);
        session.lastActivity = Date.now();

        const doc = await Session.findOneAndUpdate(
            { user_id: userId },
            { data: session, last_activity: new Date() },
            { new: true }
        );

        if (doc) {
            this.cache.set(userId, {
                data: session,
                ts: Date.now(),
                _id: doc._id.toString()
            });
        }

        return session;
    }

    async deleteSession(userId) {
        await Session.deleteOne({ user_id: userId });
        this.cache.delete(userId);
    }

    cleanup() {
        const now = Date.now();
        for (const [key, value] of this.cache.entries()) {
            if (now - value.ts > this.CACHE_TIMEOUT) {
                this.cache.delete(key);
            }
        }
    }

    destroy() {
        clearInterval(this.cleanupInterval);
        if (this.changeStream) {
            this.changeStream.close();
        }
        this.cache.clear();
    }
}
