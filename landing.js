/**
 * Comment2DM — Client Interaction Engine
 * Brand: Comment2DM | Company: VI TECH Limited
 * Theme: Dark Mode Only
 * Handles: Interactive Product Demo, Pricing Switcher, Mobile Navigation, Scroll Reveals & Session Check
 */

(function () {
  'use strict';

  // ==========================================
  // 1. HEADER SCROLL & MOBILE MENU
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
  // 2. CHECK ACTIVE SESSION FOR HEADER ACTIONS
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
            navActions.innerHTML = `
              <a href="dashboard.html" class="btn btn-secondary btn-sm">Dashboard</a>
              <a href="settings.html" class="btn btn-primary btn-sm">Account</a>
            `;
          }
        }
      }
    } catch (_) {}
  }
  checkActiveSession();

  // ==========================================
  // 3. INTERACTIVE PRODUCT DEMO SIMULATOR
  // ==========================================
  const demoScenarios = [
    {
      keyword: 'GUIDE',
      user: 'priya_growth',
      commentText: 'Send the breakdown please! GUIDE 🔥',
      dmMessage: "Hey Priya! 👋 Thanks for commenting. Here is your direct link to the 2026 Growth Blueprint:",
      actionButton: "📥 Download Growth Blueprint PDF (Free)"
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
  const simDeliveryBadge = document.getElementById('simDeliveryBadge');
  const demoKeywordInput = document.getElementById('demoKeywordInput');
  const demoTriggerBtn = document.getElementById('demoTriggerBtn');
  const pauseDemoBtn = document.getElementById('pauseDemoBtn');

  function renderScenario(scenario, isCustom = false) {
    if (!simCommentsContainer || !simDmBubble) return;

    const avatarLetter = (scenario.user.charAt(0) || 'U').toUpperCase();
    simCommentsContainer.innerHTML = `
      <div class="sim-comment-bubble active-trigger">
        <div class="sim-comment-avatar">${avatarLetter}</div>
        <div class="sim-comment-body">
          <span class="sim-comment-user">@${scenario.user}</span>
          ${scenario.commentText.replace(new RegExp(`(${scenario.keyword})`, 'gi'), '<span class="keyword-tag">$1</span>')}
        </div>
      </div>
      <div class="sim-comment-bubble" style="opacity: 0.5;">
        <div class="sim-comment-avatar" style="background:#4338ca;">M</div>
        <div class="sim-comment-body">
          <span class="sim-comment-user">@mark_creator</span>
          <span>Great breakdown on reel conversion rules!</span>
        </div>
      </div>
    `;

    simDmBubble.style.opacity = '0';
    simDmBubble.style.transform = 'translateY(4px)';

    if (simDmRecipient) {
      simDmRecipient.textContent = `@${scenario.user}`;
    }

    setTimeout(() => {
      simDmBubble.innerHTML = `
        <p class="dm-message-text">${scenario.dmMessage}</p>
        <div class="dm-cta-btn">
          <span>${scenario.actionButton}</span>
        </div>
      `;
      simDmBubble.style.opacity = '1';
      simDmBubble.style.transform = 'translateY(0)';
      simDmBubble.style.transition = 'opacity 0.25s ease, transform 0.25s ease';

      if (simDeliveryBadge) {
        simDeliveryBadge.innerHTML = `
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
          <span>Delivered in 1.1s via Comment2DM</span>
        `;
      }
    }, 240);
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

  if (pauseDemoBtn) {
    pauseDemoBtn.addEventListener('click', () => {
      isDemoPaused = !isDemoPaused;
      pauseDemoBtn.textContent = isDemoPaused ? '▶ Play' : '⏸ Pause';
    });
  }

  // ==========================================
  // 4. PRICING MONTHLY / ANNUAL SWITCH
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
  // 5. PURPOSEFUL SCROLL REVEAL
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
  // 6. DYNAMIC COPYRIGHT YEAR
  // ==========================================
  const currentYearEl = document.getElementById('currentYear');
  if (currentYearEl) {
    currentYearEl.textContent = new Date().getFullYear();
  }
})();
