const { prisma } = require('../config/database');
const { pubClient } = require('../config/redis');
const logger = require('../../utils/logger');

function setupAdminHandlers(socket, io, notifyChange) {
    if (!socket.isAdmin) return;

    // Send Command to a specific device
    socket.on('send_command', async (data, ack) => {
        try {
            const { device_id, command, payload } = data;
            if (!device_id || !command) {
                if (ack) ack({ success: false, error: 'device_id and command required' });
                return;
            }

            const newCommand = await prisma.deviceCommand.create({
                data: {
                    device_id,
                    command,
                    payload: payload || null,
                    status: 'pending'
                }
            });

            // Set Redis cache flag to let device know it has pending commands
            await pubClient.set(`commands:pending:${device_id}`, '1', 'EX', 3600);

            const commandToSend = {
                id: newCommand.id,
                device_id: newCommand.device_id,
                command: newCommand.command,
                payload: newCommand.payload,
                status: newCommand.status
            };

            // Emit to the specific device room
            io.to(`device:${device_id}`).emit('command', JSON.stringify([commandToSend]));

            logger.info({ admin: socket.id, target: device_id, command }, '🛡️ Admin issued command');
            if (ack) ack({ success: true, command: newCommand });
        } catch (err) {
            logger.error(err, '❌ Admin send_command error');
            if (ack) ack({ success: false, error: err.message });
        }
    });

    // Broadcast event to all admins
    socket.on('broadcast_admin_event', (data) => {
        socket.to('admin-dashboard').emit('admin_event', data);
    });
}

module.exports = setupAdminHandlers;
