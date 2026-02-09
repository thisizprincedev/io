const Redis = require('ioredis');
require('dotenv').config();

const redis = new Redis(process.env.REDIS_URL);

async function cleanRedis() {
    console.log('🧹 Connecting to Redis at:', process.env.REDIS_URL.split('@')[1]); // Log host only for security

    try {
        console.log('🗑️ Sending FLUSHDB command...');
        const result = await redis.flushdb();
        console.log(`✅ Redis Cleaned: ${result}`);
    } catch (error) {
        console.error('❌ Error cleaning Redis:', error);
    } finally {
        redis.quit();
        process.exit();
    }
}

cleanRedis();
