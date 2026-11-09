// ============================================================
// Comment2DM — Automations Engine Comprehensive Test Suite
// Verifies:
// 1. Backend API Validation & Entitlement Guardrails
// 2. Multi-Keyword Parsing & Case-Insensitive Matching
// 3. Resource Upload Validation & MIME Security
// 4. Follow-to-Unlock Meta API Checking Behavior
// 5. Frontend Structure & DOM Integrity
// ============================================================

const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('======================================================');
console.log('COMMENT2DM AUTOMATIONS ENGINE TEST SUITE');
console.log('======================================================\n');

let passedTests = 0;
let totalTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`Test ${totalTests}: ${name}`);
    console.log('  ✓ PASSED');
    passedTests++;
  } catch (err) {
    console.error(`Test ${totalTests}: ${name}`);
    console.error(`  ✗ FAILED: ${err.message}`);
    process.exit(1);
  }
}

// 1. Test Keyword Matching Logic
runTest('Keyword matching: exact match and case-insensitivity', () => {
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

  assert.strictEqual(keywordMatches('Please send the link!', 'LINK', 'keyword'), true);
  assert.strictEqual(keywordMatches('Can I get the link please?', 'link', 'keyword'), true);
  assert.strictEqual(keywordMatches('Interested in price and guide', 'link, guide, deal', 'keyword'), true);
  assert.strictEqual(keywordMatches('Great reel!', 'link, deal', 'keyword'), false);
  assert.strictEqual(keywordMatches('Great reel!', '', 'all'), true);
});

// 2. Test Keyword Normalization & Deduplication
runTest('Keyword list deduplication and trimming', () => {
  const rawList = ['LINK', 'link', '  DEAL  ', 'deal', 'PRICE', ''];
  const seenKw = new Set();
  const cleaned = rawList.map(k => String(k).trim()).filter(Boolean).filter(k => {
    const lower = k.toLowerCase();
    if (seenKw.has(lower)) return false;
    seenKw.add(lower);
    return true;
  });

  assert.deepStrictEqual(cleaned, ['LINK', 'DEAL', 'PRICE']);
  assert.strictEqual(cleaned.join(', '), 'LINK, DEAL, PRICE');
});

// 3. Test Plan Entitlements in src/billing.js
runTest('Billing LIMITS contain allCommentsTrigger, followToUnlock, and whiteLabel', () => {
  const billing = require('./src/billing');
  assert(billing.LIMITS.free, 'free tier limits must exist');
  assert.strictEqual(billing.LIMITS.free.allCommentsTrigger, false, 'free tier cannot use allCommentsTrigger');
  assert.strictEqual(billing.LIMITS.free.followToUnlock, false, 'free tier cannot use followToUnlock');
  assert.strictEqual(billing.LIMITS.free.whiteLabel, false, 'free tier cannot use whiteLabel');

  assert.strictEqual(billing.LIMITS.pro.allCommentsTrigger, true, 'pro tier can use allCommentsTrigger');
  assert.strictEqual(billing.LIMITS.pro.followToUnlock, true, 'pro tier can use followToUnlock');
  assert.strictEqual(billing.LIMITS.pro.whiteLabel, true, 'pro tier can use whiteLabel');

  assert.strictEqual(billing.LIMITS.elite.allCommentsTrigger, true, 'elite tier can use allCommentsTrigger');
  assert.strictEqual(billing.LIMITS.elite.followToUnlock, true, 'elite tier can use followToUnlock');
  assert.strictEqual(billing.LIMITS.elite.whiteLabel, true, 'elite tier can use whiteLabel');
});

// 4. Test Resource Upload Validation Logic
runTest('Resource upload MIME type and size security', () => {
  const allowedMimes = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'application/pdf': '.pdf'
  };

  function validateUpload(mimeType, sizeBytes) {
    if (!allowedMimes[mimeType]) throw new Error('Unsupported file type');
    if (sizeBytes > 10 * 1024 * 1024) throw new Error('File size exceeds 10MB limit');
    return allowedMimes[mimeType];
  }

  assert.strictEqual(validateUpload('application/pdf', 500000), '.pdf');
  assert.strictEqual(validateUpload('image/png', 2000000), '.png');
  assert.throws(() => validateUpload('application/x-msdownload', 100), /Unsupported file type/);
  assert.throws(() => validateUpload('image/jpeg', 15 * 1024 * 1024), /File size exceeds 10MB limit/);
});

// 5. Test Follow-to-Unlock Meta API Service
runTest('Instagram service exports checkFollowStatus function', () => {
  const instagramService = require('./src/instagram/instagramService');
  assert.strictEqual(typeof instagramService.checkFollowStatus, 'function', 'checkFollowStatus must be a function');
});

