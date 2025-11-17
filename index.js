const config = require('./src/config');
const { fetchPrometheusFiles } = require('./src/prometheus');
const { updateGraph, closeDriver, initSchema } = require('./src/neo4j');

async function runSync() {
    console.log(`[${new Date().toISOString()}] Starting sync cycle...`);
    try {
        const metrics = await fetchPrometheusFiles();
        if (metrics && metrics.length > 0) {
            console.log(`Fetched ${metrics.length} edges.`);
            await updateGraph(metrics);
        } else {
            console.log('Fetched 0 edges (empty result from Prometheus).');
        }
    } catch (error) {
        console.error('Error during sync cycle:', error);
    }
}

async function startService() {
    console.log('Starting Istio Telemetry Syncer...');

    // Initialize Schema
    await initSchema();

    // Run immediately on start
    await runSync();

    // Schedule polling
    const intervalId = setInterval(runSync, config.app.pollIntervalMs);
    console.log(`Service started. Polling every ${config.app.pollIntervalMs / 1000} seconds.`);

    // Graceful shutdown
    const shutdown = async () => {
        console.log('\nShutting down service...');
        clearInterval(intervalId);
        await closeDriver();
        console.log('Neo4j connection closed. Bye.');
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

startService();
