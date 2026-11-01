/**
 * 网关组装 — 创建 bot、编排中间件、注册事件、出站、生命周期
 *
 * 将 QQ 消息平台作为 dsh 前端协议驱动：入站消息 → handleInbound → dsh agent，
 * dsh session/event → createOutboundHandler → QQ 出站。
 */
import type { Context } from '@deepseek-ai/cordis';
import { QQBot, MsgType } from '@tencent-connect/qqbot-nodejs';
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
import { decodeButtonData } from '../features/button-utils.ts';
import { discoverMemeRoots, seedMemeDefaults } from '../features/meme-bridge.ts';
import { ProactiveBudget } from '../transport/proactive-budget.ts';
import { ProactiveQueue } from '../transport/proactive-queue.ts';
import { ProactivePermission } from '../features/proactive-permission.ts';
import { ClosingStore } from '../features/closing.ts';
import { registerQqSendTools } from '../features/qq-send-tools.ts';
import { AwakeScheduler } from '../features/awake.ts';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { PLUGIN_HOME } from '../shared/dirs.ts';
import { buildUserAgent } from '../shared/index.ts';
import type { ImQQBotConfig } from '../config.ts';
import type { ChatScope, Logger, ReplyTarget } from '../types.ts';
import { resolve } from 'node:path';
import { setupMiddlewares } from './middleware-setup.ts';
import { startMediaCleanup } from '../media/media-cleaner.ts';
import { ensureVisionInputModal, registerDescribeImageTool } from '../media/vision-tool.ts';
import { registerSendFileTool, type MediaSenderLike } from '../media/send-file-tool.ts';
import { registerSendCardTool } from '../media/send-card-tool.ts';
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
    // qq_send 分条发言与流式输出抢同一消息通道：工具模式开启时单聊流式自动关闭
    streaming: config.streaming && !config.qqSend.enabled,
  };

  const manager = new SessionManager(ctx, agents, effectiveConfig, logger);
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

  // ── 主动消息预算闸门 + 互动召回优先 ──
  // resolveReplyTarget 返回的目标不带 msg_id/event_id = 三级兜底走到第 3 级（主动推送）。
  // v2 C2C 有两条互斥的主动通道：
  //   ① 互动召回（is_wakeup，C2C 专属）：30 天 4 周期各 1 条的独立配额，
  //      不占每日主动额度；用户发一句消息即重置计时 —— 定时汇报首选。
  //   ② 普通主动：单关系 1000 条/日，走预算闸门（globalDaily/perTargetDaily）。
  // 顺序：wakeup 开启且 C2C → 先试①，失败自动转②；被闸门拦下 → 文本进暂存箱
  // （下次该目标来消息时被动补发），媒体抛错给模型。被动回复全都不经过这里。
  const proactiveBudget = config.proactive.enabled
    ? new ProactiveBudget(resolve(PLUGIN_HOME, 'proactive-budget.json'), config.proactive)
    : undefined;
  manager.proactiveBudget = proactiveBudget;
  const proactiveQueue = config.proactive.enabled
    ? new ProactiveQueue(resolve(PLUGIN_HOME, 'proactive-outbox.json'))
    : undefined;
  manager.proactiveQueue = proactiveQueue;
  // 单聊主动消息开关感知：用户在 QQ 关掉「允许机器人主动发消息」→ 推送直接走暂存，不再白发
  const proactivePermission = config.proactive.enabled
    ? new ProactivePermission(resolve(PLUGIN_HOME, 'proactive-permission.json'), logger)
    : undefined;
  manager.proactivePermission = proactivePermission;
  // 对话收尾状态（qq_close 写入，system prompt 注入衔接；仅私聊语义）
  const closingStore = config.closing.enabled
    ? new ClosingStore(resolve(PLUGIN_HOME, 'closing.json'), config.closing)
    : undefined;
  manager.closingStore = closingStore;
  // 觉醒式主动搭话:打分 → 问模型 → 模型可 skip;开口走互动召回(独立配额)
  const awake = config.awake.enabled
    ? new AwakeScheduler({
        manager,
        cfg: config.awake,
        storePath: resolve(PLUGIN_HOME, 'awake.json'),
        budget: proactiveBudget ?? undefined,
        closing: closingStore,
        permission: proactivePermission,
        probe: (record, text) => {
          record.awakeProbeTurn = true;
          record.agent.followup(createUserMessage({
            content: [{ type: 'text' as const, text }],
            source: { kind: 'user' as const },
          }));
        },
        logger,
      })
    : undefined;
  manager.awake = awake;
  const gateProactive = <T>(
    target: ReplyTarget,
    resolved: ReplyTarget,
    attempt: {
      normal: () => Promise<T>;
      /** 互动召回通道（仅 C2C 文本传入）；未传或失败 → 预算闸门 → 普通主动 */
      wakeup?: () => Promise<T>;
      onBlocked: () => T;
    },
  ): Promise<T> => {
    const isProactive = resolved.msgId === undefined && resolved.eventId === undefined;
    if (!isProactive) return attempt.normal();
    const budgetPath = (): Promise<T> => {
      // 用户在 QQ 关闭了「允许机器人主动发消息」→ 直接走暂存/报错，不再撞平台错误；
      // 重新开启（C2C_MSG_RECEIVE）后暂存箱随补发自然送达
      if (target.scope === 'c2c' && proactivePermission?.isRejected(target.targetId)) {
        logger.warn(`proactive-permission: 对方已关闭主动消息 → ${target.scope}:${target.targetId} 跳过直发`);
        return Promise.resolve(attempt.onBlocked());
      }
      if (!proactiveBudget) return attempt.normal();
      const check = proactiveBudget.tryConsume(target.scope, target.targetId);
      if (!check.ok) {
        logger.warn(`proactive-budget: 主动推送被拦（${check.reason === 'global' ? '全局额度' : '单目标额度'}用尽）→ ${target.scope}:${target.targetId}`);
        return Promise.resolve(attempt.onBlocked());
      }
      return attempt.normal();
    };
    if (attempt.wakeup) {
      return attempt.wakeup().catch((err: unknown) => {
        logger.warn(`proactive: 互动召回失败，转普通主动（预算闸门）: ${err instanceof Error ? err.message : String(err)}`);
        return budgetPath();
      });
    }
    return budgetPath();
  };
  const BLOCKED_SKIP = { skipped: 'proactive-budget' };
  const BLOCKED_THROW = (): never => {
    throw new Error('主动消息每日配额已用尽（proactive budget exhausted），请明天再试或提高 proactive 配置');
  };

  // 发送适配器：将 QQBot 实例适配为 QQBotSender（openStream 参数形态不同）。
  // sendMarkdown 统一做被动回复限额管控：同一 msgId 超限/过期时降级主动推送（互动召回优先 → 预算闸门）。
  const replyLimiter = new ReplyLimiter({ limit: 4 });
  const sender: QQBotSender = {
    sendMarkdown: (target, content, opts) => {
      const resolved = resolveReplyTarget(target, replyLimiter, true);
      return gateProactive(target, resolved, {
        normal: () => sendResolvedMarkdown(bot, resolved, content, opts),
        wakeup: target.scope === 'c2c'
          ? async () => {
              const r = await bot.send({
                target,
                msgType: MsgType.MARKDOWN,
                markdown: { content },
                extra: { is_wakeup: true },
              });
              proactiveBudget?.recordWakeup();
              return r;
            }
          : undefined,
        onBlocked: () => {
          proactiveQueue?.enqueue(target, content, logger);
          return BLOCKED_SKIP;
        },
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
      return gateProactive(target, resolved, { normal: () => bot.sendImage(resolved, source), onBlocked: BLOCKED_THROW });
    },
    sendVideo: (target, source) => {
      const resolved = resolveReplyTarget(target, replyLimiter, false);
      return gateProactive(target, resolved, { normal: () => bot.sendVideo(resolved, source), onBlocked: BLOCKED_THROW });
    },
    sendVoice: (target, source) => {
      const resolved = resolveReplyTarget(target, replyLimiter, false);
      return gateProactive(target, resolved, { normal: () => bot.sendVoice(resolved, source), onBlocked: BLOCKED_THROW });
    },
    sendFile: (target, source, opts) => {
      const resolved = resolveReplyTarget(target, replyLimiter, false);
      return gateProactive(target, resolved, { normal: () => bot.sendFile(resolved, source, opts), onBlocked: BLOCKED_THROW });
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

  // ── 单聊主动消息开关感知（C2C_MSG_REJECT / C2C_MSG_RECEIVE，GROUP_AND_C2C_EVENT intent） ──
  bot.on('rawEvent', (ctx) => {
    const eventType = (ctx as { eventType?: string }).eventType;
    if (eventType !== 'C2C_MSG_REJECT' && eventType !== 'C2C_MSG_RECEIVE') return;
    const data = (ctx as { data?: Record<string, unknown> }).data ?? {};
    const author = data.author as { user_openid?: string } | undefined;
    const openid = String(data.user_openid ?? data.openid ?? author?.user_openid ?? '');
    if (!openid) return;
    proactivePermission?.setRejected(openid, eventType === 'C2C_MSG_REJECT');
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
    console.log(`[moyu-qqbot] Bot ready! appId=${config.appId}`);
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

  // ── 发言走工具注册（qq_send 分条 / qq_close 收尾；开启后流式已自动关闭） ──
  if (effectiveConfig.qqSend.enabled) {
    registerQqSendTools(ctx, {
      manager,
      send: (target, text) => sender.sendMarkdown(target, text),
      maxParts: effectiveConfig.qqSend.maxParts,
      closing: effectiveConfig.closing.enabled ? closingStore : undefined,
      logger,
    });
  }

  // ── 图文卡片工具注册（qqbot_send_card，msg_type=8） ──
  // 发送路径与文本一致：被动窗口内带 msg_id（免费）；主动时过互动召回/预算闸门，被拦抛错给模型
  registerSendCardTool(ctx, {
    sendCard: (target, card) => {
      const resolved = resolveReplyTarget(target, replyLimiter, false);
      return gateProactive(target, resolved, {
        normal: () => bot.send({ target: resolved, extra: { msg_type: 8, card } }),
        onBlocked: BLOCKED_THROW,
      });
    },
    manager,
  }, logger);

  // ── 生命周期 ──
  (ctx as unknown as { effect(fn: () => (() => Promise<void>) | void, name?: string): void })
    .effect(() => {
      logger.info(`Starting bot (appId=${config.appId})`);
      bot.start().catch((err: unknown) => {
        logger.error(`Bot start failed: ${err instanceof Error ? err.message : String(err)}`);
      });

      awake?.start();
      return async () => {
        logger.info('Shutting down');
        awake?.stop();
        await manager.disposeAll();
        bot.stop();
      };
    }, 'moyu-qqbot.lifecycle');
}
