// src/jobs/webhookWorker.js
// Persistent Background Worker, Concurrency Pool & Fair Scheduling Engine

const crypto = require('crypto');
const webhookJobQueue = require('./webhookJobQueue');
const metaRateLimiter = require('../services/metaRateLimiter');

let isWorkerRunning = false;
let isPolling = false;
let pollingGeneration = 0;
let activePollPromise = null;
let pollTimer = null;
let pendingImmediate = null;
let activeGenContext = null;
const activeGenerations = new Map();   // gen -> genContext
const activeHeartbeats = new Map();    // `${workerId}:${jobId}` -> { timer, workerId, gen, jobId }

const baseWorkerPrefix = `worker_${process.pid}_${crypto.randomBytes(3).toString('hex')}`;
let workerId = baseWorkerPrefix;
let lastHeartbeatTime = null;
let totalProcessedCount = 0;
let totalFailedCount = 0;

// Event-driven worker wake-up coordination
let workerGeneration = 0;
let wakeUpRequested = false;
let immediatePollPending = false;
let currentPollLoop = null;
let immediatePollTriggeredCount = 0;

/**
 * Returns aggregate active job count across all running and draining worker generations.
 */
function getAggregateActiveJobCount() {
  let total = 0;
  for (const ctx of activeGenerations.values()) {
    total += (ctx.activeJobCount || 0);
  }
  return total;
}

/**
 * Returns aggregate active job count for a specific Instagram account across all generations.
 */
function getAggregateAccountJobCount(accId) {
  if (!accId) return 0;
  let total = 0;
  for (const ctx of activeGenerations.values()) {
    total += (ctx.activeJobsByAccount.get(accId) || 0);
  }
  return total;
}

/**
 * Builds list of excluded account IDs where aggregate concurrency across all generations
 * has reached ACCOUNT_CONCURRENCY, or the account is currently paused.
 */
function getAggregateExcludedAccounts() {
  const accountTotals = new Map();
  for (const ctx of activeGenerations.values()) {
    for (const [accId, count] of ctx.activeJobsByAccount.entries()) {
      accountTotals.set(accId, (accountTotals.get(accId) || 0) + count);
    }
  }

  const excluded = [];
  for (const [accId, total] of accountTotals.entries()) {
    if (total >= webhookJobQueue.ACCOUNT_CONCURRENCY || metaRateLimiter.isAccountPaused(accId)) {
      excluded.push(accId);
    }
  }
  return excluded;
}

/**
 * Triggers an immediate worker poll cycle without waiting for the next periodic poll interval.
 * Coalesces simultaneous requests and prevents overlapping poll executions.
 *
 * @returns {boolean} - True if immediate wake-up was scheduled or flagged, false if worker is stopped
 */
function triggerImmediatePoll() {
  if (!isWorkerRunning || typeof currentPollLoop !== 'function') {
    return false;
  }

  immediatePollTriggeredCount++;

  // If a claim/poll cycle is already active, record the wake-up request.
  // When the current poll finishes its work, its finally block will immediately
  // trigger another poll pass instead of sleeping for pollIntervalMs.
  if (isPolling || activePollPromise) {
    wakeUpRequested = true;
    return true;
  }

  // If an immediate poll is already pending on the event loop (setImmediate),
  // record the request and avoid enqueuing redundant setImmediate callbacks.
  if (immediatePollPending) {
    wakeUpRequested = true;
    return true;
  }

  // Worker is idle waiting for pollTimer: cancel periodic timer and poll immediately
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  immediatePollPending = true;
  const gen = workerGeneration;
  pendingImmediate = setImmediate(() => {
    immediatePollPending = false;
    pendingImmediate = null;
    if (isWorkerRunning && workerGeneration === gen && typeof currentPollLoop === 'function') {
      currentPollLoop();
    }
  });

  return true;
}

/**
 * Safely releases a claimed job back to pending if the claiming worker generation was cancelled.
 */
