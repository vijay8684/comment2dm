const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const db = require('./src/db');
const authService = require('./src/auth/authService');
const instagramService = require('./src/instagram/instagramService');
const billing = require('./src/billing');
const { verifyWebhookSignature, verifyGetChallenge } = require('./src/services/webhookSecurity');
const webhookJobQueue = require('./src/jobs/webhookJobQueue');
const webhookWorker = require('./src/jobs/webhookWorker');
const metaRateLimiter = require('./src/services/metaRateLimiter');
const emailService = require('./src/services/emailService');
const automationTimeline = require('./src/services/automationTimeline');
const storageService = require('./src/services/storageService');
const pricingService = require('./src/services/pricingService');
const couponService = require('./src/services/couponService');
const { registerAdminRoutes } = require('./src/adminRoutes');

const app = express();
const port = Number(process.env.PORT) || 3000;
const isProduction = process.env.NODE_ENV === 'production' || !!process.env.RENDER;
app.disable('x-powered-by');
app.set('trust proxy', 1);

// Enforce HTTPS in production to guarantee secure session cookies
if (isProduction) {
  app.use((request, response, next) => {
    if (request.headers['x-forwarded-proto'] !== 'https' && !request.secure) {
      return response.redirect(301, 'https://' + request.headers.host + request.url);
    }
    next();
  });
}

// Baseline security headers
app.use((request, response, next) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('X-DNS-Prefetch-Control', 'on');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://checkout.razorpay.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: https: blob:; connect-src 'self' https://*.r2.cloudflarestorage.com https://api.openai.com https://generativelanguage.googleapis.com https://api.instagram.com https://graph.instagram.com https://graph.facebook.com https://oauth2.googleapis.com https://api.razorpay.com https://checkout.razorpay.com; frame-src 'self' https://checkout.razorpay.com https://api.razorpay.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none';");
  if (isProduction) response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (request.path.startsWith('/api/')) response.setHeader('Cache-Control', 'no-store');
  next();
});

function getAdminEmails() {
  const raw = process.env.ADMIN_EMAIL;
  if (!raw || typeof raw !== 'string') return new Set();
  const list = raw
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
  return new Set(list);
}

function isAdminEmail(email) {
  if (!email || typeof email !== 'string') return false;
  return getAdminEmails().has(email.trim().toLowerCase());
}

async function loginRateLimit(request, response, next) {
  try {
    const email = typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase() : '';
    if (isAdminEmail(email)) return next();
    const ip = request.ip || request.socket.remoteAddress || 'unknown';
    const allowed = await db.consumeRateLimit(`login:${ip}`, 15 * 60 * 1000, 15);
    if (!allowed) {
      response.setHeader('Retry-After', '900');
      return response.status(429).json({ error: 'Too many attempts. Please try again in 15 minutes.' });
    }
    return next();
  } catch (error) {
    console.warn('Login rate limiter bypassed due to temporary DB latency:', error.message);
    return next();
  }
}

async function passwordChangeRateLimit(request, response, next) {
  try {
    const userId = request.user?.id || 'anon';
    const ip = request.ip || request.socket.remoteAddress || 'unknown';
    // Max 5 password update attempts per 15 minutes per user/IP
    const allowed = await db.consumeRateLimit(`pwchange:${userId}:${ip}`, 15 * 60 * 1000, 5);
    if (!allowed) {
      response.setHeader('Retry-After', '900');
      return response.status(429).json({ error: 'Too many password update attempts. Please try again in 15 minutes.' });
    }
    return next();
  } catch (error) {
    console.warn('Password change rate limiter bypassed due to temporary DB latency:', error.message);
    return next();
  }
}

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'comment2dm_super_secure_jwt_secret_key_minimum_32_chars!';
}

app.use(cookieParser());
app.use('/api', requireSameOriginForStateChanges);
billing.register(app);

app.use(express.json({
  limit: '100kb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
billing.registerPostParser(app);

function requireSameOriginForStateChanges(request, response, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return next();
  if (
    request.path === '/instagram/webhook' ||
    request.path === '/api/instagram/webhook' ||
    request.path === '/billing/webhook' ||
    request.path === '/api/billing/webhook'
  ) return next();
  if (request.headers.authorization && request.headers.authorization.startsWith('Bearer ')) return next();

  const fetchSite = request.get('sec-fetch-site');
  if (fetchSite === 'cross-site') {
    return response.status(403).json({ error: 'Cross-origin request blocked.' });
  }

  const requestHost = request.get('host');
  const origin = request.get('origin');
  const referer = request.get('referer');

  function matches(val) {
    if (!val) return false;
    try {
      const u = new URL(val);
      return u.host === requestHost;
    } catch {
      return false;
    }
  }

  if (origin && !matches(origin)) {
    return response.status(403).json({ error: 'Cross-origin request blocked.' });
  }
  if (referer && !matches(referer)) {
    return response.status(403).json({ error: 'Cross-origin request blocked.' });
  }

  return next();
}

const staticAssetOptions = {
  etag: true,
  lastModified: true,
  setHeaders: (response, filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.html') {
      // HTML documents: must revalidate with origin before use to deliver updates immediately
      response.setHeader('Cache-Control', 'no-cache');
    } else if (ext === '.css' || ext === '.js') {
      // Unversioned CSS and JS: cached locally by the browser, but must revalidate via ETag on each load
      // Ensures instant 304 responses on repeat visits while delivering updates immediately after deployment.
      response.setHeader('Cache-Control', 'no-cache');
    } else if (['.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.eot'].includes(ext)) {
      // Static media, icons, and fonts: rarely change, safe to cache for 7 days
      response.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400');
    } else {
      // Fallback for other static assets
      response.setHeader('Cache-Control', 'no-cache');
    }
  }
};

app.get(['/admin.html', '/vi-tech.html'], (req, res) => {
  res.redirect(301, '/vi-tech');
});
app.use(express.static(path.join(__dirname), staticAssetOptions));

function validateCredentials(body, includeName) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (includeName && (name.length < 2 || name.length > 100)) return 'Enter a valid full name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Enter a valid email address.';
  if (password.length < 6 || password.length > 128) return 'Password must be at least 6 characters.';
  return null;
}

function verifyJwt(token) {
  return jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'], issuer: 'nudge-app', audience: 'nudge-web' });
}

const AUTH_SESSION_DAYS = 60; // 60 days persistent login
const AUTH_SESSION_MS = AUTH_SESSION_DAYS * 24 * 60 * 60 * 1000;
const SESSION_COOKIE_MS = 24 * 60 * 60 * 1000; // 1-day standard session if remember is false

function sessionCookieOptions(remember = true) {
  const maxAge = remember ? AUTH_SESSION_MS : SESSION_COOKIE_MS;
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    maxAge: maxAge,
    expires: new Date(Date.now() + maxAge),
    path: '/'
  };
}

async function setAuthCookie(response, user, remember = true) {
  const maxAge = remember ? AUTH_SESSION_MS : SESSION_COOKIE_MS;
  const expiresAt = new Date(Date.now() + maxAge);
  const sessionToken = await authService.createSession(user.id, expiresAt);
  response.cookie('nudge_session', sessionToken, sessionCookieOptions(remember));
  response.cookie('comment2dm_session', sessionToken, sessionCookieOptions(remember));
  return sessionToken;
}

function attachUserAndCheckDeletion(request, response, user, sessionToken) {
  if (user && (user.deletion_state === 'deleting' || user.deletion_state === 'deletion_failed')) {
    if (request.method === 'DELETE' && request.path === '/api/account/delete') {
      request.user = user;
      request.sessionToken = sessionToken;
      return true;
    }
    response.status(403).json({
      error: 'This account is currently being deleted. No new operations can be performed.'
    });
    return false;
  }
  request.user = user;
  request.sessionToken = sessionToken;
  return true;
}

// Dual Session Auth Middleware: checks Bearer header first, then cookies
async function requireAuth(request, response, next) {
  // 1. Authorization: Bearer <token>
  const authHeader = request.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const bearerToken = authHeader.slice(7).trim();
    try {
      const user = await authService.getSessionUser(bearerToken);
      if (user) {
        if (!attachUserAndCheckDeletion(request, response, user, bearerToken)) return;
        return next();
      }
    } catch (e) {}
  }

  // 2. Cookie session
  const sessionToken = request.cookies.comment2dm_session || request.cookies.nudge_session;
  if (sessionToken) {
    try {
      const user = await authService.getSessionUser(sessionToken);
      if (user) {
        if (!attachUserAndCheckDeletion(request, response, user, sessionToken)) return;
        return next();
      }
    } catch (error) {
      console.error('Session lookup failed:', error.message);
    }
  }

  // 3. Fallback JWT cookie
  const token = request.cookies.nudge_token;
  if (token) {
    try {
      const payload = verifyJwt(token);
      const user = await authService.getUserById(payload.sub);
      if (user) {
        if (!attachUserAndCheckDeletion(request, response, user, null)) return;
        return next();
      }
    } catch (error) {}
  }

  return response.status(401).json({ error: 'Authentication required. Please log in.' });
}

function requireAdmin(request, response, next) {
  if (!isAdminEmail(request.user.email)) {
    return response.status(403).json({ error: 'Admin access required.' });
  }
  return next();
}

// ==========================================
// Authentication Routes
// ==========================================

app.post('/api/auth/signup', loginRateLimit, async (request, response, next) => {
  try {
    const { name, email, password, terms } = request.body || {};
    if (!terms) {
      return response.status(400).json({ error: 'You must agree to the Terms of Service and Privacy Policy.' });
    }
    const validationError = validateCredentials({ name, email, password }, true);
    if (validationError) return response.status(400).json({ error: validationError });

    const result = await authService.register({
      name: String(name).trim(),
      email: String(email).trim().toLowerCase(),
      password: String(password)
    });
    return response.status(200).json(result);
  } catch (error) {
    if (error.statusCode) {
      return response.status(error.statusCode).json({ error: error.message });
    }
    return next(error);
  }
});

app.post('/api/auth/verify-otp', loginRateLimit, async (request, response, next) => {
  try {
    const { email, otp, remember } = request.body || {};
    if (!email || !otp) {
      return response.status(400).json({ error: 'Email and 6-digit verification code are required.' });
    }
    const user = await authService.verifySignupOtp({ email, otp });
    const sessionToken = await setAuthCookie(response, user, remember !== false);
    return response.json({ success: true, user, sessionToken });
  } catch (error) {
    if (error.statusCode) {
      return response.status(error.statusCode).json({ error: error.message });
    }
    return next(error);
  }
});

app.post('/api/auth/resend-otp', loginRateLimit, async (request, response, next) => {
  try {
    const { email, type } = request.body || {};
    if (!email) {
      return response.status(400).json({ error: 'Email address is required.' });
    }
    const result = await authService.resendOtp({ email, type });
    return response.json(result);
  } catch (error) {
    if (error.statusCode) {
      return response.status(error.statusCode).json({ error: error.message });
    }
    return next(error);
  }
});

app.post('/api/auth/login', loginRateLimit, async (request, response, next) => {
  try {
    const { email, password, remember } = request.body || {};
    const validationError = validateCredentials({ email, password }, false);
    if (validationError) return response.status(400).json({ error: validationError });

    const user = await authService.authenticate(
      String(email).trim().toLowerCase(),
      String(password)
    );
    const sessionToken = await setAuthCookie(response, user, remember !== false);
    return response.json({ user, sessionToken });
  } catch (error) {
    if (error.statusCode === 403 && error.requireVerification) {
      return response.status(403).json({
        error: error.message,
        requireVerification: true,
        email: error.email
      });
    }
    if (error.statusCode) {
      return response.status(error.statusCode).json({ error: error.message });
    }
    return next(error);
  }
});

app.post('/api/auth/forgot-password', loginRateLimit, async (request, response, next) => {
  try {
    const { email } = request.body || {};
    if (!email) {
      return response.status(400).json({ error: 'Please enter your email address.' });
    }
    const result = await authService.requestPasswordReset(email);
    return response.json(result);
  } catch (error) {
    if (error.statusCode) {
      return response.status(error.statusCode).json({ error: error.message });
    }
    return next(error);
  }
});

app.post('/api/auth/verify-reset-otp', loginRateLimit, async (request, response, next) => {
  try {
    const { email, otp } = request.body || {};
    if (!email || !otp) {
      return response.status(400).json({ error: 'Email and 6-digit verification code are required.' });
    }
    const result = await authService.verifyPasswordResetOtp({ email, otp });
    return response.json(result);
  } catch (error) {
    if (error.statusCode) {
      return response.status(error.statusCode).json({ error: error.message });
    }
    return next(error);
  }
});

app.post('/api/auth/reset-password', loginRateLimit, async (request, response, next) => {
  try {
    const { resetToken, newPassword } = request.body || {};
    if (!resetToken || !newPassword) {
      return response.status(400).json({ error: 'Reset token and new password are required.' });
    }
    const result = await authService.resetPasswordWithToken({ resetToken, newPassword });
    return response.json(result);
  } catch (error) {
    if (error.statusCode) {
      return response.status(error.statusCode).json({ error: error.message });
    }
    return next(error);
  }
});

app.post('/api/auth/logout', async (request, response) => {
  try {
    const token = request.cookies.comment2dm_session || request.cookies.nudge_session;
    if (token) await authService.deleteSession(token);
  } catch (error) {
    console.error('Session logout cleanup failed:', error.message);
  }
  response.clearCookie('comment2dm_session', { path: '/' });
  response.clearCookie('nudge_session', { path: '/' });
  response.clearCookie('nudge_token', { path: '/' });
  response.status(204).end();
});

app.get('/api/auth/google', (request, response) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${request.protocol}://${request.get('host')}/api/auth/google/callback`;
  if (!clientId) {
    return response.redirect('/login.html?auth_error=' + encodeURIComponent('Google sign-in is not configured yet. Set GOOGLE_CLIENT_ID in Render.'));
  }
  const state = jwt.sign({ nonce: crypto.randomBytes(16).toString('hex') }, process.env.JWT_SECRET, { expiresIn: '15m' });
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', 'select_account');
  return response.redirect(url.toString());
});

app.get('/api/auth/google/callback', async (request, response) => {
  const fail = (msg) => response.redirect('/login.html?auth_error=' + encodeURIComponent(msg));
  try {
    if (typeof request.query.code !== 'string' || typeof request.query.state !== 'string') return fail('Google sign-in was cancelled.');
    jwt.verify(request.query.state, process.env.JWT_SECRET);
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return fail('Google sign-in is not configured on the server.');

    const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${request.protocol}://${request.get('host')}/api/auth/google/callback`;
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: request.query.code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      })
    });
    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenData.id_token) return fail('Google sign-in could not be completed.');

    const profileResponse = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(tokenData.id_token));
    const profile = await profileResponse.json();
    if (!profileResponse.ok || !profile.email) return fail('Google account verification failed.');

    const user = await authService.registerOAuthUser({ name: profile.name || profile.email.split('@')[0], email: profile.email });
    await setAuthCookie(response, user);
    return response.redirect('/dashboard.html');
  } catch (error) {
    console.error('Google OAuth callback failed:', error.message);
    return fail('Google sign-in could not be completed. Please try again.');
  }
});

app.get('/api/me', requireAuth, (request, response) => {
  const isAdmin = request.user && isAdminEmail(request.user.email);
  return response.json({ user: { ...request.user, isAdmin } });
});

// ==========================================
// User Settings & Profile
// ==========================================

app.get('/api/settings', requireAuth, async (request, response, next) => {
  try {
    const user = await db.getUserById(request.user.id);
    if (!user) {
      return response.status(404).json({ error: 'User not found.' });
    }
    const hasPassword = Boolean(user.password_hash);
    return response.json({
      user: {
        id: user.id || (user._id ? user._id.toString() : ''),
        name: user.name || '',
        email: user.email || '',
        phone: user.phone || '',
        bio: user.bio || '',
        avatarUrl: user.avatar_url || '',
        createdAt: user.created_at || user.createdAt || '',
        hasPassword: hasPassword,
        isOAuth: !hasPassword
      },
      preferences: user.notification_preferences || {
        dm_sent: false,
        failed: false,
        weekly: false,
        billing: false
      }
    });
  } catch (error) {
    return next(error);
  }
});

// Legacy / alias endpoint to support callers expecting /api/auth/me
app.get('/api/auth/me', requireAuth, async (request, response, next) => {
  try {
    const user = await db.getUserById(request.user.id);
    if (!user) {
      return response.status(404).json({ error: 'User not found.' });
    }
    const hasPassword = Boolean(user.password_hash);
    return response.json({
      user: {
        id: user.id || (user._id ? user._id.toString() : ''),
        name: user.name || '',
        email: user.email || '',
        phone: user.phone || '',
        bio: user.bio || '',
        avatarUrl: user.avatar_url || '',
        createdAt: user.created_at || user.createdAt || '',
        hasPassword: hasPassword,
        isOAuth: !hasPassword
      }
    });
  } catch (error) {
    return next(error);
  }
});

