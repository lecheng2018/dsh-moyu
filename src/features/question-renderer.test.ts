import { describe, expect, it } from 'vitest';
import { buildKeyboard, formatQuestion, optionLetter, useLetterOptions } from './question-renderer.ts';
import type { UserQuestion } from './question-channel.ts';

function makeQuestion(overrides: Partial<UserQuestion> = {}): UserQuestion {
  return {
    id: 'q9',
    question: '接下来做什么？',
    options: [{ label: '吃饭' }, { label: '睡觉' }, { label: '干活' }],
    ...overrides,
  };
}

describe('optionLetter', () => {
  it('0 起 → A 起，超出字母表返回 undefined', () => {
    expect(optionLetter(0)).toBe('A');
    expect(optionLetter(25)).toBe('Z');
    expect(optionLetter(26)).toBeUndefined();
    expect(optionLetter(-1)).toBeUndefined();
  });
});

describe('useLetterOptions', () => {
  it('≤26 个选项用字母，>26 退回编号', () => {
    expect(useLetterOptions(makeQuestion())).toBe(true);
    const many = makeQuestion({ options: Array.from({ length: 27 }, (_, i) => ({ label: `o${i}` })) });
    expect(useLetterOptions(many)).toBe(false);
  });
});

describe('formatQuestion', () => {
  it('选项列表带字母前缀，引导语提字母', () => {
    const text = formatQuestion(makeQuestion(), false, false);
    expect(text).toContain('A. 吃饭');
    expect(text).toContain('B. 睡觉');
    expect(text).toContain('回复字母或编号选择');
  });

  it('多问进度标注', () => {
    const text = formatQuestion(makeQuestion(), false, false, { index: 2, total: 3 });
    expect(text).toContain('（第 2/3 问）');
    const single = formatQuestion(makeQuestion(), false, false, { index: 1, total: 1 });
    expect(single).not.toContain('第 1/1 问');
  });

  it('多选引导语带字母示例', () => {
    const text = formatQuestion(makeQuestion({ multiSelect: true }), false, false);
    expect(text).toContain('（可多选）');
    expect(text).toContain('如 A,C');
  });

  it('>26 选项退回编号引导', () => {
    const many = makeQuestion({ options: Array.from({ length: 27 }, (_, i) => ({ label: `o${i}` })) });
    const text = formatQuestion(many, false, false);
    expect(text).toContain('27. o26');
    expect(text).toContain('回复编号选择');
  });
});

describe('buildKeyboard', () => {
  it('按钮 label 带字母前缀', () => {
    const kb = buildKeyboard(makeQuestion());
    expect(kb).toBeDefined();
    const first = kb!.content.rows[0]!.buttons[0]!;
    expect(first.render_data.label.startsWith('A.')).toBe(true);
    expect(first.action.data).toBeDefined();
  });

  it('多选不建键盘', () => {
    expect(buildKeyboard(makeQuestion({ multiSelect: true }))).toBeUndefined();
  });
});
