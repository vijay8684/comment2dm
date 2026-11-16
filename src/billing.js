const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { MongoClient, ServerApiVersion } = require('mongodb');
const Razorpay = require('razorpay');
const authService = require('./auth/authService');
const dbModule = require('./db');
const pricingService = require('./services/pricingService');
const couponService = require('./services/couponService');

// Official Canonical Subscription Plan Configurations (Monthly Launch Pricing)
// Free: ₹0, Pro: ₹70/month (7000 paise), Elite: ₹150/month (15000 paise)
const PLANS = {
  entry_monthly: {
    plan: 'free',
    cycle: 'monthly',
    amount: 100, // ₹1 default (100 paise)
    currency: 'INR',
    period: 'monthly',
    totalCount: 120,
    name: 'Starter Access Pass — ₹1',
    display_name: 'Starter Access Pass — ₹1',
    payment_model: 'one_time'
  },
  pro_monthly: {
    plan: 'pro',
    cycle: 'monthly',
    amount: 7000,
    period: 'monthly',
    totalCount: 120,
    name: 'Comment2DM Pro Monthly'
  },
  elite_monthly: {
    plan: 'elite',
    cycle: 'monthly',
    amount: 15000,
    period: 'monthly',
    totalCount: 120,
    name: 'Comment2DM Elite Monthly'
  }
};

// Canonical Plan Matrix (Single Source of Truth)
const LIMITS = {
  free: {
    name: 'Comment2DM Free',
    price: 0,
    cycle: 'monthly',
    dmMonthly: 500,
    instagramAccounts: 1,
    automations: 2,
    storageBytes: 150000000, // 150 MB (decimal: 150 * 1,000,000 bytes)
    storageDisplay: '150 MB',
    allCommentsTrigger: false,
    followToUnlock: false,
    publicReplies: true, // Preserve basic Free access pending owner confirmation
    queuePriority: 'normal',
    advancedAnalytics: false,
    earlyAccess: false,
    prioritySupport: false,
    branding: true,
    whiteLabel: false,
    dashboardAds: true
  },
  pro: {
    name: 'Comment2DM Pro',
    price: 70,
    cycle: 'monthly',
    amount: 7000,
    dmMonthly: 5000,
    instagramAccounts: 3,
    automations: Infinity, // Unlimited active automations
    storageBytes: 1000000000, // 1 GB (decimal: 1,000,000,000 bytes)
    storageDisplay: '1 GB',
    allCommentsTrigger: true,
    followToUnlock: true,
    publicReplies: true,
    queuePriority: 'standard',
    advancedAnalytics: true,
    earlyAccess: false,
    prioritySupport: false,
    branding: false,
    whiteLabel: true,
    dashboardAds: false
  },
  elite: {
    name: 'Comment2DM Elite',
    price: 150,
    cycle: 'monthly',
    amount: 15000,
    dmMonthly: 50000,
    instagramAccounts: 10,
    automations: Infinity, // Unlimited active automations
    storageBytes: 5000000000, // 5 GB (decimal: 5,000,000,000 bytes)
    storageDisplay: '5 GB',
    allCommentsTrigger: true,
    followToUnlock: true,
    publicReplies: true,
    queuePriority: 'priority',
    advancedAnalytics: true,
    earlyAccess: true,
    prioritySupport: true,
    branding: false,
    whiteLabel: true,
    dashboardAds: false
  },
  // Compatibility aliases for legacy subscription records in DB
  creator: {
    name: 'Comment2DM Pro (Creator)',
    price: 70,
    cycle: 'monthly',
    amount: 7000,
    dmMonthly: 5000,
    instagramAccounts: 3,
    automations: Infinity,
    storageBytes: 1000000000,
    storageDisplay: '1 GB',
    allCommentsTrigger: true,
    followToUnlock: true,
    publicReplies: true,
    queuePriority: 'standard',
    advancedAnalytics: true,
    earlyAccess: false,
    prioritySupport: false,
    branding: false,
    whiteLabel: true,
    dashboardAds: false
  },
  growth: {
    name: 'Comment2DM Pro (Growth)',
    price: 70,
    cycle: 'monthly',
    amount: 7000,
    dmMonthly: 5000,
    instagramAccounts: 3,
    automations: Infinity,
    storageBytes: 1000000000,
    storageDisplay: '1 GB',
    allCommentsTrigger: true,
    followToUnlock: true,
    publicReplies: true,
    queuePriority: 'standard',
    advancedAnalytics: true,
    earlyAccess: false,
    prioritySupport: false,
    branding: false,
    whiteLabel: true,
    dashboardAds: false
  },
  scale: {
    name: 'Comment2DM Elite (Scale)',
    price: 150,
    cycle: 'monthly',
    amount: 15000,
    dmMonthly: 50000,
    instagramAccounts: 10,
    automations: Infinity,
    storageBytes: 5000000000,
    storageDisplay: '5 GB',
    allCommentsTrigger: true,
    followToUnlock: true,
    publicReplies: true,
    queuePriority: 'priority',
    advancedAnalytics: true,
    earlyAccess: true,
    prioritySupport: true,
    branding: false,
    whiteLabel: true,
    dashboardAds: false
  }
};

