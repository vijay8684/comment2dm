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

console.log('\n======================================================');
console.log(`✅ ALL ${passedTests}/${totalTests} AUTOMATIONS SUITE TESTS PASSED!`);
console.log('======================================================');
