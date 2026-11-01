import { parseTarget } from "./send-file-tool.js";
/** 工具名（qqbot 前缀避免与其他通道同名工具冲突） */
export const SEND_CARD_TOOL_NAME = 'qqbot_send_card';
/** 校验并组装卡片体；不合法返回错误说明（透传给模型好自纠） */
export function validateCardInput(input) {
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (title.length < 1 || title.length > 50) {
        return { ok: false, error: `title 必填且 1-50 字符（当前 ${title.length}）` };
    }
    const description = typeof input.description === 'string' && input.description.trim() ? input.description.trim() : undefined;
    if (description && description.length > 200) {
        return { ok: false, error: `description ≤200 字符（当前 ${description.length}）` };
    }
    for (const [field, value] of [['url', input.url], ['pic_url', input.pic_url]]) {
        if (value === undefined || value === '')
            continue;
        if (typeof value !== 'string' || !value.startsWith('https://')) {
            return { ok: false, error: `${field} 必须是 https:// 链接（平台要求）` };
        }
        if (value.length > 1024) {
            return { ok: false, error: `${field} ≤1024 字符` };
        }
    }
    const content = { title };
    if (description)
        content.description = description;
    if (input.url)
        content.url = input.url;
    if (input.pic_url)
        content.pic_url = input.pic_url;
    return { ok: true, card: { type: 'tuwen', content } };
}
/** 注册 qqbot_send_card 工具 */
export function registerSendCardTool(ctx, deps, logger) {
    const tools = ctx.get('tools');
    if (!tools?.register) {
        logger.warn?.('zhoukai-qqbot: tools 服务不可用，qqbot_send_card 工具未注册');
        return;
    }
    const definition = {
        name: SEND_CARD_TOOL_NAME,
        description: 'Send a rich picture-text card (title + optional description + optional https cover image + optional https link) '
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
            render: (_args, value) => [{ type: 'text', text: `卡片已发送 → ${value.target}` }],
        },
        async execute(args, exec) {
            const validated = validateCardInput(args);
            if (!validated.ok)
                throw new Error(`qqbot_send_card: ${validated.error}`);
            let replyTarget;
            const rawTarget = typeof args.target === 'string' ? args.target : undefined;
            if (rawTarget) {
                replyTarget = parseTarget(rawTarget);
                if (!replyTarget)
                    throw new Error(`qqbot_send_card: target 格式错误，需要 c2c:openid 或 group:openid，收到: ${rawTarget}`);
            }
            else if (exec.agent !== undefined) {
                // 工具层只承诺 {id?}；findByAgent 收更宽的 DshAgent，经 unknown 桥接
                replyTarget = deps.manager.findByAgent(exec.agent)?.replyTarget;
            }
            if (!replyTarget)
                throw new Error('qqbot_send_card: 无法确定发送目标，请显式传 target 参数');
            await deps.sendCard(replyTarget, validated.card);
            logger.info?.(`zhoukai-qqbot: qqbot_send_card 「${validated.card.content.title}」→ ${replyTarget.scope}:${replyTarget.targetId}`);
            return { target: `${replyTarget.scope}:${replyTarget.targetId}` };
        },
    };
    tools.register(definition);
    logger.info?.('zhoukai-qqbot: qqbot_send_card 工具已注册');
}
//# sourceMappingURL=send-card-tool.js.map