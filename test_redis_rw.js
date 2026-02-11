const Redis = require('ioredis');
require('dotenv').config();

async function testRedisRW() {
    const url = process.env.REDIS_URL;
    console.log(`\n--- Redis R/W Test ---`);
    console.log(`Endpoint: ${url.replace(/:[^:]*@/, ':****@')}`);

    const client = new Redis(url);
    const testKey = 'test:srm:write_check';
    const testValue = `Verified at ${new Date().toISOString()}`;

    try {
        // 1. Write
        console.log(`Setting key "${testKey}"...`);
        await client.set(testKey, testValue, 'EX', 60); // Expire in 60s

        // 2. Read
        console.log(`Getting key "${testKey}"...`);
        const result = await client.get(testKey);

        if (result === testValue) {
            console.log(`✅ Success! Value matches: "${result}"`);
        } else {
            console.error(`❌ Failure! Value mismatch. Got: "${result}", Expected: "${testValue}"`);
        }

        // 3. Cleanup (optional, but keep key for 60s as verify)
        console.log(`Key will expire in 60 seconds.`);

    } catch (err) {
        console.error(`❌ Redis Error: ${err.message}`);
    } finally {
        await client.quit();
        console.log(`--- Test Complete ---\n`);
    }
}

testRedisRW();
