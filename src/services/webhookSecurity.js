// src/services/webhookSecurity.js
// Meta Instagram Webhook Signature & Verification Token Security
const crypto = require('crypto');

/**
 * Verify Meta POST webhook signature (X-Hub-Signature-256)
 * Uses constant-time comparison against HMAC-SHA256 of exact raw request body.
 *
 * @param {Buffer|string} rawBody - Raw unparsed HTTP request body Buffer
 * @param {string} signatureHeader - Value of X-Hub-Signature-256 header (sha256=<hash>)
 * @param {string} appSecret - META_APP_SECRET
 * @returns {{ valid: boolean, statusCode?: number, error?: string }}
 */
function verifyWebhookSignature(rawBody, signatureHeader, appSecret) {
  if (!appSecret) {
    return {
      valid: false,
      statusCode: 401,
      error: 'Webhook verification rejected: META_APP_SECRET not configured on server.'
    };
  }

  if (!signatureHeader || typeof signatureHeader !== 'string') {
    return {
      valid: false,
      statusCode: 401,
      error: 'Missing or invalid X-Hub-Signature-256 header.'
    };
  }

  const parts = signatureHeader.split('=');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'sha256') {
    return {
      valid: false,
      statusCode: 401,
      error: 'Malformed X-Hub-Signature-256 header format. Expected sha256=<hash>.'
    };
  }

  const providedHash = parts[1].trim();

  if (!rawBody || (typeof rawBody !== 'string' && !Buffer.isBuffer(rawBody))) {
    return {
      valid: false,
      statusCode: 401,
      error: 'Missing raw request body for signature verification.'
    };
  }

  const rawBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');

  try {
    const expectedHash = crypto
      .createHmac('sha256', appSecret)
      .update(rawBuffer)
      .digest('hex');

    const expectedBuf = Buffer.from(expectedHash, 'hex');
    const providedBuf = Buffer.from(providedHash, 'hex');

    if (expectedBuf.length !== providedBuf.length) {
      return {
        valid: false,
        statusCode: 403,
        error: 'Invalid webhook signature.'
      };
    }

    const isMatch = crypto.timingSafeEqual(expectedBuf, providedBuf);
    if (!isMatch) {
      return {
        valid: false,
        statusCode: 403,
        error: 'Invalid webhook signature.'
      };
    }

    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      statusCode: 403,
      error: 'Signature verification failed.'
    };
  }
}

/**
 * Verify Meta GET webhook verification challenge
 * Compares hub.verify_token against META_WEBHOOK_VERIFY_TOKEN using constant-time comparison.
 *
 * @param {string} mode - hub.mode query parameter
 * @param {string} token - hub.verify_token query parameter
 * @param {string} expectedToken - META_WEBHOOK_VERIFY_TOKEN
 * @returns {{ valid: boolean, statusCode?: number, error?: string }}
 */
function verifyGetChallenge(mode, token, expectedToken) {
  if (!expectedToken) {
    return {
      valid: false,
      statusCode: 403,
      error: 'META_WEBHOOK_VERIFY_TOKEN not configured on server.'
    };
  }

  if (mode !== 'subscribe') {
    return {
      valid: false,
      statusCode: 403,
      error: 'Invalid hub.mode.'
    };
  }

  if (!token || typeof token !== 'string') {
    return {
      valid: false,
      statusCode: 403,
      error: 'Missing hub.verify_token.'
    };
  }

  const bExpected = Buffer.from(expectedToken, 'utf8');
  const bToken = Buffer.from(token, 'utf8');

  if (bExpected.length !== bToken.length || !crypto.timingSafeEqual(bExpected, bToken)) {
    return {
      valid: false,
      statusCode: 403,
      error: 'Verification failed. Token mismatch.'
    };
  }

  return { valid: true };
}

module.exports = {
  verifyWebhookSignature,
  verifyGetChallenge
};
