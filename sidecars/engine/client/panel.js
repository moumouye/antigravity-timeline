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

  // 3. Robust Multi-Source Conversation ID Detector
  function getConversationId() {
    const selectedRow = document.querySelector('[data-testid="conversation-row-sidebar"][data-selected="true"]');
    const hasPathConv = window.location.pathname.match(/\/c\/([a-f0-9\-]+)/i);

    // 1. Primary: Active conversation-view container cascade-id
    const viewEl = document.querySelector('[data-testid="conversation-view"]');
    const viewCascadeId = viewEl?.getAttribute('data-cascade-id');
    if (viewCascadeId && /^[a-f0-9\-]+$/i.test(viewCascadeId)) {
      if (selectedRow) {
        const rowCascadeId = selectedRow.getAttribute('data-cascade-id');
        if (rowCascadeId && /^[a-f0-9\-]+$/i.test(rowCascadeId)) {
          return rowCascadeId;
        }
      }
      return viewCascadeId;
    }

    // 2. Secondary: Currently selected sidebar row
    if (selectedRow) {
      const rowCascadeId = selectedRow.getAttribute('data-cascade-id');
      if (rowCascadeId && /^[a-f0-9\-]+$/i.test(rowCascadeId)) {
        return rowCascadeId;
      }
    }

    const selectedLink = document.querySelector('[class*="bg-sidebar-secondary"] a[href*="/c/"], [class*="bg-sidebar-accent"] a[href*="/c/"]');
    const selectedHref = selectedLink?.getAttribute('href') || '';
    const hrefMatch = selectedHref.match(/\/c\/([a-f0-9\-]+)/i);
    if (hrefMatch) {
      return hrefMatch[1];
    }

    // 3. Tertiary: Fallback to pathname / search / href
    if (hasPathConv) return hasPathConv[1];

    const searchMatch = window.location.search.match(/conversationId=([a-f0-9\-]+)/i);
    if (searchMatch) return searchMatch[1];

    const fullHrefMatch = window.location.href.match(/\/c\/([a-f0-9\-]+)/i);
    if (fullHrefMatch) return fullHrefMatch[1];

    return '';
  }

  let currentConvId = getConversationId();

  /**
   * Robust user card element locator
   * Matches data-testid="user-input-step" and group/user-input-step across varying paddings (pt-4, pt-6, etc.)
   * Filters out any nested descendant elements to ensure 1-to-1 card correspondence.
   * @returns {HTMLElement[]}
   */
  function getUserCards() {
    const rawElements = Array.from(document.querySelectorAll('div[data-testid="user-input-step"], div[class*="group/user-input-step"]'));
    return /** @type {HTMLElement[]} */ (
      rawElements.filter((el, idx) => {
        return el instanceof HTMLElement && !rawElements.some((other, oIdx) => oIdx !== idx && other.contains(el));
      })
    );
  }

  // Smart Turn Anchoring Controller state
  let userInteractedWithScroll = false;
  let sessionArrivalPending = true; // True on initial load or conversation switch
  let sessionArrivalStartTime = performance.now();
  let firstAlignedTime = 0;
  let lastKnownTurnCount = 0;
  let lastKnownBottomPrompt = '';
  let isNavigatingTurn = false;
  let streamLockActive = false;
  let arrivalAnchorRaf = null;

  function triggerSessionArrivalAnchor(reason = 'session_switch') {
    if (isNavigatingTurn) return;
    sessionArrivalPending = true;
    userInteractedWithScroll = false;
    sessionArrivalStartTime = performance.now();
    firstAlignedTime = 0;
    streamLockActive = false;

    if (arrivalAnchorRaf) {
      cancelAnimationFrame(arrivalAnchorRaf);
      arrivalAnchorRaf = null;
    }
    runArrivalAnchorLoop();
  }

  function checkAndApplyArrivalAnchor(viewport) {
    if (!sessionArrivalPending || userInteractedWithScroll || isNavigatingTurn || !viewport) {
      sessionArrivalPending = false;
      return;
    }

    setupScrollController(viewport);
    const now = performance.now();
    const userCards = getUserCards();

    if (userCards.length > 0) {
      const lastCard = userCards[userCards.length - 1];
      const finalTop = computeTargetScrollTopForElement(viewport, lastCard);
      const diff = Math.abs(viewport.scrollTop - finalTop);

      // 如果视口偏离最后一轮提问头部（例如被宿主强推到底部），立即纠正对齐
      if (diff > 5) {
        viewport.scrollTop = finalTop;
      }

      if (firstAlignedTime === 0) {
        firstAlignedTime = now;
      } else if (now - firstAlignedTime > 1800) {
        // 宿主 autoscroll 均已收敛平息且视口稳定在目标位置超过 1.8 秒，平稳退出到达守护
        sessionArrivalPending = false;
      }
    } else {
      // 卡片尚未挂载完全时，设置 4500ms 超时上限
      if (now - sessionArrivalStartTime > 4500) {
        sessionArrivalPending = false;
      }
    }
  }

  function runArrivalAnchorLoop() {
    if (!sessionArrivalPending || userInteractedWithScroll) {
      sessionArrivalPending = false;
      return;
    }

    const viewport = getViewport();
    if (viewport) {
      checkAndApplyArrivalAnchor(viewport);
    }

    if (sessionArrivalPending) {
      arrivalAnchorRaf = requestAnimationFrame(runArrivalAnchorLoop);
    }
  }

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
      currentConvId = convId || '';
      renderUI();
    }
  };

  /**
   * Check and reconcile conversation ID change
   * @returns {boolean} true if conversation actually changed
   */
  function syncSessionState() {
    const activeConvId = getConversationId();
    if (activeConvId !== currentConvId) {
      const isInitialBinding = (currentConvId === null || currentConvId === undefined || currentConvId === '');
      currentConvId = activeConvId;
      fullTranscriptTurns = [];
      currentNodes = [];
      lastKnownTurnCount = 0;
      lastKnownBottomPrompt = '';
      
      const menu = document.getElementById('agy-timeline-menu');
      if (menu) delete menu.dataset.renderedSignature;

      if (activeConvId) {
        if (!isHovering() && !isInitialBinding && !isNavigatingTurn) {
          triggerSessionArrivalAnchor('session_switch');
        }
        requestFullTurns(activeConvId);
      } else {
        // Switched to empty / new conversation
        sessionArrivalPending = false;
        streamLockActive = false;
        if (arrivalAnchorRaf) {
          cancelAnimationFrame(arrivalAnchorRaf);
          arrivalAnchorRaf = null;
        }
        hideMenu();
      }
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
      if (b.disabled) return false;
      const text = (b.textContent || '').trim().toLowerCase();
      const aria = (b.getAttribute('aria-label') || '').trim().toLowerCase();
      const testId = (b.getAttribute('data-testid') || '').trim().toLowerCase();
      if (text.includes('no more') || aria.includes('no more')) return false;
      const matchesText = text.includes('load older') || text.includes('加载更早') || text.includes('更多历史') || text.includes('加载历史');
      const matchesAria = aria.includes('load older') || aria.includes('加载更早') || aria.includes('更多历史');
      const matchesTestId = testId.includes('load-older') || testId.includes('load-more');
      return matchesText || matchesAria || matchesTestId;
    }) || null;
  }

  /**
   * Extract clean text from a user card element, removing pills, quotes, and attachments
   * @param {Element} card
   */
  function extractCardText(card) {
    const quotable = card.querySelector('[data-quotable]') || card.querySelector('.whitespace-pre-wrap') || card;
    const rawText = (quotable.textContent || '').trim();

    let cleanText = rawText;
    try {
      const clone = quotable.cloneNode(true);
      if (clone instanceof HTMLElement) {
        clone.querySelectorAll('.context-scope-mention, [data-uri], [class*="inline-pill"]').forEach(el => el.remove());
        cleanText = (clone.textContent || '').trim();
      }
    } catch {}

    return {
      raw: rawText,
      clean: cleanText || rawText
    };
  }

  // 6. Scan and Reconcile Turns (Canonical Full Transcript + DOM Element Binding)
  /**
   * @returns {TimelineTurnNode[]}
   */
  function scanTurns() {
    const viewport = getViewport();
    if (!viewport) return [];

    const userCards = getUserCards();
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
      // Pass 1: Precise content matching (cleaning quote pills and attachments)
      userCards.forEach(card => {
        const { raw: cardRawText, clean: cardCleanText } = extractCardText(card);
        const cardNormClean = normalizeTextForMatch(cardCleanText);
        const cardNormRaw = normalizeTextForMatch(cardRawText);
        if (!cardNormClean && !cardNormRaw) return;

        const matchedNode = nodes.find(n => {
          if (n.element) return false;

          const normClean = normalizeTextForMatch(n.cleanText || n.fullText || n.userText);
          const normUser = normalizeTextForMatch(n.userText);
          const normFull = normalizeTextForMatch(n.fullText);

          // 1. Clean DOM text starts with or includes transcript prompt
          if (cardNormClean && normClean) {
            const prefixClean = normClean.slice(0, 20);
            const prefixCard = cardNormClean.slice(0, 20);
            if (cardNormClean.startsWith(prefixClean) || normClean.startsWith(prefixCard) || cardNormClean.includes(prefixClean)) {
              return true;
            }
          }

          // 2. Clean DOM text with userText preview
          if (cardNormClean && normUser) {
            const prefixUser = normUser.slice(0, 20);
            if (cardNormClean.startsWith(prefixUser) || normUser.startsWith(cardNormClean.slice(0, 20)) || cardNormClean.includes(prefixUser)) {
              return true;
            }
          }

          // 3. Fallback to raw text matching
          if (cardNormRaw && (normClean || normFull)) {
            const prefix = (normClean || normFull).slice(0, 20);
            if (cardNormRaw.includes(prefix)) {
              return true;
            }
          }

          return false;
        });

        if (matchedNode) {
          matchedNode.element = /** @type {HTMLElement} */ (card);
          matchedNode.isFolded = false;
          const elTop = /** @type {HTMLElement} */ (card).offsetTop || 0;
          matchedNode.topPercent = Math.min(98, Math.max(2, (elTop / scrollHeight) * 100));
        }
      });

      // Pass 2: Positional sequence alignment fallback
      // In Antigravity's virtualized list, mounted cards are always a contiguous chronological suffix of turns
      const mountedIndices = nodes.map((n, i) => n.element ? i : -1).filter(i => i >= 0);
      if (mountedIndices.length > 0 && mountedIndices.length < userCards.length) {
        const lastMatchedNodeIdx = mountedIndices[mountedIndices.length - 1];
        const lastMatchedCardIdx = userCards.indexOf(/** @type {HTMLElement} */ (nodes[lastMatchedNodeIdx].element));
        if (lastMatchedCardIdx >= 0) {
          userCards.forEach((card, cIdx) => {
            const offsetFromAnchor = cIdx - lastMatchedCardIdx;
            const targetNodeIdx = lastMatchedNodeIdx + offsetFromAnchor;
            if (targetNodeIdx >= 0 && targetNodeIdx < nodes.length && !nodes[targetNodeIdx].element) {
              nodes[targetNodeIdx].element = /** @type {HTMLElement} */ (card);
              nodes[targetNodeIdx].isFolded = false;
              const elTop = /** @type {HTMLElement} */ (card).offsetTop || 0;
              nodes[targetNodeIdx].topPercent = Math.min(98, Math.max(2, (elTop / scrollHeight) * 100));
            }
          });
        }
      } else if (mountedIndices.length === 0 && userCards.length > 0) {
        const numToBind = Math.min(userCards.length, nodes.length);
        for (let i = 0; i < numToBind; i++) {
          const card = userCards[userCards.length - 1 - i];
          const node = nodes[nodes.length - 1 - i];
          if (card && node && !node.element) {
            node.element = /** @type {HTMLElement} */ (card);
            node.isFolded = false;
            const elTop = /** @type {HTMLElement} */ (card).offsetTop || 0;
            node.topPercent = Math.min(98, Math.max(2, (elTop / scrollHeight) * 100));
          }
        }
      }

      return nodes;
    }

    // If current conversation is empty/new, return empty nodes
    if (!currentConvId) {
      return [];
    }

    // Fallback: When transcript is not yet available, parse mounted DOM cards
    /** @type {TimelineTurnNode[]} */
    const domNodes = [];
    userCards.forEach((card, idx) => {
      const { raw: fullText, clean: normText } = extractCardText(card);
      const cleanNorm = normalizeTextForMatch(normText);
      const firstLines = cleanNorm.split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(0, 2).join(' ') || `Turn #${idx + 1}`;
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
        cleanText: cleanNorm,
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
        // 用户悬停手柄，取消任何未完成的到达守护与滚动动画，保证主视口位移严格恒为 0
        cancelScrollAnimation();
        sessionArrivalPending = false;
        streamLockActive = false;
        userInteractedWithScroll = true;
        if (arrivalAnchorRaf) {
          cancelAnimationFrame(arrivalAnchorRaf);
          arrivalAnchorRaf = null;
        }

        if (hideTimer) {
          clearTimeout(hideTimer);
          hideTimer = null;
        }
        // Hover Intent 防抖：停留 110ms 以上才展开，杜绝鼠标快速划过时的非预期误触
        if (!hoverIntentTimer) {
          hoverIntentTimer = window.setTimeout(() => {
            hoverIntentTimer = null;
            if (isHovering()) {
              showMenu(false);
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
          showMenu(true);
        }
      });
    }
    return handle;
  }

  function updateHandleState(handle, turnsCount) {
    if (!handle) return;
    const txt = t();
    if (turnsCount === 0) {
      handle.title = `${txt.title} (${txt.turnsCount(0)})`;
      handle.classList.add('is-empty');
    } else {
      handle.title = `${txt.title} (${txt.turnsCount(turnsCount)})`;
      handle.classList.remove('is-empty');
    }
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

  function showMenu(isExplicitClick = false) {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    // 菜单展开交互期间，主视口必须保持绝对静止（位移为 0 铁律）
    sessionArrivalPending = false;
    streamLockActive = false;
    userInteractedWithScroll = true;
    cancelScrollAnimation();
    if (arrivalAnchorRaf) {
      cancelAnimationFrame(arrivalAnchorRaf);
      arrivalAnchorRaf = null;
    }

    // Check and sync session state without losing transcript data
    syncSessionState();

    currentNodes = scanTurns();
    const viewport = getViewport();
    if (viewport) {
      updateActiveNode(currentNodes, viewport);
    }

    const handle = ensureHandle();
    updateHandleState(handle, currentNodes.length);

    // 若当前为 0 轮对话且属于鼠标悬停（非显式单击），不展开空菜单，避免无意义弹窗干扰新会话初始界面；
    // 仅在用户显式单击手柄时展开以查看状态
    if (currentNodes.length === 0 && !isExplicitClick) {
      return;
    }

    const menu = ensureMenu();

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
        const cardTop = activeCard.offsetTop;
        listEl.scrollTop = Math.max(0, cardTop - listEl.clientHeight / 2 + activeCard.clientHeight / 2);
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
            scheduleHideMenu(300);
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

  function computeTargetScrollTopForElement(viewport, element) {
    const turnContainer = element.closest('[class*="scroll-mt"]') || element;
    const vpRect = viewport.getBoundingClientRect();
    const elRect = turnContainer.getBoundingClientRect();
    const currentScrollTop = viewport.scrollTop;

    const relativeOffset = elRect.top - vpRect.top;
    const targetScrollTop = currentScrollTop + relativeOffset;

    const maxScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    return Math.max(0, Math.min(maxScroll, targetScrollTop));
  }

  function scrollToElement(viewport, element) {
    const finalTop = computeTargetScrollTopForElement(viewport, element);
    smoothScrollTo(viewport, finalTop, 220);
  }

  /**
   * Jump to Turn Node
   * @param {TimelineTurnNode} node
   */
  async function jumpToTurn(node) {
    const viewport = getViewport();
    if (!viewport) return;

    // 1. 立即解除任何被动滚动守护与流式锁定，标记用户已发起明确的主动定位
    isNavigatingTurn = true;
    userInteractedWithScroll = true;
    sessionArrivalPending = false;
    streamLockActive = false;
    if (arrivalAnchorRaf) {
      cancelAnimationFrame(arrivalAnchorRaf);
      arrivalAnchorRaf = null;
    }
    cancelScrollAnimation();

    // 重新扫描最新 DOM 节点，校准元素引用
    currentNodes = scanTurns();
    let targetNode = currentNodes.find(n => n.index === node.index) || node;

    // Case 1: Already mounted in DOM
    if (targetNode.element && targetNode.element.isConnected) {
      scrollToElement(viewport, targetNode.element);
      setTimeout(() => {
        isNavigatingTurn = false;
      }, 300);
      return;
    }

    // Case 2: Folded earlier turn -> User explicitly clicked, expand history on-demand
    const menu = document.getElementById('agy-timeline-menu');
    const cardEl = menu?.querySelector(`[data-turn-idx="${targetNode.index}"]`);
    if (cardEl) {
      cardEl.classList.add('is-loading');
      const promptEl = cardEl.querySelector('.agy-turn-prompt');
      if (promptEl) promptEl.textContent = `⏳ 正在展开并定位第 ${targetNode.index} 轮...`;
    }

    const waitForDomMutation = (timeoutMs = 300) => {
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
    while (attempts < 15) {
      attempts++;
      const loadBtn = findLoadOlderBtn();
      if (!loadBtn || loadBtn.disabled) break;
      loadBtn.click();
      await waitForDomMutation(300);

      currentNodes = scanTurns();
      const updatedNode = currentNodes.find(n => n.index === targetNode.index);
      if (updatedNode && updatedNode.element && updatedNode.element.isConnected) {
        targetNode = updatedNode;
        break;
      }
    }

    currentNodes = scanTurns();
    const finalNode = currentNodes.find(n => n.index === targetNode.index) || targetNode;
    if (finalNode && finalNode.element && finalNode.element.isConnected) {
      scrollToElement(viewport, finalNode.element);
    }

    if (cardEl) {
      cardEl.classList.remove('is-loading');
      const promptEl = cardEl.querySelector('.agy-turn-prompt');
      if (promptEl) promptEl.textContent = targetNode.userText;
    }

    setTimeout(() => {
      isNavigatingTurn = false;
    }, 300);
  }

  // 11. Smart Turn Anchoring Controller (Session Switch Arrival & New Turn Lock)
  function checkAndApplyViewAnchoring(viewport) {
    if (!viewport || isNavigatingTurn) return;
    const userCards = getUserCards();
    if (userCards.length === 0) return;

    const currentCount = userCards.length;
    const lastCard = userCards[currentCount - 1];
    const { clean: currentLastText } = extractCardText(lastCard);
    const currentBottomPromptSig = normalizeTextForMatch(currentLastText);

    // 场景 1：切换/进入新对话时，自动定位至最后一轮对话的刚开始（图 2 状态）
    if (sessionArrivalPending && !userInteractedWithScroll && !isNavigatingTurn) {
      checkAndApplyArrivalAnchor(viewport);
    }

    // 场景 2：在当前会话中产生新一轮对话（用户发送了新提问）
    // 关键修复：绝不能仅凭 userCards.length 增大就判定为新提问！展开历史折叠消息时 DOM 节点数量同样会增加。
    // 必须判定末尾卡片提问内容发生实质改变（真正的新提问产生），且当前不处于主动导航跳转中。
    const isNewUserPromptSent = !isNavigatingTurn &&
      lastKnownBottomPrompt &&
      currentBottomPromptSig &&
      lastKnownBottomPrompt !== currentBottomPromptSig;

    if (isNewUserPromptSent) {
      if (currentPrefs.disableAutoScrollOnSend) {
        userInteractedWithScroll = false;
        streamLockActive = true;
        scrollToElement(viewport, lastCard);
      }
    }

    // 场景 2 伴随：模型在流式输出期间，维持视口在这一轮提问头部，防止被宿主强制滚底
    if (!isNavigatingTurn && streamLockActive && !userInteractedWithScroll && currentPrefs.disableAutoScrollOnSend) {
      const finalTop = computeTargetScrollTopForElement(viewport, lastCard);
      const isNearBottom = (viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight) <= 80;
      if (isNearBottom) {
        viewport.scrollTop = finalTop;
      }
    }

    lastKnownTurnCount = currentCount;
    if (currentBottomPromptSig) {
      lastKnownBottomPrompt = currentBottomPromptSig;
    }
  }

  // 12. Passive Viewport Tracking & Scroll Controller
  /** @type {HTMLElement | null} */
  let trackedViewport = null;

  function setupScrollController(viewport) {
    if (!viewport || (trackedViewport === viewport && viewport.isConnected)) return;
    trackedViewport = viewport;

    // 仅在真实的手动滚动动作（滚轮、触摸手势、方向键）时解除自动锚定与锁定
    const onManualScrollInteraction = () => {
      cancelScrollAnimation();
      userInteractedWithScroll = true;
      sessionArrivalPending = false;
      streamLockActive = false;
      if (arrivalAnchorRaf) {
        cancelAnimationFrame(arrivalAnchorRaf);
        arrivalAnchorRaf = null;
      }
    };

    viewport.addEventListener('wheel', onManualScrollInteraction, { passive: true });
    viewport.addEventListener('touchstart', onManualScrollInteraction, { passive: true });
    window.addEventListener('keydown', (e) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) {
        onManualScrollInteraction();
      }
    }, { passive: true });

    viewport.addEventListener('scroll', () => {
      // 在会话切换到达守护期间，若检测到宿主强行滚底或偏离卡片，立即纠正
      if (sessionArrivalPending && !userInteractedWithScroll && !isNavigatingTurn) {
        checkAndApplyArrivalAnchor(viewport);
      }

      if (currentNodes.length === 0) return;
      updateActiveNode(currentNodes, viewport);
      const menu = document.getElementById('agy-timeline-menu');
      if (menu && menu.classList.contains('show')) {
        updateActiveCardClasses(menu, currentNodes);
      }
    }, { passive: true });
  }

  // 13. Main Update Loop
  function renderUI() {
    const viewport = getViewport();
    if (!viewport) return;

    setupScrollController(viewport);

    // Sync session state without discarding transcript cache
    syncSessionState();

    currentNodes = scanTurns();
    updateActiveNode(currentNodes, viewport);
    const handle = ensureHandle();
    updateHandleState(handle, currentNodes.length);

    // Check and anchor viewport to latest turn header (Session Arrival & Stream Guard)
    checkAndApplyViewAnchoring(viewport);

    const menu = document.getElementById('agy-timeline-menu');
    if (menu && menu.classList.contains('show')) {
      if (isHovering()) {
        renderMenuList(menu, currentNodes);
      } else {
        hideMenu();
      }
    }
  }

  // 14. Global MutationObserver (Observing Body to survive viewport destruction on SPA navigation)
  let updateDebounceTimer = null;

  const domObserver = new MutationObserver(() => {
    const vp = getViewport();
    if (vp && vp !== trackedViewport) {
      setupScrollController(vp);
    }
    syncSessionState();
    if (vp && sessionArrivalPending && !userInteractedWithScroll && !isNavigatingTurn) {
      checkAndApplyArrivalAnchor(vp);
    }
    if (updateDebounceTimer) clearTimeout(updateDebounceTimer);
    updateDebounceTimer = setTimeout(() => {
      renderUI();
    }, 400);
  });

  domObserver.observe(document.body, { childList: true, subtree: true });

  // 15. Global Safety Watchdog & Auto-Dismiss System
  // 15.1 Click Outside to instantly dismiss
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

  // 15.2 ESC key to instantly dismiss
  const onGlobalKeyDown = (e) => {
    if (e.key === 'Escape') {
      const menu = document.getElementById('agy-timeline-menu');
      if (menu && menu.classList.contains('show')) {
        hideMenu();
      }
    }
  };
  window.addEventListener('keydown', onGlobalKeyDown, { passive: true });

  // 15.3 Window blur (switching apps/windows) to dismiss
  const onWindowBlur = () => {
    hideMenu();
  };
  window.addEventListener('blur', onWindowBlur);

  // 15.4 Pointer coordinate watchdog: guarantees auto-hide when pointer is physically outside
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

  // 15.5 SPA Route Switching Interception
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

  // 15.6 Sidebar Row Click Instant Arrival Trigger
  const onSidebarRowClick = (e) => {
    const target = /** @type {HTMLElement | null} */ (e.target);
    const newConvBtn = target?.closest('[data-testid="new-conversation-button"], a[href="/"]');
    if (newConvBtn) {
      sessionArrivalPending = false;
      streamLockActive = false;
      if (arrivalAnchorRaf) {
        cancelAnimationFrame(arrivalAnchorRaf);
        arrivalAnchorRaf = null;
      }
      hideMenu();
      syncSessionState();
      return;
    }
    const row = target?.closest('[data-testid="conversation-row-sidebar"], a[href*="/c/"]');
    if (row) {
      triggerSessionArrivalAnchor('sidebar_click');
    }
  };
  document.addEventListener('click', onSidebarRowClick, { capture: true, passive: true });

  const onPopState = () => {
    if (syncSessionState()) {
      renderUI();
    }
  };
  window.addEventListener('popstate', onPopState);
  window.addEventListener('hashchange', onPopState);

  renderUI();
  requestFullTurns();

  // 16. Global Cleanup handler
  window.__agyTimelineCleanup = () => {
    cancelScrollAnimation();
    if (arrivalAnchorRaf) cancelAnimationFrame(arrivalAnchorRaf);
    if (hoverIntentTimer) clearTimeout(hoverIntentTimer);
    if (hideTimer) clearTimeout(hideTimer);
    domObserver.disconnect();
    document.removeEventListener('pointerdown', onGlobalPointerDown, { capture: true });
    window.removeEventListener('keydown', onGlobalKeyDown);
    window.removeEventListener('blur', onWindowBlur);
    document.removeEventListener('pointermove', onGlobalPointerMove);
    document.removeEventListener('click', onSidebarRowClick, { capture: true });
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
