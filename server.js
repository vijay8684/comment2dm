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

// Deliver final resource helper (guaranteed idempotent)
async function deliverFinalResource({ recipientIgUserId, senderIgsid, automation, tokenData, flow, commentId, prefixMessage, workerId }) {
  const stateKey = `${automation.id}:${recipientIgUserId}:${senderIgsid}`;
  const now = new Date();
  const workerToken = workerId || `delivery_worker_${crypto.randomUUID()}`;
  const leaseExpiresAt = new Date(now.getTime() + 60000); // 60s delivery lock lease

  // Concurrency guard 1: In-memory lock
  if (processingDeliveryKeys.has(stateKey)) {
    console.log(`[CONCURRENCY] Resource delivery already in progress for key ${stateKey}. Skipping duplicate.`);
    return;
  }
  processingDeliveryKeys.add(stateKey);

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
      // AND eligible: either not_started/failed/null OR previously sending but lease expired
      // Notice: 'unknown' outcome is NOT in the eligible list to prevent blind resends
      const claimResult = await db.collections().conversationStates.findOneAndUpdate(
        {
          key: stateKey,
          resource_delivered: { $ne: true },
          delivery_state: { $ne: 'sent' },
          $or: [
            { delivery_state: { $in: ['not_started', 'failed', null] } },
            {
              delivery_state: 'sending',
              delivery_locked_until: { $lt: now }
            }
          ]
        },
        {
          $set: {
            delivery_state: 'sending',
            delivery_worker_id: workerToken,
            delivery_locked_until: leaseExpiresAt,
            sending_started_at: now.toISOString(),
            updated_at: now.toISOString()
          }
        },
        { returnDocument: 'after' }
      );

      const claimedDoc = claimResult?.value || claimResult;
      if (!claimedDoc || claimedDoc.delivery_worker_id !== workerToken) {
        console.log(`[IDEMPOTENCY] Resource delivery already claimed, in progress or completed for ${stateKey}. Skipping.`);
        return;
      }
    }

    let deliveryText = flow.delivery?.message || automation.dm_message || "Here's what you requested! Enjoy ✨";
    if (prefixMessage) {
      deliveryText = `${prefixMessage.trim()}\n\n${deliveryText}`;
    }
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

    let metaSendResult;
    try {
      metaSendResult = await instagramService.sendDirectMessage(
        recipientIgUserId,
        senderIgsid,
        deliveryPayload,
        tokenData.accessToken
      );
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

      // 2. Unknown outcome (network timeout while awaiting response, socket hangup)
      const isUnknownOutcome = dmErr?.uncertainDelivery === true ||
        /timeout|socket hang up|econnreset/i.test(dmErr.message || '');

      if (isUnknownOutcome) {
        console.warn(`[DELIVERY UNCERTAIN] Meta send outcome uncertain for ${stateKey}: ${dmErr.message}`);
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

      // 3. Graceful fallback to text ONLY if template was definitely rejected by format error
      const isTemplateFormatRejection = (dmErr.statusCode === 400 || dmErr?.metaError?.code === 100) &&
        deliveryPayload.attachment &&
        (/template|button|attachment|format/i.test(dmErr.message || '') || /template|button|attachment|format/i.test(dmErr?.metaError?.message || ''));

      if (isTemplateFormatRejection) {
        let fallbackText = deliveryText;
        if (resourceUrl && !fallbackText.includes(resourceUrl)) {
          fallbackText += `\n\n🔗 ${buttonText}: ${resourceUrl}`;
        }
        metaSendResult = await instagramService.sendDirectMessage(
          recipientIgUserId,
          senderIgsid,
          { text: fallbackText },
          tokenData.accessToken
        );
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

    // 4. Require explicit Meta confirmation (message_id / id)
    const metaMsgId = metaSendResult?.message_id || metaSendResult?.id || null;
    if (!metaMsgId) {
      console.warn(`[DELIVERY UNCONFIRMED] Meta response did not include message_id for ${stateKey}`);
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
      return;
    }

    // 5. Only mark "sent" and resource_delivered=true AFTER Meta confirms acceptance!
    if (db.collections && db.collections().conversationStates) {
      await db.collections().conversationStates.updateOne(
        { key: stateKey, delivery_worker_id: workerToken },
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
  } finally {
    setTimeout(() => {
      processingDeliveryKeys.delete(stateKey);
    }, 15000);
  }
}

// ==========================================
// Webhook Job Processing & Execution Engine
// ==========================================

async function executeCommentJob(job) {
  const recipientIgUserId = job.instagram_account_id;
  const commentId = job.comment_id;
  const commentText = job.comment_text;
  const fromId = job.from_id;
  const fromUsername = job.from_username;
  const commentMediaId = job.media_id || '';

  // 1. Check if comment was already replied to
  if (db.collections && db.collections().automationEvents) {
    const alreadyDone = await db.collections().automationEvents.findOne({
      comment_id: commentId,
      status: 'success'
    });
    if (alreadyDone) {
      console.log(`[DEDUP] Skipping comment ${commentId}: already successfully replied.`);
      return;
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
    console.log(`No active automations found for Instagram account ${recipientIgUserId}`);
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
    console.log(`[TRIGGER] No matching automation keyword for comment "${commentText}" (Media: ${commentMediaId}).`);
    return;
  }

  console.log(`[TRIGGER] Matched automation ${selectedAuto.id} for comment "${commentText}" (ID: ${commentId}). Sending interactive opening DM...`);

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

  // Prepare opening message text
  let messageToSend = flow.openingMessage || selectedAuto.dm_message || "Hey! I'm so glad you're here — thanks for your interest 😊\n\nTap below and I'll send you the link in just a moment ✨";

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

  try {
    // 1. Send Interactive Private DM
    const sendResult = await instagramService.sendPrivateReply(
      recipientIgUserId,
      commentId,
      msgPayload,
      tokenData.accessToken
    );

    const metaMsgId = sendResult?.message_id || sendResult?.id || null;

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
            meta_message_id: metaMsgId,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }
        },
        { upsert: true }
      );
    }

    // 3. Record automation event for PRIVATE DM immediately!
    // Confirms DM success before attempting public replies, preventing DM repetition on public reply error
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
    console.log(`[TRIGGER SUCCESS] Successfully sent opening DM for comment ID ${commentId}`);

    // 4. Send Public Comment Reply in an isolated try/catch (if configured)
    // Public comment errors/rate limits must NEVER fail or repeat the already-confirmed private DM!
    if (selectedAuto.reply_template) {
      try {
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
            message_text: selectedAuto.reply_template,
            status: 'success',
            meta_comment_id: publicReplyResult?.id || null,
            created_at: new Date().toISOString(),
            created_at_date: new Date()
          });
        }
      } catch (publicErr) {
        console.warn(`[PUBLIC REPLY NOTE] Public comment reply failed for comment ${commentId}: ${publicErr.message}`);
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
            message_text: selectedAuto.reply_template,
            status: 'failed',
            error: publicErr.message,
            created_at: new Date().toISOString(),
            created_at_date: new Date()
          });
        }
      }
    }
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
        created_at: new Date().toISOString(),
        created_at_date: new Date()
      });
    } else {
      await db.run(
        'INSERT INTO automation_events (owner_user_id, instagram_user_id, automation_id, comment_id, event_type, keyword, message_text, status, error_message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [selectedAuto.owner_user_id, recipientIgUserId, selectedAuto.id, commentId, 'private_reply', selectedAuto.keyword, selectedAuto.dm_message, 'failed', apiErr.message, new Date().toISOString()]
      );
    }
    console.error(`Failed to execute automation for comment ${commentId}:`, apiErr.message);
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

  console.log(`[MESSAGING] Interactive event: action="${action}", sender="${senderIgsid}", recipient="${recipientIgUserId}"`);

  let targetAutomation = null;
  if (autoId) {
    targetAutomation = await db.get('SELECT * FROM automations WHERE id = ?', [autoId]);
    if (!targetAutomation && db.collections && db.collections().automations) {
      targetAutomation = await db.collections().automations.findOne({ id: autoId });
    }
  }

  if (!targetAutomation) {
    const active = await db.all(
      'SELECT * FROM automations WHERE instagram_user_id = ? AND enabled = 1 ORDER BY updated_at DESC LIMIT 1',
      [recipientIgUserId]
    );
    targetAutomation = active?.[0];
    if (!targetAutomation && db.collections && db.collections().automations) {
      targetAutomation = await db.collections().automations.findOne(
        { instagram_user_id: recipientIgUserId, enabled: { $in: [true, 1, '1'] } },
        { sort: { updated_at: -1 } }
      );
    }
  }

  if (!targetAutomation) {
    console.log(`[MESSAGING] No matching automation for recipient ${recipientIgUserId}`);
    return;
  }

  if (String(targetAutomation.instagram_user_id) !== String(recipientIgUserId)) {
    console.log(`[ROUTING] Ignoring cross-account event: automation ${targetAutomation.id} belongs to ${targetAutomation.instagram_user_id}, but delivered to ${recipientIgUserId}`);
    return;
  }

  const tokenData = await instagramService.getDecryptedTokenByInstagramUserId(recipientIgUserId, targetAutomation.owner_user_id);
  const flow = targetAutomation.flow || {};
  const creatorUsername = tokenData.username || 'creator';
  const stateKey = `${targetAutomation.id}:${targetAutomation.instagram_user_id}:${senderIgsid}`;

  let convState = null;
  if (db.collections && db.collections().conversationStates) {
    convState = await db.collections().conversationStates.findOne({
      $or: [
        { key: stateKey },
        { automation_id: targetAutomation.id, sender_igsid: senderIgsid },
        { automation_id: targetAutomation.id, commenter_id: senderIgsid }
      ]
    });
  }

  if (convState && convState.resource_delivered === true) {
    console.log(`[IDEMPOTENCY] Resource already delivered to ${senderIgsid} for automation ${targetAutomation.id}. Ignoring duplicate trigger.`);
    return;
  }

  const profileBtn = (flow.followGate?.profileBtnText || flow.followGate?.buttonText || "Visit Profile").trim().slice(0, 20);
  const confirmBtn = (flow.followGate?.confirmBtnText || flow.followGate?.checkButtonText || "I'm following ✅").trim().slice(0, 20);
  let profileUrl = flow.followGate?.profileUrl || `https://instagram.com/${creatorUsername}`;
  if (!profileUrl.startsWith('http')) {
    profileUrl = `https://instagram.com/${profileUrl.replace(/^@/, '')}`;
  }

  if (action === 'SEND_LINK') {
    if (!flow.followGate?.enabled) {
      console.log(`[MESSAGING] Follow gate disabled. Delivering resource immediately to ${senderIgsid}...`);
      await deliverFinalResource({ recipientIgUserId, senderIgsid, automation: targetAutomation, tokenData, flow, commentId, workerId: job?.worker_id });
      return;
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

    if (followResult.isFollowing === true && followResult.verified === true) {
      console.log(`[MESSAGING] PATH A: Recipient ${senderIgsid} already follows @${creatorUsername}. Delivering resource immediately.`);
      await deliverFinalResource({ recipientIgUserId, senderIgsid, automation: targetAutomation, tokenData, flow, commentId, workerId: job?.worker_id });
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
              { type: 'postback', title: 'Retry Check 🔄'.slice(0, 20), payload: `CHECK_FOLLOW:${targetAutomation.id}:${commentId}` }
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

      try {
        await instagramService.sendDirectMessage(recipientIgUserId, senderIgsid, retryPayload, tokenData.accessToken);
      } catch (_) {
        await instagramService.sendDirectMessage(recipientIgUserId, senderIgsid, {
          text: `${retryNotice}\n\n👉 Profile: ${profileUrl}`,
          quick_replies: [{ content_type: 'text', title: 'Retry Check 🔄'.slice(0, 20), payload: `CHECK_FOLLOW:${targetAutomation.id}:${commentId}` }]
        }, tokenData.accessToken);
      }
    } else {
      console.log(`[MESSAGING] PATH B: Recipient ${senderIgsid} does not follow @${creatorUsername}. Sending two-button follow prompt.`);
      const followPrompt = flow.followGate?.message || "Oops! Looks like you haven't followed me yet 👀\n\nIt would mean a lot if you could visit my profile and hit that follow button 😊";

      const followPromptPayload = {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'button',
            text: followPrompt,
            buttons: [
              { type: 'web_url', url: profileUrl, title: profileBtn },
              { type: 'postback', title: confirmBtn, payload: `CHECK_FOLLOW:${targetAutomation.id}:${commentId}` }
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

      try {
        await instagramService.sendDirectMessage(recipientIgUserId, senderIgsid, followPromptPayload, tokenData.accessToken);
      } catch (dmErr) {
        await instagramService.sendDirectMessage(
          recipientIgUserId,
          senderIgsid,
          {
            text: `${followPrompt}\n\n👉 ${profileBtn}: ${profileUrl}`,
            quick_replies: [{ content_type: 'text', title: confirmBtn, payload: `CHECK_FOLLOW:${targetAutomation.id}:${commentId}` }]
          },
          tokenData.accessToken
        );
      }
    }
  } else if (action === 'CHECK_FOLLOW') {
    if (db.collections && db.collections().conversationStates) {
      await db.collections().conversationStates.updateOne(
        { key: stateKey },
        { $set: { state: 'CHECKING_FOLLOW_STATUS', updated_at: new Date().toISOString() } }
      );
    }

    console.log(`[MESSAGING] Fresh follower check on user tap "${confirmBtn}" for ${senderIgsid}...`);
    const recheckResult = await instagramService.checkFollowStatus(recipientIgUserId, senderIgsid, tokenData.accessToken);

    if (recheckResult.isFollowing === true && recheckResult.verified === true) {
      console.log(`[MESSAGING] Follower confirmed! Delivering resource to ${senderIgsid}.`);
      const successPrefix = flow.followGate?.successMessage || "You're all set! 🎉\n\nHere is your requested guide:";
      await deliverFinalResource({
        recipientIgUserId,
        senderIgsid,
        automation: targetAutomation,
        tokenData,
        flow,
        commentId,
        prefixMessage: successPrefix
      });
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
              { type: 'postback', title: 'Retry Check 🔄'.slice(0, 20), payload: `CHECK_FOLLOW:${targetAutomation.id}:${commentId}` }
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

      try {
        await instagramService.sendDirectMessage(recipientIgUserId, senderIgsid, retryPayload, tokenData.accessToken);
      } catch (_) {
        await instagramService.sendDirectMessage(recipientIgUserId, senderIgsid, {
          text: `${retryNotice}\n\n👉 Profile: ${profileUrl}`,
          quick_replies: [{ content_type: 'text', title: 'Retry Check 🔄'.slice(0, 20), payload: `CHECK_FOLLOW:${targetAutomation.id}:${commentId}` }]
        }, tokenData.accessToken);
      }
    } else {
      console.log(`[MESSAGING] Follow still not detected for ${senderIgsid}. Sending polite retry prompt.`);
      const retryMsg = flow.followGate?.retryMessage || "Still not seeing that follow yet! 👀 If you just hit follow, please wait a few seconds for Instagram to sync and tap below to retry.";

      const retryPromptPayload = {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'button',
            text: retryMsg,
            buttons: [
              { type: 'web_url', url: profileUrl, title: profileBtn },
              { type: 'postback', title: confirmBtn, payload: `CHECK_FOLLOW:${targetAutomation.id}:${commentId}` }
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

async function executeWebhookJob(job) {
  if (job.event_type === 'comment') {
    return await executeCommentJob(job);
  } else if (job.event_type && job.event_type.startsWith('messaging_')) {
    return await executeMessagingJob(job);
  }
}

let isDrainingQueue = false;
async function drainJobQueue() {
  if (isDrainingQueue) return;
  isDrainingQueue = true;
  try {
    let job = await webhookJobQueue.claimNextJob(db);
    while (job) {
      try {
        await executeWebhookJob(job);
        await webhookJobQueue.updateJobStatus(job, 'sent', {}, db);
      } catch (err) {
        console.error(`[QUEUE ERROR] Failed to process job ${job.job_id}:`, err.message);
        await webhookJobQueue.updateJobStatus(job, 'failed', { error: err.message }, db);
      }
      job = await webhookJobQueue.claimNextJob(db);
    }
  } catch (err) {
    console.error('Queue draining loop error:', err.message);
  } finally {
    isDrainingQueue = false;
  }
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

    // 4. Return HTTP 200 ONLY after durable persistence succeeds
    response.status(200).json({
      status: 'ok',
      enqueued: ingestResult.count,
      duplicates: ingestResult.duplicates
    });

    // 5. Asynchronous queue processing (completely decoupled from HTTP webhook response)
    if (process.env.NODE_ENV !== 'test' && ingestResult.count > 0) {
      setImmediate(() => {
        drainJobQueue().catch(err => console.error('[QUEUE ERROR] Failed to drain jobs:', err.message));
      });
    }
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

      // 4. Counts
      const [countSent, countFailed, countCommentsRaw] = await Promise.all([
        colEvents.countDocuments({ ...baseEventFilter, event_type: 'private_reply', status: 'success' }),
        colEvents.countDocuments({ ...baseEventFilter, event_type: 'private_reply', status: 'failed' }),
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
          const autoSent = await colEvents.countDocuments({ automation_id: auto.id, status: 'success' });
          const autoFailed = await colEvents.countDocuments({ automation_id: auto.id, status: 'failed' });
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
        eventType: e.event_type || 'private_reply',
        status: e.status,
        keyword: e.keyword,
        messageText: e.message_text,
        errorMessage: e.error_message,
        fromUsername: e.from_username || e.username,
        createdAt: e.created_at
      }));

      // 7. Daily breakdown
      const allEventsForDaily = await colEvents.find(baseEventFilter).toArray();
      const dateMap = {};
      for (const e of allEventsForDaily) {
        const d = String(e.created_at || '').slice(0, 10);
        if (!d) continue;
        if (!dateMap[d]) dateMap[d] = { date: d, count: 0, messagesSent: 0, messagesFailed: 0 };
        if (e.event_type === 'private_reply' && e.status === 'success') {
          dateMap[d].count += 1;
          dateMap[d].messagesSent += 1;
        } else if (e.event_type === 'private_reply' && e.status === 'failed') {
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
              SUM(CASE WHEN event_type = 'private_reply' AND status = 'success' THEN 1 ELSE 0 END) AS messagesSent,
              SUM(CASE WHEN event_type = 'private_reply' AND status = 'failed' THEN 1 ELSE 0 END) AS messagesFailed,
              SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successfulEvents
              FROM automation_events WHERE owner_user_id = ? AND instagram_user_id = ?`, [ownerId, requestedIgUserId])
          : db.get(`SELECT
              SUM(CASE WHEN event_type = 'comment_received' THEN 1 ELSE 0 END) AS comments,
              SUM(CASE WHEN event_type = 'private_reply' AND status = 'success' THEN 1 ELSE 0 END) AS messagesSent,
              SUM(CASE WHEN event_type = 'private_reply' AND status = 'failed' THEN 1 ELSE 0 END) AS messagesFailed,
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
              SUM(CASE WHEN event_type = 'private_reply' AND status = 'success' THEN 1 ELSE 0 END) AS messagesSent,
              SUM(CASE WHEN event_type = 'private_reply' AND status = 'failed' THEN 1 ELSE 0 END) AS messagesFailed
              FROM automation_events WHERE owner_user_id = ? AND instagram_user_id = ? AND created_at >= datetime('now','-29 days')
              GROUP BY substr(created_at,1,10) ORDER BY date ASC`, [ownerId, requestedIgUserId])
          : db.all(`SELECT substr(created_at,1,10) AS date,
              SUM(CASE WHEN event_type = 'comment_received' THEN 1 ELSE 0 END) AS comments,
              SUM(CASE WHEN event_type = 'private_reply' AND status = 'success' THEN 1 ELSE 0 END) AS messagesSent,
              SUM(CASE WHEN event_type = 'private_reply' AND status = 'failed' THEN 1 ELSE 0 END) AS messagesFailed
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
    const deliveryRate = totalDMs > 0 ? Math.round((sent / totalDMs) * 100) : 0;

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

      // Base filter for counting sent, failed, and pending (excluding raw non-DM triggers)
      const baseFilter = {
        $and: [
          ...baseAndClauses,
          {
            $or: [
              { event_type: 'private_reply' },
              { event_type: { $exists: false } },
              { event_type: null }
            ]
          }
        ]
      };

      // Filter for the paginated list (adds status & search)
      const listAndClauses = [...baseAndClauses];

      if (status === 'sent' || status === 'success') {
        listAndClauses.push({ status: 'success' });
      } else if (status === 'failed') {
        listAndClauses.push({ status: 'failed' });
      } else if (status === 'pending') {
        listAndClauses.push({ status: { $in: ['pending', 'queued', 'processing'] } });
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

      const [events, listTotal, sent, failed, pending] = await Promise.all([
        col.find(listFilter).sort({ created_at: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
        col.countDocuments(listFilter),
        col.countDocuments({ ...baseFilter, status: 'success' }),
        col.countDocuments({ ...baseFilter, status: 'failed' }),
        col.countDocuments({ ...baseFilter, status: { $in: ['pending', 'queued', 'processing'] } })
      ]);

      const total = sent + failed + pending;

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
          buttonText: e.button_text || null,
          automationName: e.keyword ? `Keyword: ${e.keyword}` : 'Comment to DM',
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
        listTotal,
        pages: Math.max(1, Math.ceil(listTotal / limit)),
        page,
        limit
      });
    } else {
      // SQLite fallback
      const events = await db.all(
        requestedIgUserId
          ? 'SELECT event_type AS eventType, status, keyword, message_text AS messageText, error_message AS errorMessage, created_at AS createdAt FROM automation_events WHERE owner_user_id = ? AND instagram_user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
          : 'SELECT event_type AS eventType, status, keyword, message_text AS messageText, error_message AS errorMessage, created_at AS createdAt FROM automation_events WHERE owner_user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
        requestedIgUserId ? [request.user.id, requestedIgUserId, limit, (page - 1) * limit] : [request.user.id, limit, (page - 1) * limit]
      );
      const totals = await db.get(
        requestedIgUserId
          ? `SELECT
              SUM(CASE WHEN event_type = 'private_reply' AND status = 'success' THEN 1 ELSE 0 END) AS sent,
              SUM(CASE WHEN event_type = 'private_reply' AND status = 'failed' THEN 1 ELSE 0 END) AS failed
              FROM automation_events WHERE owner_user_id = ? AND instagram_user_id = ?`
          : `SELECT
              SUM(CASE WHEN event_type = 'private_reply' AND status = 'success' THEN 1 ELSE 0 END) AS sent,
              SUM(CASE WHEN event_type = 'private_reply' AND status = 'failed' THEN 1 ELSE 0 END) AS failed
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
    await billing.ensurePlans();
    app.listen(port, '0.0.0.0', () => {
      console.log(`Comment2DM server is live on port ${port} (HTTPS ready)`);
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
module.exports = { app, deliverFinalResource, executeCommentJob, executeMessagingJob, executeWebhookJob };