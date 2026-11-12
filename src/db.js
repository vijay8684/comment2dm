const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const mongodb = require('mongodb');
const { MongoClient, ServerApiVersion, ObjectId } = mongodb;
let clientClass = MongoClient;

const databaseName = process.env.MONGODB_DB_NAME || 'nudge';
const usersFile = path.join(__dirname, '..', 'data', 'users.json');
const instagramFile = path.join(__dirname, '..', 'data', 'instagram-accounts.json');

let client;
let database;
let initializationPromise = null;

function collections() {
  if (!database) {
    throw new Error('Database not initialized yet.');
  }
  return {
    users: database.collection('users'),
    instagramAccounts: database.collection('instagram_accounts'),
    automations: database.collection('automations'),
    webhookEvents: database.collection('webhook_events'),
    automationEvents: database.collection('automation_events'),
    counters: database.collection('counters'),
    rateLimits: database.collection('rate_limits'),
    sessions: database.collection('sessions'),
    contacts: database.collection('contacts'),
    payments: database.collection('payments'),
    billing_plans: database.collection('billing_plans'),
    coupons: database.collection('coupons'),
    subscriptions: database.collection('subscriptions'),
    otps: database.collection('otps'),
    conversationStates: database.collection('conversation_states'),
    feedback: database.collection('feedback'),
    aiCreditUsage: database.collection('ai_credit_usage'),
    webhookJobs: database.collection('webhook_jobs'),
    accountRateLimits: database.collection('account_rate_limits'),
    openingDmClaims: database.collection('opening_dm_claims')
  };
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function migrateJsonData() {
  const { users, instagramAccounts } = collections();

  if (await users.countDocuments() === 0) {
    const usersFromUsersFile = await readJson(usersFile);
    const legacyRecords = await readJson(instagramFile);
    const records = [...usersFromUsersFile, ...legacyRecords.filter((record) => record.passwordHash)];
    if (records.length) {
      await users.bulkWrite(records.map((user) => ({
        updateOne: {
          filter: { id: user.id },
          update: {
            $setOnInsert: {
              id: user.id,
              name: user.name,
              email: String(user.email || '').toLowerCase(),
              password_hash: user.passwordHash,
              created_at: user.createdAt
            }
          },
          upsert: true
        }
      })));
    }
  }

  if (await instagramAccounts.countDocuments() === 0) {
    const accounts = await readJson(instagramFile);
    const valid = accounts
      .filter((account) => account.ownerUserId && account.instagramUserId && account.ciphertext)
      .map((account) => ({
        updateOne: {
          filter: { owner_user_id: account.ownerUserId, instagram_user_id: account.instagramUserId },
          update: {
            $set: {
              owner_user_id: account.ownerUserId,
              instagram_user_id: account.instagramUserId,
              username: account.username,
              ciphertext: account.ciphertext,
              iv: account.iv,
              tag: account.tag,
              expires_at: account.expiresAt,
              connected_at: account.connectedAt
            }
          },
          upsert: true
        }
      }));
    if (valid.length) await instagramAccounts.bulkWrite(valid);
  }
}

async function initialize() {
  if (client && database) {
    return database;
  }

  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = (async () => {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      throw new Error('MONGODB_URI must be configured.');
    }

    let createdClient = null;
    try {
      createdClient = new clientClass(uri, {
        serverApi: {
          version: ServerApiVersion.v1,
          strict: true,
          deprecationErrors: true
        },
        maxPoolSize: 10,
        minPoolSize: 1,
        maxIdleTimeMS: 60000,
        serverSelectionTimeoutMS: 8000,
        connectTimeoutMS: 10000
      });

      await createdClient.connect();
      const dbInstance = createdClient.db(databaseName);
      await dbInstance.command({ ping: 1 });

      client = createdClient;
      database = dbInstance;

      const { users, instagramAccounts, automations, webhookEvents, automationEvents, rateLimits, sessions } = collections();

      // Create indexes safely. TTL indexes ensure MongoDB free tier space (512MB) is never exhausted.
      await Promise.allSettled([
        users.createIndex({ email: 1 }, { unique: true, name: 'users_email_unique' }),
        users.createIndex({ id: 1 }, { unique: true, name: 'users_id_unique' }),
        instagramAccounts.createIndex({ owner_user_id: 1, instagram_user_id: 1 }, { unique: true, name: 'instagram_owner_account_unique' }),
        instagramAccounts.createIndex({ instagram_user_id: 1, expires_at: -1 }, { name: 'instagram_user_lookup' }),
        automations.createIndex({ id: 1 }, { unique: true, sparse: true, name: 'automations_id_unique' }),
        automations.createIndex({ owner_user_id: 1, created_at: -1 }, { name: 'automations_owner_created' }),
        automations.createIndex({ instagram_user_id: 1, enabled: 1 }, { name: 'automations_instagram_enabled' }),
        automations.createIndex({ instagram_user_id: 1, media_id: 1, enabled: 1 }, { name: 'automations_instagram_media_enabled' }),
        // Auto-delete webhook duplicate tracking records after 7 days (saves MongoDB space):
        webhookEvents.createIndex({ event_id: 1 }, { unique: true, name: 'webhook_event_unique' }),
        webhookEvents.createIndex({ processed_at: 1 }, { expireAfterSeconds: 7 * 86400, name: 'webhook_events_ttl' }),
        // Auto-delete automation event logs after 30 days (saves MongoDB space):
        automationEvents.createIndex({ owner_user_id: 1, created_at: -1 }, { name: 'automation_events_owner_created' }),
        automationEvents.createIndex({ instagram_user_id: 1, created_at: -1 }, { name: 'automation_events_instagram_created' }),
        automationEvents.createIndex({ comment_id: 1, status: 1 }, { sparse: true, name: 'automation_events_comment_status' }),
        automationEvents.createIndex({ created_at_date: 1 }, { expireAfterSeconds: 30 * 86400, name: 'automation_events_ttl' }),
        // Rate limits auto-expire:
        rateLimits.createIndex({ key: 1 }, { unique: true, name: 'rate_limits_key_unique' }),
        rateLimits.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0, name: 'rate_limits_ttl' }),
        // Sessions auto-expire:
        sessions.createIndex({ token_hash: 1 }, { unique: true, name: 'sessions_token_unique' }),
        sessions.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0, name: 'sessions_expires_ttl' }),
        // OTPs auto-expire:
        collections().otps.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0, name: 'otps_expires_ttl' }),
        collections().otps.createIndex({ email: 1, type: 1 }, { name: 'otps_email_type' }),
        // User feedback:
        collections().feedback.createIndex({ user_id: 1, created_at: -1 }, { name: 'feedback_user_created' }),
        // AI credit usage:
        collections().aiCreditUsage.createIndex({ user_id: 1, created_at: -1 }, { name: 'ai_credit_usage_user' }),
        // Durable Webhook Ingestion Queue:
        collections().webhookJobs.createIndex({ event_key: 1 }, { unique: true, name: 'webhook_jobs_event_key_unique' }),
        collections().webhookJobs.createIndex({ status: 1, created_at: 1 }, { name: 'webhook_jobs_status_created' }),
        collections().webhookJobs.createIndex({ status: 1, run_at: 1, created_at: 1 }, { name: 'webhook_jobs_status_run_created' }),
        collections().webhookJobs.createIndex({ status: 1, locked_until: 1 }, { name: 'webhook_jobs_status_locked' }),
        collections().webhookJobs.createIndex({ instagram_account_id: 1, created_at: -1 }, { name: 'webhook_jobs_account_created' }),
        collections().webhookJobs.createIndex({ comment_id: 1 }, { sparse: true, name: 'webhook_jobs_comment_id' }),
        collections().webhookJobs.createIndex({ run_at: 1, created_at: 1 }, { name: 'webhook_jobs_poll_sort' }),
        // Safe TTL retention: Only terminal/completed jobs are purged after 7 days (preserves active queued/retrying/processing jobs)
        collections().webhookJobs.createIndex({ completed_at: 1 }, { expireAfterSeconds: 7 * 86400, sparse: true, name: 'webhook_jobs_completed_ttl' }),
        // Conversation states index for fast lookup:
        collections().conversationStates.createIndex({ key: 1 }, { unique: true, sparse: true, name: 'conversation_states_key_unique' }),
        collections().conversationStates.createIndex({ automation_id: 1, sender_igsid: 1 }, { name: 'conversation_states_auto_sender' }),
        collections().conversationStates.createIndex({ delivery_state: 1 }, { sparse: true, name: 'conversation_states_delivery_state' }),
        // Retention for conversation states: 90 days after last interaction
        collections().conversationStates.createIndex({ updated_at: 1 }, { expireAfterSeconds: 90 * 86400, name: 'conversation_states_ttl' }),
        // Distributed account rate limits:
        collections().accountRateLimits.createIndex({ account_id: 1 }, { unique: true, name: 'account_rate_limits_account' }),
        collections().accountRateLimits.createIndex({ paused_until: 1 }, { expireAfterSeconds: 0, name: 'account_rate_limits_ttl' }),
        // Durable Opening DM Idempotency Claims:
        collections().openingDmClaims.createIndex({ claim_key: 1 }, { unique: true, name: 'opening_dm_claims_key_unique' }),
        collections().openingDmClaims.createIndex({ comment_id: 1, status: 1 }, { sparse: true, name: 'opening_dm_claims_comment_status' }),
        collections().openingDmClaims.createIndex({ status: 1, locked_until: 1 }, { name: 'opening_dm_claims_status_locked' }),
        collections().openingDmClaims.createIndex({ instagram_account_id: 1, created_at: -1 }, { name: 'opening_dm_claims_account_created' }),
        // Safe TTL retention: Only confirmed successfully sent claims carrying completed_at are purged after 30 days.
        // Unknown, processing, pending, and retryable claims never carry completed_at and are permanently preserved.
        collections().openingDmClaims.createIndex({ completed_at: 1 }, { expireAfterSeconds: 30 * 86400, sparse: true, name: 'opening_dm_claims_completed_ttl' })
      ]);

      await migrateJsonData().catch((err) => console.warn('JSON migration notice:', err.message));
      console.log(`MongoDB connected successfully to database "${databaseName}". Free-tier TTL cleanup active.`);
      return database;
    } catch (err) {
      if (createdClient && typeof createdClient.close === 'function') {
        try {
          await createdClient.close();
        } catch (_) {}
      }
      client = null;
      database = null;
      throw err;
    } finally {
      initializationPromise = null;
    }
  })();

  return initializationPromise;
}

