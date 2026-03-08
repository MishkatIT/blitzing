const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const RESULTS_FILE = path.join(__dirname, 'results.json');
const BRACKETS_FILE = path.join(__dirname, 'brackets.json');
const FEEDBACK_FILE = path.join(__dirname, 'feedback.json');
const { ROOMS_FILE, initRoomsFile } = require('./rooms-persistence');
const ADMIN_HANDLE_HASH_SALT = 'blitz_admin_handle_v1';
const ADMIN_PIN_HASH_SALT = 'blitz_admin_pin_v1';
const ADMIN_PIN_HASH = 'ea8ed8fdc6e6e9bfb38c14d8ac51e35ef55881744fcb973e2265e605c16abb17';
const ADMIN_HANDLE_HASHES = new Set([
    'e2b82273d0435bda4c0b04fd0885cf2dd98549a44bdeb17bac2ddee9325a1552',
    'd571523d4f27a5c5d831a9c14e5c6c1d0a5f29d57d267ce9a5ce732d58cf20fb'
]);
const ROOM_CLEANUP_DELAY_MS = 5 * 60 * 1000;
const ROOM_NO_OPPONENT_TIMEOUT_MS = 10 * 60 * 1000;
const ROOM_UNSTARTED_TIMEOUT_MS = 20 * 60 * 1000;
const MATCH_START_COUNTDOWN_MS = 15 * 1000;
const ROOM_PENDING_RECHECK_DELAY_MS = 60 * 1000;
const ROOM_VALIDATION_POLL_MS = 2000;
const LAST_SEEN_FILE = path.join(__dirname, 'last_seen.json');
const PROFILES_FILE = path.join(__dirname, 'profiles.json');
const PRESENCE_HEARTBEAT_ACTIVE_MS = 70 * 1000;
const SESSION_COOKIE_NAME = 'blitz_sid';
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_SECRET = process.env.BLITZ_SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_CHALLENGE_TTL_MS = 10 * 60 * 1000;
const FEEDBACK_DAILY_LIMIT = 100;
const ADMIN_PIN_MAX_FAILED_ATTEMPTS = 5;
const ADMIN_PIN_LOCK_MS = 10 * 60 * 1000;

// Store rooms in memory
const rooms = new Map();

// Initialize persistent rooms file
const { saveRoomsToDisk, loadRoomsFromDisk } = require('./rooms-persistence');
initRoomsFile();

// Restore rooms from disk on startup
(async () => {
    const loadedRooms = await loadRoomsFromDisk();
    for (const room of loadedRooms) {
        // Remove any non-serializable fields just in case
        delete room.endTimeout;
        delete room.cleanupTimeout;
        delete room.noOpponentTimeout;
        delete room.unstartedTimeout;
        delete room.countdownTimeout;
        delete room.breakAdvanceTimeout;
        // Remove ws from players
        if (Array.isArray(room.players)) {
            room.players = room.players.map(player => ({ ...player, ws: null }));
        }
        rooms.set(room.id, room);
    }
})();
let lastSeenMap = {};
const heartbeatSeenMap = new Map();
let profilesMap = {};
const sessionStore = new Map();
const sessionChallengeStore = new Map();
const adminPinAttempts = new Map();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// Initialize results file
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

function getEmptyFeedbackStore() {
    return {
        items: [],
        activity: []
    };
}

function normalizeFeedbackStatus(value) {
    const token = String(value || 'open').trim().toLowerCase();
    if (token === 'fixed') return 'fixed';
    if (token === 'ignored') return 'ignored';
    return 'open';
}

function normalizeFeedbackReplyShape(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }

    const message = String(value.message || '').trim();
    if (!message) {
        return null;
    }

    const createdAtRaw = String(value.createdAt || '').trim();
    return {
        id: String(value.id || `fr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`).trim(),
        message,
        createdBy: String(value.createdBy || '').trim() || 'anonymous',
        createdAt: createdAtRaw || new Date().toISOString()
    };
}

function normalizeFeedbackItemShape(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }

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
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return getEmptyFeedbackStore();
    }

    const normalizedItems = Array.isArray(value.items)
        ? value.items.map(normalizeFeedbackItemShape).filter(item => item && item.message)
        : [];

    return {
        items: normalizedItems,
        activity: Array.isArray(value.activity) ? value.activity : []
    };
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

    if (store.activity.length > 500) {
        store.activity = store.activity.slice(0, 500);
    }
}

function canManageFeedback(feedbackItem, requesterHandle, adminPassword = '', req = null) {
    const owner = normalizeHandle(feedbackItem?.createdBy);
    const requester = normalizeHandle(requesterHandle);
    const isOwner = !!owner && !!requester && owner === requester;
    const isAdmin = isAdminRequester(requesterHandle, adminPassword || '', req);
    return isOwner || isAdmin;
}

function canDeleteFeedbackReply(replyItem, requesterHandle, adminPassword = '', req = null) {
    const replyOwner = normalizeHandle(replyItem?.createdBy);
    const requester = normalizeHandle(requesterHandle);
    const isReplyOwner = !!replyOwner && !!requester && replyOwner === requester;
    const isAdmin = isAdminRequester(requesterHandle, adminPassword || '', req);
    return isReplyOwner || isAdmin;
}

async function initLastSeenFile() {
    try {
        const raw = await fs.readFile(LAST_SEEN_FILE, 'utf8');
        const trimmed = String(raw || '').trim();
        if (!trimmed) {
            lastSeenMap = {};
            await fs.writeFile(LAST_SEEN_FILE, JSON.stringify(lastSeenMap, null, 2));
            return;
        }

        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            lastSeenMap = parsed;
            return;
        }

        lastSeenMap = {};
        await fs.writeFile(LAST_SEEN_FILE, JSON.stringify(lastSeenMap, null, 2));
    } catch {
        lastSeenMap = {};
        await fs.writeFile(LAST_SEEN_FILE, JSON.stringify(lastSeenMap, null, 2));
    }
}

async function initProfilesFile() {
    try {
        const raw = await fs.readFile(PROFILES_FILE, 'utf8');
        const trimmed = String(raw || '').trim();
        if (!trimmed) {
            profilesMap = {};
            await fs.writeFile(PROFILES_FILE, JSON.stringify([], null, 2));
            return;
        }

        const parsed = JSON.parse(trimmed);
        const nextMap = {};

        if (Array.isArray(parsed)) {
            for (const item of parsed) {
                const handle = String(item || '').trim();
                const normalized = normalizeHandle(handle);
                if (!normalized) continue;
                if (!nextMap[normalized]) {
                    nextMap[normalized] = handle;
                }
            }
            profilesMap = nextMap;
            return;
        }

        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            for (const [key, value] of Object.entries(parsed)) {
                const handle = String(value || '').trim();
                const normalized = normalizeHandle(key || handle);
                if (!normalized) continue;
                nextMap[normalized] = handle || normalized;
            }
            profilesMap = nextMap;
            await saveProfilesFile();
            return;
        }

        profilesMap = {};
        await fs.writeFile(PROFILES_FILE, JSON.stringify([], null, 2));
    } catch {
        profilesMap = {};
        await fs.writeFile(PROFILES_FILE, JSON.stringify([], null, 2));
    }
}

async function saveLastSeenFile() {
    try {
        await fs.writeFile(LAST_SEEN_FILE, JSON.stringify(lastSeenMap, null, 2));
    } catch (error) {
        console.error('Failed to write last seen file:', error);
    }
}

async function saveProfilesFile() {
    try {
        const handles = Object.values(profilesMap)
            .filter(Boolean)
            .sort((a, b) => a.localeCompare(b));
        await fs.writeFile(PROFILES_FILE, JSON.stringify(handles, null, 2));
    } catch (error) {
        console.error('Failed to write profiles file:', error);
    }
}

function upsertProfileHandle(handle) {
    const display = String(handle || '').trim();
    const normalized = normalizeHandle(display);
    if (!normalized) return false;

    if (profilesMap[normalized]) {
        return false;
    }

    profilesMap[normalized] = display;
    saveProfilesFile().catch(() => {});
    return true;
}

function getAllProfiles() {
    return Object.values(profilesMap)
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
}

function splitIntoChunks(items, chunkSize) {
    const size = Math.max(1, Number(chunkSize) || 1);
    const chunks = [];
    for (let index = 0; index < items.length; index += size) {
        chunks.push(items.slice(index, index + size));
    }
    return chunks;
}

async function refreshProfilesCanonicalCasing() {
    const knownHandles = Object.values(profilesMap)
        .map(item => String(item || '').trim())
        .filter(Boolean);
    if (!knownHandles.length) return false;

    const deduped = [];
    const seen = new Set();
    for (const handle of knownHandles) {
        const normalized = normalizeHandle(handle);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        deduped.push(handle);
    }

    if (!deduped.length) return false;

    let changed = false;
    const chunks = splitIntoChunks(deduped, 80);

    for (const chunk of chunks) {
        try {
            const handlesQuery = chunk.map(handle => encodeURIComponent(handle)).join(';');
            const data = await fetchJson(`https://codeforces.com/api/user.info?handles=${handlesQuery}`);
            if (data.status !== 'OK' || !Array.isArray(data.result)) continue;

            for (const user of data.result) {
                const canonical = String(user?.handle || '').trim();
                const normalized = normalizeHandle(canonical);
                if (!normalized || !profilesMap[normalized]) continue;
                if (profilesMap[normalized] === canonical) continue;
                profilesMap[normalized] = canonical;
                changed = true;
            }
        } catch {
        }
    }

    if (changed) {
        await saveProfilesFile();
    }

    return changed;
}

function markHandleSeen(handle, timestamp = Date.now()) {
    const normalized = normalizeHandle(handle);
    if (!normalized) return;

    lastSeenMap[normalized] = timestamp;
    saveLastSeenFile().catch(() => {});
}

function isHandleCurrentlyActive(handle) {
    const normalized = normalizeHandle(handle);
    if (!normalized) return false;

    for (const client of wss.clients) {
        if (client.readyState !== WebSocket.OPEN) continue;
        if (normalizeHandle(client.userHandle) === normalized) {
            return true;
        }
    }

    const heartbeatAt = Number(heartbeatSeenMap.get(normalized)) || 0;
    if (!heartbeatAt) return false;

    return (Date.now() - heartbeatAt) <= PRESENCE_HEARTBEAT_ACTIVE_MS;
}

function getHandlePresence(handle) {
    const normalized = normalizeHandle(handle);
    if (!normalized) {
        return { handle: String(handle || ''), active: false, lastSeen: null };
    }

    const active = isHandleCurrentlyActive(normalized);
    const lastSeen = Number(lastSeenMap[normalized]) || null;
    return {
        handle: String(handle || ''),
        active,
        lastSeen
    };
}

function ensureSequentialBlitzNumbers(results = []) {
    if (!Array.isArray(results)) return { normalized: [], changed: false };

    const cloned = results.map(item => ({ ...item }));
    const sorted = [...cloned].sort((a, b) => {
        const aTime = new Date(a.date || 0).getTime();
        const bTime = new Date(b.date || 0).getTime();
        return aTime - bTime;
    });

    let changed = false;
    sorted.forEach((item, index) => {
        const nextNumber = index + 1;
        if (Number(item.blitzNumber) !== nextNumber) {
            changed = true;
            item.blitzNumber = nextNumber;
        }
    });

    const byMatchKey = new Map(sorted.map(item => [item.matchKey || `${item.roomId}-${item.date}-${Math.random()}`, item]));
    const normalized = cloned.map(item => {
        const key = item.matchKey || `${item.roomId}-${item.date}-${Math.random()}`;
        return byMatchKey.get(key) || item;
    });

    return { normalized, changed };
}

