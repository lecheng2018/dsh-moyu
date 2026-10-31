import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProactiveQueue } from './proactive-queue.ts';

describe('ProactiveQueue', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proactive-queue-'));
  const file = join(dir, 'nested', 'outbox.json');

  beforeEach(() => {
    rmSync(file, { force: true });
  });

  const mkTarget = (id = 'U1') => ({ scope: 'c2c' as const, targetId: id, msgId: 'm1' });

  it('enqueue + flush：按序补发并清空', async () => {
    const q = new ProactiveQueue(file);
    q.enqueue(mkTarget(), '第一条', undefined);
    q.enqueue(mkTarget(), '第二条', undefined);
    const sent: string[] = [];
    const delivered = await q.flush(mkTarget(), async (text) => { sent.push(text); });
    expect(delivered).toBe(2);
    expect(sent).toEqual(['第一条', '第二条']);
    expect(q.snapshot('c2c', 'U1').forTarget).toBe(0);
  });

  it('发送失败保留条目，下次继续', async () => {
    const q = new ProactiveQueue(file);
    q.enqueue(mkTarget(), 'A', undefined);
    let fail = true;
    const delivered1 = await q.flush(mkTarget(), async () => { if (fail) throw new Error('net'); });
    expect(delivered1).toBe(0);
    expect(q.snapshot('c2c', 'U1').forTarget).toBe(1);
    fail = false;
    const delivered2 = await q.flush(mkTarget(), async () => {});
    expect(delivered2).toBe(1);
  });

  it('只 flush 目标自己的消息', async () => {
    const q = new ProactiveQueue(file);
    q.enqueue(mkTarget('U1'), '给U1', undefined);
    q.enqueue(mkTarget('U2'), '给U2', undefined);
    const sent: string[] = [];
    await q.flush(mkTarget('U1'), async (text) => { sent.push(text); });
    expect(sent).toEqual(['给U1']);
    expect(q.snapshot('c2c', 'U2').forTarget).toBe(1);
  });

  it('每目标上限丢弃最旧', () => {
    const q = new ProactiveQueue(file);
    for (let i = 0; i < 12; i++) q.enqueue(mkTarget(), `m${i}`, undefined);
    expect(q.snapshot('c2c', 'U1').forTarget).toBe(10);
  });

  it('跨进程持久化 + TTL 过期清理', async () => {
    const q1 = new ProactiveQueue(file);
    q1.enqueue(mkTarget(), '存活的', undefined);
    // 伪造一条 25h 前的旧消息
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    raw.targets['c2c:U1'].push({ text: '过期的', at: Date.now() - 25 * 3600 * 1000 });
    writeFileSync(file, JSON.stringify(raw));
    const q2 = new ProactiveQueue(file);
    expect(q2.snapshot('c2c', 'U1').forTarget).toBe(1); // 过期条目载入即清
    const sent: string[] = [];
    await q2.flush(mkTarget(), async (text) => { sent.push(text); });
    expect(sent).toEqual(['存活的']);
    expect(existsSync(file)).toBe(true);
  });

  it('flush 其他目标不影响自己的暂存', async () => {
    const q = new ProactiveQueue(file);
    q.enqueue(mkTarget('U1'), 'x', undefined);
    const delivered = await q.flush(mkTarget('U2'), async () => {});
    expect(delivered).toBe(0);
    expect(q.snapshot('c2c', 'U1').forTarget).toBe(1);
  });
});
