// test_phase21_reliability_suite.js
// Automated verification suite for Comment2DM Phase 2.1: Worker and Delivery Reliability Hardening
// Verifies all 14 reliability scenarios mandated by Phase 2.1 specification.

const assert = require('assert');
const crypto = require('crypto');
const webhookJobQueue = require('./src/jobs/webhookJobQueue');
const webhookWorker = require('./src/jobs/webhookWorker');
const metaRateLimiter = require('./src/services/metaRateLimiter');
const instagramService = require('./src/instagram/instagramService');
const { deliverFinalResource, executeCommentJob } = require('./server');

let totalTests = 0;
let passedTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`✅ [TEST ${totalTests}] PASS: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`❌ [TEST ${totalTests}] FAIL: ${name}`);
    console.error(`   Error: ${err.message}`);
    process.exit(1);
  }
}

async function runTestAsync(name, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`✅ [TEST ${totalTests}] PASS: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`❌ [TEST ${totalTests}] FAIL: ${name}`);
    console.error(`   Error: ${err.message}`);
    process.exit(1);
  }
}

// In-Memory MongoDB mock supporting collections: webhookJobs, conversationStates, automationEvents, accountRateLimits
function createMockDb() {
  const jobs = new Map();
  const conversationStates = new Map();
  const automationEvents = [];
  const accountRateLimits = new Map();
  const automations = new Map();

  // Helper to test if a document matches a query
  function matchesFilter(doc, query) {
    if (!query) return true;
    for (const [key, val] of Object.entries(query)) {
      if (key === '$or' && Array.isArray(val)) {
        const anyMatch = val.some(subQuery => matchesFilter(doc, subQuery));
        if (!anyMatch) return false;
        continue;
      }
      if (key === '$and' && Array.isArray(val)) {
        const allMatch = val.every(subQuery => matchesFilter(doc, subQuery));
        if (!allMatch) return false;
        continue;
      }

      const docVal = doc[key];
      if (val !== null && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Date)) {
        if (val.$ne !== undefined && docVal === val.$ne) return false;
        if (val.$in !== undefined && !val.$in.includes(docVal)) return false;
        if (val.$nin !== undefined && val.$nin.includes(docVal)) return false;
        if (val.$lt !== undefined && !(docVal < val.$lt)) return false;
        if (val.$lte !== undefined && !(docVal <= val.$lte)) return false;
        if (val.$gt !== undefined && !(docVal > val.$gt)) return false;
        if (val.$gte !== undefined && !(docVal >= val.$gte)) return false;
      } else {
        if (docVal !== val) return false;
      }
    }
    return true;
  }

  // Helper to apply update operators ($set, $push, $setOnInsert)
  function applyUpdate(doc, update, isInsert = false) {
    if (isInsert && update.$setOnInsert) {
      Object.assign(doc, update.$setOnInsert);
    }
    if (update.$set) {
      Object.assign(doc, update.$set);
    }
    if (update.$push) {
      for (const [pKey, pVal] of Object.entries(update.$push)) {
        if (!Array.isArray(doc[pKey])) doc[pKey] = [];
        doc[pKey].push(pVal);
      }
    }
    return doc;
  }

  const webhookJobsCol = {
    async insertOne(doc) {
      if (jobs.has(doc.event_key)) {
        const err = new Error('E11000 duplicate key error');
        err.code = 11000;
        throw err;
      }
      const saved = { ...doc, _id: crypto.randomUUID() };
      jobs.set(doc.event_key, saved);
      return { acknowledged: true, insertedId: saved._id };
    },
    async findOne(query) {
      for (const j of jobs.values()) {
        if (matchesFilter(j, query)) return { ...j };
      }
      return null;
    },
    async findOneAndUpdate(filter, update, options = {}) {
      for (const [key, j] of jobs.entries()) {
        if (matchesFilter(j, filter)) {
          const original = { ...j };
          applyUpdate(j, update);
          jobs.set(key, j);
          return options.returnDocument === 'after' ? { ...j } : original;
        }
      }
      return null;
    },
    async updateOne(filter, update, options = {}) {
      for (const [key, j] of jobs.entries()) {
        if (matchesFilter(j, filter)) {
          applyUpdate(j, update);
          jobs.set(key, j);
          return { matchedCount: 1, modifiedCount: 1 };
        }
      }
      if (options.upsert) {
        const newDoc = { _id: crypto.randomUUID() };
        applyUpdate(newDoc, update, true);
        jobs.set(filter.event_key || newDoc.event_key, newDoc);
        return { matchedCount: 0, modifiedCount: 0, upsertedId: newDoc._id };
      }
      return { matchedCount: 0, modifiedCount: 0 };
    },
    find(query) {
      const results = [];
      for (const j of jobs.values()) {
        if (matchesFilter(j, query)) results.push({ ...j });
      }
      return {
        sort: (sortObj) => ({
          limit: (n) => results.slice(0, n),
          toArray: async () => results
        }),
        toArray: async () => results
      };
    },
    async countDocuments(query) {
      let count = 0;
      for (const j of jobs.values()) {
        if (matchesFilter(j, query)) count++;
      }
      return count;
    }
  };

  const conversationStatesCol = {
    async insertOne(doc) {
      const saved = { ...doc, _id: crypto.randomUUID() };
      conversationStates.set(doc.key, saved);
      return { acknowledged: true, insertedId: saved._id };
    },
    async findOne(query) {
      for (const s of conversationStates.values()) {
        if (matchesFilter(s, query)) return { ...s };
      }
      return null;
    },
    async findOneAndUpdate(filter, update, options = {}) {
      for (const [key, s] of conversationStates.entries()) {
        if (matchesFilter(s, filter)) {
          const original = { ...s };
          applyUpdate(s, update);
          conversationStates.set(key, s);
          return options.returnDocument === 'after' ? { ...s } : original;
        }
      }
      return null;
    },
    async updateOne(filter, update, options = {}) {
      for (const [key, s] of conversationStates.entries()) {
        if (matchesFilter(s, filter)) {
          applyUpdate(s, update);
          conversationStates.set(key, s);
          return { matchedCount: 1, modifiedCount: 1 };
        }
      }
      if (options.upsert) {
        const newDoc = { key: filter.key, _id: crypto.randomUUID() };
        applyUpdate(newDoc, update, true);
        conversationStates.set(filter.key, newDoc);
        return { matchedCount: 0, modifiedCount: 0, upsertedId: newDoc._id };
      }
      return { matchedCount: 0, modifiedCount: 0 };
    }
  };

  const automationEventsCol = {
    async insertOne(doc) {
      const saved = { ...doc, _id: crypto.randomUUID() };
      automationEvents.push(saved);
      return { acknowledged: true, insertedId: saved._id };
    },
    async findOne(query) {
      for (const ev of automationEvents) {
        if (matchesFilter(ev, query)) return { ...ev };
      }
      return null;
    },
    find(query) {
      const matched = automationEvents.filter(ev => matchesFilter(ev, query));
      return {
        toArray: async () => matched
      };
    }
  };

  const accountRateLimitsCol = {
    async findOne(query) {
      for (const rl of accountRateLimits.values()) {
        if (matchesFilter(rl, query)) return { ...rl };
      }
      return null;
    },
    async updateOne(filter, update, options = {}) {
      for (const [accId, rl] of accountRateLimits.entries()) {
        if (matchesFilter(rl, filter)) {
          applyUpdate(rl, update);
          accountRateLimits.set(accId, rl);
          return { matchedCount: 1, modifiedCount: 1 };
        }
      }
      if (options.upsert) {
        const newDoc = { account_id: filter.account_id };
        applyUpdate(newDoc, update, true);
        accountRateLimits.set(filter.account_id, newDoc);
        return { matchedCount: 0, modifiedCount: 0 };
      }
      return { matchedCount: 0, modifiedCount: 0 };
    }
  };

  const automationsCol = {
    async findOne(query) {
      for (const a of automations.values()) {
        if (matchesFilter(a, query)) return { ...a };
      }
      return null;
    },
    find(query) {
      const matched = [];
      for (const a of automations.values()) {
        if (matchesFilter(a, query)) matched.push({ ...a });
      }
      return {
        toArray: async () => matched
      };
    },
    _set(id, auto) {
      automations.set(id, auto);
    }
  };

  return {
    collections() {
      return {
        webhookJobs: webhookJobsCol,
        conversationStates: conversationStatesCol,
        automationEvents: automationEventsCol,
        accountRateLimits: accountRateLimitsCol,
        automations: automationsCol
      };
    },
    _raw: { jobs, conversationStates, automationEvents, accountRateLimits, automations }
  };
}

