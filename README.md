# Service Graph Engine

A real-time microservice observability platform that ingests Istio telemetry data from Prometheus, builds a service dependency graph in Neo4j, and provides a RESTful API with comprehensive metrics and graph analytics.

## 🎯 Overview

This service continuously monitors your Istio service mesh, collecting performance metrics and infrastructure data to provide:

- **Service Dependency Graph**: Visual representation of microservice interactions
- **Real-time Metrics**: RPS, error rates, latency percentiles (P50, P95, P99)
- **Infrastructure Monitoring**: Node and Pod resource utilization
- **Centrality Scores**: PageRank and Betweenness metrics to identify critical services
- **Historical Data**: Time-series tracking of service metrics
- **RESTful API**: Complete observability data access with Swagger documentation

## 🏗️ Architecture

```
┌─────────────┐      ┌────────────────┐      ┌──────────────┐
│   Istio     │─────▶│  Prometheus    │◀────│ Kubernetes   │
│ Service Mesh│      │                │      │   API        │
└─────────────┘      └────────────────┘      └──────────────┘
                            │                        │
                            ▼                        ▼
                    ┌───────────────────────────────────┐
                    │   Service Graph Engine            │
                    │  - Metrics Ingestion              │
                    │  - Graph Analytics                │
                    │  - API Server                     │
                    └───────────────────────────────────┘
                            │
                            ▼
                    ┌──────────────┐
                    │    Neo4j     │
                    │  Graph DB    │
                    └──────────────┘
```

## ✨ Features

### Metrics Collection
- **Service-to-Service Metrics**: Request rates, error rates, latency distributions
- **Infrastructure Metrics**: CPU and RAM usage for nodes and pods
- **Availability Tracking**: Service health and pod counts
- **Pod Placement**: Node affinity and pod distribution

### Graph Analytics
- **PageRank**: Identify most important services by incoming traffic
- **Betweenness Centrality**: Find critical services in communication paths
- **Historical Analysis**: Track metric evolution over time

### API Endpoints
- `/metrics/snapshot` - Latest metrics for all services and edges
- `/graph` - Full service dependency graph with scores
- `/graph/node/:name` - Individual service details
- `/graph/edges` - All service-to-service connections
- `/graph/history` - Historical metric trends
- `/infrastructure` - Kubernetes infrastructure metrics
- `/api-docs` - Interactive Swagger documentation

## 📋 Prerequisites

- **Node.js** 16+ and npm
- **Neo4j** 6.0+ (AuraDB or self-hosted)
- **Kubernetes** cluster with Istio installed
- **Prometheus** with Istio metrics configured
- **Kubernetes API** access (for infrastructure metrics)

## 🚀 Installation

### 1. Clone the Repository

```bash
git clone <repository-url>
cd service-graph-engine
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment

Create a `.env` file in the root directory:

```env
# Prometheus Configuration
PROMETHEUS_URL=http://localhost:9090

# Neo4j Configuration
NEO4J_URI=neo4j+s://your-instance.databases.neo4j.io
NEO4J_USER=neo4j
NEO4J_PASSWORD=your-password
NEO4J_DATABASE=neo4j

# Kubernetes API Configuration
KUBERNETES_API_URL=http://your-k8s-api:8001

# Application Configuration
PORT=3000
POLL_INTERVAL_Ms=30000              # Metrics polling interval (30 seconds)
SCORE_CALCULATION_INTERVAL_Ms=120000 # Score calculation interval (2 minutes)
```

### 4. Start the Service

```bash
node index.js
```

The service will:
1. Initialize Neo4j schema
2. Check Graph Data Science (GDS) availability
3. Perform initial sync and score calculation
4. Start scheduled polling
5. Launch API server on port 3000

## 🔧 Configuration

### Prometheus Query Window

The service uses a 1-minute window for metric aggregation. To modify this, edit `src/config.js`:

```javascript
prometheus: {
  queryWindow: '1m', // Change to '5m', '15m', etc.
}
```

### Polling Intervals

Adjust polling frequency in `.env`:

```env
# Poll Prometheus every 30 seconds
POLL_INTERVAL_Ms=30000

# Calculate graph scores every 2 minutes
SCORE_CALCULATION_INTERVAL_Ms=120000
```

## 📊 API Usage

### Get Latest Metrics Snapshot

```bash
curl http://localhost:3000/metrics/snapshot
```

Response:
```json
{
  "timestamp": "2026-01-10T12:00:00Z",
  "window": "1m",
  "services": [
    {
      "name": "frontend",
      "namespace": "default",
      "rps": 12.3,
      "errorRate": 0.01,
      "p95": 120.5
    }
  ],
  "edges": [
    {
      "from": "frontend",
      "to": "backend",
      "namespace": "default",
      "rps": 5.2,
      "errorRate": 0.00,
      "p95": 80.1
    }
  ]
}
```

### Get Service Dependency Graph

```bash
curl http://localhost:3000/graph
```

Response includes nodes with centrality scores and edges with metrics.

### View API Documentation

Open your browser to:
```
http://localhost:3000/api-docs
```

## 🧪 Testing with Example Services

Deploy sample microservices to generate test traffic:

```bash
cd k8s-example

