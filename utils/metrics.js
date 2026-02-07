const client = require('prom-client');

// Initialize Prometheus metrics
const register = new client.Registry();

// Add default metrics
client.collectDefaultMetrics({ register });

// Define custom metrics
const httpRequestDurationMicroseconds = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'Duration of HTTP requests in microseconds',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.1, 0.5, 1, 2, 5]
});

const httpRequestCount = new client.Counter({
    name: 'http_requests_total',
    help: 'Total number of HTTP requests',
    labelNames: ['method', 'route', 'status_code']
});

const socketConnections = new client.Gauge({
    name: 'socket_io_connections_total',
    help: 'Total number of active Socket.IO connections'
});

const socketEvents = new client.Counter({
    name: 'socket_io_events_total',
    help: 'Total number of Socket.IO events received',
    labelNames: ['event']
});

register.registerMetric(httpRequestDurationMicroseconds);
register.registerMetric(httpRequestCount);
register.registerMetric(socketConnections);
register.registerMetric(socketEvents);

/**
 * Middleware to track HTTP metrics
 */
const metricsMiddleware = (req, res, next) => {
    const start = Date.now();

    res.on('finish', () => {
        const duration = (Date.now() - start) / 1000;
        const route = req.route ? req.route.path : req.path;

        httpRequestDurationMicroseconds
            .labels(req.method, route, res.statusCode.toString())
            .observe(duration);

        httpRequestCount
            .labels(req.method, route, res.statusCode.toString())
            .inc();
    });

    next();
};

/**
 * Controller to expose metrics endpoint
 */
const metricsEndpoint = async (req, res) => {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
};

module.exports = {
    register,
    metricsMiddleware,
    metricsEndpoint,
    socketConnections,
    socketEvents
};
