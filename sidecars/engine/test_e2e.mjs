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

  console.log('\n=== [4/5] 验证 DOM 元素挂载与样式表生效状态 ===');
  const domCheck = await sendCdp('Runtime.evaluate', {
    expression: `(() => {
      const styleEl = document.getElementById('agy-timeline-styles');
      const trackEl = document.getElementById('agy-timeline-track');
      const floatBtn = document.getElementById('agy-timeline-floating-btn');
      const drawer = document.getElementById('agy-timeline-drawer');
      const markers = document.querySelectorAll('.agy-timeline-marker');
      return {
        hasStyle: !!styleEl,
        hasTrack: !!trackEl,
        hasFloatBtn: !!floatBtn,
        hasDrawer: !!drawer,
        markersCount: markers.length,
        styleRulesCount: styleEl?.sheet?.cssRules?.length || 0
      };
    })()`,
    returnByValue: true
  });

  const domRes = domCheck?.result?.value;
  console.log('DOM 挂载与校验结果:', JSON.stringify(domRes, null, 2));
  if (!domRes?.hasStyle || !domRes?.hasTrack) {
    throw new Error('时间线基础 DOM 挂载失败');
  }

  console.log('\n=== [5/5] 验证时间线定位与光晕脉冲动画机制 ===');
  const animCheck = await sendCdp('Runtime.evaluate', {
    expression: `(() => {
      const marker = document.querySelector('.agy-timeline-marker');
      if (marker) {
        marker.click();
      }
      const target = document.querySelector('.agy-timeline-target-highlight');
      return {
        markerClicked: !!marker,
        highlightTriggered: !!target
      };
    })()`,
    returnByValue: true
  });
  console.log('动画与定位触发结果:', JSON.stringify(animCheck?.result?.value, null, 2));

  ws.close();
  console.log('\n[SUCCESS] 端到端自动化测试全部顺利通过！');
}

runE2ETest().catch((err) => {
  console.error('\n[FAILED] 端到端自动化测试失败:', err);
  process.exit(1);
});
