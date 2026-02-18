const axios = require('axios');

/**
 * Webhook Manager
 * 
 * After each sync cycle (Prometheus → Neo4j), this module pushes
 * the latest metrics snapshot and infrastructure data to all
 * registered webhook subscriber URLs.
 * 
 * Subscribers are configured via WEBHOOK_URLS env var (comma-separated).
 * An optional WEBHOOK_SECRET provides HMAC-based authentication.
 */

const crypto = require('crypto');

let subscriberUrls = [];
let webhookSecret = '';

function init() {
    const raw = process.env.WEBHOOK_URLS || '';
    subscriberUrls = raw
        .split(',')
        .map(u => u.trim())
        .filter(u => u.length > 0);

    webhookSecret = process.env.WEBHOOK_SECRET || '';

    if (subscriberUrls.length > 0) {
        console.log(`[Webhook] Initialized with ${subscriberUrls.length} subscriber(s):`);
        subscriberUrls.forEach(u => console.log(`  → ${u}`));
    } else {
        console.log('[Webhook] No subscribers configured (set WEBHOOK_URLS to enable)');
    }
}

/**
 * Generate HMAC signature for webhook payload
 */
function signPayload(payload) {
    if (!webhookSecret) return '';
    const hmac = crypto.createHmac('sha256', webhookSecret);
    hmac.update(JSON.stringify(payload));
    return hmac.digest('hex');
}

/**
 * Notify all subscribers with the latest graph data.
 * Called after each successful sync cycle.
 * 
 * @param {Object} data - { metricsSnapshot, services, infrastructure }
 */
async function notifySubscribers(data) {
    if (subscriberUrls.length === 0) return;

    const payload = {
        event: 'graph_update',
        timestamp: new Date().toISOString(),
        data
    };

    const signature = signPayload(payload);

    const headers = {
        'Content-Type': 'application/json',
        'X-Webhook-Event': 'graph_update',
    };

    if (signature) {
        headers['X-Webhook-Signature'] = `sha256=${signature}`;
    }

    const results = await Promise.allSettled(
        subscriberUrls.map(url =>
            axios.post(url, payload, {
                headers,
                timeout: 10000, // 10s timeout per subscriber
            })
        )
    );

    results.forEach((result, idx) => {
        if (result.status === 'fulfilled') {
            console.log(`[Webhook] ✓ Notified ${subscriberUrls[idx]} (${result.value.status})`);
        } else {
            console.error(`[Webhook] ✗ Failed to notify ${subscriberUrls[idx]}: ${result.reason.message}`);
        }
    });
}

/**
 * Get current subscriber list (for health/status endpoint)
 */
function getSubscribers() {
    return subscriberUrls.map(url => ({ url }));
}

module.exports = { init, notifySubscribers, getSubscribers };
