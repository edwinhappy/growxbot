import { ENABLE_LOGS } from "./config.js";

export function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export const logger = {
    log: (...args) => {
        if (ENABLE_LOGS) console.log(...args);
    },
    error: (...args) => {
        console.error(...args);
    },
    info: (...args) => {
        if (ENABLE_LOGS) console.log(...args);
    }
};

const userRateLimits = new Map();
const RATE_LIMIT_WINDOW = 60000;
const MAX_REQUESTS_PER_WINDOW = 5;

export function checkRateLimit(userId) {
    const now = Date.now();
    const userLimit = userRateLimits.get(userId) || {
        count: 0,
        resetTime: now + RATE_LIMIT_WINDOW
    };

    if (now > userLimit.resetTime) {
        userLimit.count = 0;
        userLimit.resetTime = now + RATE_LIMIT_WINDOW;
    }

    if (userLimit.count >= MAX_REQUESTS_PER_WINDOW) {
        return false;
    }

    userLimit.count++;
    userRateLimits.set(userId, userLimit);
    return true;
}
