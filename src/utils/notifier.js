const axios = require('axios');
const http = require('http');
const https = require('https');
const logger = require('../../utils/logger');

// Reuse connections to the main backend to reduce TCP handshake overhead
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

async function notifyChange(type, data) {
    const notifyUrl = process.env.NOTIFY_URL;
    const apiKey = process.env.NOTIFY_API_KEY;
    if (!notifyUrl || process.env.HIGH_SCALE_MODE === 'true') return;

    try {
        await axios.post(notifyUrl, {
            type,
            data,
            timestamp: new Date().toISOString(),
            apiKey: apiKey
        }, {
            headers: {
                'Content-Type': 'application/json'
            },
            timeout: 5000, // Increased timeout for heavy load
            httpAgent,
            httpsAgent
        });
    } catch (err) {
        // Silently fail notification to avoid blocking main logic
        logger.debug(`Failed to notify change ${type}: ${err.message}`);
    }
}

module.exports = notifyChange;
