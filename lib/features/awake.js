/**
 * awake — 觉醒式主动搭话（决策型，借鉴 dsh-roost/awake 的设计，思想重写）
 *
 * 解决「主动」的老问题。定时器式主动（到点就发、内容由固定 prompt 决定）
 * 的结果是"每隔几小时准时出现一句无关痛痒的话"——像闹钟，不像人。决策型：
 *
 *   1. 先算「有没有值得开口的机会」（三类，纯函数评分，可测）
 *   2. 把机会 + 理由喂给模型，让它自己决定说不开口
 *   3. 模型可以不说话：只回 `<<skip>>` —— **skip 是正常结局，不是失败**
 *      （硬叫醒的 AI 会为了"显得主动"随口挑一件不重要的事，比不说话更假）
 *
 * 三类机会性质完全不同：
 *   - agreement 约定 —— 收尾记录里的「下次怎么接」，过了冷却期就是钩子，最有效
 *   - miss      想你 —— 久了没聊（按 lastActivity 与最近一次主动开口取较近者）
 *   - casual    随性 —— 最容易做作，权重最低，每天最多 casualPerDay 次
 *
 * 说话通道：评估轮的模型回复若不是 skip，outbound 照常投递——c2c 主动
 * 走互动召回（is_wakeup，独立配额）。结果学习不依赖回调：探询前拍快照，
 * +3 分钟对比 (wakeupUsed+globalUsed) 是否增长——涨了=说了，没涨=按 skip 退避。
 *
 * 铁律：群聊不参与（没有「聊完/想你」的语义）；收尾冷却期内不随性；
 * 用户在 QQ 关闭主动消息（permission）的目标整体跳过。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const SKIP_MARKER = '<<skip>>';
// ── 纯函数评分 ──
/** agreement：收尾记录里「下次怎么接」过了冷却期就是钩子。存在且不冷却 → 0.7 */
export function scoreAgreement(closing, chatKey, coolMinutes) {
    if (!closing)
        return null;
    const rec = closing.get(chatKey);
    if (!rec)
        return null;
    const ageMin = (Date.now() - rec.closedAt) / MINUTE;
    if (ageMin < coolMinutes)
        return null; // 还在冷却，当话题线不存在
    return {
        kind: 'agreement',
        score: 0.7,
        reason: `上次对话收在「${rec.note || '道别'}」,距今 ${(ageMin / 60).toFixed(1)} 小时,有个没接完的话头`,
        record: null,
    };
}
/** miss：久没聊。沉默不足 missAfterHours → 不构成机会；越久分越高，封顶 0.6 */
export function scoreMiss(silenceHours, missAfterHours) {
    if (silenceHours < missAfterHours)
        return null;
    const score = Math.min(0.6, 0.3 + 0.05 * (silenceHours - missAfterHours));
    return {
        kind: 'miss',
        score,
        reason: `已经 ${silenceHours.toFixed(1)} 小时没聊了`,
        record: null,
    };
}
/** casual：随性。固定 0.4——只在没有更优机会且当日额度未用时递给模型 */
export function scoreCasual() {
    return { kind: 'casual', score: 0.4, reason: '今日随性额度', record: null };
}
/** 挑最优：score ≥ minScore 里取最高；并列时 agreement > miss > casual */
const KIND_RANK = { agreement: 3, miss: 2, casual: 1 };
export function pickBest(candidates, minScore) {
    const eligible = candidates.filter((c) => c.score >= minScore);
    if (eligible.length === 0)
        return null;
    return eligible.sort((a, b) => (b.score - a.score) || (KIND_RANK[b.kind] - KIND_RANK[a.kind]))[0];
}
/** 是否处于清醒时段（支持跨零点：如 22→6） */
export function withinAwakeHours(from, to, now = new Date()) {
    const h = now.getHours();
    return from <= to ? h >= from && h < to : h >= from || h < to;
}
/** 下一次唤醒时间戳：窗口内 → now + 20~60 分钟抖动；窗外 → 最近一次窗口开始 + 抖动 */
export function nextWakeAt(cfg, now = Date.now()) {
    const d = new Date(now);
    const jitter = Math.round((20 + Math.random() * 40) * MINUTE);
    const at = (hour, base) => {
        const t = new Date(base);
        t.setHours(hour, 0, 0, 0);
        return t.getTime() + jitter;
    };
    if (withinAwakeHours(cfg.awakeFrom, cfg.awakeTo, d)) {
        return now + jitter;
    }
    if (cfg.awakeFrom <= cfg.awakeTo) {
        const startToday = at(cfg.awakeFrom, d);
        return now < startToday ? startToday : at(cfg.awakeFrom, new Date(now + 24 * HOUR));
    }
    // 跨零点：两个可能的窗口起点，取未来最近的
    const startA = at(cfg.awakeFrom, d);
    const startB = at(cfg.awakeFrom, new Date(now + 24 * HOUR));
    const candidates = [startA, startB].filter((t) => t > now);
    return candidates.length > 0 ? candidates.sort((a, b) => a - b)[0] : now + jitter;
}
/** 评估轮的探询文案 */
export function probePrompt(opp, lastUserText) {
    const tail = lastUserText ? `最近对话的最后一句是对方说的:「${lastUserText.slice(0, 80)}」` : '最近没有对话内容';
    return [
        '【内部评估·主动搭话】这条消息不是对方发的,是排期系统在评估「要不要主动开口」。',
        `机会类型:${opp.kind}(${opp.reason})。${tail}`,
        '现在由你决定要不要主动开口:',
        '- 想说:直接写出要发给对方的那句话(会通过互动召回送达,一两句即可,符合你的人设,别提这条评估消息本身)',
        `- 不想说:只回复 ${SKIP_MARKER} ——这是完全正常的选择,不要为了显得热情硬找话题`,
    ].join('\n');
}
export class AwakeScheduler {
    deps;
    state;
    timer = null;
    stopped = false;
    constructor(deps) {
        this.deps = deps;
        this.state = this.load();
    }
    // ── 状态 ──
    load() {
        const fresh = () => ({ date: this.today(), casualToday: 0, speaks: {}, lastSpokeAt: {}, skipStreak: 0, nextWakeAt: 0 });
        try {
            if (!existsSync(this.deps.storePath))
                return fresh();
            const parsed = JSON.parse(readFileSync(this.deps.storePath, 'utf8'));
            if (parsed?.date !== this.today())
                return fresh();
            return {
                date: this.today(),
                casualToday: Number.isFinite(parsed.casualToday) ? parsed.casualToday : 0,
                speaks: parsed.speaks && typeof parsed.speaks === 'object' ? parsed.speaks : {},
                lastSpokeAt: parsed.lastSpokeAt && typeof parsed.lastSpokeAt === 'object' ? parsed.lastSpokeAt : {},
                skipStreak: Number.isFinite(parsed.skipStreak) ? parsed.skipStreak : 0,
                nextWakeAt: Number.isFinite(parsed.nextWakeAt) ? parsed.nextWakeAt : 0,
            };
        }
        catch {
            return fresh();
        }
    }
    persist() {
        try {
            mkdirSync(dirname(this.deps.storePath), { recursive: true });
            writeFileSync(this.deps.storePath, JSON.stringify(this.state, null, 2));
        }
        catch {
            // 持久化失败只影响重启后的连续性
        }
    }
    today() {
        const d = new Date();
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    }
    /** /bot-status 快照 */
    snapshot() {
        return {
            enabled: this.deps.cfg.enabled,
            nextWakeAt: this.state.nextWakeAt,
            casualToday: this.state.casualToday,
            speaksToday: Object.values(this.state.speaks).reduce((a, b) => a + b, 0),
            skipStreak: this.state.skipStreak,
        };
    }
    // ── 生命周期 ──
    start() {
        if (this.stopped || !this.deps.cfg.enabled)
            return;
        // 重启恢复:state.nextWakeAt 还在未来 → 沿用;已过期 → 5 分钟内补评估
        const delay = this.state.nextWakeAt > Date.now()
            ? this.state.nextWakeAt - Date.now()
            : Math.round((1 + Math.random() * 4) * MINUTE);
        this.schedule(delay);
        this.deps.logger?.info?.(`awake: 觉醒调度已启动,下次评估 ${new Date(Date.now() + delay).toLocaleString('zh-CN', { hour12: false })}`);
    }
    stop() {
        this.stopped = true;
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = null;
    }
    schedule(delayMs) {
        if (this.stopped)
            return;
        if (this.timer)
            clearTimeout(this.timer);
        this.state.nextWakeAt = Date.now() + Math.max(1, delayMs);
        this.persist();
        this.timer = setTimeout(() => void this.wake(), Math.max(1, delayMs));
        this.timer.unref?.();
    }
    // ── 唤醒评估 ──
    async wake() {
        if (this.stopped)
            return;
        try {
            await this.evaluate();
        }
        catch (err) {
            this.deps.logger?.warn?.(`awake: 评估异常(忽略): ${err instanceof Error ? err.message : String(err)}`);
        }
        this.schedule(nextWakeAt(this.deps.cfg));
    }
    async evaluate() {
        const { cfg, closing, permission } = this.deps;
        if (!withinAwakeHours(cfg.awakeFrom, cfg.awakeTo))
            return;
        // 候选:有会话记录的私聊目标(通常就是主人)
        const records = this.deps.manager.listRecords().filter((r) => r.replyTarget.scope === 'c2c');
        if (records.length === 0)
            return;
        const candidates = [];
        for (const record of records) {
            if (permission?.isRejected(record.peerId))
                continue; // 对方关了主动消息
            if ((this.state.speaks[record.sessionKey] ?? 0) >= cfg.maxSpeaksPerDay)
                continue; // 今日开口额度用尽
            if (closing?.isCooling(record.sessionKey))
                continue; // 刚道别,冷却期内不随性
            // agreement:收尾钩子(过冷却)
            const agr = scoreAgreement(closing, record.sessionKey, 90);
            if (agr)
                candidates.push({ ...agr, record });
            // miss:沉默时长(以 lastActivity 与最近开口的较近者为准)
            const lastSpoke = this.state.lastSpokeAt[record.sessionKey] ?? 0;
            const lastTouch = Math.max(record.lastActivity, lastSpoke);
            const miss = scoreMiss((Date.now() - lastTouch) / HOUR, cfg.missAfterHours);
            if (miss)
                candidates.push({ ...miss, record });
        }
        // casual:每日限额,无冷却目标才有资格
        if (this.state.casualToday < cfg.casualPerDay && records.length > 0) {
            const eligible = records.filter((r) => !closing?.isCooling(r.sessionKey) && !permission?.isRejected(r.peerId));
            if (eligible.length > 0) {
                const pick = eligible.sort((a, b) => b.lastActivity - a.lastActivity)[0];
                candidates.push({ ...scoreCasual(), record: pick });
            }
        }
        const best = pickBest(candidates, cfg.minScore);
        if (!best)
            return; // 没到阈值:连模型都不问,等下一轮评估
        // 随性额度扣减在探询前记账(模型说不说都算用了这次机会)
        if (best.kind === 'casual') {
            this.state.casualToday += 1;
            this.persist();
        }
        const record = best.record;
        const lastUserText = record.lastUserText ?? '';
        this.deps.logger?.info?.(`awake: 机会 ${best.kind}(score=${best.score.toFixed(2)}) → 问模型要不要开口 → ${record.sessionKey}`);
        this.deps.probe(record, probePrompt(best, lastUserText));
        // 结果学习:+3 分钟对比发送计数(涨了=说了,没涨=skip/失败 → 退避)
        const budget = this.deps.budget;
        const before = budget ? budget.snapshot().wakeupUsed + (budget.snapshot().usedGlobal ?? 0) : 0;
        const chatKey = record.sessionKey;
        setTimeout(() => {
            const after = budget ? budget.snapshot().wakeupUsed + (budget.snapshot().usedGlobal ?? 0) : 0;
            if (after > before) {
                // 说了:计数、记 lastSpokeAt、清退避;agreement 的钩子被用掉 → 覆盖式新收尾自然接管
                this.state.speaks[chatKey] = (this.state.speaks[chatKey] ?? 0) + 1;
                this.state.lastSpokeAt[chatKey] = Date.now();
                this.state.skipStreak = 0;
                this.persist();
                this.deps.logger?.info?.(`awake: 已主动开口 → ${chatKey}`);
            }
            else {
                this.state.skipStreak += 1;
                this.persist();
                this.deps.logger?.info?.(`awake: 模型选择 skip(第 ${this.state.skipStreak} 次)→ ${chatKey}`);
            }
        }, 3 * MINUTE).unref?.();
    }
}
//# sourceMappingURL=awake.js.map