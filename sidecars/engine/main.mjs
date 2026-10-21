import { readFile, writeFile, mkdir } from 'node:fs/promises';
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

const PROFILE_DIR = getProfileDir();
const DATA_DIR = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || join(__dirname, 'data');
const PREFS_FILE = join(DATA_DIR, 'preferences.json');
const CLIENT_DIR = join(__dirname, 'client');

async function loadPrefs() {
  try {
    if (existsSync(PREFS_FILE)) {
      const data = await readFile(PREFS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch {}
  return {
    disableAutoScrollOnSend: true,
    showRightEdgeMarkers: true,
    showHoverPreview: true,
    markerColor: '#10b981',
    language: 'auto'
  };
}

async function savePrefs(prefs) {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(PREFS_FILE, JSON.stringify(prefs, null, 2), 'utf8');
  } catch (err) {
    console.error('[Timeline Engine] Failed to save preferences:', err);
  }
}

function buildWrappedScript(injectScript, savedPrefs) {
  return `
    try {
      localStorage.setItem('antigravity_timeline_settings_v1', ${JSON.stringify(JSON.stringify(savedPrefs))});
    } catch {}
    ${injectScript}
  `;
}

async function loadTranscriptTurns(convId) {
  if (!convId) return [];
  const filePath = join(homedir(), '.gemini', 'antigravity', 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
  try {
    if (!existsSync(filePath)) return [];
    const raw = await readFile(filePath, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const turns = [];
    let turnIdx = 1;
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (item.type === 'USER_INPUT') {
          let text = (item.content || '').trim();
          text = text.replace(/<\/?USER_REQUEST>/g, '')
                     .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
                     .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '')
                     .trim();
          const lns = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
          const preview = lns.slice(0, 2).join(' ') || (`Turn #${turnIdx}`);
          turns.push({
            index: turnIdx++,
            stepIndex: item.step_index,
            preview: preview.length > 120 ? preview.slice(0, 118) + '...' : preview,
            fullText: text,
            createdAt: item.created_at || ''
          });
        }
      } catch {}
    }
    return turns;
  } catch {
    return [];
  }
}

async function pushTurnsToPage(client, convId) {
  if (!client || client.closed || !convId) return;
  const turns = await loadTranscriptTurns(convId);
  const signature = `${convId}::${turns.length}::${turns[turns.length - 1]?.preview || ''}`;
  if (client.lastSentTurnsSignature === signature) return;
  client.lastSentTurnsSignature = signature;

  try {
    await client.send('Runtime.evaluate', {
      expression: `if (typeof window.__agyReceiveFullTurns === 'function') {
        window.__agyReceiveFullTurns(${JSON.stringify(convId)}, ${JSON.stringify(turns)});
      }`
    });
  } catch {}
}

class CdpClient {
  constructor(wsUrl, onBinding, onNavigated) {
    this.wsUrl = wsUrl;
    this.onBinding = onBinding;
    this.onNavigated = onNavigated;
    this.nextId = 1;
    this.pending = new Map();
    this.ws = null;
    this.closed = false;
    this.lastSentTurnsSignature = '';
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message || 'CDP Error'));
          else resolve(msg.result);
        } else if (msg.method === 'Runtime.bindingCalled') {
          if (msg.params?.name) {
            this.onBinding?.(msg.params.name, msg.params.payload);
          }
        } else if (msg.method === 'Page.loadEventFired' || msg.method === 'Page.frameNavigated') {
          this.onNavigated?.();
        }
      } catch {}
    });

    this.ws.addEventListener('close', () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) {
        reject(new Error('CDP socket closed'));
      }
      this.pending.clear();
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connection timeout')), 5000);
      this.ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.ws.addEventListener('error', (err) => {
        clearTimeout(timer);
        reject(err);
      }, { once: true });
    });
  }

  send(method, params = {}) {
    if (this.closed || !this.ws || this.ws.readyState !== 1) {
      return Promise.reject(new Error('CDP disconnected'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  close() {
    this.closed = true;
    if (this.ws) this.ws.close();
  }
}

let activeSessions = new Map();

async function getDevToolsPort() {
  const portFile = join(PROFILE_DIR, 'DevToolsActivePort');
  if (!existsSync(portFile)) return null;
  const content = await readFile(portFile, 'utf8');
  const port = parseInt(content.trim().split(/\r?\n/)[0], 10);
  return Number.isInteger(port) && port > 0 ? port : null;
}

async function discoverPages(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`);
    const list = await res.json();
    return list.filter(t => t.type === 'page' && t.url && (t.url.includes('127.0.0.1') || t.url.includes('localhost')));
  } catch {
    return [];
  }
}

async function attachToPage(target, injectScript, savedPrefs) {
  let client;
  const onReload = async () => {
    try {
      const wrapped = buildWrappedScript(injectScript, savedPrefs);
      await client?.send('Runtime.addBinding', { name: '__agyTimelineSavePrefs' });
      await client?.send('Runtime.addBinding', { name: '__agyTimelineRequestTurns' });
      await client?.send('Page.addScriptToEvaluateOnNewDocument', { source: wrapped });
      await client?.send('Runtime.evaluate', { expression: wrapped });
    } catch {}
  };

  client = new CdpClient(target.webSocketDebuggerUrl, async (name, payload) => {
    if (name === '__agyTimelineSavePrefs') {
      try {
        const parsed = JSON.parse(payload);
        await savePrefs(parsed);
        console.log('[Timeline Engine] Saved updated preferences');
      } catch {}
    } else if (name === '__agyTimelineRequestTurns') {
      try {
        const convId = payload;
        await pushTurnsToPage(client, convId);
      } catch {}
    }
  }, onReload);

  await client.connect();
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Runtime.addBinding', { name: '__agyTimelineSavePrefs' });
  await client.send('Runtime.addBinding', { name: '__agyTimelineRequestTurns' });

  const wrappedScript = buildWrappedScript(injectScript, savedPrefs);
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: wrappedScript });
  await client.send('Runtime.evaluate', { expression: wrappedScript });
  return client;
}

async function buildInjectScript() {
  const stylesPath = join(CLIENT_DIR, 'styles.css');
  const i18nPath = join(CLIENT_DIR, 'i18n.js');
  const panelPath = join(CLIENT_DIR, 'panel.js');

  if (existsSync(stylesPath) && existsSync(i18nPath) && existsSync(panelPath)) {
    const styles = await readFile(stylesPath, 'utf8');
    const i18n = await readFile(i18nPath, 'utf8');
    const panel = await readFile(panelPath, 'utf8');

    const cleanI18n = i18n.replace(/^export\s+/gm, '');
    const cleanPanel = panel.replace(/^export\s+/gm, '');

    return `(() => {
  // 1. Client Stylesheet
  const CLIENT_STYLES = ${JSON.stringify(styles)};

  // 2. Client I18N Module
  ${cleanI18n}

  // 3. Client Panel & Controller
  ${cleanPanel}

  // 4. Client Entry Execution
  function __agyRunTimelineClient() {
    if (typeof initClient === 'function') {
      initClient(CLIENT_STYLES, DEFAULT_PREFS, getTexts);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', __agyRunTimelineClient, { once: true });
  } else {
    __agyRunTimelineClient();
  }
})();\n`;
  }

  return '';
}

let lastScriptContent = '';

async function tick() {
  try {
    const port = await getDevToolsPort();
    if (!port) return;

    const pages = await discoverPages(port);
    const activeUrls = new Set(pages.map(p => p.webSocketDebuggerUrl));

    // Cleanup disconnected
    for (const [url, client] of activeSessions.entries()) {
      if (!activeUrls.has(url) || client.closed) {
        client.close();
        activeSessions.delete(url);
      }
    }

    if (pages.length === 0) return;

    const injectScript = await buildInjectScript();
    if (!injectScript) return;

    const savedPrefs = await loadPrefs();
    const hasScriptChanged = injectScript !== lastScriptContent;

    for (const page of pages) {
      const url = page.webSocketDebuggerUrl;
      let client = activeSessions.get(url);

      if (!client) {
        try {
          client = await attachToPage(page, injectScript, savedPrefs);
          activeSessions.set(url, client);
          console.log(`[Timeline Engine] Attached and injected to page: ${page.id}`);
        } catch (err) {
          console.error(`[Timeline Engine] Attach error for ${page.id}:`, err.message);
        }
      } else if (hasScriptChanged) {
        try {
          const wrapped = buildWrappedScript(injectScript, savedPrefs);
          await client.send('Runtime.evaluate', { expression: wrapped });
          console.log(`[Timeline Engine] Hot reloaded script on page: ${page.id}`);
        } catch (err) {
          console.error(`[Timeline Engine] Hot reload error:`, err.message);
        }
      }

      // Sync active conversation turns
      if (client && !client.closed) {
        try {
          const res = await client.send('Runtime.evaluate', {
            expression: 'window.location.pathname'
          });
          const pathname = res?.result?.value || '';
          const match = pathname.match(/\/c\/([a-f0-9\-]+)/);
          const convId = match ? match[1] : null;
          if (convId) {
            await pushTurnsToPage(client, convId);
          }
        } catch {}
      }
    }

    if (hasScriptChanged) {
      lastScriptContent = injectScript;
    }
  } catch (err) {
    console.error('[Timeline Engine] Tick error:', err.message);
  }
}

console.log('[Timeline Engine] Starting Antigravity Timeline Engine Sidecar...');
setInterval(tick, 1200);
tick();
