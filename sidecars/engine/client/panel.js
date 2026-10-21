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
  let isLoadingOlder = false;
  let isHoveringMenuOrHandle = false;

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

    const loadBtn = Array.from(document.querySelectorAll('button')).find(b => {
      const text = (b.textContent || '').trim().toLowerCase();
      return text.includes('load older messages') || text.includes('加载更早') || text.includes('更多历史');
    });

    if (loadBtn && !loadBtn.disabled) {
      isLoadingOlder = true;
      const prevScrollTop = viewport.scrollTop;
      const prevScrollHeight = viewport.scrollHeight;

      loadBtn.click();

      setTimeout(() => {
        const heightDiff = viewport.scrollHeight - prevScrollHeight;
        if (heightDiff > 0 && prevScrollTop > 50) {
          viewport.scrollTop = prevScrollTop + heightDiff;
        }
        isLoadingOlder = false;
        renderUI();

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

    const userCards = Array.from(document.querySelectorAll('div[class*="group/user-input-step"][class*="pt-4"]'));
    const scrollHeight = Math.max(viewport.scrollHeight, 1);

    /** @type {TimelineTurnNode[]} */
    const nodes = [];

    userCards.forEach((card, idx) => {
      // 1. Extract User Prompt Text
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
   * Render menu list safely without rebuilding DOM if already populated
   * @param {HTMLElement} menu
   * @param {TimelineTurnNode[]} nodes
   */
  function renderMenuList(menu, nodes) {
    const listEl = menu.querySelector('#agy-menu-list');

    // If already rendered with exact same count, avoid destroying innerHTML to eliminate hover flicker
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
            <div class="agy-turn-response" title="${escapeHtml(node.responseText)}">${escapeHtml(node.responseText)}</div>
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
  }

  // 9. Smart Scroll Lock (Disable auto-scroll to bottom on send)
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
        const menu = document.getElementById('agy-timeline-menu');
        if (menu && menu.classList.contains('show')) {
          updateActiveCardClasses(menu, currentNodes);
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

  // 10. Main Update Loop (Safe when user is interacting)
  function renderUI() {
    const viewport = getViewport();
    if (!viewport) return;

    currentNodes = scanTurns();
    ensureHandle();

    // If user is actively hovering over menu, do not destroy/rebuild DOM to eliminate flicker
    const menu = document.getElementById('agy-timeline-menu');
    if (menu && menu.classList.contains('show') && !isHoveringMenuOrHandle) {
      renderMenuList(menu, currentNodes);
    }
  }

  // 11. MutationObserver for dynamic turns & auto-expand
  let updateDebounceTimer = null;
  const domObserver = new MutationObserver(() => {
    if (updateDebounceTimer) clearTimeout(updateDebounceTimer);
    updateDebounceTimer = setTimeout(() => {
      autoExpandCollapsedMessages();
      renderUI();
    }, 300);
  });
  domObserver.observe(document.body, { childList: true, subtree: true });

  const initialViewport = getViewport();
  if (initialViewport) {
    setupScrollController(initialViewport);
  }
  autoExpandCollapsedMessages();
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
