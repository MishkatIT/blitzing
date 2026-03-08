// Recreate full CFUserInfo module
const CFUserInfo = (() => {
    const API_URL = 'https://codeforces.com/api/user.info?handles=';
    const UPDATE_INTERVAL_MS = 60 * 1000;
    let handleMap = new Map(); // key: normalized handle, value: { handle, rating, maxRating, color }
    let lastUpdate = 0;
    let updateTimer = null;
    let handlesToFetch = new Set();
    const MAX_RETRY = 10;
    const BASE_RETRY_DELAY_MS = 2000; // 2s
    const MAX_RETRY_DELAY_MS = 5 * 60 * 1000; // cap 5 minutes
    const retryState = new Map(); // norm -> { attempts: number, timeoutId: Timeout }
    const subscribers = new Set(); // functions to notify on updates
    // Rate limiter (default 5 requests / second)
    const REQUEST_INTERVAL_MS = 200; // 1000ms / 5req = 200ms between requests
    let requestQueue = [];
    let requestProcessor = null;

    function startRequestProcessor() {
        if (requestProcessor) return;
        requestProcessor = setInterval(async () => {
            if (requestQueue.length === 0) {
                clearInterval(requestProcessor);
                requestProcessor = null;
                return;
            }
            const item = requestQueue.shift();
            try {
                const resp = await fetch(item.url);
                let data = null;
                try { data = await resp.json(); } catch (e) { /* ignore JSON parse errors */ }
                item.resolve({ resp, data });
            } catch (err) {
                item.reject(err);
            }
        }, REQUEST_INTERVAL_MS);
    }

    function enqueueFetch(url) {
        return new Promise((resolve, reject) => {
            requestQueue.push({ url, resolve, reject });
            startRequestProcessor();
        });
    }

    function getColorByMaxRating(maxRating) {
        const v = Number(maxRating);
        if (!Number.isFinite(v)) return '#CCCCCC';
        if (v >= 4000) return '#AA0000';
        if (v >= 3000) return '#AA0000';
        if (v >= 2600) return '#FF3333';
        if (v >= 2400) return '#FF7777';
        if (v >= 2300) return '#FFBB55';
        if (v >= 2100) return '#FFCC88';
        if (v >= 1900) return '#FF88FF';
        if (v >= 1600) return '#AAAAFF';
        if (v >= 1400) return '#77DDBB';
        if (v >= 1200) return '#77FF77';
        return '#CCCCCC';
    }

    // Cache TTL: return cached info immediately if fetched within this window.
    // Requests older than this will be refreshed in the background when tracked.
    // Cache TTL: return cached info immediately if fetched within this window.
    // Requests older than this will be refreshed in the background when tracked.
    const FETCH_TTL_MS = 5 * 60 * 1000; // 5 minutes
    const LOCALSTORAGE_KEY = 'CFUserInfoCache_v1';

    // Persist a compact snapshot of handleMap to localStorage so we can
    // avoid API calls across page reloads when data is still fresh.
    function loadCacheFromStorage() {
        try {
            const raw = localStorage.getItem(LOCALSTORAGE_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return;
            Object.keys(parsed).forEach(norm => {
                const v = parsed[norm];
                if (!v || typeof v !== 'object') return;
                // Only accept reasonably-shaped entries
                handleMap.set(norm, {
                    handle: v.handle || v.h || '',
                    rating: v.rating == null ? null : v.rating,
                    maxRating: v.maxRating == null ? null : v.maxRating,
                    color: v.color || '#808080',
                    colorLGM: v.colorLGM || '#AA0000',
                    colorBlack: v.colorBlack || '#000000',
                    fetchedAt: Number(v.fetchedAt) || 0
                });
            });
        } catch (e) {
            console.warn('CFUserInfo: failed to load cache', e);
        }
    }

    function saveCacheToStorage() {
        try {
            const obj = {};
            handleMap.forEach((v, k) => {
                // store only compact fields
                obj[k] = {
                    handle: v.handle,
                    rating: v.rating,
                    maxRating: v.maxRating,
                    color: v.color,
                    colorLGM: v.colorLGM,
                    colorBlack: v.colorBlack,
                    fetchedAt: v.fetchedAt || 0
                };
            });
            localStorage.setItem(LOCALSTORAGE_KEY, JSON.stringify(obj));
        } catch (e) {
            console.warn('CFUserInfo: failed to save cache', e);
        }
    }

    // Load cached entries immediately so getInfo() can return them without calling API
    try { loadCacheFromStorage(); } catch (e) { /* ignore */ }

    // trackHandles(handles, { force: boolean })
    function trackHandles(handles, opts) {
        const force = opts && opts.force;
        handles.forEach(h => {
            const norm = String(h).trim().toLowerCase();
            // If we already have a cached entry, preserve it and only set the
            // 'handle' field if missing. This avoids resetting fetchedAt to 0
            // and causing unnecessary immediate API calls.
            if (!handleMap.has(norm)) {
                handleMap.set(norm, { handle: h, rating: null, maxRating: null, color: '#808080', fetchedAt: 0 });
            } else {
                const existing = handleMap.get(norm);
                if (existing && !existing.handle) existing.handle = h;
            }
            const existing = handleMap.get(norm) || {};
            const age = existing.fetchedAt && existing.fetchedAt > 0 ? (Date.now() - existing.fetchedAt) : Infinity;
            // If recently fetched and not forced, skip queueing to avoid repeated requests
            if (!force && age < FETCH_TTL_MS) return;

            // Reset retry state and queue the normalized handle for fetching
            clearRetry(norm);
            retryState.set(norm, { attempts: 0, timeoutId: null });
            handlesToFetch.add(norm);
        });
        updateNow();
    }

    function getInfo(handle) {
        const norm = String(handle).trim().toLowerCase();
        return handleMap.get(norm) || null;
    }

    function scheduleRetry(norm) {
        const cur = retryState.get(norm) || { attempts: 0, timeoutId: null };
        cur.attempts = (cur.attempts || 0) + 1;
        if (cur.attempts > MAX_RETRY) {
            console.warn('CFUserInfo: max retries reached for', norm);
            retryState.set(norm, cur);
            return;
        }
        if (cur.timeoutId) clearTimeout(cur.timeoutId);
        const delay = Math.min(BASE_RETRY_DELAY_MS * Math.pow(2, cur.attempts - 1), MAX_RETRY_DELAY_MS);
        cur.timeoutId = setTimeout(() => {
            handlesToFetch.add(norm);
            cur.timeoutId = null;
            updateNow();
        }, delay);
        retryState.set(norm, cur);
    }

    function clearRetry(norm) {
        const cur = retryState.get(norm);
        if (cur && cur.timeoutId) {
            clearTimeout(cur.timeoutId);
        }
        retryState.delete(norm);
    }

    function subscribe(fn) {
        if (typeof fn === 'function') subscribers.add(fn);
        return () => unsubscribe(fn);
    }

    function unsubscribe(fn) {
        subscribers.delete(fn);
    }

    function renderHandleHtml(handle) {
        const info = getInfo(handle) || {};
        const safeHandle = String(info.handle || handle || '');
        const maxRating = Number(info.maxRating);
        const colorLGM = info.colorLGM || '#AA0000';
        const colorBlack = info.colorBlack || '#000000';
        const color = info.color || '#808080';
        if (maxRating >= 4000 && safeHandle.length > 1) {
            return `<span style="color:${colorLGM}">${safeHandle.charAt(0)}</span><span style="color:${colorBlack}">${safeHandle.slice(1)}</span>`;
        } else if (maxRating >= 3000 && safeHandle.length > 1) {
            return `<span style="color:${colorBlack}">${safeHandle.charAt(0)}</span><span style="color:${colorLGM}">${safeHandle.slice(1)}</span>`;
        } else {
            return `<span style="color:${color}">${safeHandle}</span>`;
        }
    }

    async function updateNow() {
        if (handlesToFetch.size === 0) return;
        const handlesArr = Array.from(handlesToFetch);
        handlesToFetch.clear();
        for (let i = 0; i < handlesArr.length; i += 50) {
            const chunk = handlesArr.slice(i, i + 50);
            // Build API handle list using canonical-case handle stored in handleMap
            const apiHandles = chunk.map(n => (handleMap.get(n) && handleMap.get(n).handle) || n).join(';');
            try {
                const { resp, data } = await enqueueFetch(API_URL + encodeURIComponent(apiHandles));
                if (data && data.status === 'OK') {
                    const updated = new Set();
                    data.result.forEach(user => {
                        const norm = String(user.handle).trim().toLowerCase();
                        const color = getColorByMaxRating(user.maxRating);
                        const stored = Object.assign({}, user, {
                            color: color,
                            colorLGM: '#AA0000',
                            colorBlack: '#000000',
                            fetchedAt: Date.now()
                        });
                        handleMap.set(norm, stored);
                        // Clear retry state for successful entries
                        clearRetry(norm);
                        updated.add(norm);
                    });
                    // Persist cache to localStorage so subsequent page loads use it
                    try { saveCacheToStorage(); } catch (e) { /* ignore */ }
                    // Re-queue any handles that didn't appear in the result (possible transient error)
                    const returned = new Set(data.result.map(u => String(u.handle).trim().toLowerCase()));
                    chunk.forEach(n => {
                        if (!returned.has(n)) scheduleRetry(n);
                    });
                    // Notify subscribers about updated handles
                    if (subscribers.size && updated.size) {
                        subscribers.forEach(fn => {
                            try { fn(Array.from(updated)); } catch (e) { /* ignore subscriber errors */ }
                        });
                    }
                } else {
                    console.warn('CFUserInfo: API returned error', data);
                    chunk.forEach(n => scheduleRetry(n));
                }
            } catch (e) {
                console.warn('CFUserInfo: fetch error', e);
                // schedule retry for chunk
                chunk.forEach(n => scheduleRetry(n));
            }
        }
        lastUpdate = Date.now();
    }

    function startAutoUpdate() {
        if (updateTimer) clearInterval(updateTimer);
        updateTimer = setInterval(updateNow, UPDATE_INTERVAL_MS);
    }

    return {
        trackHandles,
        getInfo,
        startAutoUpdate,
        renderHandleHtml,
        subscribe,
        unsubscribe,
        _handleMap: handleMap
    };
})();

// Start periodic update and expose globally
CFUserInfo.startAutoUpdate();
window.CFUserInfo = CFUserInfo;
