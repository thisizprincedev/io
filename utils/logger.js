const pino = require('pino');

const isDevelopment = (process.env.NODE_ENV || 'development') === 'development';

const logger = pino({
    level: isDevelopment ? 'debug' : 'info',
    transport: isDevelopment
        ? {
            target: 'pino-pretty',
            options: {
                ignore: 'pid,hostname',
                translateTime: 'HH:MM:ss Z',
                colorize: true,
            },
        }
        : undefined,
});

module.exports = logger;
