(function() {
    // State
    let userHandle = '';
    let playersValidated = false;
    let currentRoom = null;
    let isHost = false;
    let ws = null;
    let reconnectAttempts = 0;
    let roomData = null;
    
    // Battle state
    let player1Handle = '';
    let player2Handle = '';
    let player1Score = 0;
    let player2Score = 0;
    let player1Rank = '';
    let player2Rank = '';
    let player1RankColor = '';
    let player2RankColor = '';
    let battleActive = false;
    let timerInterval = null;
    let apiCheckInterval = null;
    let totalDurationSec = 600;
    let timeLeftSec = 600;
    let checkIntervalSec = 1;
    let currentProblem = null;
    let currentProblemOpenedAt = null;
    let problemLocked = false;
    let breakActive = false;
    let breakSecondsLeft = 0;
    let breakStartTime = null;
    let currentProblemIndex = 0;
    let blitzNumber = 1;
    let notificationPermission = false;
    let battleStartTime = null;
    let battleDuration = 600;
    let battleEndsAt = null;
    let matchKey = null;
    let selectedProblems = [];
    let resultSubmitted = false;
    let validationProblem = null;
    let queuedNextProblem = null;
    let solveNotificationKeys = new Set();
    let matchEndNotificationShown = false;
    let matchCountdownTimer = null;
    let matchCountdownEndsAt = null;
    let timerEndVerificationInProgress = false;
    let endAfterCurrentSolve = false;
    let activeOSNotifications = [];
    let pendingSubmissionStatusReported = null;
    let userAvatarUrl = '';
    let handleVerificationProblem = null;
    let handleVerificationHandle = '';
    let handleVerificationTimer = null;
    let serverClockOffsetMs = 0;

    
    // Track solved problems
    let p1SolvedProblems = new Set();
    let p2SolvedProblems = new Set();
    
    // Problems configuration
    let problems = [
        { points: 2, rating: 800 },
        { points: 3, rating: 800 },
        { points: 4, rating: 900 },
        { points: 6, rating: 1000 },
        { points: 8, rating: 1000 },
        { points: 10, rating: 1100 },
        { points: 12, rating: 1200 }
    ];
    let problemResults = {
        p1: [],
        p2: []
    };

    // DOM elements
    const userHandleInput = document.getElementById('userHandleInput');
    const setHandleBtn = document.getElementById('setHandleBtn');
    const loggedInfo = document.getElementById('loggedInfo');
    const createRoomBtn = document.getElementById('createRoomBtn');
    const roomNameInput = document.getElementById('roomNameInput');
    const opponentHandleInput = document.getElementById('opponentHandleInput');
    const createDuration = document.getElementById('createDuration');
    const createInterval = document.getElementById('createInterval');
    const createProblemsList = document.getElementById('createProblemsList');
    const createAddProblemBtn = document.getElementById('createAddProblemBtn');
    const joinRoomBtn = document.getElementById('joinRoomBtn');
    const joinRoomIdInput = document.getElementById('joinRoomIdInput');
    const activeBlitzList = document.getElementById('activeBlitzList');
    const roomControls = document.getElementById('roomControls');
    const activeBlitzSection = document.getElementById('activeBlitzSection');
    const roomInfoBar = document.getElementById('roomInfoBar');
    const currentRoomName = document.getElementById('currentRoomName');
    const currentRoomId = document.getElementById('currentRoomId');
    const roomPlayers = document.getElementById('roomPlayers');
    const roomValidationMini = document.getElementById('roomValidationMini');
    const leaveRoomBtn = document.getElementById('leaveRoomBtn');
    const configDashboard = document.getElementById('configDashboard');
    const validationSection = document.getElementById('validationSection');
    const validationProblemLink = document.getElementById('validationProblemLink');
    const validationProblemTitle = document.getElementById('validationProblemTitle');
    const validationStatusText = document.getElementById('validationStatusText');
    const displayDuration = document.getElementById('displayDuration');
    const displayInterval = document.getElementById('displayInterval');
    const displayProblems = document.getElementById('displayProblems');
    const problemsDisplaySection = document.getElementById('problemsDisplaySection');
    const problemsDisplayBody = document.getElementById('problemsDisplayBody');
    const matchStatusBar = document.getElementById('matchStatusBar');
    const leaderboard = document.getElementById('leaderboard');
    const arenaPanel = document.getElementById('arenaPanel');
    const startBattleBtn = document.getElementById('startBattleBtn');
    const startP1HandleInput = document.getElementById('startP1HandleInput');
    const startP2HandleInput = document.getElementById('startP2HandleInput');
    const cancelGameBtn = document.getElementById('cancelGameBtn');
    
    // Battle DOM elements
    const p1HandleSpan = document.getElementById('p1Handle');
    const p2HandleSpan = document.getElementById('p2Handle');
    const p1RankSpan = document.getElementById('p1Rank');
    const p2RankSpan = document.getElementById('p2Rank');
    const p1ScoreSpan = document.getElementById('p1Score');
    const p2ScoreSpan = document.getElementById('p2Score');
    const p1Row = document.getElementById('player1Row');
    const p2Row = document.getElementById('player2Row');
    const probNameSpan = document.getElementById('probName');
    const probPointsSpan = document.getElementById('probPoints');
    const probRatingSpan = document.getElementById('probRating');
    const problemUrl = document.getElementById('problemUrl');
    const lockStatusDiv = document.getElementById('lockStatus');
    const breakTimerDiv = document.getElementById('breakTimer');
    const matchTimer = document.getElementById('matchTimer');
    const matchStatusText = document.getElementById('matchStatusText');
    const breakIndicator = document.getElementById('breakIndicator');
    const leaderboardHeader = document.getElementById('leaderboardHeader');
    const leaderboardBody = document.getElementById('leaderboardBody');
    
    // Modals
    const passwordModal = document.getElementById('passwordModal');
    const passwordInput = document.getElementById('passwordInput');
    const confirmCancel = document.getElementById('confirmCancel');
    const cancelPassword = document.getElementById('cancelPassword');
    const celebrationModal = document.getElementById('celebrationModal');
    const winnerHandleSpan = document.getElementById('winnerHandle');
    const closeCelebrationBtn = document.getElementById('closeCelebration');
    const notificationCenter = document.getElementById('notificationCenter');
    const matchCountdownOverlay = document.getElementById('matchCountdownOverlay');
    const matchCountdownTime = document.getElementById('matchCountdownTime');
    const handleSetupModal = document.getElementById('handleSetupModal');
    const generateHandleVerificationBtn = document.getElementById('generateHandleVerificationBtn');
    const closeHandleSetup = document.getElementById('closeHandleSetup');
    const verifyHandleCeBtn = document.getElementById('verifyHandleCeBtn');
    const handleVerificationBlock = document.getElementById('handleVerificationBlock');
    const handleVerificationProblemLink = document.getElementById('handleVerificationProblemLink');
    const handleVerificationStatus = document.getElementById('handleVerificationStatus');

    const API_BASE_URL = window.location.origin;
    const WS_URL = window.location.origin.replace('http', 'ws');

    // Rating options
    const ratingOptions = [800, 900, 1000, 1100, 1200, 1300, 1400, 1500, 1600];

    function getUserHandleStorageKey() {
        return 'blitzUserHandle';
    }

    function syncServerClock(serverNow) {
        if (typeof serverNow !== 'number' || !Number.isFinite(serverNow)) return;
        serverClockOffsetMs = serverNow - Date.now();
    }

    function getSyncedNow() {
        return Date.now() + serverClockOffsetMs;
    }

    function getUserAvatarStorageKey() {
        return 'blitzUserAvatar';
    }

    function getPendingJoinRoomIdKey() {
        return 'blitzPendingJoinRoomId';
    }

    function tryJoinPendingRoom() {
        const pendingRoomId = (localStorage.getItem(getPendingJoinRoomIdKey()) || '').trim().toUpperCase();
        if (!pendingRoomId) return;
        if (!userHandle) return;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;

        joinRoomIdInput.value = pendingRoomId;
        ws.send(JSON.stringify({
            type: 'JOIN_ROOM',
            roomId: pendingRoomId,
            handle: userHandle
        }));

        localStorage.removeItem(getPendingJoinRoomIdKey());
    }

    function renderLoggedInfo() {
        if (!userHandle) {
            loggedInfo.classList.remove('user-chip');
            loggedInfo.textContent = 'Not verified';
            return;
        }

        const avatarMarkup = userAvatarUrl
            ? `<img src="${userAvatarUrl}" alt="${userHandle}" class="logged-avatar">`
            : '';

        loggedInfo.classList.add('user-chip');
        loggedInfo.innerHTML = `${avatarMarkup}<span>${userHandle}</span>`;
    }

    // Load saved state
    function loadSavedState() {
        const persistedHandle = localStorage.getItem(getUserHandleStorageKey()) || '';
        const persistedAvatar = localStorage.getItem(getUserAvatarStorageKey()) || '';
        if (persistedHandle) {
            userHandle = persistedHandle;
            userAvatarUrl = persistedAvatar;
            playersValidated = true;
            userHandleInput.value = userHandle;
            renderLoggedInfo();
        }

        const saved = localStorage.getItem('blitzRoomState');
        if (saved) {
            try {
                const state = JSON.parse(saved);
                userHandle = state.userHandle || userHandle;
                userAvatarUrl = state.userAvatarUrl || userAvatarUrl;
                playersValidated = !!userHandle;
                currentRoom = state.currentRoom || null;
                isHost = state.isHost || false;
                roomData = state.roomData || null;
                
                if (userHandle) {
                    userHandleInput.value = userHandle;
                    renderLoggedInfo();
                }
                
                if (currentRoom && roomData) {
                    setTimeout(() => {
                        reconnectToRoom();
                    }, 1000);
                }
            } catch (e) {
                console.error('Error loading state:', e);
            }
        }

        renderLoggedInfo();
        
        renderCreateProblems();
    }

    // Save state
    function saveState() {
        const state = {
            userHandle,
            userAvatarUrl,
            currentRoom,
            isHost,
            roomData
        };
        localStorage.setItem('blitzRoomState', JSON.stringify(state));
        if (userHandle) {
            localStorage.setItem(getUserHandleStorageKey(), userHandle);
            localStorage.setItem(getUserAvatarStorageKey(), userAvatarUrl || '');
        }
    }

    function getRuntimeStateKey() {
        return 'blitzBattleRuntimeState';
    }

    function saveBattleRuntimeState() {
        if (!battleActive || !currentRoom || !matchKey) return;
        const runtimeState = {
            roomId: currentRoom,
            matchKey,
            player1Score,
            player2Score,
            currentProblemIndex,
            currentProblem,
            currentProblemOpenedAt,
            problemLocked,
            breakActive,
            breakSecondsLeft,
            breakStartTime,
            problemResults,
            p1SolvedProblems: Array.from(p1SolvedProblems),
            p2SolvedProblems: Array.from(p2SolvedProblems),
            savedAt: Date.now()
        };
        localStorage.setItem(getRuntimeStateKey(), JSON.stringify(runtimeState));
    }

    function loadBattleRuntimeState() {
        const saved = localStorage.getItem(getRuntimeStateKey());
        if (!saved) return null;
        try {
            return JSON.parse(saved);
        } catch {
            return null;
        }
    }

    function clearBattleRuntimeState() {
        localStorage.removeItem(getRuntimeStateKey());
    }

    // Clear saved state
    function clearSavedState() {
        localStorage.removeItem('blitzRoomState');
        clearBattleRuntimeState();
    }

    // Reconnect to room
    function reconnectToRoom() {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            connectWebSocket();
        } else {
            ws.send(JSON.stringify({
                type: 'REJOIN_ROOM',
                roomId: currentRoom,
                handle: userHandle
            }));
        }
    }

    // WebSocket connection
    function connectWebSocket() {
        ws = new WebSocket(WS_URL);
        
        ws.onopen = () => {
            console.log('WebSocket connected');
            reconnectAttempts = 0;
            
            if (currentRoom) {
                ws.send(JSON.stringify({
                    type: 'REJOIN_ROOM',
                    roomId: currentRoom,
                    handle: userHandle
                }));
            } else {
                ws.send(JSON.stringify({ type: 'GET_ACTIVE_ROOMS' }));
            }

            tryJoinPendingRoom();
        };
        
        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            handleWebSocketMessage(data);
        };
        
        ws.onclose = () => {
            console.log('WebSocket disconnected');
            if (reconnectAttempts < 5) {
                setTimeout(() => {
                    reconnectAttempts++;
                    connectWebSocket();
                }, 2000);
            }
        };
        
        ws.onerror = (error) => {
            console.error('WebSocket error:', error);
        };
    }

    function handleWebSocketMessage(data) {
        syncServerClock(data?.serverNow);

        switch(data.type) {
            case 'ROOM_CREATED':
                currentRoom = data.roomId;
                isHost = true;
                roomData = {
                    id: data.roomId,
                    name: data.roomName,
                    opponentHandle: data.opponentHandle,
                    duration: data.duration,
                    interval: data.interval,
                    problems: data.problems,
                    validationProblem: data.validationProblem
                };
                joinRoomUI(data.roomId, data.roomName, [userHandle], data.duration, data.interval, data.problems, data.validationProblem);
                saveState();
                break;

            case 'CREATE_ERROR':
                alert(data.message || 'Failed to create room');
                break;
                
            case 'ROOM_JOINED':
                currentRoom = data.roomId;
                isHost = data.isHost;
                roomData = {
                    id: data.roomId,
                    name: data.roomName,
                    players: data.players || [],
                    opponentHandle: data.opponentHandle,
                    duration: data.duration,
                    interval: data.interval,
                    problems: data.problems,
                    validationProblem: data.validationProblem
                };
                joinRoomUI(data.roomId, data.roomName, data.players, data.duration, data.interval, data.problems, data.validationProblem);
                if (data.battleState && data.battleState.status === 'running') {
                    restoreBattleState(data.battleState);
                } else if (data.countdownInProgress && data.countdownEndsAt) {
                    startMatchCountdown(data.countdownEndsAt);
                }
                saveState();
                break;

            case 'PLAYER_JOINED':
                updateRoomPlayers(data.players || []);
                if (data.handle) {
                    const joinedLabel = data.role === 'spectator' ? 'Spectator Joined' : 'Player Joined';
                    showDesktopNotification(`👋 ${joinedLabel}`, `${data.handle} joined the room`, false, true);
                }
                break;
                
            case 'REJOIN_SUCCESS':
                currentRoom = data.roomId;
                isHost = data.isHost;
                roomData = data.roomData;
                joinRoomUI(
                    data.roomId,
                    data.roomData.name,
                    data.roomData.players || [],
                    data.roomData.duration,
                    data.roomData.interval,
                    data.roomData.problems,
                    data.roomData.validationProblem
                );
                
                if (data.roomData.battleState && data.roomData.battleState.status === 'running') {
                    restoreBattleState(data.roomData.battleState);
                } else if (data.roomData.countdownInProgress && data.roomData.countdownEndsAt) {
                    startMatchCountdown(data.roomData.countdownEndsAt);
                }
                saveState();
                break;
                
            case 'JOIN_ERROR':
                alert('Error joining room: ' + data.message);
                currentRoom = null;
                isHost = false;
                roomData = null;
                clearSavedState();
                break;
                
            case 'PLAYER_LEFT':
                showDesktopNotification('👋 Player Left', `${data.handle} left the room`);
                updateRoomPlayers(data.players);
                break;
                
            case 'PLAYER_RECONNECTED':
                showDesktopNotification('🔄 Player Reconnected', `${data.handle} reconnected`);
                updateRoomPlayers(data.players);
                break;
                
            case 'ACTIVE_ROOMS':
                displayActiveRooms(data.rooms);
                break;
                
            case 'BATTLE_STARTED':
                stopMatchCountdown();
                showDesktopNotification('🚀 Match Started', 'Blitz match has started for both players.', false, true);
                startBattleFromHost(data.battleState);
                break;

            case 'MATCH_COUNTDOWN_STARTED':
                startMatchCountdown(data.startsAt);
                break;

            case 'VALIDATION_PROBLEM_READY':
                if (data.roomId === currentRoom && data.validationProblem) {
                    if (!roomData) roomData = {};
                    roomData.validationProblem = data.validationProblem;
                    setValidationProblem(data.validationProblem, roomData.players || []);
                    saveState();
                }
                break;

            case 'START_ERROR':
                if (validationStatusText && data.message) {
                    validationStatusText.textContent = data.message;
                }
                break;

            case 'VALIDATION_STATUS': {
                const pair = data.pair || [];
                const statuses = data.statuses || {};
                if (pair.length >= 2) {
                    startP1HandleInput.value = pair[0];
                    startP2HandleInput.value = pair[1];
                    startP1HandleInput.disabled = true;
                    startP2HandleInput.disabled = true;

                    const p1Ok = !!statuses[pair[0]];
                    const p2Ok = !!statuses[pair[1]];
                    validationStatusText.textContent = `${pair[0]}: ${p1Ok ? 'CE ✅' : 'CE ⏳'} | ${pair[1]}: ${p2Ok ? 'CE ✅' : 'CE ⏳'} · ${data.message || ''}`;
                } else {
                    validationStatusText.textContent = data.message || 'Waiting for match creator and selected opponent to be connected.';
                }
                break;
            }

            case 'BATTLE_FINISHED':
                if (timerEndVerificationInProgress) {
                    matchStatusText.textContent = '⏱️ Match timer ended. Checking pending submissions...';
                    break;
                }
                stopBattle(true);
                break;

            case 'PROBLEM_SOLVED': {
                const solveKey = data.solveKey || `${data.problemId}:${data.solverHandle}`;
                if (!solveNotificationKeys.has(solveKey)) {
                    solveNotificationKeys.add(solveKey);
                    showDesktopNotification('✅ Problem Solved!', `${data.solverHandle} solved Problem ${data.problemNumber}!`, false, true);
                }

                if (battleActive && !problemLocked) {
                    const solvedProblemNumber = Number(data.problemNumber) || 0;
                    const isCurrentProblem = solvedProblemNumber === currentProblemIndex;
                    if (isCurrentProblem) {
                        if (data.solverHandle === player1Handle) {
                            handleSolve('p1');
                        } else if (data.solverHandle === player2Handle) {
                            handleSolve('p2');
                        }
                    }
                }
                break;
            }

            case 'NEXT_PROBLEM_READY': {
                const nextProblemNumber = Number(data.problemNumber) || 0;
                const nextProblemIndex = nextProblemNumber - 1;
                if (nextProblemIndex >= 0 && data.problem) {
                    if (!Array.isArray(selectedProblems)) {
                        selectedProblems = [];
                    }
                    selectedProblems[nextProblemIndex] = data.problem;

                    if (battleActive && currentProblemIndex === nextProblemIndex && !currentProblem) {
                        queuedNextProblem = data.problem;
                        loadNextProblem().then(() => {
                            if (battleActive && !breakActive && currentProblem && !apiCheckInterval) {
                                apiCheckInterval = setInterval(checkSubmissions, checkIntervalSec * 1000);
                            }
                        });
                    } else if (breakActive && currentProblemIndex === nextProblemIndex) {
                        queuedNextProblem = data.problem;
                    }

                    showDesktopNotification('🆕 New Problem Ready', `Problem ${nextProblemNumber} generated and ready for next round.`, false, true);

                    saveBattleRuntimeState();
                }
                break;
            }

            case 'NEXT_PROBLEM_ERROR':
                if (data.message && breakActive) {
                    lockStatusDiv.textContent = `⏳ ${data.message}`;
                }
                break;

            case 'ROOM_CLOSED':
                if (data.roomId === currentRoom) {
                    leaveRoom();
                }
                break;
        }
    }

    function restoreBattleState(state) {
        stopMatchCountdown();
        player1Handle = state.player1Handle;
        player2Handle = state.player2Handle;
        const liveState = state.liveState || {};
        const problemConfigs = state.problemConfigs || [];
        selectedProblems = state.selectedProblems || [];
        if (problemConfigs.length > 0) {
            problems = problemConfigs.map(problem => ({ points: problem.points, rating: problem.rating }));
        } else {
            problems = selectedProblems
                .filter(problem => !!problem)
                .map(problem => ({ points: problem.points, rating: problem.rating }));
        }
        totalDurationSec = state.duration * 60;
        checkIntervalSec = state.interval;
        battleStartTime = state.startsAt;
        battleEndsAt = state.endsAt;
        battleDuration = totalDurationSec;
        matchKey = `${currentRoom}-${state.startsAt}`;
        resultSubmitted = false;
        matchEndNotificationShown = false;

        player1Score = 0;
        player2Score = 0;
        battleActive = true;
        const currentProblemNumberFromLive = Number(liveState.currentProblemNumber) || 0;
        currentProblemIndex = Math.max(0, currentProblemNumberFromLive);
        currentProblem = liveState.currentProblem || (currentProblemIndex > 0 ? selectedProblems[currentProblemIndex - 1] : null);
        problemLocked = !!liveState.problemLocked;
        breakActive = false;
        breakSecondsLeft = 0;
        breakStartTime = null;
        timeLeftSec = Math.max(0, Math.floor((battleEndsAt - getSyncedNow()) / 1000));
        problemResults = {
            p1: problems.map(() => ({ attempts: 0, solved: false, pending: false })),
            p2: problems.map(() => ({ attempts: 0, solved: false, pending: false }))
        };

        const problemWinners = state.problemWinners || {};
        Object.entries(problemWinners).forEach(([problemWinnerKey, winnerHandle]) => {
            const [problemNumberStr] = String(problemWinnerKey).split(':');
            const problemNumber = Number(problemNumberStr) || 0;
            if (problemNumber < 1 || problemNumber > problems.length) return;

            const problemPoints = problems[problemNumber - 1]?.points || selectedProblems[problemNumber - 1]?.points || 0;
            if (winnerHandle === player1Handle) {
                player1Score += problemPoints;
            } else if (winnerHandle === player2Handle) {
                player2Score += problemPoints;
            }
        });

        const breakEndsAtFromLive = Number(liveState.breakEndsAt) || 0;
        if (breakEndsAtFromLive > getSyncedNow()) {
            breakActive = true;
            breakStartTime = Number(liveState.breakStartsAt) || (breakEndsAtFromLive - 60000);
            breakSecondsLeft = Math.max(0, Math.ceil((breakEndsAtFromLive - getSyncedNow()) / 1000));
        }

        const runtimeState = loadBattleRuntimeState();
        if (runtimeState && runtimeState.roomId === currentRoom && runtimeState.matchKey === matchKey) {
            player1Score = runtimeState.player1Score || 0;
            player2Score = runtimeState.player2Score || 0;
            currentProblemIndex = runtimeState.currentProblemIndex || 0;
            currentProblem = runtimeState.currentProblem || null;
            currentProblemOpenedAt = runtimeState.currentProblemOpenedAt || null;
            problemLocked = !!runtimeState.problemLocked;
            breakActive = !!runtimeState.breakActive;
            breakStartTime = runtimeState.breakStartTime || null;
            problemResults = runtimeState.problemResults || problemResults;
            p1SolvedProblems = new Set(runtimeState.p1SolvedProblems || []);
            p2SolvedProblems = new Set(runtimeState.p2SolvedProblems || []);

            if (breakActive && breakStartTime) {
                const elapsedSeconds = Math.floor((Date.now() - breakStartTime) / 1000);
                breakSecondsLeft = Math.max(0, 60 - elapsedSeconds);
                if (breakSecondsLeft <= 0) {
                    breakActive = false;
                    breakStartTime = null;
                    breakSecondsLeft = 0;
                }
            }
        }
        
        showBattleUI();
        validationSection.style.display = 'none';
        updatePlayerUI();
        renderProblemsDisplay();
        updateTimerDisplay();

        if (currentProblem) {
            const problemPoints = selectedProblems[Math.max(0, currentProblemIndex - 1)]?.points || currentProblem.points || 500;
            probNameSpan.textContent = currentProblem.name;
            probPointsSpan.textContent = problemPoints;
            probRatingSpan.textContent = `Rating: ${currentProblem.rating}`;
            problemUrl.href = currentProblem.url;
            problemUrl.style.pointerEvents = 'auto';
            problemUrl.style.opacity = '1';
            lockStatusDiv.textContent = problemLocked
                ? `🔒 LOCKED · solved`
                : `🔓 Problem ${currentProblemIndex}/${problems.length} · waiting for AC`;
            lockStatusDiv.className = 'problem-lock-status';
        } else if (!breakActive) {
            loadNextProblem();
        }

        if (breakActive) {
            breakTimerDiv.style.display = 'block';
            breakTimerDiv.textContent = `⏳ break ${breakSecondsLeft}s`;
            breakIndicator.style.display = 'inline-block';
            breakIndicator.textContent = `Break ${breakSecondsLeft}s`;
        }
        
        startBattleTimer();
        if (apiCheckInterval) clearInterval(apiCheckInterval);
        if (!breakActive) {
            apiCheckInterval = setInterval(checkSubmissions, checkIntervalSec * 1000);
        }

        saveBattleRuntimeState();
    }

    // Render problems in create room form
    function renderCreateProblems() {
        let html = '';
        problems.forEach((prob, idx) => {
            let ratingOptionsHtml = '';
            ratingOptions.forEach(rating => {
                const selected = rating === prob.rating ? 'selected' : '';
                ratingOptionsHtml += `<option value="${rating}" ${selected}>${rating}</option>`;
            });
            
            html += `
                <div class="create-problem-item" data-index="${idx}">
                    <input type="number" class="problem-points-create" value="${prob.points}" min="1" max="2000" step="1" placeholder="Points">
                    <select class="problem-rating-create">
                        ${ratingOptionsHtml}
                    </select>
                    <button class="remove-create-problem" ${problems.length <= 1 ? 'disabled' : ''}>✕</button>
                </div>
            `;
        });
        createProblemsList.innerHTML = html;
        
        document.querySelectorAll('.problem-points-create').forEach(input => {
            input.addEventListener('change', (e) => {
                const idx = e.target.closest('.create-problem-item').dataset.index;
                problems[idx].points = Math.max(1, parseInt(e.target.value) || 1);
            });
        });
        
        document.querySelectorAll('.problem-rating-create').forEach(select => {
            select.addEventListener('change', (e) => {
                const idx = e.target.closest('.create-problem-item').dataset.index;
                problems[idx].rating = parseInt(e.target.value);
            });
        });
        
        document.querySelectorAll('.remove-create-problem').forEach(btn => {
            btn.addEventListener('click', (e) => {
                if (problems.length <= 1) return;
                const idx = e.target.closest('.create-problem-item').dataset.index;
                problems.splice(idx, 1);
                renderCreateProblems();
            });
        });
    }

    // Add problem in create form
    createAddProblemBtn.addEventListener('click', () => {
        problems.push({ points: 500, rating: 1200 });
        renderCreateProblems();
    });

    function setValidationProblem(problem, players = []) {
        validationProblem = problem || null;

        validationSection.style.display = 'block';
        if (!validationProblem) {
            validationProblemLink.href = '#';
            validationProblemLink.style.pointerEvents = 'none';
            validationProblemLink.style.opacity = '0.7';
            validationProblemTitle.textContent = 'Generating validation problem...';
            validationStatusText.textContent = 'Please wait. Validation problem is being prepared.';
            roomValidationMini.style.display = 'none';
            return;
        }

        validationProblemLink.href = validationProblem.url;
        validationProblemLink.style.pointerEvents = 'auto';
        validationProblemLink.style.opacity = '1';
        validationProblemTitle.textContent = `${validationProblem.name} · ${validationProblem.rating}`;

        roomValidationMini.href = validationProblem.url;
        roomValidationMini.style.display = 'inline-block';

        if (players.length < 2) {
            validationStatusText.textContent = 'Waiting for selected opponent to join match creator room and submit Compilation Error to the provided problem.';
        } else {
            validationStatusText.textContent = 'Waiting for match creator and selected opponent to submit Compilation Error to the provided problem.';
        }
    }

    function joinRoomUI(roomId, roomName, players, duration, interval, roomProblems, roomValidationProblem = null) {
        roomControls.style.display = 'none';
        activeBlitzSection.style.display = 'none';
        
        roomInfoBar.style.display = 'flex';
        currentRoomName.textContent = roomName;
        currentRoomId.textContent = roomId;
        
        displayDuration.value = `${duration} min`;
        displayInterval.value = `${interval} sec`;
        displayProblems.value = `${roomProblems.length} problems`;
        
        problems = roomProblems;
        setValidationProblem(roomValidationProblem, players);
        renderProblemsDisplay();
        
        updateRoomPlayers(players);
        
        if (players.length >= 2) {
            configDashboard.style.display = 'flex';
            problemsDisplaySection.style.display = 'block';
            
            player1Handle = players[0];
            player2Handle = players[1];
            p1HandleSpan.textContent = player1Handle;
            p2HandleSpan.textContent = player2Handle;
            p1HandleSpan.href = `https://codeforces.com/profile/${player1Handle}`;
            p2HandleSpan.href = `https://codeforces.com/profile/${player2Handle}`;

            startP1HandleInput.value = player1Handle;
            startP2HandleInput.value = player2Handle;
            
            startBattleBtn.textContent = '⏳ AUTO START ENABLED';
            startBattleBtn.disabled = true;
            startP1HandleInput.disabled = true;
            startP2HandleInput.disabled = true;
            
            fetchUserRanks();
        } else {
            configDashboard.style.display = 'none';
            problemsDisplaySection.style.display = 'none';
        }
    }

    function renderProblemsDisplay() {
        let html = '';
        problems.forEach((prob, idx) => {
            html += `
                <tr>
                    <td>Problem ${idx + 1}</td>
                    <td>${prob.points}</td>
                    <td>${prob.rating}</td>
                </tr>
            `;
        });
        problemsDisplayBody.innerHTML = html;
    }

    function updateRoomPlayers(players) {
        roomPlayers.textContent = `👥 ${players.length} joined`;
    }

    function displayActiveRooms(rooms) {
        if (rooms.length === 0) {
            activeBlitzList.innerHTML = '<div class="loading">No active rooms</div>';
            return;
        }
        
        let html = '';
        rooms.forEach(room => {
            html += `
                <div class="blitz-room-card">
                    <div class="blitz-room-info">
                        <h4>${room.name}</h4>
                        <p>ID: ${room.id} | 👥 ${room.assignedPlayers || room.players} joined</p>
                        <p>⏱️ ${room.duration} min | 🔄 ${room.interval}s | 📋 ${room.problems} problems</p>
                    </div>
                    <button class="join-this-room-btn" onclick="window.joinRoom('${room.id}')">Join</button>
                </div>
            `;
        });
        activeBlitzList.innerHTML = html;
    }

    window.joinRoom = function(roomId) {
        if (!userHandle) {
            alert('Please set your handle first');
            return;
        }
        joinRoomIdInput.value = roomId;
        joinRoomBtn.focus();
    };

    function stopHandleVerificationPolling() {
        if (handleVerificationTimer) {
            clearInterval(handleVerificationTimer);
            handleVerificationTimer = null;
        }
    }

    function closeHandleSetupModal() {
        stopHandleVerificationPolling();
        handleSetupModal.style.display = 'none';
    }

    async function completeHandleSetup(profile) {
        userHandle = profile.handle;
        userAvatarUrl = profile.avatar || '';
        playersValidated = true;
        userHandleInput.value = profile.handle;
        renderLoggedInfo();
        await ensureNotificationPermission();
        saveState();
        closeHandleSetupModal();
        showDesktopNotification('✅ Handle Verified', `${profile.handle} verified successfully`);
    }

    async function verifyHandleCompilationErrorNow() {
        if (!handleVerificationHandle || !handleVerificationProblem) {
            return;
        }

        handleVerificationStatus.textContent = 'Checking Codeforces submissions...';
        const passed = await hasCompilationErrorOnProblem(handleVerificationHandle, handleVerificationProblem);
        if (passed) {
            const profile = await fetchUserProfile(handleVerificationHandle);
            if (profile) {
                await completeHandleSetup(profile);
                return;
            }
        }

        handleVerificationStatus.textContent = 'Not found yet. Submit COMPILATION_ERROR on the generated problem and verify again.';
    }

    async function startHandleVerificationFlow() {
        const handle = userHandleInput.value.trim();
        if (!handle) {
            alert('Please enter a handle');
            return;
        }

        const profile = await fetchUserProfile(handle);
        if (!profile) {
            alert('Invalid Codeforces handle');
            return;
        }

        const problem = await generateHandleVerificationProblem();
        if (!problem) {
            alert('Could not generate verification problem right now. Please try again.');
            return;
        }

        handleVerificationHandle = profile.handle;
        handleVerificationProblem = problem;
        handleVerificationProblemLink.href = problem.url;
        handleVerificationProblemLink.textContent = `${problem.name} · ${problem.rating}`;
        handleVerificationBlock.style.display = 'block';
        handleVerificationStatus.textContent = `Submit COMPILATION_ERROR on this problem from @${profile.handle}. Auto-checking every 5s...`;

        stopHandleVerificationPolling();
        handleVerificationTimer = setInterval(() => {
            verifyHandleCompilationErrorNow().catch(() => {});
        }, 5000);
    }

    setHandleBtn.addEventListener('click', () => {
        userHandleInput.value = userHandle || '';
        handleVerificationProblem = null;
        handleVerificationHandle = '';
        handleVerificationBlock.style.display = 'none';
        handleVerificationProblemLink.href = '#';
        handleVerificationStatus.textContent = 'Waiting for COMPILATION_ERROR submission...';
        handleSetupModal.style.display = 'flex';
        userHandleInput.focus();
    });

    generateHandleVerificationBtn.addEventListener('click', () => {
        startHandleVerificationFlow().catch(error => {
            console.error('Handle verification flow failed:', error);
            alert('Could not start handle verification right now.');
        });
    });

    verifyHandleCeBtn.addEventListener('click', () => {
        verifyHandleCompilationErrorNow().catch(error => {
            console.error('Manual CE verification failed:', error);
        });
    });

    closeHandleSetup.addEventListener('click', () => {
        closeHandleSetupModal();
    });

    // Create room
    createRoomBtn.addEventListener('click', async () => {
        await ensureNotificationPermission();

        if (!userHandle) {
            alert('Please set your handle first');
            return;
        }

        if (!ws || ws.readyState !== WebSocket.OPEN) {
            alert('Connection not ready. Please wait a moment and try again.');
            return;
        }
        
        const roomName = roomNameInput.value.trim() || `${userHandle}'s Room`;
        const opponentHandle = opponentHandleInput.value.trim();
        const duration = parseInt(createDuration.value) || 40;
        const interval = parseInt(createInterval.value) || 1;

        if (!opponentHandle) {
            alert('Please enter opponent Codeforces handle before creating room');
            return;
        }
        if (opponentHandle === userHandle) {
            alert('Opponent handle must be different from your handle');
            return;
        }
        
        ws.send(JSON.stringify({
            type: 'CREATE_ROOM',
            handle: userHandle,
            roomName: roomName,
            opponentHandle,
            duration: duration,
            interval: interval,
            problems: problems
        }));
    });

    // Join room
    joinRoomBtn.addEventListener('click', () => {
        ensureNotificationPermission().catch(() => {});

        if (!userHandle) {
            alert('Please set your handle first');
            return;
        }

        if (!ws || ws.readyState !== WebSocket.OPEN) {
            alert('Connection not ready. Please wait a moment and try again.');
            return;
        }
        
        const roomId = joinRoomIdInput.value.trim().toUpperCase();
        
        if (!roomId) {
            alert('Please enter room ID');
            return;
        }
        
        ws.send(JSON.stringify({
            type: 'JOIN_ROOM',
            roomId: roomId,
            handle: userHandle
        }));
    });

    // Leave room
    leaveRoomBtn.addEventListener('click', () => {
        if (currentRoom && ws) {
            ws.send(JSON.stringify({
                type: 'LEAVE_ROOM',
                roomId: currentRoom,
                handle: userHandle
            }));
        }
        leaveRoom();
    });

    function leaveRoom() {
        stopMatchCountdown();
        currentRoom = null;
        isHost = false;
        roomData = null;
        clearSavedState();
        
        roomControls.style.display = 'flex';
        activeBlitzSection.style.display = 'block';
        
        roomInfoBar.style.display = 'none';
        roomValidationMini.style.display = 'none';
        configDashboard.style.display = 'none';
        validationSection.style.display = 'none';
        problemsDisplaySection.style.display = 'none';
        matchStatusBar.style.display = 'none';
        leaderboard.style.display = 'none';
        arenaPanel.style.display = 'none';
        
        battleActive = false;
        if (timerInterval) {
            clearInterval(timerInterval);
            timerInterval = null;
        }
        if (apiCheckInterval) {
            clearInterval(apiCheckInterval);
            apiCheckInterval = null;
        }
        
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'GET_ACTIVE_ROOMS' }));
        }
    }

    function stopMatchCountdown() {
        if (matchCountdownTimer) {
            clearInterval(matchCountdownTimer);
            matchCountdownTimer = null;
        }
        matchCountdownEndsAt = null;
        if (matchCountdownOverlay) {
            matchCountdownOverlay.style.display = 'none';
        }
    }

    function startMatchCountdown(startsAt) {
        stopMatchCountdown();
        if (!startsAt) return;

        matchCountdownEndsAt = startsAt;
        validationSection.style.display = 'block';
        if (matchCountdownOverlay) {
            matchCountdownOverlay.style.display = 'flex';
        }

        const renderCountdown = () => {
            const remaining = Math.max(0, Math.ceil((matchCountdownEndsAt - getSyncedNow()) / 1000));
            if (validationStatusText) {
                validationStatusText.textContent = `Both participants verified. Match starts in ${remaining}s.`;
            }
            if (matchCountdownTime) {
                matchCountdownTime.textContent = `${remaining}`;
            }
            if (remaining <= 0) {
                stopMatchCountdown();
            }
        };

        renderCountdown();
        matchCountdownTimer = setInterval(renderCountdown, 250);
    }

    function showBattleUI() {
        configDashboard.style.display = 'none';
        validationSection.style.display = 'none';
        problemsDisplaySection.style.display = 'none';
        matchStatusBar.style.display = 'flex';
        leaderboard.style.display = 'block';
        arenaPanel.style.display = 'flex';
        if (matchStatusBar) {
            matchStatusBar.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    async function fetchUserProfile(handle) {
        try {
            const response = await fetch(`https://codeforces.com/api/user.info?handles=${encodeURIComponent(handle)}`);
            const data = await response.json();
            if (data.status !== 'OK' || !Array.isArray(data.result) || !data.result[0]) {
                return null;
            }

            const user = data.result[0];
            return {
                handle: user.handle,
                avatar: user.titlePhoto || ''
            };
        } catch {
            return null;
        }
    }

    async function generateHandleVerificationProblem() {
        try {
            const response = await fetch('https://codeforces.com/api/problemset.problems?tags=implementation');
            const data = await response.json();
            if (data.status !== 'OK' || !data.result || !Array.isArray(data.result.problems)) {
                return null;
            }

            const pool = data.result.problems.filter(problem =>
                problem.contestId &&
                problem.index &&
                problem.rating &&
                problem.rating >= 800 &&
                problem.rating <= 1500
            );

            if (pool.length === 0) {
                return null;
            }

            const selected = pool[Math.floor(Math.random() * pool.length)];
            return {
                contestId: selected.contestId,
                index: selected.index,
                name: selected.name,
                rating: selected.rating,
                url: `https://codeforces.com/problemset/problem/${selected.contestId}/${selected.index}`,
                generatedAtSec: Math.floor(Date.now() / 1000)
            };
        } catch {
            return null;
        }
    }

    async function hasCompilationErrorOnProblem(handle, problem) {
        if (!handle || !problem) return false;

        try {
            const response = await fetch(`https://codeforces.com/api/user.status?handle=${encodeURIComponent(handle)}&from=1&count=200`);
            const data = await response.json();
            if (data.status !== 'OK' || !Array.isArray(data.result)) {
                return false;
            }

            return data.result.some(submission => {
                if (!submission?.problem) return false;

                const sameProblem = submission.problem.contestId === problem.contestId
                    && submission.problem.index === problem.index;
                const afterGenerated = (submission.creationTimeSeconds || 0) >= (problem.generatedAtSec || 0);

                return sameProblem
                    && afterGenerated
                    && submission.verdict === 'COMPILATION_ERROR';
            });
        } catch {
            return false;
        }
    }

    async function fetchUserRanks() {
        try {
            const response = await fetch(`https://codeforces.com/api/user.info?handles=${player1Handle};${player2Handle}`);
            const data = await response.json();
            
            if (data.status === 'OK') {
                const users = data.result;
                
                const p1Rating = users[0].rating || 0;
                const p1RankInfo = getRankFromRating(p1Rating);
                player1Rank = p1RankInfo.name;
                player1RankColor = p1RankInfo.color;
                
                const p2Rating = users[1].rating || 0;
                const p2RankInfo = getRankFromRating(p2Rating);
                player2Rank = p2RankInfo.name;
                player2RankColor = p2RankInfo.color;
                
                updatePlayerUI();
            }
        } catch (error) {
            console.error('Error fetching ranks:', error);
        }
    }

    function getRankFromRating(rating) {
        if (rating < 1200) return { name: 'Newbie', color: 'rank-newbie' };
        if (rating < 1400) return { name: 'Pupil', color: 'rank-pupil' };
        if (rating < 1600) return { name: 'Specialist', color: 'rank-specialist' };
        if (rating < 1900) return { name: 'Expert', color: 'rank-expert' };
        if (rating < 2100) return { name: 'Candidate Master', color: 'rank-cm' };
        if (rating < 2300) return { name: 'Master', color: 'rank-master' };
        if (rating < 2400) return { name: 'International Master', color: 'rank-im' };
        if (rating < 3000) return { name: 'Grandmaster', color: 'rank-gm' };
        return { name: 'Legendary Grandmaster', color: 'rank-lgm' };
    }

    function updatePlayerUI() {
        p1HandleSpan.textContent = player1Handle;
        p1HandleSpan.href = `https://codeforces.com/profile/${player1Handle}`;
        p1HandleSpan.className = `player-handle ${player1RankColor}`;
        p1RankSpan.textContent = player1Rank;
        p1RankSpan.className = `player-rank ${player1RankColor}`;
        
        p2HandleSpan.textContent = player2Handle;
        p2HandleSpan.href = `https://codeforces.com/profile/${player2Handle}`;
        p2HandleSpan.className = `player-handle ${player2RankColor}`;
        p2RankSpan.textContent = player2Rank;
        p2RankSpan.className = `player-rank ${player2RankColor}`;
        
        p1ScoreSpan.textContent = player1Score;
        p2ScoreSpan.textContent = player2Score;
        
        renderLeaderboard();
    }

    function renderLeaderboard() {
        let headerHtml = '<tr><th>Player</th><th>Rank</th><th>Total</th>';
        problems.forEach((prob, index) => {
            headerHtml += `<th>P${index + 1}<br><small>${prob.points}pts</small></th>`;
        });
        headerHtml += '</tr>';
        leaderboardHeader.innerHTML = headerHtml;
        
        let p1Row = '<tr>';
        p1Row += `<td><span class="${player1RankColor}"><strong>${player1Handle}</strong></span></td>`;
        p1Row += `<td><span class="${player1RankColor}">${player1Rank}</span></td>`;
        p1Row += `<td><strong style="color: #ffd966;">${player1Score}</strong></td>`;
        
        problems.forEach((prob, index) => {
            const result = problemResults.p1[index];
            if (result && result.solved) {
                p1Row += `<td class="problem-cell solved">✓</td>`;
            } else if (result && result.pending) {
                p1Row += `<td class="problem-cell">⏳</td>`;
            } else if (result && result.attempts > 0) {
                p1Row += `<td class="problem-cell attempted">✗</td>`;
            } else {
                p1Row += `<td class="problem-cell">—</td>`;
            }
        });
        p1Row += '</tr>';
        
        let p2Row = '<tr>';
        p2Row += `<td><span class="${player2RankColor}"><strong>${player2Handle}</strong></span></td>`;
        p2Row += `<td><span class="${player2RankColor}">${player2Rank}</span></td>`;
        p2Row += `<td><strong style="color: #ffd966;">${player2Score}</strong></td>`;
        
        problems.forEach((prob, index) => {
            const result = problemResults.p2[index];
            if (result && result.solved) {
                p2Row += `<td class="problem-cell solved">✓</td>`;
            } else if (result && result.pending) {
                p2Row += `<td class="problem-cell">⏳</td>`;
            } else if (result && result.attempts > 0) {
                p2Row += `<td class="problem-cell attempted">✗</td>`;
            } else {
                p2Row += `<td class="problem-cell">—</td>`;
            }
        });
        p2Row += '</tr>';
        
        leaderboardBody.innerHTML = p1Row + p2Row;
    }

    async function ensureNotificationPermission() {
        if (typeof Notification === 'undefined') {
            notificationPermission = false;
            return false;
        }

        if (Notification.permission === 'granted') {
            notificationPermission = true;
            return true;
        }

        if (Notification.permission !== 'default') {
            notificationPermission = false;
            return false;
        }

        try {
            const permission = await Notification.requestPermission();
            notificationPermission = permission === 'granted';
            return notificationPermission;
        } catch {
            notificationPermission = false;
            return false;
        }
    }

    async function pushOSNotification(title, message) {
        if (typeof Notification === 'undefined') {
            return;
        }

        if (Notification.permission !== 'granted') {
            const grantedNow = await ensureNotificationPermission();
            if (!grantedNow) return;
        }

        try {
            const osNotification = new Notification(title, {
                body: message,
                tag: `blitz-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                renotify: true,
                requireInteraction: true,
                silent: false
            });

            activeOSNotifications.push(osNotification);
            osNotification.onclick = () => {
                window.focus();
                osNotification.close();
            };

            osNotification.onclose = () => {
                activeOSNotifications = activeOSNotifications.filter(item => item !== osNotification);
            };

            setTimeout(() => {
                try {
                    osNotification.close();
                } catch {}
            }, 10000);
            return;
        } catch (error) {
            console.warn('Direct Notification API failed, trying service worker path:', error);
        }

        try {
            if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
                const registration = await navigator.serviceWorker.getRegistration();
                if (registration && typeof registration.showNotification === 'function') {
                    await registration.showNotification(title, {
                        body: message,
                        tag: `blitz-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                        renotify: true,
                        silent: false
                    });
                    return;
                }
            }
        } catch (error) {
            console.warn('Service worker notification path failed:', error);
        }
    }

    function showDesktopNotification(title, message, isWinner = false, allowOSNotification = false) {
        const notification = document.createElement('div');
        notification.className = `desktop-notification ${isWinner ? 'winner' : ''}`;
        notification.innerHTML = `
            <div style="font-weight: bold; margin-bottom: 5px;">${title}</div>
            <div>${message}</div>
        `;
        notification.onclick = () => notification.remove();
        notificationCenter.appendChild(notification);
        
        setTimeout(() => notification.remove(), 5000);

        if (allowOSNotification) {
            pushOSNotification(title, message).catch(error => {
                console.warn('OS notification delivery failed:', error);
            });
        }
    }

    function formatTime(seconds) {
        const mins = Math.floor(Math.max(0, seconds) / 60);
        const secs = Math.floor(Math.max(0, seconds) % 60);
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }

    function updateTimerDisplay() {
        matchTimer.textContent = formatTime(timeLeftSec);
    }

    // Start battle button kept for UI compatibility (auto-start mode)
    startBattleBtn.addEventListener('click', async () => {
        validationStatusText.textContent = 'Auto-start is enabled. Waiting for two participants to submit Compilation Error on provided problem.';
    });

    function startBattleFromHost(battleState) {
        restoreBattleState(battleState);
    }

    function startBattleTimer() {
        if (timerInterval) clearInterval(timerInterval);
        
        timerInterval = setInterval(() => {
            if (!battleActive) {
                clearInterval(timerInterval);
                return;
            }
            
            if (battleEndsAt) {
                const now = getSyncedNow();
                const newTimeLeft = Math.max(0, Math.floor((battleEndsAt - now) / 1000));
                
                if (newTimeLeft !== timeLeftSec) {
                    timeLeftSec = newTimeLeft;
                    updateTimerDisplay();
                    
                    if (timeLeftSec <= 0) {
                        verifyFinalSubmissionsAtTimerEnd();
                    }
                }
            }
            
            if (breakActive && breakStartTime) {
                const now = getSyncedNow();
                const elapsedSeconds = Math.floor((now - breakStartTime) / 1000);
                const newBreakLeft = Math.max(0, 60 - elapsedSeconds);
                
                if (newBreakLeft !== breakSecondsLeft) {
                    breakSecondsLeft = newBreakLeft;
                    breakTimerDiv.textContent = `⏳ break ${breakSecondsLeft}s`;
                    breakIndicator.textContent = `Break ${breakSecondsLeft}s`;
                    
                    if (breakSecondsLeft <= 0) {
                        endBreak();
                    }
                }
            }
        }, 1000);
    }

    function isPendingVerdict(verdict) {
        return verdict === null || verdict === undefined || verdict === 'TESTING' || verdict === 'QUEUED';
    }

    function analyzeSubmissionsForProblem(submissionData, problem, deadlineMs = null, minMs = null) {
        const analysis = {
            accepted: null,
            hasPending: false,
            hasJudgedFail: false
        };

        if (!submissionData || submissionData.status !== 'OK' || !Array.isArray(submissionData.result) || !problem) {
            return analysis;
        }

        for (const sub of submissionData.result) {
            if (!sub.problem) continue;
            const isSameProblem = sub.problem.contestId === problem.contestId && sub.problem.index === problem.index;
            if (!isSameProblem) continue;

            const submitMs = (sub.creationTimeSeconds || 0) * 1000;
            if (deadlineMs && submitMs && submitMs > deadlineMs) continue;
            if (minMs && submitMs && submitMs < minMs) continue;

            if (sub.verdict === 'OK') {
                if (!analysis.accepted || submitMs < analysis.accepted.submitMs) {
                    analysis.accepted = { submitMs, submissionId: sub.id };
                }
                continue;
            }

            if (isPendingVerdict(sub.verdict)) {
                analysis.hasPending = true;
            } else {
                analysis.hasJudgedFail = true;
            }
        }

        return analysis;
    }

    function getSubmissionWindowStartMs() {
        return currentProblemOpenedAt || battleStartTime || 0;
    }

    async function verifyFinalSubmissionsAtTimerEnd() {
        if (!battleActive || timerEndVerificationInProgress) return;

        timerEndVerificationInProgress = true;
        pendingSubmissionStatusReported = null;
        if (timerInterval) {
            clearInterval(timerInterval);
            timerInterval = null;
        }
        if (apiCheckInterval) {
            clearInterval(apiCheckInterval);
            apiCheckInterval = null;
        }

        const deadlineMs = battleEndsAt || getSyncedNow();
        matchStatusText.textContent = '⏱️ Match timer ended. Checking pending submissions...';

        try {
            while (battleActive && !breakActive && !problemLocked && currentProblem) {

                const [p1Response, p2Response] = await Promise.all([
                    fetch(`https://codeforces.com/api/user.status?handle=${player1Handle}&from=1&count=100`),
                    fetch(`https://codeforces.com/api/user.status?handle=${player2Handle}&from=1&count=100`)
                ]);

                const p1Data = await p1Response.json();
                const p2Data = await p2Response.json();

                const windowStartMs = getSubmissionWindowStartMs();
                const p1Analysis = analyzeSubmissionsForProblem(p1Data, currentProblem, deadlineMs, windowStartMs);
                const p2Analysis = analyzeSubmissionsForProblem(p2Data, currentProblem, deadlineMs, windowStartMs);

                const p1Accepted = p1Analysis.accepted;
                const p2Accepted = p2Analysis.accepted;

                if (p1Accepted || p2Accepted) {
                    reportPendingSubmissionStatus(false);
                    let solver = 'p1';
                    if (!p1Accepted) solver = 'p2';
                    else if (p2Accepted && p2Accepted.submitMs < p1Accepted.submitMs) solver = 'p2';

                    endAfterCurrentSolve = true;
                    handleSolve(solver);
                    return;
                }

                if (!p1Analysis.hasPending && !p2Analysis.hasPending) {
                    reportPendingSubmissionStatus(false);
                    break;
                }

                reportPendingSubmissionStatus(true);

                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            stopBattle(true);
        } catch (error) {
            console.error('Final submission verification failed:', error);
            stopBattle(true);
        } finally {
            reportPendingSubmissionStatus(false);
            timerEndVerificationInProgress = false;
        }
    }

    function reportPendingSubmissionStatus(hasPending) {
        if (!ws || ws.readyState !== WebSocket.OPEN || !currentRoom) return;
        if (pendingSubmissionStatusReported === hasPending) return;

        pendingSubmissionStatusReported = hasPending;
        ws.send(JSON.stringify({
            type: 'PENDING_SUBMISSION_STATUS',
            roomId: currentRoom,
            hasPending: !!hasPending
        }));
    }

    async function loadNextProblem() {
        if (!battleActive || currentProblemIndex >= problems.length) {
            stopBattle(true);
            return;
        }

        p1Row.classList.remove('solved');
        p2Row.classList.remove('solved');

        if (!queuedNextProblem) {
            queuedNextProblem = selectedProblems[currentProblemIndex] || null;
        }

        const prob = queuedNextProblem;
        if (!prob) {
            currentProblem = null;
            currentProblemOpenedAt = null;
            problemLocked = false;
            lockStatusDiv.textContent = `⏳ Generating Problem ${currentProblemIndex + 1}/${problems.length}...`;
            lockStatusDiv.className = 'problem-lock-status';
            return;
        }

        queuedNextProblem = null;
        currentProblem = prob;
        currentProblemOpenedAt = Date.now();
        currentProblemIndex++;
        
        const problemPoints = selectedProblems[currentProblemIndex - 1]?.points || 500;
        
        probNameSpan.textContent = prob.name;
        probPointsSpan.textContent = problemPoints;
        probRatingSpan.textContent = `Rating: ${prob.rating}`;
        
        problemUrl.href = prob.url;
        problemUrl.style.pointerEvents = 'auto';
        problemUrl.style.opacity = '1';
        
        lockStatusDiv.textContent = `🔓 Problem ${currentProblemIndex}/${problems.length} · waiting for AC`;
        lockStatusDiv.className = 'problem-lock-status';
        
        problemLocked = false;
        saveBattleRuntimeState();
    }

    async function checkSubmissions() {
        if (!battleActive || breakActive || problemLocked || !currentProblem || currentProblemIndex > problems.length) return;

        try {
            const [p1Response, p2Response] = await Promise.all([
                fetch(`https://codeforces.com/api/user.status?handle=${player1Handle}&from=1&count=20`),
                fetch(`https://codeforces.com/api/user.status?handle=${player2Handle}&from=1&count=20`)
            ]);

            const p1Data = await p1Response.json();
            const p2Data = await p2Response.json();

            if (!problemResults.p1[currentProblemIndex - 1]) {
                problemResults.p1[currentProblemIndex - 1] = { attempts: 0, solved: false, pending: false };
            }
            if (!problemResults.p2[currentProblemIndex - 1]) {
                problemResults.p2[currentProblemIndex - 1] = { attempts: 0, solved: false, pending: false };
            }

            const windowStartMs = getSubmissionWindowStartMs();
            const p1Analysis = analyzeSubmissionsForProblem(p1Data, currentProblem, null, windowStartMs);
            const p2Analysis = analyzeSubmissionsForProblem(p2Data, currentProblem, null, windowStartMs);

            const p1Result = problemResults.p1[currentProblemIndex - 1];
            const p2Result = problemResults.p2[currentProblemIndex - 1];

            if (!p1Result.solved) {
                p1Result.pending = !!p1Analysis.hasPending;
                if (p1Analysis.hasJudgedFail) {
                    p1Result.attempts = Math.max(1, p1Result.attempts || 0);
                }
            }

            if (!p2Result.solved) {
                p2Result.pending = !!p2Analysis.hasPending;
                if (p2Analysis.hasJudgedFail) {
                    p2Result.attempts = Math.max(1, p2Result.attempts || 0);
                }
            }

            const p1Accepted = p1Analysis.accepted;
            const p2Accepted = p2Analysis.accepted;

            if (p1Accepted || p2Accepted) {
                if (!p2Accepted || (p1Accepted && p1Accepted.submitMs <= p2Accepted.submitMs)) {
                    handleSolve('p1');
                } else {
                    handleSolve('p2');
                }
            }

            updatePlayerUI();
            
        } catch (error) {
            console.error('Error checking submissions:', error);
        }
    }

    function handleSolve(player) {
        if (problemLocked || !battleActive) return;
        
        problemLocked = true;
        const problemPoints = problems[currentProblemIndex - 1]?.points || selectedProblems[currentProblemIndex - 1]?.points || 500;
        
        if (player === 'p1') {
            player1Score += problemPoints;
            problemResults.p1[currentProblemIndex - 1].solved = true;
            p1Row.classList.add('solved');
            if (currentProblem) {
                p1SolvedProblems.add(currentProblem.id);
            }
        } else {
            player2Score += problemPoints;
            problemResults.p2[currentProblemIndex - 1].solved = true;
            p2Row.classList.add('solved');
            if (currentProblem) {
                p2SolvedProblems.add(currentProblem.id);
            }
        }

        const solverHandle = player === 'p1' ? player1Handle : player2Handle;
        const solveKey = `${currentProblem?.id || currentProblemIndex}:${solverHandle}`;
        if (!solveNotificationKeys.has(solveKey)) {
            solveNotificationKeys.add(solveKey);
            showDesktopNotification('✅ Problem Solved!', `${solverHandle} solved Problem ${currentProblemIndex}!`, false, true);
        }

        if (ws && ws.readyState === WebSocket.OPEN && currentRoom && currentProblem?.id) {
            ws.send(JSON.stringify({
                type: 'PROBLEM_SOLVED',
                roomId: currentRoom,
                solverHandle,
                problemId: currentProblem.id,
                problemNumber: currentProblemIndex,
                solveKey: `${currentProblem.id}:${solverHandle}`
            }));
        }
        
        lockStatusDiv.textContent = `🔒 LOCKED · solved by ${player === 'p1' ? player1Handle : player2Handle}`;
        lockStatusDiv.classList.add('solved-flash');
        
        updatePlayerUI();

        if (endAfterCurrentSolve) {
            endAfterCurrentSolve = false;
            stopBattle(true);
            saveBattleRuntimeState();
            return;
        }
        
        if (currentProblemIndex >= problems.length) {
            lockStatusDiv.textContent = '✅ All problems solved. Ending match now...';

            if (ws && ws.readyState === WebSocket.OPEN && currentRoom) {
                ws.send(JSON.stringify({
                    type: 'END_BATTLE_EARLY',
                    roomId: currentRoom,
                    reason: 'all-problems-solved'
                }));
            }

            stopBattle(true);
        } else {
            startBreak();
        }

        saveBattleRuntimeState();
    }

    function startBreak() {
        breakActive = true;
        breakSecondsLeft = 60;
        breakStartTime = getSyncedNow();

        if (currentProblemIndex < problems.length) {
            queuedNextProblem = selectedProblems[currentProblemIndex] || null;
        } else {
            queuedNextProblem = null;
        }

        breakTimerDiv.style.display = 'block';
        breakTimerDiv.textContent = `⏳ break ${breakSecondsLeft}s`;
        breakIndicator.style.display = 'inline-block';
        breakIndicator.textContent = `Break ${breakSecondsLeft}s`;

        if (apiCheckInterval) {
            clearInterval(apiCheckInterval);
            apiCheckInterval = null;
        }

        saveBattleRuntimeState();
    }

    function endBreak() {
        breakActive = false;
        breakStartTime = null;
        breakTimerDiv.style.display = 'none';
        breakIndicator.style.display = 'none';
        saveBattleRuntimeState();
        
        if (battleActive && currentProblemIndex < problems.length) {
            loadNextProblem().then(() => {
                if (battleActive && !breakActive && currentProblem) {
                    apiCheckInterval = setInterval(checkSubmissions, checkIntervalSec * 1000);
                }
            });
        }
    }

    async function submitBattleResult(winner) {
        if (resultSubmitted || !matchKey) return;

        const payload = {
            matchKey,
            roomId: currentRoom,
            date: new Date().toISOString(),
            duration: Math.round(totalDurationSec / 60),
            winner,
            player1: {
                handle: player1Handle,
                score: player1Score,
                rank: player1Rank
            },
            player2: {
                handle: player2Handle,
                score: player2Score,
                rank: player2Rank
            },
            problems: problems.map((configProblem, idx) => {
                const generatedProblem = selectedProblems[idx] || null;
                return {
                id: generatedProblem?.id || '',
                name: generatedProblem?.name || `Problem ${idx + 1}`,
                url: generatedProblem?.url || '',
                contestId: generatedProblem?.contestId || null,
                index: generatedProblem?.index || '',
                points: configProblem?.points || generatedProblem?.points || 0,
                rating: configProblem?.rating || generatedProblem?.rating || null,
                p1Result: problemResults.p1[idx] || { attempts: 0, solved: false, pending: false },
                p2Result: problemResults.p2[idx] || { attempts: 0, solved: false, pending: false }
            };
            })
        };

        try {
            await fetch(`${API_BASE_URL}/api/results`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            resultSubmitted = true;
        } catch (error) {
            console.error('Failed to save result:', error);
        }
    }

    async function stopBattle(fromServer = false, persistResult = true) {
        if (!battleActive && resultSubmitted) return;

        battleActive = false;
        endAfterCurrentSolve = false;
        timerEndVerificationInProgress = false;
        reportPendingSubmissionStatus(false);
        
        if (timerInterval) {
            clearInterval(timerInterval);
            timerInterval = null;
        }
        
        if (apiCheckInterval) {
            clearInterval(apiCheckInterval);
            apiCheckInterval = null;
        }
        
        breakActive = false;
        queuedNextProblem = null;
        currentProblemOpenedAt = null;
        solveNotificationKeys = new Set();
        breakTimerDiv.style.display = 'none';
        breakIndicator.style.display = 'none';
        breakStartTime = null;
        clearBattleRuntimeState();
        
        let winner = '';
        if (player1Score > player2Score) {
            winner = player1Handle;
        } else if (player2Score > player1Score) {
            winner = player2Handle;
        } else {
            winner = 'tie';
        }

        if (!matchEndNotificationShown) {
            const winnerText = winner === 'tie'
                ? 'Match ended in a tie. Check Results page.'
                : `Winner: ${winner}. Check Results page.`;
            showDesktopNotification('🏁 Match Ended', winnerText, winner !== 'tie', true);
            matchEndNotificationShown = true;
        }

        if (persistResult) {
            await submitBattleResult(winner);
        }

        matchStatusText.textContent = fromServer ? '✅ Blitz ended' : '✅ Blitz ended';
        
        if (winner !== 'tie') {
            winnerHandleSpan.textContent = winner;
            celebrationModal.style.display = 'flex';
            
            for (let i = 0; i < 50; i++) {
                const confetti = document.createElement('div');
                confetti.className = 'confetti';
                confetti.style.left = Math.random() * 100 + '%';
                confetti.style.animationDelay = Math.random() * 2 + 's';
                confetti.style.background = ['gold', '#ff6b6b', '#4d9eff', '#ffd966'][Math.floor(Math.random() * 4)];
                celebrationModal.appendChild(confetti);
                setTimeout(() => confetti.remove(), 3000);
            }
        }
    }

    cancelGameBtn.addEventListener('click', () => {
        if (!battleActive) {
            alert('No active game to cancel');
            return;
        }
        passwordModal.style.display = 'flex';
        passwordInput.value = '';
        passwordInput.focus();
    });

    confirmCancel.addEventListener('click', async () => {
        const enteredPassword = passwordInput.value;

        if (!enteredPassword) {
            alert('Please enter admin password');
            passwordInput.focus();
            return;
        }

        try {
            const response = await fetch(`${API_BASE_URL}/api/admin/verify`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-admin-password': enteredPassword
                },
                body: JSON.stringify({ password: enteredPassword })
            });

            if (!response.ok) {
                alert('Incorrect password!');
                passwordInput.value = '';
                passwordInput.focus();
                return;
            }

            passwordModal.style.display = 'none';
            stopBattle(false, false);
            showDesktopNotification('⛔ Game Cancelled', 'Game cancelled by administrator', true);
        } catch (error) {
            console.error('Admin verification failed:', error);
            alert('Could not verify admin password right now');
        }
    });

    cancelPassword.addEventListener('click', () => {
        passwordModal.style.display = 'none';
    });

    closeCelebrationBtn.addEventListener('click', () => {
        celebrationModal.style.display = 'none';
    });

    window.addEventListener('click', (e) => {
        if (e.target === passwordModal) {
            passwordModal.style.display = 'none';
        }
        if (e.target === handleSetupModal) {
            closeHandleSetupModal();
        }
    });

    function init() {
        if (typeof Notification !== 'undefined') {
            notificationPermission = Notification.permission === 'granted';

            if (Notification.permission === 'default') {
                const bootstrapPermission = () => {
                    ensureNotificationPermission().catch(() => {});
                    window.removeEventListener('click', bootstrapPermission);
                };
                window.addEventListener('click', bootstrapPermission);
            }
        }
        loadSavedState();
        connectWebSocket();
    }

    init();
})();
