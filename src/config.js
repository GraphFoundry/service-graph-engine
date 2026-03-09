require('dotenv').config();
const fs = require('fs');
const path = require('path');

const config = {
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
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_Ms, 10) || 30000, // 30 seconds
    scoreCalculationIntervalMs: parseInt(process.env.SCORE_CALCULATION_INTERVAL_Ms, 10) || 120000, // 2 minutes
    port: process.env.PORT || 3000
  }
};

/**
 * Parse a KEY=VALUE env file and set values in process.env.
 */
function loadRuntimeEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  content.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) return;
    const key = trimmed.substring(0, eqIdx).trim();
    const value = trimmed.substring(eqIdx + 1).trim();
    process.env[key] = value;
  });
}

/**
 * Reload runtime-tunable config values from the mounted ConfigMap file.
 * Updates config.app in-place so all existing references see the new values.
 */
function reloadFromFile(filePath) {
  filePath = filePath || '/etc/runtime-config/runtime.env';
  loadRuntimeEnvFile(filePath);
  config.app.pollIntervalMs = parseInt(process.env.POLL_INTERVAL_Ms, 10) || 30000;
  config.app.scoreCalculationIntervalMs = parseInt(process.env.SCORE_CALCULATION_INTERVAL_Ms, 10) || 120000;
  console.log(`[CONFIG] Runtime config reloaded from ${filePath}`);
  console.log(`[CONFIG] pollIntervalMs=${config.app.pollIntervalMs}, scoreCalculationIntervalMs=${config.app.scoreCalculationIntervalMs}`);
}

config.reloadFromFile = reloadFromFile;

module.exports = config;
