/**
 * Antigravity Timeline Plugin Type Definitions
 */

export interface TimelinePreferences {
  disableAutoScrollOnSend: boolean;
  showRightEdgeMarkers: boolean;
  showHoverPreview: boolean;
  markerColor: string;
  language: 'zh' | 'en' | 'auto';
}

export interface TimelineTurnNode {
  index: number;
  userText: string;
  fullText?: string;
  stepIndex?: number;
  responseText: string;
  timeStr: string;
  element: HTMLElement | null;
  topPercent: number;
  isActive: boolean;
  isFolded?: boolean;
}

export interface I18nTextMap {
  title: string;
  settingsTabName: string;
  turnsCount: (count: number) => string;
  turnLabel: (num: number) => string;
  topButton: string;
  bottomButton: string;
  settingsButton: string;
  collapseButton: string;
  expandButton: string;
  disableAutoScrollLabel: string;
  disableAutoScrollDesc: string;
  showMarkersLabel: string;
  showMarkersDesc: string;
  showPreviewLabel: string;
  showPreviewDesc: string;
  forkButton: string;
  forkTooltip: string;
  jumpTooltip: string;
  nowAtCurrent: string;
  noTurnsFound: string;
  loadOlder?: string;
  settingsTitle: string;
  settingsSubtitle: string;
}
