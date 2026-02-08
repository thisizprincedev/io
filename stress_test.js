const { io } = require('socket.io-client');
const cluster = require('cluster');
const os = require('os');
const crypto = require('crypto');

const TARGET_TOTAL_CONNECTIONS = parseInt(process.env.TARGET) || 1000;
const RAMP_UP_RATE_PER_SEC = parseInt(process.env.RAMP_UP) || 100; // Total connections per second
const SERVER_URL = process.env.URL || 'http://localhost:3002/';
const APP_ID = process.env.APP_ID || '7b6d6ccd-3f8e-4f73-a060-c4461789a221';
const AUTH_KEY = process.env.AUTH_KEY || 'srmmobiledd7a70467baf21155';
const HEARTBEAT_INTERVAL = 30000; // 30 seconds

if (cluster.isPrimary || cluster.isMaster) {
    const numCPUs = os.cpus().length;

    // Fix: Ensure at least 1 connection per worker if TARGET > 0
    let remaining = TARGET_TOTAL_CONNECTIONS;
    const workers = [];

    console.log(`🚀 Master ${process.pid} is starting stress test`);
    console.log(`📊 Target: ${TARGET_TOTAL_CONNECTIONS} total connections`);
    console.log(`🏗️ Workers: ${numCPUs}`);
    console.log(`🔗 Server: ${SERVER_URL}`);

    for (let i = 0; i < numCPUs; i++) {
        const count = Math.ceil(remaining / (numCPUs - i));
        remaining -= count;

        if (count > 0) {
            const worker = cluster.fork({
                WORKER_TARGET: count,
                WORKER_ID: i
            });
            workers.push(worker);
        }
    }

    const stats = {};
    setInterval(() => {
        let active = 0, failed = 0, disconnected = 0;
        for (const id in stats) {
            if (stats[id]) {
                active += stats[id].active || 0;
                failed += stats[id].failed || 0;
                disconnected += stats[id].disconnected || 0;
            }
        }
        console.log(`📈 Stats: [Active: ${active}] [Failed: ${failed}] [Disconnected: ${disconnected}]`);
    }, 5000);

    cluster.on('message', (worker, msg) => {
        if (msg.type === 'stats') {
            stats[msg.workerId] = msg;
        }
    });

} else {
    // Worker code
    const workerTarget = parseInt(process.env.WORKER_TARGET);
    const workerId = parseInt(process.env.WORKER_ID);

    let active = 0;
    let failed = 0;
    let disconnected = 0;
    const clients = [];

    function sendStats() {
        process.send({ type: 'stats', workerId, active, failed, disconnected });
    }

    async function createClient(id) {
        const deviceId = `stress_${workerId}_${id}_${crypto.randomUUID().substring(0, 8)}`;
        const socket = io(SERVER_URL, {
            query: {
                device_id: deviceId,
                app_id: APP_ID,
                auth_key: AUTH_KEY,
                build_id: 'stress-test-v1'
            },
            transports: ['polling', 'websocket'], // Start with polling for compatibility
            forceNew: true,
            reconnection: true,
            reconnectionAttempts: 5
        });

        socket.on('connect', () => {
            active++;
            sendStats();

            socket.emit('upsert_device_data', {
                device_id: deviceId,
                manufacturer: 'StressTest',
                model: 'SimulatedNode',
                androidVersion: '14',
                appId: APP_ID,
                buildId: 'stress-test-v1'
            });

            const hbInterval = setInterval(() => {
                socket.emit('send_heartbeat', {
                    device_id: deviceId,
                    type: 'ping',
                    status: true,
                    battery: 100
                });
            }, HEARTBEAT_INTERVAL);

            socket.on('disconnect', () => {
                active--;
                disconnected++;
                clearInterval(hbInterval);
                sendStats();
            });
        });

        socket.on('connect_error', (err) => {
            failed++;
            console.error(`❌ Worker ${workerId} Client ${id} Error: ${err.message}`);
            sendStats();
        });

        clients.push(socket);
    }

    let createdCount = 0;
    const interval = setInterval(() => {
        if (createdCount >= workerTarget) {
            clearInterval(interval);
            console.log(`✅ Worker ${workerId} finished spawning ${createdCount} clients`);
            return;
        }

        // Divide RAMP_UP by numCPUs roughly (Master might be more precise but this is fine)
        const batchSize = Math.max(1, Math.floor(RAMP_UP_RATE_PER_SEC / os.cpus().length));
        for (let i = 0; i < batchSize && createdCount < workerTarget; i++) {
            createClient(createdCount++);
        }
    }, 1000);
}
