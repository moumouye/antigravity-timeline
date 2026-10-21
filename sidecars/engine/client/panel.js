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

  // 2. Inject Stylesheet
  const styleEl = document.createElement('style');
  styleEl.id = 'agy-timeline-styles';
  styleEl.textContent = clientStyles;
  (document.head || document.documentElement).appendChild(styleEl);

  /** @type {TimelineTurnNode[]} */
  let currentNodes = [];
  /** @type {number | null} */
  let hoverTimer = null;
  let isLoadingOlder = false;

  // 3. Find Viewport
  function getViewport() {
    return /** @type {HTMLElement | null} */ (
      document.querySelector('[data-testid="autoscroll-viewport"]') ||
      document.querySelector('.isolate.overflow-y-auto') ||
      document.querySelector('.overflow-y-auto.min-h-0.w-full')
    );
  }

  // 4. Auto-Expand Folded / Collapsed Older Messages in Antigravity
  function autoExpandCollapsedMessages() {
    if (isLoadingOlder) return;

    const viewport = getViewport();
    if (!viewport) return;

    // Find the hidden/sr-only "Load older messages" button
    const loadBtn = Array.from(document.querySelectorAll('button')).find(b => {
      const text = (b.textContent || '').trim().toLowerCase();
      return text.includes('load older messages') || text.includes('加载更早') || text.includes('更多历史');
    });

    if (loadBtn && !loadBtn.disabled) {
      isLoadingOlder = true;
      const prevScrollTop = viewport.scrollTop;
      const prevScrollHeight = viewport.scrollHeight;

      loadBtn.click();

      // Maintain scroll position to avoid jump, then scan next batch
      setTimeout(() => {
        const heightDiff = viewport.scrollHeight - prevScrollHeight;
        if (heightDiff > 0 && prevScrollTop > 50) {
          viewport.scrollTop = prevScrollTop + heightDiff;
        }
        isLoadingOlder = false;
        renderUI();

        // Recursively expand if more older messages exist
        const hasMore = Array.from(document.querySelectorAll('button')).some(b =>
          (b.textContent || '').toLowerCase().includes('load older messages')
        );
        if (hasMore) {
          autoExpandCollapsedMessages();
        }
      }, 350);
    }
  }

  // 5. Scan All Conversation Turns Accurately
  /**
   * @returns {TimelineTurnNode[]}
   */
  function scanTurns() {
    const viewport = getViewport();
    if (!viewport) return [];

    // Query all user question cards across conversation
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
        // Find markdown paragraphs in agent answer
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

  // 6. Create or Get Track Container
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

  // 7. Create or Get Hover Popover (Strictly matches Image 3)
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

  // 8. Jump to Turn with Smooth Scroll and Pulse Glow
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

  // 9. Render Right-edge Markers (Matches Screenshot ==)
  function renderMarkers(track, nodes) {
    track.querySelectorAll('.agy-timeline-marker').forEach(el => el.remove());

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
        showPopover(node);
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

  // 10. Clean Floating Action Pill (Matches Image 2 Right-bottom Pill)
  function ensureFloatingBtn(viewport) {
    let btn = document.getElementById('agy-timeline-floating-btn');
    if (!btn) {
      btn = document.createElement('div');
      btn.id = 'agy-timeline-floating-btn';
      const parent = viewport.parentElement || document.body;
      parent.appendChild(btn);

      btn.addEventListener('click', () => {
        // Clicking floating pill scrolls smoothly to newest turn or tops
        if (currentNodes.length > 0) {
          const last = currentNodes[currentNodes.length - 1];
          jumpToTurn(last);
        }
      });
    }

    const count = currentNodes.length;
    btn.innerHTML = `
      <span class="agy-timeline-indicator"></span>
      <span>${t().turnsCount(count)}</span>
    `;
    return btn;
  }

  // 11. Smart Scroll Lock (Disable auto-scroll to bottom on send)
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

  // 12. Main Update Loop
  function renderUI() {
    const viewport = getViewport();
    if (!viewport) return;

    currentNodes = scanTurns();

    const track = ensureTrackContainer(viewport);
    renderMarkers(track, currentNodes);
    ensureFloatingBtn(viewport);
  }

  // 13. MutationObserver for dynamic turns & auto-expand
  let updateDebounceTimer = null;
  const domObserver = new MutationObserver(() => {
    if (updateDebounceTimer) clearTimeout(updateDebounceTimer);
    updateDebounceTimer = setTimeout(() => {
      autoExpandCollapsedMessages();
      renderUI();
    }, 250);
  });
  domObserver.observe(document.body, { childList: true, subtree: true });

  const initialViewport = getViewport();
  if (initialViewport) {
    setupScrollController(initialViewport);
  }
  autoExpandCollapsedMessages();
  renderUI();

  // 14. Global Cleanup handler
  window.__agyTimelineCleanup = () => {
    domObserver.disconnect();
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
