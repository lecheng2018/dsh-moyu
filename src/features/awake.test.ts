import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  scoreAgreement, scoreMiss, scoreCasual, pickBest,
  withinAwakeHours, nextWakeAt, probePrompt, AwakeScheduler,
} from './awake.ts';
import { ClosingStore } from './closing.ts';
import type { AwakeConfig } from '../config.ts';

const CFG: AwakeConfig = {
  enabled: true, awakeFrom: 8, awakeTo: 23, missAfterHours: 6,
  minScore: 0.35, casualPerDay: 1, maxSpeaksPerDay: 3,
  skipBackoffMinutes: 30, skipBackoffMaxMinutes: 240,
};

describe('scoreAgreement', () => {
  const dir = mkdtempSync(join(tmpdir(), 'awake-agr-'));
  const store = new ClosingStore(join(dir, 'c.json'), { enabled: true, ttlDays: 7, coolMinutes: 90, maxChats: 200 });

  it('无收尾记录 → null', () => {
    expect(scoreAgreement(store, 'k-none', 90)).toBeNull();
  });
  it('冷却期内 → null(刚道别不当钩子)', () => {
    store.close('k-cool', '聊完 A | 下次接 B');
    expect(scoreAgreement(store, 'k-cool', 90)).toBeNull();
  });
  it('过了冷却 → 0.7,带收尾备注', () => {
    // 手动把 closedAt 拨回 3 小时前
    const f = join(dir, 'c.json');
    const raw = JSON.parse(require('node:fs').readFileSync(f, 'utf8'));
    raw.chats['k-cool'].closedAt = Date.now() - 3 * 3600 * 1000;
    require('node:fs').writeFileSync(f, JSON.stringify(raw));
    const store2 = new ClosingStore(f, { enabled: true, ttlDays: 7, coolMinutes: 90, maxChats: 200 });
    const opp = scoreAgreement(store2, 'k-cool', 90);
    expect(opp?.score).toBe(0.7);
    expect(opp?.reason).toContain('A');
  });
});

describe('scoreMiss', () => {
  it('沉默不足 → null', () => {
    expect(scoreMiss(3, 6)).toBeNull();
  });
  it('刚过阈值 → 0.3+;越久越高,封顶 0.6', () => {
    expect(scoreMiss(6.5, 6)?.score).toBeCloseTo(0.325);
    expect(scoreMiss(12, 6)?.score).toBe(0.6);
    expect(scoreMiss(100, 6)?.score).toBe(0.6);
  });
});

describe('pickBest', () => {
  it('低于阈值 → null', () => {
    expect(pickBest([scoreCasual()], 0.5)).toBeNull();
  });
  it('取最高分', () => {
    const best = pickBest([scoreCasual(), { ...scoreMiss(12, 6), record: null as never }], 0.35);
    expect(best?.kind).toBe('miss');
  });
  it('同分时 agreement > miss > casual', () => {
    const a = { ...scoreAgreement(null, 'x', 90), record: null as never };
    const m = { ...scoreMiss(12, 6), record: null as never };
    void m; // 同分构造:直接用分数相同的假机会
    const tied = [
      { kind: 'casual' as const, score: 0.6, reason: '', record: null as never },
      { kind: 'agreement' as const, score: 0.6, reason: '', record: null as never },
    ];
    expect(pickBest(tied, 0.35)?.kind).toBe('agreement');
    void a;
  });
});

describe('withinAwakeHours', () => {
  it('普通窗口 8-23', () => {
    expect(withinAwakeHours(8, 23, new Date(2026, 10, 1, 12))).toBe(true);
    expect(withinAwakeHours(8, 23, new Date(2026, 10, 1, 3))).toBe(false);
    expect(withinAwakeHours(8, 23, new Date(2026, 10, 1, 23))).toBe(false); // 右开
  });
  it('跨零点 22-6', () => {
    expect(withinAwakeHours(22, 6, new Date(2026, 10, 1, 23))).toBe(true);
    expect(withinAwakeHours(22, 6, new Date(2026, 10, 1, 3))).toBe(true);
    expect(withinAwakeHours(22, 6, new Date(2026, 10, 1, 12))).toBe(false);
  });
});

describe('nextWakeAt', () => {
  it('窗口内 → 未来 1 小时内', () => {
    const now = new Date(2026, 10, 1, 12).getTime();
    const t = nextWakeAt(CFG, now);
    expect(t).toBeGreaterThan(now);
    expect(t - now).toBeLessThanOrEqual(61 * 60 * 1000);
  });
  it('窗外(凌晨 3 点,窗口 8-23)→ 今天 8 点后', () => {
    const now = new Date(2026, 10, 1, 3).getTime();
    const t = nextWakeAt(CFG, now);
    const eight = new Date(2026, 10, 1, 8).getTime();
    expect(t).toBeGreaterThanOrEqual(eight);
    expect(t).toBeLessThan(eight + 61 * 60 * 1000);
  });
});

describe('probePrompt', () => {
  it('包含 skip 标记说明与理由', () => {
    const p = probePrompt({ ...scoreMiss(9, 6), record: null as never }, '你好呀');
    expect(p).toContain('<<skip>>');
    expect(p).toContain('9.0 小时');
    expect(p).toContain('你好呀');
  });
});

describe('AwakeScheduler', () => {
  it('start 后 state.nextWakeAt 落在未来,stop 清理', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'awake-')), 'awake.json');
    const s = new AwakeScheduler({
      manager: { sessions: new Map() } as unknown as Parameters<AwakeScheduler['snapshot']> extends never ? never : ConstructorParameters<typeof AwakeScheduler>[0]['manager'],
      cfg: CFG,
      storePath: f,
      probe: () => {},
    });
    s.start();
    expect(s.snapshot().nextWakeAt).toBeGreaterThan(Date.now());
    s.stop();
  });
});
