const express = require('express');
const neo4j = require('neo4j-driver');
const cors = require('cors');
const config = require('./config');
const { getLastUpdateTime, driver } = require('./neo4j');
const { specs, swaggerUi } = require('./swagger');
const webhook = require('./webhook');

const app = express();

app.use(cors());
app.use(express.json());
const OVERVIEW_NAMESPACE = process.env.OVERVIEW_NAMESPACE || 'default';

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

// Swagger Documentation
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(specs, {
    explorer: true,
    customCss: '.swagger-ui .topbar { display: none }',
}));

// Swagger JSON endpoint
app.get('/swagger.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(specs);
});

/**
 * @openapi
 * /metrics/snapshot:
 *   get:
 *     operationId: getMetricsSnapshot
 *     tags:
 *       - Metrics
 *     summary: Get latest metrics snapshot
 *     description: Returns the latest aggregated metrics snapshot for all services and edges in the current window
 *     responses:
 *       200:
 *         description: Metrics snapshot retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                   example: "2026-01-04T06:00:00Z"
 *                   description: Timestamp of the snapshot
 *                 window:
 *                   type: string
 *                   example: "1m"
 *                   description: Time window for metric aggregation
 *                 services:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                         example: "payment"
 *                       namespace:
 *                         type: string
 *                         example: "default"
 *                       rps:
 *                         type: number
 *                         example: 12.3
 *                         description: Requests per second (sum of all edges)
 *                       errorRate:
 *                         type: number
 *                         example: 0.01
 *                         description: Error rate (weighted average)
 *                       p95:
 *                         type: number
 *                         example: 120.5
 *                         description: 95th percentile latency in milliseconds (max across edges)
 *                 edges:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       from:
 *                         type: string
 *                         example: "frontend"
 *                       to:
 *                         type: string
 *                         example: "payment"
 *                       namespace:
 *                         type: string
 *                         example: "default"
 *                       rps:
 *                         type: number
 *                         example: 5.2
 *                       errorRate:
 *                         type: number
 *                         example: 0.00
 *                       p95:
 *                         type: number
 *                         example: 80.1
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Internal Server Error"
 */
