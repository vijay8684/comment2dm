const bcrypt = require('bcrypt');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../db');
const otpService = require('../services/otpService');
const emailService = require('../services/emailService');

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id || (user._id ? user._id.toString() : null),
    name: user.name,
    email: user.email,
    emailVerified: user.email_verified !== false,
    createdAt: user.created_at || user.createdAt
  };
}

async function register({ name, email, password }) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const trimmedName = String(name || '').trim();

  if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    const error = new Error('Enter a valid email address.');
    error.statusCode = 400;
    throw error;
  }

  if (!trimmedName || trimmedName.length < 2) {
    const error = new Error('Enter a valid full name.');
    error.statusCode = 400;
    throw error;
  }

  if (!password || password.length < 6) {
    const error = new Error('Password must be at least 6 characters.');
    error.statusCode = 400;
    throw error;
  }

  const existing = await db.getUserByEmail(normalizedEmail);
  const passwordHash = await bcrypt.hash(password, 12);
  const { users } = db.collections();

  if (existing) {
    // If user already verified, return 409 conflict
    if (existing.email_verified !== false) {
      const error = new Error('An account with that email already exists.');
      error.statusCode = 409;
      throw error;
    }

    // Unverified user trying to sign up again: update credentials and resend OTP
    await users.updateOne(
      { email: normalizedEmail },
      {
        $set: {
          name: trimmedName,
          password_hash: passwordHash,
          updated_at: new Date().toISOString()
        }
      }
    );
  } else {
    const newUser = {
      id: crypto.randomUUID(),
      name: trimmedName,
      email: normalizedEmail,
      password_hash: passwordHash,
      email_verified: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    await users.insertOne(newUser);
  }

  // Generate and send 6-digit verification OTP
  try {
    await otpService.generateAndSendOtp(normalizedEmail, 'signup', trimmedName);
  } catch (err) {
    console.error('Failed to dispatch signup OTP email:', err.message);
  }

  return {
    requireVerification: true,
    email: normalizedEmail,
    message: 'A 6-digit verification code has been sent to your email.'
  };
}

async function verifySignupOtp({ email, otp }) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail || !otp) {
    const error = new Error('Email and verification code are required.');
    error.statusCode = 400;
    throw error;
  }

  await otpService.verifyOtp(normalizedEmail, otp, 'signup');
  await db.markUserVerified(normalizedEmail);

  const user = await db.getUserByEmail(normalizedEmail);
  if (!user) {
    const error = new Error('User not found.');
    error.statusCode = 404;
    throw error;
  }

  return publicUser(user);
}

async function resendOtp({ email, type }) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const otpType = type === 'reset_password' ? 'reset_password' : 'signup';

  if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    const error = new Error('Valid email address is required.');
    error.statusCode = 400;
    throw error;
  }

  const user = await db.getUserByEmail(normalizedEmail);
  if (!user && otpType === 'reset_password') {
    // Anti-enumeration: return success even if user not found
    return { success: true, message: 'If an account exists, a new verification code has been sent.' };
  }

  const name = user ? user.name : '';
  await otpService.generateAndSendOtp(normalizedEmail, otpType, name);

  return { success: true, message: 'A new 6-digit verification code has been sent.' };
}

async function authenticate(email, password) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail || !password) {
    const error = new Error('Invalid email or password.');
    error.statusCode = 401;
    throw error;
  }

  const user = await db.getUserByEmail(normalizedEmail);

  if (!user || !user.password_hash || !(await bcrypt.compare(password, user.password_hash))) {
    const error = new Error('Invalid email or password.');
    error.statusCode = 401;
    throw error;
  }

  // Check if account email is verified
  if (user.email_verified === false) {
    try {
      await otpService.generateAndSendOtp(normalizedEmail, 'signup', user.name);
    } catch (err) {
      console.warn('Could not auto-resend verification OTP:', err.message);
    }

    const error = new Error('Please verify your email address to continue. A new verification code has been sent.');
    error.statusCode = 403;
    error.requireVerification = true;
    error.email = normalizedEmail;
    throw error;
  }

  return publicUser(user);
}

async function requestPasswordReset(email) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    const error = new Error('Please enter a valid email address.');
    error.statusCode = 400;
    throw error;
  }

  const genericResponse = {
    success: true,
    message: 'If an account exists with this email, a 6-digit verification code has been sent.'
  };

  const user = await db.getUserByEmail(normalizedEmail);
  if (!user) {
    return genericResponse;
  }

  try {
    await otpService.generateAndSendOtp(normalizedEmail, 'reset_password', user.name);
  } catch (err) {
    console.error('Password reset OTP generation error:', err.message);
  }

  return genericResponse;
}

