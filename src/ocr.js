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
        const text = normalizeText(word.text);
        const relY = getRelY(word.bbox);
        const relX = getRelX(word.bbox);

        // Display Name (Widen range to support square crops: 0.15 -> 0.55)
        if (relY >= 0.15 && relY <= 0.55) {
            if (!elements.displayName) elements.displayName = { text: word.text, y: relY };
        }

        // Username: Y = 0.20 -> 0.65
        if (relY >= 0.20 && relY <= 0.65) {
            if (!elements.username) elements.username = { text: word.text, y: relY };
        }

        // Joined date: Y = 0.30 -> 0.90 (Look for "joined")
        if (relY >= 0.30 && relY <= 0.90 && text.includes("joined")) {
            elements.joinedDate = { text: word.text, y: relY };
        }

        // Following/Followers row: Y = 0.40 -> 0.95 (Look for numbers or "following"/"followers")
        if (relY >= 0.40 && relY <= 0.95 && (text.includes("following") || text.includes("followers"))) {
            elements.followingRow = { text: word.text, y: relY };
        }

        // Follow Button: X = 0.60 -> 0.98 AND Y = 0.30 -> 0.60
        // (Widened X slightly to catch buttons that might be shifted)
        if (relX >= 0.60 && relX <= 0.98 && relY >= 0.30 && relY <= 0.60) {
            // Check for button text
            if (text.includes("following") || text.includes("follow")) {
                elements.followButton = { text: word.text, y: relY, raw: word.text };
            }
        }
    }

    // 2. Validate Ordering
    // display_nameY < usernameY < joinedY < followingRowY
    // We allow some missing elements but if they exist they must be in order.
    let lastY = 0;
    const orderChecks = [
        elements.displayName,
        elements.username,
        elements.joinedDate,
        elements.followingRow
    ];

    for (const el of orderChecks) {
        if (el) {
            if (el.y < lastY) {
                // Out of order
                return { isValid: false, reason: "Layout mismatch (elements out of order)", followState: "unknown", confidence: 50 };
            }
            lastY = el.y;
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
    } else {
        // Fallback: Scan entire text for "Following" if button not found in exact spot?
        // The user requirement says: "If button text cannot be located in the top-right button zone -> follow_state = 'unknown'"
        // So we stick to that.
        followState = "unknown";
    }

    // 4. Final Validity Check
    // If we didn't find *any* key elements, it's probably not a profile.
    const foundCount = orderChecks.filter(e => e).length;
    if (foundCount < 2) {
        return { isValid: false, reason: "Not enough profile elements found", followState: "unknown", confidence: 20 };
    }

    return {
        isValid: true,
        reason: "Valid layout",
        followState: followState,
        confidence: 90 // High confidence if layout matches
    };
}
