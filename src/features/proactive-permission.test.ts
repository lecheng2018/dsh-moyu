import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProactivePermission } from './proactive-permission.ts';

describe('ProactivePermission', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'proactive-perm-')), 'perm.json');

  it('默认放行；setRejected(true) 后拦截，false 恢复', () => {
    const p = new ProactivePermission(file);
    expect(p.isRejected('U1')).toBe(false);
    p.setRejected('U1', true);
    expect(p.isRejected('U1')).toBe(true);
    expect(p.rejectedCount()).toBe(1);
    p.setRejected('U1', false);
    expect(p.isRejected('U1')).toBe(false);
    expect(p.rejectedCount()).toBe(0);
  });

  it('跨实例持久化（重启不丢感知）', () => {
    const p1 = new ProactivePermission(file);
    p1.setRejected('U2', true);
    const p2 = new ProactivePermission(file);
    expect(p2.isRejected('U2')).toBe(true);
    expect(p2.isRejected('U1')).toBe(false);
  });

  it('空 openid 忽略', () => {
    const p = new ProactivePermission(file);
    p.setRejected('', true);
    expect(p.rejectedCount()).toBe(1); // 只有 U2
  });
});
