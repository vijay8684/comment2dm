// src/jobs/webhookWorker.js
// Persistent Background Worker, Concurrency Pool & Fair Scheduling Engine

const crypto = require('crypto');
const webhookJobQueue = require('./webhookJobQueue');
const metaRateLimiter = require('../services/metaRateLimiter');

let isWorkerRunning = false;
let isPolling = false;
let pollTimer = null;
let activeJobCount = 0;
const activeJobsByAccount = new Map(); // instagramAccountId -> count
const activeHeartbeats = new Map();    // jobId -> interval timer

let workerId = `worker_${process.pid}_${crypto.randomBytes(3).toString('hex')}`;
let lastHeartbeatTime = null;
let totalProcessedCount = 0;
let totalFailedCount = 0;

/**
 * Starts the persistent background queue worker.
 *
 * @param {object} db - Database module instance
 * @param {Function} jobExecutor - Async function(job) that processes a single webhook job
 * @param {object} [options] - Optional overrides (pollIntervalMs, concurrency, etc.)
 */
function startWorker(db, jobExecutor, options = {}) {
  if (isWorkerRunning) {
    console.log(`[WORKER] Worker ${workerId} is already running.`);
    return;
  }

  if (typeof jobExecutor !== 'function') {
    throw new Error('webhookWorker.startWorker requires a valid jobExecutor function.');
  }

  isWorkerRunning = true;
  lastHeartbeatTime = new Date().toISOString();
  const pollInterval = Number(options.pollIntervalMs) || webhookJobQueue.WORKER_POLL_INTERVAL_MS;

  console.log(`[WORKER] Starting persistent webhook worker (${workerId}). Concurrency: ${webhookJobQueue.WORKER_CONCURRENCY}, Account Concurrency: ${webhookJobQueue.ACCOUNT_CONCURRENCY}, Poll Interval: ${pollInterval}ms`);

  async function pollLoop() {
    if (!isWorkerRunning) return;
    lastHeartbeatTime = new Date().toISOString();

    if (isPolling) {
      scheduleNextPoll();
      return;
    }

    isPolling = true;

    try {
      while (isWorkerRunning && activeJobCount < webhookJobQueue.WORKER_CONCURRENCY) {
        // Build exclusion list for accounts at capacity or currently paused
        const excludedAccounts = [];
        for (const [accId, count] of activeJobsByAccount.entries()) {
          if (count >= webhookJobQueue.ACCOUNT_CONCURRENCY || metaRateLimiter.isAccountPaused(accId)) {
            excludedAccounts.push(accId);
          }
        }

        const job = await webhookJobQueue.claimNextJob(db, {
          workerId,
          leaseMs: webhookJobQueue.JOB_LEASE_MS,
          excludedAccountIds: excludedAccounts
        });

        if (!job) {
          // No more eligible jobs in this cycle
          break;
        }

        // Increment active concurrency counters
        activeJobCount++;
        const accId = job.instagram_account_id || 'unknown';
        activeJobsByAccount.set(accId, (activeJobsByAccount.get(accId) || 0) + 1);

        // Dispatch job asynchronously within the concurrency pool
        processClaimedJob(job, jobExecutor, db).finally(() => {
          activeJobCount = Math.max(0, activeJobCount - 1);
          const currentAccCount = activeJobsByAccount.get(accId) || 1;
          if (currentAccCount <= 1) {
            activeJobsByAccount.delete(accId);
          } else {
            activeJobsByAccount.set(accId, currentAccCount - 1);
          }

          // Trigger immediate refill if worker has capacity
          if (isWorkerRunning && activeJobCount < webhookJobQueue.WORKER_CONCURRENCY) {
            setImmediate(pollLoop);
          }
        });
      }
    } catch (err) {
      console.error('[WORKER ERROR] Unexpected error during claim cycle:', err.message);
    } finally {
      isPolling = false;
      scheduleNextPoll();
    }
  }

  function scheduleNextPoll() {
    if (!isWorkerRunning) return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(pollLoop, pollInterval);
  }

  // Initial trigger
  setImmediate(pollLoop);
}

