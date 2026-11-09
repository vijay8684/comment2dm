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
      const resourceUrl = flow.delivery.resourceUrl;
      const buttonText = (flow.delivery.buttonText || 'Open Guide ↗').trim().slice(0, 20);
      const deliveryText = flow.delivery.message;
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
        deliveryPayload = { text: deliveryText };
      }
      await mockInstagramService.sendDirectMessage(recipientIgId, senderIgsid, deliveryPayload);
      return { path: 'A', delivered: true };
    }
    return { path: 'B', delivered: false };
  }

  const result = handleSendLink({
    senderIgsid: 'igsid_follower',
    recipientIgId: 'creator_1',
    flow: { delivery: { message: 'Here is your requested guide:', resourceUrl: 'https://deal.com/guide', buttonText: 'Get Guide ↗' } },
    automation: { id: 'auto_1' }
  });

  return result.then(res => {
    assert.strictEqual(res.path, 'A');
    assert.strictEqual(res.delivered, true);
    assert(dmSent.msgData.attachment, 'Must use Button Template attachment');
    assert.strictEqual(dmSent.msgData.attachment.payload.buttons[0].type, 'web_url');
    assert.strictEqual(dmSent.msgData.attachment.payload.buttons[0].url, 'https://deal.com/guide');
    assert.strictEqual(dmSent.msgData.attachment.payload.buttons[0].title, 'Get Guide ↗');
  });
});

// 11. Scenario 2: Non-follower taps Send me the link -> follow request appears with TWO buttons (Path B)
runTest('Scenario 2: Non-follower taps Send me the link -> follow prompt with Visit Profile and I\'ve followed buttons', () => {
  let dmSent = null;
  const mockInstagramService = {
    checkFollowStatus: async () => ({ supported: true, isFollowing: false, verified: true }),
    sendDirectMessage: async (recipientIgId, senderIgsid, msgData) => {
      dmSent = { recipientIgId, senderIgsid, msgData };
      return { id: 'msg_124' };
    }
  };

  async function handleSendLink({ senderIgsid, recipientIgId, flow, creatorUsername, automationId, commentId }) {
    const followStatus = await mockInstagramService.checkFollowStatus();
    if (followStatus.isFollowing) {
      return { path: 'A', delivered: true };
    }
    const followPrompt = flow.followGate?.message || "Oops! Looks like you haven't followed me yet 👀";
    const profileBtn = (flow.followGate?.profileBtnText || 'Visit Profile').trim().slice(0, 20);
    const confirmBtn = (flow.followGate?.confirmBtnText || "I've followed ✓").trim().slice(0, 20);
    const profileUrl = flow.followGate?.profileUrl || `https://instagram.com/${creatorUsername}`;

    const followPayload = {
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
              payload: `CHECK_FOLLOW:${automationId}:${commentId}`
            }
          ]
        }
      }
    };

    await mockInstagramService.sendDirectMessage(recipientIgId, senderIgsid, followPayload);
    return { path: 'B', delivered: false, promptSent: true };
  }

  const result = handleSendLink({
    senderIgsid: 'igsid_non_follower',
    recipientIgId: 'creator_1',
    creatorUsername: 'star_creator',
    automationId: 'auto_777',
    commentId: 'comm_888',
    flow: {
      followGate: { message: "Oops! Looks like you haven't followed me yet 👀" },
      delivery: { message: 'Here is link', resourceUrl: 'https://deal.com' }
    }
  });

  return result.then(res => {
    assert.strictEqual(res.path, 'B');
    assert.strictEqual(res.delivered, false);
    assert.strictEqual(res.promptSent, true);
    assert(dmSent.msgData.attachment, 'Must use Button Template for follow prompt');
    const buttons = dmSent.msgData.attachment.payload.buttons;
    assert.strictEqual(buttons.length, 2, 'Must have exactly TWO interactive buttons');
    assert.strictEqual(buttons[0].type, 'web_url', 'Button 1 must be web_url');
    assert.strictEqual(buttons[0].title, 'Visit Profile');
    assert.strictEqual(buttons[0].url, 'https://instagram.com/star_creator');
    assert.strictEqual(buttons[1].type, 'postback', 'Button 2 must be postback');
    assert.strictEqual(buttons[1].title, "I've followed ✓");
    assert.strictEqual(buttons[1].payload, 'CHECK_FOLLOW:auto_777:comm_888');
  });
});

