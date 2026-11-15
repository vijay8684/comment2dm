// test_razorpay_subscription_integration_suite.js
// Comprehensive test suite for Comment2DM Razorpay Subscriptions Integration
// Tests: Missing credentials, Subscription creation, Signatures, Webhooks, Idempotency,
// Lifecycle events, Cancellation, and Entitlement updates.

const assert = require('assert');
const http = require('http');
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test_jwt_secret_comment2dm_billing_suite_32chars!';

const db = require('./src/db');
const authService = require('./src/auth/authService');
const billing = require('./src/billing');

// Minimal in-memory mock MongoDB collection
function applyMongoUpdate(doc, update) {
  if (update.$set) {
    for (const [k, v] of Object.entries(update.$set)) {
      if (k.includes('.$.')) {
        const [arrKey, propKey] = k.split('.$.');
        if (Array.isArray(doc[arrKey]) && doc[arrKey].length > 0) {
          doc[arrKey][0][propKey] = v;
        }
      } else {
        doc[k] = v;
      }
    }
  }
  if (update.$inc) {
    for (const [k, v] of Object.entries(update.$inc)) {
      doc[k] = (doc[k] || 0) + v;
    }
  }
  if (update.$push) {
    for (const [k, v] of Object.entries(update.$push)) {
      if (!Array.isArray(doc[k])) doc[k] = [];
      doc[k].push({ ...v });
    }
  }
}

function toCompareVal(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string' && !isNaN(Date.parse(v)) && isNaN(Number(v))) return new Date(v).getTime();
  if (typeof v === 'number') return v;
  return v;
}

function matchesQuery(doc, query) {
  if (!query || Object.keys(query).length === 0) return true;
  if (!doc) return false;
  for (const [key, val] of Object.entries(query)) {
    if (key === '$or' && Array.isArray(val)) {
      const matched = val.some(q => matchesQuery(doc, q));
      if (!matched) return false;
      continue;
    }
    if (key === '$and' && Array.isArray(val)) {
      const matched = val.every(q => matchesQuery(doc, q));
      if (!matched) return false;
      continue;
    }
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      if (val instanceof Date) {
        const dVal = toCompareVal(doc[key]);
        if (dVal !== val.getTime()) return false;
        continue;
      }
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
      if (val.$gt !== undefined) {
        const dVal = toCompareVal(doc[key]);
        const qVal = toCompareVal(val.$gt);
        if (!(dVal > qVal)) return false;
        continue;
      }
      if (val.$gte !== undefined) {
        const dVal = toCompareVal(doc[key]);
        const qVal = toCompareVal(val.$gte);
        if (!(dVal >= qVal)) return false;
        continue;
      }
      if (val.$lt !== undefined) {
        const dVal = toCompareVal(doc[key]);
        const qVal = toCompareVal(val.$lt);
        if (!(dVal < qVal)) return false;
        continue;
      }
      if (val.$lte !== undefined) {
        const dVal = toCompareVal(doc[key]);
        const qVal = toCompareVal(val.$lte);
        if (!(dVal <= qVal)) return false;
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
      return {
        sort() { return this; },
        limit() { return this; },
        async toArray() { return items.filter(d => matchesQuery(d, query)); }
      };
    },
    async findOne(query = {}) {
      return items.find(d => matchesQuery(d, query)) || null;
    },
    async insertOne(doc) {
      // Enforce unique index for billing_events event_id
      if (doc.event_id && items.some(d => d.event_id === doc.event_id)) {
        const err = new Error('E11000 duplicate key error');
        err.code = 11000;
        throw err;
      }
      const copy = { ...doc };
      if (!copy._id) copy._id = 'mock_' + Math.random().toString(36).substring(2, 9);
      items.push(copy);
      return { insertedId: copy._id };
    },
    async updateOne(filter, update, options = {}) {
      let doc = items.find(d => matchesQuery(d, filter));
      let upsertedCount = 0;
      if (!doc && options.upsert) {
        doc = {};
        for (const [k, v] of Object.entries(filter)) {
          if (!k.startsWith('$') && (typeof v !== 'object' || v === null || v instanceof Date)) {
            doc[k] = v;
          }
        }
        items.push(doc);
        upsertedCount = 1;
      }
      if (!doc) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      if (options.upsert && upsertedCount === 1 && update.$setOnInsert) {
        Object.assign(doc, update.$setOnInsert);
      }
      applyMongoUpdate(doc, update);
      return { matchedCount: upsertedCount ? 0 : 1, modifiedCount: 1, upsertedCount };
    },
    async deleteOne(filter) {
      const idx = items.findIndex(d => matchesQuery(d, filter));
      if (idx !== -1) {
        items.splice(idx, 1);
        return { deletedCount: 1 };
      }
      return { deletedCount: 0 };
    },
    async deleteMany(filter) {
      let count = 0;
      for (let i = items.length - 1; i >= 0; i--) {
        if (matchesQuery(items[i], filter)) {
          items.splice(i, 1);
          count++;
        }
      }
      return { deletedCount: count };
    },
    async countDocuments(query = {}) {
      return items.filter(d => matchesQuery(d, query)).length;
    },
    async createIndex() { return 'mock_idx'; }
  };
}

