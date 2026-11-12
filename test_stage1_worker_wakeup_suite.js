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
          find: () => ({ toArray: async () => [] })
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

  console.log('\n================================================================');
  console.log(` ALL ${passedTests}/${totalTests} STAGE 1 VERIFICATION TESTS PASSED`);
  console.log('================================================================\n');
})();
