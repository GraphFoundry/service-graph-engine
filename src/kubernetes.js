const axios = require('axios');
const config = require('./config');

/**
 * Fetch Node and Pod metrics from Kubernetes API
 * Returns { nodes: [], podMetrics: Map<string, PodMetrics>, services: Map<string, ServiceMetrics> }
 */
async function fetchKubernetesMetrics() {
    try {
        const baseUrl = config.kubernetes.apiUrl;

        // Parallel fetch: Nodes list, Node Metrics, and Pod List (cluster-wide)
        const [nodesRes, podsRes] = await Promise.all([
            axios.get(`${baseUrl}/api/v1/nodes`),
            axios.get(`${baseUrl}/api/v1/pods`)
        ]);

        const nodesList = nodesRes.data.items;
        const podsList = podsRes.data.items;

        const nodesMap = new Map();
        const podMetricsMap = new Map(); // Key: "namespace:podName"
        const servicesMap = new Map();   // Key: "namespace:serviceName"

        // 1. Process Nodes (Capacity)
        const nodeCapacities = new Map(); // nodeName -> { cpuTotal, ramTotal }
        nodesList.forEach(node => {
            const nodeName = node.metadata.name;
            const capacity = node.status.capacity;
            const cpuTotalCores = parseCpu(capacity.cpu);
            const ramTotalBytes = parseMemory(capacity.memory);
            nodeCapacities.set(nodeName, { cpuTotalCores, ramTotalBytes });
        });

        // 2. Fetch Node Usage Stats & Build Node Map
        // Iterate sequentially or parallel limit if cluster is large (sequentially for safety here)
        for (const node of nodesList) {
            const nodeName = node.metadata.name;
            const { cpuTotalCores, ramTotalBytes } = nodeCapacities.get(nodeName);

            try {
                // Fetch Summary
                const summaryRes = await axios.get(`${baseUrl}/api/v1/nodes/${nodeName}/proxy/stats/summary`);
                const summary = summaryRes.data;
                const nodeStats = summary.node;

                // Node CPU Usage
                const cpuUsageNano = Number(nodeStats.cpu.usageNanoCores);
                const cpuUsageCores = cpuUsageNano / 1_000_000_000;
                const cpuUsagePercent = (cpuUsageCores / cpuTotalCores) * 100;

                // Node Memory Usage
                const ramUsageBytes = Number(nodeStats.memory.workingSetBytes);
                const ramUsageMB = ramUsageBytes / (1024 * 1024);
                const ramTotalMB = ramTotalBytes / (1024 * 1024);
                const ramUsagePercent = (ramUsageBytes / ramTotalBytes) * 100;

                nodesMap.set(nodeName, {
                    name: nodeName,
                    cpuUsagePercent: Number(cpuUsagePercent.toFixed(2)),
                    cpuUsed: Number(cpuUsageCores.toFixed(3)),
                    cores: cpuTotalCores,
                    ramUsedMB: Number(ramUsageMB.toFixed(2)),
                    ramTotalMB: Number(ramTotalMB.toFixed(2)),
                    ramUsagePercent: Number(ramUsagePercent.toFixed(2)),
                    pods: [] // Populated by pod mapping logic
                });

                // Process Pod Stats from Node Summary (Resource Usage)
                if (summary.pods) {
                    for (const pod of summary.pods) {
                        const podName = pod.podRef.name;
                        const namespace = pod.podRef.namespace;
                        const key = `${namespace}:${podName}`;

                        let podCpuUsageNano = 0;
                        let podRamUsageBytes = 0;

                        if (pod.cpu && pod.cpu.usageNanoCores) {
                            podCpuUsageNano = Number(pod.cpu.usageNanoCores);
                        }
                        if (pod.memory && pod.memory.workingSetBytes) {
                            podRamUsageBytes = Number(pod.memory.workingSetBytes);
                        }

                        const podCpuUsageCores = podCpuUsageNano / 1_000_000_000;
                        const podRamUsedMB = podRamUsageBytes / (1024 * 1024);
                        const podCpuUsagePercent = (podCpuUsageCores / cpuTotalCores) * 100; // % of Node

                        podMetricsMap.set(key, {
                            podName,
                            namespace,
                            cpuUsageCores: Number(podCpuUsageCores.toFixed(4)),
                            cpuUsagePercent: Number(podCpuUsagePercent.toFixed(2)),
                            ramUsedMB: Number(podRamUsedMB.toFixed(2)),
                            startTime: pod.startTime
                        });
                    }
                }

            } catch (err) {
                console.error(`Failed to fetch stats for node ${nodeName}:`, err.message);
                // Fallback: Create node entry with 0 usage if stats fail but node exists
                nodesMap.set(nodeName, {
                    name: nodeName,
                    cpuUsagePercent: 0,
                    cpuUsed: 0,
                    cores: cpuTotalCores,
                    ramUsedMB: 0,
                    ramTotalMB: Number((ramTotalBytes / 1024 / 1024).toFixed(2)),
                    ramUsagePercent: 0,
                    pods: []
                });
            }
        }

        // 3. Process Pod List (Service Mapping & Availability)
        // We act as "Service Discovery" here using labels
        podsList.forEach(pod => {
            const name = pod.metadata.name;
            const namespace = pod.metadata.namespace;
            const nodeName = pod.spec.nodeName;
            const labels = pod.metadata.labels || {};
            const serviceName = labels.app; // Convention: 'app' label matches service name

            // Skip pods without 'app' label or not scheduled
            if (!serviceName || !nodeName) return;

            // Determine Availability (Ready status)
            let isReady = false;
            if (pod.status && pod.status.conditions) {
                const readyCondition = pod.status.conditions.find(c => c.type === 'Ready');
                if (readyCondition && readyCondition.status === 'True') {
                    isReady = true;
                }
            }

            // Add to Service Map
            const serviceKey = `${namespace}:${serviceName}`;
            if (!servicesMap.has(serviceKey)) {
                servicesMap.set(serviceKey, {
                    name: serviceName,
                    namespace,
                    pods: []
                });
            }
            servicesMap.get(serviceKey).pods.push({
                name,
                node: nodeName,
                isReady
            });

            // Link Pod to Node (for graph structure)
            if (nodesMap.has(nodeName)) {
                if (!nodesMap.get(nodeName).pods.includes(name)) {
                    nodesMap.get(nodeName).pods.push(name);
                }
            }
        });

        return {
            nodes: Array.from(nodesMap.values()),
            podMetrics: podMetricsMap,
            services: servicesMap
        };

    } catch (error) {
        console.error('Failed to fetch Kubernetes metrics:', error.message);
        return { nodes: [], podMetrics: new Map(), services: new Map() };
    }
}

// Helpers
function parseCpu(cpuStr) {
    if (!cpuStr) return 0;
    if (cpuStr.endsWith('m')) {
        return parseInt(cpuStr) / 1000;
    }
    return parseFloat(cpuStr);
}

function parseMemory(memStr) {
    if (!memStr) return 0;
    const units = {
        'Ki': 1024,
        'Mi': 1024 * 1024,
        'Gi': 1024 * 1024 * 1024,
        'Ti': 1024 * 1024 * 1024 * 1024,
    };

    for (const [unit, multiplier] of Object.entries(units)) {
        if (memStr.endsWith(unit)) {
            return parseFloat(memStr) * multiplier;
        }
    }
    return parseFloat(memStr);
}

module.exports = { fetchKubernetesMetrics };
