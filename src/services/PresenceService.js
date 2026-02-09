const { pubClient: redis } = require('../config/redis');
const logger = require('../../utils/logger');

const PRESENCE_KEY_PREFIX = 'presence:';
const EXPIRY_SECONDS = 300; // 5 minutes

/**
 * Mark a device as online
 */
async function markOnline(deviceId) {
    if (!deviceId) return;
    try {
        const key = `${PRESENCE_KEY_PREFIX}${deviceId}`;
        await redis.set(key, '1', 'EX', EXPIRY_SECONDS);
    } catch (err) {
        logger.error(err, `[PresenceService] Failed to mark device ${deviceId} online:`);
    }
}

/**
 * Mark a device as offline
 */
async function markOffline(deviceId) {
    if (!deviceId) return;
    try {
        const key = `${PRESENCE_KEY_PREFIX}${deviceId}`;
        await redis.del(key);
    } catch (err) {
        logger.error(err, `[PresenceService] Failed to mark device ${deviceId} offline:`);
    }
}

/**
 * Check if a device is online
 */
async function isOnline(deviceId) {
    if (!deviceId) return false;
    try {
        const key = `${PRESENCE_KEY_PREFIX}${deviceId}`;
        const exists = await redis.exists(key);
        return exists === 1;
    } catch (err) {
        logger.error(err, `[PresenceService] Failed to check status for ${deviceId}:`);
        return false;
    }
}

module.exports = {
    markOnline,
    markOffline,
    isOnline
};
