/**
 * zhoukai-dsh-qqbot 插件配置 Schema
 */
import Schema from '@deepseek-ai/schemastery';
/** 访问控制子 Schema（独立导出：config 路由的服务端校验复用） */
export const AccessControlSchema = Schema.object({
    c2cMode: Schema.union(['open', 'allowlist', 'disabled']).default('open').description('C2C访问模式（默认开放）'),
    c2cAllow: Schema.array(Schema.string()).default([]).description('C2C白名单（QQ OpenID）'),
    groupMode: Schema.union(['open', 'allowlist', 'disabled']).default('open').description('群聊访问模式（默认开放：群自带进群门槛 + @bot 触发）'),
    groupAllow: Schema.array(Schema.string()).default([]).description('群聊白名单（群 OpenID）'),
});
export const ConfigSchema = Schema.object({
    appId: Schema.string().default('').description('QQ 机器人 AppID'),
    appSecret: Schema.string().default('').description('QQ 机器人 AppSecret'),
    provider: Schema.string().description('LLM provider name'),
    model: Schema.string().description('Model name'),
    preset: Schema.string().description('Agent preset id'),
    cwd: Schema.string().description('Agent working directory (default ~/.dsh-qqbot/workspace)'),
    requireMention: Schema.boolean().default(true).description('群聊是否需要@bot触发'),
    groupPrompt: Schema.string().description('群聊额外system prompt'),
    directPrompt: Schema.string().description('私聊额外system prompt'),
    textChunkLimit: Schema.number().default(4500).description('单条消息最大字符数'),
    streaming: Schema.boolean().default(true).description('是否启用流式输出（群聊始终不启用）'),
    sessionIdleTimeout: Schema.number().default(30 * 60 * 1000).description('会话闲置超时(ms)'),
    maxQueue: Schema.number().default(20).description('并发队列最大长度'),
    processingTimeoutMs: Schema.number().default(30 * 60 * 1000).description('处理超时(ms)，超时中断当前 LLM 调用'),
    askTimeoutMs: Schema.number().default(5 * 60 * 1000).description('待答问题超时(ms)，超时自动拒绝并提示'),
    historyLimit: Schema.number().default(10).description('群历史缓冲条数'),
    access: AccessControlSchema.default({
        c2cMode: 'open',
        c2cAllow: [],
        groupMode: 'open',
        groupAllow: [],
    }).description('访问控制'),
    showToolResults: Schema.boolean().default(false).description('是否展示工具调用成功结果（错误始终展示）'),
    debug: Schema.boolean().default(false),
    media: Schema.object({
        enabled: Schema.boolean().default(true).description('是否启用富媒体理解（图片/视频下载 + 工具分析）'),
        maxMB: Schema.number().default(200).description('富媒体下载大小上限(MB)'),
        ttlHours: Schema.number().default(24).description('富媒体存活时长(小时)，0=永不过期'),
    }).default({
        enabled: true,
        maxMB: 200,
        ttlHours: 24,
    }).description('富媒体理解配置'),
    vision: Schema.object({
        enabled: Schema.boolean().default(false).description('是否启用视觉理解（qqbot_describe_image 工具）'),
        provider: Schema.string().default('').description('视觉模型 provider（dsh 注册的 llm adapter，如 pi-ai）'),
        model: Schema.string().default('').description('视觉模型 id（如 qwen-vl-max）'),
        defaultPrompt: Schema.string().default('Describe this image in detail.').description('默认描述 prompt'),
        maxBytes: Schema.number().default(10 * 1024 * 1024).description('图片字节上限'),
        maxTokens: Schema.number().default(1024).description('输出 token 上限'),
        timeoutMs: Schema.number().default(120000).description('视觉调用超时(ms)'),
    }).default({
        enabled: false,
        provider: '',
        model: '',
        defaultPrompt: 'Describe this image in detail.',
        maxBytes: 10 * 1024 * 1024,
        maxTokens: 1024,
        timeoutMs: 120000,
    }).description('视觉理解配置'),
    sendFile: Schema.object({
        restrictPaths: Schema.boolean().default(true).description('是否启用路径白名单（默认 true，仅允许 media + cwd + extraRoots）'),
        extraRoots: Schema.array(Schema.string()).default([]).description('额外允许访问的根目录'),
        sendPresentedFiles: Schema.boolean().default(true).description('是否将 present 声明的交付文件发送到当前会话'),
        maxFiles: Schema.number().default(4).description('单轮最多投递的交付文件数'),
    }).default({
        restrictPaths: true,
        extraRoots: [],
        sendPresentedFiles: true,
        maxFiles: 4,
    }).description('附件发送配置'),
    proactive: Schema.object({
        enabled: Schema.boolean().default(true).description('是否启用主动消息预算闸门（被动回复不受限）'),
        globalDaily: Schema.number().default(100).description('全局每日普通主动消息上限（0 = 不限；平台 bot 级未认证 30qpm，闸门只防失控）'),
        perTargetDaily: Schema.number().default(20).description('单目标每日普通主动上限（0 = 不限；平台单关系上限 1000 条/日，默认取零头防刷屏）'),
        wakeup: Schema.boolean().default(true).description('主动推送优先走互动召回（is_wakeup：30 天 4 周期各 1 条的独立配额，不占每日主动额度；失败自动转普通主动）'),
    }).default({
        enabled: true,
        globalDaily: 100,
        perTargetDaily: 20,
        wakeup: true,
    }).description('主动消息配置'),
    qqSend: Schema.object({
        enabled: Schema.boolean().default(true).description('发言走工具:AI 用 qq_send 分条发言、qq_close 收尾;开启后单聊流式自动关闭(二者抢同一消息通道)'),
        maxParts: Schema.number().default(3).description('单轮 qq_send 最多条数(1-5;平台被动回复每条消息最多 5 次,默认留余量)'),
    }).default({
        enabled: true,
        maxParts: 3,
    }).description('发言走工具'),
    closing: Schema.object({
        enabled: Schema.boolean().default(true).description('对话收尾状态(仅私聊):qq_close 记录「收在哪/下次怎么接」,记录期内每次对话自动注入衔接'),
        ttlDays: Schema.number().default(7).description('收尾记录保留天数'),
        coolMinutes: Schema.number().default(90).description('收尾后不主动搭话的冷却分钟数(以提示方式约束)'),
        maxChats: Schema.number().default(200).description('最多保留的会话收尾记录数'),
    }).default({
        enabled: true,
        ttlDays: 7,
        coolMinutes: 90,
        maxChats: 200,
    }).description('对话收尾'),
});
//# sourceMappingURL=config.js.map