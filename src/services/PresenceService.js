const { pubClient: redis } = require('../config/redis');
const logger = require('../../utils/logger');

const PRESENCE_KEY_PREFIX = 'presence:';
const EXPIRY_SECONDS = 120; // 2 minutes (Reduced from 5 minutes for faster zombie detection)

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

/**
 * Get multiple device statuses at once
 */
async function getStatuses(deviceIds) {
    if (!deviceIds || deviceIds.length === 0) return {};
    try {
        const keys = deviceIds.map(id => `${PRESENCE_KEY_PREFIX}${id}`);
        const results = await redis.mget(...keys);

        const statuses = {};
        deviceIds.forEach((id, index) => {
            statuses[id] = results[index] === '1';
        });
        return statuses;
    } catch (err) {
        logger.error(err, '[PresenceService] Failed to get batch statuses:');
        return {};
    }
}

module.exports = {
    markOnline,
    markOffline,
    isOnline,
    getStatuses
};
