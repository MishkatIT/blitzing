(function () {
    const HANDLE_STORAGE_KEY = 'blitzUserHandle';
    const AVATAR_STORAGE_KEY = 'blitzUserAvatar';
    const AUTH_META_KEY = 'blitzAuthMeta';
    const AUTH_DEPLOY_TOKEN = 'v2.1';
    const AUTH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
    const PRESENCE_PING_INTERVAL_MS = 30000;
    const API_BASE_URL = window.location.origin;
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

    let pingTimer = null;
    let pingInFlight = false;
    let globalProfileModal = null;
    let globalProfileBody = null;
    let globalProfileLogoutBtn = null;

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
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

    function isAuthSessionValid() {
        const meta = readAuthMeta();
        if (!meta) return false;
        if (meta.deployToken !== AUTH_DEPLOY_TOKEN) return false;
        return (Date.now() - meta.issuedAt) <= AUTH_MAX_AGE_MS;
    }

    function clearAuthSessionStorage() {
        storageRemoveItem(HANDLE_STORAGE_KEY);
        storageRemoveItem(AVATAR_STORAGE_KEY);
        storageRemoveItem('blitzRoomState');
        storageRemoveItem('blitzBattleRuntimeState');
        storageRemoveItem('blitzPendingJoinRoomId');
        storageRemoveItem(AUTH_META_KEY);
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

    async function syncAuthFromServerSession() {
        try {
            const response = await fetch(`${API_BASE_URL}/api/session/me`, {
                method: 'GET',
                credentials: 'same-origin'
            });
            if (!response.ok) return;

            const data = await response.json();
            if (!data || !data.authenticated || !data.handle) {
                if (String(storageGetItem(HANDLE_STORAGE_KEY) || '').trim()) {
                    clearAuthSessionStorage();
                }
                return;
            }

            const serverHandle = String(data.handle || '').trim();
            if (!serverHandle) return;

            const localHandle = String(storageGetItem(HANDLE_STORAGE_KEY) || '').trim();
            if (!localHandle || localHandle.toLowerCase() !== serverHandle.toLowerCase()) {
                storageSetItem(HANDLE_STORAGE_KEY, serverHandle);
            }

            storageSetItem(AUTH_META_KEY, JSON.stringify({
                issuedAt: Date.now(),
                deployToken: AUTH_DEPLOY_TOKEN
            }));
        } catch {
        }
    }

    function enforceAuthPolicy() {
        const handle = String(storageGetItem(HANDLE_STORAGE_KEY) || '').trim();
        if (!handle) return;
        if (!isAuthSessionValid()) {
            clearAuthSessionStorage();
        }
    }

    function renderGlobalHandleChip() {
        const chips = document.querySelectorAll('[data-global-handle-chip]');
        enforceAuthPolicy();
        const handle = String(storageGetItem(HANDLE_STORAGE_KEY) || '').trim();
        const avatar = String(storageGetItem(AVATAR_STORAGE_KEY) || '').trim();

        if (!chips.length) return;

        chips.forEach((chip) => {
            if (!handle) {
                chip.classList.add('not-verified');
                chip.textContent = 'Login';
                const currentPath = `${window.location.pathname || ''}${window.location.search || ''}${window.location.hash || ''}`;
                const returnTo = encodeURIComponent(currentPath || '/');
                chip.setAttribute('href', `index.html?login=1&returnTo=${returnTo}`);
                chip.removeAttribute('target');
                chip.removeAttribute('rel');
                chip.setAttribute('title', 'Login in Arena');
                return;
            }

            const avatarHtml = avatar
                ? `<img src="${escapeHtml(avatar)}" alt="${escapeHtml(handle)}" class="global-handle-avatar">`
                : '';

            chip.classList.remove('not-verified');
            chip.innerHTML = `${avatarHtml}<span>${escapeHtml(handle)}</span>`;
            chip.setAttribute('href', '#');
            chip.dataset.handle = handle;
            chip.setAttribute('target', '_self');
            chip.setAttribute('title', 'Open profile card');
        });
    }

    function normalizeHandle(handle) {
        return String(handle || '').trim().toLowerCase();
    }

    function getRankFromRating(rating) {
        const value = Number(rating) || 0;
        if (value < 1200) return { name: 'Newbie', color: '#8a8f99' };
        if (value < 1400) return { name: 'Pupil', color: '#74ca77' };
        if (value < 1600) return { name: 'Specialist', color: '#4bc7b8' };
        if (value < 1900) return { name: 'Expert', color: '#6ea8fe' };
        if (value < 2100) return { name: 'Candidate Master', color: '#c67bf3' };
        if (value < 2400) return { name: 'Master', color: '#ffb86a' };
        return { name: 'Grandmaster', color: '#ff7d7d' };
    }

    function formatLastSeen(lastSeenTs) {
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

    async function fetchUserProfileDetails(handle) {
        // Prefer centralized CFUserInfo if available
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

    async function fetchSiteUserStats(handle) {
        try {
            const response = await fetch(`${API_BASE_URL}/api/results`);
            const data = await response.json();
            return buildSiteUserStats(data, handle);
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

    function buildSiteUserStats(results, targetHandle) {
        const targetNorm = normalizeHandle(targetHandle);
        let played = 0;
        let wins = 0;
        let losses = 0;
        let ties = 0;
        let scoreSum = 0;
        const opponentMap = new Map();

        const recent = [];
        for (const match of Array.isArray(results) ? results : []) {
            const p1 = String(match?.player1?.handle || '');
            const p2 = String(match?.player2?.handle || '');
            const p1Norm = normalizeHandle(p1);
            const p2Norm = normalizeHandle(p2);
            if (p1Norm !== targetNorm && p2Norm !== targetNorm) continue;

            played += 1;
            const winnerNorm = normalizeHandle(match?.winner);
            if (winnerNorm === 'tie') ties += 1;
            else if (winnerNorm === targetNorm) wins += 1;
            else losses += 1;

            const ownScore = p1Norm === targetNorm
                ? Number(match?.player1?.score) || 0
                : Number(match?.player2?.score) || 0;
            const oppScore = p1Norm === targetNorm
                ? Number(match?.player2?.score) || 0
                : Number(match?.player1?.score) || 0;
            scoreSum += ownScore;

            const opponent = p1Norm === targetNorm ? p2 : p1;
            if (opponent) {
                opponentMap.set(opponent, (opponentMap.get(opponent) || 0) + 1);
            }

            recent.push({
                roomId: String(match?.roomId || ''),
                date: String(match?.date || ''),
                opponent,
                ownScore,
                oppScore,
                outcome: winnerNorm === 'tie' ? 'T' : winnerNorm === targetNorm ? 'W' : 'L'
            });
        }

        const opponents = Array.from(opponentMap.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([handle, count]) => ({ handle, count }));

        const recentMatches = recent
            .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
            .slice(0, 5);

        let streak = '-';
        if (recentMatches.length) {
            const latest = recentMatches[0].outcome;
            let count = 0;
            for (const item of recentMatches) {
                if (item.outcome !== latest) break;
                count += 1;
            }
            streak = `${latest}${count}`;
        }

        return {
            played,
            wins,
            losses,
            ties,
            winRate: played > 0 ? ((wins / played) * 100).toFixed(1) : '0.0',
            avgScore: played > 0 ? (scoreSum / played).toFixed(1) : '0.0',
            totalScore: scoreSum,
            streak,
            opponents,
            recentMatches
        };
    }

    function ensureGlobalProfileModal() {
        if (globalProfileModal && globalProfileBody) return;

        const existingModal = document.getElementById('userProfileModal');
        const existingBody = document.getElementById('userProfileBody');
        const existingCloseBtn = document.getElementById('closeUserProfileModal');
        const existingLogoutBtn = document.getElementById('userProfileLogoutBtn');

        if (existingModal && existingBody) {
            globalProfileModal = existingModal;
            globalProfileBody = existingBody;
            globalProfileLogoutBtn = existingLogoutBtn || null;

            if (!globalProfileModal.dataset.globalProfileBound) {
                if (existingCloseBtn) {
                    existingCloseBtn.addEventListener('click', () => {
                        globalProfileModal.style.display = 'none';
                    });
                }

                if (globalProfileLogoutBtn) {
                    globalProfileLogoutBtn.addEventListener('click', () => {
                        if (!window.confirm('Are you sure you want to logout?')) {
                            return;
                        }
                        logoutServerSession().catch(() => {});
                        clearAuthSessionStorage();
                        globalProfileModal.style.display = 'none';
                        renderGlobalHandleChip();
                        startPresenceHeartbeat();
                    });
                }

                globalProfileModal.addEventListener('click', (event) => {
                    if (event.target === globalProfileModal) {
                        globalProfileModal.style.display = 'none';
                    }
                });

                globalProfileModal.dataset.globalProfileBound = '1';
            }
            return;
        }

        globalProfileModal = document.createElement('div');
        globalProfileModal.className = 'global-profile-modal';
        globalProfileModal.innerHTML = `
            <div class="global-profile-modal-content">
                <h2>User Profile</h2>
                <div class="global-profile-modal-body">Loading profile...</div>
                <div class="global-profile-modal-actions">
                    <button type="button" class="global-profile-modal-logout" data-global-logout="1">Logout</button>
                    <button type="button" class="global-profile-modal-close">Close</button>
                </div>
            </div>
        `;

        document.body.appendChild(globalProfileModal);
        globalProfileBody = globalProfileModal.querySelector('.global-profile-modal-body');
        const closeBtn = globalProfileModal.querySelector('.global-profile-modal-close');
    const logoutBtn = globalProfileModal.querySelector('[data-global-logout]');
    globalProfileLogoutBtn = logoutBtn;

        closeBtn.addEventListener('click', () => {
            globalProfileModal.style.display = 'none';
        });

        logoutBtn.addEventListener('click', () => {
            if (!window.confirm('Are you sure you want to logout?')) {
                return;
            }
            logoutServerSession().catch(() => {});
            clearAuthSessionStorage();
            globalProfileModal.style.display = 'none';
            renderGlobalHandleChip();
            startPresenceHeartbeat();
        });

        globalProfileModal.addEventListener('click', (event) => {
            if (event.target === globalProfileModal) {
                globalProfileModal.style.display = 'none';
            }
        });
    }

    async function openGlobalProfileModal(handle) {
        const cleanHandle = String(handle || '').trim();
        if (!cleanHandle) return;

        ensureGlobalProfileModal();
        globalProfileModal.style.display = 'flex';
        globalProfileBody.textContent = 'Loading profile...';
        const authenticatedHandle = String(storageGetItem(HANDLE_STORAGE_KEY) || '').trim();
        const canLogout = !!normalizeHandle(authenticatedHandle)
            && normalizeHandle(authenticatedHandle) === normalizeHandle(cleanHandle);
        if (globalProfileLogoutBtn) {
            globalProfileLogoutBtn.style.display = canLogout ? 'inline-flex' : 'none';
        }

        try {
            const [profile, stats, presence] = await Promise.all([
                fetchUserProfileDetails(cleanHandle),
                fetchSiteUserStats(cleanHandle),
                fetchSitePresence(cleanHandle)
            ]);

            if (!profile) {
                globalProfileBody.textContent = 'Could not load profile right now.';
                return;
            }

            const handle = String(profile.handle || cleanHandle);
            const rank = profile.rank || 'Unrated';
            const maxRank = profile.maxRank || 'Unrated';
            const rating = Number.isFinite(Number(profile.rating)) ? profile.rating : '—';
            const maxRating = Number.isFinite(Number(profile.maxRating)) ? profile.maxRating : '—';
            const contribution = Number.isFinite(Number(profile.contribution)) ? profile.contribution : '—';
            const friendOfCount = Number.isFinite(Number(profile.friendOfCount)) ? profile.friendOfCount : '—';
            const avatar = profile.titlePhoto || '';
            const rankColor = getRankFromRating(Number(profile.maxRating) || Number(profile.rating) || 0).color;
            const statusText = presence?.active ? 'online now' : formatLastSeen(presence?.lastSeen);
            const statusClass = presence?.active ? 'status-active' : 'status-offline';
            const authenticatedLower = normalizeHandle(authenticatedHandle);
            const handleLower = normalizeHandle(handle);
            const h2hUrl = authenticatedLower && authenticatedLower !== handleLower
                ? `headtohead.html?h1=${encodeURIComponent(authenticatedHandle)}&h2=${encodeURIComponent(handle)}`
                : `headtohead.html?h1=${encodeURIComponent(handle)}`;
            const historyUrl = `results.html?handle=${encodeURIComponent(handle)}`;

            const opponentsHtml = Array.isArray(stats.opponents) && stats.opponents.length > 0
                ? stats.opponents
                    .slice(0, 8)
                    .map(item => `<a href="#" class="user-stats-handle" data-handle="${escapeHtml(item.handle)}">${escapeHtml(item.handle)}</a> (${escapeHtml(item.count)})`)
                    .join(', ')
                : 'No match history yet.';

            const recentHtml = (stats.recentMatches || []).length
                ? stats.recentMatches.map(item => `
                    <li class="user-recent-item">
                        <span class="user-recent-outcome ${item.outcome === 'W' ? 'win' : item.outcome === 'L' ? 'loss' : 'tie'}">${escapeHtml(item.outcome)}</span>
                        <span class="user-recent-opponent">vs ${escapeHtml(item.opponent || 'Unknown')}</span>
                        <span class="user-recent-score">${escapeHtml(item.ownScore)} - ${escapeHtml(item.oppScore)}</span>
                        <a class="user-recent-link" href="${item.roomId ? `results.html?roomId=${encodeURIComponent(item.roomId)}` : historyUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.date ? new Date(item.date).toLocaleDateString() : '—')}</a>
                    </li>
                `).join('')
                : '<li class="user-recent-empty">No recent matches</li>';

            globalProfileBody.innerHTML = `
                <div class="user-profile-head">
                    ${avatar ? `<img src="${escapeHtml(avatar)}" alt="${escapeHtml(handle)}" class="user-profile-avatar">` : ''}
                    <div class="user-profile-head-info">
                        <div class="user-profile-handle-row">
                            <div class="user-profile-handle" style="color:${rankColor}">${escapeHtml(handle)}</div>
                        </div>
                        <div class="user-presence ${statusClass}"><span class="presence-dot"></span>${escapeHtml(statusText)}</div>
                        <div class="user-profile-rank">${escapeHtml(rank)} · max ${escapeHtml(maxRank)}</div>
                    </div>
                </div>
                <div class="user-profile-grid">
                    <div class="user-profile-item"><span>Rating</span><strong>${escapeHtml(rating)}</strong></div>
                    <div class="user-profile-item"><span>Max Rating</span><strong>${escapeHtml(maxRating)}</strong></div>
                    <div class="user-profile-item"><span>Contribution</span><strong>${escapeHtml(contribution)}</strong></div>
                    <div class="user-profile-item"><span>Friends Of</span><strong>${escapeHtml(friendOfCount)}</strong></div>
                </div>
                <div class="user-profile-links">
                    <a href="https://codeforces.com/profile/${encodeURIComponent(handle)}" target="_blank" rel="noopener noreferrer">CF Profile</a>
                    <a href="${historyUrl}" target="_blank" rel="noopener noreferrer">History</a>
                    <a href="${h2hUrl}" target="_blank" rel="noopener noreferrer">Head-to-Head</a>
                </div>
                <div class="user-profile-site">
                    <h4>PUC Blitz Stats</h4>
                    <div class="user-profile-grid">
                        <div class="user-profile-item"><span>Played Games</span><strong>${escapeHtml(stats.played)}</strong></div>
                        <div class="user-profile-item"><span>Wins</span><strong>${escapeHtml(stats.wins)}</strong></div>
                        <div class="user-profile-item"><span>Losses</span><strong>${escapeHtml(stats.losses)}</strong></div>
                        <div class="user-profile-item"><span>Ties</span><strong>${escapeHtml(stats.ties)}</strong></div>
                        <div class="user-profile-item"><span>Win Rate</span><strong>${escapeHtml(stats.winRate)}%</strong></div>
                        <div class="user-profile-item"><span>Avg Score</span><strong>${escapeHtml(stats.avgScore)}</strong></div>
                        <div class="user-profile-item"><span>Streak</span><strong>${escapeHtml(stats.streak)}</strong></div>
                        <div class="user-profile-item"><span>Total Score</span><strong>${escapeHtml(stats.totalScore)}</strong></div>
                    </div>
                    <div style="margin-top:8px;"><span style="color:var(--muted); font-size:0.82rem;">Played with:</span> ${opponentsHtml}</div>
                    <div class="user-recent-wrap">
                        <div class="user-recent-title">Recent 5 Matches</div>
                        <ul class="user-recent-list">${recentHtml}</ul>
                    </div>
                    <div style="margin-top:10px;">
                        <a class="user-stats-handle" href="${historyUrl}" target="_blank" rel="noopener noreferrer">View played match history</a>
                    </div>
                </div>
            `;
        } catch {
            globalProfileBody.textContent = 'Could not load profile right now.';
        }
    }

    async function pingPresence(force = false) {
        enforceAuthPolicy();
        const handle = String(storageGetItem(HANDLE_STORAGE_KEY) || '').trim();
        if (!handle) return;
        if (pingInFlight && !force) return;

        pingInFlight = true;
        try {
            await fetch('/api/presence/ping', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
                keepalive: true
            });
        } catch {
        } finally {
            pingInFlight = false;
        }
    }

    function startPresenceHeartbeat() {
        if (pingTimer) {
            clearInterval(pingTimer);
            pingTimer = null;
        }

        pingPresence(true);
        pingTimer = setInterval(() => {
            pingPresence(false);
        }, PRESENCE_PING_INTERVAL_MS);
    }

    window.addEventListener('storage', (event) => {
        if (event.key === HANDLE_STORAGE_KEY || event.key === AVATAR_STORAGE_KEY) {
            renderGlobalHandleChip();
            startPresenceHeartbeat();
        }
    });

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            pingPresence(true);
        }
    });

    window.addEventListener('focus', () => {
        pingPresence(true);
    });

    window.addEventListener('pagehide', () => {
        pingPresence(true);
    });

    document.addEventListener('click', (event) => {
        const chip = event.target.closest('[data-global-handle-chip]');
        if (chip && !chip.classList.contains('not-verified')) {
            event.preventDefault();
            enforceAuthPolicy();
            const handle = String(storageGetItem(HANDLE_STORAGE_KEY) || '').trim();
            if (!handle) return;
            openGlobalProfileModal(handle).catch(() => {});
            return;
        }

        const userStatsHandle = event.target.closest('.user-stats-handle[data-handle]');
        if (userStatsHandle) {
            event.preventDefault();
            const handle = String(userStatsHandle.dataset.handle || '').trim();
            if (!handle) return;
            openGlobalProfileModal(handle).catch(() => {});
            return;
        }

    });

    async function bootstrap() {
        enforceAuthPolicy();
        await syncAuthFromServerSession();
        renderGlobalHandleChip();
        startPresenceHeartbeat();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            bootstrap().catch(() => {});
        });
    } else {
        bootstrap().catch(() => {});
    }
})();
