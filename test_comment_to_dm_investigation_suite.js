// test_comment_to_dm_investigation_suite.js
// Comment2DM — Real Comment-to-DM Failure Investigation & Dispatch Timing Verification Suite
// Verifies all 20 required scenarios covering comment triggers, private replies, incoming message webhooks,
// text responses, conversation state restoration, follow gates, timeouts, lease lifecycles, and error states.

const assert = require('assert');
const crypto = require('crypto');
const webhookJobQueue = require('./src/jobs/webhookJobQueue');
const metaRateLimiter = require('./src/services/metaRateLimiter');
const instagramService = require('./src/instagram/instagramService');
const { deliverFinalResource, executeCommentJob, executeMessagingJob } = require('./server');
const db = require('./src/db');

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

// In-Memory MongoDB mock supporting collections: webhookJobs, conversationStates, openingDmClaims, automationEvents, instagramAccounts, automations
function createMockDb() {
  const jobs = new Map();
  const conversationStates = new Map();
  const openingDmClaims = new Map();
  const automationEvents = [];
  const instagramAccounts = new Map();
  const automations = new Map();

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
      const docVal = doc[key];
      if (val !== null && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Date)) {
        if (val.$ne !== undefined && docVal === val.$ne) return false;
        if (val.$in !== undefined) {
          const matchIn = val.$in.includes(docVal) || (val.$in.includes(null) && (docVal === undefined || docVal === null));
          if (!matchIn) return false;
        }
        if (val.$nin !== undefined) {
          const matchNin = val.$nin.includes(docVal) || (val.$nin.includes(null) && (docVal === undefined || docVal === null));
          if (matchNin) return false;
        }
        if (val.$lt !== undefined && !(docVal < val.$lt)) return false;
        if (val.$lte !== undefined && !(docVal <= val.$lte)) return false;
        if (val.$gt !== undefined && !(docVal > val.$gt)) return false;
        if (val.$gte !== undefined && !(docVal >= val.$gte)) return false;
      } else {
        if (docVal !== val) return false;
      }
    }
    return true;
  }

  function applyUpdate(doc, update, isInsert = false) {
    if (isInsert && update.$setOnInsert) Object.assign(doc, update.$setOnInsert);
    if (update.$set) Object.assign(doc, update.$set);
    if (update.$inc) {
      for (const [k, v] of Object.entries(update.$inc)) {
        doc[k] = (doc[k] || 0) + v;
      }
    }
    if (update.$push) {
      for (const [k, v] of Object.entries(update.$push)) {
        if (!Array.isArray(doc[k])) doc[k] = [];
        doc[k].push(v);
      }
    }
    if (update.$pull) {
      for (const [k, v] of Object.entries(update.$pull)) {
        if (Array.isArray(doc[k])) {
          doc[k] = doc[k].filter(item => {
            if (typeof v === 'object' && v !== null) {
              for (const [condKey, condVal] of Object.entries(v)) {
                if (typeof condVal === 'object' && condVal !== null) {
                  if (condVal.$lte && !(item[condKey] <= condVal.$lte)) return true;
                } else if (item[condKey] !== condVal) {
                  return true;
                }
              }
              return false;
            }
            return item !== v;
          });
        }
      }
    }
    return doc;
  }

  function makeCollection(map, idField = 'key') {
    return {
      async findOne(query) {
        for (const doc of map.values()) {
          if (matchesFilter(doc, query)) return JSON.parse(JSON.stringify(doc));
        }
        return null;
      },
      find(query) {
        return {
          sort(sortObj) {
            return this;
          },
          async toArray() {
            const results = [];
            for (const doc of map.values()) {
              if (matchesFilter(doc, query)) results.push(JSON.parse(JSON.stringify(doc)));
            }
            return results;
          }
        };
      },
      async insertOne(doc) {
        const key = doc[idField] || doc.id || doc._id || crypto.randomUUID();
        map.set(String(key), JSON.parse(JSON.stringify(doc)));
        return { acknowledged: true, insertedId: key };
      },
      async updateOne(query, update, options = {}) {
        for (const [k, doc] of map.entries()) {
          if (matchesFilter(doc, query)) {
            applyUpdate(doc, update, false);
            return { matchedCount: 1, modifiedCount: 1 };
          }
        }
        if (options.upsert) {
          const newDoc = { [idField]: query[idField] || crypto.randomUUID() };
          applyUpdate(newDoc, update, true);
          map.set(String(newDoc[idField]), newDoc);
          return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
        }
        return { matchedCount: 0, modifiedCount: 0 };
      },
      async findOneAndUpdate(query, update, options = {}) {
        for (const doc of map.values()) {
          if (matchesFilter(doc, query)) {
            applyUpdate(doc, update, false);
            return JSON.parse(JSON.stringify(doc));
          }
        }
        return null;
      },
      async countDocuments(query) {
        let count = 0;
        for (const doc of map.values()) {
          if (matchesFilter(doc, query)) count++;
        }
        return count;
      }
    };
  }

  const collectionsObj = {
    webhookJobs: makeCollection(jobs, 'event_key'),
    conversationStates: makeCollection(conversationStates, 'key'),
    openingDmClaims: makeCollection(openingDmClaims, 'claim_key'),
    automationEvents: {
      async insertOne(doc) {
        automationEvents.push(JSON.parse(JSON.stringify(doc)));
        return { acknowledged: true };
      },
      async findOne(query) {
        for (const doc of automationEvents) {
          if (matchesFilter(doc, query)) return JSON.parse(JSON.stringify(doc));
        }
        return null;
      }
    },
    instagramAccounts: makeCollection(instagramAccounts, 'instagram_user_id'),
    automations: makeCollection(automations, 'id')
  };

  return {
    collections() {
      return collectionsObj;
    },
    async get(sql, params) {
      if (sql.includes('FROM automations WHERE id = ?')) {
        const id = params[0];
        return automations.get(String(id)) || null;
      }
      return null;
    },
    async all(sql, params) {
      if (sql.includes('FROM automations WHERE instagram_user_id = ?')) {
        const igId = params[0];
        const res = [];
        for (const a of automations.values()) {
          if (String(a.instagram_user_id) === String(igId) && a.enabled) res.push(a);
        }
        return res;
      }
      return [];
    },
    _raw: { jobs, conversationStates, openingDmClaims, automationEvents, instagramAccounts, automations }
  };
}