async function readBrackets() {
    try {
        const raw = await fs.readFile(BRACKETS_FILE, 'utf8');
        const trimmed = String(raw || '').trim();
        if (!trimmed) return [];
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

async function writeBrackets(brackets) {
    await fs.writeFile(BRACKETS_FILE, JSON.stringify(brackets, null, 2));
}

function normalizeParticipants(participants = []) {
    const cleaned = participants
        .map(item => String(item || '').trim())
        .filter(Boolean);
    return Array.from(new Set(cleaned));
}

function normalizeHandle(value) {
    return String(value || '').trim().toLowerCase();
}

function normalizeBracketRoomConfig(rawConfig = {}) {
    const problemCountRaw = Number(rawConfig.problemCount);
    const durationRaw = Number(rawConfig.duration);
    const intervalRaw = Number(rawConfig.interval);

    const providedProblems = Array.isArray(rawConfig.problems)
        ? rawConfig.problems
            .map(problem => ({
                points: Math.max(1, Number(problem?.points) || 1),
                rating: Math.max(800, Math.min(3500, Number(problem?.rating) || 800))
            }))
            .filter(problem => Number.isFinite(problem.points) && Number.isFinite(problem.rating))
        : [];

    const normalizedProblemCount = providedProblems.length > 0
        ? providedProblems.length
        : (Number.isFinite(problemCountRaw) ? Math.max(1, Math.min(20, Math.floor(problemCountRaw))) : 7);

    return {
        problemCount: normalizedProblemCount,
        duration: Number.isFinite(durationRaw) ? Math.max(2, Math.min(60, Math.floor(durationRaw))) : 40,
        interval: Number.isFinite(intervalRaw) ? Math.max(1, Math.min(10, Math.floor(intervalRaw))) : 1,
        problems: providedProblems
    };
}

function buildDefaultProblems(problemCount = 7) {
    const total = Math.max(1, Math.min(20, Math.floor(Number(problemCount) || 7)));
    const ratings = [800, 800, 900, 1000, 1000, 1100, 1200, 1300, 1400, 1500, 1500, 1600, 1700, 1800, 1900, 2000, 2100, 2200, 2300, 2400];

    return Array.from({ length: total }, (_, index) => ({
        points: index + 2,
        rating: ratings[index] || ratings[ratings.length - 1]
    }));
}

function generateRoundRobinMatches(participants) {
    const players = [...participants];
    if (players.length % 2 !== 0) players.push('BYE');

    const rounds = players.length - 1;
    const half = players.length / 2;
    const matches = [];
    let matchSeq = 1;

    for (let round = 0; round < rounds; round++) {
        for (let i = 0; i < half; i++) {
            const p1 = players[i];
            const p2 = players[players.length - 1 - i];
            if (p1 !== 'BYE' && p2 !== 'BYE') {
                matches.push({
                    id: `m${matchSeq++}`,
                    round: round + 1,
                    label: `Round ${round + 1} · Match ${i + 1}`,
                    p1,
                    p2,
                    bracketSide: 'main',
                    status: 'pending',
                    winner: null,
                    roomId: null,
                    result: null
                });
            }
        }
        players.splice(1, 0, players.pop());
    }

    return matches;
}

function generateSingleEliminationMatches(participants) {
    const nextPower = Math.pow(2, Math.ceil(Math.log2(participants.length)));
    const slots = [...participants];
    while (slots.length < nextPower) slots.push('BYE');

    const matches = [];
    let matchSeq = 1;
    let roundPlayers = slots;
    let round = 1;

    while (roundPlayers.length >= 2) {
        const current = [];
        for (let i = 0; i < roundPlayers.length; i += 2) {
            const p1 = roundPlayers[i];
            const p2 = roundPlayers[i + 1];
            current.push(`Winner M${matchSeq}`);
            matches.push({
                id: `m${matchSeq}`,
                round,
                label: `Round ${round} · Match ${i / 2 + 1}`,
                p1,
                p2,
                bracketSide: 'main',
                status: 'pending',
                winner: null,
                roomId: null,
                result: null
            });
            matchSeq += 1;
        }
        roundPlayers = current;
        round += 1;
    }

    return matches;
}

function generateDoubleEliminationMatches(participants) {
    const winners = generateSingleEliminationMatches(participants);
    const matches = [...winners];
    let seq = winners.length + 1;
    const extraLosersRounds = Math.max(1, Math.ceil(Math.log2(participants.length)));

    for (let round = 1; round <= extraLosersRounds; round++) {
        matches.push({
            id: `m${seq++}`,
            round,
            label: `Losers Round ${round}`,
            p1: `Loser Slot ${round}A`,
            p2: `Loser Slot ${round}B`,
            bracketSide: 'losers',
            status: 'pending',
            winner: null,
            roomId: null,
            result: null
        });
    }

    matches.push({
        id: `m${seq}`,
        round: extraLosersRounds + 1,
        label: 'Grand Final',
        p1: 'Winners Bracket Champion',
        p2: 'Losers Bracket Champion',
        bracketSide: 'final',
        status: 'pending',
        winner: null,
        roomId: null,
        result: null
    });

    return matches;
}

function generateBracketMatches(type, participants) {
    if (type === 'single-elimination') return generateSingleEliminationMatches(participants);
    if (type === 'double-elimination') return generateDoubleEliminationMatches(participants);
    return generateRoundRobinMatches(participants);
}

function canManageBracket(bracket, requesterHandle, adminPassword = '', req = null) {
    const isOwner = normalizeHandle(requesterHandle) && normalizeHandle(bracket?.ownerHandle) && normalizeHandle(requesterHandle) === normalizeHandle(bracket.ownerHandle);
    const isAdmin = isAdminRequester(requesterHandle, adminPassword || '', req);
    return isOwner || isAdmin;
}

function canCreateBracketRoom(bracket, match, requesterHandle, adminPassword = '', req = null) {
    if (isAdminRequester(requesterHandle, adminPassword || '', req)) return true;

    const requester = normalizeHandle(requesterHandle);
    if (!requester) return false;

    const p1 = normalizeHandle(match?.p1);
    const p2 = normalizeHandle(match?.p2);

    return requester === p1 || requester === p2;
}

function resolveBracketRoomPlayers(match, requesterHandle, isAdminRequest = false) {
    const p1 = String(match?.p1 || '').trim();
    const p2 = String(match?.p2 || '').trim();
    if (!p1 || !p2) {
        return { hostHandle: p1, opponentHandle: p2 };
    }

    if (isAdminRequest) {
        return { hostHandle: p1, opponentHandle: p2 };
    }

    const requester = normalizeHandle(requesterHandle);
    if (!requester) {
        return { hostHandle: p1, opponentHandle: p2 };
    }

    if (normalizeHandle(p2) === requester) {
        return { hostHandle: p2, opponentHandle: p1 };
    }

    return { hostHandle: p1, opponentHandle: p2 };
}

function getBracketUsedProblemIds(bracket) {
    if (!Array.isArray(bracket?.usedProblemIds)) return [];

    const unique = new Set();
    bracket.usedProblemIds.forEach(id => {
        const token = String(id || '').trim();
        if (!token) return;
        unique.add(token);
    });

    return Array.from(unique);
}

async function reserveBracketProblemIds(bracketId, problemIds = []) {
    const uniqueToReserve = Array.from(new Set((problemIds || [])
        .map(id => String(id || '').trim())
        .filter(Boolean)));
    if (!bracketId || uniqueToReserve.length === 0) return;

    const brackets = await readBrackets();
    const index = brackets.findIndex(item => item.id === bracketId);
    if (index === -1) return;

    const bracket = brackets[index];
    const existing = new Set(getBracketUsedProblemIds(bracket));
    const initialSize = existing.size;

    uniqueToReserve.forEach(id => existing.add(id));
    if (existing.size === initialSize) return;

    bracket.usedProblemIds = Array.from(existing);
    await writeBrackets(brackets);
}

async function resolveTieWinnerByRules(player1Handle, player2Handle) {
    const response = await fetchJson(`https://codeforces.com/api/user.info?handles=${encodeURIComponent(player1Handle)};${encodeURIComponent(player2Handle)}`);
    if (response.status !== 'OK' || !Array.isArray(response.result) || response.result.length < 2) {
        return player1Handle;
    }

    const p1 = response.result[0];
    const p2 = response.result[1];

    const p1Max = Number(p1.maxRating) || Number.MAX_SAFE_INTEGER;
    const p2Max = Number(p2.maxRating) || Number.MAX_SAFE_INTEGER;
    if (p1Max !== p2Max) return p1Max < p2Max ? player1Handle : player2Handle;

    const p1Rating = Number(p1.rating) || Number.MAX_SAFE_INTEGER;
    const p2Rating = Number(p2.rating) || Number.MAX_SAFE_INTEGER;
    if (p1Rating !== p2Rating) return p1Rating < p2Rating ? player1Handle : player2Handle;

    const p1Registered = Number(p1.registrationTimeSeconds) || 0;
    const p2Registered = Number(p2.registrationTimeSeconds) || 0;
    if (p1Registered !== p2Registered) return p1Registered > p2Registered ? player1Handle : player2Handle;

    return player1Handle;
}

function normalizeBracketHandleToken(value) {
    return String(value || '').trim().toLowerCase();
}

function isPlaceholderBracketHandle(value) {
    return /winner|loser|champion|slot/i.test(String(value || ''));
}

function isByeBracketHandle(value) {
    return normalizeBracketHandleToken(value) === 'bye';
}

function isConcreteBracketHandle(value) {
    const normalized = normalizeBracketHandleToken(value);
    if (!normalized) return false;
    if (isByeBracketHandle(normalized)) return false;
    return !isPlaceholderBracketHandle(normalized);
}

function getWinnerSlotToken(matchId) {
    const parsed = /^m(\d+)$/i.exec(String(matchId || ''));
    if (!parsed) return null;
    return `winner m${parsed[1]}`;
}

function applyWinnerToNextSlots(bracket, sourceMatch, winnerHandle) {
    const winnerToken = getWinnerSlotToken(sourceMatch?.id);
    if (!winnerToken || !winnerHandle || !Array.isArray(bracket?.matches)) return false;

    let changed = false;
    for (const candidate of bracket.matches) {
        if (!candidate || candidate.status === 'completed') continue;

        if (normalizeBracketHandleToken(candidate.p1) === winnerToken) {
            candidate.p1 = winnerHandle;
            changed = true;
        }

        if (normalizeBracketHandleToken(candidate.p2) === winnerToken) {
            candidate.p2 = winnerHandle;
            changed = true;
        }
    }

    return changed;
}

function getLatestCompletedWinnerBySide(bracket, side) {
    const completed = (bracket?.matches || [])
        .filter(match => match?.bracketSide === side && match.status === 'completed' && isConcreteBracketHandle(match.winner))
        .sort((a, b) => Number(b.round || 0) - Number(a.round || 0));

    return completed.length > 0 ? completed[0].winner : null;
}

function applyChampionPlaceholders(bracket) {
    if (!Array.isArray(bracket?.matches)) return false;

    const winnersChampion = getLatestCompletedWinnerBySide(bracket, 'main');
    const losersChampion = getLatestCompletedWinnerBySide(bracket, 'losers');
    let changed = false;

    for (const candidate of bracket.matches) {
        if (!candidate || candidate.status === 'completed') continue;

        if (winnersChampion && normalizeBracketHandleToken(candidate.p1) === 'winners bracket champion') {
            candidate.p1 = winnersChampion;
            changed = true;
        }
        if (winnersChampion && normalizeBracketHandleToken(candidate.p2) === 'winners bracket champion') {
            candidate.p2 = winnersChampion;
            changed = true;
        }

        if (losersChampion && normalizeBracketHandleToken(candidate.p1) === 'losers bracket champion') {
            candidate.p1 = losersChampion;
            changed = true;
        }
        if (losersChampion && normalizeBracketHandleToken(candidate.p2) === 'losers bracket champion') {
            candidate.p2 = losersChampion;
            changed = true;
        }
    }

    return changed;
}

function autoAdvanceBracketByes(bracket) {
    if (!Array.isArray(bracket?.matches)) return false;

    let anyChanged = false;
    let progressed = true;

    while (progressed) {
        progressed = false;

        for (const match of bracket.matches) {
            if (!match || match.status === 'completed') continue;

            const p1 = String(match.p1 || '').trim();
            const p2 = String(match.p2 || '').trim();

            let winner = null;
            if (isByeBracketHandle(p1) && isConcreteBracketHandle(p2)) {
                winner = p2;
            } else if (isByeBracketHandle(p2) && isConcreteBracketHandle(p1)) {
                winner = p1;
            }

            if (!winner) continue;

            match.status = 'completed';
            match.winner = winner;
            match.result = {
                winnerOriginal: winner,
                winnerResolved: winner,
                player1Score: isByeBracketHandle(p1) ? 0 : null,
                player2Score: isByeBracketHandle(p2) ? 0 : null,
                finishedAt: new Date().toISOString(),
                autoAdvanced: 'bye'
            };

            const advanced = applyWinnerToNextSlots(bracket, match, winner);
            const championsUpdated = applyChampionPlaceholders(bracket);

            progressed = progressed || advanced || championsUpdated || true;
            anyChanged = true;
        }

        if (applyChampionPlaceholders(bracket)) {
            progressed = true;
            anyChanged = true;
        }
    }

    return anyChanged;
}

async function updateBracketMatchFromResult(resultPayload) {
    const roomId = resultPayload?.roomId;
    if (!roomId) return;

    const brackets = await readBrackets();
    let changed = false;

    for (const bracket of brackets) {
        if (!Array.isArray(bracket.matches)) continue;

        for (const match of bracket.matches) {
            if (match.roomId !== roomId) continue;

            const p1Handle = match.p1;
            const p2Handle = match.p2;
            const winnerRaw = resultPayload.winner;
            const wasCompleted = match.status === 'completed';

            const payloadP1Handle = normalizeHandle(resultPayload?.player1?.handle);
            const payloadP2Handle = normalizeHandle(resultPayload?.player2?.handle);
            const matchP1Handle = normalizeHandle(p1Handle);
            const matchP2Handle = normalizeHandle(p2Handle);

            let player1Score = resultPayload?.player1?.score ?? null;
            let player2Score = resultPayload?.player2?.score ?? null;

            const payloadOrderMatchesBracket = payloadP1Handle
                && payloadP2Handle
                && payloadP1Handle === matchP1Handle
                && payloadP2Handle === matchP2Handle;

            const payloadOrderReversed = payloadP1Handle
                && payloadP2Handle
                && payloadP1Handle === matchP2Handle
                && payloadP2Handle === matchP1Handle;

            if (payloadOrderReversed && !payloadOrderMatchesBracket) {
                const swapped = player1Score;
                player1Score = player2Score;
                player2Score = swapped;
            }

            let winnerHandle = winnerRaw;
            if (winnerRaw === 'tie') {
                winnerHandle = await resolveTieWinnerByRules(p1Handle, p2Handle);
            }

            match.status = 'completed';
            match.winner = winnerHandle;
            match.result = {
                winnerOriginal: winnerRaw,
                winnerResolved: winnerHandle,
                player1Score,
                player2Score,
                finishedAt: resultPayload?.date || new Date().toISOString()
            };

            if (!wasCompleted) {
                const propagated = applyWinnerToNextSlots(bracket, match, winnerHandle);
                const championUpdated = applyChampionPlaceholders(bracket);
                const autoByeAdvanced = autoAdvanceBracketByes(bracket);

                if (propagated || championUpdated || autoByeAdvanced) {
                    changed = true;
                }
            }

            changed = true;
        }
    }

    if (changed) {
        await writeBrackets(brackets);
    }
}

// Generate random room ID
function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function roomNameTaken(name) {
    const normalized = (name || '').trim().toLowerCase();
    if (!normalized) return false;
    return Array.from(rooms.values()).some(room => room.name.toLowerCase() === normalized);
}

function getConnectedPlayersCount(room) {
    return room.players.filter(player => !!player.ws).length;
}

function getAssignedPlayersCount(room) {
    return room.players.filter(player => !!player.handle).length;
}

function isBattleRunning(room) {
    if (!room.battleState) return false;
    return room.battleState.status === 'running' && Date.now() < room.battleState.endsAt;
}

function isBattleEnded(room) {
    if (!room.battleState) return false;
    return room.battleState.status === 'ended' || Date.now() >= room.battleState.endsAt;
}

function isRoomExpired(room) {
    if (!room.battleState || !room.battleState.cleanupAt) return false;
    return Date.now() >= room.battleState.cleanupAt;
}

function sendToRoom(room, message) {
    const payload = {
        serverNow: Date.now(),
        ...message
    };

    room.players.forEach(player => {
        if (player.ws && player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(JSON.stringify(payload));
        }
    });
}

function extractAdminPassword(req) {
    const passwordFromHeader = req.headers['x-admin-password'];
    if (typeof passwordFromHeader === 'string') {
        return passwordFromHeader;
    }

    if (req.body && typeof req.body.password === 'string') {
        return req.body.password;
    }

    return '';
}

function parseCookieHeader(cookieHeader) {
    const source = typeof cookieHeader === 'string' ? cookieHeader : '';
    if (!source.trim()) return {};

    const parsed = {};
    source.split(';').forEach(pair => {
        const idx = pair.indexOf('=');
        if (idx === -1) return;
        const key = pair.slice(0, idx).trim();
        if (!key) return;
        const value = pair.slice(idx + 1).trim();
        try {
            parsed[key] = decodeURIComponent(value);
        } catch {
            parsed[key] = value;
        }
    });
    return parsed;
}

function areEqualSafe(a, b) {
    const left = Buffer.from(String(a || ''), 'utf8');
    const right = Buffer.from(String(b || ''), 'utf8');
    if (left.length !== right.length) return false;
    return crypto.timingSafeEqual(left, right);
}

function signSessionId(sessionId) {
    return crypto
        .createHmac('sha256', SESSION_SECRET)
        .update(String(sessionId || ''))
        .digest('hex');
}

function createSessionCookieValue(sessionId) {
    const id = String(sessionId || '').trim();
    if (!id) return '';
    return `${id}.${signSessionId(id)}`;
}

function shouldUseSecureCookies() {
    const flag = String(process.env.BLITZ_SECURE_COOKIES || '').trim().toLowerCase();
    if (!flag) return false;
    return flag === '1' || flag === 'true' || flag === 'yes';
}

function readSessionIdFromRequest(req) {
    const cookies = parseCookieHeader(req.headers?.cookie || '');
    const raw = String(cookies[SESSION_COOKIE_NAME] || '').trim();
    if (!raw) return '';

    const dot = raw.lastIndexOf('.');
    if (dot <= 0) return '';

    const sessionId = raw.slice(0, dot);
    const providedSig = raw.slice(dot + 1);
    const expectedSig = signSessionId(sessionId);
    if (!areEqualSafe(providedSig, expectedSig)) return '';
    return sessionId;
}

function setSessionCookie(res, sessionId, maxAgeMs = SESSION_MAX_AGE_MS) {
    const cookieValue = createSessionCookieValue(sessionId);
    if (!cookieValue) return;

    const maxAge = Math.max(0, Number(maxAgeMs) || 0);
    const parts = [
        `${SESSION_COOKIE_NAME}=${encodeURIComponent(cookieValue)}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${Math.floor(maxAge / 1000)}`
    ];

    if (shouldUseSecureCookies()) {
        parts.push('Secure');
    }

    res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
    const parts = [
        `${SESSION_COOKIE_NAME}=`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        'Max-Age=0'
    ];

    if (shouldUseSecureCookies()) {
        parts.push('Secure');
    }

    res.setHeader('Set-Cookie', parts.join('; '));
}

function createServerSession(handle) {
    const canonicalHandle = String(handle || '').trim();
    const normalizedHandle = normalizeHandle(canonicalHandle);
    if (!normalizedHandle) return null;

    const now = Date.now();
    const sessionId = crypto.randomBytes(32).toString('hex');
    const entry = {
        id: sessionId,
        handle: canonicalHandle,
        createdAt: now,
        expiresAt: now + SESSION_MAX_AGE_MS
    };
    sessionStore.set(sessionId, entry);
    return entry;
}

function getServerSession(req) {
    const sessionId = readSessionIdFromRequest(req);
    if (!sessionId) return null;

    const entry = sessionStore.get(sessionId);
    if (!entry) return null;
    if (Date.now() > Number(entry.expiresAt || 0)) {
        sessionStore.delete(sessionId);
        return null;
    }

    return entry;
}

function destroyServerSession(req) {
    const sessionId = readSessionIdFromRequest(req);
    if (!sessionId) return;
    sessionStore.delete(sessionId);
}

function cleanupExpiredSessions() {
    const now = Date.now();
    for (const [sid, entry] of sessionStore.entries()) {
        if (now > Number(entry?.expiresAt || 0)) {
            sessionStore.delete(sid);
        }
    }
}

function createSessionChallenge(handle, problem) {
    const canonicalHandle = String(handle || '').trim();
    const normalizedHandle = normalizeHandle(canonicalHandle);
    if (!normalizedHandle || !problem || !problem.contestId || !problem.index) return null;

    const issuedAtMs = Date.now();
    const id = crypto.randomBytes(24).toString('hex');
    const entry = {
        id,
        handle: canonicalHandle,
        issuedAtMs,
        issuedAtSec: Math.floor(issuedAtMs / 1000),
        expiresAtMs: issuedAtMs + SESSION_CHALLENGE_TTL_MS,
        problem: {
            contestId: Number(problem.contestId),
            index: String(problem.index || '').trim().toUpperCase(),
            name: String(problem.name || '').trim(),
            rating: Number(problem.rating) || null,
            url: String(problem.url || '').trim()
        }
    };

    sessionChallengeStore.set(id, entry);
    return entry;
}

function getSessionChallenge(challengeId) {
    const id = String(challengeId || '').trim();
    if (!id) return null;

    const entry = sessionChallengeStore.get(id);
    if (!entry) return null;
    if (Date.now() > Number(entry.expiresAtMs || 0)) {
        sessionChallengeStore.delete(id);
        return null;
    }

    return entry;
}

function consumeSessionChallenge(challengeId) {
    const entry = getSessionChallenge(challengeId);
    if (!entry) return null;
    sessionChallengeStore.delete(entry.id);
    return entry;
}

function cleanupExpiredSessionChallenges() {
    const now = Date.now();
    for (const [id, entry] of sessionChallengeStore.entries()) {
        if (now > Number(entry?.expiresAtMs || 0)) {
            sessionChallengeStore.delete(id);
        }
    }
}

function extractRequesterHandle(req) {
    const session = getServerSession(req);
    return session?.handle || '';
}

function hashAdminToken(value, salt) {
    return crypto.createHash('sha256').update(`${salt}:${value}`).digest('hex');
}

function isDeveloperAdminHandle(handle) {
    const normalized = normalizeHandle(handle);
    if (!normalized) return false;
    const hashed = hashAdminToken(normalized, ADMIN_HANDLE_HASH_SALT);
    return ADMIN_HANDLE_HASHES.has(hashed);
}

function getClientAddressForThrottle(req) {
    const forwarded = String(req?.headers?.['x-forwarded-for'] || '').trim();
    if (forwarded) {
        const first = forwarded.split(',')[0].trim();
        if (first) return first;
    }

    const ip = String(req?.ip || req?.socket?.remoteAddress || '').trim();
    return ip || 'unknown';
}

function getAdminPinAttemptKey(req, requesterHandle) {
    const normalizedHandle = normalizeHandle(requesterHandle);
    const clientAddress = getClientAddressForThrottle(req);
    return `${normalizedHandle}|${clientAddress}`;
}

function getAdminPinThrottleState(req, requesterHandle) {
    if (!isDeveloperAdminHandle(requesterHandle)) {
        return { blocked: false, retryAfterMs: 0 };
    }

    const key = getAdminPinAttemptKey(req, requesterHandle);
    const state = adminPinAttempts.get(key);
    const now = Date.now();
    if (!state || !state.lockUntil || now >= state.lockUntil) {
        return { blocked: false, retryAfterMs: 0 };
    }

    return {
        blocked: true,
        retryAfterMs: Math.max(0, state.lockUntil - now)
    };
}

function registerAdminPinAttempt(req, requesterHandle, suppliedPassword) {
    const password = String(suppliedPassword || '').trim();
    if (!password) return false;
    if (!isDeveloperAdminHandle(requesterHandle)) return false;

    const key = getAdminPinAttemptKey(req, requesterHandle);
    const now = Date.now();
    const state = adminPinAttempts.get(key) || { failedCount: 0, lockUntil: 0 };

    if (state.lockUntil && now < state.lockUntil) {
        return false;
    }

    const valid = isValidAdminPassword(password);
    if (valid) {
        adminPinAttempts.delete(key);
        return true;
    }

    state.failedCount = Number(state.failedCount || 0) + 1;
    if (state.failedCount >= ADMIN_PIN_MAX_FAILED_ATTEMPTS) {
        state.failedCount = 0;
        state.lockUntil = now + ADMIN_PIN_LOCK_MS;
    } else {
        state.lockUntil = 0;
    }
    adminPinAttempts.set(key, state);
    return false;
}

function isAdminRequester(requesterHandle, adminPassword = '', req = null) {
    if (!isDeveloperAdminHandle(requesterHandle)) return false;

    const supplied = String(adminPassword || '').trim();
    if (!supplied) return false;

    if (req) {
        const throttle = getAdminPinThrottleState(req, requesterHandle);
        if (throttle.blocked) return false;
        return registerAdminPinAttempt(req, requesterHandle, supplied);
    }

    return isValidAdminPassword(supplied);
}

function isValidAdminPassword(input) {
    if (typeof input !== 'string' || !input.trim()) return false;

    const inputHash = hashAdminToken(input.trim(), ADMIN_PIN_HASH_SALT);
    const inputBuffer = Buffer.from(inputHash);
    const adminBuffer = Buffer.from(ADMIN_PIN_HASH);
    if (inputBuffer.length !== adminBuffer.length) return false;

    return crypto.timingSafeEqual(inputBuffer, adminBuffer);
}

function getFirstTwoConnectedHandles(room) {
    const handles = room.players
        .filter(player => player.handle && player.ws && player.ws.readyState === WebSocket.OPEN)
        .map(player => player.handle);
    if (handles.length < 2) return null;
    return [handles[0], handles[1]];
}

function getAutoStartPair(room) {
    const handles = room.players
        .filter(player => player.handle && player.ws && player.ws.readyState === WebSocket.OPEN)
        .map(player => String(player.handle).trim().toLowerCase());

    const host = String(room.host || '').trim().toLowerCase();
    const opponent = String(room.opponentHandle || '').trim().toLowerCase();

    if (room.opponentHandle) {
        if (!handles.includes(host)) {
            return { pair: null, waitMessage: 'Waiting for host to be connected.' };
        }
        if (!handles.includes(opponent)) {
            return { pair: null, waitMessage: `Waiting for selected opponent ${room.opponentHandle} to join room.` };
        }
        // Return original-cased handles for UI
        return { pair: [room.host, room.opponentHandle], waitMessage: '' };
    }

    if (handles.length < 2) {
        return { pair: null, waitMessage: 'Waiting for match creator and opponent to be connected.' };
    }

    // Find original-cased handles for the first two
    const originalHandles = room.players
        .filter(player => player.handle && player.ws && player.ws.readyState === WebSocket.OPEN)
        .map(player => player.handle);
    return { pair: [originalHandles[0], originalHandles[1]], waitMessage: '' };
}

function broadcastValidationStatus(room, payload) {
    sendToRoom(room, {
        type: 'VALIDATION_STATUS',
        roomId: room.id,
        ...payload
    });
}

function finalizeBattle(room, reason = 'timer') {
    if (!room || !room.battleState) return;
    if (room.battleState.status === 'ended') return;

    if (room.breakAdvanceTimeout) {
        clearTimeout(room.breakAdvanceTimeout);
        room.breakAdvanceTimeout = null;
    }

    const now = Date.now();
    room.battleState.status = 'ended';
    room.battleState.endedAt = now;
    room.battleState.endReason = reason;
    room.battleState.endsAt = now;
    room.battleState.cleanupAt = now + ROOM_CLEANUP_DELAY_MS;

    if (room.endTimeout) {
        clearTimeout(room.endTimeout);
        room.endTimeout = null;
    }

    scheduleRoomCleanup(room);

    sendToRoom(room, {
        type: 'BATTLE_FINISHED',
        roomId: room.id,
        battleState: room.battleState
    });

    broadcastActiveRooms();
}

function analyzeServerSubmissionsForProblem(submissionData, problem, deadlineMs = null, minMs = null) {
    const analysis = {
        accepted: null,
        hasPending: false
    };

    if (!submissionData || submissionData.status !== 'OK' || !Array.isArray(submissionData.result) || !problem) {
        return analysis;
    }

    for (const sub of submissionData.result) {
        if (!sub?.problem) continue;
        const sameProblem = sub.problem.contestId === problem.contestId && sub.problem.index === problem.index;
        if (!sameProblem) continue;

        const submitMs = (sub.creationTimeSeconds || 0) * 1000;
        if (deadlineMs && submitMs && submitMs > deadlineMs) continue;
        if (minMs && submitMs && submitMs < minMs) continue;

        if (sub.verdict === 'OK') {
            if (!analysis.accepted || submitMs < analysis.accepted.submitMs) {
                analysis.accepted = { submitMs, submissionId: sub.id };
            }
            continue;
        }

        if (sub.verdict === null || sub.verdict === undefined || sub.verdict === 'TESTING' || sub.verdict === 'QUEUED') {
            analysis.hasPending = true;
        }
    }

    return analysis;
}

async function verifyTimerEndSubmissions(room) {
    if (!room?.battleState || room.battleState.status !== 'running') return;

    const deadlineMs = room.battleState.endsAt;
    const liveState = room.battleState.liveState || {};
    const currentProblemNumber = Number(liveState.currentProblemNumber) || 0;
    const currentProblem = liveState.currentProblem
        || room.battleState.selectedProblems?.[Math.max(0, currentProblemNumber - 1)]
        || null;

    if (!currentProblem || !currentProblem.contestId || !currentProblem.index) {
        finalizeBattle(room, 'timer');
        return;
    }

    const p1 = room.battleState.player1Handle;
    const p2 = room.battleState.player2Handle;
    const minMs = Number(liveState.updatedAt) || Number(room.battleState.startsAt) || 0;

    const maxWaitMs = 90 * 1000;
    const startedAt = Date.now();

    while (Date.now() - startedAt <= maxWaitMs) {
        const [p1Data, p2Data] = await Promise.all([
            fetchJson(`https://codeforces.com/api/user.status?handle=${encodeURIComponent(p1)}&from=1&count=100`),
            fetchJson(`https://codeforces.com/api/user.status?handle=${encodeURIComponent(p2)}&from=1&count=100`)
        ]);

        const p1Analysis = analyzeServerSubmissionsForProblem(p1Data, currentProblem, deadlineMs, minMs);
        const p2Analysis = analyzeServerSubmissionsForProblem(p2Data, currentProblem, deadlineMs, minMs);

        let solverHandle = null;
        if (p1Analysis.accepted || p2Analysis.accepted) {
            if (!p2Analysis.accepted || (p1Analysis.accepted && p1Analysis.accepted.submitMs <= p2Analysis.accepted.submitMs)) {
                solverHandle = p1;
            } else {
                solverHandle = p2;
            }
        }

        if (solverHandle) {
            const key = `${currentProblemNumber}:${currentProblem.id || `${currentProblem.contestId}${currentProblem.index}`}`;
            if (!room.battleState.problemWinners) room.battleState.problemWinners = {};
            if (!room.battleState.solveAnnouncements) room.battleState.solveAnnouncements = {};

            if (!room.battleState.problemWinners[key]) {
                room.battleState.problemWinners[key] = solverHandle;
                const solveKey = `${currentProblem.id || `${currentProblem.contestId}${currentProblem.index}`}:${solverHandle}`;
                room.battleState.solveAnnouncements[solveKey] = true;

                // Persist solve timestamp to results.json
                (async () => {
                    try {
                        const resultsPath = RESULTS_FILE;
                        const resultsRaw = await fs.readFile(resultsPath, 'utf8');
                        const results = JSON.parse(resultsRaw);
                        const match = results.find(m => m.roomId === room.id);
                        if (match && Array.isArray(match.problems)) {
                            const prob = match.problems.find(p => p.id === (currentProblem.id || `${currentProblem.contestId}${currentProblem.index}`));
                            if (prob) {
                                const nowSec = Math.floor(Date.now() / 1000);
                                if (prob.p1Result && normalizeHandle(solverHandle) === normalizeHandle(room.battleState.player1Handle)) {
                                    prob.p1Result.solvedAtSec = nowSec;
                                }
                                if (prob.p2Result && normalizeHandle(solverHandle) === normalizeHandle(room.battleState.player2Handle)) {
                                    prob.p2Result.solvedAtSec = nowSec;
                                }
                                await fs.writeFile(resultsPath, JSON.stringify(results, null, 2));
                            }
                        }
                    } catch (err) {
                        console.error('Failed to persist solve timestamp:', err);
                    }
                })();

                sendToRoom(room, {
                    type: 'PROBLEM_SOLVED',
                    roomId: room.id,
                    solverHandle,
                    problemId: currentProblem.id || `${currentProblem.contestId}${currentProblem.index}`,
                    problemNumber: currentProblemNumber,
                    solveKey
                });
            }
        }

        const hasPending = p1Analysis.hasPending || p2Analysis.hasPending;
        if (!hasPending) {
            break;
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    finalizeBattle(room, 'timer');
}

function getRoomPublicState(room) {
    return {
        id: room.id,
        name: room.name,
        opponentHandle: room.opponentHandle,
        duration: room.duration,
        interval: room.interval,
        problems: room.problems,
        validationProblem: room.validationProblem,
        countdownInProgress: !!room.countdownInProgress,
        countdownEndsAt: room.countdownEndsAt || null,
        players: room.players.filter(player => !!player.handle).map(player => player.handle),
        battleState: room.battleState
    };
}

function getConnectedHandles(room) {
    return room.players
        .filter(player => !!player.handle && !!player.ws && player.ws.readyState === WebSocket.OPEN)
        .map(player => player.handle);
}

async function fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

async function fetchCodeforcesUserProfile(handle) {
    const cleanHandle = String(handle || '').trim();
    if (!cleanHandle) return null;

    const data = await fetchJson(`https://codeforces.com/api/user.info?handles=${encodeURIComponent(cleanHandle)}`);
    if (data.status !== 'OK' || !Array.isArray(data.result) || !data.result[0]) {
        return null;
    }

    return data.result[0];
}

async function validateHandle(handle) {
    const profile = await fetchCodeforcesUserProfile(handle);
    return !!profile;
}

async function hasCompilationErrorOnProblem(handle, validationProblem, minCreationTimeSec = 0) {
    if (!validationProblem) return false;
    const data = await fetchJson(`https://codeforces.com/api/user.status?handle=${encodeURIComponent(handle)}&from=1&count=100`);
    if (data.status !== 'OK') return false;

    return data.result.some(sub => {
        if (!sub.problem) return false;
        const createdAtSec = Number(sub.creationTimeSeconds) || 0;
        if (minCreationTimeSec && createdAtSec < Number(minCreationTimeSec)) return false;
        return (
            sub.verdict === 'COMPILATION_ERROR' &&
            sub.problem.contestId === validationProblem.contestId &&
            sub.problem.index === validationProblem.index
        );
    });
}

async function generateValidationProblem() {
    const source = await fetchJson('https://codeforces.com/api/problemset.problems?tags=implementation');
    if (source.status !== 'OK') {
        throw new Error('Failed to fetch Codeforces problemset');
    }

    const all = source.result.problems.filter(p => p.contestId && p.index && p.rating);
    const pool = all.filter(p => p.rating >= 800 && p.rating <= 1500);
    if (pool.length === 0) {
        throw new Error('No validation problem available');
    }

    const chosen = pool[Math.floor(Math.random() * pool.length)];
    return {
        id: `${chosen.contestId}${chosen.index}`,
        contestId: chosen.contestId,
        index: chosen.index,
        name: chosen.name,
        rating: chosen.rating,
        url: `https://codeforces.com/problemset/problem/${chosen.contestId}/${chosen.index}`,
        generatedAtSec: Math.floor(Date.now() / 1000)
    };
}

async function generateRoomProblems(configProblems = [], excludedIds = []) {
    const source = await fetchJson('https://codeforces.com/api/problemset.problems?tags=implementation');
    if (source.status !== 'OK') {
        throw new Error('Failed to fetch Codeforces problemset');
    }

    const all = source.result.problems.filter(p => p.contestId && p.index && p.rating);
    const usedIds = new Set(excludedIds || []);
    const selected = [];

    for (const cfg of configProblems) {
        const targetRating = cfg.rating || 1200;
        const candidates = all.filter(p => !usedIds.has(`${p.contestId}${p.index}`) && Math.abs(p.rating - targetRating) <= 100);
        const fallback = all.filter(p => !usedIds.has(`${p.contestId}${p.index}`) && p.rating >= 800 && p.rating <= 2000);
        const pool = candidates.length > 0 ? candidates : fallback;
        if (pool.length === 0) {
            throw new Error('No problems available to generate battle set');
        }

        const chosen = pool[Math.floor(Math.random() * pool.length)];
        const id = `${chosen.contestId}${chosen.index}`;
        usedIds.add(id);
        selected.push({
            id,
            contestId: chosen.contestId,
            index: chosen.index,
            name: chosen.name,
            rating: chosen.rating,
            url: `https://codeforces.com/problemset/problem/${chosen.contestId}/${chosen.index}`,
            points: cfg.points || 500
        });
    }

    return selected;
}

async function generateRoomProblemForConfig(configProblem = {}, excludedIds = []) {
    const generated = await generateRoomProblems([configProblem], excludedIds);
    if (!generated.length) {
        throw new Error('Failed to generate next problem');
    }
    return generated[0];
}

async function ensureFirstProblemReady(room) {
    if (!room || !Array.isArray(room.problems) || room.problems.length === 0) return;

    const existingLive = room?.battleState?.selectedProblems?.[0];
    if (existingLive) return;
    if (room.preGeneratedFirstProblem) return;
    if (room.firstProblemGenerationInProgress) return;

    room.firstProblemGenerationInProgress = true;
    try {
        const excludedIds = Array.from(new Set([
            ...(room.validationProblem ? [room.validationProblem.id] : []),
            ...((Array.isArray(room.bracketExcludedProblemIds) ? room.bracketExcludedProblemIds : []).map(id => String(id || '').trim()).filter(Boolean))
        ]));

        const usedProblemIds = Array.isArray(room?.battleState?.usedProblemIds)
            ? room.battleState.usedProblemIds
            : [];
        const generated = await generateRoomProblemForConfig(room.problems[0] || { points: 500, rating: 1200 }, [...excludedIds, ...usedProblemIds]);

        const targetRoom = rooms.get(room.id);
        if (!targetRoom) return;

        if (targetRoom.battleState && targetRoom.battleState.status === 'running') {
            if (!Array.isArray(targetRoom.battleState.selectedProblems)) {
                targetRoom.battleState.selectedProblems = Array.from({ length: targetRoom.problems.length }, () => null);
            }

            if (!targetRoom.battleState.selectedProblems[0]) {
                targetRoom.battleState.selectedProblems[0] = generated;

                if (!Array.isArray(targetRoom.battleState.usedProblemIds)) {
                    targetRoom.battleState.usedProblemIds = [];
                }
                if (!targetRoom.battleState.usedProblemIds.includes(generated.id)) {
                    targetRoom.battleState.usedProblemIds.push(generated.id);
                }

                if (targetRoom.bracketId) {
                    await reserveBracketProblemIds(targetRoom.bracketId, [generated.id]);
                }

                if (!targetRoom.battleState.liveState || Number(targetRoom.battleState.liveState.currentProblemNumber) === 0) {
                    targetRoom.battleState.liveState = {
                        currentProblemNumber: 1,
                        currentProblem: generated,
                        problemLocked: false,
                        solvedBy: null,
                        breakStartsAt: null,
                        breakEndsAt: null,
                        updatedAt: Date.now()
                    };
                }

                sendToRoom(targetRoom, {
                    type: 'NEXT_PROBLEM_READY',
                    roomId: targetRoom.id,
                    problemNumber: 1,
                    problem: generated
                });
            }

            return;
        }

        targetRoom.preGeneratedFirstProblem = generated;
    } catch (error) {
        console.error('Failed to generate first problem:', error);
    } finally {
        const targetRoom = rooms.get(room.id);
        if (targetRoom) {
            targetRoom.firstProblemGenerationInProgress = false;
        }
    }
}

async function startBattleForPair(room, startP1, startP2) {
    if (!room || (room.battleState && room.battleState.status === 'running')) return;

    if (room.noOpponentTimeout) {
        clearTimeout(room.noOpponentTimeout);
        room.noOpponentTimeout = null;
    }

    if (room.unstartedTimeout) {
        clearTimeout(room.unstartedTimeout);
        room.unstartedTimeout = null;
    }

    const excludedIds = Array.from(new Set([
        ...(room.validationProblem ? [room.validationProblem.id] : []),
        ...((Array.isArray(room.bracketExcludedProblemIds) ? room.bracketExcludedProblemIds : []).map(id => String(id || '').trim()).filter(Boolean))
    ]));

    const reservedProblems = Array.isArray(room.preGeneratedProblems) && room.preGeneratedProblems.length > 0
        ? [room.preGeneratedProblems[0]].filter(Boolean)
        : [];

    let firstProblem = room.preGeneratedFirstProblem || reservedProblems[0] || null;
    if (firstProblem?.id && room.validationProblem?.id && firstProblem.id === room.validationProblem.id) {
        firstProblem = null;
    }
    room.preGeneratedFirstProblem = null;

    const selectedProblems = Array.from({ length: room.problems.length }, () => null);
    if (firstProblem) {
        selectedProblems[0] = firstProblem;
    }

    const usedProblemIds = Array.from(new Set([
        ...excludedIds,
        ...selectedProblems.filter(Boolean).map(problem => problem.id).filter(Boolean)
    ]));

    if (room.bracketId) {
        await reserveBracketProblemIds(
            room.bracketId,
            selectedProblems.filter(Boolean).map(problem => problem.id).filter(Boolean)
        );
    }

    const startsAt = Date.now();
    const endsAt = startsAt + (room.duration * 60 * 1000);
    const cleanupAt = endsAt + ROOM_CLEANUP_DELAY_MS;

    room.battleState = {
        status: 'running',
        startsAt,
        endsAt,
        cleanupAt,
        player1Handle: startP1,
        player2Handle: startP2,
        selectedProblems,
        usedProblemIds,
        problemConfigs: room.problems,
        generatedProblemLocks: {},
        problemWinners: {},
        solveAnnouncements: {},
        liveState: {
            currentProblemNumber: firstProblem ? 1 : 0,
            currentProblem: firstProblem || null,
            problemLocked: false,
            solvedBy: null,
            breakStartsAt: null,
            breakEndsAt: null,
            updatedAt: Date.now()
        },
        duration: room.duration,
        interval: room.interval,
        roomId: room.id
    };

    if (room.endTimeout) {
    saveRoomsToDisk(rooms);
        clearTimeout(room.endTimeout);
    }

    room.endTimeout = setTimeout(() => {
        const targetRoom = rooms.get(room.id);
        if (!targetRoom || !targetRoom.battleState) return;
        verifyTimerEndSubmissions(targetRoom).catch(error => {
            console.error('Timer-end submission verification failed:', error);
            finalizeBattle(targetRoom, 'timer');
        });
    }, Math.max(0, endsAt - Date.now()));

    scheduleRoomCleanup(room);

    sendToRoom(room, {
        type: 'BATTLE_STARTED',
        roomId: room.id,
        battleState: room.battleState
    });

    if (!firstProblem) {
        ensureFirstProblemReady(room).catch(() => {});
    }

    broadcastActiveRooms();
}

async function evaluateRoomValidationAndAutoStart(room) {
    if (!room) {
        console.log('[DEBUG] evaluateRoomValidationAndAutoStart: No room');
        return;
    }
    if (room.battleState && room.battleState.status === 'running') {
        console.log('[DEBUG] evaluateRoomValidationAndAutoStart: Battle already running');
        return;
    }
    if (isBattleEnded(room) || isRoomExpired(room)) {
        console.log('[DEBUG] evaluateRoomValidationAndAutoStart: Battle ended or room expired');
        return;
    }
    if (room.validationCheckInProgress || room.startInProgress || room.countdownInProgress) {
        console.log('[DEBUG] evaluateRoomValidationAndAutoStart: Validation/start/countdown in progress');
        return;
    }

    // --- CE error waiting logic commented out ---
    // Instead, require both players to click a start button to begin the match

    const { pair, waitMessage } = getAutoStartPair(room);
    if (!pair) {
        console.log('[DEBUG] evaluateRoomValidationAndAutoStart: No pair found');
        broadcastValidationStatus(room, {
            pair: [],
            statuses: {},
            message: waitMessage || 'Waiting for two participants to join room.'
        });
        return;
    }

    // Track ready state for both players (normalize handles)
    if (!room.playerReady) room.playerReady = {};
    const [p1, p2] = pair;
    const normP1 = String(p1 || '').trim().toLowerCase();
    const normP2 = String(p2 || '').trim().toLowerCase();
    const ready1 = !!room.playerReady[normP1];
    const ready2 = !!room.playerReady[normP2];
    console.log(`[DEBUG] evaluateRoomValidationAndAutoStart: normP1=${normP1}, ready1=${ready1}, normP2=${normP2}, ready2=${ready2}`);

    let message = 'Waiting for both players to click Start Match.';
    if (ready1 && !ready2) message = `Waiting for ${p2} to click Start Match.`;
    if (!ready1 && ready2) message = `Waiting for ${p1} to click Start Match.`;
    if (ready1 && ready2) message = `Both players ready. Match starts in ${Math.round(MATCH_START_COUNTDOWN_MS / 1000)} seconds.`;

    // Always use lowercased keys for statuses, but show original handles in UI
    const statuses = {};
    statuses[p1] = !!room.playerReady[String(p1).trim().toLowerCase()];
    statuses[p2] = !!room.playerReady[String(p2).trim().toLowerCase()];
    broadcastValidationStatus(room, {
        pair,
        statuses,
        message
    });

    if (ready1 && ready2 && !room.countdownInProgress) {
        console.log(`[COUNTDOWN] Both players ready in room ${room.id}. Starting countdown.`);
        room.countdownInProgress = true;
        room.countdownEndsAt = Date.now() + MATCH_START_COUNTDOWN_MS;
        ensureFirstProblemReady(room).catch((e) => { console.log('[DEBUG] ensureFirstProblemReady error:', e); });
        sendToRoom(room, {
            type: 'MATCH_COUNTDOWN_STARTED',
            roomId: room.id,
            startsAt: room.countdownEndsAt,
            seconds: Math.round(MATCH_START_COUNTDOWN_MS / 1000),
            pair: [p1, p2]
        });
        // Server-side countdown: after 15s, start match regardless of client state
        room.countdownTimeout = setTimeout(async () => {
            const targetRoom = rooms.get(room.id);
            if (!targetRoom) {
                console.log('[DEBUG] Countdown timeout: targetRoom not found');
                return;
            }
            if (targetRoom.battleState && targetRoom.battleState.status === 'running') {
                console.log('[DEBUG] Countdown timeout: battle already running');
                return;
            }
            // Always start match after countdown, even if no clients are connected
            targetRoom.startInProgress = true;
            try {
                console.log(`[BATTLE] [SERVER] Starting battle for pair ${p1}, ${p2} in room ${room.id} after countdown (server-side)`);
                await startBattleForPair(targetRoom, p1, p2);
            } catch (error) {
                console.error('Failed to start battle after countdown:', error);
            } finally {
                targetRoom.startInProgress = false;
                targetRoom.countdownInProgress = false;
                targetRoom.countdownEndsAt = null;
                targetRoom.countdownTimeout = null;
            }
        }, MATCH_START_COUNTDOWN_MS);
    } else {
        if (!ready1 || !ready2) {
            console.log('[DEBUG] Not both players ready:', { ready1, ready2, normP1, normP2, playerReady: room.playerReady });
        }
        if (room.countdownInProgress) {
            console.log('[DEBUG] Countdown already in progress for room', room.id);
        }
    }
}

function scheduleRoomCleanup(room) {
    if (!room.battleState || !room.battleState.cleanupAt) return;
    if (room.cleanupTimeout) {
        clearTimeout(room.cleanupTimeout);
    }

    const delay = Math.max(0, room.battleState.cleanupAt - Date.now());
    room.cleanupTimeout = setTimeout(() => {
        const currentRoom = rooms.get(room.id);
        if (!currentRoom) return;

        if (currentRoom.pendingSubmissionActive) {
            currentRoom.battleState.cleanupAt = Date.now() + ROOM_PENDING_RECHECK_DELAY_MS;
            scheduleRoomCleanup(currentRoom);
            return;
        }

        sendToRoom(currentRoom, {
            type: 'ROOM_CLOSED',
            roomId: currentRoom.id,
            message: 'This blitz room has ended and moved to past results.'
        });

        rooms.delete(currentRoom.id);
        saveRoomsToDisk(rooms);
        broadcastActiveRooms();
    }, delay);
}

async function clearStaleBracketRoomReference(room) {
    if (!room?.bracketId || !room?.bracketMatchId) return;

    const brackets = await readBrackets();
    const bracket = brackets.find(item => item.id === room.bracketId);
    if (!bracket || !Array.isArray(bracket.matches)) return;

    const match = bracket.matches.find(item => item.id === room.bracketMatchId);
    if (!match) return;
    if (match.status === 'completed') return;
    if (String(match.roomId || '') !== String(room.id || '')) return;

    match.roomId = null;
    await writeBrackets(brackets);
}

async function closeUnstartedRoom(room, message) {
    if (!room) return;

    const currentRoom = rooms.get(room.id);
    if (!currentRoom) return;
    if (currentRoom.battleState) return;

    if (currentRoom.noOpponentTimeout) {
        clearTimeout(currentRoom.noOpponentTimeout);
        currentRoom.noOpponentTimeout = null;
    }

    if (currentRoom.unstartedTimeout) {
        clearTimeout(currentRoom.unstartedTimeout);
        currentRoom.unstartedTimeout = null;
    }

    if (currentRoom.countdownTimeout) {
        clearTimeout(currentRoom.countdownTimeout);
        currentRoom.countdownTimeout = null;
    }

    currentRoom.countdownInProgress = false;
    currentRoom.countdownEndsAt = null;

    sendToRoom(currentRoom, {
        type: 'ROOM_CLOSED',
        roomId: currentRoom.id,
        message
    });

    rooms.delete(currentRoom.id);
    saveRoomsToDisk(rooms);

    try {
        await clearStaleBracketRoomReference(currentRoom);
    } catch (error) {
        console.error('Failed to clear stale bracket room reference:', error);
    }

    broadcastActiveRooms();
}

function cleanupUnstartedRoomIfHostLeft(room, leftHandle) {
    if (!room || room.battleState) return false;
    if (normalizeHandle(leftHandle) !== normalizeHandle(room.host)) return false;

    return false;
}

function normalizeRoomProblems(problems = [], problemCount = 7) {
    if (Array.isArray(problems) && problems.length > 0) {
        return problems.map(problem => ({
            points: Math.max(1, Number(problem?.points) || 1),
            rating: Math.max(800, Math.min(3500, Number(problem?.rating) || 800))
        }));
    }

    return buildDefaultProblems(problemCount);
}

function createRoomWithSharedLogic({
    hostHandle,
    hostWs = null,
    opponentHandle,
    roomName,
    duration = 40,
    interval = 1,
    problems = [],
    problemCount = 7,
    validationFailureMessage = 'Validation problem generation failed. Please recreate room.',
    preGeneratedProblems = [],
    bracketId = null,
    bracketMatchId = null,
    bracketExcludedProblemIds = []
}) {
    const roomId = generateRoomId();
    const validationProblem = null;
    const normalizedProblems = normalizeRoomProblems(problems, problemCount);

    const room = {
        id: roomId,
        name: roomName,
        players: [
            { handle: hostHandle, ws: hostWs }
        ],
        host: hostHandle,
        hostHandle: hostHandle, // Ensure hostHandle property is set
        opponentHandle,
        duration,
        interval,
        problems: normalizedProblems,
        validationProblem,
        battleState: null,
        createdAt: Date.now(),
        endTimeout: null,
        cleanupTimeout: null,
        noOpponentTimeout: null,
        unstartedTimeout: null,
        countdownTimeout: null,
        countdownEndsAt: null,
        countdownInProgress: false,
        firstProblemGenerationInProgress: false,
        preGeneratedFirstProblem: null,
        preGeneratedProblems: Array.isArray(preGeneratedProblems) ? preGeneratedProblems : [],
        bracketId: bracketId || null,
        bracketMatchId: bracketMatchId || null,
        bracketExcludedProblemIds: Array.isArray(bracketExcludedProblemIds) ? bracketExcludedProblemIds : [],
        pendingSubmissionActive: false,
        validationCheckInProgress: false,
        startInProgress: false,
        breakAdvanceTimeout: null
    };

    rooms.set(roomId, room);
    saveRoomsToDisk(rooms);

    room.noOpponentTimeout = setTimeout(async () => {
        const currentRoom = rooms.get(roomId);
        if (!currentRoom) return;
        if (currentRoom.battleState) return;
        if (getAssignedPlayersCount(currentRoom) >= 2) return;

        await closeUnstartedRoom(currentRoom, 'Room closed: no opponent joined within 10 minutes.');
    }, ROOM_NO_OPPONENT_TIMEOUT_MS);

    room.unstartedTimeout = setTimeout(async () => {
        const currentRoom = rooms.get(roomId);
        if (!currentRoom) return;
        if (currentRoom.battleState) return;

        await closeUnstartedRoom(currentRoom, 'Room closed: match did not start in time. Please create a new room.');
    }, ROOM_UNSTARTED_TIMEOUT_MS);

    generateValidationProblem()
        .then(problem => {
            const currentRoom = rooms.get(roomId);
            if (!currentRoom || currentRoom.battleState) return;

            currentRoom.validationProblem = problem;
            sendToRoom(currentRoom, {
                type: 'VALIDATION_PROBLEM_READY',
                roomId: currentRoom.id,
                validationProblem: problem
            });

            evaluateRoomValidationAndAutoStart(currentRoom).catch(() => {});
        })
        .catch(error => {
            console.error('Validation problem generation failed:', error);
            const currentRoom = rooms.get(roomId);
            if (!currentRoom) return;

            broadcastValidationStatus(currentRoom, {
                pair: [],
                statuses: {},
                message: validationFailureMessage
            });
        });

    evaluateRoomValidationAndAutoStart(room).catch(() => {});
    broadcastActiveRooms();

    return room;
}

async function createBracketRoom({
    hostHandle,
    opponentHandle,
    roomName,
    duration = 40,
    interval = 1,
    problems = [],
    problemCount = 7,
    preGeneratedProblems = [],
    bracketId = null,
    bracketMatchId = null,
    bracketExcludedProblemIds = []
}) {
    return createRoomWithSharedLogic({
        hostHandle,
        hostWs: null,
        opponentHandle,
        roomName,
        duration,
        interval,
        problems,
        problemCount,
        preGeneratedProblems,
        bracketId,
        bracketMatchId,
        bracketExcludedProblemIds,
        validationFailureMessage: 'Validation problem generation failed. Please create a new room.'
    });
}

// Broadcast active rooms
function broadcastActiveRooms() {
    const activeRooms = Array.from(rooms.values())
    .filter(room => !isRoomExpired(room))
    .filter(room => !isBattleEnded(room))
    .map(room => ({
        id: room.id,
        name: room.name,
        players: getConnectedPlayersCount(room),
        assignedPlayers: getAssignedPlayersCount(room),
        duration: room.duration,
        interval: room.interval,
        problems: room.problems.length,
        battleRunning: isBattleRunning(room)
    }));
    
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'ACTIVE_ROOMS',
                rooms: activeRooms
            }));
        }
    });
}

