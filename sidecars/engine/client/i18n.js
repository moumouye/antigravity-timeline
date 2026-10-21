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
    turnsCount: (count) => `共 ${count} 轮交互`,
    turnLabel: (num) => `第 ${num} 轮`,
    topButton: '回到顶部',
    bottomButton: '滚到底部',
    settingsButton: '设置',
    collapseButton: '收起面板',
    expandButton: '展开时间线',
    disableAutoScrollLabel: '禁止发送后自动滑到底部',
    disableAutoScrollDesc: '开启后发送消息或模型输出时保持当前阅读视口',
    showMarkersLabel: '在右侧边缘显示时间线标记',
    showPreviewLabel: '悬停标记时显示提问预览气泡',
    forkButton: '分支',
    forkTooltip: '从当前对话节点开启独立分支 (Fork)',
    jumpTooltip: '点击快速定位至该轮对话',
    nowAtCurrent: '当前浏览位置',
    noTurnsFound: '等待对话生成中...'
  },
  en: {
    title: 'Conversation Timeline',
    turnsCount: (count) => `${count} turns total`,
    turnLabel: (num) => `Turn #${num}`,
    topButton: 'Back to Top',
    bottomButton: 'Scroll to Bottom',
    settingsButton: 'Settings',
    collapseButton: 'Collapse',
    expandButton: 'Expand Timeline',
    disableAutoScrollLabel: 'Prevent auto-scroll to bottom',
    disableAutoScrollDesc: 'Keep current reading position when sending or streaming messages',
    showMarkersLabel: 'Show right-edge timeline markers',
    showPreviewLabel: 'Show preview popover on hover',
    forkButton: 'Fork',
    forkTooltip: 'Fork conversation from this node',
    jumpTooltip: 'Click to jump to this turn',
    nowAtCurrent: 'Currently viewing',
    noTurnsFound: 'Waiting for conversation turns...'
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
