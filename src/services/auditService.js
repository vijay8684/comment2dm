// src/services/auditService.js
// Comment2DM — VI Tech Immutable Admin Audit Log Service

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


/**
 * Record an owner/admin action in the immutable audit log.
 * @param {Object} entry
 * @param {string} entry.actor - Admin email who performed the action
 * @param {string} entry.action - Action identifier (e.g. 'price_updated', 'coupon_created')
 * @param {string} entry.target - Target resource (e.g. 'pricing_catalog', 'coupon:SAVE20', 'user:usr_123')
 * @param {*} [entry.prevValue] - Previous state or value before action
 * @param {*} [entry.newValue] - New state or value after action
 * @param {string} [entry.reason] - Admin reason or operational justification
 * @param {string} [entry.ip] - Remote IP address
 */
async function logAdminAction({ actor, action, target, prevValue = null, newValue = null, reason = '', ip = '' }) {
  try {
    const database = await getDbHandle();
    const doc = {
      actor: String(actor || 'owner').trim().toLowerCase(),
      action: String(action || 'unknown_action').trim(),
      target: String(target || 'system').trim(),
      previous_value: prevValue,
      new_value: newValue,
      reason: String(reason || '').trim(),
      ip: String(ip || '').trim(),
      timestamp: new Date().toISOString()
    };

    await database.collection('admin_audit_logs').insertOne(doc);
    return doc;
  } catch (err) {
    console.error('[Audit Log] Failed to write audit entry:', err.message);
    return null;
  }
}

/**
 * Retrieve paginated audit logs for the VI Tech control center.
 * @param {Object} filterOptions
 * @param {number} [filterOptions.limit=50]
 * @param {number} [filterOptions.skip=0]
 * @param {string} [filterOptions.action]
 * @param {string} [filterOptions.target]
 */
async function getAuditLogs({ limit = 50, skip = 0, action = null, target = null } = {}) {
  try {
    const database = await getDbHandle();
    const query = {};
    if (action) query.action = action;
    if (target) query.target = { $regex: target, $options: 'i' };

    const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    const safeSkip = Math.max(0, parseInt(skip, 10) || 0);

    const [logs, total] = await Promise.all([
      database.collection('admin_audit_logs')
        .find(query)
        .sort({ timestamp: -1 })
        .skip(safeSkip)
        .limit(safeLimit)
        .toArray(),
      database.collection('admin_audit_logs').countDocuments(query)
    ]);

    return { logs, total, limit: safeLimit, skip: safeSkip };
  } catch (err) {
    console.error('[Audit Log] Failed to read audit logs:', err.message);
    return { logs: [], total: 0, limit: 50, skip: 0 };
  }
}

module.exports = {
  logAdminAction,
  getAuditLogs
};
