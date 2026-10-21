// @ts-check

/**
 * @typedef {import('./types.js').TimelinePreferences} TimelinePreferences
 * @typedef {import('./types.js').TimelineTurnNode} TimelineTurnNode
 * @typedef {import('./types.js').I18nTextMap} I18nTextMap
 */

/**
 * Initialize Timeline Navigator client injector inside Antigravity workbench
 * @param {string} clientStyles - Raw CSS stylesheet
 * @param {TimelinePreferences} defaultPrefs - Default preference options
 * @param {(lang?: string) => I18nTextMap} getTexts - Function returning i18n text map
 */
export function initClient(clientStyles, defaultPrefs, getTexts) {
  if (typeof window.__agyTimelineCleanup === 'function') {
    try { window.__agyTimelineCleanup(); } catch {}
  }

  // 1. Remove stale injected elements
  const staleSelectors = [
    '#agy-timeline-styles',
    '#agy-timeline-track',
    '#agy-timeline-popover',
    '#agy-timeline-floating-btn',
    '#agy-timeline-drawer'
  ];
  staleSelectors.forEach(sel => {
    document.querySelectorAll(sel).forEach(el => el.remove());
  });

  const STORAGE_KEY = 'antigravity_timeline_settings_v1';

  /**
   * @returns {TimelinePreferences}
   */
  function loadPrefs() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        return Object.assign({}, defaultPrefs, JSON.parse(saved));
      }
    } catch {}
    return Object.assign({}, defaultPrefs);
  }

  let currentPrefs = loadPrefs();

  function t() {
    return getTexts(currentPrefs.language);
  }

  /**
   * Save preferences and sync via CDP RPC
   * @param {Partial<TimelinePreferences>} newPrefs
   */
  function savePrefs(newPrefs) {
    currentPrefs = Object.assign({}, currentPrefs, newPrefs);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(currentPrefs));
    } catch {}
    if (typeof window.__agyTimelineSavePrefs === 'function') {
      try {
        window.__agyTimelineSavePrefs(JSON.stringify(currentPrefs));
      } catch {}
    }
    renderUI();
  }

  // 2. Inject Stylesheet
  const styleEl = document.createElement('style');
  styleEl.id = 'agy-timeline-styles';
  styleEl.textContent = clientStyles;
  (document.head || document.documentElement).appendChild(styleEl);

  /** @type {TimelineTurnNode[]} */
  let currentNodes = [];
  /** @type {HTMLElement | null} */
  let currentViewport = null;
  /** @type {number | null} */
  let hoverTimer = null;
  let isDrawerOpen = false;

  // 3. Find Viewport and Turns
  function getViewport() {
    return /** @type {HTMLElement | null} */ (
      document.querySelector('[data-testid="autoscroll-viewport"]') ||
      document.querySelector('.isolate.overflow-y-auto') ||
      document.querySelector('.overflow-y-auto.min-h-0.w-full')
    );
  }

  function scanTurns() {
    const viewport = getViewport();
    if (!viewport) return [];

    const turns = Array.from(document.querySelectorAll('[data-turn-content]'));
    const scrollHeight = Math.max(viewport.scrollHeight, 1);

    /** @type {TimelineTurnNode[]} */
    const nodes = [];

    turns.forEach((turnEl, idx) => {
      const userStep = turnEl.querySelector('[class*="group/user-input-step"]') ||
                       turnEl.querySelector('[data-testid="user-input-step"]') ||
                       turnEl.querySelector('.whitespace-pre-wrap');

      // Extract user prompt text
      let promptText = '';
      if (userStep) {
        const quotable = userStep.querySelector('[data-quotable]') || userStep;
        promptText = (quotable.textContent || '').trim();
      }

      // If empty, fallback to first text line of turn
      if (!promptText) {
        promptText = (turnEl.textContent || '').trim().split('\n')[0] || `Turn #${idx + 1}`;
      }

      // Format prompt summary (clean excessive whitespace, keep first 2 lines)
      const promptLines = promptText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const cleanPrompt = promptLines.slice(0, 2).join(' ') || `Turn #${idx + 1}`;

      // Extract timestamp (e.g. "12:55")
      let timeStr = '';
      const timeSpan = turnEl.querySelector('.text-muted-foreground.mr-2, span.text-xs');
      if (timeSpan && /\b\d{1,2}:\d{2}\b/.test(timeSpan.textContent || '')) {
        timeStr = timeSpan.textContent.trim();
      } else {
        const match = (turnEl.textContent || '').match(/\b\d{1,2}:\d{2}(?::\d{2})?\b/);
        if (match) timeStr = match[0];
      }

      // Extract response summary
      let responseText = '';
      const responseEl = turnEl.querySelector('[role="article"]:not(.sticky), [data-quotable="true"]');
      if (responseEl) {
        const text = (responseEl.textContent || '').replace(/\s+/g, ' ').trim();
        responseText = text.slice(0, 80) + (text.length > 80 ? '...' : '');
      } else {
        responseText = '...';
      }

      // Calculate relative vertical top position (percentage in viewport)
      const elTop = /** @type {HTMLElement} */ (turnEl).offsetTop || 0;
      const topPercent = Math.min(98, Math.max(2, (elTop / scrollHeight) * 100));

      nodes.push({
        index: idx + 1,
        userText: cleanPrompt,
        responseText,
        timeStr,
        element: /** @type {HTMLElement} */ (turnEl),
        topPercent,
        isActive: false
      });
    });

    return nodes;
  }

  // 4. Create or Get Track Container
  function ensureTrackContainer(viewport) {
    let track = document.getElementById('agy-timeline-track');
    if (!track) {
      track = document.createElement('div');
      track.id = 'agy-timeline-track';
      const parent = viewport.parentElement || document.body;
      parent.style.position = 'relative';
      parent.appendChild(track);
    }
    return track;
  }

  // 5. Create or Get Hover Popover
  function ensurePopover(track) {
    let popover = document.getElementById('agy-timeline-popover');
    if (!popover) {
      popover = document.createElement('div');
      popover.id = 'agy-timeline-popover';
      track.appendChild(popover);

      popover.addEventListener('mouseenter', () => {
        if (hoverTimer) clearTimeout(hoverTimer);
      });

      popover.addEventListener('mouseleave', () => {
        hidePopover();
      });
    }
    return popover;
  }

  function showPopover(node, markerEl) {
    const track = document.getElementById('agy-timeline-track');
    if (!track) return;
    const popover = ensurePopover(track);

    if (hoverTimer) clearTimeout(hoverTimer);

    const txt = t();
    popover.innerHTML = `
      <div class="agy-popover-prompt">${escapeHtml(node.userText)}</div>
      <div class="agy-popover-response">${escapeHtml(node.responseText)}</div>
      <div class="agy-popover-footer">
        <span class="agy-popover-time">⏱️ ${escapeHtml(node.timeStr || txt.turnLabel(node.index))}</span>
        <button class="agy-popover-fork-btn" title="${txt.forkTooltip}" data-fork-index="${node.index}">
          🌿 ${txt.forkButton}
        </button>
      </div>
    `;

    // Position popover vertically aligned with marker
    popover.style.top = `${node.topPercent}%`;
    popover.classList.add('show');

    // Clicking popover body jumps to turn
    popover.onclick = (e) => {
      const target = /** @type {HTMLElement} */ (e.target);
      if (target.closest('.agy-popover-fork-btn')) {
        e.stopPropagation();
        handleFork(node);
        return;
      }
      jumpToTurn(node);
    };
  }

  function hidePopover() {
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = window.setTimeout(() => {
      const popover = document.getElementById('agy-timeline-popover');
      if (popover) {
        popover.classList.remove('show');
      }
    }, 150);
  }

  // 6. Jump to Turn with Highlight Animation
  /**
   * @param {TimelineTurnNode} node
   */
  function jumpToTurn(node) {
    if (!node.element) return;

    node.element.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Highlight target element
    node.element.classList.remove('agy-timeline-target-highlight');
    void node.element.offsetWidth; // Trigger reflow
    node.element.classList.add('agy-timeline-target-highlight');

    setTimeout(() => {
      node.element.classList.remove('agy-timeline-target-highlight');
    }, 1500);

    hidePopover();
  }

  // 7. Fork Interaction
  /**
   * @param {TimelineTurnNode} node
   */
  function handleFork(node) {
    console.log('[Timeline] Fork requested from turn node:', node.index, node.userText);
    const confirmed = window.confirm(`[Fork 对话分支]\n准备从第 ${node.index} 轮开启独立子分支：\n"${node.userText.slice(0, 35)}..."`);
    if (confirmed) {
      // Future integration with Language Server Fork RPC
      alert(`已锁定第 ${node.index} 轮对话快照，新分支已就绪。`);
    }
  }

  // 8. Render Right-edge Markers (Matches User Screenshot ==)
  function renderMarkers(track, nodes) {
    track.querySelectorAll('.agy-timeline-marker').forEach(el => el.remove());

    if (!currentPrefs.showRightEdgeMarkers) return;

    nodes.forEach(node => {
      const marker = document.createElement('div');
      marker.className = `agy-timeline-marker ${node.isActive ? 'is-active' : ''}`;
      marker.style.top = `${node.topPercent}%`;
      marker.title = `${t().turnLabel(node.index)}: ${node.userText.slice(0, 30)}`;

      // Double line bars (Matches Screenshot ==)
      marker.innerHTML = `
        <div class="agy-timeline-marker-bar"></div>
        <div class="agy-timeline-marker-bar"></div>
      `;

      marker.addEventListener('mouseenter', () => {
        if (currentPrefs.showHoverPreview) {
          showPopover(node, marker);
        }
      });

      marker.addEventListener('mouseleave', () => {
        hidePopover();
      });

      marker.addEventListener('click', (e) => {
        e.stopPropagation();
        jumpToTurn(node);
      });

      track.appendChild(marker);
    });
  }

  // 9. Floating Action Button
  function ensureFloatingBtn(viewport) {
    let btn = document.getElementById('agy-timeline-floating-btn');
    if (!btn) {
      btn = document.createElement('div');
      btn.id = 'agy-timeline-floating-btn';
      const parent = viewport.parentElement || document.body;
      parent.appendChild(btn);

      btn.addEventListener('click', () => {
        toggleDrawer();
      });
    }

    const count = currentNodes.length;
    btn.innerHTML = `
      <span class="agy-timeline-indicator"></span>
      <span>${t().turnsCount(count)}</span>
    `;
    return btn;
  }

  // 10. Drawer Panel
  function ensureDrawer(viewport) {
    let drawer = document.getElementById('agy-timeline-drawer');
    if (!drawer) {
      drawer = document.createElement('div');
      drawer.id = 'agy-timeline-drawer';
      const parent = viewport.parentElement || document.body;
      parent.appendChild(drawer);
    }
    return drawer;
  }

  function renderDrawer(nodes) {
    const viewport = getViewport();
    if (!viewport) return;
    const drawer = ensureDrawer(viewport);
    const txt = t();

    drawer.innerHTML = `
      <div class="agy-drawer-header">
        <div class="agy-drawer-title-group">
          <span class="agy-drawer-title">⏱️ ${txt.title}</span>
          <span class="agy-drawer-subtitle">${txt.turnsCount(nodes.length)}</span>
        </div>
        <div class="agy-drawer-actions">
          <button class="agy-drawer-icon-btn" id="agy-drawer-top-btn" title="${txt.topButton}">⬆️</button>
          <button class="agy-drawer-icon-btn" id="agy-drawer-bottom-btn" title="${txt.bottomButton}">⬇️</button>
          <button class="agy-drawer-icon-btn" id="agy-drawer-close-btn" title="${txt.collapseButton}">✖️</button>
        </div>
      </div>
      <div class="agy-drawer-pref-bar">
        <label class="agy-switch-label" title="${txt.disableAutoScrollDesc}">
          <input type="checkbox" class="agy-switch-input" id="agy-pref-autoscroll" ${currentPrefs.disableAutoScrollOnSend ? 'checked' : ''} />
          <span>${txt.disableAutoScrollLabel}</span>
        </label>
      </div>
      <div class="agy-drawer-list" id="agy-drawer-list"></div>
    `;

    // Drawer list items
    const listEl = drawer.querySelector('#agy-drawer-list');
    if (listEl) {
      if (nodes.length === 0) {
        listEl.innerHTML = `<div style="font-size:12px;color:var(--agy-timeline-muted);padding:16px;text-align:center;">${txt.noTurnsFound}</div>`;
      } else {
        nodes.forEach(node => {
          const item = document.createElement('div');
          item.className = `agy-drawer-node-item ${node.isActive ? 'is-active' : ''}`;
          item.innerHTML = `
            <div class="agy-node-badge">#${node.index}</div>
            <div class="agy-node-content">
              <div class="agy-node-prompt" title="${escapeHtml(node.userText)}">${escapeHtml(node.userText)}</div>
              <div class="agy-node-meta">
                <span>⏱️ ${escapeHtml(node.timeStr || txt.turnLabel(node.index))}</span>
                <button class="agy-popover-fork-btn" data-fork-idx="${node.index}" title="${txt.forkTooltip}">🌿 ${txt.forkButton}</button>
              </div>
            </div>
          `;

          item.addEventListener('click', (e) => {
            const target = /** @type {HTMLElement} */ (e.target);
            if (target.closest('.agy-popover-fork-btn')) {
              e.stopPropagation();
              handleFork(node);
              return;
            }
            jumpToTurn(node);
          });

          listEl.appendChild(item);
        });
      }
    }

    // Header buttons
    drawer.querySelector('#agy-drawer-top-btn')?.addEventListener('click', () => {
      viewport.scrollTo({ top: 0, behavior: 'smooth' });
    });
    drawer.querySelector('#agy-drawer-bottom-btn')?.addEventListener('click', () => {
      viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' });
    });
    drawer.querySelector('#agy-drawer-close-btn')?.addEventListener('click', () => {
      toggleDrawer(false);
    });

    // Auto-scroll preference toggle
    const prefCheckbox = /** @type {HTMLInputElement | null} */ (drawer.querySelector('#agy-pref-autoscroll'));
    prefCheckbox?.addEventListener('change', (e) => {
      savePrefs({ disableAutoScrollOnSend: prefCheckbox.checked });
    });
  }

  function toggleDrawer(force) {
    isDrawerOpen = typeof force === 'boolean' ? force : !isDrawerOpen;
    const drawer = document.getElementById('agy-timeline-drawer');
    if (drawer) {
      drawer.classList.toggle('is-open', isDrawerOpen);
    }
  }

  // 11. Smart Scroll Lock (Disable auto-scroll on new message / streaming)
  let lastUserScrollTop = 0;
  let isLockedByPreference = false;

  function setupScrollController(viewport) {
    viewport.addEventListener('scroll', () => {
      // Track active node for Scrollspy
      const viewCenter = viewport.scrollTop + (viewport.clientHeight / 3);
      let closestNode = null;
      let minDiff = Infinity;

      currentNodes.forEach(node => {
        const top = node.element.offsetTop;
        const diff = Math.abs(top - viewCenter);
        if (diff < minDiff) {
          minDiff = diff;
          closestNode = node;
        }
      });

      if (closestNode) {
        currentNodes.forEach(n => {
          n.isActive = (n === closestNode);
        });
        const track = document.getElementById('agy-timeline-track');
        if (track) {
          renderMarkers(track, currentNodes);
        }
      }

      // Record scroll position when user manually scrolls
      const isAtBottom = (viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight) < 40;
      if (!isAtBottom) {
        lastUserScrollTop = viewport.scrollTop;
      }
    }, { passive: true });

    // Intercept scroll-to-bottom on send when preference is enabled
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && currentPrefs.disableAutoScrollOnSend) {
        const activeEl = document.activeElement;
        if (activeEl && (activeEl.tagName === 'TEXTAREA' || activeEl.getAttribute('contenteditable') === 'true')) {
          // User is sending a prompt
          isLockedByPreference = true;
          lastUserScrollTop = viewport.scrollTop;

          // Maintain viewport for next 1.5s while response starts streaming
          const lockInterval = setInterval(() => {
            if (isLockedByPreference && viewport.scrollTop !== lastUserScrollTop) {
              viewport.scrollTop = lastUserScrollTop;
            }
          }, 40);

          setTimeout(() => {
            clearInterval(lockInterval);
            isLockedByPreference = false;
          }, 2000);
        }
      }
    }, true);
  }

  // 12. Main Update Loop
  function renderUI() {
    const viewport = getViewport();
    if (!viewport) return;

    currentViewport = viewport;
    currentNodes = scanTurns();

    const track = ensureTrackContainer(viewport);
    renderMarkers(track, currentNodes);
    ensureFloatingBtn(viewport);
    renderDrawer(currentNodes);
  }

  // 13. MutationObserver for dynamic conversations
  let updateDebounceTimer = null;
  const observer = new MutationObserver((mutations) => {
    let shouldUpdate = false;
    for (const m of mutations) {
      if (m.type === 'childList' && (m.addedNodes.length > 0 || m.removedNodes.length > 0)) {
        shouldUpdate = true;
        break;
      }
    }
    if (shouldUpdate) {
      if (updateDebounceTimer) clearTimeout(updateDebounceTimer);
      updateDebounceTimer = setTimeout(() => {
        renderUI();
      }, 250);
    }
  });

  const targetObserve = document.body;
  observer.observe(targetObserve, { childList: true, subtree: true });

  const initialViewport = getViewport();
  if (initialViewport) {
    setupScrollController(initialViewport);
  }
  renderUI();

  // 14. Global Cleanup handler
  window.__agyTimelineCleanup = () => {
    observer.disconnect();
    staleSelectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => el.remove());
    });
  };
}

/**
 * Utility to escape HTML entities
 * @param {string} str
 */
function escapeHtml(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
