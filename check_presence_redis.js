const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const Redis = require('ioredis');
require('dotenv').config();

async function checkRealPresence() {
    console.log('\n--- Real-Time Presence Check ---');
    const redis = new Redis(process.env.REDIS_URL);

    try {
        const devices = await prisma.device.findMany({
            select: { device_id: true, model: true, last_seen: true }
        });

        const keys = devices.map(d => `presence:${d.device_id}`);
        const redisStatus = await redis.mget(...keys);

        let activeCount = 0;
        devices.forEach((d, i) => {
            const isOnline = redisStatus[i] === '1';
            if (isOnline) {
                activeCount++;
                console.log(`✅ [ONLINE]  ${d.device_id} (${d.model})`);
            }
        });

        if (activeCount === 0) {
            console.log('❌ No devices are currently connected to this server (Redis check).');
        } else {
            console.log(`\nTotal Active: ${activeCount}`);
        }

    } catch (err) {
        console.error('❌ Error:', err.message);
    } finally {
        await prisma.$disconnect();
        await redis.quit();
        console.log('--- Check Complete ---\n');
    }
}

checkRealPresence();
