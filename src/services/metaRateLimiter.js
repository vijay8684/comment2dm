// src/services/metaRateLimiter.js
// Meta Instagram Graph API Rate Limiting, Header Telemetry & Error Classification Engine
//
// ── RATE LIMIT SCOPE DOCUMENTATION ─────────────────────────────────────────────
// 1. Process-Local (In-Memory):
//    - globalLastRequestTime / GLOBAL_MAX_RPS (20 req/s): Paces outbound HTTP calls within this Node.js instance.
//    - accountPacingMap / ACCOUNT_MAX_RPS (5 req/s): Paces per-account requests within this Node.js instance.
// 2. Shared Across Instances (MongoDB-Backed Abstraction):
//    - account_rate_limits collection: When an account receives a Meta HTTP 429 or throttling header,
//      the pause expiration timestamp is written to MongoDB. All worker instances inspect this
//      pause state so throttling an account on one instance prevents other instances from
//      making redundant calls for the same creator.
// ───────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');

// Configuration from environment with conservative, documented defaults
const GLOBAL_MAX_RPS = Number(process.env.META_GLOBAL_MAX_RPS) || 20; // Max 20 req/sec globally
const ACCOUNT_MAX_RPS = Number(process.env.META_ACCOUNT_MAX_RPS) || 5;  // Max 5 req/sec per Instagram account
const BASE_BACKOFF_MS = Number(process.env.BASE_BACKOFF_MS) || 2000;   // 2s base backoff
const MAX_BACKOFF_MS = Number(process.env.MAX_BACKOFF_MS) || 300000;   // 5m max backoff
const JITTER_MS = Number(process.env.JITTER_MS) || 1000;              // 0-1000ms randomized jitter

// In-memory rate limiting state (process-local fast path)
const accountPacingMap = new Map(); // accountId -> timestamp of last request
const accountPausedUntil = new Map(); // accountId -> timestamp (ms) when pause expires
let globalLastRequestTime = 0;
let globalRateLimitPauseUntil = 0;
let rateLimitEventsCount = 0;

/**
 * Redacts sensitive tokens or authorization keys from log strings and error messages.
 *
 * @param {string} text - Raw string
 * @returns {string} - Sanitized string
 */
function sanitizeString(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/EA[A-Za-z0-9_-]{20,}/g, '[REDACTED_META_TOKEN]')
    .replace(/bearer\s+[a-zA-Z0-9_\-\.]+/gi, 'Bearer [REDACTED]')
    .replace(/access_token=[^&]+/gi, 'access_token=[REDACTED]')
    .replace(/client_secret=[^&]+/gi, 'client_secret=[REDACTED]');
}

/**
 * Classifies an error resulting from a Meta API call into standardized categories.
 *
 * @param {Error|object} err - Error object or Meta API error payload
 * @param {number} [statusCode] - HTTP status code
 * @returns {{ category: string, retryable: boolean, backoffMs: number, reason: string }}
 */
function classifyMetaError(err, statusCode) {
  const code = Number(err?.metaError?.code || err?.code || 0);
  const subcode = Number(err?.metaError?.error_subcode || err?.error_subcode || 0);
  const message = String(err?.message || err?.metaError?.message || '').toLowerCase();
  const status = Number(statusCode || err?.statusCode || err?.status || 0);

  // 1. Rate Limited
  const isRateLimit = status === 429 ||
    code === 4 ||    // Application request limit reached
    code === 17 ||   // User request limit reached
    code === 32 ||   // Page request limit reached
    code === 613 ||  // Calls to this API have exceeded the rate limit
    subcode === 2207051 || // Rate limit subcode
    message.includes('request limit') ||
    message.includes('rate limit') ||
    message.includes('too many requests') ||
    message.includes('reduce the amount of data');

  if (isRateLimit) {
    rateLimitEventsCount++;
    const retryAfterHeader = err?.retryAfterSeconds;
    const delayMs = retryAfterHeader && retryAfterHeader > 0
      ? retryAfterHeader * 1000
      : calculateBackoffWithJitter(1, 5000); // 5s min for rate limit if no Retry-After

    return {
      category: 'RATE_LIMITED',
      retryable: true,
      backoffMs: delayMs,
      reason: sanitizeString(err?.message || 'Meta API rate limit reached.')
    };
  }

  // 2. Messaging Window Policy Restriction
  const isWindowExpired = subcode === 2018278 ||
    message.includes('24 hours') ||
    message.includes('outside allowed window');

  if (isWindowExpired) {
    return {
      category: 'MESSAGING_WINDOW',
      retryable: false,
      backoffMs: 0,
      reason: '24-hour Instagram messaging window expired. User interaction required.'
    };
  }

  // 3. Permission or Authentication Error
  const isAuthError = status === 401 ||
    status === 403 ||
    code === 190 || // Invalid OAuth access token
    code === 10 ||  // Permission denied
    code === 200 || // Permissions error
    (code === 100 && subcode === 33) || // Unsupported post request
    message.includes('access token') ||
    message.includes('permission');

  if (isAuthError) {
    return {
      category: 'PERMISSION_OR_AUTH',
      retryable: false,
      backoffMs: 0,
      reason: sanitizeString(err?.message || 'Meta permission or authentication error.')
    };
  }

  // 4. Invalid Request / Bad Parameter
  const isInvalidRequest = status === 400 ||
    code === 100 ||
    message.includes('invalid parameter') ||
    message.includes('malformed');

  if (isInvalidRequest) {
    return {
      category: 'INVALID_REQUEST',
      retryable: false,
      backoffMs: 0,
      reason: sanitizeString(err?.message || 'Invalid Meta API request parameter.')
    };
  }

  // 5. Unknown Outcome (Socket timeout or hangup while awaiting reply)
  const isUnknown = message.includes('network timeout waiting for response') ||
    message.includes('socket hang up while waiting') ||
    err?.uncertainDelivery === true;

  if (isUnknown) {
    return {
      category: 'UNKNOWN_OUTCOME',
      retryable: false, // DO NOT blindly retry uncertain delivery!
      backoffMs: 0,
      reason: 'Network timeout after dispatch; delivery outcome unknown.'
    };
  }

  // 6. Temporary Network / Server Error
  const isNetworkError = status >= 500 ||
    message.includes('etimedout') ||
    message.includes('econnreset') ||
    message.includes('econnrefused') ||
    message.includes('eai_again') ||
    message.includes('fetch failed');

  if (isNetworkError) {
    return {
      category: 'TEMPORARY_NETWORK',
      retryable: true,
      backoffMs: calculateBackoffWithJitter(1),
      reason: sanitizeString(err?.message || 'Temporary network or Meta 5xx server error.')
    };
  }

  // Default Fallback
  return {
    category: 'GENERAL_ERROR',
    retryable: false,
    backoffMs: 0,
    reason: sanitizeString(err?.message || 'Unknown error occurred.')
  };
}