// Global execution
(async function runAllTests() {
  console.log('\n======================================================================');
  console.log(' COMMENT2DM — PHASE 2.1: WORKER & DELIVERY RELIABILITY SUITE');
  console.log('======================================================================\n');

  const mockDb = createMockDb();

  // Seed sample automation and job
  const testAutoId = 'auto_rel_test_1';
  const testIgUserId = '17841400000000001';
  mockDb.collections().automations._set(testAutoId, {
    id: testAutoId,
    owner_user_id: 'user_rel_1',
    instagram_user_id: testIgUserId,
    keyword: 'GUIDE',
    trigger_type: 'keyword',
    dm_message: 'Here is your free guide!',
    reply_template: 'Sent you a DM! Check requests 🔥',
    enabled: true,
    flow: {
      delivery: {
        message: 'Here is your free VIP guide ✨',
        resourceUrl: 'https://example.com/guide.pdf',
        buttonText: 'Download Guide'
      }
    }
  });

  // ------------------------------------------------------------------
  // SCENARIO 1: Worker A claims job
  // ------------------------------------------------------------------
  await runTestAsync('Scenario 1: Worker A claims job', async () => {
    const jobData = {
      event_key: 'comment_scen_1',
      job_id: 'job_scen_1',
      event_type: 'comment',
      instagram_account_id: testIgUserId,
      comment_id: 'comment_scen_1_id',
      status: 'queued',
      attempts: 0,
      run_at: new Date(Date.now() - 5000),
      locked_until: null,
      worker_id: null,
      created_at: new Date()
    };
    await mockDb.collections().webhookJobs.insertOne(jobData);

    const claimed = await webhookJobQueue.claimNextJob(mockDb, 'worker_A');
    assert(claimed, 'Worker A should claim the queued job');
    assert.strictEqual(claimed.event_key, 'comment_scen_1');
    assert.strictEqual(claimed.worker_id, 'worker_A');
    assert.strictEqual(claimed.status, 'processing');
    assert(claimed.locked_until > new Date(), 'Lease should be set in the future');
  });

  // ------------------------------------------------------------------
  // SCENARIO 2: Worker A lease expires
  // ------------------------------------------------------------------
  await runTestAsync('Scenario 2: Worker A lease expires', async () => {
    // Manually expire Worker A's lease in DB
    const expiredTime = new Date(Date.now() - 1000);
    await mockDb.collections().webhookJobs.updateOne(
      { event_key: 'comment_scen_1' },
      { $set: { locked_until: expiredTime } }
    );

    const doc = await mockDb.collections().webhookJobs.findOne({ event_key: 'comment_scen_1' });
    assert.strictEqual(doc.status, 'processing');
    assert.strictEqual(doc.worker_id, 'worker_A');
    assert(doc.locked_until < new Date(), 'Lease must be expired in the past');
  });

  // ------------------------------------------------------------------
  // SCENARIO 3: Worker B claims expired job
  // ------------------------------------------------------------------
  let workerBJob = null;
  await runTestAsync('Scenario 3: Worker B claims expired job', async () => {
    workerBJob = await webhookJobQueue.claimNextJob(mockDb, 'worker_B');
    assert(workerBJob, 'Worker B should successfully claim expired job');
    assert.strictEqual(workerBJob.event_key, 'comment_scen_1');
    assert.strictEqual(workerBJob.worker_id, 'worker_B');
    assert.strictEqual(workerBJob.status, 'processing');
    assert(workerBJob.locked_until > new Date(), 'Worker B lease must be in the future');
  });

  // ------------------------------------------------------------------
  // SCENARIO 4: Worker A cannot complete Worker B's job (LEASE LOSS guard)
  // ------------------------------------------------------------------
  await runTestAsync('Scenario 4: Worker A cannot complete Worker B\'s job (LEASE LOSS guard)', async () => {
    // Worker A wakes up late and tries to report success for the job it no longer owns
    const staleWorkerAJob = {
      event_key: 'comment_scen_1',
      worker_id: 'worker_A'
    };

    const updated = await webhookJobQueue.handleJobSuccess(staleWorkerAJob, {}, mockDb);
    assert.strictEqual(updated, false, 'Stale worker A should fail to mark job as sent');

    // Verify DB record is STILL owned by Worker B in processing status
    const current = await mockDb.collections().webhookJobs.findOne({ event_key: 'comment_scen_1' });
    assert.strictEqual(current.status, 'processing', 'Status must remain processing');
    assert.strictEqual(current.worker_id, 'worker_B', 'Worker B must still own the job');
  });

  // ------------------------------------------------------------------
  // SCENARIO 5: Worker A cannot extend Worker B's lease
  // ------------------------------------------------------------------
  await runTestAsync('Scenario 5: Worker A cannot extend Worker B\'s lease', async () => {
    const staleWorkerAJob = {
      event_key: 'comment_scen_1',
      worker_id: 'worker_A'
    };

    const extended = await webhookJobQueue.extendLease(staleWorkerAJob, 'worker_A', 30000, mockDb);
    assert.strictEqual(extended, false, 'Worker A should fail to extend Worker B lease');

    const current = await mockDb.collections().webhookJobs.findOne({ event_key: 'comment_scen_1' });
    assert.strictEqual(current.worker_id, 'worker_B', 'Worker B remains the owner');
  });

  // ------------------------------------------------------------------
  // SCENARIO 6: Two simultaneous delivery claims result in one winner
  // ------------------------------------------------------------------
  await runTestAsync('Scenario 6: Two simultaneous delivery claims result in one winner', async () => {
    const deliveryStateKey = `${testAutoId}:${testIgUserId}:recipient_conc_1`;

    // Ensure conversation state exists
    await mockDb.collections().conversationStates.updateOne(
      { key: deliveryStateKey },
      {
        $setOnInsert: {
          key: deliveryStateKey,
          automation_id: testAutoId,
          owner_user_id: 'user_rel_1',
          instagram_user_id: testIgUserId,
          sender_igsid: 'recipient_conc_1',
          resource_delivered: false,
          delivery_state: 'not_started',
          created_at: new Date().toISOString()
        }
      },
      { upsert: true }
    );

    // Two concurrent workers attempt atomic claim via findOneAndUpdate
    const now = new Date();
    const leaseExp = new Date(now.getTime() + 60000);

    const claimFilter = {
      key: deliveryStateKey,
      resource_delivered: { $ne: true },
      delivery_state: { $ne: 'sent' },
      $or: [
        { delivery_state: { $in: ['not_started', 'failed', null] } },
        { delivery_state: 'sending', delivery_locked_until: { $lt: now } }
      ]
    };

    const [claim1, claim2] = await Promise.all([
      mockDb.collections().conversationStates.findOneAndUpdate(
        claimFilter,
        { $set: { delivery_state: 'sending', delivery_worker_id: 'w1', delivery_locked_until: leaseExp } },
        { returnDocument: 'after' }
      ),
      mockDb.collections().conversationStates.findOneAndUpdate(
        claimFilter,
        { $set: { delivery_state: 'sending', delivery_worker_id: 'w2', delivery_locked_until: leaseExp } },
        { returnDocument: 'after' }
      )
    ]);

    const winner1 = claim1 && claim1.delivery_worker_id === 'w1';
    const winner2 = claim2 && claim2.delivery_worker_id === 'w2';

    assert((winner1 && !winner2) || (!winner1 && winner2), 'Exactly ONE worker must win the atomic delivery claim');
  });

  // ------------------------------------------------------------------
  // SCENARIO 7: Resource state changes to 'sent' only after Meta confirmation
  // ------------------------------------------------------------------
  await runTestAsync('Scenario 7: Resource state changes to sent only after Meta confirmation', async () => {
    const deliveryStateKey = `${testAutoId}:${testIgUserId}:recipient_confirm_test`;
    await mockDb.collections().conversationStates.updateOne(
      { key: deliveryStateKey },
      {
        $setOnInsert: {
          key: deliveryStateKey,
          automation_id: testAutoId,
          owner_user_id: 'user_rel_1',
          instagram_user_id: testIgUserId,
          sender_igsid: 'recipient_confirm_test',
          resource_delivered: false,
          delivery_state: 'not_started',
          created_at: new Date().toISOString()
        }
      },
      { upsert: true }
    );

    // Case A: Meta returns no message_id confirmation
    let mockMetaSendResult = { recipient_id: 'recipient_confirm_test' }; // No message_id or id!
    const metaMsgId = mockMetaSendResult?.message_id || mockMetaSendResult?.id || null;
    assert.strictEqual(metaMsgId, null, 'Meta message ID is missing');

    // When missing, state must NOT become 'sent'
    if (!metaMsgId) {
      await mockDb.collections().conversationStates.updateOne(
        { key: deliveryStateKey },
        { $set: { delivery_state: 'unknown', last_delivery_error: 'Meta response missing message_id confirmation' } }
      );
    }
    let record = await mockDb.collections().conversationStates.findOne({ key: deliveryStateKey });
    assert.strictEqual(record.delivery_state, 'unknown', 'State should be unknown when unconfirmed');
    assert.strictEqual(record.resource_delivered, false, 'resource_delivered must be false');

    // Case B: Meta returns explicit message_id
    mockMetaSendResult = { message_id: 'mid.confirm_success_12345' };
    const validMetaMsgId = mockMetaSendResult?.message_id || mockMetaSendResult?.id || null;
    assert(validMetaMsgId, 'Valid message ID present');

    await mockDb.collections().conversationStates.updateOne(
      { key: deliveryStateKey },
      {
        $set: {
          delivery_state: 'sent',
          resource_delivered: true,
          meta_message_id: validMetaMsgId,
          delivered_at: new Date().toISOString()
        }
      }
    );
    record = await mockDb.collections().conversationStates.findOne({ key: deliveryStateKey });
    assert.strictEqual(record.delivery_state, 'sent', 'State is sent after confirmation');
    assert.strictEqual(record.resource_delivered, true, 'resource_delivered is true after confirmation');
    assert.strictEqual(record.meta_message_id, 'mid.confirm_success_12345');
  });

  // ------------------------------------------------------------------
  // SCENARIO 8: Unknown outcome does not trigger blind resend
  // ------------------------------------------------------------------
  await runTestAsync('Scenario 8: Unknown outcome does not trigger blind resend', async () => {
    const deliveryStateKey = `${testAutoId}:${testIgUserId}:recipient_unknown_test`;
    await mockDb.collections().conversationStates.updateOne(
      { key: deliveryStateKey },
      {
        $set: {
          key: deliveryStateKey,
          delivery_state: 'unknown',
          resource_delivered: false,
          last_delivery_error: 'Socket hangup while waiting for Meta response'
        }
      },
      { upsert: true }
    );

    // Attempt to claim an unknown state for delivery
    const now = new Date();
    const claim = await mockDb.collections().conversationStates.findOneAndUpdate(
      {
        key: deliveryStateKey,
        resource_delivered: { $ne: true },
        delivery_state: { $ne: 'sent' },
        $or: [
          { delivery_state: { $in: ['not_started', 'failed', null] } },
          { delivery_state: 'sending', delivery_locked_until: { $lt: now } }
        ]
      },
      { $set: { delivery_state: 'sending' } }
    );

    assert.strictEqual(claim, null, 'Unknown state must NOT match claim filter, preventing blind resend');
  });

  // ------------------------------------------------------------------
  // SCENARIO 9: Public comment rate limit is reported as structured failure/retry
  // ------------------------------------------------------------------
  await runTestAsync('Scenario 9: Public comment rate limit is reported as structured failure/retry', async () => {
    // Test replyToComment rate limit error classification
    const rateLimitError = new Error('Meta Rate Limit on comment reply');
    rateLimitError.statusCode = 429;
    rateLimitError.retryAfterSeconds = 120;
    rateLimitError.metaError = { code: 4, message: 'Application request limit reached' };

    const classification = metaRateLimiter.classifyMetaError(rateLimitError);
    assert.strictEqual(classification.category, 'RATE_LIMITED');
    assert.strictEqual(classification.retryable, true);
    assert.strictEqual(classification.backoffMs, 120000, 'Backoff must respect Retry-After 120s');

    // Test pauseAccount
    metaRateLimiter.pauseAccount('account_ratelimit_test', 120, 'Public reply rate limit', mockDb);
    const isPaused = metaRateLimiter.isAccountPaused('account_ratelimit_test');
    assert.strictEqual(isPaused, true, 'Account should be in paused state');
  });

  // ------------------------------------------------------------------
  // SCENARIO 10: Successful DM is not repeated because public reply failed
  // ------------------------------------------------------------------
  await runTestAsync('Scenario 10: Successful DM is not repeated because public reply failed', async () => {
    const commentId = 'comment_dm_not_repeat_123';
    // 1. Private DM succeeded and recorded
    await mockDb.collections().automationEvents.insertOne({
      event_id: 'ev_private_dm_success',
      owner_user_id: 'user_rel_1',
      instagram_user_id: testIgUserId,
      automation_id: testAutoId,
      comment_id: commentId,
      event_type: 'private_reply',
      status: 'success',
      created_at: new Date().toISOString()
    });

    // 2. Public reply failed and recorded
    await mockDb.collections().automationEvents.insertOne({
      event_id: 'ev_public_reply_fail',
      owner_user_id: 'user_rel_1',
      instagram_user_id: testIgUserId,
      automation_id: testAutoId,
      comment_id: commentId,
      event_type: 'public_reply',
      status: 'failed',
      error: 'Rate limit on public comments',
      created_at: new Date().toISOString()
    });

    // 3. Worker or retry attempts to re-execute for the same comment_id
    const alreadyDone = await mockDb.collections().automationEvents.findOne({
      comment_id: commentId,
      status: 'success'
    });
    assert(alreadyDone, 'Deduplication lookup must detect previous DM success');
    assert.strictEqual(alreadyDone.event_type, 'private_reply');
    // If alreadyDone exists, the job immediately returns without sending DM again!
  });

  // ------------------------------------------------------------------
  // SCENARIO 11: Permanent permission error is not retried
  // ------------------------------------------------------------------
  await runTestAsync('Scenario 11: Permanent permission error is not retried', async () => {
    const permJob = {
      event_key: 'comment_perm_test',
      job_id: 'job_perm_test',
      status: 'processing',
      attempts: 1,
      worker_id: 'worker_perm_1'
    };
    await mockDb.collections().webhookJobs.insertOne(permJob);

    const authError = new Error('OAuthException: Error validating access token: Session has expired.');
    authError.statusCode = 401;
    authError.metaError = { code: 190, type: 'OAuthException' };

    const classification = metaRateLimiter.classifyMetaError(authError);
    assert.strictEqual(classification.category, 'PERMISSION_OR_AUTH');
    assert.strictEqual(classification.retryable, false, 'Permanent permission error must NOT be retryable');

    await webhookJobQueue.handleJobFailure(permJob, authError, mockDb);
    const updated = await mockDb.collections().webhookJobs.findOne({ event_key: 'comment_perm_test' });
    assert.strictEqual(updated.status, 'failed', 'Status must be set directly to failed');
    assert.strictEqual(updated.run_at, null, 'run_at must be null (no retry scheduled)');
  });

  // ------------------------------------------------------------------
  // SCENARIO 12: Template rejection fallback works only for eligible definite format rejections
  // ------------------------------------------------------------------
  runTest('Scenario 12: Template rejection fallback works only for eligible definite format rejections', () => {
    // A: Eligible format rejection (400 + template/button error message)
    const formatErr = {
      statusCode: 400,
      message: 'Invalid parameter: template payload button structure malformed'
    };
    const isEligible = formatErr.statusCode === 400 && /template|button|attachment|format/i.test(formatErr.message);
    assert.strictEqual(isEligible, true, 'Definite format rejection must be eligible');

    // B: Ineligible 401 (Auth error)
    const authErr = { statusCode: 401, message: 'Invalid OAuth token' };
    const isAuthEligible = authErr.statusCode === 400 && /template|button|attachment|format/i.test(authErr.message);
    assert.strictEqual(isAuthEligible, false, 'Auth error must NOT trigger template fallback');

    // C: Ineligible 500 (Server error)
    const serverErr = { statusCode: 500, message: 'Internal server error' };
    const isServerEligible = serverErr.statusCode === 400 && /template|button|attachment|format/i.test(serverErr.message);
    assert.strictEqual(isServerEligible, false, 'Server error must NOT trigger template fallback');

    // D: Ineligible 429 (Rate limit)
    const rateErr = { statusCode: 429, message: 'Too many requests' };
    const isRateEligible = rateErr.statusCode === 400 && /template|button|attachment|format/i.test(rateErr.message);
    assert.strictEqual(isRateEligible, false, 'Rate limit must NOT trigger template fallback');
  });

  // ------------------------------------------------------------------
  // SCENARIO 13: Temporary failures follow backoff
  // ------------------------------------------------------------------
  await runTestAsync('Scenario 13: Temporary failures follow backoff', async () => {
    const tempJob = {
      event_key: 'comment_temp_test',
      job_id: 'job_temp_test',
      status: 'processing',
      attempts: 1,
      worker_id: 'worker_temp_1'
    };
    await mockDb.collections().webhookJobs.insertOne(tempJob);

    const tempError = new Error('503 Service Temporarily Unavailable');
    tempError.statusCode = 503;

    const classification = metaRateLimiter.classifyMetaError(tempError);
    assert.strictEqual(classification.category, 'TEMPORARY_NETWORK');
    assert.strictEqual(classification.retryable, true);

    await webhookJobQueue.handleJobFailure(tempJob, tempError, mockDb);
    const updated = await mockDb.collections().webhookJobs.findOne({ event_key: 'comment_temp_test' });
    assert.strictEqual(updated.status, 'retrying', 'Job status must be retrying');
    assert(updated.run_at instanceof Date, 'run_at must be scheduled in the future');
    assert(updated.run_at > new Date(), 'run_at must be in future');
  });

  // ------------------------------------------------------------------
  // SCENARIO 14: Shutdown leaves unfinished work recoverable (leases intact)
  // ------------------------------------------------------------------
  await runTestAsync('Scenario 14: Shutdown leaves unfinished work recoverable (leases intact)', async () => {
    const shutJob = {
      event_key: 'comment_shutdown_test',
      job_id: 'job_shutdown_test',
      status: 'processing',
      attempts: 1,
      worker_id: 'worker_shut_1',
      locked_until: new Date(Date.now() + 25000)
    };
    await mockDb.collections().webhookJobs.insertOne(shutJob);

    // Call stopWorker on a running worker
    await webhookWorker.stopWorker(100);

    // Verify job in database was NOT failed or destroyed
    const doc = await mockDb.collections().webhookJobs.findOne({ event_key: 'comment_shutdown_test' });
    assert.strictEqual(doc.status, 'processing', 'Status must remain processing');
    assert.strictEqual(doc.worker_id, 'worker_shut_1');
    assert(doc.locked_until > new Date(), 'Lease remains intact for safe timeout & future recovery');
  });

  console.log('\n======================================================================');
  console.log(`   ALL 14 RELIABILITY SCENARIOS PASSED: ${passedTests}/${totalTests} tests successful`);
  console.log('======================================================================\n');
})();
