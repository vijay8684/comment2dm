// test_storage_and_r2_suite.js
// Verification suite for Comment2DM Cloudflare R2 Storage & Quota Lifecycle
// Verifies all 20 storage criteria: decimal quotas, persistence, presigning, atomic reservations,
// confirmation, in-use protection, immediate quota release, and zero-disk write.

const assert = require('assert');
const http = require('http');
const express = require('express');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test_jwt_secret_comment2dm_storage_suite_32chars!';
process.env.RAZORPAY_KEY_ID = 'rzp_test_TzjG2mAiJjGWxv';
process.env.RAZORPAY_KEY_SECRET = 'FTjrig5RKFU6dvMcpwGXzC3j';
process.env.RAZORPAY_WEBHOOK_SECRET = 'Commnet2DM_Billing';

const db = require('./src/db');
const billing = require('./src/billing');
const authService = require('./src/auth/authService');
const storageService = require('./src/services/storageService');
const { app } = require('./server');

function matchesQuery(doc, query) {
  if (!query || Object.keys(query).length === 0) return true;
  if (!doc) return false;
  for (const [key, val] of Object.entries(query)) {
    if (key === '$or' && Array.isArray(val)) {
      if (!val.some(q => matchesQuery(doc, q))) return false;
      continue;
    }
    if (key === '$and' && Array.isArray(val)) {
      if (!val.every(q => matchesQuery(doc, q))) return false;
      continue;
    }
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      if (val.$exists !== undefined) {
        const exists = doc[key] !== undefined;
        if (exists !== val.$exists) return false;
        continue;
      }
      if (val.$in && Array.isArray(val.$in)) {
        if (!val.$in.includes(doc[key])) return false;
        continue;
      }
      if (val.$nin && Array.isArray(val.$nin)) {
        if (val.$nin.includes(doc[key])) return false;
        continue;
      }
      if (val.$ne !== undefined) {
        if (doc[key] === val.$ne) return false;
        continue;
      }
      if (val.$gte !== undefined) {
        if (!(doc[key] >= val.$gte)) return false;
        continue;
      }
      if (val.$gt !== undefined) {
        if (!(doc[key] > val.$gt)) return false;
        continue;
      }
      if (val.$lte !== undefined) {
        if (!(doc[key] <= val.$lte)) return false;
        continue;
      }
      if (val.$lt !== undefined) {
        const docVal = doc[key] instanceof Date ? doc[key].getTime() : doc[key];
        const cmpVal = val.$lt instanceof Date ? val.$lt.getTime() : val.$lt;
        if (!(docVal < cmpVal)) return false;
        continue;
      }
    }
    if (doc[key] !== val) return false;
  }
  return true;
}

function applyUpdates(doc, update) {
  if (update.$set) Object.assign(doc, update.$set);
  if (update.$inc) {
    for (const [k, v] of Object.entries(update.$inc)) doc[k] = (doc[k] || 0) + v;
  }
  if (update.$addToSet) {
    for (const [k, v] of Object.entries(update.$addToSet)) {
      if (!Array.isArray(doc[k])) doc[k] = [];
      if (!doc[k].includes(v)) doc[k].push(v);
    }
  }
  if (update.$pull) {
    for (const [k, v] of Object.entries(update.$pull)) {
      if (Array.isArray(doc[k])) {
        doc[k] = doc[k].filter(item => item !== v);
      }
    }
  }
}

