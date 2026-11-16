// test_starter_pass_and_access_suite.js
// Verification suite for Comment2DM Starter Access Pass (₹1) and Subscriber Gating Bypass

'use strict';

const assert = require('assert');
const billing = require('./src/billing');
const pricingService = require('./src/services/pricingService');
const fs = require('fs');

async function runTests() {
  console.log('🧪 Starting Comment2DM Starter Access Pass & Access Suite...\n');

  // Test 1: Verify PLANS.entry_monthly configuration
  console.log('Test 1: Verify PLANS.entry_monthly has official Starter Access Pass naming & properties');
  const entryPlan = billing.PLANS.entry_monthly;
  assert(entryPlan, 'PLANS.entry_monthly must exist');
  assert.strictEqual(entryPlan.name, 'Starter Access Pass — ₹1', 'Plan name must be "Starter Access Pass — ₹1"');
  assert.strictEqual(entryPlan.payment_model, 'one_time', 'Payment model must be "one_time"');
  assert.strictEqual(entryPlan.amount, 100, 'Amount must be 100 paise (₹1)');
  assert.strictEqual(entryPlan.currency, 'INR', 'Currency must be INR');
  console.log('  ✅ Test 1 Passed: PLANS.entry_monthly correctly configured as Starter Access Pass — ₹1.\n');

  // Test 2: Elite subscriber must bypass the ₹1 entry fee gate
  console.log('Test 2: Elite subscriber bypasses ₹1 entry gate unconditionally');
  const mockDb = {
    collection: (name) => {
      if (name === 'users') {
        return {
          findOne: async (q) => {
            if (q.id === 'user_elite') return { id: 'user_elite', email: 'elite@creator.com', entry_paid: false };
            if (q.id === 'user_pro') return { id: 'user_pro', email: 'pro@creator.com', entry_paid: false };
            if (q.id === 'user_free_unpaid') return { id: 'user_free_unpaid', email: 'free_unpaid@test.com', entry_paid: false };
            if (q.id === 'user_free_paid') return { id: 'user_free_paid', email: 'free_paid@test.com', entry_paid: true, entry_paid_at: new Date().toISOString() };
            return null;
          }
        };
      }
      if (name === 'subscriptions') {
        return {
          findOne: async (q) => {
            if (q.user_id === 'user_elite') return { user_id: 'user_elite', plan: 'elite', status: 'active', current_end: new Date(Date.now() + 86400000).toISOString() };
            if (q.user_id === 'user_pro') return { user_id: 'user_pro', plan: 'pro', status: 'active', current_end: new Date(Date.now() + 86400000).toISOString() };
            return null;
          }
        };
      }
      if (name === 'instagram_accounts') {
        return { countDocuments: async () => 1 };
      }
      if (name === 'automations') {
        return { countDocuments: async () => 1 };
      }
      if (name === 'automation_events') {
        return { countDocuments: async () => 10 };
      }
      if (name === 'payments') {
        return {
          find: () => ({
            sort: () => ({
              limit: () => ({
                toArray: async () => [
                  {
                    _id: 'pay_123',
                    razorpay_payment_id: 'pay_123',
                    user_id: 'user_free_paid',
                    plan: 'entry_monthly',
                    item_name: 'Starter Access Pass — ₹1',
                    amount: 100,
                    currency: 'INR',
                    status: 'paid',
                    payment_model: 'one_time',
                    created_at: new Date().toISOString()
                  }
                ]
              })
            })
          })
        };
      }
      return {
        findOne: async () => null,
        find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }),
        countDocuments: async () => 0
      };
    }
  };

  billing._setDbForTesting(mockDb);
  billing._clearEntitlementCacheForTesting();

  const eliteAccess = await billing.getAutomationAccess('user_elite');
  assert.strictEqual(eliteAccess.allowed, true, 'Elite subscriber must be allowed');
  assert.strictEqual(eliteAccess.isGated, false, 'Elite subscriber must NOT be gated');
  assert.strictEqual(eliteAccess.canCreate, true, 'Elite subscriber must be allowed to create');
  assert.strictEqual(eliteAccess.canActivate, true, 'Elite subscriber must be allowed to activate');
  assert.strictEqual(eliteAccess.plan, 'elite', 'Plan must be elite');
  console.log('  ✅ Test 2 Passed: Elite subscriber has full access and is never gated.\n');

  // Test 3: Pro subscriber must bypass the ₹1 entry fee gate
  console.log('Test 3: Pro subscriber bypasses ₹1 entry gate unconditionally');
  const proAccess = await billing.getAutomationAccess('user_pro');
  assert.strictEqual(proAccess.allowed, true, 'Pro subscriber must be allowed');
  assert.strictEqual(proAccess.isGated, false, 'Pro subscriber must NOT be gated');
  assert.strictEqual(proAccess.canCreate, true, 'Pro subscriber must be allowed to create');
  assert.strictEqual(proAccess.plan, 'pro', 'Plan must be pro');
  console.log('  ✅ Test 3 Passed: Pro subscriber has full access and is never gated.\n');

  // Test 4: Free user without Starter Pass must be gated when entry pricing is active
  console.log('Test 4: Free user without Starter Pass receives ENTRY_FEE_REQUIRED');
  const freeUnpaidAccess = await billing.getAutomationAccess('user_free_unpaid');
  assert.strictEqual(freeUnpaidAccess.allowed, false, 'Unpaid free user must NOT be allowed');
  assert.strictEqual(freeUnpaidAccess.isGated, true, 'Unpaid free user must be gated');
  assert.strictEqual(freeUnpaidAccess.code, 'ENTRY_FEE_REQUIRED', 'Code must be ENTRY_FEE_REQUIRED');
  assert.strictEqual(freeUnpaidAccess.accessPass, 'Starter Access Pass — ₹1', 'Pass must be Starter Access Pass — ₹1');
  console.log('  ✅ Test 4 Passed: Unpaid Free user receives ENTRY_FEE_REQUIRED with Starter Access Pass details.\n');

  // Test 5: Free user with paid Starter Pass can create automations up to free plan limit (2)
  console.log('Test 5: Free user with paid Starter Pass has active access up to 2 automations');
  const freePaidAccess = await billing.getAutomationAccess('user_free_paid');
  assert.strictEqual(freePaidAccess.allowed, true, 'Paid free user with 1 automation must be allowed (limit 2)');
  assert.strictEqual(freePaidAccess.isGated, false, 'Paid free user must NOT be gated');
  assert.strictEqual(freePaidAccess.hasPaidEntry, true, 'hasPaidEntry must be true');
  assert.strictEqual(freePaidAccess.accessPass, 'Starter Access Pass — ₹1', 'Access pass must be labeled');
  assert.strictEqual(freePaidAccess.limit, 2, 'Limit must remain free plan canonical limit of 2');
  console.log('  ✅ Test 5 Passed: Paid Starter Pass grants automation access under canonical Free limit (2).\n');

  // Test 6: Verify check() function delegates to getAutomationAccess
  console.log('Test 6: Verify check("automations") uses getAutomationAccess logic');
  const eliteCheck = await billing.check('user_elite', 'automations');
  assert.strictEqual(eliteCheck.allowed, true, 'Elite check must be allowed');
  assert.strictEqual(eliteCheck.automationAccess.isGated, false, 'Elite check must not be gated');

  const unpaidCheck = await billing.check('user_free_unpaid', 'automations');
  assert.strictEqual(unpaidCheck.allowed, false, 'Unpaid check must not be allowed');
  assert.strictEqual(unpaidCheck.code, 'ENTRY_FEE_REQUIRED', 'Unpaid check must return ENTRY_FEE_REQUIRED');
  console.log('  ✅ Test 6 Passed: check("automations") cleanly integrates with getAutomationAccess.\n');

  // Test 7: Verify billing.history returns verified payments with Starter Access Pass
  console.log('Test 7: Verify history returns verified payment records');
  const reqMock = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  let historyResult = null;
  const resMock = {
    json: (data) => { historyResult = data; return data; },
    status: () => resMock
  };

  // Mock authenticated session
  const authService = require('./src/auth/authService');
  const origGetUser = authService.getUserById;
  authService.getUserById = async () => ({ id: 'user_free_paid', email: 'free_paid@test.com' });
  reqMock.headers.authorization = 'Bearer mock_token';
  const origGetSessionUser = authService.getSessionUser;
  authService.getSessionUser = async () => ({ id: 'user_free_paid', email: 'free_paid@test.com' });

  await billing.history(reqMock, resMock);
  assert(historyResult, 'historyResult must be returned');
  assert(Array.isArray(historyResult.payments), 'payments must be an array');
  assert.strictEqual(historyResult.payments.length, 1, '1 payment record expected');
  assert.strictEqual(historyResult.payments[0].plan, 'Starter Access Pass — ₹1', 'History plan must be Starter Access Pass — ₹1');
  assert.strictEqual(historyResult.payments[0].paymentModel, 'One-time payment', 'Payment model must be One-time payment');
  assert.strictEqual(historyResult.payments[0].status, 'paid', 'Status must be paid');
  assert.strictEqual(historyResult.payments[0].amount, 100, 'Amount must be 100 paise (₹1)');

  authService.getUserById = origGetUser;
  authService.getSessionUser = origGetSessionUser;
  console.log('  ✅ Test 7 Passed: History endpoint formats and returns verified Starter Access Pass records.\n');

  // Test 8: Verify automations.html line 184 has NO duplicate display:flex
  console.log('Test 8: Verify automations.html has no conflicting inline display:flex on entryFeeBanner');
  const autoHtml = fs.readFileSync('automations.html', 'utf8');
  const bannerMatch = autoHtml.match(/id=["']entryFeeBanner["'][^>]*style=["']([^"']*)["']/);
  assert(bannerMatch, 'entryFeeBanner must exist in automations.html');
  const bannerStyle = bannerMatch[1];
  assert(bannerStyle.includes('display:none') || bannerStyle.includes('display: none'), 'Banner must start with display:none');
  assert(!bannerStyle.includes('display:flex') && !bannerStyle.includes('display: flex'), 'Banner must NOT contain duplicate display:flex in inline style');
  console.log('  ✅ Test 8 Passed: automations.html banner is strictly hidden by default.\n');

  // Test 9: Verify styles.css has zero brace imbalance
  console.log('Test 9: Verify styles.css brace balance');
  const css = fs.readFileSync('styles.css', 'utf8');
  let depth = 0;
  for (let ch of css) { if (ch === '{') depth++; if (ch === '}') depth--; }
  assert.strictEqual(depth, 0, 'styles.css must have depth exactly 0');
  console.log('  ✅ Test 9 Passed: styles.css is perfectly balanced.\n');

  console.log('🎉 ALL 9 TESTS PASSED IN STARTER ACCESS PASS & ACCESS SUITE!');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
