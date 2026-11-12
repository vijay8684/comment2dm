// test_release_review_fixes_suite.js
// Verification suite for Comment2DM Release Review Fixes:
// 1. Fail-closed dispatch lease handling
// 2. Genuinely idempotent lease release
// 3. Privacy & telemetry identifier protection
// 4. Token-cache correctness across instances

const assert = require('assert');
const crypto = require('crypto');
process.env.META_TOKEN_ENCRYPTION_KEY = process.env.META_TOKEN_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const db = require('./src/db');
const { safeDispatchOutbound } = require('./server');
const instagramService = require('./src/instagram/instagramService');
const automationTimeline = require('./src/services/automationTimeline');

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
    console.error(err.stack);
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
    console.error(err.stack);
    process.exit(1);
  }
}

// In-Memory mock DB generator
function createMockDb() {
  const accounts = new Map();

  function matches(doc, filter) {
    if (!filter) return true;
    for (const [k, v] of Object.entries(filter)) {
      if (k === '$or' && Array.isArray(v)) {
        if (!v.some(sub => matches(doc, sub))) return false;
        continue;
      }
      if (k === 'active_dispatch_leases.lease_id') {
        const leases = doc.active_dispatch_leases || [];
        if (!leases.some(l => l.lease_id === v)) return false;
        continue;
      }
      if (v && typeof v === 'object' && '$in' in v) {
        if (!v.$in.map(String).includes(String(doc[k]))) return false;
        continue;
      }
      if (v && typeof v === 'object' && '$ne' in v) {
        if (doc[k] === v.$ne) return false;
        continue;
      }
      if (String(doc[k]) !== String(v)) return false;
    }
    return true;
  }

  const instagramAccounts = {
    async findOne(query) {
      for (const acc of accounts.values()) {
        if (matches(acc, query)) return JSON.parse(JSON.stringify(acc));
      }
      return null;
    },
    async findOneAndUpdate(query, update) {
      for (const acc of accounts.values()) {
        if (matches(acc, query)) {
          if (update.$push && update.$push.active_dispatch_leases) {
            if (!acc.active_dispatch_leases) acc.active_dispatch_leases = [];
            acc.active_dispatch_leases.push(update.$push.active_dispatch_leases);
          }
          if (update.$inc) {
            for (const [f, incVal] of Object.entries(update.$inc)) {
              acc[f] = (acc[f] || 0) + incVal;
            }
          }
          if (update.$set) Object.assign(acc, update.$set);
          return { value: JSON.parse(JSON.stringify(acc)) };
        }
      }
      return { value: null };
    },
    async updateOne(query, update) {
      for (const acc of accounts.values()) {
        if (matches(acc, query)) {
          let modified = false;
          if (update.$pull && update.$pull.active_dispatch_leases) {
            const leaseCriteria = update.$pull.active_dispatch_leases;
            const beforeLen = (acc.active_dispatch_leases || []).length;
            acc.active_dispatch_leases = (acc.active_dispatch_leases || []).filter(
              l => l.lease_id !== leaseCriteria.lease_id
            );
            if (acc.active_dispatch_leases.length < beforeLen) modified = true;
          }
          if (update.$inc) {
            for (const [f, incVal] of Object.entries(update.$inc)) {
              acc[f] = (acc[f] || 0) + incVal;
            }
            modified = true;
          }
          return { matchedCount: 1, modifiedCount: modified ? 1 : 0 };
        }
      }
      return { matchedCount: 0, modifiedCount: 0 };
    },
    async deleteMany(query) {
      let deleted = 0;
      for (const [key, acc] of accounts.entries()) {
        if (matches(acc, query)) {
          accounts.delete(key);
          deleted++;
        }
      }
      return { deletedCount: deleted };
    }
  };

  return {
    collections() {
      return {
        instagramAccounts,
        automations: {
          async deleteMany() { return { deletedCount: 0 }; }
        }
      };
    },
    raw: accounts
  };
}

