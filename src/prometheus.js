const axios = require('axios');
const config = require('./config');

// Helper to construct the BY clause
const BY_CLAUSE = 'by (source_workload, source_workload_namespace, destination_workload, destination_workload_namespace)';

const QUERIES = {
    rps: `sum(rate(istio_requests_total[${config.prometheus.queryWindow}])) ${BY_CLAUSE}`,
    errorRate: `sum(rate(istio_requests_total{response_code=~"5.."}[${config.prometheus.queryWindow}])) ${BY_CLAUSE}`,
    p50: `histogram_quantile(0.50, sum(rate(istio_request_duration_milliseconds_bucket[${config.prometheus.queryWindow}])) by (le, source_workload, source_workload_namespace, destination_workload, destination_workload_namespace))`,
    p95: `histogram_quantile(0.95, sum(rate(istio_request_duration_milliseconds_bucket[${config.prometheus.queryWindow}])) by (le, source_workload, source_workload_namespace, destination_workload, destination_workload_namespace))`,
    p99: `histogram_quantile(0.99, sum(rate(istio_request_duration_milliseconds_bucket[${config.prometheus.queryWindow}])) by (le, source_workload, source_workload_namespace, destination_workload, destination_workload_namespace))`,
    availability: `sum(rate(istio_requests_total{reporter="destination", response_code!~"5.*"}[${config.prometheus.queryWindow}])) by (destination_workload, destination_workload_namespace) / sum(rate(istio_requests_total{reporter="destination"}[${config.prometheus.queryWindow}])) by (destination_workload, destination_workload_namespace)`,
    podCount: `count(sum(rate(istio_requests_total{reporter="destination"}[${config.prometheus.queryWindow}])) by (destination_workload, destination_workload_namespace, instance)) by (destination_workload, destination_workload_namespace)`
};

async function fetchPrometheusFiles() {
    const metricsMap = new Map();
    const nodeMetricsMap = new Map(); // Key: "namespace:name", Value: { availability, podCount }

    // Helper to store node metrics
    const storeNodeMetric = (name, results) => {
        results.forEach(result => {
            const workload = result.metric.destination_workload;
            const ns = result.metric.destination_workload_namespace;
            if (!workload || workload === 'unknown' || !ns || ns === 'unknown') return;

            const id = `${ns}:${workload}`;
            if (!nodeMetricsMap.has(id)) {
                nodeMetricsMap.set(id, { availability: 0, podCount: 0 });
            }

            const val = parseFloat(result.value[1]);
            if (!isNaN(val)) {
                if (name === 'availability') {
                    // Convert availability to 0 or 1 (integer boolean)
                    nodeMetricsMap.get(id)[name] = val >= 0.5 ? 1 : 0;
                } else if (name === 'podCount') {
                    // Ensure podCount is an integer
                    nodeMetricsMap.get(id)[name] = Math.floor(val);
                } else {
                    nodeMetricsMap.get(id)[name] = val;
                }
            }
        });
    };

    const fetchMetric = async (name, query, isNodeMetric = false) => {
        try {
            const url = `${config.prometheus.url}/api/v1/query`;
            const response = await axios.get(url, { params: { query } });

            if (response.data.status !== 'success') {
                console.error(`Error fetching ${name}: ${response.data.error}`);
                return;
            }

            const results = response.data.data.result;

            if (results.length > 0 && name === 'rate') {
                console.log('DEBUG: Sample Metric Labels:', JSON.stringify(results[0].metric, null, 2));
            }


            if (isNodeMetric) {
                storeNodeMetric(name, results);
                return;
            }

            results.forEach(result => {
                const sourceName = result.metric.source_workload;
                const sourceNs = result.metric.source_workload_namespace;
                const destName = result.metric.destination_workload;
                const destNs = result.metric.destination_workload_namespace;

                // Normalization: Ignore unknown or empty workloads
                if (!sourceName || sourceName === 'unknown' || !destName || destName === 'unknown') {
                    return;
                }

                // DEBUG: Check if we are dropping due to namespace
                if (!sourceNs || sourceNs === 'unknown' || !destNs || destNs === 'unknown') {
                    if (Math.random() < 0.01) console.log(`DEBUG: Dropping due to namespace: src=${sourceNs}, dest=${destNs}`);
                    return;
                }

                const sourceId = `${sourceNs}:${sourceName}`;
                const destId = `${destNs}:${destName}`;
                const key = `${sourceId}|${destId}`;

                if (!metricsMap.has(key)) {
                    metricsMap.set(key, {
                        sourceId,
                        sourceName,
                        sourceNamespace: sourceNs,
                        destId,
                        destName,
                        destNamespace: destNs,
                        rate: 0,
                        errorRate: 0,
                        p50: 0,
                        p95: 0,
                        p99: 0
                    });
                }

                const value = parseFloat(result.value[1]);
                if (!isNaN(value)) {
                    metricsMap.get(key)[name] = value;
                }
            });
        } catch (error) {
            console.error(`Failed to fetch ${name}:`, error.message);
        }
    };

    await Promise.all([
        fetchMetric('rate', QUERIES.rps),
        fetchMetric('errorRate', QUERIES.errorRate),
        fetchMetric('p50', QUERIES.p50),
        fetchMetric('p95', QUERIES.p95),
        fetchMetric('p99', QUERIES.p99),
        fetchMetric('availability', QUERIES.availability, true),
        fetchMetric('podCount', QUERIES.podCount, true)
    ]);

    // Enrich edges with Node metrics
    for (const metric of metricsMap.values()) {
        const sourceNode = nodeMetricsMap.get(metric.sourceId) || { availability: 0, podCount: 0 };
        const destNode = nodeMetricsMap.get(metric.destId) || { availability: 0, podCount: 0 };

        metric.sourceAvailability = sourceNode.availability;
        metric.sourcePodCount = sourceNode.podCount;
        metric.destAvailability = destNode.availability;
        metric.destPodCount = destNode.podCount;
    }

    return Array.from(metricsMap.values());
}

module.exports = { fetchPrometheusFiles };
