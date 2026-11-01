/**
 * meme-bridge — dsh-meme 表情包插件零配置对接
 *
 * dsh-meme（yyh-001/dsh-meme）的 send_meme 候选带图库绝对路径，模型会把它
 * 原样传给 qqbot_send_file。默认路径白名单（media + cwd）不含图库目录，
 * 每次都要手动往 sendFile.extraRoots 加 —— 本模块做两件事：
 *
 *   1. discoverMemeRoots()：探测图库目录，自动并入 sendFile 白名单
 *      （dsh-meme 的目录解析规则：DSH_MEME_HOME || homedir()，包目录
 *        ~/.dsh/meme-packs，用户配置覆盖见 ~/.dsh/dsh-expression.json 的 packsDir）
 *   2. seedMemeDefaults()：dsh-meme 设置文件存在但未开「QQ 发图尺寸」时，
 *      帮它写上默认值（qqSendResize=true, qqSendEdge=300）——QQ 官方机器人
 *      没有表情消息类型，大图会被客户端按图片消息拉伸，300px 是插件文档
 *      给的经验值。只补缺失键，从不覆盖用户已保存的值。
 *
 * 探测失败/文件不存在一律静默跳过（dsh-meme 没装是常态，不刷日志）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getProfileDir } from "../shared/index.js";
/** 与 dsh-meme memes.js 的 dshHome() 对齐：环境变量优先，规避 Windows HOME 缺失回落 CWD 的历史 bug */
function dshMemeHome() {
    return process.env.DSH_MEME_HOME || homedir();
}
function dshExpressionFile() {
    return join(dshMemeHome(), '.dsh', 'dsh-expression.json');
}
/** 读 dsh-meme 的设置 JSON；文件不存在/损坏返回 undefined */
function readMemeSettings() {
    const file = dshExpressionFile();
    if (!existsSync(file))
        return undefined;
    try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * 探测 dsh-meme 图库根目录（三条路径）：
 *   1. 默认包目录 ~/.dsh/meme-packs（用户自装/市场装的图库都在这）
 *   2. 用户设置覆盖 packsDir（dsh-expression.json）
 *   3. **dsh-meme 插件包内置图库** node_modules/dsh-meme/memes（如 dafeiyu-001）——
 *      官方 README 明确要求白名单也要含它，否则 send_meme 返回内置包候选时
 *      qqbot_send_file 会以「不在允许的目录内」拒发
 * 只返回真实存在的目录；什么都没有时返回空数组。
 */
export function discoverMemeRoots(logger) {
    const roots = [];
    const push = (dir) => {
        if (typeof dir === 'string' && dir.length > 0 && existsSync(dir) && !roots.includes(dir)) {
            roots.push(dir);
        }
    };
    try {
        push(join(dshMemeHome(), '.dsh', 'meme-packs'));
        const settings = readMemeSettings();
        push(settings?.packsDir);
        // 插件包内置图库：从 profile 的 node_modules 找 dsh-meme（与本插件同仓安装）
        const profileDir = getProfileDir();
        if (profileDir)
            push(join(profileDir, 'node_modules', 'dsh-meme', 'memes'));
    }
    catch (err) {
        logger?.warn?.(`meme-bridge: 图库目录探测失败（忽略）: ${err instanceof Error ? err.message : String(err)}`);
    }
    return roots;
}
/**
 * 给 dsh-meme 补「QQ 发图尺寸」默认值（仅当设置文件存在且键缺失；
 * 从不覆盖用户已保存的值）。返回是否发生了写入（供日志）。
 */
export function seedMemeDefaults(logger) {
    const settings = readMemeSettings();
    if (!settings)
        return false;
    if (settings.qqSendResize !== undefined && settings.qqSendEdge !== undefined)
        return false;
    try {
        const patched = {
            ...settings,
            ...(settings.qqSendResize === undefined ? { qqSendResize: true } : {}),
            ...(settings.qqSendEdge === undefined ? { qqSendEdge: 300 } : {}),
        };
        writeFileSync(dshExpressionFile(), JSON.stringify(patched, null, 2));
        logger?.info?.('meme-bridge: 已为 dsh-meme 写入 QQ 发图尺寸默认值（qqSendResize=true, qqSendEdge=300）');
        return true;
    }
    catch (err) {
        logger?.warn?.(`meme-bridge: dsh-meme 默认值写入失败（忽略）: ${err instanceof Error ? err.message : String(err)}`);
        return false;
    }
}
//# sourceMappingURL=meme-bridge.js.map