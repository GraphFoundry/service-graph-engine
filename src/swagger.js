const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');
const config = require('./config');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Istio Telemetry Service Graph API',
      version: '1.0.0',
      description: 'API for querying service graph data from Istio telemetry, including service dependencies, centrality metrics, and graph health information.',
      contact: {
        name: 'API Support',
      },
    },
    servers: [
      {
        url: `http://localhost:${config.app.port}`,
        description: 'Local development server',
      },
      {
        url: '{protocol}://{host}:{port}',
        description: 'Custom server',
        variables: {
          protocol: {
            enum: ['http', 'https'],
            default: 'http',
          },
          host: {
            default: 'localhost',
          },
          port: {
            default: config.app.port.toString(),
          },
        },
      },
    ],
    tags: [
      {
        name: 'Health',
        description: 'Graph health and metadata endpoints',
      },
      {
        name: 'Services',
        description: 'Service discovery and dependency queries',
      },
      {
        name: 'Centrality',
        description: 'Centrality metrics and rankings',
      },
    ],
  },
  apis: ['./src/server.js'], // Path to the API routes
};

const specs = swaggerJsdoc(options);

module.exports = { specs, swaggerUi };
