(async () => {
    const fetch = global.fetch || (await import('node-fetch')).default;
    const WebSocket = require('ws');
    const API = 'http://localhost:3000';

    function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

    try {
        console.log('[TEST] Logging in Host (MITMAX)');
        const respA = await fetch(`${API}/api/session/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: 'MITMAX' })
        });
        const setCookieA = respA.headers.get('set-cookie') || respA.headers.get('Set-Cookie');
        console.log('[TEST] login A:', respA.status, 'cookie:', !!setCookieA);
        if (!setCookieA) return process.exit(2);
        const cookieHeaderA = setCookieA.split(';')[0];

        console.log('[TEST] Logging in Joiner (greed_y)');
        const respB = await fetch(`${API}/api/session/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: 'greed_y' })
        });
        const setCookieB = respB.headers.get('set-cookie') || respB.headers.get('Set-Cookie');
        console.log('[TEST] login B:', respB.status, 'cookie:', !!setCookieB);
        if (!setCookieB) return process.exit(2);
        const cookieHeaderB = setCookieB.split(';')[0];

        // Connect WS for A
        console.log('[TEST] Connecting WS A with cookie', cookieHeaderA);
        const wsA = new WebSocket('ws://localhost:3000', { headers: { Cookie: cookieHeaderA } });
        let createdRoomId = null;

        wsA.on('open', () => {
            console.log('[TEST A] open');
        });
        wsA.on('message', (m) => {
            try { const msg = JSON.parse(String(m)); console.log('[TEST A] RX', msg);
                if (msg.type === 'ROOM_CREATED') {
                    createdRoomId = msg.roomId;
                    console.log('[TEST] Created roomId=', createdRoomId);
                }
            } catch(e){ console.log('[TEST A] RAW', String(m)); }
        });

        // Wait a bit
        await sleep(300);

        // A creates a room
        const createPayload = { type: 'CREATE_ROOM', roomName: 'smoke-join', opponentHandle: 'USER_B', duration: 5, interval: 1, problems: [{points:2, rating:800}] };
        console.log('[TEST A] sending CREATE_ROOM');
        wsA.send(JSON.stringify(createPayload));

        // Wait until room created
        let wait = 0;
        while(!createdRoomId && wait < 5000){ await sleep(200); wait += 200; }
        if (!createdRoomId) { console.error('[TEST] room not created'); wsA.close(); return process.exit(3); }

        // Connect WS for B and join
        console.log('[TEST] Connecting WS B with cookie', cookieHeaderB);
        const wsB = new WebSocket('ws://localhost:3000', { headers: { Cookie: cookieHeaderB } });
        wsB.on('open', () => { console.log('[TEST B] open, sending JOIN_ROOM', createdRoomId); wsB.send(JSON.stringify({ type: 'JOIN_ROOM', roomId: createdRoomId })); });
        wsB.on('message', (m) => { try { const msg = JSON.parse(String(m)); console.log('[TEST B] RX', msg); } catch(e){ console.log('[TEST B] RAW', String(m)); } });

        // Observe messages for a short time
        await sleep(3000);
        try { wsA.close(); } catch {};
        try { wsB.close(); } catch {};

        console.log('[TEST] Done');
        process.exit(0);
    } catch (err) {
        console.error('[TEST] Exception', err);
        process.exit(1);
    }
})();
