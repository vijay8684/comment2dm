const crypto = require('crypto');
const db = require('../db');

const apiVersion = process.env.META_API_VERSION || 'v21.0';
const requiredConfig = ['META_APP_ID', 'META_APP_SECRET', 'META_REDIRECT_URI', 'META_TOKEN_ENCRYPTION_KEY'];

// 5-minute cache for media/reels to prevent lag and Meta rate limits
const reelsCache = new Map();
// 10-minute cache for detailed reel insights to prevent exhausting Meta rate limits
const reelInsightsCache = new Map();

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

// ── Engagement Calculations & Transparent Labeling ───────────────────────────
function calculateReelEngagement(metrics, followersCount = null) {
  const likes = metrics.likes?.value ?? (typeof metrics.likes === 'number' ? metrics.likes : null);
  const comments = metrics.comments?.value ?? (typeof metrics.comments === 'number' ? metrics.comments : null);
  const shares = metrics.shares?.value ?? (typeof metrics.shares === 'number' ? metrics.shares : null);
  const saved = metrics.saved?.value ?? (typeof metrics.saved === 'number' ? metrics.saved : null);
  const reach = metrics.reach?.value ?? (typeof metrics.reach === 'number' ? metrics.reach : null);
  const views = metrics.views?.value ?? metrics.plays?.value ?? (typeof metrics.views === 'number' ? metrics.views : (typeof metrics.plays === 'number' ? metrics.plays : null));
  const followers = followersCount ?? metrics.followers?.value ?? (typeof metrics.followers === 'number' ? metrics.followers : null);

  let totalInteractions = null;
  let totalInteractionsStatus = 'unavailable';
  let totalInteractionsSource = 'none';

  if (metrics.totalInteractions?.value !== undefined && metrics.totalInteractions?.value !== null) {
    totalInteractions = Number(metrics.totalInteractions.value);
    totalInteractionsStatus = metrics.totalInteractions.status || 'retrieved';
    totalInteractionsSource = metrics.totalInteractions.source || 'meta_api';
  } else if (likes !== null || comments !== null || shares !== null || saved !== null) {
    totalInteractions = (likes || 0) + (comments || 0) + (shares || 0) + (saved || 0);
    totalInteractionsStatus = metrics.likes?.status === 'manual' ? 'manual' : 'calculated';
    totalInteractionsSource = metrics.likes?.status === 'manual' ? 'manual_entry' : 'meta_api_sum';
  }

  // Formula 1: Engagement by Reach: (Total Interactions / Reach) * 100
  let byReach = {
    formula: '(Total Interactions / Reach) × 100',
    rate: null,
    available: false,
    reason: reach === null ? 'Reach metric is unavailable for this Reel from Meta API' : reach <= 0 ? 'Reach must be greater than zero' : totalInteractions === null ? 'Total interactions unavailable' : null,
    explanation: 'Measures the percentage of unique accounts reached that engaged (liked, commented, shared, or saved) with this Reel.'
  };
  if (reach !== null && reach > 0 && totalInteractions !== null) {
    byReach.rate = Number(((totalInteractions / reach) * 100).toFixed(2));
    byReach.available = true;
    byReach.reason = null;
  }

  // Formula 2: Engagement by Views (Plays): (Total Interactions / Views) * 100
  let byViews = {
    formula: '(Total Interactions / Views) × 100',
    rate: null,
    available: false,
    reason: views === null ? 'Views/plays metric is unavailable for this Reel from Meta API' : views <= 0 ? 'Views must be greater than zero' : totalInteractions === null ? 'Total interactions unavailable' : null,
    explanation: 'Measures the number of interactions generated per video play/view.'
  };
  if (views !== null && views > 0 && totalInteractions !== null) {
    byViews.rate = Number(((totalInteractions / views) * 100).toFixed(2));
    byViews.available = true;
    byViews.reason = null;
  }

  // Formula 3: Engagement by Followers: (Total Interactions / Followers) * 100
  let byFollowers = {
    formula: '(Total Interactions / Followers) × 100',
    rate: null,
    available: false,
    reason: followers === null ? 'Follower count is unavailable' : followers <= 0 ? 'Follower count must be greater than zero' : totalInteractions === null ? 'Total interactions unavailable' : null,
    explanation: 'Measures engagement relative to total account audience size.'
  };
  if (followers !== null && followers > 0 && totalInteractions !== null) {
    byFollowers.rate = Number(((totalInteractions / followers) * 100).toFixed(2));
    byFollowers.available = true;
    byFollowers.reason = null;
  }

  return {
    totalInteractions: {
      value: totalInteractions,
      status: totalInteractionsStatus,
      source: totalInteractionsSource,
      components: {
        likes: likes !== null ? { value: likes, status: metrics.likes?.status || 'retrieved' } : { value: null, status: 'unavailable' },
        comments: comments !== null ? { value: comments, status: metrics.comments?.status || 'retrieved' } : { value: null, status: 'unavailable' },
        shares: shares !== null ? { value: shares, status: metrics.shares?.status || 'retrieved' } : { value: null, status: 'unavailable' },
        saved: saved !== null ? { value: saved, status: metrics.saved?.status || 'retrieved' } : { value: null, status: 'unavailable' }
      }
    },
    byReach,
    byViews,
    byFollowers
  };
}

