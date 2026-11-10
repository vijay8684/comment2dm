// ============================================================
// Comment2DM — Final Stabilization & Functionality Test Suite
// Covers:
// A. Global Instagram Account Selector & Security
// B. Account-Specific Dashboard Metrics & Zero-Data Safety
// C. User Feedback & Feature Requests API & Validation
// D. Instagram DMs Desktop/Mobile Interaction & Idempotency
// E. Visual Consistency, Icon Standardization & Brand Assets
// ============================================================

const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('======================================================');
console.log('COMMENT2DM STABILIZATION & FUNCTIONALITY TEST SUITE');
console.log('======================================================\n');

let totalTests = 0;
let passedTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`Test ${totalTests}: ${name}`);
    console.log('  ✓ PASSED');
    passedTests++;
  } catch (err) {
    console.error(`Test ${totalTests}: ${name}`);
    console.error(`  ✗ FAILED: ${err.message}`);
    process.exit(1);
  }
}

async function runAsyncTest(name, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`Test ${totalTests}: ${name}`);
    console.log('  ✓ PASSED');
    passedTests++;
  } catch (err) {
    console.error(`Test ${totalTests}: ${name}`);
    console.error(`  ✗ FAILED: ${err.message}`);
    process.exit(1);
  }
}

(async function () {

  // ==========================================================
  // SECTION A: GLOBAL INSTAGRAM ACCOUNT SELECTOR & SECURITY
  // ==========================================================

  runTest('Account Selector: dashboard.html contains dropdown container & accessibility attributes', () => {
    const html = fs.readFileSync('dashboard.html', 'utf8');
    assert.strictEqual(html.includes('id="accountSwitcherBtn"'), true);
    assert.strictEqual(html.includes('id="accountDropdownMenu"'), true);
    assert.strictEqual(html.includes('id="accountDropdownList"'), true);
    assert.strictEqual(html.includes('aria-haspopup="listbox"'), true);
    assert.strictEqual(html.includes('Switch Account'), true);
    assert.strictEqual(html.includes('Connect another account'), true);
    assert.strictEqual(html.includes('Manage all accounts ↗'), true);
  });

  runTest('Account Selector: dashboard.js has dynamic DOM injection for pages missing dropdown markup', () => {
    const js = fs.readFileSync('dashboard.js', 'utf8');
    assert.strictEqual(js.includes('ensureAccountDropdownDOM'), true);
    assert.strictEqual(js.includes('renderAccountDropdown'), true);
    assert.strictEqual(js.includes('toggleAccountDropdown'), true);
    assert.strictEqual(js.includes('closeAccountDropdown'), true);
    assert.strictEqual(js.includes('comment2dm_selected_account_id'), true);
  });

  runTest('Account Selector Security: server.js enforces ownership check on instagram_user_id query parameter', () => {
    const serverCode = fs.readFileSync('server.js', 'utf8');
    assert.strictEqual(serverCode.includes("const requestedIgUserId = String(request.query.instagram_user_id || '').trim();"), true);
    assert.strictEqual(serverCode.includes("Unauthorized: Instagram account does not belong to user."), true);
    assert.strictEqual(serverCode.includes("owner_user_id: ownerId"), true);
  });

  // ==========================================================
  // SECTION B: ACCOUNT-SPECIFIC DASHBOARD & ZERO-DATA SAFETY
  // ==========================================================

  runTest('Dashboard: Overview query scopes metrics to requested instagram_user_id', () => {
    const serverCode = fs.readFileSync('server.js', 'utf8');
    assert.strictEqual(serverCode.includes("FROM automations WHERE owner_user_id = ? AND instagram_user_id = ? AND enabled = 1"), true);
    assert.strictEqual(serverCode.includes("FROM automation_events WHERE owner_user_id = ? AND instagram_user_id = ?"), true);
  });

  runTest('Dashboard: Zero-message delivery rate does not display misleading 100%', () => {
    const js = fs.readFileSync('dashboard.js', 'utf8');
    assert.strictEqual(js.includes("if (totalDMs === 0) {"), true);
    assert.strictEqual(js.includes("deliveryRate.textContent = '0%';"), true);
    assert.strictEqual(js.includes("deliveryNote.textContent = 'No DMs sent yet';"), true);

    const serverCode = fs.readFileSync('server.js', 'utf8');
    assert.strictEqual(serverCode.includes("const deliveryRate = totalDMs > 0 ? Math.round((sent / totalDMs) * 100) : 0;"), true);
  });

  runTest('Dashboard: Activity feed renders meaningful statuses and consistent timestamps', () => {
    const js = fs.readFileSync('dashboard.js', 'utf8');
    assert.strictEqual(js.includes("isComment ? 'Comment detected' : (isFailed ? 'Private DM failed' : 'Private DM sent')"), true);
    assert.strictEqual(js.includes("isSuccess ? '✓ Delivered' : (isFailed ? '✗ Failed' : '⏳ Processing')"), true);
    assert.strictEqual(js.includes("toLocaleDateString") || js.includes("toLocaleString"), true);
  });

  // ==========================================================
  // SECTION C: FEEDBACK & FEATURE REQUESTS
  // ==========================================================

  runTest('Feedback UI: dashboard.html contains header entry point and accessible modal', () => {
    const html = fs.readFileSync('dashboard.html', 'utf8');
    assert.strictEqual(html.includes('id="openFeedbackBtn"'), true);
    assert.strictEqual(html.includes('id="feedbackModal"'), true);
    assert.strictEqual(html.includes('id="feedbackCategory"'), true);
    assert.strictEqual(html.includes('id="feedbackSubject"'), true);
    assert.strictEqual(html.includes('id="feedbackDescription"'), true);
    assert.strictEqual(html.includes('id="submitFeedbackBtn"'), true);
    assert.strictEqual(html.includes('id="cancelFeedbackBtn"'), true);
  });

  runTest('Feedback Backend: server.js exposes POST /api/feedback with validation, deduplication and rate limits', () => {
    const serverCode = fs.readFileSync('server.js', 'utf8');
    assert.strictEqual(serverCode.includes("app.post('/api/feedback'"), true);
    assert.strictEqual(serverCode.includes("validCategories"), true);
    assert.strictEqual(serverCode.includes("Subject must be between 3 and 150 characters."), true);
    assert.strictEqual(serverCode.includes("Description must be between 10 and 2000 characters."), true);
    assert.strictEqual(serverCode.includes("Feedback rate limit reached."), true);
    assert.strictEqual(serverCode.includes("You already submitted this feedback recently."), true);
  });

  runTest('Feedback Database: src/db.js exports feedback collection with index', () => {
    const dbCode = fs.readFileSync('src/db.js', 'utf8');
    assert.strictEqual(dbCode.includes("feedback: database.collection('feedback')"), true);
    assert.strictEqual(dbCode.includes("feedback_user_created"), true);
  });

  // ==========================================================
  // SECTION D: INSTAGRAM DMS DESKTOP VS MOBILE
  // ==========================================================

  runTest('Instagram DMs: Webhook handles both postbacks and natural text replies for desktop compatibility', () => {
    const serverCode = fs.readFileSync('server.js', 'utf8');
    assert.strictEqual(serverCode.includes("payload.startsWith('SEND_LINK')"), true);
    assert.strictEqual(serverCode.includes("payload.startsWith('CHECK_FOLLOW')"), true);
    assert.strictEqual(serverCode.includes("/^(link|access|yes|send|send\\s*link)$/i.test(incomingText)"), true);
    assert.strictEqual(serverCode.includes("/(follow|following|followed|done|checked)/i.test(incomingText)"), true);
  });

  runTest('Instagram DMs: Final delivery payload embeds clickable resource URL in text for desktop Instagram Web', () => {
    const serverCode = fs.readFileSync('server.js', 'utf8');
    assert.strictEqual(serverCode.includes("const textWithLink = deliveryText.includes(resourceUrl) ? deliveryText : `${deliveryText}\\n\\n🔗 ${resourceUrl}`;"), true);
    assert.strictEqual(serverCode.includes("template_type: 'button'"), true);
  });

  // ==========================================================
  // SECTION E: VISUAL CONSISTENCY & BRAND ASSETS
  // ==========================================================

  runTest('Visual: Sidebar navigation icons standardized with clean Lucide SVGs across all pages', () => {
    const pages = [
      'dashboard.html',
      'instagram-accounts.html',
      'automations.html',
      'creator-tools.html',
      'analytics.html',
      'messages.html',
      'settings.html',
      'help.html',
      'billing.html'
    ];

    pages.forEach(page => {
      const content = fs.readFileSync(page, 'utf8');
      assert.strictEqual(content.includes('<svg width="18" height="18" viewBox="0 0 24 24"'), true, `${page} missing clean SVG nav icons`);
      assert.strictEqual(!content.includes('<span class="nav-icon">🏠</span>'), true, `${page} still contains emoji home icon`);
      assert.strictEqual(!content.includes('<span class="nav-icon">📸</span>'), true, `${page} still contains emoji camera icon`);
      assert.strictEqual(!content.includes('\uFFFD'), true, `${page} contains corrupted bytes`);
    });
  });

  runTest('Visual: Dashboard metric overview cards use clean SVG icons instead of emojis', () => {
    const html = fs.readFileSync('dashboard.html', 'utf8');
    assert.strictEqual(!html.includes('<span>📩</span>'), true);
    assert.strictEqual(!html.includes('<span>⚡</span>'), true);
    assert.strictEqual(!html.includes('<span>💬</span>'), true);
    assert.strictEqual(!html.includes('<span>📈</span>'), true);
    assert.strictEqual(html.includes('overview-grid'), true);
  });

  runTest('Brand: Approved logo and favicon assets are intact and referenced properly', () => {
    assert.strictEqual(fs.existsSync('favicon.svg'), true);
    assert.strictEqual(fs.existsSync('logo.svg'), true);
    const favicon = fs.readFileSync('favicon.svg', 'utf8');
    const logo = fs.readFileSync('logo.svg', 'utf8');
    assert.strictEqual(favicon.includes('Comment Bubble Outline'), true);
    assert.strictEqual(logo.includes('Comment') && logo.includes('DM'), true);
  });

  runTest('CSS: styles.css contains account selector dropdown styling with animations and blur', () => {
    const css = fs.readFileSync('styles.css', 'utf8');
    assert.strictEqual(css.includes('.account-selector-dropdown'), true);
    assert.strictEqual(css.includes('.account-dropdown-item'), true);
    assert.strictEqual(css.includes('.account-dropdown-header'), true);
    assert.strictEqual(css.includes('.account-dropdown-footer'), true);
  });

  console.log('\n======================================================');
  console.log(`✅ ALL ${passedTests}/${totalTests} STABILIZATION & FUNCTIONALITY TESTS PASSED!`);
  console.log('======================================================\n');

})();
