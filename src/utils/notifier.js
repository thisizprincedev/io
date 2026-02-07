const axios = require('axios');
const logger = require('../../utils/logger');

async function notifyChange(type, data) {
    const notifyUrl = process.env.NOTIFY_URL;
    const apiKey = process.env.NOTIFY_API_KEY;
    if (!notifyUrl) return;

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
            timeout: 2000
        });
    } catch (err) {
        // Silently fail notification to avoid blocking main logic
        logger.debug(`Failed to notify change ${type}: ${err.message}`);
    }
}

module.exports = notifyChange;
