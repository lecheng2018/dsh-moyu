/**
 * closing — 对话收尾状态（仅私聊）
 *
 * 解决「永远在接话」：对方说「我去睡了」，她回「晚安」，十分钟后又当无事
 * 发生地找话——因为系统里没有「这段聊完了」的概念。借鉴 SurfCore（MIT）的
 * `qq_close_conversation` 三条设计：
 *
 *   1. 收尾不发消息，只记「收在哪、下次怎么接」——说了再见就真的停
 *   2. 对方还在提问时拒绝收尾（调用方判定，见 qq-send-tools 的 qq_close）
 *   3. 收尾是状态，不是遗忘——记忆一条不动，只是这段对话有了句号
 *
 * 生命周期与记忆完全不同（覆盖式更新、会过期、参与主动搭话冷却），
 * 所以独立成模块，不塞进任何记忆存储。
 *
 * 存储：PLUGIN_HOME/closing.json，TTL 过期清理，maxChats 防无限增长。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const MINUTE = 60_000;
export class ClosingStore {
    file;
    cfg;
    state;
    constructor(storePath, cfg) {
        this.file = storePath;
        this.cfg = cfg;
        this.state = this.load();
    }
    ttlMs() {
        return Math.max(1, this.cfg.ttlDays) * 24 * 60 * MINUTE;
    }
    coolMs() {
        return Math.max(0, this.cfg.coolMinutes) * MINUTE;
    }
    load() {
        try {
            if (!existsSync(this.file))
                return { chats: {} };
            const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
            const chats = parsed?.chats && typeof parsed.chats === 'object' ? parsed.chats : {};
            // 载入即按 TTL 清理
            const now = Date.now();
            const cleaned = {};
            for (const [key, rec] of Object.entries(chats)) {
                if (rec && typeof rec.closedAt === 'number' && now - rec.closedAt < this.ttlMs()) {
                    cleaned[key] = rec;
                }
            }
            return { chats: cleaned };
        }
        catch {
            return { chats: {} };
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
    /** 记录一次收尾（覆盖式：同一会话只有最新一条） */
    close(chatKey, note) {
        const chats = this.state.chats;
        chats[chatKey] = { closedAt: Date.now(), note: note.trim() };
        // maxChats：超出时删最旧的
        const keys = Object.keys(chats);
        if (keys.length > this.cfg.maxChats) {
            keys
                .sort((a, b) => (chats[a]?.closedAt ?? 0) - (chats[b]?.closedAt ?? 0))
                .slice(0, keys.length - this.cfg.maxChats)
                .forEach((k) => delete chats[k]);
        }
        this.persist();
    }
    /** 取有效的收尾记录（TTL 内），过期返回 undefined */
    get(chatKey) {
        const rec = this.state.chats[chatKey];
        if (!rec)
            return undefined;
        if (Date.now() - rec.closedAt >= this.ttlMs())
            return undefined;
        return rec;
    }
    /** 收尾冷却期内（刚道别，不宜主动搭话） */
    isCooling(chatKey) {
        const rec = this.get(chatKey);
        if (!rec)
            return false;
        return Date.now() - rec.closedAt < this.coolMs();
    }
    /** 用户来消息 = 新对话开始，收尾状态使命完成 */
    consume(chatKey) {
        const rec = this.get(chatKey);
        if (rec) {
            delete this.state.chats[chatKey];
            this.persist();
        }
        return rec;
    }
}
//# sourceMappingURL=closing.js.map