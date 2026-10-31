/**
 * proactive-budget — 主动消息每日配额
 *
 * QQ 官方机器人的主动推送（三级兜底里的第 3 级：被动窗口内所有 msg_id/
 * event_id 都过期/超频后，不带 msg_id 直接发）消耗平台的主动消息额度，
 * 且额度很小、超发直接报错。本模块在客户端做预算闸门：
 *
 *   - 每日预算：全局 + 单目标两个维度（0 = 不限）
 *   - 按自然日滚动重置（本地时区），计数持久化到 PLUGIN_HOME
 *   - 被动回复（带 msg_id/event_id）不受预算约束——那是免费的
 *
 * 用法：bootstrap 在 sender 包装层拦截「resolveReplyTarget 产出了无
 * msg_id/event_id 的目标」这一时刻，tryConsume 通过才真正发送；拒绝时
 * 记 skipped 计数并跳过（不 throw，出站错误路径会触发重发逻辑反而放大
 * 消耗）。剩余额度经 /bot-quota 查询，并注入 system prompt 让模型自己
 * 掂量。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ChatScope } from '../types.ts';

export interface ProactiveBudgetOptions {
  /** 全局每日主动消息上限（0 = 不限；平台 bot 级月度额度约 1000 条，按天 20 保守） */
  globalDaily: number;
  /**
   * 单目标每日主动消息上限（0 = 不限）。
   * 平台「互动召回」对单用户是 30 天内 4 个周期（当天/1-3天/3-7天/7-30天）
   * 各 1 条 —— 当天只有 1 条名额，默认 1 对齐这个节奏，避免同日连发撞 304023。
   */
  perTargetDaily: number;
}

export interface BudgetCheck {
  ok: boolean;
  /** 拒绝原因维度 */
  reason?: 'global' | 'target';
  remainingGlobal: number | null;
  remainingTarget: number | null;
}

interface BudgetState {
  date: string;
  globalUsed: number;
  /** `${scope}:${targetId}` → 已用次数 */
  targets: Record<string, number>;
  /** 因预算拒绝而跳过的发送次数（诊断用） */
  skipped: number;
}

function todayKey(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export class ProactiveBudget {
  private readonly file: string;
  private readonly opts: ProactiveBudgetOptions;
  private state: BudgetState;

  constructor(storePath: string, opts: ProactiveBudgetOptions) {
    this.file = storePath;
    this.opts = opts;
    this.state = this.load();
  }

  private load(): BudgetState {
    const fresh: BudgetState = { date: todayKey(), globalUsed: 0, targets: {}, skipped: 0 };
    try {
      if (!existsSync(this.file)) return fresh;
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<BudgetState>;
      if (parsed?.date !== todayKey()) return fresh; // 跨天滚动重置
      return {
        date: todayKey(),
        globalUsed: Number.isFinite(parsed.globalUsed) ? parsed.globalUsed! : 0,
        targets: parsed.targets && typeof parsed.targets === 'object' ? parsed.targets : {},
        skipped: Number.isFinite(parsed.skipped) ? parsed.skipped! : 0,
      };
    } catch {
      return fresh;
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.state, null, 2));
    } catch {
      // 持久化失败只影响重启后的连续性，不阻断当次判断
    }
  }

  /** 单目标键（与 msgid-cache 的 cacheKey 同构） */
  private targetKey(scope: ChatScope, targetId: string): string {
    return `${scope}:${targetId}`;
  }

  /**
   * 尝试消耗一次主动推送额度。
   * 通过 → 计数+持久化，返回 ok=true 与**消耗后**剩余额度；任一维度超限 →
   * 记 skipped 并拒绝。注意 ok 反映的是准入决策：这次发送本身获准后即使
   * 恰好把额度用光，也必须返回 ok=true（剩余为 0），否则调用方会误判为被拦。
   */
  tryConsume(scope: ChatScope, targetId: string): BudgetCheck {
    const check = this.check(scope, targetId);
    if (!check.ok) {
      this.state.skipped += 1;
      this.persist();
      return check;
    }
    this.state.globalUsed += 1;
    const key = this.targetKey(scope, targetId);
    this.state.targets[key] = (this.state.targets[key] ?? 0) + 1;
    this.persist();
    return {
      ok: true,
      remainingGlobal: this.remainingGlobal(),
      remainingTarget: this.remainingTarget(scope, targetId),
    };
  }

  private remainingGlobal(): number | null {
    const g = this.opts.globalDaily;
    return g > 0 ? Math.max(0, g - this.state.globalUsed) : null;
  }

  private remainingTarget(scope: ChatScope, targetId: string): number | null {
    const t = this.opts.perTargetDaily;
    if (t <= 0) return null;
    return Math.max(0, t - (this.state.targets[this.targetKey(scope, targetId)] ?? 0));
  }

  /** 只读检查（不消耗）：两维度都未超限才放行 */
  check(scope: ChatScope, targetId: string): BudgetCheck {
    const g = this.opts.globalDaily;
    const t = this.opts.perTargetDaily;
    const usedTarget = this.state.targets[this.targetKey(scope, targetId)] ?? 0;
    const remainingGlobal = g > 0 ? Math.max(0, g - this.state.globalUsed) : null;
    const remainingTarget = t > 0 ? Math.max(0, t - usedTarget) : null;
    if (g > 0 && this.state.globalUsed >= g) {
      return { ok: false, reason: 'global', remainingGlobal: 0, remainingTarget };
    }
    if (t > 0 && usedTarget >= t) {
      return { ok: false, reason: 'target', remainingGlobal, remainingTarget: 0 };
    }
    return { ok: true, remainingGlobal, remainingTarget };
  }

  /** /bot-quota 与提示词注入用的快照 */
  snapshot(scope?: ChatScope, targetId?: string): {
    usedGlobal: number; remainingGlobal: number | null;
    usedTarget: number | null; remainingTarget: number | null;
    skipped: number; resetAt: string;
  } {
    const g = this.opts.globalDaily;
    const t = this.opts.perTargetDaily;
    const usedTarget = scope && targetId ? this.state.targets[this.targetKey(scope, targetId)] ?? 0 : null;
    return {
      usedGlobal: this.state.globalUsed,
      remainingGlobal: g > 0 ? Math.max(0, g - this.state.globalUsed) : null,
      usedTarget,
      remainingTarget: usedTarget !== null && t > 0 ? Math.max(0, t - usedTarget) : null,
      skipped: this.state.skipped,
      resetAt: '明日 00:00',
    };
  }
}
