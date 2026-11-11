// src/jobs/webhookJobQueue.js
// Durable Webhook Ingestion, Crash Recovery, Concurrency Control & Queue Management
const crypto = require('crypto');
const metaRateLimiter = require('../services/metaRateLimiter');

// Configurable Queue Parameters (with conservative, documented defaults)
const WORKER_POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS) || 1000; // 1s poll interval
const JOB_LEASE_MS = Number(process.env.JOB_LEASE_MS) || 120000;                     // 120s / 2m lease duration
const MAX_JOB_ATTEMPTS = Number(process.env.MAX_JOB_ATTEMPTS) || 5;                  // Max 5 attempts before dead-letter
const WORKER_CONCURRENCY = Number(process.env.WORKER_CONCURRENCY) || 5;              // Max 5 concurrent jobs globally
const ACCOUNT_CONCURRENCY = Number(process.env.ACCOUNT_CONCURRENCY) || 2;            // Max 2 concurrent jobs per creator
const BASE_BACKOFF_MS = Number(process.env.BASE_BACKOFF_MS) || 2000;                 // 2s base backoff
const MAX_BACKOFF_MS = Number(process.env.MAX_BACKOFF_MS) || 300000;                 // 5m max backoff
const JITTER_MS = Number(process.env.JITTER_MS) || 1000;                             // 0-1000ms randomized jitter

/**
 * Normalizes an incoming Meta webhook payload into standard job definitions.
 * Filters out bot echoes, delivery receipts, self-comments, and comment replies.
 *
 * @param {object} payload - Parsed Meta webhook JSON body
 * @returns {Array<object>} - Array of normalized job objects ready for queue insertion
 */
function normalizeWebhookPayload(payload) {
  if (!payload || payload.object !== 'instagram' || !Array.isArray(payload.entry)) {
    return [];
  }

  const jobs = [];

  for (const entry of payload.entry) {
    const recipientIgUserId = String(entry.id || '');
    const changes = Array.isArray(entry.changes) ? entry.changes : [];

    // 1. Comment Webhook Events
    for (const change of changes) {
      if (change.field !== 'comments' || !change.value) continue;

      const commentVal = change.value;
      const commentId = String(commentVal.id || '').trim();
      const commentText = String(commentVal.text || '').trim();

      if (!commentId || !commentText || !recipientIgUserId) continue;

      const fromId = String(commentVal.from?.id || '').trim();
      const fromUsername = String(commentVal.from?.username || '').toLowerCase().trim();

      // Filter: self-comments
      if (fromId && fromId === recipientIgUserId) {
        continue;
      }

      // Filter: comment replies (only respond to root comments)
      if (commentVal.parent_id) {
        continue;
      }

      const commentMediaId = String(commentVal.media?.id || commentVal.media_id || commentVal.mediaId || '');
      const eventKey = `comment:${commentId}`;

      jobs.push({
        job_id: eventKey,
        event_key: eventKey,
        event_type: 'comment',
        instagram_account_id: recipientIgUserId,
        from_id: fromId,
        from_username: fromUsername,
        comment_id: commentId,
        media_id: commentMediaId || null,
        comment_text: commentText,
        message_text: null,
        payload: null,
        action: null,
        automation_id: null,
        status: 'queued',
        attempts: 0,
        last_error: null,
        failure_category: null,
        attempt_history: [],
        run_at: new Date(),
        received_at: new Date().toISOString(),
        created_at: new Date(),
        updated_at: new Date(),
        locked_until: null,
        worker_id: null,
        completed_at: null
      });
    }

    // 2. Messaging Webhook Events (Quick Replies, Button Postbacks, Direct Messages)
    const messagingEvents = Array.isArray(entry.messaging) ? entry.messaging : [];
    for (const msgEvent of messagingEvents) {
      // Filter out echoes, delivery receipts, and read receipts
      if (msgEvent.message?.is_echo || msgEvent.delivery || msgEvent.read) {
        continue;
      }

      const senderIgsid = String(msgEvent.sender?.id || '').trim();
      const recipientId = String(msgEvent.recipient?.id || entry.id || '').trim();
      if (!senderIgsid || !recipientId || senderIgsid === recipientId) continue;

      const quickReplyPayload = msgEvent.message?.quick_reply?.payload;
      const postbackPayload = msgEvent.postback?.payload;
      const incomingText = String(msgEvent.message?.text || msgEvent.postback?.title || '').trim();
      const payloadStr = String(quickReplyPayload || postbackPayload || '').trim();

      let action = null;
      let autoId = null;
      let commentId = null;

      if (payloadStr.startsWith('SEND_LINK')) {
        action = 'SEND_LINK';
        const parts = payloadStr.split(':');
        autoId = parts[1] || null;
        commentId = parts[2] || null;
      } else if (payloadStr.startsWith('CHECK_FOLLOW')) {
        action = 'CHECK_FOLLOW';
        const parts = payloadStr.split(':');
        autoId = parts[1] || null;
        commentId = parts[2] || null;
      } else if (/send.*(link|access)/i.test(incomingText) || /^(link|access|yes|send|send\s*link)$/i.test(incomingText)) {
        action = 'SEND_LINK';
      } else if (/(follow|following|followed|done|checked)/i.test(incomingText)) {
        action = 'CHECK_FOLLOW';
      }

      if (!action) continue;

      const mid = msgEvent.message?.mid;
      const timestamp = msgEvent.timestamp || Date.now();
      const eventKey = mid
        ? `msg:${mid}`
        : `postback:${recipientId}:${senderIgsid}:${action}:${timestamp}`;

      const eventType = quickReplyPayload
        ? 'messaging_quick_reply'
        : (postbackPayload ? 'messaging_postback' : 'messaging_text');

      jobs.push({
        job_id: eventKey,
        event_key: eventKey,
        event_type: eventType,
        instagram_account_id: recipientId,
        from_id: senderIgsid,
        from_username: null,
        comment_id: commentId,
        media_id: null,
        comment_text: null,
        message_text: incomingText || null,
        payload: payloadStr || null,
        action: action,
        automation_id: autoId,
        status: 'queued',
        attempts: 0,
        last_error: null,
        failure_category: null,
        attempt_history: [],
        run_at: new Date(),
        received_at: new Date().toISOString(),
        created_at: new Date(),
        updated_at: new Date(),
        locked_until: null,
        worker_id: null,
        completed_at: null
      });
    }
  }

  return jobs;
}