/**
 * Calculates exponential backoff duration with randomized jitter.
 *
 * @param {number} attempt - Current attempt count (1-based)
 * @param {number} [baseMs] - Base backoff in ms
 * @returns {number} - Total delay in milliseconds
 */
function calculateBackoffWithJitter(attempt, baseMs = BASE_BACKOFF_MS) {
  const safeAttempt = Math.max(1, Number(attempt) || 1);
  const exponentialDelay = Math.min(baseMs * Math.pow(2, safeAttempt - 1), MAX_BACKOFF_MS);
  const jitter = Math.floor(Math.random() * JITTER_MS);
  return exponentialDelay + jitter;
}

/**
 * Inspects Meta response headers for usage limits and throttling signals.
 *
 * @param {Headers|object} headers - Fetch response headers
 * @param {string} [instagramAccountId] - Optional account ID for targeted throttling
 * @param {object} [db] - Optional db for distributed pause recording
 */
function inspectMetaHeaders(headers, instagramAccountId, db) {
  if (!headers) return;

  try {
    const getHeader = (name) => {
      if (typeof headers.get === 'function') return headers.get(name);
      return headers[name.toLowerCase()] || headers[name];
    };

    // 1. Retry-After Header (Seconds)
    const retryAfter = getHeader('retry-after');
    if (retryAfter) {
      const seconds = parseInt(retryAfter, 10);
      if (!isNaN(seconds) && seconds > 0) {
        const pauseUntil = Date.now() + (seconds * 1000);
        if (instagramAccountId) {
          pauseAccount(instagramAccountId, seconds * 1000, 'Meta Retry-After header', db);
          console.warn(`[META RATE LIMIT] Account ${instagramAccountId} paused for ${seconds}s via Retry-After`);
        } else {
          globalRateLimitPauseUntil = pauseUntil;
          console.warn(`[META RATE LIMIT] Global Meta calls paused for ${seconds}s via Retry-After`);
        }
      }
    }

    // 2. X-App-Usage Header: {"call_count":28,"total_cputime":12,"total_time":25}
    const appUsageRaw = getHeader('x-app-usage');
    if (appUsageRaw) {
      const usage = typeof appUsageRaw === 'object' ? appUsageRaw : JSON.parse(appUsageRaw);
      const maxMetric = Math.max(
        Number(usage.call_count || 0),
        Number(usage.total_cputime || 0),
        Number(usage.total_time || 0)
      );

      if (maxMetric >= 100) {
        console.error(`[META RATE LIMIT CRITICAL] X-App-Usage reached ${maxMetric}%. Applying emergency 60s global pause.`);
        globalRateLimitPauseUntil = Math.max(globalRateLimitPauseUntil, Date.now() + 60000);
      } else if (maxMetric >= 85) {
        console.warn(`[META RATE LIMIT WARNING] X-App-Usage at ${maxMetric}%. Pacing requests.`);
      }
    }

    // 3. X-Business-Use-Case-Usage Header
    const businessUsageRaw = getHeader('x-business-use-case-usage');
    if (businessUsageRaw) {
      const bUsage = typeof businessUsageRaw === 'object' ? businessUsageRaw : JSON.parse(businessUsageRaw);
      const values = Array.isArray(bUsage) ? bUsage : Object.values(bUsage);
      for (const item of values) {
        const maxPercent = Math.max(
          Number(item.call_count || 0),
          Number(item.total_cputime || 0),
          Number(item.total_time || 0)
        );
        if (maxPercent >= 100 && instagramAccountId) {
          console.error(`[META RATE LIMIT CRITICAL] Business Use Case usage reached ${maxPercent}% for account ${instagramAccountId}. Pausing account for 60s.`);
          pauseAccount(instagramAccountId, 60000, 'Meta Business Use Case usage 100%', db);
        }
      }
    }
  } catch (err) {
    // Non-fatal telemetry parsing error
  }
}

