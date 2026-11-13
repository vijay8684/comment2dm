// test_release_review_fixes_suite.js
// Verification suite for Comment2DM Release Review Fixes:
// 1. Fail-closed dispatch lease handling & pre-dispatch validation
// 2. Genuinely idempotent lease release & always-release guarantees
// 3. Renewal behaviour during disconnect & fallback protection
// 4. Privacy & telemetry identifier protection (real comment/message execution)
// 5. Token-cache correctness across instances (simulated multi-process protection)
// 6. Lease-aware Instagram disconnect fail-closed safety
// 7. Outbound operation lease protection (public comment reply)

const assert = require('assert');
const crypto = require('crypto');
process.env.META_TOKEN_ENCRYPTION_KEY = process.env.META_TOKEN_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.META_APP_ID = process.env.META_APP_ID || 'mock_meta_app_id';
process.env.META_APP_SECRET = process.env.META_APP_SECRET || 'mock_meta_app_secret';
process.env.META_REDIRECT_URI = process.env.META_REDIRECT_URI || 'https://test.example.com/callback';
const db = require('./src/db');
const { safeDispatchOutbound, app } = require('./server');
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
  const automations = new Map();
  const webhookJobs = new Map();
  const openingDmClaims = new Map();
  const conversationStates = new Map();
  const automationEvents = [];

  function matches(doc, filter) {
    if (!filter) return true;
    for (const [k, v] of Object.entries(filter)) {
      if (k === '$and' && Array.isArray(v)) {
        if (!v.every(sub => matches(doc, sub))) return false;
        continue;
      }
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
      if (v && typeof v === 'object' && '$nin' in v) {
        if (v.$nin.map(String).includes(String(doc[k]))) return false;
        continue;
      }
      if (v && typeof v === 'object' && '$ne' in v) {
        if (doc[k] === v.$ne) return false;
        continue;
      }
      if (v && typeof v === 'object' && ('$lt' in v || '$lte' in v || '$gt' in v || '$gte' in v)) {
        const docDate = new Date(doc[k]).getTime();
        if ('$lt' in v && !(docDate < new Date(v.$lt).getTime())) return false;
        if ('$lte' in v && !(docDate <= new Date(v.$lte).getTime())) return false;
        if ('$gt' in v && !(docDate > new Date(v.$gt).getTime())) return false;
        if ('$gte' in v && !(docDate >= new Date(v.$gte).getTime())) return false;
        continue;
      }
      if (String(doc[k]) !== String(v)) return false;
    }
    return true;
  }

  function applyUpdate(acc, update, query = null) {
    let modified = false;
    if (update.$push && update.$push.active_dispatch_leases) {
      if (!acc.active_dispatch_leases) acc.active_dispatch_leases = [];
      acc.active_dispatch_leases.push(update.$push.active_dispatch_leases);
      modified = true;
    }
    if (update.$pull && update.$pull.active_dispatch_leases) {
      const leaseCriteria = update.$pull.active_dispatch_leases;
      const beforeLen = (acc.active_dispatch_leases || []).length;
      acc.active_dispatch_leases = (acc.active_dispatch_leases || []).filter(l => {
        if (leaseCriteria.lease_id) return l.lease_id !== leaseCriteria.lease_id;
        if (leaseCriteria.expires_at && leaseCriteria.expires_at.$lte) {
          return new Date(l.expires_at) > new Date(leaseCriteria.expires_at.$lte);
        }
        return true;
      });
      if (acc.active_dispatch_leases.length < beforeLen) modified = true;
    }
    if (update.$inc) {
      for (const [f, incVal] of Object.entries(update.$inc)) {
        acc[f] = (acc[f] || 0) + incVal;
      }
      modified = true;
    }
    if (update.$set) {
      for (const [key, val] of Object.entries(update.$set)) {
        if (key === 'active_dispatch_leases.$.expires_at') {
          const targetLeaseId = query?.['active_dispatch_leases.lease_id'];
          if (Array.isArray(acc.active_dispatch_leases)) {
            for (const l of acc.active_dispatch_leases) {
              if (!targetLeaseId || l.lease_id === targetLeaseId) {
                l.expires_at = val;
              }
            }
          }
        } else {
          acc[key] = val;
        }
      }
      modified = true;
    }
    return modified;
  }

  let findQueryCount = 0;

  const instagramAccounts = {
    async findOne(query) {
      findQueryCount++;
      for (const acc of accounts.values()) {
        if (matches(acc, query)) return JSON.parse(JSON.stringify(acc));
      }
      return null;
    },
    async findOneAndUpdate(query, update) {
      for (const acc of accounts.values()) {
        if (matches(acc, query)) {
          applyUpdate(acc, update, query);
          return { value: JSON.parse(JSON.stringify(acc)) };
        }
      }
      return { value: null };
    },
    async updateOne(query, update) {
      for (const acc of accounts.values()) {
        if (matches(acc, query)) {
          const mod = applyUpdate(acc, update, query);
          return { matchedCount: 1, modifiedCount: mod ? 1 : 0 };
        }
      }
      return { matchedCount: 0, modifiedCount: 0 };
    },
    async updateMany(query, update) {
      let modCount = 0;
      let matchCount = 0;
      for (const acc of accounts.values()) {
        if (matches(acc, query)) {
          matchCount++;
          if (applyUpdate(acc, update, query)) modCount++;
        }
      }
      return { matchedCount: matchCount, modifiedCount: modCount };
    },
    find(query) {
      const results = [];
      for (const acc of accounts.values()) {
        if (matches(acc, query)) results.push(JSON.parse(JSON.stringify(acc)));
      }
      return {
        toArray: async () => results,
        sort: () => ({ toArray: async () => results })
      };
    },
    async countDocuments(query) {
      let count = 0;
      for (const acc of accounts.values()) {
        if (matches(acc, query)) count++;
      }
      return count;
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

  const automationsCol = {
    async findOne(query) {
      for (const a of automations.values()) {
        if (matches(a, query)) return JSON.parse(JSON.stringify(a));
      }
      return null;
    },
    find(query) {
      const results = [];
      for (const a of automations.values()) {
        if (matches(a, query)) results.push(JSON.parse(JSON.stringify(a)));
      }
      return {
        toArray: async () => results,
        sort: () => ({ toArray: async () => results })
      };
    },
    async deleteMany(query) {
      let deleted = 0;
      for (const [key, a] of automations.entries()) {
        if (matches(a, query)) {
          automations.delete(key);
          deleted++;
        }
      }
      return { deletedCount: deleted };
    }
  };

  const webhookJobsCol = {
    async deleteMany(query) {
      let deleted = 0;
      for (const [k, j] of webhookJobs.entries()) {
        if (matches(j, query)) {
          webhookJobs.delete(k);
          deleted++;
        }
      }
      return { deletedCount: deleted };
    }
  };

  const openingDmClaimsCol = {
    async findOne(query) {
      for (const c of openingDmClaims.values()) {
        if (matches(c, query)) return JSON.parse(JSON.stringify(c));
      }
      return null;
    },
    async findOneAndUpdate(query, update) {
      for (const c of openingDmClaims.values()) {
        if (matches(c, query)) {
          applyUpdate(c, update);
          return { value: JSON.parse(JSON.stringify(c)) };
        }
      }
      return { value: null };
    },
    async updateOne(query, update, opts = {}) {
      for (const c of openingDmClaims.values()) {
        if (matches(c, query)) {
          applyUpdate(c, update);
          return { matchedCount: 1, modifiedCount: 1 };
        }
      }
      if (opts.upsert) {
        const doc = { ...(update.$setOnInsert || {}), ...(update.$set || {}) };
        openingDmClaims.set(doc.claim_key || crypto.randomUUID(), doc);
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
      }
      return { matchedCount: 0, modifiedCount: 0 };
    },
    async deleteMany(query) {
      let deleted = 0;
      for (const [k, c] of openingDmClaims.entries()) {
        if (matches(c, query)) {
          openingDmClaims.delete(k);
          deleted++;
        }
      }
      return { deletedCount: deleted };
    }
  };

  const conversationStatesCol = {
    async findOne(query) {
      for (const s of conversationStates.values()) {
        if (matches(s, query)) return JSON.parse(JSON.stringify(s));
      }
      return null;
    },
    async findOneAndUpdate(query, update, opts = {}) {
      for (const s of conversationStates.values()) {
        if (matches(s, query)) {
          applyUpdate(s, update, query);
          return { value: JSON.parse(JSON.stringify(s)) };
        }
      }
      if (opts.upsert) {
        const newDoc = { ...(update.$setOnInsert || {}), ...(update.$set || {}) };
        conversationStates.set(newDoc.key || crypto.randomUUID(), newDoc);
        return { value: JSON.parse(JSON.stringify(newDoc)) };
      }
      return { value: null };
    },
    async updateOne(query, update, opts = {}) {
      for (const s of conversationStates.values()) {
        if (matches(s, query)) {
          applyUpdate(s, update);
          return { matchedCount: 1, modifiedCount: 1 };
        }
      }
      if (opts.upsert) {
        const newDoc = { ...(update.$set || {}) };
        conversationStates.set(newDoc.key || crypto.randomUUID(), newDoc);
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
      }
      return { matchedCount: 0, modifiedCount: 0 };
    }
  };

  const automationEventsCol = {
    async findOne(query) {
      for (const e of automationEvents) {
        if (matches(e, query)) return JSON.parse(JSON.stringify(e));
      }
      return null;
    },
    async insertOne(doc) {
      automationEvents.push(doc);
      return { acknowledged: true, insertedId: doc.event_id || crypto.randomUUID() };
    }
  };

  return {
    collections() {
      return {
        instagramAccounts,
        automations: automationsCol,
        webhookJobs: webhookJobsCol,
        openingDmClaims: openingDmClaimsCol,
        conversationStates: conversationStatesCol,
        automationEvents: automationEventsCol
      };
    },
    raw: accounts,
    automationsRaw: automations,
    eventsRaw: automationEvents,
    getQueryCount: () => findQueryCount,
    resetQueryCount: () => { findQueryCount = 0; }
  };
}

// Helper to encrypt tokens for mock DB
function encryptTestToken(plain) {
  const key = Buffer.from(process.env.META_TOKEN_ENCRYPTION_KEY, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]).toString('base64');
  const tag = cipher.getAuthTag().toString('base64');
  return { ciphertext, iv: iv.toString('base64'), tag };
}

