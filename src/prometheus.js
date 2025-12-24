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
    podCount: `count(sum(rate(istio_requests_total{reporter="destination"}[${config.prometheus.queryWindow}])) by (destination_workload, destination_workload_namespace, instance)) by (destination_workload, destination_workload_namespace)`,
    // Use istio metrics to get pod and node information - labels are 'pod' and 'node'
    podPlacement: `count(istio_requests_total{reporter="destination"}) by (pod, node, destination_workload, destination_workload_namespace)`,
    // Node Resource Queries using cAdvisor metrics (exposed by kubelet, no node-exporter needed)
    // NOTE: These use 'instance' label which matches K8s node name (no port suffix like node-exporter)
    nodeCPUUsed: `sum(rate(container_cpu_usage_seconds_total[1m])) by (instance)`,
    nodeCPUTotal: `machine_cpu_cores`,
    nodeRAMUsed: `sum(container_memory_working_set_bytes) by (instance)`,
    nodeRAMTotal: `machine_memory_bytes`
    // Note: Per-pod metrics not available from cAdvisor in this Prometheus setup
    // cAdvisor exports container metrics but without pod name labels
    // Pod-level metrics would require Kubernetes metrics-server API
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

async function fetchPodPlacement() {
    try {
        const url = `${config.prometheus.url}/api/v1/query`;
        const response = await axios.get(url, { params: { query: QUERIES.podPlacement } });

        if (response.data.status !== 'success') {
            console.error('Error fetching pod placement:', response.data.error);
            return new Map();
        }

        const placementMap = new Map(); // Key: "namespace:workload", Value: { nodes: [{node, pods}] }
        const results = response.data.data.result;

        results.forEach(result => {
            // Get labels from Istio metrics - labels are 'pod' and 'node'
            const pod = result.metric.pod;
            const node = result.metric.node;
            const workload = result.metric.destination_workload;
            const namespace = result.metric.destination_workload_namespace;

            if (!workload || !node || !namespace || !pod) {
                return;
            }

            const key = `${namespace}:${workload}`;

            if (!placementMap.has(key)) {
                placementMap.set(key, { nodes: [] });
            }

            const placement = placementMap.get(key);
            let nodeEntry = placement.nodes.find(n => n.node === node);

            if (!nodeEntry) {
                nodeEntry = { node, pods: [] };
                placement.nodes.push(nodeEntry);
            }

            if (!nodeEntry.pods.includes(pod)) {
                nodeEntry.pods.push(pod);
            }
        });

        return placementMap;
    } catch (error) {
        console.error('Failed to fetch pod placement:', error.message);
        return new Map();
    }
}

