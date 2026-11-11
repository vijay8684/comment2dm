// test_admin_isolation_suite.js
// Stage 1.2.2: Environment-Based Admin Isolation Verification Suite

'use strict';

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');

// Save original environment
const originalAdminEmail = process.env.ADMIN_EMAIL;

// Setup mock DB for sessions & users
const db = require('./src/db');
const usersMap = new Map();
const sessionsMap = new Map();

db.collections = function () {
  return {
    users: {
      findOne: async (q) => {
        if (q.id) return usersMap.get(q.id) || null;
        if (q.email) return Array.from(usersMap.values()).find(u => u.email.toLowerCase() === q.email.toLowerCase()) || null;
        return null;
      }
    },
    sessions: {
      findOne: async (q) => {
        if (q.token_hash) return sessionsMap.get(q.token_hash) || null;
        return null;
      },
      insertOne: async (doc) => {
        sessionsMap.set(doc.token_hash, doc);
        return { acknowledged: true };
      },
      deleteOne: async (q) => {
        if (q.token_hash) sessionsMap.delete(q.token_hash);
        return { acknowledged: true };
      }
    }
  };
};
db.getUserById = async (id) => usersMap.get(id) || null;

// Import target modules
const serverModule = require('./server.js');
const billingModule = require('./src/billing.js');
const authService = require('./src/auth/authService');

let passCount = 0;
let failCount = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`✅ PASS: ${name}`);
    passCount++;
  } catch (err) {
    console.error(`❌ FAIL: ${name}`);
    console.error(`   Error: ${err.message}`);
    failCount++;
  }
}

async function runTestAsync(name, fn) {
  try {
    await fn();
    console.log(`✅ PASS: ${name}`);
    passCount++;
  } catch (err) {
    console.error(`❌ FAIL: ${name}`);
    console.error(`   Error: ${err.message}`);
    failCount++;
  }
}

