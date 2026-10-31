import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProactiveBudget } from './proactive-budget.ts';

describe('ProactiveBudget', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proactive-budget-'));
  const file = join(dir, 'nested', 'budget.json');

  beforeEach(() => {
    rmSync(file, { force: true });
  });

  it('消耗一次 → 剩余减少', () => {
    const b = new ProactiveBudget(file, { globalDaily: 3, perTargetDaily: 2 });
    const r = b.tryConsume('c2c', 'U1');
    expect(r.ok).toBe(true);
    expect(r.remainingGlobal).toBe(2);
    expect(r.remainingTarget).toBe(1);
  });

  it('单目标超限被拦，全局额度不受损', () => {
    const b = new ProactiveBudget(file, { globalDaily: 10, perTargetDaily: 1 });
    expect(b.tryConsume('c2c', 'U1').ok).toBe(true);
    const blocked = b.tryConsume('c2c', 'U1');
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toBe('target');
    expect(b.check('c2c', 'U2').ok).toBe(true); // 别的目标不受影响
  });

  it('全局超限优先拦截', () => {
    const b = new ProactiveBudget(file, { globalDaily: 1, perTargetDaily: 5 });
    expect(b.tryConsume('c2c', 'U1').ok).toBe(true);
    const blocked = b.tryConsume('group', 'G1');
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toBe('global');
  });

  it('0 = 不限（永不拦截）', () => {
    const b = new ProactiveBudget(file, { globalDaily: 0, perTargetDaily: 0 });
    for (let i = 0; i < 50; i++) expect(b.tryConsume('c2c', 'U1').ok).toBe(true);
  });

  it('跨进程持久化 + 跨天重置', () => {
    const b1 = new ProactiveBudget(file, { globalDaily: 2, perTargetDaily: 2 });
    b1.tryConsume('c2c', 'U1');
    // 新实例读到同一份计数
    const b2 = new ProactiveBudget(file, { globalDaily: 2, perTargetDaily: 2 });
    expect(b2.snapshot('c2c', 'U1').usedGlobal).toBe(1);
    // 伪造昨天的存档 → 视为过期重置
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...raw, date: '2000-01-01' }));
    const b3 = new ProactiveBudget(file, { globalDaily: 2, perTargetDaily: 2 });
    expect(b3.snapshot('c2c', 'U1').usedGlobal).toBe(0);
  });

  it('拒绝时累计 skipped', () => {
    const b = new ProactiveBudget(file, { globalDaily: 1, perTargetDaily: 1 });
    b.tryConsume('c2c', 'U1');
    b.tryConsume('c2c', 'U1');
    b.tryConsume('c2c', 'U1');
    expect(b.snapshot().skipped).toBe(2);
  });
});

describe('ProactiveBudget wakeup counter', () => {
  it('recordWakeup 独立计数、跨进程持久化、不占用主动额度', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'proactive-wakeup-')), 'wakeup.json');
    const b = new ProactiveBudget(f, { globalDaily: 1, perTargetDaily: 1 });
    b.recordWakeup();
    b.recordWakeup();
    // 主动额度不受召回计数影响
    expect(b.tryConsume('c2c', 'U1').ok).toBe(true);
    expect(b.snapshot('c2c', 'U1').wakeupUsed).toBe(2);
    // 新实例读到同一计数
    const b2 = new ProactiveBudget(f, { globalDaily: 1, perTargetDaily: 1 });
    expect(b2.snapshot().wakeupUsed).toBe(2);
  });
});
