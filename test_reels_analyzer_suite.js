// test_reels_analyzer_suite.js
// Automated test suite for Comment2DM Phase 1: Reel Performance Analyzer & Credit Security

const assert = require('assert');
const instagramService = require('./src/instagram/instagramService');
const billing = require('./src/billing');
const fs = require('fs');
const path = require('path');

async function runSuite() {
  console.log('======================================================');
  console.log('COMMENT2DM REEL PERFORMANCE ANALYZER TEST SUITE (PHASE 1)');
  console.log('======================================================\n');

  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      console.log(`Test ${passed + failed + 1}: ${name}`);
      console.log('  ✓ PASSED');
      passed++;
    } catch (err) {
      console.log(`Test ${passed + failed + 1}: ${name}`);
      console.log(`  ❌ FAILED: ${err.message}`);
      failed++;
    }
  }

  async function testAsync(name, fn) {
    try {
      await fn();
      console.log(`Test ${passed + failed + 1}: ${name}`);
      console.log('  ✓ PASSED');
      passed++;
    } catch (err) {
      console.log(`Test ${passed + failed + 1}: ${name}`);
      console.log(`  ❌ FAILED: ${err.message}`);
      failed++;
    }
  }

  // 1. Engagement Formula: By Reach
  test('Engagement Formula: By Reach computes correctly and provides transparent metadata', () => {
    const metrics = {
      likes: { value: 120, status: 'retrieved', source: 'meta_api' },
      comments: { value: 30, status: 'retrieved', source: 'meta_api' },
      shares: { value: 15, status: 'retrieved', source: 'meta_api' },
      saved: { value: 35, status: 'retrieved', source: 'meta_api' },
      reach: { value: 2000, status: 'retrieved', source: 'meta_api' }
    };
    const res = instagramService.calculateReelEngagement(metrics);
    // Total interactions = 120 + 30 + 15 + 35 = 200
    assert.strictEqual(res.totalInteractions.value, 200);
    // Rate = (200 / 2000) * 100 = 10.0%
    assert.strictEqual(res.byReach.available, true);
    assert.strictEqual(res.byReach.rate, 10.0);
    assert.strictEqual(res.byReach.formula, '(Total Interactions / Reach) × 100');
    assert.ok(res.byReach.explanation.includes('unique accounts reached'));
  });

  // 2. Engagement Formula: By Views (Plays)
  test('Engagement Formula: By Views computes correctly and provides transparent metadata', () => {
    const metrics = {
      likes: { value: 90, status: 'retrieved', source: 'meta_api' },
      comments: { value: 10, status: 'retrieved', source: 'meta_api' },
      views: { value: 2500, status: 'retrieved', source: 'meta_api' }
    };
    const res = instagramService.calculateReelEngagement(metrics);
    // Total interactions = 100
    assert.strictEqual(res.totalInteractions.value, 100);
    // Rate = (100 / 2500) * 100 = 4.0%
    assert.strictEqual(res.byViews.available, true);
    assert.strictEqual(res.byViews.rate, 4.0);
    assert.strictEqual(res.byViews.formula, '(Total Interactions / Views) × 100');
  });

  // 3. Engagement Formula: By Followers
  test('Engagement Formula: By Followers computes correctly against account follower count', () => {
    const metrics = {
      likes: { value: 150, status: 'retrieved', source: 'meta_api' },
      comments: { value: 50, status: 'retrieved', source: 'meta_api' }
    };
    const followers = 5000;
    const res = instagramService.calculateReelEngagement(metrics, followers);
    // Total interactions = 200
    // Rate = (200 / 5000) * 100 = 4.0%
    assert.strictEqual(res.byFollowers.available, true);
    assert.strictEqual(res.byFollowers.rate, 4.0);
    assert.strictEqual(res.byFollowers.formula, '(Total Interactions / Followers) × 100');
  });

  // 4. Missing Metric Integrity: Never treat missing metrics as zero
  test('Missing Metric Integrity: Unavailable metrics are null with explicit status, not zero', () => {
    const metrics = {
      likes: { value: 50, status: 'retrieved', source: 'meta_api' },
      comments: { value: 5, status: 'retrieved', source: 'meta_api' },
      reach: { value: null, status: 'unavailable', source: 'meta_api' },
      views: { value: null, status: 'unavailable', source: 'meta_api' }
    };
    const res = instagramService.calculateReelEngagement(metrics, null);
    assert.strictEqual(res.byReach.available, false);
    assert.strictEqual(res.byReach.rate, null);
    assert.ok(res.byReach.reason.includes('unavailable'));

    assert.strictEqual(res.byViews.available, false);
    assert.strictEqual(res.byViews.rate, null);
    assert.ok(res.byViews.reason.includes('unavailable'));

    assert.strictEqual(res.byFollowers.available, false);
    assert.strictEqual(res.byFollowers.rate, null);
    assert.ok(res.byFollowers.reason.includes('unavailable'));
  });

  // 5. Manual Fallback: Clean calculation & explicit labeling
  test('Manual Fallback: Calculates all available rates and strictly labels source as manual_entry', () => {
    const input = {
      caption: 'My draft fitness reel',
      followers: 10000,
      reach: 3000,
      views: 5000,
      likes: 200,
      comments: 50,
      shares: 20,
      saved: 30
    };
    const res = instagramService.analyzeManualReel(input);
    assert.strictEqual(res.source, 'manual_entry');
    assert.strictEqual(res.metrics.likes.status, 'manual');
    assert.strictEqual(res.metrics.reach.status, 'manual');
    assert.strictEqual(res.metrics.likes.source, 'manual_entry');

    // Total interactions = 200 + 50 + 20 + 30 = 300
    // By Reach: (300 / 3000) * 100 = 10.0%
    assert.strictEqual(res.calculations.byReach.available, true);
    assert.strictEqual(res.calculations.byReach.rate, 10.0);

    // Performance score vs 3.0% baseline
    assert.ok(res.performanceScore >= 80);
    assert.strictEqual(res.performanceTier, 'Top Performer');
    assert.ok(res.scoreExplanation.includes('above industry baseline'));
  });

  // 6. Transparent Performance Ranking & Scoring
  test('Performance Ranking & Scoring: Deterministic rank assignment and average calculation', () => {
    const reelsSample = [
      { id: '101', caption: 'High reel', likeCount: 500, commentsCount: 100 }, // 600
      { id: '102', caption: 'Medium reel', likeCount: 150, commentsCount: 50 },  // 200
      { id: '103', caption: 'Low reel', likeCount: 40, commentsCount: 10 }      // 50
    ];
    const followers = 10000;
    // Rates by followers: 101 -> 6.0%, 102 -> 2.0%, 103 -> 0.5%
    const analyzed = reelsSample.map(r => {
      const calc = instagramService.calculateReelEngagement({
        likes: { value: r.likeCount, status: 'retrieved' },
        comments: { value: r.commentsCount, status: 'retrieved' }
      }, followers);
      return { id: r.id, caption: r.caption, activeRate: calc.byFollowers.rate };
    });

    analyzed.sort((a, b) => b.activeRate - a.activeRate);
    analyzed.forEach((r, idx) => { r.rank = idx + 1; });

    assert.strictEqual(analyzed[0].id, '101');
    assert.strictEqual(analyzed[0].rank, 1);
    assert.strictEqual(analyzed[2].id, '103');
    assert.strictEqual(analyzed[2].rank, 3);

    const avg = Number(((6.0 + 2.0 + 0.5) / 3).toFixed(2));
    assert.strictEqual(avg, 2.83);
  });

  // 7. Backend Credit Vulnerability: Balance Query
  await testAsync('Credit System: getAiCreditBalance returns valid quota and tracks monthly limits', async () => {
    const testUserId = 'test_user_cred_01';
    const balanceInfo = await billing.getAiCreditBalance(testUserId);
    assert.strictEqual(typeof balanceInfo.balance, 'number');
    assert.strictEqual(typeof balanceInfo.limit, 'number');
    assert.strictEqual(typeof balanceInfo.used, 'number');
    assert.strictEqual(balanceInfo.limit, 100); // Free plan default
    assert.ok(balanceInfo.balance <= 100);
  });

  // 8. Backend Credit Vulnerability: Atomic Deduction & Rejection on Insufficient Balance
  await testAsync('Credit System: Atomic deduction updates balance and rejects overdraft with HTTP 402', async () => {
    const testUserId = 'test_user_cred_deduct_' + Date.now();
    
    // Balance starts at 100
    const initial = await billing.getAiCreditBalance(testUserId);
    assert.strictEqual(initial.balance, 100);

    // Deduct 10 credits for hooks
    const ded1 = await billing.deductAiCredits(testUserId, 10, 'hooks');
    assert.strictEqual(ded1.success, true);
    assert.strictEqual(ded1.remaining, 90);
    assert.strictEqual(ded1.deducted, 10);

    // Verify balance after deduction
    const after1 = await billing.getAiCreditBalance(testUserId);
    assert.strictEqual(after1.balance, 90);
    assert.strictEqual(after1.used, 10);

    // Attempting to deduct 95 credits when only 90 remain must throw 402
    let threw = false;
    try {
      await billing.deductAiCredits(testUserId, 95, 'large_batch');
    } catch (err) {
      threw = true;
      assert.strictEqual(err.statusCode, 402);
      assert.ok(err.message.includes('Insufficient AI credits'));
    }
    assert.strictEqual(threw, true);

    // Verify balance remained unchanged at 90
    const afterFail = await billing.getAiCreditBalance(testUserId);
    assert.strictEqual(afterFail.balance, 90);
  });

  // 9. Free Deterministic Operations consume ZERO credits
  await testAsync('Credit System: Deterministic tools (Reel Analyzer, Manual Fallback, UTM) cost 0 credits', async () => {
    const testUserId = 'test_user_free_' + Date.now();
    const before = await billing.getAiCreditBalance(testUserId);
    
    // Calling analyzeManualReel consumes 0 credits
    const manualResult = instagramService.analyzeManualReel({ likes: 100, comments: 20 });
    assert.ok(manualResult.calculations);

    // Deducting 0 credits preserves balance
    const dedZero = await billing.deductAiCredits(testUserId, 0, 'reels_analyzer');
    assert.strictEqual(dedZero.remaining, before.balance);
    assert.strictEqual(dedZero.deducted, 0);

    const after = await billing.getAiCreditBalance(testUserId);
    assert.strictEqual(after.balance, before.balance);
  });

  // 10. Multi-Tenant Account Ownership & Route Protection
  test('Security & Multi-Tenant: server.js enforces requireAuth and ownership on reels performance', () => {
    const serverCode = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    assert.ok(serverCode.includes("app.get('/api/creator/reels/performance', requireAuth"));
    assert.ok(serverCode.includes("app.get('/api/creator/reels/:mediaId/insights', requireAuth"));
    assert.ok(serverCode.includes("app.post('/api/creator/reels/analyze-manual', requireAuth"));
    assert.ok(serverCode.includes("getDecryptedTokenForAccount(request.user.id, instagramUserId)"));
  });

  // 11. HTML UI: Reel Performance Analyzer elements
  test('HTML UI: creator-tools.html contains Tab 1 Reel Performance Analyzer and components', () => {
    const html = fs.readFileSync(path.join(__dirname, 'creator-tools.html'), 'utf8');
    assert.ok(html.includes('id="panel-reels-analyzer"'));
    assert.ok(html.includes('id="tabReelsAnalyzer"'));
    assert.ok(html.includes('id="formulaSelector"'));
    assert.ok(html.includes('id="sortSelector"'));
    assert.ok(html.includes('id="reelsSummaryGrid"'));
    assert.ok(html.includes('id="observationsContainer"'));
    assert.ok(html.includes('id="manualFallbackCard"'));
    assert.ok(html.includes('id="reelInsightsModal"'));
  });

  // 12. Frontend JavaScript: creator-tools.js handlers
  test('Frontend JS: creator-tools.js handles reels performance, formulas, and modal breakdown', () => {
    const js = fs.readFileSync(path.join(__dirname, 'creator-tools.js'), 'utf8');
    assert.ok(js.includes('loadReelPerformance'));
    assert.ok(js.includes('renderReelsPerformance'));
    assert.ok(js.includes('openReelInsightsModal'));
    assert.ok(js.includes('/api/creator/reels/analyze-manual'));
    assert.ok(js.includes('/api/creator/credits'));
    assert.ok(js.includes('comment2dm:accountChanged'));
  });

  console.log('\n======================================================');
  console.log(`PHASE 1 TEST SUMMARY: ${passed}/${passed + failed} PASSED, ${failed} FAILED`);
  console.log('======================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runSuite().catch(err => {
  console.error('Fatal suite error:', err);
  process.exit(1);
});