async function releaseClaimedJob(job, db, explicitWorkerId) {
  if (!job || !job.event_key) return;
  const isMongo = Boolean(db && db.collections && db.collections().webhookJobs);
  const targetWorkerId = explicitWorkerId || job.worker_id;
  const now = new Date();
  const updateFields = {
    status: 'queued',
    worker_id: null,
    locked_until: null,
    updated_at: now
  };
  try {
    if (isMongo) {
      const filter = { event_key: job.event_key, status: 'processing' };
      if (targetWorkerId) {
        filter.worker_id = targetWorkerId;
      }
      await db.collections().webhookJobs.updateOne(
        filter,
        {
          $set: updateFields,
          $inc: { attempts: -1 }
        }
      );
    } else if (webhookJobQueue.memoryJobsStore) {
      const existing = webhookJobQueue.memoryJobsStore.get(job.event_key);
      if (existing && existing.status === 'processing') {
        if (!targetWorkerId || existing.worker_id === targetWorkerId) {
          Object.assign(existing, updateFields);
          existing.attempts = Math.max(0, (existing.attempts || 1) - 1);
        }
      }
    }
  } catch (err) {
    console.warn(`[WORKER] Note: failed to release claimed job ${job.event_key}:`, err.message);
  }
}

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
  // Do NOT reset an active polling lock simply because a new generation starts.
  // If an older generation is still executing a database claim/poll pass, keep
  // isPolling active so the replacement worker does not begin another claim until it settles.
  if (!activePollPromise) {
    isPolling = false;
    pollingGeneration = 0;
  }
  wakeUpRequested = false;
  immediatePollPending = false;
  workerGeneration++;
  const currentGen = workerGeneration;
  const currentWorkerId = `${baseWorkerPrefix}_g${currentGen}`;
  workerId = currentWorkerId;
  lastHeartbeatTime = new Date().toISOString();
  const pollInterval = Number(options.pollIntervalMs) || webhookJobQueue.WORKER_POLL_INTERVAL_MS;

  const genContext = {
    gen: currentGen,
    workerId: currentWorkerId,
    activeJobCount: 0,
    activeJobsByAccount: new Map()
  };
  activeGenContext = genContext;
  activeGenerations.set(currentGen, genContext);

  console.log(`[WORKER] Starting persistent webhook worker (${workerId}). Concurrency: ${webhookJobQueue.WORKER_CONCURRENCY}, Account Concurrency: ${webhookJobQueue.ACCOUNT_CONCURRENCY}, Poll Interval: ${pollInterval}ms`);

  async function pollLoop() {
    if (!isWorkerRunning || workerGeneration !== currentGen) return;
    lastHeartbeatTime = new Date().toISOString();

    // Prevent overlapping worker generations from executing simultaneous database claims:
    // If an older generation's poll promise is still in-flight, await it safely.
    if (activePollPromise) {
      wakeUpRequested = true;
      try {
        await activePollPromise;
      } catch (_) {}

      // Verify that this worker generation is still running and current after awaiting the prior cycle
      if (!isWorkerRunning || workerGeneration !== currentGen) {
        return;
      }
    }

    if (isPolling) {
      wakeUpRequested = true;
      return;
    }

    isPolling = true;
    pollingGeneration = currentGen;
    wakeUpRequested = false;

    const pollExecution = (async () => {
      try {
        while (
          isWorkerRunning &&
          workerGeneration === currentGen &&
          getAggregateActiveJobCount() < webhookJobQueue.WORKER_CONCURRENCY
        ) {
          // Build exclusion list combining aggregate per-account concurrency and rate-limit pauses across generations
          const excludedAccounts = getAggregateExcludedAccounts();

          const job = await webhookJobQueue.claimNextJob(db, {
            workerId: currentWorkerId,
            leaseMs: webhookJobQueue.JOB_LEASE_MS,
            excludedAccountIds: excludedAccounts
          });

          // Check if worker was stopped or restarted while claim operation was in-flight
          if (!isWorkerRunning || workerGeneration !== currentGen) {
            if (job) {
              await releaseClaimedJob(job, db, currentWorkerId);
            }
            break;
          }

          if (!job) {
            // No more eligible jobs in this cycle
            break;
          }

          // Double check aggregate concurrency limits before dispatch
          if (
            getAggregateActiveJobCount() >= webhookJobQueue.WORKER_CONCURRENCY ||
            getAggregateAccountJobCount(job.instagram_account_id) >= webhookJobQueue.ACCOUNT_CONCURRENCY
          ) {
            await releaseClaimedJob(job, db, currentWorkerId);
            break;
          }

          // Increment active concurrency counters for THIS generation
          genContext.activeJobCount++;
          const accId = job.instagram_account_id || 'unknown';
          genContext.activeJobsByAccount.set(accId, (genContext.activeJobsByAccount.get(accId) || 0) + 1);

          // Dispatch job asynchronously within the concurrency pool
          processClaimedJob(job, jobExecutor, db, currentWorkerId, currentGen).finally(() => {
            genContext.activeJobCount = Math.max(0, genContext.activeJobCount - 1);
            const currentAccCount = genContext.activeJobsByAccount.get(accId) || 1;
            if (currentAccCount <= 1) {
              genContext.activeJobsByAccount.delete(accId);
            } else {
              genContext.activeJobsByAccount.set(accId, currentAccCount - 1);
            }

            if (genContext.activeJobCount === 0 && (!isWorkerRunning || workerGeneration !== currentGen)) {
              activeGenerations.delete(currentGen);
            }

            // Trigger immediate refill if THIS generation is still running and process has aggregate capacity
            if (isWorkerRunning && workerGeneration === currentGen && getAggregateActiveJobCount() < webhookJobQueue.WORKER_CONCURRENCY) {
              triggerImmediatePoll();
            }
          });
        }
      } catch (err) {
        console.error('[WORKER ERROR] Unexpected error during claim cycle:', err.message);
      } finally {
        // Only reset isPolling if THIS generation still owns the polling lock
        if (pollingGeneration === currentGen) {
          isPolling = false;
          pollingGeneration = 0;
        }

        // If this generation was superseded but a new generation is now running,
        // trigger an immediate poll on the replacement generation now that the lock is released.
        if (isWorkerRunning && workerGeneration !== currentGen) {
          triggerImmediatePoll();
        } else if (isWorkerRunning && workerGeneration === currentGen) {
          if (wakeUpRequested) {
            wakeUpRequested = false;
            if (pollTimer) {
              clearTimeout(pollTimer);
              pollTimer = null;
            }
            immediatePollPending = true;
            pendingImmediate = setImmediate(() => {
              immediatePollPending = false;
              pendingImmediate = null;
              if (isWorkerRunning && workerGeneration === currentGen && typeof currentPollLoop === 'function') {
                currentPollLoop();
              }
            });
          } else {
            scheduleNextPoll();
          }
        }
      }
    })();

    activePollPromise = pollExecution;
    try {
      await pollExecution;
    } finally {
      if (activePollPromise === pollExecution) {
        activePollPromise = null;
      }
    }
  }

  function scheduleNextPoll() {
    if (!isWorkerRunning || workerGeneration !== currentGen) return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(pollLoop, pollInterval);
  }

  currentPollLoop = pollLoop;

  // Initial trigger
  pendingImmediate = setImmediate(() => {
    pendingImmediate = null;
    if (isWorkerRunning && workerGeneration === currentGen && typeof currentPollLoop === 'function') {
      currentPollLoop();
    }
  });
}