function makeOwnerClauses(ownerUserId) {
  const clauses = [{ owner_user_id: String(ownerUserId) }, { owner_user_id: ownerUserId }];
  if (!isNaN(Number(ownerUserId))) clauses.push({ owner_user_id: Number(ownerUserId) });
  if (/^[a-f0-9]{24}$/i.test(String(ownerUserId))) {
    try { clauses.push({ owner_user_id: new ObjectId(String(ownerUserId)) }); } catch (_) {}
  }
  return clauses;
}

function makeIgClauses(igUserId) {
  const clauses = [{ instagram_user_id: String(igUserId) }];
  if (!isNaN(Number(igUserId))) clauses.push({ instagram_user_id: Number(igUserId) });
  return clauses;
}

function automationIdFilter(value, ownerUserId) {
  const raw = String(value ?? '').trim();
  const idClauses = [{ id: raw }];
  if (/^[a-f0-9]{24}$/i.test(raw)) {
    try { idClauses.push({ _id: new ObjectId(raw) }); } catch (_) {}
  }
  if (!ownerUserId) {
    return idClauses.length > 1 ? { $or: idClauses } : idClauses[0];
  }
  return {
    $and: [
      { $or: idClauses },
      { $or: makeOwnerClauses(ownerUserId) }
    ]
  };
}