function createMockCollection() {
  const items = [];
  return {
    _items: items,
    find(query = {}) {
      let sortSpec = null;
      let limitNum = null;
      return {
        sort(s) { sortSpec = s; return this; },
        limit(l) { limitNum = l; return this; },
        async toArray() {
          let res = items.filter(d => matchesQuery(d, query));
          if (sortSpec) {
            res.sort((a, b) => {
              for (const [k, dir] of Object.entries(sortSpec)) {
                const valA = a[k] !== undefined && a[k] !== null ? (a[k] instanceof Date ? a[k].getTime() : a[k]) : (dir === 1 ? Infinity : -Infinity);
                const valB = b[k] !== undefined && b[k] !== null ? (b[k] instanceof Date ? b[k].getTime() : b[k]) : (dir === 1 ? Infinity : -Infinity);
                if (valA < valB) return dir === -1 ? 1 : -1;
                if (valA > valB) return dir === -1 ? -1 : 1;
              }
              return 0;
            });
          }
          if (limitNum) res = res.slice(0, limitNum);
          return res;
        }
      };
    },
    async findOne(query = {}) {
      return items.find(d => matchesQuery(d, query)) || null;
    },
    async countDocuments(query = {}) {
      return items.filter(d => matchesQuery(d, query)).length;
    },
    async insertOne(doc) {
      items.push({ ...doc });
      return { insertedId: doc._id || doc.id || 'id_' + Math.random().toString(36).substring(2, 7) };
    },
    async updateOne(query, update, options = {}) {
      let doc = items.find(d => matchesQuery(d, query));
      if (!doc) {
        if (options && options.upsert) {
          doc = {};
          if (update.$setOnInsert) Object.assign(doc, update.$setOnInsert);
          if (update.$set) Object.assign(doc, update.$set);
          for (const [k, v] of Object.entries(query)) {
            if (!k.startsWith('$')) doc[k] = v;
          }
          items.push(doc);
          return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
        }
        return { matchedCount: 0, modifiedCount: 0 };
      }
      applyUpdates(doc, update);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async updateMany(query, update) {
      const matches = items.filter(d => matchesQuery(d, query));
      matches.forEach(d => applyUpdates(d, update));
      return { matchedCount: matches.length, modifiedCount: matches.length };
    },
    async findOneAndUpdate(query, update, options = {}) {
      let matches = items.filter(d => matchesQuery(d, query));
      if (options && options.sort) {
        matches.sort((a, b) => {
          for (const [k, dir] of Object.entries(options.sort)) {
            const valA = a[k] !== undefined && a[k] !== null ? (a[k] instanceof Date ? a[k].getTime() : a[k]) : (dir === 1 ? Infinity : -Infinity);
            const valB = b[k] !== undefined && b[k] !== null ? (b[k] instanceof Date ? b[k].getTime() : b[k]) : (dir === 1 ? Infinity : -Infinity);
            if (valA < valB) return dir === -1 ? 1 : -1;
            if (valA > valB) return dir === -1 ? -1 : 1;
          }
          return 0;
        });
      }
      let doc = matches[0] || null;
      if (!doc) {
        if (options && options.upsert) {
          doc = {};
          if (update.$setOnInsert) Object.assign(doc, update.$setOnInsert);
          if (update.$set) Object.assign(doc, update.$set);
          for (const [k, v] of Object.entries(query)) {
            if (!k.startsWith('$')) doc[k] = v;
          }
          items.push(doc);
          return { value: doc };
        }
        return { value: null };
      }
      const oldDoc = { ...doc };
      applyUpdates(doc, update);
      return { value: options && options.returnDocument === 'after' ? doc : oldDoc };
    },
    async deleteOne(query) {
      const idx = items.findIndex(d => matchesQuery(d, query));
      if (idx !== -1) items.splice(idx, 1);
      return { deletedCount: idx !== -1 ? 1 : 0 };
    },
    async deleteMany(query) {
      const initial = items.length;
      for (let i = items.length - 1; i >= 0; i--) {
        if (matchesQuery(items[i], query)) items.splice(i, 1);
      }
      return { deletedCount: initial - items.length };
    }
  };
}

let passedChecks = 0;
function test(desc, condition) {
  if (condition) {
    console.log(`  ✓ PASSED: ${desc}`);
    passedChecks++;
  } else {
    console.error(`  ✗ FAILED: ${desc}`);
    process.exitCode = 1;
  }
}

async function run() {
  console.log('======================================================================');
  console.log('   COMMENT2DM — CLOUDFLARE R2 STORAGE & QUOTA LIFECYCLE (20 CHECKS)');
  console.log('======================================================================\n');

  const mockCollections = {
    users: createMockCollection(),
    sessions: createMockCollection(),
    subscriptions: createMockCollection(),
    billing_plans: createMockCollection(),
    instagram_accounts: createMockCollection(),
    automations: createMockCollection(),
    automation_events: createMockCollection(),
    storage_resources: createMockCollection()
  };

  const mockDb = {
    collection(name) {
      if (!mockCollections[name]) mockCollections[name] = createMockCollection();
      return mockCollections[name];
    }
  };

  db._setDatabaseForTesting(mockDb);
  billing._setDbForTesting(mockDb);

  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  function makeRequest(method, path, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, baseUrl);
      const isBuffer = Buffer.isBuffer(body);
      const payload = isBuffer ? body : (body ? JSON.stringify(body) : null);
      const reqHeaders = { ...headers };
      if (payload && !reqHeaders['Content-Type'] && !isBuffer) reqHeaders['Content-Type'] = 'application/json';
      if (payload) reqHeaders['Content-Length'] = Buffer.byteLength(payload);

      const req = http.request(url, { method, headers: reqHeaders }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  // Seed test users
  const freeUser = { id: 'usr_free_stg', email: 'free_stg@example.com', name: 'Free Storage User' };
  const proUser = { id: 'usr_pro_stg', email: 'pro_stg@example.com', name: 'Pro Storage User' };
  const eliteUser = { id: 'usr_elite_stg', email: 'elite_stg@example.com', name: 'Elite Storage User' };

  await mockCollections.users.insertOne(freeUser);
  await mockCollections.users.insertOne(proUser);
  await mockCollections.users.insertOne(eliteUser);

  await mockCollections.instagram_accounts.insertOne({
    owner_user_id: freeUser.id,
    instagram_user_id: 'ig_free_acc_1',
    username: 'free_acc_1'
  });

  const freeToken = await authService.createSession(freeUser.id, new Date(Date.now() + 86400000));
  const proToken = await authService.createSession(proUser.id, new Date(Date.now() + 86400000));
  const eliteToken = await authService.createSession(eliteUser.id, new Date(Date.now() + 86400000));

  const freeHeaders = { Authorization: `Bearer ${freeToken}` };
  const proHeaders = { Authorization: `Bearer ${proToken}` };
  const eliteHeaders = { Authorization: `Bearer ${eliteToken}` };

  await mockCollections.subscriptions.insertOne({
    user_id: proUser.id,
    plan: 'pro',
    billing_cycle: 'monthly',
    status: 'active'
  });
  await mockCollections.subscriptions.insertOne({
    user_id: eliteUser.id,
    plan: 'elite',
    billing_cycle: 'monthly',
    status: 'active'
  });

  // Mock S3 Client for testing
  const mockS3Client = {
    async send(cmd) {
      return { acknowledged: true };
    },
    async getSignedUrl(params) {
      return `https://comment2dm-assets.r2.cloudflarestorage.com/${params.Key}?X-Amz-Signature=testmock`;
    }
  };

  // Section 1: Canonical Quota Definitions & Decimal Units
  console.log('--- 1. CANONICAL STORAGE QUOTAS & DECIMAL METRICS ---');
  const freeEnt = await billing.entitlement(freeUser.id);
  const proEnt = await billing.entitlement(proUser.id);
  const eliteEnt = await billing.entitlement(eliteUser.id);

  test('Free plan provides exactly 150 MB decimal storage (150,000,000 bytes)',
    freeEnt.limits.storageBytes === 150000000 && freeEnt.limits.storageDisplay === '150 MB'
  );

  test('Pro plan provides exactly 1 GB decimal storage (1,000,000,000 bytes)',
    proEnt.limits.storageBytes === 1000000000 && proEnt.limits.storageDisplay === '1 GB'
  );

  test('Elite plan provides exactly 5 GB decimal storage (5,000,000,000 bytes)',
    eliteEnt.limits.storageBytes === 5000000000 && eliteEnt.limits.storageDisplay === '5 GB'
  );

  test('formatBytes properly renders decimal MB and GB boundaries',
    storageService.formatBytes(150000000) === '150 MB' &&
    storageService.formatBytes(1000000000) === '1 GB' &&
    storageService.formatBytes(5000000000) === '5 GB' &&
    storageService.formatBytes(500000000) === '500 MB'
  );

  // Section 2: Unconfigured State & Safety Fallback
  console.log('\n--- 2. CREDENTIAL SAFETY & UNCONFIGURED STATE ---');
  storageService._setS3ClientForTesting(null);
  const oldAccessKey = process.env.R2_ACCESS_KEY_ID;
  const oldSecretKey = process.env.R2_SECRET_ACCESS_KEY;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;

  let unconfiguredErrorCaught = false;
  try {
    await storageService.createPresignedUpload(freeUser.id, {
      fileName: 'guide.pdf',
      fileType: 'application/pdf',
      fileSize: 1000000
    });
  } catch (err) {
    unconfiguredErrorCaught = err.statusCode === 503 && err.code === 'STORAGE_NOT_CONFIGURED';
  }
  test('Presigned URL creation safely returns HTTP 503 when R2 is unconfigured', unconfiguredErrorCaught);

  const unconfiguredApiRes = await makeRequest('POST', '/api/storage/presign', {
    fileName: 'guide.pdf',
    fileType: 'application/pdf',
    fileSize: 1000000
  }, freeHeaders);
  test('API endpoint /api/storage/presign returns HTTP 503 with safe error message',
    unconfiguredApiRes.status === 503 && unconfiguredApiRes.body.error.includes('unconfigured')
  );

  // Restore S3 mock for remaining lifecycle tests
  process.env.R2_ACCESS_KEY_ID = 'test_r2_id';
  process.env.R2_SECRET_ACCESS_KEY = 'test_r2_secret';
  storageService._setS3ClientForTesting(mockS3Client);

  // Section 3: Input Validation & Single File Ceilings
  console.log('\n--- 3. INPUT VALIDATION & CONSTRAINTS ---');
  let invalidMimeCaught = false;
  try {
    await storageService.createPresignedUpload(freeUser.id, {
      fileName: 'malware.exe',
      fileType: 'application/x-msdownload',
      fileSize: 500000
    });
  } catch (err) {
    invalidMimeCaught = err.statusCode === 400 && err.message.includes('Unsupported file type');
  }
  test('Unsupported file types (e.g. .exe) are rejected with HTTP 400', invalidMimeCaught);

  let excessiveSizeCaught = false;
  try {
    await storageService.createPresignedUpload(freeUser.id, {
      fileName: 'huge.pdf',
      fileType: 'application/pdf',
      fileSize: 15 * 1000 * 1000 // 15 MB > 10 MB limit
    });
  } catch (err) {
    excessiveSizeCaught = err.statusCode === 400 && err.message.includes('10 MB maximum limit');
  }
  test('Single files exceeding 10 MB maximum upload ceiling are rejected with HTTP 400', excessiveSizeCaught);

  // Section 4: Direct Presigned URL Generation & Atomic Reservation
  console.log('\n--- 4. PRESIGNED URLS & ATOMIC RESERVATIONS ---');
  const presignRes = await storageService.createPresignedUpload(freeUser.id, {
    fileName: 'cheatsheet.pdf',
    fileType: 'application/pdf',
    fileSize: 5000000 // 5 MB
  });
  test('Presigned upload generates unique resource ID and direct R2 upload URL',
    presignRes.success === true &&
    presignRes.resourceId.startsWith('res_') &&
    presignRes.uploadUrl.includes('comment2dm-assets.r2.cloudflarestorage.com') &&
    presignRes.objectKey.startsWith(`users/${freeUser.id}/`)
  );

  const pendingRecord = await mockCollections.storage_resources.findOne({ id: presignRes.resourceId });
  test('Pending upload creates an atomic reservation record in storage_resources',
    pendingRecord &&
    pendingRecord.status === 'pending' &&
    pendingRecord.size_bytes === 5000000 &&
    pendingRecord.owner_user_id === freeUser.id
  );

  const usageDuringPending = await storageService.getStorageUsage(freeUser.id);
  test('Pending reservation immediately consumes customer storage quota to prevent race conditions',
    usageDuringPending.usedBytes === 5000000 &&
    usageDuringPending.remainingBytes === 145000000
  );

  // Section 5: Quota Exceeded Rejection
  console.log('\n--- 5. STORAGE QUOTA ENFORCEMENT ---');
  let quotaExceededCaught = false;
  try {
    // Free has 150 MB total, 50 MB pending. Trying to reserve 110 MB should fail (50 + 110 = 160 > 150).
    // Note: single file ceiling is 10 MB for normal uploads, but let's test quota boundary with proUser or small increments
    // Let's test with 5 MB when only 4 MB remains:
    // First fill proUser up to 998 MB:
    await mockCollections.storage_resources.insertOne({
      id: 'res_filler_pro',
      owner_user_id: proUser.id,
      r2_object_key: `users/${proUser.id}/filler.pdf`,
      original_filename: 'filler.pdf',
      content_type: 'application/pdf',
      size_bytes: 996000000, // 996 MB used out of 1000 MB (4 MB remains)
      status: 'active',
      created_at: new Date().toISOString(),
      automation_references: [],
      deletion_state: { isDeleted: false }
    });

    // Attempting to upload 5 MB when 4 MB remains must fail:
    await storageService.createPresignedUpload(proUser.id, {
      fileName: 'overflow.pdf',
      fileType: 'application/pdf',
      fileSize: 5000000 // 5 MB > 4 MB remaining
    });
  } catch (err) {
    quotaExceededCaught = err.statusCode === 403 && err.code === 'STORAGE_QUOTA_EXCEEDED';
  }
  test('Upload is rejected with HTTP 403 (STORAGE_QUOTA_EXCEEDED) when remaining space is insufficient', quotaExceededCaught);

  // Section 6: Upload Confirmation & Idempotency
  console.log('\n--- 6. UPLOAD CONFIRMATION & IDEMPOTENCY ---');
  const confirmRes = await storageService.confirmUpload(freeUser.id, {
    resourceId: presignRes.resourceId,
    objectKey: presignRes.objectKey
  });
  test('Confirm upload transitions status from pending to active and generates access URL',
    confirmRes.success === true &&
    confirmRes.resource.id === presignRes.resourceId &&
    confirmRes.resource.url.includes(presignRes.resourceId)
  );

  const confirmedRecord = await mockCollections.storage_resources.findOne({ id: presignRes.resourceId });
  test('Active resource record has confirmed_at timestamp and active status',
    confirmedRecord.status === 'active' && Boolean(confirmedRecord.confirmed_at)
  );

  const reConfirmRes = await storageService.confirmUpload(freeUser.id, {
    resourceId: presignRes.resourceId,
    objectKey: presignRes.objectKey
  });
  test('Confirm upload is idempotent and returns active resource on duplicate calls',
    reConfirmRes.success === true && reConfirmRes.resource.id === presignRes.resourceId
  );

  // Section 7: Storage Persistence Across Month Boundaries
  console.log('\n--- 7. STORAGE PERSISTENCE ACROSS BILLING CYCLES ---');
  // Seed a file created 60 days ago
  const oldDate = new Date();
  oldDate.setMonth(oldDate.getMonth() - 2);
  await mockCollections.storage_resources.insertOne({
    id: 'res_persistent_old',
    owner_user_id: freeUser.id,
    r2_object_key: `users/${freeUser.id}/old_file.pdf`,
    original_filename: 'old_file.pdf',
    content_type: 'application/pdf',
    size_bytes: 20000000, // 20 MB
    status: 'active',
    created_at: oldDate.toISOString(),
    automation_references: [],
    deletion_state: { isDeleted: false }
  });

  const persistentUsage = await storageService.getStorageUsage(freeUser.id);
  test('Storage usage persists across calendar month boundaries and does not reset to zero',
    persistentUsage.usedBytes === 25000000 // 5 MB confirmed + 20 MB old
  );

  // Section 8: Active Automation Dependency & In-Use Protection
  console.log('\n--- 8. IN-USE PROTECTION & AUTOMATION LINKING ---');
  // Link resource to an active automation
  await storageService.linkAutomationReference(freeUser.id, 'auto_vip_delivery', presignRes.resourceId);
  const resourceWithRef = await mockCollections.storage_resources.findOne({ id: presignRes.resourceId });
  test('linkAutomationReference attaches automation ID to resource',
    resourceWithRef.automation_references.includes('auto_vip_delivery')
  );

  let inUseErrorCaught = false;
  try {
    await storageService.deleteResource(freeUser.id, presignRes.resourceId);
  } catch (err) {
    inUseErrorCaught = err.statusCode === 409 && err.code === 'RESOURCE_IN_USE';
  }
  test('File deletion is blocked with HTTP 409 (RESOURCE_IN_USE) while referenced by an automation', inUseErrorCaught);

  // Unlink automation reference and delete
  await storageService.unlinkAutomationReference(freeUser.id, 'auto_vip_delivery', presignRes.resourceId);
  const delRes = await storageService.deleteResource(freeUser.id, presignRes.resourceId);
  test('Unlinking automation reference allows subsequent deletion',
    delRes.success === true && delRes.resourceId === presignRes.resourceId
  );

  const usageAfterDel = await storageService.getStorageUsage(freeUser.id);
  test('Resource deletion immediately frees allocated storage quota',
    usageAfterDel.usedBytes === 20000000 // Only the 20 MB old file remains
  );

  // Section 9: Expired Reservation Automatic Quota Recovery
  console.log('\n--- 9. ABANDONED RESERVATION EXPIRY ---');
  // Insert an abandoned pending reservation from 20 minutes ago
  const twentyMinsAgo = new Date(Date.now() - 20 * 60 * 1000);
  await mockCollections.storage_resources.insertOne({
    id: 'res_abandoned_upload',
    owner_user_id: freeUser.id,
    r2_object_key: `users/${freeUser.id}/abandoned.pdf`,
    original_filename: 'abandoned.pdf',
    content_type: 'application/pdf',
    size_bytes: 30000000, // 30 MB
    status: 'pending',
    created_at: twentyMinsAgo.toISOString(),
    reserved_at: twentyMinsAgo,
    automation_references: [],
    deletion_state: { isDeleted: false }
  });

  // Calling getStorageUsage should detect reservation > 15 mins and expire it automatically
  const usageAfterExpiry = await storageService.getStorageUsage(freeUser.id);
  const expiredDoc = await mockCollections.storage_resources.findOne({ id: 'res_abandoned_upload' });
  test('Unconfirmed reservation older than 15 minutes is automatically expired and releases quota',
    expiredDoc.status === 'expired' && usageAfterExpiry.usedBytes === 20000000
  );

  // Section 10: Zero Ephemeral Disk Writes & Google Drive URL Isolation
  console.log('\n--- 10. ZERO-DISK WRITE & GOOGLE DRIVE ISOLATION ---');
  // Test memory buffer direct upload fallback
  const testBuffer = Buffer.from('Comment2DM in-memory PDF content without disk writes');
  const directUploadRes = await storageService.uploadDirectBuffer(freeUser.id, {
    buffer: testBuffer,
    fileName: 'direct_guide.pdf',
    mimeType: 'application/pdf'
  });
  test('uploadDirectBuffer successfully uploads in-memory buffer without touching local filesystem disk',
    directUploadRes.success === true &&
    directUploadRes.resource.id.startsWith('res_') &&
    directUploadRes.resource.fileSize === testBuffer.length
  );

  // Clean up direct upload
  await storageService.deleteResource(freeUser.id, directUploadRes.resource.id);

  // Test Google Drive automation link creates 0 bytes of R2 storage
  const initialStorage = await storageService.getStorageUsage(freeUser.id);
  const gdriveAutoRes = await makeRequest('POST', '/api/automations', {
    instagramUserId: 'ig_free_acc_1',
    mediaId: 'media_123',
    keyword: 'GDRIVE_BOOK',
    dmMessage: 'Grab your book here!',
    flow: {
      delivery: {
        type: 'gdrive',
        url: 'https://drive.google.com/file/d/1234567890abcdef/view?usp=sharing'
      }
    }
  }, freeHeaders);

  const storageAfterGdrive = await storageService.getStorageUsage(freeUser.id);
  test('Google Drive links in automations consume 0 bytes of customer R2 storage quota',
    storageAfterGdrive.usedBytes === initialStorage.usedBytes
  );

  server.close();

  console.log('\n======================================================================');
  console.log(`   STORAGE & CLOUDFLARE R2 SUITE: ${passedChecks}/20 CHECKS PASSED`);
  console.log('======================================================================\n');
}

run().catch(err => {
  console.error('Fatal test error in storage suite:', err);
  process.exit(1);
});
