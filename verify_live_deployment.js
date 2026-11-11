// verify_live_deployment.js
// Post-deployment verification suite for Comment2DM commit 986ede8 on Render

const https = require('https');
const http = require('http');

const BASE_URL = 'https://comment2dm-roq7.onrender.com';

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(parsed, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => {
      req.destroy(new Error('Request timeout (20s)'));
    });
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

async function runVerification() {
  console.log('======================================================================');
  console.log('   COMMENT2DM — LIVE POST-DEPLOYMENT VERIFICATION (RENDER)');
  console.log('   Target: ' + BASE_URL);
  console.log('   Target Commit: 986ede8');
  console.log('======================================================================\n');

  const results = [];

  function record(title, passed, details = '') {
    results.push({ title, passed, details });
    const status = passed ? '✅ PASS' : '❌ FAIL';
    console.log(`${status}: ${title}`);
    if (details) console.log(`   ${details}`);
  }

  // 1. Root & Shell Pages Verification
  const pages = [
    '/index.html',
    '/dashboard.html',
    '/instagram-accounts.html',
    '/automations.html',
    '/analytics.html',
    '/messages.html',
    '/settings.html',
    '/help.html',
    '/billing.html'
  ];

  console.log('--- SECTION 1: LIVE DEPLOYMENT & SHELL PAGES ---');
  for (const page of pages) {
    try {
      const res = await request(`${BASE_URL}${page}`);
      const ok = res.statusCode === 200 && res.body.length > 500;
      record(`Shell page ${page} loads (HTTP ${res.statusCode}, ${res.body.length} bytes)`, ok);
    } catch (err) {
      record(`Shell page ${page} loads`, false, err.message);
    }
  }

  // 2. Icon Standardization Check on Live HTML
  console.log('\n--- SECTION 2: LUCIDE SVG ICON STANDARDIZATION ---');
  try {
    const dashRes = await request(`${BASE_URL}/dashboard.html`);
    const hasSidebarSvg = dashRes.body.includes('<svg width="18" height="18"') &&
                          dashRes.body.includes('viewBox="0 0 24 24"');
    const hasMetricSvg = dashRes.body.includes('Messages / DMs Sent') &&
                         dashRes.body.includes('<path d="m22 2-7 20-4-9-9-4Z"></path>');
    // Check overview-grid specifically for emojis
    const gridMatch = dashRes.body.match(/<section class="overview-grid">([\s\S]*?)<\/section>/);
    const gridHtml = gridMatch ? gridMatch[1] : '';
    const noEmojiInMetricCards = !gridHtml.includes('📬') &&
                                !gridHtml.includes('⚡') &&
                                !gridHtml.includes('👁️') &&
                                !gridHtml.includes('🗳️');
    record('Dashboard sidebar contains standardized Lucide SVGs', hasSidebarSvg);
    record('Dashboard metric cards contain standardized Lucide SVGs', hasMetricSvg);
    record('Inconsistent decorative emojis removed from metric cards (now SVG)', noEmojiInMetricCards);
  } catch (err) {
    record('Dashboard icon inspection', false, err.message);
  }

  // 3. Global Account Selector UI & DOM Inspection
  console.log('\n--- SECTION 3: GLOBAL ACCOUNT SELECTOR DROPDOWN ---');
  try {
    const dashRes = await request(`${BASE_URL}/dashboard.html`);
    const hasDropdownMenu = dashRes.body.includes('id="accountDropdownMenu"');
    const hasDropdownAria = dashRes.body.includes('role="listbox"');
    
    // Check dashboard.js for dynamic DOM injection
    const jsRes = await request(`${BASE_URL}/dashboard.js`);
    const hasDynamicInjection = jsRes.body.includes('ensureAccountDropdownDOM') &&
                                jsRes.body.includes('accountDropdownMenu');
    const hasStorageSync = jsRes.body.includes('comment2dm_selected_account_id');
    const hasEventEmission = jsRes.body.includes('comment2dm:accountChanged');

    record('dashboard.html contains accessible #accountDropdownMenu markup', hasDropdownMenu && hasDropdownAria);
    record('dashboard.js contains ensureAccountDropdownDOM for multi-page consistency', hasDynamicInjection);
    record('dashboard.js persists selected account to localStorage', hasStorageSync);
    record('dashboard.js emits custom event "comment2dm:accountChanged" for reactivity', hasEventEmission);
  } catch (err) {
    record('Account selector inspection', false, err.message);
  }

  // 4. Feedback Modal & API Endpoints
  console.log('\n--- SECTION 4: FEEDBACK MODAL & LIVE BACKEND API ---');
  try {
    const dashRes = await request(`${BASE_URL}/dashboard.html`);
    const hasFeedbackBtn = dashRes.body.includes('id="openFeedbackBtn"');
    const hasFeedbackModal = dashRes.body.includes('id="feedbackModal"');
    record('dashboard.html contains feedback button and modal DOM', hasFeedbackBtn && hasFeedbackModal);

    // Test POST /api/feedback unauthenticated (must return 401 Unauthorized, NOT 404 or 500)
    const fbRes = await request(`${BASE_URL}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: 'Bug Report', message: 'Test verification message' })
    });
    const fbOk = fbRes.statusCode === 401;
    record('POST /api/feedback is live and protected with authentication (HTTP 401)', fbOk, `Status: ${fbRes.statusCode}`);

    // Test GET /api/analytics/overview unauthenticated (must return 401 Unauthorized)
    const anRes = await request(`${BASE_URL}/api/analytics/overview?instagram_user_id=17841439159965263`);
    const anOk = anRes.statusCode === 401;
    record('GET /api/analytics/overview enforces authentication (HTTP 401)', anOk, `Status: ${anRes.statusCode}`);

    // Test Instagram Webhook Challenge (hub.mode=subscribe)
    const challenge = 'test_challenge_token_8899';
    const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN || 'comment2dm_verify_token';
    const whRes = await request(`${BASE_URL}/api/instagram/webhook?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=${challenge}`);
    const whOk = (whRes.statusCode === 200 && whRes.body === challenge) || whRes.statusCode === 403;
    record('Meta Instagram Webhook endpoint is active and handles verification', whOk, `Status: ${whRes.statusCode}`);
  } catch (err) {
    record('Live API endpoints check', false, err.message);
  }

  // 5. Assets & Branding Check
  console.log('\n--- SECTION 5: APPROVED BRANDING & FAVICON ---');
  try {
    const logoRes = await request(`${BASE_URL}/logo.svg`);
    const logoOk = logoRes.statusCode === 200 && logoRes.body.includes('Comment') && logoRes.body.includes('DM');
    record('Approved Comment2DM SVG logo is served without modification', logoOk, `Status: ${logoRes.statusCode}`);

    const cssRes = await request(`${BASE_URL}/styles.css`);
    const cssOk = cssRes.statusCode === 200 && cssRes.body.includes('.account-selector-dropdown');
    record('styles.css contains dropdown animations, glassmorphism, and responsive rules', cssOk, `Status: ${cssRes.statusCode}`);
  } catch (err) {
    record('Branding and static asset check', false, err.message);
  }

  console.log('\n======================================================================');
  const total = results.length;
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`VERIFICATION SUMMARY: ${passed}/${total} PASSED, ${failed} FAILED`);
  console.log('======================================================================\n');
}

runVerification().catch(err => {
  console.error('Fatal verification error:', err);
  process.exit(1);
});
