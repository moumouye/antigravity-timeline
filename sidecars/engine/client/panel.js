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

  /** @type {any[]} */
  let fullTranscriptTurns = [];
  /** @type {TimelineTurnNode[]} */
  let currentNodes = [];
  /** @type {number | null} */
  let hideTimer = null;
  /** @type {number | null} */
  let hoverIntentTimer = null;
  let isHoveringHandle = false;
  let isHoveringMenu = false;

  function isHovering() {
    return isHoveringHandle || isHoveringMenu;
  }

  // 3. Conversation & Session Tracking
  function getConversationId() {
    const match = window.location.pathname.match(/\/c\/([a-f0-9\-]+)/);
    return match ? match[1] : '';
  }

  let currentConvId = getConversationId();

  function requestFullTurns(convId) {
    if (!convId) convId = getConversationId();
    if (typeof window.__agyTimelineRequestTurns === 'function' && convId) {
      window.__agyTimelineRequestTurns(convId);
    }
  }

  // Global receiver exposed to Sidecar CDP engine
  window.__agyReceiveFullTurns = (convId, turns) => {
    const activeConvId = getConversationId();
    if (convId && activeConvId && convId !== activeConvId) return;
    if (Array.isArray(turns)) {
      fullTranscriptTurns = turns;
      if (convId) currentConvId = convId;
      renderUI();
    }
  };

  /**
   * Check and reconcile conversation ID change
   * @returns {boolean} true if conversation actually changed
   */
  function syncSessionState() {
    const activeConvId = getConversationId();
    if (activeConvId && activeConvId !== currentConvId) {
      currentConvId = activeConvId;
      fullTranscriptTurns = [];
      currentNodes = [];
      const menu = document.getElementById('agy-timeline-menu');
      if (menu) delete menu.dataset.renderedSignature;
      requestFullTurns(activeConvId);
      return true;
    }
    return false;
  }

  /**
   * @param {TimelineTurnNode[]} nodes
   */
  function computeNodesSignature(nodes) {
    const sessionKey = currentConvId || 'unbound';
    if (!nodes || nodes.length === 0) return `${sessionKey}::empty`;
    return `${sessionKey}::${nodes.length}::` + nodes.map(n => `${n.index}:${n.userText}`).join('|');
  }

  /**
   * Clean and normalize text for reliable cross-DOM matching
   * @param {string} str
   */
  function normalizeTextForMatch(str) {
    return (str || '')
      .replace(/@\[(?:Quote|conversation:[^\]]+|file:[^\]]+|[^\]]+)\]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // 4. Find Viewport
  function getViewport() {
    return /** @type {HTMLElement | null} */ (
      document.querySelector('[data-testid="autoscroll-viewport"]') ||
      document.querySelector('.isolate.overflow-y-auto') ||
      document.querySelector('.overflow-y-auto.min-h-0.w-full')
    );
  }

  // 5. Locate Host "Load Older Messages" button (Only triggered on explicit click of folded turns)
  function findLoadOlderBtn() {
    return Array.from(document.querySelectorAll('button')).find(b => {
      const text = (b.textContent || '').trim().toLowerCase();
      return (text.includes('load older messages') || text.includes('加载更早') || text.includes('更多历史')) && !b.disabled;
    }) || null;
  }

  // 6. Scan and Reconcile Turns (Canonical Full Transcript + DOM Element Binding)
  /**
   * @returns {TimelineTurnNode[]}
   */
  function scanTurns() {
    const viewport = getViewport();
    if (!viewport) return [];

    const userCards = Array.from(document.querySelectorAll('div[class*="group/user-input-step"][class*="pt-4"]'));
    const scrollHeight = Math.max(viewport.scrollHeight, 1);

    // Primary: Canonical Full Turns from Engine Transcript
    if (fullTranscriptTurns && fullTranscriptTurns.length > 0) {
      /** @type {TimelineTurnNode[]} */
      const nodes = fullTranscriptTurns.map((item, idx) => ({
        index: item.index || (idx + 1),
        userText: item.preview || `Turn #${idx + 1}`,
        fullText: item.fullText || item.cleanText || item.preview || '',
        cleanText: item.cleanText || '',
        stepIndex: item.stepIndex,
        responseText: '',
        timeStr: '',
        element: /** @type {HTMLElement | null} */ (null),
        topPercent: 50,
        isActive: false,
        isFolded: true
      }));

      // Bind currently mounted DOM user cards
      userCards.forEach(card => {
        const quotable = card.querySelector('[data-quotable]') || card.querySelector('.whitespace-pre-wrap') || card;
        const cardRawText = (quotable.textContent || '').trim();
        const cardNormText = normalizeTextForMatch(cardRawText);
        if (!cardNormText) return;

        const matchedNode = nodes.find(n => {
          const normClean = normalizeTextForMatch(n.cleanText || n.fullText || n.userText);
          const normUser = normalizeTextForMatch(n.userText);
          const normFull = normalizeTextForMatch(n.fullText);

          return (
            (normClean && (cardNormText.startsWith(normClean.slice(0, 25)) || normClean.startsWith(cardNormText.slice(0, 25)))) ||
            (normUser && (cardNormText.startsWith(normUser.slice(0, 25)) || normUser.startsWith(cardNormText.slice(0, 25)))) ||
            (normFull && (cardNormText.startsWith(normFull.slice(0, 25)) || normFull.startsWith(cardNormText.slice(0, 25))))
          );
        });

        if (matchedNode) {
          matchedNode.element = /** @type {HTMLElement} */ (card);
          matchedNode.isFolded = false;
          const elTop = /** @type {HTMLElement} */ (card).offsetTop || 0;
          matchedNode.topPercent = Math.min(98, Math.max(2, (elTop / scrollHeight) * 100));
        }
      });

      return nodes;
    }

    // Fallback: When transcript is not yet available, parse mounted DOM cards
    /** @type {TimelineTurnNode[]} */
    const domNodes = [];
    userCards.forEach((card, idx) => {
      const quotable = card.querySelector('[data-quotable]') || card.querySelector('.whitespace-pre-wrap') || card;
      const fullText = (quotable.textContent || '').trim();
      const normText = normalizeTextForMatch(fullText);
      const firstLines = normText.split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(0, 2).join(' ') || `Turn #${idx + 1}`;
      const cleanPrompt = firstLines.length > 120 ? firstLines.slice(0, 118) + '...' : firstLines;

      let timeStr = '';
      const match = (card.textContent || '').match(/\b\d{1,2}:\d{2}\b/);
      if (match) timeStr = match[0];

      const elTop = /** @type {HTMLElement} */ (card).offsetTop || 0;
      const topPercent = Math.min(98, Math.max(2, (elTop / scrollHeight) * 100));

      domNodes.push({
        index: idx + 1,
        userText: cleanPrompt,
        fullText,
        cleanText: normText,
        stepIndex: idx,
        responseText: '',
        timeStr,
        element: /** @type {HTMLElement} */ (card),
        topPercent,
        isActive: false,
        isFolded: false
      });
    });

    return domNodes;
  }

  // 7. Viewport Active Node Computation
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
    let closestNode = null;
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

    if (closestNode) {
      nodes.forEach(n => {
        n.isActive = (n === closestNode);
      });
    } else {
      nodes.forEach((n, idx) => {
        n.isActive = (idx === nodes.length - 1);
      });
    }
  }

  // 8. Right-edge Middle Handle (Anchor)
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
        isHoveringHandle = true;
        if (hideTimer) {
          clearTimeout(hideTimer);
          hideTimer = null;
        }
        // Hover Intent 防抖：停留 110ms 以上才展开，杜绝鼠标快速划过时的非预期误触
        if (!hoverIntentTimer) {
          hoverIntentTimer = window.setTimeout(() => {
            hoverIntentTimer = null;
            if (isHovering()) {
              showMenu();
            }
          }, 110);
        }
      };

      const onHandleLeave = (e) => {
        isHoveringHandle = false;
        if (hoverIntentTimer) {
          clearTimeout(hoverIntentTimer);
          hoverIntentTimer = null;
        }
        const related = /** @type {Node | null} */ (e.relatedTarget);
        const menu = document.getElementById('agy-timeline-menu');
        if (related && menu && (menu === related || menu.contains(related))) {
          isHoveringMenu = true;
          return;
        }
        scheduleHideMenu();
      };

      handle.addEventListener('mouseenter', onHandleEnter);
      handle.addEventListener('mouseleave', onHandleLeave);

      // 支持单击直接快速切换展开/关闭
      handle.addEventListener('click', (e) => {
        e.stopPropagation();
        if (hoverIntentTimer) {
          clearTimeout(hoverIntentTimer);
          hoverIntentTimer = null;
        }
        const menu = document.getElementById('agy-timeline-menu');
        if (menu && menu.classList.contains('show')) {
          hideMenu();
        } else {
          isHoveringHandle = true;
          showMenu();
        }
      });
    }
    return handle;
  }

  // 9. Hover Expanded All-Turns Timeline Menu
  function ensureMenu() {
    let menu = document.getElementById('agy-timeline-menu');
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'agy-timeline-menu';
      document.body.appendChild(menu);

      const onMenuEnter = () => {
        isHoveringMenu = true;
        if (hideTimer) {
          clearTimeout(hideTimer);
          hideTimer = null;
        }
      };

      const onMenuLeave = (e) => {
        isHoveringMenu = false;
        const related = /** @type {Node | null} */ (e.relatedTarget);
        const handle = document.getElementById('agy-timeline-handle');
        if (related && handle && (handle === related || handle.contains(related))) {
          isHoveringHandle = true;
          return;
        }
        scheduleHideMenu();
      };

      menu.addEventListener('mouseenter', onMenuEnter);
      menu.addEventListener('mouseleave', onMenuLeave);
    }
    return menu;
  }

  function showMenu() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    const menu = ensureMenu();
    const handle = ensureHandle();
    const viewport = getViewport();

    // Check and sync session state without losing transcript data
    syncSessionState();

    currentNodes = scanTurns();
    updateActiveNode(currentNodes, viewport);

    handle.classList.add('is-active');
    renderMenuList(menu, currentNodes);
    menu.classList.add('show');

    // Auto-scroll menu list to the latest/active turn so user sees recent first
    scrollMenuToActiveTurn(menu, viewport);
  }

  function hideMenu() {
    if (hoverIntentTimer) {
      clearTimeout(hoverIntentTimer);
      hoverIntentTimer = null;
    }
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    isHoveringHandle = false;
    isHoveringMenu = false;

    const menu = document.getElementById('agy-timeline-menu');
    const handle = document.getElementById('agy-timeline-handle');
    if (menu) menu.classList.remove('show');
    if (handle) handle.classList.remove('is-active');
  }

  function scheduleHideMenu(delay = 200) {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      hideTimer = null;
      if (!isHovering()) {
        hideMenu();
      }
    }, delay);
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
   * Render menu list safely with signature verification (Pure prompt only, zero flicker)
   * @param {HTMLElement} menu
   * @param {TimelineTurnNode[]} nodes
   */
  function renderMenuList(menu, nodes) {
    const listEl = menu.querySelector('#agy-menu-list');
    const newSig = computeNodesSignature(nodes);
    const prevSig = menu.dataset.renderedSignature;

    // Zero DOM reconstruction if signature matches
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
        nodes.forEach(node => {
          const card = document.createElement('div');
          card.className = `agy-turn-card ${node.isActive ? 'is-active' : ''} ${node.isFolded ? 'is-folded' : ''}`;
          card.setAttribute('data-turn-idx', String(node.index));
          card.title = node.isFolded ? `${node.userText}\n(早期会话，点击自动展开定位)` : node.userText;
          card.innerHTML = `
            <div class="agy-turn-prompt">${escapeHtml(node.userText)}</div>
          `;

          card.addEventListener('click', async (e) => {
            e.stopPropagation();
            await jumpToTurn(node);
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
        card.classList.toggle('is-folded', Boolean(node.isFolded));
      }
    });
  }

  // 10. Precision Jump (Instant on mounted, on-demand auto-expansion on folded)
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

  function scrollToElement(viewport, element) {
    const turnContainer = element.closest('[class*="scroll-mt"]') || element;
    const vpRect = viewport.getBoundingClientRect();
    const elRect = turnContainer.getBoundingClientRect();
    const currentScrollTop = viewport.scrollTop;

    const relativeOffset = elRect.top - vpRect.top;
    const targetScrollTop = currentScrollTop + relativeOffset - 24;

    const maxScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const finalTop = Math.max(0, Math.min(maxScroll, targetScrollTop));

    smoothScrollTo(viewport, finalTop, 220);

    element.classList.remove('agy-timeline-target-highlight');
    void element.offsetWidth; // Trigger reflow
    element.classList.add('agy-timeline-target-highlight');

    setTimeout(() => {
      element.classList.remove('agy-timeline-target-highlight');
    }, 1500);
  }

  /**
   * Jump to Turn Node
   * @param {TimelineTurnNode} node
   */
  async function jumpToTurn(node) {
    const viewport = getViewport();
    if (!viewport) return;

    // Case 1: Already mounted in DOM
    if (node.element && node.element.isConnected) {
      scrollToElement(viewport, node.element);
      return;
    }

    // Case 2: Folded earlier turn -> User explicitly clicked, expand history on-demand
    const menu = document.getElementById('agy-timeline-menu');
    const cardEl = menu?.querySelector(`[data-turn-idx="${node.index}"]`);
    if (cardEl) {
      cardEl.classList.add('is-loading');
      const promptEl = cardEl.querySelector('.agy-turn-prompt');
      if (promptEl) promptEl.textContent = `⏳ 正在展开并定位第 ${node.index} 轮...`;
    }

    const waitForDomMutation = (timeoutMs = 180) => {
      return new Promise(resolve => {
        let timer = null;
        const observer = new MutationObserver(() => {
          if (timer) clearTimeout(timer);
          observer.disconnect();
          resolve(true);
        });
        const vp = getViewport() || document.body;
        observer.observe(vp, { childList: true, subtree: true });
        timer = setTimeout(() => {
          observer.disconnect();
          resolve(false);
        }, timeoutMs);
      });
    };

    let attempts = 0;
    while (attempts < 8) {
      attempts++;
      const loadBtn = findLoadOlderBtn();
      if (!loadBtn || loadBtn.disabled) break;
      loadBtn.click();
      await waitForDomMutation(180);

      currentNodes = scanTurns();
      const updatedNode = currentNodes.find(n => n.index === node.index);
      if (updatedNode && updatedNode.element && updatedNode.element.isConnected) {
        node = updatedNode;
        break;
      }
    }

    currentNodes = scanTurns();
    const finalNode = currentNodes.find(n => n.index === node.index);
    if (finalNode && finalNode.element && finalNode.element.isConnected) {
      scrollToElement(viewport, finalNode.element);
    }

    if (cardEl) {
      cardEl.classList.remove('is-loading');
      const promptEl = cardEl.querySelector('.agy-turn-prompt');
      if (promptEl) promptEl.textContent = node.userText;
    }
  }

  // 11. Passive Viewport Tracking
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

  // 12. Main Update Loop
  function renderUI() {
    const viewport = getViewport();
    if (!viewport) return;

    setupScrollController(viewport);

    // Sync session state without discarding transcript cache
    syncSessionState();

    currentNodes = scanTurns();
    updateActiveNode(currentNodes, viewport);
    ensureHandle();

    const menu = document.getElementById('agy-timeline-menu');
    if (menu && menu.classList.contains('show')) {
      if (isHovering()) {
        renderMenuList(menu, currentNodes);
      } else {
        hideMenu();
      }
    }
  }

  // 13. Scoped MutationObserver
  let updateDebounceTimer = null;
  const initialViewport = getViewport();

  const domObserver = new MutationObserver(() => {
    if (updateDebounceTimer) clearTimeout(updateDebounceTimer);
    updateDebounceTimer = setTimeout(() => {
      renderUI();
    }, 400);
  });

  if (initialViewport) {
    setupScrollController(initialViewport);
    domObserver.observe(initialViewport, { childList: true, subtree: true });
  } else {
    domObserver.observe(document.body, { childList: true, subtree: true });
  }

  // 14. Global Safety Watchdog & Auto-Dismiss System
  // 14.1 Click Outside to instantly dismiss
  const onGlobalPointerDown = (e) => {
    const menu = document.getElementById('agy-timeline-menu');
    const handle = document.getElementById('agy-timeline-handle');
    if (menu && menu.classList.contains('show')) {
      const target = /** @type {Node | null} */ (e.target);
      if (target && !menu.contains(target) && !handle?.contains(target)) {
        hideMenu();
      }
    }
  };
  document.addEventListener('pointerdown', onGlobalPointerDown, { capture: true, passive: true });

  // 14.2 ESC key to instantly dismiss
  const onGlobalKeyDown = (e) => {
    if (e.key === 'Escape') {
      const menu = document.getElementById('agy-timeline-menu');
      if (menu && menu.classList.contains('show')) {
        hideMenu();
      }
    }
  };
  window.addEventListener('keydown', onGlobalKeyDown, { passive: true });

  // 14.3 Window blur (switching apps/windows) to dismiss
  const onWindowBlur = () => {
    hideMenu();
  };
  window.addEventListener('blur', onWindowBlur);

  // 14.4 Pointer coordinate watchdog: guarantees auto-hide when pointer is physically outside
  const onGlobalPointerMove = (e) => {
    const menu = document.getElementById('agy-timeline-menu');
    if (!menu || !menu.classList.contains('show')) return;

    const handle = document.getElementById('agy-timeline-handle');
    const mRect = menu.getBoundingClientRect();
    const hRect = handle ? handle.getBoundingClientRect() : null;
    const { clientX: x, clientY: y } = e;

    const margin = 20;
    const inMenu = x >= mRect.left - margin && x <= mRect.right + margin &&
                   y >= mRect.top - margin && y <= mRect.bottom + margin;
    const inHandle = hRect ? (x >= hRect.left - margin && x <= hRect.right + margin &&
                              y >= hRect.top - margin && y <= hRect.bottom + margin) : false;

    if (!inMenu && !inHandle) {
      if (isHoveringHandle || isHoveringMenu) {
        isHoveringHandle = false;
        isHoveringMenu = false;
        scheduleHideMenu(140);
      }
    }
  };
  document.addEventListener('pointermove', onGlobalPointerMove, { passive: true });

  // 14.5 SPA Route Switching Interception
  const originalPushState = history.pushState;
  history.pushState = function(...args) {
    originalPushState.apply(this, args);
    setTimeout(() => {
      if (syncSessionState()) {
        renderUI();
      }
    }, 60);
  };

  const originalReplaceState = history.replaceState;
  history.replaceState = function(...args) {
    originalReplaceState.apply(this, args);
    setTimeout(() => {
      if (syncSessionState()) {
        renderUI();
      }
    }, 60);
  };

  const onPopState = () => {
    if (syncSessionState()) {
      renderUI();
    }
  };
  window.addEventListener('popstate', onPopState);
  window.addEventListener('hashchange', onPopState);

  renderUI();
  requestFullTurns();

  // 15. Global Cleanup handler
  window.__agyTimelineCleanup = () => {
    cancelScrollAnimation();
    if (hoverIntentTimer) clearTimeout(hoverIntentTimer);
    if (hideTimer) clearTimeout(hideTimer);
    domObserver.disconnect();
    document.removeEventListener('pointerdown', onGlobalPointerDown, { capture: true });
    window.removeEventListener('keydown', onGlobalKeyDown);
    window.removeEventListener('blur', onWindowBlur);
    document.removeEventListener('pointermove', onGlobalPointerMove);
    window.removeEventListener('popstate', onPopState);
    window.removeEventListener('hashchange', onPopState);
    history.pushState = originalPushState;
    history.replaceState = originalReplaceState;
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
