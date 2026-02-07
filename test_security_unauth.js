const { io } = require('socket.io-client');

const SERVER_URL = 'http://localhost:3001'; // Assuming port 3001 as per server.js
const DEVICE_ID = 'ATTACKER_DEVICE';

console.log(`🚀 Starting Unauthorized Connection Test`);

// Attempt 1: Connect without any key
const socket1 = io(SERVER_URL, {
    query: {
        device_id: DEVICE_ID
    }
});

socket1.on('connect', () => {
    console.log('🔴 ERROR: Connected without auth_key! Security fix failed (Attempt 1)');
    process.exit(1);
});

socket1.on('connect_error', (err) => {
    console.log(`✅ Success: Connection 1 blocked as expected: ${err.message}`);
    socket1.disconnect();

    // Attempt 2: Connect with wrong key
    const socket2 = io(SERVER_URL, {
        query: {
            device_id: DEVICE_ID,
            auth_key: 'wrong-key-456'
        }
    });

    socket2.on('connect', () => {
        console.log('🔴 ERROR: Connected with wrong auth_key! Security fix failed (Attempt 2)');
        process.exit(1);
    });

    socket2.on('connect_error', (err) => {
        console.log(`✅ Success: Connection 2 blocked as expected: ${err.message}`);
        socket2.disconnect();
        console.log('🏁 Unauthorized connection testing PASSED.');
        process.exit(0);
    });
});

setTimeout(() => {
    console.log('⌛ Timeout reaching Socket.IO server. Ensure it is running on port 3001.');
    process.exit(1);
}, 5000);