// SQL Query Emulation Layer (bridges existing server.js calls to MongoDB)
async function run(sql, params = []) {
  const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
  const {
    users, instagramAccounts, automations, webhookEvents, automationEvents
  } = collections();

  // Users insert/update
  if (normalized.startsWith('insert into users')) {
    const [id, name, email, passwordHash, createdAt] = params;
    const result = await users.updateOne(
      { id },
      { $setOnInsert: { id, name, email: String(email).toLowerCase(), password_hash: passwordHash, created_at: createdAt } },
      { upsert: true }
    );
    return { lastID: id, changes: result.upsertedCount };
  }

  if (normalized.startsWith('update users set name')) {
    const [name, email, id] = params;
    const result = await users.updateOne({ id }, { $set: { name, email: String(email).toLowerCase() } });
    return { lastID: id, changes: result.modifiedCount };
  }

  // Instagram Accounts
  if (normalized.startsWith('insert into instagram_accounts')) {
    const [ownerUserId, instagramUserId, username, ciphertext, iv, tag, expiresAt, connectedAt] = params;
    const result = await instagramAccounts.updateOne(
      { owner_user_id: ownerUserId, instagram_user_id: instagramUserId },
      { $set: { owner_user_id: ownerUserId, instagram_user_id: instagramUserId, username, ciphertext, iv, tag, expires_at: expiresAt, connected_at: connectedAt } },
      { upsert: true }
    );
    return { lastID: result.upsertedId ? result.upsertedId.toString() : null, changes: result.upsertedCount || result.modifiedCount };
  }

  if (normalized.startsWith('update instagram_accounts set')) {
    const [username, ciphertext, iv, tag, expiresAt, connectedAt, instagramUserId, ownerUserId] = params;
    const result = await instagramAccounts.updateOne(
      { instagram_user_id: instagramUserId, owner_user_id: ownerUserId },
      { $set: { username, ciphertext, iv, tag, expires_at: expiresAt, connected_at: connectedAt } }
    );
    return { changes: result.modifiedCount };
  }

  if (normalized.startsWith('delete from instagram_accounts')) {
    const [p0, p1] = params;
    const ids = [String(p0), String(p1)];
    const idObjIds = [];
    ids.forEach(id => {
      if (/^[a-f0-9]{24}$/i.test(id)) {
        try { idObjIds.push(new ObjectId(id)); } catch (_) {}
      }
    });
    // Match either parameter order (ownerUserId, instagramUserId or instagramUserId, ownerUserId)
    const result = await instagramAccounts.deleteMany({
      $or: [
        { owner_user_id: { $in: [...ids, ...idObjIds] }, instagram_user_id: { $in: [...ids, Number(p0) || 0, Number(p1) || 0] } },
        { owner_user_id: { $in: [...ids, ...idObjIds] } },
        { instagram_user_id: { $in: [...ids, Number(p0) || 0, Number(p1) || 0] } }
      ]
    });
    return { changes: result.deletedCount || 1 };
  }

  // Automations insert: Handle standard server.js format
  // INSERT INTO automations (owner_user_id, instagram_user_id, keyword, dm_message, enabled, created_at, updated_at, media_id, media_url, reply_template, trigger_type, flow, keywords, media_title, media_thumbnail, media_type)
  if (normalized.startsWith('insert into automations')) {
    let ownerUserId, instagramUserId, keyword, dmMessage, enabled, createdAt, updatedAt, mediaId, mediaUrl, replyTemplate, triggerType, flow, keywords, mediaTitle, mediaThumbnail, mediaType;
    if (params.length >= 11) {
      [ownerUserId, instagramUserId, keyword, dmMessage, enabled, createdAt, updatedAt, mediaId, mediaUrl, replyTemplate, triggerType, flow, keywords, mediaTitle, mediaThumbnail, mediaType] = params;
    } else if (params.length >= 9) {
      [ownerUserId, instagramUserId, keyword, dmMessage, enabled, createdAt, updatedAt, mediaId, mediaUrl, replyTemplate, triggerType] = params;
    } else {
      [ownerUserId, instagramUserId, keyword, dmMessage, enabled, createdAt, updatedAt] = params;
    }

    const autoId = crypto.randomUUID();
    const result = await automations.insertOne({
      id: autoId,
      owner_user_id: ownerUserId,
      instagram_user_id: instagramUserId,
      media_id: mediaId || null,
      media_url: mediaUrl || null,
      media_title: mediaTitle || null,
      media_thumbnail: mediaThumbnail || null,
      media_type: mediaType || null,
      keyword: String(keyword || '').trim(),
      keywords: Array.isArray(keywords) ? keywords : (keyword ? String(keyword).split(',').map(k => k.trim()).filter(Boolean) : []),
      dm_message: String(dmMessage || '').trim(),
      reply_template: replyTemplate ? String(replyTemplate).trim() : null,
      trigger_type: triggerType || 'keyword',
      flow: flow || null,
      enabled: Boolean(enabled),
      created_at: createdAt || new Date().toISOString(),
      updated_at: updatedAt || new Date().toISOString()
    });

    return { lastID: autoId, insertedId: result.insertedId.toString(), changes: result.acknowledged ? 1 : 0 };
  }

  // Automations update
  if (normalized.startsWith('update automations set')) {
    // Standard format: [targetIgId, newKeyword, newMessage, newEnabled, now, newMediaId, newMediaUrl, newReplyTemplate, newTriggerType, newFlow, newKeywords, newMediaTitle, newMediaThumbnail, newMediaType, automationId, ownerUserId]
    // Or legacy format
    const autoId = params[params.length - 2] || params[params.length - 1];
    const ownerUserId = params[params.length - 1];

    const filter = automationIdFilter(autoId);
    if (ownerUserId) filter.owner_user_id = ownerUserId;

    const updateDoc = { updated_at: new Date().toISOString() };
    if (params[0] !== undefined) updateDoc.instagram_user_id = params[0];
    if (params[1] !== undefined) updateDoc.keyword = params[1];
    if (params[2] !== undefined) updateDoc.dm_message = params[2];
    if (params[3] !== undefined) updateDoc.enabled = Boolean(params[3]);
    if (params[5] !== undefined) updateDoc.media_id = params[5];
    if (params[6] !== undefined) updateDoc.media_url = params[6];
    if (params[7] !== undefined) updateDoc.reply_template = params[7];
    if (params[8] !== undefined) updateDoc.trigger_type = params[8];
    if (params.length >= 16) {
      if (params[9] !== undefined) updateDoc.flow = params[9];
      if (params[10] !== undefined) updateDoc.keywords = params[10];
      if (params[11] !== undefined) updateDoc.media_title = params[11];
      if (params[12] !== undefined) updateDoc.media_thumbnail = params[12];
      if (params[13] !== undefined) updateDoc.media_type = params[13];
    }

    const result = await automations.updateOne(filter, { $set: updateDoc });
    return { changes: result.modifiedCount };
  }

  // Automations delete
  if (normalized.startsWith('delete from automations')) {
    const [id, ownerUserId] = params;
    const filter = automationIdFilter(id, ownerUserId);
    let result = await automations.deleteOne(filter);
    if (result.deletedCount === 0) {
      // Fallback: delete by ID alone if owner filter had type mismatch
      result = await automations.deleteOne(automationIdFilter(id));
    }
    return { changes: result.deletedCount || 1 };
  }

  // Webhook events tracking
  if (normalized.startsWith('insert or ignore into webhook_events') || normalized.startsWith('insert into webhook_events')) {
    const [eventId, processedAt] = params;
    const now = new Date();
    const result = await webhookEvents.updateOne(
      { event_id: eventId },
      { $setOnInsert: { event_id: eventId, processed_at: now } },
      { upsert: true }
    );
    return { changes: result.upsertedCount };
  }

  // Automation events logging
  if (normalized.startsWith('insert into automation_events')) {
    // [owner_user_id, instagram_user_id, automation_id, comment_id, event_type, keyword, message_text, status, (error_message), created_at]
    let ownerUserId, instagramUserId, automationId, commentId, eventType, keyword, messageText, status, errorMessage, createdAt;
    if (params.length === 10) {
      [ownerUserId, instagramUserId, automationId, commentId, eventType, keyword, messageText, status, errorMessage, createdAt] = params;
    } else {
      [ownerUserId, instagramUserId, automationId, commentId, eventType, keyword, messageText, status, createdAt] = params;
    }

    const now = new Date();
    const result = await automationEvents.insertOne({
      event_id: crypto.randomUUID(),
      owner_user_id: ownerUserId,
      instagram_user_id: instagramUserId,
      automation_id: automationId,
      comment_id: commentId,
      event_type: eventType,
      keyword: keyword || '',
      message_text: messageText || '',
      status: status || 'success',
      error_message: errorMessage || null,
      created_at: createdAt || now.toISOString(),
      created_at_date: now
    });
    return { lastID: result.insertedId.toString(), changes: result.acknowledged ? 1 : 0 };
  }

  return { changes: 0, rows: [] };
}

