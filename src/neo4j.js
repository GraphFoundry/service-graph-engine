const neo4j = require('neo4j-driver');
const config = require('./config');

const driver = neo4j.driver(
    config.neo4j.uri,
    neo4j.auth.basic(config.neo4j.user, config.neo4j.password)
);

async function initSchema() {
    const session = driver.session();
    try {
        console.log('Initializing schema...');
        // Constraints
        await session.run('CREATE CONSTRAINT service_id_unique IF NOT EXISTS FOR (s:Service) REQUIRE s.serviceId IS UNIQUE');

        // Indexes
        await session.run('CREATE INDEX service_name_idx IF NOT EXISTS FOR (s:Service) ON (s.name)');
        await session.run('CREATE INDEX service_ns_idx IF NOT EXISTS FOR (s:Service) ON (s.namespace)');

        console.log('Schema initialized.');
    } catch (error) {
        console.error('Schema initialization failed:', error);
    } finally {
        await session.close();
    }
}

const SNAPSHOT_QUERY = `
UNWIND $batch AS row
MERGE (a:Service {serviceId: row.sourceId})
  ON CREATE SET a.name = row.sourceName, a.namespace = row.sourceNamespace, a.createdAt = datetime(),
                a.podCount = row.sourcePodCount, a.availability = row.sourceAvailability
  ON MATCH SET a.updatedAt = datetime(),
               a.podCount = row.sourcePodCount, a.availability = row.sourceAvailability
MERGE (b:Service {serviceId: row.destId})
  ON CREATE SET b.name = row.destName, b.namespace = row.destNamespace, b.createdAt = datetime(),
                b.podCount = row.destPodCount, b.availability = row.destAvailability
  ON MATCH SET b.updatedAt = datetime(),
               b.podCount = row.destPodCount, b.availability = row.destAvailability
MERGE (a)-[r:CALLS_NOW]->(b)
SET
  r.rate = row.rate,
  r.errorRate = row.errorRate,
  r.p50 = row.p50,
  r.p95 = row.p95,
  r.p99 = row.p99,
  r.windowStart = $windowStart,
  r.windowEnd = $windowEnd,
  r.lastUpdated = datetime()
`;

const HISTORY_QUERY = `
UNWIND $batch AS row
MATCH (a:Service {serviceId: row.sourceId})
MATCH (b:Service {serviceId: row.destId})
CREATE (a)-[r:CALLS_HISTORY]->(b)
SET
  r.rate = row.rate,
  r.errorRate = row.errorRate,
  r.p50 = row.p50,
  r.p95 = row.p95,
  r.p99 = row.p99,
  r.windowStart = $windowStart,
  r.windowEnd = $windowEnd
`;

async function updateGraph(metrics) {
    if (!metrics || metrics.length === 0) {
        console.log('No metrics to write to Neo4j.');
        return;
    }

    const session = driver.session();
    const now = Date.now();
    const windowEnd = new Date(now).toISOString();
    // Prometheus aggregation is trailing window. If we query valid rate[1m] at T, it covers T-1m to T.
    const windowStart = new Date(now - 60000).toISOString();

    try {
        // 1. Update Snapshot
        await session.run(SNAPSHOT_QUERY, {
            batch: metrics,
            windowStart,
            windowEnd
        });

        // 2. Append History
        await session.run(HISTORY_QUERY, {
            batch: metrics,
            windowStart,
            windowEnd
        });

        lastUpdateTime = Date.now();
        console.log(`Updated graph successfully with ${metrics.length} edges (Snapshot + History).`);
    } catch (error) {
        console.error('Error writing to Neo4j:', error);
    } finally {
        await session.close();
    }
}

async function closeDriver() {
    await driver.close();
}

let lastUpdateTime = null;

function getLastUpdateTime() {
    return lastUpdateTime;
}

module.exports = { initSchema, updateGraph, closeDriver, driver, getLastUpdateTime };
