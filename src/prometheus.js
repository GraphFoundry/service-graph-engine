const axios = require('axios');
const config = require('./config');

const QUERIES = {
    rps: `sum(rate(istio_requests_total[${config.prometheus.queryWindow}])) by (source_workload, destination_workload)`,
    errorRate: `sum(rate(istio_requests_total{response_code=~"5.."}[${config.prometheus.queryWindow}])) by (source_workload, destination_workload)`,
    p50: `histogram_quantile(0.50, sum(rate(istio_request_duration_milliseconds_bucket[${config.prometheus.queryWindow}])) by (le, source_workload, destination_workload))`,
    p95: `histogram_quantile(0.95, sum(rate(istio_request_duration_milliseconds_bucket[${config.prometheus.queryWindow}])) by (le, source_workload, destination_workload))`,
    p99: `histogram_quantile(0.99, sum(rate(istio_request_duration_milliseconds_bucket[${config.prometheus.queryWindow}])) by (le, source_workload, destination_workload))`,
};

async function fetchPrometheusFiles() {
    const metricsMap = new Map();

    const fetchMetric = async (name, query) => {
        try {
            const url = `${config.prometheus.url}/api/v1/query`;
            const response = await axios.get(url, { params: { query } });

            if (response.data.status !== 'success') {
                console.error(`Error fetching ${name}: ${response.data.error}`);
                return;
            }

            const results = response.data.data.result;

            results.forEach(result => {
                const source = result.metric.source_workload;
                const destination = result.metric.destination_workload;

                // Normalization: Ignore unknown or empty workloads
                if (!source || source === 'unknown' || !destination || destination === 'unknown') {
                    return;
                }

                const key = `${source}|${destination}`;
                if (!metricsMap.has(key)) {
                    metricsMap.set(key, {
                        source,
                        destination,
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
    ]);

    return Array.from(metricsMap.values());
}

module.exports = { fetchPrometheusFiles };
