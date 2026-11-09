const crypto = require('crypto');
const db = require('../db');

const apiVersion = process.env.META_API_VERSION || 'v21.0';
const requiredConfig = ['META_APP_ID', 'META_APP_SECRET', 'META_REDIRECT_URI', 'META_TOKEN_ENCRYPTION_KEY'];

// 5-minute cache for media/reels to prevent lag and Meta rate limits
const reelsCache = new Map();

function ensureConfiguration() {
  const missing = requiredConfig.filter((key) => !process.env[key]);
  if (missing.length) {
    const error = new Error(`Instagram integration is not configured. Missing: ${missing.join(', ')}`);
    error.statusCode = 503;
    throw error;
  }
  if (!/^[a-f0-9]{64}$/i.test(process.env.META_TOKEN_ENCRYPTION_KEY)) {
    const error = new Error('META_TOKEN_ENCRYPTION_KEY must be a 64-character hexadecimal key.');
    error.statusCode = 500;
    throw error;
  }
}

function encryptToken(token) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(process.env.META_TOKEN_ENCRYPTION_KEY, 'hex'), iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return { ciphertext: encrypted.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

function publicAccount(account) {
  return {
    id: account.instagram_user_id,
    username: account.username,
    status: account.expires_at > Date.now() ? 'Connected' : 'Token expired',
    expiresAt: new Date(account.expires_at).toISOString(),
    connectedAt: account.connected_at
  };
}

function metaErrorMessage(data, fallback) {
  return data?.error?.message || data?.error_message || data?.message || fallback;
}

async function exchangeCode(code) {
  ensureConfiguration();
  const cleanCode = typeof code === 'string' ? code.replace(/#_.*$/, '').replace(/#$/, '').trim() : code;

  // Primary: api.instagram.com exchange (Direct Instagram Login)
  try {
    const params = new URLSearchParams();
    params.set('client_id', process.env.META_APP_ID);
    params.set('client_secret', process.env.META_APP_SECRET);
    params.set('grant_type', 'authorization_code');
    params.set('redirect_uri', process.env.META_REDIRECT_URI);
    params.set('code', cleanCode);

    const response = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    const data = await response.json().catch(() => ({}));

    if (response.ok && data.access_token) {
      console.log('Successfully exchanged code via api.instagram.com for user:', data.user_id);
      
      // Exchange for 60-day long-lived token via graph.instagram.com
      try {
        const longLivedUrl = new URL('https://graph.instagram.com/access_token');
        longLivedUrl.searchParams.set('grant_type', 'ig_exchange_token');
        longLivedUrl.searchParams.set('client_secret', process.env.META_APP_SECRET);
        longLivedUrl.searchParams.set('access_token', data.access_token);

        const longLivedResponse = await fetch(longLivedUrl);
        const longLivedData = await longLivedResponse.json().catch(() => ({}));

        if (longLivedResponse.ok && longLivedData.access_token) {
          console.log('Successfully exchanged for 60-day long-lived Instagram token.');
          return {
            accessToken: longLivedData.access_token,
            expiresIn: Number(longLivedData.expires_in) || (60 * 86400),
            userId: data.user_id ? String(data.user_id) : undefined
          };
        }
      } catch (longLivedErr) {
        console.warn('Long-lived token exchange warning:', longLivedErr.message);
      }

      // Return short-lived token if long-lived exchange failed
      return {
        accessToken: data.access_token,
        expiresIn: Number(data.expires_in) || (60 * 86400),
        userId: data.user_id ? String(data.user_id) : undefined
      };
    } else {
      console.warn('api.instagram.com exchange failed, attempting graph.facebook.com fallback:', metaErrorMessage(data, 'Unknown'));
    }
  } catch (err) {
    console.warn('api.instagram.com exchange notice:', err.message);
  }

  // Fallback: Meta Unified Login exchange via graph.facebook.com
  try {
    const fbUrl = new URL(`https://graph.facebook.com/${apiVersion}/oauth/access_token`);
    fbUrl.searchParams.set('client_id', process.env.META_APP_ID);
    fbUrl.searchParams.set('client_secret', process.env.META_APP_SECRET);
    fbUrl.searchParams.set('redirect_uri', process.env.META_REDIRECT_URI);
    fbUrl.searchParams.set('code', cleanCode);

    const fbResponse = await fetch(fbUrl);
    const fbData = await fbResponse.json().catch(() => ({}));
    if (fbResponse.ok && fbData.access_token) {
      console.log('Successfully exchanged code via Meta Unified Login.');
      return {
        accessToken: fbData.access_token,
        expiresIn: Number(fbData.expires_in) || (60 * 86400)
      };
    }

    const error = new Error(`Instagram code exchange failed: ${metaErrorMessage(fbData, 'No access token returned.')}`);
    error.statusCode = 502;
    error.stage = 'code_exchange';
    error.metaError = fbData.error;
    throw error;
  } catch (err) {
    if (err.statusCode) throw err;
    const error = new Error(`Instagram code exchange network error: ${err.message}`);
    error.statusCode = 502;
    throw error;
  }
}

async function fetchProfile(accessToken) {
  // 1. Direct Instagram lookup via graph.instagram.com /me (Direct SendDM Login)
  try {
    const profileUrl = new URL(`https://graph.instagram.com/${apiVersion}/me`);
    profileUrl.searchParams.set('fields', 'user_id,username,name,profile_picture_url,followers_count,id');
    profileUrl.searchParams.set('access_token', accessToken);

    let response = await fetch(profileUrl);
    let data = await response.json().catch(() => ({}));

    // If extended fields failed (e.g. followers_count not available), retry with basic id,username
    if (!response.ok || (!data.user_id && !data.id)) {
      const basicUrl = new URL(`https://graph.instagram.com/${apiVersion}/me`);
      basicUrl.searchParams.set('fields', 'id,username');
      basicUrl.searchParams.set('access_token', accessToken);
      const basicRes = await fetch(basicUrl);
      const basicData = await basicRes.json().catch(() => ({}));
      if (basicRes.ok && (basicData.user_id || basicData.id)) {
        data = basicData;
        response = basicRes;
      }
    }

    if (response.ok && (data.user_id || data.id)) {
      console.log('Successfully fetched profile via direct Instagram API:', data.username, data.user_id || data.id);
      return {
        userId: String(data.user_id || data.id),
        username: data.username || 'Instagram account',
        name: data.name || data.username || '',
        profilePictureUrl: data.profile_picture_url || null,
        followersCount: Number(data.followers_count) || 0
      };
    }
  } catch (err) {
    console.warn('Direct Instagram profile lookup notice:', err.message);
  }

  // 2. Fallback: check assigned_instagram_accounts
  try {
    const assignedUrl = new URL(`https://graph.facebook.com/${apiVersion}/me/assigned_instagram_accounts`);
    assignedUrl.searchParams.set('fields', 'id,username');
    assignedUrl.searchParams.set('access_token', accessToken);
    const assignedRes = await fetch(assignedUrl);
    const assignedData = await assignedRes.json().catch(() => ({}));
    if (assignedRes.ok && Array.isArray(assignedData.data) && assignedData.data.length > 0) {
      const ig = assignedData.data[0];
      return {
        userId: String(ig.id),
        username: ig.username || 'Instagram account',
        name: ig.username || 'Instagram account',
        profilePictureUrl: null,
        followersCount: 0
      };
    }
  } catch (_) {}

  // 3. Fallback: check linked Instagram accounts via Facebook Pages
  try {
    const pagesUrl = new URL(`https://graph.facebook.com/${apiVersion}/me/accounts`);
    pagesUrl.searchParams.set('fields', 'id,name,instagram_business_account{id,username,name,profile_picture_url}');
    pagesUrl.searchParams.set('access_token', accessToken);
    const pagesRes = await fetch(pagesUrl);
    const pagesData = await pagesRes.json().catch(() => ({}));
    if (pagesRes.ok && Array.isArray(pagesData.data)) {
      for (const page of pagesData.data) {
        if (page.instagram_business_account) {
          const ig = page.instagram_business_account;
          return {
            userId: String(ig.id),
            username: ig.username || page.name,
            name: ig.name || page.name || '',
            profilePictureUrl: ig.profile_picture_url || null,
            followersCount: 0
          };
        }
      }
    }
  } catch (_) {}

  const error = new Error('Could not retrieve Instagram profile. Please reconnect your Instagram account.');
  error.statusCode = 502;
  throw error;
}

async function subscribeToWebhooks(instagramUserId, accessToken) {
  const url = new URL(`https://graph.instagram.com/${apiVersion}/${instagramUserId}/subscribed_apps`);
  url.searchParams.set('subscribed_fields', 'comments,messages');

  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.success !== true) {
    const fallbackUrl = new URL(`https://graph.facebook.com/${apiVersion}/${instagramUserId}/subscribed_apps`);
    fallbackUrl.searchParams.set('subscribed_fields', 'comments,messages');
    const fbRes = await fetch(fallbackUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const fbData = await fbRes.json().catch(() => ({}));
    if (fbRes.ok && fbData.success === true) {
      console.log(`Instagram webhook subscription succeeded via Facebook Graph for account ${instagramUserId}.`);
      return fbData;
    }

    console.warn(`Instagram webhook subscription warning (HTTP ${response.status}): ${metaErrorMessage(data, 'Subscription could not be verified automatically.')}`);
    return data;
  }

  console.log(`Instagram webhook subscription succeeded for account ${instagramUserId}.`);
  return data;
}

async function saveAccount(userId, profile, token) {
  const encrypted = encryptToken(token.accessToken);
  await db.run(
    `INSERT INTO instagram_accounts
    (owner_user_id, instagram_user_id, username, ciphertext, iv, tag, expires_at, connected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, profile.userId, profile.username, encrypted.ciphertext, encrypted.iv, encrypted.tag, Date.now() + token.expiresIn * 1000, new Date().toISOString()]
  );
  await subscribeToWebhooks(profile.userId, token.accessToken);
}

async function listAccounts(userId) {
  const accounts = await db.getInstagramAccounts(userId);
  return accounts.map(publicAccount);
}

async function listReels(ownerUserId, instagramUserId, forceRefresh = false) {
  const cacheKey = `${ownerUserId}:${instagramUserId}`;
  const cached = reelsCache.get(cacheKey);
  if (!forceRefresh && cached && cached.expires > Date.now()) {
    return cached.items;
  }

  const accessToken = await getDecryptedTokenForAccount(ownerUserId, instagramUserId);
  const items = [];
  let nextUrl = new URL(`https://graph.instagram.com/${apiVersion}/${instagramUserId}/media`);
  nextUrl.searchParams.set('fields', 'id,caption,media_type,media_product_type,permalink,timestamp,thumbnail_url,media_url,comments_count,like_count');
  nextUrl.searchParams.set('limit', '50');
  nextUrl.searchParams.set('access_token', accessToken);

  try {
    for (let page = 0; page < 2 && nextUrl; page += 1) {
      let response = await fetch(nextUrl);
      let data = await response.json().catch(() => ({}));
      if (!response.ok) {
        // Fallback to Facebook Graph endpoint for Unified Login tokens
        const fbMediaUrl = new URL(`https://graph.facebook.com/${apiVersion}/${instagramUserId}/media`);
        fbMediaUrl.searchParams.set('fields', 'id,caption,media_type,media_product_type,permalink,timestamp,thumbnail_url,media_url,comments_count,like_count');
        fbMediaUrl.searchParams.set('limit', '50');
        fbMediaUrl.searchParams.set('access_token', accessToken);
        const fbRes = await fetch(fbMediaUrl);
        const fbData = await fbRes.json().catch(() => ({}));
        if (fbRes.ok && Array.isArray(fbData.data)) {
          data = fbData;
          response = fbRes;
        } else {
          break;
        }
      }
      for (const media of Array.isArray(data.data) ? data.data : []) {
        items.push({
          id: String(media.id),
          caption: String(media.caption || ''),
          permalink: media.permalink || '',
          timestamp: media.timestamp || null,
          thumbnailUrl: media.thumbnail_url || media.media_url || null,
          mediaType: media.media_product_type || media.media_type || 'POST',
          commentsCount: Number(media.comments_count) || 0,
          likeCount: Number(media.like_count) || 0
        });
      }
      const next = data.paging?.next;
      nextUrl = next ? new URL(next) : null;
    }
  } catch (err) {
    console.error('Failed to fetch reels from Instagram API:', err.message);
  }

  reelsCache.set(cacheKey, { items, expires: Date.now() + 5 * 60 * 1000 });
  return items;
}

async function resolveReelUrl(ownerUserId, instagramUserId, reelUrl) {
  const raw = String(reelUrl || '').trim();
  if (!raw) return null;

  // Direct media ID match
  if (/^\d+$/.test(raw)) {
    return { id: raw, permalink: `https://www.instagram.com/p/${raw}/` };
  }

  let requested;
  try {
    requested = new URL(raw);
  } catch {
    const error = new Error('Enter a valid Instagram Reel link.');
    error.statusCode = 400;
    throw error;
  }
  if (requested.hostname !== 'instagram.com' && !requested.hostname.endsWith('.instagram.com')) {
    const error = new Error('The link must be an Instagram URL.');
    error.statusCode = 400;
    throw error;
  }

  const normalizedPath = requested.pathname.replace(/\/+$/, '').toLowerCase();
  const reels = await listReels(ownerUserId, instagramUserId);
  const match = reels.find((item) => {
    try {
      const u = new URL(item.permalink);
      return u.pathname.replace(/\/+$/, '').toLowerCase() === normalizedPath;
    } catch {
      return false;
    }
  });

  if (!match) {
    // If exact match not in first pages, permit using the URL directly to prevent blocking the user
    return { id: null, permalink: raw };
  }
  return match;
}

async function disconnect(userId, instagramUserId) {
  if (db.collections) {
    const { instagramAccounts, automations } = db.collections();
    const ids = [String(instagramUserId)];
    if (!isNaN(Number(instagramUserId))) ids.push(Number(instagramUserId));
    await Promise.allSettled([
      instagramAccounts.deleteMany({
        $or: [
          { instagram_user_id: { $in: ids }, owner_user_id: String(userId) },
          { instagram_user_id: { $in: ids } }
        ]
      }),
      automations.deleteMany({
        $or: [
          { instagram_user_id: { $in: ids }, owner_user_id: String(userId) },
          { instagram_user_id: { $in: ids } }
        ]
      })
    ]);
  } else {
    await db.run('DELETE FROM instagram_accounts WHERE owner_user_id = ? AND instagram_user_id = ?', [userId, instagramUserId]);
    await db.run('DELETE FROM automations WHERE owner_user_id = ? AND instagram_user_id = ?', [userId, instagramUserId]);
  }
  reelsCache.delete(`${userId}:${instagramUserId}`);
}

async function listAllAccounts() {
  const accounts = await db.collections().instagramAccounts.find({}).toArray();
  return accounts.map((a) => ({
    ownerUserId: a.owner_user_id,
    instagramUserId: a.instagram_user_id,
    username: a.username,
    expiresAt: a.expires_at,
    connectedAt: a.connected_at
  }));
}

function decryptToken(ciphertext, iv, tag) {
  ensureConfiguration();
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(process.env.META_TOKEN_ENCRYPTION_KEY, 'hex'), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]);
  return decrypted.toString('utf8');
}

async function getAccount(ownerUserId, instagramUserId) {
  return db.getInstagramAccount(ownerUserId, instagramUserId);
}

async function getDecryptedTokenForAccount(ownerUserId, instagramUserId) {
  const account = await getAccount(ownerUserId, instagramUserId);
  if (!account) {
    const error = new Error('Connected Instagram account not found.');
    error.statusCode = 404;
    throw error;
  }
  if (account.expires_at <= Date.now()) {
    const error = new Error('Instagram access token has expired. Please reconnect your account.');
    error.statusCode = 401;
    throw error;
  }
  return decryptToken(account.ciphertext, account.iv, account.tag);
}

async function getDecryptedTokenByInstagramUserId(instagramUserId, ownerUserId) {
  let account;
  if (ownerUserId) {
    account = await db.getInstagramAccount(ownerUserId, instagramUserId);
  }
  if (!account && db.collections) {
    const { instagramAccounts } = db.collections();
    const ids = [String(instagramUserId)];
    if (!isNaN(Number(instagramUserId))) ids.push(Number(instagramUserId));

    account = await instagramAccounts.findOne(
      { instagram_user_id: { $in: ids } },
      { sort: { expires_at: -1 } }
    );

    // Fallback: If not found by ID alone, find any active account for this owner
    if (!account && ownerUserId) {
      account = await instagramAccounts.findOne(
        { owner_user_id: String(ownerUserId) },
        { sort: { expires_at: -1 } }
      );
    }
  }
  if (!account) {
    const error = new Error(`Connected Instagram account ${instagramUserId} not found.`);
    error.statusCode = 404;
    throw error;
  }
  if (account.expires_at <= Date.now()) {
    const error = new Error('Instagram access token has expired.');
    error.statusCode = 401;
    throw error;
  }
  return {
    accessToken: decryptToken(account.ciphertext, account.iv, account.tag),
    ownerUserId: account.owner_user_id,
    username: account.username
  };
}

function redactToken(token) {
  if (!token || typeof token !== 'string') return '[NONE]';
  if (token.length <= 14) return '***';
  return `${token.slice(0, 8)}...${token.slice(-6)}`;
}

// 1. Send Private DM Reply to Commenter
async function sendPrivateReply(instagramUserId, commentId, messageContent, accessToken) {
  const messageObj = typeof messageContent === 'object' && messageContent !== null
    ? messageContent
    : { text: String(messageContent) };
  const bodyData = { recipient: { comment_id: commentId }, message: messageObj };
  const sanitizedToken = redactToken(accessToken);
  
  // Attempt 1: graph.instagram.com with user ID (Standard Instagram Graph API)
  const url1 = `https://graph.instagram.com/${apiVersion}/${instagramUserId}/messages`;
  console.log(`[META PRIVATE REPLY OUTGOING] POST ${url1}`);
  console.log(`[META PRIVATE REPLY HEADERS] Authorization: Bearer ${sanitizedToken}, Content-Type: application/json`);
  console.log(`[META PRIVATE REPLY PAYLOAD] ${JSON.stringify(bodyData, null, 2)}`);

  let response = await fetch(url1, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(bodyData)
  });
  let data = await response.json().catch(() => ({}));
  console.log(`[META PRIVATE REPLY RESPONSE 1] Status: ${response.status} ${response.statusText}, Body: ${JSON.stringify(data)}`);

  if (response.ok && (data.message_id || data.id || data.recipient_id)) {
    console.log(`[META SUCCESS] Private DM sent successfully via graph.instagram.com to comment ${commentId}. Message ID: ${data.message_id || data.id}`);
    console.log(`[INBOX PLACEMENT NOTE] Meta routes proactive comment private replies to non-followers into the recipient's "Message Requests" or "Hidden Requests" tab. On Instagram mobile apps, quick reply buttons become interactive once the recipient views or accepts the chat request.`);
    return data;
  }

  // If Button Template on comment_id failed, try fallback to quick_replies
  if (!response.ok && bodyData.message?.attachment?.payload?.template_type === 'button') {
    console.warn(`[META RETRY] Button template on comment_id returned HTTP ${response.status}. Retrying with quick_replies fallback...`);
    const btn = bodyData.message.attachment.payload.buttons?.[0];
    const fallbackBody = {
      recipient: { comment_id: commentId },
      message: {
        text: bodyData.message.attachment.payload.text || 'Hey! Tap below to continue:',
        quick_replies: btn ? [{ content_type: 'text', title: btn.title, payload: btn.payload }] : undefined
      }
    };
    const retryRes = await fetch(url1, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(fallbackBody)
    });
    const retryData = await retryRes.json().catch(() => ({}));
    if (retryRes.ok && (retryData.message_id || retryData.id || retryData.recipient_id)) {
      console.log(`[META SUCCESS] Private DM delivered via quick_replies fallback to comment ${commentId}`);
      return retryData;
    }
  }

  // Attempt 2: graph.instagram.com/me/messages fallback
  console.warn(`[META RETRY] Attempt 1 failed (HTTP ${response.status}): ${metaErrorMessage(data, 'Trying /me/messages fallback...')}`);
  const url2 = `https://graph.instagram.com/${apiVersion}/me/messages`;
  console.log(`[META PRIVATE REPLY OUTGOING 2] POST ${url2}`);
  const response2 = await fetch(url2, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(bodyData)
  });
  const data2 = await response2.json().catch(() => ({}));
  console.log(`[META PRIVATE REPLY RESPONSE 2] Status: ${response2.status} ${response2.statusText}, Body: ${JSON.stringify(data2)}`);

  if (response2.ok && (data2.message_id || data2.id || data2.recipient_id)) {
    console.log(`[META SUCCESS] Private DM sent successfully via /me/messages to comment ${commentId}`);
    return data2;
  }

  // Attempt 3: graph.facebook.com fallback (for Unified Meta Login tokens)
  console.warn(`[META RETRY] Attempt 2 failed (HTTP ${response2.status}): ${metaErrorMessage(data2, 'Trying Facebook Graph fallback...')}`);
  const url3 = `https://graph.facebook.com/${apiVersion}/${instagramUserId}/messages`;
  console.log(`[META PRIVATE REPLY OUTGOING 3] POST ${url3}`);
  const response3 = await fetch(url3, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(bodyData)
  });
  const data3 = await response3.json().catch(() => ({}));
  console.log(`[META PRIVATE REPLY RESPONSE 3] Status: ${response3.status} ${response3.statusText}, Body: ${JSON.stringify(data3)}`);

  if (response3.ok && (data3.message_id || data3.id || data3.recipient_id)) {
    console.log(`[META SUCCESS] Private DM sent successfully via graph.facebook.com to comment ${commentId}`);
    return data3;
  }

  const finalError = data.error || data2.error || data3.error;
  const error = new Error(`Instagram DM Error: ${metaErrorMessage({ error: finalError }, 'All DM endpoints failed.')}`);
  error.statusCode = response.status || response2.status || response3.status || 502;
  error.metaError = finalError;
  throw error;
}

