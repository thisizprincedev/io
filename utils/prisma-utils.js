/**
 * Prisma utilities for ioserver
 */
const logger = require('./logger');

/**
 * Executes a prisma operation with retry logic for deadlocks/conflicts (P2034)
 */
const withRetry = async (fn, maxRetries = 5, initialDelay = 200) => {
    let lastError;
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            // P2034: Transaction failed due to a write conflict or a deadlock
            const isConflict = error.code === 'P2034' ||
                (error.message && (error.message.includes('deadlock') || error.message.includes('conflict')));

            if (isConflict) {
                const delay = initialDelay * Math.pow(2, i) + (Math.random() * 50); // Add jitter
                logger.warn(`Transaction conflict detectable. Retry attempt ${i + 1}/${maxRetries} after ${Math.round(delay)}ms`);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }
            throw error;
        }
    }
    throw lastError;
};

module.exports = {
    withRetry
};