app.patch('/api/settings/profile', requireAuth, async (request, response, next) => {
  try {
    const { name, phone, bio, avatarUrl } = request.body || {};

    if (name !== undefined) {
      if (typeof name !== 'string') {
        return response.status(400).json({ error: 'Name must be a text string.' });
      }
      const trimmedName = name.trim();
      if (trimmedName.length < 2 || trimmedName.length > 100) {
        return response.status(400).json({ error: 'Name must be between 2 and 100 characters.' });
      }
    }

    if (phone !== undefined && phone !== null && phone !== '') {
      if (typeof phone !== 'string') {
        return response.status(400).json({ error: 'Phone must be a text string.' });
      }
      const trimmedPhone = phone.trim();
      if (trimmedPhone.length > 20) {
        return response.status(400).json({ error: 'Phone number cannot exceed 20 characters.' });
      }
    }

    if (bio !== undefined && bio !== null && bio !== '') {
      if (typeof bio !== 'string') {
        return response.status(400).json({ error: 'Bio must be a text string.' });
      }
      const trimmedBio = bio.trim();
      if (trimmedBio.length > 160) {
        return response.status(400).json({ error: 'Bio cannot exceed 160 characters.' });
      }
    }

    if (avatarUrl !== undefined && avatarUrl !== null && avatarUrl !== '') {
      if (typeof avatarUrl !== 'string') {
        return response.status(400).json({ error: 'Invalid avatar format.' });
      }
      const trimmedAvatar = avatarUrl.trim();
      if (trimmedAvatar.length > 60000) {
        return response.status(400).json({ error: 'Avatar image exceeds maximum allowed size of 40 KB.' });
      }
      const avatarMatch = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(trimmedAvatar);
      if (!avatarMatch) {
        return response.status(400).json({ error: 'Unsupported avatar format. Only JPEG, PNG, and WebP images are allowed.' });
      }
    }

    // Do not allow arbitrary unverified email modification via profile update
    await db.updateUserProfile(request.user.id, {
      name,
      phone,
      bio,
      avatarUrl
    });

    const updated = await db.getUserById(request.user.id);
    const hasPassword = Boolean(updated.password_hash);
    return response.json({
      user: {
        id: updated.id || (updated._id ? updated._id.toString() : ''),
        name: updated.name || '',
        email: updated.email || '',
        phone: updated.phone || '',
        bio: updated.bio || '',
        avatarUrl: updated.avatar_url || '',
        createdAt: updated.created_at || updated.createdAt || '',
        hasPassword: hasPassword,
        isOAuth: !hasPassword
      }
    });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/settings/password', requireAuth, passwordChangeRateLimit, async (request, response, next) => {
  try {
    const { currentPassword, newPassword } = request.body || {};
    if (!currentPassword || !newPassword) {
      return response.status(400).json({ error: 'Current password and new password are required.' });
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return response.status(400).json({ error: 'New password must be at least 8 characters.' });
    }
    if (newPassword.length > 128) {
      return response.status(400).json({ error: 'New password cannot exceed 128 characters.' });
    }

    const userRecord = await db.getUserById(request.user.id);
    if (!userRecord || !userRecord.password_hash) {
      return response.status(400).json({ error: 'Password change not available for OAuth accounts.' });
    }

    const matches = await bcrypt.compare(currentPassword, userRecord.password_hash);
    if (!matches) {
      return response.status(401).json({ error: 'Current password is incorrect.' });
    }

    const newHash = await bcrypt.hash(newPassword, 12);
    await db.updateUserPassword(request.user.id, newHash);

    // Invalidate other sessions to secure account across devices, preserving current session
    if (authService.deleteOtherUserSessions) {
      await authService.deleteOtherUserSessions(request.user.id, request.sessionToken);
    }

    // Trigger security alert email asynchronously if configured
    emailService.sendPasswordChangedAlert(userRecord.email, userRecord.name).catch((emailErr) => {
      console.warn('[Security] Could not dispatch password changed alert:', emailErr.message);
    });

    return response.json({ success: true, message: 'Password updated successfully.' });
  } catch (error) {
    return next(error);
  }
});

app.patch('/api/settings/notifications', requireAuth, async (request, response, next) => {
  try {
    const body = request.body || {};
    const prefs = body.preferences || body;
    const cleanPrefs = {
      dm_sent: Boolean(prefs.dm_sent),
      failed: Boolean(prefs.failed),
      weekly: Boolean(prefs.weekly),
      billing: Boolean(prefs.billing)
    };
    await db.updateUserNotificationPreferences(request.user.id, cleanPrefs);
    return response.json({ success: true, preferences: cleanPrefs });
  } catch (error) {
    return next(error);
  }
});

app.delete('/api/account/delete', requireAuth, async (request, response, next) => {
  try {
    const { confirmation } = request.body || {};
    if (confirmation !== 'DELETE') {
      return response.status(400).json({ error: 'Confirmation required. Please type DELETE to confirm.' });
    }

    // Subscription protection: Prevent unsafe deletion if active or pending subscription exists
    let activeSub;
    try {
      activeSub = await billing.getActiveSubscription(request.user.id);
    } catch (subErr) {
      console.error('[Account Deletion] Failed to verify subscription status:', subErr.message);
      return response.status(503).json({
        error: 'Unable to verify subscription status at this time. Please try again shortly.'
      });
    }

    if (activeSub) {
      return response.status(409).json({
        error: 'Active subscription detected. Please cancel your subscription in Billing before deleting your account.'
      });
    }

    try {
      await db.deleteUserAccount(request.user.id);
    } catch (delErr) {
      if (delErr.code === 'DELETION_DRAIN_TIMEOUT' || delErr.statusCode === 503) {
        console.warn(`[Account Deletion] Active dispatches still draining for user (user_ref: ${automationTimeline.hashCorrelationId(request.user.id)}). Returning 503.`);
        return response.status(503).json({
          error: delErr.message,
          retryAfter: 2,
          inProgress: true
        });
      }
      throw delErr;
    }
    response.clearCookie('comment2dm_session', { path: '/' });
    response.clearCookie('nudge_session', { path: '/' });
    response.clearCookie('nudge_token', { path: '/' });
    return response.json({ success: true, message: 'Account deleted successfully.' });
  } catch (error) {
    return next(error);
  }
});

// ==========================================
// Instagram Connection & Accounts
// ==========================================

app.get('/api/instagram/authorize', requireAuth, (request, response, next) => {
  try {
    instagramService.ensureConfiguration();
    const state = jwt.sign(
      { sub: request.user.id, nonce: crypto.randomBytes(16).toString('hex') },
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    );
    // Direct Instagram Login (Exact SendDM flow - clean Instagram dialog, no Facebook portfolios)
    const authorizeUrl = new URL('https://www.instagram.com/oauth/authorize');
    authorizeUrl.searchParams.set('enable_fb_login', '0');
    authorizeUrl.searchParams.set('force_authentication', '1');
    authorizeUrl.searchParams.set('client_id', process.env.META_APP_ID);
    authorizeUrl.searchParams.set('redirect_uri', process.env.META_REDIRECT_URI);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('scope', 'instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments');
    authorizeUrl.searchParams.set('state', state);
    return response.redirect(authorizeUrl.toString());
  } catch (error) {
    if (error.statusCode === 503) {
      return response.redirect(`/instagram-accounts.html?instagram_error=${encodeURIComponent(error.message)}`);
    }
    return next(error);
  }
});

app.get('/api/instagram/callback', async (request, response) => {
  const errorRedirect = (message) => response.redirect(`/instagram-accounts.html?instagram_error=${encodeURIComponent(message)}`);
  if (request.query.error) {
    return errorRedirect(request.query.error_description || 'Instagram authorization was cancelled.');
  }
  if (typeof request.query.code !== 'string' || typeof request.query.state !== 'string') {
    return errorRedirect('Instagram authorization did not return a valid code.');
  }
  try {
    const state = jwt.verify(request.query.state, process.env.JWT_SECRET);
    if (!state.sub) return errorRedirect('Instagram authorization state was invalid.');
    const token = await instagramService.exchangeCode(request.query.code);
    const profile = await instagramService.fetchProfile(token.accessToken);

    // Enforce plan limits for new connected Instagram accounts
    const existingAccounts = await instagramService.listAccounts(state.sub);
    const isAlreadyConnected = existingAccounts.some(a => String(a.id) === String(profile.userId));
    if (!isAlreadyConnected) {
      const r = await billing.check(state.sub, 'instagramAccounts');
      if (!r.allowed) {
        return errorRedirect(`Your ${r.plan.toUpperCase()} plan allows ${r.limits.instagramAccounts} Instagram account${r.limits.instagramAccounts === 1 ? '' : 's'}. Upgrade to connect more.`);
      }
    }

    await instagramService.saveAccount(state.sub, profile, token);
    return response.redirect('/instagram-accounts.html?instagram_connected=1');
  } catch (error) {
    console.error('Instagram OAuth callback failed:', error.message);
    return errorRedirect(error.message || 'Instagram authorization could not be completed.');
  }
});

app.get('/api/instagram/accounts', requireAuth, async (request, response, next) => {
  try {
    return response.json({ accounts: await instagramService.listAccounts(request.user.id) });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/instagram/accounts/:instagramUserId/reels', requireAuth, async (request, response, next) => {
  try {
    const force = request.query.refresh === '1';
    const reels = await instagramService.listReels(request.user.id, request.params.instagramUserId, force);
    return response.json({ reels });
  } catch (error) {
    return next(error);
  }
});

app.delete('/api/instagram/accounts/:instagramUserId', requireAuth, async (request, response, next) => {
  try {
    await instagramService.disconnect(request.user.id, request.params.instagramUserId);
    return response.status(204).end();
  } catch (error) {
    return next(error);
  }
});

// ==========================================
// Comment-to-DM Automations (Fast & Reliable)
// ==========================================

app.get('/api/automations', requireAuth, async (request, response, next) => {
  try {
    const automations = await db.all(
      `SELECT a.id, a.owner_user_id AS ownerUserId, a.instagram_user_id AS instagramUserId,
              a.keyword, a.dm_message AS dmMessage, a.reply_template AS replyTemplate, a.trigger_type AS triggerType,
              a.enabled, a.media_id AS mediaId, a.media_url AS mediaUrl, a.created_at AS createdAt,
              a.updated_at AS updatedAt, i.username
       FROM automations a
       LEFT JOIN instagram_accounts i ON a.owner_user_id = i.owner_user_id AND a.instagram_user_id = i.instagram_user_id
       WHERE a.owner_user_id = ?
       ORDER BY a.created_at DESC`,
      [request.user.id]
    );
    return response.json({ automations });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/automations', requireAuth, async (request, response, next) => {
  try {
    const {
      instagramUserId,
      keyword,
      keywords,
      dmMessage,
      replyTemplate,
      triggerType,
      enabled,
      mediaUrl,
      mediaId,
      mediaTitle,
      mediaThumbnail,
      mediaType,
      flow
    } = request.body || {};

    let targetIgId = typeof instagramUserId === 'string' ? instagramUserId.trim() : '';

    if (!targetIgId) {
      return response.status(400).json({ error: 'Please select a connected Instagram account.' });
    }

    // Account ownership verification
    let account = null;
    if (targetIgId) {
      account = await db.get(
        'SELECT owner_user_id, username FROM instagram_accounts WHERE owner_user_id = ? AND instagram_user_id = ?',
        [request.user.id, targetIgId]
      );
    }
    if (!account) {
      const userAccounts = await instagramService.listAccounts(request.user.id);
      if (userAccounts && userAccounts.length > 0) {
        account = userAccounts.find(a => a.id === targetIgId) || userAccounts[0];
        targetIgId = account.id;
      }
    }
    if (!account) {
      return response.status(403).json({ error: 'No connected Instagram account found. Please connect your Instagram account first.' });
    }

    // Specific Reel or Post selection is mandatory
    let selectedMediaId = mediaId ? String(mediaId).trim() : null;
    let selectedMediaUrl = mediaUrl ? String(mediaUrl).trim() : null;

    if (!selectedMediaId && selectedMediaUrl) {
      try {
        const media = await instagramService.resolveReelUrl(request.user.id, targetIgId, selectedMediaUrl);
        if (media) {
          selectedMediaId = media.id;
          selectedMediaUrl = media.permalink;
        }
      } catch (e) {
        selectedMediaUrl = mediaUrl;
      }
    }

    if (!selectedMediaId) {
      return response.status(400).json({ error: 'Please select a specific Instagram Reel or Post to link this automation.' });
    }

    // Entitlement & Tier Quota Check
    const userEntitlement = await billing.entitlement(request.user.id, request);
    const trigger = triggerType === 'all' ? 'all' : 'keyword';

    if (trigger === 'all' && !userEntitlement?.limits?.allCommentsTrigger) {
      return response.status(403).json({
        error: 'The "Any Comment" trigger is available exclusively on Pro and Elite plans. Please upgrade to unlock.'
      });
    }

    if (flow?.followGate?.enabled && !userEntitlement?.limits?.followToUnlock) {
      return response.status(403).json({
        error: 'Follow-to-unlock is a premium feature available on Pro and Elite plans. Please upgrade to unlock.'
      });
    }

    // Clean & normalize keywords (removes duplicates, case-insensitive)
    let cleanKeywords = [];
    if (Array.isArray(keywords)) {
      cleanKeywords = keywords.map(k => String(k).trim()).filter(Boolean);
    } else if (typeof keyword === 'string') {
      cleanKeywords = keyword.split(',').map(k => k.trim()).filter(Boolean);
    }
    const seenKw = new Set();
    cleanKeywords = cleanKeywords.filter(k => {
      const lower = k.toLowerCase();
      if (seenKw.has(lower)) return false;
      seenKw.add(lower);
      return true;
    });

    const primaryKeyword = cleanKeywords.join(', ') || (trigger === 'all' ? '*' : '');
    if (trigger === 'keyword' && cleanKeywords.length === 0) {
      return response.status(400).json({ error: 'Please add at least one trigger keyword.' });
    }

    // Determine DM message
    let trimmedMessage = typeof dmMessage === 'string' ? dmMessage.trim() : '';
    if (!trimmedMessage && flow?.openingMessage) {
      trimmedMessage = String(flow.openingMessage).trim();
    }
    if (!trimmedMessage) {
      return response.status(400).json({ error: 'Direct Message content must not be empty.' });
    }

    const trimmedReply = typeof replyTemplate === 'string' ? replyTemplate.trim() : '';
    const isEnabled = enabled === false || enabled === 0 ? 0 : 1;

    // Active automations entitlement limit check
    if (isEnabled === 1) {
      const autCheck = await billing.check(request.user.id, 'automations', { user: request.user });
      if (!autCheck.allowed) {
        return response.status(403).json({
          error: `You have reached your limit of ${autCheck.limits.automations} active automations on the ${autCheck.plan} plan. Please upgrade to Pro or Elite for unlimited automations.`
        });
      }
    }

    const now = new Date().toISOString();

    const result = await db.run(
      `INSERT INTO automations (owner_user_id, instagram_user_id, keyword, dm_message, enabled, created_at, updated_at, media_id, media_url, reply_template, trigger_type, flow, keywords, media_title, media_thumbnail, media_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        request.user.id,
        targetIgId,
        primaryKeyword,
        trimmedMessage,
        isEnabled,
        now,
        now,
        selectedMediaId,
        selectedMediaUrl,
        trimmedReply,
        trigger,
        flow || null,
        cleanKeywords,
        mediaTitle || null,
        mediaThumbnail || null,
        mediaType || null
      ]
    );

    const created = await db.get(
      `SELECT a.id, a.owner_user_id AS ownerUserId, a.instagram_user_id AS instagramUserId,
              a.keyword, a.dm_message AS dmMessage, a.reply_template AS replyTemplate, a.trigger_type AS triggerType,
              a.enabled, a.media_id AS mediaId, a.media_url AS mediaUrl, a.created_at AS createdAt,
              a.updated_at AS updatedAt, i.username
       FROM automations a
       LEFT JOIN instagram_accounts i ON a.owner_user_id = i.owner_user_id AND a.instagram_user_id = i.instagram_user_id
       WHERE a.id = ?`,
      [result.lastID]
    );

    if (flow?.delivery?.resourceId && result?.lastID) {
      await storageService.linkAutomationReference(request.user.id, result.lastID, flow.delivery.resourceId);
    }

    return response.status(201).json({ automation: created });
  } catch (error) {
    return next(error);
  }
});

app.patch('/api/automations/:id', requireAuth, async (request, response, next) => {
  try {
    const automationId = request.params.id;
    const existing = await db.get(
      'SELECT * FROM automations WHERE id = ? AND owner_user_id = ?',
      [automationId, request.user.id]
    );
    if (!existing) {
      return response.status(404).json({ error: 'Automation not found.' });
    }

    const {
      instagramUserId,
      keyword,
      keywords,
      dmMessage,
      replyTemplate,
      triggerType,
      enabled,
      mediaUrl,
      mediaId,
      mediaTitle,
      mediaThumbnail,
      mediaType,
      flow
    } = request.body || {};

    let targetIgId = existing.instagram_user_id;
    if (typeof instagramUserId === 'string' && instagramUserId.trim() !== '') {
      targetIgId = instagramUserId.trim();
    }

    const userEntitlement = await billing.entitlement(request.user.id, request);

    let newTrigger = existing.trigger_type || 'keyword';
    if (triggerType !== undefined) {
      newTrigger = triggerType === 'all' ? 'all' : 'keyword';
      if (newTrigger === 'all' && !userEntitlement?.limits?.allCommentsTrigger) {
        return response.status(403).json({
          error: 'The "Any Comment" trigger is available exclusively on Pro and Elite plans. Please upgrade to unlock.'
        });
      }
    }

    if (flow?.followGate?.enabled && !userEntitlement?.limits?.followToUnlock) {
      return response.status(403).json({
        error: 'Follow-to-unlock is a premium feature available on Pro and Elite plans. Please upgrade to unlock.'
      });
    }

    let newKeywords = existing.keywords;
    let newKeyword = existing.keyword;
    if (keywords !== undefined || keyword !== undefined) {
      let rawList = [];
      if (Array.isArray(keywords)) rawList = keywords;
      else if (typeof keyword === 'string') rawList = keyword.split(',');
      const seenKw = new Set();
      newKeywords = rawList.map(k => String(k).trim()).filter(Boolean).filter(k => {
        const lower = k.toLowerCase();
        if (seenKw.has(lower)) return false;
        seenKw.add(lower);
        return true;
      });
      newKeyword = newKeywords.join(', ');
    }

    let newMessage = existing.dm_message;
    if (dmMessage !== undefined) newMessage = String(dmMessage).trim();
    if (flow?.openingMessage && !newMessage) newMessage = String(flow.openingMessage).trim();

    let newReply = existing.reply_template;
    if (replyTemplate !== undefined) newReply = String(replyTemplate).trim();

    let newEnabled = existing.enabled;
    if (enabled !== undefined) newEnabled = enabled === true || enabled === 1 || enabled === '1' ? 1 : 0;

    // Check active automation limit if toggling from disabled to enabled
    if (newEnabled === 1 && !existing.enabled) {
      const autCheck = await billing.check(request.user.id, 'automations', { user: request.user });
      if (!autCheck.allowed) {
        return response.status(403).json({
          error: `You have reached your limit of ${autCheck.limits.automations} active automations on the ${autCheck.plan} plan. Please upgrade to Pro or Elite for unlimited automations.`
        });
      }
    }

    let newMediaId = existing.media_id || null;
    if (mediaId !== undefined) newMediaId = mediaId || null;

    let newMediaUrl = existing.media_url || null;
    if (mediaUrl !== undefined) newMediaUrl = mediaUrl || null;

    let newMediaTitle = existing.media_title || null;
    if (mediaTitle !== undefined) newMediaTitle = mediaTitle || null;

    let newMediaThumbnail = existing.media_thumbnail || null;
    if (mediaThumbnail !== undefined) newMediaThumbnail = mediaThumbnail || null;

    let newMediaType = existing.media_type || null;
    if (mediaType !== undefined) newMediaType = mediaType || null;

    let newFlow = existing.flow || null;
    if (flow !== undefined) newFlow = flow;

    const now = new Date().toISOString();
    await db.run(
      `UPDATE automations
       SET instagram_user_id = ?, keyword = ?, dm_message = ?, enabled = ?, updated_at = ?, media_id = ?, media_url = ?, reply_template = ?, trigger_type = ?, flow = ?, keywords = ?, media_title = ?, media_thumbnail = ?, media_type = ?
       WHERE id = ? AND owner_user_id = ?`,
      [
        targetIgId,
        newKeyword,
        newMessage,
        newEnabled,
        now,
        newMediaId,
        newMediaUrl,
        newReply,
        newTrigger,
        newFlow,
        newKeywords,
        newMediaTitle,
        newMediaThumbnail,
        newMediaType,
        automationId,
        request.user.id
      ]
    );

    const updated = await db.get(
      `SELECT a.id, a.owner_user_id AS ownerUserId, a.instagram_user_id AS instagramUserId,
              a.keyword, a.dm_message AS dmMessage, a.reply_template AS replyTemplate, a.trigger_type AS triggerType,
              a.enabled, a.media_id AS mediaId, a.media_url AS mediaUrl, a.created_at AS createdAt,
              a.updated_at AS updatedAt, i.username
       FROM automations a
       LEFT JOIN instagram_accounts i ON a.owner_user_id = i.owner_user_id AND a.instagram_user_id = i.instagram_user_id
       WHERE a.id = ?`,
      [automationId]
    );

    if (newFlow !== undefined) {
      const oldResId = existing.flow?.delivery?.resourceId;
      const newResId = newFlow?.delivery?.resourceId;
      if (oldResId && oldResId !== newResId) {
        await storageService.unlinkAutomationReference(request.user.id, automationId, oldResId);
      }
      if (newResId && newResId !== oldResId) {
        await storageService.linkAutomationReference(request.user.id, automationId, newResId);
      }
    }

    return response.json({ automation: updated });
  } catch (error) {
    return next(error);
  }
});

app.delete('/api/automations/:id', requireAuth, async (request, response, next) => {
  try {
    const automationId = request.params.id;
    if (db.collections) {
      const { ObjectId } = require('mongodb');
      const clauses = [
        { id: String(automationId) },
        { id: automationId }
      ];
      if (!isNaN(Number(automationId))) {
        clauses.push({ id: Number(automationId) });
      }
      if (/^[a-f0-9]{24}$/i.test(String(automationId))) {
        try { clauses.push({ _id: new ObjectId(String(automationId)) }); } catch (_) {}
      }
      const ownerClauses = [
        { owner_user_id: String(request.user.id) },
        { owner_user_id: request.user.id }
      ];
      await db.collections().automations.deleteMany({
        $and: [
          { $or: clauses },
          { $or: ownerClauses }
        ]
      });
    } else {
      await db.run('DELETE FROM automations WHERE id = ? AND owner_user_id = ?', [automationId, request.user.id]);
    }
    await storageService.unlinkAutomationReference(request.user.id, automationId);
    return response.status(204).end();
  } catch (error) {
    return next(error);
  }
});

// ── Cloudflare R2 Standard Storage Integration ────────────────────────────
app.post('/api/storage/presign', requireAuth, async (request, response) => {
  try {
    const { fileName, fileType, fileSize } = request.body || {};
    if (!fileName || !fileSize) {
      return response.status(400).json({ error: 'fileName and fileSize are required.' });
    }
    const result = await storageService.createPresignedUpload(request.user.id, {
      fileName,
      fileType: fileType || 'application/octet-stream',
      fileSize: Number(fileSize)
    });
    return response.json(result);
  } catch (err) {
    const status = err.statusCode || 500;
    return response.status(status).json({
      error: err.message,
      code: err.code || 'STORAGE_ERROR'
    });
  }
});

app.post('/api/storage/confirm', requireAuth, async (request, response) => {
  try {
    const { resourceId, objectKey } = request.body || {};
    if (!resourceId || !objectKey) {
      return response.status(400).json({ error: 'resourceId and objectKey are required.' });
    }
    const result = await storageService.confirmUpload(request.user.id, { resourceId, objectKey });
    return response.json(result);
  } catch (err) {
    const status = err.statusCode || 500;
    return response.status(status).json({
      error: err.message,
      code: err.code || 'STORAGE_CONFIRM_ERROR'
    });
  }
});

app.get('/api/storage/usage', requireAuth, async (request, response) => {
  try {
    const usage = await storageService.getStorageUsage(request.user.id);
    return response.json(usage);
  } catch (err) {
    return response.status(500).json({ error: err.message });
  }
});

app.get('/api/storage/resources', requireAuth, async (request, response) => {
  try {
    const col = await storageService.getStorageCollection();
    const resources = await col.find({
      owner_user_id: String(request.user.id),
      status: 'active',
      'deletion_state.isDeleted': { $ne: true }
    }).sort({ created_at: -1 }).toArray();
    return response.json({
      resources: resources.map(r => ({
        id: r.id,
        fileName: r.original_filename,
        fileSize: r.size_bytes,
        mimeType: r.content_type,
        createdAt: r.created_at,
        automationReferences: r.automation_references || []
      }))
    });
  } catch (err) {
    return response.status(500).json({ error: err.message });
  }
});

app.delete('/api/storage/resources/:id', requireAuth, async (request, response) => {
  try {
    const result = await storageService.deleteResource(request.user.id, request.params.id);
    return response.json(result);
  } catch (err) {
    const status = err.statusCode || 500;
    return response.status(status).json({
      error: err.message,
      code: err.code || 'STORAGE_DELETE_ERROR',
      blockingAutomations: err.blockingAutomations || []
    });
  }
});

app.get('/api/storage/file/:id', async (request, response) => {
  try {
    const url = await storageService.getResourceAccessUrl(null, request.params.id);
    if (!url) {
      return response.status(404).send('File not found or expired.');
    }
    return response.redirect(302, url);
  } catch (err) {
    return response.status(500).send('Error accessing file: ' + err.message);
  }
});

// Resource Upload Endpoint (Direct memory-to-R2 upload, zero local disk writes)
app.post('/api/automations/upload-resource', requireAuth, async (request, response) => {
  try {
    const { fileName, fileType, fileData } = request.body || {};
    if (!fileData || !fileName) {
      return response.status(400).json({ error: 'No file data received.' });
    }
    const matches = String(fileData).match(/^data:([A-Za-z0-9\/\-+.]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
      return response.status(400).json({ error: 'Invalid file payload. Base64 encoding required.' });
    }
    const mimeType = matches[1].toLowerCase();
    const base64Buffer = Buffer.from(matches[2], 'base64');

    if (base64Buffer.length > 10 * 1000 * 1000) {
      return response.status(400).json({ error: 'File size exceeds maximum allowed 10MB limit.' });
    }

    if (!storageService.isConfigured()) {
      return response.status(503).json({
        error: 'Cloud storage service is currently unconfigured. Customer files cannot be stored on ephemeral server disk. Please configure Cloudflare R2 credentials or use a Google Drive link.',
        code: 'STORAGE_NOT_CONFIGURED'
      });
    }

    const uploadRes = await storageService.uploadDirectBuffer(request.user.id, {
      buffer: base64Buffer,
      fileName,
      mimeType
    });

    return response.json({
      success: true,
      url: uploadRes.resource.url,
      resourceId: uploadRes.resource.id,
      fileName: uploadRes.resource.fileName,
      fileType: uploadRes.resource.fileType,
      fileSize: uploadRes.resource.fileSize
    });
  } catch (err) {
    console.error('Resource upload failed:', err);
    const status = err.statusCode || 500;
    return response.status(status).json({
      error: err.message || 'Failed to process resource upload.',
      code: err.code || 'STORAGE_ERROR'
    });
  }
});

// Follow Verification Endpoint
app.post('/api/automations/check-follow', requireAuth, async (request, response) => {
  try {
    const { instagramUserId, commenterId } = request.body || {};
    if (!instagramUserId || !commenterId) {
      return response.status(400).json({ error: 'Missing instagram account ID or commenter ID.' });
    }
    const tokenData = await instagramService.getDecryptedTokenByInstagramUserId(instagramUserId, request.user.id);
    const result = await instagramService.checkFollowStatus(instagramUserId, commenterId, tokenData.accessToken);
    return response.json(result);
  } catch (err) {
    return response.status(500).json({ error: err.message });
  }
});

// ==========================================
// Instagram Webhook Handler (Comment to DM + Public Reply)
// ==========================================

app.get('/api/instagram/webhook', (request, response) => {
  const mode = request.query['hub.mode'];
  const token = request.query['hub.verify_token'];
  const challenge = request.query['hub.challenge'];
  const expectedToken = process.env.META_WEBHOOK_VERIFY_TOKEN;

  const verification = verifyGetChallenge(mode, token, expectedToken);
  if (verification.valid) {
    console.log('Meta Webhook verified successfully with challenge:', challenge);
    return response.status(200).send(challenge);
  } else {
    console.warn(`Meta Webhook verification rejected: ${verification.error}`);
    return response.status(verification.statusCode || 403).json({ error: verification.error });
  }
});

function keywordMatches(commentText, keyword, triggerType) {
  if (triggerType === 'all' || triggerType === 'any') return true;
  if (!commentText) return false;
  if (!keyword || keyword.trim() === '*' || keyword.trim().toLowerCase() === 'all') return true;
  const cleanComment = commentText.toLowerCase().trim();
  const keywords = String(keyword)
    .split(',')
    .map(k => k.toLowerCase().trim())
    .filter(Boolean);
  if (keywords.length === 0) return true;
  return keywords.some(kw => cleanComment.includes(kw));
}

// In-memory set to deduplicate concurrent webhook comment deliveries
const processingCommentIds = new Set();
// In-memory set to deduplicate concurrent webhook postbacks / deliveries
const processingDeliveryKeys = new Set();

// Outbound Dispatch Lease Coordination helper with Unique Lease ID Tracking (Strictly Fail-Closed)
async function safeDispatchOutbound(recipientIgUserId, workerId, dispatchFn, leaseOptions = {}) {
  if (!db || typeof db.acquireDispatchLease !== 'function') {
    console.error(`[DISPATCH LEASE REJECTED] Dispatch lease API unavailable for Instagram account. Aborting dispatch.`);
    return { success: false, skipped: true, reason: 'LEASE_API_UNAVAILABLE' };
  }

  // Require the lease validation API to exist before proceeding
  if (typeof db.isDispatchLeaseValid !== 'function') {
    console.error(`[DISPATCH LEASE ERROR] isDispatchLeaseValid API unavailable. Aborting dispatch.`);
    return { success: false, skipped: true, reason: 'LEASE_VALIDATION_API_UNAVAILABLE' };
  }

  // Require the lease release API to exist before proceeding
  if (typeof db.releaseDispatchLease !== 'function') {
    console.error(`[DISPATCH LEASE ERROR] releaseDispatchLease API unavailable. Aborting dispatch.`);
    return { success: false, skipped: true, reason: 'LEASE_RELEASE_API_UNAVAILABLE' };
  }

  let lease;
  let leaseDuration = 0;
  try {
    const leaseStart = Date.now();
    lease = await db.acquireDispatchLease(recipientIgUserId, workerId);
    leaseDuration = Date.now() - leaseStart;
  } catch (leaseAcquireErr) {
    console.error(`[DISPATCH LEASE ERROR] Exception during lease acquisition:`, leaseAcquireErr.message);
    return { success: false, skipped: true, reason: 'LEASE_ACQUISITION_FAILED', error: leaseAcquireErr.message };
  }

  if (!lease || !lease.leaseId) {
    console.warn(`[DISPATCH LEASE REJECTED] Instagram account is deleted, undergoing deletion, or database is unavailable. Aborting outbound dispatch.`);
    return { success: false, skipped: true, reason: 'ACCOUNT_DELETED' };
  }

  // Once a lease has been acquired, put all subsequent validation, timing,
  // dispatch and fallback work inside a try/finally block so the exact lease is always released.
  let renewalFailed = false;
  let leaseRenewTimer = null;

  try {
    // Verify the lease immediately before beginning the external Meta request
    let preValid = false;
    try {
      preValid = await db.isDispatchLeaseValid(recipientIgUserId, lease.leaseId);
    } catch (valErr) {
      console.error(`[DISPATCH LEASE ERROR] Exception during pre-dispatch lease validation:`, valErr.message);
      preValid = false;
    }
    if (!preValid) {
      console.warn(`[DISPATCH LEASE LOST] Worker lost dispatch lease before outbound request. Halting.`);
      const leaseLossErr = new Error(`Dispatch lease expired or reclaimed prior to request processing`);
      leaseLossErr.code = 'LEASE_LOST';
      leaseLossErr.retryable = false;
      throw leaseLossErr;
    }

    if (leaseOptions.stage && typeof automationTimeline?.recordTimelineStage === 'function') {
      automationTimeline.recordTimelineStage({
        stage: leaseOptions.stage,
        duration_ms: leaseDuration,
        job_id: leaseOptions.job_id || null,
        automation_id: leaseOptions.automation_id || null,
        instagram_account_id: recipientIgUserId,
        event_type: leaseOptions.event_type || null,
        success: true
      });
    }

    if (typeof db.renewDispatchLease === 'function') {
      leaseRenewTimer = setInterval(async () => {
        try {
          const renewed = await db.renewDispatchLease(recipientIgUserId, lease.leaseId, 15000);
          if (!renewed) renewalFailed = true;
        } catch (_) {
          renewalFailed = true;
        }
      }, 5000);
      if (leaseRenewTimer.unref) leaseRenewTimer.unref();
    }

    console.log(`[STAGE: DISPATCH_LEASE_ACQUIRED]`, JSON.stringify({
      worker_id: String(workerId || 'unknown'),
      lease_id: lease.leaseId,
      expires_at: lease.expiresAt
    }));

    const dispatchLease = {
      ...lease,
      isRenewalFailed: () => renewalFailed,
      assertValid: async () => {
        if (renewalFailed) {
          const err = new Error('Dispatch lease renewal failed; halting outbound dispatch.');
          err.code = 'LEASE_LOST';
          err.retryable = false;
          throw err;
        }
        let valid = false;
        try {
          valid = await db.isDispatchLeaseValid(recipientIgUserId, lease.leaseId);
        } catch (_) {
          valid = false;
        }
        if (!valid) {
          const err = new Error('Dispatch lease expired or reclaimed prior to request processing.');
          err.code = 'LEASE_LOST';
          err.retryable = false;
          throw err;
        }
        return true;
      }
    };

    const res = await dispatchFn(dispatchLease);

    if (renewalFailed) {
      console.warn(`[DISPATCH LEASE RENEWAL WARNING] Lease renewal failed during dispatch for lease ${lease.leaseId}`);
    }

    return res;
  } finally {
    if (leaseRenewTimer) {
      clearInterval(leaseRenewTimer);
    }
    try {
      if (typeof db.releaseDispatchLease === 'function') {
        await db.releaseDispatchLease(recipientIgUserId, lease.leaseId);
        console.log(`[STAGE: DISPATCH_LEASE_RELEASED]`, JSON.stringify({
          lease_id: lease.leaseId
        }));
      }
    } catch (releaseErr) {
      console.error(`[DISPATCH LEASE RELEASE ERROR] Failed to release dispatch lease safely:`, releaseErr.message);
    }
  }
}

// Deliver final resource helper (guaranteed idempotent)
async function deliverFinalResource({
  recipientIgUserId,
  senderIgsid,
  automation,
  tokenData,
  flow,
  commentId,
  prefixMessage,
  workerId,
  options = {}
}) {
  const stateKey = `${automation.id}:${recipientIgUserId}:${senderIgsid}`;
  const now = new Date();
  const workerToken = workerId || `delivery_worker_${crypto.randomUUID()}`;
  const deliveryLeaseMs = Number(options.deliveryLeaseMs) || 60000; // Configurable lease (default 60s)
  const deliveryHeartbeatIntervalMs = Number(options.deliveryHeartbeatIntervalMs) || Math.min(15000, Math.floor(deliveryLeaseMs / 2));
  const leaseExpiresAt = new Date(now.getTime() + deliveryLeaseMs);

  // Safety check: ensure account was not deleted while delivery was queued or in-flight
  if (db.collections && db.collections().instagramAccounts) {
    const accountAlive = await db.collections().instagramAccounts.countDocuments({
      $or: [
        { instagram_user_id: recipientIgUserId },
        { id: recipientIgUserId }
      ]
    });
    if (!accountAlive) {
      console.warn(`[DELIVERY DELETION GUARD] Instagram account was deleted while delivery was in-flight (account_ref: ${automationTimeline.hashCorrelationId(recipientIgUserId)}, state_ref: ${automationTimeline.hashCorrelationId(stateKey)}). Aborting dispatch.`);
      return { success: false, skipped: true, reason: 'ACCOUNT_DELETED' };
    }
  }

  // Concurrency guard 1: In-memory lock
  if (processingDeliveryKeys.has(stateKey)) {
    console.log(`[CONCURRENCY] Resource delivery already in progress (state_ref: ${automationTimeline.hashCorrelationId(stateKey)}). Skipping duplicate.`);
    return;
  }
  processingDeliveryKeys.add(stateKey);

  let deliveryHeartbeat = null;
  function startDeliveryHeartbeat() {
    if (deliveryHeartbeat) return;
    deliveryHeartbeat = setInterval(async () => {
      try {
        const curNow = new Date();
        const renewedExpiry = new Date(curNow.getTime() + deliveryLeaseMs);
        if (db.collections && db.collections().conversationStates) {
          const res = await db.collections().conversationStates.updateOne(
            {
              key: stateKey,
              delivery_worker_id: workerToken,
              delivery_state: 'sending',
              delivery_locked_until: { $gt: curNow }
            },
            {
              $set: {
                delivery_locked_until: renewedExpiry,
                delivery_lease_renewed_at: curNow.toISOString(),
                updated_at: curNow.toISOString()
              }
            }
          );
          if (res.matchedCount === 0) {
            console.warn(`[DELIVERY LEASE LOSS] Worker lost delivery lease (state_ref: ${automationTimeline.hashCorrelationId(stateKey)})`);
            stopDeliveryHeartbeat();
          }
        }
      } catch (err) {
        console.warn(`[DELIVERY HEARTBEAT] Error renewing lease (state_ref: ${automationTimeline.hashCorrelationId(stateKey)}):`, err.message);
      }
    }, deliveryHeartbeatIntervalMs);
    if (deliveryHeartbeat.unref) deliveryHeartbeat.unref();
  }

  function stopDeliveryHeartbeat() {
    if (deliveryHeartbeat) {
      clearInterval(deliveryHeartbeat);
      deliveryHeartbeat = null;
    }
  }

  try {
    // Concurrency guard 2: Atomic database state claim with recovery from expired leases
    if (db.collections && db.collections().conversationStates) {
      await db.collections().conversationStates.updateOne(
        { key: stateKey },
        {
          $setOnInsert: {
            key: stateKey,
            automation_id: automation.id,
            owner_user_id: automation.owner_user_id,
            instagram_user_id: recipientIgUserId,
            sender_igsid: senderIgsid,
            resource_delivered: false,
            delivery_state: 'not_started',
            state: 'INIT',
            created_at: now.toISOString()
          }
        },
        { upsert: true }
      );

      // Atomic lease claim: only claim if not already delivered (neither sent nor delivered=true)
      // AND eligible: either not_started/failed/null OR previously sending with expired lease AND undispatched
      // CRITICAL: An expired lease where delivery_request_dispatched is true must transition to 'unknown' and never be automatically resent!
      const claimResult = await db.collections().conversationStates.findOneAndUpdate(
        {
          key: stateKey,
          resource_delivered: { $ne: true },
          delivery_state: { $nin: ['sent', 'unknown'] },
          $or: [
            { delivery_state: { $in: ['not_started', 'failed', null] } },
            {
              delivery_state: 'sending',
              delivery_locked_until: { $lt: now },
              delivery_request_dispatched: { $ne: true }
            }
          ]
        },
        {
          $set: {
            delivery_state: 'sending',
            delivery_worker_id: workerToken,
            delivery_locked_until: leaseExpiresAt,
            delivery_request_dispatched: false,
            sending_started_at: now.toISOString(),
            updated_at: now.toISOString()
          }
        },
        { returnDocument: 'after' }
      );

      const claimedDoc = claimResult?.value || claimResult;
      if (!claimedDoc || claimedDoc.delivery_worker_id !== workerToken) {
        // Inspect existing state for crash recovery of in-flight dispatches:
        const checkDoc = await db.collections().conversationStates.findOne({ key: stateKey });
        if (checkDoc && checkDoc.delivery_state === 'sending' && checkDoc.delivery_request_dispatched === true && new Date(checkDoc.delivery_locked_until) < now) {
          // Worker crashed or lease expired after Meta dispatch! Outcome is uncertain!
          await db.collections().conversationStates.updateOne(
            { key: stateKey, delivery_state: 'sending', delivery_worker_id: checkDoc.delivery_worker_id },
            {
              $set: {
                delivery_state: 'unknown',
                delivery_locked_until: null,
                last_delivery_error: 'Worker crashed or lease expired after Meta delivery request was dispatched',
                updated_at: new Date().toISOString()
              }
            }
          );
          console.warn(`[DELIVERY UNCERTAIN] Marked state_ref=${automationTimeline.hashCorrelationId(stateKey)} as unknown: previous worker lease expired after request was dispatched.`);
          return { success: false, reason: 'UNKNOWN_OUTCOME' };
        }

        if (checkDoc && (checkDoc.delivery_state === 'unknown' || checkDoc.delivery_state === 'sent' || checkDoc.resource_delivered === true)) {
          console.log(`[IDEMPOTENCY] Resource delivery ${checkDoc.delivery_state} (state_ref: ${automationTimeline.hashCorrelationId(stateKey)}). Skipping.`);
          return { success: checkDoc.delivery_state === 'sent', reason: checkDoc.delivery_state };
        }

        console.log(`[IDEMPOTENCY] Resource delivery already claimed, in progress or completed (state_ref: ${automationTimeline.hashCorrelationId(stateKey)}). Skipping.`);
        return { success: false, reason: 'IN_PROGRESS' };
      }
    }

    // Start active delivery lease renewal heartbeat
    startDeliveryHeartbeat();

    // Check monthly DM quota entitlement
    try {
      const dmCheck = await billing.check(automation.owner_user_id, 'dmMonthly');
      if (!dmCheck.allowed) {
        console.warn(`[BILLING] Monthly DM quota exceeded for owner ${automation.owner_user_id} (${dmCheck.used}/${dmCheck.limits.dmMonthly}). Skipping outbound delivery.`);
        return { success: false, skipped: true, reason: 'DM_QUOTA_EXCEEDED' };
      }
    } catch (bErr) {
      console.warn('Billing check note in deliverFinalResource:', bErr.message);
    }

    let deliveryText = flow.delivery?.message || automation.dm_message || "Here's what you requested! Enjoy ✨";
    if (prefixMessage) {
      deliveryText = `${prefixMessage.trim()}\n\n${deliveryText}`;
    }
    let resourceUrl = flow.delivery?.resourceUrl;
    if (!resourceUrl && flow.delivery?.resourceId) {
      try {
        resourceUrl = await storageService.getResourceAccessUrl(automation.owner_user_id, flow.delivery.resourceId);
      } catch (_) {}
    }
    const buttonText = (flow.delivery?.buttonText || "Open Link ↗").trim().slice(0, 20);

    // Free branding attribution if not white-label
    try {
      const userEntitlement = options?.entitlement || await billing.entitlement(automation.owner_user_id, options);
      if (!userEntitlement?.limits?.whiteLabel) {
        if (!deliveryText.includes('Powered by Comment2DM')) {
          deliveryText += '\n\n⚡ Powered by Comment2DM';
        }
      }
    } catch (_) {}

    // Format delivery payload: interactive button if URL is valid, clean text fallback
    let deliveryPayload;
    if (resourceUrl && /^https?:\/\//i.test(resourceUrl)) {
      const textWithLink = deliveryText.includes(resourceUrl) ? deliveryText : `${deliveryText}\n\n🔗 ${resourceUrl}`;
      deliveryPayload = {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'button',
            text: textWithLink,
            buttons: [
              {
                type: 'web_url',
                url: resourceUrl,
                title: buttonText
              }
            ]
          }
        }
      };
    } else {
      if (resourceUrl) {
        deliveryText += `\n\n🔗 ${buttonText}: ${resourceUrl}`;
      }
      deliveryPayload = { text: deliveryText };
    }

    // Mark delivery request as dispatched immediately before initiating outbound socket write
    if (db.collections && db.collections().conversationStates) {
      await db.collections().conversationStates.updateOne(
        { key: stateKey, delivery_worker_id: workerToken, delivery_state: 'sending' },
        {
          $set: {
            delivery_request_dispatched: true,
            delivery_dispatched_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }
        }
      );
    }

    console.log(`[STAGE: META_REQUEST_STARTED]`, JSON.stringify({
      auto_ref: automationTimeline.hashCorrelationId(automation.id),
      account_ref: automationTimeline.hashCorrelationId(recipientIgUserId),
      method: 'POST'
    }));

    let metaSendResult;
    const outboundResult = await safeDispatchOutbound(recipientIgUserId, workerToken, async (dispatchLease) => {
      automationTimeline.recordTimelineStage({
        stage: 'META_REQUEST_STARTED',
        duration_ms: 0,
        job_id: options?.context?.job_id || options?.context?.event_key || null,
        automation_id: automation.id,
        instagram_account_id: recipientIgUserId,
        event_type: options?.context?.event_type || 'messaging_postback',
        success: true
      });
      const metaStart = Date.now();
      try {
        metaSendResult = await instagramService.sendDirectMessage(
          recipientIgUserId,
          senderIgsid,
          deliveryPayload,
          tokenData.accessToken
        );
        const metaDuration = Date.now() - metaStart;
        automationTimeline.recordTimelineStage({
          stage: 'FINAL_MESSAGE_SENT',
          duration_ms: metaDuration,
          job_id: options?.context?.job_id || options?.context?.event_key || null,
          automation_id: automation.id,
          instagram_account_id: recipientIgUserId,
          event_type: options?.context?.event_type || 'messaging_postback',
          success: true,
          status_code: 200
        });
      } catch (dmErr) {
        // 1. Rate-limit errors: release lease, mark failed for retry, and rethrow
        if (dmErr.statusCode === 429 || dmErr?.metaError?.code === 4 || dmErr?.metaError?.code === 17 || dmErr?.metaError?.code === 32 || dmErr?.metaError?.code === 613) {
          if (db.collections && db.collections().conversationStates) {
            await db.collections().conversationStates.updateOne(
              { key: stateKey, delivery_worker_id: workerToken },
              { $set: { delivery_state: 'failed', delivery_locked_until: null, last_delivery_error: dmErr.message, updated_at: new Date().toISOString() } }
            );
          }
          throw dmErr;
        }

        // 2. Messaging window expiration (permanent failure: recipient must interact first)
        const errorCategory = metaRateLimiter.classifyMetaError(dmErr).category;
        if (errorCategory === 'MESSAGING_WINDOW') {
          console.warn(`[DELIVERY WINDOW EXPIRED] 24-hr messaging window closed (state_ref: ${automationTimeline.hashCorrelationId(stateKey)}). User must interact first.`);
          if (db.collections && db.collections().conversationStates) {
            await db.collections().conversationStates.updateOne(
              { key: stateKey, delivery_worker_id: workerToken },
              { $set: { delivery_state: 'failed_permanent', delivery_locked_until: null, last_delivery_error: dmErr.message, updated_at: new Date().toISOString() } }
            );
          }
          throw dmErr;
        }

        // 3. Unknown outcome (network timeout while awaiting response, socket hangup, connection drop)
        const isUnknownOutcome = dmErr?.uncertainDelivery === true ||
          dmErr?.requestDispatched === true ||
          dmErr?.name === 'TimeoutError' ||
          dmErr?.name === 'AbortError' ||
          /timeout|socket hang up|econnreset|esockettimedout|network timeout|fetch failed|aborted/i.test(dmErr.message || '') ||
          dmErr.statusCode === 504 || dmErr.status === 504;

        if (isUnknownOutcome) {
          console.warn(`[DELIVERY UNCERTAIN] Meta send outcome uncertain (state_ref: ${automationTimeline.hashCorrelationId(stateKey)}): ${dmErr.message}`);
          if (db.collections && db.collections().conversationStates) {
            await db.collections().conversationStates.updateOne(
              { key: stateKey, delivery_worker_id: workerToken },
              {
                $set: {
                  delivery_state: 'unknown',
                  delivery_locked_until: null,
                  last_delivery_error: dmErr.message,
                  updated_at: new Date().toISOString()
                }
              }
            );
          }
          throw dmErr;
        }

        // 3. Graceful fallback to text ONLY if template was definitely rejected by format error (400)
        const isTemplateFormatRejection = (dmErr.statusCode === 400 || dmErr?.metaError?.code === 100) &&
          deliveryPayload.attachment &&
          (/template|button|attachment|format/i.test(dmErr.message || '') || /template|button|attachment|format/i.test(dmErr?.metaError?.message || ''));

        if (isTemplateFormatRejection) {
          let fallbackText = deliveryText;
          if (resourceUrl && !fallbackText.includes(resourceUrl)) {
            fallbackText += `\n\n🔗 ${buttonText}: ${resourceUrl}`;
          }
          try {
            if (dispatchLease && typeof dispatchLease.assertValid === 'function') {
              const isValid = await dispatchLease.assertValid();
              if (isValid === false) {
                const leaseLostErr = new Error('Dispatch lease expired or reclaimed prior to fallback send');
                leaseLostErr.code = 'LEASE_LOST';
                leaseLostErr.retryable = false;
                throw leaseLostErr;
              }
            }
            metaSendResult = await instagramService.sendDirectMessage(
              recipientIgUserId,
              senderIgsid,
              { text: fallbackText },
              tokenData.accessToken
            );
          } catch (fallbackErr) {
            const isFallbackUnknown = fallbackErr?.uncertainDelivery === true ||
              fallbackErr?.requestDispatched === true ||
              /timeout|socket hang up|econnreset|esockettimedout|network timeout|fetch failed/i.test(fallbackErr.message || '') ||
              fallbackErr.statusCode === 504 || fallbackErr.status === 504;

            if (db.collections && db.collections().conversationStates) {
              await db.collections().conversationStates.updateOne(
                { key: stateKey, delivery_worker_id: workerToken },
                {
                  $set: {
                    delivery_state: isFallbackUnknown ? 'unknown' : 'failed',
                    delivery_locked_until: null,
                    last_delivery_error: fallbackErr.message,
                    updated_at: new Date().toISOString()
                  }
                }
              );
            }
            throw fallbackErr;
          }
        } else {
          if (db.collections && db.collections().conversationStates) {
            await db.collections().conversationStates.updateOne(
              { key: stateKey, delivery_worker_id: workerToken },
              { $set: { delivery_state: 'failed', delivery_locked_until: null, last_delivery_error: dmErr.message, updated_at: new Date().toISOString() } }
            );
          }
          throw dmErr;
        }
      }
    }, {
      stage: 'FINAL_RESOURCE_LEASE_ACQUIRED',
      job_id: options?.context?.job_id || options?.context?.event_key || null,
      automation_id: automation.id,
      event_type: options?.context?.event_type || 'messaging_postback'
    });

    if (outboundResult && outboundResult.reason === 'ACCOUNT_DELETED') {
      return outboundResult;
    }

    // 4. Require explicit Meta confirmation (message_id / id)
    const metaMsgId = metaSendResult?.message_id || metaSendResult?.id || null;
    if (!metaMsgId) {
      console.warn(`[DELIVERY UNCONFIRMED] Meta response did not include message_id (state_ref: ${automationTimeline.hashCorrelationId(stateKey)})`);
      if (db.collections && db.collections().conversationStates) {
        await db.collections().conversationStates.updateOne(
          { key: stateKey, delivery_worker_id: workerToken },
          {
            $set: {
              delivery_state: 'unknown',
              delivery_locked_until: null,
              last_delivery_error: 'Meta response missing message_id confirmation',
              updated_at: new Date().toISOString()
            }
          }
        );
      }
      if (db.collections && db.collections().automationEvents) {
        try {
          await db.collections().automationEvents.insertOne({
            event_id: crypto.randomUUID(),
            owner_user_id: automation.owner_user_id,
            instagram_user_id: recipientIgUserId,
            automation_id: automation.id,
            from_id: senderIgsid,
            event_type: 'resource_delivered',
            delivery_channel: 'private_dm',
            message_text: typeof deliveryText !== 'undefined' ? deliveryText : 'Resource Delivery',
            resource_url: resourceUrl || null,
            status: 'unknown',
            error_message: 'Meta response missing message_id confirmation',
            created_at: new Date().toISOString(),
            created_at_date: new Date()
          });
        } catch (_) {}
      }
      return;
    }

    // 5. Only mark "sent" and resource_delivered=true AFTER Meta confirms acceptance AND lease is unexpired!
    if (db.collections && db.collections().conversationStates) {
      const stateUpdateRes = await db.collections().conversationStates.updateOne(
        {
          key: stateKey,
          delivery_worker_id: workerToken,
          delivery_state: 'sending',
          delivery_locked_until: { $gt: new Date() } // Must still hold active unexpired lease
        },
        {
          $set: {
            delivery_state: 'sent',
            resource_delivered: true,
            state: 'RESOURCE_DELIVERED',
            meta_message_id: metaMsgId,
            delivery_locked_until: null,
            delivered_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }
        }
      );
      if (stateUpdateRes.matchedCount === 0) {
        console.warn(`[DELIVERY LEASE LOSS] Stale worker lost delivery lease (state_ref: ${automationTimeline.hashCorrelationId(stateKey)})`);
        return { success: false, reason: 'LEASE_LOST' };
      }
    }

    console.log(`[STAGE: META_REQUEST_COMPLETED]`, JSON.stringify({
      auto_ref: automationTimeline.hashCorrelationId(automation.id),
      account_ref: automationTimeline.hashCorrelationId(recipientIgUserId),
      meta_message_id: metaMsgId,
      delivery_result: 'DELIVERED'
    }));

    // Log in automation_events
    if (db.collections && db.collections().automationEvents) {
      await db.collections().automationEvents.insertOne({
        event_id: crypto.randomUUID(),
        owner_user_id: automation.owner_user_id,
        instagram_user_id: recipientIgUserId,
        automation_id: automation.id,
        from_id: senderIgsid,
        event_type: 'resource_delivered',
        delivery_channel: 'private_dm',
        message_text: deliveryText,
        resource_url: resourceUrl || null,
        status: 'success',
        meta_message_id: metaMsgId,
        created_at: new Date().toISOString(),
        created_at_date: new Date()
      });
    } else if (db.run) {
      try {
        await db.run(
          'INSERT INTO automation_events (owner_user_id, instagram_user_id, automation_id, from_id, event_type, message_text, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [automation.owner_user_id, recipientIgUserId, automation.id, senderIgsid, 'resource_delivered', deliveryText, 'success', new Date().toISOString()]
        );
      } catch (_) {}
    }
  } catch (deliveryErr) {
    const isUnknownOutcome = deliveryErr?.uncertainDelivery === true ||
      deliveryErr?.requestDispatched === true ||
      deliveryErr?.category === 'UNKNOWN_OUTCOME' ||
      /timeout|socket hang up|econnreset|esockettimedout|network timeout|fetch failed|aborted/i.test(deliveryErr?.message || '');
    const cleanErrMsg = String(deliveryErr?.message || 'Outbound delivery failed').replace(/EA[A-Za-z0-9_-]{20,}/g, '[REDACTED_TOKEN]');

    if (db.collections && db.collections().automationEvents) {
      try {
        await db.collections().automationEvents.insertOne({
          event_id: crypto.randomUUID(),
          owner_user_id: automation.owner_user_id,
          instagram_user_id: recipientIgUserId,
          automation_id: automation.id,
          from_id: senderIgsid,
          event_type: 'resource_delivered',
          delivery_channel: 'private_dm',
          message_text: typeof deliveryText !== 'undefined' ? deliveryText : (automation.dm_message || 'Resource Delivery'),
          resource_url: typeof resourceUrl !== 'undefined' ? resourceUrl : null,
          status: isUnknownOutcome ? 'unknown' : 'failed',
          error_message: cleanErrMsg,
          created_at: new Date().toISOString(),
          created_at_date: new Date()
        });
      } catch (_) {}
    }
    throw deliveryErr;
  } finally {
    stopDeliveryHeartbeat();
    const cleanupTimer = setTimeout(() => {
      processingDeliveryKeys.delete(stateKey);
    }, 15000);
    if (cleanupTimer.unref) cleanupTimer.unref();
  }
}

// ========================================== 
// Webhook Job Processing & Execution Engine
// ========================================== 

async function executeCommentJob(job) {
  const recipientIgUserId = job.instagram_account_id;
  const commentId = job.comment_id;
  const commentText = job.comment_text || job.text || '';
  const fromId = job.from_id;
  const fromUsername = job.from_username;
  const commentMediaId = job.media_id || '';

  // 1. Fast check if comment was already replied to in automationEvents
  if (db.collections && db.collections().automationEvents) {
    const alreadyDone = await db.collections().automationEvents.findOne({
      comment_id: commentId,
      status: 'success'
    });
    if (alreadyDone) {
      console.log(`[DEDUP] Skipping comment (cmt_ref: ${automationTimeline.hashCorrelationId(commentId)}): already successfully replied.`);
      return { success: true, skipped: true, reason: 'ALREADY_REPLIED' };
    }
  }

  // 2. Fetch active automations for creator
  let activeAutomations = [];
  if (db.collections && db.collections().automations) {
    activeAutomations = await db.collections().automations.find({
      instagram_user_id: recipientIgUserId,
      enabled: { $in: [true, 1, '1'] }
    }).toArray();
  } else {
    activeAutomations = await db.all(
      'SELECT * FROM automations WHERE instagram_user_id = ? AND enabled = 1',
      [recipientIgUserId]
    );
  }

  if (!activeAutomations || activeAutomations.length === 0) {
    console.log(`No active automations found for Instagram account (account_ref: ${automationTimeline.hashCorrelationId(recipientIgUserId)})`);
    return;
  }

  // 3. Prioritize automations matching this specific Reel/Post first, then fallback to general
  const matchedMediaAutos = activeAutomations.filter((auto) => {
    if (auto.media_id && commentMediaId) {
      const autoMediaIdStr = String(auto.media_id);
      return commentMediaId.includes(autoMediaIdStr) || autoMediaIdStr.includes(commentMediaId);
    }
    return !auto.media_id;
  });

  matchedMediaAutos.sort((a, b) => {
    if (a.media_id && !b.media_id) return -1;
    if (!a.media_id && b.media_id) return 1;
    return new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0);
  });

  let selectedAuto = null;
  for (const candidate of matchedMediaAutos) {
    if (keywordMatches(commentText, candidate.keyword, candidate.trigger_type)) {
      selectedAuto = candidate;
      break;
    }
  }

  if (!selectedAuto) {
    console.log(`[TRIGGER] No matching automation keyword for comment (cmt_ref: ${automationTimeline.hashCorrelationId(commentId)}).`);
    return;
  }

  automationTimeline.recordTimelineStage({
    stage: 'AUTOMATION_CONFIG_RETRIEVED',
    duration_ms: 0,
    job_id: job.job_id || job.event_key || null,
    automation_id: selectedAuto.id,
    instagram_account_id: recipientIgUserId,
    event_type: 'comment',
    success: true
  });

  // 4. Durable Opening DM Idempotency Claim before sending opening DM
  const claimKey = `${recipientIgUserId}:${commentId}:${selectedAuto.id}`;
  const workerToken = job?.worker_id || `comment_worker_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
  const now = new Date();
  const claimLeaseExpiry = new Date(now.getTime() + 60000); // 60s lease
  let requestDispatched = false;

  if (db.collections && db.collections().openingDmClaims) {
    const claimsCol = db.collections().openingDmClaims;

    // Check existing claim state
    const existingClaim = await claimsCol.findOne({ claim_key: claimKey });
    if (existingClaim) {
      if (existingClaim.status === 'sent') {
        console.log(`[DEDUP] Opening DM already sent for comment (cmt_ref: ${automationTimeline.hashCorrelationId(commentId)}, auto_ref: ${automationTimeline.hashCorrelationId(selectedAuto.id)}). Skipping.`);
        return { success: true, skipped: true, reason: 'ALREADY_SENT', meta_message_id: existingClaim.meta_message_id };
      }
      if (existingClaim.status === 'unknown') {
        console.warn(`[IDEMPOTENCY] Opening DM for comment (cmt_ref: ${automationTimeline.hashCorrelationId(commentId)}) has unknown delivery outcome. Never blindly resending.`);
        return {
          success: false,
          skipped: true,
          status: 'unknown',
          reason: 'UNKNOWN_OUTCOME',
          error: `Opening DM delivery outcome unknown for comment ${commentId} (${claimKey}). Never blindly resending.`
        };
      }
      if (existingClaim.status === 'failed_permanent' || (existingClaim.status === 'failed' && existingClaim.retryable === false)) {
        console.log(`[IDEMPOTENCY] Opening DM for comment (cmt_ref: ${automationTimeline.hashCorrelationId(commentId)}) previously failed permanently. Skipping.`);
        return {
          success: false,
          skipped: true,
          status: 'failed_permanent',
          reason: 'FAILED_PERMANENT',
          error: `Opening DM delivery previously failed permanently for comment ${commentId}: ${existingClaim.last_error || 'Permanent failure'}`
        };
      }
    }

    // Upsert default 'pending' state if missing
    await claimsCol.updateOne(
      { claim_key: claimKey },
      {
        $setOnInsert: {
          claim_key: claimKey,
          instagram_account_id: recipientIgUserId,
          comment_id: commentId,
          automation_id: selectedAuto.id,
          status: 'pending',
          request_dispatched: false,
          created_at: now
        }
      },
      { upsert: true }
    );

    // Atomic claim via findOneAndUpdate:
    // Can claim if:
    // 1. status is 'pending' or 'failed_retryable'
    // OR
    // 2. status is 'processing' AND locked_until is expired (< now) AND request_dispatched is NOT true
    const claimRes = await claimsCol.findOneAndUpdate(
      {
        claim_key: claimKey,
        status: { $nin: ['sent', 'unknown', 'failed_permanent'] },
        $or: [
          { status: { $in: ['pending', 'failed_retryable'] } },
          {
            status: 'processing',
            locked_until: { $lt: now },
            request_dispatched: { $ne: true }
          }
        ]
      },
      {
        $set: {
          status: 'processing',
          worker_id: workerToken,
          locked_until: claimLeaseExpiry,
          request_dispatched: false,
          claiming_started_at: now,
          updated_at: now
        }
      },
      { returnDocument: 'after' }
    );

    const claimedDoc = claimRes?.value || claimRes;
    if (!claimedDoc || claimedDoc.worker_id !== workerToken) {
      // Check if this was an expired lease where request_dispatched was true:
      const checkDoc = await claimsCol.findOne({ claim_key: claimKey });
      if (checkDoc && checkDoc.status === 'processing' && checkDoc.request_dispatched === true && new Date(checkDoc.locked_until) < now) {
        // Outcome uncertain because request was dispatched before crash! Mark unknown!
        await claimsCol.updateOne(
          {
            claim_key: claimKey,
            status: 'processing',
            worker_id: checkDoc.worker_id,
            locked_until: { $lt: now }
          },
          {
            $set: {
              status: 'unknown',
              locked_until: null,
              worker_id: null,
              previous_worker_id: checkDoc.worker_id,
              last_error: 'Worker crashed or lease expired after HTTP request was dispatched',
              updated_at: new Date()
            }
          }
        );
        console.warn(`[IDEMPOTENCY UNCERTAIN] Marked claim_ref=${automationTimeline.hashCorrelationId(claimKey)} as unknown: previous worker lease expired after request dispatch.`);
        return {
          success: false,
          skipped: true,
          status: 'unknown',
          reason: 'UNKNOWN_OUTCOME',
          error: `Opening DM delivery outcome unknown: previous worker lease expired after request was dispatched (${claimKey}).`
        };
      }

      if (checkDoc && checkDoc.status === 'sent') {
        console.log(`[DEDUP] Opening DM already sent for comment (cmt_ref: ${automationTimeline.hashCorrelationId(commentId)}). Skipping.`);
        return { success: true, skipped: true, reason: 'ALREADY_SENT' };
      }
      if (checkDoc && checkDoc.status === 'unknown') {
        return {
          success: false,
          skipped: true,
          status: 'unknown',
          reason: 'UNKNOWN_OUTCOME',
          error: `Opening DM outcome unknown for comment ${commentId}. Never blindly resending.`
        };
      }
      if (checkDoc && (checkDoc.status === 'failed_permanent' || (checkDoc.status === 'failed' && checkDoc.retryable === false))) {
        return {
          success: false,
          skipped: true,
          status: 'failed_permanent',
          reason: 'FAILED_PERMANENT',
          error: `Opening DM failed permanently for comment ${commentId}.`
        };
      }

      console.log(`[IDEMPOTENCY] Opening DM delivery already in progress or claimed by another worker (claim_ref: ${automationTimeline.hashCorrelationId(claimKey)}). Skipping.`);
      return { success: false, skipped: true, status: 'concurrent_claim', reason: 'IN_PROGRESS' };
    }
  }

  console.log(`[TRIGGER] Matched automation (auto_ref: ${automationTimeline.hashCorrelationId(selectedAuto.id)}, cmt_ref: ${automationTimeline.hashCorrelationId(commentId)}). Sending interactive opening DM...`);

  try {
    // Check monthly DM quota entitlement
    try {
      const dmCheck = await billing.check(selectedAuto.owner_user_id, 'dmMonthly');
      if (!dmCheck.allowed) {
        console.warn(`[BILLING] Monthly DM quota exceeded for owner ${selectedAuto.owner_user_id} (${dmCheck.used}/${dmCheck.limits.dmMonthly}). Skipping opening DM.`);
        return { success: false, skipped: true, reason: 'DM_QUOTA_EXCEEDED' };
      }
    } catch (bErr) {
      console.warn('Billing check note in executeCommentJob:', bErr.message);
    }

    // Ensure flow is loaded
    if (!selectedAuto.flow && db.collections && db.collections().automations) {
      const raw = await db.collections().automations.findOne({ id: selectedAuto.id });
      if (raw && raw.flow) {
        selectedAuto.flow = raw.flow;
      }
    }

    const tokenData = await instagramService.getDecryptedTokenByInstagramUserId(recipientIgUserId, selectedAuto.owner_user_id);
    const flow = selectedAuto.flow || {};
    const isFollowGateEnabled = Boolean(flow.followGate?.enabled);

    console.log(`[STAGE: COMMENT_RECEIVED]`, JSON.stringify({
      auto_ref: automationTimeline.hashCorrelationId(selectedAuto.id),
      job_ref: automationTimeline.hashCorrelationId(job.job_id || job.event_key),
      account_ref: automationTimeline.hashCorrelationId(recipientIgUserId),
      follow_gate_enabled: isFollowGateEnabled
    }));

    // Prepare opening message text
    let messageToSend = flow.openingMessage || selectedAuto.dm_message || "Hey! I'm so glad you're here — thanks for your interest 😊\n\nTap below or reply 'LINK' and I'll send you the link in just a moment ✨";

    if (fromUsername) {
      messageToSend = messageToSend.replace(/\{username\}/gi, `@${fromUsername}`);
      messageToSend = messageToSend.replace(/\{name\}/gi, fromUsername);
      messageToSend = messageToSend.replace(/\{first_name\}/gi, fromUsername);
    }

    // Plan-based Free Branding Attribution
    try {
      const userEntitlement = await billing.entitlement(selectedAuto.owner_user_id, job);
      if (!userEntitlement?.limits?.whiteLabel) {
        if (!messageToSend.includes('Powered by Comment2DM')) {
          messageToSend += '\n\n⚡ Powered by Comment2DM';
        }
      }
    } catch (bErr) {
      console.warn('Billing entitlement check note:', bErr.message);
    }

    const openingBtnTitle = (flow.openingButtonText || 'Send me the link').trim().slice(0, 20);
    const msgPayload = {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'button',
          text: messageToSend,
          buttons: [
            {
              type: 'postback',
              title: openingBtnTitle,
              payload: `SEND_LINK:${selectedAuto.id}:${commentId}`
            }
          ]
        }
      }
    };

    // Record request dispatch state before network call
    requestDispatched = true;
    if (db.collections && db.collections().openingDmClaims) {
      const dispatchRes = await db.collections().openingDmClaims.updateOne(
        {
          claim_key: claimKey,
          worker_id: workerToken,
          status: 'processing',
          locked_until: { $gt: new Date() }
        },
        { $set: { request_dispatched: true, dispatched_at: new Date(), updated_at: new Date() } }
      );
      if (dispatchRes.matchedCount === 0) {
        const leaseLostErr = new Error(`Worker ${workerToken} lost claim lease before dispatch for ${claimKey}`);
        leaseLostErr.category = 'LEASE_LOST';
        leaseLostErr.retryable = false;
        throw leaseLostErr;
      }
    }

    // Safety check & outbound lease coordination
    let sendResult;
    const outboundResult = await safeDispatchOutbound(recipientIgUserId, workerToken, async () => {
      // 1. Send Interactive Private DM
      automationTimeline.recordTimelineStage({
        stage: 'META_REQUEST_STARTED',
        duration_ms: 0,
        job_id: job.job_id || job.event_key || null,
        automation_id: selectedAuto.id,
        instagram_account_id: recipientIgUserId,
        event_type: 'comment',
        success: true
      });
      const metaStart = Date.now();
      sendResult = await instagramService.sendPrivateReply(
        recipientIgUserId,
        commentId,
        msgPayload,
        tokenData.accessToken
      );
      const metaDuration = Date.now() - metaStart;
      automationTimeline.recordTimelineStage({
        stage: 'META_RESPONSE_RECEIVED',
        duration_ms: metaDuration,
        job_id: job.job_id || job.event_key || null,
        automation_id: selectedAuto.id,
        instagram_account_id: recipientIgUserId,
        event_type: 'comment',
        success: true,
        status_code: 200
      });
      return sendResult;
    }, {
      stage: 'OPENING_DM_LEASE_ACQUIRED',
      job_id: job.job_id || job.event_key || null,
      automation_id: selectedAuto.id,
      event_type: 'comment'
    });

    if (outboundResult && outboundResult.reason === 'ACCOUNT_DELETED') {
      console.warn(`[WORKER DELETION GUARD] Instagram account was deleted or undergoing deletion (account_ref: ${automationTimeline.hashCorrelationId(recipientIgUserId)}). Aborting dispatch.`);
      return outboundResult;
    }

    const metaMsgId = sendResult?.message_id || sendResult?.id || null;

    if (!metaMsgId) {
      console.warn(`[OPENING DM UNCONFIRMED] Meta response missing message_id (claim_ref: ${automationTimeline.hashCorrelationId(claimKey)})`);
      if (db.collections && db.collections().openingDmClaims) {
        await db.collections().openingDmClaims.updateOne(
          {
            claim_key: claimKey,
            worker_id: workerToken,
            status: 'processing'
          },
          {
            $set: {
              status: 'unknown',
              locked_until: null,
              last_error: 'Meta response missing message_id confirmation',
              updated_at: new Date()
            }
          }
        );
      }
      const unconfirmedErr = new Error(`Meta response missing message_id confirmation for opening DM on ${claimKey}`);
      unconfirmedErr.category = 'UNKNOWN_OUTCOME';
      unconfirmedErr.retryable = false;
      throw unconfirmedErr;
    }

    // Persist claim as confirmed 'sent'
    if (db.collections && db.collections().openingDmClaims) {
      const successRes = await db.collections().openingDmClaims.updateOne(
        {
          claim_key: claimKey,
          worker_id: workerToken,
          status: 'processing'
        },
        {
          $set: {
            status: 'sent',
            meta_message_id: metaMsgId,
            locked_until: null,
            sent_at: new Date(),
            completed_at: new Date(),
            updated_at: new Date()
          }
        }
      );
      if (successRes.matchedCount === 0) {
        console.warn(`[STALE WORKER] Worker delivered opening DM (claim_ref: ${automationTimeline.hashCorrelationId(claimKey)}), but claim was no longer in processing state. Preserving existing claim status.`);
      }
    }

    // 2. Initialize conversation state
    const stateKey = `${selectedAuto.id}:${recipientIgUserId}:${fromId || commentId}`;
    if (db.collections && db.collections().conversationStates) {
      await db.collections().conversationStates.updateOne(
        { key: stateKey },
        {
          $set: {
            key: stateKey,
            automation_id: selectedAuto.id,
            owner_user_id: selectedAuto.owner_user_id,
            instagram_user_id: recipientIgUserId,
            comment_id: commentId,
            commenter_id: fromId,
            sender_igsid: fromId,
            commenter_username: fromUsername,
            state: 'OPENING_DM_SENT',
            button_title: openingBtnTitle,
            follow_gate_required: isFollowGateEnabled,
            resource_delivered: false,
            delivery_state: 'not_started',
            meta_message_id: metaMsgId,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }
        },
        { upsert: true }
      );
    }

    // 3. Record automation event for PRIVATE DM immediately!
    if (db.collections && db.collections().automationEvents) {
      await db.collections().automationEvents.insertOne({
        event_id: crypto.randomUUID(),
        owner_user_id: selectedAuto.owner_user_id,
        instagram_user_id: recipientIgUserId,
        automation_id: selectedAuto.id,
        comment_id: commentId,
        from_username: fromUsername,
        from_id: fromId,
        comment_text: commentText,
        event_type: 'private_reply',
        delivery_channel: 'private_dm',
        keyword: selectedAuto.keyword,
        message_text: messageToSend,
        button_text: openingBtnTitle,
        interactive: true,
        status: 'success',
        meta_message_id: metaMsgId,
        created_at: new Date().toISOString(),
        created_at_date: new Date()
      });
    } else {
      await db.run(
        'INSERT INTO automation_events (owner_user_id, instagram_user_id, automation_id, comment_id, event_type, keyword, message_text, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [selectedAuto.owner_user_id, recipientIgUserId, selectedAuto.id, commentId, 'private_reply', selectedAuto.keyword, messageToSend, 'success', new Date().toISOString()]
      );
    }
    console.log(`[TRIGGER SUCCESS] Successfully sent opening DM (cmt_ref: ${automationTimeline.hashCorrelationId(commentId)})`);

    // 4. Send Public Comment Reply in an isolated try/catch (if configured)
    if (selectedAuto.reply_template) {
      try {
        await safeDispatchOutbound(recipientIgUserId, workerToken, async (dispatchLease) => {
          const publicReplyResult = await instagramService.replyToComment(
            commentId,
            selectedAuto.reply_template,
            tokenData.accessToken
          );
          if (db.collections && db.collections().automationEvents) {
            await db.collections().automationEvents.insertOne({
              event_id: crypto.randomUUID(),
              owner_user_id: selectedAuto.owner_user_id,
              instagram_user_id: recipientIgUserId,
              automation_id: selectedAuto.id,
              comment_id: commentId,
              from_username: fromUsername,
              from_id: fromId,
              comment_text: commentText,
              event_type: 'public_reply',
              delivery_channel: 'public_comment',
              message_text: selectedAuto.reply_template,
              status: 'success',
              meta_comment_id: publicReplyResult?.id || null,
              created_at: new Date().toISOString(),
              created_at_date: new Date()
            });
          }
          return publicReplyResult;
        }, {
          stage: 'PUBLIC_REPLY_LEASE_ACQUIRED',
          job_id: job.job_id || job.event_key || null,
          automation_id: selectedAuto.id,
          event_type: 'comment'
        });
      } catch (publicErr) {
        console.warn(`[PUBLIC REPLY NOTE] Public comment reply failed for comment (cmt_ref: ${automationTimeline.hashCorrelationId(commentId)}): ${publicErr.message}`);
        if (publicErr.statusCode === 429) {
          metaRateLimiter.pauseAccount(recipientIgUserId, publicErr.retryAfterSeconds || 60, 'Public reply rate limit', db);
        }
        if (db.collections && db.collections().automationEvents) {
          await db.collections().automationEvents.insertOne({
            event_id: crypto.randomUUID(),
            owner_user_id: selectedAuto.owner_user_id,
            instagram_user_id: recipientIgUserId,
            automation_id: selectedAuto.id,
            comment_id: commentId,
            from_username: fromUsername,
            from_id: fromId,
            comment_text: commentText,
            event_type: 'public_reply',
            delivery_channel: 'public_comment',
            message_text: selectedAuto.reply_template,
            status: 'failed',
            error: String(publicErr.message).replace(/EA[A-Za-z0-9_-]{20,}/g, '[REDACTED_TOKEN]'),
            created_at: new Date().toISOString(),
            created_at_date: new Date()
          });
        }
      }
    }
  } catch (apiErr) {
    const classification = metaRateLimiter.classifyMetaError(apiErr);

    let targetClaimStatus;
    let isRetryableClaim;

    if (requestDispatched) {
      // POST-DISPATCH: Request was transmitted to Meta.
      if (classification.category === 'RATE_LIMITED') {
        targetClaimStatus = 'failed_retryable';
        isRetryableClaim = true;
      } else if (classification.category === 'UNKNOWN_OUTCOME') {
        targetClaimStatus = 'unknown';
        isRetryableClaim = false;
        apiErr.category = 'UNKNOWN_OUTCOME';
        apiErr.retryable = false;
      } else if (classification.category === 'PERMISSION_OR_AUTH' ||
                 classification.category === 'INVALID_RECIPIENT' ||
                 classification.category === 'INVALID_REQUEST' ||
                 classification.category === 'MESSAGING_WINDOW') {
        targetClaimStatus = 'failed_permanent';
        isRetryableClaim = false;
      } else {
        // Any timeout, ECONNRESET, socket drop, lost response, 5xx, or unconfirmed outcome post-dispatch:
        // Must become unknown and NEVER automatically resent!
        targetClaimStatus = 'unknown';
        isRetryableClaim = false;
        apiErr.category = 'UNKNOWN_OUTCOME';
        apiErr.retryable = false;
      }
    } else {
      // PRE-DISPATCH: Known to have failed before sending across the wire to Meta.
      if (classification.category === 'PERMISSION_OR_AUTH' ||
          classification.category === 'INVALID_RECIPIENT' ||
          classification.category === 'INVALID_REQUEST' ||
          classification.retryable === false) {
        targetClaimStatus = 'failed_permanent';
        isRetryableClaim = false;
      } else {
        // Temporary network or DB glitch before dispatch: safe to retry!
        targetClaimStatus = 'failed_retryable';
        isRetryableClaim = true;
      }
    }

    if (db.collections && db.collections().openingDmClaims) {
      const failRes = await db.collections().openingDmClaims.updateOne(
        {
          claim_key: claimKey,
          worker_id: workerToken,
          status: 'processing'
        },
        {
          $set: {
            status: targetClaimStatus,
            locked_until: null,
            last_error: apiErr.message,
            retryable: isRetryableClaim,
            retry_after: isRetryableClaim ? (classification.backoffMs || 2000) : null,
            updated_at: new Date()
          }
        }
      );
      if (failRes.matchedCount === 0) {
        console.warn(`[STALE WORKER] Worker failed for claim_ref: ${automationTimeline.hashCorrelationId(claimKey)}, but claim was no longer in processing state. Preserving existing claim status.`);
      }
    }

    const isUnknownOutcome = targetClaimStatus === 'unknown' ||
      classification.category === 'UNKNOWN_OUTCOME' ||
      apiErr?.category === 'UNKNOWN_OUTCOME';
    const finalEventStatus = isUnknownOutcome ? 'unknown' : 'failed';
    const sanitizedError = String(apiErr.message || 'Dispatch failed').replace(/EA[A-Za-z0-9_-]{20,}/g, '[REDACTED_TOKEN]');

    if (db.collections && db.collections().automationEvents) {
      await db.collections().automationEvents.insertOne({
        event_id: crypto.randomUUID(),
        owner_user_id: selectedAuto.owner_user_id,
        instagram_user_id: recipientIgUserId,
        automation_id: selectedAuto.id,
        comment_id: commentId,
        from_username: fromUsername,
        from_id: fromId,
        comment_text: commentText,
        event_type: 'private_reply',
        delivery_channel: 'private_dm',
        keyword: selectedAuto.keyword,
        message_text: selectedAuto.dm_message,
        status: finalEventStatus,
        error_message: sanitizedError,
        created_at: new Date().toISOString(),
        created_at_date: new Date()
      });
    }
    console.error(`Failed to execute automation for comment (cmt_ref: ${automationTimeline.hashCorrelationId(commentId)}):`, apiErr.message);
    throw apiErr;
  }
}
async function executeMessagingJob(job) {
  const recipientIgUserId = job.instagram_account_id;
  const senderIgsid = job.from_id;
  const action = job.action;
  const autoId = job.automation_id;
  const commentId = job.comment_id;
  const payload = job.payload || '';
  const incomingText = job.message_text || '';

  console.log(`[MESSAGING] Interactive event: action="${action}", sender_ref="${automationTimeline.hashCorrelationId(senderIgsid)}", account_ref="${automationTimeline.hashCorrelationId(recipientIgUserId)}"`);

  if (action === 'UNKNOWN_POSTBACK') {
    console.warn(`[MESSAGING UNSUPPORTED] Unsupported button/postback payload from sender_ref=${automationTimeline.hashCorrelationId(senderIgsid)}. Safely ignored.`);
    return { success: true, handled: false, reason: 'UNSUPPORTED_POSTBACK' };
  }

  // 1. Restore conversation state
  let convState = null;
  let resolvedAutoId = autoId;
  let resolvedCommentId = commentId;

  if (db.collections && db.collections().conversationStates) {
    if (resolvedAutoId) {
      const directKey = `${resolvedAutoId}:${recipientIgUserId}:${senderIgsid}`;
      convState = await db.collections().conversationStates.findOne({
        $or: [
          { key: directKey },
          { automation_id: resolvedAutoId, sender_igsid: senderIgsid },
          { automation_id: resolvedAutoId, commenter_id: senderIgsid }
        ]
      });
    }

    if (!convState) {
      const pendingQuery = {
        instagram_user_id: recipientIgUserId,
        $or: [
          { sender_igsid: senderIgsid },
          { commenter_id: senderIgsid }
        ],
        resource_delivered: { $ne: true }
      };

      let pendingList = [];
      if (typeof db.collections().conversationStates.find === 'function') {
        const cursor = db.collections().conversationStates.find(pendingQuery);
        const sortCursor = cursor && typeof cursor.sort === 'function' ? cursor.sort({ updated_at: -1 }) : cursor;
        pendingList = typeof sortCursor?.toArray === 'function' ? await sortCursor.toArray() : (Array.isArray(sortCursor) ? sortCursor : []);
      }

      if (pendingList.length === 1) {
        // Exactly one pending conversation exists: deterministic & unambiguous
        convState = pendingList[0];
      } else if (pendingList.length > 1) {
        // Multiple pending conversations exist (e.g. user commented on Reel A and Reel B).
        // Try deterministic disambiguation using automation trigger keywords
        const matchedCandidates = [];
        for (const cand of pendingList) {
          let candAuto = null;
          if (cand.automation_id) {
            if (db.collections && db.collections().automations) {
              candAuto = await db.collections().automations.findOne({ id: cand.automation_id });
            }
            if (!candAuto && db.get) {
              try {
                candAuto = await db.get('SELECT * FROM automations WHERE id = ?', [cand.automation_id]);
              } catch (_) {}
            }
          }
          if (candAuto && incomingText && keywordMatches(incomingText, candAuto.keyword, candAuto.trigger_type)) {
            const isWildcard = !candAuto.keyword || candAuto.keyword.trim() === '*' || candAuto.keyword.trim().toLowerCase() === 'all';
            if (!isWildcard) {
              matchedCandidates.push({ candidate: cand, auto: candAuto });
            }
          }
        }

        if (matchedCandidates.length === 1) {
          convState = matchedCandidates[0].candidate;
          console.log(`[CONVERSATION DISAMBIGUATED] Disambiguated multiple pending conversations for sender_ref=${automationTimeline.hashCorrelationId(senderIgsid)} to auto_ref=${automationTimeline.hashCorrelationId(convState.automation_id)}.`);
        } else {
          // Cannot determine unambiguously (e.g. generic "LINK" message or multiple/zero matches).
          // MUST NOT deliver arbitrary resource or pick randomly.
          console.warn(`[AMBIGUOUS_CONVERSATION] Multiple pending automations found for sender_ref=${automationTimeline.hashCorrelationId(senderIgsid)} (${pendingList.length} pending conversations). Cannot unambiguously determine target resource. Halting safely to prevent arbitrary resource delivery.`);
          return {
            success: false,
            skipped: true,
            reason: 'AMBIGUOUS_CONVERSATION',
            candidate_count: pendingList.length
          };
        }
      } else {
        convState = await db.collections().conversationStates.findOne({
          instagram_user_id: recipientIgUserId,
          $or: [
            { sender_igsid: senderIgsid },
            { commenter_id: senderIgsid }
          ]
        }, { sort: { updated_at: -1 } });
      }
    }
  }

  if (convState) {
    resolvedAutoId = resolvedAutoId || convState.automation_id;
    resolvedCommentId = resolvedCommentId || convState.comment_id;
    console.log(`[CONVERSATION RESTORED] Restored conversation state for sender_ref=${automationTimeline.hashCorrelationId(senderIgsid)} (State: ${convState.state}, auto_ref: ${automationTimeline.hashCorrelationId(convState.automation_id)}, cmt_ref: ${automationTimeline.hashCorrelationId(resolvedCommentId)})`);
  }

  let effectiveAction = action;
  if (action === 'USER_RESPONSE') {
    if (convState?.state === 'OPENING_DM_SENT') {
      effectiveAction = 'SEND_LINK';
    } else if (convState?.state === 'FOLLOW_PROMPT_SENT' || convState?.state === 'FOLLOW_RETRY_PROMPT' || convState?.state === 'VERIFICATION_ERROR') {
      effectiveAction = 'CHECK_FOLLOW';
    } else {
      console.log(`[MESSAGING UNEXPECTED] User (sender_ref: ${automationTimeline.hashCorrelationId(senderIgsid)}) sent unexpected message. No automated dispatch warranted.`);
      return { success: true, handled: false, reason: 'UNEXPECTED_MESSAGE' };
    }
  }

  if (effectiveAction !== 'SEND_LINK' && effectiveAction !== 'CHECK_FOLLOW') {
    console.log(`[MESSAGING UNEXPECTED] Unhandled action "${effectiveAction}" for user (sender_ref: ${automationTimeline.hashCorrelationId(senderIgsid)}).`);
    return { success: true, handled: false, reason: 'UNEXPECTED_MESSAGE' };
  }

  let targetAutomation = null;
  if (resolvedAutoId) {
    if (db.collections && db.collections().automations) {
      targetAutomation = await db.collections().automations.findOne({ id: resolvedAutoId });
    }
    if (!targetAutomation && db.get) {
      try {
        targetAutomation = await db.get('SELECT * FROM automations WHERE id = ?', [resolvedAutoId]);
      } catch (_) {}
    }
  }

  if (!targetAutomation && !convState) {
    console.warn(`[CONVERSATION STATE MISSING] Missing conversation state and target automation for sender_ref=${automationTimeline.hashCorrelationId(senderIgsid)} on account_ref=${automationTimeline.hashCorrelationId(recipientIgUserId)}`);
    return { success: false, skipped: true, reason: 'CONVERSATION_STATE_MISSING' };
  }

  if (!targetAutomation) {
    if (db.collections && db.collections().automations) {
      targetAutomation = await db.collections().automations.findOne(
        { instagram_user_id: recipientIgUserId, enabled: { $in: [true, 1, '1'] } },
        { sort: { updated_at: -1 } }
      );
    }
    if (!targetAutomation && db.all) {
      try {
        const active = await db.all(
          'SELECT * FROM automations WHERE instagram_user_id = ? AND enabled = 1 ORDER BY updated_at DESC LIMIT 1',
          [recipientIgUserId]
        );
        targetAutomation = active?.[0];
      } catch (_) {}
    }
  }

  if (!targetAutomation) {
    console.warn(`[CONVERSATION STATE MISSING] No matching automation for account_ref=${automationTimeline.hashCorrelationId(recipientIgUserId)}`);
    return { success: false, skipped: true, reason: 'CONVERSATION_STATE_MISSING' };
  }

  if (String(targetAutomation.instagram_user_id) !== String(recipientIgUserId)) {
    console.log(`[ROUTING] Ignoring cross-account event: auto_ref=${automationTimeline.hashCorrelationId(targetAutomation.id)} belongs to account_ref=${automationTimeline.hashCorrelationId(targetAutomation.instagram_user_id)}, but delivered to account_ref=${automationTimeline.hashCorrelationId(recipientIgUserId)}`);
    return { success: false, skipped: true, reason: 'CROSS_ACCOUNT_EVENT' };
  }

  const tokenData = await instagramService.getDecryptedTokenByInstagramUserId(recipientIgUserId, targetAutomation.owner_user_id);
  const flow = targetAutomation.flow || {};
  const creatorUsername = tokenData.username || 'creator';
  const stateKey = `${targetAutomation.id}:${targetAutomation.instagram_user_id}:${senderIgsid}`;

  const logContext = {
    auto_ref: automationTimeline.hashCorrelationId(targetAutomation.id),
    job_ref: automationTimeline.hashCorrelationId(job.job_id || job.event_key),
    account_ref: automationTimeline.hashCorrelationId(recipientIgUserId),
    action: effectiveAction
  };

  console.log(`[STAGE: INCOMING_MESSAGE_RECEIVED]`, JSON.stringify(logContext));
  console.log(`[STAGE: CONVERSATION_STATE_CHECK]`, JSON.stringify({
    ...logContext,
    conversation_state_found: Boolean(convState),
    conversation_state: convState?.state || null,
    resource_delivered: convState?.resource_delivered || false
  }));

  if (convState && convState.resource_delivered === true) {
    console.log(`[IDEMPOTENCY] Resource already delivered (sender_ref: ${automationTimeline.hashCorrelationId(senderIgsid)}, auto_ref: ${automationTimeline.hashCorrelationId(targetAutomation.id)}). Ignoring duplicate trigger.`);
    return { success: true, skipped: true, reason: 'ALREADY_DELIVERED' };
  }

  const profileBtn = (flow.followGate?.profileBtnText || flow.followGate?.buttonText || "Visit Profile").trim().slice(0, 20);
  const confirmBtn = (flow.followGate?.confirmBtnText || flow.followGate?.checkButtonText || "I'm following ✅").trim().slice(0, 20);
  let profileUrl = flow.followGate?.profileUrl || `https://instagram.com/${creatorUsername}`;
  if (!profileUrl.startsWith('http')) {
    profileUrl = `https://instagram.com/${profileUrl.replace(/^@/, '')}`;
  }

  // Safety check: ensure account was not deleted while messaging job was queued or in-flight
  if (db.collections && db.collections().instagramAccounts) {
    const accountAlive = await db.collections().instagramAccounts.countDocuments({
      $or: [
        { instagram_user_id: recipientIgUserId },
        { id: recipientIgUserId }
      ]
    });
    if (!accountAlive) {
      console.warn(`[MESSAGING DELETION GUARD] Account was deleted while messaging job was in-flight (account_ref: ${automationTimeline.hashCorrelationId(recipientIgUserId)}). Aborting dispatch.`);
      return { success: false, skipped: true, reason: 'ACCOUNT_DELETED' };
    }
  }

  if (effectiveAction === 'SEND_LINK') {
    if (!flow.followGate?.enabled) {
      console.log(`[MESSAGING] Follow gate disabled. Delivering resource immediately (sender_ref: ${automationTimeline.hashCorrelationId(senderIgsid)})...`);
      await deliverFinalResource({ recipientIgUserId, senderIgsid, automation: targetAutomation, tokenData, flow, commentId: resolvedCommentId, workerId: job?.worker_id, options: { context: job } });
      return { success: true, delivered: true };
    }

    if (db.collections && db.collections().conversationStates) {
      await db.collections().conversationStates.updateOne(
        { key: stateKey },
        {
          $set: {
            key: stateKey,
            automation_id: targetAutomation.id,
            owner_user_id: targetAutomation.owner_user_id,
            instagram_user_id: recipientIgUserId,
            sender_igsid: senderIgsid,
            state: 'CHECKING_FOLLOW_STATUS',
            resource_delivered: false,
            updated_at: new Date().toISOString()
          }
        },
        { upsert: true }
      );
    }

    const followResult = await instagramService.checkFollowStatus(recipientIgUserId, senderIgsid, tokenData.accessToken);

    console.log(`[STAGE: FOLLOW_VERIFICATION]`, JSON.stringify({
      ...logContext,
      supported: followResult.supported,
      is_following: followResult.isFollowing,
      verified: followResult.verified,
      error: followResult.error || null
    }));

    if (followResult.isFollowing === true && followResult.verified === true) {
      console.log(`[MESSAGING] PATH A: Follow confirmed for sender_ref=${automationTimeline.hashCorrelationId(senderIgsid)}. Delivering resource immediately.`);
      await deliverFinalResource({ recipientIgUserId, senderIgsid, automation: targetAutomation, tokenData, flow, commentId: resolvedCommentId, workerId: job?.worker_id, options: { context: job } });
      return { success: true, delivered: true, follow_verified: true };
    } else if (followResult.supported === false || followResult.error || !followResult.verified) {
      console.warn(`[MESSAGING] Meta follow check unavailable or error: ${followResult.error || followResult.note}`);
      const retryNotice = "We couldn't verify your follow status right now due to a network or API delay. Please tap below to retry!";
      const retryPayload = {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'button',
            text: retryNotice,
            buttons: [
              { type: 'web_url', url: profileUrl, title: profileBtn },
              { type: 'postback', title: 'Retry Check 🔄'.slice(0, 20), payload: `CHECK_FOLLOW:${targetAutomation.id}:${resolvedCommentId || ''}` }
            ]
          }
        }
      };

      if (db.collections && db.collections().conversationStates) {
        await db.collections().conversationStates.updateOne(
          { key: stateKey },
          { $set: { state: 'VERIFICATION_ERROR', resource_delivered: false, updated_at: new Date().toISOString() } }
        );
      }

      let retryMetaResult = null;
      let retryError = null;
      await safeDispatchOutbound(recipientIgUserId, job?.worker_id, async (dispatchLease) => {
        try {
          retryMetaResult = await instagramService.sendDirectMessage(recipientIgUserId, senderIgsid, retryPayload, tokenData.accessToken);
        } catch (dmErr) {
          if (dispatchLease && typeof dispatchLease.assertValid === 'function') {
            await dispatchLease.assertValid();
          }
          try {
            retryMetaResult = await instagramService.sendDirectMessage(recipientIgUserId, senderIgsid, {
              text: `${retryNotice}\n\n👉 Profile: ${profileUrl}`,
              quick_replies: [{ content_type: 'text', title: 'Retry Check 🔄'.slice(0, 20), payload: `CHECK_FOLLOW:${targetAutomation.id}:${resolvedCommentId || ''}` }]
            }, tokenData.accessToken);
          } catch (fbErr) {
            retryError = fbErr;
            throw fbErr;
          }
        }
      });

      if (db.collections && db.collections().automationEvents) {
        const rMsgId = retryMetaResult?.message_id || retryMetaResult?.id || null;
        await db.collections().automationEvents.insertOne({
          event_id: crypto.randomUUID(),
          owner_user_id: targetAutomation.owner_user_id,
          instagram_user_id: recipientIgUserId,
          automation_id: targetAutomation.id,
          from_id: senderIgsid,
          event_type: 'verification_retry',
          delivery_channel: 'private_dm',
          message_text: retryNotice,
          status: rMsgId ? 'success' : (retryError ? 'failed' : 'unknown'),
          meta_message_id: rMsgId,
          error_message: retryError ? String(retryError.message).replace(/EA[A-Za-z0-9_-]{20,}/g, '[REDACTED_TOKEN]') : null,
          created_at: new Date().toISOString(),
          created_at_date: new Date()
        });
      }
      return { success: true, delivered: false, follow_prompt_sent: true, retry: true };
    } else {
      console.log(`[MESSAGING] PATH B: Follow not yet detected for sender_ref=${automationTimeline.hashCorrelationId(senderIgsid)}. Sending two-button follow prompt.`);
      const followPrompt = flow.followGate?.message || "Oops! Looks like you haven't followed me yet 👀\n\nIt would mean a lot if you could visit my profile and hit that follow button 😊";

      const followPromptPayload = {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'button',
            text: followPrompt,
            buttons: [
              { type: 'web_url', url: profileUrl, title: profileBtn },
              { type: 'postback', title: confirmBtn, payload: `CHECK_FOLLOW:${targetAutomation.id}:${resolvedCommentId || ''}` }
            ]
          }
        }
      };

      if (db.collections && db.collections().conversationStates) {
        await db.collections().conversationStates.updateOne(
          { key: stateKey },
          {
            $set: {
              key: stateKey,
              automation_id: targetAutomation.id,
              owner_user_id: targetAutomation.owner_user_id,
              instagram_user_id: recipientIgUserId,
              sender_igsid: senderIgsid,
              state: 'FOLLOW_PROMPT_SENT',
              resource_delivered: false,
              updated_at: new Date().toISOString()
            }
          },
          { upsert: true }
        );
      }

      let fpMetaResult = null;
      let fpError = null;
      await safeDispatchOutbound(recipientIgUserId, job?.worker_id, async (dispatchLease) => {
        try {
          fpMetaResult = await instagramService.sendDirectMessage(recipientIgUserId, senderIgsid, followPromptPayload, tokenData.accessToken);
        } catch (dmErr) {
          if (dispatchLease && typeof dispatchLease.assertValid === 'function') {
            await dispatchLease.assertValid();
          }
          try {
            fpMetaResult = await instagramService.sendDirectMessage(
              recipientIgUserId,
              senderIgsid,
              {
                text: `${followPrompt}\n\n👉 ${profileBtn}: ${profileUrl}`,
                quick_replies: [{ content_type: 'text', title: confirmBtn, payload: `CHECK_FOLLOW:${targetAutomation.id}:${resolvedCommentId || ''}` }]
              },
              tokenData.accessToken
            );
          } catch (fbErr) {
            fpError = fbErr;
            throw fbErr;
          }
        }
      });

      if (db.collections && db.collections().automationEvents) {
        const fpMsgId = fpMetaResult?.message_id || fpMetaResult?.id || null;
        await db.collections().automationEvents.insertOne({
          event_id: crypto.randomUUID(),
          owner_user_id: targetAutomation.owner_user_id,
          instagram_user_id: recipientIgUserId,
          automation_id: targetAutomation.id,
          from_id: senderIgsid,
          event_type: 'follow_prompt',
          delivery_channel: 'private_dm',
          message_text: followPrompt,
          status: fpMsgId ? 'success' : (fpError ? 'failed' : 'unknown'),
          meta_message_id: fpMsgId,
          error_message: fpError ? String(fpError.message).replace(/EA[A-Za-z0-9_-]{20,}/g, '[REDACTED_TOKEN]') : null,
          created_at: new Date().toISOString(),
          created_at_date: new Date()
        });
      }
      return { success: true, delivered: false, follow_prompt_sent: true };
    }
  } else if (effectiveAction === 'CHECK_FOLLOW') {
    if (db.collections && db.collections().conversationStates) {
      await db.collections().conversationStates.updateOne(
        { key: stateKey },
        { $set: { state: 'CHECKING_FOLLOW_STATUS', updated_at: new Date().toISOString() } }
      );
    }

    console.log(`[MESSAGING] Fresh follower check on user tap for sender_ref=${automationTimeline.hashCorrelationId(senderIgsid)}...`);
    const followStart = Date.now();
    const recheckResult = await instagramService.checkFollowStatus(recipientIgUserId, senderIgsid, tokenData.accessToken);
    const followDuration = Date.now() - followStart;
    automationTimeline.recordTimelineStage({
      stage: 'FOLLOW_VERIFICATION_COMPLETED',
      duration_ms: followDuration,
      job_id: job.job_id || job.event_key || null,
      automation_id: targetAutomation.id,
      instagram_account_id: recipientIgUserId,
      event_type: 'messaging_postback',
      success: Boolean(recheckResult && recheckResult.isFollowing && recheckResult.verified),
      status_code: 200
    });

    console.log(`[STAGE: FOLLOW_VERIFICATION]`, JSON.stringify({
      ...logContext,
      supported: recheckResult.supported,
      is_following: recheckResult.isFollowing,
      verified: recheckResult.verified,
      error: recheckResult.error || null
    }));

    if (recheckResult.isFollowing === true && recheckResult.verified === true) {
      console.log(`[MESSAGING] Follower confirmed for sender_ref=${automationTimeline.hashCorrelationId(senderIgsid)}. Delivering resource.`);
      const successPrefix = flow.followGate?.successMessage || "You're all set! 🎉\n\nHere is your requested guide:";
      await deliverFinalResource({
        recipientIgUserId,
        senderIgsid,
        automation: targetAutomation,
        tokenData,
        flow,
        commentId: resolvedCommentId,
        prefixMessage: successPrefix,
        workerId: job?.worker_id,
        options: { context: job }
      });
      return { success: true, delivered: true, follow_verified: true };
    } else if (recheckResult.supported === false || recheckResult.error || !recheckResult.verified) {
      console.warn(`[MESSAGING] Meta follower recheck error: ${recheckResult.error || recheckResult.note}`);
      const retryNotice = "We couldn't verify your follow status right now due to a network or API delay. Please tap below to retry!";
      const retryPayload = {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'button',
            text: retryNotice,
            buttons: [
              { type: 'web_url', url: profileUrl, title: profileBtn },
              { type: 'postback', title: 'Retry Check 🔄'.slice(0, 20), payload: `CHECK_FOLLOW:${targetAutomation.id}:${resolvedCommentId || ''}` }
            ]
          }
        }
      };

      if (db.collections && db.collections().conversationStates) {
        await db.collections().conversationStates.updateOne(
          { key: stateKey },
          { $set: { state: 'VERIFICATION_ERROR', resource_delivered: false, updated_at: new Date().toISOString() } }
        );
      }

      let checkRetryResult = null;
      let checkRetryErr = null;
      await safeDispatchOutbound(recipientIgUserId, job?.worker_id, async (dispatchLease) => {
        try {
          checkRetryResult = await instagramService.sendDirectMessage(recipientIgUserId, senderIgsid, retryPayload, tokenData.accessToken);
        } catch (_) {
          if (dispatchLease && typeof dispatchLease.assertValid === 'function') {
            await dispatchLease.assertValid();
          }
          try {
            checkRetryResult = await instagramService.sendDirectMessage(recipientIgUserId, senderIgsid, {
              text: `${retryNotice}\n\n👉 Profile: ${profileUrl}`,
              quick_replies: [{ content_type: 'text', title: 'Retry Check 🔄'.slice(0, 20), payload: `CHECK_FOLLOW:${targetAutomation.id}:${resolvedCommentId || ''}` }]
            }, tokenData.accessToken);
          } catch (fbErr) {
            checkRetryErr = fbErr;
            throw fbErr;
          }
        }
      });

      if (db.collections && db.collections().automationEvents) {
        const crMsgId = checkRetryResult?.message_id || checkRetryResult?.id || null;
        await db.collections().automationEvents.insertOne({
          event_id: crypto.randomUUID(),
          owner_user_id: targetAutomation.owner_user_id,
          instagram_user_id: recipientIgUserId,
          automation_id: targetAutomation.id,
          from_id: senderIgsid,
          event_type: 'verification_retry',
          delivery_channel: 'private_dm',
          message_text: retryNotice,
          status: crMsgId ? 'success' : (checkRetryErr ? 'failed' : 'unknown'),
          meta_message_id: crMsgId,
          error_message: checkRetryErr ? String(checkRetryErr.message).replace(/EA[A-Za-z0-9_-]{20,}/g, '[REDACTED_TOKEN]') : null,
          created_at: new Date().toISOString(),
          created_at_date: new Date()
        });
      }
      return { success: true, delivered: false, retry: true };
    } else {
      console.log(`[MESSAGING] Follow still not detected for sender_ref=${automationTimeline.hashCorrelationId(senderIgsid)}. Sending polite retry prompt.`);
      const retryMsg = flow.followGate?.retryMessage || "Still not seeing that follow yet! 👀 If you just hit follow, please wait a few seconds for Instagram to sync and tap below to retry.";

      const retryPromptPayload = {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'button',
            text: retryMsg,
            buttons: [
              { type: 'web_url', url: profileUrl, title: profileBtn },
              { type: 'postback', title: confirmBtn, payload: `CHECK_FOLLOW:${targetAutomation.id}:${resolvedCommentId || ''}` }
            ]
          }
        }
      };

      if (db.collections && db.collections().conversationStates) {
        await db.collections().conversationStates.updateOne(
          { key: stateKey },
          { $set: { state: 'FOLLOW_RETRY_PROMPT', resource_delivered: false, updated_at: new Date().toISOString() } }
        );
      }

      let followRetryResult = null;
      let followRetryErr = null;
      await safeDispatchOutbound(recipientIgUserId, job?.worker_id, async (dispatchLease) => {
        try {
          followRetryResult = await instagramService.sendDirectMessage(recipientIgUserId, senderIgsid, retryPromptPayload, tokenData.accessToken);
        } catch (_) {
          if (dispatchLease && typeof dispatchLease.assertValid === 'function') {
            await dispatchLease.assertValid();
          }
          try {
            followRetryResult = await instagramService.sendDirectMessage(recipientIgUserId, senderIgsid, {
              text: `${retryMsg}\n\n👉 Visit Profile: ${profileUrl}`,
              quick_replies: [{ content_type: 'text', title: confirmBtn, payload: `CHECK_FOLLOW:${targetAutomation.id}:${resolvedCommentId || ''}` }]
            }, tokenData.accessToken);
          } catch (fbErr) {
            followRetryErr = fbErr;
            throw fbErr;
          }
        }
      });

      if (db.collections && db.collections().automationEvents) {
        const frMsgId = followRetryResult?.message_id || followRetryResult?.id || null;
        await db.collections().automationEvents.insertOne({
          event_id: crypto.randomUUID(),
          owner_user_id: targetAutomation.owner_user_id,
          instagram_user_id: recipientIgUserId,
          automation_id: targetAutomation.id,
          from_id: senderIgsid,
          event_type: 'follow_retry_prompt',
          delivery_channel: 'private_dm',
          message_text: retryMsg,
          status: frMsgId ? 'success' : (followRetryErr ? 'failed' : 'unknown'),
          meta_message_id: frMsgId,
          error_message: followRetryErr ? String(followRetryErr.message).replace(/EA[A-Za-z0-9_-]{20,}/g, '[REDACTED_TOKEN]') : null,
          created_at: new Date().toISOString(),
          created_at_date: new Date()
        });
      }
      return { success: true, delivered: false, follow_retry_sent: true };
    }
  }
}

