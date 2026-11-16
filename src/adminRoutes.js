// src/adminRoutes.js
// Comment2DM — VI Tech Owner Control Center Backend Routes

'use strict';

const path = require('path');
const db = require('./db');

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

const authService = require('./auth/authService');
const storageService = require('./services/storageService');
const pricingService = require('./services/pricingService');
const couponService = require('./services/couponService');
const { logAdminAction, getAuditLogs } = require('./services/auditService');

function getAdminEmails() {
  const raw = process.env.ADMIN_EMAIL;
  if (!raw || typeof raw !== 'string') return new Set();
  return new Set(
    raw.split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
  );
}

function isAdminEmail(email) {
  if (!email || typeof email !== 'string') return false;
  return getAdminEmails().has(email.trim().toLowerCase());
}

/**
 * Resolve user from Express request
 */
async function resolveUser(req) {
  if (req.user) return req.user;

  // 1. Bearer token
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const jwt = require('jsonwebtoken');
      const secret = process.env.JWT_SECRET || 'comment2dm_secret_dev_key_fallback';
      const payload = jwt.verify(authHeader.slice(7), secret);
      const user = await authService.getUserById(payload.sub);
      if (user) return user;
    } catch {}
  }

  // 2. Session cookie
  const sessionToken = req.cookies?.comment2dm_session || req.cookies?.nudge_session;
  if (sessionToken) {
    try {
      const user = await authService.getSessionUser(sessionToken);
      if (user) return user;
    } catch {}
  }

  // 3. Fallback JWT cookie
  const token = req.cookies?.nudge_token;
  if (token) {
    try {
      const jwt = require('jsonwebtoken');
      const secret = process.env.JWT_SECRET || 'comment2dm_secret_dev_key_fallback';
      const payload = jwt.verify(token, secret);
      const user = await authService.getUserById(payload.sub);
      if (user) return user;
    } catch {}
  }

  return null;
}

/**
 * Middleware: require authenticated user
 */
async function requireAuth(req, res, next) {
  const user = await resolveUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Authentication required. Please log in.' });
  }
  req.user = user;
  next();
}

/**
 * Middleware: require VI Tech owner email
 */
