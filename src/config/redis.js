const Redis = require('ioredis');
const { createAdapter } = require('@socket.io/redis-adapter');
const logger = require('../../utils/logger');

const redisOptions = {
    retryStrategy(times) {
        // Exponential backoff with a cap at 30 seconds
        const delay = Math.min(times * 100, 30000);
        return delay;
    },
    maxRetriesPerRequest: null, // Critical for socket.io-redis
    enableReadyCheck: true,
    connectTimeout: 10000,
    keepAlive: 10000, // 10 seconds
    reconnectOnError: (err) => {
        const targetError = 'READONLY';
        if (err.message.includes(targetError)) {
            return true;
        }
        if (err.message.includes('ECONNRESET')) {
            logger.warn('Redis connection reset, attempting to reconnect...');
            return true;
        }
        return false;
    }
};

const pubClient = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', redisOptions);
const subClient = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', redisOptions);

// Add error handlers to prevent crashes and log issues
pubClient.on('error', (err) => logger.error(err, 'Redis Pub Client Error'));
subClient.on('error', (err) => {
    if (err.message.includes('ECONNRESET')) {
        logger.warn('Redis Sub Client: ECONNRESET, waiting for auto-reconnect');
    } else {
        logger.error(err, 'Redis Sub Client Error');
    }
});

subClient.on('reconnecting', (delay) => {
    logger.info(`Redis Sub Client reconnecting in ${delay}ms`);
});

pubClient.on('connect', () => logger.info('✅ Redis Pub Client Connected'));
subClient.on('connect', () => logger.info('✅ Redis Sub Client Connected'));

module.exports = {
    pubClient,
    subClient,
    createRedisAdapter: () => createAdapter(pubClient, subClient)
};
