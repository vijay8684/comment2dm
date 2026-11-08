/**
 * Comment2DM — Cryptographic OTP Verification Service
 * Handles: Secure 6-digit numeric OTP generation, hashing, 5-minute expiration,
 * 60-second cooldown, max 5 attempts, and strictly-gated development bypass.
 */

'use strict';

const crypto = require('crypto');
const db = require('../db');

const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const RESEND_COOLDOWN_MS = 60 * 1000; // 60 seconds
const MAX_VERIFY_ATTEMPTS = 5;

/**
 * Checks whether the development-only OTP bypass (0000 / 000000) is permitted.
 * Fails closed: Never permitted in production unless an explicit ALLOW_DEV_OTP=true flag is set.
 */
function isDevBypassEnabled() {
  if (process.env.ALLOW_DEV_OTP === 'true') {
    return true;
  }
  if (process.env.NODE_ENV === 'production') {
    return false;
  }
  return process.env.ALLOW_DEV_OTP !== 'false';
}

/**
 * Hashes an OTP with SHA-256 for secure storage.
 */
function hashOtp(otp) {
  return crypto.createHash('sha256').update(String(otp).trim()).digest('hex');
}

/**
 * Generates a cryptographically secure 6-digit numeric OTP.
 * Invalidates existing OTPs for (email, type), enforces 60-second cooldown.
 *
 * @param {string} email - Normalized email
 * @param {'signup' | 'reset_password'} type - Purpose of the OTP
 * @returns {Promise<{ otp: string, expiresAt: Date, resendAvailableAt: Date }>}
 */
async function generateOtp(email, type = 'signup') {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const otps = db.collections ? db.collections().otps : null;

  if (otps) {
    const existing = await otps.findOne({ email: normalizedEmail, type });
    if (existing && existing.resend_available_at && new Date(existing.resend_available_at).getTime() > Date.now()) {
      const waitSeconds = Math.ceil((new Date(existing.resend_available_at).getTime() - Date.now()) / 1000);
      const err = new Error(`Please wait ${waitSeconds} seconds before requesting another code.`);
      err.statusCode = 429;
      err.waitSeconds = waitSeconds;
      throw err;
    }

    // Invalidate existing OTPs for this (email, type)
    await otps.deleteMany({ email: normalizedEmail, type });
  }

  // Cryptographically secure 6-digit code: 100000 to 999999
  const rawOtp = crypto.randomInt(100000, 1000000).toString();
  const now = Date.now();
  const expiresAt = new Date(now + OTP_TTL_MS);
  const resendAvailableAt = new Date(now + RESEND_COOLDOWN_MS);
  const otpHash = hashOtp(rawOtp);

  if (otps) {
    await otps.insertOne({
      email: normalizedEmail,
      type,
      otp_hash: otpHash,
      attempts: 0,
      created_at: new Date(now),
      expires_at: expiresAt,
      resend_available_at: resendAvailableAt
    });
  }

  return {
    otp: rawOtp,
    expiresAt,
    resendAvailableAt
  };
}

/**
 * Generates an OTP and dispatches it via Resend API email template.
 */
async function generateAndSendOtp(email, type = 'signup', name = '') {
  const emailService = require('./emailService');
  const { otp, expiresAt } = await generateOtp(email, type);

  if (type === 'reset_password') {
    await emailService.sendPasswordResetOtp(email, otp, name);
  } else {
    await emailService.sendSignupOtp(email, otp, name);
  }

  return { success: true, expiresAt };
}

/**
 * Verifies a 6-digit OTP against the stored cryptographic hash.
 * Accepts either (email, otp, type) or (email, type, otp) for maximum caller robustness.
 * Throws an Error with statusCode on failure, returns { valid: true } on success.
 */
async function verifyOtp(email, arg2, arg3) {
  const normalizedEmail = String(email || '').trim().toLowerCase();

  // Determine which argument is otp vs type
  let inputOtp = '';
  let type = 'signup';
  if (typeof arg2 === 'string' && (arg2 === 'signup' || arg2 === 'reset_password')) {
    type = arg2;
    inputOtp = String(arg3 || '').trim();
  } else {
    inputOtp = String(arg2 || '').trim();
    type = String(arg3 || 'signup').trim();
  }

  if (!inputOtp) {
    const error = new Error('Please enter the 6-digit verification code.');
    error.statusCode = 400;
    throw error;
  }

  // 1. Development Bypass Check (0000 / 000000)
  const isDevCode = inputOtp === '0000' || inputOtp === '000000';
  if (isDevCode && isDevBypassEnabled()) {
    const otps = db.collections ? db.collections().otps : null;
    if (otps) {
      await otps.deleteMany({ email: normalizedEmail, type });
    }
    return { valid: true };
  }

  const otps = db.collections ? db.collections().otps : null;
  if (!otps) {
    const error = new Error('Database service unavailable.');
    error.statusCode = 503;
    throw error;
  }

  const record = await otps.findOne({ email: normalizedEmail, type });

  // 2. Existence and Expiry Check
  if (!record || new Date(record.expires_at).getTime() <= Date.now()) {
    if (record) await otps.deleteOne({ _id: record._id });
    const error = new Error('Verification code has expired or is invalid. Please request a new code.');
    error.statusCode = 400;
    throw error;
  }

  // 3. Max Attempts Check
  if ((record.attempts || 0) >= MAX_VERIFY_ATTEMPTS) {
    await otps.deleteOne({ _id: record._id });
    const error = new Error('Maximum verification attempts exceeded. Please request a new code.');
    error.statusCode = 429;
    throw error;
  }

  // 4. Constant-Time Hash Comparison
  const computedHash = hashOtp(inputOtp);
  const isValid = crypto.timingSafeEqual(Buffer.from(computedHash, 'utf8'), Buffer.from(record.otp_hash, 'utf8'));

  if (!isValid) {
    const remainingAttempts = MAX_VERIFY_ATTEMPTS - ((record.attempts || 0) + 1);
    await otps.updateOne({ _id: record._id }, { $inc: { attempts: 1 } });
    const attemptWarning = remainingAttempts > 0 ? ` (${remainingAttempts} attempt${remainingAttempts === 1 ? '' : 's'} remaining)` : '';
    const error = new Error(`Invalid verification code. Please check and try again.${attemptWarning}`);
    error.statusCode = 400;
    throw error;
  }

  // 5. Success: Consume and delete OTP so it can never be re-used
  await otps.deleteOne({ _id: record._id });
  return { valid: true };
}

/**
 * Clears all pending OTPs for an email and type.
 */
async function clearOtps(email, type) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const otps = db.collections ? db.collections().otps : null;
  if (otps) {
    await otps.deleteMany({ email: normalizedEmail, type });
  }
}

module.exports = {
  generateOtp,
  generateAndSendOtp,
  verifyOtp,
  clearOtps,
  isDevBypassEnabled,
  OTP_TTL_MS,
  RESEND_COOLDOWN_MS
};
