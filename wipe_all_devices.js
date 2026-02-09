const { PrismaClient } = require('@prisma/client');
require('dotenv').config();

const prisma = new PrismaClient();

async function wipe() {
    console.log('🛑 WARNING: Starting INSTANT total wipe using TRUNCATE CASCADE...');

    try {
        // 1. Get initial count
        const count = await prisma.device.count();
        console.log(`📊 Current device count: ${count}`);

        if (count === 0) {
            console.log('✅ Database is already empty. No action needed.');
            return;
        }

        console.log('⚡ Executing TRUNCATE CASCADE on devices table...');

        // TRUNCATE is much faster than Delete for large datasets
        // RESTART IDENTITY resets any auto-incrementing IDs
        // CASCADE ensures related rows in heartbeat, sms_messages, etc. are also wiped
        await prisma.$executeRaw`TRUNCATE TABLE devices RESTART IDENTITY CASCADE`;

        console.log('✅ Success: All devices and related data wiped instantly.');

    } catch (error) {
        console.error('❌ Error during wipe:', error);
        console.log('🔄 Trying fallback method (row-by-row delete)...');
        try {
            const result = await prisma.device.deleteMany({});
            console.log(`✅ Fallback succeeded. Deleted ${result.count} devices.`);
        } catch (catastrophic) {
            console.error('❌ Fallback also failed:', catastrophic.message);
        }
    } finally {
        await prisma.$disconnect();
        console.log('🏁 Wipe process finished.');
    }
}

wipe();
