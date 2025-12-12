import { logger } from "./utils.js";

/**
 * Calculates Levenshtein distance between two strings
 * @param {string} a 
 * @param {string} b 
 * @returns {number}
 */
function levenshtein(a, b) {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    const matrix = [];

    // increment along the first column of each row
    for (let i = 0; i <= b.length; i++) {
        matrix[i] = [i];
    }

    // increment each column in the first row
    for (let j = 0; j <= a.length; j++) {
        matrix[0][j] = j;
    }

    // Fill in the rest of the matrix
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1, // substitution
                    Math.min(
                        matrix[i][j - 1] + 1, // insertion
                        matrix[i - 1][j] + 1
                    ) // deletion
                );
            }
        }
    }

    return matrix[b.length][a.length];
}

/**
 * Checks if text is similar to target using Levenshtein distance
 * @param {string} text 
 * @param {string} target 
 * @param {number} threshold - Max allowed operations (default 2)
 * @returns {boolean}
 */
function isSimilar(text, target, threshold = 2) {
    if (!text) return false;
    const normalized = text.toLowerCase().trim();
    // Quick check
    if (normalized.includes(target)) return true;

    // Length check optimization
    if (Math.abs(normalized.length - target.length) > threshold) return false;

    return levenshtein(normalized, target) <= threshold;
}

/**
 * Normalizes OCR text (basic cleanup)
 * @param {string} text 
 * @returns {string}
 */
export function normalizeText(text) {
    if (!text) return "";
    return text
        .replace(/0/g, "o")
        .replace(/1/g, "l")
        .replace(/\|/g, "l")
        .replace(/@/g, "")
        .replace(/[^\w\s]/g, "") // Remove remaining symbols for cleaner fuzzy match
        .toLowerCase()
        .trim();
}

/**
 * Validates the layout of the X profile screenshot based on relative Y positions and fuzzy text matching.
 * @param {object} ocrData - The full OCR result object from Tesseract.js
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @returns {object} - { isValid: boolean, reason: string, followState: string, confidence: number }
 */
export function validateProfileLayout(ocrData, width, height) {
    if (!ocrData || !ocrData.words || ocrData.words.length === 0) {
        return { isValid: false, reason: "No text found", followState: "unknown", confidence: 0 };
    }

    const words = ocrData.words;
    const elements = {
        displayName: null,
        username: null,
        joinedDate: null,
        followingRow: null,
        followButton: null
    };

    // Helper to get relative center Y/X
    const getRelY = (bbox) => ((bbox.y0 + bbox.y1) / 2) / height;
    const getRelX = (bbox) => ((bbox.x0 + bbox.x1) / 2) / width;

    // 1. Scan for elements
    for (const word of words) {
        const rawText = word.text;
        const cleanText = normalizeText(rawText);
        const relY = getRelY(word.bbox);
        const relX = getRelX(word.bbox);

        // Ignore noise
        if (cleanText.length < 2) continue;

        // Display Name: Y = 0.10 -> 0.55 (Wider range)
        // MUST BE LEFT ALIGNED (relX < 0.6)
        if (relY >= 0.10 && relY <= 0.55 && relX < 0.6) {
            // Take the first logical looking text as display name if not set
            if (!elements.displayName) elements.displayName = { text: rawText, y: relY, isStrong: false };
        }

        // Username: Y = 0.15 -> 0.60
        // MUST BE LEFT ALIGNED
        if (relY >= 0.15 && relY <= 0.60 && relX < 0.6) {
            const isHandle = rawText.startsWith('@') || rawText.startsWith('©');
            if (!elements.username || (isHandle && !elements.username.isStrong)) {
                elements.username = { text: rawText, y: relY, isStrong: isHandle };
            }
        }

        // Joined date: Y = 0.25 -> 0.90
        // Fuzzy match "joined"
        if (relY >= 0.25 && relY <= 0.90 && relX < 0.6) {
            if (isSimilar(cleanText, "joined", 2)) {
                elements.joinedDate = { text: rawText, y: relY, isStrong: true };
            }
        }

        // Following/Followers: Y = 0.35 -> 0.95
        if (relY >= 0.35 && relY <= 0.95) {
            if (isSimilar(cleanText, "following", 2) || isSimilar(cleanText, "followers", 2)) {
                elements.followingRow = { text: rawText, y: relY, isStrong: true };
            }
        }

        // Follow Button: X = 0.60 -> 0.98 (Right side) AND Y = 0.30 -> 0.65
        if (relX >= 0.60 && relX <= 0.98 && relY >= 0.30 && relY <= 0.65) {
            // Check for button text
            if (isSimilar(cleanText, "following", 2) || isSimilar(cleanText, "follow", 2)) {
                elements.followButton = { text: rawText, y: relY, raw: rawText };
            }
        }
    }

    // 2. Validate Ordering
    let lastY = 0;
    const orderChecks = [
        elements.displayName,
        elements.username,
        elements.joinedDate,
        elements.followingRow
    ];

    let foundCount = 0;
    let strongCount = 0;

    for (const el of orderChecks) {
        if (el) {
            // Rough check with tolerance (0.05 height wiggle room) because OCR lines might not be perfectly sorted
            if (el.y < lastY - 0.05) {
                // But wait, user description is usually ABOVE joined date. Order is strictly enforced? 
                // If Display Name > Username, that's bad.
                // Let's enforce strictness for Name -> Username -> Joined
                if (el === elements.username && elements.displayName && el.y < elements.displayName.y) {
                    // Except sometimes they are on same line? No.
                }
            }
            // Actually, simply updating lastY is enough for a general flow check.
            // If we find 'following' before 'username', that's definitely wrong.
            if (el.y < lastY - 0.1) { // 10% screen height tolerance for unordered detection
                return { isValid: false, reason: "Layout mismatch (elements out of order)", followState: "unknown", confidence: 50 };
            }

            lastY = el.y;
            foundCount++;
            if (el.isStrong) strongCount++;
        }
    }

    // 3. Determine Follow State
    let followState = "unknown";
    if (elements.followButton) {
        const btnText = normalizeText(elements.followButton.raw);
        if (isSimilar(btnText, "following", 2)) {
            followState = "following";
        } else if (isSimilar(btnText, "follow", 1)) { // stricter for 'follow'
            followState = "not_following";
        }
    }

    // 4. Final Validity Check
    if (foundCount < 2) {
        return { isValid: false, reason: "Not enough profile elements found", followState: "unknown", confidence: 20 };
    }

    if (strongCount === 0 && foundCount < 3) {
        return { isValid: false, reason: "Ambiguous layout (no strong markers)", followState: "unknown", confidence: 40 };
    }

    return {
        isValid: true,
        reason: "Valid layout",
        followState: followState,
        confidence: strongCount > 1 ? 95 : 85
    };
}