let db = null;
let mongo = null;
let rz = null;
let billingIndexesCreated = false;
const cache = new Map();

function createOperationContext() {
  return { _entitlementCache: new Map() };
}

function getAdminEmails() {
  const raw = process.env.ADMIN_EMAIL;
  if (!raw || typeof raw !== 'string') return new Set();
  const list = raw
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
  return new Set(list);
}

function isAdminEmail(email) {
  if (!email || typeof email !== 'string') return false;
  return getAdminEmails().has(email.trim().toLowerCase());
}

async function ensureBillingIndexes(d) {
  if (billingIndexesCreated || !d || !d.collection) return;
  billingIndexesCreated = true;
  try {
    await Promise.allSettled([
      d.collection('subscriptions').createIndex({ user_id: 1, created_at: -1 }),
      d.collection('subscriptions').createIndex({ razorpay_subscription_id: 1 }, { unique: true, sparse: true }),
      d.collection('billing_events').createIndex({ event_id: 1 }, { unique: true, sparse: true }),
      d.collection('billing_plans').createIndex({ plan_key: 1 }, { unique: true })
    ]);
  } catch (err) {
    console.warn('[BILLING INDEXES] Note:', err.message);
  }
}

async function store() {
  if (db) return db;

  // 1. Primary path: Reuse the existing shared database from src/db
  const sharedDb = dbModule.getDatabase && dbModule.getDatabase();
  if (sharedDb) {
    db = sharedDb;
    await ensureBillingIndexes(db);
    return db;
  }

  // 2. If src/db has not been initialized yet, initialize via src/db so that only ONE MongoClient is created
  if (process.env.MONGODB_URI && typeof dbModule.initialize === 'function') {
    try {
      await dbModule.initialize();
      const initializedDb = dbModule.getDatabase();
      if (initializedDb) {
        db = initializedDb;
        await ensureBillingIndexes(db);
        return db;
      }
    } catch (initErr) {
      throw initErr;
    }
  }

  // 3. Fallback: If MONGODB_URI is provided but dbModule is unavailable (isolated test environments)
  if (process.env.MONGODB_URI) {
    mongo = new MongoClient(process.env.MONGODB_URI, {
      serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
      maxPoolSize: 5
    });
    await mongo.connect();
    db = mongo.db(process.env.MONGODB_DB_NAME || 'nudge');
    await ensureBillingIndexes(db);
    return db;
  }

  throw new Error('Database not initialized and MONGODB_URI not configured.');
}

async function auth(req) {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      const user = await authService.getSessionUser(token);
      if (user) return user;
    }
    const sessionToken = req.cookies?.comment2dm_session || req.cookies?.nudge_session;
    if (sessionToken) {
      const user = await authService.getSessionUser(sessionToken);
      if (user) return user;
    }
    const token = req.cookies?.comment2dm_token || req.cookies?.nudge_token;
    if (token) {
      const p = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'], issuer: 'nudge-app', audience: 'nudge-web' });
      return p?.sub ? await authService.getUserById(p.sub) : null;
    }
    return null;
  } catch {
    return null;
  }
}

// In-memory short-lived entitlement cache to avoid redundant database reads during high-frequency automation processing
const globalEntitlementCache = new Map();
const GLOBAL_ENTITLEMENT_TTL_MS = 15000;

async function entitlement(uid, contextOrOptions = null) {
  if (!uid) {
    return {
      plan: 'free',
      isAdmin: false,
      limits: LIMITS.free,
      subscription: null
    };
  }

  // 1. Direct entitlement pass-through if already resolved
  if (contextOrOptions && typeof contextOrOptions === 'object' && contextOrOptions.entitlement) {
    return contextOrOptions.entitlement;
  }

  // 2. Identify per-operation cache target (scoped strictly to this operation)
  let opCache = null;
  if (contextOrOptions instanceof Map) {
    opCache = contextOrOptions;
  } else if (contextOrOptions && typeof contextOrOptions === 'object') {
    const targetObj = contextOrOptions.context || contextOrOptions.job || contextOrOptions.req || contextOrOptions;
    if (targetObj) {
      if (!targetObj._entitlementCache) {
        targetObj._entitlementCache = new Map();
      }
      opCache = targetObj._entitlementCache;
    }
  }

  const cacheKey = String(uid);
  if (opCache && opCache.has(cacheKey)) {
    return opCache.get(cacheKey);
  }

  try {
    const d = await store();
    const user = await d.collection('users').findOne({ id: uid }, { projection: { email: 1, entry_paid: 1, entry_expires_at: 1, entry_paid_at: 1 } });
    let result;

    if (isAdminEmail(user?.email)) {
      result = {
        plan: 'elite',
        isAdmin: true,
        hasPaidEntry: true,
        limits: {
          name: 'Comment2DM Admin',
          price: 0,
          cycle: 'monthly',
          amount: 0,
          instagramAccounts: Infinity,
          automations: Infinity,
          dmMonthly: 50000,
          storageBytes: 5000000000,
          storageDisplay: '5 GB',
          allCommentsTrigger: true,
          publicReplies: true,
          followToUnlock: true,
          queuePriority: 'priority',
          advancedAnalytics: true,
          earlyAccess: true,
          prioritySupport: true,
          branding: false,
          whiteLabel: true,
          dashboardAds: false
        },
        subscription: null
      };
    } else {
      const s = await d.collection('subscriptions').findOne(
        { user_id: uid, status: { $in: ['active', 'cancelled'] } },
        { sort: { created_at: -1 } }
      );
      let rawPlan = 'free';
      if (s) {
        if (s.status === 'active') {
          rawPlan = s.plan || 'free';
        } else if (s.status === 'cancelled' && s.current_end && new Date(s.current_end) > new Date()) {
          rawPlan = s.plan || 'free';
        }
      }
      const plan = LIMITS[rawPlan]
        ? (rawPlan === 'creator' || rawPlan === 'growth' ? 'pro' : rawPlan === 'scale' ? 'elite' : rawPlan)
        : 'free';

      let hasPaidEntry = Boolean(user?.entry_paid);
      if (user?.entry_expires_at && new Date(user.entry_expires_at) < new Date()) {
        hasPaidEntry = false;
      }
      if (!hasPaidEntry && s) {
        if (s.status === 'active' || (s.status === 'cancelled' && s.current_end && new Date(s.current_end) > new Date())) {
          hasPaidEntry = true;
        }
      }

      result = {
        plan,
        isAdmin: false,
        hasPaidEntry,
        limits: LIMITS[plan] || LIMITS.free,
        subscription: s
      };
    }

    if (opCache) {
      opCache.set(cacheKey, result);
    }
    return result;
  } catch (err) {
    return {
      plan: 'free',
      isAdmin: false,
      limits: LIMITS.free,
      subscription: null
    };
  }
}