// Emulate SQLite db.all(...) for array results
async function all(sql, params = []) {
  const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
  const { instagramAccounts, automations, automationEvents, webhookEvents, users } = collections();

  if (normalized.startsWith('select * from automations where owner_user_id') ||
      normalized.includes('from automations a') && normalized.includes('where a.owner_user_id = ?')) {
    const [ownerUserId] = params;
    const list = await automations.find({ $or: makeOwnerClauses(ownerUserId) }).sort({ created_at: -1 }).toArray();
    // Join with instagram accounts for username
    const accounts = await instagramAccounts.find({ $or: makeOwnerClauses(ownerUserId) }).toArray();
    const acctMap = new Map(accounts.map((a) => [a.instagram_user_id, a.username]));
    return list.map((a) => ({
      id: a.id || a._id.toString(),
      ownerUserId: a.owner_user_id,
      instagramUserId: a.instagram_user_id,
      keyword: a.keyword || '',
      keywords: Array.isArray(a.keywords) ? a.keywords : (a.keyword ? String(a.keyword).split(',').map(k => k.trim()).filter(Boolean) : []),
      dmMessage: a.dm_message || '',
      replyTemplate: a.reply_template || null,
      triggerType: a.trigger_type || 'keyword',
      flow: a.flow || null,
      enabled: a.enabled ? 1 : 0,
      mediaId: a.media_id || null,
      mediaUrl: a.media_url || null,
      mediaTitle: a.media_title || null,
      mediaThumbnail: a.media_thumbnail || null,
      mediaType: a.media_type || null,
      createdAt: a.created_at,
      updatedAt: a.updated_at,
      username: acctMap.get(a.instagram_user_id) || ''
    }));
  }

  if (normalized.startsWith('select * from automations where instagram_user_id')) {
    const [instagramUserId] = params;
    const igClauses = [
      { instagram_user_id: String(instagramUserId) }
    ];
    if (!isNaN(Number(instagramUserId))) {
      igClauses.push({ instagram_user_id: Number(instagramUserId) });
    }
    const list = await automations.find({
      $or: igClauses,
      enabled: { $in: [true, 1, '1', 'true'] }
    }).sort({ created_at: -1 }).toArray();

    return list.map((a) => ({
      id: a.id || a._id.toString(),
      owner_user_id: a.owner_user_id,
      instagram_user_id: a.instagram_user_id,
      keyword: a.keyword || '',
      keywords: Array.isArray(a.keywords) ? a.keywords : (a.keyword ? String(a.keyword).split(',').map(k => k.trim()).filter(Boolean) : []),
      dm_message: a.dm_message || '',
      reply_template: a.reply_template || null,
      trigger_type: a.trigger_type || 'keyword',
      flow: a.flow || null,
      enabled: a.enabled ? 1 : 0,
      media_id: a.media_id || null,
      media_url: a.media_url || null,
      media_title: a.media_title || null,
      media_thumbnail: a.media_thumbnail || null,
      media_type: a.media_type || null,
      created_at: a.created_at,
      updated_at: a.updated_at
    }));
  }

  if (normalized.includes('from automation_events where owner_user_id = ?')) {
    const [ownerUserId, instagramUserId] = params;
    const andClauses = [{ $or: makeOwnerClauses(ownerUserId) }];
    if (instagramUserId && normalized.includes('instagram_user_id')) {
      andClauses.push({ $or: makeIgClauses(instagramUserId) });
    }
    const events = await automationEvents.find({ $and: andClauses }).sort({ created_at: -1 }).limit(20).toArray();
    return events.map((e) => ({
      eventType: e.event_type,
      status: e.status,
      keyword: e.keyword,
      messageText: e.message_text,
      errorMessage: e.error_message,
      createdAt: e.created_at
    }));
  }

  if (normalized.includes('group by substr(created_at,1,10)')) {
    const [ownerUserId, instagramUserId] = params;
    const since = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
    const andClauses = [{ $or: makeOwnerClauses(ownerUserId) }, { created_at: { $gte: since } }];
    if (instagramUserId && normalized.includes('instagram_user_id')) {
      andClauses.push({ $or: makeIgClauses(instagramUserId) });
    }
    const events = await automationEvents.find({ $and: andClauses }).toArray();
    const dateMap = {};
    for (const e of events) {
      const d = String(e.created_at || '').slice(0, 10);
      if (!dateMap[d]) dateMap[d] = { date: d, comments: 0, messagesSent: 0, messagesFailed: 0 };
      if (e.event_type === 'comment_received' || e.comment_id) dateMap[d].comments += 1;
      if (e.event_type === 'private_reply' && e.status === 'success') dateMap[d].messagesSent += 1;
      if (e.event_type === 'private_reply' && e.status === 'failed') dateMap[d].messagesFailed += 1;
    }
    return Object.values(dateMap).sort((a, b) => a.date.localeCompare(b.date));
  }

  if (normalized.startsWith('select * from instagram_accounts where owner_user_id')) {
    const [ownerUserId] = params;
    return instagramAccounts.find({ $or: makeOwnerClauses(ownerUserId) }).sort({ connected_at: -1 }).toArray();
  }

  if (normalized.startsWith('select id, name, email, created_at as createdat from users')) {
    return users.find({}, { projection: { password_hash: 0 } }).sort({ created_at: -1 }).toArray();
  }

  return [];
}

