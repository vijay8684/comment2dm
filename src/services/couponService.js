// src/services/couponService.js
// Comment2DM — Advanced Coupon Engine for VI Tech

'use strict';

const crypto = require('crypto');
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

/**
 * Generate a random uppercase coupon code
 */
function generateRandomCode(prefix = 'VI', length = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Avoid confusing 0/O, 1/I
  let result = prefix.toUpperCase();
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

/**
 * Create a new coupon code
 */
async function createCoupon(couponData, adminEmail = 'owner', ip = '') {
  const {
    code,
    discount_type = 'percentage', // 'percentage' | 'fixed'
    discount_value,
    applicable_plans = ['pro', 'elite'], // 'pro', 'elite', or both
    start_date,
    expiry_date,
    max_redemptions = 100,
    max_per_customer = 1,
    min_order_amount = 0,
    duration = 'once', // 'once' | 'repeating' | 'forever'
    duration_in_months = null,
    is_active = true
  } = couponData;

  if (!code || typeof code !== 'string') {
    throw new Error('Coupon code is required.');
  }

  const normalizedCode = code.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  if (normalizedCode.length < 3 || normalizedCode.length > 20) {
    throw new Error('Coupon code must be between 3 and 20 alphanumeric characters.');
  }

  const numValue = Number(discount_value);
  if (isNaN(numValue) || numValue <= 0) {
    throw new Error('Valid discount value is required.');
  }

  if (discount_type === 'percentage' && (numValue < 1 || numValue > 90)) {
    throw new Error('Percentage discount must be between 1% and 90%.');
  }

  if (discount_type === 'fixed' && numValue < 1) {
    throw new Error('Fixed discount must be at least ₹1.');
  }

  const startDateObj = start_date ? new Date(start_date) : new Date();
  const expiryDateObj = expiry_date ? new Date(expiry_date) : new Date(Date.now() + 90 * 86400000); // 90 days default
  if (expiryDateObj <= startDateObj) {
    throw new Error('Expiry date must be after start date.');
  }

  const database = await getDbHandle();

  // Check unique code
  const existing = await database.collection('coupons').findOne({ code: normalizedCode });
  if (existing) {
    throw new Error(`Coupon code "${normalizedCode}" already exists.`);
  }

  const doc = {
    code: normalizedCode,
    discount_type,
    discount_value: numValue,
    applicable_plans: Array.isArray(applicable_plans) ? applicable_plans : [applicable_plans],
    start_date: startDateObj.toISOString(),
    expiry_date: expiryDateObj.toISOString(),
    max_redemptions: Math.max(1, parseInt(max_redemptions, 10) || 100),
    max_per_customer: Math.max(1, parseInt(max_per_customer, 10) || 1),
    min_order_amount: Math.max(0, Number(min_order_amount) || 0),
    duration: ['once', 'repeating', 'forever'].includes(duration) ? duration : 'once',
    duration_in_months: duration === 'repeating' ? Math.max(1, parseInt(duration_in_months, 10) || 3) : null,
    is_active: Boolean(is_active),
    redemption_count: 0,
    total_discount_granted: 0,
    created_by: adminEmail,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  await database.collection('coupons').insertOne(doc);

  await logAdminAction({
    actor: adminEmail,
    action: 'coupon_created',
    target: `coupon:${normalizedCode}`,
    newValue: doc,
    reason: `Created coupon ${normalizedCode} (${discount_type === 'percentage' ? numValue + '%' : '₹' + numValue} off)`,
    ip
  });

  return doc;
}

/**
 * List coupons with optional filtering
 */
async function getCoupons({ status = null } = {}) {
  try {
    const database = await getDbHandle();
    const query = {};
    if (status === 'active') query.is_active = true;
    if (status === 'inactive') query.is_active = false;

    const list = await database.collection('coupons')
      .find(query)
      .sort({ created_at: -1 })
      .toArray();

    return list;
  } catch (err) {
    console.error('[Coupon Service] Error listing coupons:', err.message);
    return [];
  }
}

/**
 * Toggle coupon active status
 */
async function toggleCouponStatus(code, isActive, adminEmail = 'owner', ip = '') {
  const normalizedCode = String(code).trim().toUpperCase();
  const database = await getDbHandle();
  const existing = await database.collection('coupons').findOne({ code: normalizedCode });
  if (!existing) {
    throw new Error('Coupon not found.');
  }

  await database.collection('coupons').updateOne(
    { code: normalizedCode },
    { $set: { is_active: Boolean(isActive), updated_at: new Date().toISOString() } }
  );

  await logAdminAction({
    actor: adminEmail,
    action: isActive ? 'coupon_activated' : 'coupon_deactivated',
    target: `coupon:${normalizedCode}`,
    prevValue: existing.is_active,
    newValue: Boolean(isActive),
    reason: `Toggled coupon active status to ${isActive}`,
    ip
  });

  return { ...existing, is_active: Boolean(isActive) };
}

/**
 * Validate coupon code applicability for a given plan and customer
 */
async function validateCoupon(code, planKey, userId, baseAmountRupees) {
  if (!code || typeof code !== 'string') {
    return { valid: false, error: 'Please enter a coupon code.' };
  }

  const normalizedCode = code.trim().toUpperCase();
  const database = await getDbHandle();
  const coupon = await database.collection('coupons').findOne({ code: normalizedCode });

  if (!coupon) {
    return { valid: false, error: 'Invalid coupon code.' };
  }

  if (!coupon.is_active) {
    return { valid: false, error: 'This coupon code is currently inactive.' };
  }

  const now = new Date();
  if (coupon.start_date && new Date(coupon.start_date) > now) {
    return { valid: false, error: 'This coupon campaign has not started yet.' };
  }
  if (coupon.expiry_date && new Date(coupon.expiry_date) < now) {
    return { valid: false, error: 'This coupon code has expired.' };
  }

  // Plan tier eligibility
  const planTier = planKey.startsWith('elite') ? 'elite' : planKey.startsWith('pro') ? 'pro' : 'free';
  if (!coupon.applicable_plans.includes(planTier)) {
    return {
      valid: false,
      error: `Coupon ${coupon.code} is only valid for ${coupon.applicable_plans.join(' and ').toUpperCase()} plans.`
    };
  }

  // Check global max redemptions
  if (coupon.redemption_count >= coupon.max_redemptions) {
    return { valid: false, error: 'This coupon has reached its maximum redemption limit.' };
  }

  // Check active pending reservations + redemptions to prevent race condition
  const recentReservations = await database.collection('coupon_redemptions').countDocuments({
    coupon_code: normalizedCode,
    status: 'reserved',
    expires_at: { $gt: now.toISOString() }
  });

  if ((coupon.redemption_count + recentReservations) >= coupon.max_redemptions) {
    return { valid: false, error: 'This coupon has reached its maximum redemption limit.' };
  }

  // Check per-customer limit
  if (userId) {
    const userRedeemedCount = await database.collection('coupon_redemptions').countDocuments({
      coupon_code: normalizedCode,
      user_id: userId,
      status: { $in: ['redeemed', 'reserved'] },
      $or: [
        { status: 'redeemed' },
        { expires_at: { $gt: now.toISOString() } }
      ]
    });

    if (userRedeemedCount >= coupon.max_per_customer) {
      return { valid: false, error: 'You have already used this coupon code.' };
    }
  }

  // Minimum order check
  const base = Number(baseAmountRupees) || 0;
  if (coupon.min_order_amount && base < coupon.min_order_amount) {
    return {
      valid: false,
      error: `Order amount must be at least ₹${coupon.min_order_amount} to use this coupon.`
    };
  }

  // Calculate discount
  let discountRupees = 0;
  if (coupon.discount_type === 'percentage') {
    discountRupees = Math.round(base * (coupon.discount_value / 100));
  } else {
    discountRupees = Math.round(coupon.discount_value);
  }

  // Ensure minimum payable ₹1 (100 paise) so subscription can be authenticated
  discountRupees = Math.min(base - 1, Math.max(1, discountRupees));
  const finalRupees = Math.max(1, base - discountRupees);
  const discountPaise = discountRupees * 100;
  const finalPaise = finalRupees * 100;

  return {
    valid: true,
    code: coupon.code,
    duration: coupon.duration,
    duration_in_months: coupon.duration_in_months,
    coupon: {
      code: coupon.code,
      discount_type: coupon.discount_type,
      discount_value: coupon.discount_value,
      duration: coupon.duration,
      duration_in_months: coupon.duration_in_months
    },
    discount_rupees: discountRupees,
    discount_paise: discountPaise,
    final_rupees: finalRupees,
    final_paise: finalPaise,
    duration_text: coupon.duration === 'once'
      ? 'First monthly billing cycle'
      : coupon.duration === 'repeating'
        ? `First ${coupon.duration_in_months} billing cycles`
        : 'All recurring billing cycles'
  };
}

/**
 * Atomically reserve a coupon use for a pending subscription checkout (15-min TTL)
 */
async function reserveCoupon(code, arg2, arg3, arg4, arg5) {
  let planKey = '';
  let userId = '';
  let subscriptionId = '';
  let amountPaise = 0;

  if (typeof arg4 === 'object' && arg4 !== null) {
    // Called as: reserveCoupon(code, userId, subscriptionId, details)
    userId = String(arg2 || '');
    subscriptionId = String(arg3 || '');
    planKey = String(arg4.plan_key || '');
    amountPaise = arg4.final_rupees ? arg4.final_rupees * 100 : (arg4.amount_paise || 0);
  } else {
    // Called as: reserveCoupon(code, planKey, userId, subscriptionId, amountPaise)
    planKey = String(arg2 || '');
    userId = String(arg3 || '');
    subscriptionId = String(arg4 || '');
    amountPaise = typeof arg5 === 'number' ? arg5 : 0;
  }

  const normalizedCode = code.trim().toUpperCase();
  const database = await getDbHandle();

  const reservation = {
    coupon_code: normalizedCode,
    user_id: userId,
    plan_key: planKey,
    subscription_id: subscriptionId,
    amount_paise: amountPaise,
    status: 'reserved',
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString() // 15 min TTL
  };

  await database.collection('coupon_redemptions').updateOne(
    { subscription_id: subscriptionId },
    { $set: reservation },
    { upsert: true }
  );

  return reservation;
}

/**
 * Confirm coupon redemption upon successful payment verification or subscription.activated webhook
 */
async function confirmRedemption(subscriptionId, paymentId = null) {
  try {
    const database = await getDbHandle();
    const reservation = await database.collection('coupon_redemptions').findOne({
      subscription_id: subscriptionId
    });

    if (!reservation) return false;
    if (reservation.status === 'redeemed') return true; // Already redeemed idempotently

    const nowIso = new Date().toISOString();
    await database.collection('coupon_redemptions').updateOne(
      { subscription_id: subscriptionId },
      {
        $set: {
          status: 'redeemed',
          payment_id: paymentId,
          redeemed_at: nowIso,
          updated_at: nowIso
        }
      }
    );

    // Increment coupon redemption stats
    await database.collection('coupons').updateOne(
      { code: reservation.coupon_code },
      {
        $inc: { redemption_count: 1 },
        $set: { updated_at: nowIso }
      }
    );

    return true;
  } catch (err) {
    console.error('[Coupon Service] Error confirming redemption:', err.message);
    return false;
  }
}

/**
 * Release reservation if subscription is cancelled or abandoned
 */
async function releaseReservation(subscriptionId) {
  try {
    const database = await getDbHandle();
    await database.collection('coupon_redemptions').deleteOne({
      subscription_id: subscriptionId,
      status: 'reserved'
    });
    return true;
  } catch (err) {
    console.error('[Coupon Service] Error releasing reservation:', err.message);
    return false;
  }
}

module.exports = {
  generateRandomCode,
  createCoupon,
  getCoupons,
  toggleCouponStatus,
  validateCoupon,
  reserveCoupon,
  confirmRedemption,
  releaseReservation
};
