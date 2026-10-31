/**
 * QQ 文本回复 → 结构化答案（纯函数，便于单测）。
 *
 * 逐题解析：一次解析一个问题的答案。
 *
 * 认得的作答形式（与 question-renderer 的字母标注配套）：
 *   `A` / `2`            → 选第 1 / 第 2 个选项（字母与编号等价）
 *   `A,C` / `1 3` / `B、D` → 多选（multiSelect 时取全部，单选取第一个）
 *   `选 1 3` / `选A`      → 前缀「选/选择」剥掉后同上
 *   选项原文（大小写不敏感）→ 选它
 *   其它任意文字          → 自由回答（custom）
 */
import type { UserQuestion, UserQuestionAnswer } from './question-channel.ts';
import { OPTION_LETTERS, MAX_LETTER_OPTIONS } from './question-renderer.ts';

/** 全角字母 → 半角（Ａ-Ｚ / ａ-ｚ），QQ 输入法常见 */
function normalizeWidth(text: string): string {
  return text.replace(/[Ａ-Ｚａ-ｚ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

/** 从选项标记串（字母/编号混合）解析出 0 起下标序列，保持书写顺序、去重 */
function parseOptionTokens(text: string, optsLength: number): number[] {
  const picked: number[] = [];
  const push = (idx: number) => {
    if (idx >= 0 && idx < optsLength && !picked.includes(idx)) picked.push(idx);
  };
  for (const m of text.matchAll(/[A-Za-z]|\d+/g)) {
    const token = m[0];
    if (/^\d+$/.test(token)) {
      push(parseInt(token, 10) - 1);
    } else {
      const upper = token.toUpperCase();
      const idx = OPTION_LETTERS.indexOf(upper);
      if (idx >= 0 && idx < MAX_LETTER_OPTIONS) push(idx);
    }
  }
  return picked;
}

/** 把用户对单个问题的文本回复解析为答案 */
export function parseAnswer(question: UserQuestion, text: string): UserQuestionAnswer {
  const opts = question.options ?? [];
  if (opts.length > 0) {
    // 「选…」前缀：口语化作答（选 1 3 / 选A），剥掉后再按标记串解析
    const stripped = normalizeWidth(text.trim()).replace(/^选(择)?\s*/, '');
    // 纯标记串（字母/编号/分隔符/空白）→ 按标记选择
    if (stripped.length > 0 && /^[A-Za-z\d\s,，、;；./]+$/.test(stripped)) {
      const picked = parseOptionTokens(stripped, opts.length);
      if (picked.length > 0) {
        const chosen = question.multiSelect ? picked : picked.slice(0, 1);
        const selected = [...new Set(chosen.map((n) => opts[n]?.label).filter((l): l is string => typeof l === 'string'))];
        return { id: question.id, selected };
      }
    }
    // 文本与某个选项 label 完全一致（忽略大小写）
    const exact = opts.find((o) => o.label.toLowerCase() === text.trim().toLowerCase());
    if (exact) return { id: question.id, selected: [exact.label] };
  }
  return { id: question.id, selected: [], custom: text };
}
