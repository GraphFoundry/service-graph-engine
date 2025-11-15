const neo4j = require('neo4j-driver');
const config = require('./config');

const driver = neo4j.driver(
    config.neo4j.uri,
    neo4j.auth.basic(config.neo4j.user, config.neo4j.password)
);

const MERGE_QUERY = `
UNWIND $batch AS row
MERGE (a:Service {name: row.source})
MERGE (b:Service {name: row.destination})
MERGE (a)-[r:CALLS]->(b)
SET
  r.rate = row.rate,
  r.errorRate = row.errorRate,
  r.p50 = row.p50,
  r.p95 = row.p95,
  r.p99 = row.p99,
  r.windowStart = $windowStart,
  r.windowEnd = $windowEnd,
  r.lastUpdated = timestamp()
`;

async function updateGraph(metrics) {
    if (!metrics || metrics.length === 0) {
        console.log('No metrics to write to Neo4j.');
        return;
    }

    const session = driver.session();
    const now = Date.now();
    // Assuming windowEnd is now, and windowStart is 1m ago based on config
    // Note: Prometheus query returns instant vector for rate[1m], so it effectively represents the rate over the last minute ending at query time.
    const windowEnd = now;
    const windowStart = now - 60000; // 1 minute roughly

    try {
        await session.run(MERGE_QUERY, {
            batch: metrics,
            windowStart,
            windowEnd
        });
        console.log(`Updated graph successfully with ${metrics.length} edges.`);
    } catch (error) {
        console.error('Error writing to Neo4j:', error);
    } finally {
        await session.close();
    }
}

async function closeDriver() {
    await driver.close();
}

module.exports = { updateGraph, closeDriver };