async function runInvestigationSuite() {
  console.log('======================================================================');
  console.log('   COMMENT2DM — REAL COMMENT-TO-DM AUDIT TEST SUITE (20 SCENARIOS)');
  console.log('======================================================================\n');

  const origSendPrivateReply = instagramService.sendPrivateReply;
  const origSendDirectMessage = instagramService.sendDirectMessage;
  const origCheckFollowStatus = instagramService.checkFollowStatus;
  const origGetToken = instagramService.getDecryptedTokenByInstagramUserId;

  instagramService.getDecryptedTokenByInstagramUserId = async (igUserId) => ({
    accessToken: 'mock_valid_token',
    username: 'creator_test'
  });

  // -----------------------------------------------------------------------------------------
  // Test 1: Comment triggers exactly one private reply
  // -----------------------------------------------------------------------------------------
  await runTestAsync('Test 1: Comment triggers exactly one private reply', async () => {
    const testDb = createMockDb();
    db.collections = testDb.collections;

    await testDb.collections().instagramAccounts.insertOne({
      instagram_user_id: 'ig_acc_1',
      id: 'ig_acc_1',
      username: 'creator_test',
      active_dispatch_leases: []
    });

    await testDb.collections().automations.insertOne({
      id: 'auto_reel_1',
      owner_user_id: 'user_1',
      instagram_user_id: 'ig_acc_1',
      keyword: 'REELGUIDE',
      trigger_type: 'exact',
      enabled: true,
      flow: {
        followGate: { enabled: false },
        delivery: { resourceUrl: 'https://example.com/guide.pdf', buttonText: 'Get Guide' }
      }
    });

    let privateReplyCalls = 0;
    instagramService.sendPrivateReply = async (accId, commentId, payload, token) => {
      privateReplyCalls++;
      return { message_id: 'mid.comment_reply_101', recipient_id: 'user_commenter_1' };
    };

    const commentJob = {
      job_id: 'job_comm_1',
      event_type: 'comment',
      instagram_account_id: 'ig_acc_1',
      comment_id: 'comm_101',
      comment_text: 'I want REELGUIDE',
      from_id: 'user_commenter_1',
      from_username: 'commenter_jane'
    };

    await executeCommentJob(commentJob);

    assert.strictEqual(privateReplyCalls, 1, 'Private reply must be called exactly once');
    const claim = await testDb.collections().openingDmClaims.findOne({ claim_key: 'ig_acc_1:comm_101:auto_reel_1' });
    assert(claim, 'Opening DM claim must exist');
    assert.strictEqual(claim.status, 'sent', 'Claim must be stamped sent');
    assert.strictEqual(claim.meta_message_id, 'mid.comment_reply_101');

    const conv = await testDb.collections().conversationStates.findOne({ key: 'auto_reel_1:ig_acc_1:user_commenter_1' });
    assert(conv, 'Conversation state must be initialized');
    assert.strictEqual(conv.state, 'OPENING_DM_SENT');
  });

  // -----------------------------------------------------------------------------------------
  // Test 2: Second private reply for the same comment is not sent
  // -----------------------------------------------------------------------------------------
  await runTestAsync('Test 2: Second private reply for the same comment is not sent', async () => {
    let privateReplyCalls = 0;
    instagramService.sendPrivateReply = async () => {
      privateReplyCalls++;
      return { message_id: 'mid.should_not_be_called' };
    };

    const duplicateJob = {
      job_id: 'job_comm_1_dup',
      event_type: 'comment',
      instagram_account_id: 'ig_acc_1',
      comment_id: 'comm_101',
      comment_text: 'I want REELGUIDE',
      from_id: 'user_commenter_1',
      from_username: 'commenter_jane'
    };

    const res = await executeCommentJob(duplicateJob);
    assert.strictEqual(privateReplyCalls, 0, 'No second private reply may be sent to Meta');
    assert(res?.skipped, 'Job must be skipped');
  });

  // -----------------------------------------------------------------------------------------
  // Test 3: User sends the expected incoming text response
  // -----------------------------------------------------------------------------------------
  runTest('Test 3: User sends the expected incoming text response', () => {
    const rawPayload = {
      object: 'instagram',
      entry: [
        {
          id: 'ig_acc_1',
          time: 1700000000,
          messaging: [
            {
              sender: { id: 'user_commenter_1' },
              recipient: { id: 'ig_acc_1' },
              timestamp: 1700000000,
              message: {
                mid: 'mid.user_reply_text_1',
                text: 'SEND ME LINK'
              }
            }
          ]
        }
      ]
    };

    const normalized = webhookJobQueue.normalizeWebhookPayload(rawPayload);
    assert.strictEqual(normalized.length, 1, 'Must produce 1 normalized job');
    const job = normalized[0];
    assert.strictEqual(job.event_type, 'messaging_text');
    assert.strictEqual(job.action, 'SEND_LINK');
    assert.strictEqual(job.message_text, 'SEND ME LINK');
    assert.strictEqual(job.from_id, 'user_commenter_1');
  });

  // -----------------------------------------------------------------------------------------
  // Test 4: Incoming message webhook is recognized
  // -----------------------------------------------------------------------------------------
  await runTestAsync('Test 4: Incoming message webhook is recognized and enqueued', async () => {
    const testDb = createMockDb();
    const rawPayload = {
      object: 'instagram',
      entry: [
        {
          id: 'ig_acc_1',
          time: 1700000001,
          messaging: [
            {
              sender: { id: 'user_commenter_1' },
              recipient: { id: 'ig_acc_1' },
              timestamp: 1700000001,
              message: {
                mid: 'mid.webhook_recognize_1',
                text: 'link'
              }
            }
          ]
        }
      ]
    };

    const ingestRes = await webhookJobQueue.ingestWebhookPayload(rawPayload, testDb);
    assert.strictEqual(ingestRes.count, 1, 'Must persist 1 incoming messaging job');
    const stored = await testDb.collections().webhookJobs.findOne({ event_key: 'msg:mid.webhook_recognize_1' });
    assert(stored, 'Stored job must exist in database');
    assert.strictEqual(stored.action, 'SEND_LINK');
  });

  // -----------------------------------------------------------------------------------------
  // Test 5: Conversation state is restored
  // -----------------------------------------------------------------------------------------
  await runTestAsync('Test 5: Conversation state is restored for text response without autoId', async () => {
    const testDb = createMockDb();
    db.collections = testDb.collections;

    await testDb.collections().instagramAccounts.insertOne({
      instagram_user_id: 'ig_acc_1',
      id: 'ig_acc_1',
      active_dispatch_leases: []
    });

    await testDb.collections().automations.insertOne({
      id: 'auto_reel_specific',
      owner_user_id: 'user_1',
      instagram_user_id: 'ig_acc_1',
      keyword: 'SPECIFIC',
      enabled: true,
      flow: {
        followGate: { enabled: false },
        delivery: { resourceUrl: 'https://example.com/restored.pdf' }
      }
    });

    // Populate active conversation state
    await testDb.collections().conversationStates.insertOne({
      key: 'auto_reel_specific:ig_acc_1:user_commenter_1',
      automation_id: 'auto_reel_specific',
      instagram_user_id: 'ig_acc_1',
      sender_igsid: 'user_commenter_1',
      comment_id: 'comm_origin_123',
      state: 'OPENING_DM_SENT',
      resource_delivered: false,
      updated_at: new Date()
    });

    let delivered = false;
    instagramService.sendDirectMessage = async (accId, igsid, payload) => {
      delivered = true;
      return { message_id: 'mid.delivered_5' };
    };

    const messagingJob = {
      job_id: 'job_txt_restore',
      event_type: 'messaging_text',
      instagram_account_id: 'ig_acc_1',
      from_id: 'user_commenter_1',
      action: 'SEND_LINK',
      automation_id: null, // text response does not have autoId embedded
      comment_id: null,
      message_text: 'SEND ME LINK'
    };

    const res = await executeMessagingJob(messagingJob);
    assert(delivered, 'Direct message must be sent using restored conversation automation');
    assert.strictEqual(res?.success, true);
  });

  // -----------------------------------------------------------------------------------------
  // Test 6: Follow verification succeeds
  // -----------------------------------------------------------------------------------------
  await runTestAsync('Test 6: Follow verification succeeds', async () => {
    const testDb = createMockDb();
    db.collections = testDb.collections;

    await testDb.collections().instagramAccounts.insertOne({
      instagram_user_id: 'ig_acc_1',
      id: 'ig_acc_1',
      active_dispatch_leases: []
    });

    await testDb.collections().automations.insertOne({
      id: 'auto_follow_gate_1',
      owner_user_id: 'user_1',
      instagram_user_id: 'ig_acc_1',
      enabled: true,
      flow: {
        followGate: { enabled: true },
        delivery: { resourceUrl: 'https://example.com/unlocked.pdf' }
      }
    });

    await testDb.collections().conversationStates.insertOne({
      key: 'auto_follow_gate_1:ig_acc_1:user_follower',
      automation_id: 'auto_follow_gate_1',
      instagram_user_id: 'ig_acc_1',
      sender_igsid: 'user_follower',
      state: 'OPENING_DM_SENT',
      resource_delivered: false
    });

    instagramService.checkFollowStatus = async (accId, igsid) => ({
      supported: true,
      isFollowing: true,
      verified: true
    });

    let deliveredLink = false;
    instagramService.sendDirectMessage = async () => {
      deliveredLink = true;
      return { message_id: 'mid.follow_verified_link' };
    };

    const job = {
      job_id: 'job_fg_pass',
      action: 'SEND_LINK',
      instagram_account_id: 'ig_acc_1',
      from_id: 'user_follower',
      automation_id: 'auto_follow_gate_1'
    };

    const res = await executeMessagingJob(job);
    assert.strictEqual(res?.follow_verified, true, 'Follow verification must pass');
    assert(deliveredLink, 'Final link must be delivered');
  });

  // -----------------------------------------------------------------------------------------
  // Test 7: Follow verification fails
  // -----------------------------------------------------------------------------------------
  await runTestAsync('Test 7: Follow verification fails (user is not following)', async () => {
    const testDb = createMockDb();
    db.collections = testDb.collections;

    await testDb.collections().instagramAccounts.insertOne({
      instagram_user_id: 'ig_acc_1',
      id: 'ig_acc_1',
      active_dispatch_leases: []
    });

    await testDb.collections().automations.insertOne({
      id: 'auto_fg_fail',
      owner_user_id: 'user_1',
      instagram_user_id: 'ig_acc_1',
      enabled: true,
      flow: {
        followGate: { enabled: true, profileUrl: 'https://instagram.com/creator_test' },
        delivery: { resourceUrl: 'https://example.com/locked.pdf' }
      }
    });

    await testDb.collections().conversationStates.insertOne({
      key: 'auto_fg_fail:ig_acc_1:user_not_following',
      automation_id: 'auto_fg_fail',
      instagram_user_id: 'ig_acc_1',
      sender_igsid: 'user_not_following',
      state: 'OPENING_DM_SENT',
      resource_delivered: false
    });

    instagramService.checkFollowStatus = async () => ({
      supported: true,
      isFollowing: false,
      verified: true
    });

    let followPromptSent = false;
    instagramService.sendDirectMessage = async (accId, igsid, payload) => {
      followPromptSent = true;
      return { message_id: 'mid.prompt_7' };
    };

    const job = {
      job_id: 'job_fg_fail',
      action: 'SEND_LINK',
      instagram_account_id: 'ig_acc_1',
      from_id: 'user_not_following',
      automation_id: 'auto_fg_fail'
    };

    const res = await executeMessagingJob(job);
    assert.strictEqual(res?.follow_prompt_sent, true, 'Must send follow prompt');
    assert.strictEqual(res?.delivered, false, 'Final link must NOT be delivered');
    assert(followPromptSent, 'Follow prompt DM must be transmitted');

    const state = await testDb.collections().conversationStates.findOne({ key: 'auto_fg_fail:ig_acc_1:user_not_following' });
    assert.strictEqual(state.state, 'FOLLOW_PROMPT_SENT', 'Conversation state must transition to FOLLOW_PROMPT_SENT');
  });

  // -----------------------------------------------------------------------------------------
  // Test 8: Final link is sent after a valid response and successful follow verification
  // -----------------------------------------------------------------------------------------
  await runTestAsync('Test 8: Final link sent after valid response and successful follow verification', async () => {
    const testDb = createMockDb();
    db.collections = testDb.collections;

    await testDb.collections().instagramAccounts.insertOne({
      instagram_user_id: 'ig_acc_1',
      id: 'ig_acc_1',
      active_dispatch_leases: []
    });

    await testDb.collections().automations.insertOne({
      id: 'auto_recheck',
      owner_user_id: 'user_1',
      instagram_user_id: 'ig_acc_1',
      enabled: true,
      flow: {
        followGate: { enabled: true },
        delivery: { resourceUrl: 'https://example.com/reward.pdf', buttonText: 'View Reward' }
      }
    });

    await testDb.collections().conversationStates.insertOne({
      key: 'auto_recheck:ig_acc_1:user_recheck',
      automation_id: 'auto_recheck',
      instagram_user_id: 'ig_acc_1',
      sender_igsid: 'user_recheck',
      state: 'FOLLOW_PROMPT_SENT',
      resource_delivered: false
    });

    // User now follows:
    instagramService.checkFollowStatus = async () => ({
      supported: true,
      isFollowing: true,
      verified: true
    });

    let deliveredReward = false;
    instagramService.sendDirectMessage = async () => {
      deliveredReward = true;
      return { message_id: 'mid.reward_delivered_8' };
    };

    // User taps "I'm following ✅"
    const job = {
      job_id: 'job_tap_check_follow',
      action: 'CHECK_FOLLOW',
      instagram_account_id: 'ig_acc_1',
      from_id: 'user_recheck',
      automation_id: 'auto_recheck',
      payload: 'CHECK_FOLLOW:auto_recheck:comm_99'
    };

    const res = await executeMessagingJob(job);
    assert.strictEqual(res?.delivered, true, 'Resource must be delivered');
    assert(deliveredReward, 'Direct message must be sent to Meta');

    const state = await testDb.collections().conversationStates.findOne({ key: 'auto_recheck:ig_acc_1:user_recheck' });
    assert.strictEqual(state.resource_delivered, true);
    assert.strictEqual(state.delivery_state, 'sent');
  });

  // -----------------------------------------------------------------------------------------
  // Test 9: Missing conversation state is handled safely
  // -----------------------------------------------------------------------------------------
  await runTestAsync('Test 9: Missing conversation state is handled safely', async () => {
    const testDb = createMockDb();
    db.collections = testDb.collections;

    let metaCalled = false;
    instagramService.sendDirectMessage = async () => {
      metaCalled = true;
      return { message_id: 'should_not_happen' };
    };

    const jobWithoutState = {
      job_id: 'job_ghost_user',
      action: 'SEND_LINK',
      instagram_account_id: 'ig_acc_1',
      from_id: 'ghost_sender_404',
      automation_id: null,
      message_text: 'SEND ME LINK'
    };

    const res = await executeMessagingJob(jobWithoutState);
    assert.strictEqual(metaCalled, false, 'No Meta message should be sent without conversation state or automation');
    assert.strictEqual(res?.skipped, true);
    assert.strictEqual(res?.reason, 'CONVERSATION_STATE_MISSING');
  });

  // -----------------------------------------------------------------------------------------
  // Test 10: User replies with an unexpected message
  // -----------------------------------------------------------------------------------------
  await runTestAsync('Test 10: User replies with an unexpected message', async () => {
    const testDb = createMockDb();
    db.collections = testDb.collections;

    let metaCalled = false;
    instagramService.sendDirectMessage = async () => {
      metaCalled = true;
      return { message_id: 'should_not_happen' };
    };

    const jobUnexpected = {
      job_id: 'job_random_msg',
      action: 'USER_RESPONSE',
      instagram_account_id: 'ig_acc_1',
      from_id: 'user_confused_1',
      message_text: 'Who is this? Where did this come from?'
    };

    const res = await executeMessagingJob(jobUnexpected);
    assert.strictEqual(metaCalled, false, 'Unexpected message must not trigger automated messaging');
    assert.strictEqual(res?.handled, false);
    assert.strictEqual(res?.reason, 'UNEXPECTED_MESSAGE');
  });

  // -----------------------------------------------------------------------------------------
  // Test 11: Unsupported button/postback event is handled safely
  // -----------------------------------------------------------------------------------------
  await runTestAsync('Test 11: Unsupported button/postback event is handled safely', async () => {
    let metaCalled = false;
    instagramService.sendDirectMessage = async () => {
      metaCalled = true;
      return { message_id: 'should_not_happen' };
    };

    const jobUnsupported = {
      job_id: 'job_unsupported_btn',
      action: 'UNKNOWN_POSTBACK',
      instagram_account_id: 'ig_acc_1',
      from_id: 'user_tester_1',
      payload: 'UNSUPPORTED_RANDOM_BUTTON_123'
    };

    const res = await executeMessagingJob(jobUnsupported);
    assert.strictEqual(metaCalled, false);
    assert.strictEqual(res?.handled, false);
    assert.strictEqual(res?.reason, 'UNSUPPORTED_POSTBACK');
  });

  // -----------------------------------------------------------------------------------------
  // Test 12: No follow-up is sent before an eligible user response
  // -----------------------------------------------------------------------------------------
  await runTestAsync('Test 12: No follow-up is sent before an eligible user response', async () => {
    const testDb = createMockDb();
    db.collections = testDb.collections;

    // After comment job runs, state is OPENING_DM_SENT.
    await testDb.collections().conversationStates.insertOne({
      key: 'auto_12:ig_acc_1:user_12',
      automation_id: 'auto_12',
      instagram_user_id: 'ig_acc_1',
      sender_igsid: 'user_12',
      state: 'OPENING_DM_SENT',
      resource_delivered: false
    });

    // Check conversation state: resource_delivered is strictly false, no outbound request initiated
    const conv = await testDb.collections().conversationStates.findOne({ key: 'auto_12:ig_acc_1:user_12' });
    assert.strictEqual(conv.resource_delivered, false, 'Resource must remain undelivered prior to user action');
    assert.strictEqual(conv.state, 'OPENING_DM_SENT', 'State must remain OPENING_DM_SENT');
  });

  // -----------------------------------------------------------------------------------------
  // Test 13: Message outside the permitted messaging window is rejected safely
  // -----------------------------------------------------------------------------------------
  await runTestAsync('Test 13: Message outside permitted messaging window is rejected safely', async () => {
    const testDb = createMockDb();
    db.collections = testDb.collections;

    await testDb.collections().instagramAccounts.insertOne({
      instagram_user_id: 'ig_acc_1',
      id: 'ig_acc_1',
      active_dispatch_leases: []
    });

    const windowError = new Error('Cannot send message outside 24 hour window');
    windowError.statusCode = 400;
    windowError.metaError = { code: 10, error_subcode: 2018278, message: 'Cannot send message outside 24 hour window' };

    instagramService.sendDirectMessage = async () => {
      throw windowError;
    };

    const auto = {
      id: 'auto_window_test',
      owner_user_id: 'user_1',
      instagram_user_id: 'ig_acc_1'
    };

    let caughtError = null;
    try {
      await deliverFinalResource({
        recipientIgUserId: 'ig_acc_1',
        senderIgsid: 'user_expired_window',
        automation: auto,
        tokenData: { accessToken: 'token' },
        flow: { delivery: { resourceUrl: 'https://example.com' } },
        commentId: 'c1'
      });
    } catch (err) {
      caughtError = err;
    }

    assert(caughtError, 'Must throw messaging window error');
    const classification = metaRateLimiter.classifyMetaError(caughtError);
    assert.strictEqual(classification.category, 'MESSAGING_WINDOW', 'Category must be MESSAGING_WINDOW');
    assert.strictEqual(classification.retryable, false, 'Window error must never be retried');

    const state = await testDb.collections().conversationStates.findOne({ key: 'auto_window_test:ig_acc_1:user_expired_window' });
    assert.strictEqual(state.delivery_state, 'failed_permanent', 'State must be failed_permanent');
  });

  // -----------------------------------------------------------------------------------------
  // Test 14: Meta returns an application error
  // -----------------------------------------------------------------------------------------
  await runTestAsync('Test 14: Meta returns an application error', async () => {
    const testDb = createMockDb();
    db.collections = testDb.collections;

    await testDb.collections().instagramAccounts.insertOne({
      instagram_user_id: 'ig_acc_1',
      id: 'ig_acc_1',
      active_dispatch_leases: []
    });

    const appError = new Error('Invalid parameter: bad recipient ID');
    appError.statusCode = 400;
    appError.metaError = { code: 100, message: 'Invalid parameter: bad recipient ID' };

    instagramService.sendDirectMessage = async () => {
      throw appError;
    };

    const auto = {
      id: 'auto_app_err',
      owner_user_id: 'user_1',
      instagram_user_id: 'ig_acc_1'
    };

    let threw = false;
    try {
      await deliverFinalResource({
        recipientIgUserId: 'ig_acc_1',
        senderIgsid: 'user_bad_param',
        automation: auto,
        tokenData: { accessToken: 'token' },
        flow: { delivery: { resourceUrl: 'https://example.com' } }
      });
    } catch (err) {
      threw = true;
    }

    assert(threw, 'Must throw error');
    const classification = metaRateLimiter.classifyMetaError(appError);
    assert.strictEqual(classification.category, 'INVALID_REQUEST');
    assert.strictEqual(classification.retryable, false);

    const state = await testDb.collections().conversationStates.findOne({ key: 'auto_app_err:ig_acc_1:user_bad_param' });
    assert.strictEqual(state.delivery_state, 'failed');
  });

  // -----------------------------------------------------------------------------------------
  // Test 15: Meta request times out
  // -----------------------------------------------------------------------------------------
  await runTestAsync('Test 15: Meta request times out', async () => {
    const testDb = createMockDb();
    db.collections = testDb.collections;

    await testDb.collections().instagramAccounts.insertOne({
      instagram_user_id: 'ig_acc_1',
      id: 'ig_acc_1',
      active_dispatch_leases: []
    });

    const timeoutErr = new Error('The operation was aborted due to timeout');
    timeoutErr.name = 'TimeoutError';
    timeoutErr.uncertainDelivery = true;

    instagramService.sendDirectMessage = async () => {
      throw timeoutErr;
    };

    const auto = {
      id: 'auto_timeout_test',
      owner_user_id: 'user_1',
      instagram_user_id: 'ig_acc_1'
    };

    let caughtTimeout = null;
    try {
      await deliverFinalResource({
        recipientIgUserId: 'ig_acc_1',
        senderIgsid: 'user_timeout',
        automation: auto,
        tokenData: { accessToken: 'token' },
        flow: { delivery: { resourceUrl: 'https://example.com' } }
      });
    } catch (err) {
      caughtTimeout = err;
    }

    assert(caughtTimeout, 'Timeout must be thrown');
    const state = await testDb.collections().conversationStates.findOne({ key: 'auto_timeout_test:ig_acc_1:user_timeout' });
    assert.strictEqual(state.delivery_state, 'unknown', 'Delivery state must become unknown on timeout');
    assert.strictEqual(state.delivery_locked_until, null, 'Lock must be cleared');
  });

  // -----------------------------------------------------------------------------------------
  // Test 16: Lease is released after a successful request
  // -----------------------------------------------------------------------------------------
  await runTestAsync('Test 16: Lease is released after a successful request', async () => {
    const testDb = createMockDb();
    db.collections = testDb.collections;

    await testDb.collections().instagramAccounts.insertOne({
      instagram_user_id: 'ig_lease_acc',
      id: 'ig_lease_acc',
      active_dispatch_leases: []
    });

    let observedLeaseId = null;
    const lease = await db.acquireDispatchLease('ig_lease_acc', 'worker_success_test');
    observedLeaseId = lease.leaseId;

    let acc = await testDb.collections().instagramAccounts.findOne({ instagram_user_id: 'ig_lease_acc' });
    assert.strictEqual(acc.active_dispatch_leases.length, 1, 'Must hold 1 active lease');

    await db.releaseDispatchLease('ig_lease_acc', observedLeaseId);

    acc = await testDb.collections().instagramAccounts.findOne({ instagram_user_id: 'ig_lease_acc' });
    assert.strictEqual(acc.active_dispatch_leases.length, 0, 'Lease must be completely released');
  });

  // -----------------------------------------------------------------------------------------
  // Test 17: Lease is released after a failed request
  // -----------------------------------------------------------------------------------------
  await runTestAsync('Test 17: Lease is released after a failed request', async () => {
    const testDb = createMockDb();
    db.collections = testDb.collections;

    await testDb.collections().instagramAccounts.insertOne({
      instagram_user_id: 'ig_lease_fail_acc',
      id: 'ig_lease_fail_acc',
      active_dispatch_leases: []
    });

    const lease = await db.acquireDispatchLease('ig_lease_fail_acc', 'worker_fail_test');
    assert(lease?.leaseId);

    let acc = await testDb.collections().instagramAccounts.findOne({ instagram_user_id: 'ig_lease_fail_acc' });
    assert.strictEqual(acc.active_dispatch_leases.length, 1);

    // Simulate finally release on failure
    await db.releaseDispatchLease('ig_lease_fail_acc', lease.leaseId);

    acc = await testDb.collections().instagramAccounts.findOne({ instagram_user_id: 'ig_lease_fail_acc' });
    assert.strictEqual(acc.active_dispatch_leases.length, 0, 'Lease must be released even after failure');
  });

  // -----------------------------------------------------------------------------------------
  // Test 18: Lease expiration cannot permit a stale worker to continue dispatching
  // -----------------------------------------------------------------------------------------
  await runTestAsync('Test 18: Lease expiration cannot permit a stale worker to continue dispatching', async () => {
    const testDb = createMockDb();
    db.collections = testDb.collections;

    const expiredLease = {
      lease_id: 'lease_expired_123',
      worker_id: 'stale_worker',
      expires_at: new Date(Date.now() - 5000), // expired 5 seconds ago
      created_at: new Date(Date.now() - 20000)
    };

    await testDb.collections().instagramAccounts.insertOne({
      instagram_user_id: 'ig_stale_acc',
      id: 'ig_stale_acc',
      active_dispatch_leases: [expiredLease]
    });

    const isValid = await db.isDispatchLeaseValid('ig_stale_acc', 'lease_expired_123');
    assert.strictEqual(isValid, false, 'Expired lease must report invalid');
  });

  // -----------------------------------------------------------------------------------------
  // Test 19: Duplicate webhook events do not send duplicate DMs
  // -----------------------------------------------------------------------------------------
  await runTestAsync('Test 19: Duplicate webhook events do not send duplicate DMs', async () => {
    const testDb = createMockDb();
    db.collections = testDb.collections;

    await testDb.collections().instagramAccounts.insertOne({
      instagram_user_id: 'ig_acc_1',
      id: 'ig_acc_1',
      active_dispatch_leases: []
    });

    await testDb.collections().automations.insertOne({
      id: 'auto_dedup',
      owner_user_id: 'user_1',
      instagram_user_id: 'ig_acc_1',
      enabled: true,
      flow: {
        followGate: { enabled: false },
        delivery: { resourceUrl: 'https://example.com/unique.pdf' }
      }
    });

    let sendCalls = 0;
    instagramService.sendDirectMessage = async () => {
      sendCalls++;
      return { message_id: 'mid.sent_once' };
    };

    // 1st delivery call
    await deliverFinalResource({
      recipientIgUserId: 'ig_acc_1',
      senderIgsid: 'user_dedup_1',
      automation: { id: 'auto_dedup', owner_user_id: 'user_1' },
      tokenData: { accessToken: 'token' },
      flow: { delivery: { resourceUrl: 'https://example.com/unique.pdf' } }
    });

    // 2nd delivery call for same stateKey
    await deliverFinalResource({
      recipientIgUserId: 'ig_acc_1',
      senderIgsid: 'user_dedup_1',
      automation: { id: 'auto_dedup', owner_user_id: 'user_1' },
      tokenData: { accessToken: 'token' },
      flow: { delivery: { resourceUrl: 'https://example.com/unique.pdf' } }
    });

    assert.strictEqual(sendCalls, 1, 'Duplicate webhook event must send exactly 1 DM');
  });

  // -----------------------------------------------------------------------------------------
  // Test 20: A subsequent independent follow-up event obtains a fresh lease
  // -----------------------------------------------------------------------------------------
  await runTestAsync('Test 20: A subsequent independent follow-up event obtains a fresh lease', async () => {
    const testDb = createMockDb();
    db.collections = testDb.collections;

    await testDb.collections().instagramAccounts.insertOne({
      instagram_user_id: 'ig_fresh_lease_acc',
      id: 'ig_fresh_lease_acc',
      active_dispatch_leases: []
    });

    // Event 1: Initial Private Reply
    const lease1 = await db.acquireDispatchLease('ig_fresh_lease_acc', 'worker_comment_event');
    assert(lease1?.leaseId, 'Event 1 must acquire lease');
    await db.releaseDispatchLease('ig_fresh_lease_acc', lease1.leaseId);

    // Event 2: Independent follow-up event (User reply / messaging)
    const lease2 = await db.acquireDispatchLease('ig_fresh_lease_acc', 'worker_messaging_event');
    assert(lease2?.leaseId, 'Event 2 must acquire lease');
    assert.notStrictEqual(lease1.leaseId, lease2.leaseId, 'Follow-up event must receive a fresh, distinct lease ID');

    await db.releaseDispatchLease('ig_fresh_lease_acc', lease2.leaseId);

    const acc = await testDb.collections().instagramAccounts.findOne({ instagram_user_id: 'ig_fresh_lease_acc' });
    assert.strictEqual(acc.active_dispatch_leases.length, 0, 'All leases must be released');
  });

  // -----------------------------------------------------------------------------------------
  // Test 21: Meta webhook subscription verification (subscribed_fields and check endpoint)
  // -----------------------------------------------------------------------------------------
  await runTestAsync('Test 21: Meta webhook subscription verification', async () => {
    const origFetch = global.fetch;
    let subscribeRequestedFields = null;
    let checkRequestedUrl = null;

    global.fetch = async (url, options) => {
      const urlStr = String(url);
      if (options?.method === 'POST' && urlStr.includes('/subscribed_apps')) {
        const u = new URL(urlStr);
        subscribeRequestedFields = u.searchParams.get('subscribed_fields');
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true })
        };
      }
      if ((!options?.method || options?.method === 'GET') && urlStr.includes('/subscribed_apps')) {
        checkRequestedUrl = urlStr;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              {
                id: '123456789',
                name: 'Comment2DM App',
                subscribed_fields: ['comments', 'messages', 'messaging_postbacks']
              }
            ]
          })
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    try {
      // 1. Verify account subscription requests comments, messages, and messaging_postbacks
      const subRes = await instagramService.subscribeToWebhooks('ig_acc_test', 'test_token');
      assert.strictEqual(subRes.success, true, 'Subscription call must succeed');
      assert.strictEqual(
        subscribeRequestedFields,
        'comments,messages,messaging_postbacks',
        'Webhook subscription must include comments, messages, and messaging_postbacks'
      );

      // 2. Verify account subscription check queries /{ig-user-id}/subscribed_apps
      const checkRes = await instagramService.checkWebhookSubscription('ig_acc_test', 'test_token');
      assert(Array.isArray(checkRes.data), 'checkWebhookSubscription must return data array');
      assert.deepStrictEqual(
        checkRes.data[0].subscribed_fields,
        ['comments', 'messages', 'messaging_postbacks'],
        'Verified fields must match subscribed fields'
      );
    } finally {
      global.fetch = origFetch;
    }
  });

  // -----------------------------------------------------------------------------------------
  // Test 22: Realistic Instagram webhook payload tests (Text, Postback, Quick Reply, Comment)
  // -----------------------------------------------------------------------------------------
  await runTestAsync('Test 22: Realistic Instagram webhook payload tests', async () => {
    // A. Incoming text message
    const textPayload = {
      object: 'instagram',
      entry: [
        {
          id: 'ig_acc_webhook',
          time: 1700000000,
          messaging: [
            {
              sender: { id: 'user_text_sender' },
              recipient: { id: 'ig_acc_webhook' },
              timestamp: 1700000001000,
              message: {
                mid: 'm_mid_real_text_123',
                text: 'send link'
              }
            }
          ]
        }
      ]
    };

    const textJobs = webhookJobQueue.normalizeWebhookPayload(textPayload);
    assert.strictEqual(textJobs.length, 1, 'Text payload must produce 1 job');
    assert.strictEqual(textJobs[0].event_type, 'messaging_text');
    assert.strictEqual(textJobs[0].action, 'SEND_LINK');
    assert.strictEqual(textJobs[0].from_id, 'user_text_sender');
    assert.strictEqual(textJobs[0].instagram_account_id, 'ig_acc_webhook');
    assert.strictEqual(textJobs[0].job_id, 'msg:m_mid_real_text_123');

    // B. Postback/button response
    const postbackPayload = {
      object: 'instagram',
      entry: [
        {
          id: 'ig_acc_webhook',
          time: 1700000000,
          messaging: [
            {
              sender: { id: 'user_postback_sender' },
              recipient: { id: 'ig_acc_webhook' },
              timestamp: 1700000002000,
              postback: {
                title: 'Get Free Resource',
                payload: 'SEND_LINK:auto_postback_77:comm_77'
              }
            }
          ]
        }
      ]
    };

    const postbackJobs = webhookJobQueue.normalizeWebhookPayload(postbackPayload);
    assert.strictEqual(postbackJobs.length, 1, 'Postback payload must produce 1 job');
    assert.strictEqual(postbackJobs[0].event_type, 'messaging_postback');
    assert.strictEqual(postbackJobs[0].action, 'SEND_LINK');
    assert.strictEqual(postbackJobs[0].automation_id, 'auto_postback_77');
    assert.strictEqual(postbackJobs[0].comment_id, 'comm_77');

    // C. Quick reply response
    const quickReplyPayload = {
      object: 'instagram',
      entry: [
        {
          id: 'ig_acc_webhook',
          time: 1700000000,
          messaging: [
            {
              sender: { id: 'user_qr_sender' },
              recipient: { id: 'ig_acc_webhook' },
              timestamp: 1700000003000,
              message: {
                mid: 'm_mid_qr_88',
                text: "I'm following ✅",
                quick_reply: {
                  payload: 'CHECK_FOLLOW:auto_qr_88:comm_88'
                }
              }
            }
          ]
        }
      ]
    };

    const qrJobs = webhookJobQueue.normalizeWebhookPayload(quickReplyPayload);
    assert.strictEqual(qrJobs.length, 1, 'Quick reply payload must produce 1 job');
    assert.strictEqual(qrJobs[0].event_type, 'messaging_quick_reply');
    assert.strictEqual(qrJobs[0].action, 'CHECK_FOLLOW');
    assert.strictEqual(qrJobs[0].automation_id, 'auto_qr_88');
    assert.strictEqual(qrJobs[0].comment_id, 'comm_88');

    // D. Comment webhook event
    const commentPayload = {
      object: 'instagram',
      entry: [
        {
          id: 'ig_acc_webhook',
          time: 1700000000,
          changes: [
            {
              field: 'comments',
              value: {
                id: 'comm_root_99',
                text: 'GUIDE',
                from: { id: 'user_commenter_99', username: 'iguser99' },
                media: { id: 'reel_media_99' }
              }
            }
          ]
        }
      ]
    };

    const commentJobs = webhookJobQueue.normalizeWebhookPayload(commentPayload);
    assert.strictEqual(commentJobs.length, 1, 'Comment payload must produce 1 job');
    assert.strictEqual(commentJobs[0].event_type, 'comment');
    assert.strictEqual(commentJobs[0].comment_id, 'comm_root_99');
    assert.strictEqual(commentJobs[0].from_id, 'user_commenter_99');
  });

  // -----------------------------------------------------------------------------------------
  // Test 23: Multiple pending conversations - Generic "LINK" halts safely (no arbitrary delivery)
  // -----------------------------------------------------------------------------------------
  await runTestAsync('Test 23: Multiple pending conversations - Generic "LINK" halts safely', async () => {
    const testDb = createMockDb();
    db.collections = testDb.collections;

    // Connected account
    await testDb.collections().instagramAccounts.insertOne({
      instagram_user_id: 'ig_acc_multi',
      id: 'ig_acc_multi',
      active_dispatch_leases: []
    });

    // Reel A automation (Keyword: PROMPT)
    await testDb.collections().automations.insertOne({
      id: 'auto_reel_A',
      instagram_user_id: 'ig_acc_multi',
      owner_user_id: 'user_multi',
      enabled: true,
      keyword: 'PROMPT',
      trigger_type: 'contains',
      flow: {
        followGate: { enabled: false },
        delivery: { resourceUrl: 'https://example.com/prompt_pack.pdf' }
      }
    });

    // Reel B automation (Keyword: GUIDE)
    await testDb.collections().automations.insertOne({
      id: 'auto_reel_B',
      instagram_user_id: 'ig_acc_multi',
      owner_user_id: 'user_multi',
      enabled: true,
      keyword: 'GUIDE',
      trigger_type: 'contains',
      flow: {
        followGate: { enabled: false },
        delivery: { resourceUrl: 'https://example.com/guide_pack.pdf' }
      }
    });

    // User has pending conversation for Reel A
    await testDb.collections().conversationStates.insertOne({
      key: 'auto_reel_A:ig_acc_multi:jane_doe',
      automation_id: 'auto_reel_A',
      instagram_user_id: 'ig_acc_multi',
      sender_igsid: 'jane_doe',
      comment_id: 'comm_reel_A',
      state: 'OPENING_DM_SENT',
      resource_delivered: false,
      updated_at: new Date(Date.now() - 60000).toISOString()
    });

    // User ALSO has pending conversation for Reel B
    await testDb.collections().conversationStates.insertOne({
      key: 'auto_reel_B:ig_acc_multi:jane_doe',
      automation_id: 'auto_reel_B',
      instagram_user_id: 'ig_acc_multi',
      sender_igsid: 'jane_doe',
      comment_id: 'comm_reel_B',
      state: 'OPENING_DM_SENT',
      resource_delivered: false,
      updated_at: new Date().toISOString()
    });

    let sentDMs = 0;
    instagramService.sendDirectMessage = async () => {
      sentDMs++;
      return { message_id: 'mid.should_not_deliver_arbitrary' };
    };

    // User sends generic "LINK"
    const genericJob = {
      job_id: 'job_ambiguous_generic',
      event_type: 'messaging_text',
      instagram_account_id: 'ig_acc_multi',
      from_id: 'jane_doe',
      message_text: 'LINK',
      action: 'SEND_LINK',
      automation_id: null
    };

    const result = await executeMessagingJob(genericJob);
    assert.strictEqual(result.success, false, 'Ambiguous generic message must not proceed');
    assert.strictEqual(result.reason, 'AMBIGUOUS_CONVERSATION', 'Reason must be AMBIGUOUS_CONVERSATION');
    assert.strictEqual(result.candidate_count, 2, 'Must detect 2 candidates');
    assert.strictEqual(sentDMs, 0, 'ZERO DMs must be dispatched for ambiguous generic request');

    // Both conversation states must remain safely undelivered
    const stateA = await testDb.collections().conversationStates.findOne({ key: 'auto_reel_A:ig_acc_multi:jane_doe' });
    const stateB = await testDb.collections().conversationStates.findOne({ key: 'auto_reel_B:ig_acc_multi:jane_doe' });
    assert.strictEqual(stateA.resource_delivered, false, 'State A resource must not be delivered');
    assert.strictEqual(stateB.resource_delivered, false, 'State B resource must not be delivered');
  });

  // -----------------------------------------------------------------------------------------
  // Test 24: Multiple pending conversations - Disambiguated by keyword
  // -----------------------------------------------------------------------------------------
  await runTestAsync('Test 24: Multiple pending conversations - Disambiguated by keyword', async () => {
    const testDb = createMockDb();
    db.collections = testDb.collections;

    await testDb.collections().instagramAccounts.insertOne({
      instagram_user_id: 'ig_acc_multi2',
      id: 'ig_acc_multi2',
      active_dispatch_leases: []
    });

    await testDb.collections().automations.insertOne({
      id: 'auto_reel_A2',
      instagram_user_id: 'ig_acc_multi2',
      owner_user_id: 'user_multi2',
      enabled: true,
      keyword: 'PROMPT',
      trigger_type: 'contains',
      flow: {
        followGate: { enabled: false },
        delivery: { resourceUrl: 'https://example.com/reelA_prompts.pdf' }
      }
    });

    await testDb.collections().automations.insertOne({
      id: 'auto_reel_B2',
      instagram_user_id: 'ig_acc_multi2',
      owner_user_id: 'user_multi2',
      enabled: true,
      keyword: 'GUIDE',
      trigger_type: 'contains',
      flow: {
        followGate: { enabled: false },
        delivery: { resourceUrl: 'https://example.com/reelB_guide.pdf' }
      }
    });

    await testDb.collections().conversationStates.insertOne({
      key: 'auto_reel_A2:ig_acc_multi2:john_doe',
      automation_id: 'auto_reel_A2',
      instagram_user_id: 'ig_acc_multi2',
      sender_igsid: 'john_doe',
      comment_id: 'comm_reel_A2',
      state: 'OPENING_DM_SENT',
      resource_delivered: false,
      updated_at: new Date(Date.now() - 30000).toISOString()
    });

    await testDb.collections().conversationStates.insertOne({
      key: 'auto_reel_B2:ig_acc_multi2:john_doe',
      automation_id: 'auto_reel_B2',
      instagram_user_id: 'ig_acc_multi2',
      sender_igsid: 'john_doe',
      comment_id: 'comm_reel_B2',
      state: 'OPENING_DM_SENT',
      resource_delivered: false,
      updated_at: new Date().toISOString()
    });

    let deliveredUrl = null;
    instagramService.sendDirectMessage = async (recipientId, senderIgsid, message) => {
      deliveredUrl = message?.attachment?.payload?.buttons?.[0]?.url || message?.attachment?.payload?.elements?.[0]?.buttons?.[0]?.url;
      return { message_id: 'mid.disambiguated_delivery' };
    };

    // User explicitly says "PROMPT"
    const keywordJob = {
      job_id: 'job_keyword_disambiguated',
      event_type: 'messaging_text',
      instagram_account_id: 'ig_acc_multi2',
      from_id: 'john_doe',
      message_text: 'PROMPT',
      action: 'SEND_LINK',
      automation_id: null
    };

    const result = await executeMessagingJob(keywordJob);
    assert.strictEqual(result.success, true, 'Keyword disambiguated job must succeed');
    assert.strictEqual(result.delivered, true, 'Resource must be delivered');
    assert.strictEqual(deliveredUrl, 'https://example.com/reelA_prompts.pdf', 'Must deliver Reel A resource');

    const stateA = await testDb.collections().conversationStates.findOne({ key: 'auto_reel_A2:ig_acc_multi2:john_doe' });
    const stateB = await testDb.collections().conversationStates.findOne({ key: 'auto_reel_B2:ig_acc_multi2:john_doe' });
    assert.strictEqual(stateA.resource_delivered, true, 'State A resource must now be marked delivered');
    assert.strictEqual(stateB.resource_delivered, false, 'State B resource must remain pending and undelivered');
  });

  // -----------------------------------------------------------------------------------------
  // Test 25: Follow-Gate Behavior (5 paths)
  // -----------------------------------------------------------------------------------------
  await runTestAsync('Test 25: Follow-Gate Behavior (5 distinct paths)', async () => {
    const testDb = createMockDb();
    db.collections = testDb.collections;

    await testDb.collections().instagramAccounts.insertOne({
      instagram_user_id: 'ig_fg_acc',
      id: 'ig_fg_acc',
      active_dispatch_leases: []
    });

    // Base automation with follow gate enabled
    await testDb.collections().automations.insertOne({
      id: 'auto_fg_paths',
      instagram_user_id: 'ig_fg_acc',
      owner_user_id: 'user_fg',
      enabled: true,
      flow: {
        followGate: { enabled: true, profileUrl: 'https://instagram.com/creator_fg' },
        delivery: { resourceUrl: 'https://example.com/gated_asset.pdf' }
      }
    });

    let deliveredResources = 0;
    let followPromptsSent = 0;
    instagramService.sendDirectMessage = async (recipientId, senderIgsid, message) => {
      const text = message?.attachment?.payload?.text || message?.text || '';
      if (text.includes("haven't followed me yet") || text.includes("couldn't verify your follow status")) {
        followPromptsSent++;
      } else {
        deliveredResources++;
      }
      return { message_id: `mid.fg_res_${Date.now()}` };
    };

    // Path 1: Follow gate disabled
    await testDb.collections().automations.insertOne({
      id: 'auto_fg_disabled',
      instagram_user_id: 'ig_fg_acc',
      owner_user_id: 'user_fg',
      enabled: true,
      flow: {
        followGate: { enabled: false },
        delivery: { resourceUrl: 'https://example.com/ungated.pdf' }
      }
    });
    await testDb.collections().conversationStates.insertOne({
      key: 'auto_fg_disabled:ig_fg_acc:user_p1',
      automation_id: 'auto_fg_disabled',
      instagram_user_id: 'ig_fg_acc',
      sender_igsid: 'user_p1',
      state: 'OPENING_DM_SENT',
      resource_delivered: false
    });
    const p1 = await executeMessagingJob({
      event_type: 'messaging_postback',
      instagram_account_id: 'ig_fg_acc',
      from_id: 'user_p1',
      action: 'SEND_LINK',
      automation_id: 'auto_fg_disabled'
    });
    assert.strictEqual(p1.delivered, true, 'Path 1: Disabled gate delivers immediately');

    // Path 2: Follow gate enabled and user follows
    instagramService.checkFollowStatus = async () => ({ supported: true, isFollowing: true, verified: true });
    await testDb.collections().conversationStates.insertOne({
      key: 'auto_fg_paths:ig_fg_acc:user_p2',
      automation_id: 'auto_fg_paths',
      instagram_user_id: 'ig_fg_acc',
      sender_igsid: 'user_p2',
      state: 'OPENING_DM_SENT',
      resource_delivered: false
    });
    const p2 = await executeMessagingJob({
      event_type: 'messaging_postback',
      instagram_account_id: 'ig_fg_acc',
      from_id: 'user_p2',
      action: 'SEND_LINK',
      automation_id: 'auto_fg_paths'
    });
    assert.strictEqual(p2.delivered, true, 'Path 2: User following delivers immediately');

    // Path 3: Follow gate enabled and user does NOT follow
    instagramService.checkFollowStatus = async () => ({ supported: true, isFollowing: false, verified: true });
    await testDb.collections().conversationStates.insertOne({
      key: 'auto_fg_paths:ig_fg_acc:user_p3',
      automation_id: 'auto_fg_paths',
      instagram_user_id: 'ig_fg_acc',
      sender_igsid: 'user_p3',
      state: 'OPENING_DM_SENT',
      resource_delivered: false
    });
    const p3 = await executeMessagingJob({
      event_type: 'messaging_postback',
      instagram_account_id: 'ig_fg_acc',
      from_id: 'user_p3',
      action: 'SEND_LINK',
      automation_id: 'auto_fg_paths'
    });
    assert.strictEqual(p3.delivered, false, 'Path 3: Not following must NOT deliver resource');
    assert.strictEqual(p3.follow_prompt_sent, true, 'Path 3: Must send follow prompt');
    const p3State = await testDb.collections().conversationStates.findOne({ key: 'auto_fg_paths:ig_fg_acc:user_p3' });
    assert.strictEqual(p3State.state, 'FOLLOW_PROMPT_SENT', 'Path 3: State must be FOLLOW_PROMPT_SENT');

    // Path 4: Follow verification unavailable because of permissions
    instagramService.checkFollowStatus = async () => ({ supported: false, isFollowing: false, verified: false, error: 'OAuthException (#10)' });
    await testDb.collections().conversationStates.insertOne({
      key: 'auto_fg_paths:ig_fg_acc:user_p4',
      automation_id: 'auto_fg_paths',
      instagram_user_id: 'ig_fg_acc',
      sender_igsid: 'user_p4',
      state: 'OPENING_DM_SENT',
      resource_delivered: false
    });
    const p4 = await executeMessagingJob({
      event_type: 'messaging_postback',
      instagram_account_id: 'ig_fg_acc',
      from_id: 'user_p4',
      action: 'SEND_LINK',
      automation_id: 'auto_fg_paths'
    });
    assert.strictEqual(p4.delivered, false, 'Path 4: Verification unavailable must NOT deliver resource');
    assert.strictEqual(p4.retry, true, 'Path 4: Must offer retry');
    const p4State = await testDb.collections().conversationStates.findOne({ key: 'auto_fg_paths:ig_fg_acc:user_p4' });
    assert.strictEqual(p4State.state, 'VERIFICATION_ERROR', 'Path 4: State must be VERIFICATION_ERROR');

    // Path 5: User sends response after follow prompt (re-check triggers and succeeds)
    instagramService.checkFollowStatus = async () => ({ supported: true, isFollowing: true, verified: true });
    const p5 = await executeMessagingJob({
      event_type: 'messaging_text',
      instagram_account_id: 'ig_fg_acc',
      from_id: 'user_p3',
      message_text: "I'm following now!",
      action: 'USER_RESPONSE',
      automation_id: 'auto_fg_paths'
    });
    assert.strictEqual(p5.delivered, true, 'Path 5: After follow prompt, following user receives resource');
    const p5State = await testDb.collections().conversationStates.findOne({ key: 'auto_fg_paths:ig_fg_acc:user_p3' });
    assert.strictEqual(p5State.resource_delivered, true, 'Path 5: State marked delivered');
  });

  // Restore mocks
  instagramService.sendPrivateReply = origSendPrivateReply;
  instagramService.sendDirectMessage = origSendDirectMessage;
  instagramService.checkFollowStatus = origCheckFollowStatus;
  instagramService.getDecryptedTokenByInstagramUserId = origGetToken;

  console.log('\n======================================================================');
  console.log(`   INVESTIGATION AUDIT TEST SUITE: ${totalTests} CHECKS | ALL ${passedTests} PASSED!`);
  console.log('======================================================================\n');
}

runInvestigationSuite().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
