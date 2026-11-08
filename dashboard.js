// ============================================================
// Comment2DM — Dashboard & Application Shell Logic
// Theme Persistence, Connected Account State, Real-Time Stats
// ============================================================

(function () {
  const sidebar = document.getElementById('appSidebar');
  const sidebarToggleBtn = document.getElementById('sidebarToggleBtn');
  const collapseIcon = document.getElementById('collapseIcon');
  const mobileMenuToggle = document.getElementById('mobileMenuToggle');
  const userProfileBtn = document.getElementById('userProfileBtn');
  const userDropdownMenu = document.getElementById('userDropdownMenu');
  const logoutBtn = document.getElementById('headerLogoutBtn') || document.getElementById('logoutBtn');
  const themeToggleBtn = document.getElementById('themeToggleBtn');

  // Authorization helper
  window.getAuthHeaders = function (extraHeaders = {}) {
    const token = localStorage.getItem('comment2dm_token') || localStorage.getItem('nudge_token');
    const headers = { ...extraHeaders };
    if (token) {
      headers['Authorization'] = 'Bearer ' + token;
    }
    return headers;
  };

  // Instant Theme Synchronization across all shell pages
  const savedTheme = localStorage.getItem('comment2dm_theme') || 'light';
  document.documentElement.setAttribute('data-theme', savedTheme);

  // 1. Theme Synchronization & Toggle
  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', function () {
      const current = document.documentElement.getAttribute('data-theme') || 'light';
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('comment2dm_theme', next);
    });
  }

  // 2. Sidebar Collapsing Logic
  const savedCollapsed = localStorage.getItem('comment2dm_sidebar_collapsed') === 'true';
  if (savedCollapsed && sidebar) {
    sidebar.classList.add('collapsed');
    if (collapseIcon) collapseIcon.textContent = '»';
  }

  if (sidebarToggleBtn && sidebar) {
    sidebarToggleBtn.addEventListener('click', function () {
      sidebar.classList.toggle('collapsed');
      const isCollapsed = sidebar.classList.contains('collapsed');
      localStorage.setItem('comment2dm_sidebar_collapsed', isCollapsed);
      if (collapseIcon) collapseIcon.textContent = isCollapsed ? '»' : '«';
    });
  }

  // Mobile menu toggle
  if (mobileMenuToggle && sidebar) {
    mobileMenuToggle.addEventListener('click', function () {
      sidebar.classList.toggle('open');
    });
  }

  // 3. User Profile Dropdown Menu
  if (userProfileBtn && userDropdownMenu) {
    userProfileBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      userDropdownMenu.classList.toggle('show');
    });

    document.addEventListener('click', function (e) {
      if (!userDropdownMenu.contains(e.target) && e.target !== userProfileBtn) {
        userDropdownMenu.classList.remove('show');
      }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        userDropdownMenu.classList.remove('show');
      }
    });
  }

  // Auto-highlight active nav link & set tooltips
  const currentPath = window.location.pathname.split('/').pop() || 'dashboard.html';
  document.querySelectorAll('.app-nav a').forEach(link => {
    const href = link.getAttribute('href');
    if (href === currentPath || (currentPath === '' && href === 'dashboard.html')) {
      link.classList.add('active');
    } else {
      link.classList.remove('active');
    }
  });

  // 4. Logout Handler
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async function () {
      try {
        await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
      } catch (e) {}
      localStorage.removeItem('comment2dm_token');
      localStorage.removeItem('nudge_token');
      window.location.replace('login.html?tab=login');
    });
  }

  // 5. Load User Profile
  async function loadUser() {
    try {
      const response = await fetch('/api/me', {
        headers: window.getAuthHeaders(),
        credentials: 'same-origin'
      });
      if (response.status === 401) {
        localStorage.removeItem('comment2dm_token');
        window.location.replace('login.html?tab=login');
        return;
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.user) return;

      const user = data.user;
      const initial = (user.name || 'U').charAt(0).toUpperCase();

      const avatarEl = document.getElementById('userAvatarInitial');
      const nameEl = document.getElementById('topbarUserName');
      const welcomeEl = document.getElementById('welcomeGreeting');
      const dropName = document.getElementById('dropdownName');
      const dropEmail = document.getElementById('dropdownEmail');

      if (avatarEl) avatarEl.textContent = initial;
      if (nameEl) nameEl.textContent = user.name;
      if (welcomeEl) {
        const firstName = user.name ? user.name.split(' ')[0] : 'Creator';
        welcomeEl.textContent = `Hello, ${firstName} 👋`;
      }
      if (dropName) dropName.textContent = user.name;
      if (dropEmail) dropEmail.textContent = user.email;
    } catch (err) {
      console.error('Failed to load user:', err);
    }
  }

  // 6. Load Billing & Quota Limits
  async function loadBillingQuota() {
    try {
      const response = await fetch('/api/billing/status', {
        headers: window.getAuthHeaders(),
        credentials: 'same-origin'
      });
      if (!response.ok) return;
      const data = await response.json().catch(() => ({}));

      const plan = String(data.plan || 'free').toLowerCase();
      const planBadge = document.getElementById('topbarPlanBadge');
      if (planBadge) {
        planBadge.textContent = plan.toUpperCase();
        planBadge.className = 'plan-badge ' + plan;
      }

      const dmMax = data.limits?.dmMonthly || 300;
      const dmUsed = data.usage?.dmMonthly || 0;
      const pct = Math.min(100, Math.round((dmUsed / dmMax) * 100));

      const limitText = document.getElementById('dmLimitText');
      const progressFill = document.getElementById('dmProgressFill');
      const pieInner = document.getElementById('pieGaugeInner');
      const pieCircle = document.getElementById('pieGaugeCircle');
      const pieGaugeCollapsed = document.getElementById('pieGaugeCollapsed');

      if (limitText) limitText.textContent = `${dmUsed.toLocaleString()} / ${dmMax.toLocaleString()}`;
      if (progressFill) progressFill.style.width = `${Math.max(5, pct)}%`;
      if (pieInner) pieInner.textContent = `${pct}%`;
      if (pieCircle) {
        pieCircle.style.background = `conic-gradient(var(--accent) ${pct}%, rgba(118, 85, 217, 0.15) 0)`;
      }
      if (pieGaugeCollapsed) {
        pieGaugeCollapsed.title = `Monthly DMs: ${dmUsed} / ${dmMax} (${pct}%) — Click to Upgrade`;
      }
    } catch (e) {}
  }

  // 7. Load Connected Instagram Accounts (State-Driven)
  async function loadInstagramAccounts() {
    const loadingEl = document.getElementById('igLoadingState');
    const connectedEl = document.getElementById('igConnectedCard');
    const expiredEl = document.getElementById('igExpiredCard');
    const disconnectedEl = document.getElementById('igDisconnectedCard');
    const errorEl = document.getElementById('igErrorCard');
    const modal = document.getElementById('connectInstagramModal');

    const igUsername = document.getElementById('sidebarIgUsername');
    const igStatus = document.getElementById('sidebarIgStatus');
    const igAvatar = document.getElementById('sidebarIgAvatar');
    const switcherBtn = document.getElementById('accountSwitcherBtn');

    function setSectionState(state) {
      if (loadingEl) loadingEl.style.display = state === 'loading' ? 'flex' : 'none';
      if (connectedEl) connectedEl.style.display = state === 'connected' ? 'block' : 'none';
      if (expiredEl) expiredEl.style.display = state === 'expired' ? 'block' : 'none';
      if (disconnectedEl) disconnectedEl.style.display = state === 'disconnected' ? 'block' : 'none';
      if (errorEl) errorEl.style.display = state === 'error' ? 'block' : 'none';
    }

    // Set loading indicator
    setSectionState('loading');

    try {
      const response = await fetch('/api/instagram/accounts', {
        headers: window.getAuthHeaders(),
        credentials: 'same-origin'
      });

      if (response.status === 401) {
        localStorage.removeItem('comment2dm_token');
        window.location.replace('login.html?tab=login');
        return;
      }

      if (!response.ok) {
        setSectionState('error');
        const errRetryBtn = document.getElementById('igRetryBtn');
        if (errRetryBtn) errRetryBtn.onclick = () => loadInstagramAccounts();
        return;
      }

      const data = await response.json().catch(() => ({}));
      const accounts = data.accounts || [];

      if (accounts.length > 0) {
        const primary = accounts[0];
        const isExpired = primary.status === 'Token expired' || (primary.expiresAt && new Date(primary.expiresAt).getTime() <= Date.now());

        // Update Sidebar Account Switcher
        if (igUsername) igUsername.textContent = '@' + primary.username;
        if (igAvatar) igAvatar.textContent = primary.username.charAt(0).toUpperCase();
        if (igStatus) {
          igStatus.textContent = isExpired ? '⚠️ Expired' : '● Active';
          igStatus.style.color = isExpired ? 'var(--amber)' : 'var(--emerald)';
        }
        if (switcherBtn) {
          switcherBtn.onclick = () => window.location.href = 'instagram-accounts.html';
          switcherBtn.title = `Connected as @${primary.username} — Click to manage`;
        }

        if (isExpired) {
          // Token Expired State
          setSectionState('expired');
          const expiredUserEl = document.getElementById('igExpiredUsername');
          if (expiredUserEl) expiredUserEl.textContent = '@' + primary.username;
        } else {
          // Active Connected State (No large connect banner!)
          setSectionState('connected');
          const connectedUserEl = document.getElementById('igConnectedUsername');
          const connectedAvatarEl = document.getElementById('igConnectedAvatar');
          const connectedMetaEl = document.getElementById('igConnectedMeta');

          if (connectedUserEl) connectedUserEl.textContent = '@' + primary.username;
          if (connectedAvatarEl) connectedAvatarEl.textContent = primary.username.charAt(0).toUpperCase();
          if (connectedMetaEl && primary.connectedAt) {
            try {
              connectedMetaEl.textContent = `· Linked ${new Date(primary.connectedAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`;
            } catch (e) {}
          }
        }

        // IMPORTANT: NEVER show the connect modal when an account is active/connected
        if (modal) modal.classList.remove('show');

      } else {
        // Disconnected State (0 accounts)
        setSectionState('disconnected');

        if (igUsername) igUsername.textContent = 'No Account';
        if (igStatus) {
          igStatus.textContent = 'Connect now';
          igStatus.style.color = 'var(--ink-secondary)';
        }
        if (switcherBtn) {
          switcherBtn.onclick = () => {
            if (modal) modal.classList.add('show');
            else window.location.href = 'instagram-accounts.html';
          };
          switcherBtn.title = 'No account connected — Click to connect';
        }

        // Show modal only if user hasn't dismissed it this session
        const dismissed = sessionStorage.getItem('comment2dm_ig_modal_dismissed');
        if (!dismissed && modal) {
          modal.classList.add('show');
        }
      }
    } catch (err) {
      console.error('Failed to load Instagram accounts:', err);
      setSectionState('error');
      const errRetryBtn = document.getElementById('igRetryBtn');
      if (errRetryBtn) errRetryBtn.onclick = () => loadInstagramAccounts();
    }
  }

  // 8. Dismiss Modal Controller & Keyboard Navigation
  const dismissModalBtn = document.getElementById('dismissConnectModal');
  const modalOverlay = document.getElementById('connectInstagramModal');

  if (dismissModalBtn && modalOverlay) {
    dismissModalBtn.addEventListener('click', function () {
      modalOverlay.classList.remove('show');
      sessionStorage.setItem('comment2dm_ig_modal_dismissed', 'true');
    });

    modalOverlay.addEventListener('click', function (e) {
      if (e.target === modalOverlay) {
        modalOverlay.classList.remove('show');
        sessionStorage.setItem('comment2dm_ig_modal_dismissed', 'true');
      }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && modalOverlay.classList.contains('show')) {
        modalOverlay.classList.remove('show');
        sessionStorage.setItem('comment2dm_ig_modal_dismissed', 'true');
      }
    });
  }

  // 9. Load Home Activity & Real-Time Metrics
  async function loadDashboardOverview() {
    if (document.body.getAttribute('data-page') !== 'dashboard') return;

    try {
      const response = await fetch('/api/analytics/overview', {
        headers: window.getAuthHeaders(),
        credentials: 'same-origin'
      });
      if (!response.ok) return;
      const data = await response.json().catch(() => ({}));

      const dmsSent = document.getElementById('cardDmsSent');
      const activeAutos = document.getElementById('cardActiveAutos');
      const comments = document.getElementById('cardComments');
      const deliveryRate = document.getElementById('cardDeliveryRate');
      const deliveryNote = document.getElementById('cardDeliveryNote');

      if (dmsSent) dmsSent.textContent = Number(data.messagesSent || 0).toLocaleString();
      if (activeAutos) activeAutos.textContent = Number(data.activeAutomations || 0).toLocaleString();
      if (comments) comments.textContent = Number(data.comments || 0).toLocaleString();
      if (deliveryRate) deliveryRate.textContent = (data.deliveryRate || 100) + '%';
      if (deliveryNote) deliveryNote.textContent = data.messagesFailed ? `${data.messagesFailed} failed replies` : '100% Delivery Success';

      // Render recent activity feed
      const container = document.getElementById('activityFeedContainer');
      const emptyState = document.getElementById('activityEmptyState');
      const recent = data.recent || [];

      if (container && recent.length > 0) {
        if (emptyState) emptyState.style.display = 'none';
        container.innerHTML = '';

        recent.slice(0, 8).forEach(item => {
          const row = document.createElement('div');
          row.className = 'apple-card';
          row.style.padding = '14px 18px';
          row.style.marginBottom = '10px';
          row.style.display = 'flex';
          row.style.alignItems = 'center';
          row.style.justifyContent = 'space-between';
          row.style.flexWrap = 'wrap';
          row.style.gap = '12px';
          row.style.background = 'var(--surface)';
          row.style.border = '1px solid var(--glass-border)';

          const isSuccess = item.status === 'success';
          const icon = item.eventType === 'comment_received' ? '💬' : '📩';
          const label = item.eventType === 'comment_received' ? 'Comment detected' : 'Private DM sent';

          row.innerHTML = `
            <div style="display:flex; align-items:center; gap:12px;">
              <div style="width:36px; height:36px; border-radius:10px; background:${isSuccess ? 'var(--emerald-tint)' : 'var(--rose-tint)'}; display:flex; align-items:center; justify-content:center; font-size:1.1rem; flex-shrink:0;">
                ${icon}
              </div>
              <div>
                <strong style="color:var(--ink); font-size:0.9rem; display:block;">${label}</strong>
                <small style="color:var(--ink-secondary); font-size:0.8rem;">Trigger: <code style="color:var(--accent-light); background:var(--surface-hover); padding:1px 5px; border-radius:4px;">${item.keyword || 'All comments'}</code></small>
              </div>
            </div>
            <div style="display:flex; align-items:center; gap:12px;">
              <span class="plan-badge ${isSuccess ? 'pro' : ''}" style="color:${isSuccess ? 'var(--emerald)' : 'var(--rose)'};">
                ${isSuccess ? '✓ Delivered' : '✗ Failed'}
              </span>
              <small style="color:var(--ink-muted); font-size:0.75rem;">${new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small>
            </div>
          `;
          container.appendChild(row);
        });
      } else if (emptyState) {
        emptyState.style.display = 'block';
      }
    } catch (e) {
      console.error('Failed to load dashboard overview:', e);
    }
  }

  // 10. Refresh Activity Feed Button with Visual Animation
  const refreshBtn = document.getElementById('refreshActivityBtn');
  const refreshIcon = document.getElementById('refreshIcon');

  if (refreshBtn) {
    refreshBtn.addEventListener('click', async function () {
      if (refreshIcon) {
        refreshIcon.style.transform = 'rotate(360deg)';
      }
      await Promise.allSettled([
        loadDashboardOverview(),
        loadInstagramAccounts(),
        loadBillingQuota()
      ]);
      setTimeout(() => {
        if (refreshIcon) refreshIcon.style.transform = 'rotate(0deg)';
      }, 400);
    });
  }

  // Initialize all data concurrently
  Promise.allSettled([
    loadUser(),
    loadBillingQuota(),
    loadInstagramAccounts(),
    loadDashboardOverview()
  ]);
})();
