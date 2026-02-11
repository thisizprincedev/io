const { PrismaClient } = require('@prisma/client');
require('dotenv').config();

async function checkCommands() {
    const prisma = new PrismaClient();
    console.log('\n--- ioserver Commands (CockroachDB) ---');
    try {
        const commands = await prisma.deviceCommand.findMany({
            orderBy: { created_at: 'desc' },
            take: 20
        });

        commands.forEach(c => {
            console.log(`[${c.created_at}] ID: ${c.id}, Device: ${c.device_id}, Command: ${c.command}, Status: ${c.status}`);
        });

    } catch (err) {
        console.error('❌ Error:', err.message);
    } finally {
        await prisma.$disconnect();
        console.log('\n--- Check Complete ---\n');
    }
}

checkCommands();
