const config = require('./src/config');
const { fetchPrometheusFiles } = require('./src/prometheus');
const { updateGraph, closeDriver, initSchema } = require('./src/neo4j');
const { checkGDSAvailability, calculateScores } = require('./src/scores_local');
const { startServer } = require('./src/server');

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

    // Check GDS Availability
    await checkGDSAvailability();

    // Run Sync immediately on start
    await runSync();

    // Run Score Calculation immediately on start (optional, good for verification)
    await calculateScores();

    // Schedule polling
    const pollIntervalId = setInterval(runSync, config.app.pollIntervalMs);
    console.log(`Telemetry Polling started. Interval: ${config.app.pollIntervalMs / 1000} seconds.`);

    // Schedule Score Calculation
    const scoreIntervalId = setInterval(calculateScores, config.app.scoreCalculationIntervalMs);
    console.log(`Score Calculation started. Interval: ${config.app.scoreCalculationIntervalMs / 1000} seconds.`);

    // Start API Server
    startServer();

    // Graceful shutdown
    const shutdown = async () => {
        console.log('\nShutting down service...');
        clearInterval(pollIntervalId);
        clearInterval(scoreIntervalId);
        await closeDriver();
        console.log('Neo4j connection closed. Bye.');
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

startService();
