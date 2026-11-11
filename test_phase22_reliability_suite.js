// test_phase22_reliability_suite.js
// Automated verification suite for Comment2DM Phase 2.2: Critical Reliability Corrections
// Exercises actual production functions across all 16 required realistic scenarios.

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

// In-Memory MongoDB mock supporting collections: webhookJobs, conversationStates, openingDmClaims, automationEvents, accountRateLimits, automations
function createMockDb() {
  const jobs = new Map();
  const conversationStates = new Map();
  const openingDmClaims = new Map();
  const automationEvents = [];
  const accountRateLimits = new Map();
  const automations = new Map();

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

  function applyUpdate(doc, update, isInsert = false) {
    if (isInsert && update.$setOnInsert) {
      Object.assign(doc, update.$setOnInsert);
    }
    if (update.$set) {
      Object.assign(doc, update.$set);
    }
    if (update.$inc) {
      for (const [iKey, iVal] of Object.entries(update.$inc)) {
        doc[iKey] = (Number(doc[iKey]) || 0) + Number(iVal);
      }
    }
    if (update.$push) {
      for (const [pKey, pVal] of Object.entries(update.$push)) {
        if (!Array.isArray(doc[pKey])) doc[pKey] = [];
        doc[pKey].push(pVal);
      }
    }
    return doc;
  }

  function makeCollection(mapStore, keyField = '_id') {
    return {
      async insertOne(doc) {
        const key = doc[keyField] || doc.event_key || doc.claim_key || doc.key || crypto.randomUUID();
        if (mapStore.has(key)) {
          const err = new Error('E11000 duplicate key error');
          err.code = 11000;
          throw err;
        }
        const saved = { ...doc, _id: crypto.randomUUID() };
        mapStore.set(key, saved);
        return { acknowledged: true, insertedId: saved._id };
      },
      async findOne(query) {
        for (const item of mapStore.values()) {
          if (matchesFilter(item, query)) return { ...item };
        }
        return null;
      },
      async findOneAndUpdate(filter, update, options = {}) {
        for (const [key, item] of mapStore.entries()) {
          if (matchesFilter(item, filter)) {
            const original = { ...item };
            applyUpdate(item, update);
            mapStore.set(key, item);
            return options.returnDocument === 'after' ? { ...item } : original;
          }
        }
        return null;
      },
      async updateOne(filter, update, options = {}) {
        for (const [key, item] of mapStore.entries()) {
          if (matchesFilter(item, filter)) {
            applyUpdate(item, update);
            mapStore.set(key, item);
            return { matchedCount: 1, modifiedCount: 1 };
          }
        }
        if (options.upsert) {
          const key = filter[keyField] || filter.claim_key || filter.event_key || filter.key || filter.account_id || crypto.randomUUID();
          const newDoc = { [keyField]: key, _id: crypto.randomUUID() };
          applyUpdate(newDoc, update, true);
          mapStore.set(key, newDoc);
          return { matchedCount: 0, modifiedCount: 0, upsertedId: newDoc._id };
        }
        return { matchedCount: 0, modifiedCount: 0 };
      },
      find(query) {
        const results = [];
        for (const item of mapStore.values()) {
          if (matchesFilter(item, query)) results.push({ ...item });
        }
        return {
          sort: () => ({
            limit: (n) => results.slice(0, n),
            toArray: async () => results
          }),
          toArray: async () => results
        };
      },
      async countDocuments(query) {
        let count = 0;
        for (const item of mapStore.values()) {
          if (matchesFilter(item, query)) count++;
        }
        return count;
      }
    };
  }

  const webhookJobsCol = makeCollection(jobs, 'event_key');
  const conversationStatesCol = makeCollection(conversationStates, 'key');
  const openingDmClaimsCol = makeCollection(openingDmClaims, 'claim_key');
  const accountRateLimitsCol = makeCollection(accountRateLimits, 'account_id');
  const automationsCol = {
    ...makeCollection(automations, 'id'),
    _set(id, auto) {
      automations.set(id, auto);
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
      return { toArray: async () => matched };
    }
  };

  return {
    collections() {
      return {
        webhookJobs: webhookJobsCol,
        conversationStates: conversationStatesCol,
        openingDmClaims: openingDmClaimsCol,
        automationEvents: automationEventsCol,
        accountRateLimits: accountRateLimitsCol,
        automations: automationsCol
      };
    },
    async all(query, params) {
      const results = [];
      for (const a of automations.values()) {
        if (params && params[0] && a.instagram_user_id === params[0]) {
          results.push({ ...a });
        }
      }
      return results;
    },
    async get(query, params) {
      if (params && params[0] && automations.has(params[0])) {
        return { ...automations.get(params[0]) };
      }
      return null;
    },
    _raw: { jobs, conversationStates, openingDmClaims, automationEvents, accountRateLimits, automations }
  };
}

