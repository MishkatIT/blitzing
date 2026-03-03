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
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ROOM_CLEANUP_DELAY_MS = 5 * 60 * 1000;
const ROOM_NO_OPPONENT_TIMEOUT_MS = 10 * 60 * 1000;
const MATCH_START_COUNTDOWN_MS = 15 * 1000;
const ROOM_PENDING_RECHECK_DELAY_MS = 60 * 1000;
const ROOM_VALIDATION_POLL_MS = 2000;

// Store rooms in memory
const rooms = new Map();

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

function canManageBracket(bracket, requesterHandle, adminPassword = '') {
    const isOwner = normalizeHandle(requesterHandle) && normalizeHandle(bracket?.ownerHandle) && normalizeHandle(requesterHandle) === normalizeHandle(bracket.ownerHandle);
    const isAdmin = isValidAdminPassword(adminPassword || '');
    return isOwner || isAdmin;
}

function canCreateBracketRoom(bracket, match, requesterHandle, adminPassword = '') {
    if (isValidAdminPassword(adminPassword || '')) return true;

    const requester = normalizeHandle(requesterHandle);
    if (!requester) return false;

    const owner = normalizeHandle(bracket?.ownerHandle);
    const p1 = normalizeHandle(match?.p1);
    const p2 = normalizeHandle(match?.p2);

    return requester === owner || requester === p1 || requester === p2;
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

async function updateBracketMatchFromResult(resultPayload) {
    const roomId = resultPayload?.roomId;
    if (!roomId) return;

    const brackets = await readBrackets();
    let changed = false;

    for (const bracket of brackets) {
        if (!Array.isArray(bracket.matches)) continue;

        for (const match of bracket.matches) {
            if (match.roomId !== roomId || match.status === 'completed') continue;

            const p1Handle = match.p1;
            const p2Handle = match.p2;
            const winnerRaw = resultPayload.winner;

            let winnerHandle = winnerRaw;
            if (winnerRaw === 'tie') {
                winnerHandle = await resolveTieWinnerByRules(p1Handle, p2Handle);
            }

            match.status = 'completed';
            match.winner = winnerHandle;
            match.result = {
                winnerOriginal: winnerRaw,
                winnerResolved: winnerHandle,
                player1Score: resultPayload?.player1?.score ?? null,
                player2Score: resultPayload?.player2?.score ?? null,
                finishedAt: resultPayload?.date || new Date().toISOString()
            };

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

function isValidAdminPassword(input) {
    if (!ADMIN_PASSWORD || typeof input !== 'string') return false;

    const inputBuffer = Buffer.from(input);
    const adminBuffer = Buffer.from(ADMIN_PASSWORD);
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
        .map(player => player.handle);

    if (room.opponentHandle) {
        if (!handles.includes(room.host)) {
            return { pair: null, waitMessage: 'Waiting for host to be connected.' };
        }
        if (!handles.includes(room.opponentHandle)) {
            return { pair: null, waitMessage: `Waiting for selected opponent ${room.opponentHandle} to join room.` };
        }
        return { pair: [room.host, room.opponentHandle], waitMessage: '' };
    }

    if (handles.length < 2) {
        return { pair: null, waitMessage: 'Waiting for match creator and opponent to be connected.' };
    }

    return { pair: [handles[0], handles[1]], waitMessage: '' };
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

                sendToRoom(room, {
                    type: 'PROBLEM_SOLVED',
                    roomId: room.id,
                    solverHandle,
                    problemId: currentProblem.id || `${currentProblem.contestId}${currentProblem.index}`,
                    problemNumber: currentProblemNumber,
                    solveKey
                });
            }

            break;
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

async function validateHandle(handle) {
    const data = await fetchJson(`https://codeforces.com/api/user.info?handles=${encodeURIComponent(handle)}`);
    return data.status === 'OK';
}

async function hasCompilationErrorOnProblem(handle, validationProblem) {
    if (!validationProblem) return false;
    const data = await fetchJson(`https://codeforces.com/api/user.status?handle=${encodeURIComponent(handle)}&from=1&count=100`);
    if (data.status !== 'OK') return false;

    return data.result.some(sub => {
        if (!sub.problem) return false;
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
        url: `https://codeforces.com/problemset/problem/${chosen.contestId}/${chosen.index}`
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

async function startBattleForPair(room, startP1, startP2) {
    if (!room || (room.battleState && room.battleState.status === 'running')) return;

    const excludedIds = room.validationProblem ? [room.validationProblem.id] : [];
    let firstProblem = room.preGeneratedFirstProblem;
    if (!firstProblem) {
        firstProblem = await generateRoomProblemForConfig(room.problems[0] || { points: 500, rating: 1200 }, excludedIds);
    }
    room.preGeneratedFirstProblem = null;

    const selectedProblems = Array.from({ length: room.problems.length }, () => null);
    selectedProblems[0] = firstProblem;

    const usedProblemIds = [...excludedIds];
    if (!usedProblemIds.includes(firstProblem.id)) {
        usedProblemIds.push(firstProblem.id);
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
            currentProblemNumber: 1,
            currentProblem: firstProblem,
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

    broadcastActiveRooms();
}

async function evaluateRoomValidationAndAutoStart(room) {
    if (!room) return;
    if (room.battleState && room.battleState.status === 'running') return;
    if (isBattleEnded(room) || isRoomExpired(room)) return;
    if (room.validationCheckInProgress || room.startInProgress || room.countdownInProgress) return;

    if (!room.validationProblem) {
        broadcastValidationStatus(room, {
            pair: [],
            statuses: {},
            message: 'Validation problem is being generated. Please wait...'
        });
        return;
    }

    const { pair, waitMessage } = getAutoStartPair(room);
    if (!pair) {
        broadcastValidationStatus(room, {
            pair: [],
            statuses: {},
            message: waitMessage || 'Waiting for two participants to join room.'
        });
        return;
    }

    const [p1, p2] = pair;

    room.validationCheckInProgress = true;
    try {
        const [validP1, validP2, p1HasCE, p2HasCE] = await Promise.all([
            validateHandle(p1),
            validateHandle(p2),
            hasCompilationErrorOnProblem(p1, room.validationProblem),
            hasCompilationErrorOnProblem(p2, room.validationProblem)
        ]);

        const statuses = {
            [p1]: !!(validP1 && p1HasCE),
            [p2]: !!(validP2 && p2HasCE)
        };

        let message = 'Waiting for match creator and selected opponent to submit Compilation Error to the provided problem.';
        if (!validP1 || !validP2) {
            message = 'One of the selected participant handles is invalid on Codeforces.';
        } else if (statuses[p1] && statuses[p2]) {
            message = 'Both participants verified. Match starts in 15 seconds.';
        } else if (!statuses[p1] && statuses[p2]) {
            message = `Waiting for ${p1} to submit Compilation Error to the provided problem.`;
        } else if (statuses[p1] && !statuses[p2]) {
            message = `Waiting for ${p2} to submit Compilation Error to the provided problem.`;
        }

        broadcastValidationStatus(room, {
            pair,
            statuses,
            message
        });

        if (validP1 && validP2 && statuses[p1] && statuses[p2] && !room.countdownInProgress) {
            const excludedIds = room.validationProblem ? [room.validationProblem.id] : [];
            try {
                room.preGeneratedFirstProblem = await generateRoomProblemForConfig(room.problems[0] || { points: 500, rating: 1200 }, excludedIds);
            } catch (generationError) {
                console.error('Problem generation before countdown failed:', generationError);
                broadcastValidationStatus(room, {
                    pair,
                    statuses,
                    message: 'Could not generate battle problems. Retrying validation check...'
                });
                room.preGeneratedFirstProblem = null;
                return;
            }

            room.countdownInProgress = true;
            room.countdownEndsAt = Date.now() + MATCH_START_COUNTDOWN_MS;

            sendToRoom(room, {
                type: 'MATCH_COUNTDOWN_STARTED',
                roomId: room.id,
                startsAt: room.countdownEndsAt,
                seconds: 15,
                pair: [p1, p2]
            });

            room.countdownTimeout = setTimeout(async () => {
                const targetRoom = rooms.get(room.id);
                if (!targetRoom) return;
                if (targetRoom.battleState && targetRoom.battleState.status === 'running') return;

                const { pair: livePair } = getAutoStartPair(targetRoom);
                const canStartWithPair = !!livePair
                    && livePair.length === 2
                    && livePair[0] === p1
                    && livePair[1] === p2;
                if (!canStartWithPair) {
                    targetRoom.countdownInProgress = false;
                    targetRoom.countdownEndsAt = null;
                    targetRoom.countdownTimeout = null;
                    targetRoom.preGeneratedFirstProblem = null;
                    await evaluateRoomValidationAndAutoStart(targetRoom);
                    return;
                }

                targetRoom.startInProgress = true;
                try {
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
        }
    } catch (error) {
        console.error('Validation auto-start check failed:', error);
    } finally {
        room.validationCheckInProgress = false;
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
        broadcastActiveRooms();
    }, delay);
}

function cleanupUnstartedRoomIfHostLeft(room, leftHandle) {
    if (!room || room.battleState) return false;
    if (leftHandle !== room.host) return false;

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
    validationFailureMessage = 'Validation problem generation failed. Please recreate room.'
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
        countdownTimeout: null,
        countdownEndsAt: null,
        countdownInProgress: false,
        preGeneratedFirstProblem: null,
        pendingSubmissionActive: false,
        validationCheckInProgress: false,
        startInProgress: false,
        breakAdvanceTimeout: null
    };

    rooms.set(roomId, room);

    room.noOpponentTimeout = setTimeout(() => {
        const currentRoom = rooms.get(roomId);
        if (!currentRoom) return;
        if (currentRoom.battleState) return;
        if (getAssignedPlayersCount(currentRoom) >= 2) return;

        sendToRoom(currentRoom, {
            type: 'ROOM_CLOSED',
            roomId: currentRoom.id,
            message: 'Room closed: no opponent joined within 10 minutes.'
        });

        rooms.delete(roomId);
        broadcastActiveRooms();
    }, ROOM_NO_OPPONENT_TIMEOUT_MS);

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

async function createBracketRoom({ hostHandle, opponentHandle, roomName, duration = 40, interval = 1, problems = [], problemCount = 7 }) {
    return createRoomWithSharedLogic({
        hostHandle,
        hostWs: null,
        opponentHandle,
        roomName,
        duration,
        interval,
        problems,
        problemCount,
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
wss.on('connection', (ws) => {
    console.log('New WebSocket connection');
    
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            
            switch(data.type) {
                case 'CREATE_ROOM':
                    await handleCreateRoom(ws, data);
                    break;
                    
                case 'JOIN_ROOM':
                    handleJoinRoom(ws, data);
                    break;
                    
                case 'REJOIN_ROOM':
                    handleRejoinRoom(ws, data);
                    break;
                    
                case 'LEAVE_ROOM':
                    handleLeaveRoom(ws, data);
                    break;
                    
                case 'START_BATTLE':
                    handleStartBattle(ws, data);
                    break;

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
            }
        } catch (error) {
            console.error('WebSocket message error:', error);
        }
    });
    
    ws.on('close', () => {
        for (const [_, room] of rooms.entries()) {
            const playerIndex = room.players.findIndex(player => player.ws === ws);
            if (playerIndex !== -1) {
                const leftHandle = room.players[playerIndex].handle;
                room.players[playerIndex].ws = null;

                if (cleanupUnstartedRoomIfHostLeft(room, leftHandle)) {
                    broadcastActiveRooms();
                    break;
                }

                broadcastActiveRooms();
                break;
            }
        }
    });
});

async function handleCreateRoom(ws, data) {
    const roomName = (data.roomName || '').trim() || `${data.handle}'s Room`;
    const opponentHandle = (data.opponentHandle || '').trim();

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

    if (opponentHandle === data.handle) {
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

    if (!room.players.some(player => player.handle === solverHandle)) return;

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
        }, 60000);
    }

    if (solvedProblemNumber < 1 || solvedProblemNumber >= totalProblems) {
        return;
    }

    const nextProblemNumber = solvedProblemNumber + 1;
    const nextProblemIndex = nextProblemNumber - 1;
    if (!room.battleState.selectedProblems) {
        room.battleState.selectedProblems = Array.from({ length: totalProblems }, () => null);
    }
    if (room.battleState.selectedProblems[nextProblemIndex]) {
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

        sendToRoom(room, {
            type: 'NEXT_PROBLEM_READY',
            roomId: room.id,
            problemNumber: nextProblemNumber,
            problem: nextProblem
        });
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


    const existingIndex = room.players.findIndex(player => player.handle === data.handle);
    if (existingIndex !== -1) {
        room.players[existingIndex].ws = ws;
        
        ws.send(JSON.stringify({
            type: 'REJOIN_SUCCESS',
            serverNow: Date.now(),
            roomId: room.id,
            roomData: getRoomPublicState(room),
            isHost: room.host === data.handle
        }));
        
        sendToRoom(room, {
            type: 'PLAYER_RECONNECTED',
            handle: data.handle,
            players: room.players.filter(p => !!p.handle).map(p => p.handle)
        });
        
        broadcastActiveRooms();
        return;
    }

    room.players.push({ handle: data.handle, ws });

    if (room.noOpponentTimeout && getAssignedPlayersCount(room) >= 2) {
        clearTimeout(room.noOpponentTimeout);
        room.noOpponentTimeout = null;
    }

    const joinedRole = (data.handle === room.host || data.handle === room.opponentHandle)
        ? 'player'
        : 'spectator';

    sendToRoom(room, {
        type: 'PLAYER_JOINED',
        handle: data.handle,
        role: joinedRole,
        players: room.players.filter(p => !!p.handle).map(p => p.handle)
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
    
    const playerIndex = room.players.findIndex(player => player.handle === data.handle);
    if (playerIndex === -1) {
        ws.send(JSON.stringify({
            type: 'JOIN_ERROR',
            message: 'Player not found in room'
        }));
        return;
    }

    room.players[playerIndex].ws = ws;
    
    ws.send(JSON.stringify({
        type: 'REJOIN_SUCCESS',
        serverNow: Date.now(),
        roomId: room.id,
        roomData: getRoomPublicState(room),
        isHost: room.host === data.handle
    }));
    
    sendToRoom(room, {
        type: 'PLAYER_RECONNECTED',
        handle: data.handle,
        players: room.players.filter(p => !!p.handle).map(p => p.handle)
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
        message: 'Auto-start enabled: battle will start immediately after two participants submit Compilation Error on generated problem.'
    }));
}

function sendActiveRooms(ws) {
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
    if (!isValidAdminPassword(suppliedPassword)) {
        res.status(401).json({ error: 'Invalid admin password' });
        return;
    }

    res.json({ success: true });
});

app.delete('/api/results', async (req, res) => {
    const suppliedPassword = extractAdminPassword(req);
    if (!isValidAdminPassword(suppliedPassword)) {
        res.status(401).json({ error: 'Invalid admin password' });
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
        const ownerHandle = String(body.ownerHandle || '').trim();
        const type = String(body.type || 'round-robin').trim();
        const participants = normalizeParticipants(body.participants || []);
        const roomConfig = normalizeBracketRoomConfig(body.roomConfig || {});

        if (!ownerHandle) {
            res.status(400).json({ error: 'ownerHandle is required' });
            return;
        }

        if (participants.length < 2) {
            res.status(400).json({ error: 'At least 2 participants required' });
            return;
        }

        const supported = ['round-robin', 'single-elimination', 'double-elimination'];
        if (!supported.includes(type)) {
            res.status(400).json({ error: 'Unsupported tournament type' });
            return;
        }

        const bracket = {
            id: `b_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: String(body.name || 'Tournament').trim() || 'Tournament',
            type,
            ownerHandle,
            participants,
            roomConfig,
            matches: generateBracketMatches(type, participants),
            createdAt: new Date().toISOString()
        };

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
        const requesterHandle = String(req.query.requesterHandle || '').trim();
        const adminPassword = extractAdminPassword(req);

        const brackets = await readBrackets();
        const target = brackets.find(item => item.id === bracketId);
        if (!target) {
            res.status(404).json({ error: 'Bracket not found' });
            return;
        }

        if (!canManageBracket(target, requesterHandle, adminPassword)) {
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
        const requesterHandle = String(body.requesterHandle || '').trim();
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

        if (!canCreateBracketRoom(bracket, match, requesterHandle, adminPassword)) {
            res.status(403).json({ error: 'Only match players, bracket creator, or admin can create match rooms' });
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

        if (match.roomId && rooms.has(match.roomId)) {
            res.json({ success: true, roomId: match.roomId, alreadyExists: true });
            return;
        }

        const roomConfig = normalizeBracketRoomConfig(bracket.roomConfig || {});

        const room = await createBracketRoom({
            hostHandle: match.p1,
            opponentHandle: match.p2,
            roomName: `${bracket.name} · ${match.label} · ${match.p1} vs ${match.p2}`,
            duration: Number(body.duration) || roomConfig.duration,
            interval: Number(body.interval) || roomConfig.interval,
            problems: Array.isArray(body.problems) ? body.problems : (Array.isArray(roomConfig.problems) ? roomConfig.problems : []),
            problemCount: Number(body.problemCount) || roomConfig.problemCount
        });

        match.roomId = room.id;
        await writeBrackets(brackets);

        res.json({ success: true, roomId: room.id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

Promise.all([initResultsFile(), initBracketsFile()]).then(() => {
    setInterval(() => {
        rooms.forEach(room => {
            evaluateRoomValidationAndAutoStart(room).catch(() => {});
        });
    }, ROOM_VALIDATION_POLL_MS);

    server.listen(PORT, () => {
        console.log(`Server running on https://blitzing-2.onrender.com`);
    });
});