// WebSocket connection
wss.on('connection', (ws, req) => {
    console.log('New WebSocket connection');
    ws.userHandle = '';
    ws.authHandle = String(extractRequesterHandle(req) || '').trim();
    
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            const authenticatedHandle = String(ws.authHandle || '').trim();
            console.log('[DEBUG] WebSocket received message:', data.type, data);
            switch(data.type) {
                case 'CREATE_ROOM':
                    if (!authenticatedHandle) {
                        ws.send(JSON.stringify({ type: 'CREATE_ERROR', message: 'Login required' }));
                        break;
                    }
                    data.handle = authenticatedHandle;
                    await handleCreateRoom(ws, data);
                    break;
                    
                case 'JOIN_ROOM':
                    if (!authenticatedHandle) {
                        ws.send(JSON.stringify({ type: 'JOIN_ERROR', message: 'Login required' }));
                        break;
                    }
                    data.handle = authenticatedHandle;
                    handleJoinRoom(ws, data);
                    break;
                    
                case 'REJOIN_ROOM':
                    if (!authenticatedHandle) {
                        ws.send(JSON.stringify({ type: 'JOIN_ERROR', message: 'Login required' }));
                        break;
                    }
                    data.handle = authenticatedHandle;
                    handleRejoinRoom(ws, data);
                    break;
                    
                case 'LEAVE_ROOM':
                    handleLeaveRoom(ws, data);
                    break;
                    
                case 'PLAYER_READY_TO_START':
                    handlePlayerReadyToStart(ws, data);
                    break;
// Handle player clicking start button
function handlePlayerReadyToStart(ws, data) {
    const room = rooms.get(data.roomId);
    if (!room) {
        console.log('[DEBUG] handlePlayerReadyToStart: Room not found for', data.roomId);
        return;
    }
    // Print incoming data and all players for debug
    console.log('[DEBUG] handlePlayerReadyToStart: incoming data:', data);
    console.log('[DEBUG] handlePlayerReadyToStart: room.players:', room.players.map(p => ({ handle: p.handle, wsMatch: p.ws === ws })));

    // Try to find sender by ws, fallback to handle if needed
    let sender = room.players.find(player => player.ws === ws);
    if (!sender && data.handle) {
        sender = room.players.find(player => String(player.handle || '').trim().toLowerCase() === String(data.handle || '').trim().toLowerCase());
        if (sender) {
            console.log('[DEBUG] handlePlayerReadyToStart: Matched sender by handle:', sender.handle);
        }
    }
    if (!sender || !sender.handle) {
        console.log('[DEBUG] handlePlayerReadyToStart: Sender not found or missing handle');
        return;
    }
    if (!room.playerReady) room.playerReady = {};
    // Normalize handle for readiness (lowercase, trimmed)
    const normalizedHandle = String(sender.handle || '').trim().toLowerCase();
    room.playerReady[normalizedHandle] = true;
    console.log(`[READY] ${sender.handle} marked ready (normalized: ${normalizedHandle}) in room ${room.id}`);
    console.log('[DEBUG] Current playerReady:', JSON.stringify(room.playerReady));
    // Extra debug: print all player handles in room
    console.log('[DEBUG] All player handles in room:', room.players.map(p => p.handle));
    evaluateRoomValidationAndAutoStart(room).catch((e) => { console.log('[DEBUG] evaluateRoomValidationAndAutoStart error:', e); });
}

                case 'END_BATTLE_EARLY':
                    handleEndBattleEarly(ws, data);
                    break;

                case 'PROBLEM_SOLVED':
                    await handleProblemSolved(ws, data);
                    break;

                case 'PENDING_SUBMISSION_STATUS':
                    handlePendingSubmissionStatus(ws, data);
                    break;
                    
                case 'GET_ACTIVE_ROOMS':
                    sendActiveRooms(ws);
                    break;

                case 'SET_ACTIVE_HANDLE':
                    if (authenticatedHandle) {
                        ws.userHandle = authenticatedHandle;
                        markHandleSeen(ws.userHandle, Date.now());
                    }
                    break;
            }
        } catch (error) {
            console.error('WebSocket message error:', error);
        }
    });
    
    ws.on('close', () => {
        if (ws.userHandle) {
            markHandleSeen(ws.userHandle, Date.now());
        }

        for (const [_, room] of rooms.entries()) {
            const playerIndex = room.players.findIndex(player => player.ws === ws);
            if (playerIndex !== -1) {
                const leftHandle = room.players[playerIndex].handle;
                room.players[playerIndex].ws = null;

                sendToRoom(room, {
                    type: 'PLAYER_LEFT',
                    handle: leftHandle,
                    players: room.players.filter(p => !!p.handle).map(p => p.handle)
                });

                if (cleanupUnstartedRoomIfHostLeft(room, leftHandle)) {
                    broadcastActiveRooms();
                    break;
                }

                evaluateRoomValidationAndAutoStart(room).catch(() => {});

                broadcastActiveRooms();
                break;
            }
        }
    });
});

