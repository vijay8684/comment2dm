// src/services/pricingService.js
// Comment2DM — Canonical Pricing & Promotional Campaigns Engine for VI Tech

'use strict';

const db = require('../db');

async function getDbHandle() {
  if (typeof db.connect === 'function') {
    try {
      const conn = await db.connect();
      if (conn && typeof conn.collection === 'function') return conn;
    } catch (e) {}
  }
  if (typeof db.collections === 'function') {
    const cols = db.collections();
    return {
      collection: (name) => {
        if (cols && cols[name]) return cols[name];
        return {
          findOne: async () => null,
          find: () => ({
            sort: () => ({
              skip: () => ({ limit: () => ({ toArray: async () => [] }) }),
              limit: () => ({ toArray: async () => [] }),
              toArray: async () => []
            }),
            toArray: async () => []
          }),
          countDocuments: async () => 0,
          updateOne: async () => ({ acknowledged: true, matchedCount: 1, modifiedCount: 1 }),
          insertOne: async (doc) => ({ acknowledged: true, insertedId: doc._id || 'mock_id' }),
          deleteOne: async () => ({ acknowledged: true }),
          deleteMany: async () => ({ acknowledged: true })
        };
      }
    };
  }
  return {
    collection: () => ({
      findOne: async () => null,
      find: () => ({ sort: () => ({ toArray: async () => [] }), toArray: async () => [] }),
      countDocuments: async () => 0,
      updateOne: async () => ({ acknowledged: true }),
      insertOne: async () => ({ acknowledged: true })
    })
  };
}

const { logAdminAction } = require('./auditService');

// Launch Default Prices (in INR and paise)
const CANONICAL_DEFAULTS = {
  pro: {
    name: 'Pro',
    monthly: 70, // ₹70/month
    amount_paise: 7000,
    currency: 'INR'
  },
  elite: {
    name: 'Elite',
    monthly: 150, // ₹150/month
    amount_paise: 15000,
    currency: 'INR'
  },
  free: {
    name: 'Free',
    monthly: 0,
    amount_paise: 0,
    currency: 'INR'
  }
};

let inMemoryCatalogCache = null;
let inMemoryCatalogCacheTime = 0;
const CATALOG_CACHE_TTL_MS = 15000; // 15 seconds

/**
 * Retrieve canonical base catalog from database or defaults
 */
async function getPricingCatalog(bypassCache = false) {
  const now = Date.now();
  if (!bypassCache && inMemoryCatalogCache && (now - inMemoryCatalogCacheTime < CATALOG_CACHE_TTL_MS)) {
    return inMemoryCatalogCache;
  }

  try {
    const database = await getDbHandle();
    const doc = await database.collection('pricing_catalog').findOne({ _id: 'active_catalog' });
    if (doc && doc.pro && doc.elite) {
      inMemoryCatalogCache = {
        pro: {
          name: 'Pro',
          monthly: Number(doc.pro.monthly) || CANONICAL_DEFAULTS.pro.monthly,
          amount_paise: (Number(doc.pro.monthly) || CANONICAL_DEFAULTS.pro.monthly) * 100,
          currency: 'INR'
        },
        elite: {
          name: 'Elite',
          monthly: Number(doc.elite.monthly) || CANONICAL_DEFAULTS.elite.monthly,
          amount_paise: (Number(doc.elite.monthly) || CANONICAL_DEFAULTS.elite.monthly) * 100,
          currency: 'INR'
        },
        free: { ...CANONICAL_DEFAULTS.free },
        updated_at: doc.updated_at || new Date().toISOString()
      };
      inMemoryCatalogCacheTime = now;
      return inMemoryCatalogCache;
    }

    // Seed defaults if not present
    const seeded = {
      _id: 'active_catalog',
      pro: { monthly: CANONICAL_DEFAULTS.pro.monthly },
      elite: { monthly: CANONICAL_DEFAULTS.elite.monthly },
      free: { monthly: 0 },
      updated_at: new Date().toISOString()
    };
    await database.collection('pricing_catalog').updateOne(
      { _id: 'active_catalog' },
      { $setOnInsert: seeded },
      { upsert: true }
    );

    inMemoryCatalogCache = {
      pro: { ...CANONICAL_DEFAULTS.pro },
      elite: { ...CANONICAL_DEFAULTS.elite },
      free: { ...CANONICAL_DEFAULTS.free },
      updated_at: seeded.updated_at
    };
    inMemoryCatalogCacheTime = now;
    return inMemoryCatalogCache;
  } catch (err) {
    console.error('[Pricing Service] Error fetching pricing catalog:', err.message);
    return {
      pro: { ...CANONICAL_DEFAULTS.pro },
      elite: { ...CANONICAL_DEFAULTS.elite },
      free: { ...CANONICAL_DEFAULTS.free },
      updated_at: new Date().toISOString()
    };
  }
}

