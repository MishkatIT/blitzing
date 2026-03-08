// Smoke test for CREATE_ROOM
(async () => {
    const fetch = global.fetch || (await import('node-fetch')).default;
    const WebSocket = require('ws');
    const API = 'http://localhost:3000';
    try {
        console.log('[TEST] Requesting bypass login for MITMAX');
        const resp = await fetch(`${API}/api/session/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ handle: 'MITMAX' })
        });
        const body = await resp.json().catch(() => ({}));
        const setCookie = resp.headers.get('set-cookie') || resp.headers.get('Set-Cookie');
        console.log('[TEST] login response:', resp.status, body, 'set-cookie:', setCookie);
        if (!setCookie) {
            console.error('[TEST] No set-cookie returned. Cannot authenticate WS.');
            process.exit(2);
        }

        // Use cookie in WebSocket handshake
        const cookieHeader = setCookie.split(';')[0];
        console.log('[TEST] Connecting WS with cookie:', cookieHeader);
        const ws = new WebSocket('ws://localhost:3000', { headers: { Cookie: cookieHeader } });

        ws.on('open', () => {
            console.log('[TEST] WS open, sending CREATE_ROOM');
            const payload = {
                type: 'CREATE_ROOM',
                // handle will be set by server from session cookie
                roomName: "Smoke Test Room",
                opponentHandle: 'greed_y',
                duration: 10,
                interval: 1,
                problems: [{ points: 2, rating: 800 }]
            };
            console.log('[TEST] WS TX', payload);
            ws.send(JSON.stringify(payload));
        });

        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(String(data));
                console.log('[TEST] WS RX', msg);
            } catch (e) {
                console.log('[TEST] WS RAW RX', String(data));
            }
        });

        ws.on('error', (err) => {
            console.error('[TEST] WS error', err);
            process.exit(3);
        });

        ws.on('close', (code, reason) => {
            console.log('[TEST] WS closed', code, reason && reason.toString());
            process.exit(0);
        });

        // safety timeout
        setTimeout(() => {
            console.log('[TEST] Timeout reached, closing');
            try { ws.close(); } catch {}
            process.exit(0);
        }, 8000);

    } catch (err) {
        console.error('[TEST] Exception', err);
        process.exit(1);
    }
})();