async function handleCreateRoom(ws, data) {
    const roomName = (data.roomName || '').trim() || `${data.handle}'s Room`;
    const opponentHandle = (data.opponentHandle || '').trim();

    // Limit: max 100 rooms per user per 24h
    const now = Date.now();
    const cutoff = now - 24 * 60 * 60 * 1000;
    const createdRooms = Array.from(rooms.values()).filter(r => normalizeHandle(r.hostHandle) === normalizeHandle(data.handle) && r.createdAt >= cutoff);
    if (createdRooms.length >= 100) {
        ws.send(JSON.stringify({
            type: 'CREATE_ERROR',
            message: 'Room creation limit reached (100 per 24 hours).'
        }));
        return;
    }

    if (roomNameTaken(roomName)) {
        ws.send(JSON.stringify({
            type: 'CREATE_ERROR',
            message: 'Room name already exists. Please choose a unique room name.'
        }));
        return;
    }

    if (!opponentHandle) {
        ws.send(JSON.stringify({
            type: 'CREATE_ERROR',
            message: 'Opponent handle is required.'
        }));
        return;
    }

    if (normalizeHandle(opponentHandle) === normalizeHandle(data.handle)) {
        ws.send(JSON.stringify({
            type: 'CREATE_ERROR',
            message: 'Opponent handle must be different from your handle.'
        }));
        return;
    }

    const room = createRoomWithSharedLogic({
        hostHandle: data.handle,
        hostWs: ws,
        opponentHandle,
        roomName,
        duration: Number(data.duration) || 40,
        interval: Number(data.interval) || 1,
        problems: Array.isArray(data.problems) ? data.problems : [],
        problemCount: Array.isArray(data.problems) ? data.problems.length : 7,
        validationFailureMessage: 'Validation problem generation failed. Please recreate room.'
    });

    ws.userHandle = data.handle;
    markHandleSeen(data.handle, Date.now());
    
    ws.send(JSON.stringify({
        type: 'ROOM_CREATED',
        roomId: room.id,
        roomName: roomName,
        opponentHandle: room.opponentHandle,
        duration: room.duration,
        interval: room.interval,
        problems: room.problems,
        validationProblem: room.validationProblem
    }));
}

