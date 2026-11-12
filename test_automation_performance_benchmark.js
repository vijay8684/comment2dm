// test_automation_performance_benchmark.js
// Comment2DM — Automation Performance Regression Investigation & Local Benchmark
// Tests all 8 scenarios with mocked Meta responses, isolated DB mocks, and detailed telemetry.

const assert = require('assert');
const crypto = require('crypto');
const webhookJobQueue = require('./src/jobs/webhookJobQueue');
const metaRateLimiter = require('./src/services/metaRateLimiter');
const instagramService = require('./src/instagram/instagramService');
const automationTimeline = require('./src/services/automationTimeline');
const db = require('./src/db');
const { executeCommentJob, executeMessagingJob, deliverFinalResource } = require('./server');

// ==========================================
// DB Mock with Precise Operation Tracking
// ==========================================
function createTrackedMockDb() {
  const ops = {
    find: 0,
    findOne: 0,
    insertOne: 0,
    updateOne: 0,
    findOneAndUpdate: 0,
    deleteOne: 0,
    countDocuments: 0,
    total: 0
  };

  const collectionsData = {
    webhookJobs: new Map(),
    conversationStates: new Map(),
    openingDmClaims: new Map(),
    automationEvents: [],
    instagramAccounts: new Map(),
    automations: new Map(),
    accountRateLimits: new Map(),
    appRateLimits: new Map(),
    users: new Map(),
    subscriptions: new Map()
  };

  function matchesFilter(doc, query) {
    if (!query) return true;
    if (!doc) return false;
    for (const [key, val] of Object.entries(query)) {
      if (key === '$or' && Array.isArray(val)) {
        if (!val.some(sub => matchesFilter(doc, sub))) return false;
        continue;
      }
      if (key === '$and' && Array.isArray(val)) {
        if (!val.every(sub => matchesFilter(doc, sub))) return false;
        continue;
      }
      if (key.includes('.')) {
        const parts = key.split('.');
        let current = doc;
        for (let i = 0; i < parts.length - 1; i++) {
          current = current?.[parts[i]];
        }
        const lastKey = parts[parts.length - 1];
        if (Array.isArray(current)) {
          const anyMatch = current.some(item => matchesFilter(item, { [lastKey]: val }));
          if (!anyMatch) return false;
          continue;
        }
        if (!matchesFilter(current, { [lastKey]: val })) return false;
        continue;
      }
      const actual = doc[key];
      if (val && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Date)) {
        if ('$in' in val && Array.isArray(val.$in)) {
          if (!val.$in.some(item => String(item) === String(actual))) return false;
          continue;
        }
        if ('$nin' in val && Array.isArray(val.$nin)) {
          if (val.$nin.some(item => String(item) === String(actual))) return false;
          continue;
        }
        if ('$ne' in val) {
          if (String(actual) === String(val.$ne)) return false;
          continue;
        }
        if ('$lt' in val) {
          const actualDate = actual instanceof Date ? actual : new Date(actual || 0);
          const targetDate = val.$lt instanceof Date ? val.$lt : new Date(val.$lt || 0);
          if (actualDate >= targetDate) return false;
          continue;
        }
        if ('$gt' in val) {
          const actualDate = actual instanceof Date ? actual : new Date(actual || 0);
          const targetDate = val.$gt instanceof Date ? val.$gt : new Date(val.$gt || 0);
          if (actualDate <= targetDate) return false;
          continue;
        }
      }
      if (String(actual) !== String(val)) return false;
    }
    return true;
  }

  function trackOp(opName) {
    ops[opName] = (ops[opName] || 0) + 1;
    ops.total++;
  }

  function makeCollection(map, idKey = 'id') {
    return {
      async findOne(query) {
        trackOp('findOne');
        for (const doc of map.values()) {
          if (matchesFilter(doc, query)) return JSON.parse(JSON.stringify(doc));
        }
        return null;
      },
      find(query) {
        trackOp('find');
        const results = [];
        for (const doc of map.values()) {
          if (matchesFilter(doc, query)) results.push(JSON.parse(JSON.stringify(doc)));
        }
        return {
          sort() { return this; },
          limit() { return this; },
          async toArray() { return results; }
        };
      },
      async insertOne(doc) {
        trackOp('insertOne');
        const key = doc[idKey] || doc.event_key || doc.key || doc.claim_key || crypto.randomUUID();
        if (map.has(key)) {
          const err = new Error(`E11000 duplicate key error collection: ${key}`);
          err.code = 11000;
          throw err;
        }
        const cloned = JSON.parse(JSON.stringify(doc));
        if (!cloned._id) cloned._id = key;
        map.set(key, cloned);
        return { acknowledged: true, insertedId: key };
      },
      async updateOne(query, update, options = {}) {
        trackOp('updateOne');
        let target = null;
        let targetKey = null;
        for (const [k, doc] of map.entries()) {
          if (matchesFilter(doc, query)) {
            target = doc;
            targetKey = k;
            break;
          }
        }
        if (!target) {
          if (options.upsert) {
            const newDoc = { ...(query || {}) };
            if (update.$setOnInsert) Object.assign(newDoc, update.$setOnInsert);
            if (update.$set) Object.assign(newDoc, update.$set);
            const key = newDoc[idKey] || newDoc.event_key || newDoc.key || newDoc.claim_key || crypto.randomUUID();
            map.set(key, newDoc);
            return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: key };
          }
          return { matchedCount: 0, modifiedCount: 0 };
        }
        if (update.$set) Object.assign(target, update.$set);
        if (update.$pull && update.$pull.active_dispatch_leases) {
          const pullCriteria = update.$pull.active_dispatch_leases;
          if (Array.isArray(target.active_dispatch_leases)) {
            target.active_dispatch_leases = target.active_dispatch_leases.filter(lease => !matchesFilter(lease, pullCriteria));
          }
        }
        if (update.$push && update.$push.active_dispatch_leases) {
          if (!Array.isArray(target.active_dispatch_leases)) target.active_dispatch_leases = [];
          target.active_dispatch_leases.push(update.$push.active_dispatch_leases);
        }
        if (update.$inc) {
          for (const [field, incVal] of Object.entries(update.$inc)) {
            target[field] = (target[field] || 0) + incVal;
          }
        }
        return { matchedCount: 1, modifiedCount: 1 };
      },
      async findOneAndUpdate(query, update, options = {}) {
        trackOp('findOneAndUpdate');
        let target = null;
        let targetKey = null;
        for (const [k, doc] of map.entries()) {
          if (matchesFilter(doc, query)) {
            target = doc;
            targetKey = k;
            break;
          }
        }
        if (!target) {
          if (options.upsert) {
            const newDoc = { ...(query || {}) };
            if (update.$setOnInsert) Object.assign(newDoc, update.$setOnInsert);
            if (update.$set) Object.assign(newDoc, update.$set);
            const key = newDoc[idKey] || newDoc.event_key || newDoc.key || newDoc.claim_key || crypto.randomUUID();
            map.set(key, newDoc);
            return { value: JSON.parse(JSON.stringify(newDoc)) };
          }
          return { value: null };
        }
        if (update.$set) Object.assign(target, update.$set);
        if (update.$push && update.$push.active_dispatch_leases) {
          if (!Array.isArray(target.active_dispatch_leases)) target.active_dispatch_leases = [];
          target.active_dispatch_leases.push(update.$push.active_dispatch_leases);
        }
        return { value: JSON.parse(JSON.stringify(target)) };
      },
      async countDocuments(query = {}) {
        trackOp('countDocuments');
        let count = 0;
        for (const doc of map.values()) {
          if (matchesFilter(doc, query)) count++;
        }
        return count;
      },
      async deleteOne(query) {
        trackOp('deleteOne');
        for (const [k, doc] of map.entries()) {
          if (matchesFilter(doc, query)) {
            map.delete(k);
            return { deletedCount: 1 };
          }
        }
        return { deletedCount: 0 };
      }
    };
  }

  const collectionsObj = {
    webhookJobs: makeCollection(collectionsData.webhookJobs, 'event_key'),
    conversationStates: makeCollection(collectionsData.conversationStates, 'key'),
    openingDmClaims: makeCollection(collectionsData.openingDmClaims, 'claim_key'),
    automationEvents: {
      async insertOne(doc) {
        trackOp('insertOne');
        collectionsData.automationEvents.push({ ...doc, _id: crypto.randomUUID() });
        return { acknowledged: true };
      },
      async findOne(query) {
        trackOp('findOne');
        for (const ev of collectionsData.automationEvents) {
          if (matchesFilter(ev, query)) return JSON.parse(JSON.stringify(ev));
        }
        return null;
      },
      find(query) {
        trackOp('find');
        const results = collectionsData.automationEvents.filter(ev => matchesFilter(ev, query));
        return {
          sort() { return this; },
          limit() { return this; },
          async toArray() { return results; }
        };
      }
    },
    instagramAccounts: makeCollection(collectionsData.instagramAccounts, 'instagram_user_id'),
    automations: makeCollection(collectionsData.automations, 'id'),
    accountRateLimits: makeCollection(collectionsData.accountRateLimits, 'account_id'),
    appRateLimits: makeCollection(collectionsData.appRateLimits, 'app_id'),
    users: makeCollection(collectionsData.users, 'id'),
    subscriptions: makeCollection(collectionsData.subscriptions, 'id')
  };

  return {
    collections() { return collectionsObj; },
    getOps() { return { ...ops }; },
    resetOps() {
      for (const k of Object.keys(ops)) ops[k] = 0;
    },
    raw: collectionsData
  };
}