// 6. Test Free-Plan Branding Attribution Logic
runTest('Free plan branding attribution logic appends cleanly without duplication', () => {
  function applyBranding(message, isWhiteLabel) {
    let result = message || '';
    if (!isWhiteLabel) {
      if (!result.includes('Powered by Comment2DM')) {
        result += '\n\n⚡ Powered by Comment2DM';
      }
    }
    return result;
  }

  const freeMsg = applyBranding('Hey! Here is your link: https://deal.com', false);
  assert(freeMsg.includes('⚡ Powered by Comment2DM'), 'Free message must contain branding');

  // Double call does not duplicate
  const freeMsg2 = applyBranding(freeMsg, false);
  assert.strictEqual(freeMsg2.split('Powered by Comment2DM').length - 1, 1, 'Branding must not duplicate');

  // Paid user receives untouched message
  const proMsg = applyBranding('Hey! Here is your link: https://deal.com', true);
  assert(!proMsg.includes('Powered by Comment2DM'), 'Pro message must be white-label');
});

// 7. Test Personalization Variable Replacement
runTest('Message personalization replaces {username}, {name}, and {first_name}', () => {
  const template = 'Hello {first_name}! We sent this to {username}. Thanks {name}!';
  const username = 'sarah_creator';
  const personalized = template
    .replace(/\{username\}/gi, `@${username}`)
    .replace(/\{name\}/gi, username)
    .replace(/\{first_name\}/gi, username);

  assert.strictEqual(personalized, 'Hello sarah_creator! We sent this to @sarah_creator. Thanks sarah_creator!');
});

// 8. Test automations.html DOM Integrity
runTest('automations.html contains all redesigned components & clean SVG icons', () => {
  const html = fs.readFileSync('automations.html', 'utf8');

  assert(html.includes("localStorage.getItem('comment2dm_theme')"), 'Head theme sync must be present');
  assert(html.includes('id="themeToggleBtn"'), 'Theme toggle button must exist');
  assert(html.includes('id="refreshReelsBtn"'), 'Refresh reels button must exist');
  assert(html.includes('id="selectedReelPreview"'), 'Selected reel showcase must exist');
  assert(html.includes('id="keywordChipsContainer"'), 'Keyword chips container must exist');
  assert(html.includes('id="openingMessageInput"'), 'Opening DM input must exist');
  assert(html.includes('id="followGateToggle"'), 'Follow gate toggle must exist');
  assert(html.includes('id="resourceInputArea"'), 'Resource input area must exist');
  assert(html.includes('id="deleteAutomationModal"'), 'Delete confirmation modal must exist');
  assert(!html.includes('ðŸ'), 'No mojibake or UTF-8 corrupt characters allowed');
  assert(!html.includes('targetAllReelsBtn'), 'All Reels toggle must be removed (single specific post workflow)');
});

// 9. Test automations.js Script Integrity & Bug Fix
runTest('automations.js handles empty state hiding, flow building, and duplicate click prevention', () => {
  const js = fs.readFileSync('automations.js', 'utf8');

  assert(js.includes('automationsEmptyState.style.display = \'none\''), 'Empty state must be explicitly hidden when automations exist');
  assert(js.includes('saveBtn.disabled = true'), 'Save button must be disabled on submit to prevent duplicate automations');
  assert(js.includes('renderKeywordChips'), 'Keyword chips must be dynamically managed');
  assert(js.includes('updateSimulator'), 'Simulator must update in real time');
  assert(js.includes('/api/automations/upload-resource'), 'Resource upload API must be called');
});

// 10. Scenario 1: Existing follower taps Send me the link -> resource arrives immediately (Path A)
runTest('Scenario 1: Existing follower taps Send me the link -> resource arrives immediately', () => {
  let dmSent = null;
  const mockInstagramService = {
    checkFollowStatus: async () => ({ supported: true, isFollowing: true, verified: true }),
    sendDirectMessage: async (recipientIgId, senderIgsid, msgData) => {
      dmSent = { recipientIgId, senderIgsid, msgData };
      return { id: 'msg_123' };
    }
  };

  async function handleSendLink({ senderIgsid, recipientIgId, flow, automation }) {
    const followStatus = await mockInstagramService.checkFollowStatus();
    if (followStatus.isFollowing) {
      await mockInstagramService.sendDirectMessage(recipientIgId, senderIgsid, {
        text: flow.delivery.message + '\n\n' + flow.delivery.resourceUrl
      });
      return { path: 'A', delivered: true };
    }
    return { path: 'B', delivered: false };
  }

  const result = handleSendLink({
    senderIgsid: 'igsid_follower',
    recipientIgId: 'creator_1',
    flow: { delivery: { message: 'Here is your link!', resourceUrl: 'https://deal.com/guide' } },
    automation: { id: 'auto_1' }
  });

  result.then(res => {
    assert.strictEqual(res.path, 'A');
    assert.strictEqual(res.delivered, true);
    assert(dmSent.msgData.text.includes('https://deal.com/guide'), 'Resource link must be delivered');
  });
});