async function executeWebhookJob(job) {
  if (job.event_type === 'comment') {
    return await executeCommentJob(job);
  } else if (job.event_type && job.event_type.startsWith('messaging_')) {
    return await executeMessagingJob(job);
  }
}

let isDrainingQueue = false;
async function drainJobQueue() {
  console.warn('[DEPRECATED] drainJobQueue() is deprecated. The persistent webhookWorker is the sole consumer of webhook_jobs.');
  return 0;
}

app.locals.drainJobQueue = drainJobQueue;
app.locals.executeWebhookJob = executeWebhookJob;

app.post('/api/instagram/webhook', async (request, response) => {
  // 1. Validate Meta POST Signature (HMAC-SHA256 with META_APP_SECRET)
  const appSecret = process.env.META_APP_SECRET;
  const signatureHeader = request.headers['x-hub-signature-256'];
  const sigCheck = verifyWebhookSignature(request.rawBody, signatureHeader, appSecret);

  if (!sigCheck.valid) {
    return response.status(sigCheck.statusCode || 401).json({ error: sigCheck.error });
  }

  // 2. Validate payload structure
  const payload = request.body;
  if (!payload || payload.object !== 'instagram' || !Array.isArray(payload.entry)) {
    return response.status(400).json({ error: 'Malformed payload: object must be "instagram" with entry array.' });
  }

  // Raw telemetry logging (fire-and-forget, preserving existing behavior)
  if (db.collections && db.collections().webhookEvents) {
    db.collections().webhookEvents.insertOne({
      event_id: 'webhook_' + Date.now(),
      raw_payload: payload,
      received_at: new Date().toISOString(),
      processed_at: new Date().toISOString()
    }).catch(err => console.error('Failed to log raw webhook telemetry:', err.message));
  }

  // 3. Durable Event Ingestion to MongoDB webhook_jobs collection
  try {
    const ingestResult = await webhookJobQueue.ingestWebhookPayload(payload, db);

    // Notify persistent worker immediately if any fresh job was persisted
    if (ingestResult && ingestResult.count > 0) {
      webhookWorker.triggerImmediatePoll();
    }

    // 4. Return HTTP 200 ONLY after durable persistence succeeds
    // Ingestion is strictly decoupled from execution: the persistent webhookWorker
    // is the single consumer that claims and executes webhook_jobs.
    return response.status(200).json({
      status: 'ok',
      enqueued: ingestResult.count,
      duplicates: ingestResult.duplicates
    });
  } catch (err) {
    console.error('[INGEST ERROR] Webhook persistence failed:', err.message);
    // Non-2xx response so Meta knows to retry!
    return response.status(500).json({ error: 'Database persistence error. Webhook event not enqueued.' });
  }
});

