/**
 * QQ 问答的文本渲染与按钮键盘构建（纯函数，便于单测）。
 *
 * 逐题渲染：一次只渲染一个问题（多题时由状态机逐题推进）。
 */
import type { InlineKeyboard } from '@tencent-connect/qqbot-nodejs';
import type { UserQuestion } from './question-channel.ts';
import { BUTTONS_PER_ROW, buttonLabel, encodeButtonData } from './button-utils.ts';

/** 选项字母表（A-Z）：正文与按钮都带字母前缀，文字兜底字母/编号都认 */
export const OPTION_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** 选项数超过字母表时退回纯编号 */
export const MAX_LETTER_OPTIONS = OPTION_LETTERS.length;

/** 选项下标（0 起）→ 字母前缀；超出字母表返回 undefined（调用方退回编号） */
export function optionLetter(index: number): string | undefined {
  return index >= 0 && index < MAX_LETTER_OPTIONS ? OPTION_LETTERS[index] : undefined;
}

/** 本题选项是否用字母标注（单选/多选都用字母，超出 26 个退回编号） */
export function useLetterOptions(question: UserQuestion): boolean {
  return (question.options?.length ?? 0) <= MAX_LETTER_OPTIONS;
}

/**
 * 为「单选、带选项」的问题构建内联键盘；不适用时返回 undefined。
 *
 * 多行多列布局：每行 BUTTONS_PER_ROW 个按钮，减少选项多时的刷屏。
 *
 * button_data 编码 `{"t":"question","q":<问题id>,"i":<选项下标>}`，由分发器解码。
 * `t` 顶层判别字段供 interaction 统一路由；`q` 关联「当前正在问的题」：逐题
 * 推进时旧题按钮在新题发出后被点击，其 q 不等于当前题 id，可被识别并忽略。
 */
export function buildKeyboard(question: UserQuestion): InlineKeyboard | undefined {
  const opts = question.options ?? [];
  if (opts.length === 0 || question.multiSelect) return undefined;

  const rows: InlineKeyboard['content']['rows'] = [];
  const letters = useLetterOptions(question);
  for (let i = 0; i < opts.length; i += BUTTONS_PER_ROW) {
    rows.push({
      buttons: opts.slice(i, i + BUTTONS_PER_ROW).map((o, offset) => {
        const idx = i + offset;
        const prefix = letters ? `${optionLetter(idx)}. ` : '';
        return {
          id: `q-${question.id}-opt-${idx}`,
          render_data: {
            // 按钮带字母前缀（A. xxx）：按钮与正文选项一一对应，截断也不影响认字母
            label: `${prefix}${buttonLabel(o.label)}`,
            visited_label: '✓ 已选',
            style: 1,
          },
          action: {
            type: 1,
            permission: { type: 2 },
            click_limit: 1,
            data: encodeButtonData({ t: 'question', q: question.id, i: idx }),
          },
          // 同一题的选项共享分组：点一个后其余变灰（单选互斥）
          group_id: `q-${question.id}`,
        };
      }),
    });
  }
  return { content: { rows } };
}

/**
 * 把单个问题渲染成 QQ 文本
 *
 * @param progress 多问时的进度（第 index/total 问），单题省略
 */
export function formatQuestion(
  question: UserQuestion,
  requireMentionHint: boolean,
  withButtons: boolean,
  progress?: { index: number; total: number },
): string {
  const lines: string[] = [];
  if (question.header) lines.push(`**${question.header}**`);

  const opts = question.options ?? [];
  const multi = question.multiSelect === true;
  const letters = useLetterOptions(question);
  // 多问进度：让用户知道还有后续题，答完这题还有下一问
  const progressTag = progress && progress.total > 1 ? `（第 ${progress.index}/${progress.total} 问）` : '';

  // 问题行：多选标记前置，用户第一眼就知道作答方式
  lines.push(multi ? `${question.question}${progressTag}（可多选）` : `${question.question}${progressTag}`);

  // 选项列表：字母/编号前缀 + 完整 label + description（按钮 label 截断时 description 靠正文展示）
  opts.forEach((o, i) => {
    const prefix = letters ? `${optionLetter(i)}. ` : `${i + 1}. `;
    lines.push(`${prefix}${o.label}${o.description ? ` · ${o.description}` : ''}`);
  });

  // 底部引导：用引用块（>）与正文区分；mention 放在「回复」动作后（点按钮无需 @）
  if (opts.length > 0) {
    lines.push('');
    const mention = requireMentionHint ? '（需 @机器人）' : '';
    const mark = letters ? '字母或编号' : '编号';
    if (withButtons) {
      lines.push(`> 👇 点击下方按钮选择，或回复${mark}${mention}`);
    } else if (multi) {
      lines.push(`> 💡 回复多个${mark}即可多选（如 ${letters ? 'A,C' : '1,3'}）${mention}，或直接输入你的想法`);
    } else {
      lines.push(`> 💡 回复${mark}选择${mention}，或直接输入你的想法`);
    }
  }

  return lines.join('\n');
}
