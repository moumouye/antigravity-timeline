// @ts-check

/**
 * @typedef {import('./types.js').I18nTextMap} I18nTextMap
 * @typedef {import('./types.js').TimelinePreferences} TimelinePreferences
 */

/** @type {TimelinePreferences} */
export const DEFAULT_PREFS = {
  disableAutoScrollOnSend: true,
  showRightEdgeMarkers: true,
  showHoverPreview: true,
  markerColor: '#10b981',
  language: 'auto'
};

/** @type {Record<'zh' | 'en', I18nTextMap>} */
const DICTIONARIES = {
  zh: {
    title: '对话时间线',
    settingsTabName: 'Timeline Settings',
    turnsCount: (count) => `共 ${count} 轮交互`,
    turnLabel: (num) => `第 ${num} 轮`,
    topButton: '回到顶部',
    bottomButton: '滚到底部',
    settingsButton: '时间线设置',
    collapseButton: '收起面板',
    expandButton: '展开时间线',
    disableAutoScrollLabel: '禁止发送后自动滑到底部',
    disableAutoScrollDesc: '开启后，在发送提问或模型流式输出时维持当前视口阅读高度，不强制拉到底部',
    showMarkersLabel: '在右侧边缘显示时间线刻度',
    showMarkersDesc: '在对话主视口右侧边缘无缝绘制双线刻度，直观映射各轮交互相对高度',
    showPreviewLabel: '悬停刻度显示提问预览卡片',
    showPreviewDesc: '鼠标悬停在右侧刻度时，展示简洁干净的提问全文与回答摘要预览',
    forkButton: '分支',
    forkTooltip: '从当前对话节点开启独立分支 (Fork)',
    jumpTooltip: '点击快速定位至该轮对话',
    nowAtCurrent: '当前浏览位置',
    noTurnsFound: '等待对话生成中...',
    loadOlder: '加载更早对话历史',
    settingsTitle: '时间线导航设置 (Timeline Navigator)',
    settingsSubtitle: '自定义 Antigravity 对话时间线导航刻度、悬停预览与智能视口防滚屏锁定'
  },
  en: {
    title: 'Conversation Timeline',
    settingsTabName: 'Timeline Settings',
    turnsCount: (count) => `${count} turns total`,
    turnLabel: (num) => `Turn #${num}`,
    topButton: 'Back to Top',
    bottomButton: 'Scroll to Bottom',
    settingsButton: 'Timeline Settings',
    collapseButton: 'Collapse',
    expandButton: 'Expand Timeline',
    disableAutoScrollLabel: 'Prevent auto-scroll to bottom',
    disableAutoScrollDesc: 'Maintain current reading viewport height when sending prompts or streaming responses',
    showMarkersLabel: 'Show right-edge timeline markers',
    showMarkersDesc: 'Render clean double-line markers on the right edge of the chat viewport',
    showPreviewLabel: 'Show clean preview card on hover',
    showPreviewDesc: 'Display concise prompt and answer summary when hovering over timeline markers',
    forkButton: 'Fork',
    forkTooltip: 'Fork conversation from this node',
    jumpTooltip: 'Click to jump to this turn',
    nowAtCurrent: 'Currently viewing',
    noTurnsFound: 'Waiting for conversation turns...',
    loadOlder: 'Load older messages',
    settingsTitle: 'Timeline Navigator Settings',
    settingsSubtitle: 'Configure right-edge markers, hover popover preview, and smart scroll lock'
  }
};

/**
 * Resolve current locale dictionary
 * @param {string} [lang]
 * @returns {I18nTextMap}
 */
export function getTexts(lang) {
  if (lang === 'zh') return DICTIONARIES.zh;
  if (lang === 'en') return DICTIONARIES.en;

  const navLang = (typeof navigator !== 'undefined' && navigator.language) || '';
  if (navLang.toLowerCase().startsWith('zh')) {
    return DICTIONARIES.zh;
  }
  return DICTIONARIES.en;
}