// ==========================================
// Analytics & Admin
// ==========================================

function buildOwnerClauses(userId) {
  const clauses = [{ owner_user_id: String(userId) }, { owner_user_id: userId }];
  if (!isNaN(Number(userId))) clauses.push({ owner_user_id: Number(userId) });
  if (/^[a-f0-9]{24}$/i.test(String(userId))) {
    try {
      const { ObjectId } = require('mongodb');
      clauses.push({ owner_user_id: new ObjectId(String(userId)) });
    } catch (_) {}
  }
  return clauses;
}

function buildIgClauses(igUserId) {
  const clauses = [{ instagram_user_id: String(igUserId) }];
  if (!isNaN(Number(igUserId))) clauses.push({ instagram_user_id: Number(igUserId) });
  return clauses;
}

app.get('/api/analytics/overview', requireAuth, async (request, response, next) => {
  try {
    const ownerId = request.user.id;
    const days = request.query.days === 'all' ? 'all' : (parseInt(request.query.days, 10) || 30);
    const requestedIgUserId = String(request.query.instagram_user_id || '').trim();

    const ownerClauses = buildOwnerClauses(ownerId);
    const igClauses = requestedIgUserId ? buildIgClauses(requestedIgUserId) : [];

    let targetAccount = null;
    if (requestedIgUserId) {
      if (db.collections && db.collections().instagramAccounts) {
        targetAccount = await db.collections().instagramAccounts.findOne({
          $and: [
            { $or: ownerClauses },
            { $or: igClauses }
          ]
        });
        if (!targetAccount) {
          targetAccount = await db.collections().instagramAccounts.findOne({ $or: igClauses });
        }
      } else {
        targetAccount = await db.get(
          'SELECT * FROM instagram_accounts WHERE owner_user_id = ? AND instagram_user_id = ?',
          [ownerId, requestedIgUserId]
        );
      }
      if (!targetAccount) {
        return response.status(403).json({ error: 'Unauthorized: Instagram account does not belong to user.' });
      }
    }

    let accountsCount = 0;
    let activeAutomationsCount = 0;
    let sent = 0;
    let failed = 0;
    let commentsCount = 0;
    let dailyDms = [];
    let leaderboard = [];
    let recent = [];

    const isMongo = Boolean(db.collections && db.collections().automationEvents);

    if (isMongo) {
      const colEvents = db.collections().automationEvents;
      const colAutos = db.collections().automations;
      const colAccounts = db.collections().instagramAccounts;

      // 1. Account count
      if (colAccounts) {
        accountsCount = await colAccounts.countDocuments({ $or: ownerClauses });
      }

      // 2. Active automations count
      if (colAutos) {
        const autoFilter = {
          $and: [
            { $or: ownerClauses },
            { enabled: { $in: [true, 1, '1', 'true'] } }
          ]
        };
        if (requestedIgUserId) {
          autoFilter.$and.push({ $or: igClauses });
        }
        activeAutomationsCount = await colAutos.countDocuments(autoFilter);
      }

      // 3. Event base filter
      const eventAndClauses = [{ $or: ownerClauses }];
      if (requestedIgUserId) {
        eventAndClauses.push({ $or: igClauses });
      }
      if (days !== 'all' && Number(days) > 0) {
        const since = new Date(Date.now() - Number(days) * 86400 * 1000).toISOString();
        eventAndClauses.push({ created_at: { $gte: since } });
      }
      const baseEventFilter = { $and: eventAndClauses };

      // 4. Direct Message filter: include all private DM types, strictly excluding public replies and webhooks
      const privateDmCriteria = {
        ...baseEventFilter,
        $or: [
          { delivery_channel: 'private_dm' },
          { event_type: { $in: ['private_reply', 'resource_delivered', 'follow_prompt', 'follow_retry_prompt', 'verification_retry'] } },
          { event_type: { $exists: false } },
          { event_type: null }
        ],
        event_type: { $ne: 'public_reply' },
        delivery_channel: { $ne: 'public_comment' }
      };

      const [countSent, countFailed, countUnknown, countCommentsRaw] = await Promise.all([
        colEvents.countDocuments({ ...privateDmCriteria, status: 'success' }),
        colEvents.countDocuments({ ...privateDmCriteria, status: 'failed' }),
        colEvents.countDocuments({ ...privateDmCriteria, status: 'unknown' }),
        colEvents.countDocuments({
          ...baseEventFilter,
          $or: [
            { event_type: 'comment_received' },
            { comment_id: { $exists: true, $ne: null } }
          ]
        })
      ]);

      sent = countSent;
      failed = countFailed;
      const totalDMsSent = countSent + countFailed;
      commentsCount = Math.max(countCommentsRaw, totalDMsSent);

      // 5. Leaderboard
      if (colAutos) {
        const autoListFilter = { $and: [{ $or: ownerClauses }] };
        if (requestedIgUserId) autoListFilter.$and.push({ $or: igClauses });
        const userAutos = await colAutos.find(autoListFilter).toArray();
        for (const auto of userAutos) {
          const autoSent = await colEvents.countDocuments({ automation_id: auto.id, ...privateDmCriteria, status: 'success' });
          const autoFailed = await colEvents.countDocuments({ automation_id: auto.id, ...privateDmCriteria, status: 'failed' });
          leaderboard.push({
            id: auto.id,
            name: auto.keyword ? `Keyword: ${auto.keyword}` : 'All Comments',
            account: auto.username || (targetAccount ? targetAccount.username : 'Connected Account'),
            sent: autoSent,
            total: autoSent + autoFailed,
            active: auto.enabled === true || auto.enabled === 1 || auto.enabled === '1'
          });
        }
      }

      // 6. Recent feed
      const recentEvents = await colEvents.find(baseEventFilter).sort({ created_at: -1 }).limit(20).toArray();
      recent = recentEvents.map(e => ({
        eventType: e.event_type || (e.delivery_channel === 'public_comment' ? 'public_reply' : 'private_reply'),
        status: e.status,
        keyword: e.keyword,
        messageText: e.message_text,
        errorMessage: e.error_message,
        fromUsername: e.from_username || e.username,
        createdAt: e.created_at
      }));

      // 7. Daily breakdown
      const allEventsForDaily = await colEvents.find(privateDmCriteria).toArray();
      const dateMap = {};
      for (const e of allEventsForDaily) {
        const d = String(e.created_at || '').slice(0, 10);
        if (!d) continue;
        if (!dateMap[d]) dateMap[d] = { date: d, count: 0, messagesSent: 0, messagesFailed: 0 };
        if (e.status === 'success') {
          dateMap[d].count += 1;
          dateMap[d].messagesSent += 1;
        } else if (e.status === 'failed') {
          dateMap[d].messagesFailed += 1;
        }
      }
      dailyDms = Object.values(dateMap).sort((a, b) => a.date.localeCompare(b.date));

    } else {
      // SQLite fallback
      const [acctRow, autoRow, totalsRow, recentRows, dailyRows] = await Promise.all([
        db.get('SELECT COUNT(*) AS count FROM instagram_accounts WHERE owner_user_id = ?', [ownerId]),
        requestedIgUserId
          ? db.get('SELECT COUNT(*) AS count FROM automations WHERE owner_user_id = ? AND instagram_user_id = ? AND enabled = 1', [ownerId, requestedIgUserId])
          : db.get('SELECT COUNT(*) AS count FROM automations WHERE owner_user_id = ? AND enabled = 1', [ownerId]),
        requestedIgUserId
          ? db.get(`SELECT
              SUM(CASE WHEN event_type = 'comment_received' THEN 1 ELSE 0 END) AS comments,
              SUM(CASE WHEN (event_type IS NULL OR event_type NOT IN ('public_reply', 'comment_received')) AND status = 'success' THEN 1 ELSE 0 END) AS messagesSent,
              SUM(CASE WHEN (event_type IS NULL OR event_type NOT IN ('public_reply', 'comment_received')) AND status = 'failed' THEN 1 ELSE 0 END) AS messagesFailed,
              SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successfulEvents
              FROM automation_events WHERE owner_user_id = ? AND instagram_user_id = ?`, [ownerId, requestedIgUserId])
          : db.get(`SELECT
              SUM(CASE WHEN event_type = 'comment_received' THEN 1 ELSE 0 END) AS comments,
              SUM(CASE WHEN (event_type IS NULL OR event_type NOT IN ('public_reply', 'comment_received')) AND status = 'success' THEN 1 ELSE 0 END) AS messagesSent,
              SUM(CASE WHEN (event_type IS NULL OR event_type NOT IN ('public_reply', 'comment_received')) AND status = 'failed' THEN 1 ELSE 0 END) AS messagesFailed,
              SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successfulEvents
              FROM automation_events WHERE owner_user_id = ?`, [ownerId]),
        requestedIgUserId
          ? db.all(`SELECT event_type AS eventType, status, keyword, message_text AS messageText, error_message AS errorMessage, created_at AS createdAt
              FROM automation_events WHERE owner_user_id = ? AND instagram_user_id = ? ORDER BY created_at DESC LIMIT 20`, [ownerId, requestedIgUserId])
          : db.all(`SELECT event_type AS eventType, status, keyword, message_text AS messageText, error_message AS errorMessage, created_at AS createdAt
              FROM automation_events WHERE owner_user_id = ? ORDER BY created_at DESC LIMIT 20`, [ownerId]),
        requestedIgUserId
          ? db.all(`SELECT substr(created_at,1,10) AS date,
              SUM(CASE WHEN event_type = 'comment_received' THEN 1 ELSE 0 END) AS comments,
              SUM(CASE WHEN (event_type IS NULL OR event_type NOT IN ('public_reply', 'comment_received')) AND status = 'success' THEN 1 ELSE 0 END) AS messagesSent,
              SUM(CASE WHEN (event_type IS NULL OR event_type NOT IN ('public_reply', 'comment_received')) AND status = 'failed' THEN 1 ELSE 0 END) AS messagesFailed
              FROM automation_events WHERE owner_user_id = ? AND instagram_user_id = ? AND created_at >= datetime('now','-29 days')
              GROUP BY substr(created_at,1,10) ORDER BY date ASC`, [ownerId, requestedIgUserId])
          : db.all(`SELECT substr(created_at,1,10) AS date,
              SUM(CASE WHEN event_type = 'comment_received' THEN 1 ELSE 0 END) AS comments,
              SUM(CASE WHEN (event_type IS NULL OR event_type NOT IN ('public_reply', 'comment_received')) AND status = 'success' THEN 1 ELSE 0 END) AS messagesSent,
              SUM(CASE WHEN (event_type IS NULL OR event_type NOT IN ('public_reply', 'comment_received')) AND status = 'failed' THEN 1 ELSE 0 END) AS messagesFailed
              FROM automation_events WHERE owner_user_id = ? AND created_at >= datetime('now','-29 days')
              GROUP BY substr(created_at,1,10) ORDER BY date ASC`, [ownerId])
      ]);

      accountsCount = acctRow?.count || 0;
      activeAutomationsCount = autoRow?.count || 0;
      sent = Number(totalsRow?.messagesSent || 0);
      failed = Number(totalsRow?.messagesFailed || 0);
      commentsCount = Math.max(Number(totalsRow?.comments || 0), sent + failed);
      recent = recentRows || [];
      dailyDms = (dailyRows && dailyRows.length > 0)
        ? dailyRows.map(d => ({ date: d.date, count: Number(d.messagesSent || d.count || 0) }))
        : [];
    }

    const totalDMs = sent + failed;
    const deliveryRate = totalDMs > 0 ? Math.round((sent / totalDMs) * 100) : null;

    return response.json({
      dmsSent: sent,
      commentsProcessed: commentsCount,
      failed,
      totalDMs,
      deliveryRate,
      activeAutomations: activeAutomationsCount,
      dailyDms,
      automations: leaderboard,
      accounts: accountsCount,
      recent: recent || [],
      // Legacy compatibility
      comments: commentsCount,
      messagesSent: sent,
      messagesFailed: failed,
      successfulEvents: sent,
      daily: dailyDms
    });
  } catch (error) {
    return next(error);
  }
});

