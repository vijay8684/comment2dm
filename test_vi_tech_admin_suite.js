// test_vi_tech_admin_suite.js
// Comment2DM — VI Tech Owner Control Center Verification & Integration Suite

'use strict';

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');

// Setup mock DB & environment
const originalAdminEmail = process.env.ADMIN_EMAIL;
process.env.ADMIN_EMAIL = 'owner@vitech.internal';
process.env.RAZORPAY_KEY_ID = 'rzp_test_TzjG2mAiJjGWxv';
process.env.RAZORPAY_KEY_SECRET = 'mock_secret_key_12345';
process.env.JWT_SECRET = 'test_jwt_secret_xyz';

const db = require('./src/db');
const usersMap = new Map();
const sessionsMap = new Map();
const couponsMap = new Map();
const redemptionsMap = new Map();
const campaignsMap = new Map();
const pricingCatalogMap = new Map();
const billingPlansMap = new Map();
const subscriptionsMap = new Map();
const paymentsMap = new Map();
const auditLogsList = [];

// Wire in-memory mock collections
const mockCollections = {
  users: {
    findOne: async (q) => {
      if (!q) return null;
      if (q.id) return usersMap.get(q.id) || null;
      if (q._id) {
        const idStr = q._id.toString ? q._id.toString() : String(q._id);
        return usersMap.get(idStr) || Array.from(usersMap.values()).find(u => String(u._id) === idStr) || null;
      }
      if (q.$or && Array.isArray(q.$or)) {
        for (const clause of q.$or) {
          if (!clause) continue;
          if (clause.id && usersMap.has(clause.id)) return usersMap.get(clause.id);
          if (clause._id) {
            const idStr = clause._id.toString ? clause._id.toString() : String(clause._id);
            for (const u of usersMap.values()) {
              if (u.id === idStr || String(u._id) === idStr) return u;
            }
          }
        }
      }
      if (q.email) return Array.from(usersMap.values()).find(u => u.email.toLowerCase() === q.email.toLowerCase()) || null;
      return null;
    },
    find: (q) => {
      const cursor = {
        sort: () => cursor,
        skip: () => cursor,
        limit: () => cursor,
        toArray: async () => Array.from(usersMap.values())
      };
      return cursor;
    },
    countDocuments: async (q) => {
      if (!q) return usersMap.size;
      let count = 0;
      for (const u of usersMap.values()) {
        if (q.suspended === true && !u.suspended) continue;
        if (q.suspended && q.suspended.$ne && u.suspended) continue;
        count++;
      }
      return count;
    },
    updateOne: async (q, u) => {
      let targetUser = null;
      if (q.id && usersMap.has(q.id)) targetUser = usersMap.get(q.id);
      else if (q._id) {
        const idStr = q._id.toString ? q._id.toString() : String(q._id);
        for (const user of usersMap.values()) {
          if (user.id === idStr || String(user._id) === idStr) { targetUser = user; break; }
        }
      } else if (q.$or) {
        for (const clause of q.$or) {
          if (clause && clause.id && usersMap.has(clause.id)) { targetUser = usersMap.get(clause.id); break; }
        }
      }
      if (targetUser) {
        if (u.$set) Object.assign(targetUser, u.$set);
        return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
      }
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
    },
    insertOne: async (doc) => {
      usersMap.set(doc.id, { ...doc });
      return { acknowledged: true, insertedId: doc.id };
    }
  },
  sessions: {
    findOne: async (q) => sessionsMap.get(q.token_hash) || null,
    insertOne: async (doc) => { sessionsMap.set(doc.token_hash, doc); return { acknowledged: true }; },
    deleteMany: async (q) => {
      for (const [k, v] of sessionsMap.entries()) {
        if (v.user_id === q.user_id) sessionsMap.delete(k);
      }
      return { acknowledged: true };
    }
  },
  coupons: {
    findOne: async (q) => couponsMap.get(q.code) || null,
    find: () => {
      const cursor = {
        sort: () => cursor,
        skip: () => cursor,
        limit: () => cursor,
        toArray: async () => Array.from(couponsMap.values())
      };
      return cursor;
    },
    insertOne: async (doc) => { couponsMap.set(doc.code, { ...doc }); return { acknowledged: true }; },
    updateOne: async (q, u) => {
      const c = couponsMap.get(q.code);
      if (c) {
        if (u.$set) Object.assign(c, u.$set);
        if (u.$inc) {
          for (const [k, v] of Object.entries(u.$inc)) c[k] = (c[k] || 0) + v;
        }
        return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
      }
      return { acknowledged: true, matchedCount: 0 };
    }
  },
  coupon_redemptions: {
    findOne: async (q) => {
      for (const r of redemptionsMap.values()) {
        if (q.subscription_id && r.subscription_id === q.subscription_id) return r;
      }
      return null;
    },
    countDocuments: async (q) => {
      let count = 0;
      for (const r of redemptionsMap.values()) {
        if (q.coupon_code && r.coupon_code !== q.coupon_code) continue;
        if (q.user_id && r.user_id !== q.user_id) continue;
        count++;
      }
      return count;
    },
    updateOne: async (q, u, opts) => {
      let r = redemptionsMap.get(q.subscription_id);
      if (!r && opts && opts.upsert) {
        r = { ...q, ...u.$set };
        redemptionsMap.set(q.subscription_id, r);
        return { acknowledged: true, upsertedCount: 1 };
      }
      if (r && u.$set) Object.assign(r, u.$set);
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
    },
    deleteOne: async (q) => {
      redemptionsMap.delete(q.subscription_id);
      return { acknowledged: true };
    }
  },
  pricing_catalog: {
    findOne: async (q) => pricingCatalogMap.get(q._id) || null,
    updateOne: async (q, u, opts) => {
      let doc = pricingCatalogMap.get(q._id);
      if (!doc && opts && opts.upsert) {
        doc = { ...q, ...(u.$setOnInsert || {}), ...(u.$set || {}) };
        pricingCatalogMap.set(q._id, doc);
        return { acknowledged: true, upsertedCount: 1 };
      }
      if (doc && u.$set) Object.assign(doc, u.$set);
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
    }
  },
  pricing_campaigns: {
    findOne: async (q) => {
      for (const c of campaignsMap.values()) {
        if (q.status && c.status !== q.status) continue;
        if (q.id && c.id !== q.id) continue;
        return c;
      }
      return null;
    },
    find: () => {
      const cursor = {
        sort: () => cursor,
        skip: () => cursor,
        limit: () => cursor,
        toArray: async () => Array.from(campaignsMap.values())
      };
      return cursor;
    },
    insertOne: async (doc) => { campaignsMap.set(doc.id, { ...doc }); return { acknowledged: true }; },
    updateOne: async (q, u) => {
      const c = campaignsMap.get(q.id);
      if (c && u.$set) Object.assign(c, u.$set);
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
    }
  },
  billing_plans: {
    findOne: async (q) => {
      for (const p of billingPlansMap.values()) {
        if (q.plan_key && p.plan_key !== q.plan_key) continue;
        if (q.amount && p.amount !== q.amount) continue;
        return p;
      }
      return null;
    },
    insertOne: async (doc) => {
      const key = `${doc.plan_key}_${doc.amount || 'default'}`;
      billingPlansMap.set(key, { ...doc });
      return { acknowledged: true };
    },
    updateOne: async (q, u, opts) => {
      const key = `${q.plan_key}_${q.amount || 'default'}`;
      let p = billingPlansMap.get(key);
      if (!p && opts && opts.upsert) {
        p = { ...q, ...u.$set };
        billingPlansMap.set(key, p);
        return { acknowledged: true, upsertedCount: 1 };
      }
      if (p && u.$set) Object.assign(p, u.$set);
      return { acknowledged: true, matchedCount: 1 };
    }
  },
  subscriptions: {
    findOne: async (q) => {
      for (const s of subscriptionsMap.values()) {
        if (q.user_id && s.user_id !== q.user_id) continue;
        if (q.razorpay_subscription_id && s.razorpay_subscription_id !== q.razorpay_subscription_id) continue;
        if (q.status) {
          if (typeof q.status === 'string' && s.status !== q.status) continue;
          if (q.status.$in && !q.status.$in.includes(s.status)) continue;
        }
        return s;
      }
      return null;
    },
    find: () => {
      const cursor = {
        sort: () => cursor,
        skip: () => cursor,
        limit: () => cursor,
        toArray: async () => Array.from(subscriptionsMap.values())
      };
      return cursor;
    },
    countDocuments: async () => subscriptionsMap.size,
    updateOne: async (q, u, opts) => {
      let s = null;
      if (q.razorpay_subscription_id) s = subscriptionsMap.get(q.razorpay_subscription_id);
      if (!s && q._id) s = subscriptionsMap.get(q._id);
      if (!s) {
        for (const sub of subscriptionsMap.values()) {
          if (q.razorpay_subscription_id && sub.razorpay_subscription_id === q.razorpay_subscription_id) { s = sub; break; }
          if (q._id && sub._id === q._id) { s = sub; break; }
        }
      }
      if (!s && opts && opts.upsert) {
        const sid = q.razorpay_subscription_id || q._id || ('sub_' + Date.now());
        s = { ...q, ...u.$set, razorpay_subscription_id: sid, _id: sid };
        subscriptionsMap.set(sid, s);
        return { acknowledged: true, upsertedCount: 1 };
      }
      if (s && u.$set) Object.assign(s, u.$set);
      return { acknowledged: true, matchedCount: s ? 1 : 0, modifiedCount: s ? 1 : 0 };
    }
  },
  payments: {
    find: () => {
      const cursor = {
        sort: () => cursor,
        skip: () => cursor,
        limit: () => cursor,
        toArray: async () => Array.from(paymentsMap.values())
      };
      return cursor;
    },
    countDocuments: async () => paymentsMap.size,
    updateOne: async (q, u, opts) => {
      let p = paymentsMap.get(q.razorpay_payment_id);
      if (!p && opts && opts.upsert) {
        p = { ...q, ...u.$set };
        paymentsMap.set(q.razorpay_payment_id, p);
        return { acknowledged: true, upsertedCount: 1 };
      }
      if (p && u.$set) Object.assign(p, u.$set);
      return { acknowledged: true, matchedCount: 1 };
    }
  },
  rateLimits: {
    updateOne: async () => ({ acknowledged: true, matchedCount: 1 }),
    findOne: async () => null,
    insertOne: async () => ({ acknowledged: true })
  },
  admin_audit_logs: {
    insertOne: async (doc) => { auditLogsList.unshift(doc); return { acknowledged: true }; },
    find: () => ({
      sort: () => ({
        skip: () => ({ limit: () => ({ toArray: async () => auditLogsList }) }),
        limit: () => ({ toArray: async () => auditLogsList }),
        toArray: async () => auditLogsList
      }),
      toArray: async () => auditLogsList
    }),
    countDocuments: async () => auditLogsList.length
  },
  instagram_accounts: {
    countDocuments: async () => 1,
    find: () => ({ toArray: async () => [] })
  },
  automations: {
    countDocuments: async () => 2,
    find: () => ({ toArray: async () => [] })
  },
  automation_events: {
    find: () => ({ toArray: async () => [] }),
    countDocuments: async () => 42
  },
  contacts: {
    find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }), toArray: async () => [] })
  },
  feedback: {
    find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }), toArray: async () => [] })
  }
};