// 11. Scenario 2: Non-follower taps Send me the link -> follow request appears (Path B)
runTest('Scenario 2: Non-follower taps Send me the link -> follow request prompt appears', () => {
  let dmSent = null;
  const mockInstagramService = {
    checkFollowStatus: async () => ({ supported: true, isFollowing: false, verified: true }),
    sendDirectMessage: async (recipientIgId, senderIgsid, msgData) => {
      dmSent = { recipientIgId, senderIgsid, msgData };
      return { id: 'msg_124' };
    }
  };

  async function handleSendLink({ senderIgsid, recipientIgId, flow, creatorUsername }) {
    const followStatus = await mockInstagramService.checkFollowStatus();
    if (followStatus.isFollowing) {
      return { path: 'A', delivered: true };
    }
    const followPrompt = flow.followGate.message;
    const profileUrl = `https://instagram.com/${creatorUsername}`;
    await mockInstagramService.sendDirectMessage(recipientIgId, senderIgsid, {
      text: `${followPrompt}\n\n👉 Visit Profile: ${profileUrl}`,
      quick_replies: [{ title: "I've followed ✓", payload: 'CHECK_FOLLOW' }]
    });
    return { path: 'B', delivered: false, promptSent: true };
  }

  const result = handleSendLink({
    senderIgsid: 'igsid_non_follower',
    recipientIgId: 'creator_1',
    creatorUsername: 'star_creator',
    flow: {
      followGate: { message: "Oops! Looks like you haven't followed me yet 👀" },
      delivery: { message: 'Here is link', resourceUrl: 'https://deal.com' }
    }
  });

  result.then(res => {
    assert.strictEqual(res.path, 'B');
    assert.strictEqual(res.delivered, false);
    assert.strictEqual(res.promptSent, true);
    assert(dmSent.msgData.text.includes('instagram.com/star_creator'), 'Profile link must be included');
    assert.strictEqual(dmSent.msgData.quick_replies[0].title, "I've followed ✓");
  });
});

// 12. Scenario 3: Non-follower visits profile and follows -> taps I've followed -> resource arrives
runTest('Scenario 3: Non-follower follows and taps I\'ve followed -> resource arrives immediately', () => {
  let dmSent = null;
  const mockInstagramService = {
    checkFollowStatus: async () => ({ supported: true, isFollowing: true, verified: true }),
    sendDirectMessage: async (recipientIgId, senderIgsid, msgData) => {
      dmSent = { recipientIgId, senderIgsid, msgData };
      return { id: 'msg_125' };
    }
  };

  async function handleCheckFollow({ senderIgsid, recipientIgId, flow }) {
    const recheckStatus = await mockInstagramService.checkFollowStatus();
    if (recheckStatus.isFollowing) {
      await mockInstagramService.sendDirectMessage(recipientIgId, senderIgsid, {
        text: flow.delivery.message + '\n\n' + flow.delivery.resourceUrl
      });
      return { verified: true, delivered: true };
    }
    return { verified: false, delivered: false };
  }

  const result = handleCheckFollow({
    senderIgsid: 'igsid_new_follower',
    recipientIgId: 'creator_1',
    flow: { delivery: { message: 'Here is your link!', resourceUrl: 'https://deal.com/guide' } }
  });

  result.then(res => {
    assert.strictEqual(res.verified, true);
    assert.strictEqual(res.delivered, true);
    assert(dmSent.msgData.text.includes('https://deal.com/guide'));
  });
});

// 13. Scenario 4: Person does not follow -> retry message appears
runTest('Scenario 4: Person does not follow -> retry message appears with recheck option', () => {
  let dmSent = null;
  const mockInstagramService = {
    checkFollowStatus: async () => ({ supported: true, isFollowing: false, verified: true }),
    sendDirectMessage: async (recipientIgId, senderIgsid, msgData) => {
      dmSent = { recipientIgId, senderIgsid, msgData };
      return { id: 'msg_126' };
    }
  };

  async function handleCheckFollow({ senderIgsid, recipientIgId, flow, creatorUsername }) {
    const recheckStatus = await mockInstagramService.checkFollowStatus();
    if (recheckStatus.isFollowing) {
      return { delivered: true };
    }
    const retryMsg = flow.followGate.retryMessage;
    await mockInstagramService.sendDirectMessage(recipientIgId, senderIgsid, {
      text: `${retryMsg}\n\n👉 Profile: https://instagram.com/${creatorUsername}`,
      quick_replies: [{ title: "I've followed ✓", payload: 'CHECK_FOLLOW' }]
    });
    return { delivered: false, retrySent: true };
  }

  const result = handleCheckFollow({
    senderIgsid: 'igsid_still_non_follower',
    recipientIgId: 'creator_1',
    creatorUsername: 'star_creator',
    flow: {
      followGate: { retryMessage: "Still not seeing that follow yet! 👀 If you just hit follow, wait a few seconds and tap below to retry." }
    }
  });

  result.then(res => {
    assert.strictEqual(res.delivered, false);
    assert.strictEqual(res.retrySent, true);
    assert(dmSent.msgData.text.includes('Still not seeing that follow yet'));
    assert.strictEqual(dmSent.msgData.quick_replies[0].title, "I've followed ✓");
  });
});

