/**
 * zhoukai-dsh-qqbot 插件配置 Schema
 */
import Schema from '@deepseek-ai/schemastery';

export interface AccessControlConfig {
  /** C2C 访问模式 */
  c2cMode: 'open' | 'allowlist' | 'disabled';
  /** C2C 白名单（user openid） */
  c2cAllow: string[];
  /** 群聊访问模式 */
  groupMode: 'open' | 'allowlist' | 'disabled';
  /** 群聊白名单（group openid） */
  groupAllow: string[];
}

export interface MediaConfig {
  /** 是否启用富媒体理解（图片/视频下载 + 工具分析） */
  enabled: boolean;
  /** 富媒体下载大小上限（MB），默认 200 */
  maxMB: number;
  /** 富媒体存活时长（小时，TTL），默认 24，0 = 永不过期 */
  ttlHours: number;
}

export interface VisionConfig {
  /** 是否启用视觉理解（qqbot_describe_image 工具） */
  enabled: boolean;
  /** 视觉模型 provider（dsh 注册的 llm adapter，如 pi-ai） */
  provider: string;
  /** 视觉模型 id（如 qwen-vl-max） */
  model: string;
  /** 默认描述 prompt（调用未显式指定时使用） */
  defaultPrompt: string;
  /** 图片字节上限，默认 10MB */
  maxBytes: number;
  /** 输出 token 上限 */
  maxTokens: number;
  /** 视觉调用超时(ms) */
  timeoutMs: number;
}

/** 附件发送配置（qqbot_send_file 工具与 present 交付物投递共用） */
export interface SendFileConfig {
  /** 是否启用路径白名单（默认 true，仅允许 media + cwd + extraRoots；关闭则任意路径） */
  restrictPaths: boolean;
  /** 额外允许访问的根目录（media 和 agent cwd 始终默认允许） */
  extraRoots: string[];
  /** 是否把 present 声明的交付文件在轮末发送到当前会话 */
  sendPresentedFiles: boolean;
  /** 单轮最多投递的交付文件数 */
  maxFiles: number;
}

/** 主动消息配置（v2 C2C 接口：普通主动 = 单关系 1000 条/日；互动召回 = 30 天 4 周期各 1 条的独立配额） */
export interface ProactiveConfig {
  /** 是否启用预算闸门（兜底防失控；被动回复不受限） */
  enabled: boolean;
  /** 全局每日主动消息上限（0 = 不限；bot 级未认证 30qpm，闸门只防失控循环） */
  globalDaily: number;
  /** 单目标每日普通主动上限（0 = 不限；平台单关系上限 1000 条/日，闸门取其零头防刷屏） */
  perTargetDaily: number;
  /** 主动推送优先走互动召回（is_wakeup，独立配额不占每日额度；C2C 专属） */
  wakeup: boolean;
}

/** 发言走工具：AI 用 qq_send 分条发言 / qq_close 明确收尾 */
export interface QqSendConfig {
  /** 是否启用；开启后单聊流式自动关闭（二者抢同一条消息通道） */
  enabled: boolean;
  /** 单轮 qq_send 最多条数（1-5，平台被动回复每条消息最多 5 次，默认留余量） */
  maxParts: number;
}

/** 觉醒式主动搭话：打分 → 问模型 → 模型可 skip（决策型，非定时器硬发） */
export interface AwakeConfig {
  enabled: boolean;
  /** 清醒时段（小时，左闭右开，支持跨零点）：时段外不评估不搭话 */
  awakeFrom: number;
  awakeTo: number;
  /** 多久没聊算「想你」（小时） */
  missAfterHours: number;
  /** 机会分阈值：低于它连模型都不问（省 token） */
  minScore: number;
  /** 随性搭话每天最多几次 */
  casualPerDay: number;
  /** 每目标每天最多主动开口几次（含全部类型） */
  maxSpeaksPerDay: number;
  /** 模型 skip 后的退避起点（分钟），每连续 skip 翻倍 */
  skipBackoffMinutes: number;
  /** 退避上限（分钟） */
  skipBackoffMaxMinutes: number;
}

/** 对话收尾状态（仅私聊）：qq_close 记录「收在哪/下次怎么接」 */
export interface ClosingSettings {
  enabled: boolean;
  /** 收尾记录保留天数（太旧的「上次聊到」接上去反而怪） */
  ttlDays: number;
  /** 收尾后不主动搭话的冷却分钟数（刚说完晚安十分钟后又冒出来最假） */
  coolMinutes: number;
  /** 最多保留多少个会话的收尾记录 */
  maxChats: number;
}