// ── Reel Insights from Meta Graph API v21.0 ──────────────────────────────────
async function getReelInsights(ownerUserId, instagramUserId, mediaId, forceRefresh = false) {
  const cacheKey = `${instagramUserId}:${mediaId}`;
  if (!forceRefresh) {
    const cached = reelInsightsCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      return cached.data;
    }
  }

  const accessToken = await getDecryptedTokenForAccount(ownerUserId, instagramUserId);
  const account = await getAccount(ownerUserId, instagramUserId);
  const followersCount = Number(account?.followers_count || account?.followersCount) || null;

  // 1. Fetch media basic metadata
  let media = null;
  try {
    const mediaUrl = new URL(`https://graph.instagram.com/${apiVersion}/${mediaId}`);
    mediaUrl.searchParams.set('fields', 'id,caption,media_type,media_product_type,permalink,timestamp,thumbnail_url,media_url,comments_count,like_count');
    mediaUrl.searchParams.set('access_token', accessToken);
    let res = await fetch(mediaUrl);
    let data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const fbUrl = new URL(`https://graph.facebook.com/${apiVersion}/${mediaId}`);
      fbUrl.searchParams.set('fields', 'id,caption,media_type,media_product_type,permalink,timestamp,thumbnail_url,media_url,comments_count,like_count');
      fbUrl.searchParams.set('access_token', accessToken);
      const fbRes = await fetch(fbUrl);
      const fbData = await fbRes.json().catch(() => ({}));
      if (fbRes.ok && fbData.id) {
        data = fbData;
        res = fbRes;
      }
    }
    if (data.id) {
      media = {
        id: String(data.id),
        caption: String(data.caption || ''),
        mediaType: data.media_product_type || data.media_type || 'REELS',
        permalink: data.permalink || '',
        timestamp: data.timestamp || null,
        thumbnailUrl: data.thumbnail_url || data.media_url || null,
        likeCount: data.like_count !== undefined ? Number(data.like_count) : null,
        commentsCount: data.comments_count !== undefined ? Number(data.comments_count) : null
      };
    }
  } catch (err) {
    console.warn(`[REEL_INSIGHTS] Failed to fetch media object ${mediaId}:`, err.message);
  }

  if (!media) {
    const error = new Error(`Reel or media object ${mediaId} could not be retrieved from Meta API.`);
    error.statusCode = 404;
    throw error;
  }

  // 2. Fetch insights from Meta Graph API
  const metaMetrics = {};
  let metaSupported = false;
  let metaError = null;

  try {
    // Attempt standard Reels insight metrics
    const insightsUrl = new URL(`https://graph.instagram.com/${apiVersion}/${mediaId}/insights`);
    insightsUrl.searchParams.set('metric', 'reach,saved,shares,plays,total_interactions');
    insightsUrl.searchParams.set('access_token', accessToken);
    let inRes = await fetch(insightsUrl);
    let inData = await inRes.json().catch(() => ({}));

    if (!inRes.ok) {
      // Fallback: try subset without plays (which can be rejected on some formats)
      const subUrl = new URL(`https://graph.instagram.com/${apiVersion}/${mediaId}/insights`);
      subUrl.searchParams.set('metric', 'reach,saved,shares');
      subUrl.searchParams.set('access_token', accessToken);
      const subRes = await fetch(subUrl);
      const subData = await subRes.json().catch(() => ({}));
      if (subRes.ok && Array.isArray(subData.data)) {
        inData = subData;
        inRes = subRes;
      } else {
        metaError = metaErrorMessage(inData, 'Reel insights not supported for this account type or media.');
      }
    }

    if (inRes.ok && Array.isArray(inData.data)) {
      metaSupported = true;
      for (const item of inData.data) {
        const val = item.values?.[0]?.value ?? item.value;
        if (val !== undefined && val !== null) {
          metaMetrics[item.name] = Number(val);
        }
      }
    }
  } catch (err) {
    metaError = err.message;
  }

  // 3. Package metrics with status and source
  const formattedMetrics = {
    likes: {
      value: media.likeCount,
      status: media.likeCount !== null ? 'retrieved' : 'unavailable',
      source: 'meta_api'
    },
    comments: {
      value: media.commentsCount,
      status: media.commentsCount !== null ? 'retrieved' : 'unavailable',
      source: 'meta_api'
    },
    reach: {
      value: metaMetrics.reach !== undefined ? metaMetrics.reach : null,
      status: metaMetrics.reach !== undefined ? 'retrieved' : 'unavailable',
      source: 'meta_api'
    },
    views: {
      value: metaMetrics.plays !== undefined ? metaMetrics.plays : (metaMetrics.views !== undefined ? metaMetrics.views : null),
      status: (metaMetrics.plays !== undefined || metaMetrics.views !== undefined) ? 'retrieved' : 'unavailable',
      source: 'meta_api'
    },
    saved: {
      value: metaMetrics.saved !== undefined ? metaMetrics.saved : null,
      status: metaMetrics.saved !== undefined ? 'retrieved' : 'unavailable',
      source: 'meta_api'
    },
    shares: {
      value: metaMetrics.shares !== undefined ? metaMetrics.shares : null,
      status: metaMetrics.shares !== undefined ? 'retrieved' : 'unavailable',
      source: 'meta_api'
    },
    totalInteractions: metaMetrics.total_interactions !== undefined ? {
      value: metaMetrics.total_interactions,
      status: 'retrieved',
      source: 'meta_api'
    } : null
  };

  const calculations = calculateReelEngagement(formattedMetrics, followersCount);

  const result = {
    media,
    metrics: formattedMetrics,
    calculations,
    followersCount,
    metaSupported,
    metaError,
    cachedAt: new Date().toISOString()
  };

  reelInsightsCache.set(cacheKey, { data: result, expires: Date.now() + 10 * 60 * 1000 });
  return result;
}

