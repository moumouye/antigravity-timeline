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
    '#agy-timeline-drawer',
    '#agy-timeline-settings-tab',
    '#agy-timeline-settings-panel'
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
  /** @type {number | null} */
  let hoverTimer = null;
  let isDrawerOpen = false;

  // 3. Find Viewport and All Interactive Turns
  function getViewport() {
    return /** @type {HTMLElement | null} */ (
      document.querySelector('[data-testid="autoscroll-viewport"]') ||
      document.querySelector('.isolate.overflow-y-auto') ||
      document.querySelector('.overflow-y-auto.min-h-0.w-full')
    );
  }

  /**
   * Scan all conversation turns accurately (Scans all user-input steps across entire conversation)
   * @returns {TimelineTurnNode[]}
   */
  function scanTurns() {
    const viewport = getViewport();
    if (!viewport) return [];

    // All user question cards (each card represents one user turn)
    const userCards = Array.from(document.querySelectorAll('div[class*="group/user-input-step"][class*="pt-4"]'));
    const scrollHeight = Math.max(viewport.scrollHeight, 1);

    /** @type {TimelineTurnNode[]} */
    const nodes = [];

    userCards.forEach((card, idx) => {
      // 1. Extract User Prompt Text (Clean and truncate)
      const quotable = card.querySelector('[data-quotable]') || card.querySelector('.whitespace-pre-wrap') || card;
      const fullText = (quotable.textContent || '').trim();
      const firstLine = fullText.split(/\r?\n/).map(l => l.trim()).filter(Boolean)[0] || `Turn #${idx + 1}`;
      const cleanPrompt = firstLine.length > 50 ? firstLine.slice(0, 48) + '...' : firstLine;

      // 2. Extract Timestamp
      let timeStr = '';
      const match = (card.textContent || '').match(/\b\d{1,2}:\d{2}\b/);
      if (match) timeStr = match[0];

      // 3. Find Associated Agent Answer
      let turnWrapper = card;
      while (turnWrapper.parentElement && !turnWrapper.parentElement.className.includes('flex-col gap-0.5') && turnWrapper.parentElement !== document.body) {
        turnWrapper = turnWrapper.parentElement;
      }
      const turnContainer = turnWrapper.parentElement || card.parentElement;
      let responseText = '';
      if (turnContainer) {
        // Find markdown paragraph inside agent answer
        const pList = turnContainer.querySelectorAll('p, .markdown p, [class*="prose"] p');
        for (const p of Array.from(pList)) {
          const t = (p.textContent || '').replace(/\s+/g, ' ').trim();
          if (t && !t.includes(cleanPrompt.slice(0, 15))) {
            responseText = t;
            break;
          }
        }
      }
      if (!responseText) {
        responseText = '...';
      }
      const cleanResponse = responseText.length > 45 ? responseText.slice(0, 42) + '...' : responseText;

      // 4. Calculate relative vertical position
      const elTop = /** @type {HTMLElement} */ (card).offsetTop || 0;
      const topPercent = Math.min(98, Math.max(2, (elTop / scrollHeight) * 100));

      nodes.push({
        index: idx + 1,
        userText: cleanPrompt,
        responseText: cleanResponse,
        timeStr,
        element: /** @type {HTMLElement} */ (card),
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

  // 5. Create or Get Hover Popover (Strictly matches Image 3)
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

  function showPopover(node) {
    const track = document.getElementById('agy-timeline-track');
    if (!track) return;
    const popover = ensurePopover(track);

    if (hoverTimer) clearTimeout(hoverTimer);

    // Image 3 layout: Row 1 = Prompt (truncated), Row 2 = Response Capsule (green, truncated)
    popover.innerHTML = `
      <div class="agy-popover-prompt" title="${escapeHtml(node.userText)}">${escapeHtml(node.userText)}</div>
      <div class="agy-popover-response" title="${escapeHtml(node.responseText)}">${escapeHtml(node.responseText)}</div>
    `;

    popover.style.top = `${node.topPercent}%`;
    popover.classList.add('show');

    popover.onclick = () => {
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
    }, 120);
  }

  // 6. Jump to Turn with Highlight Animation
  /**
   * @param {TimelineTurnNode} node
   */
  function jumpToTurn(node) {
    if (!node.element) return;

    node.element.scrollIntoView({ behavior: 'smooth', block: 'center' });

    node.element.classList.remove('agy-timeline-target-highlight');
    void node.element.offsetWidth; // Trigger reflow
    node.element.classList.add('agy-timeline-target-highlight');

    setTimeout(() => {
      node.element.classList.remove('agy-timeline-target-highlight');
    }, 1500);

    hidePopover();
  }

  // 7. Render Right-edge Markers (Matches Screenshot ==)
  function renderMarkers(track, nodes) {
    track.querySelectorAll('.agy-timeline-marker').forEach(el => el.remove());

    if (!currentPrefs.showRightEdgeMarkers) return;

    nodes.forEach(node => {
      const marker = document.createElement('div');
      marker.className = `agy-timeline-marker ${node.isActive ? 'is-active' : ''}`;
      marker.style.top = `${node.topPercent}%`;
      marker.title = `${t().turnLabel(node.index)}: ${node.userText}`;

      // Double line bars (Matches Screenshot ==)
      marker.innerHTML = `
        <div class="agy-timeline-marker-bar"></div>
        <div class="agy-timeline-marker-bar"></div>
      `;

      marker.addEventListener('mouseenter', () => {
        if (currentPrefs.showHoverPreview) {
          showPopover(node);
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

  // 8. Floating Action Button
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

  // 9. Drawer Panel
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
              </div>
            </div>
          `;

          item.addEventListener('click', () => {
            jumpToTurn(node);
          });

          listEl.appendChild(item);
        });
      }
    }

    drawer.querySelector('#agy-drawer-top-btn')?.addEventListener('click', () => {
      viewport.scrollTo({ top: 0, behavior: 'smooth' });
    });
    drawer.querySelector('#agy-drawer-bottom-btn')?.addEventListener('click', () => {
      viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' });
    });
    drawer.querySelector('#agy-drawer-close-btn')?.addEventListener('click', () => {
      toggleDrawer(false);
    });

    const prefCheckbox = /** @type {HTMLInputElement | null} */ (drawer.querySelector('#agy-pref-autoscroll'));
    prefCheckbox?.addEventListener('change', () => {
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

  // 10. Smart Scroll Lock
  let lastUserScrollTop = 0;
  let isLockedByPreference = false;

  function setupScrollController(viewport) {
    viewport.addEventListener('scroll', () => {
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

      const isAtBottom = (viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight) < 40;
      if (!isAtBottom) {
        lastUserScrollTop = viewport.scrollTop;
      }
    }, { passive: true });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && currentPrefs.disableAutoScrollOnSend) {
        const activeEl = document.activeElement;
        if (activeEl && (activeEl.tagName === 'TEXTAREA' || activeEl.getAttribute('contenteditable') === 'true')) {
          isLockedByPreference = true;
          lastUserScrollTop = viewport.scrollTop;

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

  // 11. Native Antigravity Settings Modal Integration
  function setupSettingsModalIntegration() {
    function checkModal() {
      const dialog = document.querySelector('div[role="dialog"]');
      if (!dialog) return;

      const sidebarNav = dialog.querySelector('.bg-sidebar, nav, [role="tablist"], .flex.flex-col.gap-1');
      if (!sidebarNav || dialog.querySelector('#agy-timeline-settings-tab')) return;

      // Create Settings Tab Button
      const tabBtn = document.createElement('button');
      tabBtn.id = 'agy-timeline-settings-tab';
      tabBtn.className = 'inline-flex items-center font-medium transition-colors select-none outline-none cursor-pointer flex-grow w-full justify-start select-none font-normal h-8 min-w-0 gap-1.5 px-2 py-1 rounded-lg bg-transparent text-secondary-foreground hover:bg-sidebar-muted hover:text-foreground text-sm';
      tabBtn.innerHTML = `
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--agy-timeline-accent);">
          <circle cx="12" cy="12" r="10"></circle>
          <polyline points="12 6 12 12 16 14"></polyline>
        </svg>
        <span>${t().settingsTabName}</span>
      `;

      // Find insertion point
      const lastBtn = sidebarNav.querySelector('button:last-child');
      if (lastBtn && lastBtn.parentElement) {
        lastBtn.parentElement.appendChild(tabBtn);
      } else {
        sidebarNav.appendChild(tabBtn);
      }

      // Find Right Content Pane
      let rightPane = dialog.querySelector('.flex-1.min-w-0.overflow-y-auto, .flex-1.p-6, .overflow-y-auto:not(.bg-sidebar)');
      if (!rightPane) {
        const panes = Array.from(dialog.querySelectorAll('div')).filter(d => d.clientHeight > 200 && d !== sidebarNav && !sidebarNav.contains(d));
        rightPane = panes[panes.length - 1];
      }

      tabBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        // Highlight this tab
        sidebarNav.querySelectorAll('button').forEach(b => {
          b.classList.remove('bg-secondary', 'text-foreground');
        });
        tabBtn.classList.add('bg-secondary', 'text-foreground');

        if (rightPane) {
          // Hide other native views
          Array.from(rightPane.children).forEach(c => {
            if (c.id !== 'agy-timeline-settings-panel') {
              (/** @type {HTMLElement} */ (c)).style.display = 'none';
            }
          });

          // Show timeline settings panel
          let panel = rightPane.querySelector('#agy-timeline-settings-panel');
          if (!panel) {
            panel = renderSettingsPanel();
            rightPane.appendChild(panel);
          }
          (/** @type {HTMLElement} */ (panel)).style.display = 'block';
        }
      });

      // Reset when other native tabs are clicked
      dialog.addEventListener('click', (e) => {
        const target = /** @type {HTMLElement} */ (e.target);
        const clickedBtn = target?.closest('button');
        if (clickedBtn && clickedBtn !== tabBtn && sidebarNav.contains(clickedBtn)) {
          tabBtn.classList.remove('bg-secondary', 'text-foreground');
          const panel = rightPane?.querySelector('#agy-timeline-settings-panel');
          if (panel) {
            (/** @type {HTMLElement} */ (panel)).style.display = 'none';
          }
        }
      });
    }

    function renderSettingsPanel() {
      const panel = document.createElement('div');
      panel.id = 'agy-timeline-settings-panel';
      panel.className = 'h-full w-full overflow-y-auto px-8 py-6 select-none';

      const txt = t();
      panel.innerHTML = `
        <div style="margin-bottom:20px;">
          <h2 style="font-size:18px;font-weight:600;color:var(--foreground);">${txt.settingsTitle}</h2>
          <p style="font-size:12.5px;color:var(--muted-foreground);margin-top:4px;">${txt.settingsSubtitle}</p>
        </div>

        <div class="agy-settings-card">
          <div class="agy-settings-row">
            <div class="agy-settings-label-group">
              <span class="agy-settings-item-title">${txt.disableAutoScrollLabel}</span>
              <span class="agy-settings-item-desc">${txt.disableAutoScrollDesc}</span>
            </div>
            <label class="agy-toggle-switch">
              <input type="checkbox" id="agy-set-autoscroll" ${currentPrefs.disableAutoScrollOnSend ? 'checked' : ''} />
              <span class="agy-toggle-slider"></span>
            </label>
          </div>

          <div class="agy-settings-row" style="border-top:1px solid var(--border);padding-top:12px;">
            <div class="agy-settings-label-group">
              <span class="agy-settings-item-title">${txt.showMarkersLabel}</span>
              <span class="agy-settings-item-desc">${txt.showMarkersDesc}</span>
            </div>
            <label class="agy-toggle-switch">
              <input type="checkbox" id="agy-set-markers" ${currentPrefs.showRightEdgeMarkers ? 'checked' : ''} />
              <span class="agy-toggle-slider"></span>
            </label>
          </div>

          <div class="agy-settings-row" style="border-top:1px solid var(--border);padding-top:12px;">
            <div class="agy-settings-label-group">
              <span class="agy-settings-item-title">${txt.showPreviewLabel}</span>
              <span class="agy-settings-item-desc">${txt.showPreviewDesc}</span>
            </div>
            <label class="agy-toggle-switch">
              <input type="checkbox" id="agy-set-preview" ${currentPrefs.showHoverPreview ? 'checked' : ''} />
              <span class="agy-toggle-slider"></span>
            </label>
          </div>
        </div>
      `;

      // Event listeners for settings
      panel.querySelector('#agy-set-autoscroll')?.addEventListener('change', (e) => {
        savePrefs({ disableAutoScrollOnSend: (/** @type {HTMLInputElement} */ (e.target)).checked });
      });
      panel.querySelector('#agy-set-markers')?.addEventListener('change', (e) => {
        savePrefs({ showRightEdgeMarkers: (/** @type {HTMLInputElement} */ (e.target)).checked });
      });
      panel.querySelector('#agy-set-preview')?.addEventListener('change', (e) => {
        savePrefs({ showHoverPreview: (/** @type {HTMLInputElement} */ (e.target)).checked });
      });

      return panel;
    }

    const observer = new MutationObserver(() => {
      checkModal();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    checkModal();
    return observer;
  }

  // 12. Main Update Loop
  function renderUI() {
    const viewport = getViewport();
    if (!viewport) return;

    currentNodes = scanTurns();

    const track = ensureTrackContainer(viewport);
    renderMarkers(track, currentNodes);
    ensureFloatingBtn(viewport);
    renderDrawer(currentNodes);
  }

  // 13. MutationObserver for dynamic turns
  let updateDebounceTimer = null;
  const domObserver = new MutationObserver(() => {
    if (updateDebounceTimer) clearTimeout(updateDebounceTimer);
    updateDebounceTimer = setTimeout(() => {
      renderUI();
    }, 250);
  });
  domObserver.observe(document.body, { childList: true, subtree: true });

  const initialViewport = getViewport();
  if (initialViewport) {
    setupScrollController(initialViewport);
  }
  const modalObs = setupSettingsModalIntegration();
  renderUI();

  // 14. Global Cleanup handler
  window.__agyTimelineCleanup = () => {
    domObserver.disconnect();
    try { modalObs.disconnect(); } catch {}
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