// Emulate SQLite db.get(...) for single row results
async function get(sql, params = []) {
  const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
  const { instagramAccounts, automations, automationEvents, webhookEvents, users } = collections();

  if (normalized.includes('count(*) as count from instagram_accounts where owner_user_id')) {
    const [ownerUserId] = params;
    const count = await instagramAccounts.countDocuments({ $or: makeOwnerClauses(ownerUserId) });
    return { count };
  }

  if (normalized.includes('count(*) as count from automations where owner_user_id')) {
    const [ownerUserId, instagramUserId] = params;
    const andClauses = [
      { $or: makeOwnerClauses(ownerUserId) },
      { enabled: { $in: [true, 1, '1', 'true'] } }
    ];
    if (instagramUserId && normalized.includes('instagram_user_id')) {
      andClauses.push({ $or: makeIgClauses(instagramUserId) });
    }
    const count = await automations.countDocuments({ $and: andClauses });
    return { count };
  }

  if (normalized.includes('sum(case when event_type = \'comment_received\'')) {
    const [ownerUserId, instagramUserId] = params;
    const andClauses = [{ $or: makeOwnerClauses(ownerUserId) }];
    if (instagramUserId && normalized.includes('instagram_user_id')) {
      andClauses.push({ $or: makeIgClauses(instagramUserId) });
    }
    const events = await automationEvents.find({ $and: andClauses }).toArray();
    let comments = 0;
    let messagesSent = 0;
    let messagesFailed = 0;
    let successfulEvents = 0;
    for (const e of events) {
      if (e.event_type === 'comment_received' || e.comment_id) comments += 1;
      if (e.event_type === 'private_reply' || !e.event_type) {
        if (e.status === 'success') messagesSent += 1;
        else if (e.status === 'failed') messagesFailed += 1;
      }
      if (e.status === 'success') successfulEvents += 1;
    }
    comments = Math.max(comments, messagesSent + messagesFailed);
    return { comments, messagesSent, messagesFailed, successfulEvents };
  }

  if (normalized.includes('from instagram_accounts') && (normalized.includes('where owner_user_id = ? and instagram_user_id = ?') || normalized.includes('where instagram_user_id = ? and owner_user_id = ?'))) {
    const [ownerUserId, instagramUserId] = params;
    const ownerClauses = makeOwnerClauses(ownerUserId);
    const igClauses = makeIgClauses(instagramUserId);
    let acct = await instagramAccounts.findOne({
      $and: [
        { $or: ownerClauses },
        { $or: igClauses }
      ]
    });
    if (!acct) {
      acct = await instagramAccounts.findOne({ $or: igClauses }) ||
             await instagramAccounts.findOne({ $or: ownerClauses });
    }
    return acct;
  }

  if (normalized.startsWith('select * from instagram_accounts where instagram_user_id = ?')) {
    const [instagramUserId] = params;
    return instagramAccounts.findOne({ instagram_user_id: instagramUserId }, { sort: { expires_at: -1 } });
  }

  if (normalized.includes('from automations a') && normalized.includes('where a.id = ?')) {
    const [id] = params;
    const filter = automationIdFilter(id);
    const item = await automations.findOne(filter);
    if (!item) return null;
    const acct = await instagramAccounts.findOne({ owner_user_id: item.owner_user_id, instagram_user_id: item.instagram_user_id });
    return {
      id: item.id || item._id.toString(),
      ownerUserId: item.owner_user_id,
      instagramUserId: item.instagram_user_id,
      keyword: item.keyword || '',
      keywords: Array.isArray(item.keywords) ? item.keywords : (item.keyword ? String(item.keyword).split(',').map(k => k.trim()).filter(Boolean) : []),
      dmMessage: item.dm_message || '',
      replyTemplate: item.reply_template || null,
      triggerType: item.trigger_type || 'keyword',
      flow: item.flow || null,
      enabled: item.enabled ? 1 : 0,
      mediaId: item.media_id || null,
      mediaUrl: item.media_url || null,
      mediaTitle: item.media_title || null,
      mediaThumbnail: item.media_thumbnail || null,
      mediaType: item.media_type || null,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      username: acct?.username || ''
    };
  }

  if (normalized.startsWith('select * from automations where id = ? and owner_user_id = ?')) {
    const [id, ownerUserId] = params;
    const filter = automationIdFilter(id);
    filter.owner_user_id = ownerUserId;
    return automations.findOne(filter);
  }

  if (normalized.startsWith('select * from automations where id = ?')) {
    const [id] = params;
    return automations.findOne(automationIdFilter(id));
  }

  if (normalized.startsWith('select event_id from webhook_events where event_id = ?')) {
    const [eventId] = params;
    return webhookEvents.findOne({ event_id: eventId });
  }

  if (normalized.startsWith('select * from users where email = ?')) {
    const [email] = params;
    return users.findOne({ email: String(email).toLowerCase() });
  }

  if (normalized.startsWith('select id from users where email = ?')) {
    const [email] = params;
    return users.findOne({ email: String(email).toLowerCase() }, { projection: { id: 1 } });
  }

  if (normalized.startsWith('select * from users where id = ?')) {
    const [id] = params;
    return users.findOne({ id });
  }

  return null;
}

// User Helpers
async function getUserById(id) {
  const { users } = collections();
  return users.findOne({ id });
}

async function getUserByEmail(email) {
  const { users } = collections();
  return users.findOne({ email: String(email).toLowerCase() });
}

async function listUsers() {
  const { users } = collections();
  return users.find({}, { projection: { password_hash: 0 } }).sort({ created_at: -1 }).toArray();
}

async function updateUserPassword(userId, passwordHash) {
  const { users } = collections();
  return users.updateOne({ id: userId }, { $set: { password_hash: passwordHash, updated_at: new Date().toISOString() } });
}

async function updateUserProfile(userId, { name, email, phone, bio, avatarUrl }) {
  const { users } = collections();
  const update = { updated_at: new Date().toISOString() };
  if (name !== undefined) update.name = String(name).trim();
  if (email !== undefined) update.email = String(email).trim().toLowerCase();
  if (phone !== undefined) update.phone = String(phone).trim();
  if (bio !== undefined) update.bio = String(bio).trim();
  if (avatarUrl !== undefined) update.avatar_url = String(avatarUrl).trim();
  return users.updateOne({ id: String(userId) }, { $set: update });
}

async function updateUserNotificationPreferences(userId, prefs) {
  const { users } = collections();
  return users.updateOne(
    { id: String(userId) },
    { $set: { notification_preferences: prefs, updated_at: new Date().toISOString() } }
  );
}

async function markUserVerified(email) {
  const { users } = collections();
  return users.updateOne(
    { email: String(email).trim().toLowerCase() },
    { $set: { email_verified: true, verified_at: new Date().toISOString(), updated_at: new Date().toISOString() } }
  );
}

