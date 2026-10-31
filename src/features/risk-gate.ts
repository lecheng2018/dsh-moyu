/**
 * RiskGate — QQ 会话的工具风险门
 *
 * 两段式（对齐 dsh-im 核心的接法）：
 *   1. 本模块（第一段）：监听 `tools/pre-execute` waterfall（dsh-tools pipeline
 *      的扩展点，默认 `{kind:'allow'}`），只对 QQ 会话的工具调用按规则评估
 *      风险，达到阈值返回 `{kind:'ask', reason}` —— dsh-tools 随即走
 *      approval seam（pipeline.js: `gate.kind === "ask" ? serviceAsk(...)`);
 *   2. ApprovalChannel（第二段，官方已有）：`approval/request` answerer 把
 *      审批请求渲染成 QQ 两按钮卡片，批准/拒绝回流。
 *
 * 设计取向：
 *   - 只管 QQ 会话（manager.findByAgent 命中才介入），Web/CLI 不双弹窗
 *   - 未知工具与未命中规则 = low，永不拦截 —— 防审批疲劳（dsh-im 的教训：
 *     审批太频 → 用户关掉 → 反而更不安全）
 *   - 默认阈值 high：QQ 远程场景下只有「真会出事」的命令才打扰你；
 *     想更严把 level 调到 medium（rm -rf / sudo / 对外发送都会拦）
 */
import type { Context } from '@deepseek-ai/cordis';
import type { RiskGateConfig, RiskRule } from '../config.ts';
import type { SessionManager } from '../session/index.ts';
import type { Logger } from '../types.ts';

export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

const RISK_RANK: Record<RiskLevel, number> = { low: 1, medium: 2, high: 3 };

/** 风险级别比较：high > medium > low */
export function riskAtLeast(a: RiskLevel, b: RiskLevel): boolean {
  return RISK_RANK[a] >= RISK_RANK[b];
}

/**
 * 默认规则（顺序敏感：先匹配先生效；args 是对 arguments JSON 串的正则）。
 *
 * 工具名对齐 dsh 0.2.2-alpha.2 的实际注册名（bash/edit/write/...）。
 * 默认规则的取舍：高频无害操作（装依赖、常规 git、node_modules 清理）显式
 * 压成 low，保证 level=medium 时也不至于审批疲劳。
 */
export function defaultRiskRules(): RiskRule[] {
  return [
    // ── 显式 low：高频无害，压在 medium 之前防误拦 ──
    { tool: 'bash', args: 'rm\\s+-rf\\s+[^|;&]*node_modules', risk: 'low' },
    { tool: 'bash', args: '(npm|pnpm|yarn|bun)\\s+(install|ci|add|remove|update)', risk: 'low' },
    { tool: 'bash', args: 'pip\\s+(install|uninstall)', risk: 'low' },
    { tool: 'bash', args: 'git\\s+(pull|clone|fetch|checkout|merge|status|log|diff)', risk: 'low' },
    { tool: 'bash', args: 'git\\s+push(?!\\s+.*(--force\\b|-f\\b))', risk: 'low' },
    { tool: 'bash', args: '(systemctl|service)\\s+(status|list)', risk: 'low' },
    { tool: 'bash', args: '^(df|du|free|ps|top|ls|cat|head|tail|grep|find|which)\\b', risk: 'low' },
    // ── high：真会出事 ──
    { tool: 'bash', args: 'rm\\s+-rf\\s+[~/]|rm\\s+-rf\\s+\\*', risk: 'high' },
    { tool: 'bash', args: 'rm\\s+-rf\\s+/(etc|usr|var|boot|home|vol)', risk: 'high' },
    { tool: 'bash', args: '(mkfs|fdisk|parted|dd\\s+if=)', risk: 'high' },
    { tool: 'bash', args: '(curl|wget)[^|]*\\|\\s*(ba|z|f)?sh', risk: 'high' },
    { tool: 'bash', args: 'chmod\\s+-R\\s+777', risk: 'high' },
    { tool: 'bash', args: 'sudo\\s+(rm|shutdown|reboot|poweroff|halt|mkfs|dd)', risk: 'high' },
    { tool: 'bash', args: ':\\(\\)\\{.*\\};:', risk: 'high' }, // fork bomb
    { tool: 'send_message', args: '', risk: 'high' }, // 对外发送：对齐「发送必须审批」纪律
    // ── medium：level=medium 时才生效的加强档 ──
    { tool: 'bash', args: 'rm\\s+-rf', risk: 'medium' },
    { tool: 'bash', args: 'git\\s+push\\s+.*(--force\\b|-f\\b)', risk: 'medium' },
    { tool: 'bash', args: 'sudo', risk: 'medium' },
    { tool: 'bash', args: 'kill\\s+-9|pkill|killall', risk: 'medium' },
    { tool: 'bash', args: '(docker|podman)\\s+(rm|prune|system\\s+prune)', risk: 'medium' },
    { tool: 'write', args: '', risk: 'medium' },
    { tool: 'edit', args: '', risk: 'medium' },
  ];
}