// ── Account-Wide Reel Performance Analysis ───────────────────────────────────
async function analyzeAccountReels(ownerUserId, instagramUserId, options = {}) {
  await getDecryptedTokenForAccount(ownerUserId, instagramUserId);
  const account = await getAccount(ownerUserId, instagramUserId);
  const followersCount = Number(account?.followers_count || account?.followersCount) || null;

  const rawReels = await listReels(ownerUserId, instagramUserId, options.forceRefresh);
  if (!rawReels || rawReels.length === 0) {
    return {
      account: {
        id: instagramUserId,
        username: account.username,
        followersCount
      },
      reels: [],
      summary: {
        totalAnalyzed: 0,
        averageEngagementRate: 0,
        formulaUsed: 'By Followers',
        topPerformer: null,
        lowestPerformer: null
      },
      observations: ['No published Reels found on this connected Instagram account. Publish a Reel to begin analysis.'],
      metaSupported: false
    };
  }

  const requestedFormula = options.formula || 'reach'; // 'reach' | 'views' | 'followers'

  // Analyze each reel with available metrics
  const analyzedReels = rawReels.map((reel) => {
    const metrics = {
      likes: { value: reel.likeCount ?? null, status: reel.likeCount !== undefined ? 'retrieved' : 'unavailable', source: 'meta_api' },
      comments: { value: reel.commentsCount ?? null, status: reel.commentsCount !== undefined ? 'retrieved' : 'unavailable', source: 'meta_api' },
      reach: { value: null, status: 'unavailable', source: 'meta_api' },
      views: { value: null, status: 'unavailable', source: 'meta_api' },
      saved: { value: null, status: 'unavailable', source: 'meta_api' },
      shares: { value: null, status: 'unavailable', source: 'meta_api' }
    };

    const calculations = calculateReelEngagement(metrics, followersCount);

    // Pick active rate based on formula
    let activeRate = null;
    let activeFormulaName = 'Followers';
    if (requestedFormula === 'reach' && calculations.byReach.available) {
      activeRate = calculations.byReach.rate;
      activeFormulaName = 'Reach';
    } else if (requestedFormula === 'views' && calculations.byViews.available) {
      activeRate = calculations.byViews.rate;
      activeFormulaName = 'Views';
    } else if (calculations.byFollowers.available) {
      activeRate = calculations.byFollowers.rate;
      activeFormulaName = 'Followers';
    }

    return {
      id: reel.id,
      caption: reel.caption,
      permalink: reel.permalink,
      timestamp: reel.timestamp,
      thumbnailUrl: reel.thumbnailUrl,
      mediaType: reel.mediaType,
      metrics,
      calculations,
      activeRate,
      activeFormulaName
    };
  });

  // Calculate account benchmark average for valid rates
  const validRates = analyzedReels.filter(r => typeof r.activeRate === 'number').map(r => r.activeRate);
  const avgRate = validRates.length > 0 ? Number((validRates.reduce((a, b) => a + b, 0) / validRates.length).toFixed(2)) : 0;

  // Rank reels descending
  analyzedReels.sort((a, b) => (b.activeRate || 0) - (a.activeRate || 0));

  analyzedReels.forEach((reel, index) => {
    reel.rank = index + 1;
    reel.totalRanked = analyzedReels.length;

    // Deterministic transparent performance score out of 100
    if (typeof reel.activeRate === 'number' && avgRate > 0) {
      const ratio = reel.activeRate / avgRate;
      reel.performanceScore = Math.min(100, Math.max(10, Math.round(50 * ratio)));
      const diffPercent = Number((((reel.activeRate - avgRate) / avgRate) * 100).toFixed(1));
      reel.diffFromAverage = diffPercent;
      reel.scoreExplanation = `${diffPercent >= 0 ? '+' : ''}${diffPercent}% vs your account average (${avgRate}% by ${reel.activeFormulaName})`;
      if (ratio >= 1.3) reel.performanceTier = 'Top Performer';
      else if (ratio <= 0.7) reel.performanceTier = 'Needs Iteration';
      else reel.performanceTier = 'Steady Performer';
    } else {
      reel.performanceScore = 50;
      reel.diffFromAverage = 0;
      reel.scoreExplanation = `Average baseline (Insufficient account comparison data)`;
      reel.performanceTier = 'Unranked';
    }
  });

  const topPerformer = analyzedReels[0] || null;
  const lowestPerformer = analyzedReels.length > 1 ? analyzedReels[analyzedReels.length - 1] : null;

  // Generate transparent data-driven observations
  const observations = [];
  if (topPerformer && typeof topPerformer.activeRate === 'number') {
    observations.push(`Your top-performing Reel (#1) achieved ${topPerformer.activeRate}% engagement, which is ${topPerformer.diffFromAverage >= 0 ? '+' : ''}${topPerformer.diffFromAverage}% relative to your account average (${avgRate}%).`);
  }
  const avgComments = Math.round(analyzedReels.reduce((sum, r) => sum + (r.metrics.comments.value || 0), 0) / analyzedReels.length);
  observations.push(`Your analyzed Reels average ${avgComments} comments per post. Reels with strong question hooks attract the highest comment volume.`);
  if (lowestPerformer && topPerformer && topPerformer.id !== lowestPerformer.id) {
    observations.push(`Performance variance: Top Reel generates ${topPerformer.metrics.comments.value || 0} comments vs ${lowestPerformer.metrics.comments.value || 0} on your lowest-ranked Reel.`);
  }

  return {
    account: {
      id: instagramUserId,
      username: account.username,
      followersCount
    },
    reels: analyzedReels,
    summary: {
      totalAnalyzed: analyzedReels.length,
      averageEngagementRate: avgRate,
      formulaUsed: `By ${analyzedReels[0]?.activeFormulaName || 'Followers'}`,
      topPerformer: topPerformer ? { id: topPerformer.id, caption: topPerformer.caption, rate: topPerformer.activeRate, rank: topPerformer.rank } : null,
      lowestPerformer: lowestPerformer ? { id: lowestPerformer.id, caption: lowestPerformer.caption, rate: lowestPerformer.activeRate, rank: lowestPerformer.rank } : null
    },
    observations,
    metaSupported: true
  };
}

