const neo4j = require('neo4j-driver');
const config = require('./config');

const driver = neo4j.driver(
    config.neo4j.uri,
    neo4j.auth.basic(config.neo4j.user, config.neo4j.password)
);

async function initSchema() {
    const session = driver.session({ database: config.neo4j.database });
    try {
        console.log('Initializing schema...');
        // Constraints
        await session.run('CREATE CONSTRAINT service_id_unique IF NOT EXISTS FOR (s:Service) REQUIRE s.serviceId IS UNIQUE');

        // Indexes
        await session.run('CREATE INDEX service_name_idx IF NOT EXISTS FOR (s:Service) ON (s.name)');
        await session.run('CREATE INDEX service_ns_idx IF NOT EXISTS FOR (s:Service) ON (s.namespace)');
        await session.run('CREATE CONSTRAINT node_name_unique IF NOT EXISTS FOR (n:Node) REQUIRE n.name IS UNIQUE');
        await session.run('CREATE CONSTRAINT pod_name_unique IF NOT EXISTS FOR (p:Pod) REQUIRE p.name IS UNIQUE');

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

const MARK_UNAVAILABLE_QUERY = `
MATCH (s:Service)
WHERE NOT s.serviceId IN $activeServiceIds
SET s.availability = 0, s.podCount = 0, s.updatedAt = datetime()
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
    const session = driver.session({ database: config.neo4j.database });
    const now = Date.now();
    const windowEnd = new Date(now).toISOString();
    // Prometheus aggregation is trailing window. If we query valid rate[1m] at T, it covers T-1m to T.
    const windowStart = new Date(now - 60000).toISOString();

    try {
        if (!metrics || metrics.length === 0) {
            console.log('No metrics from Prometheus. Marking all services as unavailable.');
            // Mark all existing services as unavailable
            await session.run(MARK_UNAVAILABLE_QUERY, { activeServiceIds: [] });
        } else {
            // 1. Update Snapshot
            await session.run(SNAPSHOT_QUERY, {
                batch: metrics,
                windowStart,
                windowEnd
            });

            // 2. Collect active service IDs from current metrics
            const activeServiceIds = new Set();
            metrics.forEach(metric => {
                activeServiceIds.add(metric.sourceId);
                activeServiceIds.add(metric.destId);
            });

            // 3. Mark services not in active list as unavailable
            await session.run(MARK_UNAVAILABLE_QUERY, {
                activeServiceIds: Array.from(activeServiceIds)
            });

            // 4. Append History
            await session.run(HISTORY_QUERY, {
                batch: metrics,
                windowStart,
                windowEnd
            });

            console.log(`Updated graph successfully with ${metrics.length} edges (Snapshot + History).`);
        }

        lastUpdateTime = Date.now();
    } catch (error) {
        console.error('Error writing to Neo4j:', error);
    } finally {
        await session.close();
    }
}

const INFRA_UPDATE_QUERY = `
UNWIND $batchNodes AS row
MERGE (n:Node {name: row.name})
SET n.cpuUsagePercent = row.cpuUsagePercent, n.cores = row.cores, 
    n.ramUsedMB = row.ramUsedMB, n.ramTotalMB = row.ramTotalMB, 
    n.updatedAt = datetime()

WITH 1 as dummy
UNWIND $batchServices AS sRow
MATCH (s:Service {namespace: sRow.namespace, name: sRow.name})
FOREACH (pRow IN sRow.pods |
  MERGE (p:Pod {name: pRow.name})
  MERGE (s)-[:HAS_POD]->(p)
  MERGE (n:Node {name: pRow.node})
  MERGE (p)-[:RUNS_ON]->(n)
)
`;

async function updateInfrastructure(data) {
    const session = driver.session({ database: config.neo4j.database });
    try {
        if (!data.nodes || data.nodes.length === 0) {
            console.log('No infrastructure data to update.');
            return;
        }

        await session.run(INFRA_UPDATE_QUERY, {
            batchNodes: data.nodes,
            batchServices: data.services
        });
        console.log(`Updated infrastructure: ${data.nodes.length} nodes, ${data.services.length} services with pods.`);
    } catch (error) {
        console.error('Error updating infrastructure in Neo4j:', error);
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

module.exports = { initSchema, updateGraph, updateInfrastructure, closeDriver, driver, getLastUpdateTime };
