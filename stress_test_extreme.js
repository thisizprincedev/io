const { io } = require('socket.io-client');
const mqtt = require('mqtt');
const cluster = require('cluster');
const os = require('os');
const crypto = require('crypto');

// --- CONFIGURATION ---
const TARGET_TOTAL_CONNECTIONS = parseInt(process.env.TARGET) || 1000;
const RAMP_UP_RATE_PER_SEC = parseInt(process.env.RAMP_UP) || 100;
const SERVER_URL = process.env.URL || 'https://io.maafkardosirmajburihai.help/';
const MQTT_URL = process.env.MQTT_URL || 'mqtt://139.84.142.70:1883'; // Adjust if needed
const APP_ID = process.env.APP_ID || '7b6d6ccd-3f8e-4f73-a060-c4461789a221';
const AUTH_KEY = process.env.AUTH_KEY || 'srmmobiledd7a70467baf21155';

const HEARTBEAT_INTERVAL = 30000;
const SMS_SYNC_INTERVAL = 60000;
const COMMAND_POLL_INTERVAL = 45000;
const MQTT_PUB_INTERVAL = 50000;

if (cluster.isPrimary) {
    const numCPUs = os.cpus().length;
    let remaining = TARGET_TOTAL_CONNECTIONS;
    const workers = [];

    console.log(`🚀 MASTER: Starting high-scale stress test`);
    console.log(`📊 Target: ${TARGET_TOTAL_CONNECTIONS} | Workers: ${numCPUs} | Ramp: ${RAMP_UP_RATE_PER_SEC}/s`);

    for (let i = 0; i < numCPUs; i++) {
        const count = Math.ceil(remaining / (numCPUs - i));
        remaining -= count;
        if (count > 0) {
            workers.push(cluster.fork({ WORKER_TARGET: count, WORKER_ID: i }));
        }
    }

    const globalStats = { active: 0, failed: 0, sms_synced: 0, mqtt_pub: 0 };
    const workerStats = {};

    cluster.on('message', (worker, msg) => {
        if (msg.type === 'stats') {
            workerStats[msg.workerId] = msg.data;
            updateGlobalStats();
        }
    });

    function updateGlobalStats() {
        globalStats.active = 0;
        globalStats.failed = 0;
        globalStats.sms_synced = 0;
        globalStats.mqtt_pub = 0;
        for (const id in workerStats) {
            globalStats.active += workerStats[id].active;
            globalStats.failed += workerStats[id].failed;
            globalStats.sms_synced += workerStats[id].sms_synced;
            globalStats.mqtt_pub += workerStats[id].mqtt_pub;
        }
    }

    setInterval(() => {
        console.log(`📈 [TOTAL] Active: ${globalStats.active} | Failed: ${globalStats.failed} | SMS: ${globalStats.sms_synced} | MQTT: ${globalStats.mqtt_pub}`);
    }, 5000);

} else {
    // --- WORKER ---
    const workerTarget = parseInt(process.env.WORKER_TARGET);
    const workerId = parseInt(process.env.WORKER_ID);
    const stats = { active: 0, failed: 0, sms_synced: 0, mqtt_pub: 0 };

    function sendStats() {
        process.send({ type: 'stats', workerId, data: stats });
    }

    async function createDevice(id) {
        const deviceId = `EXTREME_${workerId}_${id}_${crypto.randomBytes(4).toString('hex')}`;

        // 1. Socket.IO Connection
        const socket = io(SERVER_URL, {
            query: { device_id: deviceId, app_id: APP_ID, auth_key: AUTH_KEY, build_id: 'extreme-v1' },
            transports: ['websocket'],
            reconnection: true,
            reconnectionAttempts: 10
        });

        // 2. Optional MQTT Connection
        let mqttClient = null;
        if (process.env.ENABLE_MQTT === 'true') {
            mqttClient = mqtt.connect(MQTT_URL, { clientId: `mqtt_${deviceId}`, clean: true });
        }

        socket.on('connect', () => {
            stats.active++;
            sendStats();

            // Initial Identity
            socket.emit('upsert_device_data', {
                device_id: deviceId,
                manufacturer: 'ExtremeSim',
                model: 'NodeWorker',
                androidVersion: '14'
            });

            // Loops
            const loops = [
                setInterval(() => {
                    socket.emit('send_heartbeat', { device_id: deviceId, type: 'ping', status: true, battery: 85 });
                }, HEARTBEAT_INTERVAL),

                setInterval(() => {
                    socket.emit('sync_sms', JSON.stringify([{
                        device_id: deviceId, id: `s_${Date.now()}`, local_sms_id: `l_${Date.now()}`,
                        address: 'TestSender', body: 'Stress test message content', timestamp: Date.now(), type: 1
                    }]), (success) => { if (success) stats.sms_synced++; });
                }, SMS_SYNC_INTERVAL),

                setInterval(() => {
                    socket.emit('get_pending_commands', deviceId, (data) => {
                        try {
                            const cmds = JSON.parse(data);
                            cmds.forEach(c => socket.emit('mark_command_executed', c.id));
                        } catch (e) { }
                    });
                }, COMMAND_POLL_INTERVAL)
            ];

            if (mqttClient) {
                loops.push(setInterval(() => {
                    mqttClient.publish(`devices/${deviceId}/telemetry`, JSON.stringify({ battery: 88, status: 'simulated' }));
                    stats.mqtt_pub++;
                }, MQTT_PUB_INTERVAL));
            }

            socket.on('disconnect', () => {
                stats.active--;
                loops.forEach(clearInterval);
                sendStats();
            });
        });

        socket.on('connect_error', () => {
            stats.failed++;
            sendStats();
        });
    }

    let created = 0;
    const rampInterval = setInterval(() => {
        if (created >= workerTarget) {
            clearInterval(rampInterval);
            return;
        }
        const batch = Math.max(1, Math.floor(RAMP_UP_RATE_PER_SEC / os.cpus().length));
        for (let i = 0; i < batch && created < workerTarget; i++) {
            createDevice(created++);
        }
    }, 1000);
}