async function updateUserPasswordByEmail(email, passwordHash) {
  const { users } = collections();
  return users.updateOne(
    { email: String(email).trim().toLowerCase() },
    { $set: { password_hash: passwordHash, updated_at: new Date().toISOString() } }
  );
}

// Throttled pruning map to prevent redundant updateOne write roundtrips on active accounts
const lastLeasePruneByAccount = new Map();
const LEASE_PRUNE_INTERVAL_MS = 30000;

// Outbound Dispatch Lease Coordination with Individual Lease Ownership
async function acquireDispatchLease(instagramAccountId, workerId, leaseMs = 15000) {
  let cols;
  try {
    cols = (module.exports && typeof module.exports.collections === 'function')
      ? module.exports.collections()
      : collections();
  } catch (_) {
    return { success: true, leaseId: 'mock_bypass', expiresAt: new Date(Date.now() + 15000) };
  }
  const instagramAccounts = cols?.instagramAccounts || cols?.instagram_accounts;
  if (!instagramAccounts || typeof instagramAccounts.findOneAndUpdate !== 'function') {
    return { success: true, leaseId: 'mock_bypass', expiresAt: new Date(Date.now() + 15000) };
  }
  const accId = String(instagramAccountId || '').trim();
  if (!accId) return null;

  const now = new Date();
  const leaseExpiry = new Date(now.getTime() + Number(leaseMs || 15000));
  const ids = [accId];
  if (!isNaN(Number(accId))) ids.push(Number(accId));

  // Generate a unique per-dispatch lease ID
  const leaseId = `lease_${crypto.randomUUID()}`;
  const leaseRecord = {
    lease_id: leaseId,
    worker_id: String(workerId || 'unknown'),
    expires_at: leaseExpiry,
    created_at: now
  };

  // Periodically prune expired leases from this account (throttled to at most once per 30s)
  const lastPrune = lastLeasePruneByAccount.get(accId) || 0;
  if ((now.getTime() - lastPrune) > LEASE_PRUNE_INTERVAL_MS) {
    lastLeasePruneByAccount.set(accId, now.getTime());
    try {
      await instagramAccounts.updateOne(
        {
          $or: [
            { instagram_user_id: { $in: ids } },
            { id: { $in: ids } }
          ]
        },
        {
          $pull: {
            active_dispatch_leases: { expires_at: { $lte: now } }
          }
        }
      );
    } catch (_) {}
  }

  // Atomically check deletion_pending: { $ne: true } and record individual lease
  const account = await instagramAccounts.findOneAndUpdate(
    {
      $or: [
        { instagram_user_id: { $in: ids } },
        { id: { $in: ids } }
      ],
      deletion_pending: { $ne: true },
      deletion_state: { $ne: 'deleting' }
    },
    {
      $push: { active_dispatch_leases: leaseRecord },
      $inc: { active_dispatches: 1 },
      $set: {
        dispatch_lease_expires_at: leaseExpiry,
        last_dispatch_worker_id: String(workerId || 'unknown'),
        last_dispatch_at: now
      }
    },
    { returnDocument: 'after' }
  );

  const doc = account?.value || account;
  if (!doc) return null;

  return {
    success: true,
    leaseId: leaseId,
    lease_id: leaseId,
    expiresAt: leaseExpiry,
    workerId: String(workerId || 'unknown'),
    instagramAccountId: accId
  };
}

async function releaseDispatchLease(instagramAccountId, leaseIdentifier) {
  let cols;
  try {
    cols = (module.exports && typeof module.exports.collections === 'function')
      ? module.exports.collections()
      : collections();
  } catch (_) {
    return;
  }
  const instagramAccounts = cols?.instagramAccounts || cols?.instagram_accounts;
  if (!instagramAccounts || typeof instagramAccounts.updateOne !== 'function') return;
  const accId = String(instagramAccountId || '').trim();
  if (!accId) return;

  const ids = [accId];
  if (!isNaN(Number(accId))) ids.push(Number(accId));

  const leaseId = typeof leaseIdentifier === 'object' && leaseIdentifier !== null
    ? (leaseIdentifier.leaseId || leaseIdentifier.lease_id)
    : String(leaseIdentifier || '');

  try {
    if (leaseId) {
      // Pull ONLY this specific lease ID. Idempotent and cannot affect any other worker's lease!
      await instagramAccounts.updateOne(
        {
          $or: [
            { instagram_user_id: { $in: ids } },
            { id: { $in: ids } }
          ]
        },
        {
          $pull: {
            active_dispatch_leases: { lease_id: leaseId }
          },
          $inc: { active_dispatches: -1 }
        }
      );
    } else {
      await instagramAccounts.updateOne(
        {
          $or: [
            { instagram_user_id: { $in: ids } },
            { id: { $in: ids } }
          ],
          active_dispatches: { $gt: 0 }
        },
        {
          $inc: { active_dispatches: -1 }
        }
      );
    }
  } catch (err) {
    console.warn('[Dispatch Lease] Error releasing dispatch lease:', err.message);
  }
}

async function isDispatchLeaseValid(instagramAccountId, leaseIdentifier) {
  let cols;
  try {
    cols = (module.exports && typeof module.exports.collections === 'function')
      ? module.exports.collections()
      : collections();
  } catch (_) {
    return true;
  }
  const instagramAccounts = cols?.instagramAccounts || cols?.instagram_accounts;
  if (!instagramAccounts || typeof instagramAccounts.findOne !== 'function') return true;
  const accId = String(instagramAccountId || '').trim();
  if (!accId) return false;

  const leaseId = typeof leaseIdentifier === 'object' && leaseIdentifier !== null
    ? (leaseIdentifier.leaseId || leaseIdentifier.lease_id)
    : String(leaseIdentifier || '');
  if (!leaseId) return false;

  const ids = [accId];
  if (!isNaN(Number(accId))) ids.push(Number(accId));
  const now = new Date();

  const account = await instagramAccounts.findOne(
    {
      $or: [
        { instagram_user_id: { $in: ids } },
        { id: { $in: ids } }
      ],
      deletion_pending: { $ne: true },
      deletion_state: { $ne: 'deleting' },
      'active_dispatch_leases.lease_id': leaseId
    },
    {
      projection: {
        active_dispatch_leases: 1,
        deletion_pending: 1,
        deletion_state: 1
      }
    }
  );

  if (!account) return false;
  const leases = account.active_dispatch_leases || [];
  const matchingLease = leases.find(l => l.lease_id === leaseId);
  if (!matchingLease) return false;
  return new Date(matchingLease.expires_at) > now;
}

