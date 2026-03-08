const path = require('path');
const fs = require('fs').promises;
const ROOMS_FILE = path.join(__dirname, 'rooms.json');

async function initRoomsFile() {
    try {
        const raw = await fs.readFile(ROOMS_FILE, 'utf8');
        const trimmed = String(raw || '').trim();
        if (!trimmed) {
            await fs.writeFile(ROOMS_FILE, JSON.stringify([]));
            return;
        }
        const parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed)) {
            await fs.writeFile(ROOMS_FILE, JSON.stringify([]));
        }
    } catch {
        await fs.writeFile(ROOMS_FILE, JSON.stringify([]));
    }
}

async function saveRoomsToDisk(roomsMap) {
    // Only persist serializable room state (remove ws, timeouts, functions)
    const serializableRooms = Array.from(roomsMap.values()).map(room => {
        const copy = { ...room };
        // Remove websocket and timeout references
        if (Array.isArray(copy.players)) {
            copy.players = copy.players.map(player => ({
                ...player,
                ws: undefined // Remove ws reference
            }));
        }
        // Remove all timeout and non-serializable fields
        delete copy.endTimeout;
        delete copy.cleanupTimeout;
        delete copy.noOpponentTimeout;
        delete copy.unstartedTimeout;
        delete copy.countdownTimeout;
        delete copy.breakAdvanceTimeout;
        return copy;
    });
    await fs.writeFile(ROOMS_FILE, JSON.stringify(serializableRooms, null, 2));
}

async function loadRoomsFromDisk() {
    try {
        const raw = await fs.readFile(ROOMS_FILE, 'utf8');
        const trimmed = String(raw || '').trim();
        if (!trimmed) return [];
        const parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed)) return [];
        return parsed;
    } catch {
        return [];
    }
}

module.exports = { ROOMS_FILE, initRoomsFile, saveRoomsToDisk, loadRoomsFromDisk };
