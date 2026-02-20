const axios = require('axios');

/**
 * Webhook Manager
 *
 * After each sync cycle (Prometheus -> Neo4j), this module pushes
 * the latest metrics snapshot and infrastructure data to all
 * registered webhook subscriber URLs.
 *
 * Subscribers are configured via WEBHOOK_URLS env var (comma-separated).
 * An optional WEBHOOK_SECRET provides HMAC-based authentication.
 */

const crypto = require('crypto');

let subscriberUrls = [];
let webhookSecret = '';
let webhookTimeoutMs = 10000;
let retryMaxAttempts = 5;
let retryBaseDelayMs = 250;
let retryMaxDelayMs = 5000;

const stats = {
    totalEvents: 0,
    attemptedDeliveries: 0,
    successfulDeliveries: 0,
    failedDeliveries: 0,
    retryAttempts: 0,
    averageDeliveryLatencyMs: 0,
    lastEventId: null,
    lastDeliveryAt: null,
    lastError: null
};

function parseIntEnv(name, fallback) {
    const raw = process.env[name];
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildUUID() {
    if (typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return crypto.randomBytes(16).toString('hex');
}

function buildEventID(payloadData) {
    const dataHash = crypto
        .createHash('sha256')
        .update(JSON.stringify(payloadData))
        .digest('hex')
        .slice(0, 12);
    return `evt_${Date.now()}_${dataHash}`;
}

function init() {
    const raw = process.env.WEBHOOK_URLS || '';
    subscriberUrls = raw
        .split(',')
        .map(u => u.trim())
        .filter(u => u.length > 0);

    webhookSecret = process.env.WEBHOOK_SECRET || '';
    webhookTimeoutMs = parseIntEnv('WEBHOOK_TIMEOUT_MS', 10000);
    retryMaxAttempts = parseIntEnv('WEBHOOK_RETRY_MAX_ATTEMPTS', 5);
    retryBaseDelayMs = parseIntEnv('WEBHOOK_RETRY_BASE_DELAY_MS', 250);
    retryMaxDelayMs = parseIntEnv('WEBHOOK_RETRY_MAX_DELAY_MS', 5000);

    if (subscriberUrls.length > 0) {
        console.log(`[Webhook] Initialized with ${subscriberUrls.length} subscriber(s):`);
        subscriberUrls.forEach(u => console.log(`  -> ${u}`));
    } else {
        console.log('[Webhook] No subscribers configured (set WEBHOOK_URLS to enable)');
    }
}

/**
 * Generate HMAC signature for webhook payload.
 * Transition-safe:
 * - If timestampHeader is present, sign `${timestampHeader}.${rawBody}`.
 * - Otherwise, sign `rawBody` (legacy behavior).
 */
function signPayload(payload, timestampHeader) {
    if (!webhookSecret) return '';
    const rawBody = JSON.stringify(payload);
    const hmac = crypto.createHmac('sha256', webhookSecret);
    if (timestampHeader) {
        hmac.update(`${timestampHeader}.${rawBody}`);
    } else {
        hmac.update(rawBody);
    }
    return hmac.digest('hex');
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableStatus(statusCode) {
    return statusCode === 429 || (statusCode >= 500 && statusCode <= 599);
}

function isRetryableNetworkError(error) {
    const code = error?.code || '';
    return (
        code === 'ECONNABORTED' ||
        code === 'ECONNRESET' ||
        code === 'ECONNREFUSED' ||
        code === 'ETIMEDOUT' ||
        code === 'EHOSTUNREACH' ||
        code === 'EAI_AGAIN' ||
        code === 'ENOTFOUND' ||
        code === 'ERR_NETWORK'
    );
}

function computeBackoffMs(attemptNumber) {
    // attemptNumber is 1-based and only used for retries.
    const expDelay = Math.min(retryMaxDelayMs, retryBaseDelayMs * Math.pow(2, attemptNumber - 1));
    const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(expDelay * 0.25)));
    return expDelay + jitter;
}

function updateLatencyStats(latencyMs) {
    const n = stats.successfulDeliveries;
    if (n <= 1) {
        stats.averageDeliveryLatencyMs = latencyMs;
        return;
    }
    const prevWeight = n - 1;
    stats.averageDeliveryLatencyMs = Math.round(
        (stats.averageDeliveryLatencyMs * prevWeight + latencyMs) / n
    );
}

async function deliverWithRetry(url, payload, headers) {
    let lastFailure = null;
    const startedAt = Date.now();

    for (let attempt = 1; attempt <= retryMaxAttempts; attempt++) {
        stats.attemptedDeliveries += 1;
        try {
            const response = await axios.post(url, payload, {
                headers,
                timeout: webhookTimeoutMs,
                validateStatus: () => true
            });

            if (response.status >= 200 && response.status < 300) {
                stats.successfulDeliveries += 1;
                stats.lastDeliveryAt = new Date().toISOString();
                updateLatencyStats(Date.now() - startedAt);
                return response.status;
            }

            const retryable = isRetryableStatus(response.status);
            lastFailure = new Error(`HTTP ${response.status}`);
            if (!retryable || attempt >= retryMaxAttempts) {
                throw lastFailure;
            }
        } catch (error) {
            const retryableNetwork = isRetryableNetworkError(error);
            if (!retryableNetwork && !(error?.message || '').startsWith('HTTP 5') && !(error?.message || '').startsWith('HTTP 429')) {
                throw error;
            }
            lastFailure = error;
            if (attempt >= retryMaxAttempts) {
                throw error;
            }
        }

        stats.retryAttempts += 1;
        const delayMs = computeBackoffMs(attempt);
        console.warn(`[Webhook] Retry ${attempt}/${retryMaxAttempts - 1} for ${url} in ${delayMs}ms`);
        await sleep(delayMs);
    }

    throw lastFailure || new Error('Unknown webhook delivery failure');
}

/**
 * Notify all subscribers with the latest graph data.
 * Called after each successful sync cycle.
 *
 * @param {Object} data - { metricsSnapshot, services, infrastructure, centrality }
 */
async function notifySubscribers(data) {
    if (subscriberUrls.length === 0) return;

    const sentAt = new Date().toISOString();
    const timestampHeader = String(Math.floor(Date.parse(sentAt) / 1000));
    const correlationId = buildUUID();
    const eventId = buildEventID(data);

    const payload = {
        event: 'graph_update',
        timestamp: sentAt,
        schema_version: '1.1',
        event_id: eventId,
        correlation_id: correlationId,
        sent_at: sentAt,
        data
    };
    stats.totalEvents += 1;
    stats.lastEventId = eventId;

    const signature = signPayload(payload, timestampHeader);
    const headers = {
        'Content-Type': 'application/json',
        'X-Webhook-Event': 'graph_update',
        'X-Webhook-Id': eventId,
        'X-Correlation-Id': correlationId,
        'X-Webhook-Timestamp': timestampHeader
    };

    if (signature) {
        headers['X-Webhook-Signature'] = `sha256=${signature}`;
    }

    const results = await Promise.allSettled(
        subscriberUrls.map(url => deliverWithRetry(url, payload, headers))
    );

    results.forEach((result, idx) => {
        const target = subscriberUrls[idx];
        if (result.status === 'fulfilled') {
            console.log(
                `[Webhook] Delivered event=${eventId} target=${target} status=${result.value} correlationId=${correlationId}`
            );
            return;
        }

        stats.failedDeliveries += 1;
        stats.lastError = result.reason?.message || 'Unknown error';
        console.error(
            `[Webhook] Failed event=${eventId} target=${target} correlationId=${correlationId} error=${stats.lastError}`
        );
    });
}

/**
 * Get current subscriber list (for health/status endpoint)
 */
function getSubscribers() {
    return subscriberUrls.map(url => ({ url }));
}

function getStats() {
    return {
        ...stats,
        subscribers: subscriberUrls.length
    };
}

module.exports = { init, notifySubscribers, getSubscribers, getStats };