async function counts(uid) {
  const d = await store();
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);

  const [accounts, automations, dmMonthly] = await Promise.all([
    d.collection('instagram_accounts').countDocuments({ owner_user_id: uid }),
    d.collection('automations').countDocuments({ owner_user_id: uid, enabled: { $in: [true, 1, '1'] } }),
    d.collection('automation_events').countDocuments({
      owner_user_id: uid,
      event_type: { $in: ['private_reply', 'resource_delivered'] },
      status: 'success',
      created_at: { $gte: start.toISOString() }
    })
  ]);
  return { accounts, automations, dmMonthly };
}

/**
 * Central automation access and entitlement checker
 * Ensures active Pro, Elite, and Admin subscribers unconditionally bypass entry gates.
 */
async function getAutomationAccess(uid, options = {}) {
  const e = await entitlement(uid, options);
  const c = await counts(uid);

  // 1. Pro, Elite subscribers & Admins NEVER get gated by the ₹1 entry fee
  if (e.isAdmin || e.plan === 'pro' || e.plan === 'elite') {
    return {
      allowed: true,
      canCreate: true,
      canActivate: true,
      isGated: false,
      plan: e.plan,
      isAdmin: Boolean(e.isAdmin),
      hasPaidEntry: true,
      used: c.automations,
      limit: e.limits?.automations ?? Infinity,
      message: 'Active subscription entitlements verified.'
    };
  }

  // 2. Free tier account gating check
  const entryPricing = await pricingService.getEntryPricing();
  const entryActive = entryPricing && entryPricing.is_active && entryPricing.monthly > 0 && entryPricing.gate_automations_if_unpaid;

  if (entryActive && !e.hasPaidEntry) {
    return {
      allowed: false,
      canCreate: false,
      canActivate: false,
      isGated: true,
      code: 'ENTRY_FEE_REQUIRED',
      requiresPayment: true,
      entryPrice: entryPricing.monthly || 1,
      accessPass: 'Starter Access Pass — ₹1',
      paymentModel: entryPricing.payment_model || 'one_time',
      message: 'Starter Access Pass (₹1 one-time entry fee) is required to create or activate automations. You can explore all other platform features for free.'
    };
  }

  // 3. Paid Starter Pass or entry gate inactive: Free plan limit is 2 active automations
  const freeLimit = e.limits?.automations ?? 2;
  const canCreate = c.automations < freeLimit;

  return {
    allowed: canCreate,
    canCreate,
    canActivate: true,
    isGated: false,
    plan: 'free',
    hasPaidEntry: Boolean(e.hasPaidEntry),
    accessPass: e.hasPaidEntry ? 'Starter Access Pass — ₹1' : null,
    used: c.automations,
    limit: freeLimit,
    message: canCreate ? 'Starter access active.' : `Free plan limit reached (${c.automations}/${freeLimit} automations). Upgrade to Pro or Elite for unlimited automations.`
  };
}

async function check(uid, resource, options = {}) {
  const e = await entitlement(uid, options);
  const c = await counts(uid);

  if (resource === 'automations') {
    const autoAccess = await getAutomationAccess(uid, options);
    return {
      ...e,
      used: c.automations,
      allowed: autoAccess.allowed,
      automationAccess: autoAccess,
      ...(autoAccess.code ? { code: autoAccess.code, requiresPayment: autoAccess.requiresPayment, message: autoAccess.message } : {})
    };
  }

  const used = resource === 'instagramAccounts' ? c.accounts : c.dmMonthly;
  return { ...e, used, allowed: e.limits[resource] === Infinity || used < e.limits[resource] };
}