// ==========================================
// User Feedback & Feature Requests
// ==========================================
app.post('/api/feedback', requireAuth, async (request, response, next) => {
  try {
    const userId = request.user.id;
    const userEmail = request.user.email || '';
    const { category, subject, description } = request.body || {};

    const validCategories = ['Bug Report', 'Feature Request', 'UI/UX Improvement', 'General Feedback'];
    if (!category || !validCategories.includes(category)) {
      return response.status(400).json({ error: 'Please select a valid feedback category.' });
    }

    const cleanSubject = String(subject || '').trim();
    if (cleanSubject.length < 3 || cleanSubject.length > 150) {
      return response.status(400).json({ error: 'Subject must be between 3 and 150 characters.' });
    }

    const cleanDesc = String(description || '').trim();
    if (cleanDesc.length < 10 || cleanDesc.length > 2000) {
      return response.status(400).json({ error: 'Description must be between 10 and 2000 characters.' });
    }

    // Rate limiting: max 5 submissions per 10 minutes per user
    const col = db.collections ? db.collections().feedback : null;
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    if (col) {
      const recentCount = await col.countDocuments({
        user_id: userId,
        created_at: { $gte: tenMinutesAgo }
      });
      if (recentCount >= 5) {
        return response.status(429).json({ error: 'Feedback rate limit reached. Please wait a few minutes before submitting again.' });
      }

      // Duplicate prevention: check if identical subject submitted in last 2 minutes
      const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      const duplicate = await col.findOne({
        user_id: userId,
        category,
        subject: cleanSubject,
        created_at: { $gte: twoMinutesAgo }
      });
      if (duplicate) {
        return response.status(409).json({ error: 'You already submitted this feedback recently. Thank you!' });
      }

      await col.insertOne({
        id: crypto.randomUUID(),
        user_id: userId,
        user_email: userEmail,
        category,
        subject: cleanSubject,
        description: cleanDesc,
        status: 'new',
        created_at: new Date().toISOString()
      });
    }

    return response.json({
      success: true,
      message: 'Thank you for your feedback! Our team has received your submission.'
    });
  } catch (error) {
    return next(error);
  }
});

