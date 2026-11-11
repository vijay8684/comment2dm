// src/services/metaRateLimiter.js
// Meta Instagram Graph API Rate Limiting, Header Telemetry & Error Classification Engine
//
// ── RATE LIMIT SCOPE & ARCHITECTURE DOCUMENTATION ──────────────────────────────
// 1. Process-Local (In-Memory Controls):
//    - globalLastRequestTime / GLOBAL_MAX_RPS (20 req/s): Leaky bucket pacing outbound HTTP
//      calls strictly within this Node.js instance to avoid local port/CPU starvation.
//    - accountPacingMap / ACCOUNT_MAX_RPS (5 req/s): Leaky bucket pacing per-account requests
//      within this Node.js process.
//
// 2. Shared Across Instances (MongoDB-Backed Rate Limiting):
//    - account_rate_limits collection: When an account receives a Meta HTTP 429, Retry-After,
//      or X-Business-Use-Case-Usage 100% throttling header, the pause expiration timestamp
//      is persisted to MongoDB with a TTL index on `paused_until`.
//    - All worker instances check `isAccountPausedAsync()` prior to dispatching outbound calls.
//    - To avoid pounding MongoDB on every request tick, a short-lived in-memory cache
//      (`sharedPauseCache`, 2000ms TTL) caches negative lookups while honoring active pauses.
//    - When the persistent worker polls for jobs (`claimNextJob()`), actively paused accounts
//      are dynamically excluded from the claim query so unpaused accounts are never blocked.
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
const sharedPauseCache = new Map(); // accountId -> { pausedUntilMs: number, lastCheckedAtMs: number }
const SHARED_PAUSE_CACHE_TTL_MS = 2000; // 2s cache for MongoDB pause lookups

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

  // 1. Rate Limited (Retryable with backoff & Retry-After)
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

  // 2. Messaging Window Policy Restriction (Permanent: User must interact first)
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

  // 3. Permanent Permission or Authentication Error (Never auto-retry)
  const isAuthError = status === 401 ||
    status === 403 ||
    code === 190 || // Invalid OAuth access token / expired
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

  // 4. Invalid or Unavailable Recipient (Permanent: Cannot message user)
  const isInvalidRecipient = code === 551 || // User not available / cannot message
    subcode === 2018001 || // Cannot message user
    code === 803 || // Recipient does not exist
    message.includes('cannot message') ||
    message.includes('not available') ||
    message.includes('blocked');

  if (isInvalidRecipient) {
    return {
      category: 'INVALID_RECIPIENT',
      retryable: false,
      backoffMs: 0,
      reason: sanitizeString(err?.message || 'Instagram user is unavailable or cannot receive messages.')
    };
  }

  // 5. Invalid Request / Bad Parameter (Permanent: Client payload error)
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

  // 6. Unknown Outcome (Network timeout or socket hangup after request was dispatched)
  // CRITICAL: If the request was in flight, Meta may have already delivered the message!
  // Never automatically resend an uncertain delivery!
  const isUnknown = err?.uncertainDelivery === true ||
    err?.requestDispatched === true ||
    message.includes('network timeout') ||
    message.includes('socket hang up') ||
    message.includes('esockettimedout') ||
    status === 504;

  if (isUnknown) {
    return {
      category: 'UNKNOWN_OUTCOME',
      retryable: false, // Never automatically retry uncertain outcomes
      backoffMs: 0,
      reason: sanitizeString(err?.message || 'Network timeout or socket drop after request dispatch; delivery outcome unknown.')
    };
  }

  // 7. Temporary Network / Meta 5xx Server Error (Safe to retry only if NOT in unknown category)
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
function calculateBackoffWithJitter(attempt = 1, baseMs = BASE_BACKOFF_MS) {
  const factor = Math.min(Math.pow(2, Math.max(0, attempt - 1)), 32);
  const backoff = Math.min(baseMs * factor, MAX_BACKOFF_MS);
  const jitter = crypto.randomInt(0, JITTER_MS + 1);
  return backoff + jitter;
}

/**
 * Inspects HTTP response headers from Meta for rate limiting and app usage indicators.
 *
 * @param {object|Headers} headers - Response headers
 * @param {string} [instagramAccountId] - Account ID being operated on
 * @param {object} [db] - Database module
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
 * Checks if a specific account is currently paused due to rate limiting.
 * Asynchronously verifies MongoDB state with a 2-second in-memory cache to prevent excessive DB traffic.
 *
 * @param {string} instagramAccountId - Account ID
 * @param {object} [db] - Database module
 * @returns {Promise<boolean>}
 */
