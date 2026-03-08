const express = require('express');
const cors = require('cors');
const fs = require('fs');
const store = require('./store');
const {
    RESULTS_FILE,
    initResultsFile,
    initBracketsFile,
    initFeedbackFile,
    initLastSeenFile,
    PROFILES_FILE
} = store;
async function initProfilesFile() {
    try {
        const raw = await fs.promises.readFile(PROFILES_FILE, 'utf8');
        const trimmed = String(raw || '').trim();
        if (!trimmed) {
            await fs.promises.writeFile(PROFILES_FILE, JSON.stringify([]));
            return;
        }
        const parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed)) {
            await fs.promises.writeFile(PROFILES_FILE, JSON.stringify([]));
        }
    } catch (err) {
        await fs.promises.writeFile(PROFILES_FILE, JSON.stringify([]));
    }
}

function ensureSequentialBlitzNumbers(state) {
    if (!Array.isArray(state)) return { normalized: [], changed: false };
    return { normalized: state, changed: false };
}

const { rooms, generateRoomId } = require('./rooms');

// Room timing constants
const ROOM_VALIDATION_POLL_MS = 5000; // ms
const ROOM_NO_OPPONENT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const ROOM_UNSTARTED_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

async function evaluateRoomValidationAndAutoStart(room) {
    // Minimal placeholder: real validation and auto-start logic lives in rooms module or will be reintroduced later.
    return;
}
// Room WebSocket handlers moved to rooms.js

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const path = require('path');

// Serve static frontend files from project root (one level up from /server)
app.use(express.static(path.join(__dirname, '..')));
// Also serve the separated frontend files under /html so requests like /index.html resolve
app.use(express.static(path.join(__dirname, '..', 'html')));
// Mount CSS and JS directories under explicit routes (/css, /js)
app.use('/css', express.static(path.join(__dirname, '..', 'css')));
app.use('/js', express.static(path.join(__dirname, '..', 'js')));

// Development-friendly Content Security Policy: allow self and localhost resources
app.use((req, res, next) => {
    try {
        res.setHeader('Content-Security-Policy', "default-src 'self' 'unsafe-inline'; connect-src 'self' http://localhost:3000 ws://localhost:3000; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;");
    } catch (e) {}
    next();
});

const http = require('http');
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

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

function buildDefaultProblems(problemCount = 7) {
    const count = Number.isFinite(Number(problemCount)) ? Math.max(1, Number(problemCount)) : 7;
    return Array.from({ length: count }, () => ({ points: 500, rating: 1200 }));
}

const heartbeatSeenMap = new Map();
function normalizeHandle(handle) {
    return String(handle || '').trim().toLowerCase();
}
function markHandleSeen(handle, ts) {
    try {
        const now = Number(ts) || Date.now();
        heartbeatSeenMap.set(normalizeHandle(handle), now);
    } catch {}
}

function sendToRoom(room, message) {
    if (!room || !Array.isArray(room.players)) return;
    const payload = typeof message === 'string' ? message : JSON.stringify(message);
    for (const player of room.players) {
        try {
            if (player && player.ws && typeof player.ws.send === 'function') {
                player.ws.send(payload);
            }
        } catch (err) {
            // ignore send errors
        }
    }
}

async function generateValidationProblem() {
    return {
        id: `val_${Date.now()}`,
        contestId: 0,
        index: 'A',
        name: 'Validation Problem',
        rating: 800,
        points: 1,
        generatedAtSec: Math.floor(Date.now() / 1000)
    };
}

