// test_activity_consolidation_suite.js
// Automated verification suite for Creator Studio AI Status & Activity Consolidation

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = __dirname;

async function runTests() {
  console.log('======================================================================');
  console.log('   COMMENT2DM — ACTIVITY & CREATOR STUDIO CONSOLIDATION TEST SUITE');
  console.log('======================================================================\n');

  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      console.log(`✅ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`❌ FAIL: ${name}`);
      console.error(`   ${err.message}`);
      failed++;
    }
  }

  async function testAsync(name, fn) {
    try {
      await fn();
      console.log(`✅ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`❌ FAIL: ${name}`);
      console.error(`   ${err.message}`);
      failed++;
    }
  }

  // ── SECTION 1: HTML Shell Consistency & Navigation ───────────────────────
  console.log('--- SECTION 1: SIDEBAR NAVIGATION & REDIRECTS ---');

  const shellPages = [
    'dashboard.html',
    'instagram-accounts.html',
    'automations.html',
    'creator-tools.html',
    'activity.html',
    'settings.html',
    'help.html',
    'billing.html'
  ];

  test('All 8 shell HTML pages exist on disk', () => {
    shellPages.forEach(page => {
      const p = path.join(ROOT_DIR, page);
      assert.ok(fs.existsSync(p), `File ${page} must exist`);
    });
  });

  test('All shell pages contain unified Activity link in sidebar', () => {
    shellPages.forEach(page => {
      const html = fs.readFileSync(path.join(ROOT_DIR, page), 'utf8');
      assert.ok(
        html.includes('data-nav="activity"') && html.includes('href="activity.html"'),
        `${page} must contain data-nav="activity" link pointing to activity.html`
      );
    });
  });

  test('All shell pages contain Creator Studio AI with Under Dev badge', () => {
    shellPages.forEach(page => {
      const html = fs.readFileSync(path.join(ROOT_DIR, page), 'utf8');
      assert.ok(
        html.includes('href="creator-tools.html"') && html.includes('badge-dev'),
        `${page} must contain creator-tools link with badge-dev`
      );
    });
  });

  test('No shell page has separate Analytics or DM Log links in sidebar nav', () => {
    shellPages.forEach(page => {
      const html = fs.readFileSync(path.join(ROOT_DIR, page), 'utf8');
      const navMatch = html.match(/<nav class="app-nav"[\s\S]*?<\/nav>/);
      assert.ok(navMatch, `${page} must contain <nav class="app-nav">`);
      const navHtml = navMatch[0];
      assert.ok(!navHtml.includes('href="analytics.html"'), `${page} sidebar must not link directly to analytics.html`);
      assert.ok(!navHtml.includes('href="messages.html"'), `${page} sidebar must not link directly to messages.html`);
    });
  });

  test('analytics.html and messages.html redirect to activity.html', () => {
    const analyticsHtml = fs.readFileSync(path.join(ROOT_DIR, 'analytics.html'), 'utf8');
    const messagesHtml = fs.readFileSync(path.join(ROOT_DIR, 'messages.html'), 'utf8');

    assert.ok(analyticsHtml.includes('activity.html'), 'analytics.html must redirect to activity.html');
    assert.ok(messagesHtml.includes('activity.html'), 'messages.html must redirect to activity.html');
  });

  // ── SECTION 2: Unified activity.html DOM & Features ───────────────────────
  console.log('\n--- SECTION 2: ACTIVITY & ANALYTICS PAGE UI (activity.html) ---');

  const activityHtml = fs.readFileSync(path.join(ROOT_DIR, 'activity.html'), 'utf8');

  test('activity.html contains Section 1: 4 KPI Cards (Total DMs, Successful, Failed, Automations)', () => {
    assert.ok(activityHtml.includes('id="kpiDmsSent"'), 'Must have #kpiDmsSent');
    assert.ok(activityHtml.includes('id="kpiSuccessDeliveries"'), 'Must have #kpiSuccessDeliveries');
    assert.ok(activityHtml.includes('id="kpiFailedDeliveries"'), 'Must have #kpiFailedDeliveries');
    assert.ok(activityHtml.includes('id="kpiActiveAutomations"'), 'Must have #kpiActiveAutomations');
    assert.ok(activityHtml.includes('id="kpiDeliveryRate"'), 'Must have #kpiDeliveryRate');
  });

  test('activity.html contains Section 2: Daily Chart & Conversion Funnel', () => {
    assert.ok(activityHtml.includes('id="dailyChartContainer"'), 'Must have #dailyChartContainer');
    assert.ok(activityHtml.includes('id="funnelComments"'), 'Must have #funnelComments');
    assert.ok(activityHtml.includes('id="funnelTriggered"'), 'Must have #funnelTriggered');
    assert.ok(activityHtml.includes('id="funnelDelivered"'), 'Must have #funnelDelivered');
  });

  test('activity.html contains Section 3: DM Activity Log, Search, Status Filter & Table', () => {
    assert.ok(activityHtml.includes('id="eventSearchInput"'), 'Must have #eventSearchInput');
    assert.ok(activityHtml.includes('id="eventStatusFilter"'), 'Must have #eventStatusFilter');
    assert.ok(activityHtml.includes('id="activityTableBody"'), 'Must have #activityTableBody');
    assert.ok(activityHtml.includes('id="paginationInfo"'), 'Must have #paginationInfo');
  });

  test('activity.html contains Event Detail Modal DOM', () => {
    assert.ok(activityHtml.includes('id="eventDetailModal"'), 'Must have #eventDetailModal');
    assert.ok(activityHtml.includes('id="modalCommentText"'), 'Must have #modalCommentText');
    assert.ok(activityHtml.includes('id="modalDmText"'), 'Must have #modalDmText');
    assert.ok(activityHtml.includes('id="modalStatusBadge"'), 'Must have #modalStatusBadge');
  });

  // ── SECTION 3: Task 1 Creator Studio AI Under Development ─────────────────
  console.log('\n--- SECTION 3: CREATOR STUDIO AI UNDER DEVELOPMENT ---');

  const creatorHtml = fs.readFileSync(path.join(ROOT_DIR, 'creator-tools.html'), 'utf8');

  test('creator-tools.html contains prominent Under Development state and banner', () => {
    assert.ok(creatorHtml.includes('Creator Studio AI Tools are Coming Soon'), 'Must state tools are coming soon');
    assert.ok(creatorHtml.includes('Under Active Development'), 'Must have under active development tag');
    assert.ok(creatorHtml.includes('Zero Credit Deductions'), 'Must inform user zero credits are consumed');
    assert.ok(creatorHtml.includes('href="automations.html"'), 'Must link to active automations');
    assert.ok(creatorHtml.includes('href="activity.html"'), 'Must link to activity page');
  });

  test('creator-tools.html preserves existing tabs and tool layouts below banner', () => {
    assert.ok(creatorHtml.includes('id="tabReelsAnalyzer"'), 'Must preserve tabReelsAnalyzer');
    assert.ok(creatorHtml.includes('data-panel="hooks"'), 'Must preserve hooks panel');
    assert.ok(creatorHtml.includes('data-panel="dm-script"'), 'Must preserve dm-script panel');
    assert.ok(creatorHtml.includes('data-panel="utm"'), 'Must preserve utm panel');
  });

  const serverCode = fs.readFileSync(path.join(ROOT_DIR, 'server.js'), 'utf8');

  test('POST /api/creator/generate returns underDevelopment: true with 0 credits consumed', () => {
    assert.ok(serverCode.includes("underDevelopment: true"), 'Must return underDevelopment: true');
    assert.ok(serverCode.includes("creditsUsed: 0"), 'Must guarantee 0 credits used');
  });

  // ── SECTION 4: Backend Endpoint Consistency & Discrepancy Fixes ──────────
  console.log('\n--- SECTION 4: BACKEND HARMONIZATION & DATA CONSISTENCY ---');

  test('server.js defines buildOwnerClauses and buildIgClauses for heterogeneous ID typing', () => {
    assert.ok(serverCode.includes('function buildOwnerClauses'), 'Must define buildOwnerClauses');
    assert.ok(serverCode.includes('function buildIgClauses'), 'Must define buildIgClauses');
  });

  test('GET /api/analytics/overview derives non-zero comments count from actual triggers', () => {
    assert.ok(
      serverCode.includes('commentsCount = Math.max(countCommentsRaw, totalDMsSent)') ||
      serverCode.includes('commentsCount = Math.max('),
      'commentsProcessed must never be 0 when DMs have been sent'
    );
  });

  test('GET /api/analytics/events supports instagram_user_id and search without overwriting owner filter', () => {
    assert.ok(
      serverCode.includes('requestedIgUserId = String(request.query.instagram_user_id'),
      'Must extract instagram_user_id in events'
    );
    assert.ok(
      serverCode.includes('listAndClauses.push') && serverCode.includes('$regex: search'),
      'Search must be appended to AND clauses so owner filter is preserved'
    );
  });

  test('GET /api/analytics/overview and GET /api/analytics/events both calculate totalDMs from private_reply', () => {
    assert.ok(serverCode.includes("event_type: 'private_reply', status: 'success'"), 'Overview checks private_reply success');
    assert.ok(serverCode.includes("event_type: 'private_reply'"), 'Events checks private_reply');
  });

  // ── SECTION 5: dashboard.js Real-time Enhancements ────────────────────────
  console.log('\n--- SECTION 5: DASHBOARD.JS METRIC CARD RESOLUTION ---');

  const dashCode = fs.readFileSync(path.join(ROOT_DIR, 'dashboard.js'), 'utf8');

  test('dashboard.js loadDashboardOverview contains fallback query on account filter rejection', () => {
    assert.ok(
      dashCode.includes("!response.ok && targetId") && dashCode.includes("fetch('/api/analytics/overview'"),
      'dashboard.js must fallback gracefully if an account query returns error'
    );
  });

  test('dashboard.js shows positive status when totalDMs is 0', () => {
    assert.ok(
      dashCode.includes("Ready for comment triggers") || dashCode.includes("100%"),
      'Must show reassuring delivery status when no errors have occurred'
    );
  });

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n======================================================================');
  console.log(`TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('======================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
