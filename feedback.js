(function () {
    const API_BASE_URL = window.location.origin;
    const OWNER_KEY = 'blitzUserHandle';
    const ADMIN_HANDLES = new Set(['else_if_tridib21', 'mishkatit']);

    const feedbackTitleInput = document.getElementById('feedbackTitleInput');
    const feedbackMessageInput = document.getElementById('feedbackMessageInput');
    const submitFeedbackBtn = document.getElementById('submitFeedbackBtn');
    const feedbackSearchInput = document.getElementById('feedbackSearchInput');
    const feedbackStatusFilter = document.getElementById('feedbackStatusFilter');
    const feedbackList = document.getElementById('feedbackList');
    const feedbackActivity = document.getElementById('feedbackActivity');

    let allItems = [];
    let allActivity = [];
    let searchQuery = '';

    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function formatTime(value) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '-';
        return date.toLocaleString();
    }

    function getCurrentHandle() {
        return String(localStorage.getItem(OWNER_KEY) || '').trim();
    }

    function isAdminHandle(handle) {
        return ADMIN_HANDLES.has(String(handle || '').trim().toLowerCase());
    }

    function normalizeStatus(value) {
        const token = String(value || 'open').trim().toLowerCase();
        if (token === 'fixed') return 'fixed';
        if (token === 'ignored') return 'ignored';
        return 'open';
    }

    function canManage(item) {
        const currentHandle = getCurrentHandle();
        if (!currentHandle) return false;
        if (String(item.createdBy || '').toLowerCase() === currentHandle.toLowerCase()) return true;
        return isAdminHandle(currentHandle);
    }

    function statusBadge(status) {
        const value = normalizeStatus(status);
        return `<span class="status-badge status-${value}">${value}</span>`;
    }

    function renderFeedbackList() {
        const filter = String(feedbackStatusFilter?.value || 'all').toLowerCase();
        const queryTokens = String(searchQuery || '')
            .toLowerCase()
            .split(/\s+/)
            .map(token => token.trim())
            .filter(Boolean);

        const filtered = allItems.filter(item => {
            const statusMatch = filter === 'all' ? true : normalizeStatus(item.status) === filter;
            if (!statusMatch) return false;

            if (!queryTokens.length) return true;

            const searchable = [
                item.title,
                item.message,
                item.createdBy,
                item.updatedBy,
                item.status
            ]
                .map(value => String(value || '').toLowerCase())
                .join(' ');

            return queryTokens.every(token => searchable.includes(token));
        });

        if (!filtered.length) {
            feedbackList.innerHTML = '<div class="feedback-meta">No feedback found.</div>';
            return;
        }

        const currentHandle = getCurrentHandle();

        feedbackList.innerHTML = filtered.map(item => {
            const manager = canManage(item);
            const isOwner = currentHandle && String(item.createdBy || '').toLowerCase() === currentHandle.toLowerCase();
            const canAdminOverride = manager && !isOwner && isAdminHandle(currentHandle);
            const history = Array.isArray(item.history) ? item.history : [];
            const historyHtml = history.length
                ? `<div class="feedback-history">${history.slice(-2).map(entry => `Updated by <strong>${escapeHtml(entry.by || 'unknown')}</strong> at ${escapeHtml(formatTime(entry.at))}`).join(' · ')}</div>`
                : '';

            const statusControl = manager
                ? `<select class="feedback-status-select" data-id="${escapeHtml(item.id)}">\n                        <option value="open" ${normalizeStatus(item.status) === 'open' ? 'selected' : ''}>Open</option>\n                        <option value="fixed" ${normalizeStatus(item.status) === 'fixed' ? 'selected' : ''}>Fixed</option>\n                        <option value="ignored" ${normalizeStatus(item.status) === 'ignored' ? 'selected' : ''}>Ignored</option>\n                    </select>`
                : statusBadge(item.status);

            const actionButtons = manager
                ? `<button class="action-btn" data-action="edit" data-id="${escapeHtml(item.id)}">Edit Text</button>\n                   <button class="action-btn danger" data-action="delete" data-id="${escapeHtml(item.id)}" data-admin="${canAdminOverride ? '1' : '0'}">Delete</button>`
                : '';

            return `
                <article class="feedback-card">
                    <div class="feedback-head">
                        <div class="feedback-title">${escapeHtml(item.title || 'Untitled Feedback')}</div>
                        ${statusControl}
                    </div>
                    <div class="feedback-meta">
                        by <strong>${escapeHtml(item.createdBy || 'unknown')}</strong> · ${escapeHtml(formatTime(item.createdAt))}
                        ${item.updatedAt ? ` · last update by ${escapeHtml(item.updatedBy || 'unknown')} at ${escapeHtml(formatTime(item.updatedAt))}` : ''}
                    </div>
                    <div class="feedback-body">${escapeHtml(item.message || '')}</div>
                    ${historyHtml}
                    <div class="feedback-actions">${actionButtons}</div>
                </article>
            `;
        }).join('');
    }

    function renderActivity() {
        if (!allActivity.length) {
            feedbackActivity.innerHTML = '<div class="activity-item">No activity yet.</div>';
            return;
        }

        feedbackActivity.innerHTML = allActivity.slice(0, 40).map(entry => {
            const type = escapeHtml(entry.type || 'updated');
            const by = escapeHtml(entry.by || 'unknown');
            const at = escapeHtml(formatTime(entry.at));
            const target = escapeHtml(entry.feedbackTitle || entry.feedbackId || 'feedback');
            return `<div class="activity-item">${at} · <strong>${by}</strong> ${type} <strong>${target}</strong></div>`;
        }).join('');
    }

    async function loadFeedback() {
        try {
            const response = await fetch(`${API_BASE_URL}/api/feedback`);
            const payload = await response.json();
            allItems = Array.isArray(payload?.items) ? payload.items : [];
            allActivity = Array.isArray(payload?.activity) ? payload.activity : [];
            renderFeedbackList();
            renderActivity();
        } catch (error) {
            console.error('Failed to load feedback:', error);
            feedbackList.innerHTML = '<div class="feedback-meta">Could not load feedback right now.</div>';
            feedbackActivity.innerHTML = '';
        }
    }

    async function submitFeedback() {
        const requesterHandle = getCurrentHandle();
        if (!requesterHandle) {
            alert('Please login first');
            return;
        }

        const title = String(feedbackTitleInput.value || '').trim();
        const message = String(feedbackMessageInput.value || '').trim();

        if (!message) {
            alert('Please write your feedback message.');
            feedbackMessageInput.focus();
            return;
        }

        const response = await fetch(`${API_BASE_URL}/api/feedback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requesterHandle, title, message })
        });

        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            alert(data.error || 'Could not submit feedback right now.');
            return;
        }

        feedbackTitleInput.value = '';
        feedbackMessageInput.value = '';
        loadFeedback();
    }

    async function patchFeedback(feedbackId, payload, requiresAdminPin) {
        const requesterHandle = getCurrentHandle();
        if (!requesterHandle) {
            alert('Please login first');
            return;
        }

        let adminPin = '';
        if (requiresAdminPin) {
            adminPin = prompt('Admin PIN required:') || '';
            if (!adminPin) return;
        }

        const response = await fetch(`${API_BASE_URL}/api/feedback/${encodeURIComponent(feedbackId)}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                ...(adminPin ? { 'x-admin-password': adminPin } : {})
            },
            body: JSON.stringify({ requesterHandle, ...payload, password: adminPin || undefined })
        });

        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            alert(data.error || 'Could not update feedback right now.');
            return;
        }

        loadFeedback();
    }

    async function deleteFeedback(feedbackId, requiresAdminPin) {
        const requesterHandle = getCurrentHandle();
        if (!requesterHandle) {
            alert('Please login first');
            return;
        }

        if (!confirm('Delete this feedback?')) return;

        let adminPin = '';
        if (requiresAdminPin) {
            adminPin = prompt('Admin PIN required:') || '';
            if (!adminPin) return;
        }

        const query = `requesterHandle=${encodeURIComponent(requesterHandle)}`;
        const response = await fetch(`${API_BASE_URL}/api/feedback/${encodeURIComponent(feedbackId)}?${query}`, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
                ...(adminPin ? { 'x-admin-password': adminPin } : {})
            },
            body: JSON.stringify({ requesterHandle, password: adminPin || undefined })
        });

        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            alert(data.error || 'Could not delete feedback right now.');
            return;
        }

        loadFeedback();
    }

    submitFeedbackBtn.addEventListener('click', () => {
        submitFeedback().catch(error => {
            console.error('Submit feedback failed:', error);
            alert('Could not submit feedback right now.');
        });
    });

    feedbackStatusFilter.addEventListener('change', renderFeedbackList);

    if (feedbackSearchInput) {
        feedbackSearchInput.addEventListener('input', () => {
            searchQuery = String(feedbackSearchInput.value || '').trim();
            renderFeedbackList();
        });
    }

    feedbackList.addEventListener('change', (event) => {
        const select = event.target.closest('.feedback-status-select');
        if (!select) return;

        const feedbackId = String(select.dataset.id || '').trim();
        const item = allItems.find(entry => String(entry.id) === feedbackId);
        if (!item) return;

        const currentHandle = getCurrentHandle();
        const isOwner = currentHandle && String(item.createdBy || '').toLowerCase() === currentHandle.toLowerCase();
        const requiresAdminPin = !isOwner && isAdminHandle(currentHandle);

        patchFeedback(feedbackId, { status: normalizeStatus(select.value) }, requiresAdminPin).catch(() => {});
    });

    feedbackList.addEventListener('click', (event) => {
        const button = event.target.closest('[data-action]');
        if (!button) return;

        const feedbackId = String(button.dataset.id || '').trim();
        const item = allItems.find(entry => String(entry.id) === feedbackId);
        if (!item) return;

        const currentHandle = getCurrentHandle();
        const isOwner = currentHandle && String(item.createdBy || '').toLowerCase() === currentHandle.toLowerCase();
        const requiresAdminPin = !isOwner && isAdminHandle(currentHandle);

        if (button.dataset.action === 'edit') {
            const nextTitle = prompt('Edit title:', item.title || '') ?? item.title;
            const nextMessage = prompt('Edit feedback message:', item.message || '');
            if (nextMessage === null) return;
            patchFeedback(feedbackId, {
                title: String(nextTitle || '').trim(),
                message: String(nextMessage || '').trim()
            }, requiresAdminPin).catch(() => {});
            return;
        }

        if (button.dataset.action === 'delete') {
            deleteFeedback(feedbackId, requiresAdminPin).catch(() => {});
        }
    });

    window.addEventListener('storage', (event) => {
        if (event.key === OWNER_KEY) {
            renderFeedbackList();
        }
    });

    loadFeedback();
})();