// 2. Send Direct Message to Recipient IGSID (Active 24-hr messaging window)
async function sendDirectMessage(instagramUserId, recipientIgsid, messageContent, accessToken) {
  const messageObj = typeof messageContent === 'object' && messageContent !== null
    ? messageContent
    : { text: String(messageContent) };
  const bodyData = { recipient: { id: recipientIgsid }, message: messageObj };
  const sanitizedToken = redactToken(accessToken);

  // Attempt 1: graph.instagram.com with user ID
  const url1 = `https://graph.instagram.com/${apiVersion}/${instagramUserId}/messages`;
  console.log(`[META DIRECT DM OUTGOING] POST ${url1}`);
  console.log(`[META DIRECT DM HEADERS] Authorization: Bearer ${sanitizedToken}, Content-Type: application/json`);
  console.log(`[META DIRECT DM PAYLOAD] ${JSON.stringify(bodyData, null, 2)}`);

  let response = await fetch(url1, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(bodyData)
  });
  let data = await response.json().catch(() => ({}));
  console.log(`[META DIRECT DM RESPONSE 1] Status: ${response.status} ${response.statusText}, Body: ${JSON.stringify(data)}`);

  if (response.ok && (data.message_id || data.id || data.recipient_id)) {
    console.log(`[META SUCCESS] Direct DM sent successfully via graph.instagram.com to recipient ${recipientIgsid}`);
    return data;
  }

  // Attempt 2: /me/messages fallback
  console.warn(`[META RETRY] Direct DM Attempt 1 failed (HTTP ${response.status}): ${metaErrorMessage(data, 'Trying /me/messages fallback...')}`);
  const url2 = `https://graph.instagram.com/${apiVersion}/me/messages`;
  const response2 = await fetch(url2, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(bodyData)
  });
  const data2 = await response2.json().catch(() => ({}));
  console.log(`[META DIRECT DM RESPONSE 2] Status: ${response2.status} ${response2.statusText}, Body: ${JSON.stringify(data2)}`);

  if (response2.ok && (data2.message_id || data2.id || data2.recipient_id)) {
    console.log(`[META SUCCESS] Direct DM sent successfully via /me/messages to recipient ${recipientIgsid}`);
    return data2;
  }

  // Attempt 3: graph.facebook.com fallback
  const url3 = `https://graph.facebook.com/${apiVersion}/${instagramUserId}/messages`;
  const response3 = await fetch(url3, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(bodyData)
  });
  const data3 = await response3.json().catch(() => ({}));

  if (response3.ok && (data3.message_id || data3.id || data3.recipient_id)) {
    console.log(`[META SUCCESS] Direct DM sent successfully via graph.facebook.com to recipient ${recipientIgsid}`);
    return data3;
  }

  const finalError = data.error || data2.error || data3.error;
  const error = new Error(`Instagram Direct DM Error: ${metaErrorMessage({ error: finalError }, 'Failed to deliver direct message.')}`);
  error.statusCode = response.status || response2.status || response3.status || 502;
  error.metaError = finalError;
  throw error;
}

