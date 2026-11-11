// src/jobs/webhookJobQueue.js
// Durable Webhook Ingestion, Deduplication, and Queue Management
const crypto = require('crypto');

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
        received_at: new Date().toISOString(),
        created_at: new Date(),
        updated_at: new Date(),
        locked_until: null
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
        received_at: new Date().toISOString(),
        created_at: new Date(),
        updated_at: new Date(),
        locked_until: null
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
 * Atomically claims the next queued job from the database for processing.
 *
 * @param {object} db - Database module instance
 * @returns {Promise<object|null>} - Claimed job document or null
 */
async function claimNextJob(db) {
  const isMongo = Boolean(db && db.collections && db.collections().webhookJobs);

  if (isMongo) {
    const col = db.collections().webhookJobs;
    const now = new Date();
    const lockExpiry = new Date(Date.now() + 60000); // 60s processing lock

    const result = await col.findOneAndUpdate(
      {
        status: 'queued',
        $or: [
          { locked_until: null },
          { locked_until: { $lte: now } }
        ]
      },
      {
        $set: {
          status: 'processing',
          locked_until: lockExpiry,
          updated_at: now
        },
        $inc: { attempts: 1 }
      },
      {
        sort: { created_at: 1 },
        returnDocument: 'after'
      }
    );

    if (!result) return null;
    return result.value !== undefined ? result.value : result;
  } else {
    for (const [key, job] of memoryJobsStore.entries()) {
      if (job.status === 'queued') {
        job.status = 'processing';
        job.attempts = (job.attempts || 0) + 1;
        job.updated_at = new Date();
        return job;
      }
    }
    return null;
  }
}

/**
 * Updates a job's status and metadata upon completion or failure.
 *
 * @param {object} job - The job document
 * @param {string} status - New state ('sent', 'failed', 'retrying', 'ignored')
 * @param {object} details - Optional error or completion metadata
 * @param {object} db - Database module instance
 */
async function updateJobStatus(job, status, details = {}, db) {
  const isMongo = Boolean(db && db.collections && db.collections().webhookJobs);
  const now = new Date();

  if (isMongo) {
    const col = db.collections().webhookJobs;
    await col.updateOne(
      { event_key: job.event_key },
      {
        $set: {
          status,
          last_error: details.error || null,
          completed_at: status === 'sent' ? now : null,
          locked_until: null,
          updated_at: now
        }
      }
    );
  } else {
    const existing = memoryJobsStore.get(job.event_key);
    if (existing) {
      existing.status = status;
      existing.last_error = details.error || null;
      existing.completed_at = status === 'sent' ? now : null;
      existing.updated_at = now;
    }
  }
}

module.exports = {
  normalizeWebhookPayload,
  ingestWebhookPayload,
  claimNextJob,
  updateJobStatus,
  memoryJobsStore
};
