const fs = require('fs').promises;
const path = require('path');

const RESULTS_FILE = path.join(__dirname, 'data', 'results.json');
const BRACKETS_FILE = path.join(__dirname, 'data', 'brackets.json');
const FEEDBACK_FILE = path.join(__dirname, 'data', 'feedback.json');
const LAST_SEEN_FILE = path.join(__dirname, 'data', 'last_seen.json');
const PROFILES_FILE = path.join(__dirname, 'data', 'profiles.json');

async function readJson(filePath, defaultValue) {
    try {
        const raw = await fs.readFile(filePath, 'utf8');
        const trimmed = String(raw || '').trim();
        if (!trimmed) return defaultValue;
        return JSON.parse(trimmed);
    } catch {
        return defaultValue;
    }
}

async function writeJson(filePath, value) {
    await fs.writeFile(filePath, JSON.stringify(value, null, 2));
}

async function initResultsFile() {
    try {
        const raw = await fs.readFile(RESULTS_FILE, 'utf8');
        const trimmed = String(raw || '').trim();
        if (!trimmed) {
            await fs.writeFile(RESULTS_FILE, JSON.stringify([]));
            return;
        }

        const parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed)) {
            await fs.writeFile(RESULTS_FILE, JSON.stringify([]));
        }
    } catch {
        await fs.writeFile(RESULTS_FILE, JSON.stringify([]));
    }
}

async function initBracketsFile() {
    try {
        const raw = await fs.readFile(BRACKETS_FILE, 'utf8');
        const trimmed = String(raw || '').trim();
        if (!trimmed) {
            await fs.writeFile(BRACKETS_FILE, JSON.stringify([]));
            return;
        }

        const parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed)) {
            await fs.writeFile(BRACKETS_FILE, JSON.stringify([]));
        }
    } catch {
        await fs.writeFile(BRACKETS_FILE, JSON.stringify([]));
    }
}

async function readBrackets() {
    return await readJson(BRACKETS_FILE, []);
}

async function writeBrackets(brackets) {
    await writeJson(BRACKETS_FILE, brackets || []);
}

module.exports = {
    initResultsFile,
    initBracketsFile,
    readBrackets,
    writeBrackets,
    readJson,
    writeJson,
    RESULTS_FILE,
    BRACKETS_FILE,
    FEEDBACK_FILE,
    LAST_SEEN_FILE,
    PROFILES_FILE
};

// Feedback helpers
function getEmptyFeedbackStore() {
    return { items: [], activity: [] };
}

function normalizeFeedbackStatus(value) {
    const token = String(value || 'open').trim().toLowerCase();
    if (token === 'fixed') return 'fixed';
    if (token === 'ignored') return 'ignored';
    return 'open';
}

function normalizeFeedbackReplyShape(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const message = String(value.message || '').trim();
    if (!message) return null;
    const createdAtRaw = String(value.createdAt || '').trim();
    return {
        id: String(value.id || `fr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`).trim(),
        message,
        createdBy: String(value.createdBy || '').trim() || 'anonymous',
        createdAt: createdAtRaw || new Date().toISOString()
    };
}

function normalizeFeedbackItemShape(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const createdAtRaw = String(value.createdAt || '').trim();
    return {
        id: String(value.id || `fb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`).trim(),
        title: String(value.title || '').trim() || 'Untitled Feedback',
        message: String(value.message || '').trim(),
        status: normalizeFeedbackStatus(value.status),
        createdBy: String(value.createdBy || '').trim() || 'unknown',
        createdAt: createdAtRaw || new Date().toISOString(),
        updatedBy: value.updatedBy == null ? null : (String(value.updatedBy || '').trim() || null),
        updatedAt: value.updatedAt == null ? null : (String(value.updatedAt || '').trim() || null),
        history: Array.isArray(value.history) ? value.history : [],
        replies: Array.isArray(value.replies)
            ? value.replies.map(normalizeFeedbackReplyShape).filter(Boolean)
            : []
    };
}

function normalizeFeedbackStoreShape(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return getEmptyFeedbackStore();
    const normalizedItems = Array.isArray(value.items)
        ? value.items.map(normalizeFeedbackItemShape).filter(item => item && item.message)
        : [];
    return { items: normalizedItems, activity: Array.isArray(value.activity) ? value.activity : [] };
}

async function initFeedbackFile() {
    try {
        const raw = await fs.readFile(FEEDBACK_FILE, 'utf8');
        const trimmed = String(raw || '').trim();
        if (!trimmed) {
            await fs.writeFile(FEEDBACK_FILE, JSON.stringify(getEmptyFeedbackStore(), null, 2));
            return;
        }

        const parsed = JSON.parse(trimmed);
        const normalized = normalizeFeedbackStoreShape(parsed);
        if (JSON.stringify(parsed) !== JSON.stringify(normalized)) {
            await fs.writeFile(FEEDBACK_FILE, JSON.stringify(normalized, null, 2));
        }
    } catch {
        await fs.writeFile(FEEDBACK_FILE, JSON.stringify(getEmptyFeedbackStore(), null, 2));
    }
}

async function readFeedbackStore() {
    try {
        const raw = await fs.readFile(FEEDBACK_FILE, 'utf8');
        const trimmed = String(raw || '').trim();
        if (!trimmed) return getEmptyFeedbackStore();
        return normalizeFeedbackStoreShape(JSON.parse(trimmed));
    } catch {
        return getEmptyFeedbackStore();
    }
}

async function writeFeedbackStore(store) {
    const normalized = normalizeFeedbackStoreShape(store);
    await fs.writeFile(FEEDBACK_FILE, JSON.stringify(normalized, null, 2));
}

function pushFeedbackActivity(store, entry) {
    if (!store || typeof store !== 'object') return;
    if (!Array.isArray(store.activity)) store.activity = [];
    store.activity.unshift({
        id: `fa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        at: new Date().toISOString(),
        type: String(entry?.type || 'updated'),
        by: String(entry?.by || '').trim() || 'unknown',
        feedbackId: String(entry?.feedbackId || '').trim(),
        feedbackTitle: String(entry?.feedbackTitle || '').trim(),
        details: entry?.details && typeof entry.details === 'object' ? entry.details : {}
    });
    if (store.activity.length > 500) store.activity = store.activity.slice(0, 500);
}

// Last-seen helpers
async function initLastSeenFile() {
    try {
        const raw = await fs.readFile(LAST_SEEN_FILE, 'utf8');
        const trimmed = String(raw || '').trim();
        if (!trimmed) {
            await fs.writeFile(LAST_SEEN_FILE, JSON.stringify({}, null, 2));
            return {};
        }

        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed;
        }

        await fs.writeFile(LAST_SEEN_FILE, JSON.stringify({}, null, 2));
        return {};
    } catch {
        await fs.writeFile(LAST_SEEN_FILE, JSON.stringify({}, null, 2));
        return {};
    }
}

async function saveLastSeenFile(map) {
    try {
        await fs.writeFile(LAST_SEEN_FILE, JSON.stringify(map || {}, null, 2));
    } catch (error) {
        console.error('Failed to write last seen file:', error);
    }
}

module.exports.initFeedbackFile = initFeedbackFile;
module.exports.readFeedbackStore = readFeedbackStore;
module.exports.writeFeedbackStore = writeFeedbackStore;
module.exports.pushFeedbackActivity = pushFeedbackActivity;
module.exports.initLastSeenFile = initLastSeenFile;
module.exports.saveLastSeenFile = saveLastSeenFile;
module.exports.getEmptyFeedbackStore = getEmptyFeedbackStore;