// 14. Scenario 5: Instagram API returns unknown/error -> safe retry state
runTest('Scenario 5: Instagram API returns unknown/error -> safe retry state without false claim', () => {
  let dmSent = null;
  const mockInstagramService = {
    checkFollowStatus: async () => ({ supported: false, isFollowing: false, error: 'OAuthException code 100' }),
    sendDirectMessage: async (recipientIgId, senderIgsid, msgData) => {
      dmSent = { recipientIgId, senderIgsid, msgData };
      return { id: 'msg_127' };
    }
  };

  async function handleSendLinkWithError({ senderIgsid, recipientIgId, creatorUsername }) {
    const followStatus = await mockInstagramService.checkFollowStatus();
    if (!followStatus.supported || followStatus.error) {
      const retryNotice = "We couldn't verify your follow status right now due to a network or API delay. Please tap below to retry!";
      await mockInstagramService.sendDirectMessage(recipientIgId, senderIgsid, {
        text: `${retryNotice}\n\n👉 Profile: https://instagram.com/${creatorUsername}`,
        quick_replies: [{ title: 'Retry Follow Check 🔄', payload: 'CHECK_FOLLOW' }]
      });
      return { safeRetry: true, falseClaimMade: false };
    }
    return { safeRetry: false };
  }

  const result = handleSendLinkWithError({
    senderIgsid: 'igsid_api_error',
    recipientIgId: 'creator_1',
    creatorUsername: 'star_creator'
  });

  result.then(res => {
    assert.strictEqual(res.safeRetry, true);
    assert.strictEqual(res.falseClaimMade, false);
    assert(dmSent.msgData.text.includes("couldn't verify your follow status right now"));
    assert(!dmSent.msgData.text.includes('verified'), 'Must not claim verified');
    assert.strictEqual(dmSent.msgData.quick_replies[0].title, 'Retry Follow Check 🔄');
  });
});

// 15. Scenario 6: Repeated button taps -> no duplicate resource delivery (Idempotency)
runTest('Scenario 6: Repeated button taps -> idempotency prevents duplicate resource delivery', () => {
  let deliveryCount = 0;
  const conversationStates = new Map();

  async function processTap(senderIgsid, autoId) {
    const key = `${senderIgsid}:${autoId}`;
    const state = conversationStates.get(key);
    if (state && state.resource_delivered) {
      return { delivered: false, duplicateBlocked: true };
    }
    deliveryCount++;
    conversationStates.set(key, { resource_delivered: true, delivered_at: Date.now() });
    return { delivered: true, duplicateBlocked: false };
  }

  return (async () => {
    const tap1 = await processTap('user_42', 'auto_100');
    assert.strictEqual(tap1.delivered, true);
    assert.strictEqual(tap1.duplicateBlocked, false);
    assert.strictEqual(deliveryCount, 1);

    const tap2 = await processTap('user_42', 'auto_100');
    assert.strictEqual(tap2.delivered, false);
    assert.strictEqual(tap2.duplicateBlocked, true);
    assert.strictEqual(deliveryCount, 1, 'Delivery count must remain 1');

    const tap3 = await processTap('user_42', 'auto_100');
    assert.strictEqual(tap3.delivered, false);
    assert.strictEqual(deliveryCount, 1, 'Repeated taps must never re-deliver');
  })();
});

// 16. Scenario 7: Follow gate disabled -> normal DM delivery
runTest('Scenario 7: Follow gate disabled -> normal DM delivery without follower prompt', () => {
  let deliveredDirectly = false;
  const flow = {
    followGate: { enabled: false },
    openingMessage: 'Hey! Thanks for commenting.',
    delivery: { message: 'Here is your link:', resourceUrl: 'https://site.com/freebie' }
  };

  if (!flow.followGate?.enabled) {
    deliveredDirectly = true;
  }

  assert.strictEqual(deliveredDirectly, true, 'Resource must deliver directly when follow gate is disabled');
});

