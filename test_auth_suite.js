// Unit & Integration Test Suite for Comment2DM Authentication System
// Runs cleanly in local test environment using in-memory collection mock

const assert = require('assert');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// Setup environment
process.env.JWT_SECRET = 'comment2dm_super_secure_jwt_secret_key_minimum_32_chars!';
process.env.ALLOW_DEV_OTP = 'true';
process.env.NODE_ENV = 'development';

// In-Memory Database Mock for Collections
function createMockCollection() {
  const docs = [];
  return {
    async findOne(query) {
      return docs.find(doc => {
        return Object.keys(query).every(key => {
          if (key === 'email') return String(doc.email).toLowerCase() === String(query.email).toLowerCase();
          if (key === 'id') return doc.id === query.id;
          if (key === 'token_hash') return doc.token_hash === query.token_hash;
          if (key === 'user_id') return doc.user_id === query.user_id;
          return doc[key] === query[key];
        });
      }) || null;
    },
    async insertOne(doc) {
      docs.push({ ...doc, _id: crypto.randomUUID() });
      return { acknowledged: true, insertedId: docs[docs.length - 1]._id };
    },
    async updateOne(filter, updateDoc) {
      const idx = docs.findIndex(d => {
        if (filter.email) return String(d.email).toLowerCase() === String(filter.email).toLowerCase();
        if (filter.id) return d.id === filter.id;
        return true;
      });
      if (idx !== -1) {
        if (updateDoc.$set) Object.assign(docs[idx], updateDoc.$set);
        return { modifiedCount: 1 };
      } else if (updateDoc.$setOnInsert) {
        docs.push({ ...updateDoc.$setOnInsert, _id: crypto.randomUUID() });
        return { upsertedCount: 1 };
      }
      return { modifiedCount: 0 };
    },
    async deleteOne(query) {
      const idx = docs.findIndex(d => {
        if (query.token_hash) return d.token_hash === query.token_hash;
        return false;
      });
      if (idx !== -1) {
        docs.splice(idx, 1);
        return { deletedCount: 1 };
      }
      return { deletedCount: 0 };
    },
    async deleteMany(query) {
      let count = 0;
      for (let i = docs.length - 1; i >= 0; i--) {
        const doc = docs[i];
        let match = true;
        if (query.email && String(doc.email).toLowerCase() !== String(query.email).toLowerCase()) match = false;
        if (query.user_id && doc.user_id !== query.user_id) match = false;
        if (match) {
          docs.splice(i, 1);
          count++;
        }
      }
      return { deletedCount: count };
    },
    async countDocuments() {
      return docs.length;
    },
    find() {
      return {
        sort() {
          return {
            async toArray() { return [...docs]; }
          };
        }
      };
    }
  };
}

const mockUsers = createMockCollection();
const mockOtps = createMockCollection();
const mockSessions = createMockCollection();
const mockRateLimits = createMockCollection();

// Monkey-patch db module for local test run
const db = require('./src/db');
db.collections = function () {
  return {
    users: mockUsers,
    otps: mockOtps,
    sessions: mockSessions,
    rateLimits: mockRateLimits
  };
};
db.getUserByEmail = async (email) => mockUsers.findOne({ email });
db.getUserById = async (id) => mockUsers.findOne({ id });
db.markUserVerified = async (email) => mockUsers.updateOne({ email }, { $set: { email_verified: true } });
db.updateUserPasswordByEmail = async (email, hash) => mockUsers.updateOne({ email }, { $set: { password_hash: hash } });
db.deleteSession = async (tokenHash) => mockSessions.deleteOne({ token_hash: tokenHash });

const authService = require('./src/auth/authService');
const otpService = require('./src/services/otpService');

