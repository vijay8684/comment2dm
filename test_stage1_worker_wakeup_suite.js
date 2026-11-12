// test_stage1_worker_wakeup_suite.js
// Verification suite for Comment2DM Performance Optimization Stage 1:
// Event-Driven Worker Wake-Up & Queue Pickup Latency Optimization

const assert = require('assert');
const crypto = require('crypto');
const webhookJobQueue = require('./src/jobs/webhookJobQueue');
const webhookWorker = require('./src/jobs/webhookWorker');

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

// In-Memory MongoDB mock simulating all queue features (queries, lease locks, sorting, unique index)
function createMockDb() {
  const jobs = new Map();
  const accountLimits = new Map();

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
    async findOneAndUpdate(filter, update, options = {}) {
      const now = new Date();
      // Match candidate
      let matched = null;
      for (const j of jobs.values()) {
        if (filter.attempts && filter.attempts.$lt && (j.attempts || 0) >= filter.attempts.$lt) continue;
        if (filter.instagram_account_id && filter.instagram_account_id.$nin && filter.instagram_account_id.$nin.includes(j.instagram_account_id)) continue;

        let statusMatch = false;
        if (filter.$or) {
          for (const cond of filter.$or) {
            if (cond.status === j.status) {
              if (cond.status === 'queued' || cond.status === 'retrying') {
                if (!j.run_at || j.run_at <= now) statusMatch = true;
              } else if (cond.status === 'processing') {
                if (j.locked_until && j.locked_until <= now) statusMatch = true;
              }
            }
          }
        }
        if (statusMatch) {
          matched = j;
          break;
        }
      }

      if (!matched) return null;

      if (update.$set) Object.assign(matched, update.$set);
      if (update.$inc) {
        for (const [k, v] of Object.entries(update.$inc)) {
          matched[k] = (matched[k] || 0) + v;
        }
      }
      return matched;
    }
  };

  return {
    collections() {
      return {
        webhookJobs: col,
        accountRateLimits: {
          find: () => ({ toArray: async () => [] }),
          findOne: async () => null
        }
      };
    }
  };
}

