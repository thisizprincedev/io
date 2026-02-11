const { Server } = require("socket.io");
const http = require("http");
const { createClient } = require("redis");
const { createAdapter } = require("@socket.io/redis-streams-adapter");

// We can't easily attach to a running process's io object, 
// but we can check Redis rooms if we know the adapter structure.
// However, redis-streams-adapter is complex.

// Instead, let's use the ioserver's own debug capabilities if available, 
// or just check the presence service again very carefully.

async function checkRedisRooms() {
    const client = createClient({ url: process.env.REDIS_URL });
    await client.connect();

    console.log('\n--- Redis Room Check ---');

    // The streams adapter doesn't store room lists in a simple way like the old adapter.
    // It uses streams for broadcasting.

    // Let's check the presence keys again.
    const keys = await client.keys('presence:*');
    console.log('Active presence keys:', keys);

    for (const key of keys) {
        const ttl = await client.ttl(key);
        console.log(`Key: ${key}, TTL: ${ttl}s`);
    }

    await client.quit();
}

checkRedisRooms().catch(console.error);
