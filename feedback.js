(function () {
    const API_BASE_URL = window.location.origin;
    const OWNER_KEY = 'blitzUserHandle';
    const ADMIN_HANDLES = new Set(['else_if_tridib21', 'mishkatit']);
    const STORAGE_ENC_PREFIX = 'enc:v1:';
    const STORAGE_ENC_SECRET = 'blitz_storage_v1';

    const feedbackTitleInput = document.getElementById('feedbackTitleInput');
    const feedbackMessageInput = document.getElementById('feedbackMessageInput');
    const submitFeedbackBtn = document.getElementById('submitFeedbackBtn');
    const feedbackSearchInput = document.getElementById('feedbackSearchInput');
    const feedbackStatusFilter = document.getElementById('feedbackStatusFilter');
    const selectAllFeedbackBtn = document.getElementById('selectAllFeedbackBtn');
    const deleteSelectedFeedbackBtn = document.getElementById('deleteSelectedFeedbackBtn');
    const feedbackList = document.getElementById('feedbackList');
    const feedbackActivity = document.getElementById('feedbackActivity');

    let allItems = [];
    let allActivity = [];
    let searchQuery = '';
    const expandedReplyComposer = new Set();
    const selectedFeedbackIds = new Set();
    let visibleSelectableFeedbackIds = [];

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

    function getCurrentHandle() {
        return String(decodeStoredValue(localStorage.getItem(OWNER_KEY) || '') || '').trim();
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

            const replies = Array.isArray(item.replies) ? item.replies : [];
            const replySearchable = replies
                .map(reply => `${reply?.message || ''} ${reply?.createdBy || ''}`)
                .join(' ');

            const searchable = [
                item.title,
                item.message,
                item.createdBy,
                item.updatedBy,
                item.status,
                replySearchable
            ]
                .map(value => String(value || '').toLowerCase())
                .join(' ');

            return queryTokens.every(token => searchable.includes(token));
        });

        if (!filtered.length) {
            visibleSelectableFeedbackIds = [];
            selectedFeedbackIds.clear();
            feedbackList.innerHTML = '<div class="feedback-meta">No feedback found.</div>';
            refreshBulkDeleteUi();
            return;
        }

        const currentHandle = getCurrentHandle();

        const nextVisibleSelectableIds = [];

        feedbackList.innerHTML = filtered.map(item => {
            const manager = canManage(item);
            const isOwner = currentHandle && String(item.createdBy || '').toLowerCase() === currentHandle.toLowerCase();
            const canAdminOverride = manager && !isOwner && isAdminHandle(currentHandle);
            const isSelected = selectedFeedbackIds.has(String(item.id));
            if (manager) {
                nextVisibleSelectableIds.push(String(item.id));
            }
            const history = Array.isArray(item.history) ? item.history : [];
            const replies = Array.isArray(item.replies) ? item.replies : [];
            const isReplyOpen = expandedReplyComposer.has(String(item.id));
            const historyHtml = history.length
                ? `<div class="feedback-history">${history.slice(-2).map(entry => `Updated by <strong>${escapeHtml(entry.by || 'unknown')}</strong> at ${escapeHtml(formatTime(entry.at))}`).join(' · ')}</div>`
                : '';

            const repliesHtml = replies.length
                ? `<div class="feedback-replies">${replies.map(reply => `
                        <div class="feedback-reply-item">
                            <div class="feedback-reply-meta">
                                <span><strong>${escapeHtml(reply.createdBy || 'anonymous')}</strong> · ${escapeHtml(formatTime(reply.createdAt))}</span>
                                ${(() => {
                                    const current = getCurrentHandle();
                                    const isOwnerReply = !!current && String(reply.createdBy || '').toLowerCase() === current.toLowerCase();
                                    const isAdminReply = isAdminHandle(current);
                                    if (!isOwnerReply && !isAdminReply) return '';
                                    return `<button class="action-btn danger mini" data-action="delete-reply" data-id="${escapeHtml(item.id)}" data-reply-id="${escapeHtml(reply.id || '')}" data-admin="${!isOwnerReply && isAdminReply ? '1' : '0'}">Delete</button>`;
                                })()}
                            </div>
                            <div class="feedback-reply-body">${escapeHtml(reply.message || '')}</div>
                        </div>
                    `).join('')}</div>`
                : '<div class="feedback-replies-empty">No replies yet.</div>';

            const statusControl = manager
                ? `<select class="feedback-status-select" data-id="${escapeHtml(item.id)}">\n                        <option value="open" ${normalizeStatus(item.status) === 'open' ? 'selected' : ''}>Open</option>\n                        <option value="fixed" ${normalizeStatus(item.status) === 'fixed' ? 'selected' : ''}>Fixed</option>\n                        <option value="ignored" ${normalizeStatus(item.status) === 'ignored' ? 'selected' : ''}>Ignored</option>\n                    </select>`
                : statusBadge(item.status);

            const actionButtons = manager
                ? `<button class="action-btn" data-action="edit" data-id="${escapeHtml(item.id)}">Edit Text</button>\n                   <button class="action-btn danger" data-action="delete" data-id="${escapeHtml(item.id)}" data-admin="${canAdminOverride ? '1' : '0'}">Delete</button>`
                : '';

            return `
                <article class="feedback-card">
                    <div class="feedback-head">
                        <div class="feedback-head-left">
                            ${manager ? `<label class="feedback-select-wrap"><input type="checkbox" data-action="select-feedback" data-id="${escapeHtml(item.id)}" ${isSelected ? 'checked' : ''}><span>Select</span></label>` : ''}
                            <div class="feedback-title">${escapeHtml(item.title || 'Untitled Feedback')}</div>
                        </div>
                        ${statusControl}
                    </div>
                    <div class="feedback-meta">
                        by <strong>${escapeHtml(item.createdBy || 'unknown')}</strong> · ${escapeHtml(formatTime(item.createdAt))}
                        ${item.updatedAt ? ` · last update by ${escapeHtml(item.updatedBy || 'unknown')} at ${escapeHtml(formatTime(item.updatedAt))}` : ''}
                    </div>
                    <div class="feedback-body">${escapeHtml(item.message || '')}</div>
                    ${historyHtml}
                    <div class="feedback-reply-block">
                        <div class="feedback-reply-head">
                            <div class="feedback-reply-title">Replies (${replies.length})</div>
                        </div>
                        <div class="feedback-reply-footer">
                            <button class="action-btn mini" data-action="toggle-reply" data-id="${escapeHtml(item.id)}">${isReplyOpen ? 'Collapse' : 'Expand'}</button>
                        </div>
                        <div class="feedback-reply-content ${isReplyOpen ? '' : 'is-hidden'}">
                            ${repliesHtml}
                            <div class="feedback-reply-compose" data-reply-compose="${escapeHtml(item.id)}">
                                <textarea class="feedback-reply-input" data-id="${escapeHtml(item.id)}" rows="2" placeholder="Write a reply..."></textarea>
                                <button class="action-btn" data-action="reply" data-id="${escapeHtml(item.id)}">Post Reply</button>
                            </div>
                        </div>
                    </div>
                    <div class="feedback-actions">${actionButtons}</div>
                </article>
            `;
        }).join('');

        visibleSelectableFeedbackIds = nextVisibleSelectableIds;
        for (const selectedId of Array.from(selectedFeedbackIds)) {
            if (!allItems.some(item => String(item.id) === selectedId)) {
                selectedFeedbackIds.delete(selectedId);
            }
        }
        refreshBulkDeleteUi();
    }

    function refreshBulkDeleteUi() {
        const selectedCount = selectedFeedbackIds.size;
        if (deleteSelectedFeedbackBtn) {
            deleteSelectedFeedbackBtn.disabled = selectedCount === 0;
            deleteSelectedFeedbackBtn.textContent = `Delete Selected (${selectedCount})`;
        }

        if (selectAllFeedbackBtn) {
            const allVisibleSelected = visibleSelectableFeedbackIds.length > 0
                && visibleSelectableFeedbackIds.every(id => selectedFeedbackIds.has(id));
            selectAllFeedbackBtn.textContent = allVisibleSelected ? 'Unselect All' : 'Select All';
            selectAllFeedbackBtn.disabled = visibleSelectableFeedbackIds.length === 0;
        }
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
            for (const selectedId of Array.from(selectedFeedbackIds)) {
                if (!allItems.some(item => String(item.id) === selectedId)) {
                    selectedFeedbackIds.delete(selectedId);
                }
            }
            renderFeedbackList();
            renderActivity();
        } catch (error) {
            console.error('Failed to load feedback:', error);
            feedbackList.innerHTML = '<div class="feedback-meta">Could not load feedback right now.</div>';
            feedbackActivity.innerHTML = '';
            refreshBulkDeleteUi();
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
            body: JSON.stringify({ title, message })
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
            body: JSON.stringify({ ...payload, password: adminPin || undefined })
        });

        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            alert(data.error || 'Could not update feedback right now.');
            return;
        }

        loadFeedback();
    }

    async function submitReply(feedbackId, message) {
        const requesterHandle = getCurrentHandle();
        if (!requesterHandle) {
            alert('Please login first');
            return;
        }

        const payload = {
            message: String(message || '').trim()
        };

        if (!payload.message) {
            alert('Please write a reply message.');
            return;
        }

        const response = await fetch(`${API_BASE_URL}/api/feedback/${encodeURIComponent(feedbackId)}/replies`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            alert(data.error || 'Could not add reply right now.');
            return;
        }

        loadFeedback();
    }

    async function deleteReply(feedbackId, replyId, requiresAdminPin) {
        const requesterHandle = getCurrentHandle();
        if (!requesterHandle) {
            alert('Please login first');
            return;
        }

        if (!confirm('Delete this reply?')) return;

        let adminPin = '';
        if (requiresAdminPin) {
            adminPin = prompt('Admin PIN required:') || '';
            if (!adminPin) return;
        }

        const response = await fetch(`${API_BASE_URL}/api/feedback/${encodeURIComponent(feedbackId)}/replies/${encodeURIComponent(replyId)}`, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
                ...(adminPin ? { 'x-admin-password': adminPin } : {})
            },
            body: JSON.stringify({ password: adminPin || undefined })
        });

        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            alert(data.error || 'Could not delete reply right now.');
            return;
        }

        loadFeedback();
    }

    async function deleteFeedbackRequest(feedbackId, adminPin = '') {
        const response = await fetch(`${API_BASE_URL}/api/feedback/${encodeURIComponent(feedbackId)}`, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
                ...(adminPin ? { 'x-admin-password': adminPin } : {})
            },
            body: JSON.stringify({ password: adminPin || undefined })
        });

        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error || 'Could not delete feedback right now.');
        }

        return true;
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

        try {
            await deleteFeedbackRequest(feedbackId, adminPin);
        } catch (error) {
            alert(error?.message || 'Could not delete feedback right now.');
            return;
        }

        loadFeedback();
    }

    async function deleteSelectedFeedback() {
        const requesterHandle = getCurrentHandle();
        if (!requesterHandle) {
            alert('Please login first');
            return;
        }

        const selectedItems = allItems.filter(item => selectedFeedbackIds.has(String(item.id)));
        if (!selectedItems.length) {
            alert('No feedback selected.');
            return;
        }

        const requesterNorm = requesterHandle.toLowerCase();
        const needsAdminItems = selectedItems.filter(item => String(item.createdBy || '').toLowerCase() !== requesterNorm);
        if (needsAdminItems.length > 0 && !isAdminHandle(requesterHandle)) {
            alert('Some selected items are not yours. Only admin can delete those.');
            return;
        }

        let adminPin = '';
        if (needsAdminItems.length > 0) {
            adminPin = prompt('Admin PIN required for selected non-owner items:') || '';
            if (!adminPin) return;
        }

        if (!confirm(`Delete ${selectedItems.length} selected feedback item(s)?`)) return;

        let failed = 0;
        for (const item of selectedItems) {
            const isOwner = String(item.createdBy || '').toLowerCase() === requesterNorm;
            const pin = isOwner ? '' : adminPin;
            try {
                await deleteFeedbackRequest(item.id, pin);
                selectedFeedbackIds.delete(String(item.id));
            } catch {
                failed += 1;
            }
        }

        await loadFeedback();
        if (failed > 0) {
            alert(`${failed} selected item(s) could not be deleted.`);
        }
    }

    submitFeedbackBtn.addEventListener('click', () => {
        submitFeedback().catch(error => {
            console.error('Submit feedback failed:', error);
            alert('Could not submit feedback right now.');
        });
    });

    feedbackStatusFilter.addEventListener('change', renderFeedbackList);

    if (selectAllFeedbackBtn) {
        selectAllFeedbackBtn.addEventListener('click', () => {
            const allVisibleSelected = visibleSelectableFeedbackIds.length > 0
                && visibleSelectableFeedbackIds.every(id => selectedFeedbackIds.has(id));

            if (allVisibleSelected) {
                visibleSelectableFeedbackIds.forEach(id => selectedFeedbackIds.delete(id));
            } else {
                visibleSelectableFeedbackIds.forEach(id => selectedFeedbackIds.add(id));
            }

            renderFeedbackList();
        });
    }

    if (deleteSelectedFeedbackBtn) {
        deleteSelectedFeedbackBtn.addEventListener('click', () => {
            deleteSelectedFeedback().catch(error => {
                console.error('Bulk delete failed:', error);
                alert('Could not delete selected feedback right now.');
            });
        });
    }

    if (feedbackSearchInput) {
        feedbackSearchInput.addEventListener('input', () => {
            searchQuery = String(feedbackSearchInput.value || '').trim();
            renderFeedbackList();
        });
    }

    feedbackList.addEventListener('change', (event) => {
        const checkbox = event.target.closest('input[data-action="select-feedback"]');
        if (checkbox) {
            const feedbackId = String(checkbox.dataset.id || '').trim();
            if (!feedbackId) return;

            if (checkbox.checked) {
                selectedFeedbackIds.add(feedbackId);
            } else {
                selectedFeedbackIds.delete(feedbackId);
            }

            refreshBulkDeleteUi();
            return;
        }

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
            return;
        }

        if (button.dataset.action === 'toggle-reply') {
            if (expandedReplyComposer.has(feedbackId)) {
                expandedReplyComposer.delete(feedbackId);
            } else {
                expandedReplyComposer.add(feedbackId);
            }
            renderFeedbackList();
            return;
        }

        if (button.dataset.action === 'reply') {
            const input = feedbackList.querySelector(`.feedback-reply-input[data-id="${CSS.escape(feedbackId)}"]`);
            const message = String(input?.value || '').trim();
            submitReply(feedbackId, message).then(() => {
                if (input) input.value = '';
            }).catch(() => {});
            return;
        }

        if (button.dataset.action === 'delete-reply') {
            const replyId = String(button.dataset.replyId || '').trim();
            if (!replyId) return;
            const requiresAdminPinForReply = String(button.dataset.admin || '0') === '1';
            deleteReply(feedbackId, replyId, requiresAdminPinForReply).catch(() => {});
        }
    });

    window.addEventListener('storage', (event) => {
        if (event.key === OWNER_KEY) {
            renderFeedbackList();
        }
    });

    loadFeedback();
})();