/**
 * Update regular monthly prices for Pro and/or Elite
 */
async function updateRegularPrices({ proMonthly, eliteMonthly }, adminEmail = 'owner', reason = '', ip = '') {
  const current = await getPricingCatalog(true);
  const newPro = proMonthly !== undefined ? Math.max(1, Math.round(Number(proMonthly))) : current.pro.monthly;
  const newElite = eliteMonthly !== undefined ? Math.max(1, Math.round(Number(eliteMonthly))) : current.elite.monthly;

  if (isNaN(newPro) || isNaN(newElite)) {
    throw new Error('Invalid price values provided.');
  }

  const database = await getDbHandle();
  const updatedAt = new Date().toISOString();

  await database.collection('pricing_catalog').updateOne(
    { _id: 'active_catalog' },
    {
      $set: {
        pro: { monthly: newPro },
        elite: { monthly: newElite },
        free: { monthly: 0 },
        updated_at: updatedAt,
        updated_by: adminEmail
      }
    },
    { upsert: true }
  );

  inMemoryCatalogCache = null; // Invalidate cache

  await logAdminAction({
    actor: adminEmail,
    action: 'regular_price_updated',
    target: 'pricing_catalog',
    prevValue: { pro: current.pro.monthly, elite: current.elite.monthly },
    newValue: { pro: newPro, elite: newElite },
    reason: reason || 'Updated regular base subscription pricing',
    ip
  });

  return getPricingCatalog(true);
}

/**
 * Get active promotional campaign applicable at given date
 */
async function getActiveCampaign(atDate = new Date()) {
  try {
    const database = await getDbHandle();
    const isoDate = atDate instanceof Date ? atDate.toISOString() : new Date(atDate).toISOString();

    const campaign = await database.collection('pricing_campaigns').findOne({
      status: 'active',
      start_date: { $lte: isoDate },
      end_date: { $gte: isoDate }
    }, { sort: { created_at: -1 } });

    return campaign || null;
  } catch (err) {
    console.error('[Pricing Service] Error finding active campaign:', err.message);
    return null;
  }
}

/**
 * Get all campaigns (active, scheduled, ended)
 */
async function getCampaigns({ status = null } = {}) {
  try {
    const database = await getDbHandle();
    const query = {};
    if (status) query.status = status;

    const list = await database.collection('pricing_campaigns')
      .find(query)
      .sort({ created_at: -1 })
      .toArray();

    return list;
  } catch (err) {
    console.error('[Pricing Service] Error getting campaigns:', err.message);
    return [];
  }
}

/**
 * Create a new promotional campaign
 */
