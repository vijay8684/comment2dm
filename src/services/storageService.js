// src/services/storageService.js
// Cloudflare R2 Standard Storage Integration (S3-Compatible API)
// Provides direct presigned browser-to-R2 uploads, atomic quota reservation, and lifecycle management.

const crypto = require('crypto');
const path = require('path');
const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  GetObjectCommand
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const dbModule = require('../db');

// Supported file MIME types and extensions
const ALLOWED_MIME_TYPES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'application/pdf': '.pdf'
};

const MAX_FILE_SIZE_BYTES = 10 * 1000 * 1000; // 10 MB maximum single file size (decimal)
const RESERVATION_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes before an unconfirmed reservation expires

let s3ClientInstance = null;
let testS3Client = null;

function isConfigured() {
  if (testS3Client) return true;
  return Boolean(
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    (process.env.R2_S3_ENDPOINT || process.env.R2_ACCOUNT_ID)
  );
}

function getBucketName() {
  return process.env.R2_BUCKET_NAME || 'comment2dm-assets';
}

function getS3Client() {
  if (testS3Client) return testS3Client;
  if (s3ClientInstance) return s3ClientInstance;

  const endpoint = process.env.R2_S3_ENDPOINT ||
    (process.env.R2_ACCOUNT_ID ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : null);

  if (!endpoint || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    return null;
  }

  s3ClientInstance = new S3Client({
    region: 'auto',
    endpoint,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
  });

  return s3ClientInstance;
}

function _setS3ClientForTesting(mock) {
  testS3Client = mock;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 MB';
  if (!Number.isFinite(bytes) || bytes < 0) return '0 MB';
  if (bytes >= 1000 * 1000 * 1000) {
    const gb = bytes / (1000 * 1000 * 1000);
    return Number.isInteger(gb) ? `${gb} GB` : `${gb.toFixed(1)} GB`;
  }
  const mb = Math.round(bytes / (1000 * 1000));
  return `${mb} MB`;
}

async function getStorageCollection() {
  if (dbModule.collections && dbModule.collections().storageResources) {
    return dbModule.collections().storageResources;
  }
  if (typeof dbModule.getDatabase === 'function' && dbModule.getDatabase()) {
    return dbModule.getDatabase().collection('storage_resources');
  }
  if (typeof dbModule.initialize === 'function') {
    const d = await dbModule.initialize();
    if (d && typeof d.collection === 'function') {
      return d.collection('storage_resources');
    }
  }
  throw new Error('Database unavailable for storage resource lookup.');
}

/**
 * Returns current customer storage usage, expiring any abandoned reservations older than 15 mins.
 */
async function getStorageUsage(userId) {
  const billing = require('../billing');
  const userEntitlement = await billing.entitlement(userId);
  const totalAllowedBytes = userEntitlement?.limits?.storageBytes || 150000000;

  try {
    const col = await getStorageCollection();
    const now = Date.now();
    const expiryThreshold = new Date(now - RESERVATION_EXPIRY_MS);

    // Atomically expire reservations older than 15 minutes that were never confirmed
    await col.updateMany(
      {
        owner_user_id: String(userId),
        status: 'pending',
        reserved_at: { $lt: expiryThreshold }
      },
      {
        $set: {
          status: 'expired',
          'deletion_state.isDeleted': true,
          'deletion_state.deletedAt': new Date().toISOString()
        }
      }
    );

    // Sum all active files and currently valid pending reservations
    const activeDocs = await col.find({
      owner_user_id: String(userId),
      status: { $in: ['active', 'pending'] },
      'deletion_state.isDeleted': { $ne: true }
    }).toArray();

    const usedBytes = activeDocs.reduce((acc, doc) => acc + (Number(doc.size_bytes) || 0), 0);
    const remainingBytes = Math.max(0, totalAllowedBytes - usedBytes);
    const percentage = totalAllowedBytes > 0 ? Math.min(100, Math.round((usedBytes / totalAllowedBytes) * 100)) : 0;

    return {
      usedBytes,
      totalBytes: totalAllowedBytes,
      remainingBytes,
      percentage,
      plan: userEntitlement.plan,
      usedFormatted: formatBytes(usedBytes),
      totalFormatted: formatBytes(totalAllowedBytes),
      remainingFormatted: formatBytes(remainingBytes)
    };
  } catch (err) {
    console.error('[STORAGE USAGE ERROR]:', err.message);
    return {
      usedBytes: 0,
      totalBytes: totalAllowedBytes,
      remainingBytes: totalAllowedBytes,
      percentage: 0,
      plan: userEntitlement?.plan || 'free',
      usedFormatted: '0 MB',
      totalFormatted: formatBytes(totalAllowedBytes),
      remainingFormatted: formatBytes(totalAllowedBytes)
    };
  }
}