function handlePendingSubmissionStatus(ws, data) {
    const room = rooms.get(data.roomId);
    if (!room || !room.battleState) return;

    const sender = room.players.find(player => player.ws === ws);
    if (!sender || !sender.handle) return;

    room.pendingSubmissionActive = !!data.hasPending;

    if (!room.pendingSubmissionActive && room.battleState.status === 'ended') {
        scheduleRoomCleanup(room);
    }
}

function handleEndBattleEarly(ws, data) {
    const room = rooms.get(data.roomId);
    if (!room || !room.battleState || room.battleState.status !== 'running') return;

    const sender = room.players.find(player => player.ws === ws);
    if (!sender || !sender.handle) return;

    finalizeBattle(room, data.reason || 'all-problems-solved');
}

async function handleProblemSolved(ws, data) {
    const room = rooms.get(data.roomId);
    if (!room || !room.battleState || room.battleState.status !== 'running') return;

    const sender = room.players.find(player => player.ws === ws);
    if (!sender || !sender.handle) return;

    const solverHandle = (data.solverHandle || '').trim();
    const problemId = (data.problemId || '').trim();
    const problemNumber = data.problemNumber;
    if (!solverHandle || !problemId) return;

    if (!room.players.some(player => normalizeHandle(player.handle) === normalizeHandle(solverHandle))) return;

    if (!room.battleState.solveAnnouncements) {
        room.battleState.solveAnnouncements = {};
    }
    if (!room.battleState.problemWinners) {
        room.battleState.problemWinners = {};
    }

    const problemWinnerKey = `${problemNumber}:${problemId}`;
    if (room.battleState.problemWinners[problemWinnerKey]) {
        return;
    }
    room.battleState.problemWinners[problemWinnerKey] = solverHandle;

    const solveKey = `${problemId}:${solverHandle}`;
    if (room.battleState.solveAnnouncements[solveKey]) return;
    room.battleState.solveAnnouncements[solveKey] = true;

    sendToRoom(room, {
        type: 'PROBLEM_SOLVED',
        roomId: room.id,
        solverHandle,
        problemId,
        problemNumber,
        solveKey
    });

    const totalProblems = (room.battleState.problemConfigs || room.problems || []).length;
    const solvedProblemNumber = Number(problemNumber) || 0;
    const solvedProblemIndex = solvedProblemNumber - 1;
    const hasNextProblem = solvedProblemNumber >= 1 && solvedProblemNumber < totalProblems;
    const now = Date.now();

    room.battleState.liveState = {
        currentProblemNumber: solvedProblemNumber,
        currentProblem: room.battleState.selectedProblems?.[solvedProblemIndex] || null,
        problemLocked: true,
        solvedBy: solverHandle,
        breakStartsAt: hasNextProblem ? now : null,
        breakEndsAt: hasNextProblem ? now + 60000 : null,
        updatedAt: now
    };

    if (room.breakAdvanceTimeout) {
        clearTimeout(room.breakAdvanceTimeout);
        room.breakAdvanceTimeout = null;
    }

    if (hasNextProblem) {
        const nextProblemNumberForLiveState = solvedProblemNumber + 1;
        room.breakAdvanceTimeout = setTimeout(() => {
            const targetRoom = rooms.get(room.id);
            if (!targetRoom || !targetRoom.battleState || targetRoom.battleState.status !== 'running') return;

            const nextProblemIndexForLiveState = nextProblemNumberForLiveState - 1;
            targetRoom.battleState.liveState = {
                currentProblemNumber: nextProblemNumberForLiveState,
                currentProblem: targetRoom.battleState.selectedProblems?.[nextProblemIndexForLiveState] || null,
                problemLocked: false,
                solvedBy: null,
                breakStartsAt: null,
                breakEndsAt: null,
                updatedAt: Date.now()
            };
            targetRoom.breakAdvanceTimeout = null;
            saveRoomsToDisk(rooms);
        }, 60000);
        saveRoomsToDisk(rooms);
    }

    if (solvedProblemNumber < 1 || solvedProblemNumber >= totalProblems) {
        saveRoomsToDisk(rooms);
        return;
    }

    const nextProblemNumber = solvedProblemNumber + 1;
    const nextProblemIndex = nextProblemNumber - 1;
    if (!room.battleState.selectedProblems) {
        room.battleState.selectedProblems = Array.from({ length: totalProblems }, () => null);
    }
    if (room.battleState.selectedProblems[nextProblemIndex]) {
        const existingProblem = room.battleState.selectedProblems[nextProblemIndex];
        sendToRoom(room, {
            type: 'NEXT_PROBLEM_READY',
            roomId: room.id,
            problemNumber: nextProblemNumber,
            problem: existingProblem
        });
        return;
    }

    if (!room.battleState.generatedProblemLocks) {
        room.battleState.generatedProblemLocks = {};
    }
    if (room.battleState.generatedProblemLocks[nextProblemNumber]) {
        return;
    }

    room.battleState.generatedProblemLocks[nextProblemNumber] = true;
    try {
        const problemConfigs = room.battleState.problemConfigs || room.problems || [];
        const targetConfig = problemConfigs[nextProblemIndex] || { points: 500, rating: 1200 };
        const usedProblemIds = Array.isArray(room.battleState.usedProblemIds)
            ? room.battleState.usedProblemIds
            : [];

        const nextProblem = await generateRoomProblemForConfig(targetConfig, usedProblemIds);
        room.battleState.selectedProblems[nextProblemIndex] = nextProblem;
        if (!room.battleState.usedProblemIds.includes(nextProblem.id)) {
            room.battleState.usedProblemIds.push(nextProblem.id);
        }

        if (room.bracketId) {
            await reserveBracketProblemIds(room.bracketId, [nextProblem.id]);
        }

        sendToRoom(room, {
            type: 'NEXT_PROBLEM_READY',
            roomId: room.id,
            problemNumber: nextProblemNumber,
            problem: nextProblem
        });
        saveRoomsToDisk(rooms);
    } catch (error) {
        console.error('Failed to generate next problem:', error);
        sendToRoom(room, {
            type: 'NEXT_PROBLEM_ERROR',
            roomId: room.id,
            problemNumber: nextProblemNumber,
            message: 'Could not generate next problem right now. Please wait and solve refresh/rejoin if needed.'
        });
    } finally {
        delete room.battleState.generatedProblemLocks[nextProblemNumber];
    }
}