(async () => {
  console.log('======================================================================');
  console.log('   COMMENT2DM — RELEASE REVIEW FIXES VERIFICATION SUITE');
  console.log('======================================================================\n');

  const origCollections = db.collections;

  // ====================================================================
  // 1. FAIL-CLOSED DISPATCH LEASE & PRE-DISPATCH VALIDATION
  // ====================================================================
  console.log('--- 1. FAIL-CLOSED DISPATCH LEASE & PRE-DISPATCH VALIDATION ---');

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

  // Test 4: Pre-dispatch lease validation loss halts BEFORE dispatchFn is called
  await runTestAsync('Test 4: Pre-dispatch lease validation loss throws LEASE_LOST and prevents dispatchFn execution', async () => {
    const mockDb = createMockDb();
    mockDb.raw.set('ig_acc_val', {
      id: 'ig_acc_val',
      instagram_user_id: 'ig_acc_val',
      active_dispatches: 0,
      active_dispatch_leases: []
    });
    db.collections = mockDb.collections;

    // Spy on acquireDispatchLease to simulate lease becoming invalid right before validation check
    const origAcquire = db.acquireDispatchLease;
    db.acquireDispatchLease = async (accId, workerId) => {
      const lease = await origAcquire(accId, workerId);
      // Revoke lease from DB immediately after acquire but before pre-dispatch check
      const acc = mockDb.raw.get(accId);
      acc.active_dispatch_leases = [];
      return lease;
    };

    let dispatchCalled = false;
    let errorCaught = null;
    try {
      await safeDispatchOutbound('ig_acc_val', 'worker_1', async () => {
        dispatchCalled = true;
        return { message_id: 'mid_test' };
      });
    } catch (err) {
      errorCaught = err;
    } finally {
      db.acquireDispatchLease = origAcquire;
    }

    assert(errorCaught, 'Must throw when lease is invalid before dispatch');
    assert.strictEqual(errorCaught.code, 'LEASE_LOST');
    assert.strictEqual(errorCaught.retryable, false);
    assert.strictEqual(dispatchCalled, false, 'dispatchFn must NEVER be called when lease is lost before request');
  });

  // Test 5: Pre-dispatch lease validation DB error halts safely BEFORE dispatchFn
  await runTestAsync('Test 5: Pre-dispatch lease validation throws returns false and halts safely before dispatchFn', async () => {
    const mockDb = createMockDb();
    mockDb.raw.set('ig_acc_throw', {
      id: 'ig_acc_throw',
      instagram_user_id: 'ig_acc_throw',
      active_dispatches: 0,
      active_dispatch_leases: []
    });
    db.collections = mockDb.collections;

    const origAcquire = db.acquireDispatchLease;
    db.acquireDispatchLease = async (accId, workerId) => {
      const lease = await origAcquire(accId, workerId);
      // Break findOne right after lease is acquired
      mockDb.collections().instagramAccounts.findOne = async () => {
        throw new Error('Database query timeout during pre-dispatch validation');
      };
      return lease;
    };

    let dispatchCalled = false;
    let errorCaught = null;
    try {
      await safeDispatchOutbound('ig_acc_throw', 'worker_1', async () => {
        dispatchCalled = true;
        return { message_id: 'mid_test' };
      });
    } catch (err) {
      errorCaught = err;
    } finally {
      db.acquireDispatchLease = origAcquire;
    }

    assert(errorCaught, 'Must throw LEASE_LOST if validation check throws');
    assert.strictEqual(errorCaught.code, 'LEASE_LOST');
    assert.strictEqual(dispatchCalled, false, 'dispatchFn must NEVER be called when pre-dispatch check fails');
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

  // Test 7: safeDispatchOutbound fails closed if isDispatchLeaseValid is missing
  await runTestAsync('Test 7: safeDispatchOutbound fails closed if isDispatchLeaseValid API is missing', async () => {
    const origValid = db.isDispatchLeaseValid;
    delete db.isDispatchLeaseValid;

    let dispatchCalled = false;
    const res = await safeDispatchOutbound('ig_acc_test', 'worker_1', async () => {
      dispatchCalled = true;
    });

    assert.strictEqual(dispatchCalled, false, 'dispatchFn must NEVER be called when validation API is missing');
    assert.strictEqual(res.skipped, true);
    assert.strictEqual(res.reason, 'LEASE_VALIDATION_API_UNAVAILABLE');

    db.isDispatchLeaseValid = origValid;
  });

  // Test 8: safeDispatchOutbound fails closed if releaseDispatchLease API is missing (no Meta request sent)
  await runTestAsync('Test 8: safeDispatchOutbound fails closed if releaseDispatchLease API is missing', async () => {
    const origRelease = db.releaseDispatchLease;
    delete db.releaseDispatchLease;

    let dispatchCalled = false;
    const res = await safeDispatchOutbound('ig_acc_test', 'worker_1', async () => {
      dispatchCalled = true;
    });

    assert.strictEqual(dispatchCalled, false, 'dispatchFn must NEVER be called when release API is missing');
    assert.strictEqual(res.skipped, true);
    assert.strictEqual(res.reason, 'LEASE_RELEASE_API_UNAVAILABLE');

    db.releaseDispatchLease = origRelease;
  });

  // Test 9: Pre-dispatch validation returns false, and the acquired lease is released
  await runTestAsync('Test 9: Pre-dispatch validation returns false, and the acquired lease is released', async () => {
    const mockDb = createMockDb();
    const accId = 'ig_val_false';
    mockDb.raw.set(accId, {
      id: accId,
      instagram_user_id: accId,
      active_dispatches: 0,
      active_dispatch_leases: []
    });
    db.collections = mockDb.collections;

    let releasedLeaseId = null;
    const origRelease = db.releaseDispatchLease;
    db.releaseDispatchLease = async (id, leaseId) => {
      releasedLeaseId = leaseId;
      return origRelease(id, leaseId);
    };

    const origValid = db.isDispatchLeaseValid;
    db.isDispatchLeaseValid = async () => false;

    let dispatchCalled = false;
    let errorCaught = null;
    try {
      await safeDispatchOutbound(accId, 'worker_1', async () => {
        dispatchCalled = true;
      });
    } catch (err) {
      errorCaught = err;
    } finally {
      db.releaseDispatchLease = origRelease;
      db.isDispatchLeaseValid = origValid;
    }

    assert(errorCaught, 'Must throw LEASE_LOST when pre-dispatch validation returns false');
    assert.strictEqual(errorCaught.code, 'LEASE_LOST');
    assert.strictEqual(dispatchCalled, false, 'dispatchFn must NOT be called');
    assert(releasedLeaseId, 'Lease MUST be released in finally even when pre-dispatch validation returns false');
  });

  // Test 10: Pre-dispatch validation throws, and the acquired lease is released
  await runTestAsync('Test 10: Pre-dispatch validation throws, and the acquired lease is released', async () => {
    const mockDb = createMockDb();
    const accId = 'ig_val_throws';
    mockDb.raw.set(accId, {
      id: accId,
      instagram_user_id: accId,
      active_dispatches: 0,
      active_dispatch_leases: []
    });
    db.collections = mockDb.collections;

    let releasedLeaseId = null;
    const origRelease = db.releaseDispatchLease;
    db.releaseDispatchLease = async (id, leaseId) => {
      releasedLeaseId = leaseId;
      return origRelease(id, leaseId);
    };

    const origValid = db.isDispatchLeaseValid;
    db.isDispatchLeaseValid = async () => { throw new Error('Simulated DB validation query failure'); };

    let dispatchCalled = false;
    let errorCaught = null;
    try {
      await safeDispatchOutbound(accId, 'worker_1', async () => {
        dispatchCalled = true;
      });
    } catch (err) {
      errorCaught = err;
    } finally {
      db.releaseDispatchLease = origRelease;
      db.isDispatchLeaseValid = origValid;
    }

    assert(errorCaught, 'Must throw LEASE_LOST when pre-dispatch validation throws');
    assert.strictEqual(errorCaught.code, 'LEASE_LOST');
    assert.strictEqual(dispatchCalled, false, 'dispatchFn must NOT be called');
    assert(releasedLeaseId, 'Lease MUST be released in finally when pre-dispatch validation throws');
  });

  // Test 11: Release failure in finally is caught and original dispatch error is preserved without leaking identifiers
  await runTestAsync('Test 11: Release failure is logged safely without exposing identifiers and preserves dispatch error', async () => {
    const mockDb = createMockDb();
    const accId = 'ig_rel_err_sensitive_id';
    mockDb.raw.set(accId, {
      id: accId,
      instagram_user_id: accId,
      active_dispatches: 0,
      active_dispatch_leases: []
    });
    db.collections = mockDb.collections;

    const origRelease = db.releaseDispatchLease;
    db.releaseDispatchLease = async () => {
      throw new Error('Database connection reset during lease release cleanup');
    };

    const capturedErrors = [];
    const origConsoleError = console.error;
    console.error = (...args) => {
      capturedErrors.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
      origConsoleError(...args);
    };

    let errorCaught = null;
    try {
      await safeDispatchOutbound(accId, 'worker_1', async () => {
        const dispatchErr = new Error('Meta API 400 Bad Request');
        dispatchErr.statusCode = 400;
        throw dispatchErr;
      });
    } catch (err) {
      errorCaught = err;
    } finally {
      console.error = origConsoleError;
      db.releaseDispatchLease = origRelease;
    }

    assert(errorCaught, 'Original dispatch error must be thrown');
    assert.strictEqual(errorCaught.message, 'Meta API 400 Bad Request', 'Must preserve original dispatch error, not mask with release error');

    const errLogs = capturedErrors.join('\n');
    assert(errLogs.includes('Failed to release dispatch lease safely'), 'Must log release failure');
    assert(!errLogs.includes(accId), 'Release failure log must NOT expose raw account ID');
  });

  // ====================================================================
  // 2. GENUINELY IDEMPOTENT LEASE RELEASE TESTS
  // ====================================================================
  console.log('\n--- 2. GENUINELY IDEMPOTENT LEASE RELEASE TESTS ---');

  await runTestAsync('Test 12: First release succeeds and decrements active_dispatches', async () => {
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

  await runTestAsync('Test 13: Second release of the same lease does not decrement again', async () => {
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

  await runTestAsync('Test 14: Releasing two different leases decrements exactly twice', async () => {
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

  await runTestAsync('Test 15: Releasing an unknown lease does not change the counter', async () => {
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
  // 3. RENEWAL BEHAVIOUR DURING DISCONNECT & FALLBACK PROTECTION
  // ====================================================================
  console.log('\n--- 3. RENEWAL BEHAVIOUR DURING DISCONNECT & FALLBACK PROTECTION ---');

  // Test 16: Existing lease renews while deletion_pending is true
  await runTestAsync('Test 16: Existing lease renews while deletion_pending is true', async () => {
    const mockDb = createMockDb();
    const accId = 'ig_renew_pending';
    const leaseId = 'lease_existing_to_renew';
    const now = Date.now();
    mockDb.raw.set(accId, {
      id: accId,
      instagram_user_id: accId,
      deletion_pending: true,
      deletion_state: 'deleting',
      active_dispatches: 1,
      active_dispatch_leases: [{ lease_id: leaseId, worker_id: 'w1', expires_at: new Date(now + 4000) }]
    });
    db.collections = mockDb.collections;

    const renewed = await db.renewDispatchLease(accId, leaseId, 15000);
    assert.strictEqual(renewed, true, 'Existing lease MUST be allowed to renew while deletion_pending is true');

    const acc = mockDb.raw.get(accId);
    const renewedLease = acc.active_dispatch_leases.find(l => l.lease_id === leaseId);
    assert(new Date(renewedLease.expires_at).getTime() > now + 10000, 'Lease expiration must be extended');
  });

  // Test 17: New lease acquisition remains blocked while deletion_pending is true
  await runTestAsync('Test 17: New lease acquisition remains blocked while deletion_pending is true', async () => {
    const mockDb = createMockDb();
    const accId = 'ig_block_new';
    mockDb.raw.set(accId, {
      id: accId,
      instagram_user_id: accId,
      deletion_pending: true,
      deletion_state: 'deleting',
      active_dispatches: 0,
      active_dispatch_leases: []
    });
    db.collections = mockDb.collections;

    const lease = await db.acquireDispatchLease(accId, 'worker_new');
    assert.strictEqual(lease, null, 'New lease acquisition MUST be blocked when deletion_pending is true');
  });

  // Test 18: Renewal requires exact lease ID and cannot create lease or authorize new dispatch
  await runTestAsync('Test 18: Renewal requires exact lease ID and cannot create lease or authorize new dispatch', async () => {
    const mockDb = createMockDb();
    const accId = 'ig_renew_exact';
    mockDb.raw.set(accId, {
      id: accId,
      instagram_user_id: accId,
      active_dispatches: 0,
      active_dispatch_leases: []
    });
    db.collections = mockDb.collections;

    const renewed = await db.renewDispatchLease(accId, 'nonexistent_lease_id', 15000);
    assert.strictEqual(renewed, false, 'Renewal must fail for non-existent lease ID');
    const acc = mockDb.raw.get(accId);
    assert.strictEqual(acc.active_dispatch_leases.length, 0, 'Renewal must never create a lease record');
    assert.strictEqual(acc.active_dispatches, 0, 'Renewal must never increment active_dispatches');
  });

  // Test 19: A failed renewal prevents a subsequent fallback request
  await runTestAsync('Test 19: A failed renewal prevents a subsequent fallback request', async () => {
    const mockDb = createMockDb();
    const accId = 'ig_fail_fallback';
    mockDb.raw.set(accId, {
      id: accId,
      instagram_user_id: accId,
      active_dispatches: 0,
      active_dispatch_leases: []
    });
    db.collections = mockDb.collections;

    let primaryCalled = false;
    let fallbackCalled = false;
    let errorCaught = null;

    try {
      await safeDispatchOutbound(accId, 'worker_test', async (dispatchLease) => {
        primaryCalled = true;
        try {
          throw new Error('Primary Meta request failed: 500 Internal Error');
        } catch (_) {
          // Simulate lease revoked/expired in DB before fallback
          const acc = mockDb.raw.get(accId);
          acc.active_dispatch_leases = []; // Revoke lease

          // Before fallback request, check assertValid()
          await dispatchLease.assertValid();
          fallbackCalled = true;
          return { sent: true };
        }
      });
    } catch (err) {
      errorCaught = err;
    }

    assert.strictEqual(primaryCalled, true, 'Primary request should have been attempted');
    assert.strictEqual(fallbackCalled, false, 'Fallback request must NOT be attempted after lease validation/renewal failure');
    assert(errorCaught, 'Must throw error when lease is invalid before fallback');
    assert.strictEqual(errorCaught.code, 'LEASE_LOST');
  });

  // Test 20: Disconnect cannot delete credentials while a valid renewed lease exists
  await runTestAsync('Test 20: Disconnect cannot delete credentials while a valid renewed lease exists', async () => {
    const mockDb = createMockDb();
    const accId = 'ig_renew_blocks_delete';
    const ownerId = 'usr_owner_renew';
    const leaseId = 'lease_renewed_keepalive';
    const enc = encryptTestToken('KEEPALIVE_TOKEN');

    mockDb.raw.set(accId, {
      id: accId,
      instagram_user_id: accId,
      owner_user_id: ownerId,
      username: 'keepalive_user',
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      tag: enc.tag,
      active_dispatches: 1,
      active_dispatch_leases: [{ lease_id: leaseId, worker_id: 'w1', expires_at: new Date(Date.now() + 200) }]
    });
    mockDb.automationsRaw.set('auto_keepalive', {
      id: 'auto_keepalive',
      owner_user_id: ownerId,
      instagram_user_id: accId
    });
    db.collections = mockDb.collections;

    // Worker periodically renews the lease during drain
    const renewInterval = setInterval(async () => {
      await db.renewDispatchLease(accId, leaseId, 500);
    }, 50);

    let errorCaught = null;
    try {
      await instagramService.disconnect(ownerId, accId, { drainTimeoutMs: 200, pollIntervalMs: 25 });
    } catch (err) {
      errorCaught = err;
    } finally {
      clearInterval(renewInterval);
    }

    assert(errorCaught, 'Disconnect must time out and throw 503 while lease is being renewed');
    assert.strictEqual(errorCaught.code, 'DISCONNECT_DRAIN_TIMEOUT');
    assert.strictEqual(errorCaught.statusCode, 503);
    assert.strictEqual(mockDb.raw.has(accId), true, 'Account credentials MUST NOT be deleted while renewed lease exists');
    assert.strictEqual(mockDb.automationsRaw.has('auto_keepalive'), true, 'Automations MUST NOT be deleted while renewed lease exists');
  });

  // ====================================================================
  // 4. PRIVACY & TELEMETRY IDENTIFIER HANDLING TESTS
  // ====================================================================
  console.log('\n--- 4. PRIVACY & TELEMETRY IDENTIFIER HANDLING TESTS ---');

  runTest('Test 21: Telemetry records transform raw identifiers into non-reversible hashes', () => {
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

  runTest('Test 22: Telemetry stringification never emits raw identifiers or private content', () => {
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

  // Test 23: Complete Privacy Audit: exercise actual comment webhook and message webhook
  await runTestAsync('Test 23: Console logs during comment and messaging webhook execution never leak raw sender IDs, comments, or texts', async () => {
    const rawAccountId = `ig_priv_acc_${crypto.randomBytes(6).toString('hex')}`;
    const rawSenderIgsid = `igsid_priv_${crypto.randomBytes(6).toString('hex')}`;
    const rawCommentId = `cmt_priv_${crypto.randomBytes(6).toString('hex')}`;
    const rawCommentText = `SECRET_KEYWORD_DISCOUNT_${crypto.randomBytes(6).toString('hex')}`;
    const rawPrivateMsg = `SECRET_USER_PHONE_555_${crypto.randomBytes(6).toString('hex')}`;
    const rawSecretToken = 'EAAB_PRIVACY_SUPER_SECRET_TOKEN';

    const capturedLogs = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;

    function intercept(level, ...args) {
      capturedLogs.push({ level, text: args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') });
    }

    console.log = (...args) => { intercept('log', ...args); };
    console.warn = (...args) => { intercept('warn', ...args); };
    console.error = (...args) => { intercept('error', ...args); };

    let commentExecuted = false;
    let messagingExecuted = false;

    try {
      const mockDb = createMockDb();
      const enc = encryptTestToken(rawSecretToken);
      mockDb.raw.set(rawAccountId, {
        id: rawAccountId,
        instagram_user_id: rawAccountId,
        owner_user_id: 'usr_priv_test',
        username: 'creator_priv_test',
        ciphertext: enc.ciphertext,
        iv: enc.iv,
        tag: enc.tag,
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        active_dispatches: 0,
        active_dispatch_leases: []
      });
      mockDb.automationsRaw.set('auto_priv_test', {
        id: 'auto_priv_test',
        owner_user_id: 'usr_priv_test',
        instagram_user_id: rawAccountId,
        keyword: rawCommentText,
        dm_message: 'Here is your private guide',
        reply_template: 'Thanks for asking!',
        enabled: 1,
        flow: { followGate: { enabled: false } }
      });
      db.collections = mockDb.collections;

      // Mock instagramService calls for this test
      const origPrivateReply = instagramService.sendPrivateReply;
      const origReplyToComment = instagramService.replyToComment;
      const origSendDM = instagramService.sendDirectMessage;

      instagramService.sendPrivateReply = async () => ({ id: 'mid_priv_reply' });
      instagramService.replyToComment = async () => ({ id: 'meta_comment_reply_id' });
      instagramService.sendDirectMessage = async () => ({ message_id: 'mid_dm_sent' });

      try {
        const executeWebhookJob = app.locals.executeWebhookJob;
        assert(typeof executeWebhookJob === 'function', 'executeWebhookJob must be available');

        // 1. Exercise actual comment webhook
        await executeWebhookJob({
          event_type: 'comment',
          instagram_account_id: rawAccountId,
          comment_id: rawCommentId,
          from_id: rawSenderIgsid,
          from_username: 'test_commenter',
          comment_text: rawCommentText
        });
        commentExecuted = true;

        // 2. Exercise actual incoming message webhook
        await executeWebhookJob({
          event_type: 'messaging_postback',
          instagram_account_id: rawAccountId,
          from_id: rawSenderIgsid,
          action: 'SEND_LINK',
          automation_id: 'auto_priv_test',
          comment_id: rawCommentId,
          message_text: rawPrivateMsg
        });
        messagingExecuted = true;
      } finally {
        instagramService.sendPrivateReply = origPrivateReply;
        instagramService.replyToComment = origReplyToComment;
        instagramService.sendDirectMessage = origSendDM;
      }
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    }

    assert.strictEqual(commentExecuted, true, 'Comment webhook must have executed successfully');
    assert.strictEqual(messagingExecuted, true, 'Messaging webhook must have executed successfully');
    assert(capturedLogs.length >= 5, 'Log collection must not be empty; operational logs must have been generated');

    const allCapturedText = capturedLogs.map(l => l.text).join('\n');
    assert(!allCapturedText.includes(rawSenderIgsid), 'Captured logs must NOT contain raw sender IGSID');
    assert(!allCapturedText.includes(rawCommentId), 'Captured logs must NOT contain raw comment ID');
    assert(!allCapturedText.includes(rawCommentText), 'Captured logs must NOT contain raw comment text');
    assert(!allCapturedText.includes(rawPrivateMsg), 'Captured logs must NOT contain private message text');
    assert(!allCapturedText.includes(rawAccountId), 'Captured logs must NOT contain raw account ID');
    assert(!allCapturedText.includes(rawSecretToken), 'Captured logs must NOT contain raw access token');
  });

  // ====================================================================
  // 5. TOKEN CACHE CORRECTNESS & MULTI-PROCESS PROTECTION
  // ====================================================================
  console.log('\n--- 5. TOKEN CACHE CORRECTNESS & MULTI-PROCESS PROTECTION ---');

  // Test 24: Cache hit avoids DB query
  await runTestAsync('Test 24: Token cache hit returns decrypted token without querying database', async () => {
    const mockDb = createMockDb();
    const enc = encryptTestToken('TOKEN_CACHE_HIT_TEST');
    mockDb.raw.set('ig_cache_1', {
      id: 'ig_cache_1',
      instagram_user_id: 'ig_cache_1',
      owner_user_id: 'usr_c1',
      username: 'cacheuser',
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      tag: enc.tag,
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      active_dispatches: 0,
      active_dispatch_leases: []
    });
    db.collections = mockDb.collections;
    instagramService.clearTokenCache();

    mockDb.resetQueryCount();
    // Call 1: Cache Miss -> Queries DB
    const res1 = await instagramService.getDecryptedTokenByInstagramUserId('ig_cache_1', 'usr_c1');
    assert.strictEqual(res1.accessToken, 'TOKEN_CACHE_HIT_TEST');
    assert.strictEqual(mockDb.getQueryCount(), 1, 'First call must query DB (queryCount = 1)');

    // Call 2: Cache Hit -> MUST NOT query DB
    const res2 = await instagramService.getDecryptedTokenByInstagramUserId('ig_cache_1', 'usr_c1');
    assert.strictEqual(res2.accessToken, 'TOKEN_CACHE_HIT_TEST');
    assert.strictEqual(mockDb.getQueryCount(), 1, 'Second call must hit memory cache (queryCount stays 1)');
  });

  // Test 25: saveAccount invalidates token cache
  await runTestAsync('Test 25: saveAccount clears the decrypted token cache on connect/reconnect', async () => {
    const mockDb = createMockDb();
    const enc1 = encryptTestToken('INITIAL_TOKEN_123');
    mockDb.raw.set('ig_reconn', {
      id: 'ig_reconn',
      instagram_user_id: 'ig_reconn',
      owner_user_id: 'usr_r1',
      username: 'reconn_user',
      ciphertext: enc1.ciphertext,
      iv: enc1.iv,
      tag: enc1.tag,
      expires_at: new Date(Date.now() + 3600000).toISOString()
    });
    db.collections = mockDb.collections;
    instagramService.clearTokenCache();

    // Warm cache
    const initial = await instagramService.getDecryptedTokenByInstagramUserId('ig_reconn', 'usr_r1');
    assert.strictEqual(initial.accessToken, 'INITIAL_TOKEN_123');
    assert.strictEqual(instagramService._tokenCache.size > 0, true, 'Cache must contain entry');

    // Simulate saveAccount reconnect with new token
    const origRun = db.run;
    db.run = async () => {};
    const origSub = instagramService.subscribeToWebhooks;
    instagramService.subscribeToWebhooks = async () => {};

    await instagramService.saveAccount(
      'usr_r1',
      { userId: 'ig_reconn', username: 'reconn_user' },
      { accessToken: 'RECONNECTED_TOKEN_456', expiresIn: 3600 }
    );

    assert.strictEqual(instagramService._tokenCache.size, 0, 'saveAccount must have cleared tokenCache');

    db.run = origRun;
    instagramService.subscribeToWebhooks = origSub;
  });

  // Test 26: disconnect clears the decrypted token cache
  await runTestAsync('Test 26: disconnect clears the decrypted token cache and reelsCache', async () => {
    const mockDb = createMockDb();
    const enc = encryptTestToken('DISC_TOKEN_TEST');
    mockDb.raw.set('ig_disc_cache', {
      id: 'ig_disc_cache',
      instagram_user_id: 'ig_disc_cache',
      owner_user_id: 'usr_d1',
      username: 'discuser',
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      tag: enc.tag,
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      active_dispatches: 0,
      active_dispatch_leases: []
    });
    db.collections = mockDb.collections;
    instagramService.clearTokenCache();

    // Warm cache
    await instagramService.getDecryptedTokenByInstagramUserId('ig_disc_cache', 'usr_d1');
    assert.strictEqual(instagramService._tokenCache.size > 0, true, 'Cache must contain entry before disconnect');

    // Disconnect
    await instagramService.disconnect('usr_d1', 'ig_disc_cache');
    assert.strictEqual(instagramService._tokenCache.size, 0, 'disconnect must have cleared tokenCache');
    assert.strictEqual(mockDb.raw.has('ig_disc_cache'), false, 'Account must be removed from DB');
  });

  // Test 27: Multi-process safety: disconnected account cannot dispatch even if second process holds cached token
  await runTestAsync('Test 27: Multi-process safety: disconnected account cannot dispatch even if second process holds cached token', async () => {
    const mockDb = createMockDb();
    const enc = encryptTestToken('TOKEN_FOR_MULTI_PROC');
    const accId = 'ig_multi_proc_test';
    const ownerId = 'usr_multi_owner';

    mockDb.raw.set(accId, {
      id: accId,
      instagram_user_id: accId,
      owner_user_id: ownerId,
      username: 'multiproc_user',
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      tag: enc.tag,
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      active_dispatches: 0,
      active_dispatch_leases: []
    });
    db.collections = mockDb.collections;
    instagramService.clearTokenCache();

    // 1. Populate the actual token cache using the real test account and encrypted token
    const tokenInProcA = await instagramService.getDecryptedTokenByInstagramUserId(accId, ownerId);
    assert.strictEqual(tokenInProcA.accessToken, 'TOKEN_FOR_MULTI_PROC');

    // 2. Retain the decrypted token result as the simulated second-process (Process B) cache
    const procBCachedToken = { ...tokenInProcA };
    assert.strictEqual(procBCachedToken.accessToken, 'TOKEN_FOR_MULTI_PROC');

    // 3. Process A disconnects the account in the shared mock database
    await instagramService.disconnect(ownerId, accId);
    assert.strictEqual(mockDb.raw.has(accId), false, 'Account must be deleted from shared database by Process A');

    // 4. Process B attempts outbound dispatch using its retained in-memory token
    let dispatchCalled = false;
    const res = await safeDispatchOutbound(accId, 'worker_process_B', async () => {
      dispatchCalled = true;
      return { message_id: 'mid_unauthorized' };
    });

    // 5. Confirm that lease acquisition fails at the database layer and dispatch callback is NEVER called
    assert.strictEqual(dispatchCalled, false, 'External dispatch callback must NEVER be called across processes');
    assert.strictEqual(res.skipped, true);
    assert.strictEqual(res.reason, 'ACCOUNT_DELETED');
  });

  // Test 28: Expired token evicted from cache even within 30s TTL
  await runTestAsync('Test 28: Expired token is evicted from cache even within 30s TTL and throws 401', async () => {
    const mockDb = createMockDb();
    const enc = encryptTestToken('EXPIRING_SOON_TOKEN');
    // Token that expires in 50 milliseconds
    const tokenExpiresAt = new Date(Date.now() + 50).toISOString();
    mockDb.raw.set('ig_exp_token', {
      id: 'ig_exp_token',
      instagram_user_id: 'ig_exp_token',
      owner_user_id: 'usr_exp',
      username: 'expuser',
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      tag: enc.tag,
      expires_at: tokenExpiresAt,
      active_dispatches: 0,
      active_dispatch_leases: []
    });
    db.collections = mockDb.collections;
    instagramService.clearTokenCache();

    // Call 1: valid now (expires in 50ms)
    const validToken = await instagramService.getDecryptedTokenByInstagramUserId('ig_exp_token', 'usr_exp');
    assert.strictEqual(validToken.accessToken, 'EXPIRING_SOON_TOKEN');

    // Wait 70ms so token has expired (well within 30s TTL!)
    await new Promise(resolve => setTimeout(resolve, 70));

    // Call 2: cached token has expired -> must evict from cache and throw 401
    let errorCaught = null;
    try {
      await instagramService.getDecryptedTokenByInstagramUserId('ig_exp_token', 'usr_exp');
    } catch (err) {
      errorCaught = err;
    }

    assert(errorCaught, 'Must throw 401 when token has expired');
    assert.strictEqual(errorCaught.statusCode, 401);
    assert.strictEqual(instagramService._tokenCache.has('ig_exp_token:usr_exp'), false, 'Expired entry must be evicted from cache');
  });

  // ====================================================================
  // 6. LEASE-AWARE INSTAGRAM DISCONNECT FAIL-CLOSED SAFETY
  // ====================================================================
  console.log('\n--- 6. LEASE-AWARE INSTAGRAM DISCONNECT FAIL-CLOSED SAFETY ---');

  // Test 29: Disconnect fails closed with 503 when collections unavailable
  await runTestAsync('Test 29: Disconnect fails closed with 503 when collections unavailable', async () => {
    const origCols = db.collections;
    db.collections = () => { throw new Error('Database cluster connection failure'); };

    let errorCaught = null;
    try {
      await instagramService.disconnect('usr_fail', 'ig_fail_1');
    } catch (err) {
      errorCaught = err;
    } finally {
      db.collections = origCols;
    }

    assert(errorCaught, 'Must throw when database safety checks unavailable');
    assert.strictEqual(errorCaught.statusCode, 503);
    assert.strictEqual(errorCaught.retryable, true);
    assert.strictEqual(errorCaught.code, 'DATABASE_SAFETY_UNAVAILABLE');
  });

  // Test 30: Disconnect requires successful deletion-pending update, failing closed with 503 if update fails
  await runTestAsync('Test 30: Disconnect requires successful deletion-pending update, failing closed with 503 if update fails', async () => {
    const mockDb = createMockDb();
    mockDb.raw.set('ig_fail_mark', {
      id: 'ig_fail_mark',
      instagram_user_id: 'ig_fail_mark',
      owner_user_id: 'usr_fail',
      ciphertext: 'c', iv: 'i', tag: 't'
    });
    mockDb.automationsRaw.set('auto_fail_mark', {
      id: 'auto_fail_mark',
      owner_user_id: 'usr_fail',
      instagram_user_id: 'ig_fail_mark'
    });
    db.collections = mockDb.collections;

    // Simulate updateMany failure
    mockDb.collections().instagramAccounts.updateMany = async () => {
      throw new Error('Disk I/O error during deletion-pending update');
    };

    let errorCaught = null;
    try {
      await instagramService.disconnect('usr_fail', 'ig_fail_mark');
    } catch (err) {
      errorCaught = err;
    }

    assert(errorCaught, 'Must throw 503 when deletion-pending update fails');
    assert.strictEqual(errorCaught.statusCode, 503);
    assert.strictEqual(errorCaught.retryable, true);
    assert.strictEqual(mockDb.raw.has('ig_fail_mark'), true, 'Account credentials must be preserved');
    assert.strictEqual(mockDb.automationsRaw.has('auto_fail_mark'), true, 'Automations must be preserved');
  });

  // Test 31: Disconnect fails closed with 503 if active lease checking throws, preserving credentials
  await runTestAsync('Test 31: Disconnect fails closed with 503 if active lease checking throws, preserving credentials', async () => {
    const mockDb = createMockDb();
    mockDb.raw.set('ig_fail_check', {
      id: 'ig_fail_check',
      instagram_user_id: 'ig_fail_check',
      owner_user_id: 'usr_fail',
      active_dispatches: 0,
      active_dispatch_leases: []
    });
    mockDb.automationsRaw.set('auto_fail_check', {
      id: 'auto_fail_check',
      owner_user_id: 'usr_fail',
      instagram_user_id: 'ig_fail_check'
    });
    db.collections = mockDb.collections;

    // Simulate find throwing during drain check
    mockDb.collections().instagramAccounts.find = () => ({
      toArray: async () => { throw new Error('Network timeout during lease check'); }
    });

    let errorCaught = null;
    try {
      await instagramService.disconnect('usr_fail', 'ig_fail_check');
    } catch (err) {
      errorCaught = err;
    }

    assert(errorCaught, 'Must throw 503 when lease check fails');
    assert.strictEqual(errorCaught.statusCode, 503);
    assert.strictEqual(errorCaught.retryable, true);
    assert.strictEqual(mockDb.raw.has('ig_fail_check'), true, 'Account credentials must be preserved');
    assert.strictEqual(mockDb.automationsRaw.has('auto_fail_check'), true, 'Automations must be preserved');
  });

  // Test 32: Disconnect timeout throws 503 and preserves account and automations in DB
  await runTestAsync('Test 32: Disconnect timeout throws 503 and preserves account and automations in DB', async () => {
    const mockDb = createMockDb();
    const enc = encryptTestToken('PRESERVED_TOKEN');
    mockDb.raw.set('ig_drain_timeout', {
      id: 'ig_drain_timeout',
      instagram_user_id: 'ig_drain_timeout',
      owner_user_id: 'usr_drain',
      username: 'preserved_user',
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      tag: enc.tag,
      active_dispatches: 1,
      active_dispatch_leases: [{ lease_id: 'lease_stuck', worker_id: 'w_slow', expires_at: new Date(Date.now() + 10000) }]
    });
    mockDb.automationsRaw.set('auto_preserved', {
      id: 'auto_preserved',
      owner_user_id: 'usr_drain',
      instagram_user_id: 'ig_drain_timeout',
      keyword: 'VIP',
      enabled: 1
    });
    db.collections = mockDb.collections;

    let errorCaught = null;
    try {
      await instagramService.disconnect('usr_drain', 'ig_drain_timeout', { drainTimeoutMs: 100, pollIntervalMs: 20 });
    } catch (err) {
      errorCaught = err;
    }

    assert(errorCaught, 'Must throw 503 when drain times out');
    assert.strictEqual(errorCaught.code, 'DISCONNECT_DRAIN_TIMEOUT');
    assert.strictEqual(errorCaught.statusCode, 503);
    assert.strictEqual(errorCaught.retryable, true);

    // CRITICAL: Ensure account and automations were NOT deleted!
    assert.strictEqual(mockDb.raw.has('ig_drain_timeout'), true, 'Account credentials MUST NOT be deleted on drain timeout');
    assert.strictEqual(mockDb.automationsRaw.has('auto_preserved'), true, 'Automations MUST NOT be deleted on drain timeout');
  });

  // Test 33: Disconnect propagates database deletion errors
  await runTestAsync('Test 33: Disconnect propagates database deletion errors instead of swallowing them', async () => {
    const mockDb = createMockDb();
    mockDb.raw.set('ig_drain_err', {
      id: 'ig_drain_err',
      instagram_user_id: 'ig_drain_err',
      owner_user_id: 'usr_drain',
      active_dispatches: 0,
      active_dispatch_leases: []
    });
    db.collections = mockDb.collections;

    // Cause deleteMany on instagramAccounts to fail
    mockDb.collections().instagramAccounts.deleteMany = async () => {
      throw new Error('Database write failure: disk full');
    };

    let errorCaught = null;
    try {
      await instagramService.disconnect('usr_drain', 'ig_drain_err');
    } catch (err) {
      errorCaught = err;
    }

    assert(errorCaught, 'Disconnect MUST throw and propagate database deletion failure');
    assert(errorCaught.message.includes('disk full'), 'Error message must propagate from database');
  });

  // ====================================================================
  // 7. OUTBOUND OPERATIONS LEASE PROTECTION
  // ====================================================================
  console.log('\n--- 7. OUTBOUND OPERATIONS LEASE PROTECTION ---');

  // Test 34: Public comment reply requires dispatch lease and records stage
  await runTestAsync('Test 34: Public comment reply is routed through safeDispatchOutbound with PUBLIC_REPLY_LEASE_ACQUIRED', async () => {
    const mockDb = createMockDb();
    const enc = encryptTestToken('REPLY_TEST_TOKEN');
    mockDb.raw.set('ig_reply_acc', {
      id: 'ig_reply_acc',
      instagram_user_id: 'ig_reply_acc',
      owner_user_id: 'usr_rep',
      username: 'reply_creator',
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      tag: enc.tag,
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      active_dispatches: 0,
      active_dispatch_leases: []
    });
    mockDb.automationsRaw.set('auto_rep_1', {
      id: 'auto_rep_1',
      owner_user_id: 'usr_rep',
      instagram_user_id: 'ig_reply_acc',
      keyword: 'PRICE',
      dm_message: 'DM sent!',
      reply_template: 'Thanks for asking! Check your DMs 😊',
      enabled: 1
    });
    db.collections = mockDb.collections;

    automationTimeline.clearRecordedTimeline();

    // Mock instagramService.replyToComment and sendPrivateReply
    const origReply = instagramService.replyToComment;
    const origPrivate = instagramService.sendPrivateReply;
    let replyCalled = false;
    let replyLeasePresent = false;

    instagramService.sendPrivateReply = async () => ({ id: 'mid_priv_reply' });
    instagramService.replyToComment = async () => {
      replyCalled = true;
      // Verify active dispatch lease was present on account during reply
      const acc = mockDb.raw.get('ig_reply_acc');
      replyLeasePresent = acc.active_dispatches > 0 && acc.active_dispatch_leases.length > 0;
      return { id: 'meta_comment_reply_id_999' };
    };

    try {
      const executeWebhookJob = app.locals.executeWebhookJob;
      await executeWebhookJob({
        event_type: 'comment',
        instagram_account_id: 'ig_reply_acc',
        comment_id: 'cmt_price_123',
        from_id: 'from_user_1',
        from_username: 'customer1',
        comment_text: 'What is the PRICE?'
      });
    } finally {
      instagramService.replyToComment = origReply;
      instagramService.sendPrivateReply = origPrivate;
    }

    assert.strictEqual(replyCalled, true, 'replyToComment must have been called');
    assert.strictEqual(replyLeasePresent, true, 'Active dispatch lease MUST have been held during replyToComment');

    const timeline = automationTimeline.getRecordedTimeline();
    const publicReplyStage = timeline.find(t => t.stage === 'PUBLIC_REPLY_LEASE_ACQUIRED');
    assert(publicReplyStage, 'PUBLIC_REPLY_LEASE_ACQUIRED stage must be recorded in automation timeline');
  });

  // Restore collections
  db.collections = origCollections;

  console.log('\n======================================================================');
  console.log(`   ALL ${totalTests} RELEASE REVIEW VERIFICATION TESTS PASSED!`);
  console.log('======================================================================\n');
})();