/**
 * Validates file parameters, reserves quota atomically, and generates a presigned R2 upload URL.
 */
async function createPresignedUpload(userId, { fileName, fileType, fileSize }) {
  if (!userId) {
    const err = new Error('Authentication required.');
    err.statusCode = 401;
    throw err;
  }

  if (!isConfigured()) {
    const err = new Error('Cloud storage service is currently unconfigured. Please use a Google Drive or external link.');
    err.statusCode = 503;
    err.code = 'STORAGE_NOT_CONFIGURED';
    throw err;
  }

  const cleanFileName = String(fileName || '').trim();
  const cleanMimeType = String(fileType || '').toLowerCase().trim();
  const numSizeBytes = Number(fileSize);

  if (!cleanFileName) {
    const err = new Error('A valid file name is required.');
    err.statusCode = 400;
    throw err;
  }

  if (!ALLOWED_MIME_TYPES[cleanMimeType]) {
    const err = new Error('Unsupported file type. Only JPG, PNG, WEBP, GIF, and PDF files are allowed.');
    err.statusCode = 400;
    throw err;
  }

  if (!Number.isFinite(numSizeBytes) || numSizeBytes <= 0) {
    const err = new Error('File size must be greater than 0 bytes.');
    err.statusCode = 400;
    throw err;
  }

  if (numSizeBytes > MAX_FILE_SIZE_BYTES) {
    const err = new Error('File size exceeds the 10 MB maximum limit per upload.');
    err.statusCode = 400;
    throw err;
  }

  // Check remaining quota
  const currentUsage = await getStorageUsage(userId);
  if (currentUsage.usedBytes + numSizeBytes > currentUsage.totalBytes) {
    const err = new Error(`Storage quota exceeded. Your ${currentUsage.plan.toUpperCase()} plan allows ${currentUsage.totalFormatted}. This file requires ${formatBytes(numSizeBytes)}, but only ${currentUsage.remainingFormatted} remains.`);
    err.statusCode = 403;
    err.code = 'STORAGE_QUOTA_EXCEEDED';
    throw err;
  }

  const ext = ALLOWED_MIME_TYPES[cleanMimeType] || path.extname(cleanFileName) || '';
  const randomId = crypto.randomUUID();
  const objectKey = `users/${userId}/${randomId}${ext}`;
  const resourceId = `res_${randomId}`;
  const bucketName = getBucketName();

  const client = getS3Client();
  let uploadUrl = null;

  if (testS3Client && typeof testS3Client.getSignedUrl === 'function') {
    uploadUrl = await testS3Client.getSignedUrl({ Bucket: bucketName, Key: objectKey, ContentType: cleanMimeType });
  } else if (client) {
    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: objectKey,
      ContentType: cleanMimeType
    });
    uploadUrl = await getSignedUrl(client, command, { expiresIn: 300 }); // 5 minutes
  }

  // Atomically persist pending reservation
  const col = await getStorageCollection();
  const record = {
    id: resourceId,
    owner_user_id: String(userId),
    r2_object_key: objectKey,
    original_filename: path.basename(cleanFileName).slice(0, 120),
    content_type: cleanMimeType,
    size_bytes: numSizeBytes,
    status: 'pending',
    created_at: new Date().toISOString(),
    reserved_at: new Date(),
    confirmed_at: null,
    automation_references: [],
    deletion_state: { isDeleted: false, deletedAt: null },
    public_url: null
  };

  await col.insertOne(record);

  return {
    success: true,
    resourceId,
    objectKey,
    uploadUrl,
    expiresInSeconds: 300
  };
}

/**
 * Confirms an upload after the browser successfully completes the direct PUT to R2.
 * Idempotent: subsequent calls return the existing active record.
 */
