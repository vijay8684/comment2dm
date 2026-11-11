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

  // 7. Global Instagram Account Selector & State Machine
  let cachedAccounts = [];
  let currentSelectedAccount = null;

  function updateSelectedAccountUI(account) {
    const igUsername = document.getElementById('sidebarIgUsername');
    const igStatus = document.getElementById('sidebarIgStatus');
    const igAvatar = document.getElementById('sidebarIgAvatar');
    const switcherBtn = document.getElementById('accountSwitcherBtn');

    const loadingEl = document.getElementById('igLoadingState');
    const connectedEl = document.getElementById('igConnectedCard');
    const expiredEl = document.getElementById('igExpiredCard');
    const disconnectedEl = document.getElementById('igDisconnectedCard');
    const errorEl = document.getElementById('igErrorCard');

    function setSectionState(state) {
      if (loadingEl) loadingEl.style.display = state === 'loading' ? 'flex' : 'none';
      if (connectedEl) connectedEl.style.display = state === 'connected' ? 'block' : 'none';
      if (expiredEl) expiredEl.style.display = state === 'expired' ? 'block' : 'none';
      if (disconnectedEl) disconnectedEl.style.display = state === 'disconnected' ? 'block' : 'none';
      if (errorEl) errorEl.style.display = state === 'error' ? 'block' : 'none';
    }

    if (account) {
      const isExpired = account.status === 'Token expired' || (account.expiresAt && new Date(account.expiresAt).getTime() <= Date.now());

      if (igUsername) igUsername.textContent = '@' + account.username;
      if (igAvatar) igAvatar.textContent = (account.username || 'I').charAt(0).toUpperCase();
      if (igStatus) {
        igStatus.textContent = isExpired ? '⚠️ Expired' : '● Active';
        igStatus.style.color = isExpired ? 'var(--amber)' : 'var(--emerald)';
      }
      if (switcherBtn) {
        switcherBtn.title = `Connected as @${account.username} — Click to switch account`;
      }

      if (isExpired) {
        setSectionState('expired');
        const expiredUserEl = document.getElementById('igExpiredUsername');
        if (expiredUserEl) expiredUserEl.textContent = '@' + account.username;
      } else {
        setSectionState('connected');
        const connectedUserEl = document.getElementById('igConnectedUsername');
        const connectedAvatarEl = document.getElementById('igConnectedAvatar');
        const connectedMetaEl = document.getElementById('igConnectedMeta');

        if (connectedUserEl) connectedUserEl.textContent = '@' + account.username;
        if (connectedAvatarEl) connectedAvatarEl.textContent = (account.username || 'I').charAt(0).toUpperCase();
        if (connectedMetaEl && account.connectedAt) {
          try {
            connectedMetaEl.textContent = `· Linked ${new Date(account.connectedAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`;
          } catch (e) {}
        }
      }
    } else {
      setSectionState('disconnected');
      if (igUsername) igUsername.textContent = 'No Account';
      if (igStatus) {
        igStatus.textContent = 'Connect now';
        igStatus.style.color = 'var(--ink-secondary)';
      }
      if (switcherBtn) {
        switcherBtn.title = 'No account connected — Click to connect';
      }
    }
  }

  function renderAccountDropdown(accounts, activeAccountId) {
    const listContainer = document.getElementById('accountDropdownList');
    if (!listContainer) return;

    if (!accounts || accounts.length === 0) {
      listContainer.innerHTML = '<div class="account-dropdown-empty">No Instagram accounts connected yet.</div>';
      return;
    }

    listContainer.innerHTML = '';
    accounts.forEach(acc => {
      const isSelected = String(acc.id) === String(activeAccountId);
      const isExpired = acc.status === 'Token expired' || (acc.expiresAt && new Date(acc.expiresAt).getTime() <= Date.now());
      const initial = (acc.username || 'I').charAt(0).toUpperCase();

      const itemBtn = document.createElement('button');
      itemBtn.type = 'button';
      itemBtn.className = `account-dropdown-item ${isSelected ? 'active' : ''}`;
      itemBtn.setAttribute('role', 'option');
      itemBtn.setAttribute('aria-selected', isSelected ? 'true' : 'false');

      itemBtn.innerHTML = `
        <div class="account-dropdown-meta">
          <div class="account-dropdown-avatar">${initial}</div>
          <div class="account-dropdown-names">
            <span class="account-dropdown-username">@${acc.username}</span>
            <span class="account-dropdown-status" style="color:${isExpired ? 'var(--amber)' : 'var(--emerald)'};">
              ${isExpired ? '⚠️ Expired' : '● Active'}
            </span>
          </div>
        </div>
        ${isSelected ? `
          <svg class="account-dropdown-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        ` : ''}
      `;

      itemBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeAccountDropdown();
        if (currentSelectedAccount && String(currentSelectedAccount.id) === String(acc.id)) {
          return;
        }
        currentSelectedAccount = acc;
        localStorage.setItem('comment2dm_selected_account_id', acc.id);
        updateSelectedAccountUI(acc);
        renderAccountDropdown(cachedAccounts, acc.id);

        // Load account-specific stats on Dashboard
        if (document.body.getAttribute('data-page') === 'dashboard') {
          loadDashboardOverview(acc.id);
        }

        // Global event dispatch for other listeners
        window.dispatchEvent(new CustomEvent('comment2dm:accountChanged', { detail: acc }));
      });

      listContainer.appendChild(itemBtn);
    });
  }

  function toggleAccountDropdown() {
    const dropdown = document.getElementById('accountDropdownMenu');
    const switcherBtn = document.getElementById('accountSwitcherBtn');
    if (!dropdown || !switcherBtn) return;

    const isOpen = dropdown.style.display === 'flex';
    if (isOpen) {
      closeAccountDropdown();
    } else {
      dropdown.style.display = 'flex';
      switcherBtn.setAttribute('aria-expanded', 'true');
    }
  }

  function closeAccountDropdown() {
    const dropdown = document.getElementById('accountDropdownMenu');
    const switcherBtn = document.getElementById('accountSwitcherBtn');
    if (dropdown) dropdown.style.display = 'none';
    if (switcherBtn) switcherBtn.setAttribute('aria-expanded', 'false');
  }

  // Global click outside & Escape listeners for Account Dropdown
  document.addEventListener('click', function (e) {
    const area = document.getElementById('sidebarAccountArea');
    const dropdown = document.getElementById('accountDropdownMenu');
    if (dropdown && dropdown.style.display === 'flex') {
      if (area && !area.contains(e.target)) {
        closeAccountDropdown();
      }
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      closeAccountDropdown();
    }
  });

  function ensureAccountDropdownDOM() {
    const area = document.getElementById('sidebarAccountArea');
    if (!area) return;
    if (!document.getElementById('accountDropdownMenu')) {
      const dropdown = document.createElement('div');
      dropdown.className = 'account-selector-dropdown';
      dropdown.id = 'accountDropdownMenu';
      dropdown.setAttribute('role', 'listbox');
      dropdown.style.display = 'none';
      dropdown.innerHTML = `
        <div class="account-dropdown-header">Switch Account</div>
        <div class="account-dropdown-list" id="accountDropdownList">
          <div class="account-dropdown-empty">Loading accounts...</div>
        </div>
        <div class="account-dropdown-footer">
          <a href="/api/instagram/authorize" class="account-dropdown-action">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            <span>Connect another account</span>
          </a>
          <a href="instagram-accounts.html" class="account-dropdown-action">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="20" height="20" x="2" y="2" rx="5" ry="5"></rect><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"></path><line x1="17.5" x2="17.51" y1="6.5" y2="6.5"></line></svg>
            <span>Manage all accounts ↗</span>
          </a>
        </div>
      `;
      area.appendChild(dropdown);
    }
  }

  async function loadInstagramAccounts() {
    ensureAccountDropdownDOM();
    const switcherBtn = document.getElementById('accountSwitcherBtn');
    const modal = document.getElementById('connectInstagramModal');

    // Attach switcher click handler
    if (switcherBtn) {
      switcherBtn.onclick = function (e) {
        e.stopPropagation();
        if (cachedAccounts.length === 0) {
          if (modal) modal.classList.add('show');
          else window.location.href = 'instagram-accounts.html';
        } else {
          toggleAccountDropdown();
        }
      };
    }

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
        const errRetryBtn = document.getElementById('igRetryBtn');
        if (errRetryBtn) errRetryBtn.onclick = () => loadInstagramAccounts();
        return;
      }

      const data = await response.json().catch(() => ({}));
      const accounts = data.accounts || [];
      cachedAccounts = accounts;

      if (accounts.length > 0) {
        const savedId = localStorage.getItem('comment2dm_selected_account_id');
        const matched = accounts.find(a => String(a.id) === String(savedId));
        currentSelectedAccount = matched || accounts[0];
        localStorage.setItem('comment2dm_selected_account_id', currentSelectedAccount.id);

        updateSelectedAccountUI(currentSelectedAccount);
        renderAccountDropdown(accounts, currentSelectedAccount.id);

        if (modal) modal.classList.remove('show');
      } else {
        currentSelectedAccount = null;
        localStorage.removeItem('comment2dm_selected_account_id');
        updateSelectedAccountUI(null);
        renderAccountDropdown([], null);

        const dismissed = sessionStorage.getItem('comment2dm_ig_modal_dismissed');
        if (!dismissed && modal) {
          modal.classList.add('show');
        }
      }
    } catch (err) {
      console.error('Failed to load Instagram accounts:', err);
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

  // 9. Load Home Activity & Account-Specific Real-Time Metrics
  async function loadDashboardOverview(accountId) {
    if (document.body.getAttribute('data-page') !== 'dashboard') return;

    const targetId = accountId || (currentSelectedAccount ? currentSelectedAccount.id : '');
    const url = targetId ? `/api/analytics/overview?instagram_user_id=${encodeURIComponent(targetId)}` : '/api/analytics/overview';

    try {
      let response = await fetch(url, {
        headers: window.getAuthHeaders(),
        credentials: 'same-origin'
      });
      if (!response.ok && targetId) {
        // Safe fallback to user-level overview if account query was rejected
        response = await fetch('/api/analytics/overview', {
          headers: window.getAuthHeaders(),
          credentials: 'same-origin'
        });
      }
      if (!response.ok) return;
      const data = await response.json().catch(() => ({}));

      const dmsSent = document.getElementById('cardDmsSent');
      const activeAutos = document.getElementById('cardActiveAutos');
      const comments = document.getElementById('cardComments');
      const deliveryRate = document.getElementById('cardDeliveryRate');
      const deliveryNote = document.getElementById('cardDeliveryNote');

      const sentCount = Number(data.dmsSent ?? data.messagesSent ?? 0);
      const failedCount = Number(data.failed ?? data.messagesFailed ?? 0);
      const commentsCount = Number(data.commentsProcessed ?? data.comments ?? 0);
      const autosCount = Number(data.activeAutomations ?? 0);
      const totalDMs = sentCount + failedCount;

      if (dmsSent) dmsSent.textContent = sentCount.toLocaleString();
      if (activeAutos) activeAutos.textContent = autosCount.toLocaleString();
      if (comments) comments.textContent = commentsCount.toLocaleString();

      if (deliveryRate) {
        if (totalDMs === 0) {
          deliveryRate.textContent = '100%';
        } else {
          deliveryRate.textContent = (data.deliveryRate ?? 100) + '%';
        }
      }

      if (deliveryNote) {
        if (totalDMs === 0) {
          deliveryNote.textContent = 'Ready for comment triggers';
          deliveryNote.style.color = 'var(--ink-muted)';
        } else if (failedCount > 0) {
          deliveryNote.textContent = `${failedCount} failed replies`;
          deliveryNote.style.color = 'var(--rose)';
        } else {
          deliveryNote.textContent = '100% Delivery Success';
          deliveryNote.style.color = 'var(--emerald)';
        }
      }

      // Render recent activity feed
      const container = document.getElementById('activityFeedContainer');
      const emptyState = document.getElementById('activityEmptyState');
      const recent = data.recent || [];

      if (container) {
        if (recent.length > 0) {
          if (emptyState) emptyState.style.display = 'none';
          // Remove old rows
          container.querySelectorAll('.activity-feed-row').forEach(el => el.remove());

          recent.slice(0, 10).forEach(item => {
            const row = document.createElement('div');
            row.className = 'apple-card activity-feed-row';
            row.style.padding = '14px 18px';
            row.style.marginBottom = '10px';
            row.style.display = 'flex';
            row.style.alignItems = 'center';
            row.style.justifyContent = 'space-between';
            row.style.flexWrap = 'wrap';
            row.style.gap = '12px';
            row.style.background = 'var(--surface)';
            row.style.border = '1px solid var(--glass-border)';

            const isSuccess = item.status === 'success' || item.status === 'delivered';
            const isFailed = item.status === 'failed';
            const isComment = item.eventType === 'comment_received';

            let label = isComment ? 'Comment detected' : (isFailed ? 'Private DM failed' : 'Private DM sent');
            let iconSvg = '';
            if (isComment) {
              iconSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:#818cf8;"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"></path></svg>`;
            } else {
              iconSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:${isSuccess ? 'var(--emerald)' : (isFailed ? 'var(--rose)' : 'var(--amber)')};"><path d="m22 2-7 20-4-9-9-4Z"></path><path d="M22 2 11 13"></path></svg>`;
            }

            const bgTint = isSuccess ? 'var(--emerald-tint)' : (isFailed ? 'var(--rose-tint)' : 'var(--amber-tint)');
            const statusColor = isSuccess ? 'var(--emerald)' : (isFailed ? 'var(--rose)' : 'var(--amber)');
            const statusText = isSuccess ? '✓ Delivered' : (isFailed ? '✗ Failed' : '⏳ Processing');

            let timeStr = '';
            if (item.createdAt) {
              try {
                timeStr = new Date(item.createdAt).toLocaleString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit'
                });
              } catch (_) {
                timeStr = String(item.createdAt);
              }
            }

            row.innerHTML = `
              <div style="display:flex; align-items:center; gap:12px;">
                <div style="width:36px; height:36px; border-radius:10px; background:${bgTint}; display:flex; align-items:center; justify-content:center; flex-shrink:0;">
                  ${iconSvg}
                </div>
                <div>
                  <strong style="color:var(--ink); font-size:0.9rem; display:block;">${label}</strong>
                  <small style="color:var(--ink-secondary); font-size:0.8rem;">Trigger: <code style="color:var(--accent-light); background:var(--surface-hover); padding:1px 5px; border-radius:4px;">${item.keyword || 'All comments'}</code></small>
                </div>
              </div>
              <div style="display:flex; align-items:center; gap:12px;">
                <span class="plan-badge" style="color:${statusColor}; background:${bgTint}; border:1px solid ${statusColor}33;">
                  ${statusText}
                </span>
                <small style="color:var(--ink-muted); font-size:0.75rem;">${timeStr}</small>
              </div>
            `;
            container.appendChild(row);
          });
        } else if (emptyState) {
          emptyState.style.display = 'block';
          container.querySelectorAll('.activity-feed-row').forEach(el => el.remove());
        }
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
        loadInstagramAccounts(),
        loadDashboardOverview(currentSelectedAccount ? currentSelectedAccount.id : null),
        loadBillingQuota()
      ]);
      setTimeout(() => {
        if (refreshIcon) refreshIcon.style.transform = 'rotate(0deg)';
      }, 400);
    });
  }

  // 11. Feedback & Feature Requests Controller
  function initFeedbackModal() {
    const openBtn = document.getElementById('openFeedbackBtn');
    const modal = document.getElementById('feedbackModal');
    const cancelBtn = document.getElementById('cancelFeedbackBtn');
    const closeBtn = document.getElementById('closeFeedbackModalBtn');
    const submitBtn = document.getElementById('submitFeedbackBtn');
    const alertBox = document.getElementById('feedbackAlert');
    const form = document.getElementById('feedbackForm');

    if (!modal) return;

    function openModal() {
      if (alertBox) alertBox.style.display = 'none';
      if (form) form.reset();
      modal.classList.add('show');
    }

    function closeModal() {
      modal.classList.remove('show');
    }

    if (openBtn) openBtn.addEventListener('click', openModal);
    if (cancelBtn) cancelBtn.addEventListener('click', closeModal);
    if (closeBtn) closeBtn.addEventListener('click', closeModal);

    modal.addEventListener('click', function (e) {
      if (e.target === modal) closeModal();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && modal.classList.contains('show')) {
        closeModal();
      }
    });

    if (submitBtn) {
      submitBtn.addEventListener('click', async function () {
        const categoryEl = document.getElementById('feedbackCategory');
        const subjectEl = document.getElementById('feedbackSubject');
        const descEl = document.getElementById('feedbackDescription');
        const spinner = document.getElementById('submitFeedbackSpinner');
        const btnText = document.getElementById('submitFeedbackText');

        const category = categoryEl ? categoryEl.value : '';
        const subject = subjectEl ? subjectEl.value.trim() : '';
        const description = descEl ? descEl.value.trim() : '';

        function showAlert(msg, isSuccess) {
          if (!alertBox) return;
          alertBox.style.display = 'block';
          alertBox.style.background = isSuccess ? 'var(--emerald-tint)' : 'var(--rose-tint)';
          alertBox.style.color = isSuccess ? 'var(--emerald)' : 'var(--rose)';
          alertBox.style.border = `1px solid ${isSuccess ? 'rgba(16, 185, 129, 0.3)' : 'rgba(244, 63, 94, 0.3)'}`;
          alertBox.textContent = msg;
        }

        if (!subject || subject.length < 3) {
          showAlert('Please enter a subject (at least 3 characters).', false);
          return;
        }

        if (!description || description.length < 10) {
          showAlert('Please provide a detailed description (at least 10 characters).', false);
          return;
        }

        // Set submitting state
        submitBtn.disabled = true;
        if (spinner) spinner.style.display = 'inline-block';
        if (btnText) btnText.textContent = 'Submitting...';
        if (alertBox) alertBox.style.display = 'none';

        try {
          const res = await fetch('/api/feedback', {
            method: 'POST',
            headers: window.getAuthHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ category, subject, description }),
            credentials: 'same-origin'
          });

          const data = await res.json().catch(() => ({}));

          if (res.ok && data.success) {
            showAlert(data.message || 'Thank you! Your feedback has been submitted successfully.', true);
            if (form) form.reset();
            setTimeout(() => {
              closeModal();
            }, 1600);
          } else {
            showAlert(data.error || 'Unable to submit feedback. Please try again.', false);
          }
        } catch (err) {
          showAlert('Network error. Please check your connection and try again.', false);
        } finally {
          submitBtn.disabled = false;
          if (spinner) spinner.style.display = 'none';
          if (btnText) btnText.textContent = 'Submit Feedback';
        }
      });
    }
  }

  initFeedbackModal();

  // Initialize all data concurrently
  async function initDashboard() {
    await Promise.allSettled([
      loadUser(),
      loadBillingQuota(),
      loadInstagramAccounts()
    ]);
    // After loading accounts, load overview for the selected account
    if (document.body.getAttribute('data-page') === 'dashboard') {
      const selectedId = localStorage.getItem('comment2dm_selected_account_id');
      loadDashboardOverview(selectedId);
    }
  }

  initDashboard();
})();
