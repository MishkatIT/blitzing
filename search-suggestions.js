(function () {
    const API_BASE_URL = window.location.origin;

    const handleInputIds = [
        'searchHandleInput',
        'profileHandleInput',
        'handleOneInput',
        'handleTwoInput',
        'userHandleInput',
        'opponentHandleInput',
        'startP1HandleInput',
        'startP2HandleInput',
        'participantsInput'
    ];

    const roomInputIds = [
        'joinRoomIdInput',
        'activeRoomsSearchInput'
    ];

    const nameInputIds = [
        'roomNameInput',
        'tournamentName'
    ];

    const textareaHandleIds = [
        'participantsInput'
    ];

    function ensureDatalist(id) {
        let datalist = document.getElementById(id);
        if (datalist) return datalist;

        datalist = document.createElement('datalist');
        datalist.id = id;
        document.body.appendChild(datalist);
        return datalist;
    }

    function attachListToInputs(ids, listId) {
        ids.forEach(id => {
            const input = document.getElementById(id);
            if (!input) return;
            if (input.tagName === 'TEXTAREA') return;
            if (!input.getAttribute('list')) {
                input.setAttribute('list', listId);
            }
        });
    }

    function uniqueSorted(values) {
        return Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b));
    }

    async function fetchResults() {
        const response = await fetch(`${API_BASE_URL}/api/results`);
        const data = await response.json();
        return Array.isArray(data) ? data : [];
    }

    async function fetchBrackets() {
        try {
            const response = await fetch(`${API_BASE_URL}/api/brackets`);
            const data = await response.json();
            return Array.isArray(data) ? data : [];
        } catch {
            return [];
        }
    }

    async function fetchProfiles() {
        try {
            const response = await fetch(`${API_BASE_URL}/api/profiles`);
            const data = await response.json();
            return Array.isArray(data)
                ? data.map(item => String(item || '').trim()).filter(Boolean)
                : [];
        } catch {
            return [];
        }
    }

    function buildSuggestions(results, brackets, profiles) {
        const handles = [];
        const roomIds = [];
        const names = [];

        for (const match of results) {
            handles.push(String(match?.player1?.handle || '').trim());
            handles.push(String(match?.player2?.handle || '').trim());
            roomIds.push(String(match?.roomId || '').trim());
        }

        for (const bracket of brackets) {
            names.push(String(bracket?.name || '').trim());
            handles.push(String(bracket?.ownerHandle || '').trim());
            if (Array.isArray(bracket?.participants)) {
                bracket.participants.forEach(handle => handles.push(String(handle || '').trim()));
            }
        }

        if (Array.isArray(profiles)) {
            profiles.forEach(handle => handles.push(String(handle || '').trim()));
        }

        return {
            handles: uniqueSorted(handles),
            roomIds: uniqueSorted(roomIds),
            names: uniqueSorted(names)
        };
    }

    function fillDatalist(datalist, values) {
        datalist.innerHTML = values
            .map(value => `<option value="${value}"></option>`)
            .join('');
    }

    function ensureTextareaSuggestionStyles() {
        if (document.getElementById('siteTextareaSuggestionStyles')) return;
        const style = document.createElement('style');
        style.id = 'siteTextareaSuggestionStyles';
        style.textContent = `
            .site-textarea-suggest-box {
                position: fixed;
                z-index: 9999;
                min-width: 220px;
                max-width: 360px;
                max-height: 220px;
                overflow-y: auto;
                border: 1px solid rgba(120, 140, 170, 0.45);
                border-radius: 10px;
                background: #121720;
                box-shadow: 0 10px 28px rgba(0,0,0,0.35);
                padding: 4px;
            }

            .site-textarea-suggest-item {
                display: block;
                width: 100%;
                border: none;
                background: transparent;
                color: #d9e2f2;
                text-align: left;
                padding: 7px 9px;
                border-radius: 8px;
                cursor: pointer;
                font-size: 0.9rem;
            }

            .site-textarea-suggest-item:hover,
            .site-textarea-suggest-item.active {
                background: rgba(110, 168, 254, 0.18);
            }
        `;
        document.head.appendChild(style);
    }

    function attachTextareaSuggestions(textarea, values) {
        if (!textarea || !Array.isArray(values) || values.length === 0) return;
        ensureTextareaSuggestionStyles();

        let popup = null;
        let activeIndex = -1;
        let shownItems = [];
        let suppressNextRefresh = false;

        function closePopup() {
            if (popup) {
                popup.remove();
                popup = null;
            }
            activeIndex = -1;
            shownItems = [];
        }

        function getCurrentLineInfo() {
            const value = textarea.value || '';
            const caret = textarea.selectionStart || 0;
            const lineStart = value.lastIndexOf('\n', Math.max(0, caret - 1)) + 1;
            const nextNewLine = value.indexOf('\n', caret);
            const lineEnd = nextNewLine === -1 ? value.length : nextNewLine;
            const lineText = value.slice(lineStart, lineEnd);
            return { value, caret, lineStart, lineEnd, lineText };
        }

        function applySuggestion(selected) {
            const info = getCurrentLineInfo();
            const before = info.value.slice(0, info.lineStart);
            const after = info.value.slice(info.lineEnd);
            textarea.value = `${before}${selected}${after}`;
            const nextPos = info.lineStart + selected.length;
            textarea.setSelectionRange(nextPos, nextPos);
            textarea.focus();
            closePopup();
            suppressNextRefresh = true;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }

        function renderPopup(items) {
            if (!items.length) {
                closePopup();
                return;
            }

            const rect = textarea.getBoundingClientRect();
            if (!popup) {
                popup = document.createElement('div');
                popup.className = 'site-textarea-suggest-box';
                document.body.appendChild(popup);
            }

            popup.style.left = `${rect.left}px`;
            popup.style.top = `${Math.min(window.innerHeight - 240, rect.bottom + 6)}px`;
            popup.style.display = 'block';

            shownItems = items;
            activeIndex = Math.min(activeIndex, items.length - 1);

            popup.innerHTML = items.map((item, index) => `
                <button type="button" class="site-textarea-suggest-item ${index === activeIndex ? 'active' : ''}" data-index="${index}">${item}</button>
            `).join('');

            popup.querySelectorAll('.site-textarea-suggest-item').forEach(button => {
                button.addEventListener('mousedown', (event) => {
                    event.preventDefault();
                    const idx = Number(button.dataset.index);
                    if (!Number.isInteger(idx) || !shownItems[idx]) return;
                    applySuggestion(shownItems[idx]);
                });
            });
        }

        function refreshSuggestions() {
            if (suppressNextRefresh) {
                suppressNextRefresh = false;
                closePopup();
                return;
            }

            const info = getCurrentLineInfo();
            const token = String(info.lineText || '').trim().toLowerCase();
            if (!token) {
                closePopup();
                return;
            }

            const filtered = values
                .filter(item => item.toLowerCase().includes(token))
                .slice(0, 8);

            if (!filtered.length) {
                closePopup();
                return;
            }

            activeIndex = 0;
            renderPopup(filtered);
        }

        textarea.addEventListener('input', refreshSuggestions);
        textarea.addEventListener('click', refreshSuggestions);
        textarea.addEventListener('blur', () => {
            setTimeout(closePopup, 120);
        });

        textarea.addEventListener('keydown', (event) => {
            if (!popup || !shownItems.length) return;

            if (event.key === 'ArrowDown') {
                event.preventDefault();
                activeIndex = (activeIndex + 1) % shownItems.length;
                renderPopup(shownItems);
                return;
            }

            if (event.key === 'ArrowUp') {
                event.preventDefault();
                activeIndex = (activeIndex - 1 + shownItems.length) % shownItems.length;
                renderPopup(shownItems);
                return;
            }

            if (event.key === 'Enter' && activeIndex >= 0 && shownItems[activeIndex]) {
                event.preventDefault();
                applySuggestion(shownItems[activeIndex]);
                return;
            }

            if (event.key === 'Escape') {
                closePopup();
            }
        });
    }

    async function initSuggestions() {
        const hasAnyTarget = [...handleInputIds, ...roomInputIds].some(id => document.getElementById(id));
        if (!hasAnyTarget) return;

        try {
            const [results, brackets, profiles] = await Promise.all([
                fetchResults(),
                fetchBrackets(),
                fetchProfiles()
            ]);
            const suggestions = buildSuggestions(results, brackets, profiles);

            const handleList = ensureDatalist('siteHandleSuggestions');
            fillDatalist(handleList, suggestions.handles);
            attachListToInputs(handleInputIds, 'siteHandleSuggestions');

            const roomList = ensureDatalist('siteRoomSuggestions');
            fillDatalist(roomList, suggestions.roomIds);
            attachListToInputs(roomInputIds, 'siteRoomSuggestions');

            const nameList = ensureDatalist('siteNameSuggestions');
            fillDatalist(nameList, suggestions.names);
            attachListToInputs(nameInputIds, 'siteNameSuggestions');

            textareaHandleIds.forEach(id => {
                const textarea = document.getElementById(id);
                if (!textarea) return;
                attachTextareaSuggestions(textarea, suggestions.handles);
            });
        } catch {
            // Keep silent if suggestions can't be loaded.
        }
    }

    initSuggestions().catch(() => {});
})();