async function billingRateLimit(req, res, next) {
  try {
    const u = await auth(req);
    if (isAdminEmail(u?.email)) return next();
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const uid = u?.id || 'anon';
    const key = `billing:${req.path}:${uid}`;
    const max = req.path.includes('create-subscription') ? 5 : req.path.includes('verify-subscription') ? 15 : 10;
    if (!(await require('../src/db').consumeRateLimit(key, 15 * 60 * 1000, max))) {
      res.setHeader('Retry-After', '900');
      return res.status(429).json({ error: 'Too many billing requests. Please try again later.' });
    }
    next();
  } catch (e) {
    return res.status(503).json({ error: 'Billing is temporarily unavailable. Please try again shortly.' });
  }
}

async function razor() {
  if (rz) return rz;
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) return null;
  rz = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
  });
  return rz;
}

async function planList() {
  const authHeader = Buffer.from(process.env.RAZORPAY_KEY_ID + ':' + process.env.RAZORPAY_KEY_SECRET).toString('base64');
  const r = await fetch('https://api.razorpay.com/v1/plans?count=100', {
    headers: { Authorization: 'Basic ' + authHeader },
    signal: AbortSignal.timeout(10000)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.description || 'Unable to list Razorpay plans.');
  return j.items || [];
}

async function ensurePlans() {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    console.log('Razorpay keys not configured; subscription plans will be initialized when keys are added.');
    return;
  }
  try {
    const d = await store();
    const existing = await planList();
    const authHeader = Buffer.from(process.env.RAZORPAY_KEY_ID + ':' + process.env.RAZORPAY_KEY_SECRET).toString('base64');

    for (const [k, x] of Object.entries(PLANS)) {
      let p = existing.find((v) => (v?.notes?.comment2dm_plan_key === k || v?.notes?.nudge_plan_key === k) && v?.item?.amount === x.amount);
      if (!p) {
        const r = await fetch('https://api.razorpay.com/v1/plans', {
          method: 'POST',
          headers: { Authorization: 'Basic ' + authHeader, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            period: x.period,
            interval: 1,
            item: { name: x.name, amount: x.amount, currency: 'INR', description: x.name + ' for Comment2DM' },
            notes: { comment2dm_plan_key: k, product: 'comment2dm' }
          }),
          signal: AbortSignal.timeout(10000)
        });
        p = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(p?.error?.description || ('Unable to create plan ' + k));
      }
      cache.set(k, p.id);
      await d.collection('billing_plans').updateOne(
        { plan_key: k },
        { $set: { plan_key: k, razorpay_plan_id: p.id, amount: x.amount, currency: 'INR', period: x.period, updated_at: new Date().toISOString() } },
        { upsert: true }
      );
    }
    console.log('Razorpay Comment2DM subscription plans are ready.');
  } catch (e) {
    console.error('Razorpay plan setup note:', e.message);
  }
}

