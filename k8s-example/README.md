# Minimal Kubernetes Deployment for Service Graph Discovery

This creates a minimal setup with 2 services that generate Istio metrics.

## Prerequisites

- Kubernetes cluster running
- Istio installed with Prometheus

## Deploy

```bash
# Enable Istio sidecar injection on default namespace
kubectl label namespace default istio-injection=enabled --overwrite

# Apply all resources
kubectl apply -f backend.yaml
kubectl apply -f frontend.yaml

# Verify pods are running with Istio sidecars (should see 2/2)
kubectl get pods -n default

# Check if metrics are being generated
kubectl exec -n default deployment/frontend -c istio-proxy -- curl -s localhost:15000/stats/prometheus | grep istio_requests_total
```

## What This Creates

- **Backend service**: Simple HTTP echo server (in default namespace)
- **Frontend service**: Continuously calls backend every 2 seconds (in default namespace)

Both services get Istio sidecars injected automatically via the namespace label.

This generates traffic that creates the following metrics your service expects:
- `istio_requests_total` with workload labels
- `istio_request_duration_milliseconds_bucket` for latency percentiles

## Cleanup

```bash
kubectl delete -f .
```

## Expected Result

After 1-2 minutes, your service should start showing:
- Fetched edges between `frontend` → `backend`
- Graph nodes: 2, Edges: 1
