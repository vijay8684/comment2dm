/**
 * test_platform_consistency_suite.js
 * Comprehensive Verification Suite for Comment2DM Complete Platform Consistency,
 * ₹1 Entry Fee Gating, Plan Limits (50,000 DMs & 5 GB Elite), Sidebar Dual Indicators & Isolation
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function runSuite() {
  console.log('🧪 Starting Comment2DM Platform Consistency & Verification Suite...\n');
  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ FAIL: ${name}`);
      console.error('     Error:', err.message);
      failed++;
    }
  }

  async function testAsync(name, fn) {
    try {
      await fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ FAIL: ${name}`);
      console.error('     Error:', err.message);
      failed++;
    }
  }

  // ========================================================
  // Test 1: Canonical Plan Matrix & Elite Quotas
  // ========================================================
  const { PLANS, CANONICAL_PLANS } = require('./src/billing');
  test('PLANS contains entry_monthly at 100 paise (₹1)', () => {
    assert(PLANS.entry_monthly, 'entry_monthly plan should exist');
    assert.strictEqual(PLANS.entry_monthly.amount, 100, 'entry_monthly amount should be 100 paise');
    assert.strictEqual(PLANS.entry_monthly.currency, 'INR');
    assert.strictEqual(PLANS.entry_monthly.period, 'monthly');
  });

  test('Canonical plan quotas conform strictly to specifications', () => {
    assert.strictEqual(CANONICAL_PLANS.free.dmMonthly, 500);
    assert.strictEqual(CANONICAL_PLANS.free.storageBytes, 150000000);
    assert.strictEqual(CANONICAL_PLANS.pro.dmMonthly, 5000);
    assert.strictEqual(CANONICAL_PLANS.pro.storageBytes, 1000000000);
    assert.strictEqual(CANONICAL_PLANS.elite.dmMonthly, 50000);
    assert.strictEqual(CANONICAL_PLANS.elite.storageBytes, 5000000000);
  });

  // ========================================================
  // Test 2: Pricing Service & Entry Pricing Controls
  // ========================================================
  const pricingService = require('./src/services/pricingService');
  await testAsync('Pricing service manages entry pricing catalog & effective pricing', async () => {
    const entryPricing = await pricingService.getEntryPricing();
    assert(entryPricing, 'Entry pricing configuration should exist');
    assert(typeof entryPricing.promotional_price === 'number', 'promotional_price should be a number');
    assert(typeof entryPricing.gate_automations_if_unpaid === 'boolean', 'gate_automations_if_unpaid should be boolean');

    const effective = await pricingService.getEffectivePricing();
    assert(effective.entry_pricing, 'Effective pricing must expose entry_pricing');
    assert.strictEqual(effective.plans.free.price, 1);
    assert.strictEqual(effective.plans.free.amount_paise, 100);
    assert.strictEqual(effective.plans.free.requires_paid_entry, true);
    assert.strictEqual(effective.plans.free.gate_automations_if_unpaid, true);
    assert.strictEqual(effective.plans.pro.price, 70);
    assert.strictEqual(effective.plans.elite.price, 150);
  });

  // ========================================================
  // Test 3: HTML Sidebar Standardization Audit
  // ========================================================
  const appHtmlFiles = [
    'dashboard.html',
    'automations.html',
    'activity.html',
    'billing.html',
    'creator-tools.html',
    'help.html',
    'instagram-accounts.html',
    'settings.html'
  ];

  appHtmlFiles.forEach(f => {
    test(`Sidebar dual indicators present in ${f}`, () => {
      const content = fs.readFileSync(path.join(__dirname, f), 'utf8');
      assert(content.includes('class="sidebar-foot"'), `${f} must contain .sidebar-foot`);
      assert(content.includes('id="dmLimitCard"'), `${f} must contain #dmLimitCard`);
      assert(content.includes('id="dmLimitText"'), `${f} must contain #dmLimitText`);
      assert(content.includes('id="sidebarStorageText"'), `${f} must contain #sidebarStorageText`);
      assert(content.includes('id="sidebarStorageFill"'), `${f} must contain #sidebarStorageFill`);
      assert(content.includes('id="sidebarStorageRemaining"'), `${f} must contain #sidebarStorageRemaining`);
      assert(!content.includes('0 / 300'), `${f} must not contain stale '0 / 300' limit`);
    });
  });

  // ========================================================
  // Test 4: Mobile Drawer & Backdrop Elements
  // ========================================================
  test('Mobile drawer backdrop & CSS variables present in styles.css', () => {
    const styles = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf8');
    assert(styles.includes('.sidebar-backdrop'), 'styles.css must have .sidebar-backdrop');
    assert(styles.includes('.sidebar-backdrop.active'), 'styles.css must have .sidebar-backdrop.active');
    assert(styles.includes('body.sidebar-open'), 'styles.css must have body.sidebar-open');
    assert(styles.includes('--ink: #0D0B12'), 'Light theme ink must be dark #0D0B12');
  });

  // ========================================================
  // Test 5: Automation Gating Elements in automations.html
  // ========================================================
  test('automations.html includes entry gate modal and banner', () => {
    const autoHtml = fs.readFileSync(path.join(__dirname, 'automations.html'), 'utf8');
    assert(autoHtml.includes('id="entryGateModal"'), 'automations.html must include entryGateModal');
    assert(autoHtml.includes('id="unlockEntryFeeBtn"'), 'automations.html must include unlockEntryFeeBtn');
    assert(autoHtml.includes('id="entryFeeBanner"'), 'automations.html must include entryFeeBanner');
    assert(autoHtml.includes('checkout.razorpay.com/v1/checkout.js'), 'automations.html must load Razorpay checkout SDK');
  });

  // ========================================================
  // Test 6: Admin Controls in vi-tech.html & vi-tech.js
  // ========================================================
  test('vi-tech owner control center includes entry pricing form and actions', () => {
    const viHtml = fs.readFileSync(path.join(__dirname, 'vi-tech.html'), 'utf8');
    assert(viHtml.includes('id="entryPricingForm"'), 'vi-tech.html must include entryPricingForm');
    assert(viHtml.includes('id="entryIsActive"'), 'vi-tech.html must include entryIsActive');
    assert(viHtml.includes('id="entryPromoPrice"'), 'vi-tech.html must include entryPromoPrice');
    assert(viHtml.includes('id="entryGateAutomations"'), 'vi-tech.html must include entryGateAutomations');
    assert(viHtml.includes('id="entryAutopayEnabled"'), 'vi-tech.html must include entryAutopayEnabled');
    assert(viHtml.includes('delete-coupon-btn') || viHtml.includes('couponsTableBody'), 'coupons section exists');
    assert(viHtml.includes('subsTableBody'), 'subscriptions section exists');

    const viJs = fs.readFileSync(path.join(__dirname, 'vi-tech.js'), 'utf8');
    assert(viJs.includes('/api/admin/pricing/entry-controls'), 'vi-tech.js must submit to entry-controls API');
    assert(viJs.includes('delete-coupon-btn'), 'vi-tech.js must wire coupon delete');
    assert(viJs.includes('cancel-sub-btn'), 'vi-tech.js must wire subscription cancel');
  });

  // ========================================================
  // Test 7: Public Reply Isolation in Analytics
  // ========================================================
  test('server.js enforces strict private DM criteria', () => {
    const serverJs = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    assert(serverJs.includes('privateDmCriteria'), 'server.js must define privateDmCriteria');
    assert(serverJs.includes('public_reply'), 'server.js must explicitly exclude public_reply');
    assert(serverJs.includes('delivery_channel: { $ne: \'public_comment\' }'), 'server.js must exclude public_comment');
  });

  console.log(`\n========================================`);
  console.log(`Results: ${passed} Passed, ${failed} Failed`);
  console.log(`========================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runSuite().catch(err => {
  console.error('Test suite runner crashed:', err);
  process.exit(1);
});