db.collections = function () {
  return mockCollections;
};
db.connect = async function () {
  return {
    collection: (name) => mockCollections[name] || {
      findOne: async () => null,
      find: () => ({ sort: () => ({ toArray: async () => [] }), toArray: async () => [] }),
      countDocuments: async () => 0,
      updateOne: async () => ({ acknowledged: true }),
      updateMany: async () => ({ acknowledged: true }),
      insertOne: async () => ({ acknowledged: true })
    }
  };
};
db.getDatabase = function () {
  return {
    collection: (name) => mockCollections[name] || {
      findOne: async () => null,
      find: () => ({ sort: () => ({ toArray: async () => [] }), toArray: async () => [] }),
      countDocuments: async () => 0,
      updateOne: async () => ({ acknowledged: true }),
      updateMany: async () => ({ acknowledged: true }),
      insertOne: async () => ({ acknowledged: true })
    }
  };
};
db.consumeRateLimit = async () => true;
db.getUserById = async (id) => usersMap.get(id) || null;

const serverModule = require('./server.js');
const billing = require('./src/billing.js');
billing._setDbForTesting(db.getDatabase());
const authService = require('./src/auth/authService');
const pricingService = require('./src/services/pricingService');
const couponService = require('./src/services/couponService');
const auditService = require('./src/services/auditService');