async function createCampaign(campaignData, adminEmail = 'owner', ip = '') {
  const {
    name,
    description = '',
    applicable_plans = ['pro', 'elite'], // 'pro', 'elite', or both
    sale_price_pro = null,
    sale_price_elite = null,
    start_date,
    end_date,
    badge_text = 'SALE',
    status = 'active',
    renewal_terms = 'First monthly billing cycle only. Regular price applies on renewal.'
  } = campaignData;

  if (!name || !start_date || !end_date) {
    throw new Error('Campaign name, start date, and end date are required.');
  }

  const startDateObj = new Date(start_date);
  const endDateObj = new Date(end_date);
  if (isNaN(startDateObj.getTime()) || isNaN(endDateObj.getTime())) {
    throw new Error('Invalid start or end date format.');
  }
  if (endDateObj <= startDateObj) {
    throw new Error('Campaign end date must be after start date.');
  }

  const catalog = await getPricingCatalog(true);

  // Validate sale prices if applicable
  let proPrice = null;
  let proDiscount = null;
  if (applicable_plans.includes('pro')) {
    if (sale_price_pro == null || Number(sale_price_pro) <= 0) {
      throw new Error('Valid sale price for Pro plan is required.');
    }
    proPrice = Math.round(Number(sale_price_pro));
    if (proPrice >= catalog.pro.monthly) {
      throw new Error(`Pro sale price (₹${proPrice}) must be less than regular price (₹${catalog.pro.monthly}).`);
    }
    proDiscount = Math.round(((catalog.pro.monthly - proPrice) / catalog.pro.monthly) * 100);
  }

  let elitePrice = null;
  let eliteDiscount = null;
  if (applicable_plans.includes('elite')) {
    if (sale_price_elite == null || Number(sale_price_elite) <= 0) {
      throw new Error('Valid sale price for Elite plan is required.');
    }
    elitePrice = Math.round(Number(sale_price_elite));
    if (elitePrice >= catalog.elite.monthly) {
      throw new Error(`Elite sale price (₹${elitePrice}) must be less than regular price (₹${catalog.elite.monthly}).`);
    }
    eliteDiscount = Math.round(((catalog.elite.monthly - elitePrice) / catalog.elite.monthly) * 100);
  }

  const database = await getDbHandle();
  const id = 'camp_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);

  const doc = {
    id,
    name: name.trim(),
    description: description.trim(),
    applicable_plans: Array.isArray(applicable_plans) ? applicable_plans : [applicable_plans],
    sale_price_pro: proPrice,
    discount_percent_pro: proDiscount,
    sale_price_elite: elitePrice,
    discount_percent_elite: eliteDiscount,
    start_date: startDateObj.toISOString(),
    end_date: endDateObj.toISOString(),
    badge_text: badge_text.trim(),
    renewal_terms: renewal_terms.trim(),
    status: status === 'scheduled' || status === 'active' || status === 'disabled' ? status : 'active',
    created_by: adminEmail,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  await database.collection('pricing_campaigns').insertOne(doc);

  await logAdminAction({
    actor: adminEmail,
    action: 'campaign_created',
    target: `campaign:${doc.id}:${doc.name}`,
    newValue: doc,
    reason: `Created campaign: ${doc.name} (${doc.badge_text})`,
    ip
  });

  return doc;
}

/**
 * End or toggle a promotional campaign
 */
async function updateCampaignStatus(campaignId, status, adminEmail = 'owner', ip = '') {
  const database = await getDbHandle();
  const existing = await database.collection('pricing_campaigns').findOne({ id: campaignId });
  if (!existing) {
    throw new Error('Campaign not found.');
  }

  const updateFields = {
    status,
    updated_at: new Date().toISOString()
  };
  if (status === 'ended') {
    updateFields.end_date = new Date().toISOString();
  }

  await database.collection('pricing_campaigns').updateOne(
    { id: campaignId },
    { $set: updateFields }
  );

  await logAdminAction({
    actor: adminEmail,
    action: `campaign_status_${status}`,
    target: `campaign:${campaignId}`,
    prevValue: existing.status,
    newValue: status,
    reason: `Updated campaign status to ${status}`,
    ip
  });

  return { ...existing, ...updateFields };
}

/**
 * Compute the effective pricing matrix incorporating active campaign if running
 */
async function getEffectivePricing(atDate = new Date()) {
  const catalog = await getPricingCatalog();
  const activeCampaign = await getActiveCampaign(atDate);

  const result = {
    plans: {
      free: {
        key: 'free',
        name: 'Free',
        price: 0,
        amount_paise: 0,
        regular_price: 0,
        currency: 'INR',
        interval: 'monthly',
        is_sale: false,
        discount_percent: 0,
        badge: null
      },
      pro: {
        key: 'pro_monthly',
        name: 'Pro',
        price: catalog.pro.monthly,
        amount_paise: catalog.pro.amount_paise,
        regular_price: catalog.pro.monthly,
        currency: 'INR',
        interval: 'monthly',
        is_sale: false,
        discount_percent: 0,
        badge: null
      },
      elite: {
        key: 'elite_monthly',
        name: 'Elite',
        price: catalog.elite.monthly,
        amount_paise: catalog.elite.amount_paise,
        regular_price: catalog.elite.monthly,
        currency: 'INR',
        interval: 'monthly',
        is_sale: false,
        discount_percent: 0,
        badge: null
      }
    },
    active_campaign: null
  };

  if (activeCampaign) {
    let campaignAttached = false;

    if (activeCampaign.applicable_plans.includes('pro') && activeCampaign.sale_price_pro != null) {
      result.plans.pro.price = activeCampaign.sale_price_pro;
      result.plans.pro.amount_paise = activeCampaign.sale_price_pro * 100;
      result.plans.pro.is_sale = true;
      result.plans.pro.discount_percent = activeCampaign.discount_percent_pro;
      result.plans.pro.badge = activeCampaign.badge_text || 'PROMO';
      result.plans.pro.renewal_terms = activeCampaign.renewal_terms;
      campaignAttached = true;
    }

    if (activeCampaign.applicable_plans.includes('elite') && activeCampaign.sale_price_elite != null) {
      result.plans.elite.price = activeCampaign.sale_price_elite;
      result.plans.elite.amount_paise = activeCampaign.sale_price_elite * 100;
      result.plans.elite.is_sale = true;
      result.plans.elite.discount_percent = activeCampaign.discount_percent_elite;
      result.plans.elite.badge = activeCampaign.badge_text || 'PROMO';
      result.plans.elite.renewal_terms = activeCampaign.renewal_terms;
      campaignAttached = true;
    }

    if (campaignAttached) {
      result.active_campaign = {
        id: activeCampaign.id,
        name: activeCampaign.name,
        badge_text: activeCampaign.badge_text,
        end_date: activeCampaign.end_date,
        renewal_terms: activeCampaign.renewal_terms
      };
    }
  }

  return result;
}

/**
 * Ensure a matching Razorpay monthly plan exists for the exact amount in paise.
 * If not present in MongoDB or Razorpay, dynamically create it on Razorpay.
 */
async function ensureRazorpayPlan(planKey, amountPaise, planDisplayName = '') {
  if (!amountPaise || amountPaise <= 0) {
    throw new Error('Amount must be positive to create a Razorpay subscription plan.');
  }

  const database = await getDbHandle();
  const environment = process.env.NODE_ENV || 'production';

  // 1. Check local MongoDB cache
  const existing = await database.collection('billing_plans').findOne({
    plan_key: planKey,
    amount: amountPaise,
    currency: 'INR',
    period: 'monthly'
  });

  if (existing?.razorpay_plan_id) {
    return existing.razorpay_plan_id;
  }

  // 2. Check Razorpay credentials
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    return null;
  }

  const authHeader = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  const planName = planDisplayName || `Comment2DM ${planKey.startsWith('elite') ? 'Elite' : 'Pro'} Plan (₹${amountPaise / 100}/mo)`;

  // 3. Create plan via Razorpay REST API
  const response = await fetch('https://api.razorpay.com/v1/plans', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${authHeader}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      period: 'monthly',
      interval: 1,
      item: {
        name: planName,
        amount: amountPaise,
        currency: 'INR',
        description: `${planName} - Comment2DM Subscription`
      },
      notes: {
        comment2dm_plan_key: planKey,
        amount: amountPaise,
        environment
      }
    }),
    signal: AbortSignal.timeout(10000)
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.id) {
    console.error('[Pricing Service] Razorpay plan creation failed:', body?.error?.description || response.statusText);
    throw new Error(body?.error?.description || 'Failed to create plan on payment provider.');
  }

  // 4. Save into billing_plans collection
  await database.collection('billing_plans').updateOne(
    { plan_key: planKey, amount: amountPaise, currency: 'INR', period: 'monthly' },
    {
      $set: {
        plan_key: planKey,
        razorpay_plan_id: body.id,
        amount: amountPaise,
        currency: 'INR',
        period: 'monthly',
        interval: 1,
        environment,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    },
    { upsert: true }
  );

  return body.id;
}

module.exports = {
  CANONICAL_DEFAULTS,
  getPricingCatalog,
  updateRegularPrices,
  getActiveCampaign,
  getCampaigns,
  createCampaign,
  updateCampaignStatus,
  getEffectivePricing,
  ensureRazorpayPlan
};
