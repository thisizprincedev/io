const { io } = require('socket.io-client');
const crypto = require('crypto');

const SERVER_URL = 'http://localhost:3001';
const SECRET = 'srm-mobile-default-key-12345';
const DEVICE_ID = 'TEST_HMAC_DEVICE_SOCKET';

console.log(`🚀 Starting HMAC SocketIO Verification Test`);

const timestamp = Math.floor(Date.now() / 1000).toString();
const nonce = crypto.randomBytes(8).toString('hex');
const message = `${timestamp}.${nonce}.${DEVICE_ID}`;
const signature = crypto.createHmac('sha256', SECRET).update(message).digest('hex');

const socket = io(SERVER_URL, {
    query: {
        device_id: DEVICE_ID,
        timestamp: timestamp,
        nonce: nonce,
        signature: signature
    },
    transports: ['websocket']
});

socket.on('connect', () => {
    console.log('✅ Success: Connected to SocketIO with valid HMAC signature.');
    socket.disconnect();
    process.exit(0);
});

socket.on('connect_error', (err) => {
    console.error(`🔴 Error: Connection failed with valid HMAC signature: ${err.message}`);
    process.exit(1);
});

setTimeout(() => {
    console.log('⌛ Timeout reaching Socket.IO server.');
    process.exit(1);
}, 5000);
