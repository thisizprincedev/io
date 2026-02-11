const { PrismaClient } = require('@prisma/client');
require('dotenv').config();

async function checkIoserverDevices() {
    const prisma = new PrismaClient();
    console.log('\n--- ioserver Devices (CockroachDB) ---');
    try {
        const devices = await prisma.device.findMany({
            select: { device_id: true, app_id: true, model: true, status: true, last_seen: true }
        });

        devices.forEach(d => {
            console.log(`ID: ${d.device_id}, App: ${d.app_id}, Model: ${d.model}, Online: ${d.status}, Last Seen: ${d.last_seen}`);
        });

    } catch (err) {
        console.error('❌ Error:', err.message);
    } finally {
        await prisma.$disconnect();
        console.log('\n--- Check Complete ---\n');
    }
}

checkIoserverDevices();
