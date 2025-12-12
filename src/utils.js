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

export function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
