// settings.js — Comment2DM Settings Page
(function () {
  'use strict';

  let stagedAvatarDataUrl = null;
  let cachedNotificationPrefs = null;

  // ── Toast ──────────────────────────────────────────────────────────────────
  function showToast(msg, type = 'success') {
    const c = document.getElementById('toastContainer');
    if (!c) return;
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = msg;
    c.appendChild(t);
    requestAnimationFrame(() => { t.classList.add('show'); });
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3500);
  }

  // ── Tab switching with URL hash support ─────────────────────────────────────
  function switchTab(panelName) {
    const tab = document.querySelector(`.settings-tab[data-panel="${panelName}"]`);
    const panel = document.getElementById('panel-' + panelName);
    if (!tab || !panel) return;
    document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.settings-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    panel.classList.add('active');
  }

  document.querySelectorAll('.settings-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const panelName = tab.dataset.panel;
      switchTab(panelName);
      if (history.replaceState) {
        history.replaceState(null, '', '#' + panelName);
      }
    });
  });

  // Check URL hash on page load
  const initialHash = (window.location.hash || '').replace('#', '');
  if (['profile', 'security', 'notifications', 'billing', 'danger'].includes(initialHash)) {
    switchTab(initialHash);
  }

  // ── Password show/hide ─────────────────────────────────────────────────────
  document.querySelectorAll('.pw-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.target);
      if (!input) return;
      input.type = input.type === 'password' ? 'text' : 'password';
      btn.textContent = input.type === 'password' ? '👁' : '🙈';
    });
  });

  // ── Bio char counter ───────────────────────────────────────────────────────
  const bioField = document.getElementById('profileBio');
  const bioCount = document.getElementById('bioCount');
  if (bioField && bioCount) {
    bioField.addEventListener('input', () => { bioCount.textContent = bioField.value.length; });
  }

  // ── Avatar selection & client-side compression ──────────────────────────────
  document.getElementById('avatarBtn')?.addEventListener('click', () => {
    document.getElementById('avatarFileInput')?.click();
  });

  document.getElementById('avatarFileInput')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const validTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!validTypes.includes(file.type)) {
      showToast('❌ Unsupported format. Please select a JPEG, PNG, or WebP image.', 'error');
      return;
    }

    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          let width = img.width;
          let height = img.height;
          const maxSide = 160;

          if (width > maxSide || height > maxSide) {
            if (width > height) {
              height = Math.round((height * maxSide) / width);
              width = maxSide;
            } else {
              width = Math.round((width * maxSide) / height);
              height = maxSide;
            }
          }

          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);

          let dataUrl = canvas.toDataURL('image/jpeg', 0.8);
          // If payload is over ~40KB (55,000 base64 chars), recompress
          if (dataUrl.length > 55000) {
            dataUrl = canvas.toDataURL('image/jpeg', 0.6);
          }

          stagedAvatarDataUrl = dataUrl;
          const preview = document.getElementById('avatarPreview');
          if (preview) {
            preview.style.backgroundImage = `url(${dataUrl})`;
            preview.style.backgroundSize = 'cover';
            preview.style.backgroundPosition = 'center';
            preview.textContent = '';
          }
        } catch (canvasErr) {
          showToast('❌ Unable to process image. Please try a different file.', 'error');
        }
      };
      img.onerror = () => {
        showToast('❌ Failed to load image file.', 'error');
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });

  // ── Load user profile data ─────────────────────────────────────────────────
  async function loadUser() {
    try {
      const res = await fetch('/api/settings', {
        headers: window.getAuthHeaders ? window.getAuthHeaders() : {},
        credentials: 'same-origin'
      });
      if (!res.ok) {
        showToast('⚠️ Could not load profile details from server.', 'error');
        return;
      }
      const data = await res.json();
      const user = data.user || {};

      const nameEl = document.getElementById('profileName');
      const emailEl = document.getElementById('profileEmail');
      const phoneEl = document.getElementById('profilePhone');
      const bioEl = document.getElementById('profileBio');
      const avatarEl = document.getElementById('avatarPreview');

      if (nameEl) nameEl.value = user.name || '';
      if (emailEl) emailEl.value = user.email || '';
      if (phoneEl) phoneEl.value = user.phone || '';
      if (bioEl) {
        bioEl.value = user.bio || '';
        if (bioCount) bioCount.textContent = bioEl.value.length;
      }

      if (avatarEl) {
        if (user.avatarUrl) {
          avatarEl.style.backgroundImage = `url(${user.avatarUrl})`;
          avatarEl.style.backgroundSize = 'cover';
          avatarEl.style.backgroundPosition = 'center';
          avatarEl.textContent = '';
        } else {
          avatarEl.style.backgroundImage = 'none';
          avatarEl.textContent = (user.name || user.email || 'U')[0].toUpperCase();
        }
      }

      // Handle OAuth user security restrictions
      if (user.isOAuth || user.hasPassword === false) {
        const oauthNotice = document.getElementById('oauthNotice');
        if (oauthNotice) oauthNotice.style.display = 'block';

        const pwForm = document.getElementById('passwordForm');
        if (pwForm) {
          pwForm.querySelectorAll('input').forEach(inp => {
            inp.disabled = true;
            inp.style.opacity = '0.5';
            inp.style.cursor = 'not-allowed';
          });
          const updateBtn = document.getElementById('updatePasswordBtn');
          if (updateBtn) {
            updateBtn.disabled = true;
            updateBtn.style.opacity = '0.5';
            updateBtn.style.cursor = 'not-allowed';
            updateBtn.title = 'Password change unavailable for OAuth accounts';
          }
        }
      }

      // Load notification preferences from server response
      if (data.preferences) {
        cachedNotificationPrefs = data.preferences;
        applyNotificationPrefs(data.preferences);
      }
    } catch (err) {
      console.error('Failed to load settings:', err);
      showToast('❌ Network error loading profile.', 'error');
    }
  }

  // ── Apply Notification Preferences ─────────────────────────────────────────
  function applyNotificationPrefs(prefs) {
    if (!prefs) return;
    ['dm_sent', 'failed', 'weekly', 'billing'].forEach(k => {
      const el = document.getElementById(`notif_${k}`);
      if (el && prefs[k] !== undefined) {
        el.checked = Boolean(prefs[k]);
      }
    });
  }

  // ── Load billing info ──────────────────────────────────────────────────────
  async function loadBilling() {
    try {
      const res = await fetch('/api/billing/status', {
        headers: window.getAuthHeaders ? window.getAuthHeaders() : {},
        credentials: 'same-origin'
      });
      if (!res.ok) return;
      const data = await res.json();
      const plan = String(data.plan || 'free').toLowerCase();
      const planName = plan.charAt(0).toUpperCase() + plan.slice(1);

      const used = data.usage?.dmMonthly || 0;
      const isUnlimited = data.isAdmin || data.limits?.dmMonthly === null || data.limits?.dmMonthly === Infinity;
      const limit = isUnlimited ? 'Unlimited' : (data.limits?.dmMonthly || (plan === 'elite' ? 50000 : plan === 'pro' ? 5000 : 300));
      const pct = isUnlimited ? 0 : Math.min(100, Math.round((used / (typeof limit === 'number' ? limit : 300)) * 100));

      const pn = document.getElementById('billingPlanName');
      const bb = document.getElementById('billingBadge');
      const bu = document.getElementById('billingDmUsage');
      const bar = document.getElementById('billingDmBar');

      if (pn) pn.textContent = planName;
      if (bb) {
        bb.textContent = plan.toUpperCase();
        bb.className = `plan-badge ${plan}`;
      }
      if (bu) bu.textContent = `${used.toLocaleString()} / ${typeof limit === 'number' ? limit.toLocaleString() : limit}`;
      if (bar) bar.style.width = pct + '%';
    } catch (err) {
      console.error('Failed to load billing status:', err);
    }
  }

  // ── Save profile ───────────────────────────────────────────────────────────
  document.getElementById('profileForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('saveProfileBtn');
    if (btn) { btn.textContent = 'Saving…'; btn.disabled = true; }

    try {
      const body = {
        name: document.getElementById('profileName')?.value.trim(),
        phone: document.getElementById('profilePhone')?.value.trim(),
        bio: document.getElementById('profileBio')?.value.trim()
      };

      if (stagedAvatarDataUrl) {
        body.avatarUrl = stagedAvatarDataUrl;
      }

      const res = await fetch('/api/settings/profile', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(window.getAuthHeaders ? window.getAuthHeaders() : {})
        },
        credentials: 'same-origin',
        body: JSON.stringify(body)
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to update profile');

      stagedAvatarDataUrl = null;
      showToast('✅ Profile saved successfully!');
    } catch (err) {
      showToast('❌ ' + err.message, 'error');
    } finally {
      if (btn) { btn.textContent = 'Save Changes'; btn.disabled = false; }
    }
  });

  // ── Change password ────────────────────────────────────────────────────────
  document.getElementById('passwordForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const current = document.getElementById('currentPw')?.value;
    const newPw = document.getElementById('newPw')?.value;
    const confirm = document.getElementById('confirmPw')?.value;

    if (!current || !newPw || !confirm) {
      showToast('❌ Please fill in all password fields.', 'error');
      return;
    }
    if (newPw !== confirm) {
      showToast('❌ Passwords do not match', 'error');
      return;
    }
    if (newPw.length < 8) {
      showToast('❌ Password must be at least 8 characters', 'error');
      return;
    }
    if (newPw.length > 128) {
      showToast('❌ Password cannot exceed 128 characters', 'error');
      return;
    }

    const btn = document.getElementById('updatePasswordBtn');
    if (btn) { btn.textContent = 'Updating Password…'; btn.disabled = true; }

    try {
      const res = await fetch('/api/settings/password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(window.getAuthHeaders ? window.getAuthHeaders() : {})
        },
        credentials: 'same-origin',
        body: JSON.stringify({ currentPassword: current, newPassword: newPw })
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to update password');

      showToast('🔒 Password updated successfully!');
      document.getElementById('passwordForm').reset();
    } catch (err) {
      showToast('❌ ' + err.message, 'error');
    } finally {
      if (btn) { btn.textContent = 'Update Password'; btn.disabled = false; }
    }
  });

  // ── Notifications ──────────────────────────────────────────────────────────
  document.getElementById('saveNotifBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('saveNotifBtn');
    if (btn) { btn.textContent = 'Saving…'; btn.disabled = true; }

    const prefs = {
      dm_sent: document.getElementById('notif_dm_sent')?.checked || false,
      failed: document.getElementById('notif_failed')?.checked || false,
      weekly: document.getElementById('notif_weekly')?.checked || false,
      billing: document.getElementById('notif_billing')?.checked || false
    };

    try {
      const res = await fetch('/api/settings/notifications', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(window.getAuthHeaders ? window.getAuthHeaders() : {})
        },
        credentials: 'same-origin',
        body: JSON.stringify(prefs)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to save preferences');

      cachedNotificationPrefs = prefs;
      localStorage.setItem('c2dm_notif_prefs', JSON.stringify(prefs));
      showToast('🔔 Notification preferences saved!');
    } catch (err) {
      showToast('❌ ' + err.message, 'error');
    } finally {
      if (btn) { btn.textContent = 'Save Preferences'; btn.disabled = false; }
    }
  });

  // ── Delete account ─────────────────────────────────────────────────────────
  document.getElementById('deleteAccountBtn')?.addEventListener('click', () => {
    const modal = document.getElementById('deleteModal');
    if (modal) modal.classList.add('open');
    const inp = document.getElementById('deleteConfirmInput');
    if (inp) {
      inp.value = '';
      inp.focus();
    }
  });

  document.getElementById('cancelDeleteBtn')?.addEventListener('click', () => {
    document.getElementById('deleteModal')?.classList.remove('open');
  });

  document.getElementById('confirmDeleteBtn')?.addEventListener('click', async () => {
    const inp = document.getElementById('deleteConfirmInput');
    const val = inp?.value?.trim();
    if (val !== 'DELETE') {
      showToast('❌ Type DELETE exactly to confirm', 'error');
      return;
    }

    const btn = document.getElementById('confirmDeleteBtn');
    if (btn) {
      btn.textContent = 'Deleting account…';
      btn.disabled = true;
    }

    try {
      const res = await fetch('/api/account/delete', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          ...(window.getAuthHeaders ? window.getAuthHeaders() : {})
        },
        credentials: 'same-origin',
        body: JSON.stringify({ confirmation: 'DELETE' })
      });

      const data = await res.json().catch(() => ({}));
      if (res.status === 409) {
        throw new Error(data.error || 'Active subscription detected. Please cancel your subscription in Billing before deleting your account.');
      }
      if (!res.ok) {
        throw new Error(data.error || 'Failed to delete account');
      }

      showToast('👋 Account deleted successfully.');
      localStorage.clear();
      setTimeout(() => {
        window.location.href = 'index.html';
      }, 500);
    } catch (err) {
      showToast('❌ ' + err.message, 'error');
      if (btn) {
        btn.textContent = 'Yes, delete my account';
        btn.disabled = false;
      }
    }
  });

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    loadUser();
    loadBilling();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