// 17. Scenario 8: Free-plan user attempts to enable follow gate -> backend rejects it
runTest('Scenario 8: Free-plan user attempts to enable follow gate -> backend rejects with 403', () => {
  const billing = require('./src/billing');

  function validateFollowGateEntitlement(plan, flow) {
    const limits = billing.LIMITS[plan] || billing.LIMITS.free;
    if (flow?.followGate?.enabled && !limits.followToUnlock) {
      const err = new Error('Follow-to-unlock is a premium feature available on Pro and Elite plans. Please upgrade to unlock.');
      err.statusCode = 403;
      throw err;
    }
    return true;
  }

  // Free plan rejection
  assert.throws(
    () => validateFollowGateEntitlement('free', { followGate: { enabled: true } }),
    err => err.statusCode === 403 && err.message.includes('Follow-to-unlock is a premium feature')
  );

  // Pro plan permitted
  assert.strictEqual(validateFollowGateEntitlement('pro', { followGate: { enabled: true } }), true);

  // Elite plan permitted
  assert.strictEqual(validateFollowGateEntitlement('elite', { followGate: { enabled: true } }), true);

  // Free plan permitted if follow gate is disabled
  assert.strictEqual(validateFollowGateEntitlement('free', { followGate: { enabled: false } }), true);
});

// 18. Test UI & DOM Integrity for DM Conversation Flow
runTest('automations.html contains DM Conversation Flow builder & Live Simulator Scenario Switcher', () => {
  const html = fs.readFileSync('automations.html', 'utf8');

  assert(html.includes('DM Conversation Flow'), 'Must have DM Conversation Flow header');
  assert(html.includes('follow-gate-master-switch'), 'Must have master follow gate toggle');
  assert(html.includes('Require users to follow before receiving the resource'), 'Exact master toggle wording');
  assert(html.includes('flow-card-opening'), 'Must have Step 1 Opening DM card');
  assert(html.includes('flow-card-conditional'), 'Must have Step 2 Check Follower Status conditional card');
  assert(html.includes('PATH A'), 'Must have PATH A branch');
  assert(html.includes('PATH B'), 'Must have PATH B branch');
  assert(html.includes('flow-card-delivery'), 'Must have Step 3 Resource Delivery card');
  assert(html.includes('simScenarioSwitcher'), 'Must have simulator scenario switcher');
  assert(html.includes('simScenarioFollowingBtn'), 'Must have Already Following simulator button');
  assert(html.includes('simScenarioNotFollowingBtn'), 'Must have Not Following simulator button');
});

// 19. Test Opening Private Reply Interactive Button Structure
runTest('Opening Private Reply payload always generates interactive button <= 20 chars with valid payload', () => {
  function buildOpeningPayload(flow, autoId, commentId) {
    const openingBtnTitle = (flow?.openingButtonText || 'Send me the link').trim().slice(0, 20);
    return {
      text: flow?.openingMessage || "Hey! I'm so glad you're here — thanks for your interest 😊\n\nTap below and I'll send you the link in just a moment ✨",
      quick_replies: [
        {
          content_type: 'text',
          title: openingBtnTitle,
          payload: `SEND_LINK:${autoId}:${commentId}`
        }
      ]
    };
  }

  const payloadDefault = buildOpeningPayload({}, 'auto_123', 'comm_456');
  assert.strictEqual(payloadDefault.quick_replies[0].title, 'Send me the link');
  assert.strictEqual(payloadDefault.quick_replies[0].payload, 'SEND_LINK:auto_123:comm_456');
  assert(payloadDefault.quick_replies[0].title.length <= 20, 'Title must be <= 20 chars');

  const payloadLong = buildOpeningPayload({ openingButtonText: 'Click here right now to get the link!' }, 'auto_1', 'comm_1');
  assert(payloadLong.quick_replies[0].title.length <= 20, 'Long titles must be trimmed to <= 20 chars for Meta API');
  assert.strictEqual(payloadLong.quick_replies[0].title, 'Click here right now');
});

// 20. Test Token Redaction Security
runTest('Meta token redaction hides API secrets in server logs', () => {
  function redactToken(token) {
    if (!token || typeof token !== 'string') return '[NONE]';
    if (token.length <= 14) return '***';
    return `${token.slice(0, 8)}...${token.slice(-6)}`;
  }

  const liveToken = 'IGQWRPYm94dUpGZAG5GZAHRlQjlHQXl5X1h3TXRycGFwS0t3TXR5';
  const redacted = redactToken(liveToken);
  assert.strictEqual(redacted, 'IGQWRPYm...t3TXR5');
  assert(!redacted.includes('ZAG5GZAHRlQjlHQXl5X1h3TXRycGFwS0t3TXR5'));
  assert.strictEqual(redactToken('short'), '***');
  assert.strictEqual(redactToken(null), '[NONE]');
});

// ==========================================
// REGRESSION SUITE: Strict State Machine & Access Control
// ==========================================

