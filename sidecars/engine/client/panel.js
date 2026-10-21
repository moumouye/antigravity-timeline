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
    '#agy-timeline-settings-panel',
    '#agy-timeline-handle',
    '#agy-timeline-menu'
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
  let hideTimer = null;
  let isHoveringMenuOrHandle = false;

  // Session & Signature tracking to completely eliminate stale cache
  function getCurrentSessionKey() {
    return `${window.location.pathname}${window.location.search}${window.location.hash}`;
  }
  let currentSessionKey = getCurrentSessionKey();

  /**
   * @param {TimelineTurnNode[]} nodes
   */
  function computeNodesSignature(nodes) {
    if (!nodes || nodes.length === 0) return `${currentSessionKey}::empty`;
    return `${currentSessionKey}::${nodes.length}::` + nodes.map(n => `${n.index}:${n.userText}`).join('|');
  }

  // 3. Find Viewport
  function getViewport() {
    return /** @type {HTMLElement | null} */ (
      document.querySelector('[data-testid="autoscroll-viewport"]') ||
      document.querySelector('.isolate.overflow-y-auto') ||
      document.querySelector('.overflow-y-auto.min-h-0.w-full')
    );
  }

  // 4. Locate "Load Older Messages" button (manual on-demand only)
  function findLoadOlderBtn() {
    return Array.from(document.querySelectorAll('button')).find(b => {
      const text = (b.textContent || '').trim().toLowerCase();
      return (text.includes('load older messages') || text.includes('加载更早') || text.includes('更多历史')) && !b.disabled;
    }) || null;
  }

  // 5. Scan All Conversation Turns Accurately
  /**
   * @returns {TimelineTurnNode[]}
   */
  function scanTurns() {
    const viewport = getViewport();
    if (!viewport) return [];

    const userCards = Array.from(document.querySelectorAll('div[class*="group/user-input-step"][class*="pt-4"]'));
    const scrollHeight = Math.max(viewport.scrollHeight, 1);

    /** @type {TimelineTurnNode[]} */
    const nodes = [];

    userCards.forEach((card, idx) => {
      // 1. Extract User Prompt Text
      const quotable = card.querySelector('[data-quotable]') || card.querySelector('.whitespace-pre-wrap') || card;
      const fullText = (quotable.textContent || '').trim();
      const firstLines = fullText.split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(0, 2).join(' ') || `Turn #${idx + 1}`;
      const cleanPrompt = firstLines.length > 120 ? firstLines.slice(0, 118) + '...' : firstLines;

      // 2. Extract Timestamp
      let timeStr = '';
      const match = (card.textContent || '').match(/\b\d{1,2}:\d{2}\b/);
      if (match) timeStr = match[0];

      const elTop = /** @type {HTMLElement} */ (card).offsetTop || 0;
      const topPercent = Math.min(98, Math.max(2, (elTop / scrollHeight) * 100));

      nodes.push({
        index: idx + 1,
        userText: cleanPrompt,
        responseText: '',
        timeStr,
        element: /** @type {HTMLElement} */ (card),
        topPercent,
        isActive: false
      });
    });

    return nodes;
  }

  // 6. Viewport Active Node Computation
  /**
   * @param {TimelineTurnNode[]} nodes
   * @param {HTMLElement | null} viewport
   */
  function updateActiveNode(nodes, viewport) {
    if (!nodes || nodes.length === 0) return;
    if (!viewport) {
      nodes.forEach((n, idx) => {
        n.isActive = (idx === nodes.length - 1);
      });
      return;
    }

    const isAtBottom = (viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight) <= 80;
    if (isAtBottom) {
      nodes.forEach((n, idx) => {
        n.isActive = (idx === nodes.length - 1);
      });
      return;
    }

    const vpRect = viewport.getBoundingClientRect();
    const viewAnchor = vpRect.top + 60;
    let closestNode = nodes[0];
    let minDiff = Infinity;

    nodes.forEach(node => {
      if (!node.element) return;
      const turnContainer = node.element.closest('[class*="scroll-mt"]') || node.element;
      const rect = turnContainer.getBoundingClientRect();
      const diff = Math.abs(rect.top - viewAnchor);
      if (diff < minDiff) {
        minDiff = diff;
        closestNode = node;
      }
    });

    nodes.forEach(n => {
      n.isActive = (n === closestNode);
    });
  }

  // 7. Right-edge Middle Handle (Anchor)
  function ensureHandle() {
    let handle = document.getElementById('agy-timeline-handle');
    if (!handle) {
      handle = document.createElement('div');
      handle.id = 'agy-timeline-handle';
      handle.title = t().title;
      handle.innerHTML = `
        <div class="agy-handle-bar"></div>
        <div class="agy-handle-bar"></div>
      `;
      document.body.appendChild(handle);

      const onHandleEnter = () => {
        isHoveringMenuOrHandle = true;
        if (hideTimer) clearTimeout(hideTimer);
        showMenu();
      };

      const onHandleLeave = (e) => {
        const related = /** @type {Node | null} */ (e.relatedTarget);
        const menu = document.getElementById('agy-timeline-menu');
        if (related && menu && (menu === related || menu.contains(related))) {
          return;
        }
        isHoveringMenuOrHandle = false;
        scheduleHideMenu();
      };

      handle.addEventListener('pointerenter', onHandleEnter);
      handle.addEventListener('mouseenter', onHandleEnter);
      handle.addEventListener('pointerleave', onHandleLeave);
      handle.addEventListener('mouseleave', onHandleLeave);
    }
    return handle;
  }

  // 8. Hover Expanded All-Turns Timeline Menu
  function ensureMenu() {
    let menu = document.getElementById('agy-timeline-menu');
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'agy-timeline-menu';
      document.body.appendChild(menu);

      const onMenuEnter = () => {
        isHoveringMenuOrHandle = true;
        if (hideTimer) clearTimeout(hideTimer);
      };

      const onMenuLeave = (e) => {
        const related = /** @type {Node | null} */ (e.relatedTarget);
        const handle = document.getElementById('agy-timeline-handle');
        if (related && handle && (handle === related || handle.contains(related))) {
          return;
        }
        isHoveringMenuOrHandle = false;
        scheduleHideMenu();
      };

      menu.addEventListener('pointerenter', onMenuEnter);
      menu.addEventListener('mouseenter', onMenuEnter);
      menu.addEventListener('pointerleave', onMenuLeave);
      menu.addEventListener('mouseleave', onMenuLeave);
    }
    return menu;
  }

  function showMenu() {
    if (hideTimer) clearTimeout(hideTimer);
    const menu = ensureMenu();
    const handle = ensureHandle();
    const viewport = getViewport();

    // Check SPA session switch
    const newSessionKey = getCurrentSessionKey();
    if (newSessionKey !== currentSessionKey) {
      currentSessionKey = newSessionKey;
      currentNodes = [];
      delete menu.dataset.renderedSignature;
    }

    currentNodes = scanTurns();
    updateActiveNode(currentNodes, viewport);

    handle.classList.add('is-active');
    renderMenuList(menu, currentNodes);
    menu.classList.add('show');

    // Automatically locate active turn / scroll to bottom so the latest turn is immediately visible
    scrollMenuToActiveTurn(menu, viewport);
  }

  function scheduleHideMenu() {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      if (!isHoveringMenuOrHandle) {
        const menu = document.getElementById('agy-timeline-menu');
        const handle = document.getElementById('agy-timeline-handle');
        if (menu) menu.classList.remove('show');
        if (handle) handle.classList.remove('is-active');
      }
    }, 280);
  }

  /**
   * Scroll menu list to active card or to bottom (latest turn)
   * @param {HTMLElement} menu
   * @param {HTMLElement | null} viewport
   */
  function scrollMenuToActiveTurn(menu, viewport) {
    const listEl = menu.querySelector('#agy-menu-list');
    if (!listEl) return;

    const performScroll = () => {
      const isAtBottom = !viewport || (viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight) <= 80;
      const activeCard = listEl.querySelector('.agy-turn-card.is-active');

      if (isAtBottom || !activeCard) {
        listEl.scrollTop = listEl.scrollHeight;
      } else {
        activeCard.scrollIntoView({ block: 'center', behavior: 'instant' });
      }
    };

    performScroll();
    requestAnimationFrame(performScroll);
  }

  /**
   * Render menu list safely with signature verification (Pure prompt only, no response rows)
   * @param {HTMLElement} menu
   * @param {TimelineTurnNode[]} nodes
   */
  function renderMenuList(menu, nodes) {
    const listEl = menu.querySelector('#agy-menu-list');
    const newSig = computeNodesSignature(nodes);
    const prevSig = menu.dataset.renderedSignature;

    // If already rendered with exact same signature, avoid destroying innerHTML
    if (listEl && prevSig === newSig) {
      updateActiveCardClasses(menu, nodes);
      return;
    }

    menu.dataset.renderedSignature = newSig;
    const txt = t();
    menu.innerHTML = `
      <div class="agy-menu-header">
        <span class="agy-menu-title">
          <span>⏱️ ${txt.title}</span>
        </span>
        <span class="agy-menu-badge">${txt.turnsCount(nodes.length)}</span>
      </div>
      <div class="agy-menu-list" id="agy-menu-list"></div>
    `;

    const newListEl = menu.querySelector('#agy-menu-list');
    if (newListEl) {
      if (nodes.length === 0) {
        newListEl.innerHTML = `<div style="font-size:12px;color:var(--agy-timeline-muted);padding:14px;text-align:center;">${txt.noTurnsFound}</div>`;
      } else {
        // If there are unexpanded older messages in the host, provide an explicit top button
        const olderBtn = findLoadOlderBtn();
        if (olderBtn && !olderBtn.disabled) {
          const loadCard = document.createElement('div');
          loadCard.className = 'agy-timeline-load-btn';
          loadCard.innerHTML = `<span>📜 ${txt.loadOlder || '加载更早对话历史'}</span>`;
          loadCard.addEventListener('click', (e) => {
            e.stopPropagation();
            loadCard.innerHTML = `<span>⏳ 加载中...</span>`;
            olderBtn.click();
            setTimeout(() => {
              currentNodes = scanTurns();
              updateActiveNode(currentNodes, getViewport());
              delete menu.dataset.renderedSignature;
              renderMenuList(menu, currentNodes);
            }, 350);
          });
          newListEl.appendChild(loadCard);
        }

        nodes.forEach(node => {
          const card = document.createElement('div');
          card.className = `agy-turn-card ${node.isActive ? 'is-active' : ''}`;
          card.setAttribute('data-turn-idx', String(node.index));
          card.innerHTML = `
            <div class="agy-turn-prompt" title="${escapeHtml(node.userText)}">${escapeHtml(node.userText)}</div>
          `;

          card.addEventListener('click', (e) => {
            e.stopPropagation();
            jumpToTurn(node);
            scheduleHideMenu();
          });

          newListEl.appendChild(card);
        });
      }
    }
  }

  /**
   * Granular class-only update for active states (zero DOM recreation)
   * @param {HTMLElement} menu
   * @param {TimelineTurnNode[]} nodes
   */
  function updateActiveCardClasses(menu, nodes) {
    const cards = menu.querySelectorAll('.agy-turn-card');
    cards.forEach((card, idx) => {
      const node = nodes[idx];
      if (node) {
        card.classList.toggle('is-active', Boolean(node.isActive));
      }
    });
  }

  // 9. Single-Shot Precision Jump with Immediate User Interruption
  let activeScrollTimer = null;

  function cancelScrollAnimation() {
    if (activeScrollTimer) {
      clearInterval(activeScrollTimer);
      activeScrollTimer = null;
    }
  }

  function smoothScrollTo(viewport, targetTop, duration = 220) {
    cancelScrollAnimation();

    const startTop = viewport.scrollTop;
    const distance = targetTop - startTop;
    if (Math.abs(distance) < 2) {
      viewport.scrollTop = targetTop;
      return;
    }

    const startTime = performance.now();
    activeScrollTimer = setInterval(() => {
      const elapsed = performance.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // easeOutCubic
      const ease = 1 - Math.pow(1 - progress, 3);
      viewport.scrollTop = startTop + distance * ease;

      if (progress >= 1) {
        cancelScrollAnimation();
        viewport.scrollTop = targetTop;
      }
    }, 16);
  }

  /**
   * @param {TimelineTurnNode} node
   */
  async function jumpToTurn(node) {
    const viewport = getViewport();
    if (!viewport) return;

    if (!node.element || !node.element.isConnected) {
      const freshNodes = scanTurns();
      const matched = freshNodes.find(n => n.index === node.index) ||
                      freshNodes.find(n => n.userText === node.userText);
      if (matched && matched.element) {
        node = matched;
      }
    }

    if (!node.element || !node.element.isConnected) return;

    // Use the true turn container instead of the sticky child
    const turnContainer = node.element.closest('[class*="scroll-mt"]') || node.element;
    const vpRect = viewport.getBoundingClientRect();
    const elRect = turnContainer.getBoundingClientRect();
    const currentScrollTop = viewport.scrollTop;

    // Target position: place the turn's prompt cleanly at the top of the viewport
    const relativeOffset = elRect.top - vpRect.top;
    const targetScrollTop = currentScrollTop + relativeOffset - 24;

    const maxScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const finalTop = Math.max(0, Math.min(maxScroll, targetScrollTop));

    smoothScrollTo(viewport, finalTop, 220);

    node.element.classList.remove('agy-timeline-target-highlight');
    void node.element.offsetWidth; // Trigger reflow
    node.element.classList.add('agy-timeline-target-highlight');

    setTimeout(() => {
      node.element.classList.remove('agy-timeline-target-highlight');
    }, 1500);
  }

  // 10. Passive Viewport Tracking (Zero interference with manual user scroll)
  /** @type {HTMLElement | null} */
  let trackedViewport = null;

  function setupScrollController(viewport) {
    if (trackedViewport === viewport) return;
    trackedViewport = viewport;

    const onUserInteraction = () => cancelScrollAnimation();
    viewport.addEventListener('wheel', onUserInteraction, { passive: true });
    viewport.addEventListener('touchstart', onUserInteraction, { passive: true });
    viewport.addEventListener('pointerdown', onUserInteraction, { passive: true });
    window.addEventListener('keydown', (e) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) {
        cancelScrollAnimation();
      }
    }, { passive: true });

    viewport.addEventListener('scroll', () => {
      if (currentNodes.length === 0) return;
      updateActiveNode(currentNodes, viewport);
      const menu = document.getElementById('agy-timeline-menu');
      if (menu && menu.classList.contains('show')) {
        updateActiveCardClasses(menu, currentNodes);
      }
    }, { passive: true });
  }

  // 11. Main Update Loop (Safe and stable)
  function renderUI() {
    const viewport = getViewport();
    if (!viewport) return;

    setupScrollController(viewport);

    // Session detection
    const newSessionKey = getCurrentSessionKey();
    if (newSessionKey !== currentSessionKey) {
      currentSessionKey = newSessionKey;
      currentNodes = [];
      const menu = document.getElementById('agy-timeline-menu');
      if (menu) delete menu.dataset.renderedSignature;
    }

    currentNodes = scanTurns();
    updateActiveNode(currentNodes, viewport);
    ensureHandle();

    const menu = document.getElementById('agy-timeline-menu');
    if (menu && menu.classList.contains('show') && !isHoveringMenuOrHandle) {
      renderMenuList(menu, currentNodes);
    }
  }

  // 12. Scoped MutationObserver (Passive structure tracker)
  let updateDebounceTimer = null;
  const initialViewport = getViewport();

  const domObserver = new MutationObserver(() => {
    if (updateDebounceTimer) clearTimeout(updateDebounceTimer);
    updateDebounceTimer = setTimeout(() => {
      renderUI();
    }, 500);
  });

  if (initialViewport) {
    setupScrollController(initialViewport);
    domObserver.observe(initialViewport, { childList: true, subtree: true });
  } else {
    domObserver.observe(document.body, { childList: true, subtree: true });
  }

  window.addEventListener('popstate', () => {
    currentNodes = [];
    renderUI();
  });
  window.addEventListener('hashchange', () => {
    currentNodes = [];
    renderUI();
  });

  renderUI();

  // 13. Global Cleanup handler
  window.__agyTimelineCleanup = () => {
    cancelScrollAnimation();
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
