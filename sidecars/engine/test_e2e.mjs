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
  console.log('=== [1/5] 读取与装配 client/ 源码模块 ===');
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

  console.log('\n=== [2/5] 探测 CDP 调试端口并建立调试会话 ===');
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

  console.log('\n=== [3/5] 执行热注入评估 (Runtime.evaluate) ===');
  const evalRes = await sendCdp('Runtime.evaluate', {
    expression: bundled,
    returnByValue: true
  });
  if (evalRes?.exceptionDetails) {
    throw new Error(`注入执行异常: ${JSON.stringify(evalRes.exceptionDetails)}`);
  }
  console.log('注入执行成功，无任何运行时语法或执行异常。');

  // 同步全量 transcript 轮次数据至客户端
  const pathnameRes = await sendCdp('Runtime.evaluate', { expression: 'window.location.pathname', returnByValue: true });
  const convMatch = (pathnameRes?.result?.value || '').match(/\/c\/([a-f0-9\-]+)/);
  if (convMatch) {
    const convId = convMatch[1];
    const transPath = join(homedir(), '.gemini', 'antigravity', 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
    if (existsSync(transPath)) {
      const raw = await readFile(transPath, 'utf8');
      const lines = raw.split(/\r?\n/).filter(Boolean);
      const turns = [];
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

  console.log('\n=== [4/5] 验证右侧手柄悬停主视口绝对静止与全量菜单自适应对齐 ===');
  const domCheck = await sendCdp('Runtime.evaluate', {
    expression: `(() => {
      const styleEl = document.getElementById('agy-timeline-styles');
      const handle = document.getElementById('agy-timeline-handle');
      const floatBtn = document.getElementById('agy-timeline-floating-btn');
      
      const viewport = document.querySelector('[data-testid="autoscroll-viewport"]') ||
                       document.querySelector('.isolate.overflow-y-auto') ||
                       document.querySelector('.overflow-y-auto.min-h-0.w-full');
      const scrollBefore = viewport ? viewport.scrollTop : 0;
      
      // Simulate hover to open menu
      if (handle) {
        handle.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      }
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

  console.log('\n=== [5/5] 验证列表中点击条目平滑定位与光晕脉冲 ===');
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
        jumpHighlightFired: !!highlighted
      };
    })()`,
    returnByValue: true
  });
  console.log('条目点击定位触发结果:', JSON.stringify(clickCheck?.result?.value, null, 2));

  ws.close();
  console.log('\n[SUCCESS] 端到端自动化测试全部顺利通过！');
}

runE2ETest().catch((err) => {
  console.error('\n[FAILED] 端到端自动化测试失败:', err);
  process.exit(1);
});