app.get('/metrics/snapshot', async (req, res) => {
    const session = driver.session({ database: config.neo4j.database });
    try {
        const lastUpdate = getLastUpdateTime();
        if (!lastUpdate) {
            return res.status(503).json({ error: 'No metrics available yet' });
        }

        // Query all edges with current metrics
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

        // Build edges array and collect service metrics
        const edges = [];
        const serviceMetrics = new Map(); // Key: "namespace:name"

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

            // Add to edges array
            edges.push({
                from: fromName,
                to: toName,
                namespace: toNs, // Edge belongs to destination namespace
                rps: parseFloat(rps.toFixed(6)),
                errorRate: parseFloat(errorRate.toFixed(4)),
                p95: parseFloat(p95.toFixed(2))
            });

            // Aggregate metrics for source service
            const fromKey = `${fromNs}:${fromName}`;
            if (!serviceMetrics.has(fromKey)) {
                serviceMetrics.set(fromKey, {
                    name: fromName,
                    namespace: fromNs,
                    totalRps: 0,
                    totalErrors: 0,
                    maxP95: 0,
                    podCount: fromPodCount,
                    availability: fromAvailability
                });
            }
            const fromMetric = serviceMetrics.get(fromKey);
            fromMetric.totalRps += rps;
            fromMetric.totalErrors += rps * errorRate;
            fromMetric.maxP95 = Math.max(fromMetric.maxP95, p95);

            // Aggregate metrics for destination service
            const toKey = `${toNs}:${toName}`;
            if (!serviceMetrics.has(toKey)) {
                serviceMetrics.set(toKey, {
                    name: toName,
                    namespace: toNs,
                    totalRps: 0,
                    totalErrors: 0,
                    maxP95: 0,
                    podCount: toPodCount,
                    availability: toAvailability
                });
            }
            const toMetric = serviceMetrics.get(toKey);
            toMetric.totalRps += rps;
            toMetric.totalErrors += rps * errorRate;
            toMetric.maxP95 = Math.max(toMetric.maxP95, p95);
        });

        // Ensure isolated services from Kubernetes discovery are visible with zero traffic defaults.
        const allServicesQuery = `
            MATCH (s:Service)
            WHERE s.namespace = $namespace
            RETURN s.name AS name, s.namespace AS namespace, s.podCount AS podCount, s.availability AS availability
        `;
        const allServicesResult = await session.run(allServicesQuery, { namespace: OVERVIEW_NAMESPACE });
        allServicesResult.records.forEach(record => {
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

        // Build services array
        const services = Array.from(serviceMetrics.values()).map(metric => ({
            name: metric.name,
            namespace: metric.namespace,
            rps: parseFloat(metric.totalRps.toFixed(6)),
            errorRate: metric.totalRps > 0
                ? parseFloat((metric.totalErrors / metric.totalRps).toFixed(4))
                : 0,
            p95: parseFloat(metric.maxP95.toFixed(2)),
            podCount: metric.podCount || 0,
            availability: metric.availability || 0
        }));

        res.json({
            timestamp: new Date(lastUpdate).toISOString(),
            window: config.prometheus.queryWindow,
            services,
            edges
        });
    } catch (error) {
        console.error('Error in /metrics/snapshot:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    } finally {
        await session.close();
    }
});

/**
 * @openapi
 * /graph/health:
 *   get:
 *     operationId: getGraphHealth
 *     tags:
 *       - Health
 *     summary: Get graph health status
 *     description: Returns the current health status of the service graph, including last update time and staleness indicator
 *     responses:
 *       200:
 *         description: Health status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: "OK"
 *                 lastUpdatedSecondsAgo:
 *                   type: integer
 *                   nullable: true
 *                   example: 45
 *                   description: Seconds since last update, null if never updated
 *                 windowMinutes:
 *                   type: integer
 *                   example: 5
 *                   description: Time window for staleness check
 *                 stale:
 *                   type: boolean
 *                   example: false
 *                   description: Whether the data is considered stale
 */
// Graph Metadata / Health
app.get('/graph/health', (req, res) => {
    const lastUpdate = getLastUpdateTime();
    const now = Date.now();
    const windowMinutes = 5; // As per requirement
    const staleThresholdMs = windowMinutes * 60 * 1000;

    let lastUpdatedSecondsAgo = null;
    let stale = true;

    if (lastUpdate) {
        lastUpdatedSecondsAgo = Math.floor((now - lastUpdate) / 1000);
        stale = (now - lastUpdate) > staleThresholdMs;
    }

    res.json({
        status: "OK",
        lastUpdatedSecondsAgo,
        windowMinutes,
        stale
    });
});

/**
 * @openapi
 * /services:
 *   get:
 *     operationId: listServices
 *     tags:
 *       - Services
 *     summary: List all services
 *     description: Retrieve a list of all services in the service graph with pod-level resource metrics
 *     responses:
 *       200:
 *         description: List of services retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 services:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                         example: "frontend"
 *                       namespace:
 *                         type: string
 *                         example: "default"
 *                       podCount:
 *                         type: integer
 *                         example: 3
 *                         description: Number of pods running for this service
 *                       availability:
 *                         type: integer
 *                         enum: [0, 1]
 *                         example: 1
 *                         description: Service availability as boolean (0=unavailable, 1=available)
 *                       placement:
 *                         type: object
 *                         description: Pod placement information showing which Kubernetes nodes host the service's pods
 *                         properties:
 *                           nodes:
 *                             type: array
 *                             items:
 *                               type: object
 *                               properties:
 *                                 node:
 *                                   type: string
 *                                   example: "k8s-node-01"
 *                                   description: Kubernetes node name
 *                                 resources:
 *                                   type: object
 *                                   description: Node-level resource usage
 *                                   properties:
 *                                     cpu:
 *                                       type: object
 *                                       properties:
 *                                         usagePercent:
 *                                           type: number
 *                                           example: 7.96
 *                                           description: Node CPU usage percentage
 *                                         cores:
 *                                           type: integer
 *                                           example: 8
 *                                           description: Total CPU cores available on node
 *                                     ram:
 *                                       type: object
 *                                       properties:
 *                                         usedMB:
 *                                           type: number
 *                                           example: 8107.19
 *                                           description: RAM used on node in MB
 *                                         totalMB:
 *                                           type: number
 *                                           example: 24026.4
 *                                           description: Total RAM available on node in MB
 *                                 pods:
 *                                   type: array
 *                                   description: List of pods running on this node with container-level metrics
 *                                   items:
 *                                     type: object
 *                                     properties:
 *                                       name:
 *                                         type: string
 *                                         example: "frontend-75d897db69-dmtzh"
 *                                         description: Pod name
 *                                       ramUsedMB:
 *                                         type: number
 *                                         example: 59.65
 *                                         description: Pod RAM usage in MB (aggregated from all containers)
 *                                       cpuUsagePercent:
 *                                         type: number
 *                                         example: 0.27
 *                                         description: Pod CPU usage as percentage of node's total cores
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Internal Server Error"
 */
// Infrastructure - Nodes
/**
 * @swagger
 * /infrastructure/nodes:
 *   get:
 *     summary: Retrieve all infrastructure nodes and their resource usage
 *     tags: [Infrastructure]
 *     responses:
 *       200:
 *         description: List of all nodes with CPU and RAM metrics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 nodes:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                         example: "k8s-node-01"
 *                       resources:
 *                         type: object
 *                         properties:
 *                           cpu:
 *                             type: object
 *                             properties:
 *                               usagePercent:
 *                                 type: number
 *                               cores:
 *                                 type: integer
 *                           ram:
 *                               type: object
 *                               properties:
 *                                 usedMB:
 *                                   type: number
 *                                 totalMB:
 *                                   type: number
 *       500:
 *         description: Internal Server Error
 */
app.get('/infrastructure/nodes', async (req, res) => {
    const session = driver.session({ database: config.neo4j.database });
    try {
        const query = `
            MATCH (n:Node)
            RETURN n.name AS name, 
                   n.cpuUsagePercent AS cpuUsagePercent, 
                   n.cores AS cores, 
                   n.ramUsedMB AS ramUsedMB, 
                   n.ramTotalMB AS ramTotalMB
            ORDER BY n.name
        `;

        const result = await session.run(query);
        const nodes = result.records.map(record => ({
            name: record.get('name'),
            resources: {
                cpu: {
                    usagePercent: Number(record.get('cpuUsagePercent') || 0),
                    cores: Number(record.get('cores') || 0)
                },
                ram: {
                    usedMB: Number(record.get('ramUsedMB') || 0),
                    totalMB: Number(record.get('ramTotalMB') || 0)
                }
            }
        }));

        res.json({ nodes });
    } catch (error) {
        console.error('Error in /infrastructure/nodes:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    } finally {
        await session.close();
    }
});

// Service Discovery
app.get('/services', async (req, res) => {
    const session = driver.session({ database: config.neo4j.database });
    try {
        const query = `
            MATCH (s:Service)
            OPTIONAL MATCH (s)-[:HAS_POD]->(p:Pod)-[:RUNS_ON]->(n:Node)
            RETURN s.name AS name, s.namespace AS namespace, s.podCount AS podCount, s.availability AS availability,
                   s.successRate AS successRate,
                   collect({pod: p.name, node: n.name, 
                            podRamUsedMB: p.ramUsedMB, podCpuUsageCores: p.cpuUsageCores, podUptimeSeconds: p.uptimeSeconds,
                            cpuUsagePercent: n.cpuUsagePercent, cores: n.cores, 
                            ramUsedMB: n.ramUsedMB, ramTotalMB: n.ramTotalMB}) AS placementData
        `;

        const result = await session.run(query);
        const services = result.records.map(record => {
            const name = record.get('name');
            const namespace = record.get('namespace');
            const podCount = Math.floor(Number(record.get('podCount') || 0));
            const availability = Number(record.get('availability') || 0);
            const successRate = record.get('successRate');
            const placementData = record.get('placementData');

            // Group by Node
            const nodesMap = new Map();
            placementData.forEach(item => {
                if (!item.node) return; // Handle cases with no pods/nodes

                if (!nodesMap.has(item.node)) {
                    nodesMap.set(item.node, {
                        node: item.node,
                        resources: {
                            cpu: {
                                usagePercent: Number.parseFloat((item.cpuUsagePercent || 0).toFixed(2)),
                                cores: item.cores || 0
                            },
                            ram: {
                                usedMB: Number.parseFloat((item.ramUsedMB || 0).toFixed(2)),
                                totalMB: Number.parseFloat((item.ramTotalMB || 0).toFixed(2))
                            }
                        },
                        pods: []
                    });
                }
                if (item.pod) {
                    const nodeCores = item.cores || 1; // Avoid division by zero
                    const cpuCores = item.podCpuUsageCores || 0;
                    const cpuUsagePercent = (cpuCores / nodeCores) * 100;

                    nodesMap.get(item.node).pods.push({
                        name: item.pod,
                        ramUsedMB: Number.parseFloat((item.podRamUsedMB || 0).toFixed(2)),
                        cpuUsagePercent: Number.parseFloat(cpuUsagePercent.toFixed(2)),
                        uptimeSeconds: item.podUptimeSeconds || 0
                    });
                }
            });

            return {
                name,
                namespace,
                podCount,
                availability,
                successRate: successRate != null ? Number(successRate) : null,
                placement: {
                    nodes: Array.from(nodesMap.values())
                }
            };
        });
        res.json({ services });
    } catch (error) {
        console.error('Error in /services:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    } finally {
        await session.close();
    }
});

/**
 * @openapi
 * /services/{service}/peers:
 *   get:
 *     operationId: getServicePeers
 *     tags:
 *       - Services
 *     summary: Get service peers (dependencies)
 *     description: Retrieve the top peers (upstream or downstream dependencies) for a given service
 *     parameters:
 *       - in: path
 *         name: service
 *         required: true
 *         schema:
 *           type: string
 *         description: The service name
 *         example: "frontend"
 *       - in: query
 *         name: direction
 *         schema:
 *           type: string
 *           enum: [out, in]
 *           default: out
 *         description: Direction of dependencies (out=downstream, in=upstream)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 5
 *         description: Maximum number of peers to return
 *     responses:
 *       200:
 *         description: Peers retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 service:
 *                   type: string
 *                   example: "frontend"
 *                 direction:
 *                   type: string
 *                   example: "out"
 *                 windowMinutes:
 *                   type: integer
 *                   example: 5
 *                 peers:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       service:
 *                         type: string
 *                         example: "backend"
 *                       metrics:
 *                         type: object
 *                         properties:
 *                           rate:
 *                             type: number
 *                             example: 150.5
 *                           p50:
 *                             type: number
 *                             example: 25.3
 *                           p95:
 *                             type: number
 *                             example: 120.7
 *                           p99:
 *                             type: number
 *                             example: 250.2
 *                           errorRate:
 *                             type: number
 *                             example: 0.02
 *       500:
 *         description: Internal server error
 */
// Dependency Queries - Peers
app.get('/services/:service/peers', async (req, res) => {
    const { service } = req.params;
    const direction = req.query.direction || 'out';
    const limit = parseInt(req.query.limit) || 5;
    const session = driver.session({ database: config.neo4j.database });

    try {
        let query = '';
        if (direction === 'out') {
            query = `
                MATCH (s:Service {name: $service})-[r:CALLS_NOW]->(p:Service)
                RETURN p.name AS service, p.podCount AS podCount, p.availability AS availability, r.rate AS rate, r.p50 AS p50, r.p95 AS p95, r.p99 AS p99, r.errorRate AS errorRate
                ORDER BY r.rate DESC
                LIMIT $limit
            `;
        } else {
            query = `
                MATCH (s:Service {name: $service})<-[r:CALLS_NOW]-(p:Service)
                RETURN p.name AS service, p.podCount AS podCount, p.availability AS availability, r.rate AS rate, r.p50 AS p50, r.p95 AS p95, r.p99 AS p99, r.errorRate AS errorRate
                ORDER BY r.rate DESC
                LIMIT $limit
            `;
        }

        const result = await session.run(query, { service, limit: neo4j.int(limit) });
        const peers = result.records.map(record => ({
            service: record.get('service'),
            podCount: Math.floor(Number(record.get('podCount') || 0)),
            availability: Number(record.get('availability') || 0),
            metrics: {
                rate: record.get('rate'),
                p50: record.get('p50'),
                p95: record.get('p95'),
                p99: record.get('p99'),
                errorRate: record.get('errorRate')
            }
        }));

        res.json({
            service,
            direction,
            windowMinutes: 5,
            peers
        });
    } catch (error) {
        console.error('Error in /services/:service/peers:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    } finally {
        await session.close();
    }
});

/**
 * @openapi
 * /services/{service}/neighborhood:
 *   get:
 *     operationId: getServiceNeighborhood
 *     tags:
 *       - Services
 *     summary: Get service neighborhood graph
 *     description: Retrieve a k-hop neighborhood subgraph centered on a given service
 *     parameters:
 *       - in: path
 *         name: service
 *         required: true
 *         schema:
 *           type: string
 *         description: The center service name
 *         example: "frontend"
 *       - in: query
 *         name: k
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Number of hops (depth) for the neighborhood
 *     responses:
 *       200:
 *         description: Neighborhood graph retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 center:
 *                   type: string
 *                   example: "frontend"
 *                 k:
 *                   type: integer
 *                   example: 2
 *                 nodes:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                         example: "frontend"
 *                       namespace:
 *                         type: string
 *                         example: "default"
 *                       podCount:
 *                         type: integer
 *                         example: 3
 *                         description: Number of pods running for this service
 *                       availability:
 *                         type: integer
 *                         enum: [0, 1]
 *                         example: 1
 *                         description: Service availability as boolean (0=unavailable, 1=available)
 *                 edges:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       from:
 *                         type: string
 *                         example: "frontend"
 *                       to:
 *                         type: string
 *                         example: "backend"
 *                       rate:
 *                         type: number
 *                         example: 150.5
 *                       p50:
 *                         type: number
 *                         example: 25.3
 *                       p95:
 *                         type: number
 *                         example: 120.7
 *                       p99:
 *                         type: number
 *                         example: 250.2
 *                       errorRate:
 *                         type: number
 *                         example: 0.02
 *       500:
 *         description: Internal server error
 */
// Dependency Queries - Neighborhood
app.get('/services/:service/neighborhood', async (req, res) => {
    const { service } = req.params;
    const k = Math.min(Math.max(parseInt(req.query.k, 10) || 2, 1), 3);
    const direction = (req.query.direction || 'both').toString().toLowerCase();
    const maxNodes = Math.min(Math.max(parseInt(req.query.maxNodes, 10) || 200, 10), 500);
    const maxEdges = Math.min(Math.max(parseInt(req.query.maxEdges, 10) || 400, 10), 1000);

    if (!['both', 'in', 'out'].includes(direction)) {
        return res.status(400).json({ error: 'direction must be one of: both, in, out' });
    }

    const session = driver.session({ database: config.neo4j.database });

    try {
        const centerResult = await session.run(
            `
                MATCH (center:Service)
                WHERE center.serviceId = $service OR center.name = $service
                RETURN center.serviceId AS serviceId,
                       center.name AS name,
                       center.namespace AS namespace,
                       center.podCount AS podCount,
                       center.availability AS availability
                LIMIT 1
            `,
            { service }
        );

        if (centerResult.records.length === 0) {
            return res.status(404).json({ error: `Service not found: ${service}` });
        }

        const centerRecord = centerResult.records[0];
        const centerRef = {
            serviceId: centerRecord.get('serviceId'),
            name: centerRecord.get('name'),
            namespace: centerRecord.get('namespace'),
            podCount: Math.floor(Number(centerRecord.get('podCount') || 0)),
            availability: Number(centerRecord.get('availability') || 0),
        };

        // Restrict traversal to live service-call edges only. Including all relationship
        // types (history, pod placement, infra links) can explode path search and stall
        // neighborhood queries during demos.
        let pattern = `(center)-[:CALLS_NOW*1..${k}]-(m)`;
        if (direction === 'in') {
            pattern = `(m)-[:CALLS_NOW*1..${k}]->(center)`;
        } else if (direction === 'out') {
            pattern = `(center)-[:CALLS_NOW*1..${k}]->(m)`;
        }

        const neighborhoodQuery = `
            MATCH (center:Service {serviceId: $centerId})
            OPTIONAL MATCH p = ${pattern}
            WITH center, collect(p) AS paths
            WITH center, CASE WHEN size(paths) = 0 THEN [NULL] ELSE paths END AS safePaths
            UNWIND safePaths AS path
            WITH center, CASE WHEN path IS NULL THEN [] ELSE relationships(path) END AS relList
            UNWIND CASE WHEN size(relList) = 0 THEN [NULL] ELSE relList END AS rel
            WITH center, collect(DISTINCT rel) AS relsRaw
            WITH center, [r IN relsRaw WHERE r IS NOT NULL] AS rels
            WITH center, rels,
                 CASE
                    WHEN size(rels) = 0 THEN [center]
                    ELSE [center] + [r IN rels | startNode(r)] + [r IN rels | endNode(r)]
                 END AS rawNodes
            UNWIND rawNodes AS node
            WITH center, rels, collect(DISTINCT node) AS nodes
            RETURN
                [n IN nodes | {
                    serviceId: n.serviceId,
                    name: n.name,
                    namespace: n.namespace,
                    podCount: n.podCount,
                    availability: n.availability,
                    successRate: n.successRate
                }] AS nodes,
                [r IN rels | {
                    source: startNode(r).serviceId,
                    target: endNode(r).serviceId,
                    from: startNode(r).name,
                    to: endNode(r).name,
                    rate: r.rate,
                    p50: r.p50,
                    p95: r.p95,
                    p99: r.p99,
                    errorRate: r.errorRate
                }] AS edges
        `;

        const result = await session.run(neighborhoodQuery, { centerId: centerRef.serviceId });

        let nodes = [];
        let edges = [];
        if (result.records.length > 0) {
            nodes = (result.records[0].get('nodes') || [])
                .filter(Boolean)
                .map((node) => ({
                    serviceId: node.serviceId || `${node.namespace || 'default'}:${node.name}`,
                    name: node.name,
                    namespace: node.namespace || 'default',
                    podCount: Math.floor(Number(node.podCount || 0)),
                    availability: Number(node.availability || 0),
                    successRate: node.successRate != null ? Number(node.successRate) : null,
                }));
            edges = (result.records[0].get('edges') || [])
                .filter(Boolean)
                .map((edge) => ({
                    source: edge.source || `default:${edge.from}`,
                    target: edge.target || `default:${edge.to}`,
                    from: edge.from,
                    to: edge.to,
                    rate: Number(edge.rate || 0),
                    p50: Number(edge.p50 || 0),
                    p95: Number(edge.p95 || 0),
                    p99: Number(edge.p99 || 0),
                    errorRate: Number(edge.errorRate || 0),
                }));
        }

        const centerInNodes = nodes.some((node) => node.serviceId === centerRef.serviceId);
        if (!centerInNodes) {
            nodes.unshift({
                serviceId: centerRef.serviceId,
                name: centerRef.name,
                namespace: centerRef.namespace || 'default',
                podCount: centerRef.podCount,
                availability: centerRef.availability,
            });
        }

        const truncated = nodes.length > maxNodes || edges.length > maxEdges;
        if (nodes.length > maxNodes) {
            nodes = nodes.slice(0, maxNodes);
        }
        if (edges.length > maxEdges) {
            edges = edges.slice(0, maxEdges);
        }

        res.json({
            center: centerRef.serviceId,
            centerRef: {
                serviceId: centerRef.serviceId,
                name: centerRef.name,
                namespace: centerRef.namespace || 'default',
            },
            k,
            direction,
            truncated,
            nodes,
            edges,
        });
    } catch (error) {
        console.error('Error in /services/:service/neighborhood:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    } finally {
        await session.close();
    }
});

/**
 * @openapi
 * /centrality:
 *   get:
 *     operationId: getCentralityScores
 *     tags:
 *       - Centrality
 *     summary: Get centrality scores for all services
 *     description: Retrieve PageRank and betweenness centrality scores for all services
 *     responses:
 *       200:
 *         description: Centrality scores retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 windowMinutes:
 *                   type: integer
 *                   example: 5
 *                 scores:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       service:
 *                         type: string
 *                         example: "frontend"
 *                       pagerank:
 *                         type: number
 *                         example: 0.85
 *                       betweenness:
 *                         type: number
 *                         example: 0.42
 *       500:
 *         description: Internal server error
 */
// Centrality APIs
app.get('/centrality', async (req, res) => {
    const session = driver.session({ database: config.neo4j.database });
    try {
        const result = await session.run('MATCH (s:Service) RETURN s.name AS service, s.pagerank AS pagerank, s.betweenness AS betweenness');
        const scores = result.records.map(record => ({
            service: record.get('service'),
            pagerank: record.get('pagerank') || 0,
            betweenness: record.get('betweenness') || 0
        }));

        res.json({
            windowMinutes: 5,
            scores
        });
    } catch (error) {
        console.error('Error in /centrality:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    } finally {
        await session.close();
    }
});

/**
 * @openapi
 * /centrality/top:
 *   get:
 *     operationId: getTopCentralityServices
 *     tags:
 *       - Centrality
 *     summary: Get top services by centrality metric
 *     description: Retrieve the top N services ranked by a specific centrality metric
 *     parameters:
 *       - in: query
 *         name: metric
 *         schema:
 *           type: string
 *           enum: [pagerank, betweenness]
 *           default: pagerank
 *         description: The centrality metric to rank by
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 5
 *         description: Maximum number of top services to return
 *     responses:
 *       200:
 *         description: Top services retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 metric:
 *                   type: string
 *                   example: "pagerank"
 *                 top:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       service:
 *                         type: string
 *                         example: "gateway"
 *                       value:
 *                         type: number
 *                         example: 0.95
 *       400:
 *         description: Invalid metric parameter
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Invalid metric. Allowed: pagerank, betweenness"
 *       500:
 *         description: Internal server error
 */
app.get('/centrality/top', async (req, res) => {
    const metric = req.query.metric || 'pagerank';
    const limit = parseInt(req.query.limit) || 5;
    const session = driver.session({ database: config.neo4j.database });

    // Whitelist metric to prevent injection
    const validMetrics = ['pagerank', 'betweenness'];
    if (!validMetrics.includes(metric)) {
        return res.status(400).json({ error: 'Invalid metric. Allowed: pagerank, betweenness' });
    }

    try {
        const query = `
            MATCH (s:Service)
            RETURN s.name AS service, s.${metric} AS value
            ORDER BY value DESC
            LIMIT $limit
        `;
        const result = await session.run(query, { limit: neo4j.int(limit) });
        const top = result.records.map(record => ({
            service: record.get('service'),
            value: record.get('value') || 0
        }));

        res.json({
            metric,
            top
        });
    } catch (error) {
        console.error('Error in /centrality/top:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    } finally {
        await session.close();
    }
});

/**
 * @openapi
 * /webhooks/status:
 *   get:
 *     operationId: getWebhookStatus
 *     tags:
 *       - Webhooks
 *     summary: Get webhook subscriber status
 *     description: Returns the list of configured webhook subscriber URLs
 *     responses:
 *       200:
 *         description: Webhook status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 subscribers:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       url:
 *                         type: string
 *                         example: "http://analysis-engine:5000/webhook/graph-update"
 */
app.get('/webhooks/status', (req, res) => {
    res.json({
        subscribers: webhook.getSubscribers(),
        stats: webhook.getStats ? webhook.getStats() : undefined
    });
});

function startServer() {
    const port = config.app.port;
    app.listen(port, () => {
        console.log(`API Server listening on port ${port}`);
    });
}

module.exports = { startServer, app };
