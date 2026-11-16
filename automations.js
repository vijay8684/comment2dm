// ============================================================
// Comment2DM — Automations Studio & Workflow Engine
// Single Reel/Post Flow, Keyword Chips, Multi-Step Conversation Builder,
// Resource Attachments & Real-Time Interaction Simulator
// ============================================================

(function () {
  // Application State
  let userAccounts = [];
  let userAutomations = [];
  let isEntryGated = false;
  let userEmail = '';
  let loadedReels = [];
  let selectedReel = null;
  let keywordsList = ['LINK'];
  let currentResourceType = 'url';
  let uploadedResourceData = null;
  let userPlan = 'free';
  let pendingDeleteId = null;

  // DOM Elements - Shell & Navigation
  const openCreateBtn = document.getElementById('openCreateBtn');
  const createFirstBtn = document.getElementById('createFirstBtn');
  const cancelFormBtn = document.getElementById('cancelFormBtn');
  const cancelFormBtn2 = document.getElementById('cancelFormBtn2');
  const automationFormCard = document.getElementById('automationFormCard');
  const automationsListGrid = document.getElementById('automationsListGrid');
  const automationsEmptyState = document.getElementById('automationsEmptyState');
  const noAccountWarning = document.getElementById('noAccountWarning');
  const automationForm = document.getElementById('automationForm');
  const accountSelect = document.getElementById('automationAccountSelect');
  const saveBtn = document.getElementById('saveAutomationBtn');
  const noticeBox = document.getElementById('automationNotice');
  const errorBox = document.getElementById('dashboardError');

  // Reel Picker Elements
  const reelPickerGrid = document.getElementById('reelPickerGrid');
  const refreshReelsBtn = document.getElementById('refreshReelsBtn');
  const refreshReelsIcon = document.getElementById('refreshReelsIcon');
  const reelsCountLabel = document.getElementById('reelsCountLabel');
  const reelGalleryError = document.getElementById('reelGalleryError');
  const retryReelsBtn = document.getElementById('retryReelsBtn');
  const selectedReelPreview = document.getElementById('selectedReelPreview');
  const selectedReelThumb = document.getElementById('selectedReelThumb');
  const selectedReelCaption = document.getElementById('selectedReelCaption');
  const selectedReelPermalink = document.getElementById('selectedReelPermalink');
  const selectedReelIdTag = document.getElementById('selectedReelIdTag');
  const clearReelSelectionBtn = document.getElementById('clearReelSelectionBtn');

  // Hidden Inputs
  const automationIdInput = document.getElementById('automationId');
  const selectedMediaIdInput = document.getElementById('selectedMediaId');
  const selectedMediaUrlInput = document.getElementById('selectedMediaUrl');
  const selectedMediaTitleInput = document.getElementById('selectedMediaTitle');
  const selectedMediaThumbnailInput = document.getElementById('selectedMediaThumbnail');
  const selectedMediaTypeInput = document.getElementById('selectedMediaType');

  // Trigger Inputs
  const triggerKeywordRadio = document.getElementById('triggerKeywordRadio');
  const triggerAllRadio = document.getElementById('triggerAllRadio');
  const keywordInputGroup = document.getElementById('keywordInputGroup');
  const keywordChipsContainer = document.getElementById('keywordChipsContainer');
  const keywordChipInput = document.getElementById('keywordChipInput');

  // Conversation Flow Inputs
  const openingMessageInput = document.getElementById('openingMessageInput');
  const openingButtonInput = document.getElementById('openingButtonInput');
  const followGateToggle = document.getElementById('followGateToggle');
  const followGateDisabledView = document.getElementById('followGateDisabledView');
  const followGateEnabledView = document.getElementById('followGateEnabledView');
  const followGateMessageInput = document.getElementById('followGateMessageInput');
  const followGateProfileBtnInput = document.getElementById('followGateProfileBtnInput');
  const followGateConfirmBtnInput = document.getElementById('followGateConfirmBtnInput');
  const followGateRetryMsgInput = document.getElementById('followGateRetryMsgInput');
  const deliveryMessageInput = document.getElementById('deliveryMessageInput');
  const deliveryUrlInput = document.getElementById('deliveryUrlInput');
  const deliveryButtonInput = document.getElementById('deliveryButtonInput');
  const resUrlPanel = document.getElementById('resUrlPanel');
  const resUploadPanel = document.getElementById('resUploadPanel');
  const resUrlLabel = document.getElementById('resUrlLabel');
  const resDriveNotice = document.getElementById('resDriveNotice');
  const resourceFileInput = document.getElementById('resourceFileInput');
  const uploadDropzone = document.getElementById('uploadDropzone');
  const uploadedFileCard = document.getElementById('uploadedFileCard');
  const uploadedFileName = document.getElementById('uploadedFileName');
  const uploadedFileSize = document.getElementById('uploadedFileSize');
  const removeUploadedFileBtn = document.getElementById('removeUploadedFileBtn');

  // Public Reply & Status Inputs
  const publicReplyToggle = document.getElementById('publicReplyToggle');
  const publicReplyInputWrap = document.getElementById('publicReplyInputWrap');
  const automationPublicReplyInput = document.getElementById('automationPublicReplyInput');
  const automationEnabledCheckbox = document.getElementById('automationEnabledCheckbox');

  // Simulator Elements
  let currentSimScenario = 'following'; // 'following' | 'not_following'
  const simScenarioSwitcher = document.getElementById('simScenarioSwitcher');
  const simScenarioFollowingBtn = document.getElementById('simScenarioFollowingBtn');
  const simScenarioNotFollowingBtn = document.getElementById('simScenarioNotFollowingBtn');
  const simActiveScenarioBadge = document.getElementById('simActiveScenarioBadge');
  const simReelThumb = document.getElementById('simReelThumb');
  const simReelTitle = document.getElementById('simReelTitle');
  const simAccountHandle = document.getElementById('simAccountHandle');
  const simComment = document.getElementById('simCommentDisplay');
  const simPublicReply = document.getElementById('simPublicReplyDisplay');
  const simOpeningDm = document.getElementById('simOpeningDmDisplay');
  const simOpeningDmText = document.getElementById('simOpeningDmText');
  const simOpeningBtn = document.getElementById('simOpeningBtnDisplay');
  const simUserTapDisplay = document.getElementById('simUserTapDisplay');
  const simGateDisplay = document.getElementById('simGateDisplay');
  const simGateMsgDisplay = document.getElementById('simGateMsgDisplay');
  const simGateProfileBtn = document.getElementById('simGateProfileBtn');
  const simGateConfirmBtn = document.getElementById('simGateConfirmBtn');
  const simUserConfirmTapDisplay = document.getElementById('simUserConfirmTapDisplay');
  const simDeliveryDisplay = document.getElementById('simDeliveryDisplay');
  const simDeliveryMsgText = document.getElementById('simDeliveryMsgText');
  const simDeliveryBtn = document.getElementById('simDeliveryBtnDisplay');
  const simBrandingTag = document.getElementById('simBrandingTag');

  // Delete Modal Elements
  const deleteModal = document.getElementById('deleteAutomationModal');
  const cancelDeleteBtn = document.getElementById('cancelDeleteBtn');
  const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');

  // Notice & Error Helpers
  function showNotice(msg) {
    if (!noticeBox) return;
    noticeBox.innerHTML = `✓ ${escapeHtml(msg)}`;
    noticeBox.style.display = 'block';
    setTimeout(() => { noticeBox.style.display = 'none'; }, 5000);
  }

  function showError(msg) {
    if (!errorBox) return;
    errorBox.innerHTML = `⚠️ ${escapeHtml(msg)}`;
    errorBox.style.display = 'block';
    errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => { errorBox.style.display = 'none'; }, 6000);
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

  // ==========================================
  // Keyword Chips Management
  // ==========================================
  function renderKeywordChips() {
    // Remove existing chip tags, preserve input
    const chips = keywordChipsContainer.querySelectorAll('.keyword-chip');
    chips.forEach(c => c.remove());

    keywordsList.forEach((kw, index) => {
      const chip = document.createElement('span');
      chip.className = 'keyword-chip';
      chip.innerHTML = `
        <span>${escapeHtml(kw)}</span>
        <button type="button" class="keyword-chip-remove" title="Remove keyword">✕</button>
      `;

      chip.querySelector('.keyword-chip-remove').addEventListener('click', (e) => {
        e.stopPropagation();
        keywordsList.splice(index, 1);
        renderKeywordChips();
        updateSimulator();
      });

      keywordChipsContainer.insertBefore(chip, keywordChipInput);
    });
  }

  function addKeywordFromInput() {
    const raw = keywordChipInput.value.trim();
    if (!raw) return;

    // Support comma-separated batch input
    const parts = raw.split(/[,]+/);
    parts.forEach(part => {
      const cleaned = part.trim().toUpperCase();
      if (cleaned && !keywordsList.includes(cleaned)) {
        keywordsList.push(cleaned);
      }
    });

    keywordChipInput.value = '';
    renderKeywordChips();
    updateSimulator();
  }

  if (keywordChipInput) {
    keywordChipInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        addKeywordFromInput();
      } else if (e.key === 'Backspace' && keywordChipInput.value === '' && keywordsList.length > 0) {
        keywordsList.pop();
        renderKeywordChips();
        updateSimulator();
      }
    });

    keywordChipInput.addEventListener('blur', () => {
      addKeywordFromInput();
    });
  }

  // Trigger Radios
  if (triggerKeywordRadio && triggerAllRadio) {
    triggerKeywordRadio.addEventListener('change', () => {
      keywordInputGroup.style.display = 'block';
      updateSimulator();
    });

    triggerAllRadio.addEventListener('change', () => {
      if (userPlan === 'free') {
        showError('The "Any Comment" trigger is available exclusively on Pro and Elite plans. Upgrade your plan to activate.');
        triggerKeywordRadio.checked = true;
        keywordInputGroup.style.display = 'block';
        return;
      }
      keywordInputGroup.style.display = 'none';
      updateSimulator();
    });
  }

  // Variable chip buttons in textareas
  document.querySelectorAll('.variable-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const varTag = btn.getAttribute('data-var');
      if (!varTag || !openingMessageInput) return;
      const start = openingMessageInput.selectionStart;
      const end = openingMessageInput.selectionEnd;
      const text = openingMessageInput.value;
      openingMessageInput.value = text.substring(0, start) + varTag + text.substring(end);
      openingMessageInput.focus();
      openingMessageInput.selectionStart = openingMessageInput.selectionEnd = start + varTag.length;
      updateSimulator();
    });
  });

  // Follow Gate Toggle (DM Conversation Flow)
  if (followGateToggle) {
    followGateToggle.addEventListener('change', () => {
      if (followGateToggle.checked && userPlan === 'free') {
        showError('Follow-to-unlock is a premium feature exclusive to Pro and Elite plans. Upgrade to enable follower gates.');
        followGateToggle.checked = false;
      }
      if (followGateEnabledView) followGateEnabledView.style.display = followGateToggle.checked ? 'block' : 'none';
      if (followGateDisabledView) followGateDisabledView.style.display = followGateToggle.checked ? 'none' : 'block';
      updateSimulator();
    });
  }

  // Simulator Scenario Switcher Buttons
  if (simScenarioFollowingBtn && simScenarioNotFollowingBtn) {
    simScenarioFollowingBtn.addEventListener('click', () => {
      currentSimScenario = 'following';
      simScenarioFollowingBtn.classList.add('active');
      simScenarioNotFollowingBtn.classList.remove('active');
      updateSimulator();
    });
    simScenarioNotFollowingBtn.addEventListener('click', () => {
      currentSimScenario = 'not_following';
      simScenarioNotFollowingBtn.classList.add('active');
      simScenarioFollowingBtn.classList.remove('active');
      updateSimulator();
    });
  }

  // Public Reply Toggle
  if (publicReplyToggle) {
    publicReplyToggle.addEventListener('change', () => {
      publicReplyInputWrap.style.display = publicReplyToggle.checked ? 'block' : 'none';
      updateSimulator();
    });
  }

  // ==========================================
  // Resource Selector Tabs & Upload
  // ==========================================
  document.querySelectorAll('.resource-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.resource-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const resType = btn.getAttribute('data-res-type');
      currentResourceType = resType;

      if (resType === 'url') {
        resUrlPanel.style.display = 'block';
        resUploadPanel.style.display = 'none';
        resUrlLabel.textContent = 'Destination Website Link';
        deliveryUrlInput.placeholder = 'https://yourbrand.com/special-deal';
        resDriveNotice.style.display = 'none';
        deliveryButtonInput.placeholder = 'Open Website ↗';
      } else if (resType === 'drive') {
        resUrlPanel.style.display = 'block';
        resUploadPanel.style.display = 'none';
        resUrlLabel.textContent = 'Google Drive / Cloud Shareable Link';
        deliveryUrlInput.placeholder = 'https://drive.google.com/file/d/.../view?usp=sharing';
        resDriveNotice.style.display = 'block';
        deliveryButtonInput.placeholder = 'Open Google Drive 📁';
      } else if (resType === 'image') {
        resUrlPanel.style.display = 'none';
        resUploadPanel.style.display = 'block';
        resourceFileInput.accept = 'image/jpeg,image/png,image/webp,image/gif';
        document.getElementById('dropzonePrompt').textContent = 'Click to upload Image (JPG, PNG, WEBP, GIF)';
        document.getElementById('dropzoneTypes').textContent = 'Images up to 10MB';
        deliveryButtonInput.placeholder = 'View Image 🖼️';
      } else if (resType === 'document') {
        resUrlPanel.style.display = 'none';
        resUploadPanel.style.display = 'block';
        resourceFileInput.accept = 'application/pdf';
        document.getElementById('dropzonePrompt').textContent = 'Click to upload PDF Document';
        document.getElementById('dropzoneTypes').textContent = 'PDF files up to 10MB';
        deliveryButtonInput.placeholder = 'Download PDF 📄';
      }

      if (resType === 'image' || resType === 'document') {
        loadStorageUsage();
      }
      updateSimulator();
    });
  });

  // Dropzone click & drag handling
  if (uploadDropzone && resourceFileInput) {
    uploadDropzone.addEventListener('click', () => resourceFileInput.click());

    uploadDropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      uploadDropzone.classList.add('dragover');
    });

    uploadDropzone.addEventListener('dragleave', () => {
      uploadDropzone.classList.remove('dragover');
    });

    uploadDropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadDropzone.classList.remove('dragover');
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        handleFileUpload(e.dataTransfer.files[0]);
      }
    });

    resourceFileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        handleFileUpload(e.target.files[0]);
      }
    });
  }

  async function loadStorageUsage() {
    try {
      const res = await fetch('/api/storage/usage', {
        headers: window.getAuthHeaders ? window.getAuthHeaders() : {},
        credentials: 'same-origin'
      });
      if (!res.ok) return;
      const data = await res.json();
      const storageBar = document.getElementById('uploadStorageBar');
      const storageText = document.getElementById('uploadStorageText');
      const remText = document.getElementById('uploadRemainingText');
      if (storageBar) storageBar.style.width = (data.percentage || 0) + '%';
      if (storageText) storageText.textContent = `${data.usedFormatted || '0 MB'} / ${data.totalFormatted || '150 MB'}`;
      if (remText) remText.textContent = `Remaining: ${data.remainingFormatted || '150 MB'}`;
    } catch (_) {}
  }

  async function handleFileUpload(file) {
    if (!file) return;

    if (file.size > 10 * 1000 * 1000) {
      showError('File is too large. Maximum file size is 10 MB.');
      return;
    }

    const selSizeEl = document.getElementById('uploadSelectedSizeText');
    if (selSizeEl) selSizeEl.textContent = `Selected file: ${(file.size / (1000 * 1000)).toFixed(2)} MB`;

    const progressContainer = document.getElementById('uploadProgressContainer');
    const progressBar = document.getElementById('uploadProgressBar');
    const progressPercent = document.getElementById('uploadPercent');

    if (progressContainer) {
      progressContainer.style.display = 'block';
      progressBar.style.width = '20%';
      progressPercent.textContent = '20%';
    }

    try {
      // 1. Request presigned upload URL & reserve quota
      const presignRes = await fetch('/api/storage/presign', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(window.getAuthHeaders ? window.getAuthHeaders() : {})
        },
        credentials: 'same-origin',
        body: JSON.stringify({
          fileName: file.name,
          fileType: file.type || 'application/octet-stream',
          fileSize: file.size
        })
      });

      const presignData = await presignRes.json();
      if (!presignRes.ok) {
        throw new Error(presignData.error || 'Failed to initialize upload reservation');
      }

      if (progressBar) progressBar.style.width = '55%';
      if (progressPercent) progressPercent.textContent = '55%';

      let directUploadFailed = false;

      // 2. Direct browser-to-R2 PUT upload (presigned URL)
      try {
        const uploadRes = await fetch(presignData.uploadUrl, {
          method: 'PUT',
          headers: {
            'Content-Type': file.type || 'application/octet-stream'
          },
          body: file
        });

        if (!uploadRes.ok) {
          throw new Error(`Upload to storage bucket returned status ${uploadRes.status}`);
        }
      } catch (directErr) {
        // Fallback to server buffer upload if browser CORS / network blocked direct PUT
        console.warn('[STORAGE] Direct R2 PUT failed or blocked by CORS, falling back to server upload:', directErr.message);
        directUploadFailed = true;
      }

      if (directUploadFailed) {
        if (progressBar) progressBar.style.width = '75%';
        if (progressPercent) progressPercent.textContent = '75%';

        const fallbackRes = await fetch('/api/automations/upload-resource', {
          method: 'POST',
          headers: {
            'Content-Type': file.type || 'application/octet-stream',
            'x-filename': encodeURIComponent(file.name),
            ...(window.getAuthHeaders ? window.getAuthHeaders() : {})
          },
          credentials: 'same-origin',
          body: file
        });

        const fallbackData = await fallbackRes.json();
        if (!fallbackRes.ok) {
          throw new Error(fallbackData.error || 'Direct storage upload failed.');
        }

        if (progressBar) progressBar.style.width = '100%';
        if (progressPercent) progressPercent.textContent = '100%';
        setTimeout(() => { if (progressContainer) progressContainer.style.display = 'none'; }, 500);

        uploadedResourceData = {
          resourceId: fallbackData.resourceId,
          url: fallbackData.url,
          fileName: fallbackData.fileName,
          fileSize: fallbackData.fileSize
        };

        if (uploadedFileCard) uploadedFileCard.style.display = 'flex';
        if (uploadedFileName) uploadedFileName.textContent = fallbackData.fileName;
        if (uploadedFileSize) uploadedFileSize.textContent = (fallbackData.fileSize / (1000 * 1000)).toFixed(2) + ' MB';
        if (uploadDropzone) uploadDropzone.style.display = 'none';

        await loadStorageUsage();
        updateSimulator();
        return;
      }

      if (progressBar) progressBar.style.width = '85%';
      if (progressPercent) progressPercent.textContent = '85%';

      // 3. Confirm upload
      const confirmRes = await fetch('/api/storage/confirm', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(window.getAuthHeaders ? window.getAuthHeaders() : {})
        },
        credentials: 'same-origin',
        body: JSON.stringify({
          resourceId: presignData.resourceId,
          objectKey: presignData.objectKey
        })
      });

      const confirmData = await confirmRes.json();
      if (!confirmRes.ok) {
        throw new Error(confirmData.error || 'Failed to confirm storage upload');
      }

      if (progressBar) progressBar.style.width = '100%';
      if (progressPercent) progressPercent.textContent = '100%';
      setTimeout(() => { if (progressContainer) progressContainer.style.display = 'none'; }, 500);

      uploadedResourceData = {
        resourceId: confirmData.resource.id,
        url: confirmData.resource.url,
        fileName: confirmData.resource.fileName,
        fileSize: confirmData.resource.fileSize
      };

      if (uploadedFileCard) uploadedFileCard.style.display = 'flex';
      if (uploadedFileName) uploadedFileName.textContent = confirmData.resource.fileName;
      if (uploadedFileSize) uploadedFileSize.textContent = (confirmData.resource.fileSize / (1000 * 1000)).toFixed(2) + ' MB';
      if (uploadDropzone) uploadDropzone.style.display = 'none';

      await loadStorageUsage();
      updateSimulator();
    } catch (err) {
      if (progressContainer) progressContainer.style.display = 'none';
      showError('Upload failed: ' + err.message);
    }
  }

  if (removeUploadedFileBtn) {
    removeUploadedFileBtn.addEventListener('click', () => {
      uploadedResourceData = null;
      uploadedFileCard.style.display = 'none';
      uploadDropzone.style.display = 'block';
      resourceFileInput.value = '';
      updateSimulator();
    });
  }

  // ==========================================
  // Live Interaction Simulator
  // ==========================================
  function updateSimulator() {
    const isAll = triggerAllRadio ? triggerAllRadio.checked : false;
    const primaryKw = keywordsList.length > 0 ? keywordsList[0] : 'LINK';
    const acct = userAccounts.find(a => a.id === accountSelect.value) || userAccounts[0];
    const username = acct ? acct.username : 'yourpage';

    // Top Header
    if (simAccountHandle) simAccountHandle.textContent = `@${username}`;
    if (simReelTitle) {
      simReelTitle.textContent = selectedReel ? (selectedReel.caption || 'Linked Instagram Reel') : 'No Reel Selected';
    }
    if (simReelThumb) {
      simReelThumb.src = (selectedReel && selectedReel.thumbnailUrl) ? selectedReel.thumbnailUrl : 'https://placehold.co/60x80/1a1a24/6366f1?text=Reel';
    }

    // Comment bubble
    if (simComment) {
      simComment.innerHTML = isAll
        ? '💬 "Awesome video! 🔥"'
        : `💬 "Can you send the <strong style="color:var(--accent-light);">${escapeHtml(primaryKw)}</strong>?"`;
    }

    // Public reply
    const hasPublicReply = publicReplyToggle && publicReplyToggle.checked;
    const publicReplyText = automationPublicReplyInput ? automationPublicReplyInput.value.trim() : '';
    if (simPublicReply) {
      if (hasPublicReply && publicReplyText) {
        simPublicReply.style.display = 'block';
        simPublicReply.textContent = `↳ @${username}: "${publicReplyText}"`;
      } else {
        simPublicReply.style.display = 'none';
      }
    }

    // Opening DM Bubble
    const openingMsg = openingMessageInput ? openingMessageInput.value.trim() : '';
    const openingBtnText = openingButtonInput ? openingButtonInput.value.trim() : 'Send me the link';
    if (simOpeningDmText) {
      simOpeningDmText.innerHTML = escapeHtml(openingMsg || "Hey! I'm so glad you're here — thanks for your interest 😊\n\nTap below and I'll send you the link in just a moment ✨").replace(/\n/g, '<br>');
    } else if (simOpeningDm) {
      simOpeningDm.childNodes[0].textContent = (openingMsg || "Hey! I'm so glad you're here — thanks for your interest 😊\n\nTap below and I'll send you the link in just a moment ✨") + ' ';
    }

    if (simOpeningBtn) {
      simOpeningBtn.style.display = 'inline-flex';
      simOpeningBtn.textContent = openingBtnText || 'Send me the link';
    }

    // Recipient Tap of "Send me the link"
    if (simUserTapDisplay) {
      simUserTapDisplay.style.display = 'block';
      simUserTapDisplay.textContent = openingBtnText || 'Send me the link';
    }

    // Follow Gate & Scenario Branches
    const isFollowGate = Boolean(followGateToggle && followGateToggle.checked);

    if (isFollowGate) {
      if (simScenarioSwitcher) simScenarioSwitcher.style.display = 'inline-flex';

      const gateMsg = followGateMessageInput ? followGateMessageInput.value.trim() : '';
      const profileBtn = followGateProfileBtnInput ? followGateProfileBtnInput.value.trim() : 'Visit Profile';
      const confirmBtn = followGateConfirmBtnInput ? followGateConfirmBtnInput.value.trim() : "I'm following ✅";

      if (currentSimScenario === 'following') {
        // PATH A: Already Following (Delivers immediately, no follow gate shown)
        if (simActiveScenarioBadge) {
          simActiveScenarioBadge.textContent = 'PATH A: Already Following (Direct Delivery)';
          simActiveScenarioBadge.style.color = '#10b981';
        }
        if (simGateDisplay) simGateDisplay.style.display = 'none';
        if (simUserConfirmTapDisplay) simUserConfirmTapDisplay.style.display = 'none';
        if (simDeliveryDisplay) simDeliveryDisplay.style.display = 'block';
      } else {
        // PATH B: Not Following (Prompts to follow, taps confirm, delivers)
        if (simActiveScenarioBadge) {
          simActiveScenarioBadge.textContent = 'PATH B: Not Following (Follow Prompt Flow)';
          simActiveScenarioBadge.style.color = '#f59e0b';
        }
        if (simGateDisplay) {
          simGateDisplay.style.display = 'flex';
          if (simGateMsgDisplay) {
            simGateMsgDisplay.innerHTML = escapeHtml(gateMsg || "Oops! Looks like you haven't followed me yet 👀\n\nIt would mean a lot if you could visit my profile and hit that follow button 😊").replace(/\n/g, '<br>');
          }
          if (simGateProfileBtn) simGateProfileBtn.textContent = profileBtn || 'Visit Profile';
          if (simGateConfirmBtn) simGateConfirmBtn.textContent = confirmBtn || "I'm following ✅";
        }
        if (simUserConfirmTapDisplay) {
          simUserConfirmTapDisplay.style.display = 'block';
          simUserConfirmTapDisplay.textContent = confirmBtn || "I'm following ✅";
        }
        if (simDeliveryDisplay) simDeliveryDisplay.style.display = 'block';
      }
    } else {
      // Direct Delivery (Follow Gate Disabled)
      if (simScenarioSwitcher) simScenarioSwitcher.style.display = 'none';
      if (simActiveScenarioBadge) {
        simActiveScenarioBadge.textContent = 'Direct Delivery (Follow Gate Disabled)';
        simActiveScenarioBadge.style.color = 'var(--ink-secondary)';
      }
      if (simGateDisplay) simGateDisplay.style.display = 'none';
      if (simUserConfirmTapDisplay) simUserConfirmTapDisplay.style.display = 'none';
      if (simDeliveryDisplay) simDeliveryDisplay.style.display = 'block';
    }

    // Final Delivery Bubble
    const deliveryMsg = deliveryMessageInput ? deliveryMessageInput.value.trim() : '';
    const deliveryBtnText = deliveryButtonInput ? deliveryButtonInput.value.trim() : '';
    if (simDeliveryMsgText) {
      simDeliveryMsgText.textContent = deliveryMsg || 'Here is your link! Click below to access the full guide:';
    }
    if (simDeliveryBtn) {
      if (currentResourceType === 'image' && uploadedResourceData) {
        simDeliveryBtn.textContent = `🖼️ ${deliveryBtnText || 'View Image'}`;
      } else if (currentResourceType === 'document' && uploadedResourceData) {
        simDeliveryBtn.textContent = `📄 ${deliveryBtnText || 'Download PDF'}`;
      } else {
        simDeliveryBtn.textContent = deliveryBtnText || 'Open Free Guide ↗';
      }
    }

    // Free plan branding tag
    if (simBrandingTag) {
      simBrandingTag.style.display = userPlan === 'free' ? 'block' : 'none';
    }
  }

  // Bind live updates
  [
    openingMessageInput,
    openingButtonInput,
    followGateMessageInput,
    followGateProfileBtnInput,
    followGateConfirmBtnInput,
    followGateRetryMsgInput,
    deliveryMessageInput,
    deliveryUrlInput,
    deliveryButtonInput,
    automationPublicReplyInput
  ].forEach(el => {
    if (el) el.addEventListener('input', updateSimulator);
  });

  // ==========================================
  // Reels Gallery & Selection (Specific Media Only)
  // ==========================================
  async function loadReelsForSelectedAccount(force = false) {
    const igUserId = accountSelect.value;
    if (!igUserId) return;

    if (refreshReelsIcon) refreshReelsIcon.style.animation = 'spin 0.8s linear infinite';
    if (reelGalleryError) reelGalleryError.style.display = 'none';

    // Render 6 skeleton cards while loading
    reelPickerGrid.innerHTML = `
      <div class="reel-skeleton-card"></div>
      <div class="reel-skeleton-card"></div>
      <div class="reel-skeleton-card"></div>
      <div class="reel-skeleton-card"></div>
      <div class="reel-skeleton-card"></div>
      <div class="reel-skeleton-card"></div>
    `;

    try {
      const res = await fetch(`/api/instagram/accounts/${encodeURIComponent(igUserId)}/reels${force ? '?refresh=1' : ''}`, {
        headers: window.getAuthHeaders(),
        credentials: 'same-origin'
      });

      if (refreshReelsIcon) refreshReelsIcon.style.animation = 'none';

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to load posts from Instagram');
      }

      const data = await res.json().catch(() => ({}));
      loadedReels = data.reels || [];

      if (reelsCountLabel) {
        reelsCountLabel.textContent = `${loadedReels.length} found`;
      }

      if (loadedReels.length === 0) {
        reelPickerGrid.innerHTML = `
          <div style="text-align:center; padding:32px 16px; color:var(--ink-secondary); grid-column:1/-1;">
            <p style="font-size:0.92rem; margin-bottom:8px;">No Reels or Posts found on this Instagram account.</p>
            <small style="color:var(--ink-muted);">Publish a Reel or post on Instagram, then click Refresh Reels.</small>
          </div>
        `;
        return;
      }

      reelPickerGrid.innerHTML = '';
      loadedReels.forEach(reel => {
        const card = document.createElement('div');
        card.className = 'reel-choice-card';
        if (selectedMediaIdInput.value === String(reel.id)) {
          card.classList.add('selected');
        }

        const thumb = reel.thumbnailUrl || 'https://placehold.co/180x320/121217/6366f1?text=Post';
        const isReel = (reel.mediaType === 'VIDEO') || (reel.mediaProductType === 'REELS');
        const pubDate = reel.timestamp ? new Date(reel.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';

        card.innerHTML = `
          <img src="${escapeHtml(thumb)}" class="reel-thumb-img" alt="Reel thumbnail" loading="lazy" />
          <div class="reel-choice-badge">
            <span>${isReel ? '🎬 Reel' : '📸 Post'}</span>
            <span>💬 ${reel.commentsCount || 0}</span>
          </div>
        `;

        card.addEventListener('click', () => {
          document.querySelectorAll('.reel-choice-card').forEach(c => c.classList.remove('selected'));
          card.classList.add('selected');
          selectReel(reel);
        });

        reelPickerGrid.appendChild(card);
      });
    } catch (err) {
      if (refreshReelsIcon) refreshReelsIcon.style.animation = 'none';
      reelPickerGrid.innerHTML = '';
      if (reelGalleryError) {
        document.getElementById('reelGalleryErrorText').textContent = err.message || 'Unable to connect to Instagram API.';
        reelGalleryError.style.display = 'block';
      }
    }
  }

  function selectReel(reel) {
    if (!reel) return;
    selectedReel = reel;
    selectedMediaIdInput.value = reel.id;
    selectedMediaUrlInput.value = reel.permalink || '';
    selectedMediaTitleInput.value = reel.caption || 'Instagram Reel';
    selectedMediaThumbnailInput.value = reel.thumbnailUrl || '';
    selectedMediaTypeInput.value = reel.mediaType || 'VIDEO';

    if (selectedReelPreview) {
      selectedReelPreview.style.display = 'flex';
      if (selectedReelThumb) {
        selectedReelThumb.src = reel.thumbnailUrl || 'https://placehold.co/180x320/121217/6366f1?text=Reel';
      }
      if (selectedReelCaption) {
        selectedReelCaption.textContent = reel.caption || 'Instagram Reel/Post';
      }
      if (selectedReelIdTag) {
        selectedReelIdTag.textContent = `ID: ${reel.id}`;
      }
      if (selectedReelPermalink) {
        selectedReelPermalink.href = reel.permalink || '#';
        selectedReelPermalink.style.display = reel.permalink ? 'inline-flex' : 'none';
      }
    }

    updateSimulator();
  }

  function clearSelectedReel() {
    selectedReel = null;
    selectedMediaIdInput.value = '';
    selectedMediaUrlInput.value = '';
    selectedMediaTitleInput.value = '';
    selectedMediaThumbnailInput.value = '';
    selectedMediaTypeInput.value = '';

    if (selectedReelPreview) selectedReelPreview.style.display = 'none';
    document.querySelectorAll('.reel-choice-card').forEach(c => c.classList.remove('selected'));
    updateSimulator();
  }

  if (clearReelSelectionBtn) clearReelSelectionBtn.addEventListener('click', clearSelectedReel);
  if (refreshReelsBtn) refreshReelsBtn.addEventListener('click', () => loadReelsForSelectedAccount(true));
  if (retryReelsBtn) retryReelsBtn.addEventListener('click', () => loadReelsForSelectedAccount(true));

  if (accountSelect) {
    accountSelect.addEventListener('change', () => {
      clearSelectedReel();
      loadReelsForSelectedAccount(false);
      updateSimulator();
    });
  }

  // ==========================================
  // Open / Edit / Close Builder Form
  // ==========================================
  function openBuilder(automation = null) {
    if (userAccounts.length === 0) {
      showError('Please connect an Instagram account first on the Instagram Accounts page.');
      return;
    }

    automationForm.reset();
    clearSelectedReel();
    uploadedResourceData = null;
    if (uploadedFileCard) uploadedFileCard.style.display = 'none';
    if (uploadDropzone) uploadDropzone.style.display = 'block';

    automationFormCard.style.display = 'block';
    automationFormCard.hidden = false;
    automationFormCard.scrollIntoView({ behavior: 'smooth' });

    if (automation) {
      // Edit Mode
      document.getElementById('formHeadingTitle').textContent = 'Edit Automation';
      automationIdInput.value = automation.id || '';
      accountSelect.value = automation.instagramUserId || (userAccounts[0] && userAccounts[0].id) || '';

      // Keywords
      if (Array.isArray(automation.keywords) && automation.keywords.length > 0) {
        keywordsList = [...automation.keywords];
      } else if (automation.keyword && automation.keyword !== '*') {
        keywordsList = automation.keyword.split(',').map(s => s.trim()).filter(Boolean);
      } else {
        keywordsList = ['LINK'];
      }
      renderKeywordChips();

      // Trigger type
      if (automation.triggerType === 'all' || automation.keyword === '*') {
        triggerAllRadio.checked = true;
        keywordInputGroup.style.display = 'none';
      } else {
        triggerKeywordRadio.checked = true;
        keywordInputGroup.style.display = 'block';
      }

      // Pre-select media
      if (automation.mediaId) {
        selectReel({
          id: automation.mediaId,
          permalink: automation.mediaUrl || '',
          caption: automation.mediaTitle || 'Linked Instagram Reel',
          thumbnailUrl: automation.mediaThumbnail || 'https://placehold.co/180x320/121217/6366f1?text=Reel',
          mediaType: automation.mediaType || 'VIDEO'
        });
      }

      // Populate flow if present, or legacy dm_message
      const flow = automation.flow || {};
      openingMessageInput.value = flow.openingMessage || automation.dmMessage || '';
      openingButtonInput.value = flow.openingButtonText || '';

      // Follow gate
      if (flow.followGate && flow.followGate.enabled) {
        followGateToggle.checked = true;
        if (followGateEnabledView) followGateEnabledView.style.display = 'block';
        if (followGateDisabledView) followGateDisabledView.style.display = 'none';
        followGateMessageInput.value = flow.followGate.message || "Oops! Looks like you haven't followed me yet 👀\n\nIt would mean a lot if you could visit my profile and hit that follow button 😊";
        followGateProfileBtnInput.value = flow.followGate.profileBtnText || flow.followGate.buttonText || 'Visit Profile';
        followGateConfirmBtnInput.value = flow.followGate.confirmBtnText || flow.followGate.checkButtonText || "I'm following ✅";
        if (followGateRetryMsgInput) followGateRetryMsgInput.value = flow.followGate.retryMessage || "Still not seeing that follow yet! 👀 If you just hit follow, wait a few seconds and tap below to retry.";
      } else {
        followGateToggle.checked = false;
        if (followGateEnabledView) followGateEnabledView.style.display = 'none';
        if (followGateDisabledView) followGateDisabledView.style.display = 'block';
      }

      // Delivery
      if (flow.delivery) {
        deliveryMessageInput.value = flow.delivery.message || '';
        deliveryUrlInput.value = flow.delivery.resourceUrl || '';
        deliveryButtonInput.value = flow.delivery.buttonText || '';
        const resType = flow.delivery.resourceType || 'url';
        if (flow.delivery.resourceId) {
          uploadedResourceData = {
            resourceId: flow.delivery.resourceId,
            url: flow.delivery.resourceUrl,
            fileName: flow.delivery.resourceName || 'Uploaded Resource'
          };
          if (uploadedFileCard) {
            uploadedFileCard.style.display = 'flex';
            if (uploadedFileName) uploadedFileName.textContent = uploadedResourceData.fileName;
            if (uploadedFileSize) uploadedFileSize.textContent = 'Existing file';
          }
          if (uploadDropzone) uploadDropzone.style.display = 'none';
        }
        const targetTab = document.querySelector(`.resource-tab-btn[data-res-type="${resType}"]`);
        if (targetTab) targetTab.click();
      } else {
        deliveryMessageInput.value = '';
        deliveryUrlInput.value = '';
        deliveryButtonInput.value = 'Open Link ↗';
      }

      // Public reply
      if (automation.replyTemplate) {
        publicReplyToggle.checked = true;
        publicReplyInputWrap.style.display = 'block';
        automationPublicReplyInput.value = automation.replyTemplate;
      } else {
        publicReplyToggle.checked = false;
        publicReplyInputWrap.style.display = 'none';
        automationPublicReplyInput.value = '';
      }

      automationEnabledCheckbox.checked = Boolean(automation.enabled);
      loadReelsForSelectedAccount(false);

    } else {
      // Create Mode
      document.getElementById('formHeadingTitle').textContent = 'Create New Automation';
      automationIdInput.value = '';
      keywordsList = ['LINK'];
      renderKeywordChips();

      triggerKeywordRadio.checked = true;
      keywordInputGroup.style.display = 'block';

      openingMessageInput.value = "Hey! I'm so glad you're here — thanks for your interest 😊\n\nTap below and I'll send you the link in just a moment ✨";
      openingButtonInput.value = 'Send me the link';

      followGateToggle.checked = false;
      if (followGateEnabledView) followGateEnabledView.style.display = 'none';
      if (followGateDisabledView) followGateDisabledView.style.display = 'block';
      if (followGateMessageInput) followGateMessageInput.value = "Oops! Looks like you haven't followed me yet 👀\n\nIt would mean a lot if you could visit my profile and hit that follow button 😊";
      if (followGateProfileBtnInput) followGateProfileBtnInput.value = 'Visit Profile';
      if (followGateConfirmBtnInput) followGateConfirmBtnInput.value = "I'm following ✅";
      if (followGateRetryMsgInput) followGateRetryMsgInput.value = "Still not seeing that follow yet! 👀 If you just hit follow, wait a few seconds and tap below to retry.";

      deliveryMessageInput.value = 'Here is your link! Click below to access the full guide:';
      deliveryUrlInput.value = '';
      deliveryButtonInput.value = 'Open Free Guide ↗';

      publicReplyToggle.checked = true;
      publicReplyInputWrap.style.display = 'block';
      automationPublicReplyInput.value = 'Sent to your DM! Check inbox 📩';

      automationEnabledCheckbox.checked = true;

      // Select default account and load its reels
      if (userAccounts.length > 0) {
        accountSelect.value = userAccounts[0].id;
        loadReelsForSelectedAccount(false);
      }
    }

    updateSimulator();
  }

  function closeBuilder() {
    automationFormCard.style.display = 'none';
    automationFormCard.hidden = true;
    automationForm.reset();
    clearSelectedReel();
  }


  // ==========================================
  // Entry Access Gate (₹1/mo) Modal & Checkout
  // ==========================================
  const entryGateModal = document.getElementById('entryGateModal');
  const closeEntryGateBtn = document.getElementById('closeEntryGateBtn');
  const unlockEntryFeeBtn = document.getElementById('unlockEntryFeeBtn');
  const bannerUnlockBtn = document.getElementById('bannerUnlockBtn');

  function openEntryGateModal() {
    if (entryGateModal) entryGateModal.style.display = 'flex';
  }
  function closeEntryGateModal() {
    if (entryGateModal) entryGateModal.style.display = 'none';
  }

  if (closeEntryGateBtn) closeEntryGateBtn.addEventListener('click', closeEntryGateModal);
  if (bannerUnlockBtn) bannerUnlockBtn.addEventListener('click', openEntryGateModal);
  if (entryGateModal) {
    entryGateModal.addEventListener('click', (e) => {
      if (e.target === entryGateModal) closeEntryGateModal();
    });
  }

  if (unlockEntryFeeBtn) {
    unlockEntryFeeBtn.addEventListener('click', async () => {
      unlockEntryFeeBtn.disabled = true;
      unlockEntryFeeBtn.innerHTML = '<span>Launching Checkout...</span>';
      try {
        const res = await fetch('/api/billing/create-subscription', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(window.getAuthHeaders ? window.getAuthHeaders() : {}) },
          body: JSON.stringify({ planKey: 'entry_monthly' })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to initiate checkout');

        if (!data.keyId || !data.subscriptionId) {
          throw new Error('Payment gateway credentials unavailable. Please try again later.');
        }

        const options = {
          key: data.keyId,
          subscription_id: data.subscriptionId,
          name: data.name || 'Comment2DM',
          description: 'Starter Access Pass — ₹1 (One-time entry fee)',
          prefill: data.prefill || { email: userEmail },
          theme: { color: '#7655D9' },
          modal: {
            ondismiss: function () {
              unlockEntryFeeBtn.disabled = false;
              unlockEntryFeeBtn.innerHTML = '<span>Unlock Starter Pass for ₹1 ⚡</span>';
            }
          },
          handler: async (response) => {
            try {
              unlockEntryFeeBtn.innerHTML = '<span>Verifying Payment...</span>';
              const verifyRes = await fetch('/api/billing/verify-subscription', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(window.getAuthHeaders ? window.getAuthHeaders() : {}) },
                body: JSON.stringify({
                  razorpay_payment_id: response.razorpay_payment_id,
                  razorpay_subscription_id: response.razorpay_subscription_id,
                  razorpay_signature: response.razorpay_signature,
                  planKey: 'entry_monthly'
                })
              });
              const vd = await verifyRes.json();
              if (!verifyRes.ok) throw new Error(vd.error || 'Verification failed');
              showNotice('🎉 Starter Access Pass Active! Automations unlocked.');
              closeEntryGateModal();
              setTimeout(() => location.reload(), 1500);
            } catch (err) {
              showError('Payment verification failed: ' + err.message);
              unlockEntryFeeBtn.disabled = false;
              unlockEntryFeeBtn.innerHTML = '<span>Unlock Starter Pass for ₹1 ⚡</span>';
            }
          }
        };

        if (typeof Razorpay === 'undefined') {
          showError('Payment gateway not loaded. Please refresh the page.');
          unlockEntryFeeBtn.disabled = false;
          unlockEntryFeeBtn.innerHTML = '<span>Unlock for ₹1 ⚡</span>';
          return;
        }

        const rzp = new Razorpay(options);
        rzp.open();
      } catch (err) {
        showError(err.message);
        unlockEntryFeeBtn.disabled = false;
        unlockEntryFeeBtn.innerHTML = '<span>Unlock for ₹1 ⚡</span>';
      }
    });
  }

  if (openCreateBtn) openCreateBtn.addEventListener('click', () => { if (isEntryGated) { openEntryGateModal(); return; } openBuilder(null); });
  if (createFirstBtn) createFirstBtn.addEventListener('click', () => { if (isEntryGated) { openEntryGateModal(); return; } openBuilder(null); });
  if (cancelFormBtn) cancelFormBtn.addEventListener('click', closeBuilder);
  if (cancelFormBtn2) cancelFormBtn2.addEventListener('click', closeBuilder);

  // ==========================================
  // Form Submission & Persistence
  // ==========================================
  if (automationForm) {
    automationForm.addEventListener('submit', async function (e) {
      e.preventDefault();

      const id = automationIdInput.value.trim();
      const igUserId = accountSelect.value || (userAccounts[0] && userAccounts[0].id);
      const isAll = triggerAllRadio.checked;
      const mediaId = selectedMediaIdInput.value.trim();
      const mediaUrl = selectedMediaUrlInput.value.trim();
      const mediaTitle = selectedMediaTitleInput.value.trim();
      const mediaThumbnail = selectedMediaThumbnailInput.value.trim();
      const mediaType = selectedMediaTypeInput.value.trim();

      // Enforce Specific Reel/Post requirement
      if (!mediaId) {
        showError('Please click on a Reel or Post above to link this automation.');
        return;
      }

      // Keyword requirement
      if (!isAll && keywordsList.length === 0) {
        showError('Please add at least one trigger keyword (e.g. LINK).');
        keywordChipInput.focus();
        return;
      }

      // Message requirement
      const openingMsg = openingMessageInput.value.trim();
      if (!openingMsg) {
        showError('Please enter an opening Direct Message.');
        openingMessageInput.focus();
        return;
      }

      // Build structured conversation flow object
      const flow = {
        openingMessage: openingMsg,
        openingButtonText: openingButtonInput.value.trim() || 'Send me the link',
        followGate: {
          enabled: followGateToggle ? followGateToggle.checked : false,
          message: followGateMessageInput ? followGateMessageInput.value.trim() : null,
          profileBtnText: followGateProfileBtnInput ? followGateProfileBtnInput.value.trim() : 'Visit Profile',
          confirmBtnText: followGateConfirmBtnInput ? followGateConfirmBtnInput.value.trim() : "I'm following ✅",
          retryMessage: followGateRetryMsgInput ? followGateRetryMsgInput.value.trim() : null,
          buttonText: followGateProfileBtnInput ? followGateProfileBtnInput.value.trim() : 'Visit Profile',
          checkButtonText: followGateConfirmBtnInput ? followGateConfirmBtnInput.value.trim() : "I'm following ✅",
          profileUrl: `https://instagram.com/${(userAccounts.find(a => a.id === igUserId) || {}).username || ''}`
        },
        delivery: {
          message: deliveryMessageInput.value.trim() || 'Here is your link! Click below to access the full guide:',
          resourceType: currentResourceType,
          resourceId: (currentResourceType === 'image' || currentResourceType === 'document') && uploadedResourceData ? uploadedResourceData.resourceId : null,
          resourceUrl: uploadedResourceData ? uploadedResourceData.url : (deliveryUrlInput.value.trim() || null),
          resourceName: uploadedResourceData ? uploadedResourceData.fileName : null,
          buttonText: deliveryButtonInput.value.trim() || 'Open Free Guide ↗'
        }
      };

      const publicReply = (publicReplyToggle && publicReplyToggle.checked)
        ? automationPublicReplyInput.value.trim()
        : '';
      const enabled = automationEnabledCheckbox.checked;

      // Prevent duplicate clicks
      saveBtn.disabled = true;
      saveBtn.innerHTML = '<span>Saving automation…</span>';

      try {
        const url = id ? `/api/automations/${encodeURIComponent(id)}` : '/api/automations';
        const method = id ? 'PATCH' : 'POST';

        const res = await fetch(url, {
          method,
          headers: {
            'Content-Type': 'application/json',
            ...window.getAuthHeaders()
          },
          credentials: 'same-origin',
          body: JSON.stringify({
            instagramUserId: igUserId,
            keyword: isAll ? '*' : keywordsList.join(', '),
            keywords: isAll ? [] : keywordsList,
            triggerType: isAll ? 'all' : 'keyword',
            dmMessage: openingMsg,
            replyTemplate: publicReply,
            enabled,
            mediaId,
            mediaUrl,
            mediaTitle,
            mediaThumbnail,
            mediaType,
            flow
          })
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          showError(data.error || 'Failed to save automation.');
          saveBtn.disabled = false;
          saveBtn.innerHTML = '<span>Save & Launch Automation ⚡</span>';
          return;
        }

        const saved = data.automation;
        if (saved) {
          if (id) {
            userAutomations = userAutomations.map(a => (String(a.id) === String(id) ? saved : a));
          } else {
            userAutomations.unshift(saved);
          }
        }

        // Cache update
        try {
          sessionStorage.setItem('comment2dm_cached_automations', JSON.stringify(userAutomations));
        } catch (_) {}

        renderAutomations();
        closeBuilder();
        showNotice(id ? 'Automation updated successfully! ⚡' : 'Automation created and active! ⚡');

      } catch (err) {
        showError('Network error. Unable to save automation.');
      } finally {
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<span>Save & Launch Automation ⚡</span>';
      }
    });
  }

  // ==========================================
  // Render Automations List (Fixed Empty State Bug)
  // ==========================================
  function renderAutomations() {
    automationsListGrid.innerHTML = '';

    // Bug Fix: Explicitly manage both .style.display and [hidden] attribute
    if (!userAutomations || userAutomations.length === 0) {
      automationsEmptyState.style.display = 'block';
      automationsEmptyState.hidden = false;
      return;
    }

    automationsEmptyState.style.display = 'none';
    automationsEmptyState.hidden = true;

    userAutomations.forEach(auto => {
      const card = document.createElement('div');
      card.className = 'apple-card';
      card.style.display = 'flex';
      card.style.flexDirection = 'column';
      card.style.gap = '16px';
      card.style.padding = '22px 26px';
      card.id = `automation_card_${auto.id}`;

      const isAll = auto.triggerType === 'all' || auto.keyword === '*';
      const statusBadge = auto.enabled
        ? `<span class="status-pill status-connected"><span class="status-dot green"></span> Active</span>`
        : `<span class="status-pill status-expired"><span class="status-dot amber"></span> Paused</span>`;

      // Keywords tags
      let keywordsHtml = '';
      if (isAll) {
        keywordsHtml = `<span class="plan-badge pro" style="font-size:0.72rem;">★ Any Comment</span>`;
      } else {
        const kws = Array.isArray(auto.keywords) && auto.keywords.length > 0
          ? auto.keywords
          : (auto.keyword ? auto.keyword.split(',') : ['LINK']);
        keywordsHtml = kws.map(k => `<span class="keyword-chip" style="font-size:0.74rem; padding:2px 8px;">${escapeHtml(k.trim())}</span>`).join(' ');
      }

      // Flow tags
      const hasFollowGate = auto.flow?.followGate?.enabled;
      const resType = auto.flow?.delivery?.resourceType || 'url';
      const resTypeIcons = { url: '🔗 Link', drive: '📁 Drive', image: '🖼️ Image', document: '📄 PDF' };

      const thumb = auto.mediaThumbnail || 'https://placehold.co/80x100/1e1e24/7655d9?text=Post';

      card.innerHTML = `
        <div class="auto-card-top-row" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:16px;">
          <!-- Left: Linked Reel Preview & Metadata -->
          <div class="auto-card-left-info" style="display:flex; align-items:center; gap:16px; min-width:0;">
            <div style="width:48px; height:64px; border-radius:8px; overflow:hidden; background:var(--surface-raised); border:1px solid var(--glass-border); flex-shrink:0;">
              <img src="${escapeHtml(thumb)}" alt="Reel" style="width:100%; height:100%; object-fit:cover;" />
            </div>

            <div style="min-width:0;">
              <div style="display:flex; align-items:center; gap:10px; margin-bottom:4px; flex-wrap:wrap;">
                <strong style="color:var(--ink); font-size:1.05rem; overflow-wrap:anywhere;">@${escapeHtml(auto.username || 'creator')}</strong>
                ${statusBadge}
                ${auto.mediaUrl ? `<a href="${escapeHtml(auto.mediaUrl)}" target="_blank" rel="noopener noreferrer" style="color:var(--accent); font-size:0.8rem; text-decoration:none;">View Reel ↗</a>` : ''}
              </div>
              <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-size:0.84rem; color:var(--ink-secondary);">
                <span>Trigger:</span>
                ${keywordsHtml}
              </div>
            </div>
          </div>

          <!-- Right: Actions -->
          <div class="auto-card-actions" style="display:flex; align-items:center; gap:10px;">
            <button class="btn btn-ghost btn-sm toggle-auto-btn" style="padding:6px 14px;">
              ${auto.enabled ? 'Pause' : 'Activate'}
            </button>
            <button class="btn btn-ghost btn-sm edit-auto-btn" style="padding:6px 14px;">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
              <span>Edit</span>
            </button>
            <button class="btn btn-danger-ghost btn-sm delete-auto-btn" style="padding:6px 14px;" title="Delete this automation">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"></path><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path></svg>
              <span>Delete</span>
            </button>
          </div>
        </div>

        <!-- Flow Summary Box -->
        <div class="auto-card-flow-summary" style="display:grid; grid-template-columns: 1.2fr 0.8fr; gap:14px; background:var(--surface-hover); border:1px solid var(--glass-border); border-radius:var(--radius-m); padding:14px 18px; font-size:0.84rem;">
          <div>
            <div style="color:var(--ink-muted); font-size:0.75rem; text-transform:uppercase; margin-bottom:4px; font-weight:700;">
              📩 Direct Message Flow
            </div>
            <div style="color:var(--ink); line-height:1.4;">
              ${escapeHtml(auto.dmMessage || 'No message set')}
            </div>
            <div style="display:flex; gap:8px; margin-top:8px; flex-wrap:wrap;">
              ${hasFollowGate ? '<span class="plan-badge pro" style="font-size:0.7rem;">🔒 Follow-to-Unlock Active</span>' : ''}
              <span class="plan-badge" style="font-size:0.7rem;">📦 ${resTypeIcons[resType] || 'Resource'}</span>
            </div>
          </div>

          <div>
            <div style="color:var(--ink-muted); font-size:0.75rem; text-transform:uppercase; margin-bottom:4px; font-weight:700;">
              💬 Public Comment Reply
            </div>
            <div style="color:var(--ink-secondary); line-height:1.4;">
              ${auto.replyTemplate ? `↳ "${escapeHtml(auto.replyTemplate)}"` : '<em style="color:var(--ink-muted);">None (DM only)</em>'}
            </div>
          </div>
        </div>
      `;

      // Toggle Pause/Activate
      card.querySelector('.toggle-auto-btn').addEventListener('click', async () => {
        if (isEntryGated && !auto.enabled) {
          openEntryGateModal();
          return;
        }
        const nextState = !auto.enabled;
        try {
          await fetch(`/api/automations/${encodeURIComponent(auto.id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', ...window.getAuthHeaders() },
            credentials: 'same-origin',
            body: JSON.stringify({ enabled: nextState })
          });
          auto.enabled = nextState;
          renderAutomations();
          showNotice(nextState ? 'Automation activated! ⚡' : 'Automation paused.');
        } catch (_) {
          showError('Failed to change status.');
        }
      });

      // Edit Button
      card.querySelector('.edit-auto-btn').addEventListener('click', () => {
        if (isEntryGated) {
          openEntryGateModal();
          return;
        }
        openBuilder(auto);
      });

      // Delete Button (Opens custom confirmation modal)
      card.querySelector('.delete-auto-btn').addEventListener('click', () => {
        pendingDeleteId = auto.id;
        if (deleteModal) {
          deleteModal.classList.add('show');
          deleteModal.setAttribute('aria-hidden', 'false');
        }
      });

      automationsListGrid.appendChild(card);
    });
  }

  // Delete Modal Confirmation Handlers
  if (cancelDeleteBtn && deleteModal) {
    cancelDeleteBtn.addEventListener('click', () => {
      deleteModal.classList.remove('show');
      deleteModal.setAttribute('aria-hidden', 'true');
      pendingDeleteId = null;
    });

    deleteModal.addEventListener('click', (e) => {
      if (e.target === deleteModal) {
        deleteModal.classList.remove('show');
        deleteModal.setAttribute('aria-hidden', 'true');
        pendingDeleteId = null;
      }
    });
  }

  if (confirmDeleteBtn) {
    confirmDeleteBtn.addEventListener('click', async () => {
      if (!pendingDeleteId) return;

      confirmDeleteBtn.disabled = true;
      confirmDeleteBtn.textContent = 'Deleting…';

      try {
        const res = await fetch(`/api/automations/${encodeURIComponent(pendingDeleteId)}`, {
          method: 'DELETE',
          headers: window.getAuthHeaders(),
          credentials: 'same-origin'
        });

        if (!res.ok) throw new Error('Failed to delete automation.');

        userAutomations = userAutomations.filter(a => String(a.id) !== String(pendingDeleteId));
        try {
          sessionStorage.setItem('comment2dm_cached_automations', JSON.stringify(userAutomations));
        } catch (_) {}

        deleteModal.classList.remove('show');
        deleteModal.setAttribute('aria-hidden', 'true');
        pendingDeleteId = null;

        renderAutomations();
        showNotice('Automation deleted successfully.');
      } catch (err) {
        showError('Delete failed: ' + err.message);
      } finally {
        confirmDeleteBtn.disabled = false;
        confirmDeleteBtn.textContent = 'Delete Automation';
      }
    });
  }

  // ==========================================
  // Initialization & Cache Hydration
  // ==========================================
  function updateAccountSelectUi() {
    if (userAccounts.length === 0) {
      if (noAccountWarning) noAccountWarning.style.display = 'block';
      if (openCreateBtn) openCreateBtn.disabled = true;
    } else {
      if (noAccountWarning) noAccountWarning.style.display = 'none';
      if (openCreateBtn) openCreateBtn.disabled = false;
      accountSelect.innerHTML = '';
      userAccounts.forEach(acct => {
        const opt = document.createElement('option');
        opt.value = acct.id;
        opt.textContent = `@${acct.username} (ID: ${acct.id})`;
        accountSelect.appendChild(opt);
      });
    }
  }

  async function init() {
    // 0. Paint cached state immediately (0ms latency on page switch)
    try {
      const cachedAccounts = sessionStorage.getItem('comment2dm_cached_accounts');
      if (cachedAccounts) {
        userAccounts = JSON.parse(cachedAccounts) || [];
        updateAccountSelectUi();
      }
      const cachedAutos = sessionStorage.getItem('comment2dm_cached_automations');
      if (cachedAutos) {
        userAutomations = JSON.parse(cachedAutos) || [];
        renderAutomations();
      }
    } catch (_) {}

    try {
      // Fetch plan status, accounts, and automations concurrently
      const [acctRes, autoRes, billRes] = await Promise.allSettled([
        fetch('/api/instagram/accounts', { headers: window.getAuthHeaders(), credentials: 'same-origin' }),
        fetch('/api/automations', { headers: window.getAuthHeaders(), credentials: 'same-origin' }),
        fetch('/api/billing/status', { headers: window.getAuthHeaders(), credentials: 'same-origin' })
      ]);

      if (acctRes.status === 'fulfilled' && acctRes.value.ok) {
        const acctData = await acctRes.value.json().catch(() => ({}));
        userAccounts = acctData.accounts || [];
        sessionStorage.setItem('comment2dm_cached_accounts', JSON.stringify(userAccounts));
        updateAccountSelectUi();
      }

      if (autoRes.status === 'fulfilled' && autoRes.value.ok) {
        const autoData = await autoRes.value.json().catch(() => ({}));
        userAutomations = autoData.automations || [];
        sessionStorage.setItem('comment2dm_cached_automations', JSON.stringify(userAutomations));
        renderAutomations();
      }

      if (billRes.status === 'fulfilled' && billRes.value.ok) {
        const billData = await billRes.value.json().catch(() => ({}));
        userPlan = (billData.plan || 'free').toLowerCase();
        userEmail = billData.email || '';
        const isSubscriber = userPlan === 'pro' || userPlan === 'elite' || billData.isAdmin === true;
        const autoAccess = billData.automationAccess || {};
        
        // Active Pro, Elite, or Admin accounts NEVER get gated by entry fee
        const isGated = !isSubscriber && (autoAccess.isGated === true || (billData.entryPricing?.gate_automations_if_unpaid && !billData.hasPaidEntry));
        isEntryGated = isGated;

        const banner = document.getElementById('entryFeeBanner');
        if (banner) {
          banner.style.display = isGated ? 'flex' : 'none';
        }
        updateSimulator();
      }

      // Check URL query param e.g. ?action=new
      const params = new URLSearchParams(window.location.search);
      if (params.get('action') === 'new') {
        openBuilder(null);
      }
    } catch (_) {
      if (userAutomations.length === 0) {
        renderAutomations();
      }
    }
  }

  init();
})();
