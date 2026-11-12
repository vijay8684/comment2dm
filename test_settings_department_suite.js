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
    async insertOne(doc) {
      const copy = { ...doc };
      if (!copy._id) copy._id = 'mock_' + Math.random().toString(36).substring(2, 9);
      items.push(copy);
      return { insertedId: copy._id };
    },
    async updateOne(filter, update, options = {}) {
      let doc = items.find(d => matchesQuery(d, filter));
      if (!doc && options.upsert) {
        doc = { ...filter };
        items.push(doc);
      }
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      if (update.$set) Object.assign(doc, update.$set);
      if (update.$inc) {
        for (const [k, v] of Object.entries(update.$inc)) {
          doc[k] = (doc[k] || 0) + v;
        }
      }
      return { matchedCount: 1, modifiedCount: 1 };
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

function matchesQuery(doc, query) {
  if (!query || Object.keys(query).length === 0) return true;
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
      if (val.$in && Array.isArray(val.$in)) {
        if (!val.$in.includes(doc[key])) return false;
        continue;
      }
      if (val.$ne !== undefined) {
        if (doc[key] === val.$ne) return false;
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

    // Test 4.1: GET /api/billing/status returns correct schema
    const billStatus = await makeRequest('GET', '/api/billing/status', null, authHeaders);
    test('GET /api/billing/status returns valid plan, limits, and usage structure',
      billStatus.status === 200 &&
      typeof billStatus.body.plan === 'string' &&
      billStatus.body.limits &&
      billStatus.body.usage &&
      typeof billStatus.body.usage.dmMonthly === 'number'
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

    // Test 5.3: Reject deletion if active subscription exists (409 Conflict)
    await mockCollections.subscriptions.insertOne({
      user_id: deleteTestUserId,
      plan: 'pro',
      status: 'active',
      razorpay_subscription_id: 'sub_active_test_123'
    });
    const subBlocked = await makeRequest('DELETE', '/api/account/delete', { confirmation: 'DELETE' }, deleteHeaders);
    test('Reject deletion when active subscription exists (HTTP 409)', subBlocked.status === 409 && subBlocked.body.error.includes('Active subscription detected'));

    // Cancel subscription so deletion can proceed
    await mockCollections.subscriptions.updateOne(
      { user_id: deleteTestUserId },
      { $set: { status: 'cancelled' } }
    );

    // Test 5.4: Successful account deletion with confirmation: "DELETE"
    const successfulDelete = await makeRequest('DELETE', '/api/account/delete', { confirmation: 'DELETE' }, deleteHeaders);
    test('Successful account deletion returns HTTP 200', successfulDelete.status === 200 && successfulDelete.body.success === true);

    // Test 5.5: Verify complete cascade data cleanup
    const userStillExists = await mockCollections.users.findOne({ id: deleteTestUserId });
    const igStillExists = await mockCollections.instagramAccounts.findOne({ owner_user_id: deleteTestUserId });
    const autoStillExists = await mockCollections.automations.findOne({ owner_user_id: deleteTestUserId });
    const sessionStillExists = await mockCollections.sessions.findOne({ user_id: deleteTestUserId });

    test('User document deleted', userStillExists === null);
    test('Instagram accounts purged', igStillExists === null);
    test('Automations purged', autoStillExists === null);
    test('Sessions purged', sessionStillExists === null);

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