// Old overview stub removed in favor of VI Tech adminRoutes

// ==========================================
// Creator Studio AI & Support Chat
// ==========================================



const supportKnowledge = [
  { keys: ['hi', 'hello', 'hey'], answer: 'Hi! Welcome to Comment2DM Support. How can I assist you with your Instagram automations, account connection, or billing today?' },
  { keys: ['connect', 'instagram', 'meta', 'account'], answer: 'To connect Instagram: 1) Go to Instagram Accounts in the sidebar. 2) Click "Connect Instagram". 3) Authorize using your professional Meta account. Ensure you have Instagram Business Login permissions enabled.' },
  { keys: ['automation', 'keyword', 'comment', 'dm'], answer: 'Comment2DM triggers automatic DMs and public replies when someone comments on your Reels! Go to "Create Automation", select your account, choose your Reel, set the trigger keyword or select "All comments", and write your private DM and public reply.' },
  { keys: ['pricing', 'upgrade', 'plan', 'billing'], answer: 'Comment2DM offers 3 plans: Free (₹0/mo, 1 connected account, 2 active automations, 500 DMs, 150 MB storage), Pro (₹70/mo, 3 connected accounts, Unlimited active automations, 5,000 DMs, 1 GB storage, all-comment trigger, follow-to-unlock), and Elite (₹150/mo, 10 connected accounts, Unlimited active automations, 50,000 DMs, 5 GB storage, priority webhook queue, priority support). Manage your plan in Billing.' },
  { keys: ['help', 'contact', 'email'], answer: 'You can email our team directly at nudge.support360@gmail.com for priority help!' }
];