async function isAccountPausedAsync(instagramAccountId, db = null) {
  const now = Date.now();
  if (globalRateLimitPauseUntil > now) return true;
  if (!instagramAccountId) return false;

  // 1. Check in-memory local map first (fastest path)
  const localExpiry = accountPausedUntil.get(instagramAccountId);
  if (localExpiry && localExpiry > now) return true;

  // 2. Check short-lived cache of MongoDB state
  const cached = sharedPauseCache.get(instagramAccountId);
  if (cached && (now - cached.lastCheckedAtMs) < SHARED_PAUSE_CACHE_TTL_MS) {
    return cached.pausedUntilMs > now;
  }

  // 3. Query MongoDB account_rate_limits collection if available
  if (db && db.collections && db.collections().accountRateLimits) {
    try {
      const record = await db.collections().accountRateLimits.findOne({ account_id: instagramAccountId });
      if (record && record.paused_until) {
        const pausedUntilMs = new Date(record.paused_until).getTime();
        sharedPauseCache.set(instagramAccountId, { pausedUntilMs, lastCheckedAtMs: now });
        if (pausedUntilMs > now) {
          accountPausedUntil.set(instagramAccountId, pausedUntilMs);
          return true;
        }
      } else {
        sharedPauseCache.set(instagramAccountId, { pausedUntilMs: 0, lastCheckedAtMs: now });
      }
    } catch (err) {
      // Safe fallback to local state if db query fails
    }
  }

  return false;
}

/**
 * Synchronous check for process-local pause state.
 *
 * @param {string} instagramAccountId - Account ID
 * @returns {boolean}
 */
function isAccountPaused(instagramAccountId) {
  const now = Date.now();
  if (globalRateLimitPauseUntil > now) return true;
  if (!instagramAccountId) return false;

  const localExpiry = accountPausedUntil.get(instagramAccountId);
  if (localExpiry && localExpiry > now) return true;

  const cached = sharedPauseCache.get(instagramAccountId);
  if (cached && cached.pausedUntilMs > now) return true;

  return false;
}

/**
 * Coordinates request pacing for both global rate limits and per-account rate limits.
 * Checks shared MongoDB pause state before pacing.
 *
 * @param {string} [instagramAccountId] - Target Instagram Account ID
 * @param {object} [db] - Database module
 * @returns {Promise<void>}
 */
async function paceRequest(instagramAccountId, db = null) {
  const now = Date.now();

  // 1. Check Global Pause
  if (globalRateLimitPauseUntil > now) {
    const waitTime = globalRateLimitPauseUntil - now;
    console.warn(`[META PACER] Global rate limit pause active. Waiting ${waitTime}ms...`);
    await new Promise(r => setTimeout(r, waitTime));
  }

  // 2. Check Shared Account Pause (checks MongoDB + local cache)
  if (instagramAccountId) {
    const isPaused = await isAccountPausedAsync(instagramAccountId, db);
    if (isPaused) {
      const expiry = Math.max(
        accountPausedUntil.get(instagramAccountId) || 0,
        sharedPauseCache.get(instagramAccountId)?.pausedUntilMs || 0
      );
      const waitTime = Math.max(0, expiry - Date.now());
      if (waitTime > 0) {
        console.warn(`[META PACER] Account ${instagramAccountId} shared pause active. Waiting ${waitTime}ms...`);
        await new Promise(r => setTimeout(r, waitTime));
      }
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
 * Manually pauses an account (e.g. after receiving a 429).
 * Updates fast in-memory map and persists to MongoDB for multi-instance sync.
 *
 * @param {string} instagramAccountId - Account ID
 * @param {number} durationMs - Pause duration in milliseconds
 * @param {string} [reason] - Reason for pause
 * @param {object} [db] - Optional db module
 */
function pauseAccount(instagramAccountId, durationMs = 30000, reason = 'rate_limit', db = null) {
  if (!instagramAccountId) return;
  const now = Date.now();
  const pauseUntil = now + durationMs;
  accountPausedUntil.set(instagramAccountId, pauseUntil);
  sharedPauseCache.set(instagramAccountId, { pausedUntilMs: pauseUntil, lastCheckedAtMs: now });
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
  sharedPauseCache.clear();
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
  isAccountPausedAsync,
  pauseAccount,
  getRateLimitEventsCount: () => rateLimitEventsCount,
  _resetForTesting
};
