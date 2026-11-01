/**
 * proactive-queue — 被预算拦下的主动消息暂存箱
 *
 * 预算闸门拦掉的主动推送（定时任务汇报、后台完成通知等）不应无声消失：
 * 本模块把它们按目标暂存，等该目标下一条真实消息到达时（被动窗口开启），
 * 作为普通被动回复依次补发。
 *
 * 设计边界：
 *   - 持久化到 PLUGIN_HOME/proactive-outbox.json，重启不丢
 *   - TTL 过期丢弃（默认 24h：隔天的定时汇报补发只会造成困惑）
 *   - 每目标上限 + 全局上限，防止故障任务灌爆
 *   - flush 只发当前目标的消息，发送走普通被动通道（带新鲜 msg_id，
 *     不再过预算闸门 —— 补发的是被动回复，本来就免费）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
/** 暂存条目 TTL（ms）：24h */
const ITEM_TTL_MS = 24 * 60 * 60 * 1000;
/** 每目标最大暂存条数：超出丢最旧的 */
const MAX_PER_TARGET = 10;
/** 全局最大暂存条数 */
const MAX_TOTAL = 50;
export class ProactiveQueue {
    file;
    state;
    constructor(storePath) {
        this.file = storePath;
        this.state = this.load();
    }
    load() {
        try {
            if (!existsSync(this.file))
                return { targets: {} };
            const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
            const targets = parsed?.targets && typeof parsed.targets === 'object' ? parsed.targets : {};
            // 载入时按 TTL 清理
            const now = Date.now();
            const cleaned = {};
            for (const [key, items] of Object.entries(targets)) {
                const live = (Array.isArray(items) ? items : []).filter((i) => !!i && typeof i.text === 'string' && typeof i.at === 'number' && now - i.at < ITEM_TTL_MS);
                if (live.length > 0)
                    cleaned[key] = live;
            }
            return { targets: cleaned };
        }
        catch {
            return { targets: {} };
        }
    }
    persist() {
        try {
            mkdirSync(dirname(this.file), { recursive: true });
            writeFileSync(this.file, JSON.stringify(this.state, null, 2));
        }
        catch {
            // 持久化失败只影响重启后的连续性
        }
    }
    /** 入队一条被拦的主动消息；超限丢最旧的并返回 false 供日志 */
    enqueue(target, text, logger) {
        const key = `${target.scope}:${target.targetId}`;
        const items = this.state.targets[key] ?? [];
        items.push({ text, at: Date.now() });
        let dropped = false;
        while (items.length > MAX_PER_TARGET) {
            items.shift();
            dropped = true;
        }
        this.state.targets[key] = items;
        // 全局上限：从最旧的目标开始挤掉
        let total = Object.values(this.state.targets).reduce((n, list) => n + list.length, 0);
        for (const k of Object.keys(this.state.targets)) {
            if (total <= MAX_TOTAL)
                break;
            const list = this.state.targets[k];
            while (list.length > 0 && total > MAX_TOTAL) {
                list.shift();
                total -= 1;
                dropped = true;
            }
            if (list.length === 0)
                delete this.state.targets[k];
        }
        this.persist();
        if (dropped)
            logger?.warn?.(`proactive-queue: 暂存超限，丢弃了部分最旧条目 key=${key}`);
        return !dropped;
    }
    /**
     * 把该目标暂存的消息用 `send` 依次补发（发送方负责走被动通道）。
     * 发送成功才移除条目；失败的保留等下一次。返回补发条数。
     */
    async flush(target, send, logger) {
        const key = `${target.scope}:${target.targetId}`;
        const items = this.state.targets[key];
        if (!items || items.length === 0)
            return 0;
        const now = Date.now();
        let delivered = 0;
        while (items.length > 0) {
            const item = items[0];
            if (now - item.at >= ITEM_TTL_MS) {
                items.shift();
                continue;
            }
            try {
                await send(item.text);
                items.shift();
                delivered += 1;
            }
            catch (err) {
                logger?.warn?.(`proactive-queue: 补发失败，保留条目等下次: ${err instanceof Error ? err.message : String(err)}`);
                break;
            }
        }
        if (items.length === 0)
            delete this.state.targets[key];
        this.persist();
        return delivered;
    }
    /** /bot-quota 展示用：全局与单目标的暂存条数 */
    snapshot(scope, targetId) {
        let total = 0;
        for (const list of Object.values(this.state.targets))
            total += list.length;
        const forTarget = scope && targetId ? this.state.targets[`${scope}:${targetId}`]?.length ?? 0 : null;
        return { total, forTarget };
    }
}
//# sourceMappingURL=proactive-queue.js.map