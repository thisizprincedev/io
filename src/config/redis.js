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
};

const redisClient = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', redisOptions);

// Add error handler
redisClient.on('error', (err) => logger.error(err, 'Redis Client Error'));
redisClient.on('connect', () => logger.info('✅ Redis Client Connected (Streams Mode)'));

module.exports = {
    pubClient: redisClient, // Export for backward compatibility or reuse
    createRedisAdapter: () => createAdapter(redisClient)
};