async function generateRoomProblemForConfig(config = { rating: 1200 }, excludedIds = []) {
    return {
        id: `p_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
        contestId: 0,
        index: 'A',
        name: 'Generated Problem',
        rating: Number(config.rating) || 1200
    };
}

async function reserveBracketProblemIds(bracketId, ids) {
    // noop placeholder
    return;
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
    require('./rooms-persistence').saveRoomsToDisk(rooms);

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
    require('./rooms').broadcastActiveRooms(wss);

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

// `broadcastActiveRooms` moved to `rooms.js`.

// WebSocket server is initialized from ws.js below

// WebSocket room handlers were moved to `rooms.js` and are registered during initialization.
// Keep `createRoomWithSharedLogic` and other shared helpers in this file; handlers live in the rooms module.

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

// Register API routes from routes.js
const sessionModule = require('./session');
const routesDeps = {
    fs: fs.promises,
    RESULTS_FILE,
    ensureSequentialBlitzNumbers,
    getHandlePresence: (handle) => ({ active: false, lastSeen: null }),
    refreshProfilesCanonicalCasing: async () => {},
    getAllProfiles: () => [],
    extractRequesterHandle: sessionModule.extractRequesterHandle,
    upsertProfileHandle: () => {},
    normalizeHandle: (h) => String(h || '').trim().toLowerCase(),
    heartbeatSeenMap: new Map(),
    markHandleSeen: (h, ts) => {},
    getServerSession: sessionModule.getServerSession,
    clearSessionCookie: sessionModule.clearSessionCookie,
    fetchCodeforcesUserProfile: async () => null,
    generateValidationProblem: async () => null,
    createSessionChallenge: sessionModule.createSessionChallenge,
    createServerSession: sessionModule.createServerSession,
    setSessionCookie: sessionModule.setSessionCookie,
    getSessionChallenge: sessionModule.getSessionChallenge,
    consumeSessionChallenge: sessionModule.consumeSessionChallenge,
    hasCompilationErrorOnProblem: async () => false,
    destroyServerSession: sessionModule.destroyServerSession,
    updateBracketMatchFromResult: async () => {},
    getAdminPinThrottleState: () => ({}),
    extractAdminPassword: () => '',
    isAdminRequester: () => false,
    isValidAdminPassword: () => false,
    readFeedbackStore: store.readFeedbackStore || (async () => ({ items: [], activity: [] })),
    writeFeedbackStore: store.writeFeedbackStore || (async () => {}),
    pushFeedbackActivity: store.pushFeedbackActivity || (() => {}),
    FEEDBACK_DAILY_LIMIT: 10,
    canDeleteFeedbackReply: () => false,
    canManageFeedback: () => false,
    readBrackets: store.readBrackets,
    writeBrackets: store.writeBrackets,
    normalizeParticipants: (p) => p,
    normalizeBracketRoomConfig: (c) => c,
    normalizeRoomProblems,
    buildDefaultProblems,
    generateBracketMatches: () => [],
    // Provided as no-op defaults for routes that call these helpers when
    // the full bracket logic isn't wired into this trimmed server build.
    autoAdvanceBracketByes: () => {},
    applyChampionPlaceholders: () => {},
    resolveBracketRoomPlayers: () => [],
    createBracketRoom,
    getBracketUsedProblemIds: async () => [],
    reserveBracketProblemIds: async () => {},
    WebSocket: null,
    getWss: () => wss
};

require('./routes')(app, routesDeps);

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
                    require('./rooms-persistence').saveRoomsToDisk(rooms);
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
        sessionModule.cleanupExpiredSessions();
    }, 10 * 60 * 1000);

    setInterval(() => {
        sessionModule.cleanupExpiredSessionChallenges();
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

    // Initialize WebSocket server and handlers (handlers come from rooms.js)
    const roomsModule = require('./rooms');
    wss = require('./ws')(server, {
        extractRequesterHandle: sessionModule.extractRequesterHandle,
        markHandleSeen,
        handleCreateRoom: roomsModule.handleCreateRoom,
        handleJoinRoom: roomsModule.handleJoinRoom,
        handleRejoinRoom: roomsModule.handleRejoinRoom,
        handleLeaveRoom: roomsModule.handleLeaveRoom,
        handleEndBattleEarly: roomsModule.handleEndBattleEarly,
        handleProblemSolved: roomsModule.handleProblemSolved,
        handlePendingSubmissionStatus: roomsModule.handlePendingSubmissionStatus,
        sendActiveRooms,
        sendToRoom,
        rooms,
        evaluateRoomValidationAndAutoStart,
        broadcastActiveRooms: roomsModule.broadcastActiveRooms,
        cleanupUnstartedRoomIfHostLeft,
        WebSocket
    });

    // Initialize rooms module dependencies (provide server-side helpers)
    roomsModule.init({
        createRoomWithSharedLogic,
        markHandleSeen,
        roomNameTaken: roomsModule.roomNameTaken,
        normalizeHandle,
        evaluateRoomValidationAndAutoStart,
        sendToRoom,
        getAssignedPlayersCount: roomsModule.getAssignedPlayersCount,
        getConnectedPlayersCount: roomsModule.getConnectedPlayersCount,
        cleanupUnstartedRoomIfHostLeft,
        startBattleForPair: async (room, p1, p2) => {},
        finalizeBattle: async (room, reason) => {},
        saveRoomsToDisk: require('./rooms-persistence').saveRoomsToDisk,
        generateValidationProblem,
        generateRoomProblemForConfig,
        reserveBracketProblemIds,
        getRoomPublicState: roomsModule.getRoomPublicState,
        broadcastActiveRooms: roomsModule.broadcastActiveRooms,
        handleProblemSolved: roomsModule.handleProblemSolved,
        wss
    });

    server.on('error', (error) => {
        if (error && error.code === 'EADDRINUSE') {
            console.error(`Port ${PORT} is already in use. Stop the existing server or change PORT.`);
            return;
        }
        console.error('HTTP server error:', error);
    });

    // Start the HTTP server
    server.listen(PORT, () => {
        console.log(`Server listening on port ${PORT}`);
    });

}).catch((error) => {
    console.error('Server initialization failed:', error);
});
