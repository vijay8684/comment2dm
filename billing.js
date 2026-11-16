// billing.js — Comment2DM Billing Page
(function () {
  'use strict';

  let currentPlan = 'free';
  let userEmail = '';
  let appliedDiscount = 0;
  let appliedCouponCode = '';

  // Canonical Launch Plan Configuration (Monthly Only)
  const PLANS = {
    free: {
      name: 'Free',
      monthlyPrice: 0,
      features: [
        '1 connected Instagram account',
        '2 active automations',
        '500 successful DMs / month',
        '150 MB customer file storage',
        'Keyword trigger',
        'Standard public replies',
        'Normal queue priority'
      ],
      missing: [
        'All-comment trigger',
        'Follow-to-unlock',
        'Advanced analytics & export',
        'Priority queue'
      ]
    },
    pro: {
      name: 'Pro',
      monthlyPrice: 70,
      features: [
        '3 connected Instagram accounts',
        'Unlimited active automations',
        '5,000 successful DMs / month',
        '1 GB customer file storage',
        'All-comment trigger',
        'Follow-to-unlock',
        'Public comment replies',
        'Advanced analytics & CSV export',
        'No Comment2DM branding',
        'No dashboard ads',
        'Standard queue priority'
      ],
      missing: [
        'Priority support',
        'Early feature access'
      ]
    },
    elite: {
      name: 'Elite',
      monthlyPrice: 150,
      features: [
        '10 connected Instagram accounts',
        'Unlimited active automations',
        '50,000 successful DMs / month',
        '5 GB customer file storage',
        'All-comment trigger',
        'Follow-to-unlock',
        'Public comment replies',
        'Advanced analytics & CSV export',
        'No Comment2DM branding',
        'No dashboard ads',
        'Priority queue processing',
        'Priority support',
        'Early feature access'
      ],
      missing: []
    }
  };

  // ── Toast ──────────────────────────────────────────────────────────────────
  function showToast(msg, type = 'success') {
    const c = document.getElementById('toastContainer');
    if (!c) return;
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = msg;
    c.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 4000);
  }

  // ── Render plan cards ─────────────────────────────────────────────────────
  function renderPlanCards() {
    const container = document.getElementById('planCards');
    if (!container) return;

    container.innerHTML = Object.entries(PLANS).map(([key, plan]) => {
      const basePrice = plan.monthlyPrice;
      const discountAmount = appliedDiscount > 0 ? (appliedDiscount > 100 ? appliedDiscount : (basePrice * (appliedDiscount / 100))) : 0;
      const finalPrice = Math.max(1, basePrice - discountAmount);

      const isCurrent = key === currentPlan;
      const isPopular = key === 'pro';

      let priceDisplay = '₹0';
      if (finalPrice > 0) {
        priceDisplay = `₹${Math.round(finalPrice).toLocaleString('en-IN')}`;
      }

      let originalDisplay = '';
      if (plan.is_sale && plan.regularPrice && plan.regularPrice > basePrice) {
        originalDisplay = `<s style="opacity:0.5;font-size:0.8rem;margin-right:6px;">₹${plan.regularPrice.toLocaleString('en-IN')}</s>`;
      } else if (appliedDiscount > 0 && basePrice > 0) {
        originalDisplay = `<s style="opacity:0.5;font-size:0.8rem;margin-right:6px;">₹${basePrice.toLocaleString('en-IN')}</s>`;
      }

      const period = basePrice === 0 ? 'Forever free' : '/ month';

      let btnClass = key;
      let btnText = isCurrent ? '✓ Current Plan' : key === 'free' ? 'Downgrade to Free' : `Upgrade to ${plan.name}`;
      if (isCurrent) btnClass = 'current-btn';

      const features = plan.features.map(f => `<li>${f}</li>`).join('');
      const missing = plan.missing.map(f => `<li class="miss">${f}</li>`).join('');

      return `<div class="plan-card ${isPopular ? 'popular' : ''} ${isCurrent ? 'current' : ''}">
        ${isPopular ? '<div class="popular-badge">⭐ Most Popular</div>' : ''}
        <div class="plan-name">${plan.name}</div>
        <div class="plan-price">
          ${originalDisplay}
          <span class="amount">${priceDisplay}</span>
          <span class="period">${period}</span>
        </div>
        <div class="plan-desc">${key === 'free' ? 'Perfect to get started' : key === 'pro' ? 'For growing creators' : 'For power users & agencies'}</div>
        <ul class="plan-features">${features}${missing}</ul>
        <button class="plan-cta ${btnClass}" data-plan="${key}" ${isCurrent ? 'disabled' : ''}>${btnText}</button>
      </div>`;
    }).join('');

    container.querySelectorAll('.plan-cta:not([disabled])').forEach(btn => {
      btn.addEventListener('click', () => initiateCheckout(btn.dataset.plan));
    });
  }

  // ── Coupons ───────────────────────────────────────────────────────────────
  const applyBtn = document.getElementById('applyCouponBtn');
  const couponInput = document.getElementById('couponCodeInput');
  const couponMsg = document.getElementById('couponMessage');

  if (applyBtn) {
    applyBtn.addEventListener('click', async () => {
      const code = couponInput.value.trim().toUpperCase();
      if (!code) return;
      try {
        const res = await fetch('/api/billing/validate-coupon', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(window.getAuthHeaders ? window.getAuthHeaders() : {}) },
          body: JSON.stringify({ code, planKey: 'pro_monthly' })
        });
        const data = await res.json();
        if (data.valid) {
          appliedDiscount = data.discount_rupees || (typeof data.discount === 'number' ? data.discount : 0);
          appliedCouponCode = code;
          const label = data.coupon?.discount_type === 'percentage' ? `${data.coupon.discount_value}% OFF` : `₹${data.discount_rupees} OFF`;
          couponMsg.textContent = `Coupon ${code} applied: ${label}! 🎉 (${data.duration_text || 'First billing cycle'})`;
          couponMsg.style.color = '#10b981';
          couponMsg.hidden = false;
          renderPlanCards();
        } else {
          couponMsg.textContent = '❌ ' + (data.error || 'Invalid or expired coupon code.');
          couponMsg.style.color = '#f43f5e';
          couponMsg.hidden = false;
          appliedDiscount = 0;
          appliedCouponCode = '';
          renderPlanCards();
        }
      } catch (e) {
        console.error(e);
      }
    });
  }

  // ── Initiate Razorpay checkout ─────────────────────────────────────────────
  async function initiateCheckout(plan) {
    if (plan === 'free') {
      showToast('Contact support to downgrade to Free plan.', 'error');
      return;
    }
    try {
      const planKey = `${plan}_monthly`;

      const res = await fetch('/api/billing/create-subscription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(window.getAuthHeaders ? window.getAuthHeaders() : {}) },
        body: JSON.stringify({ planKey, couponCode: appliedCouponCode || undefined })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create subscription');

      if (!data.keyId || !data.subscriptionId) {
        throw new Error('Payment system credentials or subscription details are unavailable. Please try again later.');
      }

      const options = {
        key: data.keyId,
        subscription_id: data.subscriptionId,
        name: data.name || 'Comment2DM',
        description: `Upgrade to ${PLANS[plan]?.name || plan} Monthly`,
        prefill: data.prefill || { email: userEmail },
        theme: { color: '#6366f1' },
        modal: {
          ondismiss: function () {
            showToast('Checkout was cancelled. No payment was charged.', 'error');
          }
        },
        handler: async (response) => {
          try {
            const verifyRes = await fetch('/api/billing/verify-subscription', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...(window.getAuthHeaders ? window.getAuthHeaders() : {}) },
              body: JSON.stringify({ 
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_subscription_id: response.razorpay_subscription_id,
                razorpay_signature: response.razorpay_signature,
                planKey
              })
            });
            const vd = await verifyRes.json();
            if (!verifyRes.ok) throw new Error(vd.error || 'Verification failed');
            showToast(`🎉 Upgraded to ${plan}! Welcome aboard.`);
            setTimeout(() => location.reload(), 2000);
          } catch (err) {
            showToast('❌ Payment verification failed: ' + err.message, 'error');
          }
        }
      };

      if (typeof Razorpay === 'undefined') {
        showToast('❌ Razorpay not loaded. Check your internet connection.', 'error');
        return;
      }
      const rzp = new Razorpay(options);
      rzp.open();
    } catch (err) {
      showToast('❌ ' + err.message, 'error');
    }
  }

  // ── Load billing status and dynamic prices ────────────────────────────────
  async function loadBillingStatus() {
    try {
      // First fetch dynamic prices
      const priceRes = await fetch('/api/billing/prices');
      if (priceRes.ok) {
        const prices = await priceRes.json();
        PLANS.pro.monthlyPrice = prices.pro_monthly || 70;
        PLANS.pro.regularPrice = prices.pro_regular || 70;
        PLANS.pro.is_sale = !!prices.plans?.pro?.is_sale;
        PLANS.pro.badge = prices.plans?.pro?.badge || null;

        PLANS.elite.monthlyPrice = prices.elite_monthly || 150;
        PLANS.elite.regularPrice = prices.elite_regular || 150;
        PLANS.elite.is_sale = !!prices.plans?.elite?.is_sale;
        PLANS.elite.badge = prices.plans?.elite?.badge || null;
      }

      // Then fetch user billing status
      const res = await fetch('/api/billing/status', {
        headers: window.getAuthHeaders ? window.getAuthHeaders() : {},
        credentials: 'same-origin'
      });
      if (!res.ok) { renderPlanCards(); return; }

      const data = await res.json();
      currentPlan = (data.plan || 'free').toLowerCase();
      const usedDms = data.usage?.dmMonthly || 0;
      const isUnlimited = data.isAdmin || data.limits?.dmMonthly === null || data.limits?.dmMonthly === Infinity;
      const defaultLimit = currentPlan === 'elite' ? 50000 : currentPlan === 'pro' ? 5000 : 500;
      const dmLimit = isUnlimited ? 'Unlimited' : (data.limits?.dmMonthly || defaultLimit);
      const dmPct = isUnlimited ? 0 : Math.min(100, Math.round((usedDms / (typeof dmLimit === 'number' ? dmLimit : defaultLimit)) * 100));
      const planName = currentPlan.charAt(0).toUpperCase() + currentPlan.slice(1);

      // DOM Elements in current plan card
      const pn = document.getElementById('currentPlanName');
      const pb = document.getElementById('currentPlanBadge');
      const dmBar = document.getElementById('dmUsageBar');
      const dmTxt = document.getElementById('dmUsageText');
      if (pn) pn.textContent = planName;
      if (pb) { pb.textContent = currentPlan.toUpperCase(); pb.className = `plan-badge ${currentPlan}`; }
      if (dmBar) dmBar.style.width = dmPct + '%';
      if (dmTxt) dmTxt.textContent = `${usedDms.toLocaleString()} / ${typeof dmLimit === 'number' ? dmLimit.toLocaleString() : dmLimit}`;

      // Storage metrics in current plan card
      const defaultStorage = currentPlan === 'elite' ? '5 GB' : currentPlan === 'pro' ? '1 GB' : '150 MB';
      const storageUsed = data.usage?.storageFormatted || '0 MB';
      const storageTotal = data.limits?.storageDisplay || defaultStorage;
      const storageRemaining = data.usage?.storageRemainingFormatted || defaultStorage;
      const storagePct = data.usage?.storagePercentage || 0;

      const storageBar = document.getElementById('storageUsageBar');
      const storageTxt = document.getElementById('storageUsageText');
      const storageRemTxt = document.getElementById('storageRemainingText');
      if (storageBar) storageBar.style.width = storagePct + '%';
      if (storageTxt) storageTxt.textContent = `${storageUsed} / ${storageTotal}`;
      if (storageRemTxt) storageRemTxt.textContent = `Remaining: ${storageRemaining}`;

      // Sidebar storage indicators
      const sideDmText = document.getElementById('dmLimitText');
      const sideDmFill = document.getElementById('dmProgressFill');
      const sideStorageText = document.getElementById('sidebarStorageText');
      const sideStorageFill = document.getElementById('sidebarStorageFill');

      if (sideDmText) sideDmText.textContent = `${usedDms.toLocaleString()} / ${typeof dmLimit === 'number' ? dmLimit.toLocaleString() : dmLimit}`;
      if (sideDmFill) sideDmFill.style.width = dmPct + '%';
      if (sideStorageText) sideStorageText.textContent = `${storageUsed} / ${storageTotal}`;
      if (sideStorageFill) sideStorageFill.style.width = storagePct + '%';

      renderPlanCards();
    } catch {
      renderPlanCards();
    }
  }

  // ── Load user email ────────────────────────────────────────────────────────
  async function loadUser() {
    try {
      const res = await fetch('/api/settings', {
        headers: window.getAuthHeaders ? window.getAuthHeaders() : {},
        credentials: 'same-origin'
      });
      if (!res.ok) return;
      const data = await res.json();
      userEmail = (data.user || data).email || '';
    } catch {}
  }

  // ── Load payment history ───────────────────────────────────────────────────
  async function loadHistory() {
    try {
      const res = await fetch('/api/billing/history', {
        headers: window.getAuthHeaders ? window.getAuthHeaders() : {},
        credentials: 'same-origin'
      });
      if (!res.ok) return;
      const data = await res.json();
      const payments = data.payments || data || [];
      const tbody = document.getElementById('historyBody');
      if (!tbody) return;
      if (!payments.length) return;

      tbody.innerHTML = payments.map(p => {
        const status = p.status === 'paid' ? '<span style="color:#10b981;">✅ Paid</span>' : p.status === 'failed' ? '<span style="color:#f43f5e;">❌ Failed</span>' : '<span style="color:#f59e0b;">⏳ Pending</span>';
        const date = new Date(p.createdAt || p.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
        const amount = p.amount ? `₹${(p.amount / 100).toLocaleString('en-IN')}` : '–';
        const plan = p.plan ? p.plan.charAt(0).toUpperCase() + p.plan.slice(1) : '–';
        return `<tr><td>${date}</td><td>${plan}</td><td>${amount}</td><td>${status}</td></tr>`;
      }).join('');
    } catch {}
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    loadUser();
    loadBillingStatus();
    loadHistory();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