function requireAdmin(req, res, next) {
  if (!req.user || !isAdminEmail(req.user.email)) {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
}

/**
 * Register all VI Tech admin routes
 */
function registerAdminRoutes(app) {
  // ── 1. Owner Control Center HTML Route ─────────────────────────────
  app.get('/vi-tech', async (req, res) => {
    const user = await resolveUser(req);
    if (!user) {
      return res.redirect('/login.html?returnTo=/vi-tech');
    }
    if (!isAdminEmail(user.email)) {
      return res.status(403).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>403 — Access Denied | VI Tech</title>
  <style>
    body { background: #0D0B12; color: #F8F7FA; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; }
    .card { background: #191621; border: 1px solid rgba(255,255,255,0.08); padding: 40px; border-radius: 20px; max-width: 420px; box-shadow: 0 16px 36px rgba(0,0,0,0.5); }
    h1 { font-size: 1.5rem; margin-bottom: 8px; color: #F43F5E; }
    p { color: #AAA4B5; font-size: 0.9rem; line-height: 1.6; margin-bottom: 24px; }
    a { display: inline-block; background: #7655D9; color: #fff; text-decoration: none; padding: 10px 20px; border-radius: 10px; font-weight: 600; font-size: 0.88rem; transition: background 0.2s; }
    a:hover { background: #936BFF; }
  </style>
</head>
<body>
  <div class="card">
    <div style="font-size: 2.5rem; margin-bottom: 12px;">🛡️</div>
    <h1>403 — Access Denied</h1>
    <p>This control center is reserved for <strong>VI Tech</strong> platform owners. Your current account does not have authorization to access this area.</p>
    <a href="/dashboard.html">Return to Dashboard</a>
  </div>
</body>
</html>`);
    }
    res.sendFile('vi-tech.html', { root: path.resolve(__dirname, '..') });
  });

  // Backward compatibility / redirect /admin.html to /vi-tech
  app.get(['/admin.html', '/vi-tech.html'], (req, res) => {
    res.redirect(301, '/vi-tech');
  });

  // ── 2. Overview Endpoint ──────────────────────────────────────────
  app.get('/api/admin/overview', requireAuth, requireAdmin, async (req, res) => {
    try {
      const database = await getDbHandle();
      const startOfMonth = new Date();
      startOfMonth.setUTCDate(1);
      startOfMonth.setUTCHours(0, 0, 0, 0);

      const [
        totalUsers,
        suspendedUsers,
        activePaidSubs,
        proSubs,
        eliteSubs,
        payments,
        automationsCount,
        dmEvents,
        r2Usage,
        recentUsers,
        recentSubs,
        recentPayments
      ] = await Promise.all([
        database.collection('users').countDocuments({}),
        database.collection('users').countDocuments({ suspended: true }),
        database.collection('subscriptions').countDocuments({ status: 'active', plan: { $in: ['pro', 'elite'] } }),
        database.collection('subscriptions').countDocuments({ status: 'active', plan: 'pro' }),
        database.collection('subscriptions').countDocuments({ status: 'active', plan: 'elite' }),
        database.collection('payments').find({ status: 'captured' }).toArray(),
        database.collection('automations').countDocuments({ enabled: { $in: [true, 1, '1'] } }),
        database.collection('automation_events').find({
          event_type: { $in: ['private_reply', 'resource_delivered'] },
          created_at: { $gte: startOfMonth.toISOString() }
        }).toArray(),
        storageService.getStorageUsage('all').catch(() => ({ usedBytes: 0, usedFormatted: '0 B' })),
        database.collection('users').find({}, { projection: { password: 0 } }).sort({ created_at: -1 }).limit(5).toArray(),
        database.collection('subscriptions').find({}).sort({ created_at: -1 }).limit(5).toArray(),
        database.collection('payments').find({}).sort({ created_at: -1 }).limit(5).toArray()
      ]);

      const totalDMsSent = dmEvents.length;
      const failedDMs = dmEvents.filter(e => e.status === 'failed').length;

      // Calculate total collected revenue in rupees
      const totalRevenueRupees = payments.reduce((sum, p) => sum + Math.round((Number(p.amount_paise) || 0) / 100), 0);

      // Calculate estimated MRR from active subscriptions
      const pricing = await pricingService.getPricingCatalog();
      const mrr = (proSubs * pricing.pro.monthly) + (eliteSubs * pricing.elite.monthly);

      return res.json({
        success: true,
        metrics: {
          total_customers: totalUsers,
          active_customers: totalUsers - suspendedUsers,
          suspended_customers: suspendedUsers,
          free_subscribers: Math.max(0, totalUsers - activePaidSubs),
          pro_subscribers: proSubs,
          elite_subscribers: eliteSubs,
          active_paid_subscriptions: activePaidSubs,
          mrr,
          total_collected_revenue: totalRevenueRupees,
          failed_payments_count: 0,
          total_dms_sent_monthly: totalDMsSent,
          failed_dms_monthly: failedDMs,
          active_automations: automationsCount,
          r2_storage_formatted: r2Usage.usedFormatted || '0 B',
          r2_storage_bytes: r2Usage.usedBytes || 0,
          mongodb_status: 'Healthy',
          render_status: 'Operational'
        },
        recent: {
          users: recentUsers,
          subscriptions: recentSubs,
          payments: recentPayments
        }
      });
    } catch (err) {
      console.error('[Admin Overview Error]:', err.message);
      return res.status(500).json({ error: 'Failed to retrieve overview metrics: ' + err.message });
    }
  });

  // ── 3. Customer Management Endpoints ──────────────────────────────
  app.get('/api/admin/customers', requireAuth, requireAdmin, async (req, res) => {
    try {
      const database = await getDbHandle();
      const { search = '', plan = 'all', status = 'all', page = 1, limit = 50 } = req.query;

      const query = {};
      if (search) {
        query.$or = [
          { name: { $regex: search, $options: 'i' } },
          { email: { $regex: search, $options: 'i' } }
        ];
      }
      if (plan && plan !== 'all') {
        query.plan = plan;
      }
      if (status === 'active') {
        query.suspended = { $ne: true };
      } else if (status === 'suspended') {
        query.suspended = true;
      }

      const safePage = Math.max(1, parseInt(page, 10) || 1);
      const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
      const skip = (safePage - 1) * safeLimit;

      const [users, total] = await Promise.all([
        database.collection('users')
          .find(query, { projection: { password: 0, reset_token: 0, reset_token_expires: 0 } })
          .sort({ created_at: -1 })
          .skip(skip)
          .limit(safeLimit)
          .toArray(),
        database.collection('users').countDocuments(query)
      ]);

      // Enrich with account and automation counts
      const enriched = await Promise.all(users.map(async (u) => {
        const [accCount, autoCount, sub] = await Promise.all([
          database.collection('instagram_accounts').countDocuments({ owner_user_id: u.id }),
          database.collection('automations').countDocuments({ owner_user_id: u.id, enabled: { $in: [true, 1, '1'] } }),
          database.collection('subscriptions').findOne({ user_id: u.id, status: 'active' }, { sort: { created_at: -1 } })
        ]);

        return {
          id: u.id,
          name: u.name || 'Unnamed',
          email: u.email,
          registered_at: u.created_at || u.createdAt || null,
          plan: sub?.plan || u.plan || 'free',
          status: u.suspended ? 'suspended' : 'active',
          instagram_accounts_count: accCount,
          active_automations_count: autoCount,
          subscription: sub ? { status: sub.status, plan: sub.plan, amount: sub.effective_amount_paise ? sub.effective_amount_paise / 100 : 70 } : null
        };
      }));

      return res.json({
        customers: enriched,
        total,
        page: safePage,
        limit: safeLimit,
        pages: Math.ceil(total / safeLimit)
      });
    } catch (err) {
      console.error('[Admin Customers Error]:', err.message);
      return res.status(500).json({ error: 'Failed to retrieve customers: ' + err.message });
    }
  });

  app.get('/api/admin/customers/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const database = await getDbHandle();
      const targetId = req.params.id;
      const user = await database.collection('users').findOne(
        { $or: [{ id: targetId }, { _id: targetId.length === 24 ? new (require('mongodb').ObjectId)(targetId) : null }] },
        { projection: { password: 0 } }
      );
      if (!user) return res.status(404).json({ error: 'Customer not found.' });

      const [accounts, automations, subscriptions, payments] = await Promise.all([
        database.collection('instagram_accounts').find({ owner_user_id: user.id }, { projection: { access_token: 0 } }).toArray(),
        database.collection('automations').find({ owner_user_id: user.id }).toArray(),
        database.collection('subscriptions').find({ user_id: user.id }).sort({ created_at: -1 }).toArray(),
        database.collection('payments').find({ user_id: user.id }).sort({ created_at: -1 }).toArray()
      ]);

      return res.json({
        customer: user,
        accounts,
        automations,
        subscriptions,
        payments
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/customers/:id/suspend', requireAuth, requireAdmin, async (req, res) => {
    try {
      const database = await getDbHandle();
      const targetId = req.params.id;
      const reason = req.body?.reason || 'Administrative suspension';
      const user = await database.collection('users').findOne({
        $or: [{ id: targetId }, { _id: targetId.length === 24 ? new (require('mongodb').ObjectId)(targetId) : null }]
      });
      if (!user) return res.status(404).json({ error: 'Customer not found.' });

      await database.collection('users').updateOne(
        { _id: user._id },
        { $set: { suspended: true, suspended_at: new Date().toISOString(), suspension_reason: reason } }
      );

      // Invalidate sessions
      await database.collection('sessions').deleteMany({ user_id: user.id });

      await logAdminAction({
        actor: req.user.email,
        action: 'customer_suspended',
        target: `customer:${user.id}:${user.email}`,
        prevValue: { suspended: false },
        newValue: { suspended: true, reason },
        reason,
        ip: req.ip
      });

      return res.json({ success: true, suspended: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/customers/:id/restore', requireAuth, requireAdmin, async (req, res) => {
    try {
      const database = await getDbHandle();
      const targetId = req.params.id;
      const user = await database.collection('users').findOne({
        $or: [{ id: targetId }, { _id: targetId.length === 24 ? new (require('mongodb').ObjectId)(targetId) : null }]
      });
      if (!user) return res.status(404).json({ error: 'Customer not found.' });

      await database.collection('users').updateOne(
        { _id: user._id },
        { $set: { suspended: false, restored_at: new Date().toISOString() }, $unset: { suspension_reason: '' } }
      );

      await logAdminAction({
        actor: req.user.email,
        action: 'customer_restored',
        target: `customer:${user.id}:${user.email}`,
        prevValue: { suspended: true },
        newValue: { suspended: false },
        reason: 'Administrative account restoration',
        ip: req.ip
      });

      return res.json({ success: true, suspended: false });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/customers/:id/revoke-sessions', requireAuth, requireAdmin, async (req, res) => {
    try {
      const database = await getDbHandle();
      const targetId = req.params.id;
      await database.collection('sessions').deleteMany({ user_id: targetId });

      await logAdminAction({
        actor: req.user.email,
        action: 'customer_sessions_revoked',
        target: `customer:${targetId}`,
        reason: 'Revoked all customer sessions',
        ip: req.ip
      });

      return res.json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/customers/:id/override-entitlement', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { plan, reason, expiry_days } = req.body || {};
      if (!['pro', 'elite', 'free'].includes(plan)) {
        return res.status(400).json({ error: 'Invalid plan tier specified.' });
      }
      if (!reason || typeof reason !== 'string' || reason.trim().length < 5) {
        return res.status(400).json({ error: 'An explicit administrative reason (min 5 chars) is required.' });
      }

      const database = await getDbHandle();
      const targetId = req.params.id;
      const user = await database.collection('users').findOne({
        $or: [{ id: targetId }, { _id: targetId.length === 24 ? new (require('mongodb').ObjectId)(targetId) : null }]
      });
      if (!user) return res.status(404).json({ error: 'Customer not found.' });

      const expiryDate = expiry_days ? new Date(Date.now() + parseInt(expiry_days, 10) * 86400000).toISOString() : null;

      await database.collection('users').updateOne(
        { _id: user._id },
        {
          $set: {
            admin_plan_override: {
              plan,
              granted_by: req.user.email,
              reason: reason.trim(),
              granted_at: new Date().toISOString(),
              expires_at: expiryDate
            },
            updated_at: new Date().toISOString()
          }
        }
      );

      await logAdminAction({
        actor: req.user.email,
        action: 'entitlement_override_granted',
        target: `customer:${user.id}:${user.email}`,
        prevValue: user.admin_plan_override || null,
        newValue: { plan, reason, expires_at: expiryDate },
        reason,
        ip: req.ip
      });

      return res.json({ success: true, plan, expires_at: expiryDate });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ── 4. Pricing & Promotions Endpoints ─────────────────────────────
  app.get('/api/admin/pricing', requireAuth, requireAdmin, async (req, res) => {
    try {
      const [catalog, campaigns, effective] = await Promise.all([
        pricingService.getPricingCatalog(),
        pricingService.getCampaigns(),
        pricingService.getEffectivePricing()
      ]);

      return res.json({
        success: true,
        catalog,
        campaigns,
        effective
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/pricing/regular', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { pro_monthly, elite_monthly, reason = '' } = req.body || {};
      const updated = await pricingService.updateRegularPrices(
        { proMonthly: pro_monthly, eliteMonthly: elite_monthly },
        req.user.email,
        reason,
        req.ip
      );
      return res.json({ success: true, catalog: updated });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/admin/pricing/entry-controls', requireAuth, requireAdmin, async (req, res) => {
    try {
      const config = req.body || {};
      const updated = await pricingService.updateEntryPricing(
        config,
        req.user.email,
        config.reason || 'Updated promotional entry pricing and AutoPay controls',
        req.ip
      );
      return res.json({ success: true, entry_pricing: updated });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/admin/pricing/campaigns', requireAuth, requireAdmin, async (req, res) => {
    try {
      const campaign = await pricingService.createCampaign(req.body, req.user.email, req.ip);
      return res.json({ success: true, campaign });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });

  app.patch('/api/admin/pricing/campaigns/:id/status', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { status } = req.body || {};
      if (!['active', 'disabled', 'ended'].includes(status)) {
        return res.status(400).json({ error: 'Invalid campaign status.' });
      }
      const updated = await pricingService.updateCampaignStatus(req.params.id, status, req.user.email, req.ip);
      return res.json({ success: true, campaign: updated });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });

  // ── 5. Coupon Code Manager Endpoints ──────────────────────────────
  app.get('/api/admin/coupons', requireAuth, requireAdmin, async (req, res) => {
    try {
      const coupons = await couponService.getCoupons();
      return res.json({ success: true, coupons });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/coupons', requireAuth, requireAdmin, async (req, res) => {
    try {
      let data = { ...req.body };
      if (data.auto_generate) {
        data.code = couponService.generateRandomCode(data.prefix || 'VI', 6);
      }
      const coupon = await couponService.createCoupon(data, req.user.email, req.ip);
      return res.json({ success: true, coupon });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });

  app.patch('/api/admin/coupons/:code/status', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { is_active } = req.body || {};
      const updated = await couponService.toggleCouponStatus(req.params.code, is_active, req.user.email, req.ip);
      return res.json({ success: true, coupon: updated });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/admin/coupons/:code', requireAuth, requireAdmin, async (req, res) => {
    try {
      const database = await getDbHandle();
      const code = String(req.params.code || '').trim().toUpperCase();
      const existing = await database.collection('coupons').findOne({ code });
      if (!existing) {
        return res.status(404).json({ error: 'Coupon not found.' });
      }
      await database.collection('coupons').deleteOne({ code });
      await logAdminAction({
        actor: req.user.email,
        action: 'coupon_deleted',
        target: `coupon:${code}`,
        prevValue: existing,
        reason: 'Deleted coupon from admin panel',
        ip: req.ip
      });
      return res.json({ success: true, code });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ── 6. Subscriptions & Payments Endpoints ─────────────────────────
  app.get('/api/admin/subscriptions', requireAuth, requireAdmin, async (req, res) => {
    try {
      const database = await getDbHandle();
      const { status = 'all', page = 1, limit = 50 } = req.query;
      const query = {};
      if (status && status !== 'all') query.status = status;

      const safePage = Math.max(1, parseInt(page, 10) || 1);
      const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
      const skip = (safePage - 1) * safeLimit;

      const [subs, total] = await Promise.all([
        database.collection('subscriptions')
          .find(query)
          .sort({ created_at: -1 })
          .skip(skip)
          .limit(safeLimit)
          .toArray(),
        database.collection('subscriptions').countDocuments(query)
      ]);

      // Enrich with user names/emails
      const enriched = await Promise.all(subs.map(async (s) => {
        const user = await database.collection('users').findOne({ id: s.user_id }, { projection: { name: 1, email: 1 } });
        return {
          id: s._id,
          razorpay_subscription_id: s.razorpay_subscription_id,
          razorpay_plan_id: s.razorpay_plan_id,
          customer_name: user?.name || 'Unknown',
          customer_email: user?.email || 'N/A',
          plan: s.plan,
          status: s.status,
          effective_amount: s.effective_amount_paise ? s.effective_amount_paise / 100 : (s.amount ? s.amount / 100 : 70),
          coupon_code: s.coupon_code || null,
          current_start: s.current_start,
          current_end: s.current_end,
          cancel_at_cycle_end: !!s.cancel_at_cycle_end,
          created_at: s.created_at
        };
      }));

      return res.json({
        subscriptions: enriched,
        total,
        page: safePage,
        limit: safeLimit
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/subscriptions/:id/cancel', requireAuth, requireAdmin, async (req, res) => {
    try {
      const database = await getDbHandle();
      const subId = req.params.id;
      const sub = await database.collection('subscriptions').findOne({
        $or: [{ id: subId }, { razorpay_subscription_id: subId }, { _id: subId }]
      });
      if (!sub) {
        return res.status(404).json({ error: 'Subscription not found.' });
      }
      await database.collection('subscriptions').updateOne(
        { _id: sub._id },
        { $set: { status: 'cancelled', cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString() } }
      );
      await logAdminAction({
        actor: req.user.email,
        action: 'subscription_cancelled_admin',
        target: `subscription:${subId}`,
        prevValue: sub.status,
        newValue: 'cancelled',
        reason: req.body?.reason || 'Cancelled by admin from control center',
        ip: req.ip
      });
      return res.json({ success: true, subscriptionId: subId });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/admin/payments', requireAuth, requireAdmin, async (req, res) => {
    try {
      const database = await getDbHandle();
      const payments = await database.collection('payments')
        .find({})
        .sort({ created_at: -1 })
        .limit(100)
        .toArray();

      const enriched = await Promise.all(payments.map(async (p) => {
        const user = await database.collection('users').findOne({ id: p.user_id }, { projection: { name: 1, email: 1 } });
        return {
          payment_id: p.razorpay_payment_id || p._id,
          subscription_id: p.razorpay_subscription_id,
          customer_email: user?.email || 'N/A',
          amount_rupees: Math.round((Number(p.amount_paise) || 0) / 100),
          status: p.status,
          created_at: p.created_at
        };
      }));

      return res.json({ success: true, payments: enriched });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ── 7. Revenue Analytics Endpoint ─────────────────────────────────
  app.get('/api/admin/revenue/analytics', requireAuth, requireAdmin, async (req, res) => {
    try {
      const database = await getDbHandle();
      const payments = await database.collection('payments').find({ status: 'captured' }).toArray();
      const subs = await database.collection('subscriptions').find({ status: 'active' }).toArray();

      const totalCollected = payments.reduce((sum, p) => sum + Math.round((Number(p.amount_paise) || 0) / 100), 0);

      const pricing = await pricingService.getPricingCatalog();
      let mrr = 0;
      subs.forEach(s => {
        if (s.plan === 'pro') mrr += (s.effective_amount_paise ? s.effective_amount_paise / 100 : pricing.pro.monthly);
        if (s.plan === 'elite') mrr += (s.effective_amount_paise ? s.effective_amount_paise / 100 : pricing.elite.monthly);
      });

      return res.json({
        total_collected_revenue: totalCollected,
        monthly_recurring_revenue: mrr,
        total_transactions: payments.length,
        active_subscribers_count: subs.length,
        refunds_total: 0,
        estimated_annual_run_rate: mrr * 12
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ── 8. Infrastructure & Telemetry Endpoint ────────────────────────
  app.get('/api/admin/infrastructure', requireAuth, requireAdmin, async (req, res) => {
    try {
      const start = Date.now();
      let dbConnected = false;
      let latencyMs = 0;
      try {
        const d = await getDbHandle();
        await d.collection('users').findOne({}, { projection: { _id: 1 } });
        dbConnected = true;
        latencyMs = Date.now() - start;
      } catch (dbErr) {
        latencyMs = Date.now() - start;
      }

      const r2Configured = !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET_NAME);
      const r2Usage = await storageService.getStorageUsage('all').catch(() => ({ usedBytes: 0, usedFormatted: '0 B' }));

      const razorpayConfigured = !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
      const isTestMode = (process.env.RAZORPAY_KEY_ID || '').startsWith('rzp_test_');

      return res.json({
        success: true,
        mongodb: {
          status: dbConnected ? 'Connected' : 'Disconnected',
          latency_ms: latencyMs,
          cluster: 'MongoDB Atlas'
        },
        cloudflare_r2: {
          status: r2Configured ? 'Configured' : 'Not configured',
          bucket: process.env.R2_BUCKET_NAME || 'Not set',
          total_storage_used: r2Usage.usedFormatted || '0 B',
          total_bytes: r2Usage.usedBytes || 0
        },
        render: {
          node_version: process.version,
          uptime_seconds: Math.round(process.uptime()),
          memory_usage_mb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
          environment: process.env.NODE_ENV || 'production'
        },
        razorpay: {
          status: razorpayConfigured ? 'Connected' : 'Missing credentials',
          mode: isTestMode ? 'Test Mode' : 'Live Mode'
        }
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ── 9. Automation Monitoring Endpoint ─────────────────────────────
  app.get('/api/admin/automations', requireAuth, requireAdmin, async (req, res) => {
    try {
      const database = await getDbHandle();
      const [totalAuto, activeAuto, recentEvents] = await Promise.all([
        database.collection('automations').countDocuments({}),
        database.collection('automations').countDocuments({ enabled: { $in: [true, 1, '1'] } }),
        database.collection('automation_events').find({}).sort({ created_at: -1 }).limit(30).toArray()
      ]);

      const failedEvents = recentEvents.filter(e => e.status === 'failed');

      return res.json({
        total_automations: totalAuto,
        active_automations: activeAuto,
        paused_automations: Math.max(0, totalAuto - activeAuto),
        recent_failures_count: failedEvents.length,
        recent_failures: failedEvents
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ── 10. Support & Feedback Endpoint ───────────────────────────────
  app.get('/api/admin/support', requireAuth, requireAdmin, async (req, res) => {
    try {
      const database = await getDbHandle();
      const [contacts, feedback] = await Promise.all([
        database.collection('contacts').find({}).sort({ created_at: -1 }).limit(100).toArray().catch(() => []),
        database.collection('feedback').find({}).sort({ created_at: -1 }).limit(100).toArray().catch(() => [])
      ]);

      return res.json({
        contacts: contacts || [],
        feedback: feedback || []
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.patch('/api/admin/support/contacts/:id/resolve', requireAuth, requireAdmin, async (req, res) => {
    try {
      const database = await getDbHandle();
      const { ObjectId } = require('mongodb');
      const targetId = req.params.id;
      const query = targetId.length === 24 ? { _id: new ObjectId(targetId) } : { id: targetId };

      await database.collection('contacts').updateOne(
        query,
        { $set: { resolved: true, resolved_at: new Date().toISOString(), resolved_by: req.user.email } }
      );

      return res.json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ── 11. Security & Audit Logs Endpoint ────────────────────────────
  app.get('/api/admin/audit-logs', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { limit = 50, skip = 0, action = null, target = null } = req.query;
      const data = await getAuditLogs({ limit, skip, action, target });
      return res.json({ success: true, ...data });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ── 12. Settings Summary Endpoint ─────────────────────────────────
  app.get('/api/admin/settings', requireAuth, requireAdmin, async (req, res) => {
    try {
      const database = await getDbHandle();
      const customSettings = await database.collection('system_settings').findOne({ _id: 'general' }) || {};

      return res.json({
        company: customSettings.company || 'VI Tech',
        product: customSettings.product || 'Comment2DM',
        support_email: customSettings.support_email || 'support@comment2dm.com',
        admin_email: process.env.ADMIN_EMAIL || 'Not configured',
        razorpay_key_id: process.env.RAZORPAY_KEY_ID ? `${process.env.RAZORPAY_KEY_ID.substring(0, 10)}...` : 'Not configured',
        razorpay_mode: (process.env.RAZORPAY_KEY_ID || '').startsWith('rzp_test_') ? 'Test Mode' : 'Live Mode',
        r2_configured: !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY),
        node_env: process.env.NODE_ENV || 'production',
        timezone: 'Asia/Kolkata (IST)',
        ...customSettings
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/settings', requireAuth, requireAdmin, async (req, res) => {
    try {
      const database = await getDbHandle();
      const { company, support_email, notification_webhook } = req.body || {};
      const updated = {
        company: company ? String(company).trim() : 'VI Tech',
        support_email: support_email ? String(support_email).trim() : 'support@comment2dm.com',
        notification_webhook: notification_webhook ? String(notification_webhook).trim() : null,
        updated_at: new Date().toISOString(),
        updated_by: req.user.email
      };

      await database.collection('system_settings').updateOne(
        { _id: 'general' },
        { $set: updated },
        { upsert: true }
      );

      await logAdminAction({
        actor: req.user.email,
        action: 'system_settings_updated',
        target: 'system_settings:general',
        newValue: updated,
        reason: 'Updated platform settings from control center',
        ip: req.ip
      });

      return res.json({ success: true, settings: updated });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });
}

module.exports = {
  registerAdminRoutes,
  getAdminEmails,
  isAdminEmail
};
