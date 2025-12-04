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

if (!BOT_TOKEN || !ADMIN_ID || !ADMIN_GROUP_ID || !OWNER_X) {
    console.error("❌ Missing required environment variables!");
    console.error("Required: BOT_TOKEN, ADMIN_ID, ADMIN_GROUP_ID, OWNER_X");
    process.exit(1);
}
