import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 剥离用户提问中的包装标签与引用前缀
 * @param {string} rawContent
 * @returns {{ raw: string, clean: string }}
 */
export function sanitizeUserPrompt(rawContent) {
  let text = (rawContent || '').trim();
  // 1. 剥离系统包装标签
  text = text.replace(/<\/?USER_REQUEST>/g, '')
             .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
             .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '')
             .trim();

  // 2. 剥离引用前缀标签 (如 @[Quote] 或 @[conversation:"..."] 或 @[file:"..."])
  const cleanPrompt = text.replace(/@\[(?:Quote|conversation:[^\]]+|file:[^\]]+|[^\]]+)\]/g, '').trim();

  return {
    raw: text,
    clean: cleanPrompt || text
  };
}

/**
 * 解析 transcript.jsonl 全量日志正文，智能识别撤回（Undo/Rewind）与分支回滚截断
 * @param {string} rawContent - transcript.jsonl 文件纯文本
 * @returns {Array<{ index: number, stepIndex: number, preview: string, fullText: string, cleanText: string, createdAt: string }>}
 */
export function parseTranscriptContent(rawContent) {
  if (!rawContent) return [];
  const lines = rawContent.split(/\r?\n/).filter(Boolean);
  const rawTurns = [];

  for (const line of lines) {
    try {
      const item = JSON.parse(line);
      const si = item.step_index;
      const source = item.source;
      const type = item.type;

      // 关键防线：当底层产生非系统事件且 step_index 小于或等于栈尾轮次时，表明用户发起过撤回或重试
      // 必须将所有在被撤回时间线上的废弃轮次全部出栈剪枝，恢复会话真实单调性
      if (typeof si === 'number' && source !== 'SYSTEM') {
        while (rawTurns.length > 0 && rawTurns[rawTurns.length - 1].stepIndex >= si) {
          rawTurns.pop();
        }
      }

      if (type === 'USER_INPUT') {
        const { raw: rawText, clean: cleanText } = sanitizeUserPrompt(item.content);
        const lns = cleanText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        rawTurns.push({
          stepIndex: si,
          rawText,
          cleanText,
          lns,
          createdAt: item.created_at || ''
        });
      }
    } catch {}
  }

  // 重新映射为自增的 1-based 连续序号与标准契约对象
  return rawTurns.map((item, idx) => {
    const turnIdx = idx + 1;
    const preview = item.lns.slice(0, 2).join(' ') || (`Turn #${turnIdx}`);
    return {
      index: turnIdx,
      stepIndex: item.stepIndex,
      preview: preview.length > 120 ? preview.slice(0, 118) + '...' : preview,
      fullText: item.rawText,
      cleanText: item.cleanText,
      createdAt: item.createdAt
    };
  });
}

/**
 * 从本地磁盘读取指定会话的 transcript.jsonl 并解析为纯净会话轮次列表
 * @param {string} convId - 会话 UUID
 * @param {string} [customPath] - 可选的自定义日志文件路径
 * @returns {Promise<Array<{ index: number, stepIndex: number, preview: string, fullText: string, cleanText: string, createdAt: string }>>}
 */
export async function loadTranscriptTurns(convId, customPath = null) {
  if (!convId && !customPath) return [];
  const filePath = customPath || join(homedir(), '.gemini', 'antigravity', 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
  try {
    if (!existsSync(filePath)) return [];
    const raw = await readFile(filePath, 'utf8');
    return parseTranscriptContent(raw);
  } catch {
    return [];
  }
}