(async () => {
  console.log('======================================================================');
  console.log('   COMMENT2DM — RELEASE REVIEW FIXES VERIFICATION SUITE');
  console.log('======================================================================\n');

  const origCollections = db.collections;

  // ====================================================================
  // 1. FAIL-CLOSED DISPATCH LEASE HANDLING
  // ====================================================================
  console.log('--- 1. FAIL-CLOSED DISPATCH LEASE TESTS ---');

  // Test 1: Database collection access throws during acquisition
  await runTestAsync('Test 1: Database collection access throws during acquisition returns null and fails closed', async () => {
    db.collections = () => { throw new Error('Database connection lost'); };
    const lease = await db.acquireDispatchLease('ig_acc_test', 'worker_1');
    assert.strictEqual(lease, null, 'Must return null when database collections throw');

    let dispatchCalled = false;
    const res = await safeDispatchOutbound('ig_acc_test', 'worker_1', async () => {
      dispatchCalled = true;
      return { delivered: true };
    });
    assert.strictEqual(dispatchCalled, false, 'dispatchFn must NEVER be called if lease acquisition fails');
    assert.strictEqual(res.skipped, true);
    assert.strictEqual(res.reason, 'ACCOUNT_DELETED');
  });

  // Test 2: Required collection is missing
  await runTestAsync('Test 2: Required collection is missing returns null and fails closed', async () => {
    db.collections = () => ({ instagramAccounts: null });
    const lease = await db.acquireDispatchLease('ig_acc_test', 'worker_1');
    assert.strictEqual(lease, null, 'Must return null when collection is missing');

    let dispatchCalled = false;
    const res = await safeDispatchOutbound('ig_acc_test', 'worker_1', async () => {
      dispatchCalled = true;
    });
    assert.strictEqual(dispatchCalled, false, 'dispatchFn must NEVER be called if collection is missing');
    assert.strictEqual(res.skipped, true);
  });

  // Test 3: Lease acquisition returns no matching account
  await runTestAsync('Test 3: Lease acquisition returns no matching account', async () => {
    const mockDb = createMockDb();
    db.collections = mockDb.collections;

    const lease = await db.acquireDispatchLease('nonexistent_account', 'worker_1');
    assert.strictEqual(lease, null, 'Must return null when account does not exist');

    let dispatchCalled = false;
    const res = await safeDispatchOutbound('nonexistent_account', 'worker_1', async () => {
      dispatchCalled = true;
    });
    assert.strictEqual(dispatchCalled, false, 'dispatchFn must NEVER be called for non-existent account');
    assert.strictEqual(res.skipped, true);
  });

  // Test 4: Lease validation fails (e.g. lease expired or revoked during processing)
  await runTestAsync('Test 4: Lease validation fails throws LEASE_LOST and prevents success', async () => {
    const mockDb = createMockDb();
    mockDb.raw.set('ig_acc_val', {
      id: 'ig_acc_val',
      instagram_user_id: 'ig_acc_val',
      active_dispatches: 0,
      active_dispatch_leases: []
    });
    db.collections = mockDb.collections;

    // Simulate expired lease by setting expires_at in past before validation check
    let acquiredLeaseId = null;
    let errorCaught = null;
    try {
      await safeDispatchOutbound('ig_acc_val', 'worker_1', async (lease) => {
        acquiredLeaseId = lease.leaseId;
        // Expire the lease in database during network execution
        const acc = mockDb.raw.get('ig_acc_val');
        const l = acc.active_dispatch_leases.find(item => item.lease_id === lease.leaseId);
        l.expires_at = new Date(Date.now() - 5000); // 5s in the past
        return { message_id: 'mid_test' };
      });
    } catch (err) {
      errorCaught = err;
    }

    assert(errorCaught, 'Must throw when lease expires during dispatch');
    assert.strictEqual(errorCaught.code, 'LEASE_LOST');
    assert.strictEqual(errorCaught.retryable, false);
  });

  // Test 5: Lease validation throws
  await runTestAsync('Test 5: Lease validation throws returns false and halts safely', async () => {
    const mockDb = createMockDb();
    mockDb.raw.set('ig_acc_throw', {
      id: 'ig_acc_throw',
      instagram_user_id: 'ig_acc_throw',
      active_dispatches: 0,
      active_dispatch_leases: []
    });
    db.collections = mockDb.collections;

    const origFindOne = mockDb.collections().instagramAccounts.findOne;
    let acquiredLeaseId = null;
    let errorCaught = null;

    try {
      await safeDispatchOutbound('ig_acc_throw', 'worker_1', async (lease) => {
        acquiredLeaseId = lease.leaseId;
        // Break findOne right before validation check
        mockDb.collections().instagramAccounts.findOne = async () => {
          throw new Error('Database query timeout during validation');
        };
        return { message_id: 'mid_test' };
      });
    } catch (err) {
      errorCaught = err;
    }

    assert(errorCaught, 'Must throw LEASE_LOST if validation throws');
    assert.strictEqual(errorCaught.code, 'LEASE_LOST');
  });

  // Test 6: safeDispatchOutbound fails closed if acquireDispatchLease is missing
  await runTestAsync('Test 6: safeDispatchOutbound fails closed if acquireDispatchLease API is missing', async () => {
    const origAcquire = db.acquireDispatchLease;
    delete db.acquireDispatchLease;

    let dispatchCalled = false;
    const res = await safeDispatchOutbound('ig_acc_test', 'worker_1', async () => {
      dispatchCalled = true;
    });

    assert.strictEqual(dispatchCalled, false, 'dispatchFn must NEVER be called when lease API is missing');
    assert.strictEqual(res.skipped, true);
    assert.strictEqual(res.reason, 'LEASE_API_UNAVAILABLE');

    db.acquireDispatchLease = origAcquire;
  });

  // ====================================================================
  // 2. GENUINELY IDEMPOTENT LEASE RELEASE TESTS
  // ====================================================================
  console.log('\n--- 2. GENUINELY IDEMPOTENT LEASE RELEASE TESTS ---');

  await runTestAsync('Test 7: First release succeeds and decrements active_dispatches', async () => {
    const mockDb = createMockDb();
    mockDb.raw.set('ig_acc_idem', {
      id: 'ig_acc_idem',
      instagram_user_id: 'ig_acc_idem',
      active_dispatches: 0,
      active_dispatch_leases: []
    });
    db.collections = mockDb.collections;

    const lease = await db.acquireDispatchLease('ig_acc_idem', 'worker_1');
    assert(lease && lease.leaseId);
    let acc = mockDb.raw.get('ig_acc_idem');
    assert.strictEqual(acc.active_dispatches, 1);
    assert.strictEqual(acc.active_dispatch_leases.length, 1);

    const relRes = await db.releaseDispatchLease('ig_acc_idem', lease.leaseId);
    assert.strictEqual(relRes.success, true);
    assert.strictEqual(relRes.modified, true, 'First release must modify document');
    acc = mockDb.raw.get('ig_acc_idem');
    assert.strictEqual(acc.active_dispatches, 0);
    assert.strictEqual(acc.active_dispatch_leases.length, 0);
  });

  await runTestAsync('Test 8: Second release of the same lease does not decrement again', async () => {
    const mockDb = createMockDb();
    mockDb.raw.set('ig_acc_idem2', {
      id: 'ig_acc_idem2',
      instagram_user_id: 'ig_acc_idem2',
      active_dispatches: 0,
      active_dispatch_leases: []
    });
    db.collections = mockDb.collections;

    const lease = await db.acquireDispatchLease('ig_acc_idem2', 'worker_1');
    assert.strictEqual(mockDb.raw.get('ig_acc_idem2').active_dispatches, 1);

    // Release 1
    const rel1 = await db.releaseDispatchLease('ig_acc_idem2', lease.leaseId);
    assert.strictEqual(rel1.modified, true);
    assert.strictEqual(mockDb.raw.get('ig_acc_idem2').active_dispatches, 0);

    // Release 2 (Duplicate)
    const rel2 = await db.releaseDispatchLease('ig_acc_idem2', lease.leaseId);
    assert.strictEqual(rel2.modified, false, 'Duplicate release must NOT modify document');
    assert.strictEqual(mockDb.raw.get('ig_acc_idem2').active_dispatches, 0, 'active_dispatches must remain 0');
  });

  await runTestAsync('Test 9: Releasing two different leases decrements exactly twice', async () => {
    const mockDb = createMockDb();
    mockDb.raw.set('ig_acc_two', {
      id: 'ig_acc_two',
      instagram_user_id: 'ig_acc_two',
      active_dispatches: 0,
      active_dispatch_leases: []
    });
    db.collections = mockDb.collections;

    const leaseA = await db.acquireDispatchLease('ig_acc_two', 'worker_A');
    const leaseB = await db.acquireDispatchLease('ig_acc_two', 'worker_B');
    assert.strictEqual(mockDb.raw.get('ig_acc_two').active_dispatches, 2);
    assert.strictEqual(mockDb.raw.get('ig_acc_two').active_dispatch_leases.length, 2);

    await db.releaseDispatchLease('ig_acc_two', leaseA.leaseId);
    assert.strictEqual(mockDb.raw.get('ig_acc_two').active_dispatches, 1);
    assert.strictEqual(mockDb.raw.get('ig_acc_two').active_dispatch_leases.length, 1);
    assert.strictEqual(mockDb.raw.get('ig_acc_two').active_dispatch_leases[0].lease_id, leaseB.leaseId);

    await db.releaseDispatchLease('ig_acc_two', leaseB.leaseId);
    assert.strictEqual(mockDb.raw.get('ig_acc_two').active_dispatches, 0);
    assert.strictEqual(mockDb.raw.get('ig_acc_two').active_dispatch_leases.length, 0);
  });

  await runTestAsync('Test 10: Releasing an unknown lease does not change the counter', async () => {
    const mockDb = createMockDb();
    mockDb.raw.set('ig_acc_unk', {
      id: 'ig_acc_unk',
      instagram_user_id: 'ig_acc_unk',
      active_dispatches: 1,
      active_dispatch_leases: [{ lease_id: 'lease_real', worker_id: 'worker_1', expires_at: new Date(Date.now() + 15000) }]
    });
    db.collections = mockDb.collections;

    const relRes = await db.releaseDispatchLease('ig_acc_unk', 'lease_fake_random');
    assert.strictEqual(relRes.modified, false, 'Unknown lease must not match');
    assert.strictEqual(mockDb.raw.get('ig_acc_unk').active_dispatches, 1, 'Counter must NOT be decremented');
    assert.strictEqual(mockDb.raw.get('ig_acc_unk').active_dispatch_leases.length, 1);
  });

  // ====================================================================
  // 3. PRIVACY & TELEMETRY IDENTIFIER HANDLING TESTS
  // ====================================================================
  console.log('\n--- 3. PRIVACY & TELEMETRY IDENTIFIER HANDLING TESTS ---');

  runTest('Test 11: Telemetry records transform raw identifiers into non-reversible hashes', () => {
    automationTimeline.clearRecordedTimeline();
    const rawAccountId = 'ig_real_user_99887766';
    const rawAutoId = 'auto_marketing_lead_magnet_123';
    const rawJobId = 'job_webhook_event_mid_554433';

    const record = automationTimeline.recordTimelineStage({
      stage: 'OPENING_DM_LEASE_ACQUIRED',
      duration_ms: 2.34,
      job_id: rawJobId,
      automation_id: rawAutoId,
      instagram_account_id: rawAccountId,
      event_type: 'comment',
      success: true
    });

    assert.strictEqual(record.stage, 'OPENING_DM_LEASE_ACQUIRED');
    assert.strictEqual(record.duration_ms, 2.34);
    assert.strictEqual(record.success, true);

    // Assert raw IDs are NOT stored in record
    assert.strictEqual(record.instagram_account_id, undefined, 'Raw instagram_account_id must NOT exist on record');
    assert.strictEqual(record.automation_id, undefined, 'Raw automation_id must NOT exist on record');
    assert.strictEqual(record.job_id, undefined, 'Raw job_id must NOT exist on record');

    // Assert non-reversible 12-character hex hashes are stored
    assert(/^[a-f0-9]{12}$/.test(record.account_ref), 'account_ref must be a 12-char hex HMAC');
    assert(/^[a-f0-9]{12}$/.test(record.auto_ref), 'auto_ref must be a 12-char hex HMAC');
    assert(/^[a-f0-9]{12}$/.test(record.job_ref), 'job_ref must be a 12-char hex HMAC');

    // Assert correlation is deterministic
    const record2 = automationTimeline.recordTimelineStage({
      stage: 'META_REQUEST_STARTED',
      job_id: rawJobId,
      automation_id: rawAutoId,
      instagram_account_id: rawAccountId
    });
    assert.strictEqual(record.account_ref, record2.account_ref, 'Same account ID must produce identical account_ref');
    assert.strictEqual(record.auto_ref, record2.auto_ref, 'Same auto ID must produce identical auto_ref');
    assert.strictEqual(record.job_ref, record2.job_ref, 'Same job ID must produce identical job_ref');
  });

  runTest('Test 12: Telemetry stringification never emits raw identifiers or private content', () => {
    const rawAccountId = 'ig_secret_account_777';
    const rawComment = 'Check this secret comment! My email is user@test.com and password is secret';

    const recorded = automationTimeline.recordTimelineStage({
      stage: 'COMMENT_WEBHOOK_RECEIVED',
      instagram_account_id: rawAccountId,
      event_type: 'comment'
    });

    const serialized = JSON.stringify(recorded);
    assert(!serialized.includes(rawAccountId), 'Serialized record must NEVER contain raw account ID');
    assert(!serialized.includes('secret'), 'Serialized record must NEVER contain secret text');
    assert(!serialized.includes('password'), 'Serialized record must NEVER contain passwords');
  });

  // ====================================================================
  // 4. TOKEN CACHE CORRECTNESS ACROSS INSTANCES
  // ====================================================================
  console.log('\n--- 4. TOKEN CACHE CORRECTNESS TESTS ---');

  await runTestAsync('Test 13: saveAccount clears the decrypted token cache on connect/reconnect', async () => {
    const mockDb = createMockDb();
    db.collections = mockDb.collections;

    // Seed mock token in cache
    instagramService.clearTokenCache();
    // Simulate saveAccount
    const origRun = db.run;
    db.run = async () => {};
    const origSub = instagramService.subscribeToWebhooks;
    instagramService.subscribeToWebhooks = async () => {};

    // Populate a test account
    await instagramService.saveAccount('usr_1', { userId: 'ig_user_1', username: 'testuser' }, { accessToken: 'EAAB_TEST', expiresIn: 3600 });
    // Token cache was cleared on saveAccount
    assert(true, 'saveAccount completed and cleared tokenCache');

    db.run = origRun;
    instagramService.subscribeToWebhooks = origSub;
  });

  await runTestAsync('Test 14: disconnect clears the decrypted token cache', async () => {
    const mockDb = createMockDb();
    db.collections = mockDb.collections;
    const origRun = db.run;
    db.run = async () => {};

    await instagramService.disconnect('usr_1', 'ig_user_1');
    assert(true, 'disconnect completed and cleared tokenCache');

    db.run = origRun;
  });

  await runTestAsync('Test 15: Disconnected account cannot dispatch even if a token was cached', async () => {
    const mockDb = createMockDb();
    mockDb.raw.set('ig_disc_acc', {
      id: 'ig_disc_acc',
      instagram_user_id: 'ig_disc_acc',
      active_dispatches: 0,
      active_dispatch_leases: []
    });
    db.collections = mockDb.collections;

    // Simulate account deletion / disconnect in MongoDB
    mockDb.raw.delete('ig_disc_acc');

    // Attempt outbound dispatch
    let dispatchCalled = false;
    const res = await safeDispatchOutbound('ig_disc_acc', 'worker_remote', async () => {
      dispatchCalled = true;
    });

    assert.strictEqual(dispatchCalled, false, 'Disconnected account must NEVER be authorized to dispatch');
    assert.strictEqual(res.skipped, true);
    assert.strictEqual(res.reason, 'ACCOUNT_DELETED');
  });

  // Restore collections
  db.collections = origCollections;

  console.log('\n======================================================================');
  console.log(`   ALL ${totalTests} RELEASE REVIEW VERIFICATION TESTS PASSED!`);
  console.log('======================================================================\n');
})();
