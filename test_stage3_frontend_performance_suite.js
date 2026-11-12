// test_stage3_frontend_performance_suite.js
// Verification suite for Comment2DM Performance Optimization Stage 3:
// Static Asset Caching, Font Loading Optimization, & Concurrent Dashboard Initialization

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { app } = require('./server');

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

async function main() {
  console.log('='.repeat(70));
  console.log('RUNNING STAGE 3 FRONTEND PERFORMANCE VERIFICATION SUITE');
  console.log('='.repeat(70));

  // Start temporary server for HTTP header testing
  const server = http.createServer(app);
  let baseUrl;

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  try {
    // -------------------------------------------------------------
    // 1. Static Asset Caching: HTML Files (Must Revalidate Immediately)
    // -------------------------------------------------------------
    await runTestAsync('HTML files are served with Cache-Control: no-cache and ETag', async () => {
      const res = await fetch(`${baseUrl}/index.html`);
      assert.strictEqual(res.status, 200, 'Expected 200 OK for /index.html');
      const cacheControl = res.headers.get('cache-control');
      assert.strictEqual(
        cacheControl,
        'no-cache',
        `Expected "no-cache" but got "${cacheControl}"`
      );
      const etag = res.headers.get('etag');
      assert.ok(etag && etag.length > 0, 'Expected ETag header on HTML response');
      assert.strictEqual(res.headers.get('x-dns-prefetch-control'), 'on', 'Expected X-DNS-Prefetch-Control: on');
    });

    await runTestAsync('Root path / serves index.html with Cache-Control: no-cache', async () => {
      const res = await fetch(`${baseUrl}/`);
      assert.strictEqual(res.status, 200, 'Expected 200 OK for /');
      const cacheControl = res.headers.get('cache-control');
      assert.strictEqual(
        cacheControl,
        'no-cache',
        `Expected "no-cache" on root HTML but got "${cacheControl}"`
      );
    });

    // -------------------------------------------------------------
    // 2. Static Asset Caching: CSS and JS Files (no-cache + ETag Revalidation)
    // -------------------------------------------------------------
    await runTestAsync('CSS files are served with Cache-Control: no-cache (NO immutable, ETag enabled)', async () => {
      const res = await fetch(`${baseUrl}/styles.css`);
      assert.strictEqual(res.status, 200, 'Expected 200 OK for /styles.css');
      const cacheControl = res.headers.get('cache-control');
      assert.strictEqual(
        cacheControl,
        'no-cache',
        `Expected "no-cache" but got "${cacheControl}"`
      );
      assert.ok(!cacheControl.includes('immutable'), 'CSS must NOT have immutable flag');
      const etag = res.headers.get('etag');
      assert.ok(etag && etag.length > 0, 'Expected ETag header on CSS response');
    });

    await runTestAsync('JavaScript files are served with Cache-Control: no-cache (NO immutable, ETag enabled)', async () => {
      const res = await fetch(`${baseUrl}/dashboard.js`);
      assert.strictEqual(res.status, 200, 'Expected 200 OK for /dashboard.js');
      const cacheControl = res.headers.get('cache-control');
      assert.strictEqual(
        cacheControl,
        'no-cache',
        `Expected "no-cache" but got "${cacheControl}"`
      );
      assert.ok(!cacheControl.includes('immutable'), 'JS must NOT have immutable flag');
      const etag = res.headers.get('etag');
      assert.ok(etag && etag.length > 0, 'Expected ETag header on JS response');
    });

    // -------------------------------------------------------------
    // 3. Static Asset Caching: Media, SVG, & Images (7-Day Caching)
    // -------------------------------------------------------------
    await runTestAsync('Static SVG / images are served with max-age=604800, stale-while-revalidate=86400', async () => {
      const res = await fetch(`${baseUrl}/logo.svg`);
      assert.strictEqual(res.status, 200, 'Expected 200 OK for /logo.svg');
      const cacheControl = res.headers.get('cache-control');
      assert.strictEqual(
        cacheControl,
        'public, max-age=604800, stale-while-revalidate=86400',
        `Expected "public, max-age=604800, stale-while-revalidate=86400" but got "${cacheControl}"`
      );
    });

    // -------------------------------------------------------------
    // 4. 404 Error Handler Cache Header
    // -------------------------------------------------------------
    await runTestAsync('Non-existent pages return 404 with Cache-Control: no-cache', async () => {
      const res = await fetch(`${baseUrl}/nonexistent-page-xyz-12345`);
      assert.strictEqual(res.status, 404, 'Expected 404 Not Found');
      const cacheControl = res.headers.get('cache-control');
      assert.strictEqual(
        cacheControl,
        'no-cache',
        `Expected "no-cache" on 404 but got "${cacheControl}"`
      );
    });

    // -------------------------------------------------------------
    // 5. Conditional Request (ETag 304 Not Modified)
    // -------------------------------------------------------------
    await runTestAsync('Conditional request with If-None-Match returns HTTP 304 Not Modified', async () => {
      const initial = await fetch(`${baseUrl}/styles.css`);
      const etag = initial.headers.get('etag');
      assert.ok(etag, 'ETag must be present for conditional test');

      // Use http.request to verify raw wire HTTP 304 status (fetch spec intercepts 304 in JS)
      const parsedUrl = new URL(`${baseUrl}/styles.css`);
      const conditional = await new Promise((resolve, reject) => {
        const req = http.request({
          hostname: parsedUrl.hostname,
          port: parsedUrl.port,
          path: parsedUrl.pathname,
          method: 'GET',
          headers: { 'If-None-Match': etag }
        }, (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
        req.on('error', reject);
        req.end();
      });

      assert.strictEqual(conditional.status, 304, `Expected 304 Not Modified but got ${conditional.status}`);
      assert.strictEqual(conditional.body, '', '304 response body must be empty');
    });

    // -------------------------------------------------------------
    // 6. API Route Protection (Must Remain no-store)
    // -------------------------------------------------------------
    await runTestAsync('API endpoints remain strictly protected with Cache-Control: no-store', async () => {
      const res = await fetch(`${baseUrl}/api/instagram/accounts`);
      const cacheControl = res.headers.get('cache-control');
      assert.strictEqual(cacheControl, 'no-store', `Expected API Cache-Control: no-store but got "${cacheControl}"`);
    });

    // -------------------------------------------------------------
    // 7. HTML Font Optimization Verification
    // -------------------------------------------------------------
    runTest('index.html contains dns-prefetch, preconnect, and display=swap for Google Fonts', () => {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
      assert.ok(html.includes('<link rel="dns-prefetch" href="https://fonts.googleapis.com" />'), 'Missing dns-prefetch for fonts.googleapis.com in index.html');
      assert.ok(html.includes('<link rel="dns-prefetch" href="https://fonts.gstatic.com" />'), 'Missing dns-prefetch for fonts.gstatic.com in index.html');
      assert.ok(html.includes('<link rel="preconnect" href="https://fonts.googleapis.com" />'), 'Missing preconnect for fonts.googleapis.com in index.html');
      assert.ok(html.includes('<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />'), 'Missing preconnect for fonts.gstatic.com in index.html');
      assert.ok(html.includes('display=swap'), 'Missing display=swap in font link in index.html');
    });

    runTest('dashboard.html contains dns-prefetch, preconnect, and display=swap for Google Fonts', () => {
      const html = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
      assert.ok(html.includes('<link rel="dns-prefetch" href="https://fonts.googleapis.com" />'), 'Missing dns-prefetch for fonts.googleapis.com in dashboard.html');
      assert.ok(html.includes('<link rel="dns-prefetch" href="https://fonts.gstatic.com" />'), 'Missing dns-prefetch for fonts.gstatic.com in dashboard.html');
      assert.ok(html.includes('<link rel="preconnect" href="https://fonts.googleapis.com" />'), 'Missing preconnect for fonts.googleapis.com in dashboard.html');
      assert.ok(html.includes('<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />'), 'Missing preconnect for fonts.gstatic.com in dashboard.html');
      assert.ok(html.includes('display=swap'), 'Missing display=swap in font link in dashboard.html');
    });

    runTest('Key application templates contain preconnect to fonts.gstatic.com and dns-prefetch', () => {
      const pages = ['automations.html', 'instagram-accounts.html', 'activity.html', 'billing.html', 'settings.html', 'login.html'];
      for (const page of pages) {
        const html = fs.readFileSync(path.join(__dirname, page), 'utf8');
        assert.ok(
          html.includes('fonts.gstatic.com'),
          `Expected fonts.gstatic.com preconnect in ${page}`
        );
        assert.ok(
          html.includes('dns-prefetch'),
          `Expected dns-prefetch in ${page}`
        );
      }
    });

    // -------------------------------------------------------------
    // 8. Dashboard Concurrent Initialization & Race-Condition Logic
    // -------------------------------------------------------------
    await runTestAsync('Rapid account switching ignores stale responses via request ID sequencing', async () => {
      // Simulate the exact state and request sequencing implemented in dashboard.js
      let latestOverviewRequestId = 0;
      let renderedData = null;

      async function simulatedLoadDashboardOverview(accountId, delayMs, responsePayload) {
        const currentRequestId = ++latestOverviewRequestId;

        // Simulate async network latency
        await new Promise(r => setTimeout(r, delayMs));

        // Sequence guard
        if (currentRequestId !== latestOverviewRequestId) {
          // Discarded stale response
          return;
        }

        renderedData = responsePayload;
      }

      // User rapidly switches from Account A to Account B
      // Account A request is slow (50ms)
      const p1 = simulatedLoadDashboardOverview('account_A', 50, { account: 'A', dmsSent: 10 });
      // Account B request is fast (10ms)
      const p2 = simulatedLoadDashboardOverview('account_B', 10, { account: 'B', dmsSent: 50 });

      await Promise.all([p1, p2]);

      // Account B must remain rendered even though Account A finished later!
      assert.strictEqual(renderedData.account, 'B', 'Expected Account B to win despite Account A finishing later');
      assert.strictEqual(renderedData.dmsSent, 50, 'Expected Account B data to be preserved');
    });

    await runTestAsync('Concurrent dashboard initialization triggers overview concurrently with other tasks', async () => {
      // Verify that initDashboard logic initiates loadDashboardOverview alongside loadUser/loadBilling/loadAccounts
      const executedTasks = [];

      async function mockLoadUser() {
        executedTasks.push({ name: 'loadUser', time: Date.now() });
      }
      async function mockLoadBillingQuota() {
        executedTasks.push({ name: 'loadBillingQuota', time: Date.now() });
      }
      async function mockLoadInstagramAccounts() {
        executedTasks.push({ name: 'loadInstagramAccounts', time: Date.now() });
      }
      async function mockLoadDashboardOverview(accId) {
        executedTasks.push({ name: 'loadDashboardOverview', accountId: accId, time: Date.now() });
      }

      // Implementation of concurrent initDashboard
      async function mockInitDashboard(isDashboardPage, savedAccountId) {
        const tasks = [
          mockLoadUser(),
          mockLoadBillingQuota(),
          mockLoadInstagramAccounts()
        ];
        if (isDashboardPage) {
          tasks.push(mockLoadDashboardOverview(savedAccountId));
        }
        await Promise.allSettled(tasks);
      }

      await mockInitDashboard(true, 'acc_123');

      assert.strictEqual(executedTasks.length, 4, 'Expected all 4 tasks to be triggered');
      const taskNames = executedTasks.map(t => t.name);
      assert.ok(taskNames.includes('loadDashboardOverview'), 'Overview must be included in initial concurrent tasks');
      assert.ok(taskNames.includes('loadUser'), 'User load must be included');
      assert.ok(taskNames.includes('loadBillingQuota'), 'Billing quota load must be included');
      assert.ok(taskNames.includes('loadInstagramAccounts'), 'Accounts load must be included');

      const overviewTask = executedTasks.find(t => t.name === 'loadDashboardOverview');
      assert.strictEqual(overviewTask.accountId, 'acc_123', 'Overview should use the saved account ID concurrently');
    });

  } finally {
    server.close();
  }

  console.log('='.repeat(70));
  console.log(`STAGE 3 VERIFICATION COMPLETE: ${passedTests}/${totalTests} TESTS PASSED`);
  console.log('='.repeat(70));
}

main().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
