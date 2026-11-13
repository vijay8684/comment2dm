// test_settings_department_suite.js
// Complete automated test suite for Comment2DM Settings Module
// Covers: Profile, Security, Notifications, Billing, and Danger Zone

const assert = require('assert');
const http = require('http');
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

// Ensure test environment
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test_jwt_secret_comment2dm_settings_suite_32chars!';

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
  if (update.$pull) {
    for (const [k, v] of Object.entries(update.$pull)) {
      if (Array.isArray(doc[k])) {
        doc[k] = doc[k].filter(item => !matchesQuery(item, v));
      }
    }
  }
}

function createMockCollection() {
  const items = [];
  return {
    _items: items,
    find(query = {}, projection = {}) {
      return {
        sort() { return this; },
        limit() { return this; },
        async toArray() {
          return items.filter(doc => matchesQuery(doc, query));
        }
      };
    },
    async findOne(query = {}, options = {}) {
      return items.find(doc => matchesQuery(doc, query)) || null;
    },
    async findOneAndUpdate(filter, update, options = {}) {
      let doc = items.find(d => matchesQuery(d, filter));
      if (!doc && options.upsert) {
        doc = {};
        for (const [k, v] of Object.entries(filter)) {
          if (!k.startsWith('$') && (typeof v !== 'object' || v === null || v instanceof Date)) {
            doc[k] = v;
          }
        }
        items.push(doc);
      }
      if (!doc) return null;
      applyMongoUpdate(doc, update);
      return { value: doc, ...doc };
    },
    async insertOne(doc) {
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
    async updateMany(filter, update, options = {}) {
      let matchedCount = 0;
      let modifiedCount = 0;
      for (const doc of items) {
        if (matchesQuery(doc, filter)) {
          matchedCount++;
          applyMongoUpdate(doc, update);
          modifiedCount++;
        }
      }
      return { matchedCount, modifiedCount };
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
    async createIndex() { return 'mock_index'; }
  };
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
    if (key.includes('.')) {
      const parts = key.split('.');
      let current = doc;
      for (let i = 0; i < parts.length - 1; i++) {
        current = current?.[parts[i]];
      }
      const lastKey = parts[parts.length - 1];
      if (Array.isArray(current)) {
        const anyMatch = current.some(item => matchesQuery(item, { [lastKey]: val }));
        if (!anyMatch) return false;
        continue;
      }
      if (!matchesQuery(current, { [lastKey]: val })) return false;
      continue;
    }
    if (val && typeof val === 'object' && val.$elemMatch) {
      if (!Array.isArray(doc[key])) return false;
      const anyMatch = doc[key].some(item => matchesQuery(item, val.$elemMatch));
      if (!anyMatch) return false;
      continue;
    }
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      if (val instanceof Date) {
        const dVal = toCompareVal(doc[key]);
        if (dVal !== val.getTime()) return false;
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

// Set up mock DB collections
const mockCollections = {
  users: createMockCollection(),
  instagram_accounts: createMockCollection(),
  automations: createMockCollection(),
  automation_events: createMockCollection(),
  sessions: createMockCollection(),
  rate_limits: createMockCollection(),
  subscriptions: createMockCollection(),
  conversation_states: createMockCollection(),
  webhook_jobs: createMockCollection(),
  opening_dm_claims: createMockCollection(),
  ai_credit_usage: createMockCollection(),
  feedback: createMockCollection(),
  otps: createMockCollection()
};

mockCollections.instagramAccounts = mockCollections.instagram_accounts;
mockCollections.automationEvents = mockCollections.automation_events;
mockCollections.rateLimits = mockCollections.rate_limits;
mockCollections.conversationStates = mockCollections.conversation_states;
mockCollections.webhookJobs = mockCollections.webhook_jobs;
mockCollections.openingDmClaims = mockCollections.opening_dm_claims;
mockCollections.aiCreditUsage = mockCollections.ai_credit_usage;

db._setDatabaseForTesting({
  collection(name) {
    if (!mockCollections[name]) mockCollections[name] = createMockCollection();
    return mockCollections[name];
  }
});
billing._setDbForTesting({
  collection(name) {
    if (!mockCollections[name]) mockCollections[name] = createMockCollection();
    return mockCollections[name];
  }
});

// Import server app after mock DB setup
// We spin up a test instance
let server;
let baseUrl;

function makeRequest(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const reqHeaders = { ...headers };
    let reqBody = null;
    if (body !== null) {
      reqHeaders['Content-Type'] = 'application/json';
      reqBody = JSON.stringify(body);
      reqHeaders['Content-Length'] = Buffer.byteLength(reqBody);
    }
    const req = http.request(url, { method, headers: reqHeaders }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: json || data });
      });
    });
    req.on('error', reject);
    if (reqBody) req.write(reqBody);
    req.end();
  });
}

