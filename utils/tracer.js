const tracer = require('dd-trace');

// Initialize Datadog APM
tracer.init({
    apmTracingEnabled: process.env.DD_TRACE_ENABLED !== 'false',
    env: process.env.NODE_ENV || 'development',
    service: 'socketio-provider-server',
    version: '1.0.0',
    logInjection: true,
    sampleRate: parseFloat(process.env.DD_TRACE_SAMPLE_RATE || '1.0'),
});

module.exports = tracer;