/**
 * Executes a claimed job with lease heartbeat, pacing, and classified error handling.
 */
async function processClaimedJob(job, jobExecutor, db) {
  const jobId = job.event_key || job.job_id;
  const accId = job.instagram_account_id;

  // Setup Lease Heartbeat (extends lease every half lease duration)
  const heartbeatIntervalMs = Math.max(10000, Math.floor(webhookJobQueue.JOB_LEASE_MS / 2));
  const heartbeatTimer = setInterval(async () => {
    try {
      const ok = await webhookJobQueue.extendLease(job, workerId, webhookJobQueue.JOB_LEASE_MS, db);
      if (!ok) {
        console.warn(`[WORKER HEARTBEAT] Lease for job ${jobId} expired or claimed by another worker.`);
      }
    } catch (err) {
      console.warn(`[WORKER HEARTBEAT] Failed to extend lease for job ${jobId}:`, err.message);
    }
  }, heartbeatIntervalMs);
  activeHeartbeats.set(jobId, heartbeatTimer);

  try {
    // 1. Pacing Guard: respects global and account rate limits before calling Meta
    await metaRateLimiter.paceRequest(accId);

    // 2. Execute business logic
    await jobExecutor(job);

    // 3. Mark success with explicit worker_id ownership
    await webhookJobQueue.handleJobSuccess(job, { worker_id: workerId }, db);
    totalProcessedCount++;
  } catch (err) {
    console.error(`[WORKER] Job ${jobId} failed attempt ${job.attempts || 1}:`, metaRateLimiter.sanitizeString(err.message));
    totalFailedCount++;
    await webhookJobQueue.handleJobFailure(job, err, db);
  } finally {
    clearInterval(heartbeatTimer);
    activeHeartbeats.delete(jobId);
  }
}

/**
 * Stops the worker cleanly (drain in-flight tasks).
 * Allows active jobs to finish within grace period with active heartbeats.
 *
 * @param {number} [timeoutMs=15000] - Grace period for in-flight tasks to finish
 * @returns {Promise<void>}
 */
async function stopWorker(timeoutMs = 15000) {
  if (!isWorkerRunning) return;
  console.log(`[WORKER] Stopping worker ${workerId}... Draining ${activeJobCount} in-flight jobs.`);
  isWorkerRunning = false;

  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  // Grace period: Wait for in-flight jobs to complete while keeping their heartbeats active!
  const start = Date.now();
  while (activeJobCount > 0 && (Date.now() - start) < timeoutMs) {
    await new Promise(r => setTimeout(r, 100));
  }

  // Clean up any remaining heartbeat timers after draining
  for (const timer of activeHeartbeats.values()) {
    clearInterval(timer);
  }
  activeHeartbeats.clear();

  if (activeJobCount > 0) {
    console.warn(`[WORKER SHUTDOWN] Force exiting with ${activeJobCount} in-flight jobs still running. Their leases will safely expire and be recovered by another worker.`);
  } else {
    console.log(`[WORKER] Worker ${workerId} stopped cleanly. All jobs drained.`);
  }
}

/**
 * Returns current worker telemetry.
 */
function getWorkerStatus() {
  return {
    worker_id: workerId,
    is_running: isWorkerRunning,
    active_jobs: activeJobCount,
    active_by_account: Object.fromEntries(activeJobsByAccount.entries()),
    last_heartbeat: lastHeartbeatTime,
    total_processed: totalProcessedCount,
    total_failed: totalFailedCount
  };
}

/**
 * For testing: resets worker state.
 */
function _resetWorkerForTesting() {
  isWorkerRunning = false;
  isPolling = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  for (const timer of activeHeartbeats.values()) {
    clearInterval(timer);
  }
  activeHeartbeats.clear();
  activeJobCount = 0;
  activeJobsByAccount.clear();
  totalProcessedCount = 0;
  totalFailedCount = 0;
}

module.exports = {
  startWorker,
  stopWorker,
  getWorkerStatus,
  _resetWorkerForTesting
};
