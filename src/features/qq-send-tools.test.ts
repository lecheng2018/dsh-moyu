import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAtPrefix, registerQqSendTools, AT_ID_RE } from './qq-send-tools.ts';
import { ClosingStore } from './closing.ts';
import type { SessionManager } from '../session/index.ts';

const OPENID = 'A57096B656A8B834B33CB0A02D26317A';

function makeManager(record?: Record<string, unknown>): SessionManager {
  return {
    findByAgent: () => record,
  } as unknown as SessionManager;
}

function makeRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionKey: 'qqbot:app:c2c:U1',
    replyTarget: { scope: 'c2c', targetId: 'U1', msgId: 'm1' },
    scope: 'c2c',
    peerId: 'U1',
    senderId: OPENID,
    turnQqSendCount: 0,
    qqSendUsedThisTurn: false,
    lastUserText: '',
    ...overrides,
  };
}

function captureTools(deps: Parameters<typeof registerQqSendTools>[1]) {
  const defs: Record<string, { execute: (a: Record<string, unknown>, e: { agent?: { id?: string } }) => Promise<unknown> }> = {};
  registerQqSendTools({ get: () => ({ register: (def: unknown) => { const d = def as { name: string }; defs[d.name] = d as never; } }) }, deps);
  return defs;
}

describe('buildAtPrefix', () => {
  it('群聊第一段 + 合法 openid → 标签', () => {
    const r = buildAtPrefix({ at: OPENID, kind: 'group', parts: 0 });
    expect(r.prefix).toBe(`<qqbot-at-user id="${OPENID}" /> `);
    expect(r.note).toBe('');
  });
  it('at=sender 解析成说话人 openid', () => {
    const r = buildAtPrefix({ at: 'sender', kind: 'group', parts: 0, senderId: OPENID });
    expect(r.prefix).toContain(OPENID);
  });
  it('私聊 → 不 @ 并解释', () => {
    const r = buildAtPrefix({ at: OPENID, kind: 'c2c', parts: 0 });
    expect(r.prefix).toBe('');
    expect(r.note).toContain('私聊');
  });
  it('非第一段 → 不 @', () => {
    const r = buildAtPrefix({ at: OPENID, kind: 'group', parts: 1 });
    expect(r.prefix).toBe('');
    expect(r.note).toContain('第一条');
  });
  it('非法 id(昵称)→ 不 @', () => {
    expect(buildAtPrefix({ at: '小明', kind: 'group', parts: 0 }).prefix).toBe('');
    expect(AT_ID_RE.test('小明')).toBe(false);
  });
});

describe('qq_send', () => {
  it('发送并计数、置位 qqSendUsedThisTurn', async () => {
    const rec = makeRecord();
    const sent: string[] = [];
    const defs = captureTools({ manager: makeManager(rec), send: async (_t, text) => { sent.push(text); }, maxParts: 3 });
    const r = await defs.qq_send!.execute({ text: '第一句' }, { agent: { id: 's1' } });
    expect(sent).toEqual(['第一句']);
    expect((r as { part: number }).part).toBe(1);
    expect(rec.turnQqSendCount).toBe(1);
    expect(rec.qqSendUsedThisTurn).toBe(true);
  });

  it('超 maxParts 拒绝', async () => {
    const rec = makeRecord({ turnQqSendCount: 3 });
    const defs = captureTools({ manager: makeManager(rec), send: async () => {}, maxParts: 3 });
    await expect(defs.qq_send!.execute({ text: 'x' }, { agent: { id: 's1' } })).rejects.toThrow('上限 3 条');
  });

  it('非 QQ 会话报错', async () => {
    const defs = captureTools({ manager: makeManager(undefined), send: async () => {}, maxParts: 3 });
    await expect(defs.qq_send!.execute({ text: 'x' }, { agent: { id: 'web' } })).rejects.toThrow('无法确定');
  });
});

describe('qq_close', () => {
  it('私聊写入 closing(不发消息)', async () => {
    const f = join(mkdtempSync(join(tmpdir(), 'qqclose-')), 'closing.json');
    const closing = new ClosingStore(f, { enabled: true, ttlDays: 7, coolMinutes: 90, maxChats: 200 });
    const rec = makeRecord({ lastUserText: '我去睡啦' });
    const sent: string[] = [];
    const defs = captureTools({ manager: makeManager(rec), send: async (_t, text) => { sent.push(text); }, maxParts: 3, closing });
    const r = await defs.qq_close!.execute({ note: '聊完周末 | 下次问她订哪天' }, { agent: { id: 's1' } });
    expect((r as { closed: boolean }).closed).toBe(true);
    expect(sent).toEqual([]); // 收尾不发消息
    expect(closing.get('qqbot:app:c2c:U1')?.note).toContain('周末');
  });

  it('对方在提问且未作答 → 拒绝', async () => {
    const rec = makeRecord({ lastUserText: '那明天几点碰头？' });
    const defs = captureTools({ manager: makeManager(rec), send: async () => {}, maxParts: 3 });
    await expect(defs.qq_close!.execute({}, { agent: { id: 's1' } })).rejects.toThrow('先回答');
  });

  it('已用 qq_send 作答过 → 允许收尾(即使最后一条是提问)', async () => {
    const rec = makeRecord({ lastUserText: '那明天几点碰头？', turnQqSendCount: 1 });
    const closing = new ClosingStore(join(mkdtempSync(join(tmpdir(), 'qqclose2-')), 'c.json'), { enabled: true, ttlDays: 7, coolMinutes: 90, maxChats: 200 });
    const defs = captureTools({ manager: makeManager(rec), send: async () => {}, maxParts: 3, closing });
    const r = await defs.qq_close!.execute({}, { agent: { id: 's1' } });
    expect((r as { closed: boolean }).closed).toBe(true);
  });

  it('群聊忽略收尾', async () => {
    const rec = makeRecord({ sessionKey: 'qqbot:app:group:G1', replyTarget: { scope: 'group', targetId: 'G1' }, scope: 'group' });
    const defs = captureTools({ manager: makeManager(rec), send: async () => {}, maxParts: 3 });
    const r = await defs.qq_close!.execute({}, { agent: { id: 's1' } });
    expect((r as { closed: boolean }).closed).toBe(false);
  });
});
