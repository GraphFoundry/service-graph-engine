const axios = require('axios');
const config = require('./config');

// Keep destination identity stable even when workload label becomes "unknown" during outages.
const DEST_NAME_LABEL = 'destination_service_name';
const DEST_NS_LABEL = 'destination_service_namespace';
const BY_CLAUSE = `by (source_workload, source_workload_namespace, ${DEST_NAME_LABEL}, ${DEST_NS_LABEL})`;

const QUERIES = {
    rps: `sum(rate(istio_requests_total[${config.prometheus.queryWindow}])) ${BY_CLAUSE}`,
    // Use `or` union before aggregation so missing 5xx/non-5xx branches contribute 0
    // instead of dropping the whole vector during arithmetic.
    errorRate: `sum(
      rate(istio_requests_total{response_code=~"5.."}[${config.prometheus.queryWindow}])
      or
      rate(istio_requests_total{response_code!~"5..", grpc_response_status=~".+", grpc_response_status!~"0"}[${config.prometheus.queryWindow}])
    ) ${BY_CLAUSE} / clamp_min(sum(rate(istio_requests_total[${config.prometheus.queryWindow}])) ${BY_CLAUSE}, 1e-9)`,
    p50: `histogram_quantile(0.50, sum(rate(istio_request_duration_milliseconds_bucket[${config.prometheus.queryWindow}])) by (le, source_workload, source_workload_namespace, destination_workload, destination_workload_namespace))`,
    p95: `histogram_quantile(0.95, sum(rate(istio_request_duration_milliseconds_bucket[${config.prometheus.queryWindow}])) by (le, source_workload, source_workload_namespace, destination_workload, destination_workload_namespace))`,
    p99: `histogram_quantile(0.99, sum(rate(istio_request_duration_milliseconds_bucket[${config.prometheus.queryWindow}])) by (le, source_workload, source_workload_namespace, destination_workload, destination_workload_namespace))`,
    availability: `sum(rate(istio_requests_total{reporter="destination", response_code!~"5.*"}[15m])) by (${DEST_NAME_LABEL}, ${DEST_NS_LABEL}) / sum(rate(istio_requests_total{reporter="destination"}[15m])) by (${DEST_NAME_LABEL}, ${DEST_NS_LABEL})`,
    podCount: `count(sum(rate(istio_requests_total{reporter="destination"}[${config.prometheus.queryWindow}])) by (${DEST_NAME_LABEL}, ${DEST_NS_LABEL}, instance)) by (${DEST_NAME_LABEL}, ${DEST_NS_LABEL})`,
    // Use istio metrics to get pod and node information - labels are 'pod' and 'node'
    podPlacement: `count(istio_requests_total{reporter="destination"}) by (pod, node, destination_workload, destination_workload_namespace)`,
    // Node Resource Queries using cAdvisor metrics (exposed by kubelet, no node-exporter needed)
    // NOTE: These use 'instance' label which matches K8s node name (no port suffix like node-exporter)
    nodeCPUUsed: `sum(rate(container_cpu_usage_seconds_total[1m])) by (instance)`,
    nodeCPUTotal: `machine_cpu_cores`,
    nodeRAMUsed: `sum(container_memory_working_set_bytes) by (instance)`,
    nodeRAMTotal: `machine_memory_bytes`,
    // Pod-level Container Resource Queries (aggregated per pod)
    // These work when cAdvisor aggregates at pod level (container label missing)
    podRAMUsed: `sum(container_memory_working_set_bytes{pod!=""}) by (pod, namespace) / 1024 / 1024`,
    podCPUUsed: `sum(rate(container_cpu_usage_seconds_total{pod!=""}[1m])) by (pod, namespace)`,
    podUptime: `time() - min(container_start_time_seconds{pod!=""}) by (pod, namespace)`
};

