const WebSocketLib = require('ws');

module.exports = function initWebSocketServer(server, deps = {}) {
    const {
        extractRequesterHandle,
        markHandleSeen,
        handleCreateRoom,
        handleJoinRoom,
        handleRejoinRoom,
        handleLeaveRoom,
        handleEndBattleEarly,
        handleProblemSolved,
        handlePendingSubmissionStatus,
        sendActiveRooms,
        sendToRoom,
        rooms,
        evaluateRoomValidationAndAutoStart,
        broadcastActiveRooms,
        cleanupUnstartedRoomIfHostLeft,
        WebSocket
    } = deps;

    const wss = new WebSocketLib.Server({ server });

    // Helper used only inside websocket handlers
    function handlePlayerReadyToStart(ws, data) {
        const room = rooms.get(data.roomId);
        if (!room) return;

        let sender = room.players.find(player => player.ws === ws);
        if (!sender && data.handle) {
            sender = room.players.find(player => String(player.handle || '').trim().toLowerCase() === String(data.handle || '').trim().toLowerCase());
        }
        if (!sender || !sender.handle) return;
        if (!room.playerReady) room.playerReady = {};
        const normalizedHandle = String(sender.handle || '').trim().toLowerCase();
        room.playerReady[normalizedHandle] = true;
        evaluateRoomValidationAndAutoStart(room).catch(() => {});
    }

    wss.on('connection', (ws, req) => {
        try {
            const remote = req && req.socket ? req.socket.remoteAddress : 'unknown';
            console.log('[SERVER] New WebSocket connection from', remote, 'authHandle prelim:', String((extractRequesterHandle && extractRequesterHandle(req)) || ''));
        } catch (e) {
            console.log('[SERVER] New WebSocket connection');
        }
        ws.userHandle = '';
        ws.authHandle = String((extractRequesterHandle && extractRequesterHandle(req)) || '').trim();
        console.log('[SERVER] connection assigned authHandle:', ws.authHandle);

        ws.on('message', async (message) => {
            try {
                const data = JSON.parse(message);
                const authenticatedHandle = String(ws.authHandle || '').trim();
                switch (data.type) {
                    case 'CREATE_ROOM':
                        if (!authenticatedHandle) {
                            ws.send(JSON.stringify({ type: 'CREATE_ERROR', message: 'Login required' }));
                            break;
                        }
                        data.handle = authenticatedHandle;
                        await (handleCreateRoom && handleCreateRoom(ws, data));
                        break;
                    case 'JOIN_ROOM':
                        if (!authenticatedHandle) {
                            ws.send(JSON.stringify({ type: 'JOIN_ERROR', message: 'Login required' }));
                            break;
                        }
                        data.handle = authenticatedHandle;
                        handleJoinRoom && handleJoinRoom(ws, data);
                        break;
                    case 'REJOIN_ROOM':
                        if (!authenticatedHandle) {
                            ws.send(JSON.stringify({ type: 'JOIN_ERROR', message: 'Login required' }));
                            break;
                        }
                        data.handle = authenticatedHandle;
                        handleRejoinRoom && handleRejoinRoom(ws, data);
                        break;
                    case 'LEAVE_ROOM':
                        handleLeaveRoom && handleLeaveRoom(ws, data);
                        break;
                    case 'PLAYER_READY_TO_START':
                        handlePlayerReadyToStart(ws, data);
                        break;
                    case 'END_BATTLE_EARLY':
                        handleEndBattleEarly && handleEndBattleEarly(ws, data);
                        break;
                    case 'PROBLEM_SOLVED':
                        await (handleProblemSolved && handleProblemSolved(ws, data));
                        break;
                    case 'PENDING_SUBMISSION_STATUS':
                        handlePendingSubmissionStatus && handlePendingSubmissionStatus(ws, data);
                        break;
                    case 'GET_ACTIVE_ROOMS':
                        sendActiveRooms && sendActiveRooms(ws);
                        break;
                    case 'SET_ACTIVE_HANDLE':
                        if (authenticatedHandle) {
                            ws.userHandle = authenticatedHandle;
                            markHandleSeen && markHandleSeen(ws.userHandle, Date.now());
                        }
                        break;
                }
            } catch (error) {
                console.error('WebSocket message error:', error);
            }
        });

        ws.on('close', () => {
            if (ws.userHandle) {
                markHandleSeen && markHandleSeen(ws.userHandle, Date.now());
            }

            for (const [_, room] of rooms.entries()) {
                const playerIndex = room.players.findIndex(player => player.ws === ws);
                if (playerIndex !== -1) {
                    const leftHandle = room.players[playerIndex].handle;
                    room.players[playerIndex].ws = null;

                    sendToRoom && sendToRoom(room, {
                        type: 'PLAYER_LEFT',
                        handle: leftHandle,
                        players: room.players.filter(p => !!p.handle).map(p => p.handle)
                    });

                    if (cleanupUnstartedRoomIfHostLeft && cleanupUnstartedRoomIfHostLeft(room, leftHandle)) {
                        broadcastActiveRooms && broadcastActiveRooms();
                        break;
                    }

                    evaluateRoomValidationAndAutoStart && evaluateRoomValidationAndAutoStart(room).catch(() => {});

                    broadcastActiveRooms && broadcastActiveRooms();
                    break;
                }
            }
        });
    });

    wss.on('error', (error) => {
        console.error('WebSocket server error:', error);
    });

    return wss;
};
