import { describe, expect, it } from 'vitest';
import { parseAnswer } from './answer-parser.ts';
import type { UserQuestion } from './question-channel.ts';

function makeQuestion(overrides: Partial<UserQuestion> = {}): UserQuestion {
  return {
    id: 'q1',
    question: '怎么做？',
    options: [
      { label: '方案甲' },
      { label: '方案乙' },
      { label: '方案丙' },
    ],
    ...overrides,
  };
}

describe('parseAnswer', () => {
  it('字母单选', () => {
    expect(parseAnswer(makeQuestion(), 'A')).toEqual({ id: 'q1', selected: ['方案甲'] });
    expect(parseAnswer(makeQuestion(), 'c')).toEqual({ id: 'q1', selected: ['方案丙'] });
  });

  it('全角字母', () => {
    expect(parseAnswer(makeQuestion(), 'Ｂ')).toEqual({ id: 'q1', selected: ['方案乙'] });
  });

  it('编号仍然可用（向后兼容）', () => {
    expect(parseAnswer(makeQuestion(), '2')).toEqual({ id: 'q1', selected: ['方案乙'] });
  });

  it('「选」前缀 + 混合字母数字', () => {
    expect(parseAnswer(makeQuestion({ multiSelect: true }), '选 1 3')).toEqual({ id: 'q1', selected: ['方案甲', '方案丙'] });
    expect(parseAnswer(makeQuestion({ multiSelect: true }), '选A')).toEqual({ id: 'q1', selected: ['方案甲'] });
  });

  it('多选多标记', () => {
    expect(parseAnswer(makeQuestion({ multiSelect: true }), 'A,C')).toEqual({ id: 'q1', selected: ['方案甲', '方案丙'] });
    expect(parseAnswer(makeQuestion({ multiSelect: true }), 'B、D'.replace('D', 'C'))).toEqual({ id: 'q1', selected: ['方案乙', '方案丙'] });
  });

  it('单选时多标记只取第一个', () => {
    expect(parseAnswer(makeQuestion(), '1 2 3')).toEqual({ id: 'q1', selected: ['方案甲'] });
  });

  it('超范围标记被忽略，全部超范围时落回 custom', () => {
    expect(parseAnswer(makeQuestion(), '9')).toEqual({ id: 'q1', selected: [], custom: '9' });
    expect(parseAnswer(makeQuestion(), 'Z')).toEqual({ id: 'q1', selected: [], custom: 'Z' });
  });

  it('选项原文（大小写不敏感）', () => {
    expect(parseAnswer(makeQuestion(), '方案乙')).toEqual({ id: 'q1', selected: ['方案乙'] });
  });

  it('自由输入透传 custom', () => {
    expect(parseAnswer(makeQuestion(), '我想改成这样')).toEqual({ id: 'q1', selected: [], custom: '我想改成这样' });
  });

  it('无选项问题一律 custom', () => {
    expect(parseAnswer(makeQuestion({ options: [] }), 'A')).toEqual({ id: 'q1', selected: [], custom: 'A' });
  });
});
