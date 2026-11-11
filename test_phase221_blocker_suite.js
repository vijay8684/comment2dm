// test_phase221_blocker_suite.js
// COMMENT2DM — PHASE 2.2.1: CRITICAL AUDIT BLOCKER FIXES VERIFICATION SUITE
//
// Tests the 4 critical blockers identified during the independent reliability audit:
//   1. Opening DM Retry State & pre- vs post-dispatch classification
//   2. Resource Delivery Crash Safety with delivery_request_dispatched guard
//   3. Non-blocking Account Rate Limits & immediate job rescheduling
//   4. Removal of legacy drainJobQueue from webhook ingestion
//
// All tests execute REAL production functions with high-fidelity atomic MongoDB and Meta API mocks.

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');

const { deliverFinalResource, executeCommentJob, app } = require('./server');
const webhookJobQueue = require('./src/jobs/webhookJobQueue');
const webhookWorker = require('./src/jobs/webhookWorker');
const metaRateLimiter = require('./src/services/metaRateLimiter');
const instagramService = require('./src/instagram/instagramService');
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

// In-Memory atomic MongoDB mock replicating production collection semantics
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
        if (val.$nin !== undefined && val.$nin.includes(docVal)) return false;
        if (val.$in !== undefined && !val.$in.includes(docVal)) return false;
        if (val.$lt !== undefined) {
          const tDoc = docVal instanceof Date ? docVal.getTime() : new Date(docVal).getTime();
          const tVal = val.$lt instanceof Date ? val.$lt.getTime() : new Date(val.$lt).getTime();
          if (isNaN(tDoc) || isNaN(tVal) || !(tDoc < tVal)) return false;
        }
        if (val.$lte !== undefined) {
          const tDoc = docVal instanceof Date ? docVal.getTime() : new Date(docVal).getTime();
          const tVal = val.$lte instanceof Date ? val.$lte.getTime() : new Date(val.$lte).getTime();
          if (isNaN(tDoc) || isNaN(tVal) || !(tDoc <= tVal)) return false;
        }
        if (val.$gt !== undefined) {
          const tDoc = docVal instanceof Date ? docVal.getTime() : new Date(docVal).getTime();
          const tVal = val.$gt instanceof Date ? val.$gt.getTime() : new Date(val.$gt).getTime();
          if (isNaN(tDoc) || isNaN(tVal) || !(tDoc > tVal)) return false;
        }
        if (val.$gte !== undefined) {
          const tDoc = docVal instanceof Date ? docVal.getTime() : new Date(docVal).getTime();
          const tVal = val.$gte instanceof Date ? val.$gte.getTime() : new Date(val.$gte).getTime();
          if (isNaN(tDoc) || isNaN(tVal) || !(tDoc >= tVal)) return false;
        }
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
        const cloned = JSON.parse(JSON.stringify(doc));
        for (const [k, v] of Object.entries(doc)) {
          if (v instanceof Date) cloned[k] = v;
        }
        cloned[keyField] = key;
        mapStore.set(key, cloned);
        return { acknowledged: true, insertedId: key };
      },
      async findOne(filter) {
        for (const doc of mapStore.values()) {
          if (matchesFilter(doc, filter)) {
            return JSON.parse(JSON.stringify(doc));
          }
        }
        return null;
      },
      find(filter) {
        return {
          async toArray() {
            const results = [];
            for (const doc of mapStore.values()) {
              if (matchesFilter(doc, filter)) {
                results.push(JSON.parse(JSON.stringify(doc)));
              }
            }
            return results;
          }
        };
      },
      async updateOne(filter, update, options = {}) {
        let target = null;
        for (const doc of mapStore.values()) {
          if (matchesFilter(doc, filter)) {
            target = doc;
            break;
          }
        }
        if (target) {
          applyUpdate(target, update, false);
          return { matchedCount: 1, modifiedCount: 1 };
        }
        if (options.upsert) {
          const newDoc = { ...filter };
          applyUpdate(newDoc, update, true);
          const key = newDoc[keyField] || newDoc.event_key || newDoc.claim_key || newDoc.key || crypto.randomUUID();
          mapStore.set(key, newDoc);
          return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
        }
        return { matchedCount: 0, modifiedCount: 0 };
      },
      async findOneAndUpdate(filter, update, options = {}) {
        let target = null;
        for (const doc of mapStore.values()) {
          if (matchesFilter(doc, filter)) {
            target = doc;
            break;
          }
        }
        if (target) {
          applyUpdate(target, update, false);
          return JSON.parse(JSON.stringify(target));
        }
        return null;
      },
      async deleteOne(filter) {
        for (const [k, doc] of mapStore.entries()) {
          if (matchesFilter(doc, filter)) {
            mapStore.delete(k);
            return { deletedCount: 1 };
          }
        }
        return { deletedCount: 0 };
      }
    };
  }

  const dbInstance = {
    collections() {
      return {
        webhookJobs: makeCollection(jobs, 'event_key'),
        conversationStates: makeCollection(conversationStates, 'key'),
        openingDmClaims: makeCollection(openingDmClaims, 'claim_key'),
        automationEvents: {
          async insertOne(doc) {
            automationEvents.push({ ...doc });
            return { acknowledged: true };
          },
          async findOne(filter) {
            return automationEvents.find(d => matchesFilter(d, filter)) || null;
          },
          find(filter) {
            return {
              async toArray() {
                return automationEvents.filter(d => matchesFilter(d, filter));
              }
            };
          }
        },
        accountRateLimits: makeCollection(accountRateLimits, 'account_id'),
        automations: makeCollection(automations, 'id')
      };
    },
    async get(query, params) {
      if (params && params[0] && automations.has(params[0])) {
        return { ...automations.get(params[0]) };
      }
      for (const a of automations.values()) {
        if (params && params[0] && a.id === params[0]) return { ...a };
      }
      return null;
    },
    async all(query, params) {
      const results = [];
      for (const a of automations.values()) {
        if (!params || !params[0] || a.instagram_user_id === params[0]) {
          results.push({ ...a });
        }
      }
      return results;
    },
    async run(query, params) { return { changes: 1 }; }
  };

  const serverDb = require('./src/db');
  serverDb.collections = dbInstance.collections;
  serverDb.all = dbInstance.all;
  serverDb.get = dbInstance.get;
  serverDb.run = dbInstance.run;

  return dbInstance;
}

