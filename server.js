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
  response.setHeader('X-DNS-Prefetch-Control', 'off');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://checkout.razorpay.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: https: blob:; connect-src 'self' https://api.openai.com https://generativelanguage.googleapis.com https://api.instagram.com https://graph.instagram.com https://graph.facebook.com https://oauth2.googleapis.com https://api.razorpay.com https://checkout.razorpay.com; frame-src 'self' https://checkout.razorpay.com https://api.razorpay.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none';");
  if (isProduction) response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (request.path.startsWith('/api/')) response.setHeader('Cache-Control', 'no-store');
  next();
});

const ADMIN_EMAILS = new Set([
  'jayvardhanreddy2008@gmail.com',
  'vijayakrishnareddy910@gmail.com',
  ...(process.env.ADMIN_EMAIL ? process.env.ADMIN_EMAIL.split(',').map(e => e.trim().toLowerCase()) : [])
]);

function isAdminEmail(email) {
  if (!email || typeof email !== 'string') return false;
  return ADMIN_EMAILS.has(email.trim().toLowerCase());
}

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'jayvardhanreddy2008@gmail.com').trim().toLowerCase();

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

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'comment2dm_super_secure_jwt_secret_key_minimum_32_chars!';
}

app.use(cookieParser());
app.use('/api', requireSameOriginForStateChanges);
billing.register(app);

app.use(express.json({ limit: '20kb' }));
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

app.use(express.static(path.join(__dirname)));

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

// Dual Session Auth Middleware: checks Bearer header first, then cookies
async function requireAuth(request, response, next) {
  // 1. Authorization: Bearer <token>
  const authHeader = request.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const bearerToken = authHeader.slice(7).trim();
    try {
      const user = await authService.getSessionUser(bearerToken);
      if (user) {
        request.user = user;
        request.sessionToken = bearerToken;
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
        request.user = user;
        request.sessionToken = sessionToken;
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
        request.user = user;
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
    return response.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone || '',
        avatarUrl: user.avatar_url || '',
        createdAt: user.created_at || user.createdAt
      },
      preferences: { notifications: true, emailReports: true }
    });
  } catch (error) {
    return next(error);
  }
});

