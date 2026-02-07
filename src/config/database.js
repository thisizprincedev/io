const { PrismaClient } = require('@prisma/client');
const logger = require('../../utils/logger');

// Handle BigInt serialization
BigInt.prototype.toJSON = function () { return this.toString() }

const prisma = new PrismaClient();

async function connectDatabase() {
    try {
        logger.info('Attempting to connect to database...');
        await prisma.$connect();
        logger.info('✅ Connected to database via Prisma');
    } catch (err) {
        logger.error(err, '❌ Database connection error');
        process.exit(1);
    }
}

module.exports = {
    prisma,
    connectDatabase
};
