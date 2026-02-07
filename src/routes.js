const logger = require('../utils/logger');

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
                orderBy: { last_seen: 'desc' }
            });
            res.json(devices);
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
                where: { device_id: deviceId }
            });
            if (!device) return res.status(404).json({ error: 'Device not found' });

            if (appId && device.app_id !== appId) {
                return res.status(403).json({ error: 'Forbidden: Device belongs to another app' });
            }

            res.json(device);
        } catch (error) {
            logger.error(`Error fetching device ${deviceId}:`, error);
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