async function verifyPasswordResetOtp({ email, otp }) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail || !otp) {
    const error = new Error('Email and verification code are required.');
    error.statusCode = 400;
    throw error;
  }

  const user = await db.getUserByEmail(normalizedEmail);
  if (!user) {
    const error = new Error('Account not found.');
    error.statusCode = 404;
    throw error;
  }

  await otpService.verifyOtp(normalizedEmail, otp, 'reset_password');

  // Issue single-use reset token valid for 15 minutes
  const resetToken = jwt.sign(
    {
      sub: user.id || (user._id ? user._id.toString() : ''),
      email: normalizedEmail,
      purpose: 'pwd_reset'
    },
    process.env.JWT_SECRET || 'comment2dm_jwt_secret_dev_2026',
    { expiresIn: '15m' }
  );

  return {
    success: true,
    resetToken,
    message: 'Code verified successfully. You may now enter your new password.'
  };
}

async function resetPasswordWithToken({ resetToken, newPassword }) {
  if (!resetToken) {
    const error = new Error('Reset token is missing or expired.');
    error.statusCode = 400;
    throw error;
  }

  if (!newPassword || newPassword.length < 6) {
    const error = new Error('Password must be at least 6 characters.');
    error.statusCode = 400;
    throw error;
  }

  let payload;
  try {
    payload = jwt.verify(resetToken, process.env.JWT_SECRET || 'comment2dm_jwt_secret_dev_2026');
  } catch (err) {
    const error = new Error('Password reset session expired or invalid. Please request a new code.');
    error.statusCode = 400;
    throw error;
  }

  if (payload.purpose !== 'pwd_reset' || !payload.email) {
    const error = new Error('Invalid reset token.');
    error.statusCode = 400;
    throw error;
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await db.updateUserPasswordByEmail(payload.email, passwordHash);
  await db.markUserVerified(payload.email);

  // Invalidate all existing sessions for security
  const { sessions } = db.collections();
  await sessions.deleteMany({ user_id: payload.sub });

  // Dispath security alert email
  const user = await db.getUserByEmail(payload.email);
  emailService.sendPasswordChangeAlert(payload.email, user ? user.name : 'Creator').catch((err) => {
    console.warn('Password change alert email failed:', err.message);
  });

  return {
    success: true,
    message: 'Your password has been reset successfully. You can now log in.'
  };
}

function createSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

async function createSession(userId, expiresAt) {
  const token = createSessionToken();
  const tokenHash = hashSessionToken(token);
  const { sessions } = db.collections();
  await sessions.insertOne({
    user_id: String(userId),
    token_hash: tokenHash,
    created_at: new Date(),
    expires_at: new Date(expiresAt)
  });
  return token;
}

async function getSessionUser(token) {
  if (!token) return null;
  const tokenHash = hashSessionToken(token);
  const { sessions } = db.collections();
  const session = await sessions.findOne({ token_hash: tokenHash });
  if (!session) return null;
  if (session.expires_at && new Date(session.expires_at) < new Date()) {
    await sessions.deleteOne({ token_hash: tokenHash });
    return null;
  }
  const user = await db.getUserById(session.user_id);
  return publicUser(user);
}

async function deleteSession(token) {
  if (token) {
    const tokenHash = hashSessionToken(token);
    await db.deleteSession(tokenHash);
  }
}

async function deleteAllUserSessions(userId) {
  const { sessions } = db.collections();
  await sessions.deleteMany({ user_id: String(userId) });
}

function createToken(user) {
  return jwt.sign(
    { sub: user.id },
    process.env.JWT_SECRET || 'comment2dm_jwt_secret_dev_2026',
    { expiresIn: '30d', issuer: 'nudge-app', audience: 'nudge-web' }
  );
}

async function getUserByEmail(email) {
  return publicUser(await db.getUserByEmail(String(email).trim().toLowerCase()));
}

async function getUserById(id) {
  return publicUser(await db.getUserById(id));
}

async function listUsers() {
  const users = await db.listUsers();
  return users.map(publicUser);
}

async function registerOAuthUser({ name, email }) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) {
    throw Object.assign(new Error('OAuth provider did not return an email address.'), { statusCode: 400 });
  }

  const existing = await db.getUserByEmail(normalizedEmail);
  if (existing) {
    // If unverified before, mark verified since Google has verified their email
    if (existing.email_verified === false) {
      await db.markUserVerified(normalizedEmail);
      existing.email_verified = true;
    }
    return publicUser(existing);
  }

  const user = {
    id: crypto.randomUUID(),
    name: String(name || 'Comment2DM Creator').trim(),
    email: normalizedEmail,
    password_hash: null,
    email_verified: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  const { users } = db.collections();
  await users.insertOne(user);
  return publicUser(user);
}

module.exports = {
  publicUser,
  register,
  verifySignupOtp,
  resendOtp,
  authenticate,
  requestPasswordReset,
  verifyPasswordResetOtp,
  resetPasswordWithToken,
  createSession,
  getSessionUser,
  deleteSession,
  deleteAllUserSessions,
  createToken,
  getUserByEmail,
  getUserById,
  listUsers,
  registerOAuthUser
};
