(function () {
    const API_BASE_URL = window.location.origin;
    const STORAGE_ENC_PREFIX = '654654HiBoss86GJHG&^%ikusehffkGHJG57634rghJGHnHGg827JHG364^%$^$#:';
    const STORAGE_ENC_SECRET = 'BNYUG&5sKJHKJ@)*%jhf&$%dfjhbJYftg73^3#-)sefkh&^%sfdh';

    const profileHandleInput = document.getElementById('profileHandleInput');
    const openProfileBtn = document.getElementById('openProfileBtn');
    const profileBody = document.getElementById('profileBody');
    const allProfilesList = document.getElementById('allProfilesList');
    const profileCountText = document.getElementById('profileCountText');

    let cachedResults = [];
    let resultsLoaded = false;
    let listedHandles = [];
    let listedProfilesLoaded = false;

    function decodeStoredValue(rawValue) {
        const raw = String(rawValue ?? '');
        if (!raw.startsWith(STORAGE_ENC_PREFIX)) return raw;
        try {
            const payload = raw.slice(STORAGE_ENC_PREFIX.length);
            const binary = atob(payload);
            const encrypted = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index += 1) {
                encrypted[index] = binary.charCodeAt(index);
            }

            const encoder = new TextEncoder();
            const keyBytes = encoder.encode(STORAGE_ENC_SECRET);
            const plainBytes = new Uint8Array(encrypted.length);
            for (let index = 0; index < encrypted.length; index += 1) {
                plainBytes[index] = encrypted[index] ^ keyBytes[index % keyBytes.length];
            }

            return new TextDecoder().decode(plainBytes);
        } catch {
            return '';
        }
    }

    function getStoredHandle() {
        return String(decodeStoredValue(localStorage.getItem('blitzUserHandle') || '') || '').trim();
    }

    function normalize(handle) {
        return String(handle || '').trim().toLowerCase();
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

    async function fetchResults() {
        const response = await fetch(`${API_BASE_URL}/api/results`);
        const data = await response.json();
        return Array.isArray(data) ? data : [];
    }

    async function ensureResultsLoaded() {
        if (resultsLoaded) return;
        cachedResults = await fetchResults();
        resultsLoaded = true;
    }

    async function fetchListedProfiles() {
        const response = await fetch(`${API_BASE_URL}/api/profiles`);
        const data = await response.json();
        return Array.isArray(data)
            ? data.map(item => String(item || '').trim()).filter(Boolean)
            : [];
    }

    async function ensureListedProfilesLoaded(force = false) {
        if (listedProfilesLoaded && !force) return;
        listedHandles = await fetchListedProfiles();
        listedProfilesLoaded = true;
    }

    function renderAllListedProfiles(selectedHandle = '') {
        if (!allProfilesList) return;
        const handles = listedHandles;
        if (profileCountText) {
            profileCountText.textContent = `${handles.length} user${handles.length === 1 ? '' : 's'}`;
        }

        if (!handles.length) {
            allProfilesList.textContent = 'No profiles found yet.';
            return;
        }

        const selectedNorm = normalize(selectedHandle);
        allProfilesList.innerHTML = handles.map(handle => {
            const handleNorm = normalize(handle);
            const activeClass = normalize(handle) === selectedNorm ? ' active' : '';
            return `<a class="profile-chip${activeClass}" data-handle-norm="${handleNorm}" href="/${encodeURIComponent(handle)}">${handle}</a>`;
        }).join('');
    }

    function scrollToListedHandle(handle) {
        if (!allProfilesList) return;
        const handleNorm = normalize(handle);
        if (!handleNorm) return;

        const chips = Array.from(allProfilesList.querySelectorAll('.profile-chip'));
        const chip = chips.find(element => normalize(element.getAttribute('data-handle-norm') || element.textContent || '') === handleNorm);
        if (!chip) return;

        requestAnimationFrame(() => {
            chip.scrollIntoView({
                behavior: 'smooth',
                block: 'start',
                inline: 'nearest'
            });

            if (typeof chip.focus === 'function') {
                try {
                    chip.focus({ preventScroll: true });
                } catch {
                    chip.focus();
                }
            }
        });
    }

    async function fetchUserProfileDetails(handle) {
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

    function buildSiteUserStats(targetHandle) {
        const targetNorm = normalize(targetHandle);
        let played = 0;
        let wins = 0;
        let losses = 0;
        let ties = 0;
        let scoreSum = 0;
        const opponentMap = new Map();
        const recent = [];

        for (const match of cachedResults) {
            const p1 = String(match?.player1?.handle || '');
            const p2 = String(match?.player2?.handle || '');
            const p1Norm = normalize(p1);
            const p2Norm = normalize(p2);
            if (p1Norm !== targetNorm && p2Norm !== targetNorm) continue;

            played += 1;
            const winnerNorm = normalize(match?.winner);
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
            if (opponent) opponentMap.set(opponent, (opponentMap.get(opponent) || 0) + 1);

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
        if (recentMatches.length > 0) {
            const latest = recentMatches[0].outcome;
            let n = 0;
            for (const item of recentMatches) {
                if (item.outcome !== latest) break;
                n += 1;
            }
            streak = `${latest}${n}`;
        }

        return {
            played,
            wins,
            losses,
            ties,
            winRate: played > 0 ? ((wins / played) * 100).toFixed(1) : '0.0',
            avgScore: played > 0 ? (scoreSum / played).toFixed(1) : '0.0',
            streak,
            opponents,
            recentMatches
        };
    }

    function renderProfile(profile, siteStats, presence) {
        if (!profileBody) return;
        if (!profile) {
            profileBody.textContent = 'Could not load profile right now.';
            return;
        }

        const handle = profile.handle || '';
        const rank = profile.rank || 'Unrated';
        const maxRank = profile.maxRank || 'Unrated';
        const rating = Number.isFinite(Number(profile.rating)) ? profile.rating : '—';
        const maxRating = Number.isFinite(Number(profile.maxRating)) ? profile.maxRating : '—';
        const contribution = Number.isFinite(Number(profile.contribution)) ? profile.contribution : '—';
        const friendOfCount = Number.isFinite(Number(profile.friendOfCount)) ? profile.friendOfCount : '—';
        const avatar = profile.titlePhoto || '';
        const stats = siteStats || { played: 0, wins: 0, losses: 0, ties: 0, winRate: '0.0', avgScore: '0.0', totalScore: 0, streak: '-', opponents: [], recentMatches: [] };
        const historyUrl = `results.html?handle=${encodeURIComponent(handle)}`;
        const cfUrl = `https://codeforces.com/profile/${encodeURIComponent(handle)}`;
        const maxRatingNum = Number(profile.maxRating);
        const ratingNum = Number(profile.rating);
        const colorRating = Number.isFinite(maxRatingNum) && maxRatingNum > 0 ? maxRatingNum : (Number.isFinite(ratingNum) ? ratingNum : 0);
        const handleRankClass = colorRating > 0 ? getRankFromRating(colorRating).color : '';
        const statusText = presence?.active
            ? 'online now'
            : formatLastSeenLikeCodeforces(presence?.lastSeen);
        const statusClass = presence?.active ? 'status-active' : 'status-offline';
        const selfHandle = String(getStoredHandle() || '').trim();
        const h2hUrl = selfHandle && selfHandle.toLowerCase() !== String(handle).toLowerCase()
            ? `headtohead.html?h1=${encodeURIComponent(selfHandle)}&h2=${encodeURIComponent(handle)}`
            : `headtohead.html?h1=${encodeURIComponent(handle)}`;

        const opponentsHtml = stats.opponents.length
            ? stats.opponents.slice(0, 8).map(item => `<a href="/${encodeURIComponent(item.handle)}" class="user-stats-handle">${item.handle}</a> (${item.count})`).join(', ')
            : 'No match history yet.';

        const recentHtml = stats.recentMatches.length
            ? stats.recentMatches.map(item => {
                const outcomeClass = item.outcome === 'W' ? 'win' : item.outcome === 'L' ? 'loss' : 'tie';
                const dateText = item.date ? new Date(item.date).toLocaleDateString() : '—';
                const roomHref = item.roomId ? `results.html?roomId=${encodeURIComponent(item.roomId)}` : historyUrl;
                return `
                    <li class="user-recent-item">
                        <span class="user-recent-outcome ${outcomeClass}">${item.outcome}</span>
                        <span class="user-recent-opponent">vs ${item.opponent || 'Unknown'}</span>
                        <span class="user-recent-score">${item.ownScore} - ${item.oppScore}</span>
                        <a class="user-recent-link" href="${roomHref}" target="_blank" rel="noopener noreferrer">${dateText}</a>
                    </li>
                `;
            }).join('')
            : '<li class="user-recent-empty">No recent matches</li>';

        profileBody.innerHTML = `
            <div class="user-profile-head">
                ${avatar ? `<img src="${avatar}" alt="${handle}" class="user-profile-avatar">` : ''}
                <div class="user-profile-head-info">
                    <div class="user-profile-handle-row">
                        <div class="user-profile-handle ${handleRankClass}">${handle}</div>
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
                <a href="${cfUrl}" target="_blank" rel="noopener noreferrer">CF Profile</a>
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
                    <ul class="user-recent-list">${recentHtml}</ul>
                </div>
                <div style="margin-top:10px;">
                    <a class="user-stats-handle" href="${historyUrl}" target="_blank" rel="noopener noreferrer">View played match history</a>
                </div>
            </div>
        `;
    }

    function getHandleFromUrl() {
        const params = new URLSearchParams(window.location.search);
        const byQuery = (params.get('handle') || '').trim();
        if (byQuery) return byQuery;

        const pathPart = decodeURIComponent((window.location.pathname || '').replace(/^\//, '')).trim();
        if (pathPart && !pathPart.includes('/') && !pathPart.includes('.')) {
            return pathPart;
        }

        return '';
    }

    async function openHandleProfile(handle) {
        const cleanHandle = String(handle || '').trim();
        if (!cleanHandle) return;

        profileBody.textContent = 'Loading profile...';

        try {
            await ensureResultsLoaded();
            await ensureListedProfilesLoaded();

            const [profile, presence] = await Promise.all([
                fetchUserProfileDetails(cleanHandle),
                fetchSitePresence(cleanHandle)
            ]);
            const stats = buildSiteUserStats(cleanHandle);
            renderProfile(profile, stats, presence);
            renderAllListedProfiles(cleanHandle);
            scrollToListedHandle(cleanHandle);

            const normalizedPath = `/${encodeURIComponent(cleanHandle)}`;
            if (window.location.pathname !== normalizedPath) {
                history.replaceState(null, '', normalizedPath);
            }
        } catch (error) {
            console.error('Profile load failed:', error);
            profileBody.textContent = 'Could not load profile right now.';
        }
    }

    function handleOpenClick() {
        const handle = String(profileHandleInput.value || '').trim();
        if (!handle) return;
        openHandleProfile(handle).catch(() => {});
    }

    openProfileBtn.addEventListener('click', handleOpenClick);
    profileHandleInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            handleOpenClick();
        }
    });

    const initialHandle = getHandleFromUrl();
    Promise.all([ensureResultsLoaded(), ensureListedProfilesLoaded()])
        .then(() => {
            renderAllListedProfiles(initialHandle);
            if (initialHandle) {
                profileHandleInput.value = initialHandle;
                openHandleProfile(initialHandle).catch(() => {});
            }
        })
        .catch(() => {
            if (allProfilesList) {
                allProfilesList.textContent = 'Could not load profile list right now.';
            }
        });
})();