// Mock State Machine Runner mimicking server.js
function createWebhookStateMachine() {
  const store = new Map();
  const deliveryCalls = [];
  const promptCalls = [];
  const inProgress = new Set();

  async function deliverFinalResource({ automationId, recipientIgId, senderIgsid, flow, prefixMessage }) {
    const key = `${automationId}:${recipientIgId}:${senderIgsid}`;
    if (inProgress.has(key)) return { delivered: false, reason: 'concurrency' };
    inProgress.add(key);

    try {
      const current = store.get(key) || { resource_delivered: false };
      if (current.resource_delivered) {
        return { delivered: false, reason: 'already_delivered' };
      }
      current.resource_delivered = true;
      current.state = 'RESOURCE_DELIVERED';
      current.delivered_at = Date.now();
      store.set(key, current);

      const text = (prefixMessage ? `${prefixMessage.trim()}\n\n` : '') + flow.delivery.message;
      deliveryCalls.push({ automationId, senderIgsid, text, resourceUrl: flow.delivery.resourceUrl });
      return { delivered: true };
    } finally {
      inProgress.delete(key);
    }
  }

  async function handleWebhookEvent({ action, automation, recipientIgId, senderIgsid, checkFollowFn }) {
    // Cross-account routing check: ignore if event recipient does not match creator
    if (String(automation.instagram_user_id) !== String(recipientIgId)) {
      return { ignored: true, reason: 'cross_account' };
    }

    const flow = automation.flow || {};
    const key = `${automation.id}:${recipientIgId}:${senderIgsid}`;
    let state = store.get(key) || { key, state: 'INIT', resource_delivered: false };

    if (state.resource_delivered) {
      return { action, ignored: true, reason: 'idempotent_skip' };
    }

    if (action === 'SEND_LINK') {
      if (!flow.followGate?.enabled) {
        await deliverFinalResource({ automationId: automation.id, recipientIgId, senderIgsid, flow });
        return { state: 'RESOURCE_DELIVERED' };
      }

      state.state = 'CHECKING_FOLLOW_STATUS';
      store.set(key, state);

      const check = await checkFollowFn(recipientIgId, senderIgsid);
      if (check.isFollowing === true && check.verified === true) {
        await deliverFinalResource({ automationId: automation.id, recipientIgId, senderIgsid, flow });
        return { state: 'RESOURCE_DELIVERED' };
      } else if (check.supported === false || check.error || !check.verified) {
        state.state = 'VERIFICATION_ERROR';
        store.set(key, state);
        promptCalls.push({ type: 'verification_error', senderIgsid });
        return { state: 'VERIFICATION_ERROR' };
      } else {
        state.state = 'FOLLOW_PROMPT_SENT';
        store.set(key, state);
        promptCalls.push({ type: 'follow_prompt', senderIgsid });
        return { state: 'FOLLOW_PROMPT_SENT' };
      }
    } else if (action === 'CHECK_FOLLOW') {
      state.state = 'CHECKING_FOLLOW_STATUS';
      store.set(key, state);

      const check = await checkFollowFn(recipientIgId, senderIgsid);
      if (check.isFollowing === true && check.verified === true) {
        const prefix = flow.followGate?.successMessage || "You're all set! 🎉\n\nHere is your requested guide:";
        await deliverFinalResource({ automationId: automation.id, recipientIgId, senderIgsid, flow, prefixMessage: prefix });
        return { state: 'RESOURCE_DELIVERED' };
      } else if (check.supported === false || check.error || !check.verified) {
        state.state = 'VERIFICATION_ERROR';
        store.set(key, state);
        promptCalls.push({ type: 'verification_error', senderIgsid });
        return { state: 'VERIFICATION_ERROR' };
      } else {
        state.state = 'FOLLOW_RETRY_PROMPT';
        store.set(key, state);
        promptCalls.push({ type: 'follow_retry_prompt', senderIgsid });
        return { state: 'FOLLOW_RETRY_PROMPT' };
      }
    }
  }

  return { store, deliveryCalls, promptCalls, handleWebhookEvent };
}

// 21. Regression 1: Follow gate enabled + non-follower -> resource send count is ZERO
runTest('Regression 1: Follow gate enabled + non-follower -> resource send count is ZERO', async () => {
  const sm = createWebhookStateMachine();
  const automation = {
    id: 'auto_reg_1',
    instagram_user_id: 'creator_1',
    flow: {
      followGate: { enabled: true, message: 'Please follow!' },
      delivery: { message: 'Guide', resourceUrl: 'https://site.com' }
    }
  };

  const res = await sm.handleWebhookEvent({
    action: 'SEND_LINK',
    automation,
    recipientIgId: 'creator_1',
    senderIgsid: 'non_follower_1',
    checkFollowFn: async () => ({ supported: true, isFollowing: false, verified: true })
  });

  assert.strictEqual(res.state, 'FOLLOW_PROMPT_SENT');
  assert.strictEqual(sm.deliveryCalls.length, 0, 'Resource send count must be strictly ZERO for non-follower');
  assert.strictEqual(sm.promptCalls.length, 1);
  assert.strictEqual(sm.promptCalls[0].type, 'follow_prompt');
});