# Enable Istio injection
kubectl label namespace default istio-injection=enabled --overwrite

# Deploy services
kubectl apply -f backend.yaml
kubectl apply -f frontend.yaml

# Verify deployment
kubectl get pods -n default
```

After 1-2 minutes, the service graph should show `frontend → backend` connections.

See [k8s-example/README.md](k8s-example/README.md) for details.

## 📁 Project Structure

```
service-graph-engine/
├── index.js                 # Main entry point
├── package.json             # Dependencies and metadata
├── src/
│   ├── config.js            # Configuration management
│   ├── server.js            # Express API server with Swagger
│   ├── prometheus.js        # Prometheus metric queries
│   ├── kubernetes.js        # Kubernetes API integration
│   ├── neo4j.js             # Neo4j graph operations
│   ├── scores.js            # Neo4j GDS score calculation (deprecated)
│   ├── scores_local.js      # Client-side score calculation
│   └── swagger.js           # Swagger/OpenAPI configuration
└── k8s-example/
    ├── backend.yaml         # Example backend service
    ├── frontend.yaml        # Example frontend service
    └── README.md            # Example deployment guide
```

## 🔍 Key Components

### Metrics Collection (`prometheus.js`)

Queries Istio metrics from Prometheus:
- `istio_requests_total` - Request rates
- `istio_request_duration_milliseconds_bucket` - Latency percentiles
- `container_cpu_usage_seconds_total` - CPU usage
- `container_memory_working_set_bytes` - Memory usage

### Graph Management (`neo4j.js`)

Manages Neo4j operations:
- **CALLS_NOW**: Latest service-to-service metrics
- **CALLS_HISTORY**: Historical metric snapshots
- **RUNS_ON**: Pod-to-Node placement
- **HOSTS**: Node-to-Pod relationships

### Score Calculation (`scores_local.js`)

Calculates graph centrality metrics using Graphology:
- **PageRank**: Importance based on incoming connections
- **Betweenness**: Criticality in communication paths

### Infrastructure Monitoring (`kubernetes.js`)

Fetches from Kubernetes API:
- Node CPU and memory usage
- Pod resource consumption
- Pod placement and status

## 🛠️ Development

### Run in Development Mode

```bash
# With auto-restart on file changes
npm install -g nodemon
nodemon index.js
```

### View Logs

The service provides detailed logging:
- Sync cycle execution
- Metrics fetched count
- Neo4j graph updates
- Score calculation results
- API server status

### Debug Prometheus Queries

Check if metrics are available:

```bash
# Test Prometheus connectivity
curl "http://localhost:9090/api/v1/query?query=up"

# Check Istio metrics
curl "http://localhost:9090/api/v1/query?query=istio_requests_total"
```

## 🔐 Security Considerations

**⚠️ Important**: The `config.js` file currently contains hardcoded credentials. For production:

1. Remove all hardcoded credentials
2. Use environment variables exclusively
3. Never commit `.env` files to version control
4. Add `.env` to `.gitignore`:

```bash
echo ".env" >> .gitignore
```

3. Use secret management tools (e.g., Kubernetes Secrets, HashiCorp Vault)

## 📈 Performance

### Resource Requirements

- **Memory**: ~100-200 MB baseline
- **CPU**: Minimal (~1-5% during polling)
- **Network**: Depends on cluster size and polling frequency

### Scalability

- Tested with up to 50+ services
- Graph queries optimized with Neo4j indexes
- Client-side score calculation scales to hundreds of nodes

### Optimization Tips

1. Increase polling intervals for larger clusters
2. Use Neo4j AuraDB for managed, scalable database
3. Filter out noisy namespaces in Prometheus queries
4. Adjust query window based on traffic patterns

## 🐛 Troubleshooting

### No Metrics Showing

1. Verify Istio sidecars are injected:
   ```bash
   kubectl get pods -n default -o wide
   # Should show 2/2 containers (app + istio-proxy)
   ```

2. Check Prometheus has Istio metrics:
   ```bash
   curl "http://prometheus:9090/api/v1/query?query=istio_requests_total"
   ```

3. Verify namespace labels in Prometheus output

### Neo4j Connection Errors

1. Test database connectivity:
   ```bash
   # Update credentials in command
   cypher-shell -a neo4j+s://your-instance.databases.neo4j.io \
     -u neo4j -p your-password "MATCH (n) RETURN count(n);"
   ```

2. Check firewall rules allow Neo4j ports (7687 for Bolt)

### High Error Rates

If seeing 500 errors in API responses:
1. Check Neo4j logs for query failures
2. Verify database disk space
3. Review application logs for stack traces

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature-name`
3. Commit changes: `git commit -am 'Add feature'`
4. Push to branch: `git push origin feature-name`
5. Submit a Pull Request

## License

ISC License

## Acknowledgments

- **Istio** - Service mesh platform
- **Prometheus** - Monitoring and alerting
- **Neo4j** - Graph database
- **Graphology** - Graph data structure library
- **Express** - Web framework
- **Swagger** - API documentation

## Support

For issues and questions:
- Create an issue in the repository
- Check existing issues for similar problems
- Review Prometheus and Neo4j logs for detailed error messages


