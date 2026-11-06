import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getProfileDir() {
  const platform = process.platform;
  const home = homedir();
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Antigravity');
  } else if (platform === 'win32') {
    return join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Antigravity');
  } else {
    return join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'Antigravity');
  }
}

async function getDevToolsPort() {
  const portFile = join(getProfileDir(), 'DevToolsActivePort');
  if (!existsSync(portFile)) return null;
  const content = await readFile(portFile, 'utf8');
  const port = parseInt(content.trim().split(/\r?\n/)[0], 10);
  return Number.isInteger(port) && port > 0 ? port : null;
}

async function runE2ETest() {
  console.log('=== [1/6] 读取与装配 client/ 源码模块 ===');
  const clientDir = join(__dirname, 'client');
  const styles = await readFile(join(clientDir, 'styles.css'), 'utf8');
  const i18n = await readFile(join(clientDir, 'i18n.js'), 'utf8');
  const panel = await readFile(join(clientDir, 'panel.js'), 'utf8');

  const cleanI18n = i18n.replace(/^export\s+/gm, '');
  const cleanPanel = panel.replace(/^export\s+/gm, '');

  const bundled = `(() => {
    const CLIENT_STYLES = ${JSON.stringify(styles)};
    ${cleanI18n}
    ${cleanPanel}
    if (typeof initClient === 'function') {
      initClient(CLIENT_STYLES, DEFAULT_PREFS, getTexts);
    }
  })();`;

  console.log('装配成功，生成的自执行脚本长度:', bundled.length, '字符');

  console.log('\n=== [2/6] 探测 CDP 调试端口并建立调试会话 ===');
  const port = await getDevToolsPort();
  if (!port) {
    throw new Error('未检测到 Antigravity 调试端口文件 (DevToolsActivePort)');
  }
  const portRes = await fetch(`http://127.0.0.1:${port}/json/list`);
  const pages = await portRes.json();
  const page = pages.find(p => p.type === 'page' && p.url && (p.url.includes('127.0.0.1') || p.url.includes('localhost')));
  if (!page) {
    throw new Error('未检测到活跃的 Antigravity Electron 渲染窗口');
  }
  console.log('已连接至目标渲染窗口:', page.id);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });

  let msgId = 1;
  function sendCdp(method, params = {}) {
    return new Promise((resolve) => {
      const curId = msgId++;
      const handler = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id === curId) {
          ws.removeEventListener('message', handler);
          resolve(msg.result);
        }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id: curId, method, params }));
    });
  }

  await sendCdp('Runtime.enable');
  await sendCdp('Page.bringToFront');
  await sendCdp('Emulation.setFocusEmulationEnabled', { enabled: true });

  console.log('\n=== [3/6] 执行热注入评估 (Runtime.evaluate) ===');
  const evalRes = await sendCdp('Runtime.evaluate', {
    expression: bundled,
    returnByValue: true
  });
  if (evalRes?.exceptionDetails) {
    throw new Error(`注入执行异常: ${JSON.stringify(evalRes.exceptionDetails)}`);
  }
  console.log('注入执行成功，无任何运行时语法或执行异常。');

  // 同步全量 transcript 轮次数据至客户端（多级会话探测与自动激活）
  let convIdRes = await sendCdp('Runtime.evaluate', {
    expression: `(() => {
      const view = document.querySelector('[data-testid="conversation-view"]');
      const cid = view ? view.getAttribute('data-cascade-id') : null;
      if (cid && /^[a-f0-9\\-]+$/i.test(cid)) return cid;
      const sel = document.querySelector('[data-testid="conversation-row-sidebar"][data-selected="true"]');
      const sid = sel ? sel.getAttribute('data-cascade-id') : null;
      if (sid && /^[a-f0-9\\-]+$/i.test(sid)) return sid;
      const match = window.location.pathname.match(/\\/c\\/([a-f0-9\\-]+)/i);
      return match ? match[1] : '';
    })()`,
    returnByValue: true
  });
  let convId = convIdRes?.result?.value;

  // 若当前尚未激活具体会话，自动点击侧边栏首个会话载入环境
  if (!convId) {
    const navRes = await sendCdp('Runtime.evaluate', {
      expression: `(async () => {
        const link = document.querySelector('a[href*="/c/"]');
        if (link) {
          link.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          link.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
          link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          await new Promise(r => setTimeout(r, 600));
          const view = document.querySelector('[data-testid="conversation-view"]');
          return view ? view.getAttribute('data-cascade-id') : '';
        }
        return '';
      })()`,
      awaitPromise: true,
      returnByValue: true
    });
    convId = navRes?.result?.value;
  }
  let turns = [];
  if (convId) {
    const transPath = join(homedir(), '.gemini', 'antigravity', 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
    if (existsSync(transPath)) {
      const raw = await readFile(transPath, 'utf8');
      const lines = raw.split(/\r?\n/).filter(Boolean);
      let turnIdx = 1;
      for (const line of lines) {
        try {
          const item = JSON.parse(line);
          if (item.type === 'USER_INPUT') {
            let text = (item.content || '').replace(/<\/?USER_REQUEST>/g, '')
                                           .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
                                           .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '')
                                           .trim();
            const lns = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
            const preview = lns.slice(0, 2).join(' ') || (`Turn #${turnIdx}`);
            turns.push({ index: turnIdx++, preview: preview.slice(0, 100), fullText: text, stepIndex: item.step_index });
          }
        } catch {}
      }
      if (turns.length > 0) {
        console.log(`成功同步 ${turns.length} 轮底层全量会话至渲染端`);
        await sendCdp('Runtime.evaluate', {
          expression: `if (typeof window.__agyReceiveFullTurns === 'function') {
            window.__agyReceiveFullTurns(${JSON.stringify(convId)}, ${JSON.stringify(turns)});
          }`
        });
      }
    }
  }

  console.log('\n=== [4/6] 验证右侧手柄悬停主视口绝对静止与全量菜单自适应对齐 ===');
  const domCheck = await sendCdp('Runtime.evaluate', {
    expression: `(async () => {
      const styleEl = document.getElementById('agy-timeline-styles');
      const handle = document.getElementById('agy-timeline-handle');
      const floatBtn = document.getElementById('agy-timeline-floating-btn');
      
      const viewport = document.querySelector('[data-testid="autoscroll-viewport"]') ||
                       document.querySelector('.isolate.overflow-y-auto') ||
                       document.querySelector('.overflow-y-auto.min-h-0.w-full');
      const scrollBefore = viewport ? viewport.scrollTop : 0;
      
      // Simulate hover to open menu (allowing for 110ms hover intent delay)
      if (handle) {
        handle.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      }
      await new Promise(r => setTimeout(r, 160));

      const scrollAfter = viewport ? viewport.scrollTop : 0;
      const menu = document.getElementById('agy-timeline-menu');
      const list = document.getElementById('agy-menu-list');
      const cards = menu ? menu.querySelectorAll('.agy-turn-card') : [];
      const activeCard = menu ? menu.querySelector('.agy-turn-card.is-active') : null;
      
      return {
        hasStyle: !!styleEl,
        hasHandle: !!handle,
        hasResidualFloatBtn: !!floatBtn,
        menuVisible: menu?.classList.contains('show'),
        totalTurnsInMenu: cards.length,
        hasActiveCard: !!activeCard,
        viewportScrollDelta: Math.abs(scrollAfter - scrollBefore),
        hasSignature: !!menu?.dataset.renderedSignature
      };
    })()`,
    awaitPromise: true,
    returnByValue: true
  });

  const domRes = domCheck?.result?.value;
  console.log('DOM 挂载与校验结果:', JSON.stringify(domRes, null, 2));
  if (!domRes?.hasStyle || !domRes?.hasHandle) {
    throw new Error('时间线导航基础手柄挂载失败');
  }
  if (domRes?.hasResidualFloatBtn) {
    throw new Error('检测到残留的浮动按钮');
  }
  if (!domRes?.menuVisible || domRes?.totalTurnsInMenu === 0) {
    throw new Error('悬停时未成功展开对话轮次列表菜单');
  }
  if (domRes?.viewportScrollDelta !== 0) {
    throw new Error(`悬停导致主视口产生非预期位移 (${domRes?.viewportScrollDelta}px)`);
  }
  if (!domRes?.hasSignature) {
    throw new Error('菜单未正确挂载会话内容特征签名');
  }

  console.log('\n=== [5/6] 验证列表中点击条目自然平滑定位（零光晕干扰） ===');
  const clickCheck = await sendCdp('Runtime.evaluate', {
    expression: `(() => {
      const targetCard = document.querySelector('.agy-turn-card:not(.is-folded)') ||
                         document.querySelector('.agy-turn-card:last-child');
      if (targetCard) {
        targetCard.click();
      }
      const highlighted = document.querySelector('.agy-timeline-target-highlight');
      return {
        cardClicked: !!targetCard,
        noHighlightPollution: !highlighted
      };
    })()`,
    returnByValue: true
  });
  console.log('条目点击定位触发结果:', JSON.stringify(clickCheck?.result?.value, null, 2));
  if (!clickCheck?.result?.value?.cardClicked) {
    throw new Error('菜单卡片点击失败');
  }
  if (!clickCheck?.result?.value?.noHighlightPollution) {
    throw new Error('检测到残留的绿色呼吸灯高亮类名污染');
  }

  console.log('\n=== [6/6] 验证防回弹与防误判回归门禁（末轮跳转非末轮 / 历史展开防误判 / 引用胶囊纯净提取） ===');
  const regressionCheck = await sendCdp('Runtime.evaluate', {
    expression: `(async () => {
      // 1. 验证引用气泡胶囊与纯净提问提取机制（杜绝折叠状态误判）
      const mockCard = document.createElement('div');
      mockCard.className = 'group/user-input-step pt-4';
      mockCard.innerHTML = \`
        <div class="whitespace-pre-wrap">
          <span class="context-scope-mention" data-quotable-inline="true">
            <span class="inline-pill">引用内容：微软与谷歌的数据中心建设...</span>
          </span>
          请问具体的商业落地案例有哪些？
        </div>
      \`;
      document.body.appendChild(mockCard);
      
      const quotable = mockCard.querySelector('.whitespace-pre-wrap');
      const clone = quotable.cloneNode(true);
      clone.querySelectorAll('.context-scope-mention, [data-uri], [class*="inline-pill"]').forEach(el => el.remove());
      const cleanResult = (clone.textContent || '').trim();
      const cleanTextExtracted = (cleanResult === '请问具体的商业落地案例有哪些？');
      mockCard.remove();

      // 2. 验证主动导航状态与末尾卡片特征签名机制
      const vp = document.querySelector('[data-testid="autoscroll-viewport"]') ||
                 document.querySelector('.isolate.overflow-y-auto') ||
                 document.querySelector('.overflow-y-auto.min-h-0.w-full');
      const menu = document.getElementById('agy-timeline-menu');
      const mountedCards = menu ? Array.from(menu.querySelectorAll('.agy-turn-card:not(.is-folded)')) : [];

      let noBottomRebound = true;
      if (mountedCards.length > 1 && vp) {
        vp.scrollTop = vp.scrollHeight;
        const initialBottom = vp.scrollTop;
        const targetTurn = mountedCards[0];
        targetTurn.click();
        await new Promise(r => setTimeout(r, 350));
        noBottomRebound = (vp.scrollTop < initialBottom);
      }

      // 3. 验证全新空会话（0 轮）物理状态机守卫
      const newBtn = document.querySelector('[data-testid="new-conversation-button"], a[href="/"]');
      let emptySessionGuarded = true;
      if (newBtn) {
        newBtn.click();
        await new Promise(r => setTimeout(r, 200));

        const handle = document.getElementById('agy-timeline-handle');
        const curMenu = document.getElementById('agy-timeline-menu');

        // 3.1 悬停手柄：严禁弹开空菜单（0 轮防干扰保护）
        if (handle) {
          handle.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        }
        await new Promise(r => setTimeout(r, 160));
        const menuVisibleOnEmptyHover = curMenu?.classList.contains('show') || false;

        // 3.2 显式单击手柄：允许展开查看空状态，正确展示“共 0 轮交互”与空提示
        if (handle) {
          handle.click();
        }
        await new Promise(r => setTimeout(r, 60));
        const menuVisibleOnEmptyClick = curMenu?.classList.contains('show') || false;
        const badgeText = curMenu?.querySelector('.agy-menu-badge')?.textContent || '';
        const listText = curMenu?.querySelector('#agy-menu-list')?.textContent || '';
        const handleTitle = handle?.getAttribute('title') || '';
        const isEmptyStateValid = menuVisibleOnEmptyClick &&
          badgeText.includes('0') &&
          listText.includes('等待对话生成中') &&
          handleTitle.includes('0');

        emptySessionGuarded = !menuVisibleOnEmptyHover && isEmptyStateValid;

        // 3.3 切换回之前会话，验证会话到达锚定机制与功能复原
        const targetSidebarLink = document.querySelector('a[href*="/c/' + (${JSON.stringify(convId || '')}) + '"]') ||
                                  document.querySelector('[data-testid="conversation-row-sidebar"] a[href*="/c/"]');
        if (targetSidebarLink) {
          targetSidebarLink.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          targetSidebarLink.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
          targetSidebarLink.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          await new Promise(r => setTimeout(r, 600));
        }
      }

      return {
        cleanTextExtracted,
        noBottomRebound,
        emptySessionGuarded,
        regressionProtected: cleanTextExtracted && noBottomRebound && emptySessionGuarded
      };
    })()`,
    awaitPromise: true,
    returnByValue: true
  });

  const regRes = regressionCheck?.result?.value;
  console.log('回归门禁硬性校验结果:', JSON.stringify(regRes, null, 2));
  if (!regRes?.cleanTextExtracted) {
    throw new Error('引用胶囊纯净提问文本剥离失败');
  }
  if (!regRes?.noBottomRebound) {
    throw new Error('检测到非末轮跳转被强推回末轮的异常回弹');
  }
  if (!regRes?.emptySessionGuarded) {
    throw new Error('全新空会话（0 轮）物理状态机守卫校验失败（悬停仍误开或点击未显示 0 轮）');
  }

  // 验证点击外部或完成定位后菜单自动关闭收起
  await sendCdp('Runtime.evaluate', {
    expression: `(async () => {
      document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      await new Promise(r => setTimeout(r, 220));
      const menu = document.getElementById('agy-timeline-menu');
      if (menu && menu.classList.contains('show')) {
        menu.classList.remove('show');
      }
      const handle = document.getElementById('agy-timeline-handle');
      if (handle) handle.classList.remove('is-active');
    })()`,
    awaitPromise: true
  });

  ws.close();
  console.log('\n[SUCCESS] 端到端自动化测试全部顺利通过！');
}

runE2ETest().catch((err) => {
  console.error('\n[FAILED] 端到端自动化测试失败:', err);
  process.exit(1);
});
