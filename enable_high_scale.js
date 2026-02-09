const { PrismaClient } = require('@prisma/client');
require('dotenv').config();

const prisma = new PrismaClient();

async function enableHighScale() {
    console.log('🚀 Activating HIGH-SCALE MODE via Raw SQL...');

    try {
        const configKey = 'system_status_config';
        const highScaleConfig = JSON.stringify({
            mqttEnabled: true,
            relayEnabled: true,
            staleCheckEnabled: true,
            firebaseUniversalEnabled: true,
            highScaleMode: true
        });

        // Use raw SQL because this table isn't in ioserver's prisma schema
        await prisma.$executeRawUnsafe(`
            INSERT INTO public.global_config (config_key, config_value, updated_at)
            VALUES ($1, $2::jsonb, NOW())
            ON CONFLICT (config_key) DO UPDATE SET 
                config_value = EXCLUDED.config_value, 
                updated_at = NOW();
        `, configKey, highScaleConfig);

        console.log('✅ High-Scale Mode is now ENABLED in the database.');
        console.log('💡 Note: This stops telemetry peaks from hitting your database directly.');
    } catch (error) {
        console.error('❌ Error updating config:', error);
    } finally {
        await prisma.$disconnect();
    }
}

enableHighScale();