// ── Manual Metric Analysis Fallback ──────────────────────────────────────────
function analyzeManualReel(input = {}) {
  const likes = typeof input.likes === 'number' ? input.likes : (input.likes ? Number(input.likes) : null);
  const comments = typeof input.comments === 'number' ? input.comments : (input.comments ? Number(input.comments) : null);
  const reach = typeof input.reach === 'number' ? input.reach : (input.reach ? Number(input.reach) : null);
  const views = typeof input.views === 'number' ? input.views : (input.views ? Number(input.views) : null);
  const shares = typeof input.shares === 'number' ? input.shares : (input.shares ? Number(input.shares) : null);
  const saved = typeof input.saved === 'number' ? input.saved : (input.saved ? Number(input.saved) : null);
  const followers = typeof input.followers === 'number' ? input.followers : (input.followers ? Number(input.followers) : null);

  const formattedMetrics = {
    likes: { value: likes, status: likes !== null ? 'manual' : 'unavailable', source: 'manual_entry' },
    comments: { value: comments, status: comments !== null ? 'manual' : 'unavailable', source: 'manual_entry' },
    reach: { value: reach, status: reach !== null ? 'manual' : 'unavailable', source: 'manual_entry' },
    views: { value: views, status: views !== null ? 'manual' : 'unavailable', source: 'manual_entry' },
    shares: { value: shares, status: shares !== null ? 'manual' : 'unavailable', source: 'manual_entry' },
    saved: { value: saved, status: saved !== null ? 'manual' : 'unavailable', source: 'manual_entry' }
  };

  const calculations = calculateReelEngagement(formattedMetrics, followers);

  // Compare to standard industry baseline (3.0%)
  const benchmark = 3.0;
  const chosenRate = calculations.byReach.available ? calculations.byReach.rate :
                     calculations.byViews.available ? calculations.byViews.rate :
                     calculations.byFollowers.available ? calculations.byFollowers.rate : null;

  let score = 50;
  let comparison = 'Industry comparison requires at least one valid engagement calculation';
  let tier = 'Average';

  if (chosenRate !== null) {
    score = Math.min(100, Math.max(10, Math.round(50 * (chosenRate / benchmark))));
    const diff = Number((((chosenRate - benchmark) / benchmark) * 100).toFixed(1));
    comparison = diff >= 0 ? `${diff}% above industry baseline (3.0%)` : `${Math.abs(diff)}% below industry baseline (3.0%)`;
    tier = score >= 70 ? 'Top Performer' : score <= 35 ? 'Needs Iteration' : 'Steady Performer';
  }

  return {
    source: 'manual_entry',
    caption: String(input.caption || 'Manual Reel Analysis'),
    metrics: formattedMetrics,
    followersCount: followers,
    calculations,
    performanceScore: score,
    performanceTier: tier,
    scoreExplanation: comparison,
    benchmark
  };
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
  checkFollowStatus,
  calculateReelEngagement,
  getReelInsights,
  analyzeAccountReels,
  analyzeManualReel
};