function handleJoinRoom(ws, data) {
    const room = rooms.get(data.roomId);
    
    if (!room) {
        ws.send(JSON.stringify({
            type: 'JOIN_ERROR',
            message: 'Room not found'
        }));
        return;
    }
    
    if (isRoomExpired(room)) {
        ws.send(JSON.stringify({
            type: 'JOIN_ERROR',
            message: 'This blitz room already ended and moved to past results.'
        }));
        return;
    }

    if (isBattleEnded(room)) {
        ws.send(JSON.stringify({
            type: 'JOIN_ERROR',
            message: 'This blitz room already ended and moved to past results.'
        }));
        return;
    }


    const existingIndex = room.players.findIndex(player => normalizeHandle(player.handle) === normalizeHandle(data.handle));
    if (existingIndex !== -1) {
        room.players[existingIndex].ws = ws;
        ws.userHandle = data.handle;
        markHandleSeen(data.handle, Date.now());
        // Always send countdown and match state to reconnecting clients
        ws.send(JSON.stringify({
            type: 'REJOIN_SUCCESS',
            serverNow: Date.now(),
            roomId: room.id,
            roomData: getRoomPublicState(room),
            isHost: room.host === data.handle,
            countdownInProgress: !!room.countdownInProgress,
            countdownEndsAt: room.countdownEndsAt || null,
            battleState: room.battleState || null
        }));
        sendToRoom(room, {
            type: 'PLAYER_RECONNECTED',
            handle: data.handle,
            players: room.players.filter(p => !!p.handle).map(p => p.handle),
            countdownInProgress: !!room.countdownInProgress,
            countdownEndsAt: room.countdownEndsAt || null,
            battleState: room.battleState || null
        });
        broadcastActiveRooms();
        return;
    }

    room.players.push({ handle: data.handle, ws });
    ws.userHandle = data.handle;
    markHandleSeen(data.handle, Date.now());

    if (room.noOpponentTimeout && getAssignedPlayersCount(room) >= 2) {
        clearTimeout(room.noOpponentTimeout);
        room.noOpponentTimeout = null;
    }

    const joinedHandle = normalizeHandle(data.handle);
    const hostHandle = normalizeHandle(room.host);
    const opponentHandle = normalizeHandle(room.opponentHandle);
    const joinedRole = (joinedHandle && (joinedHandle === hostHandle || joinedHandle === opponentHandle))
        ? 'player'
        : 'spectator';

    sendToRoom(room, {
        type: 'PLAYER_JOINED',
        handle: data.handle,
        role: joinedRole,
        players: room.players.filter(p => !!p.handle).map(p => p.handle),
        roomId: room.id,
        roomName: room.name,
        duration: room.duration,
        interval: room.interval,
        problems: room.problems,
        validationProblem: room.validationProblem
    });
    
    ws.send(JSON.stringify({
        type: 'ROOM_JOINED',
        serverNow: Date.now(),
        roomId: room.id,
        roomName: room.name,
        playerIndex: room.players.length - 1,
        players: room.players.filter(p => !!p.handle).map(p => p.handle),
        isHost: room.host === data.handle,
        opponentHandle: room.opponentHandle,
        duration: room.duration,
        interval: room.interval,
        problems: room.problems,
        validationProblem: room.validationProblem,
        battleState: room.battleState,
        countdownInProgress: !!room.countdownInProgress,
        countdownEndsAt: room.countdownEndsAt || null
    }));

    evaluateRoomValidationAndAutoStart(room).catch(() => {});
    
    broadcastActiveRooms();
}

function handleRejoinRoom(ws, data) {
    const room = rooms.get(data.roomId);
    
    if (!room) {
        ws.send(JSON.stringify({
            type: 'JOIN_ERROR',
            message: 'Room not found'
        }));
        return;
    }
    
    const playerIndex = room.players.findIndex(player => normalizeHandle(player.handle) === normalizeHandle(data.handle));
    if (playerIndex === -1) {
        ws.send(JSON.stringify({
            type: 'JOIN_ERROR',
            message: 'Player not found in room'
        }));
        return;
    }

    room.players[playerIndex].ws = ws;
    ws.userHandle = data.handle;
    markHandleSeen(data.handle, Date.now());
    
    // Always send countdown and match state to reconnecting clients
    ws.send(JSON.stringify({
        type: 'REJOIN_SUCCESS',
        serverNow: Date.now(),
        roomId: room.id,
        roomData: getRoomPublicState(room),
        isHost: room.host === data.handle,
        countdownInProgress: !!room.countdownInProgress,
        countdownEndsAt: room.countdownEndsAt || null,
        battleState: room.battleState || null
    }));
    sendToRoom(room, {
        type: 'PLAYER_RECONNECTED',
        handle: data.handle,
        players: room.players.filter(p => !!p.handle).map(p => p.handle),
        countdownInProgress: !!room.countdownInProgress,
        countdownEndsAt: room.countdownEndsAt || null,
        battleState: room.battleState || null
    });

    evaluateRoomValidationAndAutoStart(room).catch(() => {});
    
    broadcastActiveRooms();
}

function handleLeaveRoom(ws, data) {
    const room = rooms.get(data.roomId);
    if (!room) return;
    
    const playerIndex = room.players.findIndex(player => player.ws === ws);
    if (playerIndex !== -1) {
        const leftHandle = room.players[playerIndex].handle;
        room.players[playerIndex].ws = null;
        
        sendToRoom(room, {
            type: 'PLAYER_LEFT',
            handle: leftHandle,
            players: room.players.filter(p => !!p.handle).map(p => p.handle)
        });

        if (cleanupUnstartedRoomIfHostLeft(room, leftHandle)) {
            broadcastActiveRooms();
            return;
        }

        evaluateRoomValidationAndAutoStart(room).catch(() => {});
        
        broadcastActiveRooms();
    }
}

async function handleStartBattle(ws, data) {
    const room = rooms.get(data.roomId);
    if (!room) return;

    if (getAssignedPlayersCount(room) < 2) {
        ws.send(JSON.stringify({
            type: 'START_ERROR',
            message: 'At least two participants are required to start battle.'
        }));
        return;
    }

    if (room.battleState && room.battleState.status === 'running') {
        ws.send(JSON.stringify({
            type: 'START_ERROR',
            message: 'Battle is already running.'
        }));
        return;
    }

    evaluateRoomValidationAndAutoStart(room).catch(error => {
        console.error('Manual trigger for auto-start failed:', error);
    });

    ws.send(JSON.stringify({
        type: 'START_ERROR',
        message: 'Both players must click Start Match to begin the battle.'
    }));
}

function sendActiveRooms(ws) {
    const activeRooms = Array.from(rooms.values())
    .filter(room => !isRoomExpired(room))
    .filter(room => !isBattleEnded(room))
    .map(room => ({
        id: room.id,
        name: room.name,
        hostHandle: room.hostHandle || '',
        opponentHandle: room.opponentHandle || '',
        players: getConnectedPlayersCount(room),
        assignedPlayers: getAssignedPlayersCount(room),
        duration: room.duration,
        interval: room.interval,
        problems: room.problems.length,
        battleRunning: isBattleRunning(room)
    }));
    
    ws.send(JSON.stringify({
        type: 'ACTIVE_ROOMS',
        rooms: activeRooms
    }));
}

// API Routes
app.get('/api/results', async (req, res) => {
    try {
        const data = await fs.readFile(RESULTS_FILE, 'utf8');
        const parsed = JSON.parse(data);
        const { normalized, changed } = ensureSequentialBlitzNumbers(parsed);

        if (changed) {
            await fs.writeFile(RESULTS_FILE, JSON.stringify(normalized, null, 2));
        }

        res.json(normalized);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/presence/:handle', (req, res) => {
    const handle = String(req.params.handle || '').trim();
    if (!handle) {
        res.status(400).json({ error: 'handle is required' });
        return;
    }

    res.json(getHandlePresence(handle));
});

app.get('/api/profiles', async (req, res) => {
    try {
        await refreshProfilesCanonicalCasing();
    } catch {
    }
    res.json(getAllProfiles());
});

app.post('/api/profiles', (req, res) => {
    const handle = String(extractRequesterHandle(req) || '').trim();
    if (!handle) {
        res.status(401).json({ error: 'Login required' });
        return;
    }

    upsertProfileHandle(handle);
    res.json({ success: true });
});

app.post('/api/presence/ping', (req, res) => {
    const handle = String(extractRequesterHandle(req) || '').trim();
    if (!handle) {
        res.status(401).json({ error: 'Login required' });
        return;
    }

    const normalized = normalizeHandle(handle);
    const now = Date.now();
    heartbeatSeenMap.set(normalized, now);
    markHandleSeen(handle, now);

    res.json({ success: true, now });
});

app.get('/api/session/me', (req, res) => {
    const session = getServerSession(req);
    if (!session) {
        clearSessionCookie(res);
        res.json({ authenticated: false });
        return;
    }

    res.json({
        authenticated: true,
        handle: session.handle,
        expiresAt: session.expiresAt
    });
});

app.post('/api/session/challenge', async (req, res) => {
    try {
        const requestedHandle = String(req.body?.handle || '').trim();
        if (!requestedHandle) {
            res.status(400).json({ error: 'handle is required' });
            return;
        }

        // BYPASS: If user is in bypass list, return a dummy challenge so frontend flow never breaks
        const BYPASS_USERS = ['MITMAX', 'greed_y'];
        if (BYPASS_USERS.map(h => h.toLowerCase()).includes(requestedHandle.toLowerCase())) {
            res.json({
                success: true,
                challengeId: 'bypass-challenge',
                expiresAt: Date.now() + 10 * 60 * 1000,
                problem: {
                    id: 'bypass',
                    contestId: 0,
                    index: 'A',
                    name: 'Bypass User',
                    rating: 0,
                    url: '',
                    generatedAtSec: Math.floor(Date.now() / 1000)
                },
                bypassed: true
            });
            return;
        }

        const profile = await fetchCodeforcesUserProfile(requestedHandle);
        if (!profile) {
            res.status(400).json({ error: 'Invalid Codeforces handle' });
            return;
        }

        const canonicalHandle = String(profile.handle || '').trim();
        if (!canonicalHandle) {
            res.status(400).json({ error: 'Invalid Codeforces handle' });
            return;
        }

        const problem = await generateValidationProblem();
        const challenge = createSessionChallenge(canonicalHandle, problem);
        if (!challenge) {
            res.status(500).json({ error: 'Could not create verification challenge' });
            return;
        }

        res.json({
            success: true,
            challengeId: challenge.id,
            expiresAt: challenge.expiresAtMs,
            problem: challenge.problem
        });
    } catch (error) {
        res.status(500).json({ error: error.message || 'Could not create verification challenge' });
    }
});

app.post('/api/session/login', async (req, res) => {
    try {
        const requestedHandle = String(req.body?.handle || '').trim();
        if (!requestedHandle) {
            res.status(400).json({ error: 'handle is required' });
            return;
        }

        // TEMP: Allow two specific users to bypass login verification, even if challengeId is present
        const BYPASS_USERS = ['MITMAX', 'greed_y']; // <-- Replace with your actual handles
        if (BYPASS_USERS.map(h => h.toLowerCase()).includes(requestedHandle.toLowerCase())) {
            console.log(`Bypass login used for handle: ${requestedHandle}`);
            destroyServerSession(req);
            const session = createServerSession(requestedHandle);
            if (!session) {
                res.status(500).json({ error: 'Could not create session' });
                return;
            }
            upsertProfileHandle(requestedHandle);
            setSessionCookie(res, session.id);
            res.json({ success: true, handle: session.handle, expiresAt: session.expiresAt, bypassed: true });
            return;
        }

        // ...existing code for normal login flow...
        const challengeId = String(req.body?.challengeId || '').trim();
        if (!challengeId) {
            res.status(400).json({ error: 'challengeId is required' });
            return;
        }

        const challenge = getSessionChallenge(challengeId);
        if (!challenge) {
            res.status(410).json({ error: 'Verification challenge expired. Generate a new one.' });
            return;
        }

        if (normalizeHandle(challenge.handle) !== normalizeHandle(requestedHandle)) {
            res.status(401).json({ error: 'Handle does not match verification challenge' });
            return;
        }

        const profile = await fetchCodeforcesUserProfile(requestedHandle);
        if (!profile) {
            res.status(400).json({ error: 'Invalid Codeforces handle' });
            return;
        }

        const canonicalHandle = String(profile.handle || '').trim();
        if (!canonicalHandle || normalizeHandle(canonicalHandle) !== normalizeHandle(challenge.handle)) {
            res.status(401).json({ error: 'Handle does not match verification challenge' });
            return;
        }

        const verified = await hasCompilationErrorOnProblem(challenge.handle, challenge.problem, challenge.issuedAtSec);
        if (!verified) {
            res.status(401).json({ error: 'Handle verification not found for the selected problem' });
            return;
        }

        consumeSessionChallenge(challengeId);

        destroyServerSession(req);
        const session = createServerSession(challenge.handle);
        if (!session) {
            res.status(500).json({ error: 'Could not create session' });
            return;
        }

        upsertProfileHandle(challenge.handle);
        setSessionCookie(res, session.id);
        res.json({ success: true, handle: session.handle, expiresAt: session.expiresAt });
    } catch (error) {
        res.status(500).json({ error: error.message || 'Could not create session' });
    }
});

app.post('/api/session/logout', (req, res) => {
    destroyServerSession(req);
    clearSessionCookie(res);
    res.json({ success: true });
});

app.post('/api/results', async (req, res) => {
    try {
        const current = JSON.parse(await fs.readFile(RESULTS_FILE, 'utf8'));
        const normalizedState = ensureSequentialBlitzNumbers(current);
        let results = normalizedState.normalized;
        const payload = req.body || {};
        const key = payload.matchKey;

        if (key) {
            const existingIndex = results.findIndex(item => item.matchKey === key);
            if (existingIndex >= 0) {
                const existingNumber = results[existingIndex].blitzNumber;
                results[existingIndex] = {
                    ...payload,
                    blitzNumber: existingNumber
                };
            } else {

            const finalState = ensureSequentialBlitzNumbers(results);
            results = finalState.normalized;
                const maxBlitzNumber = results.reduce((max, item) => {
                    const value = Number(item.blitzNumber) || 0;
                    return Math.max(max, value);
                }, 0);
                results.push({
                    ...payload,
                    blitzNumber: maxBlitzNumber + 1
                });
            }
        } else {
            const maxBlitzNumber = results.reduce((max, item) => {
                const value = Number(item.blitzNumber) || 0;
                return Math.max(max, value);
            }, 0);
            results.push({
                ...payload,
                blitzNumber: maxBlitzNumber + 1
            });
        }

        await fs.writeFile(RESULTS_FILE, JSON.stringify(results, null, 2));
        await updateBracketMatchFromResult(payload);

        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: 'RESULTS_UPDATED' }));
            }
        });

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/verify', (req, res) => {
    const suppliedPassword = extractAdminPassword(req);
    const requesterHandle = extractRequesterHandle(req);

    const throttle = getAdminPinThrottleState(req, requesterHandle);
    if (throttle.blocked) {
        const retryMinutes = Math.max(1, Math.ceil((throttle.retryAfterMs || 0) / 60000));
        res.status(429).json({ error: `Too many wrong PIN attempts. Try again in ${retryMinutes} minute(s).` });
        return;
    }

    if (!isAdminRequester(requesterHandle, suppliedPassword, req)) {
        res.status(401).json({ error: 'Invalid admin credentials' });
        return;
    }

    res.json({ success: true });
});

