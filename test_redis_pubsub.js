const Redis = require('ioredis');
require('dotenv').config();

async function testPubSub() {
    const url = process.env.REDIS_URL;
    console.log(`\n--- Redis Pub/Sub Test ---`);
    console.log(`Endpoint: ${url.replace(/:[^:]*@/, ':****@')}`);

    const pub = new Redis(url);
    const sub = new Redis(url);

    const channel = 'srm:test:pubsub';
    let received = false;

    // 1. Subscribe
    sub.subscribe(channel, (err, count) => {
        if (err) {
            console.error(`❌ Subscription Error: ${err.message}`);
            return;
        }
        console.log(`Subscribed to ${count} channel(s). Channel: "${channel}"`);

        // 2. Publish after subscription is ready
        console.log(`Publishing message to "${channel}"...`);
        pub.publish(channel, 'PubSub Verified!');
    });

    // 3. Listen for messages
    sub.on('message', (chan, message) => {
        if (chan === channel) {
            console.log(`✅ Success! Received message: "${message}"`);
            received = true;
            finish();
        }
    });

    async function finish() {
        await pub.quit();
        await sub.quit();
        console.log(`--- Test Complete ---`);
        process.exit(received ? 0 : 1);
    }

    // Timeout handled
    setTimeout(() => {
        if (!received) {
            console.error('❌ Timeout: No message received in 5 seconds.');
            finish();
        }
    }, 5000);
}

testPubSub();
