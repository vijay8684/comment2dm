// test_stage2_database_optimization_suite.js
// Verification suite for Comment2DM Performance Optimization Stage 2:
// Shared MongoClient Reuse, Database Lifecycle, & Per-Operation Entitlement Optimization

const assert = require('assert');
const crypto = require('crypto');
const db = require('./src/db');
const billing = require('./src/billing');
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

// In-Memory MongoDB mock simulating all collections and tracking query operations
function createMockDb() {
  const users = new Map();
  const subscriptions = new Map();
  const billingPlans = new Map();
  const webhookJobs = new Map();
  const queryCounts = {
    users_findOne: 0,
    subscriptions_findOne: 0,
    billingPlans_findOne: 0
  };

  const dbMock = {
    _queryCounts: queryCounts,
    collection(name) {
      if (name === 'users') {
        return {
          async findOne(query) {
            queryCounts.users_findOne++;
            for (const u of users.values()) {
              if (query.id && u.id === query.id) return u;
              if (query.email && u.email === query.email) return u;
            }
            return null;
          },
          async insertOne(doc) {
            users.set(doc.id, { ...doc });
            return { acknowledged: true };
          }
        };
      }
      if (name === 'subscriptions') {
        return {
          async findOne(query, options = {}) {
            queryCounts.subscriptions_findOne++;
            const matches = [];
            for (const s of subscriptions.values()) {
              if (query.user_id && s.user_id !== query.user_id) continue;
              if (query.status && s.status !== query.status) continue;
              matches.push(s);
            }
            if (options.sort && options.sort.created_at === -1) {
              matches.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
            }
            return matches[0] || null;
          },
          async insertOne(doc) {
            const saved = { ...doc, _id: crypto.randomUUID() };
            subscriptions.set(doc.user_id + '_' + (doc.razorpay_subscription_id || Date.now()), saved);
            return { acknowledged: true, insertedId: saved._id };
          },
          async updateOne(filter, update) {
            for (const s of subscriptions.values()) {
              if (filter.user_id && s.user_id === filter.user_id) {
                if (update.$set) Object.assign(s, update.$set);
                return { matchedCount: 1, modifiedCount: 1 };
              }
            }
            return { matchedCount: 0, modifiedCount: 0 };
          },
          createIndex: async () => ({})
        };
      }
      if (name === 'billing_plans') {
        return {
          async findOne(query) {
            queryCounts.billingPlans_findOne++;
            return billingPlans.get(query.plan_key) || null;
          },
          createIndex: async () => ({})
        };
      }
      if (name === 'billing_events') {
        return {
          createIndex: async () => ({})
        };
      }
      return {
        createIndex: async () => ({}),
        find: () => ({ toArray: async () => [] }),
        findOne: async () => null,
        countDocuments: async () => 0
      };
    }
  };

  return {
    db: dbMock,
    users,
    subscriptions,
    queryCounts
  };
}