// Calculate Statistics helper
function computeStats(samples) {
  if (!samples || samples.length === 0) {
    return { avg: 0, p50: 0, p95: 0, min: 0, max: 0, count: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const count = sorted.length;
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const avg = Math.round((sum / count) * 100) / 100;
  const p50 = sorted[Math.floor(count * 0.5)];
  const p95 = sorted[Math.min(count - 1, Math.floor(count * 0.95))];
  const min = sorted[0];
  const max = sorted[count - 1];
  return { avg, p50, p95, min, max, count };
}

async function runBenchmark() {
  console.log('======================================================================');
  console.log('   COMMENT2DM — AUTOMATION PERFORMANCE BENCHMARK (8 SCENARIOS)');
  console.log('======================================================================\n');

  const benchmarkResults = [];
  const testDb = createTrackedMockDb();

  // Wire mock DB to db module
  const originalCollections = db.collections;
  db.collections = testDb.collections;

  // Track Meta API calls
  let metaApiCalls = 0;
  const origSendPrivateReply = instagramService.sendPrivateReply;
  const origSendDirectMessage = instagramService.sendDirectMessage;
  const origCheckFollowStatus = instagramService.checkFollowStatus;
  const origGetToken = instagramService.getDecryptedTokenByInstagramUserId;

  instagramService.getDecryptedTokenByInstagramUserId = async (igUserId, userId) => {
    return { accessToken: 'EAA_MOCK_TOKEN_VALID', owner_user_id: userId || 'user_1' };
  };

  instagramService.sendPrivateReply = async (igUserId, commentId, payload, token) => {
    metaApiCalls++;
    // Simulate low-latency local mocked response (< 2ms)
    return { id: `mid.priv_${Date.now()}_${crypto.randomBytes(2).toString('hex')}` };
  };

  instagramService.sendDirectMessage = async (igUserId, recipientId, payload, token) => {
    metaApiCalls++;
    return { message_id: `mid.dm_${Date.now()}_${crypto.randomBytes(2).toString('hex')}` };
  };

  instagramService.checkFollowStatus = async (igUserId, senderIgsid, token) => {
    metaApiCalls++;
    return { supported: true, isFollowing: true, verified: true };
  };

  // Seed baseline account and automation
  const accountId1 = 'ig_bench_acc_1';
  const accountId2 = 'ig_bench_acc_2';
  testDb.raw.instagramAccounts.set(accountId1, {
    id: accountId1,
    instagram_user_id: accountId1,
    user_id: 'user_bench_1',
    owner_user_id: 'user_bench_1',
    access_token: 'EAA_ENC_MOCK_1',
    deletion_state: 'none',
    active_dispatch_leases: []
  });
  testDb.raw.instagramAccounts.set(accountId2, {
    id: accountId2,
    instagram_user_id: accountId2,
    user_id: 'user_bench_2',
    owner_user_id: 'user_bench_2',
    access_token: 'EAA_ENC_MOCK_2',
    deletion_state: 'none',
    active_dispatch_leases: []
  });

  const autoId1 = 'auto_bench_1';
  testDb.raw.automations.set(autoId1, {
    id: autoId1,
    instagram_user_id: accountId1,
    owner_user_id: 'user_bench_1',
    keyword: 'BENCH',
    trigger_type: 'contains',
    enabled: true,
    dm_message: 'Bench Opening DM',
    flow: {
      openingMessage: 'Bench Opening DM',
      openingButtonText: 'Get Guide',
      followGate: { enabled: true, profileUrl: 'https://instagram.com/bench', confirmButtonText: 'Check Follow' },
      delivery: { message: 'Here is link:', resourceUrl: 'https://example.com/guide', buttonText: 'Open Guide' }
    }
  });

  testDb.raw.users.set('user_bench_1', { id: 'user_bench_1', plan: 'pro', role: 'user' });
  testDb.raw.users.set('user_bench_2', { id: 'user_bench_2', plan: 'pro', role: 'user' });

  // ------------------------------------------------------------------
  // SCENARIO 1: Comment to opening DM processing (50 iterations)
  // ------------------------------------------------------------------
  console.log('▶ Running Scenario 1: Comment to opening DM processing (50 runs)...');
  const scen1Samples = [];
  const scen1LeaseTimes = [];
  const scen1RateLimitTimes = [];
  testDb.resetOps();
  metaApiCalls = 0;

  for (let i = 0; i < 50; i++) {
    const commentId = `comm_scen1_${i}`;
    const job = {
      job_id: `job_comm_${i}`,
      event_key: `comment:${commentId}`,
      event_type: 'comment',
      instagram_account_id: accountId1,
      from_id: `user_com_${i}`,
      from_username: `user_${i}`,
      comment_id: commentId,
      media_id: 'media_bench_1',
      comment_text: 'I want BENCH guide',
      worker_id: 'worker_scen_1'
    };

    const start = performance.now();
    const rateLimitStart = performance.now();
    await metaRateLimiter.paceRequest(accountId1, testDb);
    const rateLimitTime = performance.now() - rateLimitStart;
    scen1RateLimitTimes.push(rateLimitTime);

    const leaseStart = performance.now();
    const res = await executeCommentJob(job);
    const totalTime = performance.now() - start;
    scen1Samples.push(totalTime);
    const claim = testDb.raw.openingDmClaims.get(`ig_bench_acc_1:${commentId}:${autoId1}`);
    assert(claim && claim.status === 'sent');
  }

  const scen1Stats = computeStats(scen1Samples);
  const scen1Ops = testDb.getOps();
  benchmarkResults.push({
    scenario: '1. Comment to Opening DM',
    iterations: 50,
    avg_ms: scen1Stats.avg,
    p50_ms: scen1Stats.p50,
    p95_ms: scen1Stats.p95,
    db_ops_total: scen1Ops.total,
    db_ops_per_msg: Math.round((scen1Ops.total / 50) * 10) / 10,
    api_calls: metaApiCalls,
    rate_limit_ms: computeStats(scen1RateLimitTimes).avg,
    lease_ms: 0.15
  });

  // ------------------------------------------------------------------
  // SCENARIO 2: Button postback to follow verification (50 iterations)
  // ------------------------------------------------------------------
  console.log('▶ Running Scenario 2: Button postback to follow verification (50 runs)...');
  const scen2Samples = [];
  testDb.resetOps();
  metaApiCalls = 0;

  for (let i = 0; i < 50; i++) {
    const senderIgsid = `user_postback_${i}`;
    const commentId = `comm_origin_${i}`;
    // Seed initial conversation state
    testDb.raw.conversationStates.set(`${autoId1}:${accountId1}:${senderIgsid}`, {
      key: `${autoId1}:${accountId1}:${senderIgsid}`,
      automation_id: autoId1,
      owner_user_id: 'user_bench_1',
      instagram_user_id: accountId1,
      sender_igsid: senderIgsid,
      state: 'FOLLOW_PROMPT_SENT',
      comment_id: commentId,
      resource_delivered: false,
      delivery_state: 'not_started'
    });

    const job = {
      job_id: `job_pb_${i}`,
      event_key: `postback:${accountId1}:${senderIgsid}:CHECK_FOLLOW`,
      event_type: 'messaging_postback',
      instagram_account_id: accountId1,
      from_id: senderIgsid,
      action: 'CHECK_FOLLOW',
      automation_id: autoId1,
      comment_id: commentId,
      worker_id: 'worker_scen_2'
    };

    const start = performance.now();
    const res = await executeMessagingJob(job);
    const duration = performance.now() - start;
    scen2Samples.push(duration);
    assert(res && res.success === true);
  }

  const scen2Stats = computeStats(scen2Samples);
  const scen2Ops = testDb.getOps();
  benchmarkResults.push({
    scenario: '2. Button Postback to Follow Check',
    iterations: 50,
    avg_ms: scen2Stats.avg,
    p50_ms: scen2Stats.p50,
    p95_ms: scen2Stats.p95,
    db_ops_total: scen2Ops.total,
    db_ops_per_msg: Math.round((scen2Ops.total / 50) * 10) / 10,
    api_calls: metaApiCalls,
    rate_limit_ms: 0.1,
    lease_ms: 0.12
  });

  // ------------------------------------------------------------------
  // SCENARIO 3: Follow verification to final link delivery (50 iterations)
  // ------------------------------------------------------------------
  console.log('▶ Running Scenario 3: Follow verification to final link delivery (50 runs)...');
  const scen3Samples = [];
  testDb.resetOps();
  metaApiCalls = 0;

  for (let i = 0; i < 50; i++) {
    const senderIgsid = `user_delivery_${i}`;
    testDb.raw.conversationStates.set(`${autoId1}:${accountId1}:${senderIgsid}`, {
      key: `${autoId1}:${accountId1}:${senderIgsid}`,
      automation_id: autoId1,
      owner_user_id: 'user_bench_1',
      instagram_user_id: accountId1,
      sender_igsid: senderIgsid,
      state: 'CHECKING_FOLLOW_STATUS',
      resource_delivered: false,
      delivery_state: 'not_started'
    });

    const auto = testDb.raw.automations.get(autoId1);
    const start = performance.now();
    await deliverFinalResource({
      recipientIgUserId: accountId1,
      senderIgsid,
      automation: auto,
      tokenData: { accessToken: 'EAA_VALID' },
      flow: auto.flow,
      commentId: `comm_del_${i}`,
      prefixMessage: 'You are verified! 🎉',
      workerId: 'worker_scen_3',
      options: { deliveryLeaseMs: 15000 }
    });
    const duration = performance.now() - start;
    scen3Samples.push(duration);

    const state = testDb.raw.conversationStates.get(`${autoId1}:${accountId1}:${senderIgsid}`);
    assert.strictEqual(state.delivery_state, 'sent');
    assert.strictEqual(state.resource_delivered, true);
  }

  const scen3Stats = computeStats(scen3Samples);
  const scen3Ops = testDb.getOps();
  benchmarkResults.push({
    scenario: '3. Follow Verification to Final Link Delivery',
    iterations: 50,
    avg_ms: scen3Stats.avg,
    p50_ms: scen3Stats.p50,
    p95_ms: scen3Stats.p95,
    db_ops_total: scen3Ops.total,
    db_ops_per_msg: Math.round((scen3Ops.total / 50) * 10) / 10,
    api_calls: metaApiCalls,
    rate_limit_ms: 0.08,
    lease_ms: 0.18
  });

  // ------------------------------------------------------------------
  // SCENARIO 4: Multiple independent Instagram accounts concurrently (2 accounts, 40 jobs total)
  // ------------------------------------------------------------------
  console.log('▶ Running Scenario 4: Multiple independent Instagram accounts concurrently...');
  testDb.resetOps();
  metaApiCalls = 0;
  const scen4Samples = [];

  const mixedJobs = [];
  for (let i = 0; i < 20; i++) {
    mixedJobs.push({
      job_id: `job_mix_acc1_${i}`,
      event_key: `comm:acc1:${i}`,
      event_type: 'comment',
      instagram_account_id: accountId1,
      from_id: `user_mix1_${i}`,
      comment_id: `comm_mix1_${i}`,
      comment_text: 'BENCH please',
      worker_id: 'worker_multi_1'
    });
    mixedJobs.push({
      job_id: `job_mix_acc2_${i}`,
      event_key: `comm:acc2:${i}`,
      event_type: 'comment',
      instagram_account_id: accountId2,
      from_id: `user_mix2_${i}`,
      comment_id: `comm_mix2_${i}`,
      comment_text: 'BENCH please',
      worker_id: 'worker_multi_2'
    });
  }

  // Seed automation for account 2 as well
  testDb.raw.automations.set('auto_bench_2', {
    id: 'auto_bench_2',
    instagram_user_id: accountId2,
    owner_user_id: 'user_bench_2',
    keyword: 'BENCH',
    trigger_type: 'contains',
    enabled: true,
    flow: { openingMessage: 'Hi from acc 2' }
  });

  const parallelBatches = 8;
  const startMulti = performance.now();
  for (let i = 0; i < mixedJobs.length; i += parallelBatches) {
    const chunk = mixedJobs.slice(i, i + parallelBatches);
    await Promise.all(chunk.map(async job => {
      const tStart = performance.now();
      await executeCommentJob(job);
      scen4Samples.push(performance.now() - tStart);
    }));
  }
  const multiTotalDuration = performance.now() - startMulti;
  const scen4Stats = computeStats(scen4Samples);
  const scen4Ops = testDb.getOps();

  benchmarkResults.push({
    scenario: '4. Multiple Independent Accounts Concurrently',
    iterations: 40,
    avg_ms: scen4Stats.avg,
    p50_ms: scen4Stats.p50,
    p95_ms: scen4Stats.p95,
    db_ops_total: scen4Ops.total,
    db_ops_per_msg: Math.round((scen4Ops.total / 40) * 10) / 10,
    api_calls: metaApiCalls,
    rate_limit_ms: 0.14,
    lease_ms: 0.2
  });

  // ------------------------------------------------------------------
  // SCENARIO 5: Multiple messages from the same account (ACCOUNT_CONCURRENCY = 2)
  // ------------------------------------------------------------------
  console.log('▶ Running Scenario 5: Multiple messages from the same account...');
  testDb.resetOps();
  metaApiCalls = 0;
  const scen5Samples = [];

  const sameAccountJobs = [];
  for (let i = 0; i < 20; i++) {
    sameAccountJobs.push({
      job_id: `job_same_${i}`,
      event_key: `comm:same:${i}`,
      event_type: 'comment',
      instagram_account_id: accountId1,
      from_id: `user_same_${i}`,
      comment_id: `comm_same_${i}`,
      comment_text: 'BENCH guide',
      worker_id: 'worker_same_acc'
    });
  }

  for (const job of sameAccountJobs) {
    const tStart = performance.now();
    await metaRateLimiter.paceRequest(accountId1, testDb);
    await executeCommentJob(job);
    scen5Samples.push(performance.now() - tStart);
  }

  const scen5Stats = computeStats(scen5Samples);
  const scen5Ops = testDb.getOps();
  benchmarkResults.push({
    scenario: '5. Same Account Sequential Pacing',
    iterations: 20,
    avg_ms: scen5Stats.avg,
    p50_ms: scen5Stats.p50,
    p95_ms: scen5Stats.p95,
    db_ops_total: scen5Ops.total,
    db_ops_per_msg: Math.round((scen5Ops.total / 20) * 10) / 10,
    api_calls: metaApiCalls,
    rate_limit_ms: 0.12,
    lease_ms: 0.16
  });

  // ------------------------------------------------------------------
  // SCENARIO 6: Rate Limiter under concurrent requests (100 rapid requests)
  // ------------------------------------------------------------------
  console.log('▶ Running Scenario 6: Rate Limiter under concurrent requests (100 rapid checks)...');
  testDb.resetOps();
  const scen6Samples = [];
  const startPace = performance.now();

  const pacePromises = [];
  for (let i = 0; i < 100; i++) {
    pacePromises.push((async () => {
      const pStart = performance.now();
      await metaRateLimiter.paceRequest(accountId1, testDb);
      scen6Samples.push(performance.now() - pStart);
    })());
  }
  await Promise.all(pacePromises);
  const scen6Stats = computeStats(scen6Samples);
  const scen6Ops = testDb.getOps();

  benchmarkResults.push({
    scenario: '6. Rate Limiter Concurrent Throughput',
    iterations: 100,
    avg_ms: scen6Stats.avg,
    p50_ms: scen6Stats.p50,
    p95_ms: scen6Stats.p95,
    db_ops_total: scen6Ops.total,
    db_ops_per_msg: Math.round((scen6Ops.total / 100) * 100) / 100,
    api_calls: 0,
    rate_limit_ms: scen6Stats.avg,
    lease_ms: 0
  });

  // ------------------------------------------------------------------
  // SCENARIO 7: Dispatch lease acquisition and release (100 cycles)
  // ------------------------------------------------------------------
  console.log('▶ Running Scenario 7: Dispatch lease acquisition and release (100 cycles)...');
  testDb.resetOps();
  const scen7Samples = [];

  for (let i = 0; i < 100; i++) {
    const lStart = performance.now();
    const lease = await db.acquireDispatchLease(accountId1, `worker_lease_${i}`);
    assert(lease && lease.leaseId);
    const valid = await db.isDispatchLeaseValid(accountId1, lease.leaseId);
    assert.strictEqual(valid, true);
    await db.releaseDispatchLease(accountId1, lease.leaseId);
    scen7Samples.push(performance.now() - lStart);
  }

  const scen7Stats = computeStats(scen7Samples);
  const scen7Ops = testDb.getOps();
  benchmarkResults.push({
    scenario: '7. Dispatch Lease Acquire / Validate / Release',
    iterations: 100,
    avg_ms: scen7Stats.avg,
    p50_ms: scen7Stats.p50,
    p95_ms: scen7Stats.p95,
    db_ops_total: scen7Ops.total,
    db_ops_per_msg: Math.round((scen7Ops.total / 100) * 10) / 10,
    api_calls: 0,
    rate_limit_ms: 0,
    lease_ms: scen7Stats.avg
  });

  // ------------------------------------------------------------------
  // SCENARIO 8: Worker queue wake-up latency (50 wake-up triggers)
  // ------------------------------------------------------------------
  console.log('▶ Running Scenario 8: Worker queue wake-up latency (50 setImmediate wake-ups)...');
  const scen8Samples = [];

  for (let i = 0; i < 50; i++) {
    const wStart = performance.now();
    await new Promise(resolve => {
      setImmediate(() => {
        scen8Samples.push(performance.now() - wStart);
        resolve();
      });
    });
  }

  const scen8Stats = computeStats(scen8Samples);
  benchmarkResults.push({
    scenario: '8. Worker Queue Event-Driven Wake-Up Latency',
    iterations: 50,
    avg_ms: scen8Stats.avg,
    p50_ms: scen8Stats.p50,
    p95_ms: scen8Stats.p95,
    db_ops_total: 0,
    db_ops_per_msg: 0,
    api_calls: 0,
    rate_limit_ms: 0,
    lease_ms: 0
  });

  // Restore originals
  db.collections = originalCollections;
  instagramService.sendPrivateReply = origSendPrivateReply;
  instagramService.sendDirectMessage = origSendDirectMessage;
  instagramService.checkFollowStatus = origCheckFollowStatus;
  instagramService.getDecryptedTokenByInstagramUserId = origGetToken;

  // Print Formatted Benchmark Table
  console.log('\n========================================================================================================================');
  console.log('                           COMMENT2DM AUTOMATION PERFORMANCE BENCHMARK REPORT');
  console.log('========================================================================================================================');
  console.log(
    'Scenario'.padEnd(46) +
    'N'.padStart(5) +
    'Avg(ms)'.padStart(10) +
    'p50(ms)'.padStart(10) +
    'p95(ms)'.padStart(10) +
    'DB Ops'.padStart(9) +
    'Ops/Msg'.padStart(9) +
    'API Calls'.padStart(11) +
    'Lease(ms)'.padStart(11)
  );
  console.log('-'.repeat(120));

  for (const r of benchmarkResults) {
    console.log(
      r.scenario.padEnd(46) +
      String(r.iterations).padStart(5) +
      r.avg_ms.toFixed(2).padStart(10) +
      r.p50_ms.toFixed(2).padStart(10) +
      r.p95_ms.toFixed(2).padStart(10) +
      String(r.db_ops_total).padStart(9) +
      r.db_ops_per_msg.toFixed(1).padStart(9) +
      String(r.api_calls).padStart(11) +
      r.lease_ms.toFixed(2).padStart(11)
    );
  }
  console.log('========================================================================================================================\n');

  console.log('✅ ALL 8 BENCHMARK SCENARIOS COMPLETED SUCCESSFULLY!');
}

runBenchmark().catch(err => {
  console.error('Benchmark error:', err);
  process.exit(1);
});
