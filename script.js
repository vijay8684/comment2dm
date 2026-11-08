// ============================================================
// Comment2DM — Client Core Script
// Persistent Auth, Dual-Session Security & Interactive Flows
// ============================================================

(function () {
  // Helper: get authorization headers including fallback localStorage token
  window.getAuthHeaders = function (extraHeaders = {}) {
    const token = localStorage.getItem('comment2dm_token') || localStorage.getItem('nudge_token');
    const headers = { ...extraHeaders };
    if (token) {
      headers['Authorization'] = 'Bearer ' + token;
    }
    return headers;
  };

  // Helper: check session and redirect if already authenticated
  async function checkSession() {
    try {
      const response = await fetch('/api/me', {
        headers: window.getAuthHeaders(),
        credentials: 'same-origin'
      });
      if (response.ok) {
        const data = await response.json().catch(() => ({}));
        if (data.user) {
          // If on login page, redirect to dashboard
          if (window.location.pathname.endsWith('login.html')) {
            window.location.replace('dashboard.html');
            return;
          }
          // If on landing page, update header actions
          const headerActions = document.querySelector('.header-actions');
          if (headerActions) {
            headerActions.innerHTML = '<a href="dashboard.html" class="btn btn-ghost">Dashboard</a><a href="settings.html" class="btn btn-primary">Account</a>';
          }
        }
      } else {
        // If unauthenticated on a protected app page, redirect to login
        if (document.body.classList.contains('app-body') && 
            !window.location.pathname.endsWith('login.html') && 
            !window.location.pathname.endsWith('index.html') &&
            !window.location.pathname.endsWith('pricing.html') &&
            !window.location.pathname.endsWith('privacy.html') &&
            !window.location.pathname.endsWith('terms.html') &&
            !window.location.pathname.endsWith('refund.html') &&
            !window.location.pathname.endsWith('contact.html') &&
            !window.location.pathname.endsWith('404.html')) {
          localStorage.removeItem('comment2dm_token');
          window.location.replace('login.html?tab=login');
        }
      }
    } catch (e) {}
  }

  checkSession();

  // Mobile navigation drawer toggle for public landing pages
  const navToggle = document.getElementById('navToggle');
  const siteHeader = document.querySelector('.site-header');
  if (navToggle && siteHeader) {
    navToggle.addEventListener('click', function () {
      siteHeader.classList.toggle('nav-open');
    });
  }

  // ============================================================
  // AUTHENTICATION INTERACTION SYSTEM (login.html)
  // ============================================================

  let currentAuthEmail = '';
  let activeResetToken = '';
  let signupTimerInterval = null;
  let resetTimerInterval = null;

  function showAuthError(msg) {
    const errorBox = document.getElementById('formError');
    const successBox = document.getElementById('formSuccess');
    if (successBox) {
      successBox.textContent = '';
      successBox.classList.remove('show');
    }
    if (errorBox) {
      if (msg) {
        errorBox.textContent = msg;
        errorBox.classList.add('show');
        errorBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else {
        errorBox.textContent = '';
        errorBox.classList.remove('show');
      }
    }
  }

  function showAuthSuccess(msg) {
    const errorBox = document.getElementById('formError');
    const successBox = document.getElementById('formSuccess');
    if (errorBox) {
      errorBox.textContent = '';
      errorBox.classList.remove('show');
    }
    if (successBox) {
      if (msg) {
        successBox.textContent = msg;
        successBox.classList.add('show');
      } else {
        successBox.textContent = '';
        successBox.classList.remove('show');
      }
    }
  }

  // View Switcher: login | signup | otp | forgot-password
  window.switchAuthTab = function (tab) {
    showAuthError('');
    showAuthSuccess('');

    const loginForm = document.getElementById('loginForm');
    const signupForm = document.getElementById('signupForm');
    const otpView = document.getElementById('otpVerificationView');
    const forgotView = document.getElementById('forgotPasswordView');
    const authTabs = document.getElementById('authTabs');
    const subtitle = document.getElementById('authSubtitle');
    const tabButtons = document.querySelectorAll('.auth-tab-btn');

    if (loginForm) loginForm.style.display = 'none';
    if (signupForm) signupForm.style.display = 'none';
    if (otpView) otpView.style.display = 'none';
    if (forgotView) forgotView.style.display = 'none';

    tabButtons.forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === tab);
    });

    if (tab === 'login') {
      if (authTabs) authTabs.style.display = 'flex';
      if (loginForm) loginForm.style.display = 'block';
      if (subtitle) subtitle.textContent = 'Log in to manage your automations';
    } else if (tab === 'signup') {
      if (authTabs) authTabs.style.display = 'flex';
      if (signupForm) signupForm.style.display = 'block';
      if (subtitle) subtitle.textContent = 'Create your free account in 30 seconds';
    } else if (tab === 'otp') {
      if (authTabs) authTabs.style.display = 'none';
      if (otpView) otpView.style.display = 'block';
      if (subtitle) subtitle.textContent = 'Security verification';
      focusFirstOtpInput('signupOtpGrid');
    } else if (tab === 'forgot-password') {
      if (authTabs) authTabs.style.display = 'none';
      if (forgotView) forgotView.style.display = 'block';
      if (subtitle) subtitle.textContent = 'Account recovery';
      showForgotStep('email');
    }
  };

  // Forgot password step controller
  window.showForgotStep = function (step) {
    showAuthError('');
    const stepEmail = document.getElementById('forgotStepEmail');
    const stepOtp = document.getElementById('forgotStepOtp');
    const stepNewPwd = document.getElementById('forgotStepNewPassword');
    const stepSuccess = document.getElementById('forgotStepSuccess');

    if (stepEmail) stepEmail.style.display = step === 'email' ? 'block' : 'none';
    if (stepOtp) stepOtp.style.display = step === 'otp' ? 'block' : 'none';
    if (stepNewPwd) stepNewPwd.style.display = step === 'new-password' ? 'block' : 'none';
    if (stepSuccess) stepSuccess.style.display = step === 'success' ? 'block' : 'none';

    if (step === 'otp') {
      focusFirstOtpInput('resetOtpGrid');
    }
  };

  // Setup Password Show/Hide Buttons
  document.querySelectorAll('.password-toggle-btn').forEach(btn => {
    btn.addEventListener('click', function () {
      const targetId = btn.getAttribute('data-target');
      const input = document.getElementById(targetId);
      if (!input) return;

      const isPassword = input.type === 'password';
      input.type = isPassword ? 'text' : 'password';

      // Update SVG Icon
      btn.innerHTML = isPassword
        ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
            <line x1="1" y1="1" x2="23" y2="23"></line>
          </svg>`
        : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
            <circle cx="12" cy="12" r="3"></circle>
          </svg>`;
    });
  });

  // Password Strength Evaluator
  function updatePasswordStrength(val) {
    const s1 = document.getElementById('strengthSeg1');
    const s2 = document.getElementById('strengthSeg2');
    const s3 = document.getElementById('strengthSeg3');
    const txt = document.getElementById('strengthText');
    if (!s1 || !s2 || !s3 || !txt) return;

    [s1, s2, s3].forEach(el => {
      el.className = 'strength-segment';
    });

    if (!val || val.length === 0) {
      txt.textContent = 'Too short';
      return;
    }

    let score = 0;
    if (val.length >= 6) score++;
    if (val.length >= 8 && /[0-9]/.test(val)) score++;
    if (val.length >= 10 && /[^a-zA-Z0-9]/.test(val)) score++;

    if (score === 1) {
      s1.classList.add('active-weak');
      txt.textContent = 'Weak';
      txt.style.color = '#f43f5e';
    } else if (score === 2) {
      s1.classList.add('active-medium');
      s2.classList.add('active-medium');
      txt.textContent = 'Medium';
      txt.style.color = '#f59e0b';
    } else if (score >= 3) {
      s1.classList.add('active-strong');
      s2.classList.add('active-strong');
      s3.classList.add('active-strong');
      txt.textContent = 'Strong';
      txt.style.color = '#10b981';
    }
  }

  const signupPwdInput = document.getElementById('signupPassword');
  if (signupPwdInput) {
    signupPwdInput.addEventListener('input', e => updatePasswordStrength(e.target.value));
  }

  // 6-Digit OTP Box Grid Controller
  function setupOtpGrid(gridId, onComplete) {
    const grid = document.getElementById(gridId);
    if (!grid) return;
    const inputs = Array.from(grid.querySelectorAll('.otp-digit-box'));

    inputs.forEach((input, index) => {
      input.addEventListener('input', function (e) {
        const val = input.value.replace(/[^0-9]/g, '');
        input.value = val ? val[val.length - 1] : '';
        input.classList.toggle('filled', input.value !== '');

        if (input.value && index < inputs.length - 1) {
          inputs[index + 1].focus();
        }

        const fullCode = inputs.map(i => i.value).join('');
        if (fullCode.length === 6 && onComplete) {
          onComplete(fullCode);
        }
      });

      input.addEventListener('keydown', function (e) {
        if (e.key === 'Backspace') {
          if (!input.value && index > 0) {
            inputs[index - 1].focus();
            inputs[index - 1].value = '';
            inputs[index - 1].classList.remove('filled');
          } else {
            input.value = '';
            input.classList.remove('filled');
          }
        } else if (e.key === 'ArrowLeft' && index > 0) {
          inputs[index - 1].focus();
        } else if (e.key === 'ArrowRight' && index < inputs.length - 1) {
          inputs[index + 1].focus();
        }
      });

      input.addEventListener('paste', function (e) {
        e.preventDefault();
        const text = (e.clipboardData || window.clipboardData).getData('text');
        const digits = text.replace(/[^0-9]/g, '').slice(0, 6);
        if (!digits) return;

        digits.split('').forEach((d, i) => {
          if (inputs[i]) {
            inputs[i].value = d;
            inputs[i].classList.add('filled');
          }
        });

        const focusTarget = Math.min(digits.length, inputs.length - 1);
        inputs[focusTarget].focus();

        const fullCode = inputs.map(i => i.value).join('');
        if (fullCode.length === 6 && onComplete) {
          onComplete(fullCode);
        }
      });
    });
  }

  function focusFirstOtpInput(gridId) {
    const grid = document.getElementById(gridId);
    if (!grid) return;
    const first = grid.querySelector('.otp-digit-box');
    if (first) {
      setTimeout(() => first.focus(), 100);
    }
  }

  function clearOtpGrid(gridId) {
    const grid = document.getElementById(gridId);
    if (!grid) return;
    grid.querySelectorAll('.otp-digit-box').forEach(i => {
      i.value = '';
      i.classList.remove('filled');
    });
  }

  function startCountdownTimer(type, seconds = 60) {
    let remaining = seconds;
    const isSignup = type === 'signup';
    const timerSpan = document.getElementById(isSignup ? 'otpTimerSeconds' : 'resetTimerSeconds');
    const countdownText = document.getElementById(isSignup ? 'otpCountdownText' : 'resetCountdownText');
    const resendBtn = document.getElementById(isSignup ? 'resendOtpBtn' : 'resendResetOtpBtn');

    if (isSignup && signupTimerInterval) clearInterval(signupTimerInterval);
    if (!isSignup && resetTimerInterval) clearInterval(resetTimerInterval);

    if (resendBtn) resendBtn.disabled = true;
    if (countdownText) countdownText.style.display = 'inline';
    if (timerSpan) timerSpan.textContent = remaining;

    const interval = setInterval(() => {
      remaining -= 1;
      if (timerSpan) timerSpan.textContent = remaining;
      if (remaining <= 0) {
        clearInterval(interval);
        if (countdownText) countdownText.style.display = 'none';
        if (resendBtn) resendBtn.disabled = false;
      }
    }, 1000);

    if (isSignup) signupTimerInterval = interval;
    else resetTimerInterval = interval;
  }

  // Initialize OTP Grids
  setupOtpGrid('signupOtpGrid', fullCode => {
    // Auto-trigger OTP submit when 6 digits are typed
    const otpForm = document.getElementById('otpForm');
    if (otpForm) otpForm.dispatchEvent(new Event('submit'));
  });

  setupOtpGrid('resetOtpGrid', fullCode => {
    const forgotOtpForm = document.getElementById('forgotOtpForm');
    if (forgotOtpForm) forgotOtpForm.dispatchEvent(new Event('submit'));
  });

  // Handle Tab Switch Buttons Click
  const authTabsContainer = document.getElementById('authTabs');
  if (authTabsContainer) {
    authTabsContainer.addEventListener('click', function (e) {
      const btn = e.target.closest('.auth-tab-btn');
      if (btn) switchAuthTab(btn.getAttribute('data-tab'));
    });

    const params = new URLSearchParams(window.location.search);
    if (params.get('tab') === 'signup') {
      switchAuthTab('signup');
    }
    if (params.get('auth_error')) {
      showAuthError(params.get('auth_error'));
    }
  }

  // Forgot password trigger link on login form
  const forgotTrigger = document.getElementById('forgotPasswordTrigger');
  if (forgotTrigger) {
    forgotTrigger.addEventListener('click', () => switchAuthTab('forgot-password'));
  }

  // ============================================================
  // FORM SUBMISSION HANDLERS
  // ============================================================

  // 1. LOGIN SUBMIT
  const loginForm = document.getElementById('loginForm');
  if (loginForm) {
    loginForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      showAuthError('');

      const email = document.getElementById('loginEmail').value.trim();
      const password = document.getElementById('loginPassword').value;
      const remember = document.getElementById('loginRemember').checked;
      const submitBtn = document.getElementById('loginSubmitBtn');

      if (!email || !password) {
        showAuthError('Please enter your email and password.');
        return;
      }

      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span class="btn-spinner"></span><span>Signing in…</span>';

      try {
        const response = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ email, password, remember })
        });
        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
          // Check for unverified account redirect
          if (response.status === 403 && data.requireVerification) {
            currentAuthEmail = data.email || email;
            const displayEl = document.getElementById('verifyEmailDisplay');
            if (displayEl) displayEl.textContent = currentAuthEmail;
            clearOtpGrid('signupOtpGrid');
            switchAuthTab('otp');
            startCountdownTimer('signup', 60);
            showAuthSuccess('A verification code has been dispatched to your email.');
            submitBtn.disabled = false;
            submitBtn.innerHTML = '<span>Log in to Comment2DM</span>';
            return;
          }

          showAuthError(data.error || 'Invalid email or password.');
          submitBtn.disabled = false;
          submitBtn.innerHTML = '<span>Log in to Comment2DM</span>';
          return;
        }

        if (data.sessionToken) {
          localStorage.setItem('comment2dm_token', data.sessionToken);
        }

        window.location.replace('dashboard.html');
      } catch (err) {
        showAuthError('Unable to sign in right now. Please check your network connection.');
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<span>Log in to Comment2DM</span>';
      }
    });
  }

  // 2. SIGNUP SUBMIT
  const signupForm = document.getElementById('signupForm');
  if (signupForm) {
    signupForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      showAuthError('');

      const name = document.getElementById('signupName').value.trim();
      const email = document.getElementById('signupEmail').value.trim();
      const password = document.getElementById('signupPassword').value;
      const confirmPassword = document.getElementById('signupConfirmPassword').value;
      const terms = document.getElementById('signupTerms').checked;
      const submitBtn = document.getElementById('signupSubmitBtn');

      if (!name || name.length < 2) {
        showAuthError('Please enter your full name.');
        return;
      }
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        showAuthError('Please enter a valid email address.');
        return;
      }
      if (!password || password.length < 6) {
        showAuthError('Password must be at least 6 characters.');
        return;
      }
      if (password !== confirmPassword) {
        showAuthError('Passwords do not match. Please verify both fields.');
        return;
      }
      if (!terms) {
        showAuthError('Please agree to the Terms of Service & Privacy Policy.');
        return;
      }

      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span class="btn-spinner"></span><span>Creating account…</span>';

      try {
        const response = await fetch('/api/auth/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ name, email, password, terms })
        });
        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
          showAuthError(data.error || 'Failed to create account.');
          submitBtn.disabled = false;
          submitBtn.innerHTML = '<span>Create Free Comment2DM Account</span>';
          return;
        }

        currentAuthEmail = email;
        const displayEl = document.getElementById('verifyEmailDisplay');
        if (displayEl) displayEl.textContent = email;

        clearOtpGrid('signupOtpGrid');
        switchAuthTab('otp');
        startCountdownTimer('signup', 60);
        showAuthSuccess('Account created! Enter the 6-digit verification code sent to your email.');

        submitBtn.disabled = false;
        submitBtn.innerHTML = '<span>Create Free Comment2DM Account</span>';
      } catch (err) {
        showAuthError('Unable to create account right now. Please try again.');
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<span>Create Free Comment2DM Account</span>';
      }
    });
  }

  // 3. SIGNUP OTP SUBMIT
  const otpForm = document.getElementById('otpForm');
  if (otpForm) {
    otpForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      showAuthError('');

      const grid = document.getElementById('signupOtpGrid');
      const inputs = Array.from(grid.querySelectorAll('.otp-digit-box'));
      const otp = inputs.map(i => i.value).join('');
      const submitBtn = document.getElementById('otpSubmitBtn');

      if (otp.length < 6) {
        showAuthError('Please enter all 6 digits of your verification code.');
        return;
      }

      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span class="btn-spinner"></span><span>Verifying…</span>';

      try {
        const response = await fetch('/api/auth/verify-otp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ email: currentAuthEmail, otp, remember: true })
        });
        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
          showAuthError(data.error || 'Invalid or expired verification code.');
          submitBtn.disabled = false;
          submitBtn.innerHTML = '<span>Verify & Continue</span>';
          return;
        }

        if (data.sessionToken) {
          localStorage.setItem('comment2dm_token', data.sessionToken);
        }

        window.location.replace('dashboard.html');
      } catch (err) {
        showAuthError('Verification failed. Please try again.');
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<span>Verify & Continue</span>';
      }
    });

    // Resend Signup OTP
    const resendBtn = document.getElementById('resendOtpBtn');
    if (resendBtn) {
      resendBtn.addEventListener('click', async function () {
        resendBtn.disabled = true;
        try {
          const res = await fetch('/api/auth/resend-otp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ email: currentAuthEmail, type: 'signup' })
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok) {
            showAuthSuccess('A new 6-digit code has been sent to your inbox.');
            startCountdownTimer('signup', 60);
          } else {
            showAuthError(data.error || 'Unable to resend verification code right now.');
            resendBtn.disabled = false;
          }
        } catch (err) {
          showAuthError('Network error while resending code.');
          resendBtn.disabled = false;
        }
      });
    }
  }

  // 4. FORGOT PASSWORD STEP A: REQUEST OTP
  const forgotEmailForm = document.getElementById('forgotEmailForm');
  if (forgotEmailForm) {
    forgotEmailForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      showAuthError('');

      const email = document.getElementById('forgotEmailInput').value.trim();
      const submitBtn = document.getElementById('forgotEmailSubmitBtn');

      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        showAuthError('Please enter a valid email address.');
        return;
      }

      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span class="btn-spinner"></span><span>Sending code…</span>';

      try {
        const response = await fetch('/api/auth/forgot-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ email })
        });
        const data = await response.json().catch(() => ({}));

        currentAuthEmail = email;
        const displayEl = document.getElementById('resetEmailDisplay');
        if (displayEl) displayEl.textContent = email;

        clearOtpGrid('resetOtpGrid');
        showForgotStep('otp');
        startCountdownTimer('reset', 60);
        showAuthSuccess(data.message || 'If an account exists, a 6-digit code has been dispatched.');

        submitBtn.disabled = false;
        submitBtn.innerHTML = '<span>Send Verification Code</span>';
      } catch (err) {
        showAuthError('Unable to process request. Please try again.');
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<span>Send Verification Code</span>';
      }
    });
  }

  // 5. FORGOT PASSWORD STEP B: VERIFY OTP
  const forgotOtpForm = document.getElementById('forgotOtpForm');
  if (forgotOtpForm) {
    forgotOtpForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      showAuthError('');

      const grid = document.getElementById('resetOtpGrid');
      const inputs = Array.from(grid.querySelectorAll('.otp-digit-box'));
      const otp = inputs.map(i => i.value).join('');
      const submitBtn = document.getElementById('forgotOtpSubmitBtn');

      if (otp.length < 6) {
        showAuthError('Please enter all 6 digits of your reset code.');
        return;
      }

      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span class="btn-spinner"></span><span>Verifying…</span>';

      try {
        const response = await fetch('/api/auth/verify-reset-otp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ email: currentAuthEmail, otp })
        });
        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
          showAuthError(data.error || 'Invalid or expired reset code.');
          submitBtn.disabled = false;
          submitBtn.innerHTML = '<span>Verify Code</span>';
          return;
        }

        activeResetToken = data.resetToken;
        showForgotStep('new-password');
        showAuthSuccess('Code verified! Please enter your new password.');

        submitBtn.disabled = false;
        submitBtn.innerHTML = '<span>Verify Code</span>';
      } catch (err) {
        showAuthError('Verification error. Please try again.');
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<span>Verify Code</span>';
      }
    });

    // Resend Reset OTP
    const resendResetBtn = document.getElementById('resendResetOtpBtn');
    if (resendResetBtn) {
      resendResetBtn.addEventListener('click', async function () {
        resendResetBtn.disabled = true;
        try {
          const res = await fetch('/api/auth/resend-otp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ email: currentAuthEmail, type: 'reset_password' })
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok) {
            showAuthSuccess('A new 6-digit reset code has been sent.');
            startCountdownTimer('reset', 60);
          } else {
            showAuthError(data.error || 'Unable to resend reset code.');
            resendResetBtn.disabled = false;
          }
        } catch (err) {
          showAuthError('Network error while resending code.');
          resendResetBtn.disabled = false;
        }
      });
    }
  }

  // 6. FORGOT PASSWORD STEP C: SUBMIT NEW PASSWORD
  const forgotNewPasswordForm = document.getElementById('forgotNewPasswordForm');
  if (forgotNewPasswordForm) {
    forgotNewPasswordForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      showAuthError('');

      const newPassword = document.getElementById('resetNewPassword').value;
      const confirmPassword = document.getElementById('resetConfirmPassword').value;
      const submitBtn = document.getElementById('resetNewPasswordSubmitBtn');

      if (!newPassword || newPassword.length < 6) {
        showAuthError('Password must be at least 6 characters.');
        return;
      }
      if (newPassword !== confirmPassword) {
        showAuthError('Passwords do not match.');
        return;
      }

      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span class="btn-spinner"></span><span>Updating password…</span>';

      try {
        const response = await fetch('/api/auth/reset-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ resetToken: activeResetToken, newPassword })
        });
        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
          showAuthError(data.error || 'Failed to update password.');
          submitBtn.disabled = false;
          submitBtn.innerHTML = '<span>Update Password & Log In</span>';
          return;
        }

        activeResetToken = '';
        showForgotStep('success');

        submitBtn.disabled = false;
        submitBtn.innerHTML = '<span>Update Password & Log In</span>';
      } catch (err) {
        showAuthError('Unable to update password. Please try again.');
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<span>Update Password & Log In</span>';
      }
    });
  }

  // ============================================================
  // PRICING PAGE TOGGLE
  // ============================================================
  const pricingToggle = document.getElementById('pricingToggle');
  if (pricingToggle) {
    const buttons = pricingToggle.querySelectorAll('button');
    buttons.forEach(btn => {
      btn.addEventListener('click', function () {
        buttons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const cycle = btn.getAttribute('data-cycle');
        document.querySelectorAll('.price-monthly').forEach(el => {
          el.style.display = cycle === 'monthly' ? '' : 'none';
        });
        document.querySelectorAll('.price-annual').forEach(el => {
          el.style.display = cycle === 'annual' ? '' : 'none';
        });
        document.querySelectorAll('[data-plan-button]').forEach(link => {
          const plan = link.getAttribute('data-plan-button');
          link.href = 'billing.html?plan=' + encodeURIComponent(plan) + '&billing=' + cycle;
        });
      });
    });
  }
})();
