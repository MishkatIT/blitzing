(async () => {
    const WebSocket = require('ws');
    const WS = 'ws://localhost:3000';
    try {
        console.log('[TEST] Connecting to', WS);
        const ws = new WebSocket(WS);

        ws.on('open', () => {
            console.log('[TEST] WS open, requesting ACTIVE_ROOMS');
            ws.send(JSON.stringify({ type: 'GET_ACTIVE_ROOMS' }));
        });

        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(String(data));
                console.log('[TEST] WS RX', JSON.stringify(msg, null, 2));
            } catch (e) {
                console.log('[TEST] WS RAW RX', String(data));
            }
            // close after first message
            try { ws.close(); } catch (e) {}
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
            try { ws.close(); } catch (e) {}
            process.exit(0);
        }, 8000);

    } catch (err) {
        console.error('[TEST] Exception', err);
        process.exit(1);
    }
})();
