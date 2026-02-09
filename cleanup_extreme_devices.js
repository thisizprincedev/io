const { PrismaClient } = require('@prisma/client');
const Redis = require('ioredis');
require('dotenv').config();

const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL);

async function cleanup() {
    console.log('🧹 Starting cleanup of EXTREME_ devices and Redis cache...');

    try {
        // 1. Cleanup Database
        const deleteResult = await prisma.device.deleteMany({
            where: {
                device_id: {
                    startsWith: 'EXTREME_'
                }
            }
        });
        console.log(`✅ Database: Deleted ${deleteResult.count} devices and their related data.`);

        // 2. Cleanup Redis
        console.log('🔍 Searching for EXTREME_ keys in Redis...');
        let cursor = '0';
        let totalKeys = 0;

        do {
            const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'device:pending:EXTREME_*', 'COUNT', 1000);
            cursor = nextCursor;

            if (keys.length > 0) {
                await redis.del(...keys);
                totalKeys += keys.length;
                console.log(`🗑️ Deleted ${totalKeys} Redis keys...`);
            }
        } while (cursor !== '0');

        console.log(`✅ Redis: Deleted ${totalKeys} command cache keys.`);

    } catch (error) {
        console.error('❌ Error during cleanup:', error);
    } finally {
        await prisma.$disconnect();
        redis.quit();
        console.log('🏁 Cleanup finished.');
    }
}

cleanup();