// 3. Send Public Reply in the Comment Thread ("Sent to your DM! Check inbox 📩")
async function replyToComment(commentId, messageText, accessToken) {
  if (!commentId || !messageText || !accessToken) return null;
  const url = `https://graph.instagram.com/${apiVersion}/${commentId}/replies`;
  const bodyData = { message: messageText };

  let response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(bodyData)
  });
  let data = await response.json().catch(() => ({}));

  if (!response.ok && (response.status === 404 || data.error?.code === 100 || data.error?.type === 'OAuthException')) {
    const fallbackUrl = `https://graph.facebook.com/${apiVersion}/${commentId}/replies`;
    const fallbackResponse = await fetch(fallbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(bodyData)
    });
    const fallbackData = await fallbackResponse.json().catch(() => ({}));
    if (fallbackResponse.ok && fallbackData.id) return fallbackData;
    if (!fallbackResponse.ok) { data = fallbackData; response = fallbackResponse; }
  }

  if (!response.ok || data.error) {
    console.warn(`Public comment reply note: ${metaErrorMessage(data, 'Failed to post public comment reply.')}`);
  }

  return data;
}

// 4. Follow-to-Unlock Meta Graph API Verification
async function checkFollowStatus(instagramUserId, userIgsid, accessToken) {
  if (!userIgsid || !accessToken) {
    return {
      supported: false,
      isFollowing: false,
      verified: false,
      note: 'Commenter identifier or access token missing.'
    };
  }

  try {
    // Attempt 1: graph.facebook.com query for is_user_follow_business & username
    const url1 = `https://graph.facebook.com/${apiVersion}/${userIgsid}?fields=name,username,is_user_follow_business&access_token=${accessToken}`;
    let response = await fetch(url1);
    let data = await response.json().catch(() => ({}));

    if (response.ok && data && typeof data.is_user_follow_business === 'boolean') {
      return {
        supported: true,
        isFollowing: data.is_user_follow_business,
        verified: true,
        username: data.username || null,
        name: data.name || null,
        note: data.is_user_follow_business ? 'Verified via official Meta Graph API' : 'Not currently following'
      };
    }

    // Attempt 2: graph.instagram.com query
    const url2 = `https://graph.instagram.com/${apiVersion}/${userIgsid}?fields=username,is_user_follow_business&access_token=${accessToken}`;
    const response2 = await fetch(url2);
    const data2 = await response2.json().catch(() => ({}));

    if (response2.ok && data2 && typeof data2.is_user_follow_business === 'boolean') {
      return {
        supported: true,
        isFollowing: data2.is_user_follow_business,
        verified: true,
        username: data2.username || null,
        note: data2.is_user_follow_business ? 'Verified via official Meta Graph API' : 'Not currently following'
      };
    }

    // Meta API restricts this query or user has not initiated messaging thread
    const metaErr = data.error || data2.error;
    return {
      supported: false,
      isFollowing: false,
      verified: false,
      error: metaErrorMessage({ error: metaErr }, 'Follow verification requires active conversation or Advanced Access.'),
      note: 'Meta Graph API follower status unavailable for this recipient.'
    };
  } catch (err) {
    return {
      supported: false,
      isFollowing: false,
      verified: false,
      error: err.message,
      note: 'Meta API follow verification unavailable.'
    };
  }
}

module.exports = {
  ensureConfiguration,
  exchangeCode,
  fetchProfile,
  saveAccount,
  subscribeToWebhooks,
  listAccounts,
  listReels,
  resolveReelUrl,
  disconnect,
  listAllAccounts,
  getAccount,
  decryptToken,
  getDecryptedTokenForAccount,
  getDecryptedTokenByInstagramUserId,
  sendPrivateReply,
  sendDirectMessage,
  replyToComment,
  checkFollowStatus
};