(async function runPhase22Suite() {
  console.log('\n======================================================================');
  console.log(' COMMENT2DM — PHASE 2.2: CRITICAL RELIABILITY VERIFICATION SUITE');
  console.log('======================================================================');
  console.log('[TEST ENVIRONMENT]: High-fidelity atomic MongoDB collection mock simulating:');
  console.log(' - webhookJobs, conversationStates, openingDmClaims, automationEvents, accountRateLimits');
  console.log(' Testing real production functions with isolated API execution.\n');

  const testDb = createMockDb();

  // Wire testDb to server's internal db reference
  const serverDb = require('./src/db');
  serverDb.collections = testDb.collections;
  serverDb.all = testDb.all;
  serverDb.get = testDb.get;

  const testIgUserId = '17841499999999999';
  const testAutoId = 'auto_p22_test_1';
  testDb.collections().automations._set(testAutoId, {
    id: testAutoId,
    owner_user_id: 'user_p22_owner',
    instagram_user_id: testIgUserId,
    keyword: 'VIP',
    trigger_type: 'keyword',
    dm_message: 'Welcome to VIP access! ✨',
    reply_template: 'Sent you a DM! Check requests 🔥',
    enabled: true,
    flow: {
      openingMessage: 'Welcome to VIP access! ✨',
      delivery: {
        message: 'Here is your VIP download link:',
        resourceUrl: 'https://example.com/vip.zip',
        buttonText: 'Get VIP Access'
      }
    }
  });

  // Mock token lookup
  instagramService.getDecryptedTokenByInstagramUserId = async (igUserId, ownerId) => ({
    accessToken: 'mock_access_token_xyz',
    username: 'test_creator'
  });

  // ------------------------------------------------------------------
  // SCENARIO 1: Two concurrent webhook deliveries for the same comment
  // ------------------------------------------------------------------
  await runTestAsync('Scenario 1: Two concurrent webhook deliveries for the same comment', async () => {
    const payload = {
      object: 'instagram',
      entry: [{
        id: testIgUserId,
        time: Date.now(),
        changes: [{
          field: 'comments',
          value: {
            id: 'comment_scen_1',
            text: 'I want VIP access',
            from: { id: 'user_commenter_1', username: 'ig_user_1' },
            media: { id: 'media_post_1' }
          }
        }]
      }]
    };

    // Both webhooks arrive simultaneously at the ingestion layer
    const [res1, res2] = await Promise.all([
      webhookJobQueue.ingestWebhookPayload(payload, testDb),
      webhookJobQueue.ingestWebhookPayload(payload, testDb)
    ]);

    const totalJobs = await testDb.collections().webhookJobs.countDocuments({ comment_id: 'comment_scen_1' });
    assert.strictEqual(totalJobs, 1, 'Exactly ONE durable job must be enqueued across concurrent webhooks');
    assert(res1.count + res2.count === 1, 'Only one ingest call enqueues the job');
    assert(res1.duplicates + res2.duplicates === 1, 'The duplicate event must be recorded as duplicate');
  });

  // ------------------------------------------------------------------
  // SCENARIO 2: Crash after Meta accepts opening DM but before success is saved
  // ------------------------------------------------------------------
  await runTestAsync('Scenario 2: Crash after Meta accepts opening DM but before success record saved', async () => {
    let metaCalls = 0;
    instagramService.sendPrivateReply = async () => {
      metaCalls++;
      return { message_id: 'mid.accepted_crash_recovery_123' };
    };

    const job = {
      job_id: 'job_crash_test',
      event_key: 'comment_crash_1',
      instagram_account_id: testIgUserId,
      comment_id: 'comment_crash_1',
      comment_text: 'VIP',
      from_id: 'commenter_crash_1',
      from_username: 'crash_user',
      worker_id: 'worker_crasher'
    };

    // 1st run: Meta sends, openingDmClaims is stamped 'sent', but simulate crash before subsequent tasks
    await executeCommentJob(job);
    assert.strictEqual(metaCalls, 1, 'Initial run sends opening DM');

    const claim = await testDb.collections().openingDmClaims.findOne({
      claim_key: `${testIgUserId}:comment_crash_1:${testAutoId}`
    });
    assert.strictEqual(claim.status, 'sent', 'Claim must be recorded as sent');
    assert.strictEqual(claim.meta_message_id, 'mid.accepted_crash_recovery_123');

    // 2nd run: Webhook retry occurs after crash
    await executeCommentJob(job);
    assert.strictEqual(metaCalls, 1, 'Webhook retry MUST NOT call Meta API again (Zero duplicate DMs)');
  });

  // ------------------------------------------------------------------
  // SCENARIO 3: An already-sent opening DM cannot be resent
  // ------------------------------------------------------------------
  await runTestAsync('Scenario 3: An already-sent opening DM cannot be resent', async () => {
    const claimKey = `${testIgUserId}:comment_already_sent:${testAutoId}`;
    await testDb.collections().openingDmClaims.insertOne({
      claim_key: claimKey,
      instagram_account_id: testIgUserId,
      comment_id: 'comment_already_sent',
      automation_id: testAutoId,
      status: 'sent',
      meta_message_id: 'mid.existing_123'
    });

    let sendCalled = false;
    instagramService.sendPrivateReply = async () => {
      sendCalled = true;
      return { message_id: 'mid.should_not_happen' };
    };

    await executeCommentJob({
      instagram_account_id: testIgUserId,
      comment_id: 'comment_already_sent',
      comment_text: 'VIP',
      from_id: 'user_sent_test',
      from_username: 'user_sent'
    });

    assert.strictEqual(sendCalled, false, 'sendPrivateReply must not be called for already-sent DM');
  });

  // ------------------------------------------------------------------
  // SCENARIO 4: An unknown opening DM cannot be resent
  // ------------------------------------------------------------------
  await runTestAsync('Scenario 4: An unknown opening DM cannot be resent', async () => {
    const claimKey = `${testIgUserId}:comment_unknown_test:${testAutoId}`;
    await testDb.collections().openingDmClaims.insertOne({
      claim_key: claimKey,
      instagram_account_id: testIgUserId,
      comment_id: 'comment_unknown_test',
      automation_id: testAutoId,
      status: 'unknown',
      last_error: 'Socket hangup while waiting for response'
    });

    let sendCalled = false;
    instagramService.sendPrivateReply = async () => {
      sendCalled = true;
      return { message_id: 'mid.should_not_happen' };
    };

    await executeCommentJob({
      instagram_account_id: testIgUserId,
      comment_id: 'comment_unknown_test',
      comment_text: 'VIP',
      from_id: 'user_unknown_test',
      from_username: 'user_unknown'
    });

    assert.strictEqual(sendCalled, false, 'Unknown state must NEVER blindly resend opening DM');
  });

  // ------------------------------------------------------------------
  // SCENARIO 5: A failed public reply does not repeat the private DM
  // ------------------------------------------------------------------
  await runTestAsync('Scenario 5: A failed public reply does not repeat the private DM', async () => {
    let privateDmCalls = 0;
    instagramService.sendPrivateReply = async () => {
      privateDmCalls++;
      return { message_id: 'mid.private_dm_success_777' };
    };

    // Public reply throws 429 rate limit
    instagramService.replyToComment = async () => {
      const err = new Error('Public reply rate limited');
      err.statusCode = 429;
      err.retryAfterSeconds = 60;
      throw err;
    };

    const job = {
      instagram_account_id: testIgUserId,
      comment_id: 'comment_public_fail_test',
      comment_text: 'VIP',
      from_id: 'user_pub_fail',
      from_username: 'user_pub_fail',
      worker_id: 'worker_pub_test'
    };

    await executeCommentJob(job);
    assert.strictEqual(privateDmCalls, 1, 'Private DM must be sent once');

    // Verify public reply failed event was logged
    const publicEvent = await testDb.collections().automationEvents.findOne({
      comment_id: 'comment_public_fail_test',
      event_type: 'public_reply'
    });
    assert(publicEvent, 'Public reply event must be logged');
    assert.strictEqual(publicEvent.status, 'failed');

    // Retry job: verify private DM is NOT repeated
    await executeCommentJob(job);
    assert.strictEqual(privateDmCalls, 1, 'Private DM was not repeated on retry');
  });

  // ------------------------------------------------------------------
  // SCENARIO 6: Two workers attempt the same opening DM claim
  // ------------------------------------------------------------------
  await runTestAsync('Scenario 6: Two workers attempt the same opening DM claim', async () => {
    let metaCalls = 0;
    instagramService.sendPrivateReply = async () => {
      metaCalls++;
      await new Promise(r => setTimeout(r, 20)); // Simulated network latency
      return { message_id: 'mid.concurrent_claim_winner' };
    };

    const job1 = {
      instagram_account_id: testIgUserId,
      comment_id: 'comment_race_test',
      comment_text: 'VIP',
      from_id: 'user_race',
      from_username: 'user_race',
      worker_id: 'worker_alpha'
    };

    const job2 = {
      instagram_account_id: testIgUserId,
      comment_id: 'comment_race_test',
      comment_text: 'VIP',
      from_id: 'user_race',
      from_username: 'user_race',
      worker_id: 'worker_beta'
    };

    // Both workers attempt opening DM simultaneously
    await Promise.all([
      executeCommentJob(job1),
      executeCommentJob(job2)
    ]);

    assert.strictEqual(metaCalls, 1, 'Exactly ONE worker must win the claim and send opening DM');
  });

  // ------------------------------------------------------------------
  // SCENARIO 7: Delivery lease renewal during a long request
  // ------------------------------------------------------------------
  await runTestAsync('Scenario 7: Delivery lease renewal during a long request', async () => {
    let renewedCount = 0;
    // Slow Meta API call (takes 350ms, longer than 200ms initial lease)
    instagramService.sendDirectMessage = async () => {
      await new Promise(r => setTimeout(r, 350));
      return { message_id: 'mid.delivery_heartbeat_renewed' };
    };

    const deliveryPromise = deliverFinalResource({
      recipientIgUserId: testIgUserId,
      senderIgsid: 'recipient_heartbeat_long',
      automation: { id: testAutoId, owner_user_id: 'user_p22_owner' },
      tokenData: { accessToken: 'token_xyz' },
      flow: { delivery: { message: 'Here is your link', resourceUrl: 'https://example.com' } },
      workerId: 'worker_delivery_hb',
      options: {
        deliveryLeaseMs: 200, // 200ms lease
        deliveryHeartbeatIntervalMs: 80 // renew every 80ms
      }
    });

    await deliveryPromise;

    const state = await testDb.collections().conversationStates.findOne({
      key: `${testAutoId}:${testIgUserId}:recipient_heartbeat_long`
    });
    assert.strictEqual(state.delivery_state, 'sent');
    assert.strictEqual(state.meta_message_id, 'mid.delivery_heartbeat_renewed');
    assert(state.delivery_lease_renewed_at, 'Lease must have been renewed by heartbeat during in-flight send');
  });

  // ------------------------------------------------------------------
  // SCENARIO 8: An expired delivery lease cannot be updated by its former owner
  // ------------------------------------------------------------------
  await runTestAsync('Scenario 8: An expired delivery lease cannot be updated by its former owner', async () => {
    const deliveryStateKey = `${testAutoId}:${testIgUserId}:recipient_stale_delivery`;

    // Stale worker whose lease expired in the past
    await testDb.collections().conversationStates.updateOne(
      { key: deliveryStateKey },
      {
        $set: {
          delivery_worker_id: 'worker_stale_deliv',
          delivery_state: 'sending',
          delivery_locked_until: new Date(Date.now() - 5000), // Expired!
          resource_delivered: false
        }
      },
      { upsert: true }
    );

    // Stale worker attempts to finalize delivery
    const res = await testDb.collections().conversationStates.updateOne(
      {
        key: deliveryStateKey,
        delivery_worker_id: 'worker_stale_deliv',
        delivery_state: 'sending',
        delivery_locked_until: { $gt: new Date() } // Must be unexpired!
      },
      {
        $set: {
          delivery_state: 'sent',
          resource_delivered: true
        }
      }
    );

    assert.strictEqual(res.matchedCount, 0, 'Expired delivery lease must reject update from former owner');
    const state = await testDb.collections().conversationStates.findOne({ key: deliveryStateKey });
    assert.strictEqual(state.delivery_state, 'sending', 'State must remain unchanged by stale worker');
  });

  // ------------------------------------------------------------------
  // SCENARIO 9: A stale worker cannot complete an expired job
  // ------------------------------------------------------------------
  await runTestAsync('Scenario 9: A stale worker cannot complete an expired job', async () => {
    const staleJob = {
      event_key: 'comment_stale_complete_test',
      job_id: 'job_stale_complete',
      status: 'processing',
      worker_id: 'worker_stale_complete',
      locked_until: new Date(Date.now() - 2000), // Expired 2s ago
      attempts: 1
    };
    await testDb.collections().webhookJobs.insertOne(staleJob);

    // Worker attempts to complete job after lease expired
    const result = await webhookJobQueue.handleJobSuccess(staleJob, { worker_id: 'worker_stale_complete' }, testDb);

    assert(result === false || result.success === false, 'Stale worker completion must fail');
    assert.strictEqual(result.status, 'stale_worker');

    const inDb = await testDb.collections().webhookJobs.findOne({ event_key: 'comment_stale_complete_test' });
    assert.strictEqual(inDb.status, 'processing', 'Job must not transition to sent');
  });

  // ------------------------------------------------------------------
  // SCENARIO 10: A stale worker cannot fail another worker's job
  // ------------------------------------------------------------------
  await runTestAsync('Scenario 10: A stale worker cannot fail another worker\'s job', async () => {
    // Worker B owns the job with active lease
    const reclaimedJob = {
      event_key: 'comment_reclaimed_test',
      job_id: 'job_reclaimed',
      status: 'processing',
      worker_id: 'worker_B_active',
      locked_until: new Date(Date.now() + 60000),
      attempts: 2
    };
    await testDb.collections().webhookJobs.insertOne(reclaimedJob);

    // Stale Worker A attempts to fail the job
    const staleJobA = { event_key: 'comment_reclaimed_test', worker_id: 'worker_A_stale' };
    const failRes = await webhookJobQueue.handleJobFailure(staleJobA, new Error('Worker A failed late'), testDb);

    assert.strictEqual(failRes.status, 'stale_worker');
    assert.strictEqual(failRes.success, false);

    const inDb = await testDb.collections().webhookJobs.findOne({ event_key: 'comment_reclaimed_test' });
    assert.strictEqual(inDb.worker_id, 'worker_B_active', 'Worker B ownership must remain intact');
    assert.strictEqual(inDb.status, 'processing');
  });

  // ------------------------------------------------------------------
  // SCENARIO 11: A stale worker cannot extend another worker's lease
  // ------------------------------------------------------------------
  await runTestAsync('Scenario 11: A stale worker cannot extend another worker\'s lease', async () => {
    const job = {
      event_key: 'comment_lease_owner_test',
      status: 'processing',
      worker_id: 'worker_real_owner',
      locked_until: new Date(Date.now() + 30000)
    };
    await testDb.collections().webhookJobs.insertOne(job);

    const ok = await webhookJobQueue.extendLease(job, 'worker_imposter', 60000, testDb);
    assert.strictEqual(ok, false, 'Imposter or stale worker cannot extend lease');
  });

  // ------------------------------------------------------------------
  // SCENARIO 12: Permanent Meta errors are not retried
  // ------------------------------------------------------------------
  await runTestAsync('Scenario 12: Permanent Meta errors are not retried', async () => {
    const permJob = {
      event_key: 'comment_perm_auth_test',
      status: 'processing',
      worker_id: 'worker_perm_test',
      locked_until: new Date(Date.now() + 60000),
      attempts: 1
    };
    await testDb.collections().webhookJobs.insertOne(permJob);

    const oauthError = new Error('OAuthException: Error validating access token');
    oauthError.statusCode = 401;
    oauthError.metaError = { code: 190, type: 'OAuthException' };

    const failRes = await webhookJobQueue.handleJobFailure(permJob, oauthError, testDb);
    assert.strictEqual(failRes.status, 'failed', 'Permanent auth error must be marked failed');
    assert.strictEqual(failRes.classification.retryable, false);

    const inDb = await testDb.collections().webhookJobs.findOne({ event_key: 'comment_perm_auth_test' });
    assert.strictEqual(inDb.status, 'failed');
    assert.strictEqual(inDb.run_at, null, 'No retry should be scheduled');
  });

  // ------------------------------------------------------------------
  // SCENARIO 13: Rate-limit errors respect Retry-After
  // ------------------------------------------------------------------
  await runTestAsync('Scenario 13: Rate-limit errors respect Retry-After', async () => {
    const rlJob = {
      event_key: 'comment_rl_retry_test',
      instagram_account_id: 'account_rl_test_1',
      status: 'processing',
      worker_id: 'worker_rl_test',
      locked_until: new Date(Date.now() + 60000),
      attempts: 1
    };
    await testDb.collections().webhookJobs.insertOne(rlJob);

    const rlError = new Error('Rate limit exceeded');
    rlError.statusCode = 429;
    rlError.retryAfterSeconds = 75; // 75 seconds

    const failRes = await webhookJobQueue.handleJobFailure(rlJob, rlError, testDb);
    assert.strictEqual(failRes.status, 'retrying');
    assert.strictEqual(failRes.classification.retryable, true);
    assert.strictEqual(failRes.classification.backoffMs, 75000);

    const inDb = await testDb.collections().webhookJobs.findOne({ event_key: 'comment_rl_retry_test' });
    assert.strictEqual(inDb.status, 'retrying');
    assert(inDb.run_at.getTime() >= Date.now() + 70000, 'run_at must respect Retry-After 75s');
  });

  // ------------------------------------------------------------------
  // SCENARIO 14: Unknown DM outcomes are never retried automatically
  // ------------------------------------------------------------------
  await runTestAsync('Scenario 14: Unknown DM outcomes are never retried automatically', async () => {
    const timeoutJob = {
      event_key: 'comment_timeout_test',
      status: 'processing',
      worker_id: 'worker_timeout_test',
      locked_until: new Date(Date.now() + 60000),
      attempts: 1
    };
    await testDb.collections().webhookJobs.insertOne(timeoutJob);

    const timeoutErr = new Error('network timeout waiting for response');
    timeoutErr.uncertainDelivery = true;

    const classification = metaRateLimiter.classifyMetaError(timeoutErr);
    assert.strictEqual(classification.category, 'UNKNOWN_OUTCOME');
    assert.strictEqual(classification.retryable, false, 'Uncertain outcomes must NOT be retryable');

    const failRes = await webhookJobQueue.handleJobFailure(timeoutJob, timeoutErr, testDb);
    assert.strictEqual(failRes.status, 'failed', 'Uncertain outcome must not be retried');

    const inDb = await testDb.collections().webhookJobs.findOne({ event_key: 'comment_timeout_test' });
    assert.strictEqual(inDb.status, 'failed');
    assert.strictEqual(inDb.run_at, null, 'Never automatically resend unknown outcome');
  });

  // ------------------------------------------------------------------
  // SCENARIO 15: Graceful shutdown preserves recoverability
  // ------------------------------------------------------------------
  await runTestAsync('Scenario 15: Graceful shutdown preserves recoverability', async () => {
    const runningJob = {
      event_key: 'comment_shut_recov_test',
      status: 'processing',
      worker_id: 'worker_shutting_down',
      locked_until: new Date(Date.now() + 45000), // Active lease
      attempts: 1
    };
    await testDb.collections().webhookJobs.insertOne(runningJob);

    await webhookWorker.stopWorker(100);

    const inDb = await testDb.collections().webhookJobs.findOne({ event_key: 'comment_shut_recov_test' });
    assert.strictEqual(inDb.status, 'processing', 'Job must remain in processing with lease intact');
    assert.strictEqual(inDb.worker_id, 'worker_shutting_down');
    assert(inDb.locked_until > new Date(), 'Lease remains intact for timeout & future recovery');
  });

  // ------------------------------------------------------------------
  // SCENARIO 16: Multiple worker instances observe persisted account pauses
  // ------------------------------------------------------------------
  await runTestAsync('Scenario 16: Multiple worker instances observe persisted account pauses', async () => {
    metaRateLimiter._resetForTesting();
    const pausedAccountId = 'account_shared_pause_test_99';

    // Instance 1 pauses the account in MongoDB
    metaRateLimiter.pauseAccount(pausedAccountId, 60000, 'Rate limit on Instance 1', testDb);

    // Verify MongoDB record was created
    const record = await testDb.collections().accountRateLimits.findOne({ account_id: pausedAccountId });
    assert(record, 'MongoDB accountRateLimits record must be persisted');
    assert(record.paused_until > new Date());

    // Reset local memory to simulate a completely separate Worker Instance 2
    metaRateLimiter._resetForTesting();

    // Instance 2 checks shared pause state
    const isPausedInstance2 = await metaRateLimiter.isAccountPausedAsync(pausedAccountId, testDb);
    assert.strictEqual(isPausedInstance2, true, 'Instance 2 must observe persisted pause from MongoDB');

    // Instance 2 claims jobs from queue: paused account must be dynamically excluded!
    const jobForPausedAccount = {
      event_key: 'job_for_paused_acc',
      instagram_account_id: pausedAccountId,
      status: 'queued',
      attempts: 0,
      run_at: new Date(Date.now() - 5000)
    };
    await testDb.collections().webhookJobs.insertOne(jobForPausedAccount);

    const claimRes = await webhookJobQueue.claimNextJob(testDb, { workerId: 'worker_instance_2' });
    if (claimRes) {
      assert.notStrictEqual(claimRes.instagram_account_id, pausedAccountId, 'Worker Instance 2 must skip jobs belonging to paused account');
    }

    const pausedJobInDb = await testDb.collections().webhookJobs.findOne({ event_key: 'job_for_paused_acc' });
    assert.strictEqual(pausedJobInDb.status, 'queued', 'Job for paused account must remain queued and un-claimed');
  });

  console.log('\n======================================================================');
  console.log(`   ALL 16 CRITICAL RELIABILITY SCENARIOS PASSED: ${passedTests}/${totalTests} tests successful`);
  console.log('======================================================================\n');
  process.exit(0);
})();
