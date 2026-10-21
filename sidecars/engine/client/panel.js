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

  // 3. Find Viewport
  function getViewport() {
    return /** @type {HTMLElement | null} */ (
      document.querySelector('[data-testid="autoscroll-viewport"]') ||
      document.querySelector('.isolate.overflow-y-auto') ||
      document.querySelector('.overflow-y-auto.min-h-0.w-full')
    );
  }

  // 4. Safe Full History Auto-Expansion (Zero scrollTop tampering)
  function findLoadOlderBtn() {
    return Array.from(document.querySelectorAll('button')).find(b => {
      const text = (b.textContent || '').trim().toLowerCase();
      return (text.includes('load older messages') || text.includes('加载更早') || text.includes('更多历史')) && !b.disabled;
    }) || null;
  }

  let isAutoExpanding = false;
  async function expandAllHistorySilently() {
    if (isAutoExpanding) return;
    isAutoExpanding = true;

    try {
      let loops = 0;
      let loadBtn = findLoadOlderBtn();
      while (loadBtn && !loadBtn.disabled && loops < 15) {
        loops++;
        loadBtn.click();
        await new Promise(r => setTimeout(r, 180));
        loadBtn = findLoadOlderBtn();
      }
    } catch {}

    isAutoExpanding = false;
    currentNodes = scanTurns();
    ensureHandle();
    const menu = document.getElementById('agy-timeline-menu');
    if (menu && menu.classList.contains('show')) {
      renderMenuList(menu, currentNodes);
    }
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
      const cleanPrompt = firstLines.length > 70 ? firstLines.slice(0, 68) + '...' : firstLines;

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

  // 6. Right-edge Middle Handle (Anchor)
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

  // 7. Hover Expanded All-Turns Timeline Menu
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

    if (findLoadOlderBtn()) {
      expandAllHistorySilently();
    }

    currentNodes = scanTurns();
    handle.classList.add('is-active');
    renderMenuList(menu, currentNodes);
    menu.classList.add('show');
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
   * Render menu list safely (Pure prompt only, no response rows)
   * @param {HTMLElement} menu
   * @param {TimelineTurnNode[]} nodes
   */
  function renderMenuList(menu, nodes) {
    const listEl = menu.querySelector('#agy-menu-list');

    // If already rendered with exact same count, avoid destroying innerHTML
    if (listEl && listEl.children.length === nodes.length && nodes.length > 0) {
      updateActiveCardClasses(menu, nodes);
      return;
    }

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

  // 8. Single-Shot Precision Jump with Easing (Bypasses sticky top-0 traps)
  let activeScrollTimer = null;

  function smoothScrollTo(viewport, targetTop, duration = 260) {
    if (activeScrollTimer) {
      clearInterval(activeScrollTimer);
      activeScrollTimer = null;
    }

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
        clearInterval(activeScrollTimer);
        activeScrollTimer = null;
        viewport.scrollTop = targetTop;
      }
    }, 16);
  }

  /**
   * @param {TimelineTurnNode} node
   */
  function jumpToTurn(node) {
    const viewport = getViewport();
    if (!viewport || !node.element) return;

    // Direct geometric delta calculation relative to viewport
    const vpRect = viewport.getBoundingClientRect();
    const elRect = node.element.getBoundingClientRect();
    const currentScrollTop = viewport.scrollTop;

    // Target position: card top aligned near viewport upper comfortable area
    const relativeOffset = elRect.top - vpRect.top;
    const targetScrollTop = currentScrollTop + relativeOffset - 40; // 40px comfortable header clearance

    const maxScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const finalTop = Math.max(0, Math.min(maxScroll, targetScrollTop));

    smoothScrollTo(viewport, finalTop, 260);

    node.element.classList.remove('agy-timeline-target-highlight');
    void node.element.offsetWidth; // Trigger reflow
    node.element.classList.add('agy-timeline-target-highlight');

    setTimeout(() => {
      node.element.classList.remove('agy-timeline-target-highlight');
    }, 1500);
  }

  // 9. Passive Viewport Tracking (Zero scrollTop tampering)
  function setupScrollController(viewport) {
    viewport.addEventListener('scroll', () => {
      if (currentNodes.length === 0) return;
      const vpRect = viewport.getBoundingClientRect();
      const viewCenter = vpRect.top + (vpRect.height / 3);

      let closestNode = null;
      let minDiff = Infinity;

      currentNodes.forEach(node => {
        if (!node.element) return;
        const rect = node.element.getBoundingClientRect();
        const diff = Math.abs(rect.top - viewCenter);
        if (diff < minDiff) {
          minDiff = diff;
          closestNode = node;
        }
      });

      if (closestNode) {
        currentNodes.forEach(n => {
          n.isActive = (n === closestNode);
        });
        const menu = document.getElementById('agy-timeline-menu');
        if (menu && menu.classList.contains('show')) {
          updateActiveCardClasses(menu, currentNodes);
        }
      }
    }, { passive: true });
  }

  // 10. Main Update Loop (Safe and stable)
  function renderUI() {
    const viewport = getViewport();
    if (!viewport) return;

    currentNodes = scanTurns();
    ensureHandle();

    const menu = document.getElementById('agy-timeline-menu');
    if (menu && menu.classList.contains('show') && !isHoveringMenuOrHandle) {
      renderMenuList(menu, currentNodes);
    }
  }

  // 11. Scoped MutationObserver (Passive structure tracker)
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

  expandAllHistorySilently();
  renderUI();

  // 12. Global Cleanup handler
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
