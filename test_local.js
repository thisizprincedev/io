const { io } = require('socket.io-client');
const crypto = require('crypto');

const SERVER_URL = 'http://localhost:3001';
const APP_ID = '7b6d6ccd-3f8e-4f73-a060-c4461789a221';
const AUTH_KEY = 'srmmobiledd7a70467baf21155';

async function testOnce() {
    const deviceId = `test_local_${crypto.randomUUID().substring(0, 8)}`;

    console.log(`Testing connection to ${SERVER_URL} for ${deviceId}`);

    const socket = io(SERVER_URL, {
        query: {
            device_id: deviceId,
            app_id: APP_ID,
            auth_key: AUTH_KEY
        },
        transports: ['websocket'],
        forceNew: true
    });

    socket.on('connect', () => {
        console.log('✅ CONNECTED');
        socket.disconnect();
        process.exit(0);
    });

    socket.on('connect_error', (err) => {
        console.error(`❌ ERROR: ${err.message}`);
        process.exit(1);
    });

    setTimeout(() => {
        console.error('❌ TIMEOUT');
        process.exit(1);
    }, 10000);
}

testOnce();