app.post('/api/support/chat', async (request, response) => {
  const rawMessage = typeof request.body?.message === 'string' ? request.body.message.trim().toLowerCase() : '';
  if (!rawMessage) return response.status(400).json({ error: 'Please enter a message.' });

  const match = supportKnowledge.find((item) => item.keys.some((k) => rawMessage.includes(k)));
  const reply = match ? match.answer : 'I am here to help you get the most out of Comment2DM. You can connect an Instagram account, set up comment-to-DM triggers, automate replies, or email support at nudge.support360@gmail.com.';

  return response.json({ reply, mode: 'support-agent' });
});

// ── Creator Studio AI ──────────────────────────────────────────────────────
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';

async function callGemini(prompt) {
  if (!GEMINI_KEY) return null;
  // Cost-effective supported model hierarchy: flash-first with graceful fallback to pro
  const models = ['gemini-1.5-flash', 'gemini-pro'];
  for (const model of models) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });
      const d = await r.json().catch(() => ({}));
      const text = d.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) return text;
    } catch (_) {}
  }
  return null;
}

function creatorFallback(type, body) {
  const { topic = '', tone = 'inspirational', count = 3, product = '', cta = '', niche = '' } = body || {};
  if (type === 'hooks') {
    const toneMap = {
      inspirational: [`Stop scrolling if you want to ${topic || 'change your life'}…`, `The ${topic || 'secret'} nobody tells you about…`, `I went from zero to ${topic || 'success'} in 30 days — here's how`, `What if I told you ${topic || 'this'} was easier than you think?`, `This changed everything for me 👇`],
      funny: [`POV: You discovered ${topic || 'the hack'} too late 😭`, `Me before vs after ${topic || 'this'} 💀`, `Nobody: Absolutely nobody: Me: ${topic || 'overthinking'}`, `Wait for the plot twist 😂`, `Things that hit different at 2am 👇`],
      educational: [`Here are 5 things about ${topic || 'this'} nobody talks about`, `The complete beginner's guide to ${topic || 'this'}`, `How to ${topic || 'get started'} in 60 seconds`, `${topic || 'This'} explained simply 🧵`, `The truth about ${topic || 'this'} (backed by data)`],
      controversial: [`Hot take: ${topic || "You're doing this wrong"}`, `Unpopular opinion about ${topic || 'this industry'}…`, `I'm tired of pretending ${topic || 'this'} works`, `The ${topic || 'advice'} everyone gives is wrong`, `Say it louder: ${topic || 'This needs to change'}`],
      emotional: [`This hit me harder than I expected 💔`, `For everyone struggling with ${topic || 'this'}…`, `Nobody prepared me for this moment`, `If you need to hear this today…`, `The day everything changed for me 🥺`]
    };
    return (toneMap[tone] || toneMap.inspirational).slice(0, count);
  }
  if (type === 'dm_script') {
    return `Hey! 👋 Thanks so much for commenting on my reel!\n\nI saw you were interested in ${product || 'what I shared'} — here's exactly what you need:\n\n✨ ${cta || 'Check the link below'}\n\nThis is something I put together specifically for people in your position. It's helped so many people already, and I think it could really make a difference for you too.\n\nLet me know if you have any questions — I'm happy to help! 🙌\n\n— [Your Name]`;
  }
  if (type === 'ideas') {
    return [
      { title: `5 mistakes most ${niche || 'creators'} make (and how to fix them)`, hook: 'I wish someone told me this sooner…', format: 'reel' },
      { title: `Day in the life of a ${niche || 'content creator'} — honest version`, hook: 'Nobody talks about THIS part', format: 'reel' },
      { title: `${niche || 'Industry'} trends you need to know in 2024`, hook: 'The landscape is changing fast. Here\'s what\'s next…', format: 'carousel' },
      { title: `How I grew my ${niche || 'account'} from 0 to 10K in 90 days`, hook: 'It wasn\'t what I expected', format: 'reel' },
      { title: `${niche || 'Creator'} tools I can\'t live without (honest review)`, hook: 'I tested 20+ tools so you don\'t have to', format: 'carousel' },
      { title: `Answering your most asked questions about ${niche || 'my journey'}`, hook: 'You asked, I\'m answering everything', format: 'story' },
      { title: `The ${niche || 'content'} strategy that actually works in 2024`, hook: 'Stop doing what doesn\'t work', format: 'carousel' }
    ];
  }
  return 'Generated content will appear here.';
}

const CREATOR_TOOL_CREDITS = {
  hooks: 10,
  dm_script: 15,
  ideas: 20,
  campaign: 25,
  growth_recommendations: 15
};

app.post('/api/creator/generate', requireAuth, async (request, response) => {
  // Creator Studio AI is marked as Under Development
  // External AI calls are suspended to protect creator budgets and 0 credits are deducted
  let creditStatus = { balance: 100 };
  try {
    creditStatus = await billing.getAiCreditBalance(request.user.id);
  } catch (_) {}

  return response.status(200).json({
    success: false,
    underDevelopment: true,
    message: 'Creator Studio AI is currently under active development. External AI requests are paused to ensure zero credit consumption.',
    creditsUsed: 0,
    creditsRemaining: creditStatus ? creditStatus.balance : 100
  });
});

// ── Reel Performance Analyzer Endpoints ─────────────────────────────────────
app.get('/api/creator/reels/performance', requireAuth, async (request, response) => {
  const instagramUserId = String(request.query.instagram_user_id || '').trim();
  if (!instagramUserId) {
    return response.status(400).json({ error: 'instagram_user_id query parameter is required.' });
  }

  // Mandatory account ownership check: throws 404/403 if unowned by request.user.id
  try {
    await instagramService.getDecryptedTokenForAccount(request.user.id, instagramUserId);
  } catch (authErr) {
    return response.status(authErr.statusCode || 403).json({ error: authErr.message });
  }

  try {
    const formula = request.query.formula || 'reach';
    const forceRefresh = request.query.force === 'true';
    const analysis = await instagramService.analyzeAccountReels(request.user.id, instagramUserId, { formula, forceRefresh });
    return response.json({ success: true, ...analysis });
  } catch (err) {
    console.error('[CREATOR_STUDIO] Reel performance error:', err.message);
    return response.status(err.statusCode || 500).json({ error: err.message || 'Failed to analyze Reels performance.' });
  }
});

app.get('/api/creator/reels/:mediaId/insights', requireAuth, async (request, response) => {
  const mediaId = String(request.params.mediaId || '').trim();
  const instagramUserId = String(request.query.instagram_user_id || '').trim();
  if (!instagramUserId) {
    return response.status(400).json({ error: 'instagram_user_id query parameter is required.' });
  }

  // Mandatory account ownership check
  try {
    await instagramService.getDecryptedTokenForAccount(request.user.id, instagramUserId);
  } catch (authErr) {
    return response.status(authErr.statusCode || 403).json({ error: authErr.message });
  }

  try {
    const forceRefresh = request.query.force === 'true';
    const insights = await instagramService.getReelInsights(request.user.id, instagramUserId, mediaId, forceRefresh);
    return response.json({ success: true, ...insights });
  } catch (err) {
    return response.status(err.statusCode || 500).json({ error: err.message || 'Failed to retrieve Reel insights.' });
  }
});

app.post('/api/creator/reels/analyze-manual', requireAuth, (request, response) => {
  try {
    const analysis = instagramService.analyzeManualReel(request.body || {});
    return response.json({ success: true, ...analysis });
  } catch (err) {
    return response.status(400).json({ error: err.message || 'Manual calculation failed.' });
  }
});

