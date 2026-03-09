(function () {
    const API_BASE_URL = window.location.origin;

    const handleOneInput = document.getElementById('handleOneInput');
    const handleTwoInput = document.getElementById('handleTwoInput');
    const compareBtn = document.getElementById('compareBtn');
    const compareNote = document.getElementById('compareNote');
    const summaryPanel = document.getElementById('summaryPanel');
    const summaryTitle = document.getElementById('summaryTitle');
    const statsGrid = document.getElementById('statsGrid');
    const matchesPanel = document.getElementById('matchesPanel');
    const matchesBody = document.getElementById('matchesBody');

    function parseQuery() {
        const params = new URLSearchParams(window.location.search);
        const h1 = (params.get('h1') || '').trim();
        const h2 = (params.get('h2') || '').trim();
        if (h1) handleOneInput.value = h1;
        if (h2) handleTwoInput.value = h2;
    }

    async function fetchResults() {
        const response = await fetch(`${API_BASE_URL}/api/results`);
        const results = await response.json();
        return Array.isArray(results) ? results : [];
    }

    function normalize(handle) {
        return String(handle || '').trim().toLowerCase();
    }

    function analyzeHeadToHead(results, h1, h2) {
        const left = normalize(h1);
        const right = normalize(h2);
        const meetings = [];

        for (const match of results) {
            const p1 = normalize(match?.player1?.handle);
            const p2 = normalize(match?.player2?.handle);
            const isPair = (p1 === left && p2 === right) || (p1 === right && p2 === left);
            if (!isPair) continue;

            const originalP1 = String(match?.player1?.handle || '');
            const originalP2 = String(match?.player2?.handle || '');
            const leftIsP1 = p1 === left;
            const leftScore = leftIsP1 ? Number(match?.player1?.score) || 0 : Number(match?.player2?.score) || 0;
            const rightScore = leftIsP1 ? Number(match?.player2?.score) || 0 : Number(match?.player1?.score) || 0;

            meetings.push({
                roomId: match?.roomId || '',
                date: match?.date || '',
                winner: String(match?.winner || ''),
                winnerNorm: normalize(match?.winner),
                leftScore,
                rightScore,
                leftHandleShown: leftIsP1 ? originalP1 : originalP2,
                rightHandleShown: leftIsP1 ? originalP2 : originalP1
            });
        }

        meetings.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

        let leftWins = 0;
        let rightWins = 0;
        let ties = 0;
        let leftScoreSum = 0;
        let rightScoreSum = 0;

        meetings.forEach(item => {
            leftScoreSum += item.leftScore;
            rightScoreSum += item.rightScore;
            if (item.winnerNorm === 'tie') ties += 1;
            else if (item.winnerNorm === left) leftWins += 1;
            else if (item.winnerNorm === right) rightWins += 1;
        });

        return {
            meetings,
            total: meetings.length,
            leftWins,
            rightWins,
            ties,
            leftAvgScore: meetings.length > 0 ? (leftScoreSum / meetings.length).toFixed(1) : '0.0',
            rightAvgScore: meetings.length > 0 ? (rightScoreSum / meetings.length).toFixed(1) : '0.0'
        };
    }

    function renderSummary(handle1, handle2, stats) {
        summaryPanel.style.display = 'block';
        summaryTitle.textContent = `${handle1} vs ${handle2}`;
        statsGrid.innerHTML = `
            <div class="stat-card"><h3>Total Meetings</h3><strong>${stats.total}</strong></div>
            <div class="stat-card"><h3>${handle1} Wins</h3><strong>${stats.leftWins}</strong></div>
            <div class="stat-card"><h3>${handle2} Wins</h3><strong>${stats.rightWins}</strong></div>
            <div class="stat-card"><h3>Ties</h3><strong>${stats.ties}</strong></div>
            <div class="stat-card"><h3>${handle1} Avg Score</h3><strong>${stats.leftAvgScore}</strong></div>
            <div class="stat-card"><h3>${handle2} Avg Score</h3><strong>${stats.rightAvgScore}</strong></div>
            <div class="stat-card"><h3>Win Share (${handle1})</h3><strong>${stats.total > 0 ? ((stats.leftWins / stats.total) * 100).toFixed(1) : '0.0'}%</strong></div>
            <div class="stat-card"><h3>Win Share (${handle2})</h3><strong>${stats.total > 0 ? ((stats.rightWins / stats.total) * 100).toFixed(1) : '0.0'}%</strong></div>
        `;
    }

    function renderMeetings(handle1, handle2, meetings) {
        matchesPanel.style.display = 'block';
        if (!meetings.length) {
            matchesBody.innerHTML = '<tr><td colspan="5">No head-to-head matches found.</td></tr>';
            return;
        }

        matchesBody.innerHTML = meetings.map(item => {
            let resultClass = 'tie';
            let winnerText = 'TIE';
            if (item.winnerNorm === normalize(handle1)) {
                resultClass = 'win';
                winnerText = item.leftHandleShown;
            } else if (item.winnerNorm === normalize(handle2)) {
                resultClass = 'loss';
                winnerText = item.rightHandleShown;
            }

            const dateText = item.date ? `${new Date(item.date).toLocaleDateString()} ${new Date(item.date).toLocaleTimeString()}` : '—';
            const historyUrl = item.roomId ? `results.html?roomId=${encodeURIComponent(item.roomId)}` : 'results.html';

            return `
                <tr>
                    <td>${dateText}</td>
                    <td>${item.roomId || '-'}</td>
                    <td class="${resultClass}">${winnerText}</td>
                    <td>${item.leftHandleShown} ${item.leftScore} - ${item.rightScore} ${item.rightHandleShown}</td>
                    <td><a href="${historyUrl}" class="nav-btn" target="_blank" rel="noopener noreferrer">Open</a></td>
                </tr>
            `;
        }).join('');
    }

    async function compareNow() {
        const handle1 = String(handleOneInput.value || '').trim();
        const handle2 = String(handleTwoInput.value || '').trim();

        if (!handle1 || !handle2) {
            compareNote.textContent = 'Enter both handles to compare.';
            return;
        }

        if (normalize(handle1) === normalize(handle2)) {
            compareNote.textContent = 'Use two different handles.';
            return;
        }

        compareNote.textContent = 'Loading…';

        try {
            const results = await fetchResults();
            const stats = analyzeHeadToHead(results, handle1, handle2);
            renderSummary(handle1, handle2, stats);
            renderMeetings(handle1, handle2, stats.meetings);

            compareNote.textContent = stats.total > 0
                ? `Found ${stats.total} meeting(s).`
                : 'No direct meetings found yet.';
        } catch (error) {
            console.error('Head-to-head load failed:', error);
            compareNote.textContent = 'Could not load results right now.';
        }
    }

    compareBtn.addEventListener('click', () => {
        compareNow();
    });

    [handleOneInput, handleTwoInput].forEach(input => {
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                compareNow();
            }
        });
    });

    parseQuery();
    if (handleOneInput.value && handleTwoInput.value) {
        compareNow();
    }
})();