async function fetchInfrastructure() {
    try {
        const url = `${config.prometheus.url}/api/v1/query`;

        // Fetch Pod Placement and Node Metrics in parallel
        const [placementRes, cpuUsedRes, cpuTotalRes, ramUsedRes, ramTotalRes] = await Promise.all([
            axios.get(url, { params: { query: QUERIES.podPlacement } }),
            axios.get(url, { params: { query: QUERIES.nodeCPUUsed } }),
            axios.get(url, { params: { query: QUERIES.nodeCPUTotal } }),
            axios.get(url, { params: { query: QUERIES.nodeRAMUsed } }),
            axios.get(url, { params: { query: QUERIES.nodeRAMTotal } })
        ]);

        const nodesMap = new Map(); // Key: nodeName, Value: { name, cpuUsagePercent, cores, ramUsedMB, ramTotalMB, pods: [] }
        const servicesMap = new Map(); // Key: "ns:service", Value: { name, namespace, pods: [] }

        // Process Node Metrics - collect raw values first
        const nodeRawMetrics = new Map(); // Key: nodeName, Value: { cpuUsed, cpuTotal, ramUsed, ramTotal }
        
        const processNodeMetric = (response, field) => {
            if (response.data.status === 'success') {
                response.data.data.result.forEach(r => {
                    let instanceLabel = r.metric.node || r.metric.instance;
                    if (!instanceLabel) return;
                    
                    // Normalize: strip port suffix (for future node-exporter compatibility)
                    let nodeName = instanceLabel.replace(/:\d+$/, '');
                    
                    if (!nodeRawMetrics.has(nodeName)) {
                        nodeRawMetrics.set(nodeName, {
                            cpuUsed: 0,
                            cpuTotal: 0,
                            ramUsed: 0,
                            ramTotal: 0
                        });
                    }
                    const val = Number.parseFloat(r.value[1]);
                    if (!Number.isNaN(val)) nodeRawMetrics.get(nodeName)[field] = val;
                });
            }
        };

        processNodeMetric(cpuUsedRes, 'cpuUsed');
        processNodeMetric(cpuTotalRes, 'cpuTotal');
        processNodeMetric(ramUsedRes, 'ramUsed');
        processNodeMetric(ramTotalRes, 'ramTotal');

        // Convert raw metrics to final format
        nodeRawMetrics.forEach((raw, nodeName) => {
            const cpuUsagePercent = raw.cpuTotal > 0 ? (raw.cpuUsed / raw.cpuTotal * 100) : 0;
            const ramUsedMB = raw.ramUsed / (1024 * 1024);
            const ramTotalMB = raw.ramTotal / (1024 * 1024);
            
            nodesMap.set(nodeName, {
                name: nodeName,
                cpuUsagePercent: Number.parseFloat(cpuUsagePercent.toFixed(2)), // percentage
                cores: raw.cpuTotal, // count
                ramUsedMB: Number.parseFloat(ramUsedMB.toFixed(2)), // MB
                ramTotalMB: Number.parseFloat(ramTotalMB.toFixed(2)), // MB
                pods: []
            });
        });

        // Process Placement
        if (placementRes.data.status === 'success') {
            const results = placementRes.data.data.result;
            console.log(`DEBUG: fetchInfrastructure found ${results.length} placement records.`);

            if (results.length > 0) {
                console.log('DEBUG: detailed sample placement:', JSON.stringify(results[0].metric, null, 2));
            }

            results.forEach(r => {
                const podName = r.metric.pod;
                const nodeName = r.metric.node;
                const serviceName = r.metric.destination_workload;
                const namespace = r.metric.destination_workload_namespace;

                if (!podName || !serviceName || !namespace) return;

                // Ensure Node exists (if we have nodeName)
                if (nodeName) {
                    if (!nodesMap.has(nodeName)) {
                        nodesMap.set(nodeName, {
                            name: nodeName,
                            cpuUsagePercent: 0,
                            cores: 0,
                            ramUsedMB: 0,
                            ramTotalMB: 0,
                            pods: []
                        });
                    }
                    
                    // Add pod name only (no per-pod metrics available from cAdvisor)
                    nodesMap.get(nodeName).pods.push(podName);
                }

                // Ensure Service exists
                const serviceKey = `${namespace}:${serviceName}`;
                if (!servicesMap.has(serviceKey)) {
                    servicesMap.set(serviceKey, { name: serviceName, namespace, pods: [] });
                }

                // Add pod to service (with node reference, no per-pod metrics)
                servicesMap.get(serviceKey).pods.push({
                    name: podName,
                    node: nodeName
                });
            });
        }

        // Log final node metrics
        nodesMap.forEach((node, name) => {
            console.log(`  - ${name}: cpu=${node.cpuUsagePercent}% (${node.cores} cores), ram=${node.ramUsedMB}/${node.ramTotalMB} MB, pods=${node.pods.length}`);
        });

        return {
            nodes: Array.from(nodesMap.values()),
            services: Array.from(servicesMap.values())
        };

    } catch (error) {
        console.error('Failed to fetch infrastructure:', error.message);
        return { nodes: [], services: [] };
    }
}

module.exports = { fetchPrometheusFiles, fetchPodPlacement, fetchInfrastructure };
