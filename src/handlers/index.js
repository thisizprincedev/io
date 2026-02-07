const deviceHandler = require('./device.handler');
const adminHandler = require('./admin.handler');
const logger = require('../../utils/logger');
const { socketEvents } = require('../../utils/metrics');

/**
 * List of sensitive events that only admins should be able to trigger
 */
const ADMIN_ONLY_EVENTS = ['send_command', 'broadcast_admin_event'];

function registerHandlers(io, notifyChange) {
    io.on('connection', (socket) => {
        // Track events per socket
        const originalOn = socket.on;
        socket.on = function (event, callback) {
            return originalOn.call(this, event, function (...args) {
                // Increment metrics
                if (socketEvents) {
                    socketEvents.labels(event).inc();
                }

                // Security Guard: Check if event is admin-only
                if (ADMIN_ONLY_EVENTS.includes(event) && !socket.isAdmin) {
                    logger.warn({
                        socket: socket.id,
                        event,
                        deviceId: socket.deviceId,
                        ip: socket.handshake.address
                    }, '⚠️ Unauthorized external event attempt');

                    // Optionally notify the client of the failure
                    const ack = args[args.length - 1];
                    if (typeof ack === 'function') {
                        ack({ success: false, error: 'Unauthorized event' });
                    }
                    return;
                }

                return callback.apply(this, args);
            });
        };

        // Delegate to handlers
        deviceHandler(socket, io, notifyChange);
        adminHandler(socket, io, notifyChange);
    });
}

module.exports = registerHandlers;