async function planId(k, targetAmount = null) {
  const targetPlan = PLANS[k];
  if (!targetPlan) return null;
  const effectiveAmount = (typeof targetAmount === 'number' && targetAmount > 0) ? targetAmount : targetPlan.amount;
  const cacheKey = `${k}_${effectiveAmount}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const d = await store();
  let p = await d.collection('billing_plans').findOne({ plan_key: k, amount: effectiveAmount });
  if (!p && effectiveAmount === targetPlan.amount) {
    p = await d.collection('billing_plans').findOne({ plan_key: k });
    if (p && p.amount && p.amount !== effectiveAmount) p = null;
  }
  if (p?.razorpay_plan_id) {
    cache.set(cacheKey, p.razorpay_plan_id);
    return p.razorpay_plan_id;
  }

  // Attempt dynamic plan resolution via pricingService
  try {
    const pid = await pricingService.ensureRazorpayPlan(k, effectiveAmount, `${targetPlan.name} (₹${effectiveAmount / 100}/mo)`);
    if (pid) {
      cache.set(cacheKey, pid);
      return pid;
    }
  } catch (err) {
    console.error('[Billing Plan ID Resolution Warning]:', err.message);
  }

  await ensurePlans();
  return cache.get(k);
}

function equal(a, b) {
  a = Buffer.from(String(a || ''));
  b = Buffer.from(String(b || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function create(req, res) {
  const u = await auth(req);
  if (!u) return res.status(401).json({ error: 'Authentication required.' });

  const rawKey = String(req.body?.planKey || '');
  const x = PLANS[rawKey];
  if (!x) return res.status(400).json({ error: 'Invalid subscription plan.' });

  const r = await razor();
  if (!r) return res.status(503).json({ error: 'Razorpay is not configured on Comment2DM yet.' });

  const d = await store();
  const existing = await d.collection('subscriptions').findOne(
    { user_id: u.id, status: { $in: ['created', 'authenticated', 'pending', 'active'] } },
    { sort: { created_at: -1 } }
  );

  if (existing) {
    if (existing.status === 'active' && existing.plan_key !== 'entry_monthly' && existing.plan !== 'entry') {
      return res.status(409).json({ error: 'You already have an active subscription. Cancel it before starting another plan.' });
    }
    if (existing.plan_key === rawKey && existing.razorpay_subscription_id && !req.body?.couponCode) {
      return res.json({
        keyId: process.env.RAZORPAY_KEY_ID,
        subscriptionId: existing.razorpay_subscription_id,
        planKey: existing.plan_key,
        amount: existing.amount || PLANS[existing.plan_key]?.amount || x.amount,
        currency: 'INR',
        name: 'Comment2DM',
        prefill: {}
      });
    }
  }

  // 1. Calculate effective plan amount taking active promotional campaign into account
  const effectivePricing = await pricingService.getEffectivePricing();
  const targetPlanInfo = effectivePricing.plans[x.plan];
  let payablePaise = targetPlanInfo ? targetPlanInfo.amount_paise : x.amount;
  let isSale = targetPlanInfo ? targetPlanInfo.is_sale : false;
  let promoBadge = targetPlanInfo ? targetPlanInfo.badge : null;

  // 2. Validate and apply coupon if provided
  let couponData = null;
  const rawCoupon = String(req.body?.couponCode || '').trim().toUpperCase();
  if (rawCoupon) {
    const couponValidation = await couponService.validateCoupon(rawCoupon, rawKey, u.id, payablePaise / 100);
    if (!couponValidation.valid) {
      return res.status(400).json({ error: couponValidation.error || 'Invalid or expired coupon code.' });
    }
    couponData = couponValidation;
    payablePaise = Math.round(couponValidation.final_rupees * 100);
  }

  // 3. Resolve matching Razorpay Plan ID for the exact payable amount
  const pid = await planId(rawKey, payablePaise);
  if (!pid) return res.status(503).json({ error: 'Payment plans are not ready yet. Please try again shortly.' });

  const user = await d.collection('users').findOne({ id: u.id }, { projection: { id: 1, name: 1, email: 1 } });
  const s = await r.subscriptions.create({
    plan_id: pid,
    total_count: x.totalCount,
    customer_notify: 1,
    notes: {
      user_id: u.id,
      plan_key: rawKey,
      coupon_code: couponData ? couponData.code : '',
      payable_amount_paise: payablePaise
    }
  });

  // 4. If coupon was applied, atomically reserve with TTL
  if (couponData && couponData.code) {
    await couponService.reserveCoupon(couponData.code, u.id, s.id, {
      plan_key: rawKey,
      plan_name: x.name,
      original_rupees: couponData.original_rupees,
      discount_rupees: couponData.discount_rupees,
      final_rupees: couponData.final_rupees
    });
  }

  await d.collection('subscriptions').updateOne(
    { razorpay_subscription_id: s.id },
    {
      $set: {
        user_id: u.id,
        plan: x.plan,
        billing_cycle: x.cycle,
        plan_key: rawKey,
        razorpay_plan_id: pid,
        amount: payablePaise,
        coupon_applied: couponData ? couponData.code : null,
        status: s.status || 'created',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    },
    { upsert: true }
  );

  return res.json({
    keyId: process.env.RAZORPAY_KEY_ID,
    subscriptionId: s.id,
    planKey: rawKey,
    amount: payablePaise,
    currency: 'INR',
    name: 'Comment2DM',
    prefill: { name: user?.name || '', email: user?.email || '' },
    isSale: isSale,
    badge: promoBadge,
    couponApplied: couponData ? {
      code: couponData.code,
      discount_rupees: couponData.discount_rupees,
      final_rupees: couponData.final_rupees,
      duration: couponData.duration,
      duration_in_months: couponData.duration_in_months
    } : null
  });
}

async function verify(req, res) {
  const u = await auth(req);
  if (!u) return res.status(401).json({ error: 'Authentication required.' });

  const sid = String(req.body?.razorpay_subscription_id || '');
  const pid = String(req.body?.razorpay_payment_id || '');
  const sig = String(req.body?.razorpay_signature || '');
  if (!sid || !pid || !sig) return res.status(400).json({ error: 'Incomplete payment verification data.' });

  if (!process.env.RAZORPAY_KEY_SECRET) {
    return res.status(503).json({ error: 'Payment verification service is not configured.' });
  }

  const exp = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(pid + '|' + sid).digest('hex');
  if (!equal(exp, sig)) return res.status(400).json({ error: 'Payment signature verification failed.' });

  const d = await store();
  const s = await d.collection('subscriptions').findOne({ razorpay_subscription_id: sid, user_id: u.id });
  if (!s) return res.status(404).json({ error: 'Subscription record not found.' });

  const nowIso = new Date().toISOString();
  // Set period to 30 days from now for active cycle
  const currentEndIso = new Date(Date.now() + 30 * 86400000).toISOString();

  await d.collection('subscriptions').updateOne(
    { _id: s._id },
    {
      $set: {
        status: 'active',
        razorpay_payment_id: pid,
        current_start: nowIso,
        current_end: currentEndIso,
        updated_at: nowIso
      }
    }
  );

  // If there was a reserved coupon for this subscription, confirm redemption
  await couponService.confirmRedemption(sid, pid);

  const isEntry = s.plan_key === 'entry_monthly' || s.plan === 'entry';
  const itemName = isEntry ? 'Starter Access Pass — ₹1' : (s.plan === 'elite' ? 'Elite Plan' : 'Pro Plan');
  const paymentModel = isEntry ? 'one_time' : 'recurring';

  // Record captured payment
  await d.collection('payments').updateOne(
    { razorpay_payment_id: pid },
    {
      $set: {
        user_id: u.id,
        subscription_id: sid,
        razorpay_payment_id: pid,
        plan: isEntry ? 'entry_monthly' : s.plan,
        item_name: itemName,
        amount: s.amount || PLANS[s.plan_key]?.amount || (isEntry ? 100 : 7000),
        currency: 'INR',
        status: 'paid',
        payment_model: paymentModel,
        created_at: nowIso
      }
    },
    { upsert: true }
  );

  // Mark entry paid on user document
  await d.collection('users').updateOne(
    { id: u.id },
    {
      $set: {
        entry_paid: true,
        entry_paid_at: nowIso,
        entry_expires_at: isEntry ? null : currentEndIso,
        entry_payment_id: pid
      }
    }
  );

  // Invalidate entitlement cache for user
  globalEntitlementCache.delete(u.id);

  return res.json({ verified: true, plan: s.plan });
}

async function cancel(req, res) {
  const u = await auth(req);
  if (!u) return res.status(401).json({ error: 'Authentication required.' });

  const d = await store();
  const s = await d.collection('subscriptions').findOne(
    { user_id: u.id, status: { $in: ['created', 'authenticated', 'active', 'pending', 'halted'] } },
    { sort: { created_at: -1 } }
  );
  if (!s) return res.status(404).json({ error: 'No active subscription found.' });

  if (s.razorpay_subscription_id) {
    const r = await razor();
    if (!r) {
      console.warn('[Billing Cancel] Payment provider unavailable for subscription:', s.razorpay_subscription_id);
      return res.status(503).json({
        error: 'Payment provider is currently unavailable. Please try again later.'
      });
    }

    try {
      const cancelRes = await r.subscriptions.cancel(s.razorpay_subscription_id, false);
      if (!cancelRes || (cancelRes.status && cancelRes.status !== 'cancelled' && cancelRes.status !== 'completed')) {
        console.warn('[Billing Cancel] Razorpay cancellation unconfirmed:', cancelRes);
        return res.status(502).json({
          error: 'Payment provider did not confirm subscription cancellation. Your subscription remains active. Please try again or contact support.'
        });
      }
    } catch (rzErr) {
      console.error('[Billing Cancel] Razorpay cancellation failed:', rzErr.message);
      return res.status(502).json({
        error: 'Unable to cancel subscription with payment provider. Your subscription remains active. Please try again or contact support.'
      });
    }
  }

  try {
    const updateRes = await d.collection('subscriptions').updateOne(
      { _id: s._id },
      { $set: { status: 'cancelled', updated_at: new Date().toISOString() } }
    );
    if (!updateRes || (updateRes.matchedCount === 0 && updateRes.modifiedCount === 0)) {
      throw new Error('Local database update matched 0 documents');
    }
  } catch (dbErr) {
    console.error('[Billing Cancel] Failed to update local subscription record:', dbErr.message);
    return res.status(500).json({
      error: 'Subscription was cancelled with payment provider, but failed to update local records. Please refresh or contact support.'
    });
  }

  return res.json({ cancelled: true });
}

async function getActiveSubscription(uid) {
  const d = await store();
  return await d.collection('subscriptions').findOne({
    user_id: String(uid),
    status: { $in: ['created', 'authenticated', 'active', 'pending', 'halted'] }
  });
}

// In-memory fallback for local testing when MongoDB is offline
const localCreditUsageMap = new Map();

async function getAiCreditBalance(uid, options = {}) {
  try {
    const e = await entitlement(uid, options);
    if (e.isAdmin || e.limits.aiCreditsMonthly === Infinity) {
      return {
        plan: e.plan,
        isAdmin: true,
        limit: Infinity,
        used: 0,
        balance: Infinity
      };
    }

    const start = new Date();
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);

    let used = 0;
    try {
      const d = await store();
      const records = await d.collection('ai_credit_usage').find({
        user_id: String(uid),
        created_at: { $gte: start.toISOString() }
      }).toArray();
      used = records.reduce((sum, r) => sum + (Number(r.credits) || 0), 0);
    } catch (dbErr) {
      // Memory fallback for local testing
      const memList = localCreditUsageMap.get(String(uid)) || [];
      used = memList
        .filter(r => r.created_at >= start.toISOString())
        .reduce((sum, r) => sum + (Number(r.credits) || 0), 0);
    }

    const limit = Number(e.limits.aiCreditsMonthly) || 100;
    const balance = Math.max(0, limit - used);

    return {
      plan: e.plan,
      isAdmin: false,
      limit,
      used,
      balance
    };
  } catch (err) {
    return {
      plan: 'free',
      isAdmin: false,
      limit: 100,
      used: 0,
      balance: 100
    };
  }
}

async function deductAiCredits(uid, cost, tool = 'general') {
  const numCost = Math.max(0, parseInt(cost, 10) || 0);
  if (numCost === 0) {
    const current = await getAiCreditBalance(uid);
    return { success: true, remaining: current.balance, deducted: 0 };
  }

  const current = await getAiCreditBalance(uid);
  if (!current.isAdmin && current.balance < numCost) {
    const error = new Error(`Insufficient AI credits. You have ${current.balance} credits remaining, but this operation requires ${numCost} credits.`);
    error.statusCode = 402;
    error.balance = current.balance;
    error.required = numCost;
    throw error;
  }

  const record = {
    user_id: String(uid),
    tool: String(tool || 'ai_tool'),
    credits: numCost,
    created_at: new Date().toISOString()
  };

  try {
    const d = await store();
    await d.collection('ai_credit_usage').insertOne(record);
  } catch (dbErr) {
    // Memory fallback for local testing
    const memList = localCreditUsageMap.get(String(uid)) || [];
    memList.push(record);
    localCreditUsageMap.set(String(uid), memList);
  }

  const remaining = current.isAdmin ? Infinity : Math.max(0, current.balance - numCost);
  return {
    success: true,
    remaining,
    deducted: numCost
  };
}

async function status(req, res) {
  const u = await auth(req);
  if (!u) return res.status(401).json({ error: 'Authentication required.' });
  const storageService = require('./services/storageService');
  const [e, c, storageUsage, effectivePricing] = await Promise.all([
    entitlement(u.id, req),
    counts(u.id),
    storageService.getStorageUsage(u.id),
    pricingService.getEffectivePricing()
  ]);

  const autoAccess = await getAutomationAccess(u.id, req);

  return res.json({
    plan: e.plan,
    isAdmin: !!e.isAdmin,
    hasPaidEntry: Boolean(e.hasPaidEntry),
    entryPricing: effectivePricing.entry_pricing || null,
    automationAccess: autoAccess,
    starterPass: {
      name: 'Starter Access Pass — ₹1',
      amount: 1,
      currency: 'INR',
      paymentModel: effectivePricing.entry_pricing?.payment_model || 'one_time',
      status: e.hasPaidEntry ? 'Paid' : 'Unpaid'
    },
    subscription: e.subscription ? { status: e.subscription.status, billingCycle: e.subscription.billing_cycle, currentEnd: e.subscription.current_end } : null,
    limits: {
      instagramAccounts: Number.isFinite(e.limits.instagramAccounts) ? e.limits.instagramAccounts : null,
      automations: Number.isFinite(e.limits.automations) ? e.limits.automations : null,
      dmMonthly: e.limits.dmMonthly === Infinity ? 50000 : (Number.isFinite(e.limits.dmMonthly) ? e.limits.dmMonthly : 500),
      storageBytes: e.limits.storageBytes,
      storageDisplay: e.limits.storageDisplay,
      allCommentsTrigger: e.limits.allCommentsTrigger,
      followToUnlock: e.limits.followToUnlock,
      publicReplies: e.limits.publicReplies,
      queuePriority: e.limits.queuePriority,
      advancedAnalytics: e.limits.advancedAnalytics,
      earlyAccess: e.limits.earlyAccess,
      prioritySupport: e.limits.prioritySupport,
      branding: e.limits.branding,
      whiteLabel: e.limits.whiteLabel,
      dashboardAds: e.limits.dashboardAds
    },
    usage: {
      instagramAccounts: c.accounts,
      automations: c.automations,
      dmMonthly: c.dmMonthly,
      storageBytes: storageUsage.usedBytes,
      storageFormatted: storageUsage.usedFormatted,
      storageRemainingFormatted: storageUsage.remainingFormatted,
      storageTotalFormatted: storageUsage.totalFormatted,
      storagePercentage: storageUsage.percentage
    }
  });
}


async function history(req, res) {
  const u = await auth(req);
  if (!u) return res.status(401).json({ error: 'Authentication required.' });

  try {
    const d = await store();
    const rawPayments = await d.collection('payments')
      .find({ user_id: u.id })
      .sort({ created_at: -1 })
      .limit(50)
      .toArray();

    const payments = rawPayments.map(p => {
      const isEntry = p.plan === 'entry' || p.plan === 'entry_monthly' || p.amount === 100 || (p.item_name && p.item_name.includes('Starter Access Pass'));
      const planDisplay = isEntry ? 'Starter Access Pass — ₹1' : (p.plan === 'elite' ? 'Elite' : p.plan === 'pro' ? 'Pro' : (p.plan ? p.plan.charAt(0).toUpperCase() + p.plan.slice(1) : '–'));
      const paymentModel = isEntry ? 'One-time payment' : 'Monthly subscription';
      const status = (p.status === 'captured' || p.status === 'paid' || p.status === 'success') ? 'paid' : (p.status === 'failed' ? 'failed' : 'pending');

      return {
        id: p.razorpay_payment_id || p._id,
        plan: planDisplay,
        rawPlan: p.plan,
        amount: p.amount || (isEntry ? 100 : 7000),
        currency: p.currency || 'INR',
        status,
        paymentModel,
        isEntryPass: isEntry,
        created_at: p.created_at || new Date().toISOString()
      };
    });

    return res.json({ payments });
  } catch (err) {
    console.error('[Billing History Error]:', err.message);
    return res.json({ payments: [] });
  }
}

function getCanonicalPlans() {
  return {
    free: LIMITS.free,
    pro: LIMITS.pro,
    elite: LIMITS.elite
  };
}

function plansEndpoint(req, res) {
  return res.json({
    plans: getCanonicalPlans()
  });
}

async function webhook(req, res) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return res.status(503).send('Webhook secret is not configured.');
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const sig = req.get('x-razorpay-signature');
  if (!sig) return res.status(400).send('Missing webhook signature.');
  const exp = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  if (!equal(exp, sig)) return res.status(400).send('Invalid webhook signature.');

  let ev;
  try {
    ev = JSON.parse(raw.toString());
  } catch {
    return res.status(400).send('Invalid JSON.');
  }

  const d = await store();
  const eid = req.get('x-razorpay-event-id') || crypto.createHash('sha256').update(raw).digest('hex');
  try {
    await d.collection('billing_events').insertOne({ event_id: eid, event: ev, created_at: new Date().toISOString() });
  } catch (e) {
    if (e?.code === 11000) return res.json({ ok: true, duplicate: true });
    throw e;
  }

  const ent = ev?.payload?.subscription?.entity;
  if (ent?.id) {
    const map = {
      'subscription.activated': 'active',
      'subscription.pending': 'pending',
      'subscription.halted': 'halted',
      'subscription.cancelled': 'cancelled',
      'subscription.completed': 'completed'
    };
    const st = map[ev.event] || ent.status;
    await d.collection('subscriptions').updateOne(
      { razorpay_subscription_id: ent.id },
      {
        $set: {
          status: st,
          current_start: ent.current_start ? new Date(ent.current_start * 1000).toISOString() : null,
          current_end: ent.current_end ? new Date(ent.current_end * 1000).toISOString() : null,
          updated_at: new Date().toISOString()
        }
      }
    );
  }
  return res.json({ ok: true });
}

function register(app) {
  app.post('/api/billing/webhook', require('express').raw({ type: 'application/json', limit: '256kb' }), webhook);
  app.get('/api/billing/status', status);
  app.get('/api/billing/history', history);
  app.get('/api/billing/plans', plansEndpoint);
  app.post('/api/billing/create-subscription', billingRateLimit, require('express').json({ limit: '10kb' }), create);
  app.post('/api/billing/verify-subscription', billingRateLimit, require('express').json({ limit: '10kb' }), verify);
  app.post('/api/billing/cancel', billingRateLimit, require('express').json({ limit: '10kb' }), cancel);

  // Enforce tier limits
  app.use('/api/instagram/authorize', async (req, res, next) => {
    const u = await auth(req);
    if (!u) return next();
    try {
      const r = await check(u.id, 'instagramAccounts');
      if (!r.allowed) {
        const errorMsg = `Your ${r.plan.toUpperCase()} plan allows ${r.limits.instagramAccounts} Instagram account${r.limits.instagramAccounts === 1 ? '' : 's'}. Upgrade to connect more.`;
        return res.redirect(`/instagram-accounts.html?instagram_error=${encodeURIComponent(errorMsg)}`);
      }
      next();
    } catch (e) {
      next(e);
    }
  });

  app.use('/api/automations', async (req, res, next) => {
    if (req.method !== 'POST') return next();
    const u = await auth(req);
    if (!u) return next();
    try {
      const access = await getAutomationAccess(u.id);
      if (!access.allowed) {
        if (access.isGated) {
          return res.status(403).json({
            error: access.message,
            code: 'ENTRY_FEE_REQUIRED',
            requiresPayment: true,
            entryPrice: access.entryPrice || 1
          });
        }
        return res.status(403).json({
          error: access.message || `Your ${access.plan.toUpperCase()} plan allows ${access.limit} active automations. Upgrade to Pro or Elite to create more.`
        });
      }
      next();
    } catch (e) {
      next(e);
    }
  });
}

function registerPostParser(app) {
  app.use('/api/instagram/webhook', async (req, res, next) => {
    try {
      const entries = Array.isArray(req.body?.entry) ? req.body.entry : [];
      for (const entry of entries) {
        const ig = String(entry?.id || '');
        if (!ig) continue;
        const d = await store();
        const account = await d.collection('instagram_accounts').findOne({ instagram_user_id: ig }, { projection: { owner_user_id: 1 } });
        if (!account) continue;
        const r = await check(account.owner_user_id, 'dmMonthly');
        if (!r.allowed) {
          req.billingBlocked = true;
          break;
        }
      }
      next();
    } catch (e) {
      next(e);
    }
  });
}

async function close() {
  if (mongo) {
    if (typeof mongo.close === 'function') {
      await mongo.close();
    }
    mongo = null;
  }
  db = null;
  billingIndexesCreated = false;
}

function _setDbForTesting(mockDb) {
  db = mockDb;
  billingIndexesCreated = false;
}

function _getDb() {
  return db;
}

function _getClient() {
  return mongo || (dbModule.getClient && dbModule.getClient());
}

function _setRazorpayForTesting(mockRz) {
  rz = mockRz;
}

module.exports = {
  register,
  registerPostParser,
  ensurePlans,
  check,
  entitlement,
  counts,
  getAiCreditBalance,
  deductAiCredits,
  createOperationContext,
  close,
  _setDbForTesting,
  _getDb,
  _getClient,
  _setRazorpayForTesting,
  _clearEntitlementCacheForTesting: () => globalEntitlementCache.clear(),
  PLANS,
  LIMITS,
  CANONICAL_PLANS: LIMITS,
  getCanonicalPlans,
  isAdminEmail,
  getAdminEmails,
  getActiveSubscription,
  getAutomationAccess,
  history
};