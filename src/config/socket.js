const socketIo = require('socket.io');
const { createRedisAdapter } = require('./redis');

function configureSocket(server) {
    const io = socketIo(server, {
        cors: {
            origin: "*",
            methods: ["GET", "POST"]
        },
        adapter: createRedisAdapter(),
        transports: ['polling', 'websocket'], // Allow both for better compatibility
        perMessageDeflate: false,    // Reduce CPU/Memory per connection
        pingTimeout: 60000,
        pingInterval: 25000,
        maxHttpBufferSize: 1e7,
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
