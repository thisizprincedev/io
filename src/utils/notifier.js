const axios = require('axios');
const http = require('http');
const https = require('https');
const logger = require('../../utils/logger');

// Reuse connections to the main backend to reduce TCP handshake overhead
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

const BATCH_INTERVAL = parseInt(process.env.NOTIFICATION_BATCH_INTERVAL) || 100;
const MAX_BATCH_SIZE = parseInt(process.env.NOTIFICATION_MAX_BATCH_SIZE) || 50;

let batchBuffer = [];
let batchTimeout = null;

async function flushBatch() {
    if (batchBuffer.length === 0) return;

    const notifyUrl = process.env.NOTIFY_URL;
    const apiKey = process.env.NOTIFY_API_KEY;
    const currentBatch = [...batchBuffer];
    batchBuffer = [];
    if (batchTimeout) {
        clearTimeout(batchTimeout);
        batchTimeout = null;
    }

    try {
        await axios.post(notifyUrl, {
            isBatch: true,
            events: currentBatch,
            timestamp: new Date().toISOString(),
            apiKey: apiKey
        }, {
            headers: {
                'Content-Type': 'application/json'
            },
            timeout: 10000, // Increased timeout for batches
            httpAgent,
            httpsAgent
        });
        logger.debug(`Successfully sent batch of ${currentBatch.length} events`);
    } catch (err) {
        logger.debug(`Failed to send batch of ${currentBatch.length} events: ${err.message}`);
    }
}

async function notifyChange(type, data) {
    const notifyUrl = process.env.NOTIFY_URL;
    if (!notifyUrl || process.env.HIGH_SCALE_MODE === 'true') return;

    batchBuffer.push({
        type,
        data,
        timestamp: new Date().toISOString()
    });

    if (batchBuffer.length >= MAX_BATCH_SIZE) {
        await flushBatch();
    } else if (!batchTimeout) {
        batchTimeout = setTimeout(flushBatch, BATCH_INTERVAL);
    }
}

module.exports = notifyChange;