(async () => {
  console.log('================================================================');
  console.log(' COMMENT2DM STAGE 1: EVENT-DRIVEN WORKER WAKE-UP TEST SUITE');
  console.log('================================================================\n');

  // -------------------------------------------------------------------------
  // Test 1: Immediate worker wake-up after successful job insertion
  // -------------------------------------------------------------------------
  await runTestAsync('Test 1: Worker wakes up immediately upon notification (< 50ms vs 60s poll)', async () => {
    webhookWorker._resetWorkerForTesting();
    const mockDb = createMockDb();
    let processedTime = null;
    const insertedTime = Date.now();

    // Start worker with a huge 60-second periodic poll interval
    webhookWorker.startWorker(mockDb, async (job) => {
      processedTime = Date.now();
    }, { pollIntervalMs: 60000 });

    const jobKey = 'comment:wakeup_test_1';
    await mockDb.collections().webhookJobs.insertOne({
      event_key: jobKey,
      job_id: jobKey,
      instagram_account_id: 'acc_creator_1',
      status: 'queued',
      attempts: 0,
      run_at: new Date(),
      created_at: new Date()
    });

    // Notify worker immediately
    const wakeUpResult = webhookWorker.triggerImmediatePoll();
    assert.strictEqual(wakeUpResult, true, 'triggerImmediatePoll must return true when running');

    // Wait up to 200ms
    const startWait = Date.now();
    while (!processedTime && (Date.now() - startWait) < 500) {
      await new Promise(r => setTimeout(r, 10));
    }

    assert.ok(processedTime, 'Job must be processed without waiting for 60s poll timer');
    const elapsed = processedTime - insertedTime;
    console.log(`   [METRIC] Pickup Latency with Immediate Wake-Up: ${elapsed}ms`);
    assert.ok(elapsed < 100, `Pickup latency should be under 100ms, was ${elapsed}ms`);

    const status = webhookWorker.getWorkerStatus();
    assert.ok(status.immediate_polls_triggered >= 1, 'immediate_polls_triggered counter must be incremented');

    await webhookWorker.stopWorker();
  });

  // -------------------------------------------------------------------------
  // Test 2: Multiple simultaneous webhook notifications coalesce safely
  // -------------------------------------------------------------------------
  await runTestAsync('Test 2: Multiple simultaneous webhook notifications coalesce safely', async () => {
    webhookWorker._resetWorkerForTesting();
    const mockDb = createMockDb();
    const processedJobs = [];

    webhookWorker.startWorker(mockDb, async (job) => {
      processedJobs.push(job.event_key);
    }, { pollIntervalMs: 60000 });

    // Ingest 5 jobs simultaneously
    for (let i = 1; i <= 5; i++) {
      await mockDb.collections().webhookJobs.insertOne({
        event_key: `comment:burst_job_${i}`,
        job_id: `comment:burst_job_${i}`,
        instagram_account_id: 'acc_creator_1',
        status: 'queued',
        attempts: 0,
        run_at: new Date(),
        created_at: new Date()
      });
    }

    // Trigger immediate poll 15 times synchronously (simulating simultaneous webhook bursts)
    for (let i = 0; i < 15; i++) {
      webhookWorker.triggerImmediatePoll();
    }

    // Wait up to 500ms for all 5 jobs to process
    const startWait = Date.now();
    while (processedJobs.length < 5 && (Date.now() - startWait) < 1000) {
      await new Promise(r => setTimeout(r, 10));
    }

    assert.strictEqual(processedJobs.length, 5, 'All 5 burst jobs must be processed');
    const workerStatus = webhookWorker.getWorkerStatus();
    assert.strictEqual(workerStatus.is_running, true);
    assert.strictEqual(workerStatus.active_jobs, 0, 'All active jobs must complete');

    await webhookWorker.stopWorker();
  });

  // -------------------------------------------------------------------------
  // Test 3: No overlapping poll executions (Strict Concurrency Invariant)
  // -------------------------------------------------------------------------
  await runTestAsync('Test 3: No overlapping poll executions during slow claim operations', async () => {
    webhookWorker._resetWorkerForTesting();
    const baseMockDb = createMockDb();
    let concurrentClaims = 0;
    let maxConcurrentClaims = 0;

    // Wrap findOneAndUpdate with an artificial async I/O delay
    const instrumentedDb = {
      collections() {
        const baseCols = baseMockDb.collections();
        return {
          ...baseCols,
          webhookJobs: {
            ...baseCols.webhookJobs,
            async findOneAndUpdate(filter, update, options) {
              concurrentClaims++;
              if (concurrentClaims > maxConcurrentClaims) {
                maxConcurrentClaims = concurrentClaims;
              }
              // Simulate 20ms database network latency
              await new Promise(r => setTimeout(r, 20));
              const res = await baseCols.webhookJobs.findOneAndUpdate(filter, update, options);
              concurrentClaims--;
              return res;
            }
          }
        };
      }
    };

    let processedCount = 0;
    webhookWorker.startWorker(instrumentedDb, async (job) => {
      processedCount++;
    }, { pollIntervalMs: 60000 });

    // Insert 2 jobs
    await baseMockDb.collections().webhookJobs.insertOne({
      event_key: 'comment:slow_1',
      job_id: 'comment:slow_1',
      instagram_account_id: 'acc_creator_1',
      status: 'queued',
      attempts: 0,
      run_at: new Date(),
      created_at: new Date()
    });
    await baseMockDb.collections().webhookJobs.insertOne({
      event_key: 'comment:slow_2',
      job_id: 'comment:slow_2',
      instagram_account_id: 'acc_creator_1',
      status: 'queued',
      attempts: 0,
      run_at: new Date(),
      created_at: new Date()
    });

    // Fire initial wake-up
    webhookWorker.triggerImmediatePoll();

    // While the worker is inside the 20ms findOneAndUpdate, fire 5 more wake-ups
    await new Promise(r => setTimeout(r, 5));
    for (let i = 0; i < 5; i++) {
      webhookWorker.triggerImmediatePoll();
    }

    // Wait for jobs to finish
    const startWait = Date.now();
    while (processedCount < 2 && (Date.now() - startWait) < 1500) {
      await new Promise(r => setTimeout(r, 10));
    }

    assert.strictEqual(processedCount, 2, 'Both jobs must be processed');
    assert.strictEqual(maxConcurrentClaims, 1, `Max concurrent claim cycles must NEVER exceed 1 (was ${maxConcurrentClaims})`);

    await webhookWorker.stopWorker();
  });

  // -------------------------------------------------------------------------
  // Test 4: Existing lease and duplicate-processing protection remain intact
  // -------------------------------------------------------------------------
  await runTestAsync('Test 4: Leased jobs are protected and expired leases recovered', async () => {
    webhookWorker._resetWorkerForTesting();
    const mockDb = createMockDb();
    let processedJob = null;

    // Insert job locked by another worker with valid lease
    const lockedJobKey = 'comment:leased_by_other';
    await mockDb.collections().webhookJobs.insertOne({
      event_key: lockedJobKey,
      job_id: lockedJobKey,
      instagram_account_id: 'acc_creator_1',
      status: 'processing',
      worker_id: 'worker_foreign_99',
      locked_until: new Date(Date.now() + 60000), // Valid for 1 min
      attempts: 1,
      run_at: new Date(),
      created_at: new Date()
    });

    webhookWorker.startWorker(mockDb, async (job) => {
      processedJob = job.event_key;
    }, { pollIntervalMs: 60000 });

    // Trigger immediate poll
    webhookWorker.triggerImmediatePoll();
    await new Promise(r => setTimeout(r, 50));

    assert.strictEqual(processedJob, null, 'Worker must not steal actively leased job from another worker');

    // Now simulate lease expiration
    const col = mockDb.collections().webhookJobs;
    await col.updateOne({ event_key: lockedJobKey }, {
      $set: { locked_until: new Date(Date.now() - 5000) } // Expired 5s ago
    });

    // Trigger immediate poll again
    webhookWorker.triggerImmediatePoll();
    const startWait = Date.now();
    while (!processedJob && (Date.now() - startWait) < 500) {
      await new Promise(r => setTimeout(r, 10));
    }

    assert.strictEqual(processedJob, lockedJobKey, 'Expired lease must be safely recovered and processed');

    await webhookWorker.stopWorker();
  });

  // -------------------------------------------------------------------------
  // Test 5: Retry and backoff behavior remains unchanged
  // -------------------------------------------------------------------------
  await runTestAsync('Test 5: Immediate notification preserves retry scheduling and backoff delays', async () => {
    webhookWorker._resetWorkerForTesting();
    const mockDb = createMockDb();
    let retriedProcessed = false;

    // Insert retrying job whose backoff has NOT arrived yet (due 30s in future)
    const retryJobKey = 'comment:backoff_job_1';
    await mockDb.collections().webhookJobs.insertOne({
      event_key: retryJobKey,
      job_id: retryJobKey,
      instagram_account_id: 'acc_creator_1',
      status: 'retrying',
      attempts: 1,
      run_at: new Date(Date.now() + 30000), // Due in 30 seconds
      created_at: new Date()
    });

    webhookWorker.startWorker(mockDb, async (job) => {
      retriedProcessed = true;
    }, { pollIntervalMs: 60000 });

    // Trigger immediate poll multiple times
    webhookWorker.triggerImmediatePoll();
    webhookWorker.triggerImmediatePoll();
    await new Promise(r => setTimeout(r, 60));

    assert.strictEqual(retriedProcessed, false, 'Retrying job with future run_at must NOT be claimed prematurely');

    const jobDoc = await mockDb.collections().webhookJobs.findOne({ event_key: retryJobKey });
    assert.strictEqual(jobDoc.status, 'retrying', 'Job status must remain retrying');
    assert.strictEqual(jobDoc.attempts, 1, 'Attempts must remain 1');

    // Now advance backoff to the past (due now)
    await mockDb.collections().webhookJobs.updateOne({ event_key: retryJobKey }, {
      $set: { run_at: new Date(Date.now() - 1000) }
    });

    webhookWorker.triggerImmediatePoll();
    const startWait = Date.now();
    while (!retriedProcessed && (Date.now() - startWait) < 500) {
      await new Promise(r => setTimeout(r, 10));
    }

    assert.strictEqual(retriedProcessed, true, 'Retrying job must be claimed immediately once run_at is due');

    await webhookWorker.stopWorker();
  });

  // -------------------------------------------------------------------------
  // Test 6: Worker restart and shutdown behavior
  // -------------------------------------------------------------------------
  await runTestAsync('Test 6: Safe worker shutdown and restart behavior', async () => {
    webhookWorker._resetWorkerForTesting();
    const mockDb = createMockDb();

    // Calling triggerImmediatePoll before startWorker is a safe no-op
    const preStartRes = webhookWorker.triggerImmediatePoll();
    assert.strictEqual(preStartRes, false, 'triggerImmediatePoll before start must return false');

    let processedKey = null;
    webhookWorker.startWorker(mockDb, async (job) => {
      processedKey = job.event_key;
    }, { pollIntervalMs: 60000 });

    assert.strictEqual(webhookWorker.getWorkerStatus().is_running, true);

    // Stop worker
    await webhookWorker.stopWorker();
    assert.strictEqual(webhookWorker.getWorkerStatus().is_running, false);

    // Calling triggerImmediatePoll after stopWorker is a safe no-op
    const postStopRes = webhookWorker.triggerImmediatePoll();
    assert.strictEqual(postStopRes, false, 'triggerImmediatePoll after stop must return false');

    // Restart worker
    let restartedProcessedKey = null;
    webhookWorker.startWorker(mockDb, async (job) => {
      restartedProcessedKey = job.event_key;
    }, { pollIntervalMs: 60000 });

    assert.strictEqual(webhookWorker.getWorkerStatus().is_running, true);

    // Ingest job into restarted worker
    await mockDb.collections().webhookJobs.insertOne({
      event_key: 'comment:restarted_job',
      job_id: 'comment:restarted_job',
      instagram_account_id: 'acc_creator_1',
      status: 'queued',
      attempts: 0,
      run_at: new Date(),
      created_at: new Date()
    });

    webhookWorker.triggerImmediatePoll();
    const startWait = Date.now();
    while (!restartedProcessedKey && (Date.now() - startWait) < 500) {
      await new Promise(r => setTimeout(r, 10));
    }

    assert.strictEqual(restartedProcessedKey, 'comment:restarted_job', 'Restarted worker must process jobs immediately');

    await webhookWorker.stopWorker();
  });

  // -------------------------------------------------------------------------
  // Test 7: Alias notifyWorker is identical to triggerImmediatePoll
  // -------------------------------------------------------------------------
  runTest('Test 7: notifyWorker alias function identity', () => {
    assert.strictEqual(typeof webhookWorker.triggerImmediatePoll, 'function');
    assert.strictEqual(typeof webhookWorker.notifyWorker, 'function');
    assert.strictEqual(webhookWorker.triggerImmediatePoll, webhookWorker.notifyWorker);
  });

  // -------------------------------------------------------------------------
  // Test 8: Worker generation isolation & non-overlapping database claims
  // -------------------------------------------------------------------------
  await runTestAsync('Test 8: Unresolved database claim during restart prevents overlapping claims and isolates generation ownership', async () => {
    webhookWorker._resetWorkerForTesting();
    const mockDb = createMockDb();

    // Ingest job 1
    await mockDb.collections().webhookJobs.insertOne({
      event_key: 'comment:gen_isolation_job_1',
      job_id: 'comment:gen_isolation_job_1',
      instagram_account_id: 'acc_creator_iso_1',
      status: 'queued',
      attempts: 0,
      run_at: new Date(),
      created_at: new Date()
    });

    const origClaim = webhookJobQueue.claimNextJob;
    let activeClaimsCount = 0;
    let maxConcurrentClaims = 0;
    let gen1ClaimStarted = false;
    let gen1ClaimResolve = null;
    let gen1WorkerIdSeen = null;
    let gen2WorkerIdSeen = null;

    // Wrap claimNextJob to track in-flight claims and genuinely delay the DB operation
    webhookJobQueue.claimNextJob = async function (db, options) {
      activeClaimsCount++;
      if (activeClaimsCount > maxConcurrentClaims) {
        maxConcurrentClaims = activeClaimsCount;
      }
      const workerIdUsed = options?.workerId;

      try {
        if (!gen1ClaimStarted) {
          gen1ClaimStarted = true;
          gen1WorkerIdSeen = workerIdUsed;
          // 1. Genuinely delay the database claim operation BEFORE it queries or updates
          await new Promise(r => { gen1ClaimResolve = r; });
        } else if (!gen2WorkerIdSeen) {
          gen2WorkerIdSeen = workerIdUsed;
        }
        return await origClaim.call(this, db, options);
      } finally {
        activeClaimsCount--;
      }
    };

    let gen1ExecutedCount = 0;
    let gen2ExecutedCount = 0;

    try {
      // 1. Start worker Generation 1
      webhookWorker.startWorker(mockDb, async (job) => {
        gen1ExecutedCount++;
      }, { pollIntervalMs: 60000 });

      // Wait until Generation 1's claimNextJob is genuinely active and pending
      const waitStart = Date.now();
      while (!gen1ClaimResolve && (Date.now() - waitStart) < 500) {
        await new Promise(r => setTimeout(r, 10));
      }
      assert.ok(gen1ClaimResolve, 'Generation 1 claimNextJob must be in-flight in database');
      assert.strictEqual(activeClaimsCount, 1, 'Generation 1 must be the only active claim');

      // 2. Stop Generation 1 while database claim is unresolved (short timeout)
      const stopGen1Promise = webhookWorker.stopWorker(50);

      // 3. Start Generation 2 BEFORE Generation 1's claim resolves
      webhookWorker.startWorker(mockDb, async (job) => {
        gen2ExecutedCount++;
      }, { pollIntervalMs: 60000 });

      const gen2Status = webhookWorker.getWorkerStatus();
      assert.strictEqual(gen2Status.is_running, true, 'Generation 2 worker must be in running state');

      // Allow event loop to process Generation 2 initialization
      await new Promise(r => setTimeout(r, 50));

      // 4. Verify Generation 2 HAS NOT started a database claim while Generation 1 is pending
      assert.strictEqual(activeClaimsCount, 1, 'Generation 2 must NOT begin a database claim while Gen 1 is unresolved');
      assert.strictEqual(maxConcurrentClaims, 1, 'Concurrent database claim operations must be strictly <= 1');

      // 5. Now resolve Generation 1's claim operation and await Gen 1 shutdown completion
      gen1ClaimResolve();
      await stopGen1Promise;

      // Allow event loop to process Gen 1 release and Gen 2 subsequent claim
      const waitJob1 = Date.now();
      while (gen2ExecutedCount === 0 && (Date.now() - waitJob1) < 2000) {
        await new Promise(r => setTimeout(r, 20));
      }

      // Verification:
      // (a) Max concurrent claims remained strictly 1 throughout
      assert.strictEqual(maxConcurrentClaims, 1, 'Max concurrent database claim operations must NEVER exceed 1');

      // (b) Generation 1 did not execute the job; Generation 2 executed it exactly once
      assert.strictEqual(gen1ExecutedCount, 0, 'Obsolete Generation 1 must not process any job');
      assert.strictEqual(gen2ExecutedCount, 1, 'Generation 2 must process the job exactly once');

      // (c) Worker IDs must be distinct across generations
      assert.ok(gen1WorkerIdSeen, 'Generation 1 worker ID must be captured');
      assert.ok(gen2WorkerIdSeen, 'Generation 2 worker ID must be captured');
      assert.notStrictEqual(gen1WorkerIdSeen, gen2WorkerIdSeen, 'Worker generations must have distinct identities');

      // 6. Verify an obsolete generation cannot modify the replacement worker's job ownership
      const activeGen2Job = {
        event_key: 'comment:gen_isolation_job_1',
        worker_id: gen2WorkerIdSeen,
        status: 'processing'
      };

      // (i) Old generation cannot extend lease
      const extendRes = await webhookJobQueue.extendLease(activeGen2Job, gen1WorkerIdSeen, 30000, mockDb);
      assert.strictEqual(extendRes, false, 'Obsolete generation must not be able to extend replacement worker lease');

      // (ii) Old generation cannot release replacement worker job
      await webhookWorker._releaseClaimedJobForTesting(activeGen2Job, mockDb, gen1WorkerIdSeen);
      const afterReleaseAttempt = await mockDb.collections().webhookJobs.findOne({ event_key: 'comment:gen_isolation_job_1' });
      assert.strictEqual(afterReleaseAttempt.status, 'sent', 'Obsolete generation release attempt must not modify replacement job status');

      // (iii) Old generation cannot mark job success
      const successRes = await webhookJobQueue.handleJobSuccess(activeGen2Job, { worker_id: gen1WorkerIdSeen }, mockDb);
      assert.strictEqual(successRes.success, false, 'Obsolete generation must not be able to mark replacement worker job success');

      // (iv) Old generation cannot record failure
      const failRes = await webhookJobQueue.handleJobFailure({ ...activeGen2Job, worker_id: gen1WorkerIdSeen }, new Error('err'), mockDb);
      assert.strictEqual(failRes.success, false, 'Obsolete generation must not be able to record failure for replacement job');

      // 7. Verify normal immediate wake-up still works afterward
      await mockDb.collections().webhookJobs.insertOne({
        event_key: 'comment:gen_isolation_job_2',
        job_id: 'comment:gen_isolation_job_2',
        instagram_account_id: 'acc_creator_iso_2',
        status: 'queued',
        attempts: 0,
        run_at: new Date(),
        created_at: new Date()
      });

      const wakeUpAccepted = webhookWorker.triggerImmediatePoll();
      assert.strictEqual(wakeUpAccepted, true, 'Immediate poll must be accepted by active Generation 2');

      const waitJob2 = Date.now();
      while (gen2ExecutedCount < 2 && (Date.now() - waitJob2) < 2000) {
        await new Promise(r => setTimeout(r, 20));
      }
      assert.strictEqual(gen2ExecutedCount, 2, 'Generation 2 must process second job immediately via wake-up');

      await webhookWorker.stopWorker();
    } finally {
      webhookJobQueue.claimNextJob = origClaim;
      if (gen1ClaimResolve) gen1ClaimResolve();
      await webhookWorker.stopWorker();
    }
  });

  // -------------------------------------------------------------------------
  // Test 9: Heartbeat isolation across generations & graceful shutdown lease retention
  // -------------------------------------------------------------------------
  await runTestAsync('Test 9: Heartbeat timers are generation-isolated and preserved during graceful shutdown', async () => {
    webhookWorker._resetWorkerForTesting();
    const mockDb = createMockDb();

    // Configure fast heartbeat interval for deterministic test execution
    webhookJobQueue._heartbeatIntervalMsForTesting = 20;

    let gen1JobResolve = null;
    let gen2JobResolve = null;
    let gen1HeartbeatTicks = 0;
    let gen2HeartbeatTicks = 0;
    let gen1WorkerId = null;
    let gen2WorkerId = null;

    const origExtendLease = webhookJobQueue.extendLease;
    webhookJobQueue.extendLease = async function (job, workerId, extensionMs, db) {
      if (gen1WorkerId && workerId === gen1WorkerId) {
        gen1HeartbeatTicks++;
      } else if (gen2WorkerId && workerId === gen2WorkerId) {
        gen2HeartbeatTicks++;
      }
      return origExtendLease.call(this, job, workerId, extensionMs, db);
    };

    try {
      // 1. Ingest job for Generation 1
      await mockDb.collections().webhookJobs.insertOne({
        event_key: 'comment:hb_shared_job_id',
        job_id: 'comment:hb_shared_job_id',
        instagram_account_id: 'acc_hb_1',
        status: 'queued',
        attempts: 0,
        run_at: new Date(),
        created_at: new Date()
      });

      // Start Generation 1
      webhookWorker.startWorker(mockDb, async (job) => {
        // In-flight task awaiting resolution
        await new Promise(r => { gen1JobResolve = r; });
      }, { pollIntervalMs: 60000 });

      gen1WorkerId = webhookWorker.getWorkerStatus().worker_id;

      // Wait until Gen 1 has claimed and activeHeartbeats contains Gen 1 heartbeat
      const hbMap = webhookWorker._getActiveHeartbeatsForTesting();
      const waitHb1 = Date.now();
      while ((hbMap.size === 0 || typeof gen1JobResolve !== 'function') && (Date.now() - waitHb1) < 1000) {
        await new Promise(r => setTimeout(r, 10));
      }
      assert.strictEqual(hbMap.size, 1, 'Generation 1 heartbeat must be registered in activeHeartbeats');
      assert.strictEqual(typeof gen1JobResolve, 'function', 'Generation 1 executor must be active');

      const gen1Key = Array.from(hbMap.keys())[0];
      assert.strictEqual(gen1Key, `${gen1WorkerId}:comment:hb_shared_job_id`, `Key must be generation-specific: ${gen1Key}`);

      // Wait for Gen 1 heartbeat to tick at least once
      const waitTick1 = Date.now();
      while (gen1HeartbeatTicks === 0 && (Date.now() - waitTick1) < 1000) {
        await new Promise(r => setTimeout(r, 10));
      }
      assert.ok(gen1HeartbeatTicks >= 1, 'Generation 1 heartbeat must actively renew lease');

      // 2. Initiate graceful shutdown on Generation 1
      const stopGen1Promise = webhookWorker.stopWorker(2500);

      // Verify Generation 1's heartbeat remains alive during graceful shutdown drain
      assert.strictEqual(hbMap.has(gen1Key), true, 'Generation 1 heartbeat must remain active during graceful shutdown');

      // 3. Start Generation 2 while Generation 1 is still in graceful shutdown drain
      await mockDb.collections().webhookJobs.insertOne({
        event_key: 'comment:hb_job_gen2',
        job_id: 'comment:hb_job_gen2',
        instagram_account_id: 'acc_hb_2',
        status: 'queued',
        attempts: 0,
        run_at: new Date(),
        created_at: new Date()
      });

      webhookWorker.startWorker(mockDb, async (job) => {
        await new Promise(r => { gen2JobResolve = r; });
      }, { pollIntervalMs: 60000 });

      gen2WorkerId = webhookWorker.getWorkerStatus().worker_id;

      // Wait until Gen 2 has claimed its job and registered its heartbeat
      const waitHb2 = Date.now();
      while ((hbMap.size < 2 || typeof gen2JobResolve !== 'function') && (Date.now() - waitHb2) < 1000) {
        await new Promise(r => setTimeout(r, 10));
      }
      assert.strictEqual(hbMap.size, 2, 'Both Gen 1 and Gen 2 heartbeats must coexist in activeHeartbeats');
      assert.strictEqual(typeof gen2JobResolve, 'function', 'Generation 2 executor must be active');

      // 4. Resolve Generation 1's job and await Gen 1 shutdown completion
      gen1JobResolve();
      await stopGen1Promise;

      // 5. Verification:
      // (a) Generation 1's heartbeat was removed upon its job completion
      assert.strictEqual(hbMap.has(gen1Key), false, 'Generation 1 heartbeat must be cleanly removed after job completion');

      // (b) Generation 2's heartbeat WAS NOT cleared by stopping Generation 1!
      assert.strictEqual(hbMap.size, 1, 'Generation 2 heartbeat must remain intact in activeHeartbeats');
      const gen2Key = Array.from(hbMap.keys())[0];
      assert.strictEqual(gen2Key, `${gen2WorkerId}:comment:hb_job_gen2`, `Gen 2 key must remain: ${gen2Key}`);

      // (c) Generation 2 heartbeat continues to tick
      const waitTick2 = Date.now();
      while (gen2HeartbeatTicks === 0 && (Date.now() - waitTick2) < 1000) {
        await new Promise(r => setTimeout(r, 10));
      }
      assert.ok(gen2HeartbeatTicks >= 1, 'Generation 2 heartbeat must actively tick even after Gen 1 stopped');

      // 6. Complete Generation 2 job and stop
      gen2JobResolve();
      await webhookWorker.stopWorker();
      assert.strictEqual(hbMap.size, 0, 'All heartbeats drained');
    } finally {
      webhookJobQueue._heartbeatIntervalMsForTesting = null;
      webhookJobQueue.extendLease = origExtendLease;
      if (gen1JobResolve) gen1JobResolve();
      if (gen2JobResolve) gen2JobResolve();
      await webhookWorker.stopWorker();
    }
  });

  // -------------------------------------------------------------------------
  // Test 10: Process-wide aggregate & per-account concurrency protection across generations
  // -------------------------------------------------------------------------
  await runTestAsync('Test 10: Aggregate worker concurrency and per-account limits are strictly enforced across overlapping generations', async () => {
    webhookWorker._resetWorkerForTesting();
    const mockDb = createMockDb();

    const gen1Resolvers = [];
    const gen2Resolvers = [];

    let gen1ActiveJobs = 0;
    let gen2ActiveJobs = 0;
    let maxObservedAggregateJobs = 0;
    let maxObservedAccA = 0;

    const recordMetrics = () => {
      const agg = webhookWorker._getAggregateActiveJobCountForTesting();
      if (agg > maxObservedAggregateJobs) {
        maxObservedAggregateJobs = agg;
      }
    };

    try {
      // Ingest 3 jobs for Generation 1: 2 for acc_shared_A (capacity=2), 1 for acc_shared_B
      const g1Jobs = [
        { event_key: 'comment:g1_job_1', job_id: 'comment:g1_job_1', instagram_account_id: 'acc_shared_A', status: 'queued', attempts: 0, run_at: new Date(), created_at: new Date() },
        { event_key: 'comment:g1_job_2', job_id: 'comment:g1_job_2', instagram_account_id: 'acc_shared_A', status: 'queued', attempts: 0, run_at: new Date(), created_at: new Date() },
        { event_key: 'comment:g1_job_3', job_id: 'comment:g1_job_3', instagram_account_id: 'acc_shared_B', status: 'queued', attempts: 0, run_at: new Date(), created_at: new Date() }
      ];
      for (const j of g1Jobs) {
        await mockDb.collections().webhookJobs.insertOne(j);
      }

      // Start Generation 1
      webhookWorker.startWorker(mockDb, async (job) => {
        gen1ActiveJobs++;
        recordMetrics();
        await new Promise(r => { gen1Resolvers.push(r); });
        gen1ActiveJobs--;
        recordMetrics();
      }, { pollIntervalMs: 60000 });

      // Wait until Gen 1 has claimed and is running all 3 jobs
      const waitG1 = Date.now();
      while (gen1ActiveJobs < 3 && (Date.now() - waitG1) < 1500) {
        await new Promise(r => setTimeout(r, 10));
      }
      assert.strictEqual(gen1ActiveJobs, 3, 'Generation 1 must have 3 active jobs in flight');
      assert.strictEqual(webhookWorker._getAggregateActiveJobCountForTesting(), 3);

      // Initiate graceful shutdown on Generation 1 (draining with all 3 jobs in flight)
      const stopGen1Promise = webhookWorker.stopWorker(1500);

      // Ingest 5 candidate jobs for Generation 2:
      // - 2 jobs for acc_shared_A (should NOT be claimed because acc_shared_A already has 2 active in Gen 1!)
      // - 2 jobs for acc_shared_B (1 active in Gen 1, so only 1 more can be claimed!)
      // - 2 jobs for acc_shared_C
      const g2Jobs = [
        { event_key: 'comment:g2_job_A1', job_id: 'comment:g2_job_A1', instagram_account_id: 'acc_shared_A', status: 'queued', attempts: 0, run_at: new Date(), created_at: new Date() },
        { event_key: 'comment:g2_job_A2', job_id: 'comment:g2_job_A2', instagram_account_id: 'acc_shared_A', status: 'queued', attempts: 0, run_at: new Date(), created_at: new Date() },
        { event_key: 'comment:g2_job_B1', job_id: 'comment:g2_job_B1', instagram_account_id: 'acc_shared_B', status: 'queued', attempts: 0, run_at: new Date(), created_at: new Date() },
        { event_key: 'comment:g2_job_C1', job_id: 'comment:g2_job_C1', instagram_account_id: 'acc_shared_C', status: 'queued', attempts: 0, run_at: new Date(), created_at: new Date() },
        { event_key: 'comment:g2_job_C2', job_id: 'comment:g2_job_C2', instagram_account_id: 'acc_shared_C', status: 'queued', attempts: 0, run_at: new Date(), created_at: new Date() }
      ];
      for (const j of g2Jobs) {
        await mockDb.collections().webhookJobs.insertOne(j);
      }

      // Start Generation 2 while Generation 1's 3 jobs are still in flight
      webhookWorker.startWorker(mockDb, async (job) => {
        gen2ActiveJobs++;
        if (job.instagram_account_id === 'acc_shared_A') {
          maxObservedAccA++;
        }
        recordMetrics();
        await new Promise(r => { gen2Resolvers.push(r); });
        gen2ActiveJobs--;
        recordMetrics();
      }, { pollIntervalMs: 60000 });

      // Allow Generation 2 to poll and claim up to remaining capacity
      // Configured WORKER_CONCURRENCY is 5. With Gen 1 holding 3 jobs, Gen 2 must claim AT MOST 2 jobs!
      await new Promise(r => setTimeout(r, 100));

      const totalActiveWhileOverlapping = webhookWorker._getAggregateActiveJobCountForTesting();
      assert.ok(totalActiveWhileOverlapping <= webhookJobQueue.WORKER_CONCURRENCY, `Aggregate active jobs (${totalActiveWhileOverlapping}) must not exceed WORKER_CONCURRENCY (${webhookJobQueue.WORKER_CONCURRENCY})`);
      assert.strictEqual(gen2ActiveJobs, 2, 'Generation 2 must claim exactly 2 jobs (5 - 3 = 2)');

      // Per-account check: acc_shared_A was at capacity (2 in Gen 1), so Gen 2 must NOT have claimed any jobs for acc_shared_A
      assert.strictEqual(maxObservedAccA, 0, 'Generation 2 must not claim jobs for acc_shared_A while at aggregate capacity');

      // Now drain Gen 1 jobs
      gen1Resolvers.forEach(r => r());
      await stopGen1Promise;

      // Now that Gen 1 jobs drained, Gen 2 should wake up and fill remaining slots
      const waitGen2Refill = Date.now();
      while (gen2ActiveJobs < 3 && (Date.now() - waitGen2Refill) < 1500) {
        await new Promise(r => setTimeout(r, 20));
      }

      assert.ok(maxObservedAggregateJobs <= webhookJobQueue.WORKER_CONCURRENCY, `Max aggregate jobs (${maxObservedAggregateJobs}) never exceeded ${webhookJobQueue.WORKER_CONCURRENCY}`);

      // Clean up Gen 2 jobs
      gen2Resolvers.forEach(r => r());
      await webhookWorker.stopWorker();
    } finally {
      gen1Resolvers.forEach(r => r());
      gen2Resolvers.forEach(r => r());
      await webhookWorker.stopWorker();
    }
  });

  console.log('\n================================================================');
  console.log(` ALL ${passedTests}/${totalTests} STAGE 1 VERIFICATION TESTS PASSED`);
  console.log('================================================================\n');
})();