app.delete('/api/results', async (req, res) => {
    const suppliedPassword = extractAdminPassword(req);
    const requesterHandle = extractRequesterHandle(req);

    const throttle = getAdminPinThrottleState(req, requesterHandle);
    if (throttle.blocked) {
        const retryMinutes = Math.max(1, Math.ceil((throttle.retryAfterMs || 0) / 60000));
        res.status(429).json({ error: `Too many wrong PIN attempts. Try again in ${retryMinutes} minute(s).` });
        return;
    }

    if (!isAdminRequester(requesterHandle, suppliedPassword, req)) {
        res.status(401).json({ error: 'Invalid admin credentials' });
        return;
    }

    try {
        await fs.writeFile(RESULTS_FILE, JSON.stringify([]));

        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: 'RESULTS_UPDATED' }));
            }
        });

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/feedback', async (req, res) => {
    try {
        const store = await readFeedbackStore();
        const items = [...store.items].sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
        const activity = [...store.activity].sort((a, b) => new Date(b.at || 0).getTime() - new Date(a.at || 0).getTime());
        res.json({ items, activity });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/feedback', async (req, res) => {
    try {
        const requesterHandle = extractRequesterHandle(req);
        if (!requesterHandle) {
            res.status(401).json({ error: 'Login required' });
            return;
        }

        const title = String(req.body?.title || '').trim();
        const message = String(req.body?.message || '').trim();
        if (!message) {
            res.status(400).json({ error: 'message is required' });
            return;
        }

        const store = await readFeedbackStore();
        const requesterNorm = normalizeHandle(requesterHandle);
        const cutoffMs = Date.now() - (24 * 60 * 60 * 1000);
        const recentByUserCount = (Array.isArray(store.items) ? store.items : []).reduce((count, item) => {
            const sameUser = normalizeHandle(item?.createdBy) === requesterNorm;
            if (!sameUser) return count;
            const createdMs = new Date(item?.createdAt || 0).getTime();
            if (!Number.isFinite(createdMs) || createdMs < cutoffMs) return count;
            return count + 1;
        }, 0);

        if (recentByUserCount >= FEEDBACK_DAILY_LIMIT) {
            res.status(429).json({ error: `Daily feedback limit reached (${FEEDBACK_DAILY_LIMIT} per 24 hours)` });
            return;
        }

        const next = {
            id: `fb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            title: title || 'Untitled Feedback',
            message,
            status: 'open',
            createdBy: requesterHandle,
            createdAt: new Date().toISOString(),
            updatedBy: null,
            updatedAt: null,
            history: [],
            replies: []
        };

        store.items.unshift(next);
        pushFeedbackActivity(store, {
            type: 'created',
            by: requesterHandle,
            feedbackId: next.id,
            feedbackTitle: next.title
        });

        await writeFeedbackStore(store);

        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: 'FEEDBACK_UPDATED' }));
            }
        });

        res.json(next);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/feedback/:feedbackId/replies', async (req, res) => {
    try {
        const feedbackId = String(req.params.feedbackId || '').trim();
        const requesterHandle = extractRequesterHandle(req);
        if (!requesterHandle) {
            res.status(401).json({ error: 'Login required' });
            return;
        }

        const replyBy = String(requesterHandle || '').trim();
        const message = String(req.body?.message || '').trim();

        if (!feedbackId) {
            res.status(400).json({ error: 'feedbackId is required' });
            return;
        }

        if (!message) {
            res.status(400).json({ error: 'message is required' });
            return;
        }

        const store = await readFeedbackStore();
        const requesterNorm = normalizeHandle(replyBy);
        const cutoffMs = Date.now() - (24 * 60 * 60 * 1000);
        const recentReplyCount = (Array.isArray(store.items) ? store.items : []).reduce((count, item) => {
            const replies = Array.isArray(item?.replies) ? item.replies : [];
            const perItemCount = replies.reduce((innerCount, replyItem) => {
                const sameUser = normalizeHandle(replyItem?.createdBy) === requesterNorm;
                if (!sameUser) return innerCount;
                const createdMs = new Date(replyItem?.createdAt || 0).getTime();
                if (!Number.isFinite(createdMs) || createdMs < cutoffMs) return innerCount;
                return innerCount + 1;
            }, 0);
            return count + perItemCount;
        }, 0);

        if (recentReplyCount >= FEEDBACK_DAILY_LIMIT) {
            res.status(429).json({ error: `Daily reply limit reached (${FEEDBACK_DAILY_LIMIT} per 24 hours)` });
            return;
        }

        const index = store.items.findIndex(item => item.id === feedbackId);
        if (index === -1) {
            res.status(404).json({ error: 'Feedback not found' });
            return;
        }

        const current = store.items[index];
        const reply = {
            id: `fr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            message,
            createdBy: replyBy,
            createdAt: new Date().toISOString()
        };

        const replies = Array.isArray(current.replies) ? current.replies : [];
        const next = {
            ...current,
            replies: [...replies, reply],
            updatedBy: replyBy,
            updatedAt: reply.createdAt
        };

        store.items[index] = next;
        pushFeedbackActivity(store, {
            type: 'replied',
            by: replyBy,
            feedbackId: next.id,
            feedbackTitle: next.title,
            details: {
                replyId: reply.id
            }
        });

        await writeFeedbackStore(store);

        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: 'FEEDBACK_UPDATED' }));
            }
        });

        res.json(reply);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/feedback/:feedbackId/replies/:replyId', async (req, res) => {
    try {
        const feedbackId = String(req.params.feedbackId || '').trim();
        const replyId = String(req.params.replyId || '').trim();
        const requesterHandle = extractRequesterHandle(req);
        const adminPassword = extractAdminPassword(req);

        if (!feedbackId || !replyId) {
            res.status(400).json({ error: 'feedbackId and replyId are required' });
            return;
        }

        const store = await readFeedbackStore();
        const feedbackIndex = store.items.findIndex(item => item.id === feedbackId);
        if (feedbackIndex === -1) {
            res.status(404).json({ error: 'Feedback not found' });
            return;
        }

        const feedbackItem = store.items[feedbackIndex];
        const replies = Array.isArray(feedbackItem.replies) ? feedbackItem.replies : [];
        const replyIndex = replies.findIndex(reply => String(reply?.id || '').trim() === replyId);
        if (replyIndex === -1) {
            res.status(404).json({ error: 'Reply not found' });
            return;
        }

        const reply = replies[replyIndex];
        if (!canDeleteFeedbackReply(reply, requesterHandle, adminPassword, req)) {
            res.status(403).json({ error: 'Only reply author or admin can delete this reply' });
            return;
        }

        const remainingReplies = replies.filter((_, index) => index !== replyIndex);
        const next = {
            ...feedbackItem,
            replies: remainingReplies,
            updatedBy: String(requesterHandle || '').trim() || 'anonymous',
            updatedAt: new Date().toISOString()
        };

        store.items[feedbackIndex] = next;
        pushFeedbackActivity(store, {
            type: 'reply_deleted',
            by: String(requesterHandle || '').trim() || 'anonymous',
            feedbackId: next.id,
            feedbackTitle: next.title,
            details: {
                replyId,
                replyBy: reply.createdBy || 'unknown'
            }
        });

        await writeFeedbackStore(store);

        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: 'FEEDBACK_UPDATED' }));
            }
        });

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.patch('/api/feedback/:feedbackId', async (req, res) => {
    try {
        const feedbackId = String(req.params.feedbackId || '').trim();
        const requesterHandle = extractRequesterHandle(req);
        const adminPassword = extractAdminPassword(req);

        if (!feedbackId) {
            res.status(400).json({ error: 'feedbackId is required' });
            return;
        }

        const store = await readFeedbackStore();
        const index = store.items.findIndex(item => item.id === feedbackId);
        if (index === -1) {
            res.status(404).json({ error: 'Feedback not found' });
            return;
        }

        const current = store.items[index];
        if (!canManageFeedback(current, requesterHandle, adminPassword, req)) {
            res.status(403).json({ error: 'Only feedback author or admin can modify this item' });
            return;
        }

        const nextTitleRaw = req.body?.title;
        const nextMessageRaw = req.body?.message;
        const nextStatusRaw = req.body?.status;

        const nextTitle = nextTitleRaw === undefined ? current.title : (String(nextTitleRaw || '').trim() || 'Untitled Feedback');
        const nextMessage = nextMessageRaw === undefined ? current.message : String(nextMessageRaw || '').trim();
        const nextStatus = nextStatusRaw === undefined ? current.status : normalizeFeedbackStatus(nextStatusRaw);

        if (!nextMessage) {
            res.status(400).json({ error: 'message cannot be empty' });
            return;
        }

        const changed = nextTitle !== current.title || nextMessage !== current.message || nextStatus !== current.status;
        if (!changed) {
            res.json(current);
            return;
        }

        const updatedAt = new Date().toISOString();
        const next = {
            ...current,
            title: nextTitle,
            message: nextMessage,
            status: nextStatus,
            updatedBy: requesterHandle,
            updatedAt,
            history: [
                ...(Array.isArray(current.history) ? current.history : []),
                {
                    at: updatedAt,
                    by: requesterHandle,
                    fromStatus: current.status,
                    toStatus: nextStatus,
                    changedTitle: nextTitle !== current.title,
                    changedMessage: nextMessage !== current.message
                }
            ]
        };

        store.items[index] = next;
        pushFeedbackActivity(store, {
            type: 'updated',
            by: requesterHandle,
            feedbackId: next.id,
            feedbackTitle: next.title,
            details: {
                fromStatus: current.status,
                toStatus: next.status
            }
        });

        await writeFeedbackStore(store);

        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: 'FEEDBACK_UPDATED' }));
            }
        });

        res.json(next);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/feedback/:feedbackId', async (req, res) => {
    try {
        const feedbackId = String(req.params.feedbackId || '').trim();
        const requesterHandle = extractRequesterHandle(req);
        const adminPassword = extractAdminPassword(req);

        if (!feedbackId) {
            res.status(400).json({ error: 'feedbackId is required' });
            return;
        }

        const store = await readFeedbackStore();
        const index = store.items.findIndex(item => item.id === feedbackId);
        if (index === -1) {
            res.status(404).json({ error: 'Feedback not found' });
            return;
        }

        const target = store.items[index];
        if (!canManageFeedback(target, requesterHandle, adminPassword, req)) {
            res.status(403).json({ error: 'Only feedback author or admin can delete this item' });
            return;
        }

        store.items.splice(index, 1);
        pushFeedbackActivity(store, {
            type: 'deleted',
            by: requesterHandle,
            feedbackId: target.id,
            feedbackTitle: target.title,
            details: {
                deletedStatus: target.status,
                createdBy: target.createdBy
            }
        });

        await writeFeedbackStore(store);

        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: 'FEEDBACK_UPDATED' }));
            }
        });

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/brackets', async (req, res) => {
    try {
        const brackets = await readBrackets();
        res.json(brackets);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/brackets', async (req, res) => {
    try {
        const body = req.body || {};
        const ownerHandle = String(extractRequesterHandle(req) || '').trim();
        const type = String(body.type || 'round-robin').trim();
        const participants = normalizeParticipants(body.participants || []);
        const roomConfig = normalizeBracketRoomConfig(body.roomConfig || {});


        // Limit: max 100 brackets per user per 24h
        const now = Date.now();
        const cutoff = now - 24 * 60 * 60 * 1000;
        const allBrackets = await readBrackets();
        const userBrackets = allBrackets.filter(b => normalizeHandle(b.ownerHandle) === normalizeHandle(ownerHandle) && new Date(b.createdAt).getTime() >= cutoff);
        if (userBrackets.length >= 100) {
            res.status(429).json({ error: 'Bracket creation limit reached (100 per 24 hours).' });
            return;
        }

        if (!ownerHandle) {
            res.status(401).json({ error: 'Login required' });
            return;
        }

        if (participants.length < 2) {
            res.status(400).json({ error: 'At least 2 participants required' });
            return;
        }

        if (participants.length > 1000) {
            res.status(400).json({ error: 'Maximum 1000 participants allowed per bracket.' });
            return;
        }

        const supported = ['round-robin', 'single-elimination', 'double-elimination'];
        if (!supported.includes(type)) {
            res.status(400).json({ error: 'Unsupported tournament type' });
            return;
        }

        // Fetch Codeforces ratings for all participants
        async function fetchCodeforcesProfiles(handles) {
            const map = {};
            if (!Array.isArray(handles) || handles.length === 0) return map;
            const chunkSize = 80;
            for (let i = 0; i < handles.length; i += chunkSize) {
                const chunk = handles.slice(i, i + chunkSize);
                try {
                    const response = await fetch(`https://codeforces.com/api/user.info?handles=${encodeURIComponent(chunk.join(';'))}`);
                    const data = await response.json();
                    if (data.status !== 'OK' || !Array.isArray(data.result)) continue;
                    data.result.forEach(user => {
                        map[user.handle] = {
                            rating: user.rating ?? null,
                            maxRating: user.maxRating ?? null
                        };
                    });
                } catch {}
            }
            return map;
        }

        function getRankClassByMaxRating(maxRating) {
            const value = Number(maxRating);
            if (!Number.isFinite(value)) return 'rank-newbie';
            if (value >= 3000) return 'rank-lgm';
            if (value >= 2600) return 'rank-gm';
            if (value >= 2300) return 'rank-im';
            if (value >= 2100) return 'rank-master';
            if (value >= 1900) return 'rank-cm';
            if (value >= 1600) return 'rank-expert';
            if (value >= 1400) return 'rank-specialist';
            if (value >= 1200) return 'rank-pupil';
            return 'rank-newbie';
        }

        // Build handleProfiles: { handle: { rating, maxRating, rankClass } }
        const handleProfiles = {};
        const codeforcesProfiles = await fetchCodeforcesProfiles(participants);
        for (const handle of participants) {
            const profile = codeforcesProfiles[handle] || {};
            const rating = profile.rating ?? null;
            const maxRating = profile.maxRating ?? null;
            const rankClass = getRankClassByMaxRating(maxRating);
            handleProfiles[handle] = { rating, maxRating, rankClass };
        }

        const bracket = {
            id: `b_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: String(body.name || 'Tournament').trim() || 'Tournament',
            type,
            ownerHandle,
            participants,
            roomConfig,
            usedProblemIds: [],
            matches: generateBracketMatches(type, participants),
            createdAt: new Date().toISOString(),
            handleProfiles
        };

        autoAdvanceBracketByes(bracket);
        applyChampionPlaceholders(bracket);

        const brackets = await readBrackets();
        brackets.unshift(bracket);
        await writeBrackets(brackets);

        res.json(bracket);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/brackets/:bracketId', async (req, res) => {
    try {
        const { bracketId } = req.params;
        const requesterHandle = extractRequesterHandle(req);
        const adminPassword = extractAdminPassword(req);

        const brackets = await readBrackets();
        const target = brackets.find(item => item.id === bracketId);
        if (!target) {
            res.status(404).json({ error: 'Bracket not found' });
            return;
        }

        if (!canManageBracket(target, requesterHandle, adminPassword, req)) {
            res.status(403).json({ error: 'Only bracket creator or admin can delete this bracket' });
            return;
        }

        const next = brackets.filter(item => item.id !== bracketId);
        await writeBrackets(next);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/brackets/:bracketId/matches/:matchId/create-room', async (req, res) => {
    try {
        const { bracketId, matchId } = req.params;
        const body = req.body || {};
        const requesterHandle = extractRequesterHandle(req);
        const adminPassword = extractAdminPassword(req);

        const brackets = await readBrackets();
        const bracketIndex = brackets.findIndex(item => item.id === bracketId);
        if (bracketIndex === -1) {
            res.status(404).json({ error: 'Bracket not found' });
            return;
        }

        const bracket = brackets[bracketIndex];
        const match = (bracket.matches || []).find(item => item.id === matchId);
        if (!match) {
            res.status(404).json({ error: 'Match not found' });
            return;
        }

        const adminRequest = isAdminRequester(requesterHandle, adminPassword, req);

        if (!canCreateBracketRoom(bracket, match, requesterHandle, adminPassword, req)) {
            res.status(403).json({ error: 'Only assigned match players or admin can create match rooms' });
            return;
        }

        if (match.status === 'completed') {
            res.status(400).json({ error: 'Match already completed' });
            return;
        }

        if (!match.p1 || !match.p2 || /winner|loser|champion|slot/i.test(`${match.p1} ${match.p2}`)) {
            res.status(400).json({ error: 'This match is not ready yet. Participants are placeholders.' });
            return;
        }

        if (/\bbye\b/i.test(`${match.p1} ${match.p2}`)) {
            res.status(400).json({ error: 'This match includes BYE and should auto-advance without room creation.' });
            return;
        }

        if (match.roomId && rooms.has(match.roomId)) {
            res.json({ success: true, roomId: match.roomId, alreadyExists: true });
            return;
        }

        const roomConfig = normalizeBracketRoomConfig(bracket.roomConfig || {});
        const requestedProblemConfigs = Array.isArray(body.problems) && body.problems.length > 0
            ? normalizeRoomProblems(body.problems, body.problems.length)
            : (Array.isArray(roomConfig.problems) && roomConfig.problems.length > 0
                ? roomConfig.problems
                : buildDefaultProblems(roomConfig.problemCount));
        const bracketUsedProblemIds = getBracketUsedProblemIds(bracket);
        const preGeneratedProblems = [];

        bracket.usedProblemIds = Array.from(new Set([
            ...bracketUsedProblemIds
        ]));

        const participants = resolveBracketRoomPlayers(match, requesterHandle, adminRequest);

        const room = await createBracketRoom({
            hostHandle: participants.hostHandle,
            opponentHandle: participants.opponentHandle,
            roomName: `${bracket.name} · ${match.label} · ${match.p1} vs ${match.p2}`,
            duration: Number(body.duration) || roomConfig.duration,
            interval: Number(body.interval) || roomConfig.interval,
            problems: requestedProblemConfigs,
            problemCount: requestedProblemConfigs.length || Number(body.problemCount) || roomConfig.problemCount,
            preGeneratedProblems,
            bracketId: bracket.id,
            bracketMatchId: match.id,
            bracketExcludedProblemIds: bracket.usedProblemIds
        });

        match.roomId = room.id;
        await writeBrackets(brackets);

        res.json({ success: true, roomId: room.id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const RESERVED_HANDLE_PATHS = new Set([
    'index',
    'results',
    'bracket',
    'headtohead',
    'leaderboard',
    'feedback',
    'profile',
    'api'
]);

app.get('/:handle([A-Za-z0-9._-]{1,24})', (req, res, next) => {
    const handle = String(req.params.handle || '').trim();
    if (!handle) {
        next();
        return;
    }

    if (RESERVED_HANDLE_PATHS.has(handle.toLowerCase())) {
        next();
        return;
    }

    res.redirect(302, `/profile.html?handle=${encodeURIComponent(handle)}`);
});

Promise.all([initResultsFile(), initBracketsFile(), initFeedbackFile(), initLastSeenFile(), initProfilesFile()]).then(() => {
        // Periodically check for break timer expiration and advance to next problem, even if no client is present
        // Helper: Periodically check for break timer expiration and advance to next problem, even if no client is present
        async function periodicBreakAdvanceCheck() {
            for (const room of rooms.values()) {
                if (!room.battleState || room.battleState.status !== 'running') continue;
                const liveState = room.battleState.liveState || {};
                const currentProblemNumber = Number(liveState.currentProblemNumber) || 0;
                const totalProblems = (room.battleState.problemConfigs || room.problems || []).length;
                const hasNextProblem = currentProblemNumber >= 1 && currentProblemNumber < totalProblems;
                if (!hasNextProblem) continue;
                // If in break, and breakEndsAt is reached, advance to next problem
                if (liveState.breakEndsAt && Date.now() >= liveState.breakEndsAt) {
                    const nextProblemNumber = currentProblemNumber + 1;
                    const nextProblemIndex = nextProblemNumber - 1;
                    if (!room.battleState.selectedProblems) {
                        room.battleState.selectedProblems = Array.from({ length: totalProblems }, () => null);
                    }
                    let nextProblem = room.battleState.selectedProblems[nextProblemIndex];
                    if (!nextProblem) {
                        // Generate next problem if not already generated
                        try {
                            const problemConfigs = room.battleState.problemConfigs || room.problems || [];
                            const targetConfig = problemConfigs[nextProblemIndex] || { points: 500, rating: 1200 };
                            const usedProblemIds = Array.isArray(room.battleState.usedProblemIds)
                                ? room.battleState.usedProblemIds
                                : [];
                            nextProblem = await generateRoomProblemForConfig(targetConfig, usedProblemIds);
                            room.battleState.selectedProblems[nextProblemIndex] = nextProblem;
                            if (!room.battleState.usedProblemIds.includes(nextProblem.id)) {
                                room.battleState.usedProblemIds.push(nextProblem.id);
                            }
                            if (room.bracketId) {
                                await reserveBracketProblemIds(room.bracketId, [nextProblem.id]);
                            }
                        } catch (error) {
                            console.error('Failed to generate next problem (server-driven break advance):', error);
                            continue;
                        }
                    }
                    // Advance liveState to next problem
                    room.battleState.liveState = {
                        currentProblemNumber: nextProblemNumber,
                        currentProblem: nextProblem,
                        problemLocked: false,
                        solvedBy: null,
                        breakStartsAt: null,
                        breakEndsAt: null,
                        updatedAt: Date.now()
                    };
                    // Notify (if any clients join later)
                    sendToRoom(room, {
                        type: 'NEXT_PROBLEM_READY',
                        roomId: room.id,
                        problemNumber: nextProblemNumber,
                        problem: nextProblem
                    });
                    saveRoomsToDisk(rooms);
                }
            }
        }

        setInterval(async () => {
            await periodicBreakAdvanceCheck();
        }, 2000); // Check every 2 seconds

        // Also run the break advance check in all other intervals for robustness
        setInterval(periodicBreakAdvanceCheck, 10 * 60 * 1000); // With session cleanup
        setInterval(periodicBreakAdvanceCheck, 60 * 1000); // With session challenge cleanup
        setInterval(periodicBreakAdvanceCheck, ROOM_VALIDATION_POLL_MS); // With validation poll
    setInterval(() => {
        cleanupExpiredSessions();
    }, 10 * 60 * 1000);

    setInterval(() => {
        cleanupExpiredSessionChallenges();
    }, 60 * 1000);

    setInterval(() => {
        rooms.forEach(room => {
            evaluateRoomValidationAndAutoStart(room).catch(() => {});
        });
    }, ROOM_VALIDATION_POLL_MS);

    // Periodically check for match timer endings and process submissions even if no client is connected
    setInterval(() => {
        rooms.forEach(room => {
            if (
                room.battleState &&
                room.battleState.status === 'running' &&
                typeof room.battleState.endsAt === 'number' &&
                Date.now() >= room.battleState.endsAt
            ) {
                // If the match timer has ended, process submissions and finalize the battle
                verifyTimerEndSubmissions(room).catch((err) => {
                    console.error('Periodic timer-end submission verification failed:', err);
                    finalizeBattle(room, 'timer');
                });
            }
        });
    }, ROOM_VALIDATION_POLL_MS);

    // Periodically check for problem solves during running matches (server-driven PROBLEM_SOLVED)
    setInterval(async () => {
        // Helper to persist a problem solve to results.json and bracket state
        async function persistServerDrivenSolve(room, solverHandle, currentProblem, currentProblemNumber) {
            try {
                // Read current results
                const resultsRaw = await fs.readFile(RESULTS_FILE, 'utf8');
                let results = [];
                try { results = JSON.parse(resultsRaw); } catch {}
                // Find the match for this room
                const match = results.find(m => m.roomId === room.id);
                if (match && Array.isArray(match.problems)) {
                    const prob = match.problems.find(p => p.id === (currentProblem.id || `${currentProblem.contestId}${currentProblem.index}`));
                    if (prob) {
                        const nowSec = Math.floor(Date.now() / 1000);
                        if (prob.p1Result && normalizeHandle(solverHandle) === normalizeHandle(room.battleState.player1Handle)) {
                            prob.p1Result.solvedAtSec = nowSec;
                        }
                        if (prob.p2Result && normalizeHandle(solverHandle) === normalizeHandle(room.battleState.player2Handle)) {
                            prob.p2Result.solvedAtSec = nowSec;
                        }
                        await fs.writeFile(RESULTS_FILE, JSON.stringify(results, null, 2));
                    }
                }
                // Also update bracket state
                await updateBracketMatchFromResult({
                    roomId: room.id,
                    winner: null, // winner is determined at match end
                    player1: { handle: room.battleState.player1Handle },
                    player2: { handle: room.battleState.player2Handle },
                    date: new Date().toISOString()
                });
            } catch (err) {
                console.error('Failed to persist server-driven solve:', err);
            }
        }

        for (const room of rooms.values()) {
            if (!room.battleState || room.battleState.status !== 'running') continue;
            const liveState = room.battleState.liveState || {};
            const currentProblemNumber = Number(liveState.currentProblemNumber) || 0;
            const currentProblem = liveState.currentProblem
                || room.battleState.selectedProblems?.[Math.max(0, currentProblemNumber - 1)]
                || null;
            if (!currentProblem || !currentProblem.id) continue;

            const p1 = room.battleState.player1Handle;
            const p2 = room.battleState.player2Handle;
            if (!p1 || !p2) continue;

            // Check if this problem is already solved
            const problemWinnerKey = `${currentProblemNumber}:${currentProblem.id}`;
            if (room.battleState.problemWinners && room.battleState.problemWinners[problemWinnerKey]) continue;

            try {
                const [p1Data, p2Data] = await Promise.all([
                    fetchJson(`https://codeforces.com/api/user.status?handle=${encodeURIComponent(p1)}&from=1&count=100`),
                    fetchJson(`https://codeforces.com/api/user.status?handle=${encodeURIComponent(p2)}&from=1&count=100`)
                ]);
                const p1Analysis = analyzeServerSubmissionsForProblem(p1Data, currentProblem);
                const p2Analysis = analyzeServerSubmissionsForProblem(p2Data, currentProblem);

                let solverHandle = null;
                if (p1Analysis.accepted || p2Analysis.accepted) {
                    if (!p2Analysis.accepted || (p1Analysis.accepted && p1Analysis.accepted.submitMs <= p2Analysis.accepted.submitMs)) {
                        solverHandle = p1;
                    } else {
                        solverHandle = p2;
                    }
                }
                if (solverHandle) {
                    // Simulate handleProblemSolved logic (server-driven)
                    if (!room.battleState.solveAnnouncements) room.battleState.solveAnnouncements = {};
                    if (!room.battleState.problemWinners) room.battleState.problemWinners = {};
                    if (room.battleState.problemWinners[problemWinnerKey]) return;
                    room.battleState.problemWinners[problemWinnerKey] = solverHandle;
                    const solveKey = `${currentProblem.id}:${solverHandle}`;
                    if (room.battleState.solveAnnouncements[solveKey]) return;
                    room.battleState.solveAnnouncements[solveKey] = true;
                    sendToRoom(room, {
                        type: 'PROBLEM_SOLVED',
                        roomId: room.id,
                        solverHandle,
                        problemId: currentProblem.id,
                        problemNumber: currentProblemNumber,
                        solveKey
                    });
                    // Persist the solve to results.json and bracket state
                    await persistServerDrivenSolve(room, solverHandle, currentProblem, currentProblemNumber);
                    // Advance to next problem or update liveState as in handleProblemSolved
                    const totalProblems = (room.battleState.problemConfigs || room.problems || []).length;
                    const solvedProblemNumber = currentProblemNumber;
                    const solvedProblemIndex = solvedProblemNumber - 1;
                    const hasNextProblem = solvedProblemNumber >= 1 && solvedProblemNumber < totalProblems;
                    const now = Date.now();
                    room.battleState.liveState = {
                        currentProblemNumber: solvedProblemNumber,
                        currentProblem: room.battleState.selectedProblems?.[solvedProblemIndex] || null,
                        problemLocked: true,
                        solvedBy: solverHandle,
                        breakStartsAt: hasNextProblem ? now : null,
                        breakEndsAt: hasNextProblem ? now + 60000 : null,
                        updatedAt: now
                    };
                    if (room.breakAdvanceTimeout) {
                        clearTimeout(room.breakAdvanceTimeout);
                        room.breakAdvanceTimeout = null;
                    }
                    if (hasNextProblem) {
                        const nextProblemNumberForLiveState = solvedProblemNumber + 1;
                        room.breakAdvanceTimeout = setTimeout(() => {
                            const targetRoom = rooms.get(room.id);
                            if (!targetRoom || !targetRoom.battleState || targetRoom.battleState.status !== 'running') return;
                            const nextProblemIndexForLiveState = nextProblemNumberForLiveState - 1;
                            targetRoom.battleState.liveState = {
                                currentProblemNumber: nextProblemNumberForLiveState,
                                currentProblem: targetRoom.battleState.selectedProblems?.[nextProblemIndexForLiveState] || null,
                                problemLocked: false,
                                solvedBy: null,
                                breakStartsAt: null,
                                breakEndsAt: null,
                                updatedAt: Date.now()
                            };
                            targetRoom.breakAdvanceTimeout = null;
                        }, 60000);
                    }
                }
            } catch (err) {
                // Ignore fetch errors
            }
        }
    }, 5000); // Check every 5 seconds

    server.on('error', (error) => {
        if (error && error.code === 'EADDRINUSE') {
            console.error(`Port ${PORT} is already in use. Stop the existing server or change PORT.`);
            return;
        }
        console.error('HTTP server error:', error);
    });

    wss.on('error', (error) => {
        console.error('WebSocket server error:', error);
    });

    server.listen(PORT, () => {
        console.log(`Server running on https://blitzing-2.onrender.com`);
    });
}).catch((error) => {
    console.error('Server initialization failed:', error);
});
