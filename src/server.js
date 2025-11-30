const express = require('express');
const neo4j = require('neo4j-driver');
const cors = require('cors');
const config = require('./config');
const { getLastUpdateTime, driver } = require('./neo4j');

const app = express();

app.use(cors());
app.use(express.json());

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

// Service Discovery
app.get('/services', async (req, res) => {
    const session = driver.session();
    try {
        const result = await session.run('MATCH (s:Service) RETURN s.name AS name, s.namespace AS namespace');
        const services = result.records.map(record => ({
            name: record.get('name'),
            namespace: record.get('namespace')
        }));
        res.json({ services });
    } catch (error) {
        console.error('Error in /services:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    } finally {
        await session.close();
    }
});

// Dependency Queries - Peers
app.get('/services/:service/peers', async (req, res) => {
    const { service } = req.params;
    const direction = req.query.direction || 'out';
    const limit = parseInt(req.query.limit) || 5;
    const session = driver.session();

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
            podCount: record.get('podCount') || 0,
            availability: record.get('availability') || 1,
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

// Dependency Queries - Neighborhood
app.get('/services/:service/neighborhood', async (req, res) => {
    const { service } = req.params;
    const k = parseInt(req.query.k) || 2;
    const session = driver.session();

    try {
        // Pure Cypher approach for small k
        const query = `
            MATCH p = (center:Service {name: $service})-[*1..${k}]-(m)
            UNWIND relationships(p) as r
            UNWIND nodes(p) as n
            RETURN collect(distinct n.name) as nodes, collect(distinct {from: startNode(r).name, to: endNode(r).name, rate: r.rate, p50: r.p50, p95: r.p95, p99: r.p99, errorRate: r.errorRate}) as edges
        `;

        const result = await session.run(query, { service });

        let nodes = [];
        let edges = [];

        if (result.records.length > 0) {
            nodes = result.records[0].get('nodes');
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
            const centerCheck = await session.run('MATCH (s:Service {name: $service}) RETURN s.name');
            if (centerCheck.records.length > 0) {
                nodes = [service];
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

// Centrality APIs
app.get('/centrality', async (req, res) => {
    const session = driver.session();
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

app.get('/centrality/top', async (req, res) => {
    const metric = req.query.metric || 'pagerank';
    const limit = parseInt(req.query.limit) || 5;
    const session = driver.session();

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
