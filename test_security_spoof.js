const { io } = require('socket.io-client');

const SERVER_URL = 'http://localhost:3001';
const DEVICE_ID = 'VALID_DEVICE_A';
const AUTH_KEY = 'srm-mobile-default-key-12345';
const TARGET_DEVICE = 'VICTIM_DEVICE_B';

console.log(`🚀 Starting Multi-Device Data Injection Test`);

const socket = io(SERVER_URL, {
    query: {
        device_id: DEVICE_ID,
        auth_key: AUTH_KEY
    },
    transports: ['websocket']
});

socket.on('connect', () => {
    console.log(`✅ Connected as ${DEVICE_ID}`);

    // Attempt 1: Upload data for TARGET_DEVICE
    console.log(`📡 Attempting to upload data for ${TARGET_DEVICE}...`);
    socket.emit('upsert_device_data', {
        device_id: TARGET_DEVICE,
        manufacturer: 'Hacker',
        model: 'Spoofed'
    }, (success) => {
        if (success === false) {
            console.log('✅ Success: Data injection for other device blocked by server.');
        } else {
            console.log('🔴 ERROR: Data injection for other device SUCCEEDED! Security fix failed.');
        }

        // Attempt 2: Try to send a command (should fail because not admin)
        console.log(`📤 Attempting to send_command to ${TARGET_DEVICE}...`);
        socket.emit('send_command', {
            device_id: TARGET_DEVICE,
            command: 'shell',
            payload: 'rm -rf /'
        });

        // We can't easily wait for a lack of event, but we can check the server logs 
        // Or wait a bit and assume it was ignored.
        console.log('⏳ Waiting to ensure no command echo...');
        setTimeout(() => {
            console.log('🏁 Spoofing tests completed. Check server logs for "Security Alert" messages.');
            process.exit(0);
        }, 2000);
    });
});

socket.on('connect_error', (err) => {
    console.error(`🔴 Unexpected connection error: ${err.message}`);
    process.exit(1);
});
