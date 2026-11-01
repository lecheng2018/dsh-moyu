/**
 * qq-send-tools — 发言走工具：qq_send（分条发言）/ qq_close（明确收尾）
 *
 * 借鉴 SurfCore（MIT）的 reserved2 模式（dsh-roost 同源）。改造前：模型吐
 * 一整段 → outbound 按长度切段，模型对发言零控制权。改成工具后：
 *
 *   - `qq_send` 调一次 = 一条独立消息（被动窗口内，SDK 自动递增 msg_seq），
 *     调几次由模型自己定（上限 maxParts ≤ 5，对齐平台被动回复 5 次限制）
 *   - `qq_close` = 明确收尾：不发消息，写「收在哪/下次怎么接」进 closing 状态
 *   - 两者都不调 = 这一轮正常输出正文（长篇技术回答仍走原路径）
 *   - 调过 qq_send 的轮次，turn 末尾的正文由 outbound 压制（record.qqSendUsedThisTurn，
 *     见 outbound.ts）——所以模型不应在正文里重复已发内容
 *
 * 全走被动窗口：同一条消息的 msg_seq 1..N，不占主动消息额度。
 * @ 标签由宿主拼装（模型给语义参数，不碰 openid 语法，抄错也发不出去）。
 */
import type { ReplyTarget } from '../types.ts';
import type { SessionManager } from '../session/index.ts';
import type { ClosingStore } from './closing.ts';
import type { Logger } from '../types.ts';

export const QQ_SEND_TOOL_NAME = 'qq_send';
export const QQ_CLOSE_TOOL_NAME = 'qq_close';

/** 单轮条数硬上限（平台被动回复每条消息最多 5 次） */
export const MAX_PARTS_LIMIT = 5;

/**
 * openid 的合法形状：官方 member_openid / user_openid 是 base64url 风格长串。
 * 必须白名单校验：这个值会拼进 `<qqbot-at-user id="…" />` 属性，模型塞个引号
 * 就能把标签拆坏；长度下限 8 挡掉「@小明」这种把昵称当 id 传的情况。
 */
export const AT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * 算这段发言要不要带 @ 前缀。纯函数，每条规则错了都是社交事故：
 *   - 私聊发 @ → 官方只在群聊 markdown 支持，标签原样露出
 *   - 非第一段发 @ → 该段仍走 markdown，但 @ 挤在第二段语义错乱，按 roost 经验禁止
 *   - id 抄错 → 静默 @ 不到人，比报错更难查
 */
export function buildAtPrefix(opts: {
  at?: string;
  kind: 'group' | 'c2c';
  parts: number;
  senderId?: string;
}): { prefix: string; note: string } {
  const want = String(opts.at ?? '').trim();
  if (!want) return { prefix: '', note: '' };
  if (opts.kind !== 'group') {
    return { prefix: '', note: '私聊里没有 @ 这回事(官方只在群聊支持),这句按普通消息发了' };
  }
  if (opts.parts > 0) {
    return { prefix: '', note: '@ 只能挂在本轮第一条消息上,这句没 @(想 @ 就把那句话放第一段)' };
  }
  const id = want === 'sender' ? opts.senderId ?? '' : want;
  if (!id || !AT_ID_RE.test(id)) {
    return { prefix: '', note: 'at 参数不是合法 openid(应为 sender 或 8-64 位 base64url 串),这句没 @' };
  }
  return { prefix: `<qqbot-at-user id="${id}" /> `, note: '' };
}

export interface QqSendToolsDeps {
  manager: SessionManager;
  /** 发送单条（bootstrap 注入 sender.sendMarkdown：被动窗口 + msg_seq 自动递增） */
  send: (target: ReplyTarget, text: string) => Promise<unknown>;
  maxParts: number;
  closing?: ClosingStore;
  logger?: Logger;
}

interface ToolCtx {
  get(name: 'tools'): { register(def: unknown): void } | undefined;
}

