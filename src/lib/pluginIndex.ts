import type { PluginIndexEntry, PluginIndexView } from "../types";
import { formatBytes } from "./pluginAudit";

/**
 * 索引界面的**展示口径**（M11.11a）。
 *
 * 抽成纯函数是为了可测：这里的每一句文案都在向用户交代"这个东西是谁给的、验没验过"，
 * 写错了不会报错——只会让人以为验过了。所以宁可啰嗦，也要让每句话都能被断言。
 *
 * 三条底线：
 *   · 从 URL 里取出**域名**显示，别只显示"某索引"——用户要知道自己订阅了谁；
 *   · 签名状态分三种（验过 / 没验 / 没签名），**不许含糊成"安全"**；
 *   · 发布者签名阶段 1 **不校验**，文案必须写"未校验"，不能写成"已签名"就完事。
 */

/** 从 URL 取域名（后端也会取一次用于来源标识，这里只用于显示）。 */
export function indexHost(url: string): string {
  const after = url.split("://")[1] ?? url;
  return after.split(/[/?#]/)[0] ?? "";
}

/** 索引来源的一句话：谁的索引、在哪个域名。 */
export function indexSourceLabel(view: PluginIndexView, url: string): string {
  const host = indexHost(url);
  const owner = view.owner?.name?.trim() || view.owner?.id?.trim() || "";
  if (owner && host) return `${owner}（${host}）`;
  return owner || host || "未知来源";
}

/**
 * 签名状态文案 + 语气。
 *
 * `level` 给界面用：`ok` 绿、`warn` 黄。**没有签名也是 warn**——因为"没验过"和
 * "验过了"在用户眼里必须一眼能分辨。
 */
export function indexSignatureLabel(view: PluginIndexView): { text: string; level: "ok" | "warn" } {
  if (view.signatureVerified === true) {
    return { text: "索引签名：已用你填的公钥校验通过", level: "ok" };
  }
  return {
    text: "索引签名：没有校验（没填公钥）——sha256 只保证下载到的包没坏，挡不住「换一份索引」",
    level: "warn",
  };
}

/** 一条记录的副标题：谁发布的、多大、什么许可、跑在哪个运行时。 */
export function entryMetaLine(entry: PluginIndexEntry): string {
  const bits = [
    entry.publisher ? `发布者 ${entry.publisher}` : "",
    entry.version ? `v${entry.version}` : "",
    entry.size > 0 ? formatBytes(entry.size) : "",
    entry.license ? entry.license : "",
    entry.runtime ? `运行时 ${entry.runtime}` : "",
  ].filter(Boolean);
  return bits.join(" · ");
}

/** 发布者签名状态。**阶段 1 不校验**，所以这句话必须自己说清楚。 */
export function entrySignatureNote(entry: PluginIndexEntry): string {
  return entry.publisherSigned
    ? "带发布者签名（本版本不校验：那要等阶段 2 的发布者公钥）"
    : "无发布者签名";
}

/** 这条记录能不能点「安装」；不能时给出给人看的理由。 */
export function entryInstallable(entry: PluginIndexEntry): { ok: boolean; reason: string } {
  if (entry.blocked) return { ok: false, reason: entry.blocked };
  return { ok: true, reason: "" };
}

/**
 * 安装确认框的正文：来源、权限逐条理由、以及"未审查"这句大实话。
 *
 * 确认框是**用户唯一一次真正读权限的机会**，所以权限和理由都在这里摊开。
 */
export function installConfirmMessage(
  entry: PluginIndexEntry,
  sourceLabel: string,
  pubkeyGiven: boolean,
): string {
  const perms = entry.permissions.length
    ? entry.permissions.map((p) => `· ${p.id} —— ${p.reason || "（作者没写理由）"}`).join("\n")
    : "· （不申请任何数据权限）";
  return [
    `来源：${sourceLabel}`,
    `插件：${entry.name || entry.id} v${entry.version}（发布者 ${entry.publisher || "未署名"}）`,
    "它要访问：",
    perms,
    "",
    "索引**没有人工审查**：能装不等于可信。装完默认未启用，你可以先看权限再决定。",
    pubkeyGiven
      ? "索引签名已用你填的公钥校验通过；插件包已按索引里的 sha256 校验完整。"
      : "这份索引**没有校验签名**（你没填公钥）：包按 sha256 校验过完整，但索引本身可能被人换过。",
  ].join("\n");
}

/** 上一次填过的索引地址 / 公钥（只是省得每次重打，不是"信任配置"）。 */
export const INDEX_URL_KEY = "shuyonote.pluginIndexUrl";
export const INDEX_PUBKEY_KEY = "shuyonote.pluginIndexPubkey";

export function loadIndexDraft(storage: Pick<Storage, "getItem">): {
  url: string;
  pubkey: string;
} {
  try {
    return {
      url: storage.getItem(INDEX_URL_KEY) ?? "",
      pubkey: storage.getItem(INDEX_PUBKEY_KEY) ?? "",
    };
  } catch {
    // 隐私模式下 localStorage 会抛，界面不该因此打不开。
    return { url: "", pubkey: "" };
  }
}

export function saveIndexDraft(
  storage: Pick<Storage, "setItem">,
  url: string,
  pubkey: string,
): void {
  try {
    storage.setItem(INDEX_URL_KEY, url);
    storage.setItem(INDEX_PUBKEY_KEY, pubkey);
  } catch {
    // 同上：存不上就算了，不影响这次安装。
  }
}
