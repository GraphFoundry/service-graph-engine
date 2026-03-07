const config = require('./src/config');
const { fetchPrometheusFiles, fetchInfrastructure } = require('./src/prometheus');
const { updateGraph, updateInfrastructure, closeDriver, initSchema, driver, getLastUpdateTime } = require('./src/neo4j');
const { checkGDSAvailability, calculateScores } = require('./src/scores_local');
const { startServer } = require('./src/server');
const webhook = require('./src/webhook');
const OVERVIEW_NAMESPACE = process.env.OVERVIEW_NAMESPACE || 'default';
let syncInFlight = false;
let scoreInFlight = false;

function toNumber(value, fallback = 0) {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
    if (typeof value === 'object' && typeof value.toNumber === 'function') {
        const n = value.toNumber();
        return Number.isFinite(n) ? n : fallback;
    }
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

async function runSync() {
    if (syncInFlight) {
        console.warn(`[${new Date().toISOString()}] Skipping sync cycle (previous sync still running).`);
        return;
    }
    syncInFlight = true;
    console.log(`[${new Date().toISOString()}] Starting sync cycle...`);
    try {
        const metrics = await fetchPrometheusFiles();
        if (metrics && metrics.length > 0) {
            console.log(`Fetched ${metrics.length} edges.`);
            await updateGraph(metrics);
        } else {
            console.log('Fetched 0 edges (empty result from Prometheus).');
        }

        const infra = await fetchInfrastructure();
        if (infra && infra.nodes.length > 0) {
            await updateInfrastructure(infra);
        }

        // Push update to webhook subscribers after successful sync
        await pushWebhookUpdate(infra);
    } catch (error) {
        console.error('Error during sync cycle:', error);
    } finally {
        syncInFlight = false;
    }
}

async function calculateScoresSafely() {
    if (scoreInFlight) {
        console.warn(`[${new Date().toISOString()}] Skipping score calculation (previous run still running).`);
        return;
    }
    scoreInFlight = true;
    try {
        await calculateScores();
    } finally {
        scoreInFlight = false;
    }
}

/**
 * Build and push the latest snapshot to all webhook subscribers.
 * This replaces the need for consumers to poll /metrics/snapshot and /services.
 */
async function pushWebhookUpdate(infra) {
    try {
        const session = driver.session({ database: config.neo4j.database });
        try {
            const lastUpdate = getLastUpdateTime();
            if (!lastUpdate) return;

            // Query metrics snapshot (same logic as GET /metrics/snapshot)
            const edgeQuery = `
                MATCH (a:Service)-[r:CALLS_NOW]->(b:Service)
                WHERE a.namespace = $namespace AND b.namespace = $namespace
                RETURN a.name AS fromName, a.namespace AS fromNs,
                       a.podCount AS fromPodCount, a.availability AS fromAvailability,
                       b.name AS toName, b.namespace AS toNs,
                       b.podCount AS toPodCount, b.availability AS toAvailability,
                       r.rate AS rps, r.errorRate AS errorRate, r.p95 AS p95
            `;
            const edgeResult = await session.run(edgeQuery, { namespace: OVERVIEW_NAMESPACE });

            const edges = [];
            const serviceMetrics = new Map();

            edgeResult.records.forEach(record => {
                const fromName = record.get('fromName');
                const fromNs = record.get('fromNs');
                const fromPodCount = toNumber(record.get('fromPodCount'));
                const fromAvailability = toNumber(record.get('fromAvailability'));
                const toName = record.get('toName');
                const toNs = record.get('toNs');
                const toPodCount = toNumber(record.get('toPodCount'));
                const toAvailability = toNumber(record.get('toAvailability'));
                const rps = toNumber(record.get('rps'));
                const errorRate = toNumber(record.get('errorRate'));
                const p95 = toNumber(record.get('p95'));

                edges.push({
                    from: fromName,
                    to: toName,
                    namespace: toNs,
                    rps: parseFloat(rps.toFixed ? rps.toFixed(6) : rps),
                    errorRate: parseFloat(errorRate.toFixed ? errorRate.toFixed(4) : errorRate),
                    p95: parseFloat(p95.toFixed ? p95.toFixed(2) : p95)
                });

                const fromKey = `${fromNs}:${fromName}`;
                if (!serviceMetrics.has(fromKey)) {
                    serviceMetrics.set(fromKey, { name: fromName, namespace: fromNs, totalRps: 0, totalErrors: 0, maxP95: 0, podCount: fromPodCount, availability: fromAvailability });
                }
                const fm = serviceMetrics.get(fromKey);
                fm.totalRps += rps;
                fm.totalErrors += rps * errorRate;
                fm.maxP95 = Math.max(fm.maxP95, p95);

                const toKey = `${toNs}:${toName}`;
                if (!serviceMetrics.has(toKey)) {
                    serviceMetrics.set(toKey, { name: toName, namespace: toNs, totalRps: 0, totalErrors: 0, maxP95: 0, podCount: toPodCount, availability: toAvailability });
                }
                const tm = serviceMetrics.get(toKey);
                tm.totalRps += rps;
                tm.totalErrors += rps * errorRate;
                tm.maxP95 = Math.max(tm.maxP95, p95);
            });

            let services = Array.from(serviceMetrics.values()).map(m => ({
                name: m.name,
                namespace: m.namespace,
                rps: parseFloat(m.totalRps.toFixed(6)),
                errorRate: m.totalRps > 0 ? parseFloat((m.totalErrors / m.totalRps).toFixed(4)) : 0,
                p95: parseFloat(m.maxP95.toFixed(2)),
                podCount: m.podCount || 0,
                availability: m.availability || 0
            }));

            let metricsSnapshot = {
                timestamp: new Date(lastUpdate).toISOString(),
                window: config.prometheus.queryWindow,
                services,
                edges
            };

            // Query services with placement (same logic as GET /services)
            const svcQuery = `
                MATCH (s:Service)
                WHERE s.namespace = $namespace
                OPTIONAL MATCH (s)-[:HAS_POD]->(p:Pod)-[:RUNS_ON]->(n:Node)
                RETURN s.name AS name, s.namespace AS namespace,
                       s.podCount AS podCount, s.availability AS availability,
                       collect(DISTINCT {
                           node: n.name,
                           podName: p.name,
                           podRam: p.ramUsedMB,
                           podCpu: p.cpuUsageCores,
                           podUptime: p.uptimeSeconds,
                           nodeCpuPercent: n.cpuUsagePercent,
                           nodeCores: n.cores,
                           nodeRamUsed: n.ramUsedMB,
                           nodeRamTotal: n.ramTotalMB
                       }) AS placements
            `;
            const svcResult = await session.run(svcQuery, { namespace: OVERVIEW_NAMESPACE });

            // Merge services discovered from Kubernetes even if they have no current traffic edges.
            svcResult.records.forEach(record => {
                const name = record.get('name');
                const namespace = record.get('namespace');
                if (!name || !namespace) return;
                const key = `${namespace}:${name}`;
                if (serviceMetrics.has(key)) return;
                serviceMetrics.set(key, {
                    name,
                    namespace,
                    totalRps: 0,
                    totalErrors: 0,
                    maxP95: 0,
                    podCount: toNumber(record.get('podCount')),
                    availability: toNumber(record.get('availability'))
                });
            });

            services = Array.from(serviceMetrics.values()).map(m => ({
                name: m.name,
                namespace: m.namespace,
                rps: parseFloat(m.totalRps.toFixed(6)),
                errorRate: m.totalRps > 0 ? parseFloat((m.totalErrors / m.totalRps).toFixed(4)) : 0,
                p95: parseFloat(m.maxP95.toFixed(2)),
                podCount: m.podCount || 0,
                availability: m.availability || 0
            }));

            metricsSnapshot = {
                timestamp: new Date(lastUpdate).toISOString(),
                window: config.prometheus.queryWindow,
                services,
                edges
            };

            const servicesWithPlacement = svcResult.records.map(record => {
                const name = record.get('name');
                const namespace = record.get('namespace');
                const podCount = toNumber(record.get('podCount'));
                const availability = toNumber(record.get('availability'));
                const placements = record.get('placements') || [];

                const nodesMap = new Map();
                placements.forEach(p => {
                    if (!p.node) return;
                    if (!nodesMap.has(p.node)) {
                        nodesMap.set(p.node, {
                            node: p.node,
                            resources: {
                                cpu: { usagePercent: p.nodeCpuPercent || 0, cores: p.nodeCores || 0 },
                                ram: { usedMB: p.nodeRamUsed || 0, totalMB: p.nodeRamTotal || 0 }
                            },
                            pods: []
                        });
                    }
                    if (p.podName) {
                        nodesMap.get(p.node).pods.push({
                            name: p.podName,
                            ramUsedMB: p.podRam || 0,
                            cpuUsagePercent: p.podCpu || 0,
                            uptimeSeconds: p.podUptime || 0
                        });
                    }
                });

                return {
                    name,
                    namespace,
                    podCount,
                    availability,
                    placement: { nodes: Array.from(nodesMap.values()) }
                };
            });

            // Query centrality scores
            let centralityScores = [];
            try {
                const centralityQuery = `
                    MATCH (s:Service)
                    WHERE s.pagerank IS NOT NULL
                    RETURN s.name AS service, s.pagerank AS pagerank, 
                           coalesce(s.betweenness, 0) AS betweenness
                `;
                const centralityResult = await session.run(centralityQuery);
                centralityScores = centralityResult.records.map(r => ({
                    service: r.get('service'),
                    pagerank: r.get('pagerank') || 0,
                    betweenness: r.get('betweenness') || 0
                }));
            } catch (err) {
                console.log('[Webhook] Centrality scores not available:', err.message);
            }

            // Query nodes
            let nodes = [];
            try {
                const nodesQuery = `
                    MATCH (n:Node)
                    RETURN n.name AS name, n.cpuUsagePercent AS cpuUsagePercent,
                           n.cores AS cores, n.ramUsedMB AS ramUsedMB, n.ramTotalMB AS ramTotalMB
                `;
                const nodesResult = await session.run(nodesQuery);
                nodes = nodesResult.records.map(r => ({
                    name: r.get('name'),
                    resources: {
                        cpu: { usagePercent: r.get('cpuUsagePercent') || 0, cores: r.get('cores') || 0 },
                        ram: { usedMB: r.get('ramUsedMB') || 0, totalMB: r.get('ramTotalMB') || 0 }
                    }
                }));
            } catch (err) {
                console.log('[Webhook] Node data not available:', err.message);
            }

            await webhook.notifySubscribers({
                metricsSnapshot,
                services: servicesWithPlacement,
                infrastructure: { nodes },
                centrality: { scores: centralityScores }
            });
        } finally {
            await session.close();
        }
    } catch (error) {
        console.error('[Webhook] Failed to push update:', error.message);
    }
}

async function startService() {
    console.log('Starting Istio Telemetry Syncer...');

    // Initialize Schema
    await initSchema();

    // Initialize Webhook subscribers
    webhook.init();

    // Check GDS Availability
    await checkGDSAvailability();

    // Run Sync immediately on start
    await runSync();

    // Run Score Calculation immediately on start (optional, good for verification)
    await calculateScoresSafely();

    // Schedule polling
    const pollIntervalId = setInterval(runSync, config.app.pollIntervalMs);
    console.log(`Telemetry Polling started. Interval: ${config.app.pollIntervalMs / 1000} seconds.`);

    // Schedule Score Calculation
    const scoreIntervalId = setInterval(calculateScoresSafely, config.app.scoreCalculationIntervalMs);
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
