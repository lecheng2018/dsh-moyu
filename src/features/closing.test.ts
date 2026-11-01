import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClosingStore } from './closing.ts';

const dir = mkdtempSync(join(tmpdir(), 'closing-'));
const CFG = { enabled: true, ttlDays: 7, coolMinutes: 90, maxChats: 200 };

describe('ClosingStore', () => {
  it('close → get → isCooling → TTL 过期', () => {
    const f = join(dir, 'c1.json');
    const s = new ClosingStore(f, CFG);
    s.close('qqbot:app:c2c:U1', '聊完周末计划 | 下次问她订哪天');
    const rec = s.get('qqbot:app:c2c:U1');
    expect(rec?.note).toContain('周末计划');
    expect(s.isCooling('qqbot:app:c2c:U1')).toBe(true); // 刚收尾,90 分钟内
    // 伪造 8 天前 → TTL(7天)过期
    const raw = JSON.parse(readFileSync(f, 'utf8'));
    raw.chats['qqbot:app:c2c:U1'].closedAt = Date.now() - 8 * 24 * 3600 * 1000;
    writeFileSync(f, JSON.stringify(raw));
    const s2 = new ClosingStore(f, CFG);
    expect(s2.get('qqbot:app:c2c:U1')).toBeUndefined();
    expect(s2.isCooling('qqbot:app:c2c:U1')).toBe(false);
  });

  it('冷却期只看 coolMinutes,TTL 之内但冷却之外 = 不冷却', () => {
    const f = join(dir, 'c2.json');
    const s = new ClosingStore(f, CFG);
    s.close('k', '收尾');
    // 伪造 2 小时前(>90min 冷却,<7 天 TTL)
    const raw = JSON.parse(readFileSync(f, 'utf8'));
    raw.chats.k.closedAt = Date.now() - 2 * 3600 * 1000;
    writeFileSync(f, JSON.stringify(raw));
    const s2 = new ClosingStore(f, CFG);
    expect(s2.get('k')).toBeDefined();
    expect(s2.isCooling('k')).toBe(false);
  });

  it('覆盖式更新:同一会话只有最新一条', () => {
    const s = new ClosingStore(join(dir, 'c3.json'), CFG);
    s.close('k', '第一次');
    s.close('k', '第二次收在别的话题');
    expect(s.get('k')?.note).toBe('第二次收在别的话题');
  });

  it('maxChats 挤掉最旧', () => {
    const s = new ClosingStore(join(dir, 'c4.json'), { ...CFG, maxChats: 2 });
    s.close('a', '1');
    s.close('b', '2');
    s.close('c', '3'); // a 被挤掉
    expect(s.get('a')).toBeUndefined();
    expect(s.get('b')).toBeDefined();
    expect(s.get('c')).toBeDefined();
  });
});