(async () => {
  console.log('================================================================');
  console.log(' COMMENT2DM STAGE 2: DATABASE & ENTITLEMENT OPTIMIZATION SUITE');
  console.log('================================================================\n');

  // -------------------------------------------------------------------------
  // Test 1: Shared MongoClient reuse between src/db and src/billing
  // -------------------------------------------------------------------------
  await runTestAsync('Test 1: src/billing reuses the single shared MongoClient from src/db', async () => {
    const { db: mockDatabase } = createMockDb();
    const mockClient = { id: 'mock_mongo_client_singleton', close: async () => {} };

    // Set shared database in db module
    db._setDatabaseForTesting(mockDatabase, mockClient);
    await billing.close(); // Reset billing state

    const billingDb = await billing._getDb();
    assert.strictEqual(billingDb, null, 'billingDb should be uninitialized initially');

    // Calling store() should pick up the shared db instance from src/db
    const storedDb = await (async () => {
      // Trigger store via entitlement
      await billing.entitlement('any_user');
      return billing._getDb();
    })();

    assert.strictEqual(storedDb, mockDatabase, 'billing must reuse the exact db instance from src/db');
    assert.strictEqual(billing._getClient(), mockClient, 'billing must reuse the exact MongoClient from src/db');

    // Clean up
    await db.close();
    await billing.close();
  });

  // -------------------------------------------------------------------------
  // Test 2: Database initialization and failure handling
  // -------------------------------------------------------------------------
  await runTestAsync('Test 2: Database initialization error handling when MONGODB_URI is missing', async () => {
    const origUri = process.env.MONGODB_URI;
    delete process.env.MONGODB_URI;
    await db.close();

    let threw = false;
    try {
      await db.initialize();
    } catch (err) {
      threw = true;
      assert.ok(err.message.includes('MONGODB_URI must be configured'), 'Must throw descriptive error on missing URI');
    }
    assert.strictEqual(threw, true, 'db.initialize() must fail safely when URI is missing');

    // Idempotent close
    await db.close();
    assert.strictEqual(db.getDatabase(), null, 'Database must be null after close()');
    assert.strictEqual(db.getClient(), null, 'Client must be null after close()');

    if (origUri) process.env.MONGODB_URI = origUri;
  });

  // -------------------------------------------------------------------------
  // Test 3: Billing entitlement correctness across tiers
  // -------------------------------------------------------------------------
  await runTestAsync('Test 3: Billing entitlement correctness (free, pro, elite, admin)', async () => {
    const { db: mockDb, users, subscriptions } = createMockDb();
    db._setDatabaseForTesting(mockDb, { id: 'client_1' });
    billing._setDbForTesting(mockDb);

    // 1. Free tier user (no active subscription)
    users.set('usr_free', { id: 'usr_free', email: 'free_user@example.com' });
    const freeEnt = await billing.entitlement('usr_free');
    assert.strictEqual(freeEnt.plan, 'free');
    assert.strictEqual(freeEnt.limits.whiteLabel, false, 'Free tier must not have whiteLabel');
    assert.strictEqual(freeEnt.limits.allCommentsTrigger, false);
    assert.strictEqual(freeEnt.limits.followToUnlock, false);
    assert.strictEqual(freeEnt.limits.dmMonthly, 300);

    // 2. Pro tier user
    users.set('usr_pro', { id: 'usr_pro', email: 'pro_user@example.com' });
    subscriptions.set('usr_pro_sub', {
      user_id: 'usr_pro',
      status: 'active',
      plan: 'pro',
      created_at: new Date().toISOString()
    });
    const proEnt = await billing.entitlement('usr_pro');
    assert.strictEqual(proEnt.plan, 'pro');
    assert.strictEqual(proEnt.limits.whiteLabel, true, 'Pro tier must have whiteLabel');
    assert.strictEqual(proEnt.limits.allCommentsTrigger, true);
    assert.strictEqual(proEnt.limits.followToUnlock, true);
    assert.strictEqual(proEnt.limits.dmMonthly, 5000);

    // 3. Elite tier user
    users.set('usr_elite', { id: 'usr_elite', email: 'elite_user@example.com' });
    subscriptions.set('usr_elite_sub', {
      user_id: 'usr_elite',
      status: 'active',
      plan: 'elite',
      created_at: new Date().toISOString()
    });
    const eliteEnt = await billing.entitlement('usr_elite');
    assert.strictEqual(eliteEnt.plan, 'elite');
    assert.strictEqual(eliteEnt.limits.whiteLabel, true, 'Elite tier must have whiteLabel');
    assert.strictEqual(eliteEnt.limits.dmMonthly, 50000);

    // 4. Admin email user (overrides even without subscription)
    process.env.ADMIN_EMAIL = 'admin_owner@comment2dm.internal';
    users.set('usr_admin', { id: 'usr_admin', email: 'admin_owner@comment2dm.internal' });
    const adminEnt = await billing.entitlement('usr_admin');
    assert.strictEqual(adminEnt.isAdmin, true);
    assert.strictEqual(adminEnt.plan, 'elite');
    assert.strictEqual(adminEnt.limits.whiteLabel, true);
    assert.strictEqual(adminEnt.limits.dmMonthly, Infinity);

    await billing.close();
    await db.close();
  });

  // -------------------------------------------------------------------------
  // Test 4: Subscription and plan changes reflect immediately in new operations
  // -------------------------------------------------------------------------
  await runTestAsync('Test 4: Subscription changes reflect immediately across new operations (no stale cache)', async () => {
    const { db: mockDb, users, subscriptions } = createMockDb();
    db._setDatabaseForTesting(mockDb, { id: 'client_1' });
    billing._setDbForTesting(mockDb);

    const testUid = 'user_dynamic_sub';
    users.set(testUid, { id: testUid, email: 'dynamic_user@example.com' });

    // Step 1: User starts on Free plan
    const op1 = billing.createOperationContext();
    const ent1 = await billing.entitlement(testUid, op1);
    assert.strictEqual(ent1.plan, 'free');
    assert.strictEqual(ent1.limits.whiteLabel, false);

    // Step 2: User upgrades to Pro (subscription inserted)
    subscriptions.set(testUid + '_sub', {
      user_id: testUid,
      status: 'active',
      plan: 'pro',
      created_at: new Date().toISOString()
    });

    // Step 3: Next operation immediately reflects Pro without stale cache
    const op2 = billing.createOperationContext();
    const ent2 = await billing.entitlement(testUid, op2);
    assert.strictEqual(ent2.plan, 'pro', 'Must immediately reflect newly activated Pro subscription');
    assert.strictEqual(ent2.limits.whiteLabel, true);

    // Step 4: User cancels subscription
    subscriptions.get(testUid + '_sub').status = 'cancelled';

    // Step 5: Next operation immediately reflects cancellation
    const op3 = billing.createOperationContext();
    const ent3 = await billing.entitlement(testUid, op3);
    assert.strictEqual(ent3.plan, 'free', 'Must immediately reflect subscription cancellation');
    assert.strictEqual(ent3.limits.whiteLabel, false);

    await billing.close();
    await db.close();
  });

  // -------------------------------------------------------------------------
  // Test 5: Per-operation entitlement query count reduction
  // -------------------------------------------------------------------------
  await runTestAsync('Test 5: Per-operation reuse reduces database round trips from 10 queries to 2', async () => {
    const { db: mockDb, users, subscriptions, queryCounts } = createMockDb();
    db._setDatabaseForTesting(mockDb, { id: 'client_1' });
    billing._setDbForTesting(mockDb);

    const testUid = 'user_query_reduction';
    users.set(testUid, { id: testUid, email: 'query_user@example.com' });
    subscriptions.set(testUid + '_sub', {
      user_id: testUid,
      status: 'active',
      plan: 'pro',
      created_at: new Date().toISOString()
    });

    // Reset query counters
    queryCounts.users_findOne = 0;
    queryCounts.subscriptions_findOne = 0;

    // Simulate an operation (e.g. A single webhook job or HTTP request)
    const opContext = billing.createOperationContext();

    // Call entitlement 5 times within this operation
    const results = [];
    for (let i = 0; i < 5; i++) {
      const res = await billing.entitlement(testUid, opContext);
      results.push(res);
    }

    // Verify all 5 results are identical and correct
    for (const r of results) {
      assert.strictEqual(r.plan, 'pro');
      assert.strictEqual(r.limits.whiteLabel, true);
    }

    // Database should have been queried ONLY ONCE for users and ONLY ONCE for subscriptions!
    console.log(`   [METRIC] Database findOne queries across 5 entitlement calls in same operation:`);
    console.log(`            users.findOne: ${queryCounts.users_findOne} (expected: 1)`);
    console.log(`            subscriptions.findOne: ${queryCounts.subscriptions_findOne} (expected: 1)`);

    assert.strictEqual(queryCounts.users_findOne, 1, 'users collection must only be queried once per operation');
    assert.strictEqual(queryCounts.subscriptions_findOne, 1, 'subscriptions collection must only be queried once per operation');

    // A new operation context must query fresh data
    const opContext2 = billing.createOperationContext();
    await billing.entitlement(testUid, opContext2);
    assert.strictEqual(queryCounts.users_findOne, 2, 'New operation context must query fresh data');
    assert.strictEqual(queryCounts.subscriptions_findOne, 2, 'New operation context must query fresh data');

    await billing.close();
    await db.close();
  });

  // -------------------------------------------------------------------------
  // Test 6: White-label permission correctness in delivery messages
  // -------------------------------------------------------------------------
  await runTestAsync('Test 6: White-label branding attribution logic is preserved accurately', async () => {
    // Verify that Free tier receives attribution, and Pro/Elite tiers do not
    const freeLimits = billing.LIMITS.free;
    const proLimits = billing.LIMITS.pro;
    const eliteLimits = billing.LIMITS.elite;

    assert.strictEqual(freeLimits.whiteLabel, false);
    assert.strictEqual(proLimits.whiteLabel, true);
    assert.strictEqual(eliteLimits.whiteLabel, true);

    // Simulate formatting in server.js
    function formatDelivery(text, userEntitlement) {
      let deliveryText = text;
      if (!userEntitlement?.limits?.whiteLabel) {
        if (!deliveryText.includes('Powered by Comment2DM')) {
          deliveryText += '\n\n⚡ Powered by Comment2DM';
        }
      }
      return deliveryText;
    }

    const freeFormatted = formatDelivery('Here is your guide!', { limits: freeLimits });
    assert.ok(freeFormatted.includes('⚡ Powered by Comment2DM'), 'Free user must receive Powered by Comment2DM attribution');

    const proFormatted = formatDelivery('Here is your guide!', { limits: proLimits });
    assert.ok(!proFormatted.includes('⚡ Powered by Comment2DM'), 'Pro user must NOT receive branding attribution');

    const eliteFormatted = formatDelivery('Here is your guide!', { limits: eliteLimits });
    assert.ok(!eliteFormatted.includes('⚡ Powered by Comment2DM'), 'Elite user must NOT receive branding attribution');
  });

  // -------------------------------------------------------------------------
  // Test 7: Operation Context helper creation & direct pass-through
  // -------------------------------------------------------------------------
  await runTestAsync('Test 7: createOperationContext helper and direct entitlement pass-through', async () => {
    const ctx = billing.createOperationContext();
    assert.ok(ctx._entitlementCache instanceof Map);

    // Direct entitlement pass-through
    const precomputed = { plan: 'pro', limits: { whiteLabel: true } };
    const res = await billing.entitlement('uid_any', { entitlement: precomputed });
    assert.strictEqual(res, precomputed);
  });

  // -------------------------------------------------------------------------
  // Test 8: Concurrent database initialization creates only one connection attempt
  // -------------------------------------------------------------------------
  await runTestAsync('Test 8: Concurrent db.initialize() callers share a single connection attempt', async () => {
    await db.close();

    const origUri = process.env.MONGODB_URI;

    try {
      process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/nudge_test_concurrency';

      let clientInstantiations = 0;
      function MockMongoClient(uri, options) {
        clientInstantiations++;
        this.connect = async () => {
          await new Promise(r => setTimeout(r, 40)); // simulate connection latency
        };
        this.db = () => ({
          command: async () => ({ ok: 1 }),
          collection: () => ({ createIndex: async () => ({}) })
        });
        this.close = async () => {};
      }

      db._setMongoClientClassForTesting(MockMongoClient);

      // Fire 5 concurrent initialize calls simultaneously
      const initCalls = [
        db.initialize(),
        db.initialize(),
        db.initialize(),
        db.initialize(),
        db.initialize()
      ];

      const results = await Promise.all(initCalls);

      assert.strictEqual(results.length, 5);
      for (let i = 1; i < results.length; i++) {
        assert.strictEqual(results[i], results[0], 'All concurrent callers must receive identical database instance');
      }

      // Exactly ONE MongoClient must have been created across all 5 concurrent calls
      assert.strictEqual(clientInstantiations, 1, `Expected exactly 1 MongoClient instantiation but got ${clientInstantiations}`);

      await db.close();
    } finally {
      db._setMongoClientClassForTesting(null);
      process.env.MONGODB_URI = origUri;
    }
  });

  // -------------------------------------------------------------------------
  // Test 9: Connection failure cleanup and safe retry
  // -------------------------------------------------------------------------
  await runTestAsync('Test 9: Connection failure cleans up partial state and permits clean retry', async () => {
    await db.close();

    const origUri = process.env.MONGODB_URI;

    try {
      process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/nudge_test_failure';

      let clientClosed = false;
      let attempt = 0;

      function MockFailingClient(uri, options) {
        attempt++;
        this.connect = async () => {
          if (attempt === 1) {
            throw new Error('ECONNREFUSED: Simulated connection drop');
          }
        };
        this.db = () => ({
          command: async () => ({ ok: 1 }),
          collection: () => ({ createIndex: async () => ({}) })
        });
        this.close = async () => {
          clientClosed = true;
        };
      }

      db._setMongoClientClassForTesting(MockFailingClient);

      // Attempt 1: Fails
      let errorThrown = false;
      try {
        await db.initialize();
      } catch (err) {
        errorThrown = true;
        assert.ok(err.message.includes('ECONNREFUSED'));
      }
      assert.strictEqual(errorThrown, true, 'First attempt must reject');
      assert.strictEqual(clientClosed, true, 'Failed client must be closed');
      assert.strictEqual(db.getClient(), null, 'Client reference must be null after failure');
      assert.strictEqual(db.getDatabase(), null, 'Database reference must be null after failure');

      // Attempt 2: Succeeds cleanly on retry
      const recoveredDb = await db.initialize();
      assert.ok(recoveredDb, 'Second initialization attempt must succeed after prior failure');
      assert.ok(db.getClient(), 'Client must be set after successful retry');
      assert.strictEqual(db.getDatabase(), recoveredDb, 'Database reference must match');

      await db.close();
    } finally {
      db._setMongoClientClassForTesting(null);
      process.env.MONGODB_URI = origUri;
    }
  });

  console.log('\n================================================================');
  console.log(` ALL ${passedTests}/${totalTests} STAGE 2 VERIFICATION TESTS PASSED`);
  console.log('================================================================\n');
})();
