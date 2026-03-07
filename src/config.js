require('dotenv').config();

module.exports = {
  prometheus: {
    url: process.env.PROMETHEUS_URL || 'http://localhost:9090',
    queryWindow: '1m', // As per requirement
  },
  neo4j: {
    uri: process.env.NEO4J_URI || 'neo4j://localhost:7687',
    user: process.env.NEO4J_USER || 'neo4j',
    password: process.env.NEO4J_PASSWORD || 'test1234',
    database: process.env.NEO4J_DATABASE || 'neo4j',
  },
  kubernetes: {
    apiUrl: process.env.KUBERNETES_API_URL || 'https://kubernetes.default.svc',
  },
  app: {
    pollIntervalMs: process.env.POLL_INTERVAL_Ms || 30000, // 30 seconds
    scoreCalculationIntervalMs: process.env.SCORE_CALCULATION_INTERVAL_Ms || 120000, // 2 minutes
    port: process.env.PORT || 3000
  }
};
