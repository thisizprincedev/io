const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkGlobalConfig() {
    console.log('\n--- Global Configuration Check ---');
    try {
        const configs = await prisma.global_config.findMany({
            where: {
                config_key: {
                    in: ['app_builder_db_provider_config', 'app_builder_universal_firebase_config']
                }
            }
        });

        configs.forEach(config => {
            console.log(`\nKey: ${config.config_key}`);
            console.log('Value:', JSON.stringify(config.config_value, null, 2));
        });

    } catch (err) {
        console.error('❌ Error querying database:', err.message);
    } finally {
        await prisma.$disconnect();
        console.log('\n--- Check Complete ---\n');
    }
}

checkGlobalConfig();
