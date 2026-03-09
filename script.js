console.log('[CLIENT] script.js loaded');
// Robust event delegation for Start Match button
document.addEventListener('click', function(e) {
    if (e.target && e.target.id === 'startBattleBtn') {
        console.log('[CLIENT] Delegated handler: Start Match button CLICK HANDLER FIRED');
        console.log('[CLIENT] DEBUG before eligibility check:', { currentRoom: window.currentRoom, userHandle: window.userHandle });
        if (!window.currentRoom || !window.userHandle) {
            if (window.userHandle && !window.currentRoom) {
                alert('You are not eligible to start the match. (Missing room).\n\nIt looks like you are logged in, but not joined to a room. Please rejoin the room or reload the page.');
                console.error('[CLIENT] Start Match click: userHandle is set but currentRoom is null. This usually means the client did not rejoin the room after reload or lost connection.');
            } else {
                alert('You are not eligible to start the match. (Missing room or handle)');
            }
            console.warn('[CLIENT] Start Match click: missing currentRoom or userHandle', { currentRoom: window.currentRoom, userHandle: window.userHandle });
            console.log('[CLIENT] EARLY RETURN: missing currentRoom or userHandle', { currentRoom: window.currentRoom, userHandle: window.userHandle });
            return;
        }
        if (!window.ws || window.ws.readyState !== WebSocket.OPEN) {
            alert('Connection not ready. Please wait for WebSocket to connect.');
            console.warn('[CLIENT] Start Match click: WebSocket not open', { ws: window.ws });
            console.log('[CLIENT] EARLY RETURN: WebSocket not open', { ws: window.ws });
            return;
        }
        const normalizedHandle = (window.userHandle || '').trim().toLowerCase();
        console.log('[CLIENT] About to send PLAYER_READY_TO_START', { currentRoom: window.currentRoom, userHandle: window.userHandle, normalizedHandle });
        window.ws.send(JSON.stringify({
            type: 'PLAYER_READY_TO_START',
            roomId: window.currentRoom,
            handle: normalizedHandle
        }));
        // Do not update button state here; let server broadcast control the UI
    }
});
(function() {
    // State
    const ADMIN_HANDLES = new Set(['else_if_tridib21', 'mishkatit']);
    let userHandle = '';
        window.userHandle = userHandle;
    let playersValidated = false;
    let currentRoom = null;
        window.currentRoom = currentRoom;
    let isHost = false;
    let ws = null;
    let reconnectAttempts = 0;
    let roomData = null;
    let allActiveRooms = [];
    
    // Battle state
    let player1Handle = '';
    let player2Handle = '';
    let player1Score = 0;
    let player2Score = 0;
    let player1Rank = '';
    let player2Rank = '';
    let player1Rating = null;
    let player2Rating = null;
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
    let handleVerificationChallengeId = '';
    let handleVerificationHandle = '';
    let handleVerificationTimer = null;
    let serverClockOffsetMs = 0;
    let leaderboardTieOrder = Math.random() < 0.5 ? ['p1', 'p2'] : ['p2', 'p1'];
    let syncedActiveHandle = '';
    let pendingPostLoginReturnTo = '';
    let spectatorPresenceMap = new Map();
    let matchSpectatorHandles = new Set();
    const SPECTATOR_RECENT_JOIN_MS = 60000;
    const SPECTATOR_KEEP_LEFT_MS = 3 * 60 * 1000;
    let celebrationRedirectTimer = null;
    const recentNotificationEvents = new Map();
    const NOTIFICATION_DEDUPE_WINDOW_MS = 4000;

    
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

    function createEmptyProblemResult() {
        return {
            attempts: 0,
            solved: false,
            pending: false,
            solvedAtSec: null
        };
    }

    function normalizeProblemResultEntry(entry) {
        const source = entry && typeof entry === 'object' ? entry : {};
        const attempts = Math.max(0, Number(source.attempts) || 0);
        const solved = !!source.solved;
        const pending = !!source.pending && !solved;
        const solvedAtSecRaw = Number(source.solvedAtSec);
        const solvedAtSec = Number.isFinite(solvedAtSecRaw) && solvedAtSecRaw >= 0
            ? Math.floor(solvedAtSecRaw)
            : null;

        return {
            attempts,
            solved,
            pending,
            solvedAtSec
        };
    }

    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function getProblemResultFor(playerKey, index) {
        if (!problemResults[playerKey]) {
            problemResults[playerKey] = [];
        }

        if (!problemResults[playerKey][index]) {
            problemResults[playerKey][index] = createEmptyProblemResult();
        } else {
            problemResults[playerKey][index] = normalizeProblemResultEntry(problemResults[playerKey][index]);
        }

        return problemResults[playerKey][index];
    }

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
    const activeRoomsSearchInput = document.getElementById('activeRoomsSearchInput');
    const roomControls = document.getElementById('roomControls');
    const activeBlitzSection = document.getElementById('activeBlitzSection');
    const roomInfoBar = document.getElementById('roomInfoBar');
    const currentRoomName = document.getElementById('currentRoomName');
    const currentRoomId = document.getElementById('currentRoomId');
    const roomPlayers = document.getElementById('roomPlayers');
    const spectatorPanel = document.getElementById('spectatorPanel');
    const spectatorCountText = document.getElementById('spectatorCountText');
    const spectatorList = document.getElementById('spectatorList');
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
    console.log('[CLIENT] startBattleBtn:', startBattleBtn);
    const startP1Handle = document.getElementById('startP1Handle');
    const startP2Handle = document.getElementById('startP2Handle');
    const startP1Avatar = document.getElementById('startP1Avatar');
    const startP2Avatar = document.getElementById('startP2Avatar');
    const cancelGameBtn = document.getElementById('cancelGameBtn');
    const startBattleVSBlock = document.getElementById('startBattleVSBlock');
    
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
    const userProfileModal = document.getElementById('userProfileModal');
    const userProfileBody = document.getElementById('userProfileBody');
    const userProfileLogoutBtn = document.getElementById('userProfileLogoutBtn');
    const closeUserProfileModal = document.getElementById('closeUserProfileModal');
    const defaultGenerateHandleVerificationBtnLabel = generateHandleVerificationBtn?.textContent || 'Generate Problem';
    let handleVerificationGenerationInFlight = false;

    // Make the whole VS player box behave like the inner handle link
    function wirePlayerBoxToHandle(handleAnchorElem) {
        if (!handleAnchorElem) return;
        try {
            const box = handleAnchorElem.closest('.vs-player-box');
            if (!box) return;
            // ensure pointer cursor (in case some contexts override CSS)
            box.style.cursor = 'pointer';
            box.addEventListener('click', function (ev) {
                // if the click originated on an actual link (e.g., the handle anchor itself), allow default
                if (ev.target && ev.target.closest && ev.target.closest('a')) return;
                const href = handleAnchorElem.getAttribute && handleAnchorElem.getAttribute('href');
                if (href && href !== '#') {
                    window.open(href, '_blank');
                }
            });
        } catch (e) {
            console.warn('[CLIENT] wirePlayerBoxToHandle error', e);
        }
    }

    // Wire existing handle anchors (main arena and start-battle block)
    wirePlayerBoxToHandle(p1HandleSpan);
    wirePlayerBoxToHandle(p2HandleSpan);
    wirePlayerBoxToHandle(startP1Handle);
    wirePlayerBoxToHandle(startP2Handle);

    // Apply CFUserInfo (canonical handle, colored HTML, and color styling) to player boxes
    function applyCFInfoToPlayerBox(handleAnchorElem) {
        if (!handleAnchorElem) return;
        try {
            const box = handleAnchorElem.closest('.vs-player-box');
            const avatar = box ? box.querySelector('.vs-player-avatar') : null;
            // derive a handle candidate
            let raw = handleAnchorElem.getAttribute('data-handle') || handleAnchorElem.textContent || '';
            try { raw = decodeURIComponent(raw); } catch (e) { /* ignore */ }
            const handle = String(raw || '').trim();
            if (!handle) return;
            if (window.CFUserInfo) {
                window.CFUserInfo.trackHandles([handle]);
                const info = window.CFUserInfo.getInfo(handle) || {};
                const canonical = info.handle || handle;
                // Render colored HTML using CFUserInfo (falls back internally if missing)
                handleAnchorElem.innerHTML = window.CFUserInfo.renderHandleHtml(canonical);
                handleAnchorElem.setAttribute('data-handle', encodeURIComponent(canonical));
                handleAnchorElem.href = `https://codeforces.com/profile/${encodeURIComponent(canonical)}`;
                handleAnchorElem.setAttribute('target', '_blank');
                handleAnchorElem.setAttribute('rel', 'noopener noreferrer');
                // Apply visual color cues: border and avatar background
                if (box && info.color) box.style.setProperty('--player-border', info.color);
                if (avatar && info.color) avatar.style.background = info.color;
            } else {
                // Fallback: ensure href uses current text value
                const txt = handleAnchorElem.textContent && handleAnchorElem.textContent.trim();
                if (txt) handleAnchorElem.href = `https://codeforces.com/profile/${encodeURIComponent(txt)}`;
            }
        } catch (e) {
            console.warn('[CLIENT] applyCFInfoToPlayerBox error', e);
        }
    }

    // Initial application
    applyCFInfoToPlayerBox(p1HandleSpan);
    applyCFInfoToPlayerBox(p2HandleSpan);
    applyCFInfoToPlayerBox(startP1Handle);
    applyCFInfoToPlayerBox(startP2Handle);

    // Subscribe for updates from CFUserInfo so cards refresh when data arrives
    if (window.CFUserInfo && typeof window.CFUserInfo.subscribe === 'function') {
        window.CFUserInfo.subscribe((updatedHandles) => {
            // Re-apply to all four anchors (cheap and simple)
            applyCFInfoToPlayerBox(p1HandleSpan);
            applyCFInfoToPlayerBox(p2HandleSpan);
            applyCFInfoToPlayerBox(startP1Handle);
            applyCFInfoToPlayerBox(startP2Handle);
        });
    }

    function setGenerateHandleButtonState({ disabled, label }) {
        if (!generateHandleVerificationBtn) return;
        generateHandleVerificationBtn.disabled = !!disabled;
        if (generateHandleVerificationBtn) {
            generateHandleVerificationBtn.textContent = label || defaultGenerateHandleVerificationBtnLabel;
        }
    }

    const API_BASE_URL = window.location.origin;
    const WS_URL = window.location.origin.replace('http', 'ws');
    const AUTH_META_KEY = 'blitzAuthMeta';
    const AUTH_DEPLOY_TOKEN = 'v2.1';
    const AUTH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
    const STORAGE_ENC_PREFIX = 'enc:v1:';
    const STORAGE_ENC_SECRET = 'blitz_storage_v1';
    const ENCRYPTED_STORAGE_KEYS = new Set([
        'blitzUserHandle',
        'blitzUserAvatar',
        'blitzRoomState',
        'blitzBattleRuntimeState',
        'blitzPendingJoinRoomId',
        'blitzAuthMeta'
    ]);

    // Rating options
    const ratingOptions = Array.from({ length: 28 }, (_, index) => 800 + (index * 100));

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

    function shouldEncryptStorageKey(key) {
        return ENCRYPTED_STORAGE_KEYS.has(String(key || ''));
    }

    function toBase64FromBytes(bytes) {
        let binary = '';
        for (let index = 0; index < bytes.length; index += 1) {
            binary += String.fromCharCode(bytes[index]);
        }
        return btoa(binary);
    }

    function fromBase64ToBytes(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.charCodeAt(index);
        }
        return bytes;
    }

    function xorBytes(inputBytes, keyBytes) {
        const output = new Uint8Array(inputBytes.length);
        for (let index = 0; index < inputBytes.length; index += 1) {
            output[index] = inputBytes[index] ^ keyBytes[index % keyBytes.length];
        }
        return output;
    }

    function encryptStorageValue(plainText) {
        const text = String(plainText ?? '');
        const encoder = new TextEncoder();
        const valueBytes = encoder.encode(text);
        const keyBytes = encoder.encode(STORAGE_ENC_SECRET);
        const encrypted = xorBytes(valueBytes, keyBytes);
        return `${STORAGE_ENC_PREFIX}${toBase64FromBytes(encrypted)}`;
    }

    function decryptStorageValue(rawValue) {
        const raw = String(rawValue ?? '');
        if (!raw.startsWith(STORAGE_ENC_PREFIX)) {
            return null;
        }

        try {
            const payload = raw.slice(STORAGE_ENC_PREFIX.length);
            const encrypted = fromBase64ToBytes(payload);
            const encoder = new TextEncoder();
            const keyBytes = encoder.encode(STORAGE_ENC_SECRET);
            const decrypted = xorBytes(encrypted, keyBytes);
            const decoder = new TextDecoder();
            return decoder.decode(decrypted);
        } catch {
            return '';
        }
    }

    function storageGetItem(key) {
        const raw = localStorage.getItem(key);
        if (raw == null) return null;
        if (!shouldEncryptStorageKey(key)) return raw;

        const decrypted = decryptStorageValue(raw);
        if (decrypted == null) {
            try {
                localStorage.setItem(key, encryptStorageValue(raw));
            } catch {
            }
            return raw;
        }
        return decrypted;
    }

    function storageSetItem(key, value) {
        const nextValue = String(value ?? '');
        if (!shouldEncryptStorageKey(key)) {
            localStorage.setItem(key, nextValue);
            return;
        }
        localStorage.setItem(key, encryptStorageValue(nextValue));
    }

    function storageRemoveItem(key) {
        localStorage.removeItem(key);
    }

    function readAuthMeta() {
        const raw = storageGetItem(AUTH_META_KEY);
        if (!raw) return null;

        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return null;
            const issuedAt = Number(parsed.issuedAt) || 0;
            const deployToken = String(parsed.deployToken || '').trim();
            if (!issuedAt || !deployToken) return null;
            return { issuedAt, deployToken };
        } catch {
            return null;
        }
    }

    function clearAuthSessionStorage() {
        storageRemoveItem(getUserHandleStorageKey());
        storageRemoveItem(getUserAvatarStorageKey());
        storageRemoveItem('blitzRoomState');
        storageRemoveItem(getRuntimeStateKey());
        storageRemoveItem(getPendingJoinRoomIdKey());
        storageRemoveItem(AUTH_META_KEY);
    }

    function isAuthSessionValid() {
        const meta = readAuthMeta();
        if (!meta) return false;
        if (meta.deployToken !== AUTH_DEPLOY_TOKEN) return false;
        return (Date.now() - meta.issuedAt) <= AUTH_MAX_AGE_MS;
    }

    function stampAuthSessionMeta() {
        storageSetItem(AUTH_META_KEY, JSON.stringify({
            issuedAt: Date.now(),
            deployToken: AUTH_DEPLOY_TOKEN
        }));
    }

    async function syncAuthFromServerSession() {
        try {
            const response = await fetch(`${API_BASE_URL}/api/session/me`, {
                method: 'GET',
                credentials: 'same-origin'
            });
            if (!response.ok) return false;

            const data = await response.json();
            if (!data || !data.authenticated || !data.handle) {
                if (String(storageGetItem(getUserHandleStorageKey()) || '').trim()) {
                    clearAuthSessionStorage();
                }
                if (String(userHandle || '').trim()) {
                    userHandle = '';
                            window.userHandle = userHandle;
                        window.userHandle = userHandle;
                    userAvatarUrl = '';
                    playersValidated = false;
                    userHandleInput.value = '';
                    renderLoggedInfo();
                }
                return false;
            }

            const serverHandle = String(data.handle || '').trim();
            if (!serverHandle) return false;

            const localHandle = String(userHandle || '').trim();
            if (!localHandle || localHandle.toLowerCase() !== serverHandle.toLowerCase()) {
                userHandle = serverHandle;
                        window.userHandle = userHandle;
                    window.userHandle = userHandle;
                    window.currentRoom = currentRoom;
                userAvatarUrl = '';
                userHandleInput.value = serverHandle;
            }
            playersValidated = true;

            storageSetItem(getUserHandleStorageKey(), serverHandle);
            stampAuthSessionMeta();
            renderLoggedInfo();
            return true;
        } catch {
            return false;
        }
    }

    async function createServerSessionForHandle(handle, challengeId) {
        const cleanHandle = String(handle || '').trim();
        const cleanChallengeId = String(challengeId || '').trim();
        if (!cleanHandle || !cleanChallengeId) {
            return { ok: false, error: 'Missing verification challenge' };
        }

        try {
            const response = await fetch(`${API_BASE_URL}/api/session/login`, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    handle: cleanHandle,
                    challengeId: cleanChallengeId
                })
            });

            if (response.ok) {
                return { ok: true, error: '' };
            }

            const data = await response.json().catch(() => ({}));
            return {
                ok: false,
                error: String(data?.error || '').trim() || 'Verification pending',
                status: response.status
            };
        } catch {
            return { ok: false, error: 'Could not verify handle right now' };
        }
    }

    async function logoutServerSession() {
        try {
            await fetch(`${API_BASE_URL}/api/session/logout`, {
                method: 'POST',
                credentials: 'same-origin'
            });
        } catch {
        }
    }

    function logoutCurrentUser() {
        const currentHandleSnapshot = String(userHandle || '').trim();
        if (currentRoom && ws && ws.readyState === WebSocket.OPEN && currentHandleSnapshot) {
            ws.send(JSON.stringify({
                type: 'LEAVE_ROOM',
                roomId: currentRoom,
                handle: currentHandleSnapshot
            }));
        }

        if (currentRoom) {
            leaveRoom();
        }

        logoutServerSession().catch(() => {});

        clearAuthSessionStorage();
        userHandle = '';
        userAvatarUrl = '';
        playersValidated = false;
        userHandleInput.value = '';
        syncedActiveHandle = '';
        renderLoggedInfo();
        if (userProfileModal) {
            userProfileModal.style.display = 'none';
        }
    }

    function tryJoinPendingRoom() {
        const pendingRoomId = (storageGetItem(getPendingJoinRoomIdKey()) || '').trim().toUpperCase();
        if (!pendingRoomId) return;
        if (!userHandle) return;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;

        joinRoomIdInput.value = pendingRoomId;
        ws.send(JSON.stringify({
            type: 'JOIN_ROOM',
            roomId: pendingRoomId,
            handle: userHandle
        }));

        storageRemoveItem(getPendingJoinRoomIdKey());
    }

    function renderLoggedInfo() {
        if (!userHandle) {
            loggedInfo.classList.remove('user-chip');
            loggedInfo.removeAttribute('role');
            loggedInfo.removeAttribute('tabindex');
            loggedInfo.removeAttribute('title');
            if (loggedInfo) loggedInfo.textContent = '';
            loggedInfo.style.display = 'none';
            if (setHandleBtn) setHandleBtn.style.display = 'inline-flex';
            syncAdminOnlyUiVisibility();
            return;
        }

        const avatarMarkup = userAvatarUrl
            ? `<img src="${userAvatarUrl}" alt="${userHandle}" class="logged-avatar">`
            : '';

        loggedInfo.classList.add('user-chip');
        loggedInfo.setAttribute('role', 'button');
        loggedInfo.setAttribute('tabindex', '0');
        loggedInfo.setAttribute('title', 'Click to view profile');
        loggedInfo.innerHTML = `${avatarMarkup}<span>${userHandle}</span>`;
        loggedInfo.style.display = 'inline-flex';
        if (setHandleBtn) setHandleBtn.style.display = 'none';

        syncAdminOnlyUiVisibility();

        syncActiveHandlePresence();
    }

    function syncAdminOnlyUiVisibility() {
        if (!cancelGameBtn) return;
        cancelGameBtn.style.display = isAdminHandle(userHandle) ? 'inline-flex' : 'none';
    }

    function syncActiveHandlePresence(force = false) {
        const handle = String(userHandle || '').trim();
        if (!handle) return;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;

        const normalized = handle.toLowerCase();
        if (!force && normalized === syncedActiveHandle) return;

        ws.send(JSON.stringify({
            type: 'SET_ACTIVE_HANDLE',
            handle
        }));
        syncedActiveHandle = normalized;
    }

    async function fetchSiteUserStats(handle) {
        try {
            const normalizedHandle = String(handle || '').trim().toLowerCase();
            const response = await fetch(`${API_BASE_URL}/api/results`);
            const results = await response.json();
            if (!Array.isArray(results)) {
                return {
                    played: 0,
                    wins: 0,
                    losses: 0,
                    ties: 0,
                    winRate: '0.0',
                    avgScore: '0.0',
                    totalScore: 0,
                    streak: '-',
                    opponents: [],
                    recentMatches: []
                };
            }

            let played = 0;
            let wins = 0;
            let losses = 0;
            let ties = 0;
            let scoreSum = 0;
            const opponentMap = new Map();
            const matchEntries = [];

            for (const match of results) {
                const p1 = String(match?.player1?.handle || '');
                const p2 = String(match?.player2?.handle || '');
                const p1Norm = p1.toLowerCase();
                const p2Norm = p2.toLowerCase();
                if (p1Norm !== normalizedHandle && p2Norm !== normalizedHandle) continue;

                played += 1;
                const winner = match?.winner;
                const winnerNorm = String(winner || '').toLowerCase();
                if (winnerNorm === 'tie') ties += 1;
                else if (winnerNorm === normalizedHandle) wins += 1;
                else losses += 1;

                let ownScore = 0;
                let opponentScore = 0;
                if (p1Norm === normalizedHandle) {
                    ownScore = Number(match?.player1?.score) || 0;
                    opponentScore = Number(match?.player2?.score) || 0;
                    scoreSum += ownScore;
                } else if (p2Norm === normalizedHandle) {
                    ownScore = Number(match?.player2?.score) || 0;
                    opponentScore = Number(match?.player1?.score) || 0;
                    scoreSum += ownScore;
                }

                const opponent = p1Norm === normalizedHandle ? p2 : p1;
                if (opponent) {
                    opponentMap.set(opponent, (opponentMap.get(opponent) || 0) + 1);
                }

                let outcome = 'L';
                if (winnerNorm === 'tie') outcome = 'T';
                else if (winnerNorm === normalizedHandle) outcome = 'W';

                matchEntries.push({
                    opponent,
                    ownScore,
                    opponentScore,
                    outcome,
                    date: match?.date || '',
                    roomId: match?.roomId || ''
                });
            }

            const winRate = played > 0 ? ((wins / played) * 100).toFixed(1) : '0.0';
            const avgScore = played > 0 ? (scoreSum / played).toFixed(1) : '0.0';
            const opponents = Array.from(opponentMap.entries())
                .sort((a, b) => b[1] - a[1])
                .map(([opponentHandle, count]) => ({ handle: opponentHandle, count }));

            const recentMatches = matchEntries
                .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
                .slice(0, 5);

            let streak = '-';
            if (recentMatches.length > 0) {
                const latestOutcome = recentMatches[0].outcome;
                let streakCount = 0;
                for (const item of recentMatches) {
                    if (item.outcome !== latestOutcome) break;
                    streakCount += 1;
                }
                streak = `${latestOutcome}${streakCount}`;
            }

            return { played, wins, losses, ties, winRate, avgScore, totalScore: scoreSum, streak, opponents, recentMatches };
        } catch {
            return {
                played: 0,
                wins: 0,
                losses: 0,
                ties: 0,
                winRate: '0.0',
                avgScore: '0.0',
                totalScore: 0,
                streak: '-',
                opponents: [],
                recentMatches: []
            };
        }
    }

    async function fetchUserProfileDetails(handle) {
        if (window.CFUserInfo) {
            window.CFUserInfo.trackHandles([handle]);
            let info = window.CFUserInfo.getInfo(handle);
            let waited = 0;
            while ((!info || info.rating === null) && waited < 2000) {
                await new Promise(res => setTimeout(res, 100));
                waited += 100;
                info = window.CFUserInfo.getInfo(handle);
            }
            if (info && (info.handle || info.rating !== null || info.maxRating !== null)) return info;
        }

        try {
            const response = await fetch(`https://codeforces.com/api/user.info?handles=${encodeURIComponent(handle)}`);
            const data = await response.json();
            if (data.status !== 'OK' || !Array.isArray(data.result) || !data.result[0]) return null;
            return data.result[0];
        } catch {
            return null;
        }
    }

    async function fetchSitePresence(handle) {
        try {
            const response = await fetch(`${API_BASE_URL}/api/presence/${encodeURIComponent(handle)}`);
            const data = await response.json();
            return {
                active: !!data?.active,
                lastSeen: Number(data?.lastSeen) || null
            };
        } catch {
            return { active: false, lastSeen: null };
        }
    }

    function formatLastSeenLikeCodeforces(lastSeenTs) {
        const timestamp = Number(lastSeenTs) || 0;
        if (!timestamp) return 'last seen unavailable';

        const diffMs = Math.max(0, Date.now() - timestamp);
        const minute = 60 * 1000;
        const hour = 60 * minute;
        const day = 24 * hour;
        const week = 7 * day;
        const month = 30 * day;

        if (diffMs < minute) return 'last seen just now';
        if (diffMs < hour) {
            const value = Math.floor(diffMs / minute);
            return `last seen ${value} minute${value === 1 ? '' : 's'} ago`;
        }
        if (diffMs < day) {
            const value = Math.floor(diffMs / hour);
            return `last seen ${value} hour${value === 1 ? '' : 's'} ago`;
        }
        if (diffMs < week) {
            const value = Math.floor(diffMs / day);
            return `last seen ${value} day${value === 1 ? '' : 's'} ago`;
        }
        if (diffMs < month) {
            const value = Math.floor(diffMs / week);
            return `last seen ${value} week${value === 1 ? '' : 's'} ago`;
        }

        const value = Math.floor(diffMs / month);
        return `last seen ${value} month${value === 1 ? '' : 's'} ago`;
    }

    function openUserProfileModalLoading() {
        if (!userProfileModal || !userProfileBody) return;
        if (userProfileBody) userProfileBody.textContent = 'Loading profile...';
        if (userProfileLogoutBtn) {
            userProfileLogoutBtn.style.display = 'none';
        }
        userProfileModal.style.display = 'flex';
    }

    function renderUserProfileModal(profile, siteStats, presence) {
        if (!userProfileBody) return;
        if (!profile) {
            if (userProfileBody) userProfileBody.textContent = 'Could not load profile right now.';
            return;
        }

        const handle = profile.handle || userHandle;
        const rank = profile.rank || 'Unrated';
        const numericMaxRating = Number(profile.maxRating);
        const numericRating = Number(profile.rating);
        const colorRating = Number.isFinite(numericMaxRating) && numericMaxRating > 0
            ? numericMaxRating
            : (Number.isFinite(numericRating) && numericRating > 0 ? numericRating : 0);
        const handleRankClass = colorRating > 0 ? getRankFromRating(colorRating).color : '';
        const canEditOwnHandle = String(handle || '').toLowerCase() === String(userHandle || '').toLowerCase();
        if (userProfileLogoutBtn) {
            userProfileLogoutBtn.style.display = canEditOwnHandle ? 'inline-flex' : 'none';
        }
        const maxRank = profile.maxRank || 'Unrated';
        const rating = Number.isFinite(Number(profile.rating)) ? profile.rating : '—';
        const maxRating = Number.isFinite(Number(profile.maxRating)) ? profile.maxRating : '—';
        const contribution = Number.isFinite(Number(profile.contribution)) ? profile.contribution : '—';
        const friendOfCount = Number.isFinite(Number(profile.friendOfCount)) ? profile.friendOfCount : '—';
        const stats = siteStats || {
            played: 0,
            wins: 0,
            losses: 0,
            ties: 0,
            winRate: '0.0',
            avgScore: '0.0',
            totalScore: 0,
            streak: '-',
            opponents: [],
            recentMatches: []
        };
        const avatar = profile.titlePhoto || userAvatarUrl || '';
        const base = `https://codeforces.com/profile/${encodeURIComponent(handle)}`;
        const historyUrl = `results.html?handle=${encodeURIComponent(handle)}`;
        const statusText = presence?.active
            ? 'online now'
            : formatLastSeenLikeCodeforces(presence?.lastSeen);
        const statusClass = presence?.active ? 'status-active' : 'status-offline';
        const selfHandle = String(userHandle || '').trim();
        const h2hUrl = selfHandle && selfHandle.toLowerCase() !== String(handle).toLowerCase()
            ? `headtohead.html?h1=${encodeURIComponent(selfHandle)}&h2=${encodeURIComponent(handle)}`
            : `headtohead.html?h1=${encodeURIComponent(handle)}`;
        const opponentsHtml = Array.isArray(stats.opponents) && stats.opponents.length > 0
            ? stats.opponents.slice(0, 8).map(item => `<a href="#" class="user-stats-handle" data-handle="${item.handle}">${item.handle}</a> (${item.count})`).join(', ')
            : 'No match history yet.';
        const recentMatchesHtml = Array.isArray(stats.recentMatches) && stats.recentMatches.length > 0
            ? stats.recentMatches.map(item => {
                const outcomeClass = item.outcome === 'W' ? 'win' : item.outcome === 'L' ? 'loss' : 'tie';
                const dateText = item.date ? new Date(item.date).toLocaleDateString() : '—';
                const roomHref = item.roomId ? `results.html?roomId=${encodeURIComponent(item.roomId)}` : historyUrl;
                return `
                    <li class="user-recent-item">
                        <span class="user-recent-outcome ${outcomeClass}">${item.outcome}</span>
                        <span class="user-recent-opponent">vs ${item.opponent || 'Unknown'}</span>
                        <span class="user-recent-score">${item.ownScore} - ${item.opponentScore}</span>
                        <a class="user-recent-link" href="${roomHref}" target="_blank" rel="noopener noreferrer">${dateText}</a>
                    </li>
                `;
            }).join('')
            : '<li class="user-recent-empty">No recent matches</li>';

        userProfileBody.innerHTML = `
            <div class="user-profile-head">
                ${avatar ? `<img src="${avatar}" alt="${handle}" class="user-profile-avatar">` : ''}
                <div class="user-profile-head-info">
                    <div class="user-profile-handle-row">
                        <div class="user-profile-handle ${handleRankClass}">${window.CFUserInfo ? window.CFUserInfo.renderHandleHtml(handle) : escapeHtml(handle)}</div>
                    </div>
                    <div class="user-presence ${statusClass}"><span class="presence-dot"></span>${statusText}</div>
                    <div class="user-profile-rank">${rank} · max ${maxRank}</div>
                </div>
            </div>
            <div class="user-profile-grid">
                <div class="user-profile-item"><span>Rating</span><strong>${rating}</strong></div>
                <div class="user-profile-item"><span>Max Rating</span><strong>${maxRating}</strong></div>
                <div class="user-profile-item"><span>Contribution</span><strong>${contribution}</strong></div>
                <div class="user-profile-item"><span>Friends Of</span><strong>${friendOfCount}</strong></div>
            </div>
            <div class="user-profile-links">
                <a href="${base}" target="_blank" rel="noopener noreferrer">CF Profile</a>
                <a href="${historyUrl}" target="_blank" rel="noopener noreferrer">History</a>
                <a href="${h2hUrl}" target="_blank" rel="noopener noreferrer">Head-to-Head</a>
            </div>
            <div class="user-profile-site">
                <h4>PUC Blitz Stats</h4>
                <div class="user-profile-grid">
                    <div class="user-profile-item"><span>Played Games</span><strong>${stats.played}</strong></div>
                    <div class="user-profile-item"><span>Wins</span><strong>${stats.wins}</strong></div>
                    <div class="user-profile-item"><span>Losses</span><strong>${stats.losses}</strong></div>
                    <div class="user-profile-item"><span>Ties</span><strong>${stats.ties}</strong></div>
                    <div class="user-profile-item"><span>Win Rate</span><strong>${stats.winRate}%</strong></div>
                    <div class="user-profile-item"><span>Avg Score</span><strong>${stats.avgScore}</strong></div>
                    <div class="user-profile-item"><span>Streak</span><strong>${stats.streak}</strong></div>
                    <div class="user-profile-item"><span>Total Score</span><strong>${stats.totalScore}</strong></div>
                </div>
                <div style="margin-top:8px;"><span style="color:var(--muted); font-size:0.82rem;">Played with:</span> ${opponentsHtml}</div>
                <div class="user-recent-wrap">
                    <div class="user-recent-title">Recent 5 Matches</div>
                    <ul class="user-recent-list">${recentMatchesHtml}</ul>
                </div>
                <div style="margin-top:10px;">
                    <a class="user-stats-handle" href="${historyUrl}" target="_blank" rel="noopener noreferrer">View played match history</a>
                </div>
            </div>
        `;
    }

    async function openUserProfileModal(targetHandle = '') {
        const handleToOpen = String(targetHandle || userHandle || '').trim();
        if (!handleToOpen) return;
        openUserProfileModalLoading();
        const [profile, siteStats, presence] = await Promise.all([
            fetchUserProfileDetails(handleToOpen),
            fetchSiteUserStats(handleToOpen),
            fetchSitePresence(handleToOpen)
        ]);
        renderUserProfileModal(profile, siteStats, presence);
    }

    function bindArenaPlayerProfileLinks() {
        const wire = (anchorEl) => {
            if (!anchorEl) return;
            anchorEl.addEventListener('click', (event) => {
                event.preventDefault();
                const handleToOpen = String(anchorEl.textContent || '').trim();
                if (!handleToOpen || handleToOpen.toLowerCase() === 'waiting') return;
                openUserProfileModal(handleToOpen).catch(() => {});
            });
        };

        wire(p1HandleSpan);
        wire(p2HandleSpan);
    }

    // Load saved state
    function loadSavedState() {
        const hasPersistedHandle = !!String(storageGetItem(getUserHandleStorageKey()) || '').trim();
        if (hasPersistedHandle && !isAuthSessionValid()) {
            clearAuthSessionStorage();
        }

        const persistedHandle = storageGetItem(getUserHandleStorageKey()) || '';
        const persistedAvatar = storageGetItem(getUserAvatarStorageKey()) || '';
        if (persistedHandle) {
            userHandle = persistedHandle;
                window.userHandle = userHandle;
            userAvatarUrl = persistedAvatar;
            playersValidated = true;
            userHandleInput.value = userHandle;
            renderLoggedInfo();
        }

        const saved = storageGetItem('blitzRoomState');
        if (saved) {
            try {
                const state = JSON.parse(saved);
                userHandle = state.userHandle || userHandle;
                    window.userHandle = userHandle;
                userAvatarUrl = state.userAvatarUrl || userAvatarUrl;
                playersValidated = !!userHandle;
                currentRoom = state.currentRoom || null;
                    window.currentRoom = currentRoom;
                    console.log('[CLIENT] DEBUG set currentRoom:', currentRoom);
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
        storageSetItem('blitzRoomState', JSON.stringify(state));
        if (userHandle) {
            storageSetItem(getUserHandleStorageKey(), userHandle);
            storageSetItem(getUserAvatarStorageKey(), userAvatarUrl || '');
            stampAuthSessionMeta();
        } else {
            storageRemoveItem(AUTH_META_KEY);
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
        storageSetItem(getRuntimeStateKey(), JSON.stringify(runtimeState));
    }

    function loadBattleRuntimeState() {
        const saved = storageGetItem(getRuntimeStateKey());
        if (!saved) return null;
        try {
            return JSON.parse(saved);
        } catch {
            return null;
        }
    }

    function clearBattleRuntimeState() {
        storageRemoveItem(getRuntimeStateKey());
    }

    // Clear saved state
    function clearSavedState() {
        storageRemoveItem('blitzRoomState');
        // Do NOT clearBattleRuntimeState here, so runtime state (including standing timestamp) persists across leave/re-enter
    }

    function isAdminHandle(handle) {
        return ADMIN_HANDLES.has(String(handle || '').trim().toLowerCase());
    }

    // Reconnect to room
    function reconnectToRoom() {
        window.reconnectToRoom = reconnectToRoom;
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
        window.ws = ws;
        
        ws.onopen = () => {
            console.log('WebSocket connected');
            reconnectAttempts = 0;
            syncedActiveHandle = '';
            
            if (currentRoom) {
                ws.send(JSON.stringify({
                    type: 'REJOIN_ROOM',
                    roomId: currentRoom,
                    handle: userHandle
                }));
            } else {
                ws.send(JSON.stringify({ type: 'GET_ACTIVE_ROOMS' }));
            }

            syncActiveHandlePresence(true);
            tryJoinPendingRoom();
        };
        
        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            handleWebSocketMessage(data);
        };
        
        ws.onclose = () => {
            console.log('WebSocket disconnected');
            syncedActiveHandle = '';
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
                window.currentRoom = currentRoom;
                console.log('[CLIENT] DEBUG set currentRoom (ROOM_CREATED):', currentRoom);
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
                window.currentRoom = currentRoom;
                console.log('[CLIENT] DEBUG set currentRoom (ROOM_JOINED):', currentRoom);
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
                console.log('PLAYER_JOINED received', data);
                updateRoomPlayers(data.players || [], { type: 'joined', handle: data.handle });
                // Also re-render the full room UI for all clients
                if (typeof joinRoomUI === 'function' && data.roomId && data.roomName && data.players) {
                    joinRoomUI(
                        data.roomId,
                        data.roomName,
                        data.players,
                        data.duration,
                        data.interval,
                        data.problems,
                        data.validationProblem
                    );
                }
                if (data.handle) {
                    const joinedRole = String(data.role || '').trim().toLowerCase();
                    const joinedLabel = joinedRole === 'player'
                        ? 'Player Joined'
                        : 'Spectator Joined';
                    showDesktopNotification(`👋 ${joinedLabel}`, `${data.handle} joined the room`, false, true);
                }
                break;
                
            case 'REJOIN_SUCCESS':
                currentRoom = data.roomId;
                window.currentRoom = currentRoom;
                console.log('[CLIENT] DEBUG set currentRoom (REJOIN_SUCCESS):', currentRoom);
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
                window.currentRoom = currentRoom;
                console.log('[CLIENT] DEBUG set currentRoom (JOIN_ERROR):', currentRoom);
                isHost = false;
                roomData = null;
                clearSavedState();
                break;
                
            case 'PLAYER_LEFT':
                showDesktopNotification('👋 Player Left', `${data.handle} left the room`);
                updateRoomPlayers(data.players, { type: 'left', handle: data.handle });
                break;
                
            case 'PLAYER_RECONNECTED':
                showDesktopNotification('🔄 Player Reconnected', `${data.handle} reconnected`);
                updateRoomPlayers(data.players, { type: 'reconnected', handle: data.handle });
                break;
                
            case 'ACTIVE_ROOMS':
                displayActiveRooms(data.rooms);
                break;
                
            case 'BATTLE_STARTED':
                console.log('[CLIENT] BATTLE_STARTED received', data);
                stopMatchCountdown();
                showDesktopNotification('🚀 Match Started', 'Blitz match has started for both players.', false, true);
                startBattleFromHost(data.battleState);
                break;

            case 'MATCH_COUNTDOWN_STARTED':
                console.log('[CLIENT] MATCH_COUNTDOWN_STARTED received', data);
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
                console.log('[CLIENT] VALIDATION_STATUS received', data);
                const pair = data.pair || [];
                const statuses = data.statuses || {};
                if (pair.length >= 2) {
                    // ...existing code...
                    if (startP1Handle) {
                        if (pair[0] && pair[0] !== 'Waiting') {
                            if (window.CFUserInfo) {
                                window.CFUserInfo.trackHandles([pair[0]]);
                                const info = window.CFUserInfo.getInfo(pair[0]) || {};
                                const display = info.handle || pair[0];
                                startP1Handle.innerHTML = window.CFUserInfo.renderHandleHtml(display);
                                startP1Handle.href = `https://codeforces.com/profile/${encodeURIComponent(display)}`;
                                startP1Handle.setAttribute('data-handle', encodeURIComponent(pair[0]));
                                startP1Handle.setAttribute('target', '_blank');
                                startP1Handle.setAttribute('rel', 'noopener noreferrer');
                            } else {
                                startP1Handle.textContent = pair[0];
                                startP1Handle.href = `https://codeforces.com/profile/${encodeURIComponent(pair[0])}`;
                            }
                        } else {
                            startP1Handle.textContent = pair[0];
                            startP1Handle.href = '#';
                        }
                    }
                    if (startP2Handle) {
                        if (pair[1] && pair[1] !== 'Waiting') {
                            if (window.CFUserInfo) {
                                window.CFUserInfo.trackHandles([pair[1]]);
                                const info2 = window.CFUserInfo.getInfo(pair[1]) || {};
                                const display2 = info2.handle || pair[1];
                                startP2Handle.innerHTML = window.CFUserInfo.renderHandleHtml(display2);
                                startP2Handle.href = `https://codeforces.com/profile/${encodeURIComponent(display2)}`;
                                startP2Handle.setAttribute('data-handle', encodeURIComponent(pair[1]));
                                startP2Handle.setAttribute('target', '_blank');
                                startP2Handle.setAttribute('rel', 'noopener noreferrer');
                            } else {
                                startP2Handle.textContent = pair[1];
                                startP2Handle.href = `https://codeforces.com/profile/${encodeURIComponent(pair[1])}`;
                            }
                        } else {
                            startP2Handle.textContent = pair[1];
                            startP2Handle.href = '#';
                        }
                    }

                    // Normalize handles for readiness check
                    let myHandle = (userHandle || '').trim().toLowerCase();
                    let pairLower = pair.map(h => (h || '').trim().toLowerCase());
                    let statusesLower = {};
                    Object.keys(statuses).forEach(h => {
                        statusesLower[(h || '').trim().toLowerCase()] = statuses[h];
                    });
                    // Debug log after all variables are initialized
                    console.log('[CLIENT] DEBUG myHandle:', myHandle, 'pairLower:', pairLower, 'statusesLower:', statusesLower);
                    let iAmInPair = pairLower.includes(myHandle);
                    startBattleVSBlock.style.display = 'block';
                    if (iAmInPair) {
                        startBattleBtn.disabled = !!statusesLower[myHandle];
                        if (startBattleBtn) startBattleBtn.textContent = statusesLower[myHandle] ? 'Ready ✔️' : 'Start Match';
                    } else {
                        startBattleBtn.disabled = true;
                        if (startBattleBtn) startBattleBtn.textContent = 'Waiting for players';
                    }

                    // Show status for both players
                    const p1Ok = !!statusesLower[pairLower[0]];
                    const p2Ok = !!statusesLower[pairLower[1]];
                    if (validationStatusText) validationStatusText.textContent = `${pair[0]}: ${p1Ok ? 'Ready ✅' : 'Not Ready'} | ${pair[1]}: ${p2Ok ? 'Ready ✅' : 'Not Ready'} · ${data.message || ''}`;
                } else {
                    startBattleVSBlock.style.display = 'none';
                    if (validationStatusText) {
                        validationStatusText.textContent = data.message || 'Waiting for match creator and selected opponent to be connected.';
                    }
                }
                break;
            }

            case 'PROBLEM_SOLVED': {
                const solveKey = data.solveKey || `${data.problemId}:${data.solverHandle}`;
                if (!solveNotificationKeys.has(solveKey)) {
                    solveNotificationKeys.add(solveKey);
                    showDesktopNotification('✅ Problem Solved!', `${data.solverHandle} solved Problem ${data.problemNumber}!`, false, true);
                }

                // Update solvedAtSec if provided
                if (typeof data.solvedAtSec === 'number' && data.solverHandle && data.problemNumber) {
                    const problemIndex = Number(data.problemNumber) - 1;
                    if (problemIndex >= 0) {
                        if (data.solverHandle === player1Handle && problemResults.p1 && problemResults.p1[problemIndex]) {
                            problemResults.p1[problemIndex].solvedAtSec = data.solvedAtSec;
                        } else if (data.solverHandle === player2Handle && problemResults.p2 && problemResults.p2[problemIndex]) {
                            problemResults.p2[problemIndex].solvedAtSec = data.solvedAtSec;
                        }
                    }
                }

                if (battleActive && !problemLocked) {
                    const solvedProblemNumber = Number(data.problemNumber) || 0;
                    const isCurrentProblem = solvedProblemNumber === currentProblemIndex;
                    if (isCurrentProblem) {
                        checkSubmissions().catch(() => {});
                    }
                }
                // Always update clickable state after problem is solved
                if (typeof updateCurrentProblemDetailsUI === 'function') {
                    updateCurrentProblemDetailsUI();
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
                    } else if (breakActive && currentProblemIndex + 1 === nextProblemNumber) {
                        console.log('[NEXT_PROBLEM_READY] Setting queuedNextProblem', {
                            breakActive,
                            currentProblemIndex,
                            nextProblemNumber,
                            dataProblem: data.problem
                        });
                        queuedNextProblem = data.problem;
                    }

                    console.log('[NEXT_PROBLEM_READY] Message handled', {
                        breakActive,
                        currentProblemIndex,
                        nextProblemNumber,
                        queuedNextProblem
                    });

                    showDesktopNotification('🆕 New Problem Ready', `Problem ${nextProblemNumber} generated and ready for next round.`, false, true);

                    saveBattleRuntimeState();
                }
                // Always update clickable state after next problem is loaded
                if (typeof updateCurrentProblemDetailsUI === 'function') {
                    updateCurrentProblemDetailsUI();
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
                        function updateCurrentProblemDetailsUI() {
                            if (!currentProblem) return;
                            const problemPoints = selectedProblems[Math.max(0, currentProblemIndex - 1)]?.points || currentProblem.points || 500;
                            if (probNameSpan) probNameSpan.textContent = currentProblem.name;
                            if (probPointsSpan) probPointsSpan.textContent = problemPoints;
                            if (probRatingSpan) probRatingSpan.textContent = `Rating: ${currentProblem.rating}`;
                            problemUrl.href = currentProblem.url;
                            // Always fully reset clickable state and style
                            problemUrl.classList.remove('not-allowed');
                            problemUrl.style.pointerEvents = 'auto';
                            problemUrl.style.opacity = '1';
                            if (problemUrl._blockClickHandler) {
                                problemUrl.removeEventListener('click', problemUrl._blockClickHandler);
                                problemUrl._blockClickHandler = null;
                            }
                            // Check if current problem is solved by either player
                            const index = Math.max(0, Number(currentProblemIndex || 0) - 1);
                            const p1Solved = problemResults?.p1?.[index]?.solved;
                            const p2Solved = problemResults?.p2?.[index]?.solved;
                            if (p1Solved || p2Solved) {
                                // Show who solved and use green solved-flash style
                                let solver = null;
                                if (p1Solved && problemResults?.p1?.[index]?.solvedAtSec != null) solver = player1Handle;
                                if (p2Solved && problemResults?.p2?.[index]?.solvedAtSec != null) solver = player2Handle;
                                if (solver) {
                                    if (lockStatusDiv) lockStatusDiv.textContent = `🔒 LOCKED · solved by ${solver}`;
                                } else {
                                    if (lockStatusDiv) lockStatusDiv.textContent = `🔒 LOCKED · solved`;
                                }
                                if (lockStatusDiv) lockStatusDiv.className = 'problem-lock-status solved-flash';
                            } else {
                                // No unlocked text, just show problem info
                                if (lockStatusDiv) lockStatusDiv.textContent = `Problem ${currentProblemIndex}/${problems.length} · waiting for AC`;
                                if (lockStatusDiv) lockStatusDiv.className = 'problem-lock-status';
                            }
                        }
                window.restoreBattleState = restoreBattleState;
                console.log('[restoreBattleState] called', {
                    player1Handle,
                    player2Handle,
                    battleActive,
                    battleStartTime,
                    battleEndsAt,
                    currentProblemIndex,
                    currentProblem,
                    breakActive,
                    breakSecondsLeft,
                    timeLeftSec
                });
        stopMatchCountdown();
        battleActive = true;
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
        // At match start, set both ranks to '1' for live standings
        player1Rank = '1';
        player2Rank = '1';
        const currentProblemNumberFromLive = Number(liveState.currentProblemNumber) || 0;
        currentProblemIndex = Math.max(0, currentProblemNumberFromLive);
        currentProblem = liveState.currentProblem || (currentProblemIndex > 0 ? selectedProblems[currentProblemIndex - 1] : null);
        problemLocked = !!liveState.problemLocked;
        breakActive = false;
        breakSecondsLeft = 0;
        breakStartTime = null;
        timeLeftSec = Math.max(0, Math.floor((battleEndsAt - getSyncedNow()) / 1000));
        problemResults = {
            p1: problems.map(() => createEmptyProblemResult()),
            p2: problems.map(() => createEmptyProblemResult())
        };

        const problemWinners = state.problemWinners || {};
        const problemSolveTimes = state.problemSolveTimes || {};
        Object.entries(problemWinners).forEach(([problemWinnerKey, winnerHandle]) => {
            const [problemNumberStr] = String(problemWinnerKey).split(':');
            const problemNumber = Number(problemNumberStr) || 0;
            if (problemNumber < 1 || problemNumber > problems.length) return;

            const problemIndex = problemNumber - 1;
            if (!problemResults.p1[problemIndex]) {
                problemResults.p1[problemIndex] = createEmptyProblemResult();
            }
            if (!problemResults.p2[problemIndex]) {
                problemResults.p2[problemIndex] = createEmptyProblemResult();
            }

            const problemPoints = problems[problemNumber - 1]?.points || selectedProblems[problemNumber - 1]?.points || 0;
            if (winnerHandle === player1Handle) {
                player1Score += problemPoints;
                problemResults.p1[problemIndex].solved = true;
                problemResults.p1[problemIndex].pending = false;
                // Restore solve time if available, but do not overwrite existing non-null/positive value
                if (problemSolveTimes[problemNumber] && Number.isFinite(Number(problemSolveTimes[problemNumber].p1))) {
                    problemResults.p1[problemIndex].solvedAtSec = Number(problemSolveTimes[problemNumber].p1);
                } // else do not overwrite existing solvedAtSec
                p1SolvedProblems.add(String(problemNumber));
            } else if (winnerHandle === player2Handle) {
                player2Score += problemPoints;
                problemResults.p2[problemIndex].solved = true;
                problemResults.p2[problemIndex].pending = false;
                // Restore solve time if available, but do not overwrite existing non-null/positive value
                if (problemSolveTimes[problemNumber] && Number.isFinite(Number(problemSolveTimes[problemNumber].p2))) {
                    problemResults.p2[problemIndex].solvedAtSec = Number(problemSolveTimes[problemNumber].p2);
                } // else do not overwrite existing solvedAtSec
                p2SolvedProblems.add(String(problemNumber));
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
                    // Always try to load next problem after break ends if queuedNextProblem exists
                    if (typeof queuedNextProblem !== 'undefined' && queuedNextProblem) {
                        loadNextProblem().then(() => {
                            updatePlayerUI();
                            renderProblemsDisplay();
                            updateTimerDisplay();
                            updateCurrentProblemDetailsUI();
                        });
                    } else {
                        // Always update UI after break ends
                        updatePlayerUI();
                        renderProblemsDisplay();
                        updateTimerDisplay();
                        updateCurrentProblemDetailsUI();
                    }
                }
            }
        }
        
        // Hide VS block and countdown overlay if visible
        if (startBattleVSBlock) startBattleVSBlock.style.display = 'none';
        if (matchCountdownOverlay) matchCountdownOverlay.style.display = 'none';

        // Always show battle UI and update timer
        showBattleUI();
        validationSection.style.display = 'none';
        renderLiveSpectatorList(roomData?.players || []);
        updatePlayerUI();
        renderProblemsDisplay();
        updateTimerDisplay();

        // Always load the next problem if not set, and update UI after
        if ((!currentProblem && !breakActive) || (!currentProblem && currentProblemIndex < problems.length)) {
            loadNextProblem().then(() => {
                updatePlayerUI();
                renderProblemsDisplay();
                updateTimerDisplay();
            });
        } else if (currentProblem) {
            updateCurrentProblemDetailsUI();
            updatePlayerUI();
            renderProblemsDisplay();
            updateTimerDisplay();
        }

        if (breakActive) {
            breakTimerDiv.style.display = 'block';
            breakTimerDiv.textContent = `⏳ break ${breakSecondsLeft}s`;
            breakIndicator.style.display = 'inline-block';
            breakIndicator.textContent = `Break ${breakSecondsLeft}s`;
        }

        // Always start timer interval
        startBattleTimer();
        if (apiCheckInterval) clearInterval(apiCheckInterval);
        if (!breakActive) {
            apiCheckInterval = setInterval(checkSubmissions, checkIntervalSec * 1000);
        }

        saveBattleRuntimeState();
    }

    // Render problems in create room form
    function renderCreateProblems(scrollToIndex = null) {
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

        if (Number.isInteger(scrollToIndex) && scrollToIndex >= 0) {
            const target = createProblemsList.querySelector(`.create-problem-item[data-index="${scrollToIndex}"]`);
            if (target) {
                target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        }
    }

    // Add problem in create form
    createAddProblemBtn.addEventListener('click', () => {
        const lastPoints = problems.length > 0 ? Number(problems[problems.length - 1].points) || 0 : 0;
        const lastRating = problems.length > 0 ? Number(problems[problems.length - 1].rating) || 800 : 800;
        problems.push({ points: Math.max(1, lastPoints + 2), rating: Math.min(3500, lastRating + 100) });
        renderCreateProblems(problems.length - 1);
    });

    function setValidationProblem(problem, players = []) {
        validationProblem = problem || null;

        validationSection.style.display = 'block';
        if (!validationProblem) {
            validationProblemLink.href = '#';
            validationProblemLink.style.pointerEvents = 'none';
            validationProblemLink.style.opacity = '0.7';
            if (validationProblemTitle) validationProblemTitle.textContent = 'Generating validation problem...';
            if (validationStatusText) validationStatusText.textContent = 'Please wait. Validation problem is being prepared.';
            roomValidationMini.style.display = 'none';
            return;
        }

        validationProblemLink.href = validationProblem.url;
        validationProblemLink.style.pointerEvents = 'auto';
        validationProblemLink.style.opacity = '1';
        if (validationProblemTitle) validationProblemTitle.textContent = `${validationProblem.name} · ${validationProblem.rating}`;

        roomValidationMini.href = validationProblem.url;
        roomValidationMini.style.display = 'inline-block';

        if (players.length < 2) {
            if (validationStatusText) validationStatusText.textContent = 'Waiting for selected opponent to join match creator room and submit Compilation Error to the provided problem.';
        } else {
            if (validationStatusText) validationStatusText.textContent = 'Waiting for match creator and selected opponent to submit Compilation Error to the provided problem.';
        }
    }

    function joinRoomUI(roomId, roomName, players, duration, interval, roomProblems, roomValidationProblem = null) {
        console.log('[joinRoomUI] called', { roomId, roomName, players, duration, interval, roomProblems, roomValidationProblem });
        roomControls.style.display = 'none';
        activeBlitzSection.style.display = 'none';
        
        roomInfoBar.style.display = 'flex';
        if (currentRoomName) currentRoomName.textContent = roomName;
        if (currentRoomId) currentRoomId.textContent = roomId;
        
        displayDuration.value = `${duration} min`;
        displayInterval.value = `${interval} sec`;
        displayProblems.value = `${roomProblems.length} problems`;
        
        problems = roomProblems;
        setValidationProblem(roomValidationProblem, players);
        renderProblemsDisplay();
        
        updateRoomPlayers(players);
        // Show VS block only when both players are present and not in battle
        if (startBattleVSBlock) {
            // Only show if not in battle state
            if (!battleActive && players.length >= 2) {
                startBattleVSBlock.style.display = 'block';
            } else {
                startBattleVSBlock.style.display = 'none';
            }
        }
        if (players.length >= 2) {
            configDashboard.style.display = 'flex';
            problemsDisplaySection.style.display = 'block';
            player1Handle = players[0];
            player2Handle = players[1];
            if (p1HandleSpan) {
                if (player1Handle && player1Handle !== 'Waiting') {
                    if (window.CFUserInfo) {
                        window.CFUserInfo.trackHandles([player1Handle]);
                        const p1Info = window.CFUserInfo.getInfo(player1Handle) || {};
                        const disp1 = p1Info.handle || player1Handle;
                        p1HandleSpan.innerHTML = window.CFUserInfo.renderHandleHtml(disp1);
                        p1HandleSpan.href = `https://codeforces.com/profile/${encodeURIComponent(disp1)}`;
                        p1HandleSpan.setAttribute('data-handle', encodeURIComponent(player1Handle));
                        p1HandleSpan.setAttribute('target', '_blank');
                        p1HandleSpan.setAttribute('rel', 'noopener noreferrer');
                    } else {
                        p1HandleSpan.textContent = player1Handle;
                        p1HandleSpan.href = `https://codeforces.com/profile/${encodeURIComponent(player1Handle)}`;
                    }
                } else {
                    p1HandleSpan.textContent = player1Handle;
                    p1HandleSpan.href = '#';
                }
            }
            if (p2HandleSpan) {
                if (player2Handle && player2Handle !== 'Waiting') {
                    if (window.CFUserInfo) {
                        window.CFUserInfo.trackHandles([player2Handle]);
                        const p2Info = window.CFUserInfo.getInfo(player2Handle) || {};
                        const disp2 = p2Info.handle || player2Handle;
                        p2HandleSpan.innerHTML = window.CFUserInfo.renderHandleHtml(disp2);
                        p2HandleSpan.href = `https://codeforces.com/profile/${encodeURIComponent(disp2)}`;
                        p2HandleSpan.setAttribute('data-handle', encodeURIComponent(player2Handle));
                        p2HandleSpan.setAttribute('target', '_blank');
                        p2HandleSpan.setAttribute('rel', 'noopener noreferrer');
                    } else {
                        p2HandleSpan.textContent = player2Handle;
                        p2HandleSpan.href = `https://codeforces.com/profile/${encodeURIComponent(player2Handle)}`;
                    }
                } else {
                    p2HandleSpan.textContent = player2Handle;
                    p2HandleSpan.href = '#';
                }
            }
            if (startP1Handle) {
                if (player1Handle && player1Handle !== 'Waiting') {
                    if (window.CFUserInfo) {
                        window.CFUserInfo.trackHandles([player1Handle]);
                        const sp1 = window.CFUserInfo.getInfo(player1Handle) || {};
                        const d1 = sp1.handle || player1Handle;
                        startP1Handle.innerHTML = window.CFUserInfo.renderHandleHtml(d1);
                        startP1Handle.href = `https://codeforces.com/profile/${encodeURIComponent(d1)}`;
                        startP1Handle.setAttribute('data-handle', encodeURIComponent(player1Handle));
                        startP1Handle.setAttribute('target', '_blank');
                        startP1Handle.setAttribute('rel', 'noopener noreferrer');
                    } else {
                        startP1Handle.textContent = player1Handle;
                        startP1Handle.href = `https://codeforces.com/profile/${encodeURIComponent(player1Handle)}`;
                    }
                } else {
                    startP1Handle.textContent = player1Handle;
                    startP1Handle.href = '#';
                }
            }
            if (startP2Handle) {
                if (player2Handle && player2Handle !== 'Waiting') {
                    if (window.CFUserInfo) {
                        window.CFUserInfo.trackHandles([player2Handle]);
                        const sp2 = window.CFUserInfo.getInfo(player2Handle) || {};
                        const d2 = sp2.handle || player2Handle;
                        startP2Handle.innerHTML = window.CFUserInfo.renderHandleHtml(d2);
                        startP2Handle.href = `https://codeforces.com/profile/${encodeURIComponent(d2)}`;
                        startP2Handle.setAttribute('data-handle', encodeURIComponent(player2Handle));
                        startP2Handle.setAttribute('target', '_blank');
                        startP2Handle.setAttribute('rel', 'noopener noreferrer');
                    } else {
                        startP2Handle.textContent = player2Handle;
                        startP2Handle.href = `https://codeforces.com/profile/${encodeURIComponent(player2Handle)}`;
                    }
                } else {
                    startP2Handle.textContent = player2Handle;
                    startP2Handle.href = '#';
                }
            }
            // AUTO START ENABLE BUTTON (commented out)
            // startBattleBtn.textContent = '⏳ AUTO START ENABLED';
            // startBattleBtn.disabled = true;
            // startP1HandleInput.disabled = true;
            // startP2HandleInput.disabled = true;
            fetchUserRanks();
        } else {
            configDashboard.style.display = 'none';
            problemsDisplaySection.style.display = 'none';
        }
    }

    function renderProblemsDisplay() {
        window.renderProblemsDisplay = renderProblemsDisplay;
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

    function updateRoomPlayers(players, eventMeta = null) {
        const list = Array.isArray(players) ? players.filter(Boolean) : [];
        if (roomPlayers) roomPlayers.textContent = `👥 ${list.length} joined`;
        if (roomData) {
            roomData.players = list;
        }
        renderLiveSpectatorList(list, eventMeta);
    }

    function getSpectatorHandles(players = []) {
        const uniqueHandles = Array.from(new Set((players || []).map(item => String(item || '').trim()).filter(Boolean)));
        const p1 = String(player1Handle || '').trim().toLowerCase();
        const p2 = String(player2Handle || '').trim().toLowerCase();
        return uniqueHandles.filter(handle => {
            const normalized = handle.toLowerCase();
            return normalized !== p1 && normalized !== p2;
        });
    }

    function updateSpectatorPresence(players = [], eventMeta = null) {
        const now = Date.now();
        const activeSpectators = getSpectatorHandles(players);
        const activeSet = new Set(activeSpectators.map(handle => handle.toLowerCase()));

        activeSpectators.forEach(handle => {
            const key = handle.toLowerCase();
            matchSpectatorHandles.add(handle);
            const existing = spectatorPresenceMap.get(key);
            const next = existing ? { ...existing } : { key, label: handle, status: 'online', joinedAt: now, leftAt: null };
            next.label = handle;
            if (next.status !== 'online') {
                next.joinedAt = now;
            }
            next.status = 'online';
            next.leftAt = null;
            spectatorPresenceMap.set(key, next);
        });

        spectatorPresenceMap.forEach((entry, key) => {
            if (!activeSet.has(key) && entry.status === 'online') {
                entry.status = 'left';
                entry.leftAt = now;
                spectatorPresenceMap.set(key, entry);
            }
        });

        if (eventMeta && eventMeta.handle) {
            const eventHandle = String(eventMeta.handle || '').trim();
            const eventKey = eventHandle.toLowerCase();
            const isPlayer = eventKey === String(player1Handle || '').trim().toLowerCase()
                || eventKey === String(player2Handle || '').trim().toLowerCase();

            if (!isPlayer && eventHandle) {
                matchSpectatorHandles.add(eventHandle);
                const existing = spectatorPresenceMap.get(eventKey) || {
                    key: eventKey,
                    label: eventHandle,
                    status: 'online',
                    joinedAt: now,
                    leftAt: null
                };

                if (eventMeta.type === 'left') {
                    existing.status = 'left';
                    existing.leftAt = now;
                } else if (eventMeta.type === 'joined' || eventMeta.type === 'reconnected') {
                    existing.status = 'online';
                    existing.leftAt = null;
                    existing.joinedAt = now;
                }

                existing.label = eventHandle;
                spectatorPresenceMap.set(eventKey, existing);
            }
        }

        spectatorPresenceMap.forEach((entry, key) => {
            if (entry.status === 'left' && (now - (Number(entry.leftAt) || 0)) > SPECTATOR_KEEP_LEFT_MS) {
                spectatorPresenceMap.delete(key);
            }
        });
    }

    function captureSpectatorChipRects() {
        if (!spectatorList) return new Map();

        const rects = new Map();
        const chips = Array.from(spectatorList.querySelectorAll('.spectator-chip'));
        chips.forEach(chip => {
            if (chip.classList.contains('is-leaving')) return;
            const key = String(chip.dataset.handle || '').toLowerCase();
            if (!key) return;
            rects.set(key, chip.getBoundingClientRect());
        });

        return rects;
    }

    function animateSpectatorChipReflow(previousRects) {
        if (!spectatorList || !previousRects || previousRects.size === 0) return;

        const chips = Array.from(spectatorList.querySelectorAll('.spectator-chip'));
        chips.forEach(chip => {
            if (chip.classList.contains('is-leaving') || chip.classList.contains('is-entering')) return;

            const key = String(chip.dataset.handle || '').toLowerCase();
            const previousRect = previousRects.get(key);
            if (!previousRect) return;

            const nextRect = chip.getBoundingClientRect();
            const dx = previousRect.left - nextRect.left;
            const dy = previousRect.top - nextRect.top;

            if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;

            chip.animate(
                [
                    { transform: `translate(${dx}px, ${dy}px)` },
                    { transform: 'translate(0, 0)' }
                ],
                {
                   
                    easing: 'cubic-bezier(0.22, 1, 0.36, 1)'
                }
            );
        });
    }

    function renderLiveSpectatorList(players = [], eventMeta = null) {
        if (!spectatorPanel || !spectatorCountText || !spectatorList) return;

        if (!battleActive) {
            spectatorPanel.style.display = 'none';
            spectatorCountText.textContent = '0 live';
            spectatorList.innerHTML = '';
            spectatorPresenceMap = new Map();
            matchSpectatorHandles = new Set();
            return;
        }

        updateSpectatorPresence(players, eventMeta);

        const now = Date.now();
        const spectatorEntries = Array.from(spectatorPresenceMap.values()).sort((a, b) => {
            if (a.status !== b.status) {
                return a.status === 'online' ? -1 : 1;
            }
            const aTime = Number(a.joinedAt || a.leftAt || 0);
            const bTime = Number(b.joinedAt || b.leftAt || 0);
            return bTime - aTime;
        });

        const liveCount = spectatorEntries.filter(entry => entry.status === 'online').length;
        const leftCount = spectatorEntries.filter(entry => entry.status === 'left').length;

        const previousRects = captureSpectatorChipRects();

        spectatorCountText.textContent = leftCount > 0
            ? `${liveCount} live · ${leftCount} left`
            : `${liveCount} live`;

        const desiredSpectators = spectatorEntries.map(entry => {
            const joinedRecently = entry.status === 'online' && (now - (Number(entry.joinedAt) || 0)) <= SPECTATOR_RECENT_JOIN_MS;
            const statusClass = entry.status === 'online' ? 'is-online' : 'is-left';
            const statusText = entry.status === 'online'
                ? (joinedRecently ? 'newly joined' : 'live now')
                : 'left';
            return {
                key: entry.key,
                label: entry.label,
                statusClass,
                statusText
            };
        });
        const desiredKeys = new Set(desiredSpectators.map(item => item.key));

        const emptyState = spectatorList.querySelector('.spectator-empty');
        if (emptyState) {
            emptyState.remove();
        }

        const existingChips = Array.from(spectatorList.querySelectorAll('.spectator-chip'));
        const existingByKey = new Map();
        existingChips.forEach(chip => {
            const key = String(chip.dataset.handle || '').toLowerCase();
            if (key) {
                existingByKey.set(key, chip);
            }
        });

        const ensureEmptyState = () => {
            if (desiredSpectators.length !== 0) return;
            const remainingChips = spectatorList.querySelectorAll('.spectator-chip').length;
            if (remainingChips > 0) return;
            if (!spectatorList.querySelector('.spectator-empty')) {
                const empty = document.createElement('span');
                empty.className = 'spectator-empty';
                empty.textContent = 'No live spectators';
                spectatorList.appendChild(empty);
            }
        };

        existingChips.forEach(chip => {
            const key = String(chip.dataset.handle || '').toLowerCase();
            if (!key || desiredKeys.has(key) || chip.classList.contains('is-leaving')) return;

            chip.classList.add('is-leaving');
            const removeChip = () => {
                chip.removeEventListener('transitionend', removeChip);
                const beforeRemovalRects = captureSpectatorChipRects();
                if (chip.isConnected) {
                    chip.remove();
                }
                requestAnimationFrame(() => {
                    animateSpectatorChipReflow(beforeRemovalRects);
                });
                ensureEmptyState();
            };

            chip.addEventListener('transitionend', removeChip);
            setTimeout(removeChip, 260);
        });

        desiredSpectators.forEach(({ key, label, statusClass, statusText }) => {
            const existing = existingByKey.get(key);
            if (existing) {
                existing.classList.remove('is-online', 'is-left');
                existing.classList.add(statusClass);
                existing.innerHTML = `<span class="spectator-chip-handle">${escapeHtml(label)}</span><span class="spectator-chip-status">${escapeHtml(statusText)}</span>`;
                existing.setAttribute('title', `Open profile: ${label}`);
                existing.setAttribute('role', 'button');
                existing.setAttribute('tabindex', '0');
                existing.classList.remove('is-leaving');
                spectatorList.appendChild(existing);
                return;
            }

            const chip = document.createElement('span');
            chip.className = `spectator-chip ${statusClass} is-entering`;
            chip.dataset.handle = key;
            chip.innerHTML = `<span class="spectator-chip-handle">${escapeHtml(label)}</span><span class="spectator-chip-status">${escapeHtml(statusText)}</span>`;
            chip.setAttribute('title', `Open profile: ${label}`);
            chip.setAttribute('role', 'button');
            chip.setAttribute('tabindex', '0');
            spectatorList.appendChild(chip);

            requestAnimationFrame(() => {
                chip.classList.remove('is-entering');
            });
        });

        ensureEmptyState();
        requestAnimationFrame(() => {
            animateSpectatorChipReflow(previousRects);
        });

        spectatorPanel.style.display = 'block';
    }

    function renderFilteredActiveRooms() {
        const query = (activeRoomsSearchInput?.value || '').trim().toLowerCase();
        const rooms = query
            ? allActiveRooms.filter(room => {
                const name = String(room?.name || '').toLowerCase();
                const id = String(room?.id || '').toLowerCase();
                return name.includes(query) || id.includes(query);
            })
            : allActiveRooms;

        if (rooms.length === 0) {
            activeBlitzList.innerHTML = `
                <div class="active-blitz-empty-state">
                    <div class="empty-bg-anim" aria-hidden="true">
                        <svg width="180" height="180" viewBox="0 0 180 180" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <circle cx="90" cy="90" r="80" fill="#101624" opacity="0.13"/>
                            <circle cx="90" cy="90" r="60" fill="#6ea8fe" opacity="0.07"/>
                        </svg>
                    </div>
                    <div class="empty-illustration" aria-hidden="true">
                        <svg width="80" height="80" viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <circle cx="40" cy="40" r="38" fill="#151d2b" stroke="#252d3b" stroke-width="3"/>
                            <ellipse cx="40" cy="55" rx="18" ry="6" fill="#232b3b"/>
                            <rect x="28" y="28" width="24" height="16" rx="8" fill="#232b3b"/>
                            <circle cx="36" cy="36" r="3" fill="#6ea8fe"/>
                            <circle cx="44" cy="36" r="3" fill="#6ea8fe"/>
                        </svg>
                    </div>
                    <div class="empty-title">No active rooms right now</div>
                    <div class="empty-desc">Create a new room or join one using a Room ID.</div>
                    <div class="empty-quote">“Opportunities don't happen. You create them.”<br><span>- Chris Grosser</span></div>
                    <div class="empty-actions">
                        <button class="primary-btn" onclick="document.getElementById('roomNameInput').focus()">Create Room</button>
                        <button class="results-btn" onclick="document.getElementById('joinRoomIdInput').focus()">Join Room</button>
                    </div>
                    <ul class="empty-tips">
                        <li>Tip: Invite friends to join your room using the Share button.</li>
                        <li>Check the <a href="leaderboard.html">Leaderboard</a> or <a href="feedback.html">send feedback</a>.</li>
                    </ul>
                </div>
            `;
            return;
        }

        // Show all rooms, let CSS handle scrolling
        let html = '';
        rooms.forEach(room => {
            html += `
                <div class="blitz-room-card" style="position:relative;">
                    <button class="share-room-btn" title="Copy room code" style="position:absolute;top:10px;right:10px;font-size:0.78em;padding:2px 8px;min-width:unset;line-height:1.1;background:linear-gradient(180deg,#9dc4ff,#6ea8fe);color:#0a1220;border-radius:7px;border:1px solid #6ea8fe;cursor:pointer;z-index:2;" onclick="window.copyRoomShareLink('${room.id}', this)">Share</button>
                    <div class="blitz-room-info">
                        <h4>${room.name}</h4>
                        <div style=\"font-weight:normal;font-size:0.95em;margin-bottom:2px;\">${room.hostHandle ? room.hostHandle : '?'} vs ${room.opponentHandle ? room.opponentHandle : '?'}</div>
                        <p>ID: ${room.id} | 👥 ${room.assignedPlayers || room.players} joined</p>
                        <p>⏱️ ${room.duration} min | 🔄 ${room.interval}s | 📋 ${room.problems} problems</p>
                    </div>
                    <button class="join-this-room-btn" style="position:absolute;bottom:10px;right:10px;font-size:0.92em;padding:5px 14px;min-width:unset;line-height:1.2;z-index:2;" onclick="window.joinRoom('${room.id}')">Join</button>
                </div>
            `;
        });
        activeBlitzList.innerHTML = html;
    }

    // Add global function to copy room link
    window.copyRoomShareLink = function(url, btn) {
        if (!navigator.clipboard) {
            // fallback
            const input = document.createElement('input');
            input.value = url;
            document.body.appendChild(input);
            input.select();
            document.execCommand('copy');
            document.body.removeChild(input);
        } else {
            navigator.clipboard.writeText(url);
        }
        if (btn) {
            const prev = btn.textContent;
            btn.textContent = 'Room ID copied!';
            btn.disabled = true;
            setTimeout(() => {
                btn.textContent = prev;
                btn.disabled = false;
            }, 1200);
        }
    }

    function displayActiveRooms(rooms) {
        allActiveRooms = Array.isArray(rooms) ? rooms : [];
        renderFilteredActiveRooms();
    }

    window.joinRoom = function(roomId) {
        if (!userHandle) {
            alert('Please login first');
            return;
        }

        const normalizedRoomId = String(roomId || '').trim().toUpperCase();
        joinRoomIdInput.value = normalizedRoomId;

        if (!ws || ws.readyState !== WebSocket.OPEN) {
            alert('Connection not ready. Please wait a moment and try again.');
            return;
        }

        ws.send(JSON.stringify({
            type: 'JOIN_ROOM',
            roomId: normalizedRoomId,
            handle: userHandle
        }));
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

    function openHandleSetupModal() {
        userHandleInput.value = userHandle || '';
        handleVerificationProblem = null;
        handleVerificationChallengeId = '';
        handleVerificationHandle = '';
        handleVerificationBlock.style.display = 'none';
        handleVerificationProblemLink.href = '#';
        handleVerificationStatus.textContent = 'Waiting for COMPILATION_ERROR submission...';
        handleVerificationGenerationInFlight = false;
        setGenerateHandleButtonState({
            disabled: false,
            label: defaultGenerateHandleVerificationBtnLabel
        });
        handleSetupModal.style.display = 'flex';
        userHandleInput.focus();
    }

    async function completeHandleSetup(profile) {
        userHandle = profile.handle;
            window.userHandle = userHandle;
            window.currentRoom = currentRoom;
            window.currentRoom = currentRoom;
            window.currentRoom = currentRoom;
            window.currentRoom = currentRoom;
            window.currentRoom = currentRoom;
            window.currentRoom = currentRoom;
        userAvatarUrl = profile.avatar || '';
        playersValidated = true;
        userHandleInput.value = profile.handle;

        try {
            await fetch(`${API_BASE_URL}/api/profiles`, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' }
            });
        } catch {
        }

        renderLoggedInfo();
        await ensureNotificationPermission();
        saveState();
        closeHandleSetupModal();
        showDesktopNotification('✅ Handle Verified', `${profile.handle} verified successfully`);

        if (pendingPostLoginReturnTo) {
            const target = pendingPostLoginReturnTo;
            pendingPostLoginReturnTo = '';
            window.location.href = target;
        } else {
            // Refresh the page after successful login if no redirect
            window.location.reload();
        }
    }

    async function verifyHandleCompilationErrorNow() {
        if (!handleVerificationHandle || !handleVerificationProblem || !handleVerificationChallengeId) {
            return;
        }

        handleVerificationStatus.textContent = 'Checking Codeforces submissions...';
        const loginResult = await createServerSessionForHandle(handleVerificationHandle, handleVerificationChallengeId);
        if (loginResult.ok) {
            const profile = await fetchUserProfile(handleVerificationHandle);
            if (!profile) {
                handleVerificationStatus.textContent = 'Verified, but could not load profile. Try again.';
                return;
            }

            await completeHandleSetup(profile);
            return;
        }

        if (Number(loginResult.status) === 410) {
            handleVerificationStatus.textContent = 'Verification expired. Generate a new problem and submit CE again.';
            setGenerateHandleButtonState({
                disabled: false,
                label: defaultGenerateHandleVerificationBtnLabel
            });
            handleVerificationChallengeId = '';
            return;
        }

        handleVerificationStatus.textContent = loginResult.error || 'Not found yet. Submit COMPILATION_ERROR on the generated problem and verify again.';
    }

    async function startHandleVerificationFlow() {
        const handle = userHandleInput.value.trim();
        if (!handle) {
            alert('Please enter a handle');
            return false;
        }

        const profile = await fetchUserProfile(handle);
        if (!profile) {
            alert('Invalid Codeforces handle');
            return false;
        }

        const challengePayload = await requestHandleVerificationChallenge(profile.handle);
        if (!challengePayload || !challengePayload.problem || !challengePayload.challengeId) {
            alert('Could not generate verification problem right now. Please try again.');
            return false;
        }

        handleVerificationHandle = profile.handle;
        handleVerificationChallengeId = challengePayload.challengeId;
        handleVerificationProblem = challengePayload.problem;
        handleVerificationProblemLink.href = handleVerificationProblem.url;
        handleVerificationProblemLink.textContent = `${handleVerificationProblem.name} · ${handleVerificationProblem.rating}`;
        handleVerificationBlock.style.display = 'block';
        handleVerificationStatus.textContent = `Submit COMPILATION_ERROR on this problem from @${profile.handle}. Auto-checking every 5s...`;

        stopHandleVerificationPolling();
        handleVerificationTimer = setInterval(() => {
            verifyHandleCompilationErrorNow().catch(() => {});
        }, 5000);

        return true;
    }

    setHandleBtn.addEventListener('click', () => {
        openHandleSetupModal();
    });

    generateHandleVerificationBtn.addEventListener('click', async () => {
        if (handleVerificationGenerationInFlight || generateHandleVerificationBtn.disabled) {
            return;
        }

        handleVerificationGenerationInFlight = true;
        setGenerateHandleButtonState({ disabled: true, label: 'Generating...' });

        try {
            const success = await startHandleVerificationFlow();
            if (success) {
                setGenerateHandleButtonState({ disabled: true, label: 'Generated' });
            } else {
                setGenerateHandleButtonState({
                    disabled: false,
                    label: defaultGenerateHandleVerificationBtnLabel
                });
            }
        } catch (error) {
            console.error('Handle verification flow failed:', error);
            alert('Could not start handle verification right now.');
            setGenerateHandleButtonState({
                disabled: false,
                label: defaultGenerateHandleVerificationBtnLabel
            });
        } finally {
            handleVerificationGenerationInFlight = false;
        }
    });

    verifyHandleCeBtn.addEventListener('click', () => {
        verifyHandleCompilationErrorNow().catch(error => {
            console.error('Manual CE verification failed:', error);
        });
    });

    closeHandleSetup.addEventListener('click', () => {
        closeHandleSetupModal();
    });

    loggedInfo.addEventListener('click', () => {
        openUserProfileModal().catch(() => {});
    });

    loggedInfo.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openUserProfileModal().catch(() => {});
        }
    });

    if (closeUserProfileModal) {
        closeUserProfileModal.addEventListener('click', () => {
            userProfileModal.style.display = 'none';
        });
    }

    if (userProfileLogoutBtn) {
        userProfileLogoutBtn.addEventListener('click', () => {
            if (!window.confirm('Are you sure you want to logout?')) {
                return;
            }
            logoutCurrentUser();
        });
    }

    if (userProfileBody) {
        userProfileBody.addEventListener('click', (event) => {
            const handleLink = event.target.closest('.user-stats-handle');
            if (!handleLink) return;
            const targetHandle = handleLink.dataset.handle;
            if (!targetHandle) return;
            event.preventDefault();
            openUserProfileModal(targetHandle).catch(() => {});
        });
    }

    if (activeRoomsSearchInput) {
        activeRoomsSearchInput.addEventListener('input', () => {
            renderFilteredActiveRooms();
        });
    }

    if (spectatorList) {
        spectatorList.addEventListener('click', (event) => {
            const chip = event.target.closest('.spectator-chip[data-handle]');
            if (!chip) return;
            const targetHandle = String(chip.dataset.handle || '').trim();
            if (!targetHandle) return;
            event.preventDefault();
            openUserProfileModal(targetHandle).catch(() => {});
        });

        spectatorList.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            const chip = event.target.closest('.spectator-chip[data-handle]');
            if (!chip) return;
            const targetHandle = String(chip.dataset.handle || '').trim();
            if (!targetHandle) return;
            event.preventDefault();
            openUserProfileModal(targetHandle).catch(() => {});
        });
    }

    // Create room
    createRoomBtn.addEventListener('click', async () => {
        await ensureNotificationPermission();

        if (!userHandle) {
            alert('Please login first');
            return;
        }

        if (!ws || ws.readyState !== WebSocket.OPEN) {
            alert('Connection not ready. Please wait a moment and try again.');
            return;
        }
        
        const roomName = roomNameInput.value.trim() || `${userHandle}'s Room`;
        const opponentHandle = opponentHandleInput.value.trim().toLowerCase();
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
            alert('Please login first');
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
        leaderboardTieOrder = Math.random() < 0.5 ? ['p1', 'p2'] : ['p2', 'p1'];
        player1Rating = null;
        player2Rating = null;
        currentRoom = null;
        isHost = false;
        roomData = null;
        clearSavedState();
        
        roomControls.style.display = 'flex';
        activeBlitzSection.style.display = 'block';
        
        roomInfoBar.style.display = 'none';
        if (spectatorPanel) {
            spectatorPanel.style.display = 'none';
        }
        spectatorPresenceMap = new Map();
        matchSpectatorHandles = new Set();
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
            // Force full page reload to ensure CSS is reloaded
            window.location.reload();
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
                validationStatusText.textContent = `Both participants verified. Match starts in ${remaining}s. Fetching first problem...`;
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
            if (window.CFUserInfo) {
                window.CFUserInfo.trackHandles([handle]);
                let info = window.CFUserInfo.getInfo(handle);
                let waited = 0;
                while ((!info || (info.titlePhoto === undefined && info.rating === null)) && waited < 2000) {
                    await new Promise(res => setTimeout(res, 100));
                    waited += 100;
                    info = window.CFUserInfo.getInfo(handle);
                }
                if (info) return { handle: info.handle || handle, avatar: info.titlePhoto || '' };
            }

            const response = await fetch(`https://codeforces.com/api/user.info?handles=${encodeURIComponent(handle)}`);
            const data = await response.json();
            if (data.status !== 'OK' || !Array.isArray(data.result) || !data.result[0]) return null;
            const user = data.result[0];
            return { handle: user.handle, avatar: user.titlePhoto || '' };
        } catch {
            return null;
        }
    }

    async function requestHandleVerificationChallenge(handle) {
        const cleanHandle = String(handle || '').trim();
        if (!cleanHandle) return null;

        try {
            const response = await fetch(`${API_BASE_URL}/api/session/challenge`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ handle: cleanHandle })
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) return null;
            if (!data?.challengeId || !data?.problem) return null;

            return {
                challengeId: String(data.challengeId || '').trim(),
                problem: data.problem
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
            if (window.CFUserInfo) {
                window.CFUserInfo.trackHandles([player1Handle, player2Handle].filter(Boolean));
                let waited = 0;
                let p1Info = window.CFUserInfo.getInfo(player1Handle);
                let p2Info = window.CFUserInfo.getInfo(player2Handle);
                while (waited < 2000 && ((p1Info == null || p1Info.rating === null) || (p2Info == null || p2Info.rating === null))) {
                    await new Promise(res => setTimeout(res, 100));
                    waited += 100;
                    p1Info = window.CFUserInfo.getInfo(player1Handle);
                    p2Info = window.CFUserInfo.getInfo(player2Handle);
                }

                if (p1Info && p1Info.rating !== null && p2Info && p2Info.rating !== null) {
                    const p1Rating = p1Info.rating || 0;
                    player1Rating = p1Rating;
                    const p1RankInfo = getRankFromRating(p1Rating);
                    player1Rank = p1RankInfo.name;
                    player1RankColor = p1RankInfo.color;

                    const p2Rating = p2Info.rating || 0;
                    player2Rating = p2Rating;
                    const p2RankInfo = getRankFromRating(p2Rating);
                    player2Rank = p2RankInfo.name;
                    player2RankColor = p2RankInfo.color;

                    updatePlayerUI();
                    return;
                }
            }

            const response = await fetch(`https://codeforces.com/api/user.info?handles=${player1Handle};${player2Handle}`);
            const data = await response.json();
            
            if (data.status === 'OK') {
                const users = data.result;
                
                const p1Rating = users[0].rating || 0;
                player1Rating = p1Rating;
                const p1RankInfo = getRankFromRating(p1Rating);
                player1Rank = p1RankInfo.name;
                player1RankColor = p1RankInfo.color;
                
                const p2Rating = users[1].rating || 0;
                player2Rating = p2Rating;
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
        window.updatePlayerUI = updatePlayerUI;
        if (p1HandleSpan) {
            p1HandleSpan.textContent = player1Handle;
            p1HandleSpan.href = '#';
            p1HandleSpan.className = `player-handle ${player1RankColor}`;
        }
        if (p1RankSpan) {
            p1RankSpan.textContent = player1Rank;
            p1RankSpan.className = `player-rank ${player1RankColor}`;
        }
        if (p2HandleSpan) {
            p2HandleSpan.textContent = player2Handle;
            p2HandleSpan.href = '#';
            p2HandleSpan.className = `player-handle ${player2RankColor}`;
        }
        if (p2RankSpan) {
            p2RankSpan.textContent = player2Rank;
            p2RankSpan.className = `player-rank ${player2RankColor}`;
        }
        if (p1ScoreSpan) p1ScoreSpan.textContent = player1Score;
        if (p2ScoreSpan) p2ScoreSpan.textContent = player2Score;
        renderLeaderboard();
    }

    function getOrderedLeaderboardPlayers() {
        const players = [
            {
                id: 'p1',
                handle: player1Handle,
                rank: player1Rank,
                rankColor: player1RankColor,
                rating: Number.isFinite(Number(player1Rating)) ? Number(player1Rating) : null,
                score: Number(player1Score) || 0,
                results: problemResults.p1 || []
            },
            {
                id: 'p2',
                handle: player2Handle,
                rank: player2Rank,
                rankColor: player2RankColor,
                rating: Number.isFinite(Number(player2Rating)) ? Number(player2Rating) : null,
                score: Number(player2Score) || 0,
                results: problemResults.p2 || []
            }
        ];

        players.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            const aKnown = Number.isFinite(a.rating);
            const bKnown = Number.isFinite(b.rating);
            if (aKnown && bKnown && a.rating !== b.rating) {
                return a.rating - b.rating;
            }
            if (aKnown !== bKnown) {
                return aKnown ? -1 : 1;
            }
            return leaderboardTieOrder.indexOf(a.id) - leaderboardTieOrder.indexOf(b.id);
        });

        // If both players have the same score, set both ranks to 1
        if (players.length === 2 && players[0].score === players[1].score) {
            players[0].rank = '1';
            players[1].rank = '1';
        } else {
            // Otherwise, assign ranks based on position
            players.forEach((p, idx) => { p.rank = String(idx + 1); });
        }
        return players;
    }

    function renderLeaderboardRow(player, standingPosition) {
        let row = `<tr data-player-id="${player.id}">`;
        row += `<td><span class="${player.rankColor}"><strong>${player.handle}</strong></span><div class="leaderboard-cf-rank ${player.rankColor}">${player.rank}</div></td>`;
        row += `<td><span class="leaderboard-standing">#${standingPosition}</span></td>`;
        row += `<td><strong style="color: #ffd966;">${player.score}</strong></td>`;

        problems.forEach((_, index) => {
            const result = normalizeProblemResultEntry(player.results[index] || createEmptyProblemResult());
            if (result.solved) {
                const acLabel = result.attempts > 0 ? `+${result.attempts}` : '+';
                const solveTimeHtml = Number.isFinite(result.solvedAtSec)
                    ? `<div class="problem-cell-sub">${formatTime(result.solvedAtSec)}</div>`
                    : '';
                row += `<td class="problem-cell status-ac"><div class="problem-cell-main">${acLabel}</div>${solveTimeHtml}</td>`;
            } else if (result.pending) {
                row += `<td class="problem-cell status-pending"><div class="problem-cell-main pending-main">?<span class="pending-loader" aria-hidden="true"></span></div></td>`;
            } else if (result.attempts > 0) {
                row += `<td class="problem-cell status-wa"><div class="problem-cell-main">-${result.attempts}</div></td>`;
            } else {
                row += `<td class="problem-cell status-none"><div class="problem-cell-main">—</div></td>`;
            }
        });

        row += '</tr>';
        return row;
    }

    function animateLeaderboardReorder(previousTopById) {
        const rows = Array.from(leaderboardBody.querySelectorAll('tr[data-player-id]'));
        rows.forEach(row => {
            const playerId = row.dataset.playerId;
            if (!playerId || !previousTopById.has(playerId)) return;

            const oldTop = previousTopById.get(playerId);
            const newTop = row.getBoundingClientRect().top;
            const deltaY = oldTop - newTop;
            if (Math.abs(deltaY) < 1) return;

            row.style.transition = 'none';
            row.style.transform = `translateY(${deltaY}px)`;

            requestAnimationFrame(() => {
                row.style.transition = 'transform 240ms ease';
                row.style.transform = 'translateY(0)';

                const cleanup = () => {
                    row.style.transition = '';
                    row.style.transform = '';
                    row.removeEventListener('transitionend', cleanup);
                };

                row.addEventListener('transitionend', cleanup);
            });
        });
    }

    function renderLeaderboard() {
        let headerHtml = '<tr><th>Player</th><th>Rank</th><th>Total</th>';
        problems.forEach((prob, index) => {
            headerHtml += `<th>P${index + 1}<br><small>${prob.points}pts</small></th>`;
        });
        headerHtml += '</tr>';
        leaderboardHeader.innerHTML = headerHtml;

        const previousTopById = new Map();
        Array.from(leaderboardBody.querySelectorAll('tr[data-player-id]')).forEach(row => {
            const playerId = row.dataset.playerId;
            if (!playerId) return;
            previousTopById.set(playerId, row.getBoundingClientRect().top);
        });

        const rows = getOrderedLeaderboardPlayers().map((player, index) => renderLeaderboardRow(player, index + 1));
        leaderboardBody.innerHTML = rows.join('');

        if (previousTopById.size > 0) {
            animateLeaderboardReorder(previousTopById);
        }
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
            }, 60000);
        } catch (error) {
            console.warn('Service worker notification path failed:', error);
        }
    }

    function shouldSkipDuplicateNotification(title, message) {
        const now = Date.now();
        const normalizedTitle = String(title || '').trim().toLowerCase();
        const normalizedMessage = String(message || '').trim().toLowerCase();
        const key = `${normalizedTitle}::${normalizedMessage}`;
        const previous = Number(recentNotificationEvents.get(key)) || 0;

        for (const [eventKey, timestamp] of recentNotificationEvents.entries()) {
            if (now - Number(timestamp) > NOTIFICATION_DEDUPE_WINDOW_MS) {
                recentNotificationEvents.delete(eventKey);
            }
        }

        if (previous > 0 && (now - previous) <= NOTIFICATION_DEDUPE_WINDOW_MS) {
            return true;
        }

        recentNotificationEvents.set(key, now);
        return false;
    }

    function showDesktopNotification(title, message, isWinner = false, allowOSNotification = false) {
        if (shouldSkipDuplicateNotification(title, message)) {
            return;
        }

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

    function buildResultsRedirectUrl() {
        const roomId = String(currentRoom || '').trim().toUpperCase();
        if (!roomId) return 'results.html';
        return `results.html?roomId=${encodeURIComponent(roomId)}`;
    }

    function redirectToResultsPage() {
        window.location.href = buildResultsRedirectUrl();
    }

    function scheduleResultsRedirect(delayMs = 15000) {
        if (celebrationRedirectTimer) {
            clearTimeout(celebrationRedirectTimer);
            celebrationRedirectTimer = null;
        }

        celebrationRedirectTimer = setTimeout(() => {
            if (celebrationModal) {
                celebrationModal.style.display = 'none';
            }
            redirectToResultsPage();
        }, Math.max(0, Number(delayMs) || 0));
    }

    function updateTimerDisplay() {
        window.updateTimerDisplay = updateTimerDisplay;
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
        console.log('[startBattleTimer] called', {
            battleActive,
            battleEndsAt,
            timeLeftSec
        });
        timerInterval = setInterval(() => {
            if (!battleActive) {
                clearInterval(timerInterval);
                return;
            }
            if (battleEndsAt) {
                const now = getSyncedNow();
                const newTimeLeft = Math.max(0, Math.floor((battleEndsAt - now) / 1000));
                if (newTimeLeft !== timeLeftSec) {
                    console.log('[timer tick]', { newTimeLeft, timeLeftSec, battleEndsAt, now });
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
            hasJudgedFail: false,
            judgedFailCount: 0,
            earliestPendingMs: null
        };

        if (!submissionData || submissionData.status !== 'OK' || !Array.isArray(submissionData.result) || !problem) {
            return analysis;
        }

        const relevantSubs = [];
        for (const sub of submissionData.result) {
            if (!sub.problem) continue;
            const isSameProblem = sub.problem.contestId === problem.contestId && sub.problem.index === problem.index;
            if (!isSameProblem) continue;

            const submitMs = (sub.creationTimeSeconds || 0) * 1000;
            if (deadlineMs && submitMs && submitMs > deadlineMs) continue;
            if (minMs && submitMs && submitMs < minMs) continue;

            relevantSubs.push({
                submitMs,
                submissionId: sub.id,
                verdict: sub.verdict
            });
        }

        for (const sub of relevantSubs) {
            if (sub.verdict === 'OK') {
                if (!analysis.accepted || sub.submitMs < analysis.accepted.submitMs) {
                    analysis.accepted = { submitMs: sub.submitMs, submissionId: sub.submissionId };
                }
            }
        }

        const acceptedMs = analysis.accepted?.submitMs || null;
        let failCount = 0;
        let hasPending = false;

        for (const sub of relevantSubs) {
            if (acceptedMs && sub.submitMs >= acceptedMs) {
                continue;
            }

            if (sub.verdict === 'OK') {
                continue;
            }

            if (isPendingVerdict(sub.verdict)) {
                hasPending = true;
                if (!analysis.earliestPendingMs || (sub.submitMs && sub.submitMs < analysis.earliestPendingMs)) {
                    analysis.earliestPendingMs = sub.submitMs || analysis.earliestPendingMs;
                }
            } else {
                failCount += 1;
            }
        }

        analysis.judgedFailCount = failCount;
        analysis.hasJudgedFail = failCount > 0;
        analysis.hasPending = hasPending;

        return analysis;
    }

    function getSubmissionWindowStartMs() {
        return currentProblemOpenedAt || battleStartTime || 0;
    }

    function hasAnyPendingOnCurrentProblem() {
        const index = Math.max(0, Number(currentProblemIndex || 0) - 1);
        const p1 = normalizeProblemResultEntry(problemResults?.p1?.[index] || createEmptyProblemResult());
        const p2 = normalizeProblemResultEntry(problemResults?.p2?.[index] || createEmptyProblemResult());
        return !!p1.pending || !!p2.pending;
    }

    function hasBlockingPendingForWinnerDecision(p1Analysis, p2Analysis) {
        const acceptedMs = [p1Analysis?.accepted?.submitMs, p2Analysis?.accepted?.submitMs]
            .map(value => Number(value) || 0)
            .filter(value => value > 0)
            .sort((a, b) => a - b)[0] || 0;

        if (!acceptedMs) {
            return !!p1Analysis?.hasPending || !!p2Analysis?.hasPending;
        }

        return false;
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
            let checked = false;
            let noAcceptedOrPending = false;
            while (battleActive && !breakActive && !problemLocked && currentProblem) {
                checked = true;
                const [p1Response, p2Response] = await Promise.all([
                    fetch(`https://codeforces.com/api/user.status?handle=${player1Handle}&from=1&count=100`),
                    fetch(`https://codeforces.com/api/user.status?handle=${player2Handle}&from=1&count=100`)
                ]);

                const p1Data = await p1Response.json();
                const p2Data = await p2Response.json();

                const windowStartMs = getSubmissionWindowStartMs();
                const p1Analysis = analyzeSubmissionsForProblem(p1Data, currentProblem, deadlineMs, windowStartMs);
                const p2Analysis = analyzeSubmissionsForProblem(p2Data, currentProblem, deadlineMs, windowStartMs);
                const hasBlockingPending = hasBlockingPendingForWinnerDecision(p1Analysis, p2Analysis);
                const hasAnyAccepted = !!p1Analysis.accepted || !!p2Analysis.accepted;

                const p1Accepted = p1Analysis.accepted;
                const p2Accepted = p2Analysis.accepted;

                if (hasBlockingPending) {
                    lockStatusDiv.textContent = `⏳ Problem ${currentProblemIndex}/${problems.length} · queued verdict pending`;
                    lockStatusDiv.className = 'problem-lock-status';
                    reportPendingSubmissionStatus(true);
                    updatePlayerUI();
                    return;
                }

                reportPendingSubmissionStatus(false);

                if (p1Accepted || p2Accepted) {
                    if (!p2Accepted || (p1Accepted && p1Accepted.submitMs <= p2Accepted.submitMs)) {
                        handleSolve('p1', p1Accepted?.submitMs || null);
                    } else {
                        handleSolve('p2', p2Accepted?.submitMs || null);
                    }
                } else {
                    // No accepted submissions and no blocking pending, so end match
                    noAcceptedOrPending = true;
                }

                updatePlayerUI();
                if (noAcceptedOrPending) {
                    matchStatusText.textContent = '⏱️ Match timer ended. No submissions. Match ended as tie.';
                    stopBattle(true);
                    return;
                }
            }
            // If we never entered the loop (problemLocked, no currentProblem, etc), or after loop, ensure match ends
            if (!problemLocked && (!currentProblem || !hasAnyPendingOnCurrentProblem())) {
                matchStatusText.textContent = '⏱️ Match timer ended. No submissions. Match ended as tie.';
                stopBattle(true);
            }
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

        if (p1Row && p1Row.classList) p1Row.classList.remove('solved');
        if (p2Row && p2Row.classList) p2Row.classList.remove('solved');

        if (!queuedNextProblem) {
            queuedNextProblem = selectedProblems[currentProblemIndex] || null;
        }

        const prob = queuedNextProblem;
        if (!prob) {
            currentProblem = null;
            currentProblemOpenedAt = null;
            problemLocked = false;
            lockStatusDiv.textContent = `⏳ Fetching Problem ${currentProblemIndex + 1}/${problems.length}...`;
            lockStatusDiv.className = 'problem-lock-status';
            return;
        }


        // Show notification for new problem
        if (window.Notification && Notification.permission === 'granted') {
            new Notification('🆕 New Problem', {
                body: `${prob.name} (Rating: ${prob.rating})`,
                silent: true
            });
        } else if (typeof showDesktopNotification === 'function') {
            showDesktopNotification('🆕 New Problem', `${prob.name} (Rating: ${prob.rating})`, false, true);
        }

        queuedNextProblem = null;
        currentProblem = prob;
        currentProblemOpenedAt = Date.now();
        currentProblemIndex++;

        const problemPoints = selectedProblems[currentProblemIndex - 1]?.points || 500;

        // Show battle panel
        if (arenaPanel) arenaPanel.style.display = 'flex';

        probNameSpan.textContent = prob.name;
        probPointsSpan.textContent = problemPoints;
        probRatingSpan.textContent = `Rating: ${prob.rating}`;

        problemUrl.href = prob.url;
        problemUrl.style.pointerEvents = 'auto';
        problemUrl.style.opacity = '1';

        lockStatusDiv.textContent = `🔓 Problem ${currentProblemIndex}/${problems.length} · waiting for AC`;
        lockStatusDiv.className = 'problem-lock-status';

        problemLocked = false;
        // Always update problem details UI
        if (typeof updateCurrentProblemDetailsUI === 'function') updateCurrentProblemDetailsUI();
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

            const problemIndex = currentProblemIndex - 1;
            const p1Result = getProblemResultFor('p1', problemIndex);
            const p2Result = getProblemResultFor('p2', problemIndex);

            const windowStartMs = getSubmissionWindowStartMs();
            const p1Analysis = analyzeSubmissionsForProblem(p1Data, currentProblem, null, windowStartMs);
            const p2Analysis = analyzeSubmissionsForProblem(p2Data, currentProblem, null, windowStartMs);
            const hasBlockingPending = hasBlockingPendingForWinnerDecision(p1Analysis, p2Analysis);
            const hasAnyAccepted = !!p1Analysis.accepted || !!p2Analysis.accepted;

            if (!p1Result.solved) {
                p1Result.pending = hasAnyAccepted ? false : !!p1Analysis.hasPending;
                p1Result.attempts = Math.max(0, Number(p1Analysis.judgedFailCount) || 0);
            }

            if (!p2Result.solved) {
                p2Result.pending = hasAnyAccepted ? false : !!p2Analysis.hasPending;
                p2Result.attempts = Math.max(0, Number(p2Analysis.judgedFailCount) || 0);
            }

            const p1Accepted = p1Analysis.accepted;
            const p2Accepted = p2Analysis.accepted;

            if (hasBlockingPending) {
                lockStatusDiv.textContent = `⏳ Problem ${currentProblemIndex}/${problems.length} · queued verdict pending`;
                lockStatusDiv.className = 'problem-lock-status';
                reportPendingSubmissionStatus(true);
                updatePlayerUI();
                return;
            }

            reportPendingSubmissionStatus(false);

            if (p1Accepted || p2Accepted) {
                if (!p2Accepted || (p1Accepted && p1Accepted.submitMs <= p2Accepted.submitMs)) {
                    handleSolve('p1', p1Accepted?.submitMs || null);
                } else {
                    handleSolve('p2', p2Accepted?.submitMs || null);
                }
            }

            updatePlayerUI();
            
        } catch (error) {
            console.error('Error checking submissions:', error);
        }
    }

    function handleSolve(player, solveSubmitMs = null) {
        if (problemLocked || !battleActive) return;
        
        problemLocked = true;
        const problemPoints = problems[currentProblemIndex - 1]?.points || selectedProblems[currentProblemIndex - 1]?.points || 500;
        
        const solvedAtSec = Number.isFinite(Number(solveSubmitMs)) && Number.isFinite(Number(battleStartTime))
            ? Math.max(0, Math.floor((Number(solveSubmitMs) - Number(battleStartTime)) / 1000))
            : (Number.isFinite(Number(getSyncedNow())) && Number.isFinite(Number(battleStartTime))
                ? Math.max(0, Math.floor((Number(getSyncedNow()) - Number(battleStartTime)) / 1000))
                : null);

        if (player === 'p1') {
            player1Score += problemPoints;
            const p1Result = getProblemResultFor('p1', currentProblemIndex - 1);
            p1Result.solved = true;
            p1Result.pending = false;
            if (Number.isFinite(Number(solvedAtSec))) {
                p1Result.solvedAtSec = solvedAtSec;
            }
            if (p1Row) {
                p1Row.classList.add('solved');
            }
            if (currentProblem) {
                p1SolvedProblems.add(currentProblem.id);
            }
        } else {
            player2Score += problemPoints;
            const p2Result = getProblemResultFor('p2', currentProblemIndex - 1);
            p2Result.solved = true;
            p2Result.pending = false;
            if (Number.isFinite(Number(solvedAtSec))) {
                p2Result.solvedAtSec = solvedAtSec;
            }
            if (p2Row) {
                p2Row.classList.add('solved');
            }
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
        // Ensure break timer updates instantly
        startBattleTimer();
    }

    function endBreak() {
        window.endBreak = endBreak;
        breakActive = false;
        breakStartTime = null;
        breakTimerDiv.style.display = 'none';
        breakIndicator.style.display = 'none';
        saveBattleRuntimeState();
        
        if (battleActive && currentProblemIndex < problems.length) {
            // Ensure queuedNextProblem is set from selectedProblems if not already set
            if (!queuedNextProblem) {
                console.log('[endBreak] queuedNextProblem was empty, setting from selectedProblems', {
                    currentProblemIndex,
                    selectedProblem: selectedProblems[currentProblemIndex]
                });
                queuedNextProblem = selectedProblems[currentProblemIndex] || null;
            } else {
                console.log('[endBreak] queuedNextProblem already set', { queuedNextProblem });
            }
            loadNextProblem().then(() => {
                console.log('[endBreak] loadNextProblem finished', {
                    currentProblem,
                    currentProblemIndex,
                    queuedNextProblem
                });
                if (battleActive && !breakActive && currentProblem) {
                    apiCheckInterval = setInterval(checkSubmissions, checkIntervalSec * 1000);
                }
            });
        }
    }

    async function submitBattleResult(winner) {
        if (resultSubmitted || !matchKey) return;

        const spectators = Array.from(matchSpectatorHandles)
            .map(handle => String(handle || '').trim())
            .filter(Boolean)
            .sort((a, b) => a.localeCompare(b));

        const payload = {
            matchKey,
            roomId: currentRoom,
            date: new Date().toISOString(),
            duration: Math.round(totalDurationSec / 60),
            winner,
            spectators,
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
                p1Result: normalizeProblemResultEntry(problemResults.p1[idx] || createEmptyProblemResult()),
                p2Result: normalizeProblemResultEntry(problemResults.p2[idx] || createEmptyProblemResult())
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
        window.stopBattle = stopBattle;
        window.handleSolve = handleSolve;
        if (!battleActive && resultSubmitted) return;

        if (celebrationRedirectTimer) {
            clearTimeout(celebrationRedirectTimer);
            celebrationRedirectTimer = null;
        }

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
        if (spectatorPanel) {
            spectatorPanel.style.display = 'none';
        }
        spectatorPresenceMap = new Map();
        breakStartTime = null;
        clearBattleRuntimeState();
        
        let winner = '';
        if (player1Score > player2Score) {
            winner = player1Handle;
        } else if (player2Score > player1Score) {
            winner = player2Handle;
        } else if (player1Handle && player2Handle) {
            winner = 'tie';
        } else {
            winner = '';
        }

        if (!matchEndNotificationShown) {
            let winnerText = '';
            if (winner === 'tie') {
                winnerText = 'Match ended in a tie. Check Results page.';
            } else if (winner) {
                winnerText = `Winner: ${winner}. Check Results page.`;
            } else {
                winnerText = 'Match ended. Check Results page.';
            }
            showDesktopNotification('🏁 Match Ended', winnerText, true, true);
            matchEndNotificationShown = true;
        }

        if (persistResult) {
            await submitBattleResult(winner);
        }

        matchSpectatorHandles = new Set();

        const finalScoreText = `${player1Handle}: ${player1Score} · ${player2Handle}: ${player2Score}`;
        let resultText = '';
        if (winner === 'tie') {
            resultText = 'Tie';
        } else if (winner) {
            resultText = `Winner: ${winner}`;
        } else {
            resultText = 'Match ended';
        }
        matchStatusText.textContent = `✅ Blitz ended · ${resultText} · ${finalScoreText}`;

        // Always show celebration card, even if no winner/tie (no submissions)
        if (winner === 'tie' || (winner && winner !== '') || winner === '') {
            winnerHandleSpan.textContent = (winner === 'tie') ? 'Tie' : (winner ? winner : 'No Winner');
            celebrationModal.style.display = 'flex';
            if (closeCelebrationBtn) {
                closeCelebrationBtn.textContent = 'Close';
            }
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

        if (persistResult) {
            scheduleResultsRedirect(15000);
        }
    }

    cancelGameBtn.addEventListener('click', () => {
        if (!battleActive) {
            alert('No active game to cancel');
            return;
        }

        if (!isAdminHandle(userHandle)) {
            alert('Only admin can cancel game.');
            return;
        }

        passwordModal.style.display = 'flex';
        passwordInput.value = '';
        passwordInput.focus();
    });

    confirmCancel.addEventListener('click', async () => {
        const enteredPassword = passwordInput.value;

        if (!enteredPassword) {
            alert('Please enter admin PIN');
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
                alert('Incorrect admin PIN!');
                passwordInput.value = '';
                passwordInput.focus();
                return;
            }

            passwordModal.style.display = 'none';
            if (ws && ws.readyState === WebSocket.OPEN && currentRoom) {
                ws.send(JSON.stringify({
                    type: 'CANCEL_ROOM',
                    roomId: currentRoom,
                    handle: userHandle,
                    adminPassword: enteredPassword
                }));
            }
            stopBattle(false, true); // Ensure match is fully ended and UI updates
            showDesktopNotification('⛔ Game Cancelled', 'Game cancelled by administrator', true);
        } catch (error) {
            console.error('Admin verification failed:', error);
            alert('Could not verify admin PIN right now');
        }
    });

    cancelPassword.addEventListener('click', () => {
        passwordModal.style.display = 'none';
    });

    closeCelebrationBtn.addEventListener('click', () => {
        celebrationModal.style.display = 'none';
        if (celebrationRedirectTimer) {
            clearTimeout(celebrationRedirectTimer);
            celebrationRedirectTimer = null;
        }
        redirectToResultsPage();
    });

    window.addEventListener('click', (e) => {
        if (e.target === passwordModal) {
            passwordModal.style.display = 'none';
        }
        if (e.target === handleSetupModal) {
            closeHandleSetupModal();
        }
        if (e.target === userProfileModal) {
            userProfileModal.style.display = 'none';
        }
    });

    function hasDirectLoginIntent() {
        const params = new URLSearchParams(window.location.search || '');
        const loginFlag = String(params.get('login') || '').toLowerCase();
        const hash = String(window.location.hash || '').replace('#', '').toLowerCase();
        return loginFlag === '1' || loginFlag === 'true' || hash === 'login';
    }

    function getPostLoginReturnTarget() {
        const params = new URLSearchParams(window.location.search || '');
        const raw = String(params.get('returnTo') || '').trim();
        if (!raw) return '';

        try {
            const decoded = decodeURIComponent(raw);
            if (!decoded.startsWith('/')) return '';
            if (decoded.startsWith('//')) return '';
            if (decoded.startsWith('/index.html') || decoded === '/') return '';
            return decoded;
        } catch {
            return '';
        }
    }

    function clearDirectLoginIntentFromUrl() {
        const url = new URL(window.location.href);
        if (url.searchParams.has('login')) {
            url.searchParams.delete('login');
        }
        if (url.hash === '#login') {
            url.hash = '';
        }
        window.history.replaceState({}, '', url.toString());
    }

    async function init() {
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
        await syncAuthFromServerSession();

        pendingPostLoginReturnTo = getPostLoginReturnTarget();

        if (!userHandle && hasDirectLoginIntent()) {
            openHandleSetupModal();
            clearDirectLoginIntentFromUrl();
        }

        bindArenaPlayerProfileLinks();
        // Decorate any static CF profile links on the page to use CFUserInfo rendering
        function decorateStaticProfileLinks() {
            try {
                const anchors = Array.from(document.querySelectorAll('a[href^="https://codeforces.com/profile/"]'));
                anchors.forEach(a => {
                    try {
                        const href = a.getAttribute('href') || '';
                        const m = href.match(/https?:\/\/codeforces.com\/profile\/(.+)$/i);
                        if (!m) return;
                        let orig = m[1] || '';
                        try { orig = decodeURIComponent(orig); } catch {}
                        a.setAttribute('data-handle', orig);
                        a.classList.add('player-handle-link');
                        if (window.CFUserInfo) {
                            window.CFUserInfo.trackHandles([orig]);
                            const info = window.CFUserInfo.getInfo(orig) || {};
                            const display = info.handle || orig;
                            a.innerHTML = window.CFUserInfo.renderHandleHtml(display);
                            a.href = `https://codeforces.com/profile/${encodeURIComponent(display)}`;
                            a.setAttribute('target', '_blank');
                            a.setAttribute('rel', 'noopener noreferrer');
                        }
                    } catch (e) {
                        // ignore
                    }
                });
            } catch (e) {}
        }
        decorateStaticProfileLinks();

        // If CFUserInfo provides subscribe, refresh static links when info arrives
        if (window.CFUserInfo && typeof window.CFUserInfo.subscribe === 'function') {
            window.CFUserInfo.subscribe(() => {
                decorateStaticProfileLinks();
            });
        }
        connectWebSocket();
    }

    init().catch(() => {});
})();