/**
 * Executes a claimed job with lease heartbeat, pacing, and classified error handling.
 */
async function processClaimedJob(job, jobExecutor, db, explicitWorkerId, explicitGen) {
  const targetWorkerId = explicitWorkerId || job?.worker_id || workerId;
  const targetGen = explicitGen !== undefined ? explicitGen : workerGeneration;
  const jobId = job.event_key || job.job_id;
  const accId = job.instagram_account_id;
  const heartbeatKey = `${targetWorkerId}:${jobId}`;

  // Setup Lease Heartbeat (extends lease every half lease duration)
  const defaultHeartbeatMs = webhookJobQueue._heartbeatIntervalMsForTesting || Math.max(10000, Math.floor(webhookJobQueue.JOB_LEASE_MS / 2));
  const heartbeatIntervalMs = defaultHeartbeatMs;
  const heartbeatTimer = setInterval(async () => {
    // If this generation's heartbeat was explicitly removed (e.g. shutdown timeout or job completed):
    if (!activeHeartbeats.has(heartbeatKey)) {
      clearInterval(heartbeatTimer);
      return;
    }
    try {
      const ok = await webhookJobQueue.extendLease(job, targetWorkerId, webhookJobQueue.JOB_LEASE_MS, db);
      if (!ok) {
        console.warn(`[WORKER HEARTBEAT] Lease for job ${jobId} expired or claimed by another worker.`);
        clearInterval(heartbeatTimer);
        activeHeartbeats.delete(heartbeatKey);
      }
    } catch (err) {
      console.warn(`[WORKER HEARTBEAT] Failed to extend lease for job ${jobId}:`, err.message);
    }
  }, heartbeatIntervalMs);

  // Register heartbeat with generation-specific key
  activeHeartbeats.set(heartbeatKey, {
    timer: heartbeatTimer,
    workerId: targetWorkerId,
    gen: targetGen,
    jobId
  });

  try {
    // 1. Non-blocking Account Rate Limit Guard:
    // If account is currently paused across instances, reschedule immediately to pause expiry
    // without occupying a worker concurrency slot with a blocking sleep.
    if (accId) {
      const pauseExpiryMs = await metaRateLimiter.getAccountPauseExpiry(accId, db);
      if (pauseExpiryMs > Date.now()) {
        const pauseExpiryDate = new Date(pauseExpiryMs);
        console.log(`[WORKER NON-BLOCKING] Account ${accId} is paused until ${pauseExpiryDate.toISOString()}. Rescheduling job ${jobId} immediately without blocking worker slot.`);
        const reschedRes = await webhookJobQueue.rescheduleJobForPause(job, targetWorkerId, pauseExpiryDate, db);
        if (reschedRes && reschedRes.success === false) {
          console.warn(`[WORKER LEASE LOSS] Worker ${targetWorkerId} could not reschedule job ${jobId}: ${reschedRes.reason}`);
        }
        return; // Exits cleanly and immediately frees the worker slot
      }
    }

    // 2. Pacing Guard: respects global and account micro-pacing
    await metaRateLimiter.paceRequest(accId, db);

    // 3. Execute business logic
    const execRes = await jobExecutor(job);

    // Guard against marking skipped unknown or permanent failures as successful delivery:
    if (execRes && execRes.skipped) {
      if (execRes.status === 'unknown' || execRes.reason === 'UNKNOWN_OUTCOME') {
        const unknownErr = new Error(execRes.error || `Opening DM outcome is unknown for job ${jobId}. Never blindly resending.`);
        unknownErr.category = 'UNKNOWN_OUTCOME';
        unknownErr.retryable = false;
        unknownErr.isUnknownOutcome = true;
        throw unknownErr;
      }
      if (execRes.status === 'failed_permanent' || execRes.reason === 'FAILED_PERMANENT') {
        const permErr = new Error(execRes.error || `Opening DM delivery failed permanently for job ${jobId}.`);
        permErr.category = 'PERMISSION_OR_AUTH';
        permErr.retryable = false;
        throw permErr;
      }
      if (execRes.status === 'concurrent_claim' || execRes.reason === 'IN_PROGRESS') {
        console.log(`[WORKER] Job ${jobId} was skipped due to active concurrent worker. Releasing slot.`);
        return;
      }
    }

    // 4. Mark success with explicit targetWorkerId ownership and lease verification
    const successRes = await webhookJobQueue.handleJobSuccess(job, { worker_id: targetWorkerId }, db);
    if (!successRes || successRes === false || successRes.success === false || successRes.status === 'stale_worker') {
      console.warn(`[WORKER LEASE LOSS] Worker ${targetWorkerId} executed job ${jobId}, but lease was lost before committing success.`);
    } else {
      totalProcessedCount++;
    }
  } catch (err) {
    console.error(`[WORKER] Job ${jobId} failed attempt ${job.attempts || 1}:`, metaRateLimiter.sanitizeString(err.message));
    totalFailedCount++;
    const failRes = await webhookJobQueue.handleJobFailure({ ...job, worker_id: targetWorkerId }, err, db);
    if (failRes && (failRes.status === 'stale_worker' || failRes.success === false)) {
      console.warn(`[WORKER LEASE LOSS] Worker ${targetWorkerId} could not record failure for job ${jobId}: lease lost.`);
    }
  } finally {
    // ProcessClaimedJob clears and deletes ONLY its own generation-specific heartbeat
    clearInterval(heartbeatTimer);
    activeHeartbeats.delete(heartbeatKey);
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
  const stoppingGen = workerGeneration;
  const stoppingGenContext = activeGenContext;
  const stoppingGenWorkerId = stoppingGenContext ? stoppingGenContext.workerId : workerId;
  console.log(`[WORKER] Stopping worker ${stoppingGenWorkerId}... Draining ${stoppingGenContext ? stoppingGenContext.activeJobCount : 0} in-flight jobs.`);

  isWorkerRunning = false;
  wakeUpRequested = false;
  immediatePollPending = false;
  workerGeneration++;
  currentPollLoop = null;

  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (pendingImmediate) {
    clearImmediate(pendingImmediate);
    pendingImmediate = null;
  }

  // Grace period: Wait for in-flight poll cycle to settle if active
  if (activePollPromise) {
    try {
      const pollDrainWait = Math.min(timeoutMs, 2000);
      await Promise.race([
        activePollPromise,
        new Promise(r => setTimeout(r, pollDrainWait))
      ]);
    } catch (_) {}
  }

  // Grace period: Wait for in-flight jobs of this generation to complete while keeping their heartbeats active!
  const start = Date.now();
  while (stoppingGenContext && stoppingGenContext.activeJobCount > 0 && (Date.now() - start) < timeoutMs) {
    await new Promise(r => setTimeout(r, 100));
  }

  // Reset polling lock only if activePollPromise has fully settled
  if (!activePollPromise && pollingGeneration === stoppingGen) {
    isPolling = false;
    pollingGeneration = 0;
  }

  // Stop remaining heartbeat timers ONLY for the generation being stopped
  // Any replacement worker generation's heartbeats are completely preserved!
  for (const [key, heartbeat] of activeHeartbeats.entries()) {
    if (heartbeat.workerId === stoppingGenWorkerId || heartbeat.gen === stoppingGen) {
      clearInterval(heartbeat.timer);
      activeHeartbeats.delete(key);
    }
  }

  if (stoppingGenContext && stoppingGenContext.activeJobCount === 0) {
    activeGenerations.delete(stoppingGen);
  }

  if (stoppingGenContext && stoppingGenContext.activeJobCount > 0) {
    console.warn(`[WORKER SHUTDOWN] Force exiting with ${stoppingGenContext.activeJobCount} in-flight jobs still running. Their leases will safely expire and be recovered by another worker.`);
  } else {
    console.log(`[WORKER] Worker ${stoppingGenWorkerId} stopped cleanly. All jobs drained.`);
  }
}

/**
 * Returns current worker telemetry.
 */
function getWorkerStatus() {
  const currentCtx = activeGenContext;
  return {
    worker_id: currentCtx ? currentCtx.workerId : workerId,
    is_running: isWorkerRunning,
    is_polling: isPolling,
    wake_up_requested: wakeUpRequested,
    active_jobs: currentCtx ? currentCtx.activeJobCount : 0,
    aggregate_active_jobs: getAggregateActiveJobCount(),
    active_by_account: currentCtx ? Object.fromEntries(currentCtx.activeJobsByAccount.entries()) : {},
    last_heartbeat: lastHeartbeatTime,
    total_processed: totalProcessedCount,
    total_failed: totalFailedCount,
    immediate_polls_triggered: immediatePollTriggeredCount
  };
}

/**
 * For testing: resets worker state.
 */
function _resetWorkerForTesting() {
  isWorkerRunning = false;
  isPolling = false;
  pollingGeneration = 0;
  activePollPromise = null;
  wakeUpRequested = false;
  immediatePollPending = false;
  workerGeneration++;
  currentPollLoop = null;
  activeGenContext = null;
  activeGenerations.clear();
  workerId = baseWorkerPrefix;
  immediatePollTriggeredCount = 0;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (pendingImmediate) {
    clearImmediate(pendingImmediate);
    pendingImmediate = null;
  }
  for (const heartbeat of activeHeartbeats.values()) {
    clearInterval(heartbeat.timer);
  }
  activeHeartbeats.clear();
  totalProcessedCount = 0;
  totalFailedCount = 0;
}

module.exports = {
  startWorker,
  stopWorker,
  getWorkerStatus,
  triggerImmediatePoll,
  notifyWorker: triggerImmediatePoll,
  _processClaimedJobForTesting: processClaimedJob,
  _releaseClaimedJobForTesting: releaseClaimedJob,
  _getActiveHeartbeatsForTesting: () => activeHeartbeats,
  _getAggregateActiveJobCountForTesting: getAggregateActiveJobCount,
  _resetWorkerForTesting
};