// In-memory fallback queue for unit tests / development without MongoDB
const memoryJobsStore = new Map();

/**
 * Durably ingests a Meta webhook payload into MongoDB webhook_jobs collection.
 * Uses atomic unique index insertion for race-condition-free deduplication.
 *
 * @param {object} payload - Parsed Meta webhook payload
 * @param {object} db - Database module instance
 * @returns {Promise<{ count: number, duplicates: number, jobs: Array<object> }>}
 */
async function ingestWebhookPayload(payload, db) {
  const normalizedJobs = normalizeWebhookPayload(payload);
  if (normalizedJobs.length === 0) {
    return { count: 0, duplicates: 0, jobs: [] };
  }

  let count = 0;
  let duplicates = 0;
  const persistedJobs = [];

  const isMongo = Boolean(db && db.collections && db.collections().webhookJobs);

  if (isMongo) {
    const col = db.collections().webhookJobs;
    for (const job of normalizedJobs) {
      try {
        await col.insertOne(job);
        count++;
        persistedJobs.push(job);
      } catch (err) {
        if (err.code === 11000 || (err.message && err.message.includes('E11000'))) {
          // Atomic deduplication: record already existed in MongoDB!
          duplicates++;
        } else {
          // Re-throw genuine database connection / persistence errors
          throw err;
        }
      }
    }
  } else {
    // In-memory fallback
    for (const job of normalizedJobs) {
      if (memoryJobsStore.has(job.event_key)) {
        duplicates++;
      } else {
        memoryJobsStore.set(job.event_key, { ...job, _id: crypto.randomUUID() });
        count++;
        persistedJobs.push(job);
      }
    }
  }

  return {
    count,
    duplicates,
    jobs: persistedJobs
  };
}

