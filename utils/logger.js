const winston = require('winston');
const Transport = require('winston-transport');
const { ElasticsearchTransport } = require('winston-elasticsearch');
const path = require('path');
const axios = require('axios');

const isDevelopment = (process.env.NODE_ENV || 'development') === 'development';
const logLevel = process.env.LOG_LEVEL || 'info';
const relayUrl = process.env.NOTIFY_URL ? process.env.NOTIFY_URL.replace('/external/events', '/monitoring/logging/client') : null;

// In-memory log buffer for live monitoring (parity with backend)
const logBuffer = [];
const MAX_BUFFER_SIZE = 100;

class LiveBufferTransport extends Transport {
    constructor(opts) {
        super(opts);
    }

    log(info, callback) {
        const logEntry = {
            timestamp: info.timestamp || new Date().toISOString(),
            level: info.level,
            message: info.message,
            ...info
        };

        // Remove complex winston internals
        delete logEntry[Symbol.for('message')];
        delete logEntry[Symbol.for('level')];
        delete logEntry[Symbol.for('splat')];

        logBuffer.unshift(logEntry);
        if (logBuffer.length > MAX_BUFFER_SIZE) {
            logBuffer.pop();
        }

        callback();
    }
}

class RelayTransport extends Transport {
    constructor(opts) {
        super(opts);
        this.relayUrl = opts.relayUrl;
    }

    async log(info, callback) {
        if (!this.relayUrl) {
            return callback();
        }

        const logEntry = {
            level: info.level,
            message: info.message,
            source: 'socketio-server',
            meta: {
                timestamp: info.timestamp || new Date().toISOString(),
                ...info
            }
        };

        // Cleanup meta
        delete logEntry.meta[Symbol.for('message')];
        delete logEntry.meta[Symbol.for('level')];
        delete logEntry.meta[Symbol.for('splat')];
        delete logEntry.meta.message;
        delete logEntry.meta.level;

        try {
            // FIRE AND FORGET - Don't await to avoid blocking winston
            axios.post(this.relayUrl, logEntry, { timeout: 1000 }).catch(() => { });
        } catch (e) {
            // Ignore relay errors to prevent crashing
        }

        callback();
    }
}

// Standard JSON formatting
const standardFormat = winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
);

// Console formatting (prettier for dev)
const consoleFormat = winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : '';
        return `[${timestamp}] ${level}: ${message} ${metaStr}`;
    })
);

const transports = [
    new winston.transports.Console({
        format: isDevelopment ? consoleFormat : standardFormat,
    }),
    new winston.transports.File({
        filename: path.join(__dirname, '../server.log'),
        format: standardFormat,
        maxsize: 10485760, // 10MB
        maxFiles: 5
    }),
    new LiveBufferTransport(),
    new RelayTransport({ relayUrl: relayUrl })
];

// Add Elasticsearch transport if enabled
if (process.env.ELASTICSEARCH_ENABLED === 'true') {
    try {
        const esTransport = new ElasticsearchTransport({
            level: logLevel,
            indexPrefix: process.env.ELASTICSEARCH_INDEX_PREFIX || 'srm-socketio',
            clientOpts: {
                node: process.env.ELASTICSEARCH_NODE,
                auth: (process.env.ELASTICSEARCH_USERNAME && process.env.ELASTICSEARCH_PASSWORD) ? {
                    username: process.env.ELASTICSEARCH_USERNAME,
                    password: process.env.ELASTICSEARCH_PASSWORD,
                } : undefined
            },
            transformer: (logData) => {
                const { level, message, timestamp, ...meta } = logData;
                return {
                    '@timestamp': timestamp,
                    severity: level,
                    message,
                    fields: meta
                };
            }
        });

        esTransport.on('error', (error) => {
            console.error('Elasticsearch transport error:', error);
        });

        transports.push(esTransport);
    } catch (err) {
        console.error('Failed to initialize Elasticsearch transport:', err);
    }
}

const winstonLogger = winston.createLogger({
    level: logLevel,
    format: standardFormat,
    transports: transports,
    exitOnError: false,
});

// Wrapper for compatibility with existing code
const logger = {
    info: (msgOrObj, meta) => {
        if (typeof msgOrObj === 'string') {
            const metadata = typeof meta === 'string' ? { label: meta } : meta;
            winstonLogger.info(msgOrObj, metadata);
        } else {
            const { msg, ...rest } = msgOrObj;
            const metadata = typeof meta === 'string' ? { label: meta, ...rest } : (meta || rest);
            winstonLogger.info(msg || 'Log event', metadata);
        }
    },
    error: (err, meta) => {
        const metadata = typeof meta === 'string' ? { label: meta } : (meta || {});
        if (err instanceof Error) {
            winstonLogger.error(err.message, { stack: err.stack, ...metadata });
        } else if (typeof err === 'string') {
            winstonLogger.error(err, metadata);
        } else {
            const { msg, ...rest } = err;
            winstonLogger.error(msg || 'Error event', { ...metadata, ...rest });
        }
    },
    warn: (msgOrObj, meta) => {
        if (typeof msgOrObj === 'string') {
            const metadata = typeof meta === 'string' ? { label: meta } : meta;
            winstonLogger.warn(msgOrObj, metadata);
        } else {
            const { msg, ...rest } = msgOrObj;
            const metadata = typeof meta === 'string' ? { label: meta, ...rest } : (meta || rest);
            winstonLogger.warn(msg || 'Warning event', metadata);
        }
    },
    debug: (msgOrObj, meta) => {
        if (typeof msgOrObj === 'string') {
            const metadata = typeof meta === 'string' ? { label: meta } : meta;
            winstonLogger.debug(msgOrObj, metadata);
        } else {
            const { msg, ...rest } = msgOrObj;
            const metadata = typeof meta === 'string' ? { label: meta, ...rest } : (meta || rest);
            winstonLogger.debug(msg || 'Debug event', metadata);
        }
    },
    getRecentLogs: () => [...logBuffer]
};


module.exports = logger;

