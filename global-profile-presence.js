(function () {
    const HANDLE_STORAGE_KEY = 'blitzUserHandle';
    const AVATAR_STORAGE_KEY = 'blitzUserAvatar';
    const PRESENCE_PING_INTERVAL_MS = 30000;

    let pingTimer = null;
    let pingInFlight = false;

    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function renderGlobalHandleChip() {
        const chips = document.querySelectorAll('[data-global-handle-chip]');
        const handle = String(localStorage.getItem(HANDLE_STORAGE_KEY) || '').trim();
        const avatar = String(localStorage.getItem(AVATAR_STORAGE_KEY) || '').trim();

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
            chip.setAttribute('href', `profile.html?handle=${encodeURIComponent(handle)}`);
            chip.setAttribute('target', '_self');
            chip.setAttribute('title', 'Open your profile');
        });
    }

    async function pingPresence(force = false) {
        const handle = String(localStorage.getItem(HANDLE_STORAGE_KEY) || '').trim();
        if (!handle) return;
        if (pingInFlight && !force) return;

        pingInFlight = true;
        try {
            await fetch('/api/presence/ping', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ handle }),
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

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            renderGlobalHandleChip();
            startPresenceHeartbeat();
        });
    } else {
        renderGlobalHandleChip();
        startPresenceHeartbeat();
    }
})();
