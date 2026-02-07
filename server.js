const cluster = require('cluster');
const os = require('os');
const logger = require('./utils/logger');
require('dotenv').config();

// --- MASTER PROCESS ---
if (cluster.isPrimary) {
    const numWorkers = parseInt(process.env.SOCKET_WORKERS) || os.cpus().length;
    logger.info(`Master process starting ${numWorkers} workers...`);

    for (let i = 0; i < numWorkers; i++) {
        cluster.fork();
    }

    cluster.on('exit', (worker, code, signal) => {
        logger.warn(`Worker ${worker.process.pid} died. Forking a new one...`);
        cluster.fork();
    });

    return; // Master process ends here
}

// --- WORKER PROCESS ---
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');

// Modular configurations
const { prisma, connectDatabase } = require('./src/config/database');
const { pubClient, subClient } = require('./src/config/redis');
const configureSocket = require('./src/config/socket');

// Middlewares & Handlers
const setupAuthMiddleware = require('./src/middlewares/auth.middleware');
const httpAuthMiddleware = require('./src/middlewares/httpAuth.middleware');
const registerHandlers = require('./src/handlers/index');
const setupRoutes = require('./src/routes');
const notifyChange = require('./src/utils/notifier');

// Metrics
const {
    metricsMiddleware,
    metricsEndpoint
} = require('./utils/metrics');

const app = express();
const server = http.createServer(app);

// 1. App Middlewares
app.use(metricsMiddleware);
app.use(helmet());
app.use(cors());
app.set('trust proxy', true);
app.use(express.json());

// 2. Socket.IO Setup
const io = configureSocket(server);

// 3. Socket.IO Middlewares
setupAuthMiddleware(io);

// 4. Register Event Handlers
registerHandlers(io, notifyChange);

// 5. REST Routes
app.get('/metrics', metricsEndpoint);
app.use('/api', httpAuthMiddleware); // Secure all API routes
setupRoutes(app, prisma, io, notifyChange);

// Crash test endpoint (Dev only)
if ((process.env.NODE_ENV || 'development') === 'development') {
    app.get('/debug/crash', () => {
        throw new Error('Debug: Simulated Socket.IO system crash');
    });
}

// 6. Graceful Shutdown
const termShutdown = async (signal) => {
    logger.info({ signal }, '🛑 Received signal, shutting down gracefully...');
    try {
        await prisma.$disconnect();
        pubClient.quit();
        subClient.quit();
        server.close(() => {
            logger.info('✅ Server closed. Exiting.');
            process.exit(0);
        });
    } catch (err) {
        logger.error(err, '❌ Error during shutdown');
        process.exit(1);
    }
};

process.on('SIGTERM', () => termShutdown('SIGTERM'));
process.on('SIGINT', () => termShutdown('SIGINT'));

// Exception Handling
process.on('uncaughtException', (error) => logger.error(error, '💥 Uncaught Exception'));
process.on('unhandledRejection', (reason, promise) => logger.error({ reason, promise }, '💥 Unhandled Rejection'));

// 7. Start Server
const PORT = process.env.PORT || 3002;
server.listen(PORT, async () => {
    logger.info(`🚀 Worker ${process.pid} listening on port ${PORT}`);
    await connectDatabase();
});