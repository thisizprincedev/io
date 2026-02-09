const { PrismaClient } = require('@prisma/client');
require('dotenv').config();

const prisma = new PrismaClient();

async function check() {
    try {
        console.log('--- Top Tables by Row Count ---');
        const stats = await prisma.$queryRawUnsafe(`
            SELECT schemaname, relname, n_live_tup 
            FROM pg_stat_user_tables 
            WHERE n_live_tup > 0
            ORDER BY n_live_tup DESC;
        `);
        console.table(stats);

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await prisma.$disconnect();
    }
}

check();
