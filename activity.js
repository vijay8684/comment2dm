// activity.js — Comment2DM Unified Activity & Analytics Controller
(function () {
  'use strict';

  let currentDays = '7';
  let currentPage = 1;
  let totalPages = 1;
  let currentStatus = 'all';
  let currentSearch = '';
  let selectedAccountId = localStorage.getItem('comment2dm_selected_account_id') || '';
  let currentAccountUsername = '';
  let searchDebounceTimer = null;
  let refreshTimer = null;

  // ── Helper Utilities ──────────────────────────────────────────────────────
  function fmt(n) {
    if (n === undefined || n === null) return '0';
    const num = Number(n);
    if (isNaN(num)) return '0';
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
    return num.toLocaleString();
  }

  function pct(a, b) {
    const numA = Number(a) || 0;
    const numB = Number(b) || 0;
    if (numB <= 0) return numA > 0 ? '100%' : '0%';
    return Math.round((numA / numB) * 100) + '%';
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function relativeTime(dateStr) {
    if (!dateStr) return '–';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '–';
    const diff = Math.floor((Date.now() - d.getTime()) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function formatFullTime(dateStr) {
    if (!dateStr) return '–';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return String(dateStr);
    return d.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  function initials(name) {
    if (!name) return '?';
    return name.replace(/^@+/, '').split(/[\s_.]/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  }

  // ── 1. Fetch & Render Analytics Overview ──────────────────────────────────
  async function loadAnalyticsOverview() {
    const params = new URLSearchParams({ days: String(currentDays) });
    if (selectedAccountId) params.set('instagram_user_id', selectedAccountId);

    try {
      const res = await fetch(`/api/analytics/overview?${params.toString()}`, {
        headers: window.getAuthHeaders ? window.getAuthHeaders() : {},
        credentials: 'same-origin'
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json().catch(() => ({}));

      const sent = Number(data.dmsSent ?? data.messagesSent ?? 0);
      const failed = Number(data.failed ?? data.messagesFailed ?? 0);
      const totalDMs = sent + failed;
      const comments = Number(data.commentsProcessed ?? data.comments ?? 0);
      const activeAutos = Number(data.activeAutomations ?? 0);
      const deliveryRate = totalDMs > 0 ? (data.deliveryRate ?? Math.round((sent / totalDMs) * 100)) : 100;

      // Update KPI Cards
      const kpiSentEl = document.getElementById('kpiDmsSent');
      const kpiSuccessEl = document.getElementById('kpiSuccessDeliveries');
      const kpiDeliveryRateEl = document.getElementById('kpiDeliveryRate');
      const kpiFailedEl = document.getElementById('kpiFailedDeliveries');
      const kpiFailedSubEl = document.getElementById('kpiFailedSubtext');
      const kpiAutosEl = document.getElementById('kpiActiveAutomations');

      if (kpiSentEl) kpiSentEl.textContent = fmt(sent);
      if (kpiSuccessEl) kpiSuccessEl.textContent = fmt(sent);
      if (kpiDeliveryRateEl) kpiDeliveryRateEl.textContent = `${deliveryRate}% Delivery Rate`;
      if (kpiFailedEl) kpiFailedEl.textContent = fmt(failed);
      if (kpiFailedSubEl) {
        kpiFailedSubEl.innerHTML = failed > 0
          ? `<span style="color:var(--rose); font-weight:600;">⚠️ ${failed} failed attempts</span>`
          : `<span style="color:var(--emerald);">✓ 0 delivery issues</span>`;
      }
      if (kpiAutosEl) kpiAutosEl.textContent = fmt(activeAutos);

      // Update Conversion Funnel
      const funnelCommentsEl = document.getElementById('funnelComments');
      const funnelTriggeredEl = document.getElementById('funnelTriggered');
      const funnelDeliveredEl = document.getElementById('funnelDelivered');
      const funnelTriggerPctEl = document.getElementById('funnelTriggerPct');
      const funnelDeliverPctEl = document.getElementById('funnelDeliverPct');

      if (funnelCommentsEl) funnelCommentsEl.textContent = fmt(comments);
      if (funnelTriggeredEl) funnelTriggeredEl.textContent = fmt(totalDMs);
      if (funnelDeliveredEl) funnelDeliveredEl.textContent = fmt(sent);
      if (funnelTriggerPctEl) funnelTriggerPctEl.textContent = `${pct(totalDMs, comments)} Conversion`;
      if (funnelDeliverPctEl) funnelDeliverPctEl.textContent = `${deliveryRate}% Delivery`;

      // Render Bar Chart
      renderDailyChart(data.dailyDms || []);

    } catch (err) {
      console.error('Failed to load activity overview:', err);
    }
  }

  // ── 2. Render Daily Trend Chart ───────────────────────────────────────────
  function renderDailyChart(dailyDms) {
    const container = document.getElementById('dailyChartContainer');
    if (!container) return;

    let bars = Array.isArray(dailyDms) ? [...dailyDms] : [];

    if (bars.length === 0) {
      const numDays = currentDays === '7' ? 7 : currentDays === '30' ? 14 : currentDays === '90' ? 20 : 10;
      bars = Array.from({ length: numDays }, (_, i) => {
        const d = new Date();
        d.setDate(d.getDate() - (numDays - 1 - i));
        return { date: d.toISOString().slice(5, 10), count: 0 };
      });
    }

    if (currentDays === '7' && bars.length > 7) bars = bars.slice(-7);
    if (currentDays === '30' && bars.length > 30) bars = bars.slice(-30);
    if (currentDays === '90' && bars.length > 90) bars = bars.slice(-90);

    const maxVal = Math.max(...bars.map(b => Number(b.count || b.messagesSent || 0)), 1);

    container.innerHTML = bars.map(b => {
      const count = Number(b.count || b.messagesSent || 0);
      const height = Math.max(4, Math.round((count / maxVal) * 140));
      const shortDate = (b.date || '').slice(5) || (b.date || '');

      return `
        <div class="activity-chart-bar-wrap" title="${escapeHtml(b.date)}: ${count} DMs">
          <div class="activity-chart-bar" style="height:${height}px;"></div>
          <span class="activity-chart-label">${escapeHtml(shortDate)}</span>
        </div>
      `;
    }).join('');
  }

  // ── 3. Fetch & Render DM Event Log ────────────────────────────────────────
  async function loadEventLog() {
    const tbody = document.getElementById('activityTableBody');
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:30px; color:var(--ink-secondary);">Loading activity events...</td></tr>`;
    }

    const params = new URLSearchParams({
      page: String(currentPage),
      limit: '20',
      status: currentStatus,
      days: String(currentDays),
      search: currentSearch
    });
    if (selectedAccountId) params.set('instagram_user_id', selectedAccountId);

    try {
      const res = await fetch(`/api/analytics/events?${params.toString()}`, {
        headers: window.getAuthHeaders ? window.getAuthHeaders() : {},
        credentials: 'same-origin'
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json().catch(() => ({}));

      totalPages = data.pages || 1;
      const events = data.events || [];
      const totalCount = data.total ?? 0;

      // Update Summary & Pagination
      const countSummaryEl = document.getElementById('logCountSummary');
      if (countSummaryEl) countSummaryEl.textContent = `${totalCount} total events`;

      const pageInfoEl = document.getElementById('paginationInfo');
      if (pageInfoEl) pageInfoEl.textContent = `Page ${currentPage} of ${totalPages} (${totalCount} events)`;

      const prevBtn = document.getElementById('prevPageBtn');
      const nextBtn = document.getElementById('nextPageBtn');
      if (prevBtn) prevBtn.disabled = currentPage <= 1;
      if (nextBtn) nextBtn.disabled = currentPage >= totalPages;

      if (!tbody) return;

      if (events.length === 0) {
        tbody.innerHTML = `
          <tr>
            <td colspan="7">
              <div style="text-align:center; padding:48px 20px; color:var(--ink-secondary);">
                <div style="font-size:2.4rem; margin-bottom:10px;">💌</div>
                <h4 style="color:var(--ink); font-size:1rem; margin:0 0 6px;">No Activity Events Found</h4>
                <p style="font-size:0.84rem; max-width:400px; margin:0 auto 16px;">
                  ${currentSearch ? `No events match "${escapeHtml(currentSearch)}".` : 'Automated DMs sent in response to Reel comments will appear here in real time.'}
                </p>
                <a href="automations.html" class="btn btn-primary btn-sm">Configure Automations →</a>
              </div>
            </td>
          </tr>
        `;
        return;
      }

      tbody.innerHTML = '';
      events.forEach((ev, idx) => {
        const rawHandle = ev.senderName || ev.username || 'Commenter';
        const handle = String(rawHandle).replace(/^@+/, '');
        const isSent = ev.status === 'sent' || ev.status === 'success';
        const isFailed = ev.status === 'failed';
        const statusClass = isSent ? 'emerald' : (isFailed ? 'rose' : 'amber');
        const statusLabel = isSent ? '✓ Delivered' : (isFailed ? '✗ Failed' : '⏳ Processing');
        const statusColor = isSent ? 'var(--emerald)' : (isFailed ? 'var(--rose)' : 'var(--amber)');
        const commentMsg = ev.commentText || ev.comment_text || '–';
        const dmMsg = ev.dmText || ev.dmPreview || '–';
        const autoName = ev.automationName || (ev.keyword ? `Keyword: ${ev.keyword}` : 'Comment to DM');
        const timeShort = relativeTime(ev.createdAt || ev.created_at || ev.timestamp);

        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td style="padding-left:18px;">
            <div style="display:flex; align-items:center; gap:10px;">
              <div style="width:32px; height:32px; border-radius:50%; background:linear-gradient(135deg,var(--accent),#ec4899); display:flex; align-items:center; justify-content:center; color:#fff; font-weight:700; font-size:0.75rem; flex-shrink:0;">
                ${escapeHtml(initials(handle))}
              </div>
              <span style="font-weight:600; color:var(--ink);">@${escapeHtml(handle)}</span>
            </div>
          </td>
          <td>
            <div style="max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--ink-secondary); font-size:0.83rem;" title="${escapeHtml(commentMsg)}">
              💬 "${escapeHtml(commentMsg)}"
            </div>
          </td>
          <td>
            <div style="max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--ink); font-size:0.83rem;" title="${escapeHtml(dmMsg)}">
              ${escapeHtml(dmMsg)}
            </div>
          </td>
          <td>
            <span class="automation-pill" style="font-size:0.75rem;">
              ⚡ ${escapeHtml(autoName)}
            </span>
          </td>
          <td>
            <span style="color:${statusColor}; font-weight:600; font-size:0.82rem; display:inline-flex; align-items:center; gap:6px;">
              <span style="width:7px; height:7px; border-radius:50%; background:${statusColor};"></span>
              ${statusLabel}
            </span>
          </td>
          <td style="color:var(--ink-secondary); font-size:0.82rem; white-space:nowrap;">
            ${timeShort}
          </td>
          <td style="text-align:right; padding-right:18px;">
            <button class="btn btn-secondary btn-sm view-detail-btn" data-index="${idx}" type="button" style="padding:4px 10px; font-size:0.78rem;">
              View Details
            </button>
          </td>
        `;

        // Detail Modal trigger
        tr.querySelector('.view-detail-btn').addEventListener('click', () => {
          openDetailModal(ev);
        });

        tbody.appendChild(tr);
      });

    } catch (err) {
      console.error('Failed to load event log:', err);
      if (tbody) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:30px; color:var(--rose);">Error loading events. Please refresh.</td></tr>`;
      }
    }
  }

  // ── 4. Event Detail Modal ─────────────────────────────────────────────────
  function openDetailModal(ev) {
    const modal = document.getElementById('eventDetailModal');
    if (!modal) return;

    const rawHandle = ev.senderName || ev.username || 'Commenter';
    const handle = String(rawHandle).replace(/^@+/, '');

    const avatarEl = document.getElementById('modalAvatar');
    const userEl = document.getElementById('modalUsername');
    const timeEl = document.getElementById('modalTime');
    const commentEl = document.getElementById('modalCommentText');
    const dmEl = document.getElementById('modalDmText');
    const btnWrapEl = document.getElementById('modalBtnWrap');
    const btnTitleEl = document.getElementById('modalBtnTitle');
    const statusBadgeEl = document.getElementById('modalStatusBadge');
    const autoNameEl = document.getElementById('modalAutoName');
    const errorWrapEl = document.getElementById('modalErrorWrap');
    const errorTextEl = document.getElementById('modalErrorText');

    if (avatarEl) avatarEl.textContent = initials(handle);
    if (userEl) userEl.textContent = '@' + handle;
    if (timeEl) timeEl.textContent = formatFullTime(ev.createdAt || ev.created_at || ev.timestamp);
    if (commentEl) commentEl.textContent = ev.commentText || ev.comment_text || '–';
    if (dmEl) dmEl.textContent = ev.dmText || ev.dmPreview || '–';

    if (ev.buttonText) {
      if (btnWrapEl) btnWrapEl.style.display = 'block';
      if (btnTitleEl) btnTitleEl.textContent = ev.buttonText;
    } else if (btnWrapEl) {
      btnWrapEl.style.display = 'none';
    }

    const isSent = ev.status === 'sent' || ev.status === 'success';
    const isFailed = ev.status === 'failed';
    if (statusBadgeEl) {
      statusBadgeEl.textContent = isSent ? '✓ Successfully Delivered' : (isFailed ? '✗ Delivery Failed' : '⏳ Processing');
      statusBadgeEl.style.color = isSent ? 'var(--emerald)' : (isFailed ? 'var(--rose)' : 'var(--amber)');
    }

    if (autoNameEl) autoNameEl.textContent = ev.automationName || 'Comment to DM';

    if (ev.errorMessage) {
      if (errorWrapEl) errorWrapEl.style.display = 'block';
      if (errorTextEl) errorTextEl.textContent = ev.errorMessage;
    } else if (errorWrapEl) {
      errorWrapEl.style.display = 'none';
    }

    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
  }

  function closeDetailModal() {
    const modal = document.getElementById('eventDetailModal');
    if (modal) {
      modal.classList.remove('show');
      modal.setAttribute('aria-hidden', 'true');
    }
  }

  // ── 5. Account Label Updates & Event Listeners ────────────────────────────
  function updateAccountLabel() {
    const labelEl = document.getElementById('activeAccountLabel');
    if (!labelEl) return;

    if (currentAccountUsername) {
      labelEl.textContent = `@${currentAccountUsername}`;
    } else {
      const cached = sessionStorage.getItem('comment2dm_cached_accounts');
      if (cached) {
        try {
          const list = JSON.parse(cached);
          const found = list.find(a => String(a.id) === String(selectedAccountId));
          if (found) {
            currentAccountUsername = found.username;
            labelEl.textContent = `@${found.username}`;
            return;
          }
        } catch (_) {}
      }
      labelEl.textContent = selectedAccountId ? `Account ${selectedAccountId}` : 'All Accounts';
    }
  }

  // ── 6. Master Reload Function ─────────────────────────────────────────────
  async function reloadAll() {
    updateAccountLabel();
    await Promise.allSettled([
      loadAnalyticsOverview(),
      loadEventLog()
    ]);
  }

  // ── 7. DOM Event Wire-Up ──────────────────────────────────────────────────
  function init() {
    updateAccountLabel();
    reloadAll();

    // Range Tabs
    const rangeTabs = document.getElementById('rangeTabs');
    if (rangeTabs) {
      rangeTabs.addEventListener('click', (e) => {
        const btn = e.target.closest('.activity-range-tab');
        if (!btn) return;
        rangeTabs.querySelectorAll('.activity-range-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentDays = btn.getAttribute('data-days') || '7';
        currentPage = 1;

        const chartRangeBadge = document.getElementById('chartRangeBadge');
        if (chartRangeBadge) {
          chartRangeBadge.textContent = btn.textContent;
        }

        reloadAll();
      });
    }

    // Refresh Button
    const refreshBtn = document.getElementById('refreshActivityBtn');
    const refreshIcon = document.getElementById('refreshIcon');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', async () => {
        if (refreshIcon) refreshIcon.style.transform = 'rotate(360deg)';
        await reloadAll();
        setTimeout(() => {
          if (refreshIcon) refreshIcon.style.transform = 'rotate(0deg)';
        }, 400);
      });
    }

    // Search Input with Debounce
    const searchInput = document.getElementById('eventSearchInput');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => {
          currentSearch = e.target.value.trim();
          currentPage = 1;
          loadEventLog();
        }, 300);
      });
    }

    // Status Filter
    const statusSelect = document.getElementById('eventStatusFilter');
    if (statusSelect) {
      statusSelect.addEventListener('change', (e) => {
        currentStatus = e.target.value;
        currentPage = 1;
        loadEventLog();
      });
    }

    // Pagination Buttons
    const prevBtn = document.getElementById('prevPageBtn');
    const nextBtn = document.getElementById('nextPageBtn');
    if (prevBtn) {
      prevBtn.addEventListener('click', () => {
        if (currentPage > 1) {
          currentPage--;
          loadEventLog();
        }
      });
    }
    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        if (currentPage < totalPages) {
          currentPage++;
          loadEventLog();
        }
      });
    }

    // Modal Close Listeners
    const closeDetailModalBtn = document.getElementById('closeDetailModalBtn');
    const dismissModalBtn = document.getElementById('dismissModalBtn');
    const detailModal = document.getElementById('eventDetailModal');

    if (closeDetailModalBtn) closeDetailModalBtn.addEventListener('click', closeDetailModal);
    if (dismissModalBtn) dismissModalBtn.addEventListener('click', closeDetailModal);

    if (detailModal) {
      detailModal.addEventListener('click', (e) => {
        if (e.target === detailModal) closeDetailModal();
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeDetailModal();
    });

    // Account Switcher Listener
    window.addEventListener('comment2dm:accountChanged', (e) => {
      const acct = e.detail;
      if (acct) {
        selectedAccountId = acct.id || '';
        currentAccountUsername = acct.username || '';
      } else {
        selectedAccountId = '';
        currentAccountUsername = '';
      }
      currentPage = 1;
      reloadAll();
    });

    // Auto-poll every 45 seconds
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (currentPage === 1 && !currentSearch) {
        reloadAll();
      }
    }, 45000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
