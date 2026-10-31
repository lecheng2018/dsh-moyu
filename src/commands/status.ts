/**
 * 状态命令：/bot-status（QQBot 特有）
 *
 * 会话状态 + 健康面板（主动配额/暂存箱/meme 桥）一行一个，
 * 远程运维时一眼确认插件各子系统状态。
 */
import type { CommandDeps, CategorizedCommand } from './types.ts';
import { getScopePeer, formatRelativeTime } from '../shared/index.ts';

/** /bot-status — 查看当前会话状态与健康面板 */
export function statusCommand({ manager }: CommandDeps): CategorizedCommand {
  return {
    name: 'bot-status',
    category: 'qqbot',
    scope: 'all',
    description: '查看当前会话状态与健康面板',
    handler: (cmdCtx) => {
      const { scope, peerId } = getScopePeer(cmdCtx);
      const status = manager.getStatus(scope, peerId);
      const lines: string[] = [];
      if (status.active) {
        const modelInfo = status.model ? `${status.provider}/${status.model}` : '宿主默认';
        lines.push(
          '📊 会话状态',
          `会话: ${status.sessionId ? status.sessionId.slice(0, 8) : '—'}`,
          `模型: ${modelInfo}`,
          `Preset: ${status.preset ?? '无'}`,
          `消息数: ${status.messageCount ?? 0}`,
          `最后活动: ${formatRelativeTime(status.lastActivity)}`,
        );
      } else {
        lines.push('📊 会话状态: 当前无活跃会话');
      }

      // ── 健康面板 ──
      lines.push(
        '',
        '🩺 健康面板',
      );
      const budget = manager.proactiveBudget;
      if (budget) {
        const snap = budget.snapshot(scope, peerId);
        const g = snap.remainingGlobal !== null ? `剩余 ${snap.remainingGlobal}` : '不限';
        const t = snap.remainingTarget !== null ? `本${scope === 'group' ? '群' : '用户'}剩余 ${snap.remainingTarget}` : '';
        lines.push(`主动配额: 全局${g}${t ? `，${t}` : ''}`);
      } else {
        lines.push('主动配额: 预算闸门未启用');
      }
      const queued = manager.proactiveQueue?.snapshot(scope, peerId);
      if (queued && queued.total > 0) {
        const own = queued.forTarget !== null ? `本${scope === 'group' ? '群' : '用户'} ${queued.forTarget} 条，` : '';
        lines.push(`暂存待补发: ${own}全局 ${queued.total} 条`);
      }
      const roots = manager.memeRoots.length;
      lines.push(`meme 桥: ${roots > 0 ? `已放行 ${roots} 个图库目录` : '未检测到 dsh-meme 图库'}`);
      return lines.join('\n');
    },
  };
}