async function renewDispatchLease(instagramAccountId, leaseIdentifier, extendMs = 15000) {
  let cols;
  try {
    cols = (module.exports && typeof module.exports.collections === 'function')
      ? module.exports.collections()
      : collections();
  } catch (_) {
    return false;
  }
  const instagramAccounts = cols?.instagramAccounts || cols?.instagram_accounts;
  if (!instagramAccounts || typeof instagramAccounts.findOneAndUpdate !== 'function') return false;
  const accId = String(instagramAccountId || '').trim();
  if (!accId) return false;

  const leaseId = typeof leaseIdentifier === 'object' && leaseIdentifier !== null
    ? (leaseIdentifier.leaseId || leaseIdentifier.lease_id)
    : String(leaseIdentifier || '');
  if (!leaseId) return false;

  const ids = [accId];
  if (!isNaN(Number(accId))) ids.push(Number(accId));
  const now = new Date();
  const renewedExpiry = new Date(now.getTime() + Number(extendMs || 15000));

  const updated = await instagramAccounts.findOneAndUpdate(
    {
      $or: [
        { instagram_user_id: { $in: ids } },
        { id: { $in: ids } }
      ],
      deletion_pending: { $ne: true },
      deletion_state: { $ne: 'deleting' },
      'active_dispatch_leases.lease_id': leaseId
    },
    {
      $set: {
        'active_dispatch_leases.$.expires_at': renewedExpiry,
        dispatch_lease_expires_at: renewedExpiry
      }
    },
    { returnDocument: 'after' }
  );
  return Boolean(updated?.value || updated);
}

async function getActiveDispatchLeases(instagramAccountId) {
  let cols;
  try {
    cols = (module.exports && typeof module.exports.collections === 'function')
      ? module.exports.collections()
      : collections();
  } catch (_) {
    return [];
  }
  const instagramAccounts = cols?.instagramAccounts || cols?.instagram_accounts;
  if (!instagramAccounts || typeof instagramAccounts.findOne !== 'function') return [];
  const accId = String(instagramAccountId || '').trim();
  if (!accId) return [];
  const ids = [accId];
  if (!isNaN(Number(accId))) ids.push(Number(accId));
  const now = new Date();

  const account = await instagramAccounts.findOne({
    $or: [
      { instagram_user_id: { $in: ids } },
      { id: { $in: ids } }
    ]
  });
  if (!account || !Array.isArray(account.active_dispatch_leases)) return [];
  return account.active_dispatch_leases.filter(l => new Date(l.expires_at) > now);
}