async function runTestSuite() {
  console.log('======================================================');
  console.log('COMMENT2DM AUTHENTICATION TEST SUITE (18 CASES)');
  console.log('======================================================\n');

  const testEmail = 'creator_test@comment2dm.com';
  const testPassword = 'SecurePassword2026!';
  const testName = 'Alex Creator';

  // 1. Invalid Email Syntax
  console.log('Test 1: Reject invalid email format');
  try {
    await authService.register({ name: testName, email: 'invalid_email_format', password: testPassword });
    assert.fail('Should fail on invalid email');
  } catch (err) {
    assert.strictEqual(err.statusCode, 400);
    console.log('  ✓ PASSED');
  }

  // 2. Weak Password (< 6 chars)
  console.log('Test 2: Reject weak password');
  try {
    await authService.register({ name: testName, email: testEmail, password: '123' });
    assert.fail('Should fail on short password');
  } catch (err) {
    assert.strictEqual(err.statusCode, 400);
    console.log('  ✓ PASSED');
  }

  // 3. Normal Signup (Creates unverified account and dispatches OTP)
  console.log('Test 3: Normal signup registers unverified account & triggers OTP');
  const signupResult = await authService.register({ name: testName, email: testEmail, password: testPassword });
  assert.strictEqual(signupResult.requireVerification, true);
  assert.strictEqual(signupResult.email, testEmail);
  const createdRecord = await db.getUserByEmail(testEmail);
  assert(createdRecord);
  assert.strictEqual(createdRecord.email_verified, false);
  console.log('  ✓ PASSED');

  // 4. Duplicate Unverified Signup (Updates credentials without 409)
  console.log('Test 4: Re-submitting signup while unverified refreshes credentials & sends fresh OTP');
  await mockOtps.deleteMany({ email: testEmail });
  const reSignup = await authService.register({ name: 'Alex Updated', email: testEmail, password: 'NewPassword999!' });
  assert.strictEqual(reSignup.requireVerification, true);
  console.log('  ✓ PASSED');

  // 5. Unverified Account Login Attempt (Blocks login & triggers OTP)
  console.log('Test 5: Login attempt on unverified account returns 403 requireVerification');
  try {
    await authService.authenticate(testEmail, 'NewPassword999!');
    assert.fail('Should have thrown 403');
  } catch (err) {
    assert.strictEqual(err.statusCode, 403);
    assert.strictEqual(err.requireVerification, true);
    assert.strictEqual(err.email, testEmail);
    console.log('  ✓ PASSED');
  }

  // 6. Wrong OTP Rejection
  console.log('Test 6: Invalid OTP code rejection');
  try {
    await authService.verifySignupOtp({ email: testEmail, otp: '888888' });
    assert.fail('Should fail on bad OTP');
  } catch (err) {
    assert(err.message.includes('Invalid') || err.message.includes('code'));
    console.log('  ✓ PASSED');
  }

  // 7. Development OTP Bypass Verification (agreed 4-digit code: 0000)
  console.log('Test 7: Development OTP verification with 0000');
  const verifyRes = await authService.verifySignupOtp({ email: testEmail, otp: '0000' });
  assert.strictEqual(verifyRes.emailVerified, true);
  const verifiedRecord = await db.getUserByEmail(testEmail);
  assert.strictEqual(verifiedRecord.email_verified, true);
  console.log('  ✓ PASSED');

  // 8. Duplicate Signup for Verified User (Throws 409 Conflict)
  console.log('Test 8: Duplicate signup on already verified user returns 409 Conflict');
  try {
    await authService.register({ name: testName, email: testEmail, password: testPassword });
    assert.fail('Should throw 409 conflict');
  } catch (err) {
    assert.strictEqual(err.statusCode, 409);
    console.log('  ✓ PASSED');
  }

  // 9. Login for Verified Account
  console.log('Test 9: Verified account logs in successfully');
  const loggedInUser = await authService.authenticate(testEmail, 'NewPassword999!');
  assert.strictEqual(loggedInUser.email, testEmail);
  assert.strictEqual(loggedInUser.emailVerified, true);
  console.log('  ✓ PASSED');

  // 10. Wrong Password Returns Generic 401
  console.log('Test 10: Wrong password returns generic 401 without user enumeration');
  try {
    await authService.authenticate(testEmail, 'WrongPassword!');
    assert.fail('Should throw 401');
  } catch (err) {
    assert.strictEqual(err.statusCode, 401);
    assert.strictEqual(err.message, 'Invalid email or password.');
    console.log('  ✓ PASSED');
  }

  // 11. Session Cookie / Token Creation
  console.log('Test 11: Session token creation & lookup');
  const expiry = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
  const sessionToken = await authService.createSession(loggedInUser.id, expiry);
  assert(sessionToken && sessionToken.length > 20);
  const sessionUser = await authService.getSessionUser(sessionToken);
  assert.strictEqual(sessionUser.id, loggedInUser.id);
  console.log('  ✓ PASSED');

  // 12. Forgot Password Anti-Enumeration (Same response for existing and non-existing email)
  console.log('Test 12: Forgot password anti-enumeration response identical');
  const forgotUnknown = await authService.requestPasswordReset('non_existent_random_user@domain.com');
  const forgotKnown = await authService.requestPasswordReset(testEmail);
  assert.strictEqual(forgotUnknown.message, forgotKnown.message);
  console.log('  ✓ PASSED');

  // 13. OTP Resend Cooldown (Enforces 60-second cooldown)
  console.log('Test 13: Enforce 60-second OTP resend cooldown');
  try {
    await authService.resendOtp({ email: testEmail, type: 'reset_password' });
    assert.fail('Should fail due to cooldown');
  } catch (err) {
    assert(err.message.toLowerCase().includes('wait') || err.message.toLowerCase().includes('seconds'));
    console.log('  ✓ PASSED');
  }

  // 14. Reset OTP Verification & Single-Use JWT Token
  console.log('Test 14: Reset OTP verification issues signed single-use reset token');
  const resetVerify = await authService.verifyPasswordResetOtp({ email: testEmail, otp: '0000' });
  assert(resetVerify.resetToken);
  const decoded = jwt.verify(resetVerify.resetToken, process.env.JWT_SECRET);
  assert.strictEqual(decoded.purpose, 'pwd_reset');
  assert.strictEqual(decoded.email, testEmail);
  console.log('  ✓ PASSED');

  // 15. Password Reset Execution & Session Invalidation
  console.log('Test 15: Password reset invalidates existing sessions & updates credentials');
  const updatedPwd = 'NewlyResetPassword123!';
  const resetSuccess = await authService.resetPasswordWithToken({
    resetToken: resetVerify.resetToken,
    newPassword: updatedPwd
  });
  assert(resetSuccess.success);

  // Check that old session was invalidated
  const invalidatedLookup = await authService.getSessionUser(sessionToken);
  assert.strictEqual(invalidatedLookup, null);

  // Check new password works
  const reAuth = await authService.authenticate(testEmail, updatedPwd);
  assert.strictEqual(reAuth.email, testEmail);
  console.log('  ✓ PASSED');

  // 16. Google OAuth User Auto-Registration / Verification
  console.log('Test 16: Google OAuth creates email-verified user');
  const googleUser = await authService.registerOAuthUser({
    name: 'Google User',
    email: 'google_user@gmail.com'
  });
  assert.strictEqual(googleUser.emailVerified, true);
  console.log('  ✓ PASSED');

  // 17. Session Logout & Cleanup
  console.log('Test 17: Session token destruction on logout');
  const session2 = await authService.createSession(googleUser.id, expiry);
  assert(await authService.getSessionUser(session2));
  await authService.deleteSession(session2);
  assert.strictEqual(await authService.getSessionUser(session2), null);
  console.log('  ✓ PASSED');

  // 18. Fail-Closed Production Bypass Policy
  console.log('Test 18: In production mode with ALLOW_DEV_OTP=false, bypass fails closed');
  process.env.NODE_ENV = 'production';
  process.env.ALLOW_DEV_OTP = 'false';
  try {
    await otpService.verifyOtp('random_user@domain.com', '0000', 'signup');
    assert.fail('Dev bypass should not work in production');
  } catch (err) {
    assert(err.message.includes('disabled') || err.message.includes('Invalid') || err.message.includes('code'));
    console.log('  ✓ PASSED');
  }

  console.log('\n======================================================');
  console.log('✅ ALL 18 AUTHENTICATION TEST CASES PASSED SUCCESSFULLY!');
  console.log('======================================================');
}

runTestSuite().catch(err => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
