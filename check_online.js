const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkOnlineDevices() {
    console.log('\n--- Online Devices Check ---');
    try {
        const onlineDevices = await prisma.device.findMany({
            where: { status: true },
            select: {
                device_id: true,
                model: true,
                manufacturer: true,
                android_version: true,
                last_seen: true,
                app_id: true
            }
        });

        if (onlineDevices.length === 0) {
            console.log('No devices currently online.');
        } else {
            console.log(`Units Online: ${onlineDevices.length}\n`);
            onlineDevices.forEach((device, index) => {
                console.log(`${index + 1}. [${device.device_id}] ${device.manufacturer} ${device.model}`);
                console.log(`   OS: Android ${device.android_version} | App: ${device.app_id}`);
                console.log(`   Last Seen: ${device.last_seen.toISOString()}`);
                console.log('---');
            });
        }
    } catch (err) {
        console.error('❌ Error querying database:', err.message);
    } finally {
        await prisma.$disconnect();
        console.log('--- Check Complete ---\n');
    }
}

checkOnlineDevices();
