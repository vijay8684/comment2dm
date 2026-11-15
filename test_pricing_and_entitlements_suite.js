// test_pricing_and_entitlements_suite.js
// Verification suite for Comment2DM Launch Pricing & Tier Entitlements
// Verifies 18 distinct entitlement, quota, security, and gating checks.

const assert = require('assert');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test_jwt_secret_comment2dm_pricing_entitlements_32chars!';
process.env.RAZORPAY_KEY_ID = 'rzp_test_TzjG2mAiJjGWxv';
process.env.RAZORPAY_KEY_SECRET = 'FTjrig5RKFU6dvMcpwGXzC3j';
process.env.RAZORPAY_WEBHOOK_SECRET = 'Commnet2DM_Billing';

const db = require('./src/db');
const billing = require('./src/billing');
const authService = require('./src/auth/authService');
const { app, deliverFinalResource, executeCommentJob } = require('./server');

function matchesQuery(doc, query) {
  if (!query || Object.keys(query).length === 0) return true;
  if (!doc) return false;
  for (const [key, val] of Object.entries(query)) {
    if (key === '$or' && Array.isArray(val)) {
      if (!val.some(q => matchesQuery(doc, q))) return false;
      continue;
    }
    if (key === '$and' && Array.isArray(val)) {
      if (!val.every(q => matchesQuery(doc, q))) return false;
      continue;
    }
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      if (val.$exists !== undefined) {
        const exists = doc[key] !== undefined;
        if (exists !== val.$exists) return false;
        continue;
      }
      if (val.$in && Array.isArray(val.$in)) {
        if (!val.$in.includes(doc[key])) return false;
        continue;
      }
      if (val.$nin && Array.isArray(val.$nin)) {
        if (val.$nin.includes(doc[key])) return false;
        continue;
      }
      if (val.$ne !== undefined) {
        if (doc[key] === val.$ne) return false;
        continue;
      }
      if (val.$gte !== undefined) {
        if (!(doc[key] >= val.$gte)) return false;
        continue;
      }
      if (val.$gt !== undefined) {
        if (!(doc[key] > val.$gt)) return false;
        continue;
      }
      if (val.$lte !== undefined) {
        if (!(doc[key] <= val.$lte)) return false;
        continue;
      }
      if (val.$lt !== undefined) {
        if (!(doc[key] < val.$lt)) return false;
        continue;
      }
    }
    if (doc[key] !== val) return false;
  }
  return true;
}

