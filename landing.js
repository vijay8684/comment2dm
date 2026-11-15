/**
 * Comment2DM — Premium Landing Page Interactive Engine
 * Brand: Comment2DM | Operating Company: VI TECH Limited
 * Handles: Theme Toggle, Interactive Product Demo, Pricing Switcher, Mobile Navigation & Smooth Scroll
 */

(function () {
  'use strict';

  // ==========================================
  // 1. THEME TOGGLE & PERSISTENCE
  // ==========================================
  const themeToggleBtn = document.getElementById('themeToggleBtn');

  function getPreferredTheme() {
    const saved = localStorage.getItem('comment2dm_theme');
    if (saved) return saved;
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('comment2dm_theme', theme);
    if (themeToggleBtn) {
      themeToggleBtn.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`);
    }
  }

  // Initial theme sync
  setTheme(getPreferredTheme());

  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || 'dark';
      const nextTheme = current === 'dark' ? 'light' : 'dark';
      setTheme(nextTheme);
    });
  }

  // Listen for system theme changes if user hasn't explicitly set one
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', e => {
    if (!localStorage.getItem('comment2dm_theme')) {
      setTheme(e.matches ? 'light' : 'dark');
    }
  });

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

    // Close on mobile link click
    document.querySelectorAll('.mobile-nav-link, .mobile-menu-drawer .btn').forEach(link => {
      link.addEventListener('click', () => {
        hamburgerBtn.classList.remove('open');
        mobileMenuDrawer.classList.remove('open');
        hamburgerBtn.setAttribute('aria-expanded', 'false');
      });
    });

    // Close on Escape key
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
      const headers = token ? { 'Authorization': 'Bearer ' + token } : {};
      const res = await fetch('/api/me', { headers, credentials: 'same-origin' });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data.user) {
          const navActions = document.querySelector('.nav-actions');
          if (navActions) {
            const themeBtnHtml = themeToggleBtn ? themeToggleBtn.outerHTML : '';
            navActions.innerHTML = `
              ${themeBtnHtml}
              <a href="dashboard.html" class="btn btn-secondary btn-sm">Dashboard</a>
              <a href="settings.html" class="btn btn-primary btn-sm">Account</a>
            `;
            // Re-attach theme toggle listener
            const newThemeBtn = document.getElementById('themeToggleBtn');
            if (newThemeBtn) {
              newThemeBtn.addEventListener('click', () => {
                const cur = document.documentElement.getAttribute('data-theme') || 'dark';
                setTheme(cur === 'dark' ? 'light' : 'dark');
              });
            }
          }
        }
      }
    } catch (_) {}
  }
  checkActiveSession();

  // ==========================================
  // 4. INTERACTIVE PRODUCT VISUALIZATION
  // ==========================================
  const demoScenarios = [
    {
      keyword: 'GUIDE',
      user: 'priya_ux',
      commentText: 'Need this resource for our team! GUIDE 🔥',
      dmMessage: "Hey Priya! 👋 Thanks for commenting. Here is your direct link to download the 2026 Instagram Growth Playbook:",
      actionButton: "📥 Download Playbook PDF (Free)"
    },
    {
      keyword: 'SCALE',
      user: 'alex.ventures',
      commentText: 'Mind sending over the templates? SCALE 🚀',
      dmMessage: "Hey Alex! ⚡ Here are the viral automation templates you requested. Instant access below:",
      actionButton: "🚀 Get Viral Automation Templates"
    },
    {
      keyword: 'PROMO',
      user: 'sarah.creatives',
      commentText: 'Love the new collection! PROMO plz 💕',
      dmMessage: "Hey Sarah! 🎉 Here is your exclusive 20% discount code for today: VIP20. Shop direct below:",
      actionButton: "🛍️ Apply 20% Off At Checkout"
    }
  ];

  let currentScenarioIndex = 0;
  let isDemoPaused = false;
  let demoCycleInterval = null;

  const simCommentsContainer = document.getElementById('simCommentsList');
  const simDmBubble = document.getElementById('simDmBubble');
  const simDmRecipient = document.getElementById('simDmRecipient');
  const simDmActionBtn = document.getElementById('simDmActionBtn');
  const simDeliveryBadge = document.getElementById('simDeliveryBadge');
  const simFlowPulse = document.getElementById('simFlowPulse');
  const demoKeywordInput = document.getElementById('demoKeywordInput');
  const demoTriggerBtn = document.getElementById('demoTriggerBtn');
  const pauseDemoBtn = document.getElementById('pauseDemoBtn');

  function renderScenario(scenario, isCustom = false) {
    if (!simCommentsContainer || !simDmBubble) return;

    // Pulse flow bridge
    if (simFlowPulse) {
      simFlowPulse.style.opacity = '1';
    }

    // Update Comment Stream
    const avatarLetter = (scenario.user.charAt(0) || 'U').toUpperCase();
    simCommentsContainer.innerHTML = `
      <div class="sim-comment-item active-trigger">
        <div class="sim-comment-avatar">${avatarLetter}</div>
        <div class="sim-comment-content">
          <span class="sim-comment-user">@${scenario.user}</span>
          ${scenario.commentText.replace(new RegExp(`(${scenario.keyword})`, 'gi'), '<span class="keyword-badge">$1</span>')}
        </div>
      </div>
      <div class="sim-comment-item" style="opacity: 0.6;">
        <div class="sim-comment-avatar" style="background:#553C9A;">M</div>
        <div class="sim-comment-content">
          <span class="sim-comment-user">@mark_creator</span>
          <span>Great breakdown on reel conversion rules!</span>
        </div>
      </div>
    `;

    // Animate DM Appearance
    simDmBubble.style.opacity = '0';
    simDmBubble.style.transform = 'translateY(6px)';

    if (simDmRecipient) {
      simDmRecipient.textContent = `@${scenario.user}`;
    }

    setTimeout(() => {
      simDmBubble.innerHTML = `
        <p>${scenario.dmMessage}</p>
        <div class="dm-action-button" id="simDmActionBtn">
          <span>${scenario.actionButton}</span>
        </div>
      `;
      simDmBubble.style.opacity = '1';
      simDmBubble.style.transform = 'translateY(0)';
      simDmBubble.style.transition = 'opacity 0.3s ease, transform 0.3s ease';

      if (simDeliveryBadge) {
        simDeliveryBadge.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
          <span>Delivered in 1.1s via Comment2DM</span>
        `;
      }
    }, 280);
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

  // Initial render
  if (simCommentsContainer) {
    renderScenario(demoScenarios[0]);
    startDemoAutoCycle();
  }

  // Custom Keyword Trigger Handler
  if (demoTriggerBtn && demoKeywordInput) {
    demoTriggerBtn.addEventListener('click', () => {
      const word = (demoKeywordInput.value || '').trim().toUpperCase();
      if (!word) return;

      const customScenario = {
        keyword: word,
        user: 'you_on_instagram',
        commentText: `Can I get the details? ${word} please! 🔥`,
        dmMessage: `Hey there! ⚡ Comment2DM caught your keyword "${word}". Here is your instant automated access link:`,
        actionButton: `👉 Claim Access For [${word}]`
      };

      renderScenario(customScenario, true);
    });

    demoKeywordInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        demoTriggerBtn.click();
      }
    });
  }

  // Pause / Resume Toggle
  if (pauseDemoBtn) {
    pauseDemoBtn.addEventListener('click', () => {
      isDemoPaused = !isDemoPaused;
      pauseDemoBtn.textContent = isDemoPaused ? '▶ Resume Demo' : '⏸ Pause';
      pauseDemoBtn.setAttribute('title', isDemoPaused ? 'Resume auto simulation' : 'Pause auto simulation');
    });
  }

  // ==========================================
  // 5. HOW IT WORKS PROGRESS LINE OBSERVER
  // ==========================================
  const hiwSection = document.getElementById('how-it-works');
  const lineProgress = document.getElementById('hiwLineProgress');

  if (hiwSection && lineProgress) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          lineProgress.style.width = '100%';
        }
      });
    }, { threshold: 0.35 });

    observer.observe(hiwSection);
  }

  // ==========================================
  // 6. PRICING MONTHLY CONFIGURATION
  // ==========================================
  const pricingData = {
    free: { monthly: '₹0', period: '/ month' },
    pro: { monthly: '₹70', period: '/ month' },
    elite: { monthly: '₹150', period: '/ month' }
  };

  document.querySelectorAll('[data-plan-target]').forEach(link => {
    const plan = link.getAttribute('data-plan-target');
    link.href = `login.html?tab=signup&plan=${encodeURIComponent(plan)}&billing=monthly`;
  });

  // ==========================================
  // 7. SCROLL REVEAL OBSERVER
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
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

    revealElements.forEach(el => revealObserver.observe(el));
  } else {
    revealElements.forEach(el => el.classList.add('revealed'));
  }

  // ==========================================
  // 8. DYNAMIC COPYRIGHT YEAR
  // ==========================================
  const currentYearEl = document.getElementById('currentYear');
  if (currentYearEl) {
    currentYearEl.textContent = new Date().getFullYear();
  }
})();
