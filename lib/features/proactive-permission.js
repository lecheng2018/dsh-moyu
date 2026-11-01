/**
 * proactive-permission — 单聊主动消息开关感知
 *
 * 平台事件（GROUP_AND_C2C_EVENT intent）：
 *   - C2C_MSG_REJECT：用户在 QQ 关闭「允许机器人主动发消息」→ 此后的主动推送
 *     必失败（40034105/40034100），不感知就白发白报错
 *   - C2C_MSG_RECEIVE：用户重新开启 → 自动恢复
 *
 * 感知后的行为（由 bootstrap 的预算闸门消费）：
 *   - 该用户的主动推送直接走暂存箱/报错路径，不再撞平台错误
 *   - 用户重新开启后，暂存箱随补发自然送达
 *
 * 持久化到 PLUGIN_HOME/proactive-permission.json：重启不丢感知状态，
 * 避免每次重启都白白撞一次平台错误才重新学到。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
export class ProactivePermission {
    logger;
    file;
    state;
    constructor(storePath, logger) {
        this.logger = logger;
        this.file = storePath;
        this.state = this.load();
    }
    load() {
        try {
            if (!existsSync(this.file))
                return { rejected: {} };
            const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
            return {
                rejected: parsed?.rejected && typeof parsed.rejected === 'object' ? parsed.rejected : {},
            };
        }
        catch {
            return { rejected: {} };
        }
    }
    persist() {
        try {
            mkdirSync(dirname(this.file), { recursive: true });
            writeFileSync(this.file, JSON.stringify(this.state, null, 2));
        }
        catch {
            // 持久化失败只影响重启后的记忆，不阻断判断
        }
    }
    /** 记录用户的主动消息开关状态（true=关闭） */
    setRejected(userOpenid, rejected) {
        if (!userOpenid)
            return;
        if (rejected) {
            this.state.rejected[userOpenid] = Date.now();
        }
        else {
            delete this.state.rejected[userOpenid];
        }
        this.persist();
        this.logger?.info?.(`proactive-permission: ${userOpenid.slice(0, 10)}… 主动消息${rejected ? '已关闭' : '已开启'}`);
    }
    /** 该用户是否关闭了主动消息 */
    isRejected(userOpenid) {
        return userOpenid in this.state.rejected;
    }
    /** 当前处于「已关闭」状态的用户数（/bot-status 用） */
    rejectedCount() {
        return Object.keys(this.state.rejected).length;
    }
}
//# sourceMappingURL=proactive-permission.js.map