/** 对一次工具调用评估风险级别（顺序敏感，未命中 = low） */
export function evaluateRisk(tool: string, argsJson: string, rules: RiskRule[]): RiskLevel {
  for (const rule of rules) {
    if (rule.tool !== tool) continue;
    if (rule.args) {
      let re: RegExp;
      try {
        re = new RegExp(rule.args, 'i');
      } catch {
        continue; // 用户配置了坏正则：跳过该条而不是崩
      }
      if (!re.test(argsJson)) continue;
    }
    return (RISK_LEVELS as readonly string[]).includes(rule.risk) ? rule.risk : 'low';
  }
  return 'low';
}

/** pre-execute waterfall 的载荷最小契约（dsh-tools pipeline.js:386） */
export interface PreExecuteInput {
  agent?: { id?: string };
  name?: string;
  arguments?: unknown;
  callId?: string;
}

/** gate 可返回的判定（对齐 pipeline 的 kind 联合） */
export type PreExecuteVerdict = { kind: 'allow' } | { kind: 'ask'; reason?: string } | { kind: 'deny'; reason?: string };

export class RiskGate {
  private readonly manager: SessionManager;
  private readonly config: RiskGateConfig;
  private readonly logger: Logger;
  private readonly rules: RiskRule[];

  public constructor(manager: SessionManager, config: RiskGateConfig, logger: Logger) {
    this.manager = manager;
    this.config = config;
    this.logger = logger;
    // 默认规则在前，用户追加规则在后（同优先级下后匹配不覆盖先匹配，追加规则只能补充新场景）
    this.rules = [...defaultRiskRules(), ...(config.extraRules ?? [])];
  }

  /** 注册 tools/pre-execute 监听（global 必需：waterfall 按 agent 作用域派发） */
  public install(ctx: Context): void {
    (ctx as unknown as {
      on(event: 'tools/pre-execute', handler: (exec: PreExecuteInput, next: () => Promise<PreExecuteVerdict>) => Promise<PreExecuteVerdict>, options?: { global?: boolean }): unknown;
    }).on('tools/pre-execute', (exec, next) => this.gate(exec, next), { global: true });
    this.logger.info(
      `risk-gate: 已启用（阈值 ${this.config.level}，规则 ${this.rules.length} 条，仅 QQ 会话）`,
    );
  }

  /** 风险评估：QQ 会话 + 达到阈值 → ask；其余放行 */
  public async gate(exec: PreExecuteInput, next: () => Promise<PreExecuteVerdict>): Promise<PreExecuteVerdict> {
    if (!this.config.enabled) return next();
    const record = exec.agent ? this.manager.findByAgent(exec.agent) : undefined;
    if (!record) return next(); // 只管 QQ 会话，Web/CLI 不双弹窗
    const tool = typeof exec.name === 'string' ? exec.name : '';
    if (!tool) return next();
    let argsJson = '';
    try {
      argsJson = JSON.stringify(exec.arguments ?? {});
    } catch {
      argsJson = '';
    }
    const risk = evaluateRisk(tool, argsJson, this.rules);
    if (!riskAtLeast(risk, this.config.level)) return next();
    return {
      kind: 'ask',
      reason: `QQ 远程审批：工具 "${tool}" 判定为 ${risk} 风险，等待你在 QQ 卡片上批准或拒绝`,
    };
  }
}