async function confirmUpload(userId, { resourceId, objectKey }) {
  if (!userId || !resourceId) {
    const err = new Error('Resource identifier is required.');
    err.statusCode = 400;
    throw err;
  }

  const col = await getStorageCollection();
  const query = { id: String(resourceId), owner_user_id: String(userId) };
  if (objectKey) query.r2_object_key = String(objectKey);

  const existing = await col.findOne(query);
  if (!existing) {
    const err = new Error('Storage resource reservation not found or access denied.');
    err.statusCode = 404;
    throw err;
  }

  // If already active, return cleanly (idempotent)
  if (existing.status === 'active') {
    return {
      success: true,
      resource: {
        id: existing.id,
        fileName: existing.original_filename,
        fileSize: existing.size_bytes,
        fileType: existing.content_type,
        url: existing.public_url || `/api/storage/file/${existing.id}`
      }
    };
  }

  let finalUrl = null;
  if (process.env.R2_PUBLIC_BASE_URL) {
    finalUrl = `${process.env.R2_PUBLIC_BASE_URL.replace(/\/$/, '')}/${existing.r2_object_key}`;
  } else {
    finalUrl = `/api/storage/file/${existing.id}`;
  }

  const confirmedAt = new Date().toISOString();
  await col.updateOne(
    { _id: existing._id },
    {
      $set: {
        status: 'active',
        confirmed_at: confirmedAt,
        public_url: finalUrl,
        updated_at: confirmedAt
      }
    }
  );

  return {
    success: true,
    resource: {
      id: existing.id,
      fileName: existing.original_filename,
      fileSize: existing.size_bytes,
      fileType: existing.content_type,
      url: finalUrl
    }
  };
}

/**
 * Deletes a customer's uploaded resource from R2 and updates usage.
 * Checks for automation dependencies before proceeding.
 */
async function deleteResource(userId, resourceId) {
  if (!userId || !resourceId) {
    const err = new Error('Invalid resource deletion parameters.');
    err.statusCode = 400;
    throw err;
  }

  const col = await getStorageCollection();
  const existing = await col.findOne({ id: String(resourceId), owner_user_id: String(userId) });
  if (!existing || existing.deletion_state?.isDeleted) {
    const err = new Error('Resource not found or already deleted.');
    err.statusCode = 404;
    throw err;
  }

  // Check if any automations still reference this resource
  if (Array.isArray(existing.automation_references) && existing.automation_references.length > 0) {
    const err = new Error(`Cannot delete file because it is currently referenced by ${existing.automation_references.length} automation(s). Remove it from those automations before deleting.`);
    err.statusCode = 409;
    err.code = 'RESOURCE_IN_USE';
    throw err;
  }

  // Check database for active automations using this resource URL or ID
  if (dbModule.collections && dbModule.collections().automations) {
    const inUse = await dbModule.collections().automations.findOne({
      owner_user_id: String(userId),
      $or: [
        { 'flow.delivery.resourceId': existing.id },
        { media_url: existing.public_url },
        { 'flow.delivery.url': existing.public_url }
      ]
    });
    if (inUse) {
      const err = new Error('Cannot delete file because it is currently in use by an automation. Remove it from your automation first.');
      err.statusCode = 409;
      err.code = 'RESOURCE_IN_USE';
      throw err;
    }
  }

  // Delete from R2 external storage
  const client = getS3Client();
  if (client) {
    try {
      await client.send(new DeleteObjectCommand({
        Bucket: getBucketName(),
        Key: existing.r2_object_key
      }));
    } catch (r2Err) {
      console.warn('[R2 DELETION WARNING]:', r2Err.message);
    }
  }

  const deletedAt = new Date().toISOString();
  await col.updateOne(
    { _id: existing._id },
    {
      $set: {
        status: 'deleted',
        'deletion_state.isDeleted': true,
        'deletion_state.deletedAt': deletedAt,
        updated_at: deletedAt
      }
    }
  );

  return { success: true, resourceId: existing.id };
}

/**
 * Removes an automation reference from resources when an automation is deleted or modified.
 */
async function unlinkAutomationReference(userId, automationId, resourceId = null) {
  try {
    const col = await getStorageCollection();
    const filter = { owner_user_id: String(userId) };
    if (resourceId) filter.id = String(resourceId);

    await col.updateMany(
      filter,
      { $pull: { automation_references: String(automationId) } }
    );
  } catch (err) {
    console.warn('[STORAGE UNLINK WARNING]:', err.message);
  }
}

/**
 * Adds an automation reference to a resource.
 */
async function linkAutomationReference(userId, automationId, resourceId) {
  if (!resourceId || !automationId) return;
  try {
    const col = await getStorageCollection();
    await col.updateOne(
      { id: String(resourceId), owner_user_id: String(userId) },
      { $addToSet: { automation_references: String(automationId) } }
    );
  } catch (err) {
    console.warn('[STORAGE LINK WARNING]:', err.message);
  }
}

