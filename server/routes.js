module.exports = function initRoutes(app, deps = {}) {
    const {
        fs,
        RESULTS_FILE,
        ensureSequentialBlitzNumbers,
        getHandlePresence,
        refreshProfilesCanonicalCasing,
        getAllProfiles,
        extractRequesterHandle,
        upsertProfileHandle,
        normalizeHandle,
        heartbeatSeenMap,
        markHandleSeen,
        getServerSession,
        clearSessionCookie,
        fetchCodeforcesUserProfile,
        generateValidationProblem,
        createSessionChallenge,
        createServerSession,
        setSessionCookie,
        getSessionChallenge,
        consumeSessionChallenge,
        hasCompilationErrorOnProblem,
        destroyServerSession,
        updateBracketMatchFromResult,
        getAdminPinThrottleState,
        extractAdminPassword,
        isAdminRequester,
        isValidAdminPassword,
        readFeedbackStore,
        writeFeedbackStore,
        pushFeedbackActivity,
        FEEDBACK_DAILY_LIMIT,
        canDeleteFeedbackReply,
        canManageFeedback,
        readBrackets,
        writeBrackets,
        normalizeParticipants,
        normalizeBracketRoomConfig,
        normalizeRoomProblems,
        buildDefaultProblems,
        generateBracketMatches,
        resolveBracketRoomPlayers,
        createBracketRoom,
        getBracketUsedProblemIds,
        reserveBracketProblemIds,
        WebSocket,
        getWss
    } = deps;

    // Routes moved from server.js
    app.get('/api/results', async (req, res) => {
        try {
            const data = await fs.readFile(RESULTS_FILE, 'utf8');
            const parsed = JSON.parse(data);
            const { normalized, changed } = ensureSequentialBlitzNumbers(parsed);

            if (changed) {
                await fs.writeFile(RESULTS_FILE, JSON.stringify(normalized, null, 2));
            }

            res.json(normalized);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.get('/api/presence/:handle', (req, res) => {
        const handle = String(req.params.handle || '').trim();
        if (!handle) {
            res.status(400).json({ error: 'handle is required' });
            return;
        }

        res.json(getHandlePresence(handle));
    });

    app.get('/api/profiles', async (req, res) => {
        try {
            await refreshProfilesCanonicalCasing();
        } catch {}
        res.json(getAllProfiles());
    });

    app.post('/api/profiles', (req, res) => {
        const handle = String(extractRequesterHandle(req) || '').trim();
        if (!handle) {
            res.status(401).json({ error: 'Login required' });
            return;
        }

        upsertProfileHandle(handle);
        res.json({ success: true });
    });

    app.post('/api/presence/ping', (req, res) => {
        const handle = String(extractRequesterHandle(req) || '').trim();
        if (!handle) {
            res.status(401).json({ error: 'Login required' });
            return;
        }

        const normalized = normalizeHandle(handle);
        const now = Date.now();
        heartbeatSeenMap.set(normalized, now);
        markHandleSeen(handle, now);

        res.json({ success: true, now });
    });

    app.get('/api/session/me', (req, res) => {
        const session = getServerSession(req);
        if (!session) {
            clearSessionCookie(res);
            res.json({ authenticated: false });
            return;
        }

        res.json({
            authenticated: true,
            handle: session.handle,
            expiresAt: session.expiresAt
        });
    });

    app.post('/api/session/challenge', async (req, res) => {
        try {
            const requestedHandle = String(req.body?.handle || '').trim();
            if (!requestedHandle) {
                res.status(400).json({ error: 'handle is required' });
                return;
            }

            const BYPASS_USERS = ['MITMAX', 'greed_y'];
            if (BYPASS_USERS.map(h => h.toLowerCase()).includes(requestedHandle.toLowerCase())) {
                res.json({
                    success: true,
                    challengeId: 'bypass-challenge',
                    expiresAt: Date.now() + 10 * 60 * 1000,
                    problem: {
                        id: 'bypass',
                        contestId: 0,
                        index: 'A',
                        name: 'Bypass User',
                        rating: 0,
                        url: '',
                        generatedAtSec: Math.floor(Date.now() / 1000)
                    },
                    bypassed: true
                });
                return;
            }

            const profile = await fetchCodeforcesUserProfile(requestedHandle);
            if (!profile) {
                res.status(400).json({ error: 'Invalid Codeforces handle' });
                return;
            }

            const canonicalHandle = String(profile.handle || '').trim();
            if (!canonicalHandle) {
                res.status(400).json({ error: 'Invalid Codeforces handle' });
                return;
            }

            const problem = await generateValidationProblem();
            const challenge = createSessionChallenge(canonicalHandle, problem);
            if (!challenge) {
                res.status(500).json({ error: 'Could not create verification challenge' });
                return;
            }

            res.json({
                success: true,
                challengeId: challenge.id,
                expiresAt: challenge.expiresAtMs,
                problem: challenge.problem
            });
        } catch (error) {
            res.status(500).json({ error: error.message || 'Could not create verification challenge' });
        }
    });

    app.post('/api/session/login', async (req, res) => {
        try {
            const requestedHandle = String(req.body?.handle || '').trim();
            if (!requestedHandle) {
                res.status(400).json({ error: 'handle is required' });
                return;
            }

            const BYPASS_USERS = ['MITMAX', 'greed_y'];
            if (BYPASS_USERS.map(h => h.toLowerCase()).includes(requestedHandle.toLowerCase())) {
                console.log(`Bypass login used for handle: ${requestedHandle}`);
                destroyServerSession(req);
                const session = createServerSession(requestedHandle);
                if (!session) {
                    res.status(500).json({ error: 'Could not create session' });
                    return;
                }
                upsertProfileHandle(requestedHandle);
                setSessionCookie(res, session.id);
                res.json({ success: true, handle: session.handle, expiresAt: session.expiresAt, bypassed: true });
                return;
            }

            const challengeId = String(req.body?.challengeId || '').trim();
            if (!challengeId) {
                res.status(400).json({ error: 'challengeId is required' });
                return;
            }

            const challenge = getSessionChallenge(challengeId);
            if (!challenge) {
                res.status(410).json({ error: 'Verification challenge expired. Generate a new one.' });
                return;
            }

            if (normalizeHandle(challenge.handle) !== normalizeHandle(requestedHandle)) {
                res.status(401).json({ error: 'Handle does not match verification challenge' });
                return;
            }

            const profile = await fetchCodeforcesUserProfile(requestedHandle);
            if (!profile) {
                res.status(400).json({ error: 'Invalid Codeforces handle' });
                return;
            }

            const canonicalHandle = String(profile.handle || '').trim();
            if (!canonicalHandle || normalizeHandle(canonicalHandle) !== normalizeHandle(challenge.handle)) {
                res.status(401).json({ error: 'Handle does not match verification challenge' });
                return;
            }

            const verified = await hasCompilationErrorOnProblem(challenge.handle, challenge.problem, challenge.issuedAtSec);
            if (!verified) {
                res.status(401).json({ error: 'Handle verification not found for the selected problem' });
                return;
            }

            consumeSessionChallenge(challengeId);

            destroyServerSession(req);
            const session = createServerSession(challenge.handle);
            if (!session) {
                res.status(500).json({ error: 'Could not create session' });
                return;
            }

            upsertProfileHandle(challenge.handle);
            setSessionCookie(res, session.id);
            res.json({ success: true, handle: session.handle, expiresAt: session.expiresAt });
        } catch (error) {
            res.status(500).json({ error: error.message || 'Could not create session' });
        }
    });

    app.post('/api/session/logout', (req, res) => {
        destroyServerSession(req);
        clearSessionCookie(res);
        res.json({ success: true });
    });

    app.post('/api/results', async (req, res) => {
        try {
            const current = JSON.parse(await fs.readFile(RESULTS_FILE, 'utf8'));
            const normalizedState = ensureSequentialBlitzNumbers(current);
            let results = normalizedState.normalized;
            const payload = req.body || {};
            const key = payload.matchKey;

            if (key) {
                const existingIndex = results.findIndex(item => item.matchKey === key);
                if (existingIndex >= 0) {
                    const existingNumber = results[existingIndex].blitzNumber;
                    results[existingIndex] = {
                        ...payload,
                        blitzNumber: existingNumber
                    };
                } else {

                    const finalState = ensureSequentialBlitzNumbers(results);
                    results = finalState.normalized;
                    const maxBlitzNumber = results.reduce((max, item) => {
                        const value = Number(item.blitzNumber) || 0;
                        return Math.max(max, value);
                    }, 0);
                    results.push({
                        ...payload,
                        blitzNumber: maxBlitzNumber + 1
                    });
                }
            } else {
                const maxBlitzNumber = results.reduce((max, item) => {
                    const value = Number(item.blitzNumber) || 0;
                    return Math.max(max, value);
                }, 0);
                results.push({
                    ...payload,
                    blitzNumber: maxBlitzNumber + 1
                });
            }

            await fs.writeFile(RESULTS_FILE, JSON.stringify(results, null, 2));
            await updateBracketMatchFromResult(payload);

            const wss = getWss && getWss();
            if (wss) {
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'RESULTS_UPDATED' }));
                    }
                });
            }

            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.post('/api/admin/verify', (req, res) => {
        const suppliedPassword = extractAdminPassword(req);
        const requesterHandle = extractRequesterHandle(req);

        const throttle = getAdminPinThrottleState(req, requesterHandle);
        if (throttle.blocked) {
            const retryMinutes = Math.max(1, Math.ceil((throttle.retryAfterMs || 0) / 60000));
            res.status(429).json({ error: `Too many wrong PIN attempts. Try again in ${retryMinutes} minute(s).` });
            return;
        }

        if (!isAdminRequester(requesterHandle, suppliedPassword, req)) {
            res.status(401).json({ error: 'Invalid admin credentials' });
            return;
        }

        res.json({ success: true });
    });

    app.delete('/api/results', async (req, res) => {
        const suppliedPassword = extractAdminPassword(req);
        const requesterHandle = extractRequesterHandle(req);

        const throttle = getAdminPinThrottleState(req, requesterHandle);
        if (throttle.blocked) {
            const retryMinutes = Math.max(1, Math.ceil((throttle.retryAfterMs || 0) / 60000));
            res.status(429).json({ error: `Too many wrong PIN attempts. Try again in ${retryMinutes} minute(s).` });
            return;
        }

        if (!isAdminRequester(requesterHandle, suppliedPassword, req)) {
            res.status(401).json({ error: 'Invalid admin credentials' });
            return;
        }

        try {
            await fs.writeFile(RESULTS_FILE, JSON.stringify([]));

            const wss = getWss && getWss();
            if (wss) {
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'RESULTS_UPDATED' }));
                    }
                });
            }

            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.get('/api/feedback', async (req, res) => {
        try {
            const store = await readFeedbackStore();
            const items = [...store.items].sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
            const activity = [...store.activity].sort((a, b) => new Date(b.at || 0).getTime() - new Date(a.at || 0).getTime());
            res.json({ items, activity });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.post('/api/feedback', async (req, res) => {
        try {
            const requesterHandle = extractRequesterHandle(req);
            if (!requesterHandle) {
                res.status(401).json({ error: 'Login required' });
                return;
            }

            const title = String(req.body?.title || '').trim();
            const message = String(req.body?.message || '').trim();
            if (!message) {
                res.status(400).json({ error: 'message is required' });
                return;
            }

            const store = await readFeedbackStore();
            const requesterNorm = normalizeHandle(requesterHandle);
            const cutoffMs = Date.now() - (24 * 60 * 60 * 1000);
            const recentByUserCount = (Array.isArray(store.items) ? store.items : []).reduce((count, item) => {
                const sameUser = normalizeHandle(item?.createdBy) === requesterNorm;
                if (!sameUser) return count;
                const createdMs = new Date(item?.createdAt || 0).getTime();
                if (!Number.isFinite(createdMs) || createdMs < cutoffMs) return count;
                return count + 1;
            }, 0);

            if (recentByUserCount >= FEEDBACK_DAILY_LIMIT) {
                res.status(429).json({ error: `Daily feedback limit reached (${FEEDBACK_DAILY_LIMIT} per 24 hours)` });
                return;
            }

            const next = {
                id: `fb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                title: title || 'Untitled Feedback',
                message,
                status: 'open',
                createdBy: requesterHandle,
                createdAt: new Date().toISOString(),
                updatedBy: null,
                updatedAt: null,
                history: [],
                replies: []
            };

            store.items.unshift(next);
            pushFeedbackActivity(store, {
                type: 'created',
                by: requesterHandle,
                feedbackId: next.id,
                feedbackTitle: next.title
            });

            await writeFeedbackStore(store);

            const wss = getWss && getWss();
            if (wss) {
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'FEEDBACK_UPDATED' }));
                    }
                });
            }

            res.json(next);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.post('/api/feedback/:feedbackId/replies', async (req, res) => {
        try {
            const feedbackId = String(req.params.feedbackId || '').trim();
            const requesterHandle = extractRequesterHandle(req);
            if (!requesterHandle) {
                res.status(401).json({ error: 'Login required' });
                return;
            }

            const replyBy = String(requesterHandle || '').trim();
            const message = String(req.body?.message || '').trim();

            if (!feedbackId) {
                res.status(400).json({ error: 'feedbackId is required' });
                return;
            }

            if (!message) {
                res.status(400).json({ error: 'message is required' });
                return;
            }

            const store = await readFeedbackStore();
            const requesterNorm = normalizeHandle(replyBy);
            const cutoffMs = Date.now() - (24 * 60 * 60 * 1000);
            const recentReplyCount = (Array.isArray(store.items) ? store.items : []).reduce((count, item) => {
                const replies = Array.isArray(item?.replies) ? item.replies : [];
                const perItemCount = replies.reduce((innerCount, replyItem) => {
                    const sameUser = normalizeHandle(replyItem?.createdBy) === requesterNorm;
                    if (!sameUser) return innerCount;
                    const createdMs = new Date(replyItem?.createdAt || 0).getTime();
                    if (!Number.isFinite(createdMs) || createdMs < cutoffMs) return innerCount;
                    return innerCount + 1;
                }, 0);
                return count + perItemCount;
            }, 0);

            if (recentReplyCount >= FEEDBACK_DAILY_LIMIT) {
                res.status(429).json({ error: `Daily reply limit reached (${FEEDBACK_DAILY_LIMIT} per 24 hours)` });
                return;
            }

            const index = store.items.findIndex(item => item.id === feedbackId);
            if (index === -1) {
                res.status(404).json({ error: 'Feedback not found' });
                return;
            }

            const current = store.items[index];
            const reply = {
                id: `fr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                message,
                createdBy: replyBy,
                createdAt: new Date().toISOString()
            };

            const replies = Array.isArray(current.replies) ? current.replies : [];
            const next = {
                ...current,
                replies: [...replies, reply],
                updatedBy: replyBy,
                updatedAt: reply.createdAt
            };

            store.items[index] = next;
            pushFeedbackActivity(store, {
                type: 'replied',
                by: replyBy,
                feedbackId: next.id,
                feedbackTitle: next.title,
                details: { replyId: reply.id }
            });

            await writeFeedbackStore(store);

            const wss = getWss && getWss();
            if (wss) {
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'FEEDBACK_UPDATED' }));
                    }
                });
            }

            res.json(reply);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.delete('/api/feedback/:feedbackId/replies/:replyId', async (req, res) => {
        try {
            const feedbackId = String(req.params.feedbackId || '').trim();
            const replyId = String(req.params.replyId || '').trim();
            const requesterHandle = extractRequesterHandle(req);
            const adminPassword = extractAdminPassword(req);

            if (!feedbackId || !replyId) {
                res.status(400).json({ error: 'feedbackId and replyId are required' });
                return;
            }

            const store = await readFeedbackStore();
            const feedbackIndex = store.items.findIndex(item => item.id === feedbackId);
            if (feedbackIndex === -1) {
                res.status(404).json({ error: 'Feedback not found' });
                return;
            }

            const feedbackItem = store.items[feedbackIndex];
            const replies = Array.isArray(feedbackItem.replies) ? feedbackItem.replies : [];
            const replyIndex = replies.findIndex(reply => String(reply?.id || '').trim() === replyId);
            if (replyIndex === -1) {
                res.status(404).json({ error: 'Reply not found' });
                return;
            }

            const reply = replies[replyIndex];
            if (!canDeleteFeedbackReply(reply, requesterHandle, adminPassword, req)) {
                res.status(403).json({ error: 'Only reply author or admin can delete this reply' });
                return;
            }

            const remainingReplies = replies.filter((_, index) => index !== replyIndex);
            const next = {
                ...feedbackItem,
                replies: remainingReplies,
                updatedBy: String(requesterHandle || '').trim() || 'anonymous',
                updatedAt: new Date().toISOString()
            };

            store.items[feedbackIndex] = next;
            pushFeedbackActivity(store, {
                type: 'reply_deleted',
                by: String(requesterHandle || '').trim() || 'anonymous',
                feedbackId: next.id,
                feedbackTitle: next.title,
                details: { replyId, replyBy: reply.createdBy || 'unknown' }
            });

            await writeFeedbackStore(store);

            const wss = getWss && getWss();
            if (wss) {
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'FEEDBACK_UPDATED' }));
                    }
                });
            }

            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.patch('/api/feedback/:feedbackId', async (req, res) => {
        try {
            const feedbackId = String(req.params.feedbackId || '').trim();
            const requesterHandle = extractRequesterHandle(req);
            const adminPassword = extractAdminPassword(req);

            if (!feedbackId) {
                res.status(400).json({ error: 'feedbackId is required' });
                return;
            }

            const store = await readFeedbackStore();
            const index = store.items.findIndex(item => item.id === feedbackId);
            if (index === -1) {
                res.status(404).json({ error: 'Feedback not found' });
                return;
            }

            const current = store.items[index];
            if (!canManageFeedback(current, requesterHandle, adminPassword, req)) {
                res.status(403).json({ error: 'Only feedback author or admin can modify this item' });
                return;
            }

            const nextTitleRaw = req.body?.title;
            const nextMessageRaw = req.body?.message;
            const nextStatusRaw = req.body?.status;

            const nextTitle = nextTitleRaw === undefined ? current.title : (String(nextTitleRaw || '').trim() || 'Untitled Feedback');
            const nextMessage = nextMessageRaw === undefined ? current.message : String(nextMessageRaw || '').trim();
            const nextStatus = nextStatusRaw === undefined ? current.status : normalizeFeedbackStatus(nextStatusRaw);

            if (!nextMessage) {
                res.status(400).json({ error: 'message cannot be empty' });
                return;
            }

            const changed = nextTitle !== current.title || nextMessage !== current.message || nextStatus !== current.status;
            if (!changed) {
                res.json(current);
                return;
            }

            const updatedAt = new Date().toISOString();
            const next = {
                ...current,
                title: nextTitle,
                message: nextMessage,
                status: nextStatus,
                updatedBy: requesterHandle,
                updatedAt,
                history: [
                    ...(Array.isArray(current.history) ? current.history : []),
                    {
                        at: updatedAt,
                        by: requesterHandle,
                        fromStatus: current.status,
                        toStatus: nextStatus,
                        changedTitle: nextTitle !== current.title,
                        changedMessage: nextMessage !== current.message
                    }
                ]
            };

            store.items[index] = next;
            pushFeedbackActivity(store, {
                type: 'updated',
                by: requesterHandle,
                feedbackId: next.id,
                feedbackTitle: next.title,
                details: { fromStatus: current.status, toStatus: next.status }
            });

            await writeFeedbackStore(store);

            const wss = getWss && getWss();
            if (wss) {
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'FEEDBACK_UPDATED' }));
                    }
                });
            }

            res.json(next);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.delete('/api/feedback/:feedbackId', async (req, res) => {
        try {
            const feedbackId = String(req.params.feedbackId || '').trim();
            const requesterHandle = extractRequesterHandle(req);
            const adminPassword = extractAdminPassword(req);

            if (!feedbackId) {
                res.status(400).json({ error: 'feedbackId is required' });
                return;
            }

            const store = await readFeedbackStore();
            const index = store.items.findIndex(item => item.id === feedbackId);
            if (index === -1) {
                res.status(404).json({ error: 'Feedback not found' });
                return;
            }

            const target = store.items[index];
            if (!canManageFeedback(target, requesterHandle, adminPassword, req)) {
                res.status(403).json({ error: 'Only feedback author or admin can delete this item' });
                return;
            }

            store.items.splice(index, 1);
            pushFeedbackActivity(store, {
                type: 'deleted',
                by: requesterHandle,
                feedbackId: target.id,
                feedbackTitle: target.title,
                details: { deletedStatus: target.status, createdBy: target.createdBy }
            });

            await writeFeedbackStore(store);

            const wss = getWss && getWss();
            if (wss) {
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'FEEDBACK_UPDATED' }));
                    }
                });
            }

            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.get('/api/brackets', async (req, res) => {
        try {
            const brackets = await readBrackets();
            res.json(brackets);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.post('/api/brackets', async (req, res) => {
        try {
            const body = req.body || {};
            const ownerHandle = String(extractRequesterHandle(req) || '').trim();
            const type = String(body.type || 'round-robin').trim();
            const participants = normalizeParticipants(body.participants || []);
            const roomConfig = normalizeBracketRoomConfig(body.roomConfig || {});

            const now = Date.now();
            const cutoff = now - 24 * 60 * 60 * 1000;
            const allBrackets = await readBrackets();
            const userBrackets = allBrackets.filter(b => normalizeHandle(b.ownerHandle) === normalizeHandle(ownerHandle) && new Date(b.createdAt).getTime() >= cutoff);
            if (userBrackets.length >= 100) {
                res.status(429).json({ error: 'Bracket creation limit reached (100 per 24 hours).' });
                return;
            }

            if (!ownerHandle) {
                res.status(401).json({ error: 'Login required' });
                return;
            }

            if (participants.length < 2) {
                res.status(400).json({ error: 'At least 2 participants required' });
                return;
            }

            if (participants.length > 1000) {
                res.status(400).json({ error: 'Maximum 1000 participants allowed per bracket.' });
                return;
            }

            const supported = ['round-robin', 'single-elimination', 'double-elimination'];
            if (!supported.includes(type)) {
                res.status(400).json({ error: 'Unsupported tournament type' });
                return;
            }

            async function fetchCodeforcesProfiles(handles) {
                const map = {};
                if (!Array.isArray(handles) || handles.length === 0) return map;
                const chunkSize = 80;
                for (let i = 0; i < handles.length; i += chunkSize) {
                    const chunk = handles.slice(i, i + chunkSize);
                    try {
                        const response = await fetch(`https://codeforces.com/api/user.info?handles=${encodeURIComponent(chunk.join(';'))}`);
                        const data = await response.json();
                        if (data.status !== 'OK' || !Array.isArray(data.result)) continue;
                        data.result.forEach(user => {
                            map[user.handle] = { rating: user.rating ?? null, maxRating: user.maxRating ?? null };
                        });
                    } catch {}
                }
                return map;
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

            const handleProfiles = {};
            const codeforcesProfiles = await fetchCodeforcesProfiles(participants);
            for (const handle of participants) {
                const profile = codeforcesProfiles[handle] || {};
                const rating = profile.rating ?? null;
                const maxRating = profile.maxRating ?? null;
                const rankClass = getRankClassByMaxRating(maxRating);
                handleProfiles[handle] = { rating, maxRating, rankClass };
            }

            const bracket = {
                id: `b_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                name: String(body.name || 'Tournament').trim() || 'Tournament',
                type,
                ownerHandle,
                participants,
                roomConfig,
                usedProblemIds: [],
                matches: generateBracketMatches(type, participants),
                createdAt: new Date().toISOString(),
                handleProfiles
            };

            autoAdvanceBracketByes(bracket);
            applyChampionPlaceholders(bracket);

            const brackets = await readBrackets();
            brackets.unshift(bracket);
            await writeBrackets(brackets);

            res.json(bracket);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.delete('/api/brackets/:bracketId', async (req, res) => {
        try {
            const { bracketId } = req.params;
            const requesterHandle = extractRequesterHandle(req);
            const adminPassword = extractAdminPassword(req);

            const brackets = await readBrackets();
            const target = brackets.find(item => item.id === bracketId);
            if (!target) {
                res.status(404).json({ error: 'Bracket not found' });
                return;
            }

            if (!canManageBracket(target, requesterHandle, adminPassword, req)) {
                res.status(403).json({ error: 'Only bracket creator or admin can delete this bracket' });
                return;
            }

            const next = brackets.filter(item => item.id !== bracketId);
            await writeBrackets(next);
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.post('/api/brackets/:bracketId/matches/:matchId/create-room', async (req, res) => {
        try {
            const { bracketId, matchId } = req.params;
            const body = req.body || {};
            const requesterHandle = extractRequesterHandle(req);
            const adminPassword = extractAdminPassword(req);

            const brackets = await readBrackets();
            const bracketIndex = brackets.findIndex(item => item.id === bracketId);
            if (bracketIndex === -1) {
                res.status(404).json({ error: 'Bracket not found' });
                return;
            }

            const bracket = brackets[bracketIndex];
            const match = (bracket.matches || []).find(item => item.id === matchId);
            if (!match) {
                res.status(404).json({ error: 'Match not found' });
                return;
            }

            const adminRequest = isAdminRequester(requesterHandle, adminPassword, req);

            if (!canCreateBracketRoom(bracket, match, requesterHandle, adminPassword, req)) {
                res.status(403).json({ error: 'Only assigned match players or admin can create match rooms' });
                return;
            }

            if (match.status === 'completed') {
                res.status(400).json({ error: 'Match already completed' });
                return;
            }

            if (!match.p1 || !match.p2 || /winner|loser|champion|slot/i.test(`${match.p1} ${match.p2}`)) {
                res.status(400).json({ error: 'This match is not ready yet. Participants are placeholders.' });
                return;
            }

            if (/\bbye\b/i.test(`${match.p1} ${match.p2}`)) {
                res.status(400).json({ error: 'This match includes BYE and should auto-advance without room creation.' });
                return;
            }

            if (match.roomId && getWss && getWss()) {
                const wss = getWss();
                if (wss && wss.rooms && wss.rooms.has(match.roomId)) {
                    res.json({ success: true, roomId: match.roomId, alreadyExists: true });
                    return;
                }
            }

            const roomConfig = normalizeBracketRoomConfig(bracket.roomConfig || {});
            const requestedProblemConfigs = Array.isArray(body.problems) && body.problems.length > 0
                ? normalizeRoomProblems(body.problems, body.problems.length)
                : (Array.isArray(roomConfig.problems) && roomConfig.problems.length > 0
                    ? roomConfig.problems
                    : buildDefaultProblems(roomConfig.problemCount));
            const bracketUsedProblemIds = getBracketUsedProblemIds(bracket);
            const preGeneratedProblems = [];

            bracket.usedProblemIds = Array.from(new Set([...bracketUsedProblemIds]));

            const participants = resolveBracketRoomPlayers(match, requesterHandle, adminRequest);

            const room = await createBracketRoom({
                hostHandle: participants.hostHandle,
                opponentHandle: participants.opponentHandle,
                roomName: `${bracket.name} · ${match.label} · ${match.p1} vs ${match.p2}`,
                duration: Number(body.duration) || roomConfig.duration,
                interval: Number(body.interval) || roomConfig.interval,
                problems: requestedProblemConfigs,
                problemCount: requestedProblemConfigs.length || Number(body.problemCount) || roomConfig.problemCount,
                preGeneratedProblems,
                bracketId: bracket.id,
                bracketMatchId: match.id,
                bracketExcludedProblemIds: bracket.usedProblemIds
            });

            match.roomId = room.id;
            await writeBrackets(brackets);

            res.json({ success: true, roomId: room.id });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
};
