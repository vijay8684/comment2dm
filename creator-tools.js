// creator-tools.js — Comment2DM Creator Studio AI
(function () {
  'use strict';

  let aiCredits = 100;
  let activeInstagramAccount = null;
  let currentReelsData = null;

  // ── Tab switching ──────────────────────────────────────────────────────────
  document.getElementById('studioTabs')?.addEventListener('click', (e) => {
    const tab = e.target.closest('.studio-tab');
    if (!tab) return;
    document.querySelectorAll('.studio-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.studio-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    const panelId = 'panel-' + tab.dataset.panel;
    const panel = document.getElementById(panelId);
    if (panel) panel.classList.add('active');
  });

  // ── Load AI credits ────────────────────────────────────────────────────────
  async function loadCredits() {
    try {
      const res = await fetch('/api/creator/credits', {
        headers: window.getAuthHeaders ? window.getAuthHeaders() : {}
      });
      if (!res.ok) {
        // Fallback to billing status
        const billRes = await fetch('/api/billing/status', {
          headers: window.getAuthHeaders ? window.getAuthHeaders() : {}
        });
        if (billRes.ok) {
          const bData = await billRes.json();
          aiCredits = bData.aiCreditsRemaining ?? bData.limits?.aiCreditsMonthly ?? 100;
        }
      } else {
        const data = await res.json();
        aiCredits = data.balance ?? data.limit ?? 100;
      }
      updateCreditsDisplay();
    } catch (_) {}
  }

  function updateCreditsDisplay() {
    const el = document.getElementById('aiCreditsDisplay');
    if (el) el.textContent = aiCredits === Infinity ? 'Unlimited' : aiCredits.toLocaleString();
  }

  // ── Generic AI call ────────────────────────────────────────────────────────
  async function callAI(payload) {
    const res = await fetch('/api/creator/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(window.getAuthHeaders ? window.getAuthHeaders() : {}) },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Generation failed');
    if (typeof data.creditsRemaining === 'number') {
      aiCredits = data.creditsRemaining;
      updateCreditsDisplay();
    }
    return data.result;
  }

  // ── Set button loading state ───────────────────────────────────────────────
  function setLoading(btn, loading, defaultText) {
    if (loading) {
      btn.disabled = true;
      btn.innerHTML = '<div class="spinner"></div> Generating…';
    } else {
      btn.disabled = false;
      btn.textContent = defaultText || btn.dataset.origText || btn.textContent;
    }
  }

  // ===========================================================================
  // PHASE 1 — REEL PERFORMANCE ANALYZER
  // ===========================================================================

  async function resolveActiveAccount() {
    try {
      const res = await fetch('/api/instagram/accounts', {
        headers: window.getAuthHeaders ? window.getAuthHeaders() : {}
      });
      if (!res.ok) return null;
      const data = await res.json();
      const accounts = data.accounts || [];
      if (!accounts.length) return null;

      const storedId = localStorage.getItem('comment2dm_selected_account_id');
      const found = accounts.find(a => String(a.id) === String(storedId));
      activeInstagramAccount = found || accounts[0];
      return activeInstagramAccount;
    } catch {
      return null;
    }
  }

  function updateActiveAccountUI() {
    const badge = document.getElementById('activeReelsAccountUsername');
    if (badge) {
      badge.textContent = activeInstagramAccount ? `@${activeInstagramAccount.username}` : 'No Connected Account';
    }
  }

  async function loadReelPerformance(forceRefresh = false) {
    const skeleton = document.getElementById('reelsLoadingSkeleton');
    const grid = document.getElementById('reelsGrid');
    const empty = document.getElementById('reelsEmptyState');
    const formulaSelect = document.getElementById('formulaSelector');
    const formula = formulaSelect ? formulaSelect.value : 'reach';

    if (skeleton) skeleton.style.display = 'block';
    if (grid) grid.style.display = 'none';
    if (empty) empty.style.display = 'none';

    if (!activeInstagramAccount) {
      await resolveActiveAccount();
    }
    updateActiveAccountUI();

    if (!activeInstagramAccount) {
      if (skeleton) skeleton.style.display = 'none';
      if (empty) empty.style.display = 'block';
      return;
    }

    try {
      const url = `/api/creator/reels/performance?instagram_user_id=${encodeURIComponent(activeInstagramAccount.id)}&formula=${encodeURIComponent(formula)}&force=${forceRefresh ? 'true' : 'false'}`;
      const res = await fetch(url, {
        headers: window.getAuthHeaders ? window.getAuthHeaders() : {}
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }

      const data = await res.json();
      currentReelsData = data;
      renderReelsPerformance(data);
    } catch (err) {
      console.warn('[REELS_ANALYZER] Performance load notice:', err.message);
      if (skeleton) skeleton.style.display = 'none';
      if (empty) {
        empty.style.display = 'block';
        empty.innerHTML = `
          <div style="font-size:2rem;margin-bottom:10px;">⚠️</div>
          <div style="font-size:1rem;font-weight:600;color:#f1f5f9;margin-bottom:4px;">Meta Insights Unavailable</div>
          <div style="font-size:0.84rem;max-width:460px;margin:0 auto 16px;color:rgba(255,255,255,0.5);">
            ${err.message.includes('Instagram access token has expired') ? 'Your Instagram token has expired. Reconnect in Instagram Accounts.' : 'Official Meta insights could not be retrieved. You can use the Manual Fallback Calculator below to analyze your metrics.'}
          </div>
          <button class="btn-secondary" onclick="document.getElementById('toggleManualFallbackBtn').click();">Open Manual Fallback Calculator</button>
        `;
      }
    }
  }

  function renderReelsPerformance(data) {
    const skeleton = document.getElementById('reelsLoadingSkeleton');
    const grid = document.getElementById('reelsGrid');
    const empty = document.getElementById('reelsEmptyState');

    if (skeleton) skeleton.style.display = 'none';

    const reels = data.reels || [];
    if (!reels.length) {
      if (empty) empty.style.display = 'block';
      if (grid) grid.style.display = 'none';
      return;
    }

    if (empty) empty.style.display = 'none';
    if (grid) grid.style.display = 'grid';

    // Update Summary Cards
    const summary = data.summary || {};
    const avgEl = document.getElementById('summaryAvgRate');
    if (avgEl) avgEl.textContent = typeof summary.averageEngagementRate === 'number' ? `${summary.averageEngagementRate}%` : '—';

    const topEl = document.getElementById('summaryTopRate');
    if (topEl) topEl.textContent = summary.topPerformer && typeof summary.topPerformer.rate === 'number' ? `${summary.topPerformer.rate}%` : '—';

    const countEl = document.getElementById('summaryReelsCount');
    if (countEl) countEl.textContent = summary.totalAnalyzed || reels.length;

    const tierEl = document.getElementById('summaryBenchmarkTier');
    if (tierEl) {
      if (summary.averageEngagementRate >= 3.5) {
        tierEl.textContent = '🔥 High Growth';
        tierEl.style.color = '#10b981';
      } else if (summary.averageEngagementRate >= 1.5) {
        tierEl.textContent = '👍 Steady';
        tierEl.style.color = '#818cf8';
      } else {
        tierEl.textContent = '⚠️ Needs Boost';
        tierEl.style.color = '#f59e0b';
      }
    }

    // Update Observations List
    const obsList = document.getElementById('observationsList');
    if (obsList && data.observations && data.observations.length) {
      obsList.innerHTML = data.observations.map(obs => `<li style="margin-bottom:6px;">${obs}</li>`).join('');
    }

    // Sort Reels
    const sortVal = document.getElementById('sortSelector')?.value || 'engagement';
    const sorted = [...reels].sort((a, b) => {
      if (sortVal === 'recent') return new Date(b.timestamp || 0) - new Date(a.timestamp || 0);
      if (sortVal === 'comments') return (b.metrics?.comments?.value || 0) - (a.metrics?.comments?.value || 0);
      if (sortVal === 'likes') return (b.metrics?.likes?.value || 0) - (a.metrics?.likes?.value || 0);
      return (b.activeRate || 0) - (a.activeRate || 0);
    });

    // Render Cards
    grid.innerHTML = sorted.map(reel => {
      const metrics = reel.metrics || {};
      const likes = metrics.likes?.value;
      const comments = metrics.comments?.value;
      const reach = metrics.reach?.value;
      const views = metrics.views?.value;
      const shares = metrics.shares?.value;
      const saved = metrics.saved?.value;

      const rateDisplay = typeof reel.activeRate === 'number' ? `${reel.activeRate}%` : '—';
      const tierClass = reel.performanceTier === 'Top Performer' ? 'tier-top' :
                        reel.performanceTier === 'Needs Iteration' ? 'tier-needs-iteration' : 'tier-steady';
      const tierIcon = reel.performanceTier === 'Top Performer' ? '🔥' :
                       reel.performanceTier === 'Needs Iteration' ? '⚠️' : '✨';

      const dateStr = reel.timestamp ? new Date(reel.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Recent';

      return `
        <div class="reel-card" data-reel-id="${reel.id}">
          <div>
            <div class="reel-header">
              <div class="reel-thumb-box">
                ${reel.thumbnailUrl ? `<img src="${reel.thumbnailUrl}" class="reel-thumb-img" alt="Reel thumbnail">` : `<span style="font-size:1.4rem;">🎬</span>`}
              </div>
              <div style="flex:1;min-width:0;">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:2px;">
                  <span class="tier-badge ${tierClass}">${tierIcon} ${reel.performanceTier || 'Reel'}</span>
                  <span style="font-size:0.74rem;color:rgba(255,255,255,0.35);">${dateStr}</span>
                </div>
                <div class="reel-caption-text" title="${reel.caption || ''}">${reel.caption || 'No caption available'}</div>
              </div>
            </div>

            <!-- Metrics Grid with Transparent Labels -->
            <div class="reel-metrics-grid">
              <div class="metric-pill">
                <span>Reach</span>
                ${reach !== null && reach !== undefined ? `<strong>${reach.toLocaleString()}</strong>` : `<span class="metric-status-tag status-unavailable">Unavailable</span>`}
              </div>
              <div class="metric-pill">
                <span>Views/Plays</span>
                ${views !== null && views !== undefined ? `<strong>${views.toLocaleString()}</strong>` : `<span class="metric-status-tag status-unavailable">Unavailable</span>`}
              </div>
              <div class="metric-pill">
                <span>Likes</span>
                ${likes !== null && likes !== undefined ? `<strong>${likes.toLocaleString()}</strong>` : `<span class="metric-status-tag status-unavailable">—</span>`}
              </div>
              <div class="metric-pill">
                <span>Comments</span>
                ${comments !== null && comments !== undefined ? `<strong>${comments.toLocaleString()}</strong>` : `<span class="metric-status-tag status-unavailable">—</span>`}
              </div>
              <div class="metric-pill">
                <span>Shares</span>
                ${shares !== null && shares !== undefined ? `<strong>${shares.toLocaleString()}</strong>` : `<span class="metric-status-tag status-unavailable">Unavailable</span>`}
              </div>
              <div class="metric-pill">
                <span>Saves</span>
                ${saved !== null && saved !== undefined ? `<strong>${saved.toLocaleString()}</strong>` : `<span class="metric-status-tag status-unavailable">Unavailable</span>`}
              </div>
            </div>

            <div style="margin-top:10px;padding:8px 12px;background:rgba(255,255,255,0.02);border-radius:8px;display:flex;align-items:center;justify-content:space-between;">
              <span style="font-size:0.78rem;color:rgba(255,255,255,0.5);">Engagement (${reel.activeFormulaName || 'Formula'}):</span>
              <span style="font-size:1.1rem;font-weight:700;color:#f1f5f9;">${rateDisplay}</span>
            </div>

            <div style="font-size:0.75rem;color:rgba(255,255,255,0.4);margin-top:6px;">
              Score: <strong style="color:#818cf8;">${reel.performanceScore || 50}/100</strong> · Rank #${reel.rank || '–'} of ${reel.totalRanked || reels.length}
            </div>
          </div>

          <div style="display:flex;align-items:center;gap:8px;margin-top:14px;flex-wrap:wrap;">
            <button class="btn-secondary view-insights-btn" style="flex:1;justify-content:center;font-size:0.78rem;padding:6px 10px;" data-id="${reel.id}">
              📊 Detailed Insights
            </button>
            <button class="btn-secondary generate-ideas-reel-btn" style="flex:1;justify-content:center;font-size:0.78rem;padding:6px 10px;color:#818cf8;border-color:rgba(99,102,241,0.25);" data-id="${reel.id}">
              💡 Ideas From Reel
            </button>
          </div>
        </div>
      `;
    }).join('');

    // Attach event listeners to card buttons
    grid.querySelectorAll('.view-insights-btn').forEach(btn => {
      btn.addEventListener('click', () => openReelInsightsModal(btn.dataset.id));
    });

    grid.querySelectorAll('.generate-ideas-reel-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const reelId = btn.dataset.id;
        const targetReel = reels.find(r => String(r.id) === String(reelId));
        if (targetReel) {
          window.selectedReelForIdeas = targetReel;
          // Switch to Content Ideas tab
          const ideasTab = document.querySelector('.studio-tab[data-panel="ideas"]');
          if (ideasTab) ideasTab.click();
        }
      });
    });
  }

  // ── Single Reel Detailed Insights Modal ────────────────────────────────────
  async function openReelInsightsModal(mediaId) {
    const modal = document.getElementById('reelInsightsModal');
    const content = document.getElementById('reelInsightsModalContent');
    if (!modal || !content) return;

    modal.classList.add('show');
    content.innerHTML = '<div style="text-align:center;padding:30px;"><div class="spinner" style="margin:0 auto 10px;"></div><div>Fetching full Meta Graph API insights…</div></div>';

    try {
      const url = `/api/creator/reels/${encodeURIComponent(mediaId)}/insights?instagram_user_id=${encodeURIComponent(activeInstagramAccount.id)}`;
      const res = await fetch(url, { headers: window.getAuthHeaders ? window.getAuthHeaders() : {} });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const m = data.metrics || {};
      const c = data.calculations || {};

      content.innerHTML = `
        <div style="font-size:0.86rem;color:#e2e8f0;margin-bottom:16px;line-height:1.5;">
          ${data.media?.caption ? `"${data.media.caption}"` : 'Reel ID: ' + mediaId}
        </div>

        <div style="font-size:0.78rem;font-weight:600;color:rgba(255,255,255,0.4);text-transform:uppercase;margin-bottom:8px;">Metric Verification Breakdown</div>
        <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:12px;margin-bottom:16px;">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <div class="metric-pill"><span>Reach</span> ${m.reach?.value !== null ? `<strong>${m.reach.value.toLocaleString()}</strong> <span class="metric-status-tag status-retrieved">Meta API</span>` : `<span class="metric-status-tag status-unavailable">Unavailable</span>`}</div>
            <div class="metric-pill"><span>Views/Plays</span> ${m.views?.value !== null ? `<strong>${m.views.value.toLocaleString()}</strong> <span class="metric-status-tag status-retrieved">Meta API</span>` : `<span class="metric-status-tag status-unavailable">Unavailable</span>`}</div>
            <div class="metric-pill"><span>Likes</span> ${m.likes?.value !== null ? `<strong>${m.likes.value.toLocaleString()}</strong> <span class="metric-status-tag status-retrieved">Meta API</span>` : `<span class="metric-status-tag status-unavailable">Unavailable</span>`}</div>
            <div class="metric-pill"><span>Comments</span> ${m.comments?.value !== null ? `<strong>${m.comments.value.toLocaleString()}</strong> <span class="metric-status-tag status-retrieved">Meta API</span>` : `<span class="metric-status-tag status-unavailable">Unavailable</span>`}</div>
            <div class="metric-pill"><span>Shares</span> ${m.shares?.value !== null ? `<strong>${m.shares.value.toLocaleString()}</strong> <span class="metric-status-tag status-retrieved">Meta API</span>` : `<span class="metric-status-tag status-unavailable">Unavailable</span>`}</div>
            <div class="metric-pill"><span>Saves</span> ${m.saved?.value !== null ? `<strong>${m.saved.value.toLocaleString()}</strong> <span class="metric-status-tag status-retrieved">Meta API</span>` : `<span class="metric-status-tag status-unavailable">Unavailable</span>`}</div>
          </div>
        </div>

        <div style="font-size:0.78rem;font-weight:600;color:rgba(255,255,255,0.4);text-transform:uppercase;margin-bottom:8px;">Engagement Formulas</div>
        <div style="display:flex;flex-direction:column;gap:10px;">
          <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:12px;">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <span style="font-size:0.84rem;font-weight:600;color:#f1f5f9;">Engagement by Reach</span>
              <strong style="font-size:1.1rem;color:#10b981;">${c.byReach?.available ? `${c.byReach.rate}%` : '—'}</strong>
            </div>
            <div style="font-family:monospace;font-size:0.75rem;color:#818cf8;margin:4px 0;">${c.byReach?.formula || '(Interactions / Reach) × 100'}</div>
            <div style="font-size:0.75rem;color:rgba(255,255,255,0.4);">${c.byReach?.explanation || c.byReach?.reason || ''}</div>
          </div>

          <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:12px;">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <span style="font-size:0.84rem;font-weight:600;color:#f1f5f9;">Engagement by Views</span>
              <strong style="font-size:1.1rem;color:#818cf8;">${c.byViews?.available ? `${c.byViews.rate}%` : '—'}</strong>
            </div>
            <div style="font-family:monospace;font-size:0.75rem;color:#818cf8;margin:4px 0;">${c.byViews?.formula || '(Interactions / Views) × 100'}</div>
            <div style="font-size:0.75rem;color:rgba(255,255,255,0.4);">${c.byViews?.explanation || c.byViews?.reason || ''}</div>
          </div>

          <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:12px;">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <span style="font-size:0.84rem;font-weight:600;color:#f1f5f9;">Engagement by Followers</span>
              <strong style="font-size:1.1rem;color:#f59e0b;">${c.byFollowers?.available ? `${c.byFollowers.rate}%` : '—'}</strong>
            </div>
            <div style="font-family:monospace;font-size:0.75rem;color:#818cf8;margin:4px 0;">${c.byFollowers?.formula || '(Interactions / Followers) × 100'}</div>
            <div style="font-size:0.75rem;color:rgba(255,255,255,0.4);">${c.byFollowers?.explanation || c.byFollowers?.reason || ''}</div>
          </div>
        </div>
      `;
    } catch (err) {
      content.innerHTML = `<div style="color:#f43f5e;padding:20px;text-align:center;">❌ Failed to load detailed insights: ${err.message}</div>`;
    }
  }

  document.getElementById('closeReelInsightsModalBtn')?.addEventListener('click', () => {
    document.getElementById('reelInsightsModal')?.classList.remove('show');
  });

  document.getElementById('reelInsightsModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'reelInsightsModal') {
      document.getElementById('reelInsightsModal').classList.remove('show');
    }
  });

  // ── Manual Fallback Calculator ─────────────────────────────────────────────
  document.getElementById('toggleManualFallbackBtn')?.addEventListener('click', () => {
    const card = document.getElementById('manualFallbackCard');
    if (card) {
      card.style.display = card.style.display === 'none' ? 'block' : 'none';
      if (card.style.display === 'block') card.scrollIntoView({ behavior: 'smooth' });
    }
  });

  document.getElementById('closeManualFallbackBtn')?.addEventListener('click', () => {
    const card = document.getElementById('manualFallbackCard');
    if (card) card.style.display = 'none';
  });

  document.getElementById('calculateManualBtn')?.addEventListener('click', async () => {
    const caption = document.getElementById('manualCaption')?.value.trim();
    const followers = parseFloat(document.getElementById('manualFollowers')?.value) || null;
    const reach = parseFloat(document.getElementById('manualReach')?.value) || null;
    const views = parseFloat(document.getElementById('manualViews')?.value) || null;
    const likes = parseFloat(document.getElementById('manualLikes')?.value) || null;
    const comments = parseFloat(document.getElementById('manualComments')?.value) || null;
    const shares = parseFloat(document.getElementById('manualShares')?.value) || null;
    const saved = parseFloat(document.getElementById('manualSaves')?.value) || null;

    if (likes === null && comments === null) {
      alert('Please enter at least Likes or Comments to calculate performance.');
      return;
    }

    const payload = { caption, followers, reach, views, likes, comments, shares, saved };
    const resBox = document.getElementById('manualResultBox');
    if (resBox) {
      resBox.style.display = 'block';
      resBox.innerHTML = '<div class="spinner" style="margin:10px auto;"></div>';
    }

    try {
      const res = await fetch('/api/creator/reels/analyze-manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(window.getAuthHeaders ? window.getAuthHeaders() : {}) },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Calculation failed');

      const c = data.calculations || {};
      resBox.innerHTML = `
        <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(245,158,11,0.3);border-radius:12px;padding:16px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
            <div style="font-size:0.92rem;font-weight:700;color:#f1f5f9;">
              ${data.caption}
            </div>
            <span class="metric-status-tag status-manual">Manual Entry</span>
          </div>

          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;text-align:center;margin-bottom:14px;">
            <div style="background:rgba(0,0,0,0.25);border-radius:8px;padding:10px;">
              <div style="font-size:0.75rem;color:rgba(255,255,255,0.4);">By Reach</div>
              <div style="font-size:1.3rem;font-weight:700;color:#10b981;">${c.byReach?.available ? `${c.byReach.rate}%` : '—'}</div>
              <div style="font-size:0.68rem;color:rgba(255,255,255,0.3);">(Interactions / Reach)</div>
            </div>
            <div style="background:rgba(0,0,0,0.25);border-radius:8px;padding:10px;">
              <div style="font-size:0.75rem;color:rgba(255,255,255,0.4);">By Views</div>
              <div style="font-size:1.3rem;font-weight:700;color:#818cf8;">${c.byViews?.available ? `${c.byViews.rate}%` : '—'}</div>
              <div style="font-size:0.68rem;color:rgba(255,255,255,0.3);">(Interactions / Views)</div>
            </div>
            <div style="background:rgba(0,0,0,0.25);border-radius:8px;padding:10px;">
              <div style="font-size:0.75rem;color:rgba(255,255,255,0.4);">By Followers</div>
              <div style="font-size:1.3rem;font-weight:700;color:#f59e0b;">${c.byFollowers?.available ? `${c.byFollowers.rate}%` : '—'}</div>
              <div style="font-size:0.68rem;color:rgba(255,255,255,0.3);">(Interactions / Followers)</div>
            </div>
          </div>

          <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:rgba(99,102,241,0.08);border-radius:8px;">
            <div>
              <div style="font-size:0.75rem;color:rgba(255,255,255,0.4);">Performance Score</div>
              <div style="font-size:1.1rem;font-weight:700;color:#818cf8;">${data.performanceScore || 50} / 100</div>
            </div>
            <div style="text-align:right;">
              <div style="font-size:0.75rem;color:rgba(255,255,255,0.4);">Benchmark Comparison</div>
              <div style="font-size:0.82rem;font-weight:600;color:#f1f5f9;">${data.scoreExplanation}</div>
            </div>
          </div>
        </div>
      `;
    } catch (err) {
      resBox.innerHTML = `<div style="color:#f43f5e;font-size:0.84rem;">❌ ${err.message}</div>`;
    }
  });

  // ── Formula Selector & Explainer Update ────────────────────────────────────
  document.getElementById('formulaSelector')?.addEventListener('change', (e) => {
    const val = e.target.value;
    const txt = document.getElementById('formulaExplainerText');
    if (txt) {
      if (val === 'reach') txt.innerHTML = '<strong>Active Formula: Engagement by Reach</strong> = (Total Interactions ÷ Reach) × 100. Measures the percentage of unique accounts reached that took an action.';
      else if (val === 'views') txt.innerHTML = '<strong>Active Formula: Engagement by Views</strong> = (Total Interactions ÷ Views) × 100. Measures the interaction density generated per video view/play.';
      else if (val === 'followers') txt.innerHTML = '<strong>Active Formula: Engagement by Followers</strong> = (Total Interactions ÷ Followers) × 100. Measures engagement relative to your total follower base.';
    }
    loadReelPerformance(false);
  });

  document.getElementById('sortSelector')?.addEventListener('change', () => {
    if (currentReelsData) renderReelsPerformance(currentReelsData);
  });

  document.getElementById('refreshReelsBtn')?.addEventListener('click', () => {
    const icon = document.getElementById('refreshReelsIcon');
    if (icon) icon.style.transform = 'rotate(360deg)';
    loadReelPerformance(true).finally(() => {
      setTimeout(() => { if (icon) icon.style.transform = ''; }, 600);
    });
  });

  // Global account changed event listener
  window.addEventListener('comment2dm:accountChanged', (e) => {
    activeInstagramAccount = e.detail?.account || null;
    updateActiveAccountUI();
    loadReelPerformance(true);
  });

  // ===========================================================================
  // EXISTING TOOLS: HOOKS, DM SCRIPT, UTM BUILDER, IDEAS (PRESERVED)
  // ===========================================================================

  // ── Hook count slider ──────────────────────────────────────────────────────
  const hookCountEl = document.getElementById('hookCount');
  const hookCountVal = document.getElementById('hookCountVal');
  hookCountEl?.addEventListener('input', () => { if (hookCountVal) hookCountVal.textContent = hookCountEl.value; });

  // ── DM CTA custom ─────────────────────────────────────────────────────────
  document.getElementById('dmCta')?.addEventListener('change', (e) => {
    const row = document.getElementById('customCtaRow');
    if (row) row.style.display = e.target.value === 'Custom' ? 'block' : 'none';
  });

  // ── Hook Generator ─────────────────────────────────────────────────────────
  const hooksBtn = document.getElementById('generateHooksBtn');
  if (hooksBtn) hooksBtn.dataset.origText = '✨ Generate Hooks';

  document.getElementById('generateHooksBtn')?.addEventListener('click', async () => {
    const topic = document.getElementById('hookTopic')?.value.trim();
    const audience = document.getElementById('hookAudience')?.value.trim();
    const tone = document.getElementById('hookTone')?.value;
    const count = parseInt(document.getElementById('hookCount')?.value || '3');
    if (!topic) { alert('Please enter a topic.'); return; }

    const btn = document.getElementById('generateHooksBtn');
    setLoading(btn, true);
    const resultEl = document.getElementById('hooksResult');
    if (resultEl) resultEl.innerHTML = '';

    try {
      const result = await callAI({ type: 'hooks', topic, audience, tone, count });
      const hooks = Array.isArray(result) ? result : String(result).split('\n').filter(h => h.trim());
      if (resultEl) {
        resultEl.innerHTML = hooks.map((hook, i) => `
          <div class="result-card">
            <span style="font-size:0.72rem;color:rgba(255,255,255,0.25);text-transform:uppercase;letter-spacing:0.05em;">Hook ${i + 1}</span>
            <div class="result-text" style="margin-top:4px;">${hook.replace(/^\d+\.\s*/, '')}</div>
            <button class="copy-btn" onclick="navigator.clipboard.writeText(this.closest('.result-card').querySelector('.result-text').textContent).then(()=>{this.textContent='✓ Copied!';setTimeout(()=>this.textContent='📋 Copy',2000)})">📋 Copy</button>
          </div>
        `).join('');
      }
    } catch (err) {
      if (resultEl) resultEl.innerHTML = `<div style="color:#f43f5e;font-size:0.86rem;padding:12px;">❌ ${err.message}</div>`;
    } finally {
      setLoading(btn, false, '✨ Generate Hooks');
    }
  });

  // ── DM Script Writer ───────────────────────────────────────────────────────
  const dmBtn = document.getElementById('generateDmBtn');
  if (dmBtn) dmBtn.dataset.origText = '✨ Generate DM Script';

  document.getElementById('generateDmBtn')?.addEventListener('click', async () => {
    const product = document.getElementById('dmProduct')?.value.trim();
    const ctaSelect = document.getElementById('dmCta')?.value;
    const cta = ctaSelect === 'Custom' ? (document.getElementById('customCta')?.value.trim() || ctaSelect) : ctaSelect;
    const tone = document.getElementById('dmTone')?.value;
    if (!product) { alert('Please enter a product/service name.'); return; }

    const btn = document.getElementById('generateDmBtn');
    setLoading(btn, true);
    const resultEl = document.getElementById('dmScriptResult');
    if (resultEl) resultEl.innerHTML = '';

    try {
      const result = await callAI({ type: 'dm_script', product, cta, tone });
      const script = Array.isArray(result) ? result.join('\n') : String(result);
      if (resultEl) {
        resultEl.innerHTML = `<div class="result-card">
          <div class="result-text">${script}</div>
          <button class="copy-btn" onclick="navigator.clipboard.writeText(this.closest('.result-card').querySelector('.result-text').textContent).then(()=>{this.textContent='✓ Copied!';setTimeout(()=>this.textContent='📋 Copy',2000)})">📋 Copy</button>
        </div>
        <button onclick="window.location.href='automations.html?dm=${encodeURIComponent(script)}'" style="margin-top:10px;padding:9px 16px;background:rgba(16,185,129,0.12);border:1px solid rgba(16,185,129,0.25);border-radius:10px;color:#10b981;font-size:0.84rem;font-weight:600;cursor:pointer;">⚡ Apply to Automation</button>`;
      }
    } catch (err) {
      if (resultEl) resultEl.innerHTML = `<div style="color:#f43f5e;font-size:0.86rem;padding:12px;">❌ ${err.message}</div>`;
    } finally {
      setLoading(btn, false, '✨ Generate DM Script');
    }
  });

  // ── UTM Builder ────────────────────────────────────────────────────────────
  let utmHistory = JSON.parse(localStorage.getItem('c2dm_utm_history') || '[]');

  function renderUtmHistory() {
    const list = document.getElementById('utmHistoryList');
    const historyEl = document.getElementById('utmHistory');
    if (!list || !historyEl) return;
    if (!utmHistory.length) { historyEl.style.display = 'none'; return; }
    historyEl.style.display = 'block';
    list.innerHTML = utmHistory.slice(-5).reverse().map(url => `
      <div class="utm-history-item">
        <span style="font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:80%;">${url}</span>
        <button onclick="navigator.clipboard.writeText('${url.replace(/'/g, "\\'")}').then(()=>{})" style="background:none;border:none;color:#818cf8;cursor:pointer;font-size:0.75rem;flex-shrink:0;">📋</button>
      </div>`).join('');
  }

  document.getElementById('buildUtmBtn')?.addEventListener('click', () => {
    const base = document.getElementById('utmUrl')?.value.trim();
    const campaign = document.getElementById('utmCampaign')?.value.trim().replace(/\s+/g, '-').toLowerCase();
    const medium = document.getElementById('utmMedium')?.value;
    const source = document.getElementById('utmSource')?.value;

    if (!base) { alert('Please enter a base URL.'); return; }

    try {
      const parsed = new URL(base);
      parsed.searchParams.set('utm_source', source);
      parsed.searchParams.set('utm_medium', medium);
      parsed.searchParams.set('utm_campaign', campaign || 'comment2dm');
      const fullUrl = parsed.toString();

      const output = document.getElementById('utmResult');
      const outputWrap = document.getElementById('utmOutput');
      if (output) output.textContent = fullUrl;
      if (outputWrap) outputWrap.style.display = 'block';

      document.getElementById('copyUtmBtn')?.addEventListener('click', () => {
        navigator.clipboard.writeText(fullUrl);
        document.getElementById('copyUtmBtn').textContent = '✓ Copied!';
        setTimeout(() => { const b = document.getElementById('copyUtmBtn'); if (b) b.textContent = '📋 Copy'; }, 2000);
      }, { once: true });

      utmHistory = [...utmHistory.filter(u => u !== fullUrl), fullUrl].slice(-5);
      localStorage.setItem('c2dm_utm_history', JSON.stringify(utmHistory));
      renderUtmHistory();
    } catch {
      alert('Please enter a valid URL (including https://).');
    }
  });

  // ── Content Ideas ──────────────────────────────────────────────────────────
  const ideasBtn = document.getElementById('generateIdeasBtn');
  if (ideasBtn) ideasBtn.dataset.origText = '💡 Generate 7 Ideas';

  document.getElementById('generateIdeasBtn')?.addEventListener('click', async () => {
    const niche = document.getElementById('ideasNiche')?.value.trim();
    const week = document.getElementById('ideasWeek')?.value.trim() || 'This Week';
    if (!niche) { alert('Please enter your niche.'); return; }

    const btn = document.getElementById('generateIdeasBtn');
    setLoading(btn, true);
    const resultEl = document.getElementById('ideasResult');
    if (resultEl) resultEl.innerHTML = '';

    try {
      const result = await callAI({ type: 'ideas', niche, week });
      const ideas = Array.isArray(result) ? result : [];
      const formats = ['reel', 'carousel', 'story', 'static', 'reel', 'carousel', 'reel'];
      const fmtLabels = { reel:'🎬 Reel', carousel:'🎠 Carousel', story:'📱 Story', static:'🖼️ Static' };
      const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
      if (resultEl) {
        resultEl.innerHTML = ideas.map((idea, i) => {
          const fmt = formats[i] || 'reel';
          const ideaText = typeof idea === 'object' ? (idea.title || String(idea)) : String(idea);
          const hook = typeof idea === 'object' ? (idea.hook || '') : '';
          return `<div class="idea-card">
            <div class="idea-format ${fmt}">${fmtLabels[fmt]}</div>
            <div class="idea-title">${ideaText.replace(/^\d+\.\s*/, '')}</div>
            ${hook ? `<div class="idea-hook">"${hook}"</div>` : ''}
            <div class="idea-meta">📅 Best day: ${days[i]} · <a href="#" onclick="navigator.clipboard.writeText(this.closest('.idea-card').querySelector('.idea-title').textContent);return false;" style="color:#818cf8;font-size:0.72rem;">📋 Copy idea</a></div>
          </div>`;
        }).join('');
        if (!ideas.length) resultEl.innerHTML = `<div style="color:rgba(255,255,255,0.3);padding:20px;grid-column:1/-1;">No ideas returned. Try again.</div>`;
      }
    } catch (err) {
      if (resultEl) resultEl.innerHTML = `<div style="color:#f43f5e;font-size:0.86rem;padding:12px;grid-column:1/-1;">❌ ${err.message}</div>`;
    } finally {
      setLoading(btn, false, '💡 Generate 7 Ideas');
    }
  });

  // ── Init ──────────────────────────────────────────────────────────────────
  async function init() {
    await loadCredits();
    renderUtmHistory();
    await resolveActiveAccount();
    updateActiveAccountUI();
    loadReelPerformance(false);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