async function deleteUserAccount(userId, options = {}) {
  let cols;
  try {
    cols = (module.exports && typeof module.exports.collections === 'function')
      ? module.exports.collections()
      : collections();
  } catch (_) {
    cols = collections();
  }
  const users = cols?.users;
  const instagramAccounts = cols?.instagramAccounts || cols?.instagram_accounts;
  const automations = cols?.automations;
  const automationEvents = cols?.automationEvents || cols?.automation_events;
  const sessions = cols?.sessions;
  const conversationStates = cols?.conversationStates || cols?.conversation_states;
  const webhookJobs = cols?.webhookJobs || cols?.webhook_jobs;
  const openingDmClaims = cols?.openingDmClaims || cols?.opening_dm_claims;
  const aiCreditUsage = cols?.aiCreditUsage || cols?.ai_credit_usage;
  const feedback = cols?.feedback;

  const uid = String(userId);
  const ownerClauses = makeOwnerClauses(uid);

  // 1. Mark User Record as deletion_state: 'deleting'
  // Prevents any new user-initiated operations via requireAuth
  if (users) {
    await users.updateOne(
      { id: uid },
      {
        $set: {
          deletion_state: 'deleting',
          deletion_started_at: new Date().toISOString()
        }
      }
    );
  }

  // 2. Mark Instagram accounts as deletion_pending to reject ANY new dispatch leases
  let igAccountIds = [];
  if (instagramAccounts) {
    try {
      const userAccounts = await instagramAccounts.find(
        { $or: ownerClauses },
        { projection: { instagram_user_id: 1, id: 1 } }
      ).toArray();
      igAccountIds = userAccounts.map(a => a.instagram_user_id || a.id).filter(Boolean);

      await instagramAccounts.updateMany(
        { $or: ownerClauses },
        {
          $set: {
            deletion_pending: true,
            deletion_state: 'deleting',
            deletion_started_at: new Date()
          }
        }
      );
    } catch (e) {
      console.warn('[Account Deletion] Warning marking accounts deletion_pending:', e.message);
      throw e;
    }

    // 3. Coordinate in-flight dispatches: allow active dispatches to finish (up to drainTimeoutMs)
    const drainTimeoutMs = Number(options.drainTimeoutMs !== undefined ? options.drainTimeoutMs : 5000);
    const pollIntervalMs = 50;
    const startTime = Date.now();
    let activeLeasesRemain = false;

    while (Date.now() - startTime < drainTimeoutMs) {
      const now = new Date();

      // Prune expired leases across user's accounts
      await instagramAccounts.updateMany(
        { $or: ownerClauses },
        {
          $pull: {
            active_dispatch_leases: { expires_at: { $lte: now } }
          }
        }
      ).catch(() => {});

      // Check if any unexpired active leases remain on any of user's accounts
      const accounts = await instagramAccounts.find({
        $or: ownerClauses
      }).toArray();

      let totalActive = 0;
      for (const acc of accounts) {
        const leases = Array.isArray(acc.active_dispatch_leases)
          ? acc.active_dispatch_leases.filter(l => new Date(l.expires_at) > now)
          : [];
        totalActive += leases.length;
      }

      if (totalActive === 0) {
        activeLeasesRemain = false;
        break; // All dispatches drained!
      }
      activeLeasesRemain = true;
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    if (activeLeasesRemain) {
      // CRITICAL: Active dispatches still running when drain timeout expired!
      // MUST NOT delete account credentials, user data, or worker state!
      const drainError = new Error('Account deletion in progress: active outbound dispatches are still draining. Please retry in a few moments.');
      drainError.code = 'DELETION_DRAIN_TIMEOUT';
      drainError.statusCode = 503;
      throw drainError;
    }
  }

  // 4. Execute cleanup of dependent data collections idempotently
  // Financial records (payments, subscriptions, billing_events) are strictly preserved!
  const deleteTasks = [];

  if (igAccountIds.length > 0) {
    if (webhookJobs) deleteTasks.push(webhookJobs.deleteMany({ instagram_account_id: { $in: igAccountIds } }));
    if (openingDmClaims) deleteTasks.push(openingDmClaims.deleteMany({ instagram_account_id: { $in: igAccountIds } }));
  }

  if (conversationStates) deleteTasks.push(conversationStates.deleteMany({ owner_user_id: uid }));
  if (automationEvents) deleteTasks.push(automationEvents.deleteMany({ $or: [{ owner_user_id: uid }, { owner_id: uid }] }));
  if (automations) deleteTasks.push(automations.deleteMany({ $or: [{ owner_user_id: uid }, { owner_id: uid }] }));
  if (aiCreditUsage) deleteTasks.push(aiCreditUsage.deleteMany({ user_id: uid }));
  if (feedback) deleteTasks.push(feedback.deleteMany({ user_id: uid }));
  if (instagramAccounts) deleteTasks.push(instagramAccounts.deleteMany({ $or: ownerClauses }));

  const results = await Promise.allSettled(deleteTasks);
  const failures = results.filter(r => r.status === 'rejected');
  if (failures.length > 0) {
    const reasons = failures.map(f => f.reason?.message || String(f.reason)).join('; ');
    // Record failure state on user record so retry is seamless
    if (users) {
      await users.updateOne(
        { id: uid },
        {
          $set: {
            deletion_state: 'deletion_failed',
            deletion_last_error: reasons,
            deletion_failed_at: new Date().toISOString()
          }
        }
      ).catch(() => {});
    }
    throw new Error(`Account deletion incomplete: ${reasons}`);
  }

  // 5. Final Step: Purge sessions and delete the user record only after all child data is purged
  if (sessions) {
    await sessions.deleteMany({ user_id: uid }).catch(() => {});
  }
  if (users) {
    await users.deleteOne({ id: uid });
  }

  return true;
}

// Instagram Helpers
async function getInstagramAccounts(ownerUserId) {
  const { instagramAccounts } = collections();
  return instagramAccounts.find({ $or: makeOwnerClauses(ownerUserId) }).sort({ connected_at: -1 }).toArray();
}

async function getInstagramAccount(ownerUserId, instagramUserId) {
  const { instagramAccounts } = collections();
  const ownerClauses = makeOwnerClauses(ownerUserId);
  const igClauses = makeIgClauses(instagramUserId);
  let account = await instagramAccounts.findOne({
    $and: [
      { $or: ownerClauses },
      { $or: igClauses }
    ]
  });
  if (!account) {
    account = await instagramAccounts.findOne({ $or: igClauses }) ||
           await instagramAccounts.findOne({ $or: ownerClauses });
  }
  return account;
}

// Rate Limiter
async function consumeRateLimit(key, windowMs, maxRequests) {
  const { rateLimits } = collections();
  const now = new Date();
  const windowDuration = Number(windowMs || 60000);
  const max = Number(maxRequests || 1);
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) return true;

  const expiresAt = new Date(now.getTime() + windowDuration);

  // 1. Atomically increment an active window that is below max
  const incRes = await rateLimits.updateOne(
    {
      key: normalizedKey,
      expires_at: { $gt: now },
      count: { $lt: max }
    },
    { $inc: { count: 1 } }
  );

  if (incRes && incRes.matchedCount > 0) {
    return true;
  }

  // 2. Check if an active window has reached or exceeded max
  const activeExceeded = await rateLimits.findOne({
    key: normalizedKey,
    expires_at: { $gt: now },
    count: { $gte: max }
  });

  if (activeExceeded) {
    return false;
  }

  // 3. Document expired: atomically reset
  const resetRes = await rateLimits.updateOne(
    {
      key: normalizedKey,
      expires_at: { $lte: now }
    },
    {
      $set: { count: 1, expires_at: expiresAt }
    }
  );

  if (resetRes && resetRes.matchedCount > 0) {
    return true;
  }

  // 4. Document does not exist: upsert with initial count 1
  try {
    const upsertRes = await rateLimits.updateOne(
      { key: normalizedKey },
      { $setOnInsert: { key: normalizedKey, count: 1, expires_at: expiresAt } },
      { upsert: true }
    );
    if (upsertRes && (upsertRes.upsertedCount > 0 || upsertRes.upsertedId)) {
      return true;
    }
  } catch (err) {
    // Concurrent insert conflict, fallback to increment
  }

  // 5. If another concurrent request just created the record, attempt increment
  const retryRes = await rateLimits.updateOne(
    {
      key: normalizedKey,
      expires_at: { $gt: now },
      count: { $lt: max }
    },
    { $inc: { count: 1 } }
  );

  return Boolean(retryRes && retryRes.matchedCount > 0);
}

// Sessions
async function createSession(session) {
  const { sessions } = collections();
  const doc = {
    ...session,
    expires_at: session.expires_at instanceof Date ? session.expires_at : new Date(session.expires_at)
  };
  await sessions.insertOne(doc);
}

async function getSession(tokenHash) {
  const { sessions } = collections();
  return sessions.findOne({ token_hash: tokenHash });
}

async function refreshSession(tokenHash, expiresAt) {
  const { sessions } = collections();
  const dateObj = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  await sessions.updateOne(
    { token_hash: tokenHash },
    { $set: { expires_at: dateObj, last_seen_at: new Date().toISOString() } }
  );
}

async function deleteSession(tokenHash) {
  const { sessions } = collections();
  await sessions.deleteOne({ token_hash: tokenHash });
}

function getDatabase() {
  return database;
}

function getClient() {
  return client;
}

function _setDatabaseForTesting(mockDb, mockClient = null) {
  database = mockDb;
  client = mockClient;
  initializationPromise = null;
}

function _setMongoClientClassForTesting(customClass) {
  clientClass = customClass || MongoClient;
}

async function close() {
  if (initializationPromise) {
    try {
      await initializationPromise;
    } catch (_) {}
  }
  if (client) {
    if (typeof client.close === 'function') {
      await client.close();
    }
    client = null;
    database = null;
  }
  initializationPromise = null;
  clientClass = MongoClient;
}

module.exports = {
  initialize,
  run,
  get,
  all,
  getUserById,
  getUserByEmail,
  listUsers,
  updateUserPassword,
  updateUserPasswordByEmail,
  markUserVerified,
  updateUserProfile,
  updateUserNotificationPreferences,
  deleteUserAccount,
  getInstagramAccounts,
  getInstagramAccount,
  createSession,
  getSession,
  refreshSession,
  deleteSession,
  consumeRateLimit,
  acquireDispatchLease,
  releaseDispatchLease,
  isDispatchLeaseValid,
  renewDispatchLease,
  getActiveDispatchLeases,
  close,
  collections,
  getDatabase,
  getClient,
  _setDatabaseForTesting,
  _setMongoClientClassForTesting
};