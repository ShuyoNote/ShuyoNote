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

/** 粗粒度版本比较（与后端同一口径：`x.y.z` 逐段比，比不出来返回 null）。 */
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string) => {
    const core = v.split(/[-+]/)[0] ?? "";
    const parts = core.split(".");
    if (parts.length !== 3) return null;
    const nums = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
    return nums.some((n) => Number.isNaN(n)) ? null : nums;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

export type EntryAction = "install" | "upgrade" | "reinstall" | "blocked" | "newer-installed";

/**
 * 这一条现在该做什么：新装 / 升级 / 重装 / 装不了。
 *
 * 已装的版本更新时**不让点**（后端也会拒）：装一个更旧的版本几乎总是误操作，
 * 而代价是功能悄悄退回去——事后极难发现。要降级就得先卸载，那是个明确的动作。
 */
export function entryAction(
  entry: PluginIndexEntry,
  installedVersion?: string | null,
): { action: EntryAction; label: string; reason: string } {
  const gate = entryInstallable(entry);
  if (!gate.ok) return { action: "blocked", label: "安装", reason: gate.reason };
  if (!installedVersion) return { action: "install", label: "安装", reason: "" };
  const cmp = compareVersions(installedVersion, entry.version);
  if (cmp === 0) return { action: "reinstall", label: `重装 v${entry.version}`, reason: "" };
  if (cmp !== null && cmp > 0) {
    return {
      action: "newer-installed",
      label: "安装",
      reason: `已装更新的版本 v${installedVersion}（要降级请先卸载）`,
    };
  }
  return { action: "upgrade", label: `升级到 v${entry.version}`, reason: "" };
}

/** 这次安装/升级**新增**的权限（升级时最该让用户看到的东西）。 */
export function addedPermissions(
  entry: PluginIndexEntry,
  installed?: { permissions?: { id: string }[] } | null,
): { id: string; reason: string }[] {
  if (!installed) return [];
  const had = new Set((installed.permissions ?? []).map((p) => p.id));
  return entry.permissions.filter((p) => !had.has(p.id));
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
  installedVersion?: string | null,
  added: { id: string; reason: string }[] = [],
): string {
  const perms = entry.permissions.length
    ? entry.permissions.map((p) => `· ${p.id} —— ${p.reason || "（作者没写理由）"}`).join("\n")
    : "· （不申请任何数据权限）";
  // 升级时把"新增了哪几项权限"单独摊出来：这是用户在这一刻最该读的一行。
  const growth = added.length
    ? [
        "",
        `这次升级新增了 ${added.length} 项权限（旧的已装版本没有）：`,
        ...added.map((p) => `· ${p.id} —— ${p.reason || "（作者没写理由）"}`),
        "宿主会先暂停它，你确认之后才会恢复运行。",
      ]
    : [];
  const head = installedVersion
    ? installedVersion === entry.version
      ? `这是「重装」：已装的 v${installedVersion} 会被这一份同版本覆盖（用它可以修好被改坏的插件目录）。`
      : `这是「升级」：已装的 v${installedVersion} 会被替换成 v${entry.version}（替换前会自动备份，装不上就回滚）。`
    : "";
  return [
    `来源：${sourceLabel}`,
    head,
    `插件：${entry.name || entry.id} v${entry.version}（发布者 ${entry.publisher || "未署名"}）`,
    "它要访问：",
    perms,
    ...growth,
    "",
    "索引**没有人工审查**：能装不等于可信。装完默认未启用，你可以先看权限再决定。",
    pubkeyGiven
      ? "索引签名已用你填的公钥校验通过；插件包已按索引里的 sha256 校验完整。"
      : "这份索引**没有校验签名**（你没填公钥）：包按 sha256 校验过完整，但索引本身可能被人换过。",
  ].join("\n");
}

/**
 * 已装插件被撤回时的界面文案。
 *
 * 三种状态必须说成三句不同的话，否则用户分不清"它被撤回了、跑不了"和"它还好好的"：
 *   · 撤回 + 没忽略 → 已经拦住运行，给出他唯一的两个出口（仍然使用 / 卸载）；
 *   · 撤回 + 已忽略 → 说明这是他自己选的，别让界面显得像在指责他；
 *   · 没有 → 空字符串（界面不显示任何东西）。
 */
export function revocationNotice(
  revoked: { version: string; reason: string; ignored: boolean } | null | undefined,
): { text: string; blocked: boolean } {
  if (!revoked) return { text: "", blocked: false };
  const why = revoked.reason.trim() || "索引没有写原因";
  if (revoked.ignored) {
    return {
      text: `索引撤回的 v${revoked.version} 你选择继续使用（原因：${why}）`,
      blocked: false,
    };
  }
  return {
    text: `已被索引撤回，运行已被拦下：${why}（撤回的是 v${revoked.version}）`,
    blocked: true,
  };
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
