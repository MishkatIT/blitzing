(function () {
    function normalizeHandle(handle) {
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

    function getEmptySiteStats() {
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

    async function fetchSitePresence(apiBaseUrl, handle) {
        try {
            const response = await fetch(`${apiBaseUrl}/api/presence/${encodeURIComponent(handle)}`);
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
            totalScore: scoreSum,
            streak,
            opponents,
            recentMatches
        };
    }

    function getPresenceStatus(presence) {
        const active = !!presence?.active;
        return {
            text: active ? 'online now' : formatLastSeenLikeCodeforces(presence?.lastSeen),
            cssClass: active ? 'status-active' : 'status-offline'
        };
    }

    function buildOpponentsHtml(stats, options = {}) {
        const safeStats = stats || getEmptySiteStats();
        if (!Array.isArray(safeStats.opponents) || safeStats.opponents.length === 0) {
            return 'No match history yet.';
        }

        const limit = Number.isFinite(Number(options.limit)) ? Number(options.limit) : 8;
        const linkClass = options.linkClass || 'user-stats-handle';
        const hrefBuilder = typeof options.hrefBuilder === 'function'
            ? options.hrefBuilder
            : (handle) => `#`;
        const dataHandle = !!options.dataHandle;

        return safeStats.opponents.slice(0, limit).map(item => {
            const handle = String(item?.handle || '');
            const count = Number(item?.count) || 0;
            const href = hrefBuilder(handle);
            const attr = dataHandle ? ` data-handle="${handle}"` : '';
            return `<a href="${href}" class="${linkClass}"${attr}>${handle}</a> (${count})`;
        }).join(', ');
    }

    function buildRecentMatchesHtml(stats, options = {}) {
        const safeStats = stats || getEmptySiteStats();
        if (!Array.isArray(safeStats.recentMatches) || safeStats.recentMatches.length === 0) {
            return '<li class="user-recent-empty">No recent matches</li>';
        }

        const historyUrl = String(options.historyUrl || 'results.html');
        return safeStats.recentMatches.map(item => {
            const outcome = item?.outcome || 'T';
            const outcomeClass = outcome === 'W' ? 'win' : outcome === 'L' ? 'loss' : 'tie';
            const dateText = item?.date ? new Date(item.date).toLocaleDateString() : '—';
            const ownScore = Number(item?.ownScore) || 0;
            const oppScore = Number(item?.oppScore ?? item?.opponentScore) || 0;
            const roomId = String(item?.roomId || '');
            const roomHref = roomId ? `results.html?roomId=${encodeURIComponent(roomId)}` : historyUrl;

            return `
                <li class="user-recent-item">
                    <span class="user-recent-outcome ${outcomeClass}">${outcome}</span>
                    <span>vs ${item?.opponent || 'Unknown'}</span>
                    <span class="user-recent-score">${ownScore} - ${oppScore}</span>
                    <a class="user-recent-link" href="${roomHref}" target="_blank" rel="noopener noreferrer">${dateText}</a>
                </li>
            `;
        }).join('');
    }

    function getProfileDisplay(profile, fallbackHandle) {
        if (!profile) return null;
        const handle = profile.handle || fallbackHandle || '';
        const rank = profile.rank || 'Unrated';
        const maxRank = profile.maxRank || 'Unrated';
        const rating = Number.isFinite(Number(profile.rating)) ? profile.rating : '—';
        const maxRating = Number.isFinite(Number(profile.maxRating)) ? profile.maxRating : '—';
        const contribution = Number.isFinite(Number(profile.contribution)) ? profile.contribution : '—';
        const friendOfCount = Number.isFinite(Number(profile.friendOfCount)) ? profile.friendOfCount : '—';
        const avatar = profile.titlePhoto || '';
        const maxRatingNum = Number(profile.maxRating);
        const ratingNum = Number(profile.rating);
        const colorRating = Number.isFinite(maxRatingNum) && maxRatingNum > 0 ? maxRatingNum : (Number.isFinite(ratingNum) ? ratingNum : 0);
        const handleRankClass = colorRating > 0 ? getRankFromRating(colorRating).color : '';

        return {
            handle,
            rank,
            maxRank,
            rating,
            maxRating,
            contribution,
            friendOfCount,
            avatar,
            handleRankClass
        };
    }

    window.BlitzProfilePresenceUtils = {
        normalizeHandle,
        getRankFromRating,
        getEmptySiteStats,
        formatLastSeenLikeCodeforces,
        fetchUserProfileDetails,
        fetchSitePresence,
        buildSiteUserStats,
        getPresenceStatus,
        buildOpponentsHtml,
        buildRecentMatchesHtml,
        getProfileDisplay
    };
})();