app.patch('/api/settings/profile', requireAuth, async (request, response, next) => {
  try {
    const { name, email, phone, avatarUrl } = request.body || {};
    if (name && (name.length < 2 || name.length > 100)) {
      return response.status(400).json({ error: 'Name must be between 2 and 100 characters.' });
    }
    if (email) {
      const cleanEmail = email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
        return response.status(400).json({ error: 'Enter a valid email address.' });
      }
      const existing = await db.getUserByEmail(cleanEmail);
      if (existing && existing.id !== request.user.id) {
        return response.status(409).json({ error: 'An account with that email already exists.' });
      }
    }

    await db.updateUserProfile(request.user.id, { name, email, phone, avatarUrl });
    const updated = await db.getUserById(request.user.id);
    return response.json({
      user: {
        id: updated.id,
        name: updated.name,
        email: updated.email,
        phone: updated.phone || '',
        avatarUrl: updated.avatar_url || '',
        createdAt: updated.created_at || updated.createdAt
      }
    });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/settings/password', requireAuth, async (request, response, next) => {
  try {
    const { currentPassword, newPassword } = request.body || {};
    if (!currentPassword || !newPassword) {
      return response.status(400).json({ error: 'Current password and new password are required.' });
    }
    if (newPassword.length < 6) {
      return response.status(400).json({ error: 'New password must be at least 6 characters.' });
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
    return response.json({ success: true, message: 'Password updated successfully.' });
  } catch (error) {
    return next(error);
  }
});

app.delete('/api/account/delete', requireAuth, async (request, response, next) => {
  try {
    await db.deleteUserAccount(request.user.id);
    response.clearCookie('comment2dm_session', { path: '/' });
    response.clearCookie('nudge_session', { path: '/' });
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
    const userEntitlement = await billing.entitlement(request.user.id);
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

    const userEntitlement = await billing.entitlement(request.user.id);

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
    return response.status(204).end();
  } catch (error) {
    return next(error);
  }
});

// Resource Upload Endpoint (Images, PDFs up to 10MB)
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

    if (base64Buffer.length > 10 * 1024 * 1024) {
      return response.status(400).json({ error: 'File size exceeds maximum allowed 10MB limit.' });
    }

    const allowedMimes = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
      'image/gif': '.gif',
      'application/pdf': '.pdf'
    };

    if (!allowedMimes[mimeType]) {
      return response.status(400).json({ error: 'Unsupported file type. Only JPG, PNG, WEBP, GIF, and PDF files are allowed.' });
    }

    const ext = allowedMimes[mimeType];
    const safeBase = path.basename(fileName, path.extname(fileName)).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
    const uniqueName = `res_${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${safeBase}${ext}`;
    const uploadsDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
    fs.writeFileSync(path.join(uploadsDir, uniqueName), base64Buffer);

    return response.json({
      success: true,
      url: `/uploads/${uniqueName}`,
      fileName: `${safeBase}${ext}`,
      fileType: mimeType,
      fileSize: base64Buffer.length
    });
  } catch (err) {
    console.error('Resource upload failed:', err);
    return response.status(500).json({ error: 'Failed to process resource upload.' });
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

  // Supports configured env token, or standard defaults ('comment2dm_webhook_token', 'nudge_webhook_secret', 'comment2dm')
  const isValidToken = !expectedToken ||
                       token === expectedToken ||
                       token === 'comment2dm_webhook_token' ||
                       token === 'nudge_webhook_secret' ||
                       token === 'comment2dm' ||
                       token === 'nudge';

  if (mode === 'subscribe' && isValidToken) {
    console.log('Meta Webhook verified successfully with challenge:', challenge);
    return response.status(200).send(challenge);
  } else {
    console.warn(`Meta Webhook verification failed. Received token: "${token}", Expected: "${expectedToken || 'comment2dm_webhook_token'}"`);
    return response.status(403).json({ error: 'Verification failed. Token mismatch.' });
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

// Deliver final resource helper (guaranteed idempotent)
async function deliverFinalResource({ recipientIgUserId, senderIgsid, automation, tokenData, flow, commentId }) {
  // Idempotency guard: prevent duplicate deliveries on rapid button clicks
  const key = `${recipientIgUserId}:${senderIgsid}:${automation.id}`;
  if (db.collections && db.collections().conversationStates) {
    const existing = await db.collections().conversationStates.findOne({ key });
    if (existing && existing.resource_delivered === true) {
      console.log(`[IDEMPOTENCY] Resource already delivered to ${senderIgsid} for automation ${automation.id}.`);
      return;
    }
  }

  let deliveryText = flow.delivery?.message || automation.dm_message || "Here's what you requested! Enjoy ✨";
  const resourceUrl = flow.delivery?.resourceUrl;
  const buttonText = (flow.delivery?.buttonText || "Open Link ↗").trim().slice(0, 20);

  // Free branding attribution if not white-label
  try {
    const userEntitlement = await billing.entitlement(automation.owner_user_id);
    if (!userEntitlement?.limits?.whiteLabel) {
      if (!deliveryText.includes('Powered by Comment2DM')) {
        deliveryText += '\n\n⚡ Powered by Comment2DM';
      }
    }
  } catch (_) {}

  // Format delivery payload: interactive button if URL is valid, clean text fallback
  let deliveryPayload;
  if (resourceUrl && /^https?:\/\//i.test(resourceUrl)) {
    deliveryPayload = {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'button',
          text: deliveryText,
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

  try {
    await instagramService.sendDirectMessage(
      recipientIgUserId,
      senderIgsid,
      deliveryPayload,
      tokenData.accessToken
    );
  } catch (dmErr) {
    // Graceful fallback to text if template rejected by client
    if (deliveryPayload.attachment) {
      let fallbackText = deliveryText;
      if (resourceUrl && !fallbackText.includes(resourceUrl)) {
        fallbackText += `\n\n🔗 ${buttonText}: ${resourceUrl}`;
      }
      await instagramService.sendDirectMessage(
        recipientIgUserId,
        senderIgsid,
        { text: fallbackText },
        tokenData.accessToken
      );
    } else {
      throw dmErr;
    }
  }

  // Persist conversation state for idempotency
  if (db.collections && db.collections().conversationStates) {
    await db.collections().conversationStates.updateOne(
      { key },
      {
        $set: {
          key,
          automation_id: automation.id,
          owner_user_id: automation.owner_user_id,
          instagram_user_id: recipientIgUserId,
          sender_igsid: senderIgsid,
          state: 'RESOURCE_DELIVERED',
          resource_delivered: true,
          delivered_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
      },
      { upsert: true }
    );
  }

  // Log in automation_events
  if (db.collections && db.collections().automationEvents) {
    await db.collections().automationEvents.insertOne({
      event_id: crypto.randomUUID(),
      owner_user_id: automation.owner_user_id,
      instagram_user_id: recipientIgUserId,
      automation_id: automation.id,
      from_id: senderIgsid,
      event_type: 'resource_delivered',
      message_text: deliveryText,
      resource_url: resourceUrl || null,
      status: 'success',
      created_at: new Date().toISOString()
    });
  }
}

app.post('/api/instagram/webhook', async (request, response) => {
  response.status(200).json({ status: 'ok' });

  try {
    if (request.billingBlocked) return;
    const payload = request.body;
    console.log('Incoming Meta Webhook received:', JSON.stringify(payload));

    if (db.collections && db.collections().webhookEvents) {
      db.collections().webhookEvents.insertOne({
        event_id: 'webhook_' + Date.now(),
        raw_payload: payload,
        received_at: new Date().toISOString(),
        processed_at: new Date().toISOString()
      }).catch(err => console.error('Failed to log raw webhook:', err.message));
    }

    if (!payload || payload.object !== 'instagram' || !Array.isArray(payload.entry)) {
      return;
    }

    for (const entry of payload.entry) {
      const recipientIgUserId = String(entry.id || '');
      const changes = Array.isArray(entry.changes) ? entry.changes : [];

      // ==========================================
      // 1. Comment Webhook Events
      // ==========================================
      for (const change of changes) {
        if (change.field !== 'comments' || !change.value) continue;

        const commentVal = change.value;
        const commentId = String(commentVal.id || '');
        const commentText = String(commentVal.text || '');

        if (!commentId || !commentText || !recipientIgUserId) continue;

        const fromId = String(commentVal.from?.id || '');
        const fromUsername = String(commentVal.from?.username || '').toLowerCase();

        // 1. DEDUP & LOOP PREVENTION: Ignore comments posted by the Instagram account itself (prevents bot self-reply loop)
        if (fromId && fromId === recipientIgUserId) {
          console.log(`[DEDUP] Skipping comment ${commentId}: posted by account itself (${recipientIgUserId}).`);
          continue;
        }

        // 2. DEDUP: Ignore comment replies (only respond to root comments on reels, never replies to comments)
        if (commentVal.parent_id) {
          console.log(`[DEDUP] Skipping comment reply ${commentId}: it is a reply to parent comment ${commentVal.parent_id}.`);
          continue;
        }

        // 3. CONCURRENCY LOCK: Skip if already being processed in-memory right now
        if (processingCommentIds.has(commentId)) {
          console.log(`[DEDUP] Skipping comment ${commentId}: currently being processed in memory.`);
          continue;
        }

        // 4. DB DEDUPLICATION: Check if comment was already logged or replied to
        const existingEvent = await db.get('SELECT event_id FROM webhook_events WHERE event_id = ?', [commentId]);
        if (existingEvent) {
          console.log(`[DEDUP] Skipping duplicate comment event ${commentId} (already in webhook_events).`);
          continue;
        }

        if (db.collections && db.collections().automationEvents) {
          const alreadyDone = await db.collections().automationEvents.findOne({
            comment_id: commentId,
            status: 'success'
          });
          if (alreadyDone) {
            console.log(`[DEDUP] Skipping comment ${commentId}: already successfully replied.`);
            continue;
          }
        }

        processingCommentIds.add(commentId);
        try {
          await db.run('INSERT OR IGNORE INTO webhook_events (event_id, processed_at) VALUES (?, ?)', [
            commentId,
            new Date().toISOString()
          ]);

          const automations = await db.all(
            'SELECT * FROM automations WHERE instagram_user_id = ? AND enabled = 1',
            [recipientIgUserId]
          );

          let activeAutomations = automations || [];
          if (activeAutomations.length === 0 && db.collections) {
            activeAutomations = await db.collections().automations.find({
              instagram_user_id: recipientIgUserId,
              enabled: { $in: [true, 1, '1'] }
            }).toArray();
          }

          if (activeAutomations.length === 0) {
            console.log(`No active automations found for Instagram account ${recipientIgUserId}`);
            continue;
          }

          const commentMediaId = String(commentVal.media?.id || commentVal.media_id || commentVal.mediaId || '');

          // Prioritize automations matching this specific Reel/Post first, then fallback to general
          const matchedMediaAutos = activeAutomations.filter((auto) => {
            if (auto.media_id && commentMediaId) {
              const autoMediaIdStr = String(auto.media_id);
              return commentMediaId.includes(autoMediaIdStr) || autoMediaIdStr.includes(commentMediaId);
            }
            return !auto.media_id; // general fallback only if no media_id set
          });

          // Sort by: specific media match first, then newest updated
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
            console.log(`[TRIGGER] No matching automation keyword for comment "${commentText}" (Media: ${commentMediaId}).`);
            continue;
          }

          console.log(`[TRIGGER] Matched automation ${selectedAuto.id} for comment "${commentText}" (ID: ${commentId}). Sending interactive opening DM...`);

          try {
            // Safety: Ensure flow is loaded
            if (!selectedAuto.flow && db.collections) {
              const raw = await db.collections().automations.findOne({ id: selectedAuto.id });
              if (raw && raw.flow) {
                selectedAuto.flow = raw.flow;
              }
            }

            const tokenData = await instagramService.getDecryptedTokenByInstagramUserId(recipientIgUserId, selectedAuto.owner_user_id);
            const flow = selectedAuto.flow || {};
            const isFollowGateEnabled = Boolean(flow.followGate?.enabled);

            // Prepare opening message text
            let messageToSend = flow.openingMessage || selectedAuto.dm_message || "Hey! I'm so glad you're here — thanks for your interest 😊\n\nTap below and I'll send you the link in just a moment ✨";

            // Variable Personalization
            if (fromUsername) {
              messageToSend = messageToSend.replace(/\{username\}/gi, `@${fromUsername}`);
              messageToSend = messageToSend.replace(/\{name\}/gi, fromUsername);
              messageToSend = messageToSend.replace(/\{first_name\}/gi, fromUsername);
            }

            // Plan-based Free Branding Attribution
            try {
              const userEntitlement = await billing.entitlement(selectedAuto.owner_user_id);
              if (!userEntitlement?.limits?.whiteLabel) {
                if (!messageToSend.includes('Powered by Comment2DM')) {
                  messageToSend += '\n\n⚡ Powered by Comment2DM';
                }
              }
            } catch (bErr) {
              console.warn('Billing entitlement check note:', bErr.message);
            }

            // Interactive Opening Button Title (max 20 characters per Meta Graph API rules)
            const openingBtnTitle = (flow.openingButtonText || 'Send me the link').trim().slice(0, 20);

            // Images 2 & 3: Button Template card embedded directly in the chat bubble
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

            // 1. Send Interactive Private DM via official Meta API
            const sendResult = await instagramService.sendPrivateReply(
              recipientIgUserId,
              commentId,
              msgPayload,
              tokenData.accessToken
            );

            // 2. Initialize conversation state for multi-step tracking & idempotency
            const stateKey = `${recipientIgUserId}:${fromId || commentId}:${selectedAuto.id}`;
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
                    commenter_username: fromUsername,
                    state: 'OPENING_DM_SENT',
                    button_title: openingBtnTitle,
                    follow_gate_required: isFollowGateEnabled,
                    resource_delivered: false,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                  }
                },
                { upsert: true }
              );
            }

            // 3. Send Public Comment Reply (if configured)
            if (selectedAuto.reply_template) {
              await instagramService.replyToComment(
                commentId,
                selectedAuto.reply_template,
                tokenData.accessToken
              );
            }

            // 4. Record automation event
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
                keyword: selectedAuto.keyword,
                message_text: messageToSend,
                button_text: openingBtnTitle,
                interactive: true,
                status: 'success',
                meta_message_id: sendResult?.message_id || sendResult?.id || null,
                created_at: new Date().toISOString()
              });
            } else {
              await db.run(
                'INSERT INTO automation_events (owner_user_id, instagram_user_id, automation_id, comment_id, event_type, keyword, message_text, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [selectedAuto.owner_user_id, recipientIgUserId, selectedAuto.id, commentId, 'private_reply', selectedAuto.keyword, messageToSend, 'success', new Date().toISOString()]
              );
            }
            console.log(`[TRIGGER SUCCESS] Successfully sent interactive DM & reply for comment ID ${commentId}`);
          } catch (apiErr) {
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
                keyword: selectedAuto.keyword,
                message_text: selectedAuto.dm_message,
                status: 'failed',
                error_message: apiErr.message,
                created_at: new Date().toISOString()
              });
            } else {
              await db.run(
                'INSERT INTO automation_events (owner_user_id, instagram_user_id, automation_id, comment_id, event_type, keyword, message_text, status, error_message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [selectedAuto.owner_user_id, recipientIgUserId, selectedAuto.id, commentId, 'private_reply', selectedAuto.keyword, selectedAuto.dm_message, 'failed', apiErr.message, new Date().toISOString()]
              );
            }
            console.error(`Failed to execute automation for comment ${commentId}:`, apiErr.message);
          }

          // CRITICAL: Stop after matching first automation so multiple rules do not fire on the same comment
          break;
        } finally {
          // Release in-memory lock after 60 seconds (absorbs rapid re-deliveries from Meta)
          setTimeout(() => {
            processingCommentIds.delete(commentId);
          }, 60000);
        }
      }

      // ==========================================
      // 2. Interactive Messaging Events (Quick Replies, Button Taps, DMs)
      // ==========================================
      const messagingEvents = Array.isArray(entry.messaging) ? entry.messaging : [];
      for (const msgEvent of messagingEvents) {
        const senderIgsid = String(msgEvent.sender?.id || '');
        const recipientIgUserId = String(msgEvent.recipient?.id || entry.id || '');
        if (!senderIgsid || !recipientIgUserId || senderIgsid === recipientIgUserId) continue;

        const quickReplyPayload = msgEvent.message?.quick_reply?.payload;
        const postbackPayload = msgEvent.postback?.payload;
        const incomingText = String(msgEvent.message?.text || msgEvent.postback?.title || '').trim();
        const payload = String(quickReplyPayload || postbackPayload || '').trim();

        let action = '';
        let autoId = '';
        let commentId = '';

        if (payload.startsWith('SEND_LINK')) {
          action = 'SEND_LINK';
          const parts = payload.split(':');
          autoId = parts[1] || '';
          commentId = parts[2] || '';
        } else if (payload.startsWith('CHECK_FOLLOW')) {
          action = 'CHECK_FOLLOW';
          const parts = payload.split(':');
          autoId = parts[1] || '';
          commentId = parts[2] || '';
        } else if (/send.*link/i.test(incomingText)) {
          action = 'SEND_LINK';
        } else if (/follow/i.test(incomingText)) {
          action = 'CHECK_FOLLOW';
        }

        if (!action) continue;

        console.log(`[MESSAGING] Interactive event: action="${action}", sender="${senderIgsid}", payload="${payload}"`);

        // Find automation
        let targetAutomation = null;
        if (autoId) {
          targetAutomation = await db.get('SELECT * FROM automations WHERE id = ?', [autoId]);
          if (!targetAutomation && db.collections) {
            targetAutomation = await db.collections().automations.findOne({ id: autoId });
          }
        }

        if (!targetAutomation) {
          const active = await db.all(
            'SELECT * FROM automations WHERE instagram_user_id = ? AND enabled = 1 ORDER BY updated_at DESC LIMIT 1',
            [recipientIgUserId]
          );
          targetAutomation = active?.[0];
          if (!targetAutomation && db.collections) {
            targetAutomation = await db.collections().automations.findOne(
              { instagram_user_id: recipientIgUserId, enabled: { $in: [true, 1, '1'] } },
              { sort: { updated_at: -1 } }
            );
          }
        }

        if (!targetAutomation) {
          console.log(`[MESSAGING] No matching automation for recipient ${recipientIgUserId}`);
          continue;
        }

        const tokenData = await instagramService.getDecryptedTokenByInstagramUserId(recipientIgUserId, targetAutomation.owner_user_id);
        const flow = targetAutomation.flow || {};
        const creatorUsername = tokenData.username || 'creator';

        // IDEMPOTENCY CHECK: Do not deliver resource twice on repeated button taps
        const idempotencyKey = `${recipientIgUserId}:${senderIgsid}:${targetAutomation.id}`;
        let convState = null;
        if (db.collections && db.collections().conversationStates) {
          convState = await db.collections().conversationStates.findOne({ key: idempotencyKey });
        }

        if (convState && convState.resource_delivered === true) {
          console.log(`[IDEMPOTENCY] Resource already delivered to ${senderIgsid} for automation ${targetAutomation.id}. Ignoring duplicate trigger.`);
          continue;
        }

        if (action === 'SEND_LINK') {
          // If follow gate is disabled, deliver resource immediately
          if (!flow.followGate?.enabled) {
            console.log(`[MESSAGING] Follow gate disabled. Delivering resource immediately to ${senderIgsid}...`);
            await deliverFinalResource({ recipientIgUserId, senderIgsid, automation: targetAutomation, tokenData, flow, commentId });
            continue;
          }

          // Follow gate is ENABLED: Check follower status via official Meta API
          console.log(`[MESSAGING] Checking follower status for ${senderIgsid} via Meta Graph API...`);
          const followResult = await instagramService.checkFollowStatus(recipientIgUserId, senderIgsid, tokenData.accessToken);

          if (followResult.isFollowing === true) {
            // PATH A — Already Following: Deliver immediately
            console.log(`[MESSAGING] PATH A: Recipient ${senderIgsid} already follows @${creatorUsername}. Delivering resource immediately.`);
            await deliverFinalResource({ recipientIgUserId, senderIgsid, automation: targetAutomation, tokenData, flow, commentId });
          } else if (followResult.supported === false || followResult.error) {
            // Safe Retry State if Meta API error or restricted
            console.warn(`[MESSAGING] Meta follow check unavailable or error: ${followResult.error || followResult.note}`);
            const retryNotice = "We couldn't verify your follow status right now due to a network or API delay. Please tap below to retry!";
            const profileUrl = flow.followGate?.profileUrl || `https://instagram.com/${creatorUsername}`;
            await instagramService.sendDirectMessage(
              recipientIgUserId,
              senderIgsid,
              {
                text: `${retryNotice}\n\n👉 Profile: ${profileUrl}`,
                quick_replies: [
                  {
                    content_type: 'text',
                    title: 'Retry Follow Check 🔄'.slice(0, 20),
                    payload: `CHECK_FOLLOW:${targetAutomation.id}:${commentId}`
                  }
                ]
              },
              tokenData.accessToken
            );
          } else {
            // PATH B — Not Following: Send two-button follow prompt (Image 3 format)
            console.log(`[MESSAGING] PATH B: Recipient ${senderIgsid} does not follow @${creatorUsername}. Sending two-button follow prompt.`);
            const followPrompt = flow.followGate?.message || "Oops! Looks like you haven't followed me yet 👀\n\nIt would mean a lot if you could visit my profile and hit that follow button 😊";
            const profileBtn = (flow.followGate?.profileBtnText || "Visit Profile").trim().slice(0, 20);
            const confirmBtn = (flow.followGate?.confirmBtnText || "I'm following ✅").trim().slice(0, 20);
            let profileUrl = flow.followGate?.profileUrl || `https://instagram.com/${creatorUsername}`;
            if (!profileUrl.startsWith('http')) {
              profileUrl = `https://instagram.com/${profileUrl.replace(/^@/, '')}`;
            }

            const followPromptPayload = {
              attachment: {
                type: 'template',
                payload: {
                  template_type: 'button',
                  text: followPrompt,
                  buttons: [
                    {
                      type: 'web_url',
                      url: profileUrl,
                      title: profileBtn
                    },
                    {
                      type: 'postback',
                      title: confirmBtn,
                      payload: `CHECK_FOLLOW:${targetAutomation.id}:${commentId}`
                    }
                  ]
                }
              }
            };

            try {
              await instagramService.sendDirectMessage(
                recipientIgUserId,
                senderIgsid,
                followPromptPayload,
                tokenData.accessToken
              );
            } catch (dmErr) {
              await instagramService.sendDirectMessage(
                recipientIgUserId,
                senderIgsid,
                {
                  text: `${followPrompt}\n\n👉 ${profileBtn}: ${profileUrl}`,
                  quick_replies: [
                    {
                      content_type: 'text',
                      title: confirmBtn,
                      payload: `CHECK_FOLLOW:${targetAutomation.id}:${commentId}`
                    }
                  ]
                },
                tokenData.accessToken
              );
            }

            // Update conversation state to FOLLOW_PROMPTED
            if (db.collections && db.collections().conversationStates) {
              await db.collections().conversationStates.updateOne(
                { key: idempotencyKey },
                {
                  $set: {
                    key: idempotencyKey,
                    automation_id: targetAutomation.id,
                    owner_user_id: targetAutomation.owner_user_id,
                    instagram_user_id: recipientIgUserId,
                    sender_igsid: senderIgsid,
                    state: 'FOLLOW_PROMPTED',
                    resource_delivered: false,
                    updated_at: new Date().toISOString()
                  }
                },
                { upsert: true }
              );
            }
          }
        } else if (action === 'CHECK_FOLLOW') {
          // Fresh query to Meta API
          console.log(`[MESSAGING] Fresh follower check on user tap "I'm following" for ${senderIgsid}...`);
          const recheckResult = await instagramService.checkFollowStatus(recipientIgUserId, senderIgsid, tokenData.accessToken);

          if (recheckResult.isFollowing === true) {
            console.log(`[MESSAGING] Follower confirmed! Delivering resource to ${senderIgsid}.`);
            await deliverFinalResource({ recipientIgUserId, senderIgsid, automation: targetAutomation, tokenData, flow, commentId });
          } else if (recheckResult.supported === false || recheckResult.error) {
            console.warn(`[MESSAGING] Meta follower recheck error: ${recheckResult.error || recheckResult.note}`);
            const retryNotice = "We couldn't verify your follow status right now due to a network or API delay. Please tap below to retry!";
            const profileBtn = (flow.followGate?.profileBtnText || "Visit Profile").trim().slice(0, 20);
            let profileUrl = flow.followGate?.profileUrl || `https://instagram.com/${creatorUsername}`;
            if (!profileUrl.startsWith('http')) {
              profileUrl = `https://instagram.com/${profileUrl.replace(/^@/, '')}`;
            }

            const retryPayload = {
              attachment: {
                type: 'template',
                payload: {
                  template_type: 'button',
                  text: `${retryNotice}\n\n👉 Profile: ${profileUrl}`,
                  buttons: [
                    {
                      type: 'web_url',
                      url: profileUrl,
                      title: profileBtn
                    },
                    {
                      type: 'postback',
                      title: 'Retry Check 🔄'.slice(0, 20),
                      payload: `CHECK_FOLLOW:${targetAutomation.id}:${commentId}`
                    }
                  ]
                }
              }
            };
            try {
              await instagramService.sendDirectMessage(recipientIgUserId, senderIgsid, retryPayload, tokenData.accessToken);
            } catch (_) {
              await instagramService.sendDirectMessage(recipientIgUserId, senderIgsid, {
                text: `${retryNotice}\n\n👉 Profile: ${profileUrl}`,
                quick_replies: [{ content_type: 'text', title: 'Retry Check 🔄'.slice(0, 20), payload: `CHECK_FOLLOW:${targetAutomation.id}:${commentId}` }]
              }, tokenData.accessToken);
            }
          } else {
            // Still not following
            console.log(`[MESSAGING] Follow still not detected for ${senderIgsid}. Sending polite retry prompt.`);
            const retryMsg = flow.followGate?.retryMessage || "Still not seeing that follow yet! 👀 If you just hit follow, please wait a few seconds for Instagram to sync and tap below to retry.";
            const profileBtn = (flow.followGate?.profileBtnText || "Visit Profile").trim().slice(0, 20);
            const confirmBtn = (flow.followGate?.confirmBtnText || "I'm following ✅").trim().slice(0, 20);
            let profileUrl = flow.followGate?.profileUrl || `https://instagram.com/${creatorUsername}`;
            if (!profileUrl.startsWith('http')) {
              profileUrl = `https://instagram.com/${profileUrl.replace(/^@/, '')}`;
            }

            const retryPromptPayload = {
              attachment: {
                type: 'template',
                payload: {
                  template_type: 'button',
                  text: retryMsg,
                  buttons: [
                    {
                      type: 'web_url',
                      url: profileUrl,
                      title: profileBtn
                    },
                    {
                      type: 'postback',
                      title: confirmBtn,
                      payload: `CHECK_FOLLOW:${targetAutomation.id}:${commentId}`
                    }
                  ]
                }
              }
            };
            try {
              await instagramService.sendDirectMessage(recipientIgUserId, senderIgsid, retryPromptPayload, tokenData.accessToken);
            } catch (_) {
              await instagramService.sendDirectMessage(recipientIgUserId, senderIgsid, {
                text: `${retryMsg}\n\n👉 Visit Profile: ${profileUrl}`,
                quick_replies: [{ content_type: 'text', title: confirmBtn, payload: `CHECK_FOLLOW:${targetAutomation.id}:${commentId}` }]
              }, tokenData.accessToken);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('Error in Instagram webhook processing:', err.message);
  }
});

// ==========================================
// Analytics & Admin
// ==========================================

app.get('/api/analytics/overview', requireAuth, async (request, response, next) => {
  try {
    const ownerId = request.user.id;
    const days = parseInt(request.query.days, 10) || 30;

    let [accounts, activeAutomations, totals, recent, daily] = await Promise.all([
      db.get('SELECT COUNT(*) AS count FROM instagram_accounts WHERE owner_user_id = ?', [ownerId]),
      db.get('SELECT COUNT(*) AS count FROM automations WHERE owner_user_id = ? AND enabled = 1', [ownerId]),
      db.get(`SELECT
        SUM(CASE WHEN event_type = 'comment_received' THEN 1 ELSE 0 END) AS comments,
        SUM(CASE WHEN event_type = 'private_reply' AND status = 'success' THEN 1 ELSE 0 END) AS messagesSent,
        SUM(CASE WHEN event_type = 'private_reply' AND status = 'failed' THEN 1 ELSE 0 END) AS messagesFailed,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successfulEvents
        FROM automation_events WHERE owner_user_id = ?`, [ownerId]),
      db.all(`SELECT event_type AS eventType, status, keyword, message_text AS messageText, error_message AS errorMessage, created_at AS createdAt
        FROM automation_events WHERE owner_user_id = ? ORDER BY created_at DESC LIMIT 20`, [ownerId]),
      db.all(`SELECT substr(created_at,1,10) AS date,
        SUM(CASE WHEN event_type = 'comment_received' THEN 1 ELSE 0 END) AS comments,
        SUM(CASE WHEN event_type = 'private_reply' AND status = 'success' THEN 1 ELSE 0 END) AS messagesSent,
        SUM(CASE WHEN event_type = 'private_reply' AND status = 'failed' THEN 1 ELSE 0 END) AS messagesFailed
        FROM automation_events WHERE owner_user_id = ? AND created_at >= datetime('now','-29 days')
        GROUP BY substr(created_at,1,10) ORDER BY date ASC`, [ownerId])
    ]);

    let sent = Number(totals?.messagesSent || 0);
    let failed = Number(totals?.messagesFailed || 0);
    let commentsCount = Number(totals?.comments || 0);

    // If MongoDB collection is directly accessible, compute exact real-time metrics
    let leaderboard = [];
    if (db.collections && db.collections().automationEvents) {
      const col = db.collections().automationEvents;
      const countSent = await col.countDocuments({ owner_user_id: ownerId, status: 'success' });
      const countFailed = await col.countDocuments({ owner_user_id: ownerId, status: 'failed' });
      const totalEvents = await col.countDocuments({ owner_user_id: ownerId });
      
      sent = countSent;
      failed = countFailed;
      commentsCount = totalEvents;

      // Build automation leaderboard
      if (db.collections().automations) {
        const userAutos = await db.collections().automations.find({ owner_user_id: ownerId }).toArray();
        for (const auto of userAutos) {
          const autoSent = await col.countDocuments({ automation_id: auto.id, status: 'success' });
          const autoFailed = await col.countDocuments({ automation_id: auto.id, status: 'failed' });
          leaderboard.push({
            id: auto.id,
            name: auto.keyword ? `Keyword: ${auto.keyword}` : 'All Comments',
            account: auto.username || 'Connected Account',
            sent: autoSent,
            total: autoSent + autoFailed,
            active: Boolean(auto.enabled)
          });
        }
      }
    }

    const totalDMs = sent + failed;
    const deliveryRate = totalDMs > 0 ? Math.round((sent / totalDMs) * 100) : 100;

    // Build daily array for bar chart ({ date, count })
    const dailyDms = (daily && daily.length > 0)
      ? daily.map(d => ({ date: d.date, count: Number(d.messagesSent || d.count || 0) }))
      : [];

    return response.json({
      // Fields expected by analytics.js frontend
      dmsSent: sent,
      commentsProcessed: commentsCount,
      failed,
      deliveryRate,
      activeAutomations: activeAutomations?.count || 0,
      dailyDms,
      automations: leaderboard,

      // Fields for legacy compatibility
      accounts: accounts?.count || 0,
      comments: commentsCount,
      messagesSent: sent,
      messagesFailed: failed,
      successfulEvents: sent,
      recent: recent || [],
      daily: daily || []
    });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/admin/overview', requireAuth, requireAdmin, async (request, response, next) => {
  try {
    const users = await authService.listUsers();
    const instagramAccounts = await instagramService.listAllAccounts();
    return response.json({ users, instagramAccounts });
  } catch (error) {
    return next(error);
  }
});

// ==========================================
// Creator Studio AI & Support Chat
// ==========================================



const supportKnowledge = [
  { keys: ['hi', 'hello', 'hey'], answer: 'Hi! Welcome to Comment2DM Support. How can I assist you with your Instagram automations, account connection, or billing today?' },
  { keys: ['connect', 'instagram', 'meta', 'account'], answer: 'To connect Instagram: 1) Go to Instagram Accounts in the sidebar. 2) Click "Connect Instagram". 3) Authorize using your professional Meta account. Ensure you have Instagram Business Login permissions enabled.' },
  { keys: ['automation', 'keyword', 'comment', 'dm'], answer: 'Comment2DM triggers automatic DMs and public replies when someone comments on your Reels! Go to "Create Automation", select your account, choose your Reel, set the trigger keyword or select "All comments", and write your private DM and public reply.' },
  { keys: ['pricing', 'upgrade', 'plan', 'billing'], answer: 'Comment2DM offers 3 plans: Free (3 automations, 300 DMs), Pro (25 automations, 5,000 DMs, All Comments trigger, public replies), and Elite (Unlimited automations, 50,000 DMs, priority webhook queue). Manage your plan in Billing.' },
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
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    const d = await r.json();
    return d.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch { return null; }
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

app.post('/api/creator/generate', requireAuth, async (request, response) => {
  const { type: rawType, tool, topic, audience, tone = 'inspirational', count = 3, product, cta, niche, week } = request.body || {};
  const type = rawType || tool || 'hooks';
  try {
    let result = null;
    if (GEMINI_KEY) {
      let prompt = '';
      if (type === 'hooks') prompt = `Generate ${count || 3} scroll-stopping Instagram Reel hooks about "${topic || 'content creation'}" for ${audience || 'general audience'} with a ${tone} tone. Return only the hooks, one per line, no numbering.`;
      else if (type === 'dm_script') prompt = `Write a friendly Instagram DM script for "${product || 'free guide'}". CTA: ${cta || 'check link'}. Tone: ${tone}. Max 150 words. Natural, personalized, not spammy.`;
      else if (type === 'ideas') prompt = `Generate 7 Instagram content ideas for the ${niche || 'creators'} niche for ${week || 'this week'}. Return as JSON array of objects with: title, hook, format (reel/carousel/story/static).`;
      const raw = await callGemini(prompt);
      if (raw) {
        if (type === 'hooks') result = raw.split('\n').filter(l => l.trim()).slice(0, count || 3);
        else if (type === 'ideas') { try { result = JSON.parse(raw.match(/\[[\s\S]*\]/)?.[0] || '[]'); } catch { result = null; } }
        else result = raw;
      }
    }
    if (!result) result = creatorFallback(type, request.body);
    return response.json({ success: true, result, output: result });
  } catch (err) {
    return response.status(500).json({ error: err.message || 'Generation failed' });
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

// ── Analytics Events for DM Log ─────────────────────────────────────────────
app.get('/api/analytics/events', requireAuth, async (request, response) => {
  try {
    const page = Math.max(1, parseInt(request.query.page) || 1);
    const limit = Math.min(50, parseInt(request.query.limit) || 20);
    const status = request.query.status || 'all';
    const days = parseInt(request.query.days) || 7;
    const search = request.query.search || '';
    const col = db.collections ? (db.collections().automationEvents || db.collections().automation_events) : null;
    if (!col) return response.json({ events: [], total: 0, sent: 0, failed: 0, pending: 0, pages: 1 });

    const since = new Date(Date.now() - days * 86400000).toISOString();
    const filter = {
      $or: [
        { owner_user_id: String(request.user.id) },
        { owner_user_id: request.user.id }
      ],
      created_at: { $gte: since }
    };
    if (status !== 'all') {
      filter.status = status === 'sent' ? 'success' : status;
    }
    if (search) {
      filter.$or = [
        { message_text: { $regex: search, $options: 'i' } },
        { keyword: { $regex: search, $options: 'i' } }
      ];
    }

    const [events, total, sent, failed] = await Promise.all([
      col.find(filter).sort({ created_at: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
      col.countDocuments(filter),
      col.countDocuments({ ...filter, status: 'success' }),
      col.countDocuments({ ...filter, status: 'failed' })
    ]);

    const mappedEvents = events.map(e => {
      const rawSender = e.from_username || e.username || e.from_id || e.instagram_user_id || 'Commenter';
      const cleanSender = String(rawSender).replace(/^@+/, '');
      return {
        id: e.event_id || e._id,
        senderName: cleanSender,
        username: cleanSender,
        commentText: e.comment_text || (e.keyword ? `Keyword: "${e.keyword}"` : 'Comment'),
        dmPreview: e.message_text || '–',
        dmText: e.message_text || '–',
        automationName: 'Comment to DM',
        status: e.status === 'success' ? 'sent' : e.status,
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
      pending: 0,
      pages: Math.max(1, Math.ceil(total / limit))
    });
  } catch (err) {
    return response.status(500).json({ error: err.message });
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

// ── Admin endpoints ─────────────────────────────────────────────────────────
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
      prices: pricesDoc || { pro_monthly: 999, elite_monthly: 2499 },
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
        { $set: { pro_monthly: pro_monthly || 999, elite_monthly: elite_monthly || 2499, updated_at: new Date() } },
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
    const col = db.collections ? db.collections().billing_plans : null;
    const pricesDoc = col ? await col.findOne({ _id: 'global_prices' }) : null;
    return response.json(pricesDoc || { pro_monthly: 999, elite_monthly: 2499 });
  } catch (err) { return response.json({ pro_monthly: 999, elite_monthly: 2499 }); }
});

app.post('/api/billing/validate-coupon', async (request, response) => {
  try {
    const { code } = request.body || {};
    if (!code) return response.status(400).json({ error: 'Code required' });
    const col = db.collections ? db.collections().coupons : null;
    const coupon = col ? await col.findOne({ _id: code.toUpperCase() }) : null;
    if (!coupon) return response.status(404).json({ error: 'Invalid coupon' });
    return response.json({ valid: true, discount: coupon.discount });
  } catch (err) { return response.status(500).json({ error: err.message }); }
});

// 404 & Error handlers
app.use((request, response) => {
  if (request.path.startsWith('/api/')) return response.status(404).json({ error: 'Endpoint not found.' });
  return response.status(404).sendFile(path.join(__dirname, '404.html'));
});

app.use((error, request, response, next) => {
  if (response.headersSent) return next(error);
  console.error('Server error:', error);
  response.status(error.statusCode || 500).json({
    error: error.statusCode ? error.message : 'Something went wrong. Please try again.'
  });
});

db.initialize().then(async () => {
  await billing.ensurePlans();
  app.listen(port, '0.0.0.0', () => {
    console.log(`Comment2DM server is live on port ${port} (HTTPS ready)`);
  });
}).catch((error) => {
  console.error('Database initialization failed:', error);
  process.exitCode = 1;
});