app.get('/api/creator/credits', requireAuth, async (request, response) => {
  try {
    const credits = await billing.getAiCreditBalance(request.user.id);
    return response.json({ success: true, ...credits });
  } catch (err) {
    return response.status(500).json({ error: err.message || 'Failed to fetch credits balance.' });
  }
});

// ── Contact form ────────────────────────────────────────────────────────────
app.post('/api/contact', async (request, response) => {
  const { name, email, subject, message } = request.body || {};
  if (!name || !email || !message) return response.status(400).json({ error: 'name, email and message are required' });
  try {
    if (db.collections && db.collections.contacts) {
      await db.collections.contacts.insertOne({ name: String(name).slice(0, 100), email: String(email).slice(0, 254), subject: String(subject || 'General').slice(0, 100), message: String(message).slice(0, 2000), created_at: new Date(), resolved: false });
    }
    return response.json({ success: true });
  } catch { return response.json({ success: true }); }
});

// ── Analytics Events for DM Log & Unified Activity ──────────────────────────
app.get('/api/analytics/events', requireAuth, async (request, response) => {
  try {
    const page = Math.max(1, parseInt(request.query.page) || 1);
    const limit = Math.min(50, parseInt(request.query.limit) || 20);
    const status = request.query.status || 'all';
    const days = request.query.days === 'all' ? 'all' : (parseInt(request.query.days) || 30);
    const search = String(request.query.search || '').trim();
    const requestedIgUserId = String(request.query.instagram_user_id || '').trim();

    const ownerClauses = buildOwnerClauses(request.user.id);
    const isMongo = Boolean(db.collections && db.collections().automationEvents);

    if (isMongo) {
      const col = db.collections().automationEvents;

      // Base query scoped to user and selected account + date window
      const baseAndClauses = [{ $or: ownerClauses }];
      if (requestedIgUserId) {
        baseAndClauses.push({ $or: buildIgClauses(requestedIgUserId) });
      }
      if (days !== 'all' && Number(days) > 0) {
        const since = new Date(Date.now() - Number(days) * 86400000).toISOString();
        baseAndClauses.push({ created_at: { $gte: since } });
      }

      // Direct Message filter: include all private DM event types, strictly excluding public replies and webhooks
      const privateDmCriteria = {
        $or: [
          { delivery_channel: 'private_dm' },
          { event_type: { $in: ['private_reply', 'resource_delivered', 'follow_prompt', 'follow_retry_prompt', 'verification_retry'] } },
          { event_type: { $exists: false } },
          { event_type: null }
        ],
        event_type: { $ne: 'public_reply' },
        delivery_channel: { $ne: 'public_comment' }
      };

      // Base filter for counting sent, failed, pending, unknown private DMs
      const baseFilter = {
        $and: [
          ...baseAndClauses,
          privateDmCriteria
        ]
      };

      // Filter for the paginated list (adds status & search) strictly for private DMs
      const listAndClauses = [
        ...baseAndClauses,
        privateDmCriteria
      ];

      if (status === 'sent' || status === 'success') {
        listAndClauses.push({ status: 'success' });
      } else if (status === 'failed') {
        listAndClauses.push({ status: 'failed' });
      } else if (status === 'pending') {
        listAndClauses.push({ status: { $in: ['pending', 'queued', 'processing'] } });
      } else if (status === 'unknown') {
        listAndClauses.push({ status: 'unknown' });
      }

      if (search) {
        listAndClauses.push({
          $or: [
            { from_username: { $regex: search, $options: 'i' } },
            { username: { $regex: search, $options: 'i' } },
            { comment_text: { $regex: search, $options: 'i' } },
            { message_text: { $regex: search, $options: 'i' } },
            { keyword: { $regex: search, $options: 'i' } }
          ]
        });
      }

      const listFilter = { $and: listAndClauses };

      const [events, listTotal, sent, failed, pending, unknown] = await Promise.all([
        col.find(listFilter).sort({ created_at: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
        col.countDocuments(listFilter),
        col.countDocuments({ ...baseFilter, status: 'success' }),
        col.countDocuments({ ...baseFilter, status: 'failed' }),
        col.countDocuments({ ...baseFilter, status: { $in: ['pending', 'queued', 'processing'] } }),
        col.countDocuments({ ...baseFilter, status: 'unknown' })
      ]);

      const total = sent + failed + pending;

      const mappedEvents = events.map(e => {
        const rawSender = e.from_username || e.username || e.from_id || e.instagram_user_id || 'Commenter';
        const cleanSender = String(rawSender).replace(/^@+/, '');
        let autoName = e.keyword ? `Keyword: ${e.keyword}` : 'Comment to DM';
        if (e.event_type === 'resource_delivered') autoName = 'Resource Delivery';
        else if (e.event_type === 'follow_prompt') autoName = 'Follow Verification Prompt';
        else if (e.event_type === 'follow_retry_prompt') autoName = 'Follow Retry Prompt';
        else if (e.event_type === 'verification_retry') autoName = 'Verification Error Retry';

        return {
          id: e.event_id || e._id,
          senderName: cleanSender,
          username: cleanSender,
          commentText: e.comment_text || (e.keyword ? `Keyword: "${e.keyword}"` : 'Comment'),
          dmPreview: e.message_text || '–',
          dmText: e.message_text || '–',
          buttonText: e.button_text || null,
          automationName: autoName,
          status: e.status === 'success' ? 'sent' : e.status,
          errorMessage: e.error_message || null,
          timestamp: e.created_at,
          created_at: e.created_at,
          createdAt: e.created_at
        };
      });

      return response.json({
        events: mappedEvents,
        total,
        sent,
        failed,
        pending,
        unknown,
        listTotal,
        pages: Math.max(1, Math.ceil(listTotal / limit)),
        page,
        limit
      });
    } else {
      // SQLite fallback
      const events = await db.all(
        requestedIgUserId
          ? `SELECT event_type AS eventType, status, keyword, message_text AS messageText, error_message AS errorMessage, created_at AS createdAt
             FROM automation_events
             WHERE owner_user_id = ? AND instagram_user_id = ? AND (event_type IS NULL OR event_type NOT IN ('public_reply', 'comment_received'))
             ORDER BY created_at DESC LIMIT ? OFFSET ?`
          : `SELECT event_type AS eventType, status, keyword, message_text AS messageText, error_message AS errorMessage, created_at AS createdAt
             FROM automation_events
             WHERE owner_user_id = ? AND (event_type IS NULL OR event_type NOT IN ('public_reply', 'comment_received'))
             ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        requestedIgUserId ? [request.user.id, requestedIgUserId, limit, (page - 1) * limit] : [request.user.id, limit, (page - 1) * limit]
      );
      const totals = await db.get(
        requestedIgUserId
          ? `SELECT
              SUM(CASE WHEN (event_type IS NULL OR event_type NOT IN ('public_reply', 'comment_received')) AND status = 'success' THEN 1 ELSE 0 END) AS sent,
              SUM(CASE WHEN (event_type IS NULL OR event_type NOT IN ('public_reply', 'comment_received')) AND status = 'failed' THEN 1 ELSE 0 END) AS failed
              FROM automation_events WHERE owner_user_id = ? AND instagram_user_id = ?`
          : `SELECT
              SUM(CASE WHEN (event_type IS NULL OR event_type NOT IN ('public_reply', 'comment_received')) AND status = 'success' THEN 1 ELSE 0 END) AS sent,
              SUM(CASE WHEN (event_type IS NULL OR event_type NOT IN ('public_reply', 'comment_received')) AND status = 'failed' THEN 1 ELSE 0 END) AS failed
              FROM automation_events WHERE owner_user_id = ?`,
        requestedIgUserId ? [request.user.id, requestedIgUserId] : [request.user.id]
      );
      const sent = Number(totals?.sent || 0);
      const failed = Number(totals?.failed || 0);
      const total = sent + failed;

      const mapped = (events || []).map(e => ({
        id: e.createdAt,
        senderName: 'Commenter',
        username: 'Commenter',
        commentText: e.keyword ? `Keyword: "${e.keyword}"` : 'Comment',
        dmPreview: e.messageText || '–',
        dmText: e.messageText || '–',
        automationName: e.keyword ? `Keyword: ${e.keyword}` : 'Comment to DM',
        status: e.status === 'success' ? 'sent' : e.status,
        timestamp: e.createdAt,
        created_at: e.createdAt,
        createdAt: e.createdAt
      }));

      return response.json({
        events: mapped,
        total,
        sent,
        failed,
        pending: 0,
        unknown: 0,
        listTotal: total,
        pages: Math.max(1, Math.ceil(total / limit)),
        page,
        limit
      });
    }
  } catch (err) {
    return response.status(500).json({ error: err.message });
  }
});

// ── Advanced Analytics CSV Export ─────────────────────────────────────────
app.get('/api/analytics/export', requireAuth, async (request, response) => {
  try {
    const userEntitlement = await billing.entitlement(request.user.id, request);
    if (!userEntitlement?.limits?.advancedAnalytics) {
      return response.status(403).json({
        error: 'CSV data export is a premium feature available exclusively on Pro and Elite plans. Please upgrade to unlock.'
      });
    }

    const ownerClauses = buildOwnerClauses(request.user.id);
    let events = [];
    if (db.collections && db.collections().automationEvents) {
      events = await db.collections().automationEvents
        .find({ $or: ownerClauses })
        .sort({ created_at: -1 })
        .limit(5000)
        .toArray();
    } else {
      events = await db.all(
        'SELECT * FROM automation_events WHERE owner_user_id = ? ORDER BY created_at DESC LIMIT 5000',
        [request.user.id]
      );
    }

    const headers = ['Event ID', 'Type', 'Status', 'Instagram User ID', 'Comment ID', 'Created At', 'Error'];
    const rows = (events || []).map(e => [
      `"${String(e._id || e.id || '').replace(/"/g, '""')}"`,
      `"${String(e.event_type || 'comment').replace(/"/g, '""')}"`,
      `"${String(e.status || '').replace(/"/g, '""')}"`,
      `"${String(e.instagram_user_id || '').replace(/"/g, '""')}"`,
      `"${String(e.comment_id || '').replace(/"/g, '""')}"`,
      `"${String(e.created_at || '').replace(/"/g, '""')}"`,
      `"${String(e.error_message || e.error || '').replace(/"/g, '""')}"`
    ]);

    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    response.setHeader('Content-Type', 'text/csv');
    response.setHeader('Content-Disposition', 'attachment; filename="comment2dm_analytics_export.csv"');
    return response.send(csvContent);
  } catch (err) {
    return response.status(500).json({ error: 'Failed to export analytics: ' + err.message });
  }
});

// ── Live Debug Status for User & Webhook Verification ────────────────────────
app.get('/api/instagram/debug-status', requireAuth, async (request, response) => {
  try {
    const ownerId = request.user.id;
    const { automations, instagramAccounts, webhookEvents, automationEvents } = db.collections();

    const [accounts, userAutomations, recentWebhooks, recentEvents] = await Promise.all([
      instagramAccounts.find({
        $or: [{ owner_user_id: String(ownerId) }, { owner_user_id: ownerId }]
      }).toArray(),
      automations.find({
        $or: [{ owner_user_id: String(ownerId) }, { owner_user_id: ownerId }]
      }).toArray(),
      webhookEvents.find({}).sort({ processed_at: -1 }).limit(10).toArray(),
      automationEvents.find({
        $or: [{ owner_user_id: String(ownerId) }, { owner_user_id: ownerId }]
      }).sort({ created_at: -1 }).limit(15).toArray()
    ]);

    return response.json({
      serverTime: new Date().toISOString(),
      user: { id: ownerId, email: request.user.email },
      accountsCount: accounts.length,
      accounts: accounts.map(a => ({
        username: a.username,
        instagramUserId: a.instagram_user_id,
        connectedAt: a.connected_at,
        tokenValid: a.expires_at > Date.now(),
        tokenExpiresInDays: Math.round((a.expires_at - Date.now()) / (86400 * 1000))
      })),
      automationsCount: userAutomations.length,
      automations: userAutomations.map(a => ({
        id: a.id || a._id,
        keyword: a.keyword,
        triggerType: a.trigger_type,
        enabled: a.enabled,
        mediaId: a.media_id,
        instagramUserId: a.instagram_user_id,
        dmSnippet: (a.dm_message || '').slice(0, 40)
      })),
      recentWebhookEventsCount: recentWebhooks.length,
      recentWebhooksReceived: recentWebhooks,
      recentAutomationRepliesCount: recentEvents.length,
      recentAutomationReplies: recentEvents
    });
  } catch (err) {
    return response.status(500).json({ error: err.message });
  }
});

// ── VI Tech Owner Control Center & Admin Routes ───────────────────────────
registerAdminRoutes(app);

// ── Legacy Admin Endpoints (Backward Compatible) ─────────────────────────
app.get('/api/admin/users', requireAdmin, async (request, response) => {
  try {
    const users = db.collections ? await db.collections().users.find({}, { projection: { password: 0 } }).sort({ created_at: -1 }).limit(500).toArray() : [];
    return response.json({ users });
  } catch (err) { return response.status(500).json({ error: err.message }); }
});

app.patch('/api/admin/users/:id/plan', requireAdmin, async (request, response) => {
  try {
    const { plan } = request.body || {};
    if (!['free', 'pro', 'elite'].includes(plan)) return response.status(400).json({ error: 'Invalid plan' });
    const { ObjectId } = require('mongodb');
    await db.collections().users.updateOne({ _id: new ObjectId(request.params.id) }, { $set: { plan, updated_at: new Date() } });
    return response.json({ success: true });
  } catch (err) { return response.status(500).json({ error: err.message }); }
});

app.patch('/api/admin/users/:id/suspend', requireAdmin, async (request, response) => {
  try {
    const { ObjectId } = require('mongodb');
    const user = await db.collections().users.findOne({ _id: new ObjectId(request.params.id) });
    if (!user) return response.status(404).json({ error: 'User not found' });
    await db.collections().users.updateOne({ _id: new ObjectId(request.params.id) }, { $set: { suspended: !user.suspended, updated_at: new Date() } });
    return response.json({ success: true, suspended: !user.suspended });
  } catch (err) { return response.status(500).json({ error: err.message }); }
});

app.get('/api/admin/revenue', requireAdmin, async (request, response) => {
  try {
    const col = db.collections ? db.collections().payments : null;
    if (!col) return response.json({ months: [] });
    const since = new Date(); since.setMonth(since.getMonth() - 6);
    const payments = await col.find({ status: 'paid', created_at: { $gte: since } }).toArray();
    const months = {};
    payments.forEach(p => {
      const key = new Date(p.created_at).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
      months[key] = (months[key] || 0) + (p.amount || 0);
    });
    return response.json({ months: Object.entries(months).map(([month, total]) => ({ month, total: Math.round(total / 100) })) });
  } catch (err) { return response.status(500).json({ error: err.message }); }
});

app.get('/api/admin/health', requireAdmin, async (request, response) => {
  const start = Date.now();
  let dbOk = false;
  try { await db.collections().users.findOne({}, { projection: { _id: 1 } }); dbOk = true; } catch {}
  return response.json({ api: true, database: dbOk, latency: Date.now() - start, timestamp: new Date().toISOString() });
});

app.get('/api/admin/contacts', requireAdmin, async (request, response) => {
  try {
    const col = db.collections ? db.collections().contacts : null;
    const contacts = col ? await col.find({}).sort({ created_at: -1 }).limit(100).toArray() : [];
    return response.json({ contacts });
  } catch (err) { return response.status(500).json({ error: err.message }); }
});

app.patch('/api/admin/contacts/:id/resolve', requireAdmin, async (request, response) => {
  try {
    const { ObjectId } = require('mongodb');
    await db.collections().contacts.updateOne({ _id: new ObjectId(request.params.id) }, { $set: { resolved: true, resolved_at: new Date() } });
    return response.json({ success: true });
  } catch (err) { return response.status(500).json({ error: err.message }); }
});

app.get('/api/admin/config', requireAdmin, async (request, response) => {
  try {
    const col = db.collections ? db.collections().billing_plans : null;
    const coup = db.collections ? db.collections().coupons : null;
    const pricesDoc = col ? await col.findOne({ _id: 'global_prices' }) : null;
    const coupons = coup ? await coup.find({}).toArray() : [];
    return response.json({ 
      prices: pricesDoc || { pro_monthly: 70, elite_monthly: 150 },
      coupons: coupons.map(c => ({ code: c._id, discount: c.discount }))
    });
  } catch (err) { return response.status(500).json({ error: err.message }); }
});

app.post('/api/admin/config/prices', requireAdmin, async (request, response) => {
  try {
    const { pro_monthly, elite_monthly } = request.body || {};
    if (db.collections) {
      await db.collections().billing_plans.updateOne(
        { _id: 'global_prices' }, 
        { $set: { pro_monthly: pro_monthly || 70, elite_monthly: elite_monthly || 150, updated_at: new Date() } },
        { upsert: true }
      );
    }
    return response.json({ success: true });
  } catch (err) { return response.status(500).json({ error: err.message }); }
});

app.post('/api/admin/config/coupon', requireAdmin, async (request, response) => {
  try {
    const { code, discount } = request.body || {};
    if (!code || !discount) return response.status(400).json({ error: 'Code and discount required' });
    if (db.collections) {
      await db.collections().coupons.updateOne(
        { _id: code.toUpperCase() }, 
        { $set: { discount: Number(discount), created_at: new Date() } },
        { upsert: true }
      );
    }
    return response.json({ success: true });
  } catch (err) { return response.status(500).json({ error: err.message }); }
});

// ── Queue & Worker Observability Metrics ─────────────────────────────────
app.get('/api/admin/queue/metrics', requireAuth, requireAdmin, async (request, response) => {
  try {
    const metrics = await webhookJobQueue.getQueueMetrics(db);
    const workerStatus = webhookWorker.getWorkerStatus();
    return response.json({
      success: true,
      timestamp: new Date().toISOString(),
      ...metrics,
      worker: workerStatus
    });
  } catch (err) {
    return response.status(500).json({ error: 'Failed to retrieve queue metrics: ' + err.message });
  }
});

app.delete('/api/admin/config/coupon/:code', requireAdmin, async (request, response) => {
  try {
    if (db.collections) {
      await db.collections().coupons.deleteOne({ _id: request.params.code.toUpperCase() });
    }
    return response.json({ success: true });
  } catch (err) { return response.status(500).json({ error: err.message }); }
});

app.get('/api/billing/prices', async (request, response) => {
  try {
    const effective = await pricingService.getEffectivePricing();
    return response.json({
      pro_monthly: effective.plans.pro.price,
      elite_monthly: effective.plans.elite.price,
      pro_regular: effective.plans.pro.regular_price,
      elite_regular: effective.plans.elite.regular_price,
      plans: effective.plans,
      active_campaign: effective.active_campaign
    });
  } catch (err) {
    return response.json({ pro_monthly: 70, elite_monthly: 150 });
  }
});

app.post('/api/billing/validate-coupon', async (request, response) => {
  try {
    const { code, planKey } = request.body || {};
    if (!code) return response.status(400).json({ error: 'Coupon code is required.' });
    const targetPlanKey = planKey || 'pro_monthly';
    const effective = await pricingService.getEffectivePricing();
    const planInfo = targetPlanKey.startsWith('elite') ? effective.plans.elite : effective.plans.pro;
    const u = request.user || null;
    const result = await couponService.validateCoupon(code, targetPlanKey, u?.id || null, planInfo.price);
    if (!result.valid) {
      return response.status(400).json({ valid: false, error: result.error });
    }
    return response.json({
      valid: true,
      coupon: result.coupon,
      discount_rupees: result.discount_rupees,
      final_rupees: result.final_rupees,
      duration_text: result.duration_text
    });
  } catch (err) {
    return response.status(500).json({ error: err.message });
  }
});

// 404 & Error handlers
app.use((request, response) => {
  if (request.path.startsWith('/api/')) return response.status(404).json({ error: 'Endpoint not found.' });
  response.setHeader('Cache-Control', 'no-cache');
  return response.status(404).sendFile('404.html', { root: __dirname });
});

app.use((error, request, response, next) => {
  if (response.headersSent) return next(error);
  console.error('Server error:', error);
  response.status(error.statusCode || 500).json({
    error: error.statusCode ? error.message : 'Something went wrong. Please try again.'
  });
});

// Graceful shutdown handling for container termination
async function handleGracefulShutdown(signal) {
  console.log(`[SHUTDOWN] Received ${signal}. Draining queue worker...`);
  try {
    await webhookWorker.stopWorker(10000);
  } catch (err) {
    console.error('Error during worker shutdown:', err.message);
  }
  process.exit(0);
}

if (require.main === module) {
  db.initialize().then(async () => {
    // Bind port immediately so cloud providers (Render) detect open port without delay
    app.listen(port, '0.0.0.0', () => {
      console.log(`Comment2DM server is live on port ${port} (HTTPS ready)`);
    });

    // Synchronize Razorpay subscription plans asynchronously in background
    billing.ensurePlans().catch((err) => {
      console.error('Razorpay plan setup note:', err.message);
    });

    // Start persistent background worker after database initialization
    if (process.env.NODE_ENV !== 'test') {
      webhookWorker.startWorker(db, executeWebhookJob);
    }
  }).catch((error) => {
    console.error('Database initialization failed:', error);
    process.exitCode = 1;
  });

  process.on('SIGTERM', () => handleGracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => handleGracefulShutdown('SIGINT'));
}
// Export handlers for automated testing
module.exports = { app, deliverFinalResource, executeCommentJob, executeMessagingJob, executeWebhookJob, safeDispatchOutbound, isAdminEmail, getAdminEmails };