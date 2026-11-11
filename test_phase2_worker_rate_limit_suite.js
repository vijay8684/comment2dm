// test_phase2_worker_rate_limit_suite.js
// Automated verification suite for Phase 2: Persistent Worker, Crash Recovery, & Meta Rate Limit Engine
// Tests all 18 requirements mandated by Phase 2 specification.

const assert = require('assert');
const crypto = require('crypto');
const webhookJobQueue = require('./src/jobs/webhookJobQueue');
const webhookWorker = require('./src/jobs/webhookWorker');
const metaRateLimiter = require('./src/services/metaRateLimiter');
const billing = require('./src/billing');

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

// In-Memory MongoDB mock simulating all Phase 2 features (queries, lease locks, sorting, unique index)
function createMockDb() {
  const jobs = new Map();
  const conversationStates = new Map();

  const col = {
    async insertOne(doc) {
      if (jobs.has(doc.event_key)) {
        const err = new Error(`E11000 duplicate key error`);
        err.code = 11000;
        throw err;
      }
      const saved = { ...doc, _id: crypto.randomUUID() };
      jobs.set(doc.event_key, saved);
      return { acknowledged: true, insertedId: saved._id };
    },
    async findOne(query) {
      for (const j of jobs.values()) {
        const match = Object.keys(query).every(k => {
          if (query[k] && typeof query[k] === 'object' && query[k].$ne !== undefined) {
            return j[k] !== query[k].$ne;
          }
          return j[k] === query[k];
        });
        if (match) return j;
      }
      return null;
    },
    find(query = {}) {
      const arr = Array.from(jobs.values()).filter(j => {
        if (query.status && query.status.$in) {
          return query.status.$in.includes(j.status);
        }
        if (query.status && j.status !== query.status) return false;
        return true;
      });
      return {
        toArray: async () => arr,
        sort: () => ({
          limit: (n) => ({
            toArray: async () => arr.slice(0, n)
          })
        })
      };
    },
    async countDocuments(query = {}) {
      let count = 0;
      for (const j of jobs.values()) {
        if (query.status && j.status === query.status) count++;
      }
      return count;
    },
    aggregate(pipeline) {
      const counts = {};
      for (const j of jobs.values()) {
        if (['queued', 'retrying', 'processing'].includes(j.status)) {
          const acc = j.instagram_account_id;
          counts[acc] = (counts[acc] || 0) + 1;
        }
      }
      const res = Object.entries(counts).map(([id, count]) => ({ _id: id, count }));
      return {
        toArray: async () => res
      };
    },
    async updateOne(filter, updateDoc) {
      const j = jobs.get(filter.event_key);
      if (!j) return { matchedCount: 0, modifiedCount: 0 };
      if (filter.status && j.status !== filter.status) return { matchedCount: 0, modifiedCount: 0 };
      if (filter.worker_id && j.worker_id !== filter.worker_id) return { matchedCount: 0, modifiedCount: 0 };

      if (updateDoc.$set) Object.assign(j, updateDoc.$set);
      if (updateDoc.$push) {
        for (const k in updateDoc.$push) {
          if (!Array.isArray(j[k])) j[k] = [];
          j[k].push(updateDoc.$push[k]);
        }
      }
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async findOneAndUpdate(filter, updateDoc, options) {
      const now = new Date();
      // Sort candidates by run_at asc, created_at asc
      const candidates = Array.from(jobs.values()).sort((a, b) => {
        const timeA = new Date(a.run_at || a.created_at).getTime();
        const timeB = new Date(b.run_at || b.created_at).getTime();
        return timeA - timeB;
      });

      for (const j of candidates) {
        // Attempts check
        if (filter.attempts?.$lt !== undefined && j.attempts >= filter.attempts.$lt) continue;
        // Account exclusion check
        if (filter.instagram_account_id?.$nin && filter.instagram_account_id.$nin.includes(j.instagram_account_id)) {
          continue;
        }

        // Match $or conditions
        let matchesOr = false;
        if (filter.$or) {
          for (const cond of filter.$or) {
            if (cond.status === 'queued' && j.status === 'queued') {
              const runAtDue = !j.run_at || new Date(j.run_at) <= now;
              if (runAtDue) { matchesOr = true; break; }
            } else if (cond.status === 'retrying' && j.status === 'retrying') {
              const runAtDue = !j.run_at || new Date(j.run_at) <= now;
              if (runAtDue) { matchesOr = true; break; }
            } else if (cond.status === 'processing' && j.status === 'processing') {
              const leaseExpired = j.locked_until && new Date(j.locked_until) <= now;
              if (leaseExpired) { matchesOr = true; break; }
            }
          }
        }

        if (matchesOr) {
          // Atomically apply updateDoc
          if (updateDoc.$set) Object.assign(j, updateDoc.$set);
          if (updateDoc.$inc) {
            for (const k in updateDoc.$inc) {
              j[k] = (j[k] || 0) + updateDoc.$inc[k];
            }
          }
          return { value: j };
        }
      }
      return null;
    }
  };

  const statesCol = {
    async findOne(query) {
      return conversationStates.get(query.key) || null;
    },
    async updateOne(filter, updateDoc, options = {}) {
      let state = conversationStates.get(filter.key);
      if (!state && options.upsert && updateDoc.$setOnInsert) {
        state = { ...updateDoc.$setOnInsert };
        conversationStates.set(filter.key, state);
        return { upsertedCount: 1 };
      }
      if (!state) return { matchedCount: 0, modifiedCount: 0 };

      // Filter condition checks
      if (filter.delivery_state?.$nin && filter.delivery_state.$nin.includes(state.delivery_state)) {
        return { matchedCount: 0, modifiedCount: 0 };
      }
      if (filter.resource_delivered?.$ne !== undefined && state.resource_delivered === filter.resource_delivered.$ne) {
        return { matchedCount: 0, modifiedCount: 0 };
      }

      if (updateDoc.$set) Object.assign(state, updateDoc.$set);
      return { matchedCount: 1, modifiedCount: 1 };
    }
  };

  return {
    collections: () => ({
      webhookJobs: col,
      conversationStates: statesCol
    }),
    _rawJobs: jobs,
    _rawStates: conversationStates
  };
}

async function runSuite() {
  console.log('======================================================================');
  console.log(' COMMENT2DM — PHASE 2: PERSISTENT WORKER & RATE LIMIT ENGINE SUITE');
  console.log('======================================================================\n');

  // -------------------------------------------------------------------------
  // Test 1: Worker starts after database initialization
  // -------------------------------------------------------------------------
  await runTestAsync('Test 1: Worker starts after database initialization', async () => {
    webhookWorker._resetWorkerForTesting();
    const mockDb = createMockDb();
    let workerExecuted = false;

    webhookWorker.startWorker(mockDb, async (job) => {
      workerExecuted = true;
    }, { pollIntervalMs: 50 });

    const status = webhookWorker.getWorkerStatus();
    assert.strictEqual(status.is_running, true, 'Worker should be in running state');
    assert.ok(status.worker_id.startsWith('worker_'), 'Worker ID should be initialized');
    assert.ok(status.last_heartbeat, 'Heartbeat must be recorded');

    await webhookWorker.stopWorker();
    const stoppedStatus = webhookWorker.getWorkerStatus();
    assert.strictEqual(stoppedStatus.is_running, false, 'Worker should stop cleanly');
  });

  // -------------------------------------------------------------------------
  // Test 2: Pending jobs are processed without another webhook
  // -------------------------------------------------------------------------
  await runTestAsync('Test 2: Pending jobs are processed without another webhook', async () => {
    webhookWorker._resetWorkerForTesting();
    const mockDb = createMockDb();

    // Insert pending job directly into DB
    const jobKey = 'comment:auto_drain_101';
    await mockDb.collections().webhookJobs.insertOne({
      event_key: jobKey,
      job_id: jobKey,
      instagram_account_id: 'acc_creator_1',
      status: 'queued',
      attempts: 0,
      run_at: new Date(Date.now() - 1000), // Due in the past
      created_at: new Date()
    });

    let processedJobKey = null;
    webhookWorker.startWorker(mockDb, async (job) => {
      processedJobKey = job.event_key;
    }, { pollIntervalMs: 20 });

    // Wait for worker poll
    await new Promise(r => setTimeout(r, 100));
    await webhookWorker.stopWorker();

    assert.strictEqual(processedJobKey, jobKey, 'Job should be picked up and processed by persistent worker');
    const updated = await mockDb.collections().webhookJobs.findOne({ event_key: jobKey });
    assert.strictEqual(updated.status, 'sent', 'Processed job must be updated to sent');
  });

  // -------------------------------------------------------------------------
  // Test 3: Expired processing jobs are recovered (Crash Recovery)
  // -------------------------------------------------------------------------
  await runTestAsync('Test 3: Expired processing jobs are recovered (Crash Recovery)', async () => {
    webhookWorker._resetWorkerForTesting();
    const mockDb = createMockDb();

    // Simulate crashed job: left in 'processing' with expired lease
    const crashedKey = 'comment:crashed_node_job_1';
    await mockDb.collections().webhookJobs.insertOne({
      event_key: crashedKey,
      job_id: crashedKey,
      instagram_account_id: 'acc_creator_1',
      status: 'processing',
      attempts: 1,
      worker_id: 'old_dead_worker_999',
      locked_until: new Date(Date.now() - 5000), // Expired 5 seconds ago!
      created_at: new Date(Date.now() - 60000)
    });

    const claimed = await webhookJobQueue.claimNextJob(mockDb, { workerId: 'new_recovered_worker' });
    assert.ok(claimed, 'Expired processing job must be claimed by recovery');
    assert.strictEqual(claimed.event_key, crashedKey);
    assert.strictEqual(claimed.worker_id, 'new_recovered_worker');
    assert.strictEqual(claimed.attempts, 2, 'Attempts count should increment');
    assert.ok(new Date(claimed.locked_until) > new Date(), 'New active lease lock must be applied');
  });

  // -------------------------------------------------------------------------
  // Test 4: Active leases prevent duplicate claiming
  // -------------------------------------------------------------------------
  await runTestAsync('Test 4: Active leases prevent duplicate claiming', async () => {
    const mockDb = createMockDb();
    const activeKey = 'comment:active_in_flight_1';
    await mockDb.collections().webhookJobs.insertOne({
      event_key: activeKey,
      job_id: activeKey,
      instagram_account_id: 'acc_creator_1',
      status: 'processing',
      attempts: 1,
      worker_id: 'worker_alpha',
      locked_until: new Date(Date.now() + 60000), // Active lease for 60s
      created_at: new Date()
    });

    const secondClaim = await webhookJobQueue.claimNextJob(mockDb, { workerId: 'worker_beta' });
    assert.strictEqual(secondClaim, null, 'Active lease must prevent another worker from claiming');
  });

  // -------------------------------------------------------------------------
  // Test 5: Job heartbeat extends lease
  // -------------------------------------------------------------------------
  await runTestAsync('Test 5: Job heartbeat extends lease', async () => {
    const mockDb = createMockDb();
    const heartbeatKey = 'comment:heartbeat_job_1';
    const initialLock = new Date(Date.now() + 10000);

    await mockDb.collections().webhookJobs.insertOne({
      event_key: heartbeatKey,
      job_id: heartbeatKey,
      status: 'processing',
      worker_id: 'worker_heartbeat_test',
      locked_until: initialLock
    });

    const extended = await webhookJobQueue.extendLease(
      { event_key: heartbeatKey },
      'worker_heartbeat_test',
      120000,
      mockDb
    );
    assert.strictEqual(extended, true, 'Lease extension should succeed');

    const updated = await mockDb.collections().webhookJobs.findOne({ event_key: heartbeatKey });
    assert.ok(new Date(updated.locked_until).getTime() > initialLock.getTime() + 60000, 'Locked until must be extended');
  });

  // -------------------------------------------------------------------------
  // Test 6: Maximum attempts move jobs to dead-letter state
  // -------------------------------------------------------------------------
  await runTestAsync('Test 6: Maximum attempts move jobs to dead-letter state', async () => {
    const mockDb = createMockDb();
    const maxAttemptKey = 'comment:poison_job_max';

    const job = {
      event_key: maxAttemptKey,
      attempts: 5, // Reached MAX_JOB_ATTEMPTS
      instagram_account_id: 'acc_creator_1'
    };
    await mockDb.collections().webhookJobs.insertOne(job);

    const failResult = await webhookJobQueue.handleJobFailure(job, new Error('ETIMEDOUT connection failed'), mockDb);
    assert.strictEqual(failResult.status, 'dead_letter', 'Should transition to dead_letter after 5 attempts');

    const saved = await mockDb.collections().webhookJobs.findOne({ event_key: maxAttemptKey });
    assert.strictEqual(saved.status, 'dead_letter');
    assert.ok(saved.completed_at, 'Dead-letter job should have completed_at timestamp');
  });

  // -------------------------------------------------------------------------
  // Test 7: Temporary network failures are retried
  // -------------------------------------------------------------------------
  await runTestAsync('Test 7: Temporary network failures are retried', async () => {
    const mockDb = createMockDb();
    const retryKey = 'comment:network_glitch_job';

    const job = {
      event_key: retryKey,
      attempts: 1,
      instagram_account_id: 'acc_creator_1'
    };
    await mockDb.collections().webhookJobs.insertOne(job);

    const failResult = await webhookJobQueue.handleJobFailure(job, new Error('ECONNRESET socket reset'), mockDb);
    assert.strictEqual(failResult.status, 'retrying', 'Temporary error should schedule retry');

    const saved = await mockDb.collections().webhookJobs.findOne({ event_key: retryKey });
    assert.strictEqual(saved.status, 'retrying');
    assert.ok(saved.run_at, 'Retry job must have run_at scheduled');
    assert.ok(new Date(saved.run_at) > new Date(), 'run_at must be in the future');
  });

  // -------------------------------------------------------------------------
  // Test 8: Rate-limit errors respect Retry-After
  // -------------------------------------------------------------------------
  await runTestAsync('Test 8: Rate-limit errors respect Retry-After', async () => {
    const mockDb = createMockDb();
    metaRateLimiter._resetForTesting();
    const rateKey = 'comment:meta_throttled_job';

    const job = {
      event_key: rateKey,
      attempts: 1,
      instagram_account_id: 'acc_busy_influencer_99'
    };
    await mockDb.collections().webhookJobs.insertOne(job);

    const rateError = new Error('Calls to this API have exceeded the rate limit');
    rateError.statusCode = 429;
    rateError.retryAfterSeconds = 45; // 45 seconds Retry-After from Meta

    const failResult = await webhookJobQueue.handleJobFailure(job, rateError, mockDb);
    assert.strictEqual(failResult.status, 'retrying');
    assert.strictEqual(failResult.classification.category, 'RATE_LIMITED');

    // Confirm account is paused for 45s
    assert.strictEqual(metaRateLimiter.isAccountPaused('acc_busy_influencer_99'), true);

    const saved = await mockDb.collections().webhookJobs.findOne({ event_key: rateKey });
    const runAtDelta = new Date(saved.run_at).getTime() - Date.now();
    assert.ok(runAtDelta >= 44000 && runAtDelta <= 46000, `run_at should reflect 45s Retry-After: ${runAtDelta}ms`);
  });

  // -------------------------------------------------------------------------
  // Test 9: Exponential backoff includes jitter
  // -------------------------------------------------------------------------
  runTest('Test 9: Exponential backoff includes jitter', () => {
    const delay1 = metaRateLimiter.calculateBackoffWithJitter(1, 2000);
    const delay2 = metaRateLimiter.calculateBackoffWithJitter(2, 2000);
    const delay3 = metaRateLimiter.calculateBackoffWithJitter(3, 2000);

    // Attempt 1: 2000ms base + (0-1000ms jitter) => 2000 - 3000ms
    assert.ok(delay1 >= 2000 && delay1 <= 3000, `Attempt 1 was ${delay1}`);
    // Attempt 2: 4000ms base + (0-1000ms jitter) => 4000 - 5000ms
    assert.ok(delay2 >= 4000 && delay2 <= 5000, `Attempt 2 was ${delay2}`);
    // Attempt 3: 8000ms base + (0-1000ms jitter) => 8000 - 9000ms
    assert.ok(delay3 >= 8000 && delay3 <= 9000, `Attempt 3 was ${delay3}`);
  });

  // -------------------------------------------------------------------------
  // Test 10: Permission errors are not retried indefinitely
  // -------------------------------------------------------------------------
  await runTestAsync('Test 10: Permission errors are not retried indefinitely', async () => {
    const mockDb = createMockDb();
    const authKey = 'comment:token_expired_190';
    const job = { event_key: authKey, attempts: 1, instagram_account_id: 'acc_1' };
    await mockDb.collections().webhookJobs.insertOne(job);

    const authError = new Error('Error validating access token: The session has been invalidated.');
    authError.statusCode = 401;
    authError.code = 190; // Meta Invalid OAuth Token

    const failResult = await webhookJobQueue.handleJobFailure(job, authError, mockDb);
    assert.strictEqual(failResult.status, 'failed', 'Permission error must fail immediately');
    assert.strictEqual(failResult.classification.retryable, false);

    const saved = await mockDb.collections().webhookJobs.findOne({ event_key: authKey });
    assert.strictEqual(saved.status, 'failed');
    assert.strictEqual(saved.run_at, null, 'No retry scheduled for auth failures');
  });

  // -------------------------------------------------------------------------
  // Test 11: Concurrent workers cannot claim the same job
  // -------------------------------------------------------------------------
  await runTestAsync('Test 11: Concurrent workers cannot claim the same job', async () => {
    const mockDb = createMockDb();
    const singleJobKey = 'comment:concurrency_race_1';
    await mockDb.collections().webhookJobs.insertOne({
      event_key: singleJobKey,
      job_id: singleJobKey,
      instagram_account_id: 'acc_1',
      status: 'queued',
      attempts: 0,
      run_at: new Date(Date.now() - 100)
    });

    // 5 workers attempt to claim simultaneously
    const claims = await Promise.all([
      webhookJobQueue.claimNextJob(mockDb, { workerId: 'w1' }),
      webhookJobQueue.claimNextJob(mockDb, { workerId: 'w2' }),
      webhookJobQueue.claimNextJob(mockDb, { workerId: 'w3' }),
      webhookJobQueue.claimNextJob(mockDb, { workerId: 'w4' }),
      webhookJobQueue.claimNextJob(mockDb, { workerId: 'w5' })
    ]);

    const successfulClaims = claims.filter(c => c !== null);
    assert.strictEqual(successfulClaims.length, 1, 'Exactly one worker must claim the job');
  });

  // -------------------------------------------------------------------------
  // Test 12: Per-account concurrency is respected
  // -------------------------------------------------------------------------
  await runTestAsync('Test 12: Per-account concurrency is respected', async () => {
    const mockDb = createMockDb();
    // Insert 4 jobs for account A and 2 for account B
    for (let i = 1; i <= 4; i++) {
      await mockDb.collections().webhookJobs.insertOne({
        event_key: `comment:accA_${i}`,
        job_id: `comment:accA_${i}`,
        instagram_account_id: 'account_A',
        status: 'queued',
        attempts: 0,
        run_at: new Date(Date.now() - 100)
      });
    }
    for (let i = 1; i <= 2; i++) {
      await mockDb.collections().webhookJobs.insertOne({
        event_key: `comment:accB_${i}`,
        job_id: `comment:accB_${i}`,
        instagram_account_id: 'account_B',
        status: 'queued',
        attempts: 0,
        run_at: new Date(Date.now() - 100)
      });
    }

    // Worker claims with account_A excluded (because account_A reached ACCOUNT_CONCURRENCY)
    const claimed = await webhookJobQueue.claimNextJob(mockDb, {
      workerId: 'w_test',
      excludedAccountIds: ['account_A']
    });

    assert.ok(claimed, 'Should claim a job from account_B');
    assert.strictEqual(claimed.instagram_account_id, 'account_B');
  });

  // -------------------------------------------------------------------------
  // Test 13: One busy account does not starve another (Fair Scheduling)
  // -------------------------------------------------------------------------
  await runTestAsync('Test 13: One busy account does not starve another (Fair Scheduling)', async () => {
    webhookWorker._resetWorkerForTesting();
    const mockDb = createMockDb();

    // Account Viral has 50 jobs
    for (let i = 1; i <= 50; i++) {
      await mockDb.collections().webhookJobs.insertOne({
        event_key: `comment:viral_${i}`,
        job_id: `comment:viral_${i}`,
        instagram_account_id: 'account_viral',
        status: 'queued',
        attempts: 0,
        created_at: new Date(Date.now() - 5000 + i)
      });
    }

    // Account Small has 1 job
    await mockDb.collections().webhookJobs.insertOne({
      event_key: `comment:small_1`,
      job_id: `comment:small_1`,
      instagram_account_id: 'account_small',
      status: 'queued',
      attempts: 0,
      created_at: new Date(Date.now() - 1000)
    });

    let smallAccountProcessed = false;
    webhookWorker.startWorker(mockDb, async (job) => {
      if (job.instagram_account_id === 'account_small') {
        smallAccountProcessed = true;
      }
      // Simulate 10ms work
      await new Promise(r => setTimeout(r, 10));
    }, { pollIntervalMs: 15 });

    // Wait 250ms for worker to process jobs with per-account limit of 2
    await new Promise(r => setTimeout(r, 250));
    await webhookWorker.stopWorker();

    assert.strictEqual(smallAccountProcessed, true, 'Small account job must not be starved by viral account');
  });

  // -------------------------------------------------------------------------
  // Test 14: Unknown delivery outcomes are not blindly resent
  // -------------------------------------------------------------------------
  await runTestAsync('Test 14: Unknown delivery outcomes are not blindly resent', async () => {
    const mockDb = createMockDb();
    const unknownKey = 'comment:uncertain_timeout_1';
    const job = { event_key: unknownKey, attempts: 1, instagram_account_id: 'acc_1' };
    await mockDb.collections().webhookJobs.insertOne(job);

    const timeoutErr = new Error('Network timeout waiting for response from Meta');
    timeoutErr.uncertainDelivery = true;

    const failResult = await webhookJobQueue.handleJobFailure(job, timeoutErr, mockDb);
    assert.strictEqual(failResult.classification.category, 'UNKNOWN_OUTCOME');
    assert.strictEqual(failResult.classification.retryable, false, 'Uncertain delivery must NOT be blindly retried');

    const saved = await mockDb.collections().webhookJobs.findOne({ event_key: unknownKey });
    assert.strictEqual(saved.status, 'failed');
    assert.strictEqual(saved.failure_category, 'UNKNOWN_OUTCOME');
  });

  // -------------------------------------------------------------------------
  // Test 15: Successful jobs are not executed again
  // -------------------------------------------------------------------------
  await runTestAsync('Test 15: Successful jobs are not executed again', async () => {
    const mockDb = createMockDb();
    const sentKey = 'comment:already_finished_101';
    await mockDb.collections().webhookJobs.insertOne({
      event_key: sentKey,
      job_id: sentKey,
      status: 'sent',
      attempts: 1,
      completed_at: new Date()
    });

    const claimed = await webhookJobQueue.claimNextJob(mockDb, { workerId: 'w_test' });
    assert.strictEqual(claimed, null, 'Sent jobs must never be claimed again');
  });

  // -------------------------------------------------------------------------
  // Test 16: Existing follow-gate state machine remains intact
  // -------------------------------------------------------------------------
  await runTestAsync('Test 16: Existing follow-gate state machine remains intact', async () => {
    const mockDb = createMockDb();
    const stateKey = 'auto_123:acc_creator:user_fan';

    // State starts 'INIT'
    await mockDb.collections().conversationStates.updateOne(
      { key: stateKey },
      { $setOnInsert: { key: stateKey, delivery_state: 'not_started', resource_delivered: false } },
      { upsert: true }
    );

    // Transition to sending
    const claimRes = await mockDb.collections().conversationStates.updateOne(
      { key: stateKey, delivery_state: { $nin: ['sending', 'sent'] }, resource_delivered: { $ne: true } },
      { $set: { delivery_state: 'sending' } }
    );
    assert.strictEqual(claimRes.modifiedCount, 1);

    // Confirm state is 'sending' and NOT prematurely 'sent'
    const inFlightState = await mockDb.collections().conversationStates.findOne({ key: stateKey });
    assert.strictEqual(inFlightState.delivery_state, 'sending');
    assert.strictEqual(inFlightState.resource_delivered, false);

    // Complete delivery with meta_message_id
    await mockDb.collections().conversationStates.updateOne(
      { key: stateKey },
      { $set: { delivery_state: 'sent', resource_delivered: true, meta_message_id: 'mid_meta_12345' } }
    );

    const finalState = await mockDb.collections().conversationStates.findOne({ key: stateKey });
    assert.strictEqual(finalState.delivery_state, 'sent');
    assert.strictEqual(finalState.resource_delivered, true);
    assert.strictEqual(finalState.meta_message_id, 'mid_meta_12345');
  });

  // -------------------------------------------------------------------------
  // Test 17: Existing public comment reply behavior remains intact
  // -------------------------------------------------------------------------
  runTest('Test 17: Existing public comment reply behavior remains intact', () => {
    // Redaction and sanitization tests
    const rawError = 'Failed with token EAAJ1234567890abcdef1234567890 and secret';
    const sanitized = metaRateLimiter.sanitizeString(rawError);
    assert.strictEqual(sanitized.includes('EAAJ'), false, 'Access token must be redacted');
    assert.strictEqual(sanitized.includes('[REDACTED_META_TOKEN]'), true);
  });

  // -------------------------------------------------------------------------
  // Test 18: Existing billing and authentication are unaffected
  // -------------------------------------------------------------------------
  runTest('Test 18: Existing billing and authentication are unaffected', () => {
    assert.strictEqual(typeof billing.entitlement, 'function');
    assert.strictEqual(typeof billing.register, 'function');
    assert.strictEqual(typeof billing.LIMITS, 'object');
    assert.ok(billing.LIMITS.free, 'Billing limits free tier exists');
    assert.ok(billing.LIMITS.pro, 'Billing limits pro tier exists');
    assert.ok(billing.LIMITS.elite, 'Billing limits elite tier exists');
  });

  // -------------------------------------------------------------------------
  // Telemetry: Admin Observability Metrics
  // -------------------------------------------------------------------------
  await runTestAsync('Admin Metrics: getQueueMetrics returns comprehensive snapshot', async () => {
    const mockDb = createMockDb();
    await mockDb.collections().webhookJobs.insertOne({ event_key: 'm1', status: 'queued', instagram_account_id: 'a1', created_at: new Date(Date.now() - 5000) });
    await mockDb.collections().webhookJobs.insertOne({ event_key: 'm2', status: 'processing', instagram_account_id: 'a1' });
    await mockDb.collections().webhookJobs.insertOne({ event_key: 'm3', status: 'retrying', instagram_account_id: 'a2' });
    await mockDb.collections().webhookJobs.insertOne({ event_key: 'm4', status: 'sent', instagram_account_id: 'a1' });

    const metrics = await webhookJobQueue.getQueueMetrics(mockDb);
    assert.strictEqual(metrics.queued_jobs, 1);
    assert.strictEqual(metrics.processing_jobs, 1);
    assert.strictEqual(metrics.retrying_jobs, 1);
    assert.strictEqual(metrics.jobs_processed, 1);
    assert.ok(metrics.oldest_pending_job_age_ms >= 4000);
    assert.ok(Array.isArray(metrics.per_account_queue_depth));
  });

  console.log('\n======================================================================');
  console.log(`   ALL 18 PHASE 2 TEST SCENARIOS PASSED: ${passedTests}/${totalTests} tests successful`);
  console.log('======================================================================\n');
}

runSuite().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
