import dotenv from "dotenv";

dotenv.config();

export const BOT_TOKEN = process.env.BOT_TOKEN;
export const ADMIN_ID = parseInt(process.env.ADMIN_ID || "0");
export const ADMIN_GROUP_ID = parseInt(process.env.ADMIN_GROUP_ID || "0");
export const OWNER_X = process.env.OWNER_X;
export const MONGO_URI = process.env.MONGO_URI;
export const ENABLE_LOGS = process.env.ENABLE_LOGS === "true";

// Network Limits
export const MAX_SKIPS_PER_DAY = 5;
export const MAX_WARNINGS = 3;
export const MAX_VERIFICATION_ATTEMPTS = 3;
export const OCR_POOL_SIZE = parseInt(process.env.OCR_POOL_SIZE || "1");

// Timeouts & Delays
export const RATE_LIMIT_WINDOW = 60000; // 1 minute
export const MAX_REQUESTS = 5;
export const SEND_PROFILE_DELAY = 150; // ms (legacy use)
export const BATCH_DELAY = 50; // ms
export const SKIP_RESET_HOURS = 24;

// Strict Validation
if (!BOT_TOKEN || isNaN(ADMIN_ID) || ADMIN_ID === 0 ||
    isNaN(ADMIN_GROUP_ID) || ADMIN_GROUP_ID === 0 ||
    !OWNER_X || !MONGO_URI) {
    console.error("❌ Missing or invalid required environment variables!");
    console.error("Required: BOT_TOKEN, ADMIN_ID, ADMIN_GROUP_ID, OWNER_X, MONGO_URI");
    process.exit(1);
}

if (isNaN(OCR_POOL_SIZE) || OCR_POOL_SIZE < 1 || OCR_POOL_SIZE > 10) {
    console.error("❌ OCR_POOL_SIZE must be between 1 and 10");
    process.exit(1);
}
