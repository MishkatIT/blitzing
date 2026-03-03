(function () {
    const API_BASE_URL = window.location.origin;
    const OWNER_KEY = 'blitzUserHandle';

    const typeGrid = document.getElementById('typeGrid');
    const generateBracketBtn = document.getElementById('generateBracketBtn');
    const participantsInput = document.getElementById('participantsInput');
    const shuffleNamesBtn = document.getElementById('shuffleNamesBtn');
    const shuffledNamesPreview = document.getElementById('shuffledNamesPreview');
    const tournamentName = document.getElementById('tournamentName');
    const outputPanel = document.getElementById('outputPanel');
    const outputTitle = document.getElementById('outputTitle');
    const outputMeta = document.getElementById('outputMeta');
    const outputContent = document.getElementById('outputContent');
    const savedBracketsList = document.getElementById('savedBracketsList');
    const expandedBracketIds = new Set();

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

    function drawAllTreeConnections() {
        document.querySelectorAll('.bracket-tree').forEach(tree => drawTreeConnections(tree));
    }

    function getCurrentHandle() {
        return (localStorage.getItem(OWNER_KEY) || '').trim();
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

    function groupMatches(matches) {
        const grouped = new Map();
        for (const match of matches || []) {
            const side = match.bracketSide || 'main';
            const key = `${side}:R${match.round || 1}`;
            if (!grouped.has(key)) {
                grouped.set(key, {
                    side,
                    round: match.round || 1,
                    title: `${side === 'main' ? 'Main' : side === 'losers' ? 'Losers' : 'Final'} · Round ${match.round || 1}`,
                    matches: []
                });
            }
            grouped.get(key).matches.push(match);
        }

        return Array.from(grouped.values()).sort((a, b) => {
            if (a.side !== b.side) return a.side.localeCompare(b.side);
            return a.round - b.round;
        });
    }

    function isPlaceholderMatch(match) {
        return /winner|loser|champion|slot/i.test(`${match.p1} ${match.p2}`);
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
            return handle;
        }

        const profile = ratingsMap?.get(handle);
        if (!profile || profile.rating === null || profile.rating === undefined) {
            return handle;
        }

        return `${handle} (${profile.rating})`;
    }

    async function renderBracketPreview(bracket) {
        outputPanel.style.display = 'block';
        outputTitle.textContent = `${bracket.name} · ${String(bracket.type).replace('-', ' ').replace(/\b\w/g, c => c.toUpperCase())}`;
        outputMeta.textContent = `${bracket.participants.length} participants · Owner: ${bracket.ownerHandle}`;

        const ratingsMap = await fetchRatingsMap(getAllConcreteHandles([bracket]));

        const groups = groupMatches(bracket.matches || []);
        const html = groups.map(group => {
            const matches = group.matches.map(match => {
                const status = match.status === 'completed'
                    ? `Winner: ${match.winner || '-'}`
                    : match.roomId
                        ? `Room: ${match.roomId}`
                        : 'Pending';

                const p1Text = renderPlayer(match.p1, ratingsMap);
                const p2Text = renderPlayer(match.p2, ratingsMap);

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
                        </div>
                    </div>
                `;
            }).join('');

            return `
                <div class="round-box" data-round="${group.round}" data-side="${group.side}">
                    <h4>${group.title}</h4>
                    <div class="round-matches">${matches}</div>
                </div>
            `;
        }).join('');

        outputContent.innerHTML = `<div class="bracket-tree">${html}</div>`;
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
                const matchesHtml = groups.map(group => {
                    const items = group.matches.map(match => {
                        const ready = !isPlaceholderMatch(match);
                        const completed = match.status === 'completed';
                        const createDisabled = !ready || completed;
                        const createLabel = completed
                            ? `Winner: ${match.winner || '-'}`
                            : match.roomId
                                ? `Open Room ${match.roomId}`
                                : 'Create Match Room';

                        const p1Text = renderPlayer(match.p1, ratingsMap);
                        const p2Text = renderPlayer(match.p2, ratingsMap);

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
                                    <div class="saved-actions" style="margin-top:8px;">
                                        <button class="small-btn primary create-room-btn" ${createDisabled ? 'disabled' : ''}>
                                            ${createLabel}
                                        </button>
                                    </div>
                                </div>
                            </div>
                        `;
                    }).join('');

                    return `
                        <div class="round-box" data-round="${group.round}" data-side="${group.side}" style="margin-bottom:8px;">
                            <h4>${group.title}</h4>
                            <div class="round-matches">${items}</div>
                        </div>
                    `;
                }).join('');

                const canDeleteAsOwner = myHandle && bracket.ownerHandle === myHandle;

                return `
                    <div class="saved-card" data-bracket-card-id="${bracket.id}">
                        <div class="saved-head saved-toggle" data-bracket-id="${bracket.id}" role="button" tabindex="0">
                            <div>
                                <strong>${bracket.name}</strong>
                            </div>
                            <div class="saved-actions">
                                <span class="saved-expand">${isExpanded ? 'Collapse' : 'Expand'}</span>
                                <button class="small-btn delete-bracket-btn ${canDeleteAsOwner ? 'danger' : ''}" data-bracket-id="${bracket.id}">
                                    Delete Bracket
                                </button>
                            </div>
                        </div>
                        <div class="saved-details" style="display:${isExpanded ? 'block' : 'none'};">
                            <div class="saved-meta" style="margin-bottom:10px;">${bracket.type} · ${bracket.participants.length} participants · Owner: ${bracket.ownerHandle}</div>
                            <div class="bracket-tree">${matchesHtml}</div>
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
            alert('Please set your handle first on Arena page.');
            return;
        }

        const participants = parseParticipants();
        if (participants.length < 2) {
            alert('Please add at least 2 participants.');
            return;
        }

        const payload = {
            ownerHandle,
            name: tournamentName.value.trim() || 'Tournament',
            type: getSelectedType(),
            participants
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
        const tryDelete = async (adminPassword = '') => {
            return fetch(`${API_BASE_URL}/api/brackets/${encodeURIComponent(bracketId)}?requesterHandle=${encodeURIComponent(requesterHandle)}`, {
                method: 'DELETE',
                headers: adminPassword ? { 'x-admin-password': adminPassword, 'Content-Type': 'application/json' } : undefined,
                body: adminPassword ? JSON.stringify({ password: adminPassword }) : undefined
            });
        };

        let response = await tryDelete();
        if (response.status === 403) {
            const adminPassword = prompt('Only creator/admin can delete. Enter admin password:');
            if (!adminPassword) return;
            response = await tryDelete(adminPassword);
        }

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            alert(data.error || 'Could not delete bracket');
            return;
        }

        expandedBracketIds.delete(bracketId);

        await loadBrackets();
    }

    async function createRoomFromMatch(bracketId, matchId) {
        const requesterHandle = getCurrentHandle();
        if (!requesterHandle) {
            alert('Please set your handle first on Arena page.');
            return;
        }

        const response = await fetch(`${API_BASE_URL}/api/brackets/${encodeURIComponent(bracketId)}/matches/${encodeURIComponent(matchId)}/create-room`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requesterHandle })
        });

        const data = await response.json();
        if (!response.ok) {
            alert(data.error || 'Could not create room for this match');
            return;
        }

        const roomId = data.roomId;
        localStorage.setItem('blitzPendingJoinRoomId', roomId);
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
    window.addEventListener('resize', () => {
        drawAllTreeConnections();
    });
    setInterval(() => {
        loadBrackets().catch(() => {});
    }, 5000);
})();
