const { driver } = require('./neo4j');
const config = require('./config');

async function checkGDSAvailability() {
  const session = driver.session({ database: config.neo4j.database });
  try {
    const result = await session.run('CALL gds.version()');
    if (result.records.length > 0) {
      console.log(`GDS Version: ${result.records[0].get('gdsVersion')}`);
    } else {
      console.warn('WARNING: GDS plugin not detected or version call failed.');
    }
  } catch (error) {
    console.error('Failed to check GDS version. Ensure the GDS plugin is installed.', error.code || error.message);
  } finally {
    await session.close();
  }
}

async function calculateScores() {
  console.log('Starting Score Calculation Job (GDS)...');
  const session = driver.session({ database: config.neo4j.database });
  const graphName = 'service-call-graph';

  try {
    // 1. Cleanup Start: Drop old projection if exists
    const existsResult = await session.run(`
      CALL gds.graph.exists($graphName) 
      YIELD exists 
      RETURN exists
    `, { graphName });

    if (existsResult.records[0].get('exists')) {
      await session.run(`CALL gds.graph.drop($graphName)`, { graphName });
      console.log('Dropped existing graph projection.');
    }

    // 2. Project Graph
    await session.run(`
      CALL gds.graph.project(
        $graphName,
        'Service',
        {
          CALLS_NOW: {
            type: 'CALLS_NOW',
            orientation: 'NATURAL',
            properties: 'rate'
          }
        }
      )
    `, { graphName });
    console.log('Graph projected.');

    // 3. Compute PageRank (Weighted)
    const prResult = await session.run(`
      CALL gds.pageRank.write(
        $graphName,
        {
          relationshipWeightProperty: 'rate',
          writeProperty: 'pagerank'
        }
      )
    `, { graphName });
    console.log(`PageRank computed. Properties written: ${prResult.records[0].get('nodePropertiesWritten')}`);

    // 4. Compute Betweenness Centrality
    const bcResult = await session.run(`
      CALL gds.betweenness.write(
        $graphName,
        {
          writeProperty: 'betweenness'
        }
      )
    `, { graphName });
    console.log(`Betweenness computed. Properties written: ${bcResult.records[0].get('nodePropertiesWritten')}`);

    // 5. Cleanup End: Drop projection
    await session.run(`CALL gds.graph.drop($graphName)`, { graphName });
    console.log('Graph projection dropped.');

    // 6. Update Metadata
    await session.run(`
      MATCH (s:Service)
      SET s.updatedAt = datetime()
    `);
    console.log('Service timestamps updated.');

  } catch (error) {
    console.error('Error during score calculation:', error);
  } finally {
    await session.close();
  }
}

module.exports = { checkGDSAvailability, calculateScores };