async function runTestSuite() {
  console.log('======================================================================');
  console.log('   COMMENT2DM — SETTINGS MODULE COMPREHENSIVE TEST SUITE');
  console.log('======================================================================\n');

  // Start express server
  const { app: testApp } = require('./server');
  await new Promise(resolve => {
    server = testApp.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  const results = [];
  function test(name, passed, details = '') {
    results.push({ name, passed, details });
    const mark = passed ? '✅ PASS' : '❌ FAIL';
    console.log(`${mark}: ${name} ${details ? '(' + details + ')' : ''}`);
    if (!passed) {
      throw new Error(`Test failed: ${name} - ${details}`);
    }
  }

  try {
    // -------------------------------------------------------------------
    // PREPARATION: Create Test Users
    // -------------------------------------------------------------------
    const userPasswordHash = await bcrypt.hash('SecretPass123!', 10);
    const testUserId = 'user_settings_test_1';
    await mockCollections.users.insertOne({
      id: testUserId,
      name: 'Mysterio Legend',
      email: 'mysterio@comment2dm.com',
      password_hash: userPasswordHash,
      phone: '+1 555 0199',
      bio: 'Automating DMs for creators',
      avatar_url: '',
      email_verified: true,
      created_at: new Date().toISOString()
    });

    // Create session token for User 1
    const testSessionToken = await authService.createSession(testUserId, new Date(Date.now() + 86400000));
    const authHeaders = { Authorization: `Bearer ${testSessionToken}` };

    // Create OAuth User (no password_hash)
    const oauthUserId = 'user_settings_oauth_2';
    await mockCollections.users.insertOne({
      id: oauthUserId,
      name: 'Google Creator',
      email: 'google_user@gmail.com',
      password_hash: null,
      email_verified: true,
      created_at: new Date().toISOString()
    });
    const oauthSessionToken = await authService.createSession(oauthUserId, new Date(Date.now() + 86400000));
    const oauthAuthHeaders = { Authorization: `Bearer ${oauthSessionToken}` };

    // -------------------------------------------------------------------
    // 1. PROFILE TESTS
    // -------------------------------------------------------------------
    console.log('\n--- 1. PROFILE SETTINGS TESTS ---');

    // Test 1.1: GET /api/settings requires auth
    const unauthSettings = await makeRequest('GET', '/api/settings');
    test('GET /api/settings requires auth', unauthSettings.status === 401, 'HTTP 401');

    // Test 1.2: GET /api/settings returns user profile data
    const getSettings = await makeRequest('GET', '/api/settings', null, authHeaders);
    test('GET /api/settings returns 200 with full user data', getSettings.status === 200 &&
      getSettings.body.user.name === 'Mysterio Legend' &&
      getSettings.body.user.email === 'mysterio@comment2dm.com' &&
      getSettings.body.user.phone === '+1 555 0199' &&
      getSettings.body.user.bio === 'Automating DMs for creators' &&
      getSettings.body.user.hasPassword === true &&
      getSettings.body.user.isOAuth === false,
      'Loaded name, email, phone, bio, hasPassword'
    );

    // Test 1.3: GET /api/auth/me legacy alias works
    const getAuthMe = await makeRequest('GET', '/api/auth/me', null, authHeaders);
    test('GET /api/auth/me legacy alias returns user profile', getAuthMe.status === 200 && getAuthMe.body.user.name === 'Mysterio Legend');

    // Test 1.4: PATCH /api/settings/profile updates Name, Phone, and Bio
    const patchRes = await makeRequest('PATCH', '/api/settings/profile', {
      name: 'Mysterio Updated',
      phone: '+91 9876543210',
      bio: 'New bio description under 160 characters.'
    }, authHeaders);
    test('PATCH /api/settings/profile persists name, phone, and bio', patchRes.status === 200 &&
      patchRes.body.user.name === 'Mysterio Updated' &&
      patchRes.body.user.phone === '+91 9876543210' &&
      patchRes.body.user.bio === 'New bio description under 160 characters.',
      'Updated successfully'
    );

    // Verify persistence in DB and reload via GET
    const verifyGet = await makeRequest('GET', '/api/settings', null, authHeaders);
    test('Profile updates persist after reload', verifyGet.body.user.bio === 'New bio description under 160 characters.' &&
      verifyGet.body.user.name === 'Mysterio Updated');

    // Test 1.5: Reject invalid name
    const badName = await makeRequest('PATCH', '/api/settings/profile', { name: 'A' }, authHeaders);
    test('Reject name shorter than 2 characters', badName.status === 400);

    // Test 1.6: Reject bio > 160 chars
    const longBio = 'x'.repeat(161);
    const badBio = await makeRequest('PATCH', '/api/settings/profile', { bio: longBio }, authHeaders);
    test('Reject bio exceeding 160 characters', badBio.status === 400);

    // Test 1.7: Reject SVG or non-image avatar data URL
    const svgAvatar = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=';
    const badAvatar = await makeRequest('PATCH', '/api/settings/profile', { avatarUrl: svgAvatar }, authHeaders);
    test('Reject SVG avatar (only JPEG, PNG, WebP allowed)', badAvatar.status === 400);

    // Test 1.8: Reject avatar > 40KB
    const oversizedAvatar = 'data:image/jpeg;base64,' + 'A'.repeat(65000);
    const oversizedRes = await makeRequest('PATCH', '/api/settings/profile', { avatarUrl: oversizedAvatar }, authHeaders);
    test('Reject avatar exceeding 40 KB limit', oversizedRes.status === 400);

    // Test 1.9: Accept valid compressed avatar data URL and persist it
    const validAvatar = 'data:image/jpeg;base64,' + Buffer.from('test-jpeg-content').toString('base64');
    const goodAvatar = await makeRequest('PATCH', '/api/settings/profile', { avatarUrl: validAvatar }, authHeaders);
    test('Accept valid JPEG avatar data URL', goodAvatar.status === 200 && goodAvatar.body.user.avatarUrl === validAvatar);

    // Verify avatar persisted in DB
    const userInDb = await mockCollections.users.findOne({ id: testUserId });
    test('Avatar persisted in MongoDB document', userInDb.avatar_url === validAvatar);

    // -------------------------------------------------------------------
    // 2. SECURITY TESTS
    // -------------------------------------------------------------------
    console.log('\n--- 2. SECURITY SETTINGS TESTS ---');

    // Test 2.1: POST /api/settings/password requires auth
    const unauthPw = await makeRequest('POST', '/api/settings/password', { currentPassword: 'a', newPassword: 'b' });
    test('Password update requires auth', unauthPw.status === 401);

    // Test 2.2: Reject new password < 8 characters
    const shortPw = await makeRequest('POST', '/api/settings/password', {
      currentPassword: 'SecretPass123!',
      newPassword: 'short'
    }, authHeaders);
    test('Reject password under 8 characters', shortPw.status === 400 && shortPw.body.error.includes('at least 8 characters'));

    // Test 2.3: Reject wrong current password
    const wrongCurrent = await makeRequest('POST', '/api/settings/password', {
      currentPassword: 'WrongPassword999!',
      newPassword: 'BrandNewPass123!'
    }, authHeaders);
    test('Reject incorrect current password', wrongCurrent.status === 401 && wrongCurrent.body.error.includes('Current password is incorrect'));

    // Test 2.4: Reject password change for OAuth account
    const oauthPw = await makeRequest('POST', '/api/settings/password', {
      currentPassword: 'AnyPassword!',
      newPassword: 'BrandNewPass123!'
    }, oauthAuthHeaders);
    test('Reject password change for OAuth account', oauthPw.status === 400 && oauthPw.body.error.includes('OAuth accounts'));

    // Test 2.5: Successfully change password and invalidate OTHER sessions
    // Create second session token representing another device
    const secondSessionToken = await authService.createSession(testUserId, new Date(Date.now() + 86400000));
    test('Second session exists prior to password change', (await authService.getSessionUser(secondSessionToken)) !== null);

    const successfulPwChange = await makeRequest('POST', '/api/settings/password', {
      currentPassword: 'SecretPass123!',
      newPassword: 'BrandNewPass123!'
    }, authHeaders);
    test('Successfully update password', successfulPwChange.status === 200 && successfulPwChange.body.success === true);

    // Current session must remain valid
    const currentSessionUser = await authService.getSessionUser(testSessionToken);
    test('Current session remains active after password change', currentSessionUser !== null);

    // Other session must be invalidated
    const otherSessionUser = await authService.getSessionUser(secondSessionToken);
    test('Other sessions are invalidated on password change', otherSessionUser === null);

    // Verify new password works and old password fails
    const reloadedUser = await mockCollections.users.findOne({ id: testUserId });
    const matchesNew = await bcrypt.compare('BrandNewPass123!', reloadedUser.password_hash);
    const matchesOld = await bcrypt.compare('SecretPass123!', reloadedUser.password_hash);
    test('New password hash verified; old password invalid', matchesNew === true && matchesOld === false);

    // Test 2.6: Enforce Rate Limiter on POST /api/settings/password (max 5 per 15 min)
    let rateLimitHit = false;
    for (let i = 0; i < 6; i++) {
      const rlRes = await makeRequest('POST', '/api/settings/password', {
        currentPassword: 'BrandNewPass123!',
        newPassword: 'AnotherPassword999!'
      }, authHeaders);
      if (rlRes.status === 429) {
        rateLimitHit = true;
        break;
      }
    }
    test('Enforce rate limit (HTTP 429) after excessive password update attempts', rateLimitHit === true);

    // Test 2.7: Concurrent rate-limiter requests against same key enforce strict limit
    const concurrentKey = `concurrent:test:${Date.now()}`;
    const concurrentResults = await Promise.all(
      Array.from({ length: 10 }).map(() => db.consumeRateLimit(concurrentKey, 60000, 5))
    );
    const passCount = concurrentResults.filter(Boolean).length;
    const blockCount = concurrentResults.filter(r => !r).length;
    test('Atomic rate limiter handles 10 concurrent requests: exactly 5 succeed and 5 block',
      passCount === 5 && blockCount === 5,
      `Passed: ${passCount}, Blocked: ${blockCount}`
    );

    // Test 2.8: Different users/keys do not incorrectly share one rate limit
    const differentUserKey = `concurrent:test:other_user:${Date.now()}`;
    const diffUserResult = await db.consumeRateLimit(differentUserKey, 60000, 5);
    test('Different rate limit keys do not share limits', diffUserResult === true);

    // Test 2.9: Window expiration properly resets rate limit counter
    const expiringKey = `expiring:test:${Date.now()}`;
    await db.consumeRateLimit(expiringKey, 10, 1); // Max 1, window 10ms
    const immediateBlocked = await db.consumeRateLimit(expiringKey, 10, 1);
    test('Immediate second request is blocked at limit', immediateBlocked === false);
    // Artificially expire the record
    await mockCollections.rateLimits.updateOne(
      { key: expiringKey },
      { $set: { expires_at: new Date(Date.now() - 5000) } }
    );
    const afterExpiryAllowed = await db.consumeRateLimit(expiringKey, 10, 1);
    test('Expired rate limit window resets and allows new requests', afterExpiryAllowed === true);

    // -------------------------------------------------------------------
    // 3. NOTIFICATION PREFERENCES TESTS
    // -------------------------------------------------------------------
    console.log('\n--- 3. NOTIFICATION PREFERENCES TESTS ---');

    // Test 3.1: PATCH /api/settings/notifications saves preferences to MongoDB
    const saveNotif = await makeRequest('PATCH', '/api/settings/notifications', {
      dm_sent: true,
      failed: false,
      weekly: true,
      billing: false
    }, authHeaders);
    test('Save notification preferences', saveNotif.status === 200 && saveNotif.body.success === true);

    // Test 3.2: Verify GET /api/settings returns the persisted preferences
    const getNotif = await makeRequest('GET', '/api/settings', null, authHeaders);
    test('GET /api/settings returns persisted notification preferences',
      getNotif.body.preferences.dm_sent === true &&
      getNotif.body.preferences.failed === false &&
      getNotif.body.preferences.weekly === true &&
      getNotif.body.preferences.billing === false
    );

    // -------------------------------------------------------------------
    // 4. BILLING DATA CONSISTENCY TESTS
    // -------------------------------------------------------------------
    console.log('\n--- 4. BILLING DATA CONSISTENCY TESTS ---');

    // Test 4.1: GET /api/billing/status returns correct schema with Bearer token
    const billStatus = await makeRequest('GET', '/api/billing/status', null, authHeaders);
    test('GET /api/billing/status returns valid plan, limits, and usage structure with Bearer token',
      billStatus.status === 200 &&
      typeof billStatus.body.plan === 'string' &&
      billStatus.body.limits &&
      billStatus.body.usage &&
      typeof billStatus.body.usage.dmMonthly === 'number'
    );

    // Test 4.2: GET /api/billing/status succeeds with comment2dm_session cookie (without Authorization header)
    const billCookieStatus = await makeRequest('GET', '/api/billing/status', null, {
      Cookie: `comment2dm_session=${testSessionToken}`
    });
    test('GET /api/billing/status authenticates with comment2dm_session cookie',
      billCookieStatus.status === 200 &&
      typeof billCookieStatus.body.plan === 'string'
    );

    // Test 4.3: GET /api/billing/status succeeds with nudge_session cookie
    const billNudgeCookieStatus = await makeRequest('GET', '/api/billing/status', null, {
      Cookie: `nudge_session=${testSessionToken}`
    });
    test('GET /api/billing/status authenticates with nudge_session cookie',
      billNudgeCookieStatus.status === 200 &&
      typeof billNudgeCookieStatus.body.plan === 'string'
    );

    // Test 4.4: POST /api/billing/cancel with missing provider config returns HTTP 503
    billing._setRazorpayForTesting(null);
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
    await mockCollections.subscriptions.deleteMany({ user_id: testUserId });
    await mockCollections.subscriptions.insertOne({
      _id: 'sub_rz_test_1',
      user_id: testUserId,
      plan: 'pro',
      status: 'active',
      razorpay_subscription_id: 'sub_mock_rz_1'
    });
    const missingRzCancel = await makeRequest('POST', '/api/billing/cancel', {}, authHeaders);
    test('POST /api/billing/cancel returns HTTP 503 when provider credentials missing',
      missingRzCancel.status === 503 && missingRzCancel.body.error.includes('unavailable')
    );

    // Test 4.5: POST /api/billing/cancel handles provider error/rejection without marking cancelled
    const mockRzReject = {
      subscriptions: {
        async cancel() {
          throw new Error('Razorpay gateway timeout: 504 Gateway Timeout');
        }
      }
    };
    billing._setRazorpayForTesting(mockRzReject);
    const rejectCancel = await makeRequest('POST', '/api/billing/cancel', {}, authHeaders);
    test('POST /api/billing/cancel returns HTTP 502 on provider rejection',
      rejectCancel.status === 502 && rejectCancel.body.error.includes('Unable to cancel subscription with payment provider')
    );
    const subAfterReject = await mockCollections.subscriptions.findOne({ _id: 'sub_rz_test_1' });
    test('Subscription status remains active in local DB after provider rejection',
      subAfterReject.status === 'active'
    );

    // Test 4.6: POST /api/billing/cancel handles unconfirmed provider status
    const mockRzUnconfirmed = {
      subscriptions: {
        async cancel() {
          return { id: 'sub_mock_rz_1', status: 'pending' };
        }
      }
    };
    billing._setRazorpayForTesting(mockRzUnconfirmed);
    const unconfirmedCancel = await makeRequest('POST', '/api/billing/cancel', {}, authHeaders);
    test('POST /api/billing/cancel returns HTTP 502 on unconfirmed provider status',
      unconfirmedCancel.status === 502 && unconfirmedCancel.body.error.includes('did not confirm')
    );

    // Test 4.7: POST /api/billing/cancel handles local DB update failure
    const mockRzSuccess = {
      subscriptions: {
        async cancel() {
          return { id: 'sub_mock_rz_1', status: 'cancelled' };
        }
      }
    };
    billing._setRazorpayForTesting(mockRzSuccess);
    const originalSubUpdate = mockCollections.subscriptions.updateOne;
    mockCollections.subscriptions.updateOne = async () => {
      throw new Error('Simulated database write error');
    };
    const dbErrCancel = await makeRequest('POST', '/api/billing/cancel', {}, authHeaders);
    test('POST /api/billing/cancel returns HTTP 500 when local database update fails',
      dbErrCancel.status === 500 && dbErrCancel.body.error.includes('failed to update local records')
    );
    mockCollections.subscriptions.updateOne = originalSubUpdate;

    // Test 4.8: POST /api/billing/cancel succeeds when provider confirms cancellation
    const successCancel = await makeRequest('POST', '/api/billing/cancel', {}, authHeaders);
    test('POST /api/billing/cancel succeeds (HTTP 200) when provider confirms cancellation',
      successCancel.status === 200 && successCancel.body.cancelled === true
    );
    const subAfterSuccess = await mockCollections.subscriptions.findOne({ _id: 'sub_rz_test_1' });
    test('Subscription status updated to cancelled in local DB after provider confirmation',
      subAfterSuccess.status === 'cancelled'
    );

    // -------------------------------------------------------------------
    // 5. DANGER ZONE: SAFE ACCOUNT DELETION TESTS
    // -------------------------------------------------------------------
    console.log('\n--- 5. DANGER ZONE ACCOUNT DELETION TESTS ---');

    // Create a user specifically for deletion tests
    const deleteTestUserId = 'user_to_delete_99';
    await mockCollections.users.insertOne({
      id: deleteTestUserId,
      name: 'To Delete',
      email: 'delete_me@comment2dm.com',
      password_hash: userPasswordHash
    });
    const deleteSessionToken = await authService.createSession(deleteTestUserId, new Date(Date.now() + 86400000));
    const deleteHeaders = { Authorization: `Bearer ${deleteSessionToken}` };

    // Link Instagram account and automation to test cascade cleanup
    await mockCollections.instagramAccounts.insertOne({
      id: 'ig_acc_delete_1',
      owner_user_id: deleteTestUserId,
      instagram_user_id: 'ig_user_12345'
    });
    await mockCollections.automations.insertOne({
      id: 'auto_delete_1',
      owner_user_id: deleteTestUserId
    });

    // Test 5.1: Reject deletion without confirmation body
    const noConfirm = await makeRequest('DELETE', '/api/account/delete', null, deleteHeaders);
    test('Reject deletion with empty body', noConfirm.status === 400 && noConfirm.body.error.includes('Confirmation required'));

    // Test 5.2: Reject deletion with incorrect confirmation text
    const wrongConfirm = await makeRequest('DELETE', '/api/account/delete', { confirmation: 'delete' }, deleteHeaders);
    test('Reject deletion with incorrect lowercase confirmation', wrongConfirm.status === 400);

    // Test 5.3: Reject deletion for ALL non-terminal subscription states
    const nonTerminalStates = ['created', 'authenticated', 'active', 'pending', 'halted'];
    for (const state of nonTerminalStates) {
      await mockCollections.subscriptions.deleteMany({ user_id: deleteTestUserId });
      await mockCollections.subscriptions.insertOne({
        user_id: deleteTestUserId,
        plan: 'pro',
        status: state,
        razorpay_subscription_id: `sub_${state}_test_123`
      });
      const blockedRes = await makeRequest('DELETE', '/api/account/delete', { confirmation: 'DELETE' }, deleteHeaders);
      test(`Reject deletion when subscription status is '${state}' (HTTP 409)`,
        blockedRes.status === 409 && blockedRes.body.error.includes('Active subscription detected'),
        `status: ${state}`
      );
    }

    // Test 5.4: Terminal subscription states do NOT block account deletion
    const terminalStates = ['cancelled', 'completed', 'expired'];
    for (const state of terminalStates) {
      await mockCollections.subscriptions.deleteMany({ user_id: deleteTestUserId });
      await mockCollections.subscriptions.insertOne({
        user_id: deleteTestUserId,
        plan: 'pro',
        status: state,
        razorpay_subscription_id: `sub_${state}_test_123`
      });
      const activeSub = await billing.getActiveSubscription(deleteTestUserId);
      test(`Terminal state '${state}' is not considered an active recurring subscription`, activeSub === null);
    }

    // Test 5.4a: Database lookup failure in getActiveSubscription blocks deletion with HTTP 503
    const originalFindOne = mockCollections.subscriptions.findOne;
    mockCollections.subscriptions.findOne = async () => {
      throw new Error('Database cluster connection failure');
    };
    const dbFailureDelete = await makeRequest('DELETE', '/api/account/delete', { confirmation: 'DELETE' }, deleteHeaders);
    test('Account deletion fails-closed with HTTP 503 when subscription lookup fails',
      dbFailureDelete.status === 503 && dbFailureDelete.body.error.includes('Unable to verify subscription status')
    );
    mockCollections.subscriptions.findOne = originalFindOne;

    // Test 5.4b: Verify rejected deletion leaves user data completely untouched
    const userUntouched = await mockCollections.users.findOne({ id: deleteTestUserId });
    const igUntouched = await mockCollections.instagramAccounts.findOne({ owner_user_id: deleteTestUserId });
    const autoUntouched = await mockCollections.automations.findOne({ owner_user_id: deleteTestUserId });
    test('Rejected deletion leaves user document untouched', userUntouched !== null && userUntouched.id === deleteTestUserId);
    test('Rejected deletion leaves Instagram accounts untouched', igUntouched !== null);
    test('Rejected deletion leaves automations untouched', autoUntouched !== null);

    // Clear subscriptions so deletion can proceed
    await mockCollections.subscriptions.deleteMany({ user_id: deleteTestUserId });

    // Test 5.5: Successful account deletion with confirmation: "DELETE"
    const successfulDelete = await makeRequest('DELETE', '/api/account/delete', { confirmation: 'DELETE' }, deleteHeaders);
    test('Successful account deletion returns HTTP 200', successfulDelete.status === 200 && successfulDelete.body.success === true);

    // Test 5.6: Verify complete cascade data cleanup
    const userStillExists = await mockCollections.users.findOne({ id: deleteTestUserId });
    const igStillExists = await mockCollections.instagramAccounts.findOne({ owner_user_id: deleteTestUserId });
    const autoStillExists = await mockCollections.automations.findOne({ owner_user_id: deleteTestUserId });
    const sessionStillExists = await mockCollections.sessions.findOne({ user_id: deleteTestUserId });

    test('User document deleted', userStillExists === null);
    test('Instagram accounts purged', igStillExists === null);
    test('Automations purged', autoStillExists === null);
    test('Sessions purged', sessionStillExists === null);

    // Test 5.7: Deletion safety - db.deleteUserAccount does not report success if a cleanup operation fails
    const mockErrorUserId = 'error_user_123';
    let deleteThrew = false;
    const originalDeleteMany = mockCollections.automations.deleteMany;
    mockCollections.automations.deleteMany = async () => {
      throw new Error('Simulated database connection failure');
    };
    try {
      await db.deleteUserAccount(mockErrorUserId);
    } catch (err) {
      deleteThrew = true;
    } finally {
      mockCollections.automations.deleteMany = originalDeleteMany;
    }
    test('db.deleteUserAccount rejects with Error if cleanup fails (does not silently ignore error)', deleteThrew === true);

    // Test 5.8: In-flight worker race guard - aborts comment job dispatch if account was deleted
    const { executeCommentJob, deliverFinalResource } = require('./server');
    const raceCommentJob = {
      event_type: 'comment',
      instagram_account_id: 'deleted_ig_acc_999',
      comment_id: 'cmt_race_1',
      text: 'hello'
    };
    const commentRaceRes = await executeCommentJob(raceCommentJob);
    test('executeCommentJob aborts safely when Instagram account is deleted/missing before dispatch',
      commentRaceRes === undefined || (commentRaceRes && commentRaceRes.skipped === true)
    );

    // Test 5.9: In-flight worker race guard - deliverFinalResource aborts safely if account is deleted
    const deliveryRaceRes = await deliverFinalResource({
      recipientIgUserId: 'deleted_ig_acc_999',
      senderIgsid: 'sender_999',
      automation: { id: 'auto_999', owner_user_id: 'user_999' },
      tokenData: { accessToken: 'dummy_token' },
      flow: {},
      commentId: 'cmt_999'
    });
    test('deliverFinalResource aborts safely when Instagram account is deleted/missing before dispatch',
      deliveryRaceRes && deliveryRaceRes.reason === 'ACCOUNT_DELETED'
    );

    // -------------------------------------------------------------------
    // 5B. DISPATCH COORDINATION & INDIVIDUAL LEASE OWNERSHIP TESTS
    // -------------------------------------------------------------------
    console.log('\n--- 5B. DISPATCH COORDINATION & INDIVIDUAL LEASE OWNERSHIP TESTS ---');

    // Test 5.10: Two workers acquire different lease IDs
    const multiWorkerIgId = 'ig_multi_worker_1';
    await mockCollections.instagramAccounts.insertOne({
      id: multiWorkerIgId,
      instagram_user_id: multiWorkerIgId,
      owner_user_id: 'user_coord_1',
      active_dispatch_leases: []
    });
    const lease1 = await db.acquireDispatchLease(multiWorkerIgId, 'worker_A');
    const lease2 = await db.acquireDispatchLease(multiWorkerIgId, 'worker_B');
    test('Two workers acquire different lease IDs',
      lease1 !== null && lease2 !== null &&
      typeof lease1.leaseId === 'string' && typeof lease2.leaseId === 'string' &&
      lease1.leaseId.startsWith('lease_') && lease2.leaseId.startsWith('lease_') &&
      lease1.leaseId !== lease2.leaseId
    );

    // Test 5.11: Worker A releases only its own lease
    await db.releaseDispatchLease(multiWorkerIgId, lease1.leaseId);
    const validA = await db.isDispatchLeaseValid(multiWorkerIgId, lease1.leaseId);
    test('Worker A releases only its own lease (lease A becomes invalid)', validA === false);

    // Test 5.12: Worker B's lease remains active
    const validB = await db.isDispatchLeaseValid(multiWorkerIgId, lease2.leaseId);
    test("Worker B's lease remains active after Worker A releases", validB === true);

    // Test 5.13: Duplicate release is harmless and does not affect another worker's lease
    await db.releaseDispatchLease(multiWorkerIgId, lease1.leaseId); // Duplicate release of A
    const validBAfterDup = await db.isDispatchLeaseValid(multiWorkerIgId, lease2.leaseId);
    test('Duplicate release of lease A is harmless and preserves lease B', validBAfterDup === true);
    await db.releaseDispatchLease(multiWorkerIgId, lease2.leaseId); // Clean release of B
    test('Worker B releases cleanly', await db.isDispatchLeaseValid(multiWorkerIgId, lease2.leaseId) === false);

    // Test 5.14: Worker crash and lease expiration recover safely
    const crashIgId = 'ig_crash_test_1';
    await mockCollections.instagramAccounts.insertOne({
      id: crashIgId,
      instagram_user_id: crashIgId,
      owner_user_id: 'user_crash_1',
      active_dispatch_leases: [
        {
          lease_id: 'lease_crashed_1',
          worker_id: 'crashed_worker',
          expires_at: new Date(Date.now() - 5000), // already expired!
          created_at: new Date(Date.now() - 20000)
        }
      ]
    });
    test('Expired crashed lease is reported invalid by isDispatchLeaseValid',
      await db.isDispatchLeaseValid(crashIgId, 'lease_crashed_1') === false
    );
    const newWorkerLease = await db.acquireDispatchLease(crashIgId, 'new_worker_1');
    test('New worker can acquire lease and expired crash lease is safely pruned',
      newWorkerLease !== null && newWorkerLease.leaseId &&
      await db.isDispatchLeaseValid(crashIgId, newWorkerLease.leaseId) === true
    );
    await db.releaseDispatchLease(crashIgId, newWorkerLease.leaseId);

    // Test 5.15: No new lease is acquired after deletion starts
    const coordIgAccId = 'ig_coord_test_1';
    await mockCollections.instagramAccounts.insertOne({
      id: coordIgAccId,
      instagram_user_id: coordIgAccId,
      owner_user_id: 'user_coord_1',
      deletion_pending: true,
      deletion_state: 'deleting',
      active_dispatch_leases: []
    });
    const leaseDenied = await db.acquireDispatchLease(coordIgAccId, 'worker_late');
    test('No new lease is acquired after deletion starts (returns null)', leaseDenied === null);

    // Test 5.16: Concurrent workers cannot bypass deletion_pending
    const concurrentAttempts = await Promise.all(
      Array.from({ length: 10 }, (_, i) => db.acquireDispatchLease(coordIgAccId, `concurrent_w_${i}`))
    );
    test('Concurrent workers cannot bypass deletion_pending (10/10 return null)',
      concurrentAttempts.every(res => res === null)
    );

    // Test 5.17: Deletion waits while a valid lease exists
    const drainUserId = 'user_drain_test_1';
    const drainIgId = 'ig_drain_test_1';
    await mockCollections.users.insertOne({ id: drainUserId, name: 'Drain User', email: 'drain@test.com' });
    await mockCollections.instagramAccounts.insertOne({
      id: drainIgId,
      instagram_user_id: drainIgId,
      owner_user_id: drainUserId,
      active_dispatch_leases: []
    });
    const inFlightLease = await db.acquireDispatchLease(drainIgId, 'in_flight_worker', 10000);
    let deletionCompleted = false;
    const deletionPromise = db.deleteUserAccount(drainUserId, { drainTimeoutMs: 2000 }).then(() => {
      deletionCompleted = true;
    });
    await new Promise(resolve => setTimeout(resolve, 80));
    test('Account deletion waits while a valid lease exists', deletionCompleted === false);
    // Worker releases its lease
    await db.releaseDispatchLease(drainIgId, inFlightLease.leaseId);
    await deletionPromise;
    test('Account deletion completes once all active leases are released', deletionCompleted === true);

    // Test 5.18: Drain timeout returns non-success result (HTTP 503) when leases remain active
    const drainTimeoutUserId = 'user_drain_timeout_1';
    const drainTimeoutIgId = 'ig_drain_timeout_1';
    await mockCollections.users.insertOne({
      id: drainTimeoutUserId,
      name: 'Drain Timeout User',
      email: 'draintimeout@test.com',
      password_hash: userPasswordHash
    });
    const drainTimeoutSession = await authService.createSession(drainTimeoutUserId, new Date(Date.now() + 86400000));
    const drainTimeoutHeaders = { Authorization: `Bearer ${drainTimeoutSession}` };
    await mockCollections.instagramAccounts.insertOne({
      id: drainTimeoutIgId,
      instagram_user_id: drainTimeoutIgId,
      owner_user_id: drainTimeoutUserId,
      active_dispatch_leases: []
    });
    await mockCollections.automations.insertOne({
      id: 'auto_drain_timeout_1',
      owner_user_id: drainTimeoutUserId
    });
    // Worker acquires a lease that it does NOT release
    const unreleasedLease = await db.acquireDispatchLease(drainTimeoutIgId, 'worker_stuck', 30000);

    // Deletion requested via HTTP API: should return 503 because lease is still active
    const drainTimeoutResponse = await makeRequest(
      'DELETE',
      '/api/account/delete',
      { confirmation: 'DELETE' },
      drainTimeoutHeaders
    );
    test('Account deletion drain timeout returns HTTP 503 non-success result',
      drainTimeoutResponse.status === 503 && drainTimeoutResponse.body.inProgress === true
    );

    // Test 5.19: Drain timeout does NOT delete account credentials or user data
    const userAfterTimeout = await mockCollections.users.findOne({ id: drainTimeoutUserId });
    const igAfterTimeout = await mockCollections.instagramAccounts.findOne({ owner_user_id: drainTimeoutUserId });
    const autoAfterTimeout = await mockCollections.automations.findOne({ owner_user_id: drainTimeoutUserId });
    test('Drain timeout preserves user record', userAfterTimeout !== null && userAfterTimeout.id === drainTimeoutUserId);
    test('Drain timeout preserves Instagram account credentials', igAfterTimeout !== null && igAfterTimeout.id === drainTimeoutIgId);
    test('Drain timeout preserves automations', autoAfterTimeout !== null);

    // Test 5.20: Retry succeeds after all leases are released
    await db.releaseDispatchLease(drainTimeoutIgId, unreleasedLease.leaseId);
    const retryAfterDrained = await makeRequest(
      'DELETE',
      '/api/account/delete',
      { confirmation: 'DELETE' },
      drainTimeoutHeaders
    );
    test('Retry account deletion succeeds with HTTP 200 after all leases are released',
      retryAfterDrained.status === 200 && retryAfterDrained.body.success === true
    );
    const userAfterDrained = await mockCollections.users.findOne({ id: drainTimeoutUserId });
    const igAfterDrained = await mockCollections.instagramAccounts.findOne({ owner_user_id: drainTimeoutUserId });
    test('User record purged after successful retry', userAfterDrained === null);
    test('Instagram accounts purged after successful retry', igAfterDrained === null);

    // Test 5.21: A worker cannot dispatch after losing its lease
    const shortLeaseIgId = 'ig_short_lease_1';
    await mockCollections.instagramAccounts.insertOne({
      id: shortLeaseIgId,
      instagram_user_id: shortLeaseIgId,
      owner_user_id: 'user_short_1',
      active_dispatch_leases: []
    });
    const expiredQuickLease = await db.acquireDispatchLease(shortLeaseIgId, 'worker_quick', 10); // 10ms lease
    await new Promise(resolve => setTimeout(resolve, 25)); // wait for lease to expire
    test('isDispatchLeaseValid returns false after lease duration elapses',
      await db.isDispatchLeaseValid(shortLeaseIgId, expiredQuickLease.leaseId) === false
    );

    // Test 5.22: Partial cleanup failure leaves deletion_state: 'deletion_failed' and does not delete user record
    const partialUserId = 'user_partial_fail_1';
    await mockCollections.users.insertOne({
      id: partialUserId,
      name: 'Partial Fail User',
      email: 'partial@test.com',
      password_hash: userPasswordHash
    });
    const partialSessionToken = await authService.createSession(partialUserId, new Date(Date.now() + 86400000));
    const partialHeaders = { Authorization: `Bearer ${partialSessionToken}` };
    await mockCollections.automations.insertOne({ id: 'auto_partial_1', owner_user_id: partialUserId });

    const origAutomationsDeleteMany = mockCollections.automations.deleteMany;
    mockCollections.automations.deleteMany = async () => {
      throw new Error('Database write conflict during automation deletion');
    };

    let partialThrew = false;
    try {
      await db.deleteUserAccount(partialUserId);
    } catch (err) {
      partialThrew = true;
    }
    test('Partial cleanup failure causes db.deleteUserAccount to throw', partialThrew === true);

    const partialUserDoc = await mockCollections.users.findOne({ id: partialUserId });
    test('User record is NOT deleted on partial failure', partialUserDoc !== null && partialUserDoc.id === partialUserId);
    test('User record tracks deletion_state as "deletion_failed"', partialUserDoc.deletion_state === 'deletion_failed');

    // Test 5.23: User cannot start new operations while in 'deletion_failed' or 'deleting' state
    const blockedProfileOp = await makeRequest('PATCH', '/api/settings/profile', { name: 'Hacker Attempt' }, partialHeaders);
    test('User in deletion_failed state is blocked from normal operations (HTTP 403)',
      blockedProfileOp.status === 403 && blockedProfileOp.body.error.includes('currently being deleted')
    );

    // Test 5.24: Retrying cleanup completes successfully and purges user record
    mockCollections.automations.deleteMany = origAutomationsDeleteMany; // restore function
    const retryDeleteRes = await makeRequest('DELETE', '/api/account/delete', { confirmation: 'DELETE' }, partialHeaders);
    test('Retrying account deletion succeeds (HTTP 200)', retryDeleteRes.status === 200 && retryDeleteRes.body.success === true);
    const userAfterRetry = await mockCollections.users.findOne({ id: partialUserId });
    test('User record is purged after successful retry', userAfterRetry === null);

    // Test 5.25: Financial records remain strictly preserved after account deletion
    const financeUserId = 'user_financial_audit_1';
    await mockCollections.users.insertOne({
      id: financeUserId,
      name: 'Finance Audit User',
      email: 'finance@test.com'
    });
    await mockCollections.subscriptions.insertOne({
      _id: 'sub_fin_1',
      user_id: financeUserId,
      status: 'cancelled',
      plan: 'pro'
    });
    if (!mockCollections.payments) mockCollections.payments = createMockCollection();
    if (!mockCollections.billing_events) mockCollections.billing_events = createMockCollection();
    await mockCollections.payments.insertOne({
      _id: 'pay_fin_1',
      user_id: financeUserId,
      amount: 4900,
      currency: 'INR',
      status: 'captured'
    });
    await mockCollections.billing_events.insertOne({
      _id: 'bev_fin_1',
      user_id: financeUserId,
      event: 'subscription.cancelled'
    });

    await db.deleteUserAccount(financeUserId);

    const finUserAfter = await mockCollections.users.findOne({ id: financeUserId });
    const finSubAfter = await mockCollections.subscriptions.findOne({ user_id: financeUserId });
    const finPayAfter = await mockCollections.payments.findOne({ user_id: financeUserId });
    const finEventAfter = await mockCollections.billing_events.findOne({ user_id: financeUserId });

    test('User record is purged after deletion', finUserAfter === null);
    test('Financial record - subscriptions is strictly preserved', finSubAfter !== null && finSubAfter._id === 'sub_fin_1');
    test('Financial record - payments is strictly preserved', finPayAfter !== null && finPayAfter._id === 'pay_fin_1');
    test('Financial record - billing_events is strictly preserved', finEventAfter !== null && finEventAfter._id === 'bev_fin_1');

    console.log('\n======================================================================');
    const total = results.length;
    const passed = results.filter(r => r.passed).length;
    console.log(`   SETTINGS TEST SUITE: ${total} CHECKS | ALL ${passed} PASSED!`);
    console.log('======================================================================\n');
  } finally {
    if (server) server.close();
  }
}

runTestSuite().catch(err => {
  console.error('\n❌ TEST SUITE FAILURE:', err);
  process.exit(1);
});
