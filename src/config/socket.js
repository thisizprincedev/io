const socketIo = require('socket.io');
const { createRedisAdapter } = require('./redis');

function configureSocket(server) {
    const io = socketIo(server, {
        cors: {
            origin: "*",
            methods: ["GET", "POST"],
            credentials: true
        },
        adapter: createRedisAdapter(),
        allowEIO3: true,
        // transports: ['websocket'], // Allowed polling fallback now that sticky sessions are enabled
        perMessageDeflate: false,
        pingTimeout: 30000,          // Reduced from 60s to 30s for faster dead-connection detection
        pingInterval: 15000,         // Slightly slower interval to reduce overhead on 1M scale
        connectTimeout: 45000,       // More generous for slow mobile networks
        maxHttpBufferSize: 1e6,      // 1MB
        cleanupEmptyChildNamespaces: true,
        connectionStateRecovery: {    // Enable state recovery for short disconnections
            maxDisconnectionDuration: 5 * 60 * 1000, // Increased to 5 minutes
            skipMiddlewares: false, // 🛡️ CRITICAL: Run auth middleware during recovery to re-populate socket.deviceId
        },
    });

    // Memory optimization: Discard raw request data after handshake
    io.on("connection", (socket) => {
        if (socket.conn && socket.conn.request) {
            socket.conn.request = null;
        }
    });

    return io;
}

module.exports = configureSocket;
