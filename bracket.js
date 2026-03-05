(function () {
    const API_BASE_URL = window.location.origin;
    const recentBracketNotifications = new Map();
    const BRACKET_NOTIFICATION_DEDUPE_MS = 4000;
    const OWNER_KEY = 'blitzUserHandle';
    const ADMIN_HANDLES = new Set(['else_if_tridib21', 'mishkatit']);
    const STORAGE_ENC_PREFIX = 'enc:v1:';
    const STORAGE_ENC_SECRET = 'blitz_storage_v1';

    const typeGrid = document.getElementById('typeGrid');
    const generateBracketBtn = document.getElementById('generateBracketBtn');
    const participantsInput = document.getElementById('participantsInput');
    const shuffleNamesBtn = document.getElementById('shuffleNamesBtn');
    const shuffledNamesPreview = document.getElementById('shuffledNamesPreview');
    const tournamentName = document.getElementById('tournamentName');
    const defaultMatchDuration = document.getElementById('defaultMatchDuration');
    const defaultMatchInterval = document.getElementById('defaultMatchInterval');
    const bracketProblemsList = document.getElementById('bracketProblemsList');
    const bracketAddProblemBtn = document.getElementById('bracketAddProblemBtn');
    const outputPanel = document.getElementById('outputPanel');
    const outputTitle = document.getElementById('outputTitle');
    const outputMeta = document.getElementById('outputMeta');
    const outputContent = document.getElementById('outputContent');
    const savedBracketsList = document.getElementById('savedBracketsList');
    const expandedBracketIds = new Set();
    const ratingOptions = Array.from({ length: 28 }, (_, index) => 800 + (index * 100));
    let bracketProblems = [
        { points: 2, rating: 800 },
        { points: 3, rating: 800 },
        { points: 4, rating: 900 },
        { points: 6, rating: 1000 },
        { points: 8, rating: 1000 },
        { points: 10, rating: 1100 },
        { points: 12, rating: 1200 }
    ];

    function normalizeProblemConfigs(configs) {
        if (!Array.isArray(configs) || configs.length === 0) {
            return [
                { points: 2, rating: 800 },
                { points: 3, rating: 800 },
                { points: 4, rating: 900 },
                { points: 6, rating: 1000 },
                { points: 8, rating: 1000 },
                { points: 10, rating: 1100 },
                { points: 12, rating: 1200 }
            ];
        }

        return configs.map(item => ({
            points: Math.max(1, Number(item?.points) || 1),
            rating: Math.max(800, Math.min(3500, Number(item?.rating) || 800))
        }));
    }

    function renderBracketProblems(scrollToIndex = null) {
        if (!bracketProblemsList) return;
        const html = bracketProblems.map((problem, index) => {
            const ratingSelect = ratingOptions
                .map(rating => `<option value="${rating}" ${rating === problem.rating ? 'selected' : ''}>${rating}</option>`)
                .join('');

            return `
                <div class="create-problem-item" data-index="${index}">
                    <input type="number" class="problem-points-create" value="${problem.points}" min="1" max="2000" step="1" placeholder="Points">
                    <select class="problem-rating-create">${ratingSelect}</select>
                    <button class="remove-create-problem" ${bracketProblems.length <= 1 ? 'disabled' : ''}>✕</button>
                </div>
            `;
        }).join('');

        bracketProblemsList.innerHTML = html;

        bracketProblemsList.querySelectorAll('.problem-points-create').forEach(input => {
            input.addEventListener('change', (event) => {
                const parent = event.target.closest('.create-problem-item');
                if (!parent) return;
                const index = Number(parent.dataset.index);
                bracketProblems[index].points = Math.max(1, Number(event.target.value) || 1);
            });
        });

        bracketProblemsList.querySelectorAll('.problem-rating-create').forEach(select => {
            select.addEventListener('change', (event) => {
                const parent = event.target.closest('.create-problem-item');
                if (!parent) return;
                const index = Number(parent.dataset.index);
                bracketProblems[index].rating = Number(event.target.value) || 800;
            });
        });

        bracketProblemsList.querySelectorAll('.remove-create-problem').forEach(button => {
            button.addEventListener('click', (event) => {
                if (bracketProblems.length <= 1) return;
                const parent = event.target.closest('.create-problem-item');
                if (!parent) return;
                const index = Number(parent.dataset.index);
                bracketProblems.splice(index, 1);
                renderBracketProblems();
            });
        });

        if (Number.isInteger(scrollToIndex) && scrollToIndex >= 0) {
            const target = bracketProblemsList.querySelector(`.create-problem-item[data-index="${scrollToIndex}"]`);
            if (target) {
                target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        }
    }

    function getBracketRoomConfigFromInputs() {
        const normalizedProblems = normalizeProblemConfigs(bracketProblems);
        return {
            problemCount: normalizedProblems.length,
            duration: Math.max(2, Math.min(60, Number(defaultMatchDuration?.value) || 40)),
            interval: Math.max(1, Math.min(10, Number(defaultMatchInterval?.value) || 1)),
            problems: normalizedProblems
        };
    }

    async function ensureNotificationPermission() {
        if (!('Notification' in window) || !window.isSecureContext) return;
        if (Notification.permission === 'default') {
            try {
                await Notification.requestPermission();
            } catch (error) {
                console.warn('Notification permission request failed:', error);
            }
        }
    }

    function showOsNotification(title, body) {
        if (!('Notification' in window) || !window.isSecureContext) return;
        if (Notification.permission !== 'granted') return;

            const now = Date.now();
            const key = `${String(title || '').trim().toLowerCase()}::${String(body || '').trim().toLowerCase()}`;
            const previous = Number(recentBracketNotifications.get(key)) || 0;
            if (previous > 0 && (now - previous) <= BRACKET_NOTIFICATION_DEDUPE_MS) {
                return;
            }
            recentBracketNotifications.set(key, now);

            for (const [savedKey, timestamp] of recentBracketNotifications.entries()) {
                if (now - Number(timestamp) > BRACKET_NOTIFICATION_DEDUPE_MS) {
                    recentBracketNotifications.delete(savedKey);
                }
            }

        try {
            new Notification(title, { body });
        } catch (error) {
            console.warn('OS notification failed:', error);
        }
    }

    function drawConnectionPath(svg, x1, y1, x2, y2) {
        const controlOffset = Math.max(28, (x2 - x1) * 0.45);
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', `M ${x1} ${y1} C ${x1 + controlOffset} ${y1}, ${x2 - controlOffset} ${y2}, ${x2} ${y2}`);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', '#6f8fbe');
        path.setAttribute('stroke-width', '2');
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('stroke-linejoin', 'round');
        svg.appendChild(path);
    }

    function getRoundNodes(roundBox) {
        return Array.from(roundBox.querySelectorAll('.match-node'));
    }

    function connectRoundPair(svg, treeRect, tree, fromRound, toRound) {
        const fromNodes = getRoundNodes(fromRound);
        const toNodes = getRoundNodes(toRound);
        if (!fromNodes.length || !toNodes.length) return;

        fromNodes.forEach((fromNode, index) => {
            const toIndex = Math.min(Math.floor(index / 2), toNodes.length - 1);
            const toNode = toNodes[toIndex];
            if (!toNode) return;

            const fromRect = fromNode.getBoundingClientRect();
            const toRect = toNode.getBoundingClientRect();

            const x1 = fromRect.right - treeRect.left + tree.scrollLeft;
            const y1 = fromRect.top + (fromRect.height / 2) - treeRect.top + tree.scrollTop;
            const x2 = toRect.left - treeRect.left + tree.scrollLeft;
            const y2 = toRect.top + (toRect.height / 2) - treeRect.top + tree.scrollTop;

            drawConnectionPath(svg, x1, y1, x2, y2);
        });
    }

    function getSortedRoundsBySide(tree) {
        const map = new Map();
        const rounds = Array.from(tree.querySelectorAll('.round-box'));

        rounds.forEach(roundBox => {
            const side = roundBox.dataset.side || 'main';
            const round = Number(roundBox.dataset.round || 1);
            if (!map.has(side)) map.set(side, []);
            map.get(side).push({ round, element: roundBox });
        });

        map.forEach((list, side) => {
            list.sort((a, b) => a.round - b.round);
            map.set(side, list.map(item => item.element));
        });

        return map;
    }

    function ensureTreeSvg(tree) {
        let svg = tree.querySelector(':scope > svg.tree-connections');
        if (!svg) {
            svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.classList.add('tree-connections');
            tree.prepend(svg);
        }

        const width = tree.scrollWidth;
        const height = tree.scrollHeight;
        svg.setAttribute('width', String(width));
        svg.setAttribute('height', String(height));
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.innerHTML = '';
        return svg;
    }

    function drawTreeConnections(tree) {
        if (!tree || tree.offsetParent === null) return;
        const svg = ensureTreeSvg(tree);
        const treeRect = tree.getBoundingClientRect();
        const grouped = getSortedRoundsBySide(tree);

        grouped.forEach(rounds => {
            for (let index = 0; index < rounds.length - 1; index += 1) {
                connectRoundPair(svg, treeRect, tree, rounds[index], rounds[index + 1]);
            }
        });

        const finals = grouped.get('final') || [];
        if (finals.length) {
            const finalRound = finals[0];
            const mains = grouped.get('main') || [];
            const losers = grouped.get('losers') || [];
            if (mains.length) {
                connectRoundPair(svg, treeRect, tree, mains[mains.length - 1], finalRound);
            }
            if (losers.length) {
                connectRoundPair(svg, treeRect, tree, losers[losers.length - 1], finalRound);
            }
        }
    }

    // PATCH: Prevent drawAllTreeConnections from resetting scrollLeft
    // PATCH: Persist bracket-tree scrollLeft using sessionStorage
    function drawAllTreeConnections() {
        document.querySelectorAll('.bracket-tree').forEach((tree, idx) => {
            // Use a unique key per bracket-tree (if multiple)
            const key = 'bracketTreeScrollLeft_' + idx;
            // Restore scrollLeft from sessionStorage if available
            const saved = sessionStorage.getItem(key);
            if (saved !== null) {
                tree.scrollLeft = Number(saved);
            }
            // Listen for user scroll and persist
            if (!tree._scrollListenerAttached) {
                tree.addEventListener('scroll', () => {
                    sessionStorage.setItem(key, tree.scrollLeft);
                }, { passive: true });
                // Mouse pointer-follow horizontal scroll
                // Drag-to-scroll with grab cursor
                let isDragging = false;
                let dragStartX = 0;
                let dragStartScroll = 0;
                tree.style.cursor = 'grab';
                tree.addEventListener('mousedown', function(e) {
                    if (e.button !== 0) return; // Only left mouse button
                    isDragging = true;
                    dragStartX = e.clientX;
                    dragStartScroll = tree.scrollLeft;
                    tree.style.cursor = 'grabbing';
                    tree.classList.add('dragging');
                    e.preventDefault();
                });
                window.addEventListener('mousemove', function(e) {
                    if (!isDragging) return;
                    const dx = e.clientX - dragStartX;
                    tree.scrollLeft = dragStartScroll - dx;
                });
                window.addEventListener('mouseup', function() {
                    if (isDragging) {
                        isDragging = false;
                        tree.style.cursor = 'grab';
                        tree.classList.remove('dragging');
                    }
                });

                // Arrow key navigation
                tree.setAttribute('tabindex', '0');
                tree.addEventListener('keydown', function(e) {
                    const scrollAmount = 80;
                    if (e.key === 'ArrowLeft') {
                        tree.scrollLeft -= scrollAmount;
                        e.preventDefault();
                    } else if (e.key === 'ArrowRight') {
                        tree.scrollLeft += scrollAmount;
                        e.preventDefault();
                    } else if (e.key === 'ArrowUp') {
                        tree.scrollTop -= scrollAmount;
                        e.preventDefault();
                    } else if (e.key === 'ArrowDown') {
                        tree.scrollTop += scrollAmount;
                        e.preventDefault();
                    }
                });
                tree._scrollListenerAttached = true;
            }
            drawTreeConnections(tree);
            // After redraw, restore scrollLeft again
            const savedAfter = sessionStorage.getItem(key);
            if (savedAfter !== null) {
                tree.scrollLeft = Number(savedAfter);
            }
        });
    }

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

    function encodeStoredValue(plainValue) {
        const text = String(plainValue ?? '');
        const encoder = new TextEncoder();
        const valueBytes = encoder.encode(text);
        const keyBytes = encoder.encode(STORAGE_ENC_SECRET);
        const encrypted = new Uint8Array(valueBytes.length);
        for (let index = 0; index < valueBytes.length; index += 1) {
            encrypted[index] = valueBytes[index] ^ keyBytes[index % keyBytes.length];
        }

        let binary = '';
        for (let index = 0; index < encrypted.length; index += 1) {
            binary += String.fromCharCode(encrypted[index]);
        }
        return `${STORAGE_ENC_PREFIX}${btoa(binary)}`;
    }

    function getCurrentHandle() {
        return String(decodeStoredValue(localStorage.getItem(OWNER_KEY) || '') || '').trim();
    }

    function isAdminHandle(handle) {
        return ADMIN_HANDLES.has(String(handle || '').trim().toLowerCase());
    }

    function getSelectedType() {
        const selected = document.querySelector('input[name="tournamentType"]:checked');
        return selected ? selected.value : 'round-robin';
    }

    function parseParticipants() {
        const lines = participantsInput.value
            .split(/\r?\n/)
            .map(item => item.trim())
            .filter(Boolean);

        return Array.from(new Set(lines));
    }

    function shuffleList(items) {
        const shuffled = [...items];
        for (let index = shuffled.length - 1; index > 0; index -= 1) {
            const swapIndex = Math.floor(Math.random() * (index + 1));
            [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
        }
        return shuffled;
    }

    function showShuffledPreview(names) {
        if (!shuffledNamesPreview) return;
        if (!Array.isArray(names) || names.length === 0) {
            shuffledNamesPreview.style.display = 'none';
            shuffledNamesPreview.textContent = '';
            return;
        }

        const numbered = names.map((name, index) => `${index + 1}. ${name}`).join('\n');
        shuffledNamesPreview.textContent = `Shuffled Order:\n${numbered}`;
        shuffledNamesPreview.style.display = 'block';
    }

    function shuffleParticipants() {
        const participants = parseParticipants();
        if (participants.length < 2) {
            alert('Please add at least 2 names to shuffle.');
            return;
        }

        const shuffled = shuffleList(participants);
        participantsInput.value = shuffled.join('\n');
        showShuffledPreview(shuffled);
    }

    function selectTypeCard(value) {
        document.querySelectorAll('.type-card').forEach(card => {
            card.classList.toggle('selected', card.dataset.type === value);
            const input = card.querySelector('input');
            if (input) input.checked = card.dataset.type === value;
        });
    }

    function groupMatches(matches, bracketType = 'single-elimination') {
        const grouped = new Map();
        let maxRound = 1;
        for (const match of matches || []) {
            const side = match.bracketSide || 'main';
            const round = match.round || 1;
            if (round > maxRound) maxRound = round;
            const key = `${side}:R${round}`;
            if (!grouped.has(key)) {
                grouped.set(key, {
                    side,
                    round,
                    matches: []
                });
            }
            grouped.get(key).matches.push(match);
        }

        // Assign round titles
        const roundNames = [null, 'Final', 'Semifinal', 'Quarterfinal', 'Round of 8', 'Round of 16', 'Round of 32', 'Round of 64'];
        const result = Array.from(grouped.values()).sort((a, b) => {
            if (a.side !== b.side) return a.side.localeCompare(b.side);
            return a.round - b.round;
        });
        result.forEach(group => {
            if (bracketType === 'single-elimination' && group.side === 'main') {
                const roundIdx = maxRound - group.round + 1;
                group.title = roundNames[roundIdx] || `Round ${group.round}`;
            } else {
                group.title = `${group.side === 'main' ? 'Main' : group.side === 'losers' ? 'Losers' : 'Final'} · Round ${group.round}`;
            }
        });
        return result;
    }

    function getRoundColorVars(round) {
        const palette = [
            { border: '#2f4a72', top: 'rgba(110, 168, 254, 0.16)', bottom: 'rgba(110, 168, 254, 0.04)' },
            { border: '#30543f', top: 'rgba(90, 203, 138, 0.15)', bottom: 'rgba(90, 203, 138, 0.04)' },
            { border: '#5a4377', top: 'rgba(198, 123, 243, 0.18)', bottom: 'rgba(198, 123, 243, 0.05)' },
            { border: '#6b5331', top: 'rgba(255, 184, 106, 0.2)', bottom: 'rgba(255, 184, 106, 0.06)' },
            { border: '#5a3f4c', top: 'rgba(255, 125, 125, 0.16)', bottom: 'rgba(255, 125, 125, 0.05)' },
            { border: '#3e5460', top: 'rgba(102, 217, 239, 0.16)', bottom: 'rgba(102, 217, 239, 0.05)' }
        ];

        const index = Math.max(0, (Number(round) || 1) - 1) % palette.length;
        return palette[index];
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function getRankClassByMaxRating(maxRating) {
        const value = Number(maxRating);
        if (!Number.isFinite(value)) return 'rank-newbie';
        if (value >= 3000) return 'rank-lgm';
        if (value >= 2600) return 'rank-gm';
        if (value >= 2300) return 'rank-im';
        if (value >= 2100) return 'rank-master';
        if (value >= 1900) return 'rank-cm';
        if (value >= 1600) return 'rank-expert';
        if (value >= 1400) return 'rank-specialist';
        if (value >= 1200) return 'rank-pupil';
        return 'rank-newbie';
    }

    function isPlaceholderMatch(match) {
        return /winner|loser|champion|slot/i.test(`${match.p1} ${match.p2}`);
    }

    function isConcreteHandle(handle) {
        const text = String(handle || '').trim();
        if (!text) return false;
        return !/winner|loser|champion|slot|bye/i.test(text);
    }

    function normalizeHandleToken(value) {
        return String(value || '').trim().toLowerCase();
    }

    function computeBracketStandings(bracket) {
        const participants = Array.isArray(bracket?.participants) ? bracket.participants : [];
        const rows = participants.map(handle => ({
            handle,
            played: 0,
            wins: 0,
            losses: 0,
            ties: 0,
            points: 0,
            tieBreakStatus: 'Clear'
        }));

        const rowMap = new Map(rows.map(item => [String(item.handle).toLowerCase(), item]));

        (bracket?.matches || []).forEach(match => {
            if (match?.status !== 'completed' || !match?.result) return;
            const left = String(match.p1 || '');
            const right = String(match.p2 || '');
            if (!isConcreteHandle(left) || !isConcreteHandle(right)) return;

            const leftKey = left.toLowerCase();
            const rightKey = right.toLowerCase();
            const leftRow = rowMap.get(leftKey);
            const rightRow = rowMap.get(rightKey);
            if (!leftRow || !rightRow) return;

            const leftScore = Number(match?.result?.player1Score) || 0;
            const rightScore = Number(match?.result?.player2Score) || 0;
            const winner = String(match?.winner || '').toLowerCase();

            leftRow.played += 1;
            rightRow.played += 1;
            leftRow.points += leftScore;
            rightRow.points += rightScore;

            if (winner === 'tie') {
                leftRow.ties += 1;
                rightRow.ties += 1;
            } else if (winner === leftKey) {
                leftRow.wins += 1;
                rightRow.losses += 1;
            } else if (winner === rightKey) {
                rightRow.wins += 1;
                leftRow.losses += 1;
            }
        });

        rows.sort((a, b) => {
            if (b.wins !== a.wins) return b.wins - a.wins;
            if (b.points !== a.points) return b.points - a.points;
            return a.handle.localeCompare(b.handle);
        });

        const groups = new Map();
        rows.forEach(row => {
            const key = `${row.wins}:${row.points}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(row);
        });

        const winsGroups = new Map();
        rows.forEach(row => {
            if (!winsGroups.has(row.wins)) winsGroups.set(row.wins, []);
            winsGroups.get(row.wins).push(row);
        });

        rows.forEach(row => {
            const exact = groups.get(`${row.wins}:${row.points}`) || [];
            if (exact.length > 1) {
                row.tieBreakStatus = 'Still tied';
                return;
            }

            const sameWins = winsGroups.get(row.wins) || [];
            if (sameWins.length > 1) {
                row.tieBreakStatus = 'By points';
                return;
            }

            row.tieBreakStatus = 'Clear';
        });

        return rows;
    }

    function renderStandingsPanel(bracket, ratingsMap) {
        const standings = computeBracketStandings(bracket);
        if (!standings.length) {
            return '<div class="standings-panel"><h4>Standings</h4><p class="note">No participants found.</p></div>';
        }

        const rowsHtml = standings.map((row, index) => `
            <tr>
                <td>${index + 1}</td>
                <td>${renderPlayer(row.handle, ratingsMap)}</td>
                <td>${row.played}</td>
                <td>${row.wins}</td>
                <td>${row.points}</td>
                <td>${row.tieBreakStatus}</td>
            </tr>
        `).join('');

        return `
            <div class="standings-panel">
                <h4>Standings</h4>
                <div class="standings-table-wrap">
                    <table class="standings-table">
                        <thead>
                            <tr>
                                <th>#</th>
                                <th>Handle</th>
                                <th>P</th>
                                <th>W</th>
                                <th>Pts</th>
                                <th>Tie-break</th>
                            </tr>
                        </thead>
                        <tbody>${rowsHtml}</tbody>
                    </table>
                </div>
            </div>
        `;
    }

    function getAllConcreteHandles(brackets) {
        const handles = new Set();
        (brackets || []).forEach(bracket => {
            (bracket.matches || []).forEach(match => {
                [match.p1, match.p2].forEach(handle => {
                    if (!handle) return;
                    if (/winner|loser|champion|slot|bye/i.test(handle)) return;
                    handles.add(handle);
                });
            });
        });
        return Array.from(handles);
    }

    async function fetchRatingsMap(handles) {
        const map = new Map();
        if (!Array.isArray(handles) || handles.length === 0) return map;

        const chunkSize = 100;
        for (let index = 0; index < handles.length; index += chunkSize) {
            const chunk = handles.slice(index, index + chunkSize);
            try {
                const response = await fetch(`https://codeforces.com/api/user.info?handles=${encodeURIComponent(chunk.join(';'))}`);
                const data = await response.json();
                if (data.status !== 'OK' || !Array.isArray(data.result)) continue;

                data.result.forEach(user => {
                    map.set(user.handle, {
                        rating: user.rating ?? null,
                        maxRating: user.maxRating ?? null
                    });
                    map.set(String(user.handle || '').toLowerCase(), {
                        rating: user.rating ?? null,
                        maxRating: user.maxRating ?? null
                    });
                });
            } catch (error) {
                console.warn('Rating lookup failed for chunk', chunk, error);
            }
        }

        return map;
    }

    function renderPlayer(handle, ratingsMap) {
        if (!handle) return 'TBD';
        if (/winner|loser|champion|slot|bye/i.test(handle)) {
            return escapeHtml(handle);
        }

        const profile = ratingsMap?.get(handle) || ratingsMap?.get(String(handle).toLowerCase()) || null;
        const safeHandle = escapeHtml(handle);
        const currentRating = profile?.rating;
        const maxRating = profile?.maxRating;
        const rankClass = getRankClassByMaxRating(maxRating);
        const currentText = Number.isFinite(Number(currentRating)) ? Number(currentRating) : '-';
        const ultraLegendary = Number(maxRating) >= 4000;
        const legendary = Number(maxRating) >= 3000;
        const firstChar = safeHandle.charAt(0);
        const restChars = safeHandle.slice(1);
        let handleHtml = `<span class="player-handle-max ${rankClass}">${safeHandle}</span>`;
        if (safeHandle.length > 1 && ultraLegendary) {
            handleHtml = `<span class="player-handle-ultra-first">${firstChar}</span><span class="player-handle-ultra-rest">${restChars}</span>`;
        } else if (safeHandle.length > 1 && legendary) {
            handleHtml = `<span class="player-handle-legendary-first">${firstChar}</span><span class="player-handle-legendary-rest">${restChars}</span>`;
        }

        // Wrap handleHtml in a link to Codeforces profile
        const cfProfileUrl = `https://codeforces.com/profile/${encodeURIComponent(safeHandle)}`;
        const handleLink = `<a href="${cfProfileUrl}" class="player-handle-link" target="_blank" rel="noopener noreferrer">${handleHtml}</a>`;

        return `
            <span class="player-chip">
                ${handleLink}
                <span class="player-current-rating">current rating ${currentText}</span>
            </span>
        `;
    }

    function getMatchHistoryUrl(match) {
        if (!match?.roomId) return 'results.html';
        return `results.html?roomId=${encodeURIComponent(match.roomId)}`;
    }

    function getMatchPointsSummary(match) {
        const p1 = match?.result?.player1Score;
        const p2 = match?.result?.player2Score;
        const left = Number.isFinite(Number(p1)) ? Number(p1) : null;
        const right = Number.isFinite(Number(p2)) ? Number(p2) : null;

        if (left === null && right === null) {
            return `${match?.p1 || 'P1'}: - · ${match?.p2 || 'P2'}: -`;
        }

        return `${match?.p1 || 'P1'}: ${left ?? '-'} · ${match?.p2 || 'P2'}: ${right ?? '-'}`;
    }

    async function renderBracketPreview(bracket) {
        outputPanel.style.display = 'block';
        outputTitle.textContent = `${bracket.name} · ${String(bracket.type).replace('-', ' ').replace(/\b\w/g, c => c.toUpperCase())}`;
        const roomConfig = bracket.roomConfig || { problemCount: 7, duration: 40, interval: 1, problems: [] };
        outputMeta.textContent = `${bracket.participants.length} participants · Owner: ${bracket.ownerHandle} · ${roomConfig.problemCount} problems · ${roomConfig.duration}m · ${roomConfig.interval}s check`;

        const ratingsMap = await fetchRatingsMap(getAllConcreteHandles([bracket]));

        const groups = groupMatches(bracket.matches || [], bracket.type);
        const standingsHtml = renderStandingsPanel(bracket, ratingsMap);
        const html = groups.map(group => {
            const roundColors = getRoundColorVars(group.round);
            const matches = group.matches.map(match => {
                const status = match.status === 'completed'
                    ? `Winner: ${match.winner || '-'}`
                    : match.roomId
                        ? `Room: ${match.roomId}`
                        : 'Pending';

                const p1Text = renderPlayer(match.p1, ratingsMap);
                const p2Text = renderPlayer(match.p2, ratingsMap);
                const historyUrl = getMatchHistoryUrl(match);
                const pointsText = getMatchPointsSummary(match);

                return `
                    <div class="match-node">
                        <div class="match-card">
                            <div class="match-head">
                                <span>${match.label || ''}</span>
                                <span>${status}</span>
                            </div>
                            <div class="team-row"><span>${p1Text}</span></div>
                            <div class="vs-row">vs</div>
                            <div class="team-row"><span>${p2Text}</span></div>
                            <div class="match-points">Points: ${pointsText}</div>
                            <a class="match-history-link" href="${historyUrl}" target="_blank" rel="noopener noreferrer">History</a>
                        </div>
                    </div>
                `;
            }).join('');

            return `
                <div class="round-box" data-round="${group.round}" data-side="${group.side}" style="--round-border:${roundColors.border};--round-bg-top:${roundColors.top};--round-bg-bottom:${roundColors.bottom};">
                    <h4>${group.title}</h4>
                    <div class="round-matches">${matches}</div>
                </div>
            `;
        }).join('');

        outputContent.innerHTML = `
            <div class="bracket-layout">
                <div class="bracket-tree">${html}</div>
                ${standingsHtml}
            </div>
        `;
        drawAllTreeConnections();
    }

    function showEmptySavedState() {
        savedBracketsList.innerHTML = '<p class="note">No brackets yet. Create one above.</p>';
    }

    async function loadBrackets() {
        try {
            const response = await fetch(`${API_BASE_URL}/api/brackets`);
            const brackets = await response.json();
            if (!Array.isArray(brackets) || brackets.length === 0) {
                showEmptySavedState();
                return;
            }

            const ratingsMap = await fetchRatingsMap(getAllConcreteHandles(brackets));

            const myHandle = getCurrentHandle();
            const cards = brackets.map(bracket => {
                const isExpanded = expandedBracketIds.has(bracket.id);
                const groups = groupMatches(bracket.matches || []);
                const standingsHtml = renderStandingsPanel(bracket, ratingsMap);
                const matchesHtml = groups.map(group => {
                    const roundColors = getRoundColorVars(group.round);
                    const items = group.matches.map(match => {
                        const ready = !isPlaceholderMatch(match);
                        const completed = match.status === 'completed';
                        const mine = normalizeHandleToken(myHandle);
                        const p1 = normalizeHandleToken(match.p1);
                        const p2 = normalizeHandleToken(match.p2);
                        const canCreateMatchRoom = !!mine && (isAdminHandle(myHandle) || mine === p1 || mine === p2);
                        const createDisabled = !ready || completed || !canCreateMatchRoom;
                        const createLabel = completed
                            ? `Winner: ${match.winner || '-'}`
                            : match.roomId
                                ? `Open Room ${match.roomId}`
                                : 'Create Match Room';

                        const p1Text = renderPlayer(match.p1, ratingsMap);
                        const p2Text = renderPlayer(match.p2, ratingsMap);
                        const historyUrl = getMatchHistoryUrl(match);
                        const pointsText = getMatchPointsSummary(match);

                        return `
                            <div class="match-node">
                                <div class="match-card" data-bracket-id="${bracket.id}" data-match-id="${match.id}">
                                    <div class="match-head">
                                        <span>${match.label || ''}</span>
                                        <span>${completed ? 'Completed' : 'Pending'}</span>
                                    </div>
                                    <div class="team-row"><span>${p1Text}</span></div>
                                    <div class="vs-row">vs</div>
                                    <div class="team-row"><span>${p2Text}</span></div>
                                    <div class="match-points">Points: ${pointsText}</div>
                                    <div class="saved-actions" style="margin-top:8px;">
                                        <button class="small-btn primary create-room-btn" ${createDisabled ? 'disabled' : ''}>
                                            ${createLabel}
                                        </button>
                                        <a class="small-btn match-history-link-btn" href="${historyUrl}" target="_blank" rel="noopener noreferrer">History</a>
                                    </div>
                                </div>
                            </div>
                        `;
                    }).join('');

                    return `
                        <div class="round-box" data-round="${group.round}" data-side="${group.side}" style="--round-border:${roundColors.border};--round-bg-top:${roundColors.top};--round-bg-bottom:${roundColors.bottom};margin-bottom:8px;">
                            <h4>${group.title}</h4>
                            <div class="round-matches">${items}</div>
                        </div>
                    `;
                }).join('');

                const canDeleteAsOwner = myHandle && bracket.ownerHandle === myHandle;
                const canDelete = !!canDeleteAsOwner || isAdminHandle(myHandle);

                return `
                    <div class="saved-card" data-bracket-card-id="${bracket.id}">
                        <div class="saved-head saved-toggle" data-bracket-id="${bracket.id}" role="button" tabindex="0">
                            <div>
                                <strong>${bracket.name}</strong>
                            </div>
                            <div class="saved-actions">
                                <span class="saved-expand">${isExpanded ? 'Collapse' : 'Expand'}</span>
                                ${canDelete ? `
                                <button class="small-btn delete-bracket-btn ${canDeleteAsOwner ? 'danger' : ''}" data-bracket-id="${bracket.id}">
                                    Delete Bracket
                                </button>
                                ` : ''}
                            </div>
                        </div>
                        <div class="saved-details" style="display:${isExpanded ? 'block' : 'none'};">
                            <div class="saved-meta" style="margin-bottom:10px;">${bracket.type} · ${bracket.participants.length} participants · Owner: ${bracket.ownerHandle} · ${(bracket.roomConfig?.problemCount ?? bracket.roomConfig?.problems?.length ?? 7)} problems · ${(bracket.roomConfig?.duration ?? 40)}m · ${(bracket.roomConfig?.interval ?? 1)}s check</div>
                            <div class="bracket-layout">
                                <div class="bracket-tree">${matchesHtml}</div>
                                ${standingsHtml}
                            </div>
                        </div>
                    </div>
                `;
            }).join('');

            savedBracketsList.innerHTML = cards;
            drawAllTreeConnections();
        } catch (error) {
            console.error('Failed to load brackets:', error);
            savedBracketsList.innerHTML = '<p class="note">Could not load brackets right now.</p>';
        }
    }

    async function generateBracket() {
        const ownerHandle = getCurrentHandle();
        if (!ownerHandle) {
            alert('Please login first on Arena page.');
            return;
        }

        const participants = parseParticipants();
        if (participants.length < 2) {
            alert('Please add at least 2 participants.');
            return;
        }

        const payload = {
            name: tournamentName.value.trim() || 'Tournament',
            type: getSelectedType(),
            participants,
            roomConfig: getBracketRoomConfigFromInputs()
        };

        const response = await fetch(`${API_BASE_URL}/api/brackets`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await response.json();
        if (!response.ok) {
            alert(data.error || 'Failed to create bracket');
            return;
        }

        renderBracketPreview(data);
        await loadBrackets();
    }

    async function deleteBracket(bracketId) {
        const requesterHandle = getCurrentHandle();
        if (!requesterHandle) {
            alert('Please login first on Arena page.');
            return;
        }

        let response = await fetch(`${API_BASE_URL}/api/brackets/${encodeURIComponent(bracketId)}`, {
            method: 'DELETE'
        });

        if (response.status === 403 && isAdminHandle(requesterHandle)) {
            const adminPassword = prompt('Admin PIN required to delete bracket:');
            if (!adminPassword) return;

            response = await fetch(`${API_BASE_URL}/api/brackets/${encodeURIComponent(bracketId)}`, {
                method: 'DELETE',
                headers: {
                    'Content-Type': 'application/json',
                    'x-admin-password': adminPassword
                },
                body: JSON.stringify({ password: adminPassword })
            });
        }

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            if (response.status === 403 && !isAdminHandle(requesterHandle)) {
                alert('Only admin can delete this bracket.');
                return;
            }
            alert(data.error || 'Could not delete bracket');
            return;
        }

        expandedBracketIds.delete(bracketId);

        await loadBrackets();
    }

    async function createRoomFromMatch(bracketId, matchId) {
        const requesterHandle = getCurrentHandle();
        if (!requesterHandle) {
            alert('Please login first on Arena page.');
            return;
        }

        let response = await fetch(`${API_BASE_URL}/api/brackets/${encodeURIComponent(bracketId)}/matches/${encodeURIComponent(matchId)}/create-room`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });

        if (response.status === 403 && isAdminHandle(requesterHandle)) {
            const adminPassword = prompt('Admin PIN required to create room for this match:');
            if (!adminPassword) return;

            response = await fetch(`${API_BASE_URL}/api/brackets/${encodeURIComponent(bracketId)}/matches/${encodeURIComponent(matchId)}/create-room`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-admin-password': adminPassword
                },
                body: JSON.stringify({ password: adminPassword })
            });
        }

        const data = await response.json();
        if (!response.ok) {
            if (response.status === 403 && !isAdminHandle(requesterHandle)) {
                alert('Only assigned match players or admin can create this room.');
                return;
            }
            alert(data.error || 'Could not create room for this match');
            return;
        }

        const roomId = data.roomId;
        showOsNotification('Bracket Match Room Ready', `Room ${roomId} created. Redirecting to Arena.`);
        localStorage.setItem('blitzPendingJoinRoomId', encodeStoredValue(roomId));
        window.location.href = 'index.html#roomControls';
    }

    typeGrid.addEventListener('click', (event) => {
        const card = event.target.closest('.type-card');
        if (!card) return;
        selectTypeCard(card.dataset.type);
    });

    generateBracketBtn.addEventListener('click', () => {
        generateBracket().catch(error => {
            console.error('Generate bracket failed:', error);
            alert('Could not generate bracket right now.');
        });
    });

    if (shuffleNamesBtn) {
        shuffleNamesBtn.addEventListener('click', () => {
            shuffleParticipants();
        });
    }

    if (bracketAddProblemBtn) {
        bracketAddProblemBtn.addEventListener('click', () => {
            const lastPoints = bracketProblems.length > 0 ? Number(bracketProblems[bracketProblems.length - 1].points) || 0 : 0;
            const lastRating = bracketProblems.length > 0 ? Number(bracketProblems[bracketProblems.length - 1].rating) || 800 : 800;
            bracketProblems.push({
                points: Math.max(1, lastPoints + 2),
                rating: Math.min(3500, lastRating + 100)
            });
            renderBracketProblems(bracketProblems.length - 1);
        });
    }

    participantsInput.addEventListener('input', () => {
        if (shuffledNamesPreview && shuffledNamesPreview.style.display !== 'none') {
            shuffledNamesPreview.style.display = 'none';
            shuffledNamesPreview.textContent = '';
        }
    });

    savedBracketsList.addEventListener('click', (event) => {
        const toggleHead = event.target.closest('.saved-toggle');
        if (toggleHead && !event.target.closest('.delete-bracket-btn')) {
            const card = toggleHead.closest('.saved-card');
            if (!card) return;

            const details = card.querySelector('.saved-details');
            const expandText = card.querySelector('.saved-expand');
            if (!details) return;

            const isOpen = details.style.display !== 'none';
            details.style.display = isOpen ? 'none' : 'block';
            const bracketId = toggleHead.dataset.bracketId;
            if (bracketId) {
                if (isOpen) {
                    expandedBracketIds.delete(bracketId);
                } else {
                    expandedBracketIds.add(bracketId);
                }
            }
            if (expandText) {
                expandText.textContent = isOpen ? 'Expand' : 'Collapse';
            }
            drawAllTreeConnections();
            return;
        }

        const deleteBtn = event.target.closest('.delete-bracket-btn');
        if (deleteBtn) {
            const bracketId = deleteBtn.dataset.bracketId;
            if (!bracketId) return;
            if (!confirm('Delete this bracket?')) return;
            deleteBracket(bracketId).catch(error => {
                console.error('Delete bracket failed:', error);
            });
            return;
        }

        const createBtn = event.target.closest('.create-room-btn');
        if (createBtn) {
            const card = createBtn.closest('.match-card');
            if (!card) return;
            const bracketId = card.dataset.bracketId;
            const matchId = card.dataset.matchId;
            createRoomFromMatch(bracketId, matchId).catch(error => {
                console.error('Create room from match failed:', error);
            });
        }
    });

    loadBrackets();
    renderBracketProblems();
    ensureNotificationPermission();
    window.addEventListener('resize', () => {
        drawAllTreeConnections();
    });
    setInterval(() => {
        loadBrackets().catch(() => {});
    }, 5000);
})();
