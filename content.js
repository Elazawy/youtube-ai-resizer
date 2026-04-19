(function() {
  'use strict';

  // State
  let geminiContainer = null;
  let isResizing = false;
  let currentResizeHandle = null;
  let startX, startWidth, startHeight;
  let startPageY;
  let geminiObserver = null;
  let isFullscreen = false;
  let fullscreenPollId = null;

  // Default settings
  const DEFAULTS = {
    width: 400,
    height: 600,
    fontSize: 14,
    position: 'right'
  };

  // Storage key
  const STORAGE_KEY = 'geminiResizerSettings';
  const MIN_WIDTH = 300;
  const MIN_HEIGHT = 200;

  // Load saved settings
  async function loadSettings() {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      return result[STORAGE_KEY] || DEFAULTS;
    } catch (e) {
      return DEFAULTS;
    }
  }

  // Save settings
  async function saveSettings(settings) {
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: settings });
    } catch (e) {
      console.error('Failed to save settings:', e);
    }
  }

  // Find Gemini container
  function findGeminiContainer() {
    // Try multiple selectors to find the Gemini sidebar/chat container
    const selectors = [
      // Sidebar container
      'div[role="dialog"][aria-label*="Gemini"]',
      'div[role="dialog"][aria-label*="جمني"]',
      // Chat container
      '[data-gemini-chat]',
      // Generic container with Gemini-related attributes
      'div[class*="gemini"]',
      // Bottom sheet / floating container
      'div[class*="ytd-gemini"]',
      // Any dialog that might be Gemini
      'tp-yt-paper-dialog[aria-modal="true"]',
      // The new Gemini AI side panel
      '#gemini-container',
      '[class*="gemini-assistant"]',
      '[class*="ai-assistant"]',
      // Common YouTube side panel patterns
      'ytd-engagement-panel-section-list-renderer'
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el) {
        // Verify it contains Gemini-related content
        const text = el.textContent || '';
        const hasGeminiContent = text.includes('Gemini') ||
                                  text.includes('جمني') ||
                                  text.includes('جيميني') ||
                                  el.querySelector('[class*="gemini"]') ||
                                  el.querySelector('button[class*="gemini"]');

        if (hasGeminiContent || selector.includes('gemini')) {
          return el;
        }
      }
    }

    // Look for buttons that open Gemini
    const geminiButton = document.querySelector('button[aria-label*="Gemini"], button[title*="Gemini"]');
    if (geminiButton) {
      // Try to find the parent container
      let parent = geminiButton.closest('div[role="dialog"], tp-yt-paper-dialog, ytd-popup-container > div');
      if (parent) return parent;
    }

    return null;
  }

  // Create resize handles
  function createResizeHandles(container) {
    // Remove existing handles
    const existingHandles = container.querySelectorAll('.gemini-resize-handle');
    existingHandles.forEach(h => h.remove());

    // Create handle positions
    const positions = ['right', 'bottom', 'corner'];

    positions.forEach(pos => {
      const handle = document.createElement('div');
      handle.className = `gemini-resize-handle gemini-resize-${pos}`;
      handle.dataset.position = pos;
      handle.title = pos === 'right' ? 'Drag to resize width' :
                     pos === 'bottom' ? 'Drag to resize height' : 'Drag to resize width and height';
      container.appendChild(handle);

      // Add event listeners - use capture phase to ensure they fire
      handle.addEventListener('mousedown', startResize, true);
      handle.addEventListener('touchstart', startResize, { passive: false, capture: true });

      console.log(`YouTube Gemini Resizer: Created ${pos} resize handle`);
    });
  }

  // Start resize operation
  function startResize(e) {
    // Prevent default to stop text selection, etc.
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    if (!geminiContainer) {
      console.log('YouTube Gemini Resizer: No container found');
      return;
    }

    isResizing = true;
    currentResizeHandle = e.currentTarget?.dataset.position || e.target?.dataset.position;

    console.log('YouTube Gemini Resizer: Starting resize', currentResizeHandle);

    const touch = e.touches ? e.touches[0] : e;
    startX = touch.clientX;
    startPageY = touch.clientY + window.scrollY;

    const rect = geminiContainer.getBoundingClientRect();
    startWidth = rect.width;
    startHeight = rect.height;

    // Keep the opposite edge unpinned so each handle resizes in one direction.
    const computedStyle = window.getComputedStyle(geminiContainer);
    const currentPosition = computedStyle.position;
    if (currentPosition === 'fixed' || currentPosition === 'absolute') {
      if (currentResizeHandle === 'right' || currentResizeHandle === 'corner') {
        geminiContainer.style.left = `${rect.left}px`;
        geminiContainer.style.right = 'auto';
      }

      if (currentResizeHandle === 'bottom' || currentResizeHandle === 'corner') {
        geminiContainer.style.top = `${rect.top}px`;
        geminiContainer.style.bottom = 'auto';
      }
    }

    document.body.style.cursor = getCursorForPosition(currentResizeHandle);
    geminiContainer.style.userSelect = 'none'; // Prevent text selection during resize

    document.addEventListener('mousemove', doResize, true);
    document.addEventListener('mouseup', stopResize, true);
    document.addEventListener('touchmove', doResize, { passive: false, capture: true });
    document.addEventListener('touchend', stopResize, true);
  }

  function autoScrollPageDown(pointerClientY) {
    if (!geminiContainer) return 0;

    const computedStyle = window.getComputedStyle(geminiContainer);
    if (computedStyle.position === 'fixed') return 0;

    const threshold = 80;
    const distanceToBottom = window.innerHeight - pointerClientY;
    if (distanceToBottom > threshold) return 0;

    const doc = document.documentElement;
    const maxScrollTop = Math.max(0, doc.scrollHeight - window.innerHeight);
    if (window.scrollY >= maxScrollTop) return 0;

    const beforeScroll = window.scrollY;
    const overflow = threshold - distanceToBottom;
    const step = Math.min(36, Math.max(8, Math.round(overflow / 2)));
    window.scrollBy(0, step);
    return window.scrollY - beforeScroll;
  }

  function applyContainerWidth(width) {
    if (!geminiContainer) return;

    const newWidth = Math.max(MIN_WIDTH, Math.round(width));
    geminiContainer.style.width = `${newWidth}px`;
    geminiContainer.style.minWidth = `${newWidth}px`;
    geminiContainer.style.flex = `0 0 ${newWidth}px`;

    const secondary = geminiContainer.closest('#secondary');
    if (secondary) {
      secondary.style.width = `${newWidth}px`;
      secondary.style.minWidth = `${newWidth}px`;
      secondary.style.flex = `0 0 ${newWidth}px`;

      const primary = document.querySelector('#primary');
      if (primary) {
        primary.style.maxWidth = `calc(100% - ${newWidth + 24}px)`;
        primary.style.flex = '1 1 auto';
        primary.style.minWidth = '0';
      }
    }

    const panels = geminiContainer.closest('#panels');
    if (panels) {
      panels.style.width = '100%';
    }
  }

  function applyContainerHeight(height) {
    if (!geminiContainer) return;

    const newHeight = Math.max(MIN_HEIGHT, Math.round(height));
    geminiContainer.style.setProperty('height', `${newHeight}px`, 'important');
    geminiContainer.style.setProperty('min-height', `${newHeight}px`, 'important');
    geminiContainer.style.setProperty('max-height', `${newHeight}px`, 'important');

    const innerContent = geminiContainer.querySelector('#content, .content, [role="main"]');
    if (innerContent) {
      innerContent.style.height = '100%';
      innerContent.style.minHeight = '0';
      innerContent.style.flex = '1 1 auto';
    }
  }

  // Perform resize
  function doResize(e) {
    if (!isResizing || !geminiContainer) return;
    e.preventDefault();

    const touch = e.touches ? e.touches[0] : e;
    const deltaX = touch.clientX - startX;
    const deltaY = (touch.clientY + window.scrollY) - startPageY;

    if (currentResizeHandle === 'right') {
      applyContainerWidth(startWidth + deltaX);
    } else if (currentResizeHandle === 'bottom') {
      let nextDeltaY = deltaY;
      if (nextDeltaY > 0) {
        nextDeltaY += autoScrollPageDown(touch.clientY);
      }
      applyContainerHeight(startHeight + nextDeltaY);
    } else if (currentResizeHandle === 'corner') {
      applyContainerWidth(startWidth + deltaX);
      let nextDeltaY = deltaY;
      if (nextDeltaY > 0) {
        nextDeltaY += autoScrollPageDown(touch.clientY);
      }
      applyContainerHeight(startHeight + nextDeltaY);
    }
  }

  // Stop resize
  function stopResize() {
    if (!isResizing) return;

    isResizing = false;
    document.body.style.cursor = '';

    if (geminiContainer) {
      geminiContainer.style.userSelect = ''; // Restore text selection
    }

    document.removeEventListener('mousemove', doResize, true);
    document.removeEventListener('mouseup', stopResize, true);
    document.removeEventListener('touchmove', doResize, { capture: true });
    document.removeEventListener('touchend', stopResize, true);

    // Save the new dimensions
    if (geminiContainer) {
      const rect = geminiContainer.getBoundingClientRect();
      loadSettings().then(settings => {
        settings.width = rect.width;
        settings.height = rect.height;
        saveSettings(settings);
      });
    }

    console.log('YouTube Gemini Resizer: Resize complete');
  }

  // Get cursor style
  function getCursorForPosition(position) {
    switch (position) {
      case 'right': return 'ew-resize';
      case 'bottom': return 'ns-resize';
      case 'corner': return 'nwse-resize';
      default: return 'default';
    }
  }

  // Apply settings
  async function applySettings() {
    const settings = await loadSettings();

    if (geminiContainer) {
      const computedStyle = window.getComputedStyle(geminiContainer);
      const currentPosition = computedStyle.position;

      if (currentPosition !== 'static') {
        applyContainerWidth(settings.width);
        applyContainerHeight(settings.height);

        if (currentPosition === 'fixed' || currentPosition === 'absolute') {
          const rect = geminiContainer.getBoundingClientRect();
          if (rect.left < window.innerWidth / 2) {
            geminiContainer.style.left = `${rect.left}px`;
            geminiContainer.style.right = 'auto';
          }
        }
      }

      // Ensure visibility
      geminiContainer.style.opacity = '1';
      geminiContainer.style.visibility = 'visible';
    }

    // Apply font size to text elements within Gemini
    applyFontSize(settings.fontSize);
  }

  // Apply font size
  function applyFontSize(size) {
    if (!geminiContainer) return;

    const textElements = geminiContainer.querySelectorAll(
      'p, span, div, button, input, textarea, [role="textbox"], [contenteditable]'
    );

    textElements.forEach(el => {
      el.style.fontSize = `${size}px`;
      el.style.lineHeight = '1.5';
    });

    // Add a style tag for persistent font sizing
    let styleId = 'gemini-font-size-style';
    let styleTag = document.getElementById(styleId);
    if (!styleTag) {
      styleTag = document.createElement('style');
      styleTag.id = styleId;
      document.head.appendChild(styleTag);
    }

    styleTag.textContent = `
      .gemini-resizer-active,
      .gemini-resizer-active *,
      [class*="gemini"] [role="textbox"],
      [class*="gemini"] [contenteditable],
      [class*="gemini"] p,
      [class*="gemini"] span,
      [class*="gemini"] div {
        font-size: ${size}px !important;
        line-height: 1.5 !important;
      }
    `;
  }

  // Create text size controls
  function createTextSizeControls() {
    if (!geminiContainer) return;

    // Check if controls already exist
    if (geminiContainer.querySelector('.gemini-text-controls')) return;

    const controls = document.createElement('div');
    controls.className = 'gemini-text-controls';
    controls.innerHTML = `
      <button class="gemini-text-btn gemini-text-decrease" title="Decrease text size">A-</button>
      <span class="gemini-text-label">Text Size</span>
      <button class="gemini-text-btn gemini-text-increase" title="Increase text size">A+</button>
    `;

    // Append to container (floating position via CSS)
    geminiContainer.appendChild(controls);

    // Add event listeners
    controls.querySelector('.gemini-text-decrease').addEventListener('click', (e) => {
      e.stopPropagation();
      adjustFontSize(-2);
    });

    controls.querySelector('.gemini-text-increase').addEventListener('click', (e) => {
      e.stopPropagation();
      adjustFontSize(2);
    });
  }

  // Adjust font size
  async function adjustFontSize(delta) {
    const settings = await loadSettings();
    settings.fontSize = Math.max(10, Math.min(24, settings.fontSize + delta));
    await saveSettings(settings);
    applyFontSize(settings.fontSize);
  }

  const RESPONSE_SELECTORS = [
    'model-turn',
    '[data-content-type="model"]',
    '[data-message-author-role="model"]',
    '[data-author="model"]',
    '[role="alert"]',
    '[class*="assistant"][class*="turn"]',
    '[class*="model"][class*="turn"]',
    '.model-response-text',
    '.conversation-turn:not(.user-turn)'
  ];
  const RESPONSE_SELECTOR = RESPONSE_SELECTORS.join(', ');
  let copyInjectScheduled = false;

  function normalizeMultilineText(text) {
    return (text || '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function extractResponseText(turn) {
    const clone = turn.cloneNode(true);
    clone.querySelectorAll('.gemini-response-actions, .gemini-copy-btn, .gemini-text-controls, .gemini-resize-handle, button[aria-label*="Thumbs"], button[aria-label*="thumbs"], button[aria-label*="إعجاب"], button[aria-label*="عدم الإعجاب"]').forEach((el) => {
      el.remove();
    });
    return normalizeMultilineText(clone.innerText || clone.textContent || '');
  }

  function isLikelyResponseTurn(turn) {
    if (!(turn instanceof HTMLElement)) return false;
    if (turn.classList.contains('gemini-response-actions')) return false;
    if (turn.matches('[data-content-type="user"], [data-message-author-role="user"], [data-author="user"]')) return false;
    if (turn.querySelector('[contenteditable="true"], textarea, input[type="text"], input:not([type])')) return false;

    const hints = [
      turn.getAttribute('data-content-type'),
      turn.getAttribute('data-message-author-role'),
      turn.getAttribute('data-author'),
      turn.className,
      turn.id,
      turn.getAttribute('aria-label')
    ].join(' ').toLowerCase();

    const hasUserHint = hints.includes('user') || hints.includes('prompt') || hints.includes('input');
    const hasModelHint = hints.includes('model') || hints.includes('assistant') || hints.includes('response');
    if (hasUserHint && !hasModelHint) return false;

    const text = extractResponseText(turn);
    if (!text) return false;
    if (text.includes('قد يعرض الذكاء الاصطناعي معلومات خاطئة')) return false;
    if (text.toLowerCase().includes('ai may display inaccurate information')) return false;

    return true;
  }

  function getResponseTurns() {
    // When geminiContainer is null (e.g. during fullscreen), fall back to
    // searching the whole document so copy buttons still get injected.
    const root = geminiContainer || document;

    return Array.from(root.querySelectorAll(RESPONSE_SELECTOR)).filter((turn) => {
      if (!isLikelyResponseTurn(turn)) return false;
      return turn.closest(RESPONSE_SELECTOR) === turn;
    });
  }

  async function copyTextToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.top = '-9999px';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();

      let copied = false;
      try {
        copied = document.execCommand('copy');
      } catch (fallbackErr) {
        console.error('Gemini copy fallback failed:', fallbackErr);
      }

      textarea.remove();
      if (!copied) {
        console.error('Gemini copy failed:', err);
      }
      return copied;
    }
  }

  function setCopyButtonLabel(button, label) {
    const labelEl = button.querySelector('.gemini-copy-label');
    if (labelEl) labelEl.textContent = label;
  }

  function injectCopyButtons() {
    const turns = getResponseTurns();
    turns.forEach((turn) => {
      if (turn.dataset.geminiCopyInjected === 'true') return;
      if (turn.nextElementSibling?.classList.contains('gemini-response-actions')) {
        turn.dataset.geminiCopyInjected = 'true';
        return;
      }

      const actions = document.createElement('div');
      actions.className = 'gemini-response-actions';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gemini-copy-btn';
      btn.setAttribute('aria-label', 'Copy response');
      btn.innerHTML = `
        <svg class="gemini-copy-icon" width="14" height="14" viewBox="0 0 24 24"
             fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
        <span class="gemini-copy-label">Copy</span>
      `;

      btn.addEventListener('click', async (e) => {
        e.stopPropagation();

        const text = extractResponseText(turn);
        if (!text) {
          setCopyButtonLabel(btn, 'No text');
          setTimeout(() => setCopyButtonLabel(btn, 'Copy'), 1200);
          return;
        }

        btn.disabled = true;
        setCopyButtonLabel(btn, 'Copying...');
        const copied = await copyTextToClipboard(text);
        btn.disabled = false;

        if (copied) {
          btn.classList.add('gemini-copy-success');
          setCopyButtonLabel(btn, 'Copied!');
          setTimeout(() => {
            btn.classList.remove('gemini-copy-success');
            setCopyButtonLabel(btn, 'Copy');
          }, 1500);
          return;
        }

        setCopyButtonLabel(btn, 'Failed');
        setTimeout(() => setCopyButtonLabel(btn, 'Copy'), 1500);
      });

      actions.appendChild(btn);
      turn.insertAdjacentElement('afterend', actions);
      turn.dataset.geminiCopyInjected = 'true';
    });
  }

  function scheduleCopyButtonInjection() {
    if (copyInjectScheduled) return;
    copyInjectScheduled = true;
    window.requestAnimationFrame(() => {
      copyInjectScheduled = false;
      injectCopyButtons();
    });
  }

  // ── Fullscreen detection ────────────────────────────────────────────
  function checkFullscreen() {
    // Detect via native Fullscreen API
    if (document.fullscreenElement) return true;
    // Detect via YouTube's player fullscreen class
    const player = document.querySelector('.html5-video-player');
    if (player && player.classList.contains('ytp-fullscreen')) return true;
    return false;
  }

  /** Tear down every modification the extension has made. */
  function disableExtension() {
    console.log('YouTube Gemini Resizer: Disabling (fullscreen mode)');

    if (geminiContainer) {
      // Remove resize handles
      geminiContainer.querySelectorAll('.gemini-resize-handle').forEach(h => h.remove());
      // Remove text size controls
      geminiContainer.querySelectorAll('.gemini-text-controls').forEach(c => c.remove());
      // Remove the active marker class and undo inline styles we injected
      geminiContainer.classList.remove('gemini-resizer-active');
      geminiContainer.style.opacity = '';
      geminiContainer.style.visibility = '';
      geminiContainer.style.zIndex = '';
      geminiContainer.style.position = '';
      geminiContainer.style.width = '';
      geminiContainer.style.minWidth = '';
      geminiContainer.style.flex = '';
      geminiContainer.style.height = '';
      geminiContainer.style.minHeight = '';
      geminiContainer.style.maxHeight = '';
      geminiContainer.style.userSelect = '';
    }

    // Undo layout tweaks on #secondary and #primary
    const secondary = document.querySelector('#secondary');
    if (secondary) {
      secondary.style.width = '';
      secondary.style.minWidth = '';
      secondary.style.flex = '';
    }
    const primary = document.querySelector('#primary');
    if (primary) {
      primary.style.maxWidth = '';
      primary.style.flex = '';
      primary.style.minWidth = '';
    }
    const panels = document.querySelector('#panels');
    if (panels) {
      panels.style.width = '';
    }

    // Remove injected font-size style tag
    const fontStyle = document.getElementById('gemini-font-size-style');
    if (fontStyle) fontStyle.remove();

    // NOTE: Copy buttons are intentionally kept in fullscreen so the user
    // can still copy AI responses while watching the video.
    // The mutation observer also stays connected so new copy buttons are
    // injected for streamed responses (see MutationObserver below).

    // Reset container reference so it gets re-detected on re-enable
    geminiContainer = null;
  }

  /** Re-enable after leaving fullscreen. */
  function enableExtension() {
    console.log('YouTube Gemini Resizer: Re-enabling (exited fullscreen)');
    // Re-start the observer + initialization cycle
    startObserving();
  }

  function onFullscreenChange() {
    const nowFullscreen = checkFullscreen();
    if (nowFullscreen === isFullscreen) return;
    isFullscreen = nowFullscreen;

    if (isFullscreen) {
      disableExtension();
    } else {
      enableExtension();
    }
  }

  // Initialize resizer
  async function initializeResizer() {
    // Skip if currently in fullscreen
    if (isFullscreen) return;

    geminiContainer = findGeminiContainer();

    if (geminiContainer && !geminiContainer.classList.contains('gemini-resizer-active')) {
      geminiContainer.classList.add('gemini-resizer-active');

      // Ensure proper stacking context and visibility BEFORE applying other styles
      // This prevents transparency issues
      geminiContainer.style.opacity = '1';
      geminiContainer.style.visibility = 'visible';
      geminiContainer.style.zIndex = '2147483646'; // Max safe z-index

      // CRITICAL: Container MUST have non-static position for handles to work
      // Check and set positioning BEFORE creating handles
      const computedStyle = window.getComputedStyle(geminiContainer);
      const currentPosition = computedStyle.position;

      // If position is static, set to relative so absolute handles work
      if (currentPosition === 'static') {
        geminiContainer.style.position = 'relative';
      }

      // Apply settings
      await applySettings();

      // Create resize handles AFTER positioning is set
      createResizeHandles(geminiContainer);

      // Create text size controls
      createTextSizeControls();

      // Add copy buttons for existing responses
      scheduleCopyButtonInjection();

      // Add resize observer to maintain handles
      const resizeObserver = new ResizeObserver(() => {
        createResizeHandles(geminiContainer);
      });
      resizeObserver.observe(geminiContainer);

      console.log('YouTube Gemini Resizer: Container initialized', geminiContainer);
    }
  }

  // Listen for messages from popup
  chrome.runtime.onMessage?.addListener((request, sender, sendResponse) => {
    if (request.action === 'adjustTextSize') {
      adjustFontSize(request.delta);
      sendResponse({ success: true });
    } else if (request.action === 'resetSize') {
      saveSettings(DEFAULTS).then(() => {
        applySettings();
      });
      sendResponse({ success: true });
    } else if (request.action === 'getSettings') {
      loadSettings().then(settings => {
        sendResponse(settings);
      });
      return true; // Will respond asynchronously
    }
  });

  /** Clean up all layout modifications when Gemini panel is closed/removed. */
  function cleanupOnClose() {
    console.log('YouTube Gemini Resizer: Gemini panel closed, cleaning up layout');

    // Remove resize handles, text controls, and active class from the old container
    if (geminiContainer) {
      geminiContainer.querySelectorAll('.gemini-resize-handle').forEach(h => h.remove());
      geminiContainer.querySelectorAll('.gemini-text-controls').forEach(c => c.remove());
      geminiContainer.classList.remove('gemini-resizer-active');
      geminiContainer.style.width = '';
      geminiContainer.style.minWidth = '';
      geminiContainer.style.flex = '';
      geminiContainer.style.height = '';
      geminiContainer.style.minHeight = '';
      geminiContainer.style.maxHeight = '';
      geminiContainer.style.opacity = '';
      geminiContainer.style.visibility = '';
      geminiContainer.style.zIndex = '';
      geminiContainer.style.position = '';
      geminiContainer.style.userSelect = '';
    }

    // Reset #secondary, #primary, and #panels to undo layout changes
    const secondary = document.querySelector('#secondary');
    if (secondary) {
      secondary.style.width = '';
      secondary.style.minWidth = '';
      secondary.style.flex = '';
    }
    const primary = document.querySelector('#primary');
    if (primary) {
      primary.style.maxWidth = '';
      primary.style.flex = '';
      primary.style.minWidth = '';
    }
    const panels = document.querySelector('#panels');
    if (panels) {
      panels.style.width = '';
    }

    // Remove injected copy buttons
    document.querySelectorAll('.gemini-response-actions').forEach(el => el.remove());
    document.querySelectorAll('[data-gemini-copy-injected]').forEach(el => {
      delete el.dataset.geminiCopyInjected;
    });

    // Remove injected font-size style tag
    const fontStyle = document.getElementById('gemini-font-size-style');
    if (fontStyle) fontStyle.remove();

    // Reset container reference so it can be re-detected
    geminiContainer = null;
  }

  /** Check if the Gemini panel is actually visible (not just in the DOM). */
  function isGeminiPanelVisible() {
    if (!geminiContainer || !document.contains(geminiContainer)) return false;

    // Check if the panel or a close ancestor is hidden via display/visibility
    const style = window.getComputedStyle(geminiContainer);
    if (style.display === 'none' || style.visibility === 'hidden') return false;

    // Also check the engagement panel's visibility attribute
    // YouTube uses the 'visibility' attribute (not CSS) on engagement panels
    const engagementPanel = geminiContainer.closest('ytd-engagement-panel-section-list-renderer');
    if (engagementPanel) {
      const vis = engagementPanel.getAttribute('visibility');
      // YouTube uses 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED' when open
      if (vis && !vis.includes('EXPANDED')) return false;
    }

    return true;
  }

  // Watch for Gemini container to appear
  function startObserving() {
    // Initial check
    initializeResizer();

    // Set up mutation observer
    geminiObserver = new MutationObserver((mutations) => {
      // Always inject copy buttons — even in fullscreen
      scheduleCopyButtonInjection();

      if (isFullscreen) return; // Skip resize/layout logic while fullscreen

      // If we had a container but it's gone or hidden, clean up
      if (geminiContainer && !isGeminiPanelVisible()) {
        cleanupOnClose();
        return;
      }

      // Check if Gemini container appeared
      if (!geminiContainer || !document.contains(geminiContainer)) {
        initializeResizer();
      }
    });

    geminiObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  // ── Fullscreen event listeners ────────────────────────────────────
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);

  // YouTube may toggle fullscreen via its player without using the native
  // Fullscreen API, so poll for the `.ytp-fullscreen` class as a fallback.
  fullscreenPollId = setInterval(() => {
    onFullscreenChange();
  }, 500);

  // Start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserving);
  } else {
    startObserving();
  }

  // Also check periodically for the container
  setInterval(() => {
    // Always inject copy buttons — even in fullscreen
    scheduleCopyButtonInjection();

    if (isFullscreen) return; // Skip resize/layout logic while fullscreen

    // If we had a container but it's gone or hidden, clean up
    if (geminiContainer && !isGeminiPanelVisible()) {
      cleanupOnClose();
      return;
    }

    if (!geminiContainer || !document.contains(geminiContainer)) {
      initializeResizer();
    }
  }, 1000);

  console.log('YouTube Gemini Resizer: Extension loaded');
})();