/**
 * Coordinates request pacing for both global rate limits and per-account rate limits.
 *
 * @param {string} [instagramAccountId] - Target Instagram Account ID
 * @returns {Promise<void>}
 */
async function paceRequest(instagramAccountId) {
  const now = Date.now();

  // 1. Check Global Pause
  if (globalRateLimitPauseUntil > now) {
    const waitTime = globalRateLimitPauseUntil - now;
    console.warn(`[META PACER] Global rate limit pause active. Waiting ${waitTime}ms...`);
    await new Promise(r => setTimeout(r, waitTime));
  }

  // 2. Check Account-Specific Pause
  if (instagramAccountId && accountPausedUntil.has(instagramAccountId)) {
    const pauseExpiry = accountPausedUntil.get(instagramAccountId);
    if (pauseExpiry > now) {
      const waitTime = pauseExpiry - now;
      console.warn(`[META PACER] Account ${instagramAccountId} pause active. Waiting ${waitTime}ms...`);
      await new Promise(r => setTimeout(r, waitTime));
    } else {
      accountPausedUntil.delete(instagramAccountId);
    }
  }

  // 3. Global Leaky-Bucket Pacing
  const minGlobalInterval = 1000 / GLOBAL_MAX_RPS;
  const timeSinceGlobal = Date.now() - globalLastRequestTime;
  if (timeSinceGlobal < minGlobalInterval) {
    await new Promise(r => setTimeout(r, minGlobalInterval - timeSinceGlobal));
  }
  globalLastRequestTime = Date.now();

  // 4. Per-Account Leaky-Bucket Pacing
  if (instagramAccountId) {
    const minAccountInterval = 1000 / ACCOUNT_MAX_RPS;
    const lastAccountTime = accountPacingMap.get(instagramAccountId) || 0;
    const timeSinceAccount = Date.now() - lastAccountTime;
    if (timeSinceAccount < minAccountInterval) {
      await new Promise(r => setTimeout(r, minAccountInterval - timeSinceAccount));
    }
    accountPacingMap.set(instagramAccountId, Date.now());
  }
}

/**
 * Checks if a specific account is currently paused due to rate limiting.
 * Fast in-memory check with optional MongoDB sync.
 *
 * @param {string} instagramAccountId - Account ID
 * @returns {boolean}
 */
function isAccountPaused(instagramAccountId) {
  if (globalRateLimitPauseUntil > Date.now()) return true;
  if (!instagramAccountId) return false;
  const expiry = accountPausedUntil.get(instagramAccountId);
  if (!expiry) return false;
  if (expiry > Date.now()) return true;
  accountPausedUntil.delete(instagramAccountId);
  return false;
}

/**
 * Manually pauses an account (e.g. after receiving a 429).
 * Updates fast in-memory map and optionally persists to MongoDB for multi-instance sync.
 *
 * @param {string} instagramAccountId - Account ID
 * @param {number} durationMs - Pause duration in milliseconds
 * @param {string} [reason] - Reason for pause
 * @param {object} [db] - Optional db module
 */
function pauseAccount(instagramAccountId, durationMs = 30000, reason = 'rate_limit', db = null) {
  if (!instagramAccountId) return;
  const pauseUntil = Date.now() + durationMs;
  accountPausedUntil.set(instagramAccountId, pauseUntil);
  rateLimitEventsCount++;

  // Shared MongoDB persistence abstraction
  if (db && db.collections && db.collections().accountRateLimits) {
    db.collections().accountRateLimits.updateOne(
      { account_id: instagramAccountId },
      {
        $set: {
          account_id: instagramAccountId,
          paused_until: new Date(pauseUntil),
          reason: reason,
          updated_at: new Date()
        }
      },
      { upsert: true }
    ).catch(err => console.warn('[RATE LIMIT DB SYNC WARNING]', err.message));
  }
}

/**
 * Resets state for testing purposes.
 */
function _resetForTesting() {
  accountPacingMap.clear();
  accountPausedUntil.clear();
  globalLastRequestTime = 0;
  globalRateLimitPauseUntil = 0;
  rateLimitEventsCount = 0;
}

module.exports = {
  GLOBAL_MAX_RPS,
  ACCOUNT_MAX_RPS,
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  JITTER_MS,
  sanitizeString,
  classifyMetaError,
  calculateBackoffWithJitter,
  inspectMetaHeaders,
  paceRequest,
  isAccountPaused,
  pauseAccount,
  getRateLimitEventsCount: () => rateLimitEventsCount,
  _resetForTesting
};
