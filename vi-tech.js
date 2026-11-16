// vi-tech.js
// Comment2DM — VI Tech Owner Control Center Frontend Logic

'use strict';

document.addEventListener('DOMContentLoaded', () => {
  // ── State & Variables ────────────────────────────────────────────────
  let currentSection = 'overview';
  let activeCustomersList = [];
  let currentActiveCustomer = null;

  // ── Toast Notifications ──────────────────────────────────────────────
  const toastContainer = document.getElementById('toastContainer');
  function showToast(message, type = 'success') {
    if (!toastContainer) return;
    const toast = document.createElement('div');
    toast.className = `vi-toast ${type}`;
    toast.textContent = message;
    toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }

  // ── Theme Switcher ───────────────────────────────────────────────────
  const themeToggleBtn = document.getElementById('themeToggleBtn');
  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || 'dark';
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('comment2dm_theme', next);
    });
  }

  // ── Mobile Sidebar Toggle ────────────────────────────────────────────
  const mobileToggle = document.getElementById('mobileMenuToggle');
  const appSidebar = document.getElementById('appSidebar');
  if (mobileToggle && appSidebar) {
    mobileToggle.addEventListener('click', () => {
      appSidebar.classList.toggle('open');
    });
  }

  // ── Navigation Tabs ──────────────────────────────────────────────────
  const navItems = document.querySelectorAll('.admin-nav-item');
  const sections = document.querySelectorAll('.admin-section');
  const sectionTitle = document.getElementById('currentSectionTitle');

  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const target = item.dataset.section;
      if (!target) return;

      navItems.forEach(n => n.classList.remove('active'));
      sections.forEach(s => s.classList.remove('active'));

      item.classList.add('active');
      const activeSec = document.getElementById(`section-${target}`);
      if (activeSec) activeSec.classList.add('active');

      currentSection = target;
      if (sectionTitle) {
        sectionTitle.textContent = item.querySelector('span:last-child')?.textContent || 'VI Tech Admin';
      }

      loadSectionData(target);
      if (appSidebar && appSidebar.classList.contains('open')) {
        appSidebar.classList.remove('open');
      }
    });
  });

  // ── Section Data Loader ──────────────────────────────────────────────
  function loadSectionData(sec) {
    switch (sec) {
      case 'overview':
        loadOverview();
        break;
      case 'customers':
        loadCustomers();
        break;
      case 'pricing':
        loadPricing();
        break;
      case 'coupons':
        loadCoupons();
        break;
      case 'subscriptions':
        loadSubscriptions();
        loadPayments();
        break;
      case 'revenue':
        loadRevenue();
        break;
      case 'infrastructure':
        loadInfrastructure();
        break;
      case 'automations':
        loadAutomations();
        break;
      case 'support':
        loadSupport();
        break;
      case 'audit':
        loadAuditLogs();
        break;
      case 'settings':
        loadSettings();
        break;
    }
  }

  // ── 1. Overview ──────────────────────────────────────────────────────
  async function loadOverview() {
    try {
      const res = await fetch('/api/admin/overview', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Failed to load overview data');
      const data = await res.json();
      const m = data.metrics || {};

      document.getElementById('kpiTotalCustomers').textContent = m.total_customers ?? '--';
      document.getElementById('kpiActiveCustomers').textContent = `${m.active_customers ?? '--'} active`;
      document.getElementById('kpiMRR').textContent = `₹${(m.mrr || 0).toLocaleString('en-IN')}`;
      document.getElementById('kpiPaidSubs').textContent = `${m.active_paid_subscriptions || 0} active subscriptions`;
      document.getElementById('kpiTotalRevenue').textContent = `₹${(m.total_collected_revenue || 0).toLocaleString('en-IN')}`;
      document.getElementById('kpiTotalDMs').textContent = (m.total_dms_sent_monthly || 0).toLocaleString('en-IN');
      document.getElementById('kpiFailedDMs').textContent = `${m.failed_dms_monthly || 0} issues`;
      document.getElementById('kpiR2Storage').textContent = m.r2_storage_formatted || '0 B';
      document.getElementById('kpiActiveAutomations').textContent = m.active_automations || 0;

      document.getElementById('distFree').textContent = m.free_subscribers ?? '--';
      document.getElementById('distPro').textContent = m.pro_subscribers ?? '--';
      document.getElementById('distElite').textContent = m.elite_subscribers ?? '--';
    } catch (err) {
      showToast('❌ ' + err.message, 'error');
    }
  }

  // ── 2. Customers ─────────────────────────────────────────────────────
  async function loadCustomers() {
    const search = document.getElementById('customerSearchInput')?.value || '';
    const plan = document.getElementById('customerPlanFilter')?.value || 'all';
    const status = document.getElementById('customerStatusFilter')?.value || 'all';
    const tbody = document.getElementById('customersTableBody');

    try {
      const res = await fetch(`/api/admin/customers?search=${encodeURIComponent(search)}&plan=${plan}&status=${status}`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Failed to load customers');
      const data = await res.json();
      activeCustomersList = data.customers || [];

      if (activeCustomersList.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--ink-muted);">No matching customers found.</td></tr>`;
        return;
      }

      tbody.innerHTML = activeCustomersList.map(c => `
        <tr>
          <td>
            <div style="font-weight:700;">${c.name}</div>
            <div style="font-size:0.75rem;color:var(--ink-muted);">${c.email}</div>
          </td>
          <td>
            <span class="status-badge ${c.plan === 'elite' ? 'scheduled' : c.plan === 'pro' ? 'active' : ''}">
              ${c.plan.toUpperCase()}
            </span>
          </td>
          <td>
            <span class="status-badge ${c.status === 'active' ? 'active' : 'suspended'}">
              ${c.status.toUpperCase()}
            </span>
          </td>
          <td>${c.instagram_accounts_count} accounts</td>
          <td>${c.active_automations_count} active</td>
          <td style="font-size:0.78rem;color:var(--ink-muted);">${c.registered_at ? new Date(c.registered_at).toLocaleDateString() : 'N/A'}</td>
          <td>
            <div style="display:flex;gap:6px;">
              <button class="action-btn view-cust-btn" data-id="${c.id}">Details</button>
              ${c.status === 'active' 
                ? `<button class="action-btn danger suspend-cust-btn" data-id="${c.id}" data-action="suspend">Suspend</button>`
                : `<button class="action-btn restore-cust-btn" data-id="${c.id}" data-action="restore" style="color:#10B981;">Restore</button>`
              }
            </div>
          </td>
        </tr>
      `).join('');

      // Wire customer action buttons
      tbody.querySelectorAll('.view-cust-btn').forEach(b => {
        b.addEventListener('click', () => openCustomerModal(b.dataset.id));
      });
      tbody.querySelectorAll('.suspend-cust-btn, .restore-cust-btn').forEach(b => {
        b.addEventListener('click', () => handleCustomerStatus(b.dataset.id, b.dataset.action));
      });
    } catch (err) {
      showToast('❌ ' + err.message, 'error');
    }
  }

  // Customer search & filter listeners
  document.getElementById('customerSearchInput')?.addEventListener('input', debounce(loadCustomers, 300));
  document.getElementById('customerPlanFilter')?.addEventListener('change', loadCustomers);
  document.getElementById('customerStatusFilter')?.addEventListener('change', loadCustomers);

  async function handleCustomerStatus(userId, action) {
    const isSuspend = action === 'suspend';
    if (!confirm(`Are you sure you want to ${isSuspend ? 'SUSPEND' : 'RESTORE'} this customer?`)) return;

    try {
      const endpoint = isSuspend ? `/api/admin/customers/${userId}/suspend` : `/api/admin/customers/${userId}/restore`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: isSuspend ? 'Administrative suspension from VI Tech Control Center' : 'Administrative restoration' }),
        credentials: 'same-origin'
      });
      if (!res.ok) throw new Error(`Failed to ${action} customer`);
      showToast(`Customer successfully ${isSuspend ? 'suspended' : 'restored'}!`);
      loadCustomers();
    } catch (err) {
      showToast('❌ ' + err.message, 'error');
    }
  }

  // ── Customer Modal ───────────────────────────────────────────────────
  const customerModal = document.getElementById('customerModal');
  const closeCustModal = document.getElementById('closeCustomerModal');
  if (closeCustModal) {
    closeCustModal.addEventListener('click', () => customerModal.classList.remove('open'));
  }

  async function openCustomerModal(userId) {
    try {
      const res = await fetch(`/api/admin/customers/${userId}`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Failed to load customer profile');
      const data = await res.json();
      currentActiveCustomer = data.customer;

      document.getElementById('custModalName').textContent = currentActiveCustomer.name || 'Customer';
      document.getElementById('custModalEmail').textContent = currentActiveCustomer.email;

      const content = document.getElementById('custModalContent');
      content.innerHTML = `
        <div style="margin-bottom:16px;">
          <strong>Account Status:</strong> <span class="status-badge ${currentActiveCustomer.suspended ? 'suspended' : 'active'}">${currentActiveCustomer.suspended ? 'SUSPENDED' : 'ACTIVE'}</span><br>
          <strong>Current Tier:</strong> ${currentActiveCustomer.plan?.toUpperCase() || 'FREE'}<br>
          <strong>Customer ID:</strong> <code>${currentActiveCustomer.id}</code><br>
          <strong>Registered:</strong> ${new Date(currentActiveCustomer.created_at || currentActiveCustomer.createdAt).toLocaleString()}
        </div>
        <div style="margin-bottom:16px;">
          <strong>Connected Instagram Accounts (${data.accounts?.length || 0}):</strong>
          <ul style="margin:4px 0 0 16px;padding:0;">
            ${(data.accounts || []).map(a => `<li>@${a.username || a.instagram_user_id} (Linked: ${new Date(a.connected_at).toLocaleDateString()})</li>`).join('') || '<li>No connected accounts</li>'}
          </ul>
        </div>
        <div>
          <strong>Subscription Records (${data.subscriptions?.length || 0}):</strong>
          <ul style="margin:4px 0 0 16px;padding:0;">
            ${(data.subscriptions || []).map(s => `<li>${s.plan?.toUpperCase()} - ${s.status?.toUpperCase()} (${s.razorpay_subscription_id || 'N/A'})</li>`).join('') || '<li>No subscription history</li>'}
          </ul>
        </div>
      `;

      customerModal.classList.add('open');
    } catch (err) {
      showToast('❌ ' + err.message, 'error');
    }
  }

  document.getElementById('modalRevokeBtn')?.addEventListener('click', async () => {
    if (!currentActiveCustomer) return;
    try {
      const res = await fetch(`/api/admin/customers/${currentActiveCustomer.id}/revoke-sessions`, {
        method: 'POST',
        credentials: 'same-origin'
      });
      if (!res.ok) throw new Error('Failed to revoke sessions');
      showToast('All customer sessions revoked.');
    } catch (err) {
      showToast('❌ ' + err.message, 'error');
    }
  });

  document.getElementById('modalOverrideBtn')?.addEventListener('click', async () => {
    if (!currentActiveCustomer) return;
    const plan = prompt('Enter override plan tier (pro, elite, free):', 'pro');
    if (!plan || !['pro', 'elite', 'free'].includes(plan.toLowerCase())) return;
    const reason = prompt('Reason for override (required for audit log):', 'Complimentary VIP access granted by owner');
    if (!reason) return;

    try {
      const res = await fetch(`/api/admin/customers/${currentActiveCustomer.id}/override-entitlement`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: plan.toLowerCase(), reason, expiry_days: 30 }),
        credentials: 'same-origin'
      });
      if (!res.ok) throw new Error('Failed to override entitlement');
      showToast(`Entitlement override to ${plan.toUpperCase()} granted!`);
      customerModal.classList.remove('open');
      loadCustomers();
    } catch (err) {
      showToast('❌ ' + err.message, 'error');
    }
  });

  // ── 3. Pricing & Promotions ──────────────────────────────────────────
  async function loadPricing() {
    try {
      const res = await fetch('/api/admin/pricing', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Failed to load pricing');
      const data = await res.json();

      const cat = data.catalog || {};
      const proInp = document.getElementById('inputProRegular');
      const eliteInp = document.getElementById('inputEliteRegular');
      if (proInp) proInp.value = cat.pro?.monthly || 70;
      if (eliteInp) eliteInp.value = cat.elite?.monthly || 150;

      // Render campaigns
      const tbody = document.getElementById('campaignsTableBody');
      const camps = data.campaigns || [];
      if (camps.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:20px;color:var(--ink-muted);">No promotional campaigns scheduled yet.</td></tr>`;
        return;
      }

      tbody.innerHTML = camps.map(c => `
        <tr>
          <td><strong>${c.name}</strong></td>
          <td><span class="status-badge scheduled">${c.badge_text || 'PROMO'}</span></td>
          <td>${c.sale_price_pro ? `₹${c.sale_price_pro} (${c.discount_percent_pro}% off)` : '--'}</td>
          <td>${c.sale_price_elite ? `₹${c.sale_price_elite} (${c.discount_percent_elite}% off)` : '--'}</td>
          <td style="font-size:0.75rem;">${new Date(c.start_date).toLocaleString()}</td>
          <td style="font-size:0.75rem;">${new Date(c.end_date).toLocaleString()}</td>
          <td><span class="status-badge ${c.status === 'active' ? 'active' : 'suspended'}">${c.status.toUpperCase()}</span></td>
          <td>
            ${c.status === 'active' 
              ? `<button class="action-btn danger end-camp-btn" data-id="${c.id}">End Sale</button>`
              : `<span style="font-size:0.75rem;color:var(--ink-muted);">Inactive</span>`
            }
          </td>
        </tr>
      `).join('');

      tbody.querySelectorAll('.end-camp-btn').forEach(b => {
        b.addEventListener('click', async () => {
          if (!confirm('Are you sure you want to immediately end this sale campaign?')) return;
          try {
            const r = await fetch(`/api/admin/pricing/campaigns/${b.dataset.id}/status`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status: 'ended' }),
              credentials: 'same-origin'
            });
            if (!r.ok) throw new Error('Failed to end campaign');
            showToast('Promotion ended.');
            loadPricing();
          } catch (e) { showToast('❌ ' + e.message, 'error'); }
        });
      });
    } catch (err) {
      showToast('❌ ' + err.message, 'error');
    }
  }

  // Update Regular Prices
  document.getElementById('regularPriceForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pro = Number(document.getElementById('inputProRegular').value);
    const elite = Number(document.getElementById('inputEliteRegular').value);
    const reason = document.getElementById('inputPriceReason').value.trim();

    if (!confirm(`Confirm updating regular prices to Pro: ₹${pro}/mo, Elite: ₹${elite}/mo?`)) return;

    try {
      const res = await fetch('/api/admin/pricing/regular', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pro_monthly: pro, elite_monthly: elite, reason }),
        credentials: 'same-origin'
      });
      if (!res.ok) throw new Error('Failed to update regular prices');
      showToast('Regular base prices successfully updated!');
      loadPricing();
    } catch (err) {
      showToast('❌ ' + err.message, 'error');
    }
  });

  // Real-time discount percentage auto-calculation
  const campPro = document.getElementById('campProPrice');
  const campElite = document.getElementById('campElitePrice');
  function updateCampaignCalcs() {
    const regPro = Number(document.getElementById('inputProRegular')?.value) || 70;
    const regElite = Number(document.getElementById('inputEliteRegular')?.value) || 150;

    const valPro = Number(campPro?.value);
    const valElite = Number(campElite?.value);

    const proCalc = document.getElementById('campProCalc');
    const eliteCalc = document.getElementById('campEliteCalc');

    if (proCalc) {
      proCalc.textContent = (valPro > 0 && valPro < regPro) 
        ? `${Math.round(((regPro - valPro)/regPro)*100)}% discount (Regular ₹${regPro})` 
        : '';
    }
    if (eliteCalc) {
      eliteCalc.textContent = (valElite > 0 && valElite < regElite) 
        ? `${Math.round(((regElite - valElite)/regElite)*100)}% discount (Regular ₹${regElite})` 
        : '';
    }
  }
  campPro?.addEventListener('input', updateCampaignCalcs);
  campElite?.addEventListener('input', updateCampaignCalcs);

  // Create Campaign
  document.getElementById('createCampaignForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('campName').value.trim();
    const proPrice = document.getElementById('campProPrice').value ? Number(document.getElementById('campProPrice').value) : null;
    const elitePrice = document.getElementById('campElitePrice').value ? Number(document.getElementById('campElitePrice').value) : null;
    const start_date = document.getElementById('campStartDate').value;
    const end_date = document.getElementById('campEndDate').value;
    const badge_text = document.getElementById('campBadge').value.trim();

    const applicable_plans = [];
    if (proPrice != null) applicable_plans.push('pro');
    if (elitePrice != null) applicable_plans.push('elite');

    if (applicable_plans.length === 0) {
      showToast('❌ Enter at least one sale price for Pro or Elite.', 'error');
      return;
    }

    try {
      const res = await fetch('/api/admin/pricing/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          applicable_plans,
          sale_price_pro: proPrice,
          sale_price_elite: elitePrice,
          start_date,
          end_date,
          badge_text,
          status: 'active'
        }),
        credentials: 'same-origin'
      });
      if (!res.ok) throw new Error('Failed to create campaign');
      showToast(`🎉 Festive campaign "${name}" launched!`);
      e.target.reset();
      loadPricing();
    } catch (err) {
      showToast('❌ ' + err.message, 'error');
    }
  });

  // ── 4. Coupon Codes ──────────────────────────────────────────────────
  async function loadCoupons() {
    try {
      const res = await fetch('/api/admin/coupons', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Failed to load coupons');
      const data = await res.json();
      const tbody = document.getElementById('couponsTableBody');
      const coupons = data.coupons || [];

      if (coupons.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--ink-muted);">No coupons created yet.</td></tr>`;
        return;
      }

      tbody.innerHTML = coupons.map(c => `
        <tr>
          <td><strong style="color:var(--accent-light);letter-spacing:0.04em;">${c.code}</strong></td>
          <td>${c.discount_type === 'percentage' ? `${c.discount_value}% OFF` : `₹${c.discount_value} OFF`}</td>
          <td>${c.duration === 'once' ? '1st Cycle' : c.duration === 'repeating' ? `${c.duration_in_months} Cycles` : 'Forever'}</td>
          <td>${c.redemption_count || 0} / ${c.max_redemptions}</td>
          <td><span class="status-badge ${c.is_active ? 'active' : 'suspended'}">${c.is_active ? 'ACTIVE' : 'INACTIVE'}</span></td>
          <td style="font-size:0.75rem;">${c.expiry_date ? new Date(c.expiry_date).toLocaleDateString() : 'Never'}</td>
          <td>
            <button class="action-btn toggle-coupon-btn" data-code="${c.code}" data-active="${c.is_active}">
              ${c.is_active ? 'Deactivate' : 'Activate'}
            </button>
          </td>
        </tr>
      `).join('');

      tbody.querySelectorAll('.toggle-coupon-btn').forEach(b => {
        b.addEventListener('click', async () => {
          const code = b.dataset.code;
          const current = b.dataset.active === 'true';
          try {
            const r = await fetch(`/api/admin/coupons/${code}/status`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ is_active: !current }),
              credentials: 'same-origin'
            });
            if (!r.ok) throw new Error('Failed to toggle coupon status');
            showToast(`Coupon ${code} updated!`);
            loadCoupons();
          } catch (e) { showToast('❌ ' + e.message, 'error'); }
        });
      });
    } catch (err) {
      showToast('❌ ' + err.message, 'error');
    }
  }

  document.getElementById('generateCouponBtn')?.addEventListener('click', () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = 'SAVE';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
    const inp = document.getElementById('couponCodeInput');
    if (inp) inp.value = code;
  });

  document.getElementById('createCouponForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = document.getElementById('couponCodeInput').value.trim().toUpperCase();
    const discount_type = document.getElementById('couponType').value;
    const discount_value = Number(document.getElementById('couponValue').value);
    const duration = document.getElementById('couponDuration').value;
    const max_redemptions = Number(document.getElementById('couponMaxUses').value) || 100;
    const expiry_date = document.getElementById('couponExpiry').value || null;

    try {
      const res = await fetch('/api/admin/coupons', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          discount_type,
          discount_value,
          applicable_plans: ['pro', 'elite'],
          duration,
          max_redemptions,
          expiry_date
        }),
        credentials: 'same-origin'
      });
      if (!res.ok) throw new Error('Failed to create coupon code');
      showToast(`🎟️ Coupon ${code} created successfully!`);
      e.target.reset();
      loadCoupons();
    } catch (err) {
      showToast('❌ ' + err.message, 'error');
    }
  });

  // ── 5. Subscriptions & Payments ──────────────────────────────────────
  async function loadSubscriptions() {
    try {
      const status = document.getElementById('subStatusFilter')?.value || 'all';
      const res = await fetch(`/api/admin/subscriptions?status=${status}`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Failed to load subscriptions');
      const data = await res.json();
      const tbody = document.getElementById('subsTableBody');
      const subs = data.subscriptions || [];

      if (subs.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--ink-muted);">No subscriptions found.</td></tr>`;
        return;
      }

      tbody.innerHTML = subs.map(s => `
        <tr>
          <td>
            <strong>${s.customer_name}</strong>
            <div style="font-size:0.75rem;color:var(--ink-muted);">${s.customer_email}</div>
          </td>
          <td><span class="status-badge ${s.plan === 'elite' ? 'scheduled' : 'active'}">${s.plan?.toUpperCase()}</span></td>
          <td>₹${s.effective_amount || 70} / mo</td>
          <td><span class="status-badge ${s.status === 'active' ? 'active' : 'suspended'}">${s.status?.toUpperCase()}</span></td>
          <td><code style="font-size:0.75rem;">${s.razorpay_subscription_id || 'N/A'}</code></td>
          <td style="font-size:0.75rem;">${s.current_end ? new Date(s.current_end).toLocaleDateString() : 'N/A'}</td>
          <td>${s.coupon_code ? `<span class="status-badge scheduled">${s.coupon_code}</span>` : '--'}</td>
        </tr>
      `).join('');
    } catch (err) {
      showToast('❌ ' + err.message, 'error');
    }
  }

  document.getElementById('subStatusFilter')?.addEventListener('change', loadSubscriptions);

  async function loadPayments() {
    try {
      const res = await fetch('/api/admin/payments', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Failed to load payments');
      const data = await res.json();
      const tbody = document.getElementById('paymentsTableBody');
      const payments = data.payments || [];

      if (payments.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--ink-muted);">No payments recorded yet.</td></tr>`;
        return;
      }

      tbody.innerHTML = payments.map(p => `
        <tr>
          <td><code>${p.payment_id}</code></td>
          <td>${p.customer_email}</td>
          <td><strong>₹${p.amount_rupees}</strong></td>
          <td><span class="status-badge active">${p.status?.toUpperCase()}</span></td>
          <td style="font-size:0.75rem;">${new Date(p.created_at).toLocaleString()}</td>
        </tr>
      `).join('');
    } catch (err) {
      showToast('❌ ' + err.message, 'error');
    }
  }

  // ── 6. Revenue Analytics ─────────────────────────────────────────────
  async function loadRevenue() {
    try {
      const res = await fetch('/api/admin/revenue/analytics', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Failed to load revenue analytics');
      const data = await res.json();

      document.getElementById('revTotalCollected').textContent = `₹${(data.total_collected_revenue || 0).toLocaleString('en-IN')}`;
      document.getElementById('revMRR').textContent = `₹${(data.monthly_recurring_revenue || 0).toLocaleString('en-IN')}`;
      document.getElementById('revARR').textContent = `₹${(data.estimated_annual_run_rate || 0).toLocaleString('en-IN')}`;
      document.getElementById('revTransactions').textContent = data.total_transactions || 0;
    } catch (err) {
      showToast('❌ ' + err.message, 'error');
    }
  }

  // ── 7. Usage & Infrastructure ────────────────────────────────────────
  async function loadInfrastructure() {
    try {
      const res = await fetch('/api/admin/infrastructure', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Failed to load infrastructure telemetry');
      const data = await res.json();

      document.getElementById('infraMongoStatus').textContent = data.mongodb?.status || 'Unknown';
      document.getElementById('infraMongoLatency').textContent = `${data.mongodb?.latency_ms || 0} ms`;

      document.getElementById('infraR2Status').textContent = data.cloudflare_r2?.status || 'Not configured';
      document.getElementById('infraR2Bucket').textContent = data.cloudflare_r2?.bucket || 'None';
      document.getElementById('infraR2Usage').textContent = data.cloudflare_r2?.total_storage_used || '0 B';

      document.getElementById('infraNodeVer').textContent = data.render?.node_version || '--';
      document.getElementById('infraUptime').textContent = `${Math.round((data.render?.uptime_seconds || 0) / 3600)} hours`;
      document.getElementById('infraMemory').textContent = `${data.render?.memory_usage_mb || 0} MB`;
      document.getElementById('infraEnv').textContent = data.render?.environment || '--';

      document.getElementById('infraRazorpayStatus').textContent = data.razorpay?.status || 'Missing';
      document.getElementById('infraRazorpayMode').textContent = data.razorpay?.mode || 'Test Mode';
    } catch (err) {
      showToast('❌ ' + err.message, 'error');
    }
  }

  // ── 8. Automations Monitoring ────────────────────────────────────────
  async function loadAutomations() {
    try {
      const res = await fetch('/api/admin/automations', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Failed to load automation metrics');
      const data = await res.json();

      document.getElementById('autoTotal').textContent = data.total_automations || 0;
      document.getElementById('autoActive').textContent = data.active_automations || 0;
      document.getElementById('autoPaused').textContent = data.paused_automations || 0;
      document.getElementById('autoFailures').textContent = data.recent_failures_count || 0;

      const tbody = document.getElementById('autoFailuresTableBody');
      const fails = data.recent_failures || [];
      if (fails.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:20px;color:#10B981;">✓ All automations healthy with 100% successful delivery.</td></tr>`;
        return;
      }

      tbody.innerHTML = fails.map(f => `
        <tr>
          <td><code>${f.event_type}</code></td>
          <td><span class="status-badge ${f.status === 'failed' ? 'suspended' : 'active'}">${f.status?.toUpperCase()}</span></td>
          <td>${f.error_code || f.error_message || 'N/A'}</td>
          <td style="font-size:0.75rem;">${new Date(f.created_at).toLocaleString()}</td>
        </tr>
      `).join('');
    } catch (err) {
      showToast('❌ ' + err.message, 'error');
    }
  }

  // ── 9. Support & Feedback ────────────────────────────────────────────
  async function loadSupport() {
    try {
      const res = await fetch('/api/admin/support', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Failed to load support inquiries');
      const data = await res.json();
      const tbody = document.getElementById('supportTableBody');
      const contacts = data.contacts || [];

      if (contacts.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--ink-muted);">No open customer tickets.</td></tr>`;
        return;
      }

      tbody.innerHTML = contacts.map(c => `
        <tr>
          <td><strong>${c.name || 'Anonymous'}</strong></td>
          <td>${c.email || 'N/A'}</td>
          <td>${c.message || c.subject || 'No message content'}</td>
          <td><span class="status-badge ${c.resolved ? 'active' : 'scheduled'}">${c.resolved ? 'RESOLVED' : 'OPEN'}</span></td>
          <td style="font-size:0.75rem;">${new Date(c.created_at || c.createdAt).toLocaleDateString()}</td>
          <td>
            ${!c.resolved ? `<button class="action-btn resolve-ticket-btn" data-id="${c._id || c.id}">Resolve</button>` : '--'}
          </td>
        </tr>
      `).join('');

      tbody.querySelectorAll('.resolve-ticket-btn').forEach(b => {
        b.addEventListener('click', async () => {
          try {
            const r = await fetch(`/api/admin/support/contacts/${b.dataset.id}/resolve`, {
              method: 'PATCH',
              credentials: 'same-origin'
            });
            if (!r.ok) throw new Error('Failed to resolve inquiry');
            showToast('Ticket marked as resolved.');
            loadSupport();
          } catch (e) { showToast('❌ ' + e.message, 'error'); }
        });
      });
    } catch (err) {
      showToast('❌ ' + err.message, 'error');
    }
  }

  // ── 10. Audit Logs ───────────────────────────────────────────────────
  async function loadAuditLogs() {
    try {
      const res = await fetch('/api/admin/audit-logs?limit=50', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Failed to load audit logs');
      const data = await res.json();
      const tbody = document.getElementById('auditTableBody');
      const logs = data.logs || [];

      if (logs.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--ink-muted);">Audit log is currently empty.</td></tr>`;
        return;
      }

      tbody.innerHTML = logs.map(l => `
        <tr>
          <td style="font-size:0.75rem;white-space:nowrap;">${new Date(l.timestamp).toLocaleString()}</td>
          <td><code>${l.actor}</code></td>
          <td><span class="status-badge scheduled">${l.action}</span></td>
          <td><code>${l.target}</code></td>
          <td style="font-size:0.82rem;">${l.reason || JSON.stringify(l.new_value) || '--'}</td>
        </tr>
      `).join('');
    } catch (err) {
      showToast('❌ ' + err.message, 'error');
    }
  }

  // ── 11. System Settings ──────────────────────────────────────────────
  async function loadSettings() {
    try {
      const res = await fetch('/api/admin/settings', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Failed to load system settings');
      const data = await res.json();

      document.getElementById('sysOwnerEmail').textContent = data.admin_email || '--';
      document.getElementById('sysRazorpayMode').textContent = data.razorpay_mode || '--';
      document.getElementById('sysR2').textContent = data.r2_configured ? 'Cloudflare R2 (Connected)' : 'Not Configured';
      const ownerDisplay = document.getElementById('ownerEmailDisplay');
      if (ownerDisplay) ownerDisplay.textContent = data.admin_email ? data.admin_email.split('@')[0] : 'Owner';
    } catch (err) {
      showToast('❌ ' + err.message, 'error');
    }
  }

  // Refresh Button
  document.getElementById('refreshBtn')?.addEventListener('click', () => {
    loadSectionData(currentSection);
    showToast('Telemetry refreshed!');
  });

  // Utility Debounce
  function debounce(fn, ms) {
    let timeout;
    return function (...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  // Initial Boot
  loadOverview();
  loadSettings();
});
