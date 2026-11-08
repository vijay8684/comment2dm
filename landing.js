/**
 * Comment2DM — Client Interaction Engine
 * Brand: Comment2DM | Company: VI TECH Limited
 * Theme: Light Mode (Default) with Dark Mode Support
 * Handles: Theme Toggling, Interactive Product Simulator, Pricing Switcher, Mobile Navigation, Scroll Reveals & Session Check
 */

(function () {
  'use strict';

  // ==========================================
  // 1. THEME INITIALIZATION & TOGGLE
  // ==========================================
  function initTheme() {
    const savedTheme = localStorage.getItem('comment2dm_theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);

    const toggleButtons = document.querySelectorAll('#themeToggleBtn, #mobileThemeToggleBtn');
    toggleButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme') || 'light';
        const next = current === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('comment2dm_theme', next);
      });
    });
  }
  initTheme();

  // ==========================================
  // 2. HEADER SCROLL & MOBILE MENU
  // ==========================================
  const header = document.getElementById('siteHeader');
  const hamburgerBtn = document.getElementById('hamburgerBtn');
  const mobileMenuDrawer = document.getElementById('mobileMenuDrawer');

  window.addEventListener('scroll', () => {
    if (window.scrollY > 20) {
      header?.classList.add('scrolled');
    } else {
      header?.classList.remove('scrolled');
    }
  }, { passive: true });

  if (hamburgerBtn && mobileMenuDrawer) {
    hamburgerBtn.addEventListener('click', () => {
      const isOpen = hamburgerBtn.classList.toggle('open');
      mobileMenuDrawer.classList.toggle('open', isOpen);
      hamburgerBtn.setAttribute('aria-expanded', String(isOpen));
    });

    document.querySelectorAll('.mobile-nav-link, .mobile-menu-drawer .btn').forEach(link => {
      link.addEventListener('click', () => {
        hamburgerBtn.classList.remove('open');
        mobileMenuDrawer.classList.remove('open');
        hamburgerBtn.setAttribute('aria-expanded', 'false');
      });
    });

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && mobileMenuDrawer.classList.contains('open')) {
        hamburgerBtn.classList.remove('open');
        mobileMenuDrawer.classList.remove('open');
        hamburgerBtn.setAttribute('aria-expanded', 'false');
        hamburgerBtn.focus();
      }
    });
  }

  // ==========================================
  // 3. CHECK ACTIVE SESSION FOR HEADER ACTIONS
  // ==========================================
  async function checkActiveSession() {
    try {
      const token = localStorage.getItem('comment2dm_token') || localStorage.getItem('nudge_token');
      if (!token) return;

      const res = await fetch('/api/me', {
        headers: { 'Authorization': 'Bearer ' + token },
        credentials: 'same-origin'
      });

      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data.user) {
          const loginBtn = document.querySelector('.nav-actions a[href*="tab=login"]');
          const signupBtn = document.querySelector('.nav-actions a[href*="tab=signup"]');
          if (loginBtn) {
            loginBtn.href = 'dashboard.html';
            loginBtn.textContent = 'Dashboard';
          }
          if (signupBtn) {
            signupBtn.href = 'settings.html';
            signupBtn.textContent = 'Account';
          }
        }
      }
    } catch (_) {}
  }
  checkActiveSession();

  // ==========================================
  // 4. INTERACTIVE HERO PRODUCT SIMULATOR
  // ==========================================
  const demoScenarios = [
    {
      keyword: 'GUIDE',
      user: 'priya_growth',
      avatar: 'P',
      commentText: 'Send the breakdown please! GUIDE 🔥',
      dmMessage: "Hey Priya! 👋 Thanks for commenting on our Reel. Here is your direct link to the 2026 Growth Playbook + Notion swipe file:",
      resourceTitle: "2026 Growth Playbook (PDF)",
      resourceDomain: "comment2dm.app/playbook",
      resourceBadge: "Instant Download · Free PDF",
      latency: "0.8s"
    },
    {
      keyword: 'SCALE',
      user: 'alex.ventures',
      avatar: 'A',
      commentText: 'Mind sending over the templates? SCALE 🚀',
      dmMessage: "Hey Alex! ⚡ Here are the viral automation templates you requested. Instant access is ready below:",
      resourceTitle: "Viral Reel Automation Templates",
      resourceDomain: "comment2dm.app/templates",
      resourceBadge: "Copy to Notion / Drive",
      latency: "0.7s"
    },
    {
      keyword: 'PROMO',
      user: 'sarah.creatives',
      avatar: 'S',
      commentText: 'Love the new collection! PROMO plz 💕',
      dmMessage: "Hey Sarah! 🎉 Here is your exclusive 20% discount code for today: VIP20. Tap below to apply it automatically:",
      resourceTitle: "Exclusive VIP 20% Discount",
      resourceDomain: "comment2dm.app/vip20",
      resourceBadge: "Claim 20% Off Code",
      latency: "0.9s"
    },
    {
      keyword: 'LINK',
      user: 'david_media',
      avatar: 'D',
      commentText: 'Where can I find the podcast link? LINK 🙏',
      dmMessage: "Hey David! 🎙️ Here is the direct link to the full podcast episode with timestamps and show notes:",
      resourceTitle: "Episode #84: 0 to 100K Followers",
      resourceDomain: "comment2dm.app/ep84",
      resourceBadge: "Listen on Spotify / Apple",
      latency: "0.6s"
    }
  ];

  let currentScenarioIndex = 0;
  let isDemoPaused = false;
  let demoCycleInterval = null;

  const simCommentsContainer = document.getElementById('simCommentsList');
  const simDmBubble = document.getElementById('simDmBubble');
  const simDmRecipient = document.getElementById('simDmRecipient');
  const dmRecipientAvatar = document.getElementById('dmRecipientAvatar');
  const simDeliveryBadge = document.getElementById('simDeliveryBadge');
  const telemetryActiveKey = document.getElementById('telemetryActiveKey');
  const telemetryLatency = document.getElementById('telemetryLatency');
  const captionKeywordDisplay = document.getElementById('captionKeywordDisplay');
  const demoKeywordInput = document.getElementById('demoKeywordInput');
  const demoTriggerBtn = document.getElementById('demoTriggerBtn');
  const pauseDemoBtn = document.getElementById('pauseDemoBtn');
  const quickChipsList = document.getElementById('quickChipsList');

  function renderScenario(scenario) {
    if (!simCommentsContainer || !simDmBubble) return;

    // Update Telemetry & Caption
    if (telemetryActiveKey) telemetryActiveKey.textContent = scenario.keyword;
    if (telemetryLatency) telemetryLatency.textContent = scenario.latency;
    if (captionKeywordDisplay) captionKeywordDisplay.textContent = scenario.keyword;
    if (simDmRecipient) simDmRecipient.textContent = `@${scenario.user}`;
    if (dmRecipientAvatar) dmRecipientAvatar.textContent = scenario.avatar;

    // Update Chips active state
    if (quickChipsList) {
      quickChipsList.querySelectorAll('.chip-btn').forEach(chip => {
        chip.classList.toggle('active', chip.getAttribute('data-chip') === scenario.keyword);
      });
    }

    // Render Comments Feed
    const highlightedComment = scenario.commentText.replace(
      new RegExp(`(${scenario.keyword})`, 'gi'),
      '<span class="keyword-highlight-pill">$1</span>'
    );

    simCommentsContainer.innerHTML = `
      <div class="sim-comment-item active-trigger">
        <div class="sim-comment-avatar">${scenario.avatar}</div>
        <div class="sim-comment-content">
          <div class="comment-author-row">
            <span class="sim-comment-user">@${scenario.user}</span>
            <span class="comment-time">Just now</span>
          </div>
          <div class="comment-text-body">${highlightedComment}</div>
          <div class="comment-trigger-badge">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
            <span>Trigger Keyword Matched: "${scenario.keyword}"</span>
          </div>
        </div>
      </div>
      <div class="sim-comment-item muted-comment">
        <div class="sim-comment-avatar avatar-muted">M</div>
        <div class="sim-comment-content">
          <div class="comment-author-row">
            <span class="sim-comment-user">@marco_dev</span>
            <span class="comment-time">4m ago</span>
          </div>
          <div class="comment-text-body">Super helpful reel, testing this with my team!</div>
        </div>
      </div>
    `;

    // Render DM Chat with smooth transition
    simDmBubble.style.opacity = '0';
    simDmBubble.style.transform = 'translateY(6px)';

    setTimeout(() => {
      simDmBubble.innerHTML = `
        <div class="dm-message-bubble">
          <p class="dm-text">${scenario.dmMessage}</p>
          
          <div class="dm-resource-link-card">
            <div class="resource-card-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
                <line x1="16" y1="13" x2="8" y2="13"></line>
                <line x1="16" y1="17" x2="8" y2="17"></line>
                <polyline points="10 9 9 9 8 9"></polyline>
              </svg>
            </div>
            <div class="resource-card-info">
              <span class="resource-domain">${scenario.resourceDomain}</span>
              <span class="resource-title">${scenario.resourceTitle}</span>
              <span class="resource-tag">${scenario.resourceBadge}</span>
            </div>
            <div class="resource-action-icon">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <line x1="5" y1="12" x2="19" y2="12"></line>
                <polyline points="12 5 19 12 12 19"></polyline>
              </svg>
            </div>
          </div>
        </div>
      `;
      simDmBubble.style.opacity = '1';
      simDmBubble.style.transform = 'translateY(0)';
      simDmBubble.style.transition = 'opacity 0.24s cubic-bezier(0.16, 1, 0.3, 1), transform 0.24s cubic-bezier(0.16, 1, 0.3, 1)';

      if (simDeliveryBadge) {
        simDeliveryBadge.innerHTML = `
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
          <span>Delivered in ${scenario.latency} via Official Meta Graph API</span>
        `;
      }
    }, 200);
  }

  function startDemoAutoCycle() {
    if (demoCycleInterval) clearInterval(demoCycleInterval);
    demoCycleInterval = setInterval(() => {
      if (!isDemoPaused) {
        currentScenarioIndex = (currentScenarioIndex + 1) % demoScenarios.length;
        renderScenario(demoScenarios[currentScenarioIndex]);
      }
    }, 4500);
  }

  if (simCommentsContainer) {
    renderScenario(demoScenarios[0]);
    startDemoAutoCycle();
  }

  // Quick Chip Click Handlers
  if (quickChipsList) {
    quickChipsList.querySelectorAll('.chip-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-chip');
        const match = demoScenarios.find(s => s.keyword === key);
        if (match) {
          renderScenario(match);
        }
      });
    });
  }

  // Custom Keyword Input Simulator
  if (demoTriggerBtn && demoKeywordInput) {
    const handleCustomTrigger = () => {
      const raw = (demoKeywordInput.value || '').trim();
      if (!raw) return;
      const word = raw.toUpperCase().slice(0, 16);

      const customScenario = {
        keyword: word,
        user: 'you_on_instagram',
        avatar: 'Y',
        commentText: `Can I get the details? ${word} please! 🔥`,
        dmMessage: `Hey there! ⚡ Comment2DM instantly caught your keyword "${word}". Here is your direct automated access link:`,
        resourceTitle: `Exclusive [${word}] Resource Bundle`,
        resourceDomain: `comment2dm.app/r/${word.toLowerCase()}`,
        resourceBadge: `Instant Download · Direct Link`,
        latency: '0.6s'
      };

      renderScenario(customScenario);
      demoKeywordInput.value = '';
    };

    demoTriggerBtn.addEventListener('click', handleCustomTrigger);
    demoKeywordInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleCustomTrigger();
      }
    });
  }

  // Pause / Resume Auto Cycle
  if (pauseDemoBtn) {
    pauseDemoBtn.addEventListener('click', () => {
      isDemoPaused = !isDemoPaused;
      pauseDemoBtn.textContent = isDemoPaused ? '▶' : '⏸';
      pauseDemoBtn.title = isDemoPaused ? 'Resume auto simulation' : 'Pause auto simulation';
    });
  }

  // ==========================================
  // 5. PRICING MONTHLY / ANNUAL SWITCH
  // ==========================================
  const billingCycleSwitch = document.getElementById('billingCycleSwitch');
  const monthlyLabel = document.getElementById('monthlyLabel');
  const annualLabel = document.getElementById('annualLabel');

  const pricingData = {
    free: { monthly: '₹0', annual: '₹0', period: '/ month' },
    pro: { monthly: '₹999', annual: '₹799', period: '/ mo (billed yearly)' },
    elite: { monthly: '₹2,499', annual: '₹1,999', period: '/ mo (billed yearly)' }
  };

  if (billingCycleSwitch) {
    billingCycleSwitch.addEventListener('change', () => {
      const isAnnual = billingCycleSwitch.checked;
      monthlyLabel?.classList.toggle('active', !isAnnual);
      annualLabel?.classList.toggle('active', isAnnual);

      const proPriceEl = document.getElementById('pricePro');
      const proPeriodEl = document.getElementById('periodPro');
      const elitePriceEl = document.getElementById('priceElite');
      const elitePeriodEl = document.getElementById('periodElite');

      if (proPriceEl) proPriceEl.textContent = isAnnual ? pricingData.pro.annual : pricingData.pro.monthly;
      if (proPeriodEl) proPeriodEl.textContent = isAnnual ? pricingData.pro.period : '/ month';
      if (elitePriceEl) elitePriceEl.textContent = isAnnual ? pricingData.elite.annual : pricingData.elite.monthly;
      if (elitePeriodEl) elitePeriodEl.textContent = isAnnual ? pricingData.elite.period : '/ month';

      const cycle = isAnnual ? 'annual' : 'monthly';
      document.querySelectorAll('[data-plan-target]').forEach(link => {
        const plan = link.getAttribute('data-plan-target');
        link.href = `login.html?tab=signup&plan=${encodeURIComponent(plan)}&billing=${cycle}`;
      });
    });
  }

  // ==========================================
  // 6. PURPOSEFUL SCROLL REVEAL
  // ==========================================
  const revealElements = document.querySelectorAll('.reveal-item');
  if ('IntersectionObserver' in window && revealElements.length > 0) {
    const revealObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('revealed');
          revealObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });

    revealElements.forEach(el => revealObserver.observe(el));
  } else {
    revealElements.forEach(el => el.classList.add('revealed'));
  }

  // ==========================================
  // 7. DYNAMIC COPYRIGHT YEAR
  // ==========================================
  const currentYearEl = document.getElementById('currentYear');
  if (currentYearEl) {
    currentYearEl.textContent = new Date().getFullYear();
  }
})();