/**
 * Atomically claims the next eligible job from the database for processing.
 * Handles:
 * 1. Fresh 'queued' jobs whose run_at is due.
 * 2. 'retrying' jobs whose backoff run_at has arrived.
 * 3. Crash Recovery: 'processing' jobs whose lease expired (locked_until <= now).
 * 4. Fair scheduling & per-account concurrency via excludedAccountIds filter.
 *
 * @param {object} db - Database module instance
 * @param {object} [options] - Claim options
 * @param {string} [options.workerId] - Worker ID claiming the job
 * @param {number} [options.leaseMs] - Lease lock duration in milliseconds
 * @param {Array<string>} [options.excludedAccountIds] - Account IDs to exclude from this claim tick
 * @returns {Promise<object|null>} - Claimed job document or null
 */
async function claimNextJob(db, options = {}) {
  const isMongo = Boolean(db && db.collections && db.collections().webhookJobs);
  const now = new Date();
  const workerId = (typeof options === 'string' ? options : options?.workerId) || `worker_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
  const leaseMs = Number(options.leaseMs) || JOB_LEASE_MS;
  const lockExpiry = new Date(now.getTime() + leaseMs);
  const excludedAccounts = Array.isArray(options.excludedAccountIds) ? options.excludedAccountIds : [];

  if (isMongo) {
    const col = db.collections().webhookJobs;

    const baseFilter = {
      attempts: { $lt: MAX_JOB_ATTEMPTS },
      $or: [
        // Condition 1: 'queued' jobs whose run_at is due
        {
          status: 'queued',
          $or: [
            { run_at: null },
            { run_at: { $exists: false } },
            { run_at: { $lte: now } }
          ]
        },
        // Condition 2: 'retrying' jobs whose run_at has arrived
        {
          status: 'retrying',
          $or: [
            { run_at: null },
            { run_at: { $exists: false } },
            { run_at: { $lte: now } }
          ]
        },
        // Condition 3: Crash Recovery: 'processing' jobs whose lease expired
        {
          status: 'processing',
          locked_until: { $lte: now }
        }
      ]
    };

    // Dynamic exclusion of paused accounts from shared MongoDB rate limit collection
    let activeExcluded = [...excludedAccounts];
    if (db.collections().accountRateLimits) {
      try {
        const pausedDocs = await db.collections().accountRateLimits.find({
          paused_until: { $gt: now }
        }).toArray();
        if (Array.isArray(pausedDocs)) {
          for (const p of pausedDocs) {
            if (p.account_id && !activeExcluded.includes(p.account_id)) {
              activeExcluded.push(p.account_id);
            }
          }
        }
      } catch (_) {}
    }
    if (activeExcluded.length > 0) {
      baseFilter.instagram_account_id = { $nin: activeExcluded };
    }

    const updateDoc = {
      $set: {
        status: 'processing',
        locked_until: lockExpiry,
        worker_id: workerId,
        lease_extended_at: now,
        updated_at: now
      },
      $inc: { attempts: 1 }
    };

    const result = await col.findOneAndUpdate(
      baseFilter,
      updateDoc,
      {
        sort: { run_at: 1, created_at: 1 },
        returnDocument: 'after'
      }
    );

    if (!result) return null;
    return result.value !== undefined ? result.value : result;
  } else {
    // In-memory fallback for testing
    for (const [key, job] of memoryJobsStore.entries()) {
      if (job.attempts >= MAX_JOB_ATTEMPTS) continue;
      if (excludedAccounts.includes(job.instagram_account_id) || metaRateLimiter.isAccountPaused(job.instagram_account_id)) continue;

      const isQueuedDue = (job.status === 'queued') && (!job.run_at || job.run_at <= now);
      const isRetryingDue = (job.status === 'retrying') && (!job.run_at || job.run_at <= now);
      const isExpiredProcessing = (job.status === 'processing') && (job.locked_until && job.locked_until <= now);

      if (isQueuedDue || isRetryingDue || isExpiredProcessing) {
        job.status = 'processing';
        job.attempts = (job.attempts || 0) + 1;
        job.worker_id = workerId;
        job.locked_until = lockExpiry;
        job.lease_extended_at = now;
        job.updated_at = now;
        return job;
      }
    }
    return null;
  }
}

/**
 * Extends the lease lock of an actively processing job (heartbeat).
 *
 * @param {object} job - The job document
 * @param {string} workerId - Worker ID extending lease
 * @param {number} [extensionMs] - Milliseconds to extend
 * @param {object} db - Database module instance
 * @returns {Promise<boolean>} - True if lease was extended
 */
async function extendLease(job, workerId, extensionMs = JOB_LEASE_MS, db) {
  const isMongo = Boolean(db && db.collections && db.collections().webhookJobs);
  const now = new Date();
  const targetWorkerId = workerId || job?.worker_id;
  if (!targetWorkerId) {
    console.warn(`[LEASE EXTEND ERROR] Missing workerId for job ${job?.event_key}`);
    return false;
  }
  const newLockExpiry = new Date(now.getTime() + extensionMs);

  if (isMongo) {
    const col = db.collections().webhookJobs;
    const filter = {
      event_key: job.event_key,
      worker_id: targetWorkerId,
      status: 'processing',
      locked_until: { $gt: now } // Strictly requires unexpired lease
    };

    const res = await col.updateOne(filter, {
      $set: {
        locked_until: newLockExpiry,
        lease_extended_at: now,
        updated_at: now
      }
    });
    return (res.modifiedCount || res.matchedCount) > 0;
  } else {
    const existing = memoryJobsStore.get(job.event_key);
    if (existing && existing.status === 'processing') {
      const isOwner = existing.worker_id === targetWorkerId;
      const isUnexpired = existing.locked_until && new Date(existing.locked_until) > now;
      if (isOwner && isUnexpired) {
        existing.locked_until = newLockExpiry;
        existing.lease_extended_at = now;
        existing.updated_at = now;
        return true;
      }
    }
    return false;
  }
}

/**
 * Handles job failure with error classification, exponential backoff, jitter, and dead-letter logic.
 *
 * @param {object} job - The job document
 * @param {Error|object} error - The error encountered
 * @param {object} db - Database module instance
 * @returns {Promise<{ status: string, classification: object }>}
 */
async function handleJobFailure(job, error, db) {
  const isMongo = Boolean(db && db.collections && db.collections().webhookJobs);
  const now = new Date();
  const workerId = job.worker_id;
  const classification = metaRateLimiter.classifyMetaError(error);

  const attemptRecord = {
    attempt: job.attempts || 1,
    timestamp: now.toISOString(),
    error: classification.reason,
    category: classification.category
  };

  // Determine if job should be retried or moved to dead-letter / failed
  const isRetryable = classification.retryable === true;
  const attempts = Number(job.attempts || 1);
  const reachedMaxAttempts = attempts >= MAX_JOB_ATTEMPTS;

  let newStatus;
  let runAt = null;

  if (isRetryable && !reachedMaxAttempts) {
    newStatus = 'retrying';
    const delay = classification.backoffMs || metaRateLimiter.calculateBackoffWithJitter(attempts);
    runAt = new Date(now.getTime() + delay);

    if (classification.category === 'RATE_LIMITED' && job.instagram_account_id) {
      metaRateLimiter.pauseAccount(job.instagram_account_id, delay, 'Rate limit during execution', db);
    }
  } else {
    newStatus = reachedMaxAttempts ? 'dead_letter' : 'failed';
    runAt = null;
  }

  const updateFields = {
    status: newStatus,
    last_error: classification.reason,
    failure_category: classification.category,
    locked_until: null,
    run_at: runAt,
    updated_at: now,
    completed_at: newStatus === 'retrying' ? null : now
  };

  if (isMongo) {
    const col = db.collections().webhookJobs;
    const filter = { event_key: job.event_key };
    if (workerId) {
      filter.worker_id = workerId;
      filter.status = 'processing';
      filter.locked_until = { $gt: now }; // Strictly requires unexpired lease
    }
    const res = await col.updateOne(
      filter,
      {
        $set: updateFields,
        $push: { attempt_history: attemptRecord }
      }
    );
    if (res.matchedCount === 0) {
      console.warn(`[LEASE LOSS] Worker ${workerId} could not update failed status for job ${job.event_key}: lease expired or claimed by another worker.`);
      return { success: false, reason: 'LEASE_LOST', status: 'stale_worker', classification };
    }
  } else {
    const existing = memoryJobsStore.get(job.event_key);
    if (existing) {
      if (workerId) {
        const isOwner = existing.worker_id === workerId;
        const isProcessing = existing.status === 'processing';
        const isUnexpired = existing.locked_until && new Date(existing.locked_until) > now;
        if (!isOwner || !isProcessing || !isUnexpired) {
          console.warn(`[LEASE LOSS] Worker ${workerId} could not update failed status for job ${job.event_key}: lease lost or expired.`);
          return { success: false, reason: 'LEASE_LOST', status: 'stale_worker', classification };
        }
      }
      Object.assign(existing, updateFields);
      if (!Array.isArray(existing.attempt_history)) existing.attempt_history = [];
      existing.attempt_history.push(attemptRecord);
    }
  }

  return { success: true, status: newStatus, classification };
}

/**
 * Updates a job's status upon successful completion.
 *
 * @param {object} job - The job document
 * @param {object} details - Optional metadata
 * @param {object} db - Database module instance
 */
async function handleJobSuccess(job, details = {}, db) {
  const targetDb = (details && details.collections) ? details : db;
  const isMongo = Boolean(targetDb && targetDb.collections && targetDb.collections().webhookJobs);
  const now = new Date();
  const workerId = (details && !details.collections ? details.worker_id : null) || job.worker_id;

  if (!workerId) {
    console.warn(`[LEASE LOSS] Cannot mark job ${job.event_key} as sent without explicit worker_id`);
    return { success: false, reason: 'MISSING_WORKER_ID', status: 'stale_worker' };
  }

  const updateFields = {
    status: 'sent',
    last_error: null,
    locked_until: null,
    completed_at: now,
    updated_at: now,
    meta_message_id: details?.meta_message_id || null
  };

  if (isMongo) {
    const col = targetDb.collections().webhookJobs;
    const filter = {
      event_key: job.event_key,
      worker_id: workerId,
      status: 'processing',
      locked_until: { $gt: now } // Strictly requires unexpired lease
    };
    const res = await col.updateOne(filter, { $set: updateFields });
    if (res.matchedCount === 0) {
      console.warn(`[LEASE LOSS] Worker ${workerId} could not mark job ${job.event_key} as sent: lease expired or claimed by another worker.`);
      return { success: false, reason: 'LEASE_LOST', status: 'stale_worker' };
    }
    return { success: true, status: 'sent' };
  } else {
    const existing = memoryJobsStore.get(job.event_key);
    if (existing) {
      const isOwner = existing.worker_id === workerId;
      const isProcessing = existing.status === 'processing';
      const isUnexpired = existing.locked_until && new Date(existing.locked_until) > now;
      if (!isOwner || !isProcessing || !isUnexpired) {
        console.warn(`[LEASE LOSS] Worker ${workerId} could not mark job ${job.event_key} as sent: lease lost or expired.`);
        return { success: false, reason: 'LEASE_LOST', status: 'stale_worker' };
      }
      Object.assign(existing, updateFields);
      return { success: true, status: 'sent' };
    }
    return { success: false, reason: 'JOB_NOT_FOUND', status: 'stale_worker' };
  }
}

/**
 * Backward compatibility wrapper for Phase 1 tests.
 */
async function updateJobStatus(job, status, details = {}, db) {
  if (status === 'sent') {
    return await handleJobSuccess(job, details, db);
  } else if (status === 'failed') {
    return await handleJobFailure(job, new Error(details.error || 'Failed'), db);
  } else {
    const isMongo = Boolean(db && db.collections && db.collections().webhookJobs);
    const now = new Date();
    if (isMongo) {
      const filter = { event_key: job.event_key };
      if (job.worker_id) {
        filter.worker_id = job.worker_id;
        filter.status = 'processing';
        filter.locked_until = { $gt: now };
      }
      await db.collections().webhookJobs.updateOne(
        filter,
        { $set: { status, last_error: details.error || null, updated_at: now, locked_until: null } }
      );
    } else {
      const existing = memoryJobsStore.get(job.event_key);
      if (existing) {
        existing.status = status;
        existing.last_error = details.error || null;
        existing.updated_at = now;
        existing.locked_until = null;
      }
    }
  }
}

/**
 * Returns comprehensive backend metrics for queue observability.
 *
 * @param {object} db - Database module instance
 * @returns {Promise<object>} - Metrics snapshot
 */
async function getQueueMetrics(db) {
  const isMongo = Boolean(db && db.collections && db.collections().webhookJobs);
  const now = Date.now();

  if (isMongo) {
    const col = db.collections().webhookJobs;
    const [queued, processing, retrying, failed, deadLetter, sent] = await Promise.all([
      col.countDocuments({ status: 'queued' }),
      col.countDocuments({ status: 'processing' }),
      col.countDocuments({ status: 'retrying' }),
      col.countDocuments({ status: 'failed' }),
      col.countDocuments({ status: 'dead_letter' }),
      col.countDocuments({ status: 'sent' })
    ]);

    // Oldest pending job
    const oldestPending = await col.find(
      { status: { $in: ['queued', 'retrying'] } }
    ).sort({ created_at: 1 }).limit(1).toArray();

    const oldestAgeMs = oldestPending.length > 0 && oldestPending[0].created_at
      ? Math.max(0, now - new Date(oldestPending[0].created_at).getTime())
      : 0;

    // Per account pending depth
    const perAccountAgg = await col.aggregate([
      { $match: { status: { $in: ['queued', 'retrying', 'processing'] } } },
      { $group: { _id: '$instagram_account_id', count: { $sum: 1 } } },
      { $limit: 50 }
    ]).toArray();

    return {
      queued_jobs: queued,
      processing_jobs: processing,
      retrying_jobs: retrying,
      failed_jobs: failed,
      dead_letter_jobs: deadLetter,
      jobs_processed: sent,
      jobs_failed: failed + deadLetter,
      oldest_pending_job_age_ms: oldestAgeMs,
      meta_rate_limit_events: metaRateLimiter.getRateLimitEventsCount(),
      per_account_queue_depth: perAccountAgg.map(a => ({ account_id: a._id, depth: a.count }))
    };
  } else {
    // In-memory fallback
    let queued = 0, processing = 0, retrying = 0, failed = 0, deadLetter = 0, sent = 0;
    let oldestTime = Infinity;
    const accountCounts = {};

    for (const job of memoryJobsStore.values()) {
      if (job.status === 'queued') queued++;
      else if (job.status === 'processing') processing++;
      else if (job.status === 'retrying') retrying++;
      else if (job.status === 'failed') failed++;
      else if (job.status === 'dead_letter') deadLetter++;
      else if (job.status === 'sent') sent++;

      if (['queued', 'retrying'].includes(job.status)) {
        const t = new Date(job.created_at || now).getTime();
        if (t < oldestTime) oldestTime = t;
        const acc = job.instagram_account_id || 'unknown';
        accountCounts[acc] = (accountCounts[acc] || 0) + 1;
      }
    }

    return {
      queued_jobs: queued,
      processing_jobs: processing,
      retrying_jobs: retrying,
      failed_jobs: failed,
      dead_letter_jobs: deadLetter,
      jobs_processed: sent,
      jobs_failed: failed + deadLetter,
      oldest_pending_job_age_ms: oldestTime === Infinity ? 0 : Math.max(0, now - oldestTime),
      meta_rate_limit_events: metaRateLimiter.getRateLimitEventsCount(),
      per_account_queue_depth: Object.entries(accountCounts).map(([account_id, depth]) => ({ account_id, depth }))
    };
  }
}

module.exports = {
  WORKER_POLL_INTERVAL_MS,
  JOB_LEASE_MS,
  MAX_JOB_ATTEMPTS,
  WORKER_CONCURRENCY,
  ACCOUNT_CONCURRENCY,
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  JITTER_MS,
  normalizeWebhookPayload,
  ingestWebhookPayload,
  claimNextJob,
  extendLease,
  handleJobFailure,
  handleJobSuccess,
  updateJobStatus,
  getQueueMetrics,
  memoryJobsStore
};
