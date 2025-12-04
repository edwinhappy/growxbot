import { logger } from "./utils.js";

/**
 * Normalizes OCR text to handle common misinterpretations.
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
        .toLowerCase()
        .trim();
}

/**
 * Validates the layout of the X profile screenshot based on relative Y positions.
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

    // Helper to get relative center Y
    const getRelY = (bbox) => ((bbox.y0 + bbox.y1) / 2) / height;
    const getRelX = (bbox) => ((bbox.x0 + bbox.x1) / 2) / width;

    // 1. Scan for elements
    for (const word of words) {
        const rawText = word.text;
        const text = normalizeText(rawText);
        const relY = getRelY(word.bbox);
        const relX = getRelX(word.bbox);

        // Ignore very short noise (unless it's a number for stats, but stats look for keywords)
        if (text.length < 2) continue;

        // Display Name: Y = 0.15 -> 0.55
        // MUST BE LEFT ALIGNED (relX < 0.5) - This kills centered text like keyboards
        if (relY >= 0.15 && relY <= 0.55 && relX < 0.6) {
            if (!elements.displayName) elements.displayName = { text: rawText, y: relY, isStrong: false };
        }

        // Username: Y = 0.20 -> 0.65
        // MUST BE LEFT ALIGNED
        if (relY >= 0.20 && relY <= 0.65 && relX < 0.6) {
            const isHandle = rawText.startsWith('@') || rawText.startsWith('©'); // OCR sometimes sees @ as ©
            if (!elements.username || (isHandle && !elements.username.isStrong)) {
                elements.username = { text: rawText, y: relY, isStrong: isHandle };
            }
        }

        // Joined date: Y = 0.30 -> 0.90 (Look for "joined")
        // MUST BE LEFT ALIGNED
        if (relY >= 0.30 && relY <= 0.90 && text.includes("joined") && relX < 0.6) {
            elements.joinedDate = { text: rawText, y: relY, isStrong: true };
        }

        // Following/Followers row: Y = 0.40 -> 0.95
        // Usually left aligned too, but can span wider
        if (relY >= 0.40 && relY <= 0.95 && (text.includes("following") || text.includes("followers"))) {
            elements.followingRow = { text: rawText, y: relY, isStrong: true };
        }

        // Follow Button: X = 0.60 -> 0.98 (Right side) AND Y = 0.30 -> 0.60
        if (relX >= 0.60 && relX <= 0.98 && relY >= 0.30 && relY <= 0.60) {
            if (text.includes("following") || text.includes("follow")) {
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
            if (el.y < lastY) {
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
        if (btnText.includes("following") || btnText.includes("foll0wing")) {
            followState = "following";
        } else if (btnText.includes("follow") || btnText.includes("f0llow")) {
            followState = "not_following";
        }
    }

    // 4. Final Validity Check
    // Must have at least 2 elements AND (at least 1 strong element OR 3+ elements)
    if (foundCount < 2) {
        return { isValid: false, reason: "Not enough profile elements found", followState: "unknown", confidence: 20 };
    }

    if (strongCount === 0 && foundCount < 3) {
        return { isValid: false, reason: "Ambiguous layout (no strong markers like '@', 'joined', 'following')", followState: "unknown", confidence: 40 };
    }

    return {
        isValid: true,
        reason: "Valid layout",
        followState: followState,
        confidence: strongCount > 1 ? 95 : 85
    };
}
