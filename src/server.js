const express = require('express');
const neo4j = require('neo4j-driver');
const cors = require('cors');
const config = require('./config');
const { getLastUpdateTime, driver } = require('./neo4j');
const { specs, swaggerUi } = require('./swagger');

const app = express();

app.use(cors());
app.use(express.json());

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
            RETURN a.name AS fromName, a.namespace AS fromNs,
                   a.podCount AS fromPodCount, a.availability AS fromAvailability,
                   b.name AS toName, b.namespace AS toNs,
                   b.podCount AS toPodCount, b.availability AS toAvailability,
                   r.rate AS rps, r.errorRate AS errorRate, r.p95 AS p95
        `;
        const edgeResult = await session.run(edgeQuery);

        // Build edges array and collect service metrics
        const edges = [];
        const serviceMetrics = new Map(); // Key: "namespace:name"

        edgeResult.records.forEach(record => {
            const fromName = record.get('fromName');
            const fromNs = record.get('fromNs');
            const fromPodCount = record.get('fromPodCount');
            const fromAvailability = record.get('fromAvailability');
            const toName = record.get('toName');
            const toNs = record.get('toNs');
            const toPodCount = record.get('toPodCount');
            const toAvailability = record.get('toAvailability');
            const rps = record.get('rps') || 0;
            const errorRate = record.get('errorRate') || 0;
            const p95 = record.get('p95') || 0;

            // Add to edges array
            edges.push({
                from: fromName,
                to: toName,
                namespace: toNs, // Edge belongs to destination namespace
                rps: parseFloat(rps.toFixed(2)),
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

        // Build services array
        const services = Array.from(serviceMetrics.values()).map(metric => ({
            name: metric.name,
            namespace: metric.namespace,
            rps: parseFloat(metric.totalRps.toFixed(2)),
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
 *     description: Retrieve a list of all services in the service graph
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
 *                                   example: "minikube-m02"
 *                                   description: Kubernetes node name
 *                                 pods:
 *                                   type: array
 *                                   items:
 *                                     type: string
 *                                   example: ["frontend-6fd958545-bbrq2", "frontend-6fd958545-xyz12"]
 *                                   description: List of pod names running on this node
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
// Service Discovery
app.get('/services', async (req, res) => {
    const session = driver.session({ database: config.neo4j.database });
    try {
        const query = `
            MATCH (s:Service)
            OPTIONAL MATCH (s)-[:HAS_POD]->(p:Pod)-[:RUNS_ON]->(n:Node)
            RETURN s.name AS name, s.namespace AS namespace, s.podCount AS podCount, s.availability AS availability,
                   collect({pod: p.name, node: n.name, 
                            cpuUsed: n.cpuUsed, cpuTotal: n.cpuTotal, 
                            ramUsed: n.ramUsed, ramTotal: n.ramTotal}) AS placementData
        `;

        const result = await session.run(query);
        const services = result.records.map(record => {
            const name = record.get('name');
            const namespace = record.get('namespace');
            const podCount = Math.floor(Number(record.get('podCount') || 0));
            const availability = Number(record.get('availability') || 0);
            const placementData = record.get('placementData');

            // Group by Node
            const nodesMap = new Map();
            placementData.forEach(item => {
                if (!item.node) return; // Handle cases with no pods/nodes

                if (!nodesMap.has(item.node)) {
                    nodesMap.set(item.node, {
                        node: item.node,
                        resources: {
                            cpu: { used: item.cpuUsed || 0, total: item.cpuTotal || 0, unit: 'cores' },
                            ram: { used: item.ramUsed || 0, total: item.ramTotal || 0, unit: 'bytes' }
                        },
                        pods: []
                    });
                }
                if (item.pod) {
                    nodesMap.get(item.node).pods.push(item.pod);
                }
            });

            return {
                name,
                namespace,
                podCount,
                availability,
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
            availability: Number(record.get('availability') || 0) >= 0.5 ? 1 : 0,
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
    const k = parseInt(req.query.k) || 1;
    const session = driver.session({ database: config.neo4j.database });

    try {
        // Pure Cypher approach for small k
        const query = `
            MATCH p = (center:Service {name: $service})-[*1..${k}]-(m)
            UNWIND relationships(p) as r
            UNWIND nodes(p) as n
            RETURN collect(distinct {name: n.name, namespace: n.namespace, podCount: n.podCount, availability: n.availability}) as nodes, 
                   collect(distinct {from: startNode(r).name, to: endNode(r).name, rate: r.rate, p50: r.p50, p95: r.p95, p99: r.p99, errorRate: r.errorRate}) as edges
        `;

        const result = await session.run(query, { service });

        let nodes = [];
        let edges = [];

        if (result.records.length > 0) {
            nodes = result.records[0].get('nodes').map(node => ({
                ...node,
                podCount: Math.floor(Number(node.podCount || 0)),
                availability: Number(node.availability || 0)
            }));
            edges = result.records[0].get('edges');
        } else {
            // Handle case where service exists but has no neighbors or doesn't exist?
            // If service doesn't exist, we should probably check.
            // But for now, let's assume if no paths, we verify if center exists.
            // Simplified: just return what we found (empty if nothing).
            // If center exists but no edges, query might return empty?
            // With MATCH p = ... it requires at least one pattern match.
            // So if isolated, it returns nothing.
            // To handle isolated center:
            const centerCheck = await session.run('MATCH (s:Service {name: $service}) RETURN s.name, s.namespace, s.podCount, s.availability');
            if (centerCheck.records.length > 0) {
                const record = centerCheck.records[0];
                nodes = [{
                    name: record.get('name'),
                    namespace: record.get('namespace'),
                    podCount: Math.floor(Number(record.get('podCount') || 0)),
                    availability: Number(record.get('availability') || 0)
                }];
            }
        }

        // De-duplicate edges based on content if needed, but COLLECT(DISTINCT ...) should handle object equality if identical.
        // However, Neo4j map equality considers key order? usually fine.

        // Filter out nulls if any
        nodes = nodes.filter(n => n);
        edges = edges.filter(e => e);

        res.json({
            center: service,
            k,
            nodes,
            edges
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

function startServer() {
    const port = config.app.port;
    app.listen(port, () => {
        console.log(`API Server listening on port ${port}`);
    });
}

module.exports = { startServer, app };
