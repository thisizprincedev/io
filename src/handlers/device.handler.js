const { prisma } = require('../config/database');
const { pubClient } = require('../config/redis');
const logger = require('../../utils/logger');
const { socketConnections } = require('../../utils/metrics');

const getVal = (obj, key1, key2) => {
    if (!obj) return undefined;
    if (obj[key1] !== undefined && obj[key1] !== null) return obj[key1];
    if (key2 && obj[key2] !== undefined && obj[key2] !== null) return obj[key2];
    return undefined;
};

// Consolidated buffer for all device updates (status + info)
let deviceUpdateBuffer = new Map();
let isFlushing = false;
const STATUS_FLUSH_INTERVAL = 2000; // 2 seconds

async function flushDeviceUpdates() {
    if (deviceUpdateBuffer.size === 0 || isFlushing) return;

    isFlushing = true;
    // Work on a snapshot of the current buffer
    const updatesToFlush = new Map(deviceUpdateBuffer);
    const deviceIds = Array.from(updatesToFlush.keys());

    try {
        await prisma.$transaction(
            deviceIds.map(dId => {
                const info = updatesToFlush.get(dId);
                return prisma.device.upsert({
                    where: { device_id: dId },
                    update: info,
                    create: {
                        device_id: dId,
                        ...info
                    }
                });
            })
        );

        // Remove successfully flushed items from the main buffer
        for (const dId of deviceIds) {
            // Only remove if it hasn't been updated again since we took the snapshot
            const current = deviceUpdateBuffer.get(dId);
            const snapshot = updatesToFlush.get(dId);
            if (current === snapshot) {
                deviceUpdateBuffer.delete(dId);
            }
        }

        logger.debug(`Successfully flushed updates for ${deviceIds.length} devices`);
    } catch (err) {
        logger.error(err, `❌ Error flushing device updates for ${deviceIds.length} devices`);
        // We keep the data in deviceUpdateBuffer for the next attempt
    } finally {
        isFlushing = false;
    }
}

setInterval(flushDeviceUpdates, STATUS_FLUSH_INTERVAL);

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

        // Queue device online status update
        const current = deviceUpdateBuffer.get(deviceId) || {};
        deviceUpdateBuffer.set(deviceId, {
            ...current,
            status: true,
            last_seen: new Date(),
            app_id: appId,
            build_id: buildId
        });
        notifyChange('device_change', { device_id: deviceId, status: true, last_seen: new Date() });
    }

    socket.on('disconnect', () => {
        socketConnections.dec();
        logger.info({ socket: socket.id }, '🔌 Socket disconnected');

        if (deviceId) {
            const current = deviceUpdateBuffer.get(deviceId) || {};
            deviceUpdateBuffer.set(deviceId, {
                ...current,
                status: false,
                last_seen: new Date()
            });
            notifyChange('device_change', { device_id: deviceId, status: false, last_seen: new Date() });
        }
    });

    // 2. Device Data Upsert (Initial or detailed update)
    socket.on('upsert_device_data', (rawData, ack) => {
        try {
            const data = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;

            const dId = getVal(data, 'device_id', 'deviceId') || deviceId;
            if (dId !== deviceId && !socket.isAdmin) {
                logger.warn({ socketDeviceId: deviceId, payloadDeviceId: dId }, '⚠️ Security Alert: Unauthorized device data upsert attempt (ID mismatch)');
                if (ack) ack(false);
                return;
            }

            if (!dId) {
                logger.warn({ socketId: socket.id }, '⚠️ Unauthorized device data upsert attempt (Missing deviceId)');
                if (ack) ack(false);
                return;
            }

            const deviceInfo = {
                android_id: getVal(data, 'android_id', 'androidId'),
                manufacturer: getVal(data, 'manufacturer'),
                model: getVal(data, 'model'),
                brand: getVal(data, 'brand'),
                product: getVal(data, 'product'),
                android_version: getVal(data, 'android_version', 'androidVersion'),
                app_id: getVal(data, 'app_id', 'appId') || appId,
                build_id: getVal(data, 'build_id', 'buildId') || buildId,
                raw_device_info: JSON.stringify(data),
                sim_cards: getVal(data, 'sim_cards', 'simCards'),
                service_status: getVal(data, 'service_status', 'serviceStatus'),
                oem_status: getVal(data, 'oem_status', 'oemStatus'),
                power_save_status: getVal(data, 'power_save_status', 'powerSaveStatus'),
                screen_status: getVal(data, 'screen_status', 'screenStatus'),
                process_importance: String(getVal(data, 'process_importance') || ""),
                last_seen: new Date(),
                status: true
            };

            const current = deviceUpdateBuffer.get(dId) || {};
            deviceUpdateBuffer.set(dId, {
                ...current,
                ...deviceInfo
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
        const targetDeviceId = dId || deviceId;
        if (!targetDeviceId) return ack && ack(JSON.stringify([]));

        if (targetDeviceId !== deviceId && !socket.isAdmin) {
            if (ack) ack(JSON.stringify([]));
            return;
        }

        try {
            // Optimization: Check Redis flag first to avoid DB query if no commands
            const cacheKey = `commands:pending:${targetDeviceId}`;
            const hasPending = await pubClient.get(cacheKey);

            // If cache says '0', we know for sure there are no pending commands
            if (hasPending === '0') {
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
                },
                take: 10
            });

            const formattedCommands = commands.map(cmd => ({
                id: cmd.id,
                device_id: cmd.device_id,
                command: cmd.command,
                payload: cmd.payload,
                status: cmd.status,
                created_at: cmd.created_at
            }));

            // Cache result to avoid next DB hit
            if (formattedCommands.length === 0) {
                await pubClient.set(cacheKey, '0', 'EX', 60); // Cache "no commands" for 60s
            } else {
                await pubClient.set(cacheKey, '1', 'EX', 3600); // Flag "has commands"
            }

            if (ack) ack(JSON.stringify(formattedCommands));
        } catch (err) {
            logger.debug(`❌ Silent error fetching commands for ${targetDeviceId}: ${err.message}`);
            if (ack) ack(JSON.stringify([]));
        }
    });


    // Register other handlers
    require('./telemetry.handler')(socket, io, notifyChange);
}

module.exports = handleConnection;
