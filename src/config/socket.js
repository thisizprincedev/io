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
        transports: ['websocket'], // Force websocket only for 1M scale performance
        perMessageDeflate: false,    // Reduce CPU/Memory per connection
        pingTimeout: 60000,          // Balanced for high-concurrency (1m)
        pingInterval: 10000,         // Faster detection of dead connections
        connectTimeout: 30000,
        maxHttpBufferSize: 1e6,      // 1MB (Reduces memory risk per client)
        cleanupEmptyChildNamespaces: true
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