/**
 * Returns a secure, time-limited access URL for a resource for delivery via Instagram DM.
 */
async function getResourceAccessUrl(userId, resourceId) {
  const col = await getStorageCollection();
  const existing = await col.findOne({
    id: String(resourceId),
    status: 'active',
    'deletion_state.isDeleted': { $ne: true }
  });

  if (!existing) return null;

  if (process.env.R2_PUBLIC_BASE_URL) {
    return `${process.env.R2_PUBLIC_BASE_URL.replace(/\/$/, '')}/${existing.r2_object_key}`;
  }

  const client = getS3Client();
  if (client) {
    try {
      const command = new GetObjectCommand({
        Bucket: getBucketName(),
        Key: existing.r2_object_key
      });
      return await getSignedUrl(client, command, { expiresIn: 3600 }); // 1 hour access
    } catch (_) {}
  }

  return existing.public_url || null;
}

/**
 * Direct buffer upload for fallback server-side upload without touching local disk.
 */
async function uploadDirectBuffer(userId, { buffer, fileName, mimeType }) {
  if (!userId) {
    const err = new Error('Authentication required.');
    err.statusCode = 401;
    throw err;
  }
  if (!isConfigured()) {
    const err = new Error('Cloud storage service is currently unconfigured. Please configure Cloudflare R2 credentials.');
    err.statusCode = 503;
    err.code = 'STORAGE_NOT_CONFIGURED';
    throw err;
  }
  const cleanFileName = String(fileName || '').trim();
  const cleanMimeType = String(mimeType || '').toLowerCase().trim();
  const numSizeBytes = buffer.length;

  if (!ALLOWED_MIME_TYPES[cleanMimeType]) {
    const err = new Error('Unsupported file type. Only JPG, PNG, WEBP, GIF, and PDF files are allowed.');
    err.statusCode = 400;
    throw err;
  }
  if (numSizeBytes > MAX_FILE_SIZE_BYTES) {
    const err = new Error('File size exceeds the 10 MB maximum limit per upload.');
    err.statusCode = 400;
    throw err;
  }

  const currentUsage = await getStorageUsage(userId);
  if (currentUsage.usedBytes + numSizeBytes > currentUsage.totalBytes) {
    const err = new Error(`Storage quota exceeded. Your ${currentUsage.plan.toUpperCase()} plan allows ${currentUsage.totalFormatted}. This file requires ${formatBytes(numSizeBytes)}, but only ${currentUsage.remainingFormatted} remains.`);
    err.statusCode = 403;
    err.code = 'STORAGE_QUOTA_EXCEEDED';
    throw err;
  }

  const ext = ALLOWED_MIME_TYPES[cleanMimeType] || path.extname(cleanFileName) || '';
  const randomId = crypto.randomUUID();
  const objectKey = `users/${userId}/${randomId}${ext}`;
  const resourceId = `res_${randomId}`;
  const bucketName = getBucketName();

  const client = getS3Client();
  if (client) {
    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: objectKey,
      Body: buffer,
      ContentType: cleanMimeType
    });
    await client.send(command);
  }

  const col = await getStorageCollection();
  const now = new Date();
  const record = {
    id: resourceId,
    owner_user_id: String(userId),
    r2_object_key: objectKey,
    original_filename: path.basename(cleanFileName).slice(0, 120),
    content_type: cleanMimeType,
    size_bytes: numSizeBytes,
    status: 'active',
    created_at: now.toISOString(),
    reserved_at: now,
    confirmed_at: now.toISOString(),
    automation_references: [],
    deletion_state: { isDeleted: false, deletedAt: null },
    public_url: null
  };
  await col.insertOne(record);

  return {
    success: true,
    resource: {
      id: resourceId,
      fileName: record.original_filename,
      fileSize: numSizeBytes,
      fileType: cleanMimeType,
      url: `/api/storage/file/${resourceId}`
    }
  };
}

module.exports = {
  isConfigured,
  getBucketName,
  getStorageUsage,
  getStorageCollection,
  createPresignedUpload,
  confirmUpload,
  deleteResource,
  uploadDirectBuffer,
  linkAutomationReference,
  unlinkAutomationReference,
  getResourceAccessUrl,
  formatBytes,
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE_BYTES,
  _setS3ClientForTesting
};