let passedChecks = 0;
function test(name, condition) {
  if (condition) {
    console.log(`  ✓ PASSED: ${name}`);
    passedChecks++;
  } else {
    console.error(`  ✗ FAILED: ${name}`);
    process.exitCode = 1;
  }
}

async function runSuite() {
  console.log('======================================================================');
  console.log('   COMMENT2DM — RAZORPAY SUBSCRIPTION INTEGRATION TEST SUITE');
  console.log('======================================================================');

  const mockCollections = {
    users: createMockCollection(),
    sessions: createMockCollection(),
    subscriptions: createMockCollection(),
    billing_plans: createMockCollection(),
    billing_events: createMockCollection(),
    instagram_accounts: createMockCollection(),
    automations: createMockCollection(),
    automation_events: createMockCollection(),
    rate_limits: createMockCollection()
  };

  const mockDb = {
    collection(name) {
      if (!mockCollections[name]) mockCollections[name] = createMockCollection();
      return mockCollections[name];
    }
  };

  db._setDatabaseForTesting(mockDb);
  billing._setDbForTesting(mockDb);

  // Seed test users
  const testUser = {
    id: 'usr_sub_test',
    email: 'creator_test@comment2dm.com',
    name: 'Creator Test',
    is_verified: true,
    created_at: new Date().toISOString()
  };
  await mockCollections.users.insertOne(testUser);

  const testToken = await authService.createSession(testUser.id, new Date(Date.now() + 86400000));
  const authHeaders = { Authorization: `Bearer ${testToken}` };

  async function resetRateLimits() {
    await mockCollections.rate_limits.deleteMany({});
  }

  // Set up Express test server
  const app = express();
  billing.register(app);

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
      if (payload && !reqHeaders['Content-Type'] && !isBuffer) {
        reqHeaders['Content-Type'] = 'application/json';
      }
      if (payload) {
        reqHeaders['Content-Length'] = Buffer.byteLength(payload);
      }

      const req = http.request(url, { method, headers: reqHeaders }, (res) => {
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

  try {
    // -----------------------------------------------------------------------
    // 1. MISSING CREDENTIALS HANDLING TESTS
    // -----------------------------------------------------------------------
    console.log('\n--- 1. MISSING CREDENTIALS HANDLING ---');

    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    billing._setRazorpayForTesting(null);

    // 1.1: Create subscription fails safely with 503 when keys are unset
    const noCredCreate = await makeRequest('POST', '/api/billing/create-subscription', { planKey: 'pro_monthly' }, authHeaders);
    test('POST /api/billing/create-subscription returns HTTP 503 when Razorpay keys missing',
      noCredCreate.status === 503 && noCredCreate.body.error.includes('Razorpay is not configured')
    );

    // 1.2: Verify subscription fails safely with 503 when secret is unset
    const noCredVerify = await makeRequest('POST', '/api/billing/verify-subscription', {
      razorpay_subscription_id: 'sub_123',
      razorpay_payment_id: 'pay_123',
      razorpay_signature: 'sig_123'
    }, authHeaders);
    test('POST /api/billing/verify-subscription returns HTTP 503 when Key Secret missing',
      noCredVerify.status === 503 && noCredVerify.body.error.includes('not configured')
    );

    // 1.3: Webhook endpoint fails safely with 503 when webhook secret is unset
    const noCredWebhook = await makeRequest('POST', '/api/billing/webhook', Buffer.from(JSON.stringify({ event: 'test' })), {
      'Content-Type': 'application/json',
      'x-razorpay-signature': 'any_sig'
    });
    test('POST /api/billing/webhook returns HTTP 503 when Webhook Secret missing',
      noCredWebhook.status === 503 && String(noCredWebhook.body).includes('Webhook secret is not configured')
    );

    // 1.4: Verify client billing.js contains NO rzp_test_placeholder fallback
    const fs = require('fs');
    const path = require('path');
    const clientBillingJs = fs.readFileSync(path.join(__dirname, 'billing.js'), 'utf8');
    test('billing.js has removed rzp_test_placeholder fallback', !clientBillingJs.includes('rzp_test_placeholder'));
    test('billing.js validates keyId and subscriptionId before opening checkout',
      clientBillingJs.includes('!data.keyId') && clientBillingJs.includes('!data.subscriptionId')
    );

    // -----------------------------------------------------------------------
    // 2. SUBSCRIPTION CREATION & CHECKOUT TESTS
    // -----------------------------------------------------------------------
    console.log('\n--- 2. SUBSCRIPTION CREATION & CHECKOUT ---');
    await resetRateLimits();

    // Configure test mode credentials
    process.env.RAZORPAY_KEY_ID = 'rzp_test_TzjG2mAiJjGWxv';
    process.env.RAZORPAY_KEY_SECRET = 'FTjrig5RKFU6dvMcpwGXzC3j';
    process.env.RAZORPAY_WEBHOOK_SECRET = 'Commnet2DM_Billing';

    let createdSubscriptionParams = null;
    const mockRazorpay = {
      subscriptions: {
        async create(params) {
          createdSubscriptionParams = params;
          return {
            id: 'sub_test_' + Math.random().toString(36).substring(2, 9),
            status: 'created',
            plan_id: params.plan_id,
            total_count: params.total_count
          };
        },
        async cancel(subId) {
          return { id: subId, status: 'cancelled' };
        }
      }
    };
    billing._setRazorpayForTesting(mockRazorpay);

    // Pre-populate mock billing_plans for fast testing
    await mockCollections.billing_plans.insertOne({ plan_key: 'pro_monthly', razorpay_plan_id: 'plan_pro_m_123' });
    await mockCollections.billing_plans.insertOne({ plan_key: 'pro_annual', razorpay_plan_id: 'plan_pro_a_123' });
    await mockCollections.billing_plans.insertOne({ plan_key: 'elite_monthly', razorpay_plan_id: 'plan_elite_m_123' });
    await mockCollections.billing_plans.insertOne({ plan_key: 'elite_annual', razorpay_plan_id: 'plan_elite_a_123' });

    // 2.1: Authentication required
    const unauthCreate = await makeRequest('POST', '/api/billing/create-subscription', { planKey: 'pro_monthly' });
    test('POST /api/billing/create-subscription requires auth (HTTP 401)', unauthCreate.status === 401);

    // 2.2: Reject unknown plan key
    const invalidPlan = await makeRequest('POST', '/api/billing/create-subscription', { planKey: 'super_vip' }, authHeaders);
    test('POST /api/billing/create-subscription rejects invalid plan key (HTTP 400)', invalidPlan.status === 400);

    // 2.3: Successful Pro Monthly creation
    const proMonthlyRes = await makeRequest('POST', '/api/billing/create-subscription', { planKey: 'pro_monthly' }, authHeaders);
    test('Create Pro Monthly subscription returns HTTP 200 with subscriptionId and Key ID',
      proMonthlyRes.status === 200 &&
      proMonthlyRes.body.keyId === 'rzp_test_TzjG2mAiJjGWxv' &&
      proMonthlyRes.body.subscriptionId.startsWith('sub_test_') &&
      createdSubscriptionParams.plan_id === 'plan_pro_m_123' &&
      createdSubscriptionParams.total_count === 120
    );

    const subInDb = await mockCollections.subscriptions.findOne({ user_id: testUser.id });
    test('Subscription record persisted in database with status created',
      subInDb && subInDb.status === 'created' && subInDb.plan === 'pro' && subInDb.billing_cycle === 'monthly'
    );

    // 2.3b: Elite Monthly verification and rejection of unapproved Annual plans
    await mockCollections.subscriptions.deleteMany({ user_id: testUser.id });
    const eliteMonthlyRes = await makeRequest('POST', '/api/billing/create-subscription', { planKey: 'elite_monthly' }, authHeaders);
    test('Create Elite Monthly subscription returns HTTP 200 with plan_elite_m_123 and total_count: 120',
      eliteMonthlyRes.status === 200 &&
      createdSubscriptionParams.plan_id === 'plan_elite_m_123' &&
      createdSubscriptionParams.total_count === 120
    );

    const unapprovedAnnualRes = await makeRequest('POST', '/api/billing/create-subscription', { planKey: 'pro_annual' }, authHeaders);
    test('Unapproved annual plan checkout is safely rejected (HTTP 400)',
      unapprovedAnnualRes.status === 400
    );

    // Reset to Pro Monthly for remaining tests
    await resetRateLimits();
    await mockCollections.subscriptions.deleteMany({ user_id: testUser.id });
    await makeRequest('POST', '/api/billing/create-subscription', { planKey: 'pro_monthly' }, authHeaders);
    const resetSubInDb = await mockCollections.subscriptions.findOne({ user_id: testUser.id });

    // 2.4: Re-attempting checkout on same pending plan returns existing subscriptionId (no duplicate object)
    const retryRes = await makeRequest('POST', '/api/billing/create-subscription', { planKey: 'pro_monthly' }, authHeaders);
    test('Re-attempting checkout on uncompleted plan reuses existing subscriptionId',
      retryRes.status === 200 && retryRes.body.subscriptionId === resetSubInDb.razorpay_subscription_id
    );

    // 2.5: Prevent duplicate subscription when an active subscription exists (HTTP 409)
    await resetRateLimits();
    await mockCollections.subscriptions.updateOne({ user_id: testUser.id }, { $set: { status: 'active' } });
    const duplicateBlock = await makeRequest('POST', '/api/billing/create-subscription', { planKey: 'elite_monthly' }, authHeaders);
    test('POST /api/billing/create-subscription blocks duplicate active subscription (HTTP 409 Conflict)',
      duplicateBlock.status === 409 && duplicateBlock.body.error.includes('already have an active subscription')
    );

    // -----------------------------------------------------------------------
    // 3. PAYMENT SIGNATURE VERIFICATION TESTS
    // -----------------------------------------------------------------------
    console.log('\n--- 3. PAYMENT SIGNATURE VERIFICATION ---');
    await resetRateLimits();

    const activeSub = await mockCollections.subscriptions.findOne({ user_id: testUser.id });
    const testPaymentId = 'pay_test_payment_999';

    // 3.1: Reject incomplete payload
    const incompleteVerify = await makeRequest('POST', '/api/billing/verify-subscription', {
      razorpay_subscription_id: activeSub.razorpay_subscription_id
      // missing payment_id and signature
    }, authHeaders);
    test('POST /api/billing/verify-subscription rejects incomplete data (HTTP 400)', incompleteVerify.status === 400);

    // 3.2: Reject tampered / invalid signature
    const invalidSigVerify = await makeRequest('POST', '/api/billing/verify-subscription', {
      razorpay_subscription_id: activeSub.razorpay_subscription_id,
      razorpay_payment_id: testPaymentId,
      razorpay_signature: 'invalid_tampered_hmac_signature'
    }, authHeaders);
    test('POST /api/billing/verify-subscription rejects invalid signature (HTTP 400)', invalidSigVerify.status === 400);

    // 3.3: Accept valid HMAC SHA256 signature
    const validSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${testPaymentId}|${activeSub.razorpay_subscription_id}`)
      .digest('hex');

    const validVerify = await makeRequest('POST', '/api/billing/verify-subscription', {
      razorpay_subscription_id: activeSub.razorpay_subscription_id,
      razorpay_payment_id: testPaymentId,
      razorpay_signature: validSignature
    }, authHeaders);
    test('POST /api/billing/verify-subscription verifies valid signature (HTTP 200)',
      validVerify.status === 200 && validVerify.body.verified === true && validVerify.body.plan === 'pro'
    );

    const verifiedSub = await mockCollections.subscriptions.findOne({ razorpay_subscription_id: activeSub.razorpay_subscription_id });
    test('Subscription status updated to active in DB with razorpay_payment_id stored',
      verifiedSub.status === 'active' && verifiedSub.razorpay_payment_id === testPaymentId
    );

    // -----------------------------------------------------------------------
    // 4. WEBHOOK INTEGRATION & IDEMPOTENCY TESTS
    // -----------------------------------------------------------------------
    console.log('\n--- 4. WEBHOOK INTEGRATION & IDEMPOTENCY ---');

    function createSignedWebhook(eventPayload) {
      const raw = Buffer.from(JSON.stringify(eventPayload));
      const sig = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest('hex');
      return { raw, sig };
    }

    const testWebhookEvent = {
      event: 'subscription.activated',
      payload: {
        subscription: {
          entity: {
            id: activeSub.razorpay_subscription_id,
            status: 'active',
            current_start: Math.floor(Date.now() / 1000),
            current_end: Math.floor(Date.now() / 1000) + 30 * 86400
          }
        }
      }
    };
    const signedWh = createSignedWebhook(testWebhookEvent);

    // 4.0: Reject non-JSON webhook body
    const badJsonSig = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(Buffer.from('not_json_data')).digest('hex');
    const badJsonWh = await makeRequest('POST', '/api/billing/webhook', Buffer.from('not_json_data'), {
      'Content-Type': 'application/json',
      'x-razorpay-signature': badJsonSig
    });
    test('Webhook rejects malformed non-JSON payload (HTTP 400)', badJsonWh.status === 400);

    // 4.1: Reject webhook without signature header
    const noSigWh = await makeRequest('POST', '/api/billing/webhook', signedWh.raw, {
      'Content-Type': 'application/json'
    });
    test('Webhook rejects missing signature header (HTTP 400)', noSigWh.status === 400);

    // 4.2: Reject webhook with invalid signature header
    const badSigWh = await makeRequest('POST', '/api/billing/webhook', signedWh.raw, {
      'Content-Type': 'application/json',
      'x-razorpay-signature': 'bad_fake_signature'
    });
    test('Webhook rejects invalid signature header (HTTP 400)', badSigWh.status === 400);

    // 4.3: Process valid webhook event
    const validWh = await makeRequest('POST', '/api/billing/webhook', signedWh.raw, {
      'Content-Type': 'application/json',
      'x-razorpay-signature': signedWh.sig,
      'x-razorpay-event-id': 'evt_test_activation_001'
    });
    test('Webhook processes valid subscription.activated event (HTTP 200 ok: true)',
      validWh.status === 200 && validWh.body.ok === true && !validWh.body.duplicate
    );

    // 4.4: Webhook Replay Protection (Idempotency)
    const replayWh = await makeRequest('POST', '/api/billing/webhook', signedWh.raw, {
      'Content-Type': 'application/json',
      'x-razorpay-signature': signedWh.sig,
      'x-razorpay-event-id': 'evt_test_activation_001'
    });
    test('Duplicate webhook delivery detected and handled idempotently (ok: true, duplicate: true)',
      replayWh.status === 200 && replayWh.body.ok === true && replayWh.body.duplicate === true
    );

    // 4.5: Webhook subscription lifecycle events
    const haltedPayload = {
      event: 'subscription.halted',
      payload: {
        subscription: {
          entity: {
            id: activeSub.razorpay_subscription_id,
            status: 'halted'
          }
        }
      }
    };
    const signedHalted = createSignedWebhook(haltedPayload);
    await makeRequest('POST', '/api/billing/webhook', signedHalted.raw, {
      'Content-Type': 'application/json',
      'x-razorpay-signature': signedHalted.sig,
      'x-razorpay-event-id': 'evt_test_halted_002'
    });

    const haltedSub = await mockCollections.subscriptions.findOne({ razorpay_subscription_id: activeSub.razorpay_subscription_id });
    test('Webhook subscription.halted maps status to halted', haltedSub.status === 'halted');

    const cancelledPayload = {
      event: 'subscription.cancelled',
      payload: {
        subscription: {
          entity: {
            id: activeSub.razorpay_subscription_id,
            status: 'cancelled'
          }
        }
      }
    };
    const signedCancelled = createSignedWebhook(cancelledPayload);
    await makeRequest('POST', '/api/billing/webhook', signedCancelled.raw, {
      'Content-Type': 'application/json',
      'x-razorpay-signature': signedCancelled.sig,
      'x-razorpay-event-id': 'evt_test_cancelled_003'
    });

    const cancelledSub = await mockCollections.subscriptions.findOne({ razorpay_subscription_id: activeSub.razorpay_subscription_id });
    test('Webhook subscription.cancelled maps status to cancelled', cancelledSub.status === 'cancelled');

    // 4.6: Webhook subscription.pending
    const pendingPayload = {
      event: 'subscription.pending',
      payload: { subscription: { entity: { id: activeSub.razorpay_subscription_id, status: 'pending' } } }
    };
    const signedPending = createSignedWebhook(pendingPayload);
    await makeRequest('POST', '/api/billing/webhook', signedPending.raw, {
      'Content-Type': 'application/json',
      'x-razorpay-signature': signedPending.sig,
      'x-razorpay-event-id': 'evt_test_pending_004'
    });
    const pendingSub = await mockCollections.subscriptions.findOne({ razorpay_subscription_id: activeSub.razorpay_subscription_id });
    test('Webhook subscription.pending maps status to pending', pendingSub.status === 'pending');

    // 4.7: Webhook subscription.completed
    const completedPayload = {
      event: 'subscription.completed',
      payload: { subscription: { entity: { id: activeSub.razorpay_subscription_id, status: 'completed' } } }
    };
    const signedCompleted = createSignedWebhook(completedPayload);
    await makeRequest('POST', '/api/billing/webhook', signedCompleted.raw, {
      'Content-Type': 'application/json',
      'x-razorpay-signature': signedCompleted.sig,
      'x-razorpay-event-id': 'evt_test_completed_005'
    });
    const completedSub = await mockCollections.subscriptions.findOne({ razorpay_subscription_id: activeSub.razorpay_subscription_id });
    test('Webhook subscription.completed maps status to completed', completedSub.status === 'completed');

    // -----------------------------------------------------------------------
    // 5. SUBSCRIPTION CANCELLATION & PROTECTION TESTS
    // -----------------------------------------------------------------------
    console.log('\n--- 5. SUBSCRIPTION CANCELLATION & PROTECTION ---');
    await resetRateLimits();

    // Reset to active subscription for cancellation test
    await mockCollections.subscriptions.updateOne(
      { razorpay_subscription_id: activeSub.razorpay_subscription_id },
      { $set: { status: 'active' } }
    );

    // 5.1: Razorpay failure keeps subscription active (fail safe)
    let simulateRazorpayFail = true;
    billing._setRazorpayForTesting({
      subscriptions: {
        async cancel() {
          if (simulateRazorpayFail) throw new Error('Razorpay Gateway 504 Timeout');
          return { id: activeSub.razorpay_subscription_id, status: 'cancelled' };
        }
      }
    });

    const failCancel = await makeRequest('POST', '/api/billing/cancel', {}, authHeaders);
    test('POST /api/billing/cancel returns HTTP 502 when payment provider fails', failCancel.status === 502);

    const stillActive = await mockCollections.subscriptions.findOne({ razorpay_subscription_id: activeSub.razorpay_subscription_id });
    test('Subscription remains active in DB when payment provider cancellation fails', stillActive.status === 'active');

    // 5.2: Provider confirmation cancels subscription cleanly
    simulateRazorpayFail = false;
    const successCancel = await makeRequest('POST', '/api/billing/cancel', {}, authHeaders);
    test('POST /api/billing/cancel succeeds (HTTP 200) when provider confirms cancellation',
      successCancel.status === 200 && successCancel.body.cancelled === true
    );

    const nowCancelled = await mockCollections.subscriptions.findOne({ razorpay_subscription_id: activeSub.razorpay_subscription_id });
    test('Subscription updated to cancelled in DB after confirmed provider response', nowCancelled.status === 'cancelled');

    // -----------------------------------------------------------------------
    // 6. USER ENTITLEMENT UPDATES & TIER QUOTAS
    // -----------------------------------------------------------------------
    console.log('\n--- 6. USER ENTITLEMENT UPDATES & TIER QUOTAS ---');

    // 6.1: Cancelled subscription drops user back to Free tier
    billing._clearEntitlementCacheForTesting();
    const freeEntitlement = await billing.entitlement(testUser.id);
    test('User with cancelled subscription receives Free tier entitlement',
      freeEntitlement.plan === 'free' &&
      freeEntitlement.limits.dmMonthly === 500 &&
      freeEntitlement.limits.automations === 2 &&
      freeEntitlement.limits.instagramAccounts === 1 &&
      freeEntitlement.limits.whiteLabel === false &&
      freeEntitlement.limits.storageBytes === 150000000
    );

    // 6.2: Active Pro subscription grants Pro limits
    await mockCollections.subscriptions.updateOne(
      { razorpay_subscription_id: activeSub.razorpay_subscription_id },
      { $set: { status: 'active', plan: 'pro' } }
    );
    billing._clearEntitlementCacheForTesting();
    const proEntitlement = await billing.entitlement(testUser.id);
    test('User with active Pro subscription receives Pro tier entitlement',
      proEntitlement.plan === 'pro' &&
      proEntitlement.limits.dmMonthly === 5000 &&
      proEntitlement.limits.automations === Infinity &&
      proEntitlement.limits.instagramAccounts === 3 &&
      proEntitlement.limits.whiteLabel === true &&
      proEntitlement.limits.storageBytes === 1000000000
    );

    // 6.3: Active Elite subscription grants Elite limits
    await mockCollections.subscriptions.updateOne(
      { razorpay_subscription_id: activeSub.razorpay_subscription_id },
      { $set: { status: 'active', plan: 'elite' } }
    );
    billing._clearEntitlementCacheForTesting();
    const eliteEntitlement = await billing.entitlement(testUser.id);
    test('User with active Elite subscription receives Elite tier entitlement',
      eliteEntitlement.plan === 'elite' &&
      eliteEntitlement.limits.dmMonthly === 50000 &&
      eliteEntitlement.limits.automations === Infinity &&
      eliteEntitlement.limits.instagramAccounts === 10
    );

    // 6.4: Admin email receives unlimited entitlements
    const adminUser = {
      id: 'usr_admin_test',
      email: 'admin@comment2dm.com'
    };
    process.env.ADMIN_EMAIL = 'admin@comment2dm.com';
    await mockCollections.users.insertOne(adminUser);
    billing._clearEntitlementCacheForTesting();
    const adminEntitlement = await billing.entitlement(adminUser.id);
    test('Admin email receives unlimited entitlements (isAdmin: true, dmMonthly: Infinity)',
      adminEntitlement.isAdmin === true && adminEntitlement.limits.dmMonthly === Infinity
    );

    console.log('======================================================================');
    console.log(`   RAZORPAY INTEGRATION TEST SUITE: ${passedChecks} CHECKS PASSED`);
    console.log('======================================================================\n');
  } finally {
    server.close();
  }
}

runSuite().catch(err => {
  console.error('Fatal error running Razorpay test suite:', err);
  process.exit(1);
});
