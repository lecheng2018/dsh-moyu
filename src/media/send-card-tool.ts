/**
 * 内置 qqbot_send_card 工具 — 图文卡片消息（msg_type=8，2026-10-28 新增）
 *
 * 用途：定时任务汇报/结果通知带「标题 + 描述 + 封面图 + 跳转链接」，
 * 比纯文本醒目（例如汇报备份结果并附 NAS 面板链接）。
 *
 * 平台规则（bot.q.qq.com v2 文档 §9.1）：
 *   - card.type 目前仅 tuwen：content{title ≤50, description ≤200, url https ≤1024, pic_url https ≤1024}
 *   - url / pic_url 必须 https
 *   - 单聊/群聊均支持
 *
 * 发送路径与 qqbot_send_file 一致：目标默认自动定位（当前会话），
 * 被动窗口内带 msg_id（免费）；主动时过预算闸门，被拦抛错给模型。
 */
import type { SessionManager } from '../session/index.ts';
import type { ReplyTarget } from '../types.ts';
import { parseTarget } from './send-file-tool.ts';

/** 工具名（qqbot 前缀避免与其他通道同名工具冲突） */
export const SEND_CARD_TOOL_NAME = 'qqbot_send_card';

export interface CardInput {
  title: string;
  description?: string;
  url?: string;
  pic_url?: string;
}

export interface CardBody {
  type: 'tuwen';
  content: { title: string; description?: string; url?: string; pic_url?: string };
}

/** 校验并组装卡片体；不合法返回错误说明（透传给模型好自纠） */
export function validateCardInput(input: CardInput): { ok: true; card: CardBody } | { ok: false; error: string } {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (title.length < 1 || title.length > 50) {
    return { ok: false, error: `title 必填且 1-50 字符（当前 ${title.length}）` };
  }
  const description = typeof input.description === 'string' && input.description.trim() ? input.description.trim() : undefined;
  if (description && description.length > 200) {
    return { ok: false, error: `description ≤200 字符（当前 ${description.length}）` };
  }
  for (const [field, value] of [['url', input.url], ['pic_url', input.pic_url]] as const) {
    if (value === undefined || value === '') continue;
    if (typeof value !== 'string' || !value.startsWith('https://')) {
      return { ok: false, error: `${field} 必须是 https:// 链接（平台要求）` };
    }
    if (value.length > 1024) {
      return { ok: false, error: `${field} ≤1024 字符` };
    }
  }
  const content: CardBody['content'] = { title };
  if (description) content.description = description;
  if (input.url) content.url = input.url;
  if (input.pic_url) content.pic_url = input.pic_url;
  return { ok: true, card: { type: 'tuwen', content } };
}

/** 发送器注入（bootstrap 内实现：被动解析 + 预算闸门） */
export type CardSender = (target: ReplyTarget, card: CardBody) => Promise<unknown>;

/** 注册 qqbot_send_card 工具 */
export function registerSendCardTool(
  ctx: { get(name: 'tools'): { register(def: unknown): void } | undefined },
  deps: { sendCard: CardSender; manager: SessionManager },
  logger: { info?(...a: unknown[]): void; warn?(...a: unknown[]): void },
): void {
  const tools = ctx.get('tools');
  if (!tools?.register) {
    logger.warn?.('zhoukai-qqbot: tools 服务不可用，qqbot_send_card 工具未注册');
    return;
  }
  const definition = {
    name: SEND_CARD_TOOL_NAME,
    description:
      'Send a rich picture-text card (title + optional description + optional https cover image + optional https link) '
      + 'to the current QQ conversation. Use for task reports / notifications that benefit from a clickable link '
      + '(e.g. a dashboard URL). Title is required; url and pic_url must be https.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Card title, 1-50 characters.' },
        description: { type: 'string', description: 'Optional card description, ≤200 characters.' },
        url: { type: 'string', description: 'Optional https link the card opens when tapped (≤1024 chars).' },
        pic_url: { type: 'string', description: 'Optional https cover image URL (≤1024 chars).' },
        target: { type: 'string', description: 'Optional send target as "c2c:openid" or "group:openid". Omit to send to the current conversation.' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { target: { type: 'string' } },
        required: ['target'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: { target: string }) => [{ type: 'text', text: `卡片已发送 → ${value.target}` }],
    },
    async execute(args: Record<string, unknown>, exec: { agent?: { id?: string } }) {
      const validated = validateCardInput(args as unknown as CardInput);
      if (!validated.ok) throw new Error(`qqbot_send_card: ${validated.error}`);
      let replyTarget: ReplyTarget | undefined;
      const rawTarget = typeof args.target === 'string' ? args.target : undefined;
      if (rawTarget) {
        replyTarget = parseTarget(rawTarget);
        if (!replyTarget) throw new Error(`qqbot_send_card: target 格式错误，需要 c2c:openid 或 group:openid，收到: ${rawTarget}`);
      } else if (exec.agent !== undefined) {
        // 工具层只承诺 {id?}；findByAgent 收更宽的 DshAgent，经 unknown 桥接
        replyTarget = deps.manager.findByAgent(exec.agent as unknown as Parameters<SessionManager['findByAgent']>[0])?.replyTarget;
      }
      if (!replyTarget) throw new Error('qqbot_send_card: 无法确定发送目标，请显式传 target 参数');
      await deps.sendCard(replyTarget, validated.card);
      logger.info?.(`zhoukai-qqbot: qqbot_send_card 「${validated.card.content.title}」→ ${replyTarget.scope}:${replyTarget.targetId}`);
      return { target: `${replyTarget.scope}:${replyTarget.targetId}` };
    },
  };
  tools.register(definition);
  logger.info?.('zhoukai-qqbot: qqbot_send_card 工具已注册');
}
