const { driver } = require('./neo4j');
const config = require('./config');
const Graph = require('graphology');
const pagerank = require('graphology-metrics/centrality/pagerank');
const betweenness = require('graphology-metrics/centrality/betweenness');

/**
 * Client-side score calculation to replace Neo4j GDS.
 * Fetches the entire graph used, calculates scores in memory, and writes them back.
 */
async function calculateScores() {
    console.log('Starting Client-Side Score Calculation Job...');
    const session = driver.session({ database: config.neo4j.database });
    let graph;

    try {
        // 1. Fetch Graph Data
        console.log('Fetching graph from Neo4j...');
        const result = await session.run(`
            MATCH (s:Service)-[r:CALLS_NOW]->(t:Service)
            RETURN s.name AS source, t.name AS target, r.rate AS weight
        `);

        graph = new Graph({ type: 'directed', allowSelfLoops: true }); // Allow self loops just in case

        result.records.forEach(record => {
            const source = record.get('source');
            const target = record.get('target');
            const weight = record.get('weight') || 1.0;

            if (!graph.hasNode(source)) graph.addNode(source);
            if (!graph.hasNode(target)) graph.addNode(target);

            // Graphology doesn't support multi-edges by default in simple Graph,
            // but for service graphs we usually just want one aggregate edge or the latest.
            // If edge exists, we update weight? For simplicity, we assume one edge per direction.
            if (!graph.hasEdge(source, target)) {
                graph.addEdge(source, target, { weight });
            }
        });

        // Also fetch isolated nodes to be correct? 
        // PageRank handles components, but good to have all nodes.
        const nodesResult = await session.run(`MATCH (s:Service) RETURN s.name AS name`);
        nodesResult.records.forEach(record => {
            const name = record.get('name');
            if (!graph.hasNode(name)) graph.addNode(name);
        });

        console.log(`Graph loaded. Nodes: ${graph.order}, Edges: ${graph.size}`);

        if (graph.order === 0) {
            console.log('Graph is empty. Skipping calculation.');
            return;
        }

        // 2. Calculate PageRank
        // Note: graphology's pagerank doesn't support 'weight' attribute out of the box in the simplified signature?
        // Actually it does via options: { attributes: { weight: 'weight' } } or similar depending on version.
        // Let's check docs or use standard unweighted if unsure, but weighted is requested.
        // Looking at graphology-metrics docs, weight attribute string is supported.
        console.log('Calculating PageRank...');
        const prScores = pagerank(graph, { alpha: 0.85, weightAttribute: 'weight' });

        // 3. Calculate Betweenness
        // Betweenness is computationally expensive O(N*E) or O(N+E)*N.
        // For small service graphs (<1000 nodes) it's fine.
        console.log('Calculating Betweenness Centrality...');
        const bcScores = betweenness(graph); // Unweighted betweenness is standard for topology importance

        // 4. Prepare updates
        const updates = [];
        graph.forEachNode(node => {
            updates.push({
                name: node,
                pagerank: prScores[node] || 0,
                betweenness: bcScores[node] || 0
            });
        });

        // 5. Write back to Neo4j
        console.log(`Persisting scores for ${updates.length} services...`);
        await session.run(`
            UNWIND $updates AS row
            MATCH (s:Service {name: row.name})
            SET s.pagerank = row.pagerank,
                s.betweenness = row.betweenness,
                s.updatedAt = datetime()
        `, { updates });

        console.log('Scores updated successfully.');

    } catch (error) {
        console.error('Error during client-side score calculation:', error);
    } finally {
        await session.close();
    }
}

// No-op for GDS check since we don't need it
async function checkGDSAvailability() {
    console.log('Client-side calculation enabled. Skipping GDS check.');
    return true;
}

module.exports = { calculateScores, checkGDSAvailability };
