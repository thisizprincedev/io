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
        transports: ['websocket', 'polling'], // Prioritize websocket
        perMessageDeflate: false,    // Reduce CPU/Memory per connection
        pingTimeout: 60000,
        pingInterval: 25000,
        maxHttpBufferSize: 1e8,      // 100MB
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