/** 注册 qq_send / qq_close 两个工具（config.qqSend.enabled 时由 bootstrap 调用） */
export function registerQqSendTools(ctx: ToolCtx, deps: QqSendToolsDeps): void {
  const tools = ctx.get('tools');
  if (!tools?.register) {
    deps.logger?.warn?.('zhoukai-qqbot: tools 服务不可用，qq_send/qq_close 未注册');
    return;
  }
  const maxParts = Math.min(MAX_PARTS_LIMIT, Math.max(1, Math.floor(deps.maxParts) || 3));

  tools.register({
    name: QQ_SEND_TOOL_NAME,
    description:
      'Send one chat message to the current QQ conversation. Call it multiple times to split a casual reply into '
      + `several separate messages (max ${maxParts} per turn) — this reads much more human than one long block. `
      + 'After calling qq_send, do NOT repeat the same content in your final text (it will be dropped). '
      + 'For long technical/ops answers, skip this tool and just write the normal reply instead. '
      + 'Optional `at` (group only): "sender" or a member openid to @-mention, first message of the turn only.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Message text for this part (keep it short; markdown allowed).' },
        at: { type: 'string', description: 'Group only: "sender" or member openid to @-mention. First part only.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { part: { type: 'integer' }, note: { type: 'string' } },
        required: ['part'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: { part: number; note?: string }) => [
        { type: 'text', text: `已发出第 ${value.part} 条${value.note ? `（${value.note}）` : ''}` },
      ],
    },
    async execute(args: Record<string, unknown>, exec: { agent?: { id?: string } }) {
      const text = typeof args.text === 'string' ? args.text.trim() : '';
      if (!text) throw new Error('qq_send: text 必填且不能为空');
      const record = exec.agent
        ? deps.manager.findByAgent(exec.agent as unknown as Parameters<SessionManager['findByAgent']>[0])
        : undefined;
      if (!record) throw new Error('qq_send: 无法确定发送目标(当前会话不是 QQ 会话)');
      const count = record.turnQqSendCount ?? 0;
      if (count >= maxParts) {
        throw new Error(`qq_send: 本轮已发 ${count} 条,上限 ${maxParts} 条(平台被动回复上限)。想说的话并进下一条,或用 qq_close 收尾`);
      }
      const { prefix, note } = buildAtPrefix({
        at: typeof args.at === 'string' ? args.at : undefined,
        kind: record.replyTarget.scope === 'group' ? 'group' : 'c2c',
        parts: count,
        senderId: record.senderId,
      });
      await deps.send(record.replyTarget, prefix + text);
      record.turnQqSendCount = count + 1;
      record.qqSendUsedThisTurn = true;
      record.awakeProbeTurn = false; // 工具开口=选择说话,评估轮标记解除
      deps.logger?.info?.(`zhoukai-qqbot: qq_send 第 ${count + 1}/${maxParts} 条 → ${record.sessionKey}`);
      return { part: count + 1, ...(note ? { note } : {}) };
    },
  });

  tools.register({
    name: QQ_CLOSE_TOOL_NAME,
    description:
      'Mark the current private conversation as closed: you are done talking and will not add anything more. '
      + 'Does NOT send any message — it only records "where we left off / how to pick it up next time" so the '
      + 'next conversation continues naturally. Refused if the user just asked something and got no reply yet. '
      + 'Group conversations have no concept of closing — do not call it there.',
    parameters: {
      type: 'object',
      properties: {
        note: {
          type: 'string',
          description: '「收在哪 | 下次怎么接」,竖线分隔,后半可省。例:「聊完周末计划 | 下次问她订的哪天」',
        },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { closed: { type: 'boolean' } },
        required: ['closed'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: { closed: boolean }) => [{ type: 'text', text: value.closed ? '已收尾(不发消息)' : '未收尾' }],
    },
    async execute(args: Record<string, unknown>, exec: { agent?: { id?: string } }) {
      const record = exec.agent
        ? deps.manager.findByAgent(exec.agent as unknown as Parameters<SessionManager['findByAgent']>[0])
        : undefined;
      if (!record) throw new Error('qq_close: 无法确定会话');
      if (record.replyTarget.scope !== 'c2c') {
        return { closed: false, note: '群聊没有「聊完」这回事,忽略本次收尾' };
      }
      // 对方还在提问且本轮尚未作答 → 拒绝收尾(问题没答完就退场,最让人恼火)
      const last = (record.lastUserText ?? '').trim();
      const answered = (record.turnQqSendCount ?? 0) > 0;
      if (!answered && /[?？]\s*$/.test(last)) {
        throw new Error('qq_close: 对方最后一条是提问且本轮还没回应,先回答再收尾');
      }
      const note = typeof args.note === 'string' && args.note.trim() ? args.note.trim() : '';
      deps.closing?.close(record.sessionKey, note);
      deps.logger?.info?.(`zhoukai-qqbot: qq_close 收尾 → ${record.sessionKey}${note ? ` note=${note.slice(0, 40)}` : ''}`);
      return { closed: true };
    },
  });

  deps.logger?.info?.(`zhoukai-qqbot: qq_send/qq_close 工具已注册(单轮上限 ${maxParts} 条)`);
}
