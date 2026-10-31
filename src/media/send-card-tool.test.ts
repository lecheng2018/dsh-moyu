import { describe, expect, it } from 'vitest';
import { validateCardInput } from './send-card-tool.ts';
import type { CardInput } from './send-card-tool.ts';

describe('validateCardInput', () => {
  it('最小合法卡片（仅 title）', () => {
    const r = validateCardInput({ title: '备份完成' } satisfies CardInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.card.type).toBe('tuwen');
      expect(r.card.content.title).toBe('备份完成');
      expect(r.card.content.description).toBeUndefined();
    }
  });

  it('全字段合法', () => {
    const r = validateCardInput({
      title: '定时任务汇报',
      description: '全量备份已完成，耗时 4 分 10 秒',
      url: 'https://nas.561889.xyz/',
      pic_url: 'https://example.com/cover.png',
    });
    expect(r.ok).toBe(true);
  });

  it('title 必填且 ≤50', () => {
    expect(validateCardInput({ title: '' }).ok).toBe(false);
    expect(validateCardInput({ title: 'x'.repeat(51) }).ok).toBe(false);
  });

  it('description ≤200', () => {
    expect(validateCardInput({ title: 't', description: 'x'.repeat(201) }).ok).toBe(false);
  });

  it('url/pic_url 必须 https', () => {
    expect(validateCardInput({ title: 't', url: 'http://example.com' }).ok).toBe(false);
    expect(validateCardInput({ title: 't', pic_url: 'ftp://x' }).ok).toBe(false);
    expect(validateCardInput({ title: 't', url: 'https://ok.example.com' }).ok).toBe(true);
  });

  it('url/pic_url ≤1024', () => {
    expect(validateCardInput({ title: 't', url: `https://x.com/${'a'.repeat(1024)}` }).ok).toBe(false);
  });

  it('空串可选字段视为未填', () => {
    const r = validateCardInput({ title: 't', url: '', pic_url: '' });
    expect(r.ok).toBe(true);
  });
});
