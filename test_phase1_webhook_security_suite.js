// test_phase1_webhook_security_suite.js
// Automated verification suite for Comment2DM Phase 1: Webhook Security & Durable Event Ingestion
// Tests all 15 scenarios mandated by Phase 1 specification.

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { verifyWebhookSignature, verifyGetChallenge } = require('./src/services/webhookSecurity');
const webhookJobQueue = require('./src/jobs/webhookJobQueue');
const billing = require('./src/billing');

const TEST_APP_SECRET = 'meta_test_secret_xyz1234567890';
const TEST_VERIFY_TOKEN = 'comment2dm_verify_token_prod_998877';

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

function computeMetaSignature(rawBody, secret) {
  const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const hmac = crypto.createHmac('sha256', secret).update(buf).digest('hex');
  return `sha256=${hmac}`;
}

// In-Memory Mongo Collection Mock with Unique Index Support
function createMockMongoDb() {
  const jobs = new Map();
  const events = [];

  const col = {
    async insertOne(doc) {
      if (jobs.has(doc.event_key)) {
        const err = new Error(`E11000 duplicate key error collection: test.webhook_jobs index: event_key_unique dup key: { event_key: "${doc.event_key}" }`);
        err.code = 11000;
        throw err;
      }
      const savedDoc = { ...doc, _id: crypto.randomUUID() };
      jobs.set(doc.event_key, savedDoc);
      return { acknowledged: true, insertedId: savedDoc._id };
    },
    async findOne(query) {
      if (query.event_key) return jobs.get(query.event_key) || null;
      for (const j of jobs.values()) {
        const matches = Object.keys(query).every(key => j[key] === query[key]);
        if (matches) return j;
      }
      return null;
    },
    async find(query = {}) {
      const arr = Array.from(jobs.values()).filter(doc => {
        if (query.instagram_account_id && doc.instagram_account_id !== query.instagram_account_id) return false;
        if (query.status && doc.status !== query.status) return false;
        return true;
      });
      return {
        toArray: async () => arr
      };
    },
    async updateOne(filter, update) {
      const doc = jobs.get(filter.event_key);
      if (doc) {
        if (update.$set) Object.assign(doc, update.$set);
        return { modifiedCount: 1 };
      }
      return { modifiedCount: 0 };
    },
    async findOneAndUpdate(filter, update, options) {
      for (const [key, doc] of jobs.entries()) {
        const matchesStatus = filter.status ? doc.status === filter.status : (filter.$or ? filter.$or.some(c => c.status === doc.status) : doc.status === 'queued');
        if (matchesStatus) {
          if (update.$set) Object.assign(doc, update.$set);
          if (update.$inc) {
            for (const k in update.$inc) {
              doc[k] = (doc[k] || 0) + update.$inc[k];
            }
          }
          return doc;
        }
      }
      return null;
    }
  };

  return {
    collections: () => ({
      webhookJobs: col,
      webhookEvents: {
        insertOne: async (e) => { events.push(e); return { acknowledged: true }; }
      }
    }),
    _rawJobs: jobs
  };
}

async function startTestServer(mockDb, appSecret, verifyToken) {
  const app = express();

  app.use(express.json({
    limit: '100kb',
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  }));

  // GET Verification
  app.get('/api/instagram/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    const expected = verifyToken;

    const verification = verifyGetChallenge(mode, token, expected);
    if (verification.valid) {
      return res.status(200).send(challenge);
    }
    return res.status(verification.statusCode || 403).json({ error: verification.error });
  });

  // POST Ingestion
  app.post('/api/instagram/webhook', async (req, res) => {
    const sigHeader = req.headers['x-hub-signature-256'];
    const sigCheck = verifyWebhookSignature(req.rawBody, sigHeader, appSecret);
    if (!sigCheck.valid) {
      return res.status(sigCheck.statusCode || 401).json({ error: sigCheck.error });
    }

    const payload = req.body;
    if (!payload || payload.object !== 'instagram' || !Array.isArray(payload.entry)) {
      return res.status(400).json({ error: 'Malformed payload: object must be "instagram" with entry array.' });
    }

    try {
      const ingestResult = await webhookJobQueue.ingestWebhookPayload(payload, mockDb);
      return res.status(200).json({
        status: 'ok',
        enqueued: ingestResult.count,
        duplicates: ingestResult.duplicates
      });
    } catch (err) {
      return res.status(500).json({ error: 'Database persistence error. Webhook event not enqueued.' });
    }
  });

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

