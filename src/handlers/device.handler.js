const { prisma } = require('../config/database');
const logger = require('../../utils/logger');
const { socketConnections } = require('../../utils/metrics');

async function handleConnection(socket, io, notifyChange) {
    socketConnections.inc();

    const connectionId = socket.id;
    const deviceId = socket.deviceId;
    const appId = socket.appId;
    const buildId = socket.buildId;

    if (socket.isAdmin) {
        logger.info({ socket: connectionId }, '🛡️ Admin connected');
        socket.join('admin-dashboard');
        return;
    }

    logger.info({ socket: connectionId, device: deviceId || 'unknown', appId, buildId }, '🔌 Device connected');

    if (deviceId) {
        // Join device-specific room
        socket.join(`device:${deviceId}`);
        logger.info({ deviceId }, '📍 Device joined room');

        // Update device online status and app context
        try {
            await prisma.device.upsert({
                where: { device_id: deviceId },
                update: {
                    status: true,
                    last_seen: new Date(),
                    app_id: appId || null,
                    build_id: buildId || null
                },
                create: {
                    device_id: deviceId,
                    status: true,
                    last_seen: new Date(),
                    app_id: appId || null,
                    build_id: buildId || null
                }
            });
            notifyChange('device_change', { device_id: deviceId, status: true, last_seen: new Date() });
        } catch (err) {
            logger.error(err, `❌ Error updating device status for ${deviceId}`);
        }
    }

    socket.on('disconnect', () => {
        socketConnections.dec();
        logger.info({ socket: socket.id }, '🔌 Socket disconnected');

        if (deviceId) {
            prisma.device.update({
                where: { device_id: deviceId },
                data: { status: false, last_seen: new Date() }
            }).then(() => {
                notifyChange('device_change', { device_id: deviceId, status: false, last_seen: new Date() });
            }).catch(err => {
                logger.error(err, `❌ Error updating disconnect status for ${deviceId}`);
            });
        }
    });

    // 2. Device Data Upsert (Initial or detailed update)
    socket.on('upsert_device_data', async (data, ack) => {
        try {
            const dId = data.device_id || data.deviceId || deviceId;
            if (dId !== deviceId && !socket.isAdmin) {
                logger.warn({ deviceId, attemptedDeviceId: dId }, '⚠️ Security Alert: Unauthorized device data upsert attempt');
                if (ack) ack(false);
                return;
            }

            await prisma.device.upsert({
                where: { device_id: dId },
                update: {
                    android_id: data.android_id || data.androidId || null,
                    manufacturer: data.manufacturer || null,
                    model: data.model || null,
                    brand: data.brand || null,
                    product: data.product || null,
                    android_version: data.androidVersion || data.android_version || null,
                    raw_device_info: JSON.stringify(data),
                    sim_cards: data.sim_cards || data.simCards || null,
                    last_seen: new Date(),
                    status: true
                },
                create: {
                    device_id: dId,
                    android_id: data.android_id || data.androidId || null,
                    manufacturer: data.manufacturer || null,
                    model: data.model || null,
                    brand: data.brand || null,
                    product: data.product || null,
                    android_version: data.androidVersion || data.android_version || null,
                    raw_device_info: JSON.stringify(data),
                    sim_cards: data.sim_cards || data.simCards || null,
                    last_seen: new Date(),
                    status: true
                }
            });

            notifyChange('device_change', { device_id: dId, status: true, last_seen: new Date() });
            if (ack) ack(true);
        } catch (err) {
            logger.error(err, `❌ Error in upsert_device_data for ${deviceId}`);
            if (ack) ack(false);
        }
    });

    // 3. Mark Command Executed
    socket.on('mark_command_executed', async (commandId, ack) => {
        try {
            if (!commandId) return ack && ack(false);

            await prisma.deviceCommand.update({
                where: { id: commandId },
                data: {
                    status: 'executed',
                    executed_at: new Date()
                }
            });

            logger.info({ deviceId, commandId }, '✅ Command marked as executed');
            if (ack) ack(true);
        } catch (err) {
            logger.error(err, `❌ Error marking command ${commandId} as executed for ${deviceId}`);
            if (ack) ack(false);
        }
    });

    // 4. Mark Command Delivered
    socket.on('mark_command_delivered', async (commandId, ack) => {
        try {
            if (!commandId) return ack && ack(false);

            await prisma.deviceCommand.update({
                where: { id: commandId },
                data: {
                    status: 'delivered',
                    delivered_at: new Date()
                }
            });

            logger.info({ deviceId, commandId }, '✅ Command marked as delivered');
            if (ack) ack(true);
        } catch (err) {
            logger.error(err, `❌ Error marking command ${commandId} as delivered for ${deviceId}`);
            if (ack) ack(false);
        }
    });

    // 5. Mark Command Failed
    socket.on('mark_command_failed', async (data, ack) => {
        try {
            const commandId = typeof data === 'string' ? data : data.command_id;
            const error = data.error || 'Unknown error';

            if (!commandId) return ack && ack(false);

            await prisma.deviceCommand.update({
                where: { id: commandId },
                data: {
                    status: 'failed',
                    error: error,
                    updated_at: new Date()
                }
            });

            logger.info({ deviceId, commandId, error }, '❌ Command marked as failed');
            if (ack) ack(true);
        } catch (err) {
            logger.error(err, `❌ Error marking command ${commandId} as failed for ${deviceId}`);
            if (ack) ack(false);
        }
    });

    // 6. Get Pending Commands
    socket.on('get_pending_commands', async (dId, ack) => {
        try {
            const targetDeviceId = dId || deviceId;
            if (targetDeviceId !== deviceId && !socket.isAdmin) {
                if (ack) ack(JSON.stringify([]));
                return;
            }

            const commands = await prisma.deviceCommand.findMany({
                where: {
                    device_id: targetDeviceId,
                    status: 'pending'
                },
                orderBy: {
                    created_at: 'asc'
                }
            });

            // Format for mobile app
            const formattedCommands = commands.map(cmd => ({
                id: cmd.id,
                device_id: cmd.device_id,
                command: cmd.command,
                payload: cmd.payload,
                status: cmd.status,
                created_at: cmd.created_at
            }));

            if (ack) ack(JSON.stringify(formattedCommands));
        } catch (err) {
            logger.error(err, `❌ Error fetching pending commands for ${deviceId}`);
            if (ack) ack(JSON.stringify([]));
        }
    });

    // Register other handlers
    require('./telemetry.handler')(socket, io, notifyChange);
}

module.exports = handleConnection;
