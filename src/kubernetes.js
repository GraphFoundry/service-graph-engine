const axios = require('axios');
const config = require('./config');

/**
 * Fetch Node and Pod metrics from Kubernetes API (stats/summary)
 * Returns { nodes: [], pods: Map<string, PodMetrics> }
 */
async function fetchKubernetesMetrics() {
    try {
        const baseUrl = config.kubernetes.apiUrl;

        // 1. Get list of nodes
        const nodesRes = await axios.get(`${baseUrl}/api/v1/nodes`);
        const nodesList = nodesRes.data.items;

        const nodesMap = new Map();
        const podMetricsMap = new Map(); // Key: "namespace:podName"

        // 2. Iterate each node and get stats/summary
        for (const node of nodesList) {
            const nodeName = node.metadata.name;
            const capacity = node.status.capacity;
            const allocatable = node.status.allocatable;

            // Parse Capacity (cpu in cores, memory in Ki/Mi/etc)
            // CPU: "8" -> 8 cores
            // Memory: "24026408Ki" -> bytes
            const cpuTotalCores = parseCpu(capacity.cpu);
            const ramTotalBytes = parseMemory(capacity.memory);

            try {
                // Fetch Summary
                const summaryRes = await axios.get(`${baseUrl}/api/v1/nodes/${nodeName}/proxy/stats/summary`);
                const summary = summaryRes.data;
                const nodeStats = summary.node;

                // Node CPU Usage
                // usageNanoCores: integer formatted string
                const cpuUsageNano = Number(nodeStats.cpu.usageNanoCores);
                const cpuUsageCores = cpuUsageNano / 1_000_000_000;
                const cpuUsagePercent = (cpuUsageCores / cpuTotalCores) * 100;

                // Node Memory Usage
                // workingSetBytes: integer
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
                    pods: [] // Populated later by graph engine or here? logic usually in prometheus.js
                });

                // Pods on this node
                if (summary.pods) {
                    for (const pod of summary.pods) {
                        const podName = pod.podRef.name;
                        const namespace = pod.podRef.namespace;
                        const key = `${namespace}:${podName}`;

                        // Aggregated pod usage (sum of containers usually, but summary has pod-level)
                        // If pod-level cpu/memory is directly available:
                        let podCpuUsageNano = 0;
                        let podRamUsageBytes = 0;

                        // Check if pod has aggregated stats, else sum containers
                        if (pod.cpu && pod.cpu.usageNanoCores) {
                            podCpuUsageNano = Number(pod.cpu.usageNanoCores);
                        }
                        if (pod.memory && pod.memory.workingSetBytes) {
                            podRamUsageBytes = Number(pod.memory.workingSetBytes);
                        }

                        const podCpuUsageCores = podCpuUsageNano / 1_000_000_000;
                        const podRamUsedMB = podRamUsageBytes / (1024 * 1024);

                        // Pod percentage is relative to Node capacity usually, or limit?
                        // Dashboard expects % of Node usually for visualization
                        const podCpuUsagePercent = (podCpuUsageCores / cpuTotalCores) * 100;

                        podMetricsMap.set(key, {
                            podName,
                            namespace,
                            cpuUsageCores: Number(podCpuUsageCores.toFixed(4)),
                            cpuUsagePercent: Number(podCpuUsagePercent.toFixed(2)),
                            ramUsedMB: Number(podRamUsedMB.toFixed(2)),
                            // Uptime: value available? 
                            // summary.pods[].startTime is string "2026-01-04T13:34:02Z"
                            startTime: pod.startTime
                        });
                    }
                }

            } catch (err) {
                console.error(`Failed to fetch stats for node ${nodeName}:`, err.message);
                // Fallback or empty for this node
            }
        }

        return {
            nodes: Array.from(nodesMap.values()),
            podMetrics: podMetricsMap
        };

    } catch (error) {
        console.error('Failed to fetch Kubernetes metrics:', error.message);
        return { nodes: [], podMetrics: new Map() };
    }
}

// Helpers
function parseCpu(cpuStr) {
    if (cpuStr.endsWith('m')) {
        return parseInt(cpuStr) / 1000;
    }
    return parseFloat(cpuStr);
}

function parseMemory(memStr) {
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
    return parseFloat(memStr); // Assume bytes if no unit? or Ki default? K8s usually strict.
}

module.exports = { fetchKubernetesMetrics };