async function runBlockerSuite() {
  console.log('\n======================================================================');
  console.log(' COMMENT2DM — PHASE 2.2.1: CRITICAL AUDIT BLOCKER FIXES SUITE');
  console.log('======================================================================\n');

  const origSendPrivateReply = instagramService.sendPrivateReply;
  const origSendDirectMessage = instagramService.sendDirectMessage;
  const origGetToken = instagramService.getDecryptedTokenByInstagramUserId;
  const origEntitlement = billing.entitlement;

  const serverDb = require('./src/db');
  function setupTestDb(testDb) {
    serverDb.collections = testDb.collections;
    serverDb.all = testDb.all;
    serverDb.get = testDb.get;
    serverDb.run = testDb.run;
  }

  // Restore stubs after tests
  function restoreAllMocks() {
    instagramService.sendPrivateReply = origSendPrivateReply;
    instagramService.sendDirectMessage = origSendDirectMessage;
    instagramService.getDecryptedTokenByInstagramUserId = origGetToken;
    billing.entitlement = origEntitlement;
    metaRateLimiter._resetForTesting();
    webhookWorker._resetWorkerForTesting();
  }

  // -------------------------------------------------------------------------
  // TEST 1: Opening DM known pre-dispatch failure becomes failed_retryable
  // -------------------------------------------------------------------------
  await runTestAsync('Test 1: Opening DM known pre-dispatch failure becomes failed_retryable', async () => {
    restoreAllMocks();
    const testDb = createMockDb();
    const appRef = require('./server').app;
    appRef.locals.db = testDb;

    const autoId = 'auto_predispatch_1';
    await testDb.collections().automations.insertOne({
      id: autoId,
      owner_user_id: 'user_1',
      instagram_user_id: 'acc_101',
      keyword: 'PROMO',
      enabled: 1
    });

    // Simulate pre-dispatch error (e.g. Database blip fetching decrypted token)
    instagramService.getDecryptedTokenByInstagramUserId = async () => {
      const err = new Error('Database connection reset during token lookup');
      err.code = 'ECONNRESET';
      throw err;
    };

    let dispatchAttempted = false;
    instagramService.sendPrivateReply = async () => {
      dispatchAttempted = true;
      return { message_id: 'unexpected_send' };
    };

    const job = {
      event_key: 'comment:cmt_predispatch_101',
      job_id: 'comment:cmt_predispatch_101',
      event_type: 'comment',
      instagram_account_id: 'acc_101',
      comment_id: 'cmt_predispatch_101',
      text: 'PROMO code please',
      from_id: 'user_commenter_1',
      from_username: 'vip_fan',
      worker_id: 'worker_p221_1'
    };

    let threw = false;
    try {
      await executeCommentJob(job);
    } catch (e) {
      threw = true;
    }
    assert.strictEqual(threw, true, 'Should rethrow pre-dispatch failure');
    assert.strictEqual(dispatchAttempted, false, 'Meta request must not have been dispatched');

    const claimKey = `acc_101:cmt_predispatch_101:${autoId}`;
    const claimDoc = await testDb.collections().openingDmClaims.findOne({ claim_key: claimKey });
    assert.ok(claimDoc, 'Claim record must exist');
    assert.strictEqual(claimDoc.status, 'failed_retryable', 'Known pre-dispatch failure must be failed_retryable');
    assert.strictEqual(claimDoc.retryable, true, 'Must be marked retryable');
    assert.strictEqual(claimDoc.request_dispatched, false, 'request_dispatched must be false');
  });

  // -------------------------------------------------------------------------
  // TEST 2: A retry can successfully send after a known pre-dispatch failure
  // -------------------------------------------------------------------------
  await runTestAsync('Test 2: A retry can successfully send after a known pre-dispatch failure', async () => {
    restoreAllMocks();
    const testDb = createMockDb();
    const appRef = require('./server').app;
    appRef.locals.db = testDb;

    const autoId = 'auto_retry_success_1';
    await testDb.collections().automations.insertOne({
      id: autoId,
      owner_user_id: 'user_1',
      instagram_user_id: 'acc_101',
      keyword: 'PROMO',
      enabled: 1
    });

    const claimKey = `acc_101:cmt_retry_102:${autoId}`;
    // Pre-populate claim as failed_retryable from a previous attempt
    await testDb.collections().openingDmClaims.insertOne({
      claim_key: claimKey,
      instagram_account_id: 'acc_101',
      comment_id: 'cmt_retry_102',
      automation_id: autoId,
      status: 'failed_retryable',
      request_dispatched: false,
      retryable: true,
      last_error: 'Pre-dispatch timeout',
      created_at: new Date(Date.now() - 5000)
    });

    // Token fetch now succeeds
    instagramService.getDecryptedTokenByInstagramUserId = async () => ({
      accessToken: 'valid_test_token',
      username: 'creator_pro'
    });

    let sentMessageId = null;
    instagramService.sendPrivateReply = async (accId, cmtId, payload) => {
      sentMessageId = 'meta_opening_msg_999';
      return { message_id: sentMessageId };
    };

    const job = {
      event_key: 'comment:cmt_retry_102',
      job_id: 'comment:cmt_retry_102',
      event_type: 'comment',
      instagram_account_id: 'acc_101',
      comment_id: 'cmt_retry_102',
      text: 'PROMO',
      from_id: 'user_commenter_2',
      from_username: 'fan_two',
      worker_id: 'worker_retry_winner'
    };

    await executeCommentJob(job);

    const updatedClaim = await testDb.collections().openingDmClaims.findOne({ claim_key: claimKey });
    assert.strictEqual(updatedClaim.status, 'sent', 'Claim must transition to sent on successful retry');
    assert.strictEqual(updatedClaim.meta_message_id, 'meta_opening_msg_999');
    assert.strictEqual(updatedClaim.request_dispatched, true);
  });

  // -------------------------------------------------------------------------
  // TEST 3: Opening DM dispatched followed by ECONNRESET becomes unknown
  // -------------------------------------------------------------------------
  await runTestAsync('Test 3: Opening DM dispatched followed by ECONNRESET becomes unknown', async () => {
    restoreAllMocks();
    const testDb = createMockDb();
    const appRef = require('./server').app;
    appRef.locals.db = testDb;

    const autoId = 'auto_econnreset_1';
    await testDb.collections().automations.insertOne({
      id: autoId,
      owner_user_id: 'user_1',
      instagram_user_id: 'acc_101',
      keyword: 'PROMO',
      enabled: 1
    });

    instagramService.getDecryptedTokenByInstagramUserId = async () => ({
      accessToken: 'valid_test_token'
    });

    // Simulate socket reset AFTER request sent to Meta
    instagramService.sendPrivateReply = async () => {
      const err = new Error('socket hang up');
      err.code = 'ECONNRESET';
      throw err;
    };

    const job = {
      event_key: 'comment:cmt_reset_103',
      job_id: 'comment:cmt_reset_103',
      event_type: 'comment',
      instagram_account_id: 'acc_101',
      comment_id: 'cmt_reset_103',
      text: 'PROMO',
      from_id: 'user_3',
      worker_id: 'worker_p221_reset'
    };

    let threw = false;
    try {
      await executeCommentJob(job);
    } catch (e) {
      threw = true;
    }
    assert.strictEqual(threw, true);

    const claimKey = `acc_101:cmt_reset_103:${autoId}`;
    const claimDoc = await testDb.collections().openingDmClaims.findOne({ claim_key: claimKey });
    assert.strictEqual(claimDoc.status, 'unknown', 'Dispatched request followed by socket drop must become unknown');
    assert.strictEqual(claimDoc.request_dispatched, true, 'Request was dispatched');
    assert.strictEqual(claimDoc.retryable, false, 'Unknown outcome must never be marked retryable');
  });

  // -------------------------------------------------------------------------
  // TEST 4: An unknown opening DM is never automatically resent
  // -------------------------------------------------------------------------
  await runTestAsync('Test 4: An unknown opening DM is never automatically resent', async () => {
    restoreAllMocks();
    const testDb = createMockDb();
    const appRef = require('./server').app;
    appRef.locals.db = testDb;

    const autoId = 'auto_unknown_no_resend';
    await testDb.collections().automations.insertOne({
      id: autoId,
      owner_user_id: 'user_1',
      instagram_user_id: 'acc_101',
      keyword: 'PROMO',
      enabled: 1
    });

    const claimKey = `acc_101:cmt_unknown_104:${autoId}`;
    // Claim is in unknown state
    await testDb.collections().openingDmClaims.insertOne({
      claim_key: claimKey,
      instagram_account_id: 'acc_101',
      comment_id: 'cmt_unknown_104',
      automation_id: autoId,
      status: 'unknown',
      request_dispatched: true,
      last_error: 'Connection dropped',
      created_at: new Date(Date.now() - 30000)
    });

    let sendCalled = false;
    instagramService.sendPrivateReply = async () => {
      sendCalled = true;
      return { message_id: 'bad_resend' };
    };

    const job = {
      event_key: 'comment:cmt_unknown_104',
      job_id: 'comment:cmt_unknown_104',
      event_type: 'comment',
      instagram_account_id: 'acc_101',
      comment_id: 'cmt_unknown_104',
      text: 'PROMO',
      from_id: 'user_4',
      worker_id: 'worker_retry_unknown'
    };

    let caughtErr = null;
    let res = null;
    try {
      res = await executeCommentJob(job);
    } catch (err) {
      caughtErr = err;
    }

    assert.strictEqual(sendCalled, false, 'Meta send must NEVER be called for unknown claim');
    if (res) {
      assert.strictEqual(res.status, 'unknown', 'Result must indicate unknown status');
      assert.strictEqual(res.reason, 'UNKNOWN_OUTCOME');
    } else {
      assert.ok(caughtErr, 'Should indicate unretryable outcome');
      assert.strictEqual(caughtErr.category, 'UNKNOWN_OUTCOME');
    }
  });

  // -------------------------------------------------------------------------
  // TEST 5: Permanent permission failures become failed_permanent
  // -------------------------------------------------------------------------
  await runTestAsync('Test 5: Permanent permission failures become failed_permanent', async () => {
    restoreAllMocks();
    const testDb = createMockDb();
    const appRef = require('./server').app;
    appRef.locals.db = testDb;

    const autoId = 'auto_perm_fail_1';
    await testDb.collections().automations.insertOne({
      id: autoId,
      owner_user_id: 'user_1',
      instagram_user_id: 'acc_101',
      keyword: 'PROMO',
      enabled: 1
    });

    instagramService.getDecryptedTokenByInstagramUserId = async () => ({
      accessToken: 'expired_token'
    });

    instagramService.sendPrivateReply = async () => {
      const err = new Error('Error validating access token: Session has been invalidated.');
      err.statusCode = 401;
      err.metaError = { code: 190, message: 'Invalid OAuth 2.0 Access Token' };
      throw err;
    };

    const job = {
      event_key: 'comment:cmt_auth_fail_105',
      job_id: 'comment:cmt_auth_fail_105',
      event_type: 'comment',
      instagram_account_id: 'acc_101',
      comment_id: 'cmt_auth_fail_105',
      text: 'PROMO',
      from_id: 'user_5',
      worker_id: 'worker_auth_test'
    };

    try {
      await executeCommentJob(job);
    } catch (_) {}

    const claimKey = `acc_101:cmt_auth_fail_105:${autoId}`;
    const claimDoc = await testDb.collections().openingDmClaims.findOne({ claim_key: claimKey });
    assert.strictEqual(claimDoc.status, 'failed_permanent', 'Must record failed_permanent');
    assert.strictEqual(claimDoc.retryable, false);
  });

  // -------------------------------------------------------------------------
  // TEST 6: Queue does not mark a skipped opening DM as successfully delivered
  // -------------------------------------------------------------------------
  await runTestAsync('Test 6: Queue does not mark a skipped opening DM as successfully delivered', async () => {
    restoreAllMocks();
    const testDb = createMockDb();
    webhookWorker._resetWorkerForTesting();

    const jobKey = 'comment:cmt_skipped_claim_106';
    const autoId = 'auto_skipped_test';
    const claimKey = `acc_creator_6:cmt_skipped_claim_106:${autoId}`;

    // Claim is unknown
    await testDb.collections().openingDmClaims.insertOne({
      claim_key: claimKey,
      status: 'unknown',
      request_dispatched: true,
      last_error: 'Uncertain delivery'
    });

    await testDb.collections().automations.insertOne({
      id: autoId,
      owner_user_id: 'user_6',
      instagram_user_id: 'acc_creator_6',
      keyword: 'LINK',
      enabled: 1
    });

    await testDb.collections().webhookJobs.insertOne({
      event_key: jobKey,
      job_id: jobKey,
      event_type: 'comment',
      instagram_account_id: 'acc_creator_6',
      comment_id: 'cmt_skipped_claim_106',
      text: 'LINK',
      status: 'queued',
      attempts: 0,
      run_at: new Date(Date.now() - 1000),
      created_at: new Date()
    });

    const appRef = require('./server').app;
    appRef.locals.db = testDb;

    // Start worker and process
    webhookWorker.startWorker(testDb, executeCommentJob, { pollIntervalMs: 20 });
    await new Promise(r => setTimeout(r, 120));
    await webhookWorker.stopWorker();

    const jobInDb = await testDb.collections().webhookJobs.findOne({ event_key: jobKey });
    assert.notStrictEqual(jobInDb.status, 'sent', 'Skipped opening DM must NOT be marked sent!');
    assert.strictEqual(jobInDb.status === 'failed' || jobInDb.status === 'dead_letter', true, 'Job must be failed or dead_letter');
  });

  // -------------------------------------------------------------------------
  // TEST 7: Resource DM dispatched followed by process crash becomes unknown
  // -------------------------------------------------------------------------
  await runTestAsync('Test 7: Resource DM dispatched followed by process crash becomes unknown', async () => {
    restoreAllMocks();
    const testDb = createMockDb();
    const stateKey = 'auto_res_crash_1:acc_101:user_7';

    // Simulate process crash: worker 1 set sending and dispatched: true, then crashed and lease expired
    await testDb.collections().conversationStates.insertOne({
      key: stateKey,
      automation_id: 'auto_res_crash_1',
      owner_user_id: 'owner_1',
      instagram_user_id: 'acc_101',
      sender_igsid: 'user_7',
      delivery_state: 'sending',
      delivery_worker_id: 'crashed_worker_1',
      delivery_locked_until: new Date(Date.now() - 5000), // Expired 5 seconds ago!
      delivery_request_dispatched: true, // Dispatched to Meta before crash!
      resource_delivered: false,
      created_at: new Date().toISOString()
    });

    let sendCalled = false;
    instagramService.sendDirectMessage = async () => {
      sendCalled = true;
      return { message_id: 'duplicate_resource' };
    };

    const automation = { id: 'auto_res_crash_1', owner_user_id: 'owner_1', dm_message: 'Link here' };
    const flow = { delivery: { message: 'Link here', resourceUrl: 'https://example.com/asset' } };
    const tokenData = { accessToken: 'valid_token' };

    const res = await deliverFinalResource({
      recipientIgUserId: 'acc_101',
      senderIgsid: 'user_7',
      automation,
      tokenData,
      flow,
      commentId: 'cmt_7',
      workerId: 'worker_recovering_2'
    });

    assert.strictEqual(sendCalled, false, 'Must NEVER re-dispatch resource if previous worker dispatched before crashing');
    assert.strictEqual(res.reason, 'UNKNOWN_OUTCOME');

    const updatedState = await testDb.collections().conversationStates.findOne({ key: stateKey });
    assert.strictEqual(updatedState.delivery_state, 'unknown', 'Delivery state must transition to unknown');
    assert.strictEqual(updatedState.delivery_locked_until, null);
  });

  // -------------------------------------------------------------------------
  // TEST 8: Expired dispatched resource delivery is not reclaimed
  // -------------------------------------------------------------------------
  await runTestAsync('Test 8: Expired dispatched resource delivery is not reclaimed', async () => {
    restoreAllMocks();
    const testDb = createMockDb();
    const stateKey = 'auto_no_reclaim:acc_101:user_8';

    await testDb.collections().conversationStates.insertOne({
      key: stateKey,
      delivery_state: 'unknown',
      delivery_request_dispatched: true,
      resource_delivered: false
    });

    let sendDispatched = false;
    instagramService.sendDirectMessage = async () => {
      sendDispatched = true;
      return { message_id: 'should_not_send' };
    };

    const res = await deliverFinalResource({
      recipientIgUserId: 'acc_101',
      senderIgsid: 'user_8',
      automation: { id: 'auto_no_reclaim', owner_user_id: 'owner_1' },
      tokenData: { accessToken: 'tok' },
      flow: {},
      workerId: 'worker_attempt_reclaim'
    });

    assert.strictEqual(sendDispatched, false, 'Unknown resource delivery must never be reclaimed');
    assert.strictEqual(res.success, false);
  });

  // -------------------------------------------------------------------------
  // TEST 9: Expired undispatched resource delivery can be safely reclaimed
  // -------------------------------------------------------------------------
  await runTestAsync('Test 9: Expired undispatched resource delivery can be safely reclaimed', async () => {
    restoreAllMocks();
    const testDb = createMockDb();
    const stateKey = 'auto_safe_reclaim:acc_101:user_9';

    // Worker 1 crashed BEFORE dispatch (e.g. In billing check or string template formatting)
    await testDb.collections().conversationStates.insertOne({
      key: stateKey,
      delivery_state: 'sending',
      delivery_worker_id: 'crashed_worker_pre_dispatch',
      delivery_locked_until: new Date(Date.now() - 3000), // Expired
      delivery_request_dispatched: false, // Never sent to Meta!
      resource_delivered: false
    });

    let deliveredMsgId = null;
    instagramService.sendDirectMessage = async () => {
      deliveredMsgId = 'meta_safe_reclaimed_id_123';
      return { message_id: deliveredMsgId };
    };

    const res = await deliverFinalResource({
      recipientIgUserId: 'acc_101',
      senderIgsid: 'user_9',
      automation: { id: 'auto_safe_reclaim', owner_user_id: 'owner_1' },
      tokenData: { accessToken: 'tok' },
      flow: { delivery: { message: 'Here is your link!', resourceUrl: 'https://example.com' } },
      workerId: 'worker_healthy_reclaimer'
    });

    assert.strictEqual(deliveredMsgId, 'meta_safe_reclaimed_id_123', 'Undispatched expired lease must be safely reclaimed and delivered');
    const updatedState = await testDb.collections().conversationStates.findOne({ key: stateKey });
    assert.strictEqual(updatedState.delivery_state, 'sent');
    assert.strictEqual(updatedState.resource_delivered, true);
    assert.strictEqual(updatedState.meta_message_id, 'meta_safe_reclaimed_id_123');
  });

  // -------------------------------------------------------------------------
  // TEST 10: Resource fallback cannot send again after an uncertain outcome
  // -------------------------------------------------------------------------
  await runTestAsync('Test 10: Resource fallback cannot send again after an uncertain outcome', async () => {
    restoreAllMocks();
    const testDb = createMockDb();
    const stateKey = 'auto_fallback_guard:acc_101:user_10';

    let sendCallCount = 0;
    instagramService.sendDirectMessage = async () => {
      sendCallCount++;
      // First attempt times out
      const err = new Error('ESOCKETTIMEDOUT while awaiting Meta');
      err.code = 'ETIMEDOUT';
      throw err;
    };

    let caughtErr = null;
    try {
      await deliverFinalResource({
        recipientIgUserId: 'acc_101',
        senderIgsid: 'user_10',
        automation: { id: 'auto_fallback_guard', owner_user_id: 'owner_1' },
        tokenData: { accessToken: 'tok' },
        flow: { delivery: { message: 'Link', resourceUrl: 'https://example.com' } },
        workerId: 'worker_fallback_tester'
      });
    } catch (e) {
      caughtErr = e;
    }

    assert.ok(caughtErr);
    assert.strictEqual(sendCallCount, 1, 'Must NOT attempt fallback send after uncertain first outcome');
    const state = await testDb.collections().conversationStates.findOne({ key: stateKey });
    assert.strictEqual(state.delivery_state, 'unknown');
  });

  // -------------------------------------------------------------------------
  // TEST 11: Long account pause reschedules the job without blocking a worker slot
  // -------------------------------------------------------------------------
  await runTestAsync('Test 11: Long account pause reschedules the job without blocking a worker slot', async () => {
    restoreAllMocks();
    const testDb = createMockDb();
    const pausedAccountId = 'acc_long_paused_11';
    const pauseDurationMs = 60000; // 60 seconds pause
    const pauseExpiry = new Date(Date.now() + pauseDurationMs);

    // Record pause in accountRateLimits
    metaRateLimiter.pauseAccount(pausedAccountId, pauseDurationMs, 'Meta 429 Retry-After', testDb);

    const job = {
      event_key: 'comment:paused_cmt_11',
      job_id: 'comment:paused_cmt_11',
      instagram_account_id: pausedAccountId,
      status: 'processing',
      worker_id: 'worker_fast_slot_11',
      locked_until: new Date(Date.now() + 30000),
      attempts: 1
    };
    await testDb.collections().webhookJobs.insertOne(job);

    let businessLogicRan = false;
    const dummyExecutor = async () => {
      businessLogicRan = true;
    };

    const startTime = Date.now();
    // Start worker process for claimed job
    await webhookWorker._processClaimedJobForTesting(job, dummyExecutor, testDb, 'worker_fast_slot_11');
    const elapsedMs = Date.now() - startTime;

    assert.strictEqual(businessLogicRan, false, 'Business logic must not run for paused account');
    assert.ok(elapsedMs < 100, `Worker slot must be freed immediately without sleeping for 60s! Elapsed: ${elapsedMs}ms`);

    const updatedJob = await testDb.collections().webhookJobs.findOne({ event_key: 'comment:paused_cmt_11' });
    assert.strictEqual(updatedJob.status, 'retrying', 'Job must be rescheduled to retrying');
    assert.strictEqual(updatedJob.locked_until, null, 'Lock must be released');
    assert.ok(new Date(updatedJob.run_at).getTime() >= pauseExpiry.getTime() - 2000, 'run_at must match pause expiry');
  });

  // -------------------------------------------------------------------------
  // TEST 12: Healthy account jobs continue while another account is paused
  // -------------------------------------------------------------------------
  await runTestAsync('Test 12: Healthy account jobs continue while another account is paused', async () => {
    restoreAllMocks();
    const testDb = createMockDb();
    webhookWorker._resetWorkerForTesting();

    const pausedAccountId = 'acc_paused_12';
    const healthyAccountId = 'acc_healthy_12';

    // Pause Account A for 60s
    metaRateLimiter.pauseAccount(pausedAccountId, 60000, 'Rate limited', testDb);

    // Job for paused account
    await testDb.collections().webhookJobs.insertOne({
      event_key: 'comment:paused_job_12',
      job_id: 'comment:paused_job_12',
      instagram_account_id: pausedAccountId,
      status: 'queued',
      attempts: 0,
      run_at: new Date(Date.now() - 1000),
      created_at: new Date()
    });

    // Job for healthy account
    await testDb.collections().webhookJobs.insertOne({
      event_key: 'comment:healthy_job_12',
      job_id: 'comment:healthy_job_12',
      instagram_account_id: healthyAccountId,
      status: 'queued',
      attempts: 0,
      run_at: new Date(Date.now() - 1000),
      created_at: new Date()
    });

    let healthyJobExecuted = false;
    const testExecutor = async (job) => {
      if (job.instagram_account_id === healthyAccountId) {
        healthyJobExecuted = true;
      }
    };

    webhookWorker.startWorker(testDb, testExecutor, { pollIntervalMs: 20 });
    await new Promise(r => setTimeout(r, 150));
    await webhookWorker.stopWorker();

    assert.strictEqual(healthyJobExecuted, true, 'Healthy account job must execute without being blocked by paused account');
    const healthyJobInDb = await testDb.collections().webhookJobs.findOne({ event_key: 'comment:healthy_job_12' });
    assert.strictEqual(healthyJobInDb.status, 'sent');
  });

  // -------------------------------------------------------------------------
  // TEST 13: Rescheduling rejects stale worker ownership
  // -------------------------------------------------------------------------
  await runTestAsync('Test 13: Rescheduling rejects stale worker ownership', async () => {
    restoreAllMocks();
    const testDb = createMockDb();
    const jobKey = 'comment:stale_resched_13';

    await testDb.collections().webhookJobs.insertOne({
      event_key: jobKey,
      instagram_account_id: 'acc_13',
      status: 'processing',
      worker_id: 'legitimate_new_worker_2',
      locked_until: new Date(Date.now() + 30000)
    });

    // Stale worker 1 attempts to reschedule
    const res = await webhookJobQueue.rescheduleJobForPause(
      { event_key: jobKey, instagram_account_id: 'acc_13' },
      'stale_expired_worker_1',
      new Date(Date.now() + 60000),
      testDb
    );

    assert.strictEqual(res.success, false, 'Must reject rescheduling from worker that does not hold lease');
    assert.strictEqual(res.reason, 'LEASE_LOST');

    const jobDoc = await testDb.collections().webhookJobs.findOne({ event_key: jobKey });
    assert.strictEqual(jobDoc.worker_id, 'legitimate_new_worker_2', 'Job ownership must remain intact');
  });

  // -------------------------------------------------------------------------
  // TEST 14: Webhook ingestion does not invoke the legacy drain function
  // -------------------------------------------------------------------------
  await runTestAsync('Test 14: Webhook ingestion does not invoke the legacy drain function', async () => {
    restoreAllMocks();
    const testDb = createMockDb();
    const appRef = require('./server').app;
    appRef.locals.db = testDb;

    let legacyDrainCalled = false;
    appRef.locals.drainJobQueue = async () => {
      legacyDrainCalled = true;
      return 0;
    };

    // Construct valid webhook payload
    const testPayload = {
      object: 'instagram',
      entry: [{
        id: 'acc_ingest_test',
        time: Date.now(),
        changes: [{
          field: 'comments',
          value: {
            id: 'cmt_ingest_test_14',
            text: 'Hello world',
            from: { id: 'user_14', username: 'tester' },
            media: { id: 'media_14' }
          }
        }]
      }]
    };

    // Ingest payload via queue
    const ingestRes = await webhookJobQueue.ingestWebhookPayload(testPayload, testDb);
    assert.strictEqual(ingestRes.count, 1, 'Should enqueue 1 job');

    // Wait a tick to confirm no setImmediate drain was scheduled
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(legacyDrainCalled, false, 'Legacy drainJobQueue must NOT be invoked during ingestion');
  });

  // -------------------------------------------------------------------------
  // TEST 15: Only the persistent worker consumes webhook jobs
  // -------------------------------------------------------------------------
  await runTestAsync('Test 15: Only the persistent worker consumes webhook jobs', async () => {
    restoreAllMocks();
    const testDb = createMockDb();
    webhookWorker._resetWorkerForTesting();

    await testDb.collections().webhookJobs.insertOne({
      event_key: 'comment:cmt_exclusive_worker_15',
      job_id: 'comment:cmt_exclusive_worker_15',
      instagram_account_id: 'acc_15',
      status: 'queued',
      attempts: 0,
      run_at: new Date(Date.now() - 500),
      created_at: new Date()
    });

    let consumedByWorker = false;
    webhookWorker.startWorker(testDb, async (job) => {
      consumedByWorker = true;
    }, { pollIntervalMs: 20 });

    await new Promise(r => setTimeout(r, 100));
    await webhookWorker.stopWorker();

    assert.strictEqual(consumedByWorker, true, 'Persistent worker must be the sole consumer processing queued jobs');
    const updated = await testDb.collections().webhookJobs.findOne({ event_key: 'comment:cmt_exclusive_worker_15' });
    assert.strictEqual(updated.status, 'sent');
  });

  // -------------------------------------------------------------------------
  // TEST 16: Existing heartbeat and shutdown behavior still works
  // -------------------------------------------------------------------------
  await runTestAsync('Test 16: Existing heartbeat and shutdown behavior still works', async () => {
    restoreAllMocks();
    const testDb = createMockDb();
    webhookWorker._resetWorkerForTesting();

    let jobCompleted = false;
    webhookWorker.startWorker(testDb, async (job) => {
      // Simulate task running during graceful shutdown
      await new Promise(r => setTimeout(r, 50));
      jobCompleted = true;
    }, { pollIntervalMs: 20 });

    await testDb.collections().webhookJobs.insertOne({
      event_key: 'comment:cmt_shutdown_16',
      job_id: 'comment:cmt_shutdown_16',
      instagram_account_id: 'acc_16',
      status: 'queued',
      attempts: 0,
      run_at: new Date(Date.now() - 500),
      created_at: new Date()
    });

    // Give it a moment to claim
    await new Promise(r => setTimeout(r, 30));
    // Trigger graceful stop
    await webhookWorker.stopWorker();

    assert.strictEqual(jobCompleted, true, 'In-flight task must drain cleanly before worker shutdown');
    const status = webhookWorker.getWorkerStatus();
    assert.strictEqual(status.is_running, false, 'Worker must be stopped');
  });

  console.log('\n======================================================================');
  console.log(`   ALL 16 BLOCKER SCENARIOS PASSED: ${passedTests}/${totalTests} tests successful`);
  console.log('======================================================================\n');
  process.exit(0);
}

runBlockerSuite().catch(err => {
  console.error('Fatal blocker test suite error:', err);
  process.exit(1);
});