export interface ImQQBotConfig {
  /** QQ Bot AppID */
  appId: string;
  /** QQ Bot AppSecret */
  appSecret: string;
  /** dsh LLM 提供商名称 */
  provider?: string;
  /** 模型名称 */
  model?: string;
  /** Agent preset id */
  preset?: string;
  /** Agent 工作目录（缺省 ~/.dsh-qqbot/workspace，不随宿主进程 cwd） */
  cwd?: string;
  /** 是否启用群消息 @mention 门控 */
  requireMention: boolean;
  /** 群聊额外 system prompt */
  groupPrompt?: string;
  /** 私聊额外 system prompt */
  directPrompt?: string;
  /** 单条消息最大长度（QQ 限制约 5000 字符） */
  textChunkLimit: number;
  /** 是否启用流式输出（群聊始终不启用） */
  streaming: boolean;
  /** 每会话最大闲置时长(ms)，超时自动回收 */
  sessionIdleTimeout: number;
  /** 并发队列最大长度 */
  maxQueue: number;
  /** 处理超时(ms)，超时中断当前 LLM 调用 */
  processingTimeoutMs: number;
  /** 待答问题超时(ms)，超时自动拒绝并提示（ask_user_question） */
  askTimeoutMs: number;
  /** 群历史缓冲条数 */
  historyLimit: number;
  /** 访问控制 */
  access: AccessControlConfig;
  /** 是否展示工具调用成功结果（工具错误始终展示） */
  showToolResults: boolean;
  /** 调试模式 */
  debug: boolean;
  /** 富媒体理解（图片/视频） */
  media: MediaConfig;
  /** 视觉理解（qqbot_describe_image 工具，走 dsh llm + attachments） */
  vision: VisionConfig;
  /** 附件发送（qqbot_send_file 工具与交付物投递共用） */
  sendFile: SendFileConfig;
  /** 主动消息每日配额（被动回复不受限） */
  proactive: ProactiveConfig;
  /** 发言走工具（qq_send 分条 / qq_close 收尾） */
  qqSend: QqSendConfig;
  /** 对话收尾状态（仅私聊） */
  closing: ClosingSettings;
  /** 觉醒式主动搭话 */
  awake: AwakeConfig;
}

/** 访问控制子 Schema（独立导出：config 路由的服务端校验复用） */
export const AccessControlSchema: Schema<AccessControlConfig> = Schema.object({
  c2cMode: Schema.union(['open', 'allowlist', 'disabled']).default('open').description('C2C访问模式（默认开放）'),
  c2cAllow: Schema.array(Schema.string()).default([]).description('C2C白名单（QQ OpenID）'),
  groupMode: Schema.union(['open', 'allowlist', 'disabled']).default('open').description('群聊访问模式（默认开放：群自带进群门槛 + @bot 触发）'),
  groupAllow: Schema.array(Schema.string()).default([]).description('群聊白名单（群 OpenID）'),
});

export const ConfigSchema: Schema<ImQQBotConfig> = Schema.object({
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
  awake: Schema.object({
    enabled: Schema.boolean().default(true).description('觉醒式主动搭话:打分后问模型「要不要说」,模型可 skip;仅私聊,走互动召回通道'),
    awakeFrom: Schema.number().default(8).description('清醒时段开始(小时)'),
    awakeTo: Schema.number().default(23).description('清醒时段结束(小时,不含)'),
    missAfterHours: Schema.number().default(6).description('多久没聊算「想你」(小时)'),
    minScore: Schema.number().default(0.35).description('机会分阈值(0-1),低于它不问模型'),
    casualPerDay: Schema.number().default(1).description('随性搭话每天最多几次'),
    maxSpeaksPerDay: Schema.number().default(3).description('每目标每天最多主动开口几次(全部类型合计)'),
    skipBackoffMinutes: Schema.number().default(30).description('模型 skip 后的退避起点(分钟),连续 skip 翻倍'),
    skipBackoffMaxMinutes: Schema.number().default(240).description('skip 退避上限(分钟)'),
  }).default({
    enabled: true,
    awakeFrom: 8,
    awakeTo: 23,
    missAfterHours: 6,
    minScore: 0.35,
    casualPerDay: 1,
    maxSpeaksPerDay: 3,
    skipBackoffMinutes: 30,
    skipBackoffMaxMinutes: 240,
  }).description('觉醒式主动搭话'),
});
