const logger = require('../../utils/logger');
const crypto = require('crypto');

function setupAuthMiddleware(io) {
    const secret = process.env.SOCKETIO_AUTH_KEY || process.env.MOBILE_API_ACCESS_KEY || 'your-fallback-secret';

    io.use((socket, next) => {
        const query = socket.handshake.query;
        const {
            device_id,
            app_id,
            auth_key,
            admin_token,
            build_id,
            signature,
            timestamp,
            nonce
        } = query;

        const deviceId = device_id;

        // 1. Check for Admin token
        if (admin_token && admin_token === process.env.ADMIN_TOKEN) {
            socket.isAdmin = true;
            return next();
        }

        // 2. HMAC Signature Verification (Preferred)
        if (signature && timestamp && nonce) {
            const dataToSign = `${timestamp}.${nonce}.${deviceId}`;
            const expectedSignature = crypto
                .createHmac('sha256', secret)
                .update(dataToSign)
                .digest('hex');

            if (signature === expectedSignature) {
                // Check timestamp freshness (5 min window)
                const now = Date.now();
                const sigTime = parseInt(timestamp);
                if (Math.abs(now - sigTime) < 300000) {
                    socket.deviceId = deviceId;
                    socket.appId = app_id;
                    socket.buildId = build_id;
                    return next();
                }
            }
        }

        // 3. Fallback to static auth_key (Legacy/Initial Registration)
        if (auth_key && auth_key === secret) {
            if (!deviceId) return next(new Error('device_id required'));

            socket.deviceId = deviceId;
            socket.appId = app_id;
            socket.buildId = build_id;
            return next();
        }

        logger.warn({ device_id: deviceId, ip: socket.handshake.address, hasSignature: !!signature }, '❌ Unauthorized socket connection attempt');
        return next(new Error('Authentication failed'));
    });
}

module.exports = setupAuthMiddleware;