async function main() {
  console.log('======================================================================');
  console.log(' COMMENT2DM — STAGE 1.2.2: ENVIRONMENT-BASED ADMIN ISOLATION SUITE');
  console.log('======================================================================\n');

  // Test 1: Configured production admins are recognized when supplied through environment
  runTest('1. Configured production admins are recognized via comma-separated ADMIN_EMAIL', () => {
    process.env.ADMIN_EMAIL = 'prod-admin1@comment2dm.com, prod-admin2@comment2dm.com';
    
    assert.strictEqual(serverModule.isAdminEmail('prod-admin1@comment2dm.com'), true);
    assert.strictEqual(serverModule.isAdminEmail('prod-admin2@comment2dm.com'), true);
    assert.strictEqual(billingModule.isAdminEmail('prod-admin1@comment2dm.com'), true);
    assert.strictEqual(billingModule.isAdminEmail('prod-admin2@comment2dm.com'), true);
    assert.strictEqual(serverModule.isAdminEmail('stranger@example.com'), false);
  });

  // Test 2: Configured staging admins are recognized
  runTest('2. Configured staging admins are recognized via dedicated ADMIN_EMAIL', () => {
    process.env.ADMIN_EMAIL = 'staging-admin@comment2dm.internal';

    assert.strictEqual(serverModule.isAdminEmail('staging-admin@comment2dm.internal'), true);
    assert.strictEqual(billingModule.isAdminEmail('staging-admin@comment2dm.internal'), true);
  });

  // Test 3: Production admin addresses are NOT automatically admins in staging
  runTest('3. Production admin addresses are NOT automatically admins in staging', () => {
    // When staging environment sets only its dedicated admin
    process.env.ADMIN_EMAIL = 'staging-admin@comment2dm.internal';

    // Verify former hardcoded production addresses are rejected
    assert.strictEqual(serverModule.isAdminEmail('jayvardhanreddy2008@gmail.com'), false);
    assert.strictEqual(serverModule.isAdminEmail('vijayakrishnareddy910@gmail.com'), false);
    assert.strictEqual(billingModule.isAdminEmail('jayvardhanreddy2008@gmail.com'), false);
    assert.strictEqual(billingModule.isAdminEmail('vijayakrishnareddy910@gmail.com'), false);
    
    // Verify other production addresses are rejected
    assert.strictEqual(serverModule.isAdminEmail('prod-admin1@comment2dm.com'), false);
  });

  // Test 4: Empty or missing ADMIN_EMAIL grants NO admin access
  runTest('4. Empty or missing ADMIN_EMAIL grants NO admin access', () => {
    // Missing environment variable
    delete process.env.ADMIN_EMAIL;
    assert.strictEqual(serverModule.isAdminEmail('jayvardhanreddy2008@gmail.com'), false);
    assert.strictEqual(serverModule.isAdminEmail('staging-admin@comment2dm.internal'), false);
    assert.strictEqual(billingModule.isAdminEmail('jayvardhanreddy2008@gmail.com'), false);

    // Empty string
    process.env.ADMIN_EMAIL = '';
    assert.strictEqual(serverModule.isAdminEmail('jayvardhanreddy2008@gmail.com'), false);
    assert.strictEqual(serverModule.isAdminEmail('staging-admin@comment2dm.internal'), false);

    // Whitespace only
    process.env.ADMIN_EMAIL = '   ,   ,   ';
    assert.strictEqual(serverModule.isAdminEmail('jayvardhanreddy2008@gmail.com'), false);
    assert.strictEqual(serverModule.isAdminEmail('staging-admin@comment2dm.internal'), false);
  });

  // Test 5: Email comparison remains case-insensitive and whitespace-tolerant
  runTest('5. Email comparison is case-insensitive and whitespace-tolerant', () => {
    process.env.ADMIN_EMAIL = '  Staging-Admin@Comment2DM.Internal  ,  SecondAdmin@Internal.Org ';

    // Mixed case in lookup
    assert.strictEqual(serverModule.isAdminEmail('staging-admin@comment2dm.internal'), true);
    assert.strictEqual(serverModule.isAdminEmail('STAGING-ADMIN@COMMENT2DM.INTERNAL'), true);
    assert.strictEqual(serverModule.isAdminEmail('  Staging-Admin@Comment2dm.Internal  '), true);
    assert.strictEqual(serverModule.isAdminEmail('secondadmin@internal.org'), true);
    assert.strictEqual(serverModule.isAdminEmail('SECONDADMIN@INTERNAL.ORG'), true);

    // Same behavior in billing
    assert.strictEqual(billingModule.isAdminEmail('staging-admin@comment2dm.internal'), true);
    assert.strictEqual(billingModule.isAdminEmail('STAGING-ADMIN@COMMENT2DM.INTERNAL'), true);
  });

  // Test 6: Non-string, null, and malformed inputs fail closed
  runTest('6. Non-string, null, and malformed inputs fail closed safely', () => {
    process.env.ADMIN_EMAIL = 'staging-admin@comment2dm.internal';

    assert.strictEqual(serverModule.isAdminEmail(null), false);
    assert.strictEqual(serverModule.isAdminEmail(undefined), false);
    assert.strictEqual(serverModule.isAdminEmail(12345), false);
    assert.strictEqual(serverModule.isAdminEmail({}), false);
    assert.strictEqual(serverModule.isAdminEmail([]), false);
    assert.strictEqual(serverModule.isAdminEmail(''), false);
  });

  // Test 7: HTTP route authorization test with requireAdmin
  await runTestAsync('7. Express HTTP requireAdmin middleware enforces dynamic environment admin', async () => {
    process.env.ADMIN_EMAIL = 'staging-admin@comment2dm.internal';

    // Populate mock users in memory
    const adminUser = { id: 'usr_admin_1', email: 'staging-admin@comment2dm.internal', name: 'Staging Admin' };
    const nonAdminUser = { id: 'usr_normal_1', email: 'jayvardhanreddy2008@gmail.com', name: 'Regular User' };
    usersMap.set(adminUser.id, adminUser);
    usersMap.set(nonAdminUser.id, nonAdminUser);

    // Create valid sessions for both users
    const adminSessionToken = await authService.createSession(adminUser.id, new Date(Date.now() + 3600000));
    const nonAdminSessionToken = await authService.createSession(nonAdminUser.id, new Date(Date.now() + 3600000));

    // Start a temporary HTTP listener on serverModule.app
    const server = http.createServer(serverModule.app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      // Helper for HTTP requests
      function makeRequest(path, cookieToken) {
        return new Promise((resolve, reject) => {
          const req = http.request({
            hostname: '127.0.0.1',
            port,
            path,
            method: 'GET',
            headers: {
              'Cookie': `comment2dm_session=${cookieToken}`
            }
          }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => resolve({ statusCode: res.statusCode, body }));
          });
          req.on('error', reject);
          req.end();
        });
      }

      // Non-admin accessing /api/admin/overview must receive HTTP 403
      const nonAdminRes = await makeRequest('/api/admin/overview', nonAdminSessionToken);
      assert.strictEqual(nonAdminRes.statusCode, 403, `Non-admin should get 403, got ${nonAdminRes.statusCode}`);
      const nonAdminBody = JSON.parse(nonAdminRes.body);
      assert.strictEqual(nonAdminBody.error, 'Admin access required.');

      // Admin accessing /api/me should receive isAdmin: true
      const adminMeRes = await makeRequest('/api/me', adminSessionToken);
      assert.strictEqual(adminMeRes.statusCode, 200);
      const adminMeBody = JSON.parse(adminMeRes.body);
      assert.strictEqual(adminMeBody.user.isAdmin, true, 'Staging admin should have isAdmin: true in /api/me');

      // Non-admin accessing /api/me should receive isAdmin: false
      const nonAdminMeRes = await makeRequest('/api/me', nonAdminSessionToken);
      assert.strictEqual(nonAdminMeRes.statusCode, 200);
      const nonAdminMeBody = JSON.parse(nonAdminMeRes.body);
      assert.strictEqual(nonAdminMeBody.user.isAdmin, false, 'Non-admin should have isAdmin: false in /api/me');
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  // Test 8: Billing isAdminEmail and getAdminEmails match server.js across configurations
  runTest('8. Billing module admin verification matches server.js across dynamic configurations', () => {
    process.env.ADMIN_EMAIL = 'billing-admin@comment2dm.internal, finance-admin@comment2dm.internal';

    assert.strictEqual(billingModule.isAdminEmail('billing-admin@comment2dm.internal'), true);
    assert.strictEqual(billingModule.isAdminEmail('finance-admin@comment2dm.internal'), true);
    assert.strictEqual(billingModule.isAdminEmail('jayvardhanreddy2008@gmail.com'), false);
    assert.strictEqual(billingModule.isAdminEmail('vijayakrishnareddy910@gmail.com'), false);

    const billingEmails = billingModule.getAdminEmails();
    const serverEmails = serverModule.getAdminEmails();
    assert.deepStrictEqual(Array.from(billingEmails).sort(), ['billing-admin@comment2dm.internal', 'finance-admin@comment2dm.internal']);
    assert.deepStrictEqual(Array.from(serverEmails).sort(), ['billing-admin@comment2dm.internal', 'finance-admin@comment2dm.internal']);
  });

  // Restore original environment
  if (originalAdminEmail !== undefined) {
    process.env.ADMIN_EMAIL = originalAdminEmail;
  } else {
    delete process.env.ADMIN_EMAIL;
  }

  console.log('\n======================================================================');
  console.log(` RESULTS: ${passCount} PASSED, ${failCount} FAILED`);
  console.log('======================================================================\n');

  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unexpected test error:', err);
  process.exit(1);
});
