/**
 * /bot-quota — 查询主动消息每日配额
 *
 * 展示全局/单目标的今日用量与剩余额度，以及被预算闸门拦下的次数。
 * 未启用预算闸门时如实告知。
 */
import type { CommandDeps, CategorizedCommand } from './types.ts';
import { getScopePeer } from '../shared/index.ts';

export function quotaCommand({ manager }: CommandDeps): CategorizedCommand {
  return {
    name: 'bot-quota',
    category: 'qqbot',
    scope: 'all',
    description: '查询主动消息每日配额',
    usage: [
      '/bot-quota',
      '',
      '查看主动推送（不带 msg_id 的第 3 级兜底发送）的今日配额。',
      '被动回复不受配额限制；配额每日 0 点重置。',
      '在配置 proactive.globalDaily / perTargetDaily 调整额度（0 = 不限）。',
    ].join('\n'),
    handler: (cmdCtx) => {
      const budget = manager.proactiveBudget;
      if (!budget) return 'ℹ️ 主动消息预算闸门未启用（proactive.enabled=false），主动推送不受限。';
      const { scope, peerId } = getScopePeer(cmdCtx);
      const snap = budget.snapshot(scope, peerId);
      const queued = manager.proactiveQueue?.snapshot(scope, peerId);
      const lines = [
        '📮 主动消息配额（今日）',
        `全局: 已用 ${snap.usedGlobal}${snap.remainingGlobal !== null ? ` / 剩余 ${snap.remainingGlobal}` : '（不限）'}`,
      ];
      if (snap.usedTarget !== null) {
        lines.push(`本${scope === 'group' ? '群' : '用户'}: 已用 ${snap.usedTarget}${snap.remainingTarget !== null ? ` / 剩余 ${snap.remainingTarget}` : '（不限）'}`);
      } else {
        lines.push('本会话: 暂无记录');
      }
      if (queued && queued.total > 0) {
        const qline = queued.forTarget !== null
          ? `📥 暂存待补发: 本${scope === 'group' ? '群' : '用户'} ${queued.forTarget} 条（全局 ${queued.total} 条），你下次来消息时自动补发`
          : `📥 暂存待补发: 全局 ${queued.total} 条`;
        lines.push(qline);
      }
      if (snap.skipped > 0) lines.push(`⚠️ 已因额度跳过 ${snap.skipped} 条主动消息（文本类已进暂存箱）`);
      lines.push(`🔔 互动召回: 今日已发 ${snap.wakeupUsed} 条（30 天 4 周期各 1 条的独立配额，你发一句消息即重置计时）`);
      lines.push(`重置: ${snap.resetAt}`);
      return lines.join('\n');
    },
  };
}
