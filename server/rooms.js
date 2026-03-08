const { initRoomsFile, loadRoomsFromDisk } = require('./rooms-persistence');

// In-memory rooms map (exported so other modules can use it)
const rooms = new Map();

// Initialize persistent rooms file and restore saved rooms
initRoomsFile();
(async () => {
    try {
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
    } catch (err) {
        // Fail silently; server will start with empty rooms
        // console.error('Failed to restore rooms from disk:', err);
    }
})();

module.exports = { rooms };

// Helper: generate random room ID
function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function roomNameTaken(name) {
    const normalized = (name || '').trim().toLowerCase();
    if (!normalized) return false;
    return Array.from(rooms.values()).some(room => String(room.name || '').toLowerCase() === normalized);
}

function getConnectedPlayersCount(room) {
    if (!room || !Array.isArray(room.players)) return 0;
    return room.players.filter(player => !!player.ws).length;
}

function getAssignedPlayersCount(room) {
    if (!room || !Array.isArray(room.players)) return 0;
    return room.players.filter(player => !!player.handle).length;
}

function isBattleRunning(room) {
    if (!room || !room.battleState) return false;
    return room.battleState.status === 'running' && Date.now() < room.battleState.endsAt;
}

function isBattleEnded(room) {
    if (!room || !room.battleState) return false;
    return room.battleState.status === 'ended' || Date.now() >= room.battleState.endsAt;
}

function isRoomExpired(room) {
    if (!room || !room.battleState || !room.battleState.cleanupAt) return false;
    return Date.now() >= room.battleState.cleanupAt;
}

function getFirstTwoConnectedHandles(room) {
    if (!room || !Array.isArray(room.players)) return null;
    const handles = room.players
        .filter(player => player.handle && player.ws && player.ws.readyState === require('ws').OPEN)
        .map(player => player.handle);
    if (handles.length < 2) return null;
    return [handles[0], handles[1]];
}

function getConnectedHandles(room) {
    if (!room || !Array.isArray(room.players)) return [];
    return room.players
        .filter(player => !!player.handle && !!player.ws && player.ws.readyState === require('ws').OPEN)
        .map(player => player.handle);
}

function getRoomPublicState(room) {
    if (!room) return null;
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
        players: Array.isArray(room.players) ? room.players.filter(player => !!player.handle).map(player => player.handle) : [],
        battleState: room.battleState
    };
}

module.exports = {
    rooms,
    generateRoomId,
    roomNameTaken,
    getConnectedPlayersCount,
    getAssignedPlayersCount,
    isBattleRunning,
    isBattleEnded,
    isRoomExpired,
    getFirstTwoConnectedHandles,
    getConnectedHandles,
    getRoomPublicState
};

// Broadcast active rooms over provided WebSocket server
function broadcastActiveRooms(wss) {
    if (!wss) return;
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
            problems: Array.isArray(room.problems) ? room.problems.length : 0,
            battleRunning: isBattleRunning(room)
        }));

    wss.clients.forEach(client => {
        if (client.readyState === require('ws').OPEN) {
            client.send(JSON.stringify({
                type: 'ACTIVE_ROOMS',
                rooms: activeRooms
            }));
        }
    });
}

module.exports.broadcastActiveRooms = broadcastActiveRooms;

// Internal dependency container (set by server.js)
let _deps = {};

function init(deps = {}) {
    _deps = deps;
}