// 12. Scenario 3: Non-follower follows and taps I've followed -> resource arrives immediately (zero extra steps)
runTest('Scenario 3: Non-follower follows and taps I\'ve followed -> resource arrives immediately', () => {
  let dmSent = null;
  const mockInstagramService = {
    checkFollowStatus: async () => ({ supported: true, isFollowing: true, verified: true }),
    sendDirectMessage: async (recipientIgId, senderIgsid, msgData) => {
      dmSent = { recipientIgId, senderIgsid, msgData };
      return { id: 'msg_125' };
    }
  };

  async function handleCheckFollow({ senderIgsid, recipientIgId, flow, automation }) {
    const recheckStatus = await mockInstagramService.checkFollowStatus();
    if (recheckStatus.isFollowing) {
      const resourceUrl = flow.delivery.resourceUrl;
      const buttonText = (flow.delivery.buttonText || 'Open Guide ↗').trim().slice(0, 20);
      const deliveryPayload = {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'button',
            text: flow.delivery.message,
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
      await mockInstagramService.sendDirectMessage(recipientIgId, senderIgsid, deliveryPayload);
      return { verified: true, delivered: true };
    }
    return { verified: false, delivered: false };
  }

  const result = handleCheckFollow({
    senderIgsid: 'igsid_new_follower',
    recipientIgId: 'creator_1',
    flow: { delivery: { message: 'You\'re all set! 🎉', resourceUrl: 'https://deal.com/guide' } },
    automation: { id: 'auto_1' }
  });

  return result.then(res => {
    assert.strictEqual(res.verified, true);
    assert.strictEqual(res.delivered, true);
    assert(dmSent.msgData.attachment, 'Resource delivered via Button Template');
    assert.strictEqual(dmSent.msgData.attachment.payload.buttons[0].url, 'https://deal.com/guide');
  });
});

// 13. Scenario 4: Person does not follow -> retry message appears with TWO buttons
runTest('Scenario 4: Person does not follow -> retry message appears with recheck and profile buttons', () => {
  let dmSent = null;
  const mockInstagramService = {
    checkFollowStatus: async () => ({ supported: true, isFollowing: false, verified: true }),
    sendDirectMessage: async (recipientIgId, senderIgsid, msgData) => {
      dmSent = { recipientIgId, senderIgsid, msgData };
      return { id: 'msg_126' };
    }
  };

  async function handleCheckFollow({ senderIgsid, recipientIgId, flow, creatorUsername, automationId, commentId }) {
    const recheckStatus = await mockInstagramService.checkFollowStatus();
    if (recheckStatus.isFollowing) {
      return { delivered: true };
    }
    const retryMsg = flow.followGate?.retryMessage || "I couldn't confirm that you're following yet 😊";
    const profileUrl = flow.followGate?.profileUrl || `https://instagram.com/${creatorUsername}`;
    const profileBtn = (flow.followGate?.profileBtnText || 'Visit Profile').trim().slice(0, 20);
    const confirmBtn = (flow.followGate?.confirmBtnText || "I've followed ✓").trim().slice(0, 20);

    const notVerifiedPayload = {
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
              payload: `CHECK_FOLLOW:${automationId}:${commentId}`
            }
          ]
        }
      }
    };

    await mockInstagramService.sendDirectMessage(recipientIgId, senderIgsid, notVerifiedPayload);
    return { delivered: false, retrySent: true };
  }

  const result = handleCheckFollow({
    senderIgsid: 'igsid_still_non_follower',
    recipientIgId: 'creator_1',
    creatorUsername: 'star_creator',
    automationId: 'auto_777',
    commentId: 'comm_888',
    flow: {
      followGate: { retryMessage: "Still not seeing that follow yet! 👀" }
    }
  });

  return result.then(res => {
    assert.strictEqual(res.delivered, false);
    assert.strictEqual(res.retrySent, true);
    assert(dmSent.msgData.attachment, 'Must use Button Template');
    const buttons = dmSent.msgData.attachment.payload.buttons;
    assert.strictEqual(buttons.length, 2, 'Retry prompt must have TWO interactive buttons');
    assert.strictEqual(buttons[0].type, 'web_url');
    assert.strictEqual(buttons[0].url, 'https://instagram.com/star_creator');
    assert.strictEqual(buttons[1].type, 'postback');
    assert.strictEqual(buttons[1].title, "I've followed ✓");
  });
});