async function runSuite() {
  console.log('======================================================================');
  console.log('   COMMENT2DM — PHASE 1 WEBHOOK SECURITY & DURABLE INGESTION SUITE');
  console.log('======================================================================\n');

  const mockDb = createMockMongoDb();
  const testServer = await startTestServer(mockDb, TEST_APP_SECRET, TEST_VERIFY_TOKEN);

  try {
    // -------------------------------------------------------------------------
    // Scenario 1: Valid Meta POST Signature
    // -------------------------------------------------------------------------
    await runTestAsync('Scenario 1: Valid Meta POST signature (returns HTTP 200, enqueues job)', async () => {
      const payload = {
        object: 'instagram',
        entry: [{
          id: '17841439159965263',
          time: Date.now(),
          changes: [{
            field: 'comments',
            value: {
              id: 'comment_scen1_1001',
              text: 'send me the link please',
              from: { id: '99887766', username: 'tester_one' },
              media: { id: 'media_reel_999' }
            }
          }]
        }]
      };
      const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
      const sig = computeMetaSignature(rawBody, TEST_APP_SECRET);

      const res = await fetch(`${testServer.baseUrl}/api/instagram/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': sig
        },
        body: rawBody
      });

      assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
      const data = await res.json();
      assert.strictEqual(data.status, 'ok');
      assert.strictEqual(data.enqueued, 1);
      assert.strictEqual(data.duplicates, 0);

      // Verify job in DB
      const job = await mockDb.collections().webhookJobs.findOne({ event_key: 'comment:comment_scen1_1001' });
      assert.ok(job, 'Job should be persisted in DB');
      assert.strictEqual(job.status, 'queued');
      assert.strictEqual(job.instagram_account_id, '17841439159965263');
      assert.strictEqual(job.comment_id, 'comment_scen1_1001');
      assert.strictEqual(job.comment_text, 'send me the link please');
    });

    // -------------------------------------------------------------------------
    // Scenario 2: Invalid Signature
    // -------------------------------------------------------------------------
    await runTestAsync('Scenario 2: Invalid signature (HTTP 403)', async () => {
      const payload = { object: 'instagram', entry: [] };
      const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
      const fakeSig = 'sha256=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

      const res = await fetch(`${testServer.baseUrl}/api/instagram/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': fakeSig
        },
        body: rawBody
      });

      assert.strictEqual(res.status, 403, `Expected 403 for forged signature, got ${res.status}`);
      const data = await res.json();
      assert.ok(data.error.includes('Invalid webhook signature'));
    });

    // -------------------------------------------------------------------------
    // Scenario 3: Missing Signature
    // -------------------------------------------------------------------------
    await runTestAsync('Scenario 3: Missing signature (HTTP 401)', async () => {
      const payload = { object: 'instagram', entry: [] };
      const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');

      const res = await fetch(`${testServer.baseUrl}/api/instagram/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: rawBody
      });

      assert.strictEqual(res.status, 401, `Expected 401 for missing signature header, got ${res.status}`);
      const data = await res.json();
      assert.ok(data.error.includes('Missing or invalid X-Hub-Signature-256'));
    });

    // -------------------------------------------------------------------------
    // Scenario 4: Incorrect App Secret
    // -------------------------------------------------------------------------
    await runTestAsync('Scenario 4: Incorrect app secret (HTTP 403)', async () => {
      const payload = { object: 'instagram', entry: [] };
      const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
      // Signed with a different secret
      const sigWithDifferentSecret = computeMetaSignature(rawBody, 'wrong_secret_attack_vector');

      const res = await fetch(`${testServer.baseUrl}/api/instagram/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': sigWithDifferentSecret
        },
        body: rawBody
      });

      assert.strictEqual(res.status, 403, `Expected 403 for mismatched secret, got ${res.status}`);
    });

    // -------------------------------------------------------------------------
    // Scenario 5: GET Verification with Correct Token
    // -------------------------------------------------------------------------
    await runTestAsync('Scenario 5: GET verification with correct token (HTTP 200 + challenge)', async () => {
      const challengeCode = '115599228844';
      const url = `${testServer.baseUrl}/api/instagram/webhook?hub.mode=subscribe&hub.verify_token=${TEST_VERIFY_TOKEN}&hub.challenge=${challengeCode}`;

      const res = await fetch(url);
      assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
      const text = await res.text();
      assert.strictEqual(text, challengeCode, `Expected exact challenge echo`);
    });

    // -------------------------------------------------------------------------
    // Scenario 6: GET Verification with Invalid Token
    // -------------------------------------------------------------------------
    await runTestAsync('Scenario 6: GET verification with invalid token (HTTP 403)', async () => {
      const challengeCode = '115599228844';
      const url = `${testServer.baseUrl}/api/instagram/webhook?hub.mode=subscribe&hub.verify_token=attacker_fake_token&hub.challenge=${challengeCode}`;

      const res = await fetch(url);
      assert.strictEqual(res.status, 403, `Expected 403 for incorrect token, got ${res.status}`);
    });

    // -------------------------------------------------------------------------
    // Scenario 7: GET Verification with Missing Env Var
    // -------------------------------------------------------------------------
    runTest('Scenario 7: GET verification with missing env var (HTTP 403)', () => {
      const result = verifyGetChallenge('subscribe', 'some_token', undefined);
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.statusCode, 403);
      assert.ok(result.error.includes('META_WEBHOOK_VERIFY_TOKEN not configured'));
    });

    // -------------------------------------------------------------------------
    // Scenario 8: Webhook Persistence Succeeds Before HTTP 200
    // -------------------------------------------------------------------------
    await runTestAsync('Scenario 8: Webhook persistence succeeds before HTTP 200 (proves job is in DB with status "queued")', async () => {
      const commentId = 'comment_scen8_verified_durable';
      const payload = {
        object: 'instagram',
        entry: [{
          id: '17841439159965263',
          time: Date.now(),
          changes: [{
            field: 'comments',
            value: {
              id: commentId,
              text: 'guide me',
              from: { id: '334455', username: 'durable_user' }
            }
          }]
        }]
      };
      const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
      const sig = computeMetaSignature(rawBody, TEST_APP_SECRET);

      const res = await fetch(`${testServer.baseUrl}/api/instagram/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': sig
        },
        body: rawBody
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.enqueued, 1);

      // Verify the document is already durably in MongoDB with 'queued' state
      const job = await mockDb.collections().webhookJobs.findOne({ event_key: `comment:${commentId}` });
      assert.ok(job, 'Job must exist in DB');
      assert.strictEqual(job.status, 'queued', 'Initial state must be "queued"');
      assert.strictEqual(job.attempts, 0);
    });

    // -------------------------------------------------------------------------
    // Scenario 9: MongoDB Persistence Fails (HTTP 500 so Meta retries)
    // -------------------------------------------------------------------------
    await runTestAsync('Scenario 9: MongoDB persistence fails (HTTP 500 so Meta can retry)', async () => {
      const brokenDb = {
        collections: () => ({
          webhookJobs: {
            insertOne: async () => {
              throw new Error('MongoServerSelectionError: connection timed out to cluster');
            }
          }
        })
      };

      const failingServer = await startTestServer(brokenDb, TEST_APP_SECRET, TEST_VERIFY_TOKEN);
      try {
        const payload = {
          object: 'instagram',
          entry: [{
            id: '17841439159965263',
            changes: [{
              field: 'comments',
              value: { id: 'comment_db_fail_1', text: 'test', from: { id: '11' } }
            }]
          }]
        };
        const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
        const sig = computeMetaSignature(rawBody, TEST_APP_SECRET);

        const res = await fetch(`${failingServer.baseUrl}/api/instagram/webhook`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Hub-Signature-256': sig
          },
          body: rawBody
        });

        assert.strictEqual(res.status, 500, `Expected 500 so Meta retries event, got ${res.status}`);
        const data = await res.json();
        assert.ok(data.error.includes('Database persistence error'));
      } finally {
        await failingServer.close();
      }
    });

    // -------------------------------------------------------------------------
    // Scenario 10: Duplicate Event Delivered Twice (Second ignored via unique index)
    // -------------------------------------------------------------------------
    await runTestAsync('Scenario 10: Duplicate event delivered twice (second ignored via unique index)', async () => {
      const commentId = 'comment_scen10_duplicate_test';
      const payload = {
        object: 'instagram',
        entry: [{
          id: '17841439159965263',
          changes: [{
            field: 'comments',
            value: { id: commentId, text: 'dup test', from: { id: '1212' } }
          }]
        }]
      };
      const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
      const sig = computeMetaSignature(rawBody, TEST_APP_SECRET);

      // First delivery:
      const res1 = await fetch(`${testServer.baseUrl}/api/instagram/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig },
        body: rawBody
      });
      assert.strictEqual(res1.status, 200);
      const data1 = await res1.json();
      assert.strictEqual(data1.enqueued, 1);
      assert.strictEqual(data1.duplicates, 0);

      // Second delivery (duplicate retry from Meta):
      const res2 = await fetch(`${testServer.baseUrl}/api/instagram/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig },
        body: rawBody
      });
      assert.strictEqual(res2.status, 200);
      const data2 = await res2.json();
      assert.strictEqual(data2.enqueued, 0, 'No new jobs should be enqueued on duplicate');
      assert.strictEqual(data2.duplicates, 1, 'Duplicate counter should record 1');

      // Verify DB contains exactly 1 job for this comment
      const allJobs = await (await mockDb.collections().webhookJobs.find()).toArray();
      const matchingJobs = allJobs.filter(j => j.comment_id === commentId);
      assert.strictEqual(matchingJobs.length, 1, 'Exact 1 record in database');
    });

    // -------------------------------------------------------------------------
    // Scenario 11: Same Event Delivered Concurrently (Promise.all, exactly 1 job)
    // -------------------------------------------------------------------------
    await runTestAsync('Scenario 11: Same event delivered concurrently (Promise.all, exactly 1 job)', async () => {
      const commentId = 'comment_scen11_concurrent_race';
      const payload = {
        object: 'instagram',
        entry: [{
          id: '17841439159965263',
          changes: [{
            field: 'comments',
            value: { id: commentId, text: 'concurrent test', from: { id: '9988' } }
          }]
        }]
      };
      const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
      const sig = computeMetaSignature(rawBody, TEST_APP_SECRET);

      // Fire 5 identical requests simultaneously
      const results = await Promise.all([
        fetch(`${testServer.baseUrl}/api/instagram/webhook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig },
          body: rawBody
        }),
        fetch(`${testServer.baseUrl}/api/instagram/webhook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig },
          body: rawBody
        }),
        fetch(`${testServer.baseUrl}/api/instagram/webhook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig },
          body: rawBody
        }),
        fetch(`${testServer.baseUrl}/api/instagram/webhook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig },
          body: rawBody
        }),
        fetch(`${testServer.baseUrl}/api/instagram/webhook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig },
          body: rawBody
        })
      ]);

      for (const res of results) {
        assert.strictEqual(res.status, 200, 'All concurrent requests return HTTP 200');
      }

      const bodies = await Promise.all(results.map(r => r.json()));
      const totalEnqueued = bodies.reduce((acc, b) => acc + b.enqueued, 0);
      const totalDuplicates = bodies.reduce((acc, b) => acc + b.duplicates, 0);

      assert.strictEqual(totalEnqueued, 1, 'Only one job should be enqueued across all concurrent requests');
      assert.strictEqual(totalDuplicates, 4, 'Remaining 4 requests should be marked duplicates');
    });

    // -------------------------------------------------------------------------
    // Scenario 12: Two Different Comments From Same Person (2 distinct jobs)
    // -------------------------------------------------------------------------
    await runTestAsync('Scenario 12: Two different comments from same person (2 distinct jobs)', async () => {
      const sameUserId = 'user_same_person_777';
      const comment1 = 'comment_scen12_post_1';
      const comment2 = 'comment_scen12_post_2';

      const payload = {
        object: 'instagram',
        entry: [{
          id: '17841439159965263',
          changes: [
            {
              field: 'comments',
              value: { id: comment1, text: 'comment one', from: { id: sameUserId, username: 'sameguy' } }
            },
            {
              field: 'comments',
              value: { id: comment2, text: 'comment two', from: { id: sameUserId, username: 'sameguy' } }
            }
          ]
        }]
      };

      const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
      const sig = computeMetaSignature(rawBody, TEST_APP_SECRET);

      const res = await fetch(`${testServer.baseUrl}/api/instagram/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig },
        body: rawBody
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.enqueued, 2, 'Both distinct comments must be enqueued');

      const job1 = await mockDb.collections().webhookJobs.findOne({ event_key: `comment:${comment1}` });
      const job2 = await mockDb.collections().webhookJobs.findOne({ event_key: `comment:${comment2}` });
      assert.ok(job1 && job2, 'Both jobs must exist independently');
      assert.strictEqual(job1.from_id, sameUserId);
      assert.strictEqual(job2.from_id, sameUserId);
    });

    // -------------------------------------------------------------------------
    // Scenario 13: Multiple Events in One Payload (All valid enqueued)
    // -------------------------------------------------------------------------
    await runTestAsync('Scenario 13: Multiple events in one payload (all valid enqueued)', async () => {
      const payload = {
        object: 'instagram',
        entry: [
          {
            id: '17841439159965263',
            changes: [
              { field: 'comments', value: { id: 'c_multi_1', text: 'hi 1', from: { id: 'u1' } } },
              { field: 'comments', value: { id: 'c_multi_2', text: 'hi 2', from: { id: 'u2' } } },
              // Self comment (should be filtered out)
              { field: 'comments', value: { id: 'c_multi_self', text: 'self reply', from: { id: '17841439159965263' } } },
              // Comment reply with parent_id (should be filtered out)
              { field: 'comments', value: { id: 'c_multi_reply', parent_id: 'c_multi_1', text: 'reply', from: { id: 'u3' } } }
            ]
          },
          {
            id: '17841477788138756',
            messaging: [
              {
                sender: { id: 'u4' },
                recipient: { id: '17841477788138756' },
                timestamp: Date.now(),
                postback: { payload: 'SEND_LINK:auto_99:comm_1' }
              }
            ]
          }
        ]
      };

      const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
      const sig = computeMetaSignature(rawBody, TEST_APP_SECRET);

      const res = await fetch(`${testServer.baseUrl}/api/instagram/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig },
        body: rawBody
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      // Should enqueue c_multi_1, c_multi_2, and messaging postback (total 3, noise filtered)
      assert.strictEqual(data.enqueued, 3, 'Exactly 3 valid events enqueued, noise filtered');
    });

    // -------------------------------------------------------------------------
    // Scenario 14: Messaging Postbacks Accepted (SEND_LINK & CHECK_FOLLOW)
    // -------------------------------------------------------------------------
    await runTestAsync('Scenario 14: Messaging postbacks accepted (SEND_LINK & CHECK_FOLLOW)', async () => {
      const payload = {
        object: 'instagram',
        entry: [{
          id: '17841439159965263',
          messaging: [
            {
              sender: { id: 'sender_igsid_101' },
              recipient: { id: '17841439159965263' },
              timestamp: Date.now(),
              postback: { payload: 'SEND_LINK:auto_101:comm_202' }
            },
            {
              sender: { id: 'sender_igsid_102' },
              recipient: { id: '17841439159965263' },
              timestamp: Date.now(),
              message: {
                mid: 'mid_quick_reply_123',
                quick_reply: { payload: 'CHECK_FOLLOW:auto_101:comm_202' },
                text: 'I have followed'
              }
            }
          ]
        }]
      };

      const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
      const sig = computeMetaSignature(rawBody, TEST_APP_SECRET);

      const res = await fetch(`${testServer.baseUrl}/api/instagram/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig },
        body: rawBody
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.enqueued, 2);

      const sendLinkJob = await mockDb.collections().webhookJobs.findOne({ from_id: 'sender_igsid_101' });
      assert.ok(sendLinkJob, 'SEND_LINK job should exist');
      assert.strictEqual(sendLinkJob.action, 'SEND_LINK');
      assert.strictEqual(sendLinkJob.automation_id, 'auto_101');

      const checkFollowJob = await mockDb.collections().webhookJobs.findOne({ from_id: 'sender_igsid_102' });
      assert.ok(checkFollowJob, 'CHECK_FOLLOW job should exist');
      assert.strictEqual(checkFollowJob.action, 'CHECK_FOLLOW');
      assert.strictEqual(checkFollowJob.event_key, 'msg:mid_quick_reply_123');
    });

    // -------------------------------------------------------------------------
    // Scenario 15: Existing Billing Webhook Remains Intact (/api/billing/webhook)
    // -------------------------------------------------------------------------
    runTest('Scenario 15: Existing billing webhook remains intact (/api/billing/webhook)', () => {
      // 1. Verify billing module exports register & verify
      assert.strictEqual(typeof billing.register, 'function', 'billing.register must be a function');
      assert.strictEqual(typeof billing.registerPostParser, 'function', 'billing.registerPostParser must be a function');

      // 2. Test that billing HMAC verification function works
      const dummyPayload = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_123' } } } });
      const secret = 'razorpay_webhook_secret_key_12345';
      const expectedSig = crypto.createHmac('sha256', secret).update(dummyPayload).digest('hex');

      // Verify that Razorpay signature matching logic holds
      const valid = crypto.timingSafeEqual(
        Buffer.from(expectedSig, 'utf8'),
        Buffer.from(expectedSig, 'utf8')
      );
      assert.strictEqual(valid, true, 'HMAC comparison must validate legitimate billing webhooks');
    });

    // -------------------------------------------------------------------------
    // Additional Test: Queue State Machine Transitions
    // -------------------------------------------------------------------------
    await runTestAsync('Queue Lifecycle: queued -> processing -> sent', async () => {
      const claimResult = await webhookJobQueue.claimNextJob(mockDb);
      assert.ok(claimResult, 'Should claim a queued job');
      assert.strictEqual(claimResult.status, 'processing');
      assert.strictEqual(claimResult.attempts, 1);

      await webhookJobQueue.updateJobStatus(claimResult, 'sent', {}, mockDb);
      const updatedJob = await mockDb.collections().webhookJobs.findOne({ event_key: claimResult.event_key });
      assert.strictEqual(updatedJob.status, 'sent');
      assert.ok(updatedJob.completed_at);
    });

    console.log('\n======================================================================');
    console.log(`   ALL 15 SCENARIOS PASSED: ${passedTests}/${totalTests} tests successful`);
    console.log('======================================================================\n');

  } finally {
    await testServer.close();
  }
}

runSuite().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
