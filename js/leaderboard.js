(function () {
    const API_BASE_URL = window.location.origin;
    const profileUtils = window.BlitzProfilePresenceUtils || {};

    const searchHandleInput = document.getElementById('searchHandleInput');
    const minMatchesInput = document.getElementById('minMatchesInput');
    const sortBySelect = document.getElementById('sortBySelect');
    const leaderboardBody = document.getElementById('leaderboardBody');
    const tableNote = document.getElementById('tableNote');

    const playersRanked = document.getElementById('playersRanked');
    const totalMatches = document.getElementById('totalMatches');
    const topByRate = document.getElementById('topByRate');
    const topByWins = document.getElementById('topByWins');
    const userProfileModal = document.getElementById('userProfileModal');
    const userProfileBody = document.getElementById('userProfileBody');
    const closeUserProfileModal = document.getElementById('closeUserProfileModal');

    let rawResults = [];

    function normalize(handle) {
        return profileUtils.normalizeHandle
            ? profileUtils.normalizeHandle(handle)
            : String(handle || '').trim().toLowerCase();
    }

    async function fetchResults() {
        const response = await fetch(`${API_BASE_URL}/api/results`);
        const data = await response.json();
        return Array.isArray(data) ? data : [];
    }

    async function fetchUserProfileDetails(handle) {
        if (profileUtils.fetchUserProfileDetails) {
            return profileUtils.fetchUserProfileDetails(handle);
        }
        return null;
    }

    async function fetchSitePresence(handle) {
        if (profileUtils.fetchSitePresence) {
            return profileUtils.fetchSitePresence(API_BASE_URL, handle);
        }
        return { active: false, lastSeen: null };
    }

    function buildSiteUserStats(targetHandle) {
        if (profileUtils.buildSiteUserStats) {
            return profileUtils.buildSiteUserStats(rawResults, targetHandle);
        }
        return profileUtils.getEmptySiteStats ? profileUtils.getEmptySiteStats() : {
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

    function decodeStoredValue(rawValue) {
        const raw = String(rawValue ?? '');
        const prefix = 'enc:v1:';
        const secret = 'blitz_storage_v1';
        if (!raw.startsWith(prefix)) return raw;
        try {
            const payload = raw.slice(prefix.length);
            const binary = atob(payload);
            const encrypted = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index += 1) {
                encrypted[index] = binary.charCodeAt(index);
            }

            const encoder = new TextEncoder();
            const keyBytes = encoder.encode(secret);
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

    function renderUserProfileModal(profile, siteStats, presence) {
        if (!userProfileBody) return;
        if (!profile) {
            userProfileBody.textContent = 'Could not load profile right now.';
            return;
        }

        const display = profileUtils.getProfileDisplay
            ? profileUtils.getProfileDisplay(profile, '')
            : null;
        if (!display) {
            userProfileBody.textContent = 'Could not load profile right now.';
            return;
        }

        const handle = display.handle;
        const rank = display.rank;
        const maxRank = display.maxRank;
        const rating = display.rating;
        const maxRating = display.maxRating;
        const contribution = display.contribution;
        const friendOfCount = display.friendOfCount;
        const avatar = display.avatar;
        const stats = siteStats || (profileUtils.getEmptySiteStats ? profileUtils.getEmptySiteStats() : { played: 0, wins: 0, losses: 0, ties: 0, winRate: '0.0', avgScore: '0.0', totalScore: 0, streak: '-', opponents: [], recentMatches: [] });
        const historyUrl = `results.html?handle=${encodeURIComponent(handle)}`;
        const cfUrl = `https://codeforces.com/profile/${encodeURIComponent(handle)}`;
        const handleRankClass = display.handleRankClass;
        const presenceStatus = profileUtils.getPresenceStatus
            ? profileUtils.getPresenceStatus(presence)
            : { text: 'last seen unavailable', cssClass: 'status-offline' };
        const selfHandle = getStoredHandle();
        const h2hUrl = selfHandle && selfHandle.toLowerCase() !== String(handle).toLowerCase()
            ? `headtohead.html?h1=${encodeURIComponent(selfHandle)}&h2=${encodeURIComponent(handle)}`
            : `headtohead.html?h1=${encodeURIComponent(handle)}`;

        const opponentsHtml = profileUtils.buildOpponentsHtml
            ? profileUtils.buildOpponentsHtml(stats, {
                linkClass: 'user-stats-handle',
                dataHandle: true,
                hrefBuilder: () => '#'
            })
            : 'No match history yet.';

        const recentHtml = profileUtils.buildRecentMatchesHtml
            ? profileUtils.buildRecentMatchesHtml(stats, { historyUrl })
            : '<li class="user-recent-empty">No recent matches</li>';

        userProfileBody.innerHTML = `
            <div class="user-profile-head">
                ${avatar ? `<img src="${avatar}" alt="${handle}" class="user-profile-avatar">` : ''}
                <div class="user-profile-head-info">
                    <div class="user-profile-handle-row">
                        <div class="user-profile-handle ${handleRankClass}">${handle}</div>
                    </div>
                    <div class="user-presence ${presenceStatus.cssClass}"><span class="presence-dot"></span>${presenceStatus.text}</div>
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
                    <a class="user-recent-link" href="${historyUrl}" target="_blank" rel="noopener noreferrer">View played match history</a>
                </div>
            </div>
        `;
    }

    async function openUserProfileModal(handle) {
        if (!userProfileModal || !userProfileBody) return;
        const cleanHandle = String(handle || '').trim();
        if (!cleanHandle) return;

        userProfileBody.textContent = 'Loading profile...';
        userProfileModal.style.display = 'flex';

        const [profile, presence] = await Promise.all([
            fetchUserProfileDetails(cleanHandle),
            fetchSitePresence(cleanHandle)
        ]);
        const stats = buildSiteUserStats(cleanHandle);
        renderUserProfileModal(profile, stats, presence);
    }

    function buildLeaderboard(results) {
        const map = new Map();

        for (const match of results) {
            const p1Handle = String(match?.player1?.handle || '').trim();
            const p2Handle = String(match?.player2?.handle || '').trim();
            const p1Key = normalize(p1Handle);
            const p2Key = normalize(p2Handle);
            if (!p1Key || !p2Key) continue;

            if (!map.has(p1Key)) {
                map.set(p1Key, {
                    handle: p1Handle,
                    played: 0,
                    wins: 0,
                    losses: 0,
                    ties: 0,
                    totalScore: 0,
                    lastMatchAt: 0
                });
            }

            if (!map.has(p2Key)) {
                map.set(p2Key, {
                    handle: p2Handle,
                    played: 0,
                    wins: 0,
                    losses: 0,
                    ties: 0,
                    totalScore: 0,
                    lastMatchAt: 0
                });
            }

            const p1 = map.get(p1Key);
            const p2 = map.get(p2Key);
            const winner = normalize(match?.winner);
            const p1Score = Number(match?.player1?.score) || 0;
            const p2Score = Number(match?.player2?.score) || 0;
            const matchTime = new Date(match?.date || 0).getTime();

            p1.played += 1;
            p2.played += 1;
            p1.totalScore += p1Score;
            p2.totalScore += p2Score;
            p1.lastMatchAt = Math.max(p1.lastMatchAt, matchTime || 0);
            p2.lastMatchAt = Math.max(p2.lastMatchAt, matchTime || 0);

            if (winner === 'tie') {
                p1.ties += 1;
                p2.ties += 1;
            } else if (winner === p1Key) {
                p1.wins += 1;
                p2.losses += 1;
            } else if (winner === p2Key) {
                p2.wins += 1;
                p1.losses += 1;
            }
        }

        return Array.from(map.values()).map(item => {
            const winRateValue = item.played > 0 ? (item.wins / item.played) * 100 : 0;
            const avgScoreValue = item.played > 0 ? item.totalScore / item.played : 0;
            return {
                ...item,
                winRateValue,
                avgScoreValue,
                winRate: `${winRateValue.toFixed(1)}%`,
                avgScore: avgScoreValue.toFixed(1)
            };
        });
    }

    function sortRows(rows, sortBy) {
        const sorted = [...rows];
        sorted.sort((a, b) => {
            if (sortBy === 'wins') {
                if (b.wins !== a.wins) return b.wins - a.wins;
                if (b.winRateValue !== a.winRateValue) return b.winRateValue - a.winRateValue;
                if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
                return a.handle.localeCompare(b.handle);
            }

            if (sortBy === 'totalScore') {
                if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
                if (b.wins !== a.wins) return b.wins - a.wins;
                if (b.winRateValue !== a.winRateValue) return b.winRateValue - a.winRateValue;
                return a.handle.localeCompare(b.handle);
            }

            if (b.winRateValue !== a.winRateValue) return b.winRateValue - a.winRateValue;
            if (b.wins !== a.wins) return b.wins - a.wins;
            if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
            return a.handle.localeCompare(b.handle);
        });
        return sorted;
    }

    function applyFilters(rows) {
        const query = normalize(searchHandleInput.value);
        const minMatches = Math.max(1, Number(minMatchesInput.value) || 1);

        return rows.filter(item => {
            if (item.played < minMatches) return false;
            if (query && !normalize(item.handle).includes(query)) return false;
            return true;
        });
    }

    function renderSummary(rows) {
        playersRanked.textContent = String(rows.length);
        totalMatches.textContent = String(rawResults.length);

        if (!rows.length) {
            topByRate.textContent = '-';
            topByWins.textContent = '-';
            return;
        }

        const byRate = [...rows].sort((a, b) => b.winRateValue - a.winRateValue || b.wins - a.wins || a.handle.localeCompare(b.handle));
        const byWins = [...rows].sort((a, b) => b.wins - a.wins || b.winRateValue - a.winRateValue || a.handle.localeCompare(b.handle));

        topByRate.textContent = `${byRate[0].handle} (${byRate[0].winRate})`;
        topByWins.textContent = `${byWins[0].handle} (${byWins[0].wins})`;
    }

    function renderTable(rows) {
        if (!rows.length) {
            leaderboardBody.innerHTML = '<tr><td colspan="10">No players match current filters.</td></tr>';
            tableNote.textContent = '';
            return;
        }

        leaderboardBody.innerHTML = rows.map((item, index) => {
            const lastMatch = item.lastMatchAt > 0 ? new Date(item.lastMatchAt).toLocaleDateString() : '-';
            return `
                <tr>
                    <td>${index + 1}</td>
                    <td><a class="handle-link" href="#" data-handle="${item.handle}">${item.handle}</a></td>
                    <td>${item.played}</td>
                    <td>${item.wins}</td>
                    <td>${item.losses}</td>
                    <td>${item.ties}</td>
                    <td>${item.winRate}</td>
                    <td>${item.avgScore}</td>
                    <td>${item.totalScore}</td>
                    <td>${lastMatch}</td>
                </tr>
            `;
        }).join('');

        tableNote.textContent = 'Ranking uses selected sort with tie-breaks: wins, win rate, total score, then handle.';
    }

    function refreshView() {
        const rows = buildLeaderboard(rawResults);
        const filtered = applyFilters(rows);
        const sorted = sortRows(filtered, sortBySelect.value);
        renderSummary(sorted);
        renderTable(sorted);
    }

    async function init() {
        try {
            rawResults = await fetchResults();
            refreshView();
        } catch (error) {
            console.error('Failed to load leaderboard:', error);
            leaderboardBody.innerHTML = '<tr><td colspan="10">Could not load leaderboard right now.</td></tr>';
        }
    }

    [searchHandleInput, minMatchesInput].forEach(input => {
        input.addEventListener('input', refreshView);
    });

    sortBySelect.addEventListener('change', refreshView);

    leaderboardBody.addEventListener('click', (event) => {
        const handleLink = event.target.closest('.handle-link');
        if (!handleLink) return;
        const handle = String(handleLink.dataset.handle || '').trim();
        if (!handle) return;
        event.preventDefault();
        openUserProfileModal(handle).catch(() => {
            userProfileBody.textContent = 'Could not load profile right now.';
        });
    });

    if (userProfileBody) {
        userProfileBody.addEventListener('click', (event) => {
            const innerHandleLink = event.target.closest('.user-stats-handle');
            if (!innerHandleLink) return;
            const handle = String(innerHandleLink.dataset.handle || '').trim();
            if (!handle) return;
            event.preventDefault();
            openUserProfileModal(handle).catch(() => {
                userProfileBody.textContent = 'Could not load profile right now.';
            });
        });
    }

    if (closeUserProfileModal && userProfileModal) {
        closeUserProfileModal.addEventListener('click', () => {
            userProfileModal.style.display = 'none';
        });
    }

    if (userProfileModal) {
        userProfileModal.addEventListener('click', (event) => {
            if (event.target === userProfileModal) {
                userProfileModal.style.display = 'none';
            }
        });
    }

    init();
})();