async function fetchPrometheusFiles() {
    const metricsMap = new Map();
    const nodeMetricsMap = new Map(); // Key: "namespace:name", Value: { availability, podCount }

    // Helper to store node metrics
    const storeNodeMetric = (name, results) => {
        results.forEach(result => {
            const workload = getDestinationName(result.metric);
            const ns = getDestinationNamespace(result.metric);
            if (!workload || workload === 'unknown' || !ns || ns === 'unknown') return;

            const id = `${ns}:${workload}`;
            if (!nodeMetricsMap.has(id)) {
                nodeMetricsMap.set(id, { availability: 0, podCount: 0 });
            }

            const val = parseFloat(result.value[1]);
            if (!isNaN(val)) {
                if (name === 'availability') {
                    // Store exact availability (0.0 - 1.0) instead of rounding
                    nodeMetricsMap.get(id)[name] = val;
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
                const destName = getDestinationName(result.metric);
                const destNs = getDestinationNamespace(result.metric);

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

const { fetchKubernetesMetrics } = require('./kubernetes');

async function fetchInfrastructure() {
    try {
        // Ground truth for infrastructure is Kubernetes (nodes, pods, readiness).
        // Do not synthesize pod placement from traffic metrics for this view.
        const k8sMetrics = await fetchKubernetesMetrics();

        const nodesMap = new Map(); // Key: nodeName, Value: { name, cpuUsagePercent, cores, ramUsedMB, ramTotalMB, pods: [] }
        const servicesMap = new Map(); // Key: "ns:service", Value: { name, namespace, pods: [], availability: ... }

        // Populate Nodes from K8s Metrics (Ground Truth)
        k8sMetrics.nodes.forEach(node => {
            nodesMap.set(node.name, node);
        });

        // Use K8s Pod Metrics Map
        const podMetricsMap = k8sMetrics.podMetrics;

        // Populate Services from K8s Discovery (Ground Truth)
        if (k8sMetrics.services) {
            k8sMetrics.services.forEach((serviceData, key) => {
                const podDetails = serviceData.pods.map(podInfo => {
                    const podKey = `${serviceData.namespace}:${podInfo.name}`;
                    const metrics = podMetricsMap.get(podKey) || {
                        ramUsedMB: 0,
                        cpuUsageCores: 0,
                        cpuUsagePercent: 0,
                        uptimeSeconds: 0
                    };

                    // Calculate uptime
                    let uptimeSeconds = 0;
                    if (metrics.startTime) {
                        const diff = Date.now() - new Date(metrics.startTime).getTime();
                        uptimeSeconds = Math.floor(diff / 1000);
                        if (uptimeSeconds < 0) uptimeSeconds = 0;
                    }

                    return {
                        name: podInfo.name,
                        node: podInfo.node,
                        ramUsedMB: metrics.ramUsedMB,
                        cpuUsageCores: metrics.cpuUsageCores,
                        cpuUsagePercent: metrics.cpuUsagePercent,
                        uptimeSeconds: uptimeSeconds,
                        isReady: podInfo.isReady
                    };
                });

                // Determine Infrastructure Availability (At least one pod ready)
                const availablePodCount = podDetails.filter(p => p.isReady).length;
                const availability = availablePodCount > 0 ? 1 : 0;

                servicesMap.set(key, {
                    name: serviceData.name,
                    namespace: serviceData.namespace,
                    pods: podDetails,
                    podCount: podDetails.length,
                    availability: availability
                });
            });
        }

        // Log confirmation
        console.log(`Updated infrastructure from K8s API: ${nodesMap.size} nodes, ${servicesMap.size} services.`);

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

function getDestinationName(metric) {
    const workload = metric.destination_workload;
    if (workload && workload !== 'unknown') {
        return workload;
    }
    return metric.destination_service_name;
}

function getDestinationNamespace(metric) {
    const ns = metric.destination_workload_namespace;
    if (ns && ns !== 'unknown') {
        return ns;
    }
    return metric.destination_service_namespace;
}