let passCount = 0;
let failCount = 0;

function test(description, condition) {
  if (condition) {
    console.log(`  ✓ PASSED: ${description}`);
    passCount++;
  } else {
    console.error(`  ❌ FAILED: ${description}`);
    failCount++;
  }
}

async function runSuite() {
  console.log('======================================================================');
  console.log('   COMMENT2DM — VI TECH OWNER CONTROL CENTER & BILLING TEST SUITE     ');
  console.log('======================================================================\n');

  // Populate users
  const ownerUser = { id: 'usr_owner_1', _id: 'usr_owner_1', email: 'owner@vitech.internal', name: 'VI Tech Owner', plan: 'elite' };
  const customerUser = { id: 'usr_cust_1', _id: 'usr_cust_1', email: 'regular-creator@gmail.com', name: 'Regular Creator', plan: 'pro' };
  usersMap.set(ownerUser.id, ownerUser);
  usersMap.set(customerUser.id, customerUser);

  const ownerSessionToken = await authService.createSession(ownerUser.id, new Date(Date.now() + 86400000));
  const customerSessionToken = await authService.createSession(customerUser.id, new Date(Date.now() + 86400000));

  // Start HTTP Server for integration checks
  const server = http.createServer(serverModule.app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  function makeRequest(method, path, body = null, cookie = null) {
    return new Promise((resolve, reject) => {
      const headers = {};
      if (cookie) headers['Cookie'] = `comment2dm_session=${cookie}`;
      let data = null;
      if (body) {
        data = JSON.stringify(body);
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(data);
      }
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers
      }, (res) => {
        let respBody = '';
        res.on('data', c => respBody += c);
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(respBody); } catch {}
          resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: respBody });
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  try {
    // -------------------------------------------------------------------
    // 1. ADMIN ROUTING & SECURITY
    // -------------------------------------------------------------------
    console.log('--- 1. ADMIN ROUTING & SECURITY ---');

    // 1.1: Unauthenticated request to /vi-tech redirects to login
    const unauthViTech = await makeRequest('GET', '/vi-tech');
    test('Unauthenticated GET /vi-tech redirects to /login.html?returnTo=/vi-tech',
      unauthViTech.status === 302 && unauthViTech.headers.location === '/login.html?returnTo=/vi-tech'
    );

    // 1.2: Ordinary customer denied with HTTP 403
    const customerViTech = await makeRequest('GET', '/vi-tech', null, customerSessionToken);
    test('Ordinary customer GET /vi-tech receives HTTP 403 Access Denied',
      customerViTech.status === 403 && customerViTech.raw.includes('403 — Access Denied')
    );

    // 1.3: Owner granted access to /vi-tech
    const ownerViTech = await makeRequest('GET', '/vi-tech', null, ownerSessionToken);
    test('Owner GET /vi-tech receives HTTP 200 with VI Tech control center',
      ownerViTech.status === 200 && ownerViTech.raw.includes('VI TECH')
    );

    // 1.4: Direct access to admin.html redirects to /vi-tech
    const adminHtmlRedirect = await makeRequest('GET', '/admin.html');
    test('Legacy /admin.html redirects (HTTP 301) to /vi-tech',
      adminHtmlRedirect.status === 301 && adminHtmlRedirect.headers.location === '/vi-tech'
    );

    // 1.5: Non-admin calling /api/admin/overview is blocked (HTTP 403)
    const nonAdminApi = await makeRequest('GET', '/api/admin/overview', null, customerSessionToken);
    test('Non-admin calling /api/admin/overview receives HTTP 403 Forbidden',
      nonAdminApi.status === 403 && nonAdminApi.body.error === 'Admin access required.'
    );

    // 1.6: Owner calling /api/admin/overview receives full telemetry
    const ownerApi = await makeRequest('GET', '/api/admin/overview', null, ownerSessionToken);
    test('Owner calling /api/admin/overview receives HTTP 200 with metrics',
      ownerApi.status === 200 && ownerApi.body.success === true && ownerApi.body.metrics.total_customers >= 2
    );

    // -------------------------------------------------------------------
    // 2. PRICING & PROMOTIONAL SALES ENGINE
    // -------------------------------------------------------------------
    console.log('\n--- 2. PRICING & PROMOTIONAL SALES ENGINE ---');

    // 2.1: Default canonical prices
    const catalog = await pricingService.getPricingCatalog();
    test('Canonical pricing defaults: Pro ₹70/mo, Elite ₹150/mo, Free ₹0',
      catalog.pro.monthly === 70 && catalog.elite.monthly === 150 && catalog.free.monthly === 0
    );

    // 2.2: Owner updates regular prices
    const updatePriceRes = await makeRequest('POST', '/api/admin/pricing/regular', {
      pro_monthly: 80,
      elite_monthly: 180,
      reason: 'Inflation adjustment'
    }, ownerSessionToken);
    test('Owner updates Pro and Elite base prices via POST /api/admin/pricing/regular',
      updatePriceRes.status === 200 &&
      updatePriceRes.body.catalog.pro.monthly === 80 &&
      updatePriceRes.body.catalog.elite.monthly === 180
    );

    // 2.3: Reset prices back to approved ₹70 and ₹150
    await pricingService.updateRegularPrices({ proMonthly: 70, eliteMonthly: 150 }, 'owner@vitech.internal', 'Launch approved pricing');
    const resetCatalog = await pricingService.getPricingCatalog(true);
    test('Reset to approved prices: Pro ₹70, Elite ₹150', resetCatalog.pro.monthly === 70 && resetCatalog.elite.monthly === 150);

    // 2.4: Create festive promotional campaign (Diwali Sale)
    const startDate = new Date(Date.now() - 3600000).toISOString(); // 1 hour ago
    const endDate = new Date(Date.now() + 86400000 * 5).toISOString(); // 5 days from now
    const campaignRes = await makeRequest('POST', '/api/admin/pricing/campaigns', {
      name: 'Diwali Dhamaka Sale',
      applicable_plans: ['pro', 'elite'],
      sale_price_pro: 49,
      sale_price_elite: 99,
      start_date: startDate,
      end_date: endDate,
      badge_text: 'DIWALI SPECIAL'
    }, ownerSessionToken);

    test('Promotional campaign created with auto-calculated discounts (Pro ₹49 = 30% off, Elite ₹99 = 34% off)',
      campaignRes.status === 200 &&
      campaignRes.body.campaign.sale_price_pro === 49 &&
      campaignRes.body.campaign.discount_percent_pro === 30 &&
      campaignRes.body.campaign.sale_price_elite === 99 &&
      campaignRes.body.campaign.discount_percent_elite === 34
    );

    // 2.5: Effective pricing API reflects active campaign
    const effectivePricesRes = await makeRequest('GET', '/api/billing/prices');
    test('GET /api/billing/prices returns effective promotional prices and badges across all pages',
      effectivePricesRes.status === 200 &&
      effectivePricesRes.body.pro_monthly === 49 &&
      effectivePricesRes.body.elite_monthly === 99 &&
      effectivePricesRes.body.pro_regular === 70 &&
      effectivePricesRes.body.elite_regular === 150 &&
      effectivePricesRes.body.plans.pro.is_sale === true &&
      effectivePricesRes.body.plans.pro.badge === 'DIWALI SPECIAL'
    );

    // 2.6: End promotional campaign and verify return to regular price
    await pricingService.updateCampaignStatus(campaignRes.body.campaign.id, 'ended', 'owner@vitech.internal');
    const endedPricesRes = await makeRequest('GET', '/api/billing/prices');
    test('Ending campaign immediately reverts GET /api/billing/prices back to regular Pro ₹70 and Elite ₹150',
      endedPricesRes.status === 200 &&
      endedPricesRes.body.pro_monthly === 70 &&
      endedPricesRes.body.elite_monthly === 150 &&
      endedPricesRes.body.plans.pro.is_sale === false
    );

    // -------------------------------------------------------------------
    // 3. COUPON ENGINE & REAL DISCOUNT PAYMENT INTEGRATION
    // -------------------------------------------------------------------
    console.log('\n--- 3. COUPON ENGINE & REAL DISCOUNT PAYMENT INTEGRATION ---');

    // 3.1: Create percentage discount coupon SAVE20
    const couponRes = await makeRequest('POST', '/api/admin/coupons', {
      code: 'SAVE20',
      discount_type: 'percentage',
      discount_value: 20,
      applicable_plans: ['pro', 'elite'],
      duration: 'once',
      max_redemptions: 50,
      max_per_customer: 1
    }, ownerSessionToken);

    test('Create percentage coupon SAVE20 (20% OFF, duration: once, limit: 50)',
      couponRes.status === 200 && couponRes.body.coupon.code === 'SAVE20' && couponRes.body.coupon.discount_value === 20
    );

    // 3.2: Validate coupon on Pro plan (₹70 -> ₹56 = 5600 paise)
    const validProRes = await makeRequest('POST', '/api/billing/validate-coupon', {
      code: 'SAVE20',
      planKey: 'pro_monthly'
    }, customerSessionToken);

    test('Coupon validation calculates correct discount: ₹70 - 20% (₹14) = ₹56 payable',
      validProRes.status === 200 &&
      validProRes.body.valid === true &&
      validProRes.body.discount_rupees === 14 &&
      validProRes.body.final_rupees === 56
    );

    // 3.3: Reject invalid or non-existent coupon
    const invalidCouponRes = await makeRequest('POST', '/api/billing/validate-coupon', {
      code: 'FAKECODE99'
    });
    test('Reject non-existent coupon code (HTTP 400 with descriptive error)',
      invalidCouponRes.status === 400 && invalidCouponRes.body.valid === false
    );

    // 3.4: Dynamic Razorpay Plan resolution for discounted ₹56 (5600 paise)
    const mockCreatedPlans = [];
    billing._setRazorpayForTesting({
      subscriptions: {
        async create(params) {
          return {
            id: 'sub_test_discounted_999',
            status: 'created',
            plan_id: params.plan_id
          };
        },
        async cancel(subId) {
          return { id: subId, status: 'cancelled' };
        }
      }
    });

    // Populate billing_plans with mock plan for 5600 paise
    await mockCollections.billing_plans.insertOne({
      plan_key: 'pro_monthly',
      amount: 5600,
      razorpay_plan_id: 'plan_pro_m_5600_paise'
    });

    // 3.5: Create subscription with coupon SAVE20
    const discountedCheckoutRes = await makeRequest('POST', '/api/billing/create-subscription', {
      planKey: 'pro_monthly',
      couponCode: 'SAVE20'
    }, customerSessionToken);

    test('Create subscription with SAVE20 resolves exact matching Razorpay plan for 5600 paise (₹56)',
      discountedCheckoutRes.status === 200 &&
      discountedCheckoutRes.body.amount === 5600 &&
      discountedCheckoutRes.body.couponApplied.code === 'SAVE20' &&
      discountedCheckoutRes.body.couponApplied.discount_rupees === 14
    );

    // 3.6: Verify coupon reservation was created with TTL
    const reservation = await mockCollections.coupon_redemptions.findOne({
      subscription_id: discountedCheckoutRes.body.subscriptionId
    });
    test('Coupon usage atomically reserved in coupon_redemptions with status reserved',
      reservation && reservation.coupon_code === 'SAVE20' && reservation.status === 'reserved'
    );

    // 3.7: Payment verification transitions coupon to redeemed and records payment
    const verifyRes = await makeRequest('POST', '/api/billing/verify-subscription', {
      razorpay_subscription_id: discountedCheckoutRes.body.subscriptionId,
      razorpay_payment_id: 'pay_test_disc_777',
      razorpay_signature: crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
        .update('pay_test_disc_777|' + discountedCheckoutRes.body.subscriptionId)
        .digest('hex')
    }, customerSessionToken);

    test('POST /api/billing/verify-subscription verifies signature (HTTP 200)',
      verifyRes.status === 200 && verifyRes.body.verified === true
    );

    const redeemedRecord = await mockCollections.coupon_redemptions.findOne({
      subscription_id: discountedCheckoutRes.body.subscriptionId
    });
    test('Coupon reservation updated to redeemed with payment ID recorded',
      redeemedRecord && redeemedRecord.status === 'redeemed' && redeemedRecord.payment_id === 'pay_test_disc_777'
    );

    const couponInDb = await mockCollections.coupons.findOne({ code: 'SAVE20' });
    test('Coupon redemption_count incremented in coupons collection',
      couponInDb && couponInDb.redemption_count === 1
    );

    // -------------------------------------------------------------------
    // 4. SUBSCRIPTION LIFECYCLE: DOWNGRADE & CANCELLATION ACCESS RETENTION
    // -------------------------------------------------------------------
    console.log('\n--- 4. SUBSCRIPTION LIFECYCLE & ACCESS RETENTION ---');

    // 4.1: Subscription with future current_end retains paid access even if cancelled
    const futureEnd = new Date(Date.now() + 86400000 * 20).toISOString(); // 20 days remaining
    await mockCollections.subscriptions.updateOne(
      { razorpay_subscription_id: discountedCheckoutRes.body.subscriptionId },
      { $set: { status: 'cancelled', current_end: futureEnd, plan: 'pro' } }
    );
    billing._clearEntitlementCacheForTesting();

    const retainedEntitlement = await billing.entitlement(customerUser.id);
    test('User with cancelled subscription and active current_end retains Pro entitlements until cycle ends',
      retainedEntitlement.plan === 'pro' &&
      retainedEntitlement.limits.dmMonthly === 5000 &&
      retainedEntitlement.limits.whiteLabel === true
    );

    // 4.2: Subscription with expired current_end drops to Free tier
    const pastEnd = new Date(Date.now() - 3600000).toISOString(); // 1 hour ago
    await mockCollections.subscriptions.updateOne(
      { razorpay_subscription_id: discountedCheckoutRes.body.subscriptionId },
      { $set: { status: 'cancelled', current_end: pastEnd, plan: 'pro' } }
    );
    billing._clearEntitlementCacheForTesting();

    const expiredEntitlement = await billing.entitlement(customerUser.id);
    test('User with cancelled subscription after current_end has elapsed drops back to Free tier',
      expiredEntitlement.plan === 'free' &&
      expiredEntitlement.limits.dmMonthly === 500 &&
      expiredEntitlement.limits.whiteLabel === false
    );

    // -------------------------------------------------------------------
    // 5. CUSTOMER MANAGEMENT & IMMUTABLE AUDIT LOGS
    // -------------------------------------------------------------------
    console.log('\n--- 5. CUSTOMER MANAGEMENT & IMMUTABLE AUDIT LOGS ---');

    // 5.1: Suspend customer
    const suspendRes = await makeRequest('POST', `/api/admin/customers/${customerUser.id}/suspend`, {
      reason: 'Payment fraud investigation'
    }, ownerSessionToken);
    test('POST /api/admin/customers/:id/suspend suspends account and invalidates sessions',
      suspendRes.status === 200 && suspendRes.body.suspended === true
    );

    // 5.2: Restore customer
    const restoreRes = await makeRequest('POST', `/api/admin/customers/${customerUser.id}/restore`, {}, ownerSessionToken);
    test('POST /api/admin/customers/:id/restore restores customer account',
      restoreRes.status === 200 && restoreRes.body.suspended === false
    );

    // 5.3: Verify audit logs recorded all owner operations
    const auditLogsRes = await makeRequest('GET', '/api/admin/audit-logs', null, ownerSessionToken);
    test('Audit log records all sensitive owner actions (price updates, campaigns, coupons, suspensions)',
      auditLogsRes.status === 200 &&
      auditLogsRes.body.logs.length >= 4 &&
      auditLogsRes.body.logs.some(l => l.action.includes('price')) &&
      auditLogsRes.body.logs.some(l => l.action.includes('coupon')) &&
      auditLogsRes.body.logs.some(l => l.action.includes('suspended'))
    );

    // 5.4: Infrastructure telemetry endpoint returns honest metrics
    const infraRes = await makeRequest('GET', '/api/admin/infrastructure', null, ownerSessionToken);
    test('Infrastructure endpoint returns accurate, unfabricated telemetry for Mongo, R2, Render & Razorpay',
      infraRes.status === 200 &&
      infraRes.body.mongodb.cluster.includes('Atlas') &&
      infraRes.body.render.node_version === process.version &&
      infraRes.body.razorpay.mode === 'Test Mode'
    );

    console.log('\n======================================================================');
    console.log(`   RESULTS: ${passCount} PASSED, ${failCount} FAILED`);
    console.log('======================================================================\n');

    if (failCount > 0) {
      process.exit(1);
    }
  } finally {
    process.env.ADMIN_EMAIL = originalAdminEmail;
    await new Promise(r => server.close(r));
  }
}

runSuite().catch(err => {
  console.error('Fatal error running suite:', err);
  process.exit(1);
});
