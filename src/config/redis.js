const Redis = require('ioredis');
const { createAdapter } = require('@socket.io/redis-streams-adapter');
const logger = require('../../utils/logger');

const redisOptions = {
    retryStrategy(times) {
        // Exponential backoff with a cap at 30 seconds
        const delay = Math.min(times * 100, 30000);
        return delay;
    },
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    connectTimeout: 10000,
    keepAlive: 10000,
    // explicitly handle common network errors
    reconnectOnError(err) {
        const targetErrors = ['READONLY', 'ECONNRESET', 'ETIMEDOUT'];
        if (targetErrors.some(target => err.message.includes(target))) {
            logger.warn(`Redis connection error (${err.message}). Forcing reconnection...`);
            return true;
        }
        return false;
    }
};

/**
 * Robustly parse Redis connection string to avoid issues with special characters in passwords
 */
function getRedisConfig() {
    const url = process.env.REDIS_URL || 'redis://localhost:6379';
    try {
        // ioredis handles URL strings well, but object-based is more explicit for SSL/TLS and auth
        if (url.includes('@')) {
            const parsed = new URL(url);
            return {
                host: parsed.hostname,
                port: parseInt(parsed.port),
                username: parsed.username || undefined,
                password: decodeURIComponent(parsed.password) || undefined,
                tls: url.startsWith('rediss://') ? {} : undefined,
                ...redisOptions
            };
        }
    } catch (e) {
        logger.debug('Using fallback string-based Redis connection');
    }
    return url;
}

const config = getRedisConfig();
const redisClient = typeof config === 'string' ? new Redis(config, redisOptions) : new Redis(config);

// Add error handler
redisClient.on('error', (err) => {
    if (err.message.includes('ECONNRESET')) {
        logger.debug('Minor: Redis connection reset (ECONNRESET) - auto-reconnecting');
        return;
    }
    logger.error(err, 'Redis Client Error');
});
redisClient.on('connect', () => logger.info('✅ Redis Client Connected (Streams Mode)'));

module.exports = {
    pubClient: redisClient, // Export for backward compatibility or reuse
    createRedisAdapter: () => createAdapter(redisClient)
};