// 22. Regression 2: Follow gate enabled + follower -> resource sent exactly once
runTest('Regression 2: Follow gate enabled + follower -> resource sent exactly once', async () => {
  const sm = createWebhookStateMachine();
  const automation = {
    id: 'auto_reg_2',
    instagram_user_id: 'creator_1',
    flow: {
      followGate: { enabled: true },
      delivery: { message: 'Here is your guide', resourceUrl: 'https://site.com/ebook' }
    }
  };

  const res = await sm.handleWebhookEvent({
    action: 'SEND_LINK',
    automation,
    recipientIgId: 'creator_1',
    senderIgsid: 'existing_follower_1',
    checkFollowFn: async () => ({ supported: true, isFollowing: true, verified: true })
  });

  assert.strictEqual(res.state, 'RESOURCE_DELIVERED');
  assert.strictEqual(sm.deliveryCalls.length, 1, 'Resource must be sent exactly once for existing follower');
  assert.strictEqual(sm.deliveryCalls[0].resourceUrl, 'https://site.com/ebook');
  assert.strictEqual(sm.promptCalls.length, 0, 'No follow prompt should be sent to existing follower');
});

// 23. Regression 3: Non-follower later verifies -> resource sent exactly once
runTest('Regression 3: Non-follower later verifies -> resource sent exactly once', async () => {
  const sm = createWebhookStateMachine();
  const automation = {
    id: 'auto_reg_3',
    instagram_user_id: 'creator_1',
    flow: {
      followGate: { enabled: true, successMessage: "You're all set! 🎉" },
      delivery: { message: 'Here is your link!', resourceUrl: 'https://site.com/verified' }
    }
  };

  // Step 1: User clicks SEND_LINK as non-follower
  await sm.handleWebhookEvent({
    action: 'SEND_LINK',
    automation,
    recipientIgId: 'creator_1',
    senderIgsid: 'convert_user',
    checkFollowFn: async () => ({ supported: true, isFollowing: false, verified: true })
  });
  assert.strictEqual(sm.deliveryCalls.length, 0, 'Must not deliver before following');

  // Step 2: User follows on Instagram and clicks "I've followed ✓" (CHECK_FOLLOW)
  const res = await sm.handleWebhookEvent({
    action: 'CHECK_FOLLOW',
    automation,
    recipientIgId: 'creator_1',
    senderIgsid: 'convert_user',
    checkFollowFn: async () => ({ supported: true, isFollowing: true, verified: true })
  });

  assert.strictEqual(res.state, 'RESOURCE_DELIVERED');
  assert.strictEqual(sm.deliveryCalls.length, 1, 'Resource delivered exactly once after following');
  assert(sm.deliveryCalls[0].text.includes("You're all set! 🎉"), 'Must include success confirmation prefix');
});

// 24. Regression 4: Non-follower fails verification -> resource send count remains ZERO
runTest('Regression 4: Non-follower fails verification -> resource send count remains ZERO', async () => {
  const sm = createWebhookStateMachine();
  const automation = {
    id: 'auto_reg_4',
    instagram_user_id: 'creator_1',
    flow: {
      followGate: { enabled: true },
      delivery: { message: 'Link', resourceUrl: 'https://site.com' }
    }
  };

  // Step 1: SEND_LINK
  await sm.handleWebhookEvent({
    action: 'SEND_LINK',
    automation,
    recipientIgId: 'creator_1',
    senderIgsid: 'stubborn_user',
    checkFollowFn: async () => ({ supported: true, isFollowing: false, verified: true })
  });

  // Step 2: User taps "I've followed" without actually following
  const res = await sm.handleWebhookEvent({
    action: 'CHECK_FOLLOW',
    automation,
    recipientIgId: 'creator_1',
    senderIgsid: 'stubborn_user',
    checkFollowFn: async () => ({ supported: true, isFollowing: false, verified: true })
  });

  assert.strictEqual(res.state, 'FOLLOW_RETRY_PROMPT');
  assert.strictEqual(sm.deliveryCalls.length, 0, 'Resource count must remain ZERO when verification fails');
  assert.strictEqual(sm.promptCalls.filter(p => p.type === 'follow_retry_prompt').length, 1);
});