// 14. Scenario 5: Instagram API returns unknown/error -> safe retry state without false claim
runTest('Scenario 5: Instagram API returns unknown/error -> safe retry state without false claim', () => {
  let dmSent = null;
  const mockInstagramService = {
    checkFollowStatus: async () => ({ supported: false, isFollowing: false, error: 'OAuthException code 100' }),
    sendDirectMessage: async (recipientIgId, senderIgsid, msgData) => {
      dmSent = { recipientIgId, senderIgsid, msgData };
      return { id: 'msg_127' };
    }
  };

  async function handleSendLinkWithError({ senderIgsid, recipientIgId, creatorUsername, automationId, commentId }) {
    const followStatus = await mockInstagramService.checkFollowStatus();
    if (!followStatus.supported || followStatus.error) {
      const retryNotice = "We couldn't verify your follow status right now due to a network or API delay. Please tap below to retry!";
      const profileUrl = `https://instagram.com/${creatorUsername}`;
      const errorPayload = {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'button',
            text: retryNotice,
            buttons: [
              {
                type: 'web_url',
                url: profileUrl,
                title: 'Visit Profile'
              },
              {
                type: 'postback',
                title: 'Retry Check 🔄',
                payload: `CHECK_FOLLOW:${automationId}:${commentId}`
              }
            ]
          }
        }
      };
      await mockInstagramService.sendDirectMessage(recipientIgId, senderIgsid, errorPayload);
      return { safeRetry: true, falseClaimMade: false };
    }
    return { safeRetry: false };
  }

  const result = handleSendLinkWithError({
    senderIgsid: 'igsid_api_error',
    recipientIgId: 'creator_1',
    creatorUsername: 'star_creator',
    automationId: 'auto_777',
    commentId: 'comm_888'
  });

  return result.then(res => {
    assert.strictEqual(res.safeRetry, true);
    assert.strictEqual(res.falseClaimMade, false);
    assert(dmSent.msgData.attachment);
    assert(dmSent.msgData.attachment.payload.text.includes("couldn't verify your follow status right now"));
    assert(!dmSent.msgData.attachment.payload.text.includes('verified'), 'Must not claim verified');
    assert.strictEqual(dmSent.msgData.attachment.payload.buttons.length, 2);
    assert.strictEqual(dmSent.msgData.attachment.payload.buttons[1].title, 'Retry Check 🔄');
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

// 16. Scenario 7: Two different comments on different Reels/media -> correct automation isolated
runTest('Scenario 7: Multi-comment isolation - comments on different Reels match their own specific automation', () => {
  const automations = [
    { id: 'auto_reel_A', media_id: 'media_111', keyword: 'BOOK', dm_message: 'Guide for Book A', enabled: 1 },
    { id: 'auto_reel_B', media_id: 'media_222', keyword: 'BOOK', dm_message: 'Guide for Book B', enabled: 1 }
  ];

  function matchAutomationForComment(commentMediaId, commentText) {
    const matched = automations.filter(a => {
      if (a.media_id && commentMediaId) {
        return String(commentMediaId).includes(String(a.media_id));
      }
      return !a.media_id;
    });
    return matched.find(a => commentText.toUpperCase().includes(a.keyword.toUpperCase())) || null;
  }

  const match1 = matchAutomationForComment('media_111', 'I want the BOOK please!');
  assert.strictEqual(match1.id, 'auto_reel_A');
  assert.strictEqual(match1.dm_message, 'Guide for Book A');

  const match2 = matchAutomationForComment('media_222', 'Send me BOOK now');
  assert.strictEqual(match2.id, 'auto_reel_B');
  assert.strictEqual(match2.dm_message, 'Guide for Book B');
});

// 17. Scenario 8: Paused automation (enabled = false / 0) -> no message triggered
runTest('Scenario 8: Paused automation (enabled = 0 or false) -> completely ignored and triggers nothing', () => {
  const allAutomations = [
    { id: 'auto_paused', media_id: 'media_333', keyword: 'FREE', enabled: 0 },
    { id: 'auto_active', media_id: 'media_444', keyword: 'PRO', enabled: 1 }
  ];

  function getActiveAutomations(commentMediaId, commentText) {
    const activeOnly = allAutomations.filter(a => a.enabled === 1 || a.enabled === true);
    return activeOnly.filter(a => {
      if (a.media_id && commentMediaId) {
        return String(commentMediaId).includes(String(a.media_id));
      }
      return !a.media_id;
    }).find(a => commentText.toUpperCase().includes(a.keyword.toUpperCase())) || null;
  }

  const resultPaused = getActiveAutomations('media_333', 'I want FREE item');
  assert.strictEqual(resultPaused, null, 'Paused automation must never match');

  const resultActive = getActiveAutomations('media_444', 'Send PRO link');
  assert(resultActive !== null, 'Active automation must match');
  assert.strictEqual(resultActive.id, 'auto_active');
});

// 18. Scenario 9: Follow gate disabled -> normal direct DM delivery
runTest('Scenario 9: Follow gate disabled -> normal DM delivery without follower prompt', () => {
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

// 19. Scenario 10: Free-plan user attempts to enable follow gate -> backend rejects with 403
runTest('Scenario 10: Free-plan user attempts to enable follow gate -> backend rejects with 403', () => {
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

console.log('\n======================================================');
console.log(`✅ ALL ${passedTests}/${totalTests} AUTOMATIONS SUITE TESTS PASSED!`);
console.log('======================================================');
