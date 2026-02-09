const { PrismaClient } = require('@prisma/client');
require('dotenv').config();

const prisma = new PrismaClient();

async function check() {
    try {
        const total = await prisma.device.count();
        const online = await prisma.device.count({ where: { status: true } });
        const samples = await prisma.device.findMany({
            take: 5,
            select: { device_id: true, status: true }
        });

        console.log(`📊 Total Devices in DB: ${total}`);
        console.log(`🟢 Online Devices in DB: ${online}`);
        console.log('📝 Sample Device IDs:', JSON.stringify(samples, null, 2));
    } catch (err) {
        console.error('Error:', err);
    } finally {
        await prisma.$disconnect();
    }
}

check();