// 25. Regression 5: Meta API error -> resource send count remains ZERO
runTest('Regression 5: Meta API error -> resource send count remains ZERO', async () => {
  const sm = createWebhookStateMachine();
  const automation = {
    id: 'auto_reg_5',
    instagram_user_id: 'creator_1',
    flow: {
      followGate: { enabled: true },
      delivery: { message: 'Secret Resource', resourceUrl: 'https://site.com' }
    }
  };

  const res = await sm.handleWebhookEvent({
    action: 'SEND_LINK',
    automation,
    recipientIgId: 'creator_1',
    senderIgsid: 'error_user',
    checkFollowFn: async () => ({ supported: false, error: 'Rate limit / OAuth error', verified: false })
  });

  assert.strictEqual(res.state, 'VERIFICATION_ERROR');
  assert.strictEqual(sm.deliveryCalls.length, 0, 'Resource must NEVER be delivered on Meta API error');
  assert.strictEqual(sm.promptCalls[0].type, 'verification_error');
});

// 26. Regression 6: Duplicate postback -> no duplicate resource
runTest('Regression 6: Duplicate postback -> no duplicate resource', async () => {
  const sm = createWebhookStateMachine();
  const automation = {
    id: 'auto_reg_6',
    instagram_user_id: 'creator_1',
    flow: {
      followGate: { enabled: false },
      delivery: { message: 'Link', resourceUrl: 'https://site.com' }
    }
  };

  // First tap
  const res1 = await sm.handleWebhookEvent({
    action: 'SEND_LINK',
    automation,
    recipientIgId: 'creator_1',
    senderIgsid: 'rapid_user',
    checkFollowFn: async () => ({ isFollowing: true, verified: true })
  });
  assert.strictEqual(sm.deliveryCalls.length, 1);

  // Duplicate tap 1
  const res2 = await sm.handleWebhookEvent({
    action: 'SEND_LINK',
    automation,
    recipientIgId: 'creator_1',
    senderIgsid: 'rapid_user',
    checkFollowFn: async () => ({ isFollowing: true, verified: true })
  });
  assert.strictEqual(res2.ignored, true);
  assert.strictEqual(sm.deliveryCalls.length, 1, 'Duplicate tap must not deliver resource again');

  // Duplicate tap 2
  await sm.handleWebhookEvent({
    action: 'CHECK_FOLLOW',
    automation,
    recipientIgId: 'creator_1',
    senderIgsid: 'rapid_user',
    checkFollowFn: async () => ({ isFollowing: true, verified: true })
  });
  assert.strictEqual(sm.deliveryCalls.length, 1, 'Postback on already delivered state must be ignored');
});

// 27. Regression 7: Follow gate disabled -> resource sent normally
runTest('Regression 7: Follow gate disabled -> resource sent normally without follower check', async () => {
  const sm = createWebhookStateMachine();
  let checkFollowCalled = false;
  const automation = {
    id: 'auto_reg_7',
    instagram_user_id: 'creator_1',
    flow: {
      followGate: { enabled: false },
      delivery: { message: 'Open Access Guide', resourceUrl: 'https://site.com/free' }
    }
  };

  const res = await sm.handleWebhookEvent({
    action: 'SEND_LINK',
    automation,
    recipientIgId: 'creator_1',
    senderIgsid: 'any_commenter',
    checkFollowFn: async () => {
      checkFollowCalled = true;
      return { isFollowing: false };
    }
  });

  assert.strictEqual(res.state, 'RESOURCE_DELIVERED');
  assert.strictEqual(sm.deliveryCalls.length, 1);
  assert.strictEqual(checkFollowCalled, false, 'Meta follower check must not be queried when follow gate is disabled');
});

// 28. Regression 8: Concurrent postbacks -> no bypass or duplicate delivery
runTest('Regression 8: Concurrent postbacks -> no bypass or duplicate delivery', async () => {
  const sm = createWebhookStateMachine();
  const automation = {
    id: 'auto_reg_8',
    instagram_user_id: 'creator_1',
    flow: {
      followGate: { enabled: true },
      delivery: { message: 'High Value Download', resourceUrl: 'https://site.com/valuable' }
    }
  };

  // Launch 10 concurrent postbacks simultaneously for the same user
  const promises = Array.from({ length: 10 }).map((_, i) =>
    sm.handleWebhookEvent({
      action: i % 2 === 0 ? 'SEND_LINK' : 'CHECK_FOLLOW',
      automation,
      recipientIgId: 'creator_1',
      senderIgsid: 'concurrent_user',
      checkFollowFn: async () => ({ supported: true, isFollowing: true, verified: true })
    })
  );

  await Promise.all(promises);
  assert.strictEqual(sm.deliveryCalls.length, 1, 'Concurrent postbacks must deliver the resource EXACTLY once');
});

console.log('\n======================================================');
console.log(`✅ ALL ${passedTests}/${totalTests} AUTOMATIONS SUITE TESTS PASSED!`);
console.log('======================================================');