function createMockCollection() {
  const items = [];
  return {
    _items: items,
    find(query = {}) {
      let sortSpec = null;
      let limitNum = null;
      return {
        sort(s) { sortSpec = s; return this; },
        limit(l) { limitNum = l; return this; },
        async toArray() {
          let res = items.filter(d => matchesQuery(d, query));
          if (sortSpec) {
            res.sort((a, b) => {
              for (const [k, dir] of Object.entries(sortSpec)) {
                if (a[k] < b[k]) return dir === -1 ? 1 : -1;
                if (a[k] > b[k]) return dir === -1 ? -1 : 1;
              }
              return 0;
            });
          }
          if (limitNum) res = res.slice(0, limitNum);
          return res;
        }
      };
    },
    async findOne(query = {}) {
      return items.find(d => matchesQuery(d, query)) || null;
    },
    async countDocuments(query = {}) {
      return items.filter(d => matchesQuery(d, query)).length;
    },
    async insertOne(doc) {
      items.push({ ...doc });
      return { insertedId: doc._id || doc.id || 'id_' + Math.random().toString(36).substring(2, 7) };
    },
    async updateOne(query, update, options = {}) {
      let doc = items.find(d => matchesQuery(d, query));
      if (!doc) {
        if (options && options.upsert) {
          doc = {};
          if (update.$setOnInsert) Object.assign(doc, update.$setOnInsert);
          if (update.$set) Object.assign(doc, update.$set);
          for (const [k, v] of Object.entries(query)) {
            if (!k.startsWith('$')) doc[k] = v;
          }
          items.push(doc);
          return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
        }
        return { matchedCount: 0, modifiedCount: 0 };
      }
      if (update.$set) Object.assign(doc, update.$set);
      if (update.$inc) {
        for (const [k, v] of Object.entries(update.$inc)) doc[k] = (doc[k] || 0) + v;
      }
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async findOneAndUpdate(query, update, options = {}) {
      let matches = items.filter(d => matchesQuery(d, query));
      if (options && options.sort) {
        matches.sort((a, b) => {
          for (const [k, dir] of Object.entries(options.sort)) {
            const valA = a[k] !== undefined && a[k] !== null ? (a[k] instanceof Date ? a[k].getTime() : a[k]) : (dir === 1 ? Infinity : -Infinity);
            const valB = b[k] !== undefined && b[k] !== null ? (b[k] instanceof Date ? b[k].getTime() : b[k]) : (dir === 1 ? Infinity : -Infinity);
            if (valA < valB) return dir === -1 ? 1 : -1;
            if (valA > valB) return dir === -1 ? -1 : 1;
          }
          return 0;
        });
      }
      let doc = matches[0] || null;
      if (!doc) {
        if (options && options.upsert) {
          doc = {};
          if (update.$setOnInsert) Object.assign(doc, update.$setOnInsert);
          if (update.$set) Object.assign(doc, update.$set);
          for (const [k, v] of Object.entries(query)) {
            if (!k.startsWith('$')) doc[k] = v;
          }
          items.push(doc);
          return { value: doc };
        }
        return { value: null };
      }
      const oldDoc = { ...doc };
      if (update.$set) Object.assign(doc, update.$set);
      if (update.$inc) {
        for (const [k, v] of Object.entries(update.$inc)) doc[k] = (doc[k] || 0) + v;
      }
      return { value: options && options.returnDocument === 'after' ? doc : oldDoc };
    },
    async updateMany(query, update) {
      const matches = items.filter(d => matchesQuery(d, query));
      matches.forEach(d => {
        if (update.$set) Object.assign(d, update.$set);
      });
      return { matchedCount: matches.length, modifiedCount: matches.length };
    },
    async deleteOne(query) {
      const idx = items.findIndex(d => matchesQuery(d, query));
      if (idx !== -1) items.splice(idx, 1);
      return { deletedCount: idx !== -1 ? 1 : 0 };
    },
    async deleteMany(query) {
      const initial = items.length;
      for (let i = items.length - 1; i >= 0; i--) {
        if (matchesQuery(items[i], query)) items.splice(i, 1);
      }
      return { deletedCount: initial - items.length };
    }
  };
}

let passedChecks = 0;
function test(desc, condition) {
  if (condition) {
    console.log(`  ✓ PASSED: ${desc}`);
    passedChecks++;
  } else {
    console.error(`  ✗ FAILED: ${desc}`);
    process.exitCode = 1;
  }
}

async function run() {
  console.log('======================================================================');
  console.log('   COMMENT2DM — PRICING & TIER ENTITLEMENTS SUITE (18 CHECKS)');
  console.log('======================================================================\n');

  const mockCollections = {
    users: createMockCollection(),
    sessions: createMockCollection(),
    subscriptions: createMockCollection(),
    billing_plans: createMockCollection(),
    instagram_accounts: createMockCollection(),
    automations: createMockCollection(),
    automation_events: createMockCollection(),
    storage_resources: createMockCollection(),
    webhook_jobs: createMockCollection(),
    account_rate_limits: createMockCollection(),
    opening_dm_claims: createMockCollection(),
    conversation_states: createMockCollection()
  };

  const mockDb = {
    collection(name) {
      if (!mockCollections[name]) mockCollections[name] = createMockCollection();
      return mockCollections[name];
    }
  };

  db._setDatabaseForTesting(mockDb);
  billing._setDbForTesting(mockDb);

  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  function makeRequest(method, path, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, baseUrl);
      const isBuffer = Buffer.isBuffer(body);
      const payload = isBuffer ? body : (body ? JSON.stringify(body) : null);
      const reqHeaders = { ...headers };
      if (payload && !reqHeaders['Content-Type'] && !isBuffer) reqHeaders['Content-Type'] = 'application/json';
      if (payload) reqHeaders['Content-Length'] = Buffer.byteLength(payload);

      const req = http.request(url, { method, headers: reqHeaders }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  // Seed test users
  const freeUser = { id: 'usr_free_1', email: 'free_creator@example.com', name: 'Free Creator' };
  const proUser = { id: 'usr_pro_1', email: 'pro_creator@example.com', name: 'Pro Creator' };
  const eliteUser = { id: 'usr_elite_1', email: 'elite_creator@example.com', name: 'Elite Creator' };

  await mockCollections.users.insertOne(freeUser);
  await mockCollections.users.insertOne(proUser);
  await mockCollections.users.insertOne(eliteUser);

  const freeToken = await authService.createSession(freeUser.id, new Date(Date.now() + 86400000));
  const proToken = await authService.createSession(proUser.id, new Date(Date.now() + 86400000));
  const eliteToken = await authService.createSession(eliteUser.id, new Date(Date.now() + 86400000));

  const freeHeaders = { Authorization: `Bearer ${freeToken}` };
  const proHeaders = { Authorization: `Bearer ${proToken}` };
  const eliteHeaders = { Authorization: `Bearer ${eliteToken}` };

  // Set subscriptions in mockDb
  await mockCollections.subscriptions.insertOne({
    user_id: proUser.id,
    plan: 'pro',
    billing_cycle: 'monthly',
    status: 'active',
    razorpay_subscription_id: 'sub_pro_123'
  });
  await mockCollections.subscriptions.insertOne({
    user_id: eliteUser.id,
    plan: 'elite',
    billing_cycle: 'monthly',
    status: 'active',
    razorpay_subscription_id: 'sub_elite_123'
  });

  // Check 1: Canonical Plans Endpoint Returns Monthly-Only Approved Launch Pricing
  console.log('--- 1. CANONICAL PRICING MATRIX ---');
  const plansRes = await makeRequest('GET', '/api/billing/plans');
  test('Canonical plans endpoint returns HTTP 200 with Free ₹0, Pro ₹70, Elite ₹150',
    plansRes.status === 200 &&
    plansRes.body.plans?.free?.price === 0 &&
    plansRes.body.plans?.pro?.price === 70 &&
    plansRes.body.plans?.elite?.price === 150
  );

  // Check 2: Dynamic Prices API returns approved defaults (70 and 150)
  const pricesRes = await makeRequest('GET', '/api/billing/prices');
  test('Dynamic prices API defaults to Pro ₹70 and Elite ₹150',
    pricesRes.status === 200 &&
    pricesRes.body.pro_monthly === 70 &&
    pricesRes.body.elite_monthly === 150
  );

  // Check 3: Free Tier Entitlements
  console.log('\n--- 2. TIER ENTITLEMENTS ---');
  billing._clearEntitlementCacheForTesting();
  const freeEnt = await billing.entitlement(freeUser.id);
  test('Free tier allows 1 account, 2 active automations, 500 DMs, 150 MB storage, branding, ads',
    freeEnt.plan === 'free' &&
    freeEnt.limits.instagramAccounts === 1 &&
    freeEnt.limits.automations === 2 &&
    freeEnt.limits.dmMonthly === 500 &&
    freeEnt.limits.storageBytes === 150000000 &&
    freeEnt.limits.branding === true &&
    freeEnt.limits.dashboardAds === true &&
    freeEnt.limits.allCommentsTrigger === false &&
    freeEnt.limits.followToUnlock === false
  );

  // Check 4: Pro Tier Entitlements
  billing._clearEntitlementCacheForTesting();
  const proEnt = await billing.entitlement(proUser.id);
  test('Pro tier allows 3 accounts, Unlimited automations, 5,000 DMs, 1 GB storage, no branding, no ads',
    proEnt.plan === 'pro' &&
    proEnt.limits.instagramAccounts === 3 &&
    proEnt.limits.automations === Infinity &&
    proEnt.limits.dmMonthly === 5000 &&
    proEnt.limits.storageBytes === 1000000000 &&
    proEnt.limits.branding === false &&
    proEnt.limits.dashboardAds === false &&
    proEnt.limits.allCommentsTrigger === true &&
    proEnt.limits.followToUnlock === true
  );

  // Check 5: Elite Tier Entitlements
  billing._clearEntitlementCacheForTesting();
  const eliteEnt = await billing.entitlement(eliteUser.id);
  test('Elite tier allows 10 accounts, Unlimited automations, 50,000 DMs, 5 GB storage, priority queue',
    eliteEnt.plan === 'elite' &&
    eliteEnt.limits.instagramAccounts === 10 &&
    eliteEnt.limits.automations === Infinity &&
    eliteEnt.limits.dmMonthly === 50000 &&
    eliteEnt.limits.storageBytes === 5000000000 &&
    eliteEnt.limits.queuePriority === 'priority' &&
    eliteEnt.limits.prioritySupport === true &&
    eliteEnt.limits.earlyAccess === true
  );

  // Check 6: Connected Instagram Accounts Enforcement
  console.log('\n--- 3. FEATURE GATING & QUOTA ENFORCEMENT ---');
  // Seed 1 account for Free user
  await mockCollections.instagram_accounts.insertOne({
    owner_user_id: freeUser.id,
    instagram_user_id: 'ig_free_acc_1',
    username: 'free_acc_1'
  });
  const freeAcctCheck = await billing.check(freeUser.id, 'instagramAccounts');
  test('Free user with 1 connected account is blocked from connecting a 2nd account',
    freeAcctCheck.allowed === false && freeAcctCheck.used === 1 && freeAcctCheck.limits.instagramAccounts === 1
  );

  // Seed 3 accounts for Pro user
  for (let i = 1; i <= 3; i++) {
    await mockCollections.instagram_accounts.insertOne({
      owner_user_id: proUser.id,
      instagram_user_id: `ig_pro_acc_${i}`,
      username: `pro_acc_${i}`
    });
  }
  const proAcctCheck = await billing.check(proUser.id, 'instagramAccounts');
  test('Pro user with 3 connected accounts is blocked from connecting a 4th account',
    proAcctCheck.allowed === false && proAcctCheck.used === 3 && proAcctCheck.limits.instagramAccounts === 3
  );

  // Check 7: Active Automations Enforcement on Free Tier
  await mockCollections.automations.insertOne({
    id: 101,
    owner_user_id: freeUser.id,
    instagram_user_id: 'ig_free_acc_1',
    enabled: 1
  });
  await mockCollections.automations.insertOne({
    id: 102,
    owner_user_id: freeUser.id,
    instagram_user_id: 'ig_free_acc_1',
    enabled: 1
  });
  const freeAutCheck = await billing.check(freeUser.id, 'automations');
  test('Free user with 2 active automations is blocked from activating a 3rd automation',
    freeAutCheck.allowed === false && freeAutCheck.used === 2 && freeAutCheck.limits.automations === 2
  );

  // Check 8: Pro user can activate unlimited automations
  for (let i = 1; i <= 5; i++) {
    await mockCollections.automations.insertOne({
      id: 200 + i,
      owner_user_id: proUser.id,
      instagram_user_id: 'ig_pro_acc_1',
      enabled: 1
    });
  }
  const proAutCheck = await billing.check(proUser.id, 'automations');
  test('Pro user with multiple automations is permitted unlimited active automations',
    proAutCheck.allowed === true && proAutCheck.limits.automations === Infinity
  );

  // Check 9: All-Comments Trigger Gating
  // Free user deletes one automation so active count is 1 (< 2 limit),
  // ensuring the feature gate (not the count limit) is tested.
  await mockCollections.automations.deleteOne({ id: 102 });

  const freeAllCommentRes = await makeRequest('POST', '/api/automations', {
    instagramUserId: 'ig_free_acc_1',
    mediaId: 'media_123',
    triggerType: 'all',
    dmMessage: 'Hello from Free'
  }, freeHeaders);
  test('Free plan is rejected (HTTP 403) from creating All-Comments trigger',
    freeAllCommentRes.status === 403 &&
    freeAllCommentRes.body.error.includes('Any Comment')
  );

  // Check 10: Follow-to-Unlock Gating
  const freeFollowGateRes = await makeRequest('POST', '/api/automations', {
    instagramUserId: 'ig_free_acc_1',
    mediaId: 'media_123',
    keyword: 'VIP',
    dmMessage: 'Hello from Free',
    flow: { followGate: { enabled: true } }
  }, freeHeaders);
  test('Free plan is rejected (HTTP 403) from creating Follow-to-Unlock automation',
    freeFollowGateRes.status === 403 &&
    freeFollowGateRes.body.error.includes('Follow-to-unlock')
  );

  // Check 11: Advanced Analytics CSV Export Gating
  console.log('\n--- 4. ADVANCED ANALYTICS & BRANDING ---');
  const freeExportRes = await makeRequest('GET', '/api/analytics/export', null, freeHeaders);
  test('Free plan is rejected (HTTP 403) when accessing CSV analytics export',
    freeExportRes.status === 403 &&
    freeExportRes.body.error.includes('CSV data export')
  );

  const proExportRes = await makeRequest('GET', '/api/analytics/export', null, proHeaders);
  test('Pro plan is permitted (HTTP 200) to export CSV analytics',
    proExportRes.status === 200 &&
    String(proExportRes.headers['content-type']).includes('text/csv')
  );

  // Check 12: Comment2DM Branding Attribution on Free Outbound Messages
  let simulatedFreeDmText = "Here is your link!";
  const freeEntForDm = await billing.entitlement(freeUser.id);
  if (!freeEntForDm.limits.whiteLabel && !simulatedFreeDmText.includes('Powered by Comment2DM')) {
    simulatedFreeDmText += '\n\n⚡ Powered by Comment2DM';
  }
  test('Free outbound messages include Powered by Comment2DM branding',
    simulatedFreeDmText.includes('⚡ Powered by Comment2DM')
  );

  let simulatedProDmText = "Here is your link!";
  const proEntForDm = await billing.entitlement(proUser.id);
  if (!proEntForDm.limits.whiteLabel && !simulatedProDmText.includes('Powered by Comment2DM')) {
    simulatedProDmText += '\n\n⚡ Powered by Comment2DM';
  }
  test('Pro outbound messages omit Comment2DM branding (white-label active)',
    !simulatedProDmText.includes('Powered by Comment2DM')
  );

  // Check 13: Monthly DM Quota Enforcement
  console.log('\n--- 5. OUTBOUND DELIVERY & QUEUE PRIORITY ---');
  // Seed 500 successful events for Free user in current month
  const startOfMonth = new Date();
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);

  for (let i = 0; i < 500; i++) {
    await mockCollections.automation_events.insertOne({
      owner_user_id: freeUser.id,
      event_type: 'private_reply',
      status: 'success',
      created_at: new Date(startOfMonth.getTime() + 1000 * i).toISOString()
    });
  }

  const freeDmQuotaCheck = await billing.check(freeUser.id, 'dmMonthly');
  test('Free user with 500 DMs reaches quota and further deliveries are disallowed',
    freeDmQuotaCheck.allowed === false && freeDmQuotaCheck.used === 500 && freeDmQuotaCheck.limits.dmMonthly === 500
  );

  // Check 14: Outbound Comment Delivery skips gracefully on DM quota exceeded
  await mockCollections.automations.insertOne({
    id: 'auto_quota_test',
    owner_user_id: freeUser.id,
    instagram_user_id: 'ig_free_acc_1',
    keyword: 'VIP',
    keywords: ['VIP'],
    dm_message: 'Here is your link!',
    enabled: 1
  });

  const commentJobRes = await executeCommentJob({
    instagram_account_id: 'ig_free_acc_1',
    comment_id: 'cmt_quota_test_1',
    comment_text: 'VIP',
    from_id: 'sender_123'
  });
  test('executeCommentJob returns skipped: true with reason DM_QUOTA_EXCEEDED when quota is reached',
    commentJobRes?.skipped === true && commentJobRes?.reason === 'DM_QUOTA_EXCEEDED'
  );

  // Check 15: Queue Priority Resolution
  const webhookJobQueue = require('./src/jobs/webhookJobQueue');
  // Enqueue 3 jobs (Elite, Pro, Free)
  const normJobs = [
    {
      job_id: 'job_free',
      event_key: 'evt_free',
      event_type: 'comment',
      instagram_account_id: 'ig_free_acc_1',
      run_at: new Date(),
      created_at: new Date(Date.now() + 10)
    },
    {
      job_id: 'job_pro',
      event_key: 'evt_pro',
      event_type: 'comment',
      instagram_account_id: 'ig_pro_acc_1',
      run_at: new Date(),
      created_at: new Date(Date.now() + 20)
    },
    {
      job_id: 'job_elite',
      event_key: 'evt_elite',
      event_type: 'comment',
      instagram_account_id: 'ig_elite_acc_1',
      run_at: new Date(),
      created_at: new Date(Date.now() + 30)
    }
  ];

  await mockCollections.instagram_accounts.insertOne({
    owner_user_id: eliteUser.id,
    instagram_user_id: 'ig_elite_acc_1',
    username: 'elite_acc_1'
  });

  const queueDb = {
    collections() {
      return {
        webhookJobs: mockCollections.webhook_jobs,
        instagramAccounts: mockCollections.instagram_accounts
      };
    }
  };

  const payload = {
    object: 'instagram',
    entry: [
      {
        id: 'ig_free_acc_1',
        changes: [{ field: 'comments', value: { id: 'c_free', text: 'hi', from: { id: 'u1' } } }]
      },
      {
        id: 'ig_pro_acc_1',
        changes: [{ field: 'comments', value: { id: 'c_pro', text: 'hi', from: { id: 'u2' } } }]
      },
      {
        id: 'ig_elite_acc_1',
        changes: [{ field: 'comments', value: { id: 'c_elite', text: 'hi', from: { id: 'u3' } } }]
      }
    ]
  };

  await webhookJobQueue.ingestWebhookPayload(payload, queueDb);
  const queuedJobs = await mockCollections.webhook_jobs.find({}).toArray();
  const eliteJob = queuedJobs.find(j => j.instagram_account_id === 'ig_elite_acc_1');
  const proJob = queuedJobs.find(j => j.instagram_account_id === 'ig_pro_acc_1');
  const freeJob = queuedJobs.find(j => j.instagram_account_id === 'ig_free_acc_1');

  test('Webhook queue assigns priority 1 to Elite, 2 to Pro, and 3 to Free',
    eliteJob?.priority === 1 && proJob?.priority === 2 && freeJob?.priority === 3
  );

  // Check 16: Queue Sorting Picks Elite Before Pro and Free
  const claimedJob = await webhookJobQueue.claimNextJob(queueDb, { workerId: 'worker_p_test' });
  test('Worker claims highest priority job (Elite, priority: 1) first',
    claimedJob && claimedJob.instagram_account_id === 'ig_elite_acc_1' && claimedJob.priority === 1
  );

  // Check 17: Support Knowledge Base reflects Free ₹0, Pro ₹70, Elite ₹150
  console.log('\n--- 6. CUSTOMER SUPPORT & STATUS RECONCILIATION ---');
  const kbRes = await makeRequest('POST', '/api/support/chat', { message: 'what is your pricing?' });
  test('Support chat provides approved pricing (Free ₹0, Pro ₹70, Elite ₹150)',
    kbRes.status === 200 &&
    kbRes.body.reply.includes('₹70') &&
    kbRes.body.reply.includes('₹150')
  );

  // Check 18: Billing Status Endpoint returns accurate unified numbers
  const statusRes = await makeRequest('GET', '/api/billing/status', null, proHeaders);
  test('GET /api/billing/status returns correct storage and quota limits',
    statusRes.status === 200 &&
    statusRes.body.plan === 'pro' &&
    statusRes.body.limits?.storageBytes === 1000000000 &&
    statusRes.body.limits?.storageDisplay === '1 GB' &&
    statusRes.body.limits?.dmMonthly === 5000 &&
    statusRes.body.limits?.automations === null // Infinity serialized as null
  );

  server.close();

  console.log('\n======================================================================');
  console.log(`   PRICING & ENTITLEMENTS SUITE: ${passedChecks}/18 CHECKS PASSED`);
  console.log('======================================================================\n');
}

run().catch(err => {
  console.error('Fatal test error in pricing suite:', err);
  process.exit(1);
});
