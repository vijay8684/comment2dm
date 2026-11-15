/**
 * test_analytics_and_ui_consistency_suite.js
 * Comprehensive automated verification test suite for Comment2DM:
 * 1. Outbound Private DM Event Classification (delivery_channel: 'private_dm', created_at_date, status handling)
 * 2. Public Comment Reply Isolation (delivery_channel: 'public_comment', excluded from DM metrics & DM activity log)
 * 3. Analytics Overview & Delivery Rate calculation (null/neutral when 0 DMs)
 * 4. Tooltip integration on KPI tiles and conversion funnels
 * 5. Sidebar icon distinction across all 8 application pages (Automations workflow icon vs Settings gear icon)
 * 6. Instant Anti-FOUC Theme Sync script presence across all 8 pages
 * 7. Standardized Header User Menu across all pages
 * 8. Frontend neutral states for 0 DMs in activity.js and dashboard.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

let passedTests = 0;
let totalTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`  ✓ PASS: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(`    ${err.message}`);
  }
}

console.log('================================================================');
console.log('Comment2DM: Analytics Accuracy, Delivery Tracking & UI Test Suite');
console.log('================================================================\n');

const repoDir = __dirname;
const htmlFiles = [
  'dashboard.html',
  'automations.html',
  'activity.html',
  'creator-tools.html',
  'instagram-accounts.html',
  'settings.html',
  'help.html',
  'billing.html'
];

// Test 1: Anti-FOUC Theme Sync Script in all 8 HTML files
console.log('--- 1. Anti-FOUC Theme Sync Verification ---');
htmlFiles.forEach(file => {
  runTest(`${file} contains Anti-FOUC theme sync script in <head>`, () => {
    const content = fs.readFileSync(path.join(repoDir, file), 'utf8');
    assert(content.includes('comment2dm_theme'), `${file} missing comment2dm_theme storage check`);
    assert(content.includes('data-theme'), `${file} missing data-theme attribute application`);
  });
});

// Test 2: Sidebar Navigation Icon Distinctiveness (Workflow icon for Automations vs Gear for Settings)
console.log('\n--- 2. Sidebar Navigation Distinctiveness Verification ---');
const workflowNodeSignature = '<rect x="3" y="3"';
const gearCircleSignature = '<circle cx="12" cy="12" r="3"';

htmlFiles.forEach(file => {
  runTest(`${file} has distinct Automations (workflow) and Settings (gear) icons`, () => {
    const content = fs.readFileSync(path.join(repoDir, file), 'utf8');
    
    // Automations nav link check
    const autoNavMatch = content.match(/<a [^>]*href="automations\.html"[^>]*>([\s\S]*?)<\/a>/);
    assert(autoNavMatch, `${file} missing href="automations.html" nav link`);
    assert(autoNavMatch[1].includes(workflowNodeSignature), `${file} automations nav link does not use workflow nodes icon`);
    assert(!autoNavMatch[1].includes(gearCircleSignature), `${file} automations nav link still uses settings gear icon!`);

    // Settings nav link check
    const settingsNavMatch = content.match(/<a [^>]*href="settings\.html"[^>]*>([\s\S]*?)<\/a>/);
    assert(settingsNavMatch, `${file} missing href="settings.html" nav link`);
    assert(settingsNavMatch[1].includes(gearCircleSignature), `${file} settings nav link does not use gear icon`);
  });
});

// Test 3: Tooltips on activity.html (KPIs and Funnel)
console.log('\n--- 3. Activity Page KPI & Funnel Tooltips Verification ---');
runTest('activity.html has tooltips on all 4 KPI cards and 3 funnel steps', () => {
  const content = fs.readFileSync(path.join(repoDir, 'activity.html'), 'utf8');
  assert(content.includes('Total DMs Sent'), 'Missing Total DMs Sent');
  assert(content.includes('Total direct messages initiated by Comment2DM automations.'), 'Missing Total DMs tooltip');
  assert(content.includes('Messages confirmed as accepted and delivered by the Meta Instagram Graph API.'), 'Missing Successful Deliveries tooltip');
  assert(content.includes('Messages that Meta rejected due to messaging window closure'), 'Missing Failed Deliveries tooltip');
  assert(content.includes('Number of active comment-to-DM automation rules currently listening for triggers.'), 'Missing Active Automations tooltip');
  assert(content.includes('Total comments received and analyzed across your connected posts and reels.'), 'Missing Comments Processed tooltip');
  assert(content.includes('Comments that matched automation keywords and rule conditions to initiate DM workflows.'), 'Missing DMs Triggered tooltip');
  assert(content.includes('Confirmed outbound messages successfully received in commenter direct message inboxes.'), 'Missing Delivered to Inbox tooltip');
});

// Test 4: Tooltips on dashboard.html (KPI Cards)
console.log('\n--- 4. Dashboard KPI Tooltips Verification ---');
runTest('dashboard.html has tooltips on all 4 metric overview cards', () => {
  const content = fs.readFileSync(path.join(repoDir, 'dashboard.html'), 'utf8');
  assert(content.includes('Total direct messages initiated by Comment2DM automations.'), 'Missing Messages Sent tooltip');
  assert(content.includes('Number of active comment-to-DM automation rules currently listening for triggers.'), 'Missing Active Automations tooltip');
  assert(content.includes('Total comments received and analyzed across your connected posts and reels.'), 'Missing Comments Processed tooltip');
  assert(content.includes('Percentage of direct messages confirmed as accepted and delivered by Instagram.'), 'Missing Delivery Success Rate tooltip');
});

// Test 5: Server.js Backend Event Logging & Public Comment Reply Separation
console.log('\n--- 5. Backend Event Classification & Public Reply Separation ---');
runTest('server.js deliverFinalResource sets private_dm channel, created_at_date, and handles unknown status', () => {
  const serverCode = fs.readFileSync(path.join(repoDir, 'server.js'), 'utf8');
  assert(serverCode.includes("delivery_channel: 'private_dm'"), "Missing delivery_channel: 'private_dm'");
  assert(serverCode.includes("created_at_date: new Date()"), "Missing created_at_date in event logging");
  assert(serverCode.includes("status: isUnknownOutcome ? 'unknown' : 'failed'"), "Missing unknown status handling on unconfirmed delivery error");
});

runTest('server.js executeCommentJob classifies private DM vs public comment reply', () => {
  const serverCode = fs.readFileSync(path.join(repoDir, 'server.js'), 'utf8');
  assert(serverCode.includes("delivery_channel: 'public_comment'"), "Missing delivery_channel: 'public_comment' for public comment replies");
  assert(serverCode.includes("event_type: 'public_reply'"), "Missing event_type: 'public_reply'");
});

runTest('server.js /api/analytics/overview strictly isolates private DMs from public replies', () => {
  const serverCode = fs.readFileSync(path.join(repoDir, 'server.js'), 'utf8');
  assert(serverCode.includes("delivery_channel: { $ne: 'public_comment' }"), "Overview endpoint must exclude public_comment channel");
  assert(serverCode.includes("event_type: { $ne: 'public_reply' }"), "Overview endpoint must exclude public_reply event type");
  assert(serverCode.includes("const deliveryRate = totalDMs > 0 ? Math.round((sent / totalDMs) * 100) : null;"), "Delivery rate must be null when totalDMs is 0");
});

runTest('server.js /api/analytics/events strictly excludes public replies from Direct Message Activity Log', () => {
  const serverCode = fs.readFileSync(path.join(repoDir, 'server.js'), 'utf8');
  // Check that public_reply is excluded in baseFilter
  assert(serverCode.includes("delivery_channel: 'private_dm'"), "Events baseFilter must specify private_dm");
  assert(serverCode.includes("event_type: { $ne: 'public_reply' }"), "Events list query must exclude public_reply");
});

// Test 6: Frontend Zero Delivery Rate Handling
console.log('\n--- 6. Frontend Zero / Neutral Delivery Rate Handling ---');
runTest('activity.js displays neutral state when totalDMs === 0', () => {
  const actCode = fs.readFileSync(path.join(repoDir, 'activity.js'), 'utf8');
  assert(actCode.includes("'Not enough delivery data'"), "activity.js must display 'Not enough delivery data' when no DMs");
  assert(!actCode.includes("totalDMs > 0 ? (data.deliveryRate ?? Math.round((sent / totalDMs) * 100)) : 100;"), "activity.js must NOT default deliveryRate to 100!");
});

runTest('dashboard.js displays neutral state when totalDMs === 0', () => {
  const dashCode = fs.readFileSync(path.join(repoDir, 'dashboard.js'), 'utf8');
  assert(dashCode.includes("deliveryRate.textContent = '—'"), "dashboard.js must display '—' when totalDMs === 0");
  assert(!dashCode.includes("deliveryRate.textContent = '100%';"), "dashboard.js must NOT default deliveryRate to 100% when totalDMs === 0");
});

// Test 7: CSS Styles for Tooltips and Light Mode
console.log('\n--- 7. CSS Design System & Semantic Variables Verification ---');
runTest('styles.css contains .info-tooltip-wrap, .info-tooltip-btn, and .info-tooltip-box', () => {
  const css = fs.readFileSync(path.join(repoDir, 'styles.css'), 'utf8');
  assert(css.includes('.info-tooltip-wrap'), 'Missing .info-tooltip-wrap class');
  assert(css.includes('.info-tooltip-btn'), 'Missing .info-tooltip-btn class');
  assert(css.includes('.info-tooltip-box'), 'Missing .info-tooltip-box class');
});

runTest('creator-tools.html does not hardcode white-on-white text in light mode', () => {
  const ctCode = fs.readFileSync(path.join(repoDir, 'creator-tools.html'), 'utf8');
  assert(!ctCode.includes('.form-input { width:100%; padding:10px 14px; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.1); border-radius:10px; color:#f1f5f9;'), "creator-tools.html still hardcodes #f1f5f9 on form-input");
  assert(ctCode.includes('var(--surface)'), 'creator-tools.html must use var(--surface)');
  assert(ctCode.includes('var(--ink)'), 'creator-tools.html must use var(--ink)');
});

runTest('billing.html uses semantic CSS variables for plans and amounts', () => {
  const billCode = fs.readFileSync(path.join(repoDir, 'billing.html'), 'utf8');
  assert(billCode.includes('var(--surface)'), 'billing.html must use var(--surface)');
  assert(billCode.includes('var(--ink)'), 'billing.html must use var(--ink)');
});

console.log('\n================================================================');
console.log(`Results: ${passedTests} / ${totalTests} tests passed (${Math.round((passedTests / totalTests) * 100)}%)`);
console.log('================================================================\n');

if (passedTests < totalTests) {
  process.exit(1);
} else {
  process.exit(0);
}
