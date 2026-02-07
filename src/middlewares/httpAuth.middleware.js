const logger = require('../../utils/logger');

/**
 * Basic HTTP API Key authentication for SocketIOProviderServer
 * Secure version: Only accepts ADMIN_TOKEN, intended for backend-to-backend communication.
 * The mobile app connects via Socket.IO using SOCKETIO_AUTH_KEY.
 */
const httpAuthMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization;
    const apiKeyHeader = req.headers['x-api-key'];
    const secret = process.env.ADMIN_TOKEN;

    if (!secret) {
        logger.error('ADMIN_TOKEN not configured on server. HTTP API is disabled for safety.');
        return res.status(500).json({ error: 'Server configuration error: ADMIN_TOKEN missing' });
    }

    // Check Authorization header (Bearer token)
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        if (token === secret) return next();
    }

    // Check X-API-Key header
    if (apiKeyHeader === secret) return next();

    // Check query param
    if (req.query.api_key === secret) return next();

    logger.warn({ ip: req.ip, path: req.path }, '❌ Unauthorized HTTP API access attempt (Blocked Mobile App or Rogue access)');
    return res.status(401).json({ error: 'Unauthorized: Admin access required' });
};

module.exports = httpAuthMiddleware;
