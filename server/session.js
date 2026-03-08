const crypto = require('crypto');

const SESSION_COOKIE_NAME = 'blitz_sid';
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_SECRET = process.env.BLITZ_SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_CHALLENGE_TTL_MS = 10 * 60 * 1000;

const sessionStore = new Map();
const sessionChallengeStore = new Map();

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
    if (!canonicalHandle) return null;

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
    const normalizedHandle = String(canonicalHandle || '').trim().toLowerCase();
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

module.exports = {
    createServerSession,
    getServerSession,
    destroyServerSession,
    cleanupExpiredSessions,
    createSessionChallenge,
    getSessionChallenge,
    consumeSessionChallenge,
    cleanupExpiredSessionChallenges,
    extractRequesterHandle,
    setSessionCookie,
    clearSessionCookie,
    readSessionIdFromRequest
};
