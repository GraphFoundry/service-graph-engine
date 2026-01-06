require('dotenv').config();

module.exports = {
  prometheus: {
    url: process.env.PROMETHEUS_URL || 'http://localhost:9090',
    queryWindow: '1m', // As per requirement
  },
  neo4j: {
    uri: process.env.NEO4J_URI || 'neo4j+s://517b3e75.databases.neo4j.io',
    user: process.env.NEO4J_USER || 'neo4j',
    password: process.env.NEO4J_PASSWORD || 'Ex-hfrpIOCfghD-dZ04f2ya3-zbUpBdsZSgjwl6a8Rg',
    database: process.env.NEO4J_DATABASE || 'neo4j',
  },
  kubernetes: {
    apiUrl: process.env.KUBERNETES_API_URL || 'http://140.245.39.115:8005',
  },
  app: {
    pollIntervalMs: process.env.POLL_INTERVAL_Ms || 30000, // 30 seconds
    scoreCalculationIntervalMs: process.env.SCORE_CALCULATION_INTERVAL_Ms || 120000, // 2 minutes
    port: process.env.PORT || 3000
  }
};