async function handleCreateRoom(ws, data) {
    console.log('[SERVER] handleCreateRoom called', { authHandle: ws.authHandle, userHandle: ws.userHandle, payload: data ? { roomName: data.roomName, opponentHandle: data.opponentHandle, duration: data.duration, interval: data.interval } : null });
    try { require('fs').appendFileSync('server/room_debug.log', JSON.stringify({ ts: Date.now(), event: 'handleCreateRoom', authHandle: ws.authHandle, payload: data || null }) + '\n'); } catch (e) {}
    const {
        createRoomWithSharedLogic,
        markHandleSeen
    } = _deps;

    const roomName = (data.roomName || '').trim() || `${data.handle}'s Room`;
    const opponentHandle = (data.opponentHandle || '').trim();

    const now = Date.now();
    const cutoff = now - 24 * 60 * 60 * 1000;
    const createdRooms = Array.from(rooms.values()).filter(r => String((r.hostHandle || '')).trim().toLowerCase() === String((data.handle || '')).trim().toLowerCase() && r.createdAt >= cutoff);
    if (createdRooms.length >= 100) {
        ws.send(JSON.stringify({ type: 'CREATE_ERROR', message: 'Room creation limit reached (100 per 24 hours).' }));
        return;
    }

    if (_deps.roomNameTaken && _deps.roomNameTaken(roomName)) {
        ws.send(JSON.stringify({ type: 'CREATE_ERROR', message: 'Room name already exists. Please choose a unique room name.' }));
        return;
    }

    if (!opponentHandle) {
        ws.send(JSON.stringify({ type: 'CREATE_ERROR', message: 'Opponent handle is required.' }));
        return;
    }

    if (_deps.normalizeHandle && _deps.normalizeHandle(opponentHandle) === _deps.normalizeHandle(data.handle)) {
        ws.send(JSON.stringify({ type: 'CREATE_ERROR', message: 'Opponent handle must be different from your handle.' }));
        return;
    }

    let room;
    try {
        room = await createRoomWithSharedLogic({
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
    } catch (err) {
        console.error('[SERVER] createRoomWithSharedLogic threw', err && err.stack ? err.stack : err);
        try { require('fs').appendFileSync('server/room_debug.log', JSON.stringify({ ts: Date.now(), event: 'createRoomError', error: String(err && err.stack ? err.stack : err) }) + '\n'); } catch(e){}
        try { ws.send(JSON.stringify({ type: 'CREATE_ERROR', message: 'Server error creating room' })); } catch(e){}
        return;
    }

    ws.userHandle = data.handle;
    if (markHandleSeen) markHandleSeen(data.handle, Date.now());

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
    console.log('[SERVER] Sent ROOM_CREATED to', data.handle, 'roomId', room.id);
    try { require('fs').appendFileSync('server/room_debug.log', JSON.stringify({ ts: Date.now(), event: 'sent_ROOM_CREATED', to: data.handle, roomId: room.id }) + '\n'); } catch (e) {}
}

function handlePendingSubmissionStatus(ws, data) {
    const room = rooms.get(data.roomId);
    if (!room || !room.battleState) return;

    const sender = room.players.find(player => player.ws === ws);
    if (!sender || !sender.handle) return;

    room.pendingSubmissionActive = !!data.hasPending;

    if (!room.pendingSubmissionActive && room.battleState.status === 'ended') {
        if (typeof scheduleRoomCleanup === 'function') scheduleRoomCleanup(room);
    }
}

function handleEndBattleEarly(ws, data) {
    const room = rooms.get(data.roomId);
    if (!room || !room.battleState || room.battleState.status !== 'running') return;

    const sender = room.players.find(player => player.ws === ws);
    if (!sender || !sender.handle) return;

    if (_deps.finalizeBattle) _deps.finalizeBattle(room, data.reason || 'all-problems-solved');
}

async function handleProblemSolved(ws, data) {
    if (_deps && _deps.handleProblemSolved) return _deps.handleProblemSolved(ws, data);
}

function handleJoinRoom(ws, data) {
    const room = rooms.get(data.roomId);
    if (!room) {
        ws.send(JSON.stringify({ type: 'JOIN_ERROR', message: 'Room not found' }));
        return;
    }

    if (_deps && _deps.isRoomExpired && _deps.isRoomExpired(room)) {
        ws.send(JSON.stringify({ type: 'JOIN_ERROR', message: 'This blitz room already ended and moved to past results.' }));
        return;
    }

    if (_deps && _deps.isBattleEnded && _deps.isBattleEnded(room)) {
        ws.send(JSON.stringify({ type: 'JOIN_ERROR', message: 'This blitz room already ended and moved to past results.' }));
        return;
    }

    const existingIndex = room.players.findIndex(player => _deps.normalizeHandle(player.handle) === _deps.normalizeHandle(data.handle));
    if (existingIndex !== -1) {
        room.players[existingIndex].ws = ws;
        ws.userHandle = data.handle;
        if (_deps.markHandleSeen) _deps.markHandleSeen(data.handle, Date.now());
        ws.send(JSON.stringify({
            type: 'REJOIN_SUCCESS',
            serverNow: Date.now(),
            roomId: room.id,
            roomData: _deps.getRoomPublicState ? _deps.getRoomPublicState(room) : null,
            isHost: room.host === data.handle,
            countdownInProgress: !!room.countdownInProgress,
            countdownEndsAt: room.countdownEndsAt || null,
            battleState: room.battleState || null
        }));
        if (_deps.sendToRoom) _deps.sendToRoom(room, { type: 'PLAYER_RECONNECTED', handle: data.handle, players: room.players.filter(p => !!p.handle).map(p => p.handle), countdownInProgress: !!room.countdownInProgress, countdownEndsAt: room.countdownEndsAt || null, battleState: room.battleState || null });
        if (_deps.evaluateRoomValidationAndAutoStart) _deps.evaluateRoomValidationAndAutoStart(room).catch(() => {});
        if (_deps.broadcastActiveRooms) _deps.broadcastActiveRooms(_deps.wss);
        return;
    }

    room.players.push({ handle: data.handle, ws });
    ws.userHandle = data.handle;
    if (_deps.markHandleSeen) _deps.markHandleSeen(data.handle, Date.now());

    if (room.noOpponentTimeout && _deps.getAssignedPlayersCount && _deps.getAssignedPlayersCount(room) >= 2) {
        clearTimeout(room.noOpponentTimeout);
        room.noOpponentTimeout = null;
    }

    const joinedHandle = _deps.normalizeHandle(data.handle);
    const hostHandle = _deps.normalizeHandle(room.host);
    const opponentHandle = _deps.normalizeHandle(room.opponentHandle);
    const joinedRole = (joinedHandle && (joinedHandle === hostHandle || joinedHandle === opponentHandle)) ? 'player' : 'spectator';

    if (_deps.sendToRoom) _deps.sendToRoom(room, { type: 'PLAYER_JOINED', handle: data.handle, role: joinedRole, players: room.players.filter(p => !!p.handle).map(p => p.handle), roomId: room.id, roomName: room.name, duration: room.duration, interval: room.interval, problems: room.problems, validationProblem: room.validationProblem });

    ws.send(JSON.stringify({ type: 'ROOM_JOINED', serverNow: Date.now(), roomId: room.id, roomName: room.name, playerIndex: room.players.length - 1, players: room.players.filter(p => !!p.handle).map(p => p.handle), isHost: room.host === data.handle, opponentHandle: room.opponentHandle, duration: room.duration, interval: room.interval, problems: room.problems, validationProblem: room.validationProblem, battleState: room.battleState, countdownInProgress: !!room.countdownInProgress, countdownEndsAt: room.countdownEndsAt || null }));

    if (_deps.evaluateRoomValidationAndAutoStart) _deps.evaluateRoomValidationAndAutoStart(room).catch(() => {});
    if (_deps.broadcastActiveRooms) _deps.broadcastActiveRooms(_deps.wss);
}

function handleRejoinRoom(ws, data) {
    const room = rooms.get(data.roomId);
    if (!room) { ws.send(JSON.stringify({ type: 'JOIN_ERROR', message: 'Room not found' })); return; }
    const playerIndex = room.players.findIndex(player => _deps.normalizeHandle(player.handle) === _deps.normalizeHandle(data.handle));
    if (playerIndex === -1) { ws.send(JSON.stringify({ type: 'JOIN_ERROR', message: 'Player not found in room' })); return; }

    room.players[playerIndex].ws = ws;
    ws.userHandle = data.handle;
    if (_deps.markHandleSeen) _deps.markHandleSeen(data.handle, Date.now());

    ws.send(JSON.stringify({ type: 'REJOIN_SUCCESS', serverNow: Date.now(), roomId: room.id, roomData: _deps.getRoomPublicState ? _deps.getRoomPublicState(room) : null, isHost: room.host === data.handle, countdownInProgress: !!room.countdownInProgress, countdownEndsAt: room.countdownEndsAt || null, battleState: room.battleState || null }));
    if (_deps.sendToRoom) _deps.sendToRoom(room, { type: 'PLAYER_RECONNECTED', handle: data.handle, players: room.players.filter(p => !!p.handle).map(p => p.handle), countdownInProgress: !!room.countdownInProgress, countdownEndsAt: room.countdownEndsAt || null, battleState: room.battleState || null });

    if (_deps.evaluateRoomValidationAndAutoStart) _deps.evaluateRoomValidationAndAutoStart(room).catch(() => {});
    if (_deps.broadcastActiveRooms) _deps.broadcastActiveRooms(_deps.wss);
}

function handleLeaveRoom(ws, data) {
    const room = rooms.get(data.roomId);
    if (!room) return;

    const playerIndex = room.players.findIndex(player => player.ws === ws);
    if (playerIndex !== -1) {
        const leftHandle = room.players[playerIndex].handle;
        room.players[playerIndex].ws = null;

        if (_deps.sendToRoom) _deps.sendToRoom(room, { type: 'PLAYER_LEFT', handle: leftHandle, players: room.players.filter(p => !!p.handle).map(p => p.handle) });

        if (_deps.cleanupUnstartedRoomIfHostLeft && _deps.cleanupUnstartedRoomIfHostLeft(room, leftHandle)) {
            if (_deps.broadcastActiveRooms) _deps.broadcastActiveRooms(_deps.wss);
            return;
        }

        if (_deps.evaluateRoomValidationAndAutoStart) _deps.evaluateRoomValidationAndAutoStart(room).catch(() => {});
        if (_deps.broadcastActiveRooms) _deps.broadcastActiveRooms(_deps.wss);
    }
}

async function handleStartBattle(ws, data) {
    const room = rooms.get(data.roomId);
    if (!room) return;

    if (_deps.getAssignedPlayersCount && _deps.getAssignedPlayersCount(room) < 2) {
        ws.send(JSON.stringify({ type: 'START_ERROR', message: 'At least two participants are required to start battle.' }));
        return;
    }

    if (room.battleState && room.battleState.status === 'running') {
        ws.send(JSON.stringify({ type: 'START_ERROR', message: 'Battle is already running.' }));
        return;
    }

    const sender = room.players.find(player => player.ws === ws);
    if (!sender || !sender.handle) return;

    const hostHandle = _deps.normalizeHandle(room.host);
    const requester = _deps.normalizeHandle(sender.handle);
    if (requester !== hostHandle && _deps.normalizeHandle(data.handle) !== hostHandle) {
        ws.send(JSON.stringify({ type: 'START_ERROR', message: 'Only the host can start the match.' }));
        return;
    }

    const p1 = room.host;
    const p2 = room.opponentHandle;
    if (!p1 || !p2) {
        ws.send(JSON.stringify({ type: 'START_ERROR', message: 'Match must have two players to start.' }));
        return;
    }

    if (_deps.startBattleForPair) {
        _deps.startBattleForPair(room, p1, p2);
    }
}

module.exports.init = init;
module.exports.handleCreateRoom = handleCreateRoom;
module.exports.handleJoinRoom = handleJoinRoom;
module.exports.handleRejoinRoom = handleRejoinRoom;
module.exports.handleLeaveRoom = handleLeaveRoom;
module.exports.handleStartBattle = handleStartBattle;
module.exports.handleEndBattleEarly = handleEndBattleEarly;
module.exports.handleProblemSolved = handleProblemSolved;
module.exports.handlePendingSubmissionStatus = handlePendingSubmissionStatus;
