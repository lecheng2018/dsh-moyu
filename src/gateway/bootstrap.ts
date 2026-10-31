/**
 * 网关组装 — 创建 bot、编排中间件、注册事件、出站、生命周期
 *
 * 将 QQ 消息平台作为 dsh 前端协议驱动：入站消息 → handleInbound → dsh agent，
 * dsh session/event → createOutboundHandler → QQ 出站。
 */
import type { Context } from '@deepseek-ai/cordis';
import { QQBot } from '@tencent-connect/qqbot-nodejs';
import type { GatewayDisconnect, InteractionEvent, MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import { SessionManager, type DshAgentRegistry } from '../session/index.ts';
import { handleInbound, createOutboundHandler } from '../transport/index.ts';
import { parseStreamFrame } from '../transport/events.ts';
import { ReplyLimiter } from '../transport/reply-limiter.ts';
import { cacheMsgId, cacheEventId } from '../transport/msgid-cache.ts';
import { resolveReplyTarget, sendResolvedMarkdown } from '../transport/reply-target.ts';
import type { ToolsRegistryLike } from '../transport/tool-presenter.ts';
import type { QQBotSender } from '../transport/outbound-buffer.ts';
import { QuestionChannel } from '../features/question-channel.ts';
import { ApprovalChannel, type ApprovalChannelContext } from '../features/approval-channel.ts';
import { RiskGate } from '../features/risk-gate.ts';
import { decodeButtonData } from '../features/button-utils.ts';
import { discoverMemeRoots, seedMemeDefaults } from '../features/meme-bridge.ts';
import { ProactiveBudget } from '../transport/proactive-budget.ts';
import { ProactiveQueue } from '../transport/proactive-queue.ts';
import { PLUGIN_HOME } from '../shared/dirs.ts';
import { buildUserAgent } from '../shared/index.ts';
import type { ImQQBotConfig } from '../config.ts';
import type { ChatScope, Logger, ReplyTarget } from '../types.ts';
import { resolve } from 'node:path';
import { setupMiddlewares } from './middleware-setup.ts';
import { startMediaCleanup } from '../media/media-cleaner.ts';
import { ensureVisionInputModal, registerDescribeImageTool } from '../media/vision-tool.ts';
import { registerSendFileTool, type MediaSenderLike } from '../media/send-file-tool.ts';
import { DeliverablesDeliverer } from '../transport/deliverables.ts';

/**
 * interaction 统一分发器：按 button_data 的顶层 `t` 判别字段，路由到对应
 * channel（question / approval）。QQ 只有一个 interaction 入口，集中路由
 * 避免多通道各自 try 导致误判。
 */
function dispatchInteraction(event: InteractionEvent, manager: SessionManager): boolean {
  const raw = event.data?.resolved?.button_data;
  if (!raw) return false;
  const button = decodeButtonData(raw);
  if (!button) return false;
  if (button.t === 'question') return manager.questionChannel?.handleInteraction(event) ?? false;
  if (button.t === 'approval') return manager.approvalChannel?.handleInteraction(event) ?? false;
  return false;
}

export async function bootstrapGateway(
  ctx: Context,
  agents: DshAgentRegistry,
  config: ImQQBotConfig,
  logger: Logger,
): Promise<void> {
  // ── dsh-meme 零配置对接 ──
  // 图库目录自动并入 sendFile 白名单（media + cwd 之外的第三类默认根），
  // 并在 dsh-meme 设置存在但未开「QQ 发图尺寸」时补默认值（300px）。
  seedMemeDefaults(logger);
  const memeRoots = discoverMemeRoots(logger);
  if (memeRoots.length > 0) {
    logger.info(`meme-bridge: 已自动放行 dsh-meme 图库目录: ${memeRoots.join(', ')}`);
  }
  const effectiveConfig: ImQQBotConfig = {
    ...config,
    sendFile: { ...config.sendFile, extraRoots: [...config.sendFile.extraRoots, ...memeRoots] },
  };

  const manager = new SessionManager(ctx, agents, effectiveConfig, logger);
  manager.riskGateInfo = { enabled: effectiveConfig.riskGate.enabled, level: effectiveConfig.riskGate.level };
  manager.memeRoots = memeRoots;

  // ── 初始化 QQ Bot SDK ──
  const userAgent = buildUserAgent();
  const bot = new QQBot({
    appId: config.appId,
    appSecret: config.appSecret,
    transport: 'websocket',
    baseUrl: process.env.QQBOT_BASE_URL?.replace(/\/+$/, '') || 'https://api.bot.qq.com',
    tokenBaseUrl: process.env.QQBOT_TOKEN_BASE_URL?.replace(/\/+$/, '') || 'https://api.bot.qq.com',
    userAgent,
    logger,
  } as ConstructorParameters<typeof QQBot>[0]);
  logger.info(`QQBot SDK initialized (UA: ${userAgent})`);

  // ── 中间件链 ──
  setupMiddlewares(bot, effectiveConfig, manager, logger);

  // ── 入站：经过中间件链后的消息交给 dsh agent ──
  bot.on('message', async (mCtx: MiddlewareContext) => {
    const msg = mCtx.message;
    // 记录最近 msgId，供无上下文的出站发送（文件发送显式 target、主动推送等）获取被动回复目标
    cacheMsgId(mCtx.replyTarget.scope, mCtx.replyTarget.targetId, mCtx.replyTarget.msgId);
    // 用户来了 → 被动窗口开启 → 先把被预算拦下的主动消息补发掉（走被动通道，不耗配额）
    if (proactiveQueue) {
      try {
        await proactiveQueue.flush(mCtx.replyTarget, (text) => {
          const resolved = resolveReplyTarget(mCtx.replyTarget, replyLimiter, true);
          return sendResolvedMarkdown(bot, resolved, text);
        }, logger);
      } catch (err) {
        logger.warn(`proactive-queue: flush failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (config.debug) {
      logger.debug(`← message (post-middleware): ${JSON.stringify(msg, null, 2).slice(0, 500)}`);
    }
    await handleInbound(mCtx, manager, effectiveConfig, logger);
  });

  // ── 出站：dsh session/event → QQ 消息 ──
  // 获取 tools 服务（工具结果结构化展示），可选
  let toolsRegistry: ToolsRegistryLike | undefined;
  try {
    toolsRegistry = ctx.get('tools') as ToolsRegistryLike | undefined;
  } catch {
    toolsRegistry = undefined;
  }

  // ── 主动消息预算闸门 ──
  // resolveReplyTarget 返回的目标不带 msg_id/event_id = 三级兜底走到第 3 级（主动推送），
  // 此时消耗每日配额。被拦时的处置因调用方而异（onBlocked）：
  //   - 文本出站：静默跳过（返回 {skipped} 哨兵；出站错误路径的重发会放大消耗，不 throw）
  //   - 媒体发送：抛错 —— sendMediaFile 的 catch 会转成 outcome:'failed' 透传给
  //     qqbot_send_file 工具结果/交付物日志，让模型明确知道没发出去
  // 被动回复（带 msg_id/event_id）不受限。
  const proactiveBudget = config.proactive.enabled
    ? new ProactiveBudget(resolve(PLUGIN_HOME, 'proactive-budget.json'), config.proactive)
    : undefined;
  manager.proactiveBudget = proactiveBudget;
  // 被预算拦掉的主动消息暂存箱：下次该目标来消息时作为被动回复补发（持久化，24h TTL）
  const proactiveQueue = config.proactive.enabled
    ? new ProactiveQueue(resolve(PLUGIN_HOME, 'proactive-outbox.json'))
    : undefined;
  manager.proactiveQueue = proactiveQueue;
  const gateProactive = <T>(
    target: ReplyTarget,
    resolved: ReplyTarget,
    doSend: () => Promise<T>,
    onBlocked: () => T,
  ): Promise<T> => {
    if (!proactiveBudget) return doSend();
    if (resolved.msgId === undefined && resolved.eventId === undefined) {
      const check = proactiveBudget.tryConsume(target.scope, target.targetId);
      if (!check.ok) {
        logger.warn(`proactive-budget: 主动推送被拦（${check.reason === 'global' ? '全局额度' : '单目标额度'}用尽）→ ${target.scope}:${target.targetId}`);
        return Promise.resolve(onBlocked());
      }
    }
    return doSend();
  };
  const BLOCKED_SKIP = { skipped: 'proactive-budget' };
  const BLOCKED_THROW = (): never => {
    throw new Error('主动消息每日配额已用尽（proactive budget exhausted），请明天再试或提高 proactive 配置');
  };

  // 发送适配器：将 QQBot 实例适配为 QQBotSender（openStream 参数形态不同）。
  // sendMarkdown 统一做被动回复限额管控：同一 msgId 超限/过期时降级主动推送（过预算闸门）。
  const replyLimiter = new ReplyLimiter({ limit: 4 });
  const sender: QQBotSender = {
    sendMarkdown: (target, content, opts) => {
      const resolved = resolveReplyTarget(target, replyLimiter, true);
      return gateProactive(target, resolved, () => sendResolvedMarkdown(bot, resolved, content, opts), () => {
        // 文本主动推送被预算拦下 → 暂存补发，不丢消息（键盘卡片不暂存：通知场景少用且时效强）
        proactiveQueue?.enqueue(target, content, logger);
        return BLOCKED_SKIP;
      });
    },
    openStream: (target) => bot.openStream({
      target: {
        scope: target.scope,
        targetId: target.targetId,
        msgId: target.msgId as string,
      },
    }),
  };

  // ── 附件发送适配器（qqbot_send_file 工具与交付物投递共用） ──
  // 包装 bot：让文件发送也走 msgId 兜底 + 被动回复限额管控 + 主动推送预算。
  // 注意：SDK 文件发送暂不支持 event_id，故 allowEvent=false，跳过 event 候选。
  const mediaSender: MediaSenderLike = {
    sendImage: (target, source) => {
      const resolved = resolveReplyTarget(target, replyLimiter, false);
      return gateProactive(target, resolved, () => bot.sendImage(resolved, source), BLOCKED_THROW);
    },
    sendVideo: (target, source) => {
      const resolved = resolveReplyTarget(target, replyLimiter, false);
      return gateProactive(target, resolved, () => bot.sendVideo(resolved, source), BLOCKED_THROW);
    },
    sendVoice: (target, source) => {
      const resolved = resolveReplyTarget(target, replyLimiter, false);
      return gateProactive(target, resolved, () => bot.sendVoice(resolved, source), BLOCKED_THROW);
    },
    sendFile: (target, source, opts) => {
      const resolved = resolveReplyTarget(target, replyLimiter, false);
      return gateProactive(target, resolved, () => bot.sendFile(resolved, source, opts), BLOCKED_THROW);
    },
  };

  // 交付物投递：present 声明的文件在轮末发送到当前会话（outbound 路由触发）
  const deliverablesDeliverer = new DeliverablesDeliverer(sender, mediaSender, effectiveConfig, logger);

  const outbound = createOutboundHandler(manager, sender, effectiveConfig, logger, toolsRegistry, deliverablesDeliverer);
  (ctx as unknown as { on(event: string, handler: (...args: unknown[]) => void): void })
    .on('session/event', outbound.routeSessionEvent as (...args: unknown[]) => void);

  // ── 出站流式：agent/assistant-stream → 流式帧路由 ──
  // 实时流式走瞬态 agent/assistant-stream（chunk 不进 session log）。
  // 该事件按 agent 作用域派发，根作用域监听器不带 global 会被过滤（同
  // approval/request），帧到达后自行按 agent.id 路由，非 QQ 会话在 router 内忽略。
  (ctx as unknown as { on(event: string, handler: (...args: unknown[]) => void, options?: { global?: boolean }): void })
    .on('agent/assistant-stream', (payload: unknown) => {
      const parsed = parseStreamFrame(payload);
      if (parsed !== undefined) outbound.routeStreamFrame(parsed.agentId, parsed.delta);
    }, { global: true });

  // ── 问答通道（ask_user_question → QQ 文本 + 按钮） ──
  const questionChannel = new QuestionChannel(manager, sender, effectiveConfig, logger);
  manager.questionChannel = questionChannel;
  questionChannel.install(ctx);

  // ── 工具风险门（tools/pre-execute 判风险 → approval seam → 上面的 QQ 审批按钮） ──
  const riskGate = new RiskGate(manager, effectiveConfig.riskGate, logger);
  riskGate.install(ctx);

  // ── 审批通道（approval/request → QQ 两按钮审批） ──
  const approvalChannel = new ApprovalChannel(manager, sender, effectiveConfig, logger);
  manager.approvalChannel = approvalChannel;
  approvalChannel.install(ctx as unknown as ApprovalChannelContext);

  // ── 按钮点击回调（interaction）：统一分发到问答/审批通道 ──
  bot.on('interaction', async (_iCtx: unknown, event: InteractionEvent) => {
    // scope/targetId 推导对齐消息事件（inbound.ts）：按 scene 判定类型，群用 group_openid，私聊用 user_openid
    const scope: ChatScope = event.scene === 'group' ? 'group' : 'c2c';
    const targetId = scope === 'group' ? (event.group_openid ?? event.user_openid) : event.user_openid;
    // 记录互动事件 id，作为后续被动回复候选（event_id）
    cacheEventId(scope, targetId, event.id);

    const matched = dispatchInteraction(event, manager);
    await bot.acknowledgeInteraction(event.id, matched ? 0 : 3).catch(() => {});
  });

  bot.on('error', (err: unknown) => {
    logger.error(`bot error: ${err instanceof Error ? err.message : String(err)}`);
  });

  // 掉线可观测：willReconnect=false 表示不会再重连（随后 bot.start() 的 Promise 会失败）。
  // disconnected 事件为 SDK 1.0.5+ 新增：旧版 handlers 表缺该键，bot.on 会抛
  // TypeError（profiles 增量安装可能残留旧版 SDK）——降级为跳过监听而非崩溃
  try {
    bot.on('disconnected', (event: GatewayDisconnect) => {
      const detail = `code=${event.code}${event.reason ? ` reason=${event.reason}` : ''}`;
      if (event.willReconnect) {
        logger.warn(`Bot disconnected (${detail}), reconnecting...`);
      } else {
        logger.error(`Bot disconnected permanently (${detail}), giving up`);
      }
    });
  } catch (err) {
    logger.warn(`qqbot-nodejs SDK 不支持 disconnected 事件（请升级 @tencent-connect/qqbot-nodejs 至 1.0.5+）: ${err instanceof Error ? err.message : String(err)}`);
  }

  bot.on('ready', () => {
    console.log(`[zhoukai-qqbot] Bot ready! appId=${config.appId}`);
  });

  // ── 富媒体过期清理 ──
  if (config.media.enabled) {
    startMediaCleanup(ctx, config.media.ttlHours, logger);
  }

  // ── 视觉工具注册（qqbot_describe_image，复用 dsh llm + attachments） ──
  ensureVisionInputModal(config.vision, logger);
  registerDescribeImageTool(ctx, config.vision, logger);

  // ── 附件发送工具注册（qqbot_send_file，发送器见上方 mediaSender） ──
  registerSendFileTool(ctx, mediaSender, manager, effectiveConfig, logger);

  // ── 生命周期 ──
  (ctx as unknown as { effect(fn: () => (() => Promise<void>) | void, name?: string): void })
    .effect(() => {
      logger.info(`Starting bot (appId=${config.appId})`);
      bot.start().catch((err: unknown) => {
        logger.error(`Bot start failed: ${err instanceof Error ? err.message : String(err)}`);
      });

      return async () => {
        logger.info('Shutting down');
        await manager.disposeAll();
        bot.stop();
      };
    }, 'zhoukai-qqbot.lifecycle');
}
