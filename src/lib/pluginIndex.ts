import type { PluginIndexEntry, PluginIndexView } from "../types";
import { sanitizeExternalUrl } from "./links";
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

/**
 * 运行档的人话。
 *
 * 界面上**不写** `logic` / `declarative` 这两个词：它们是实现词汇，而用户只关心一件事——
 * **这东西会不会自己跑代码**。所以直接回答那一句。认不出的值原样返回（新档位出现时
 * 宁可显示生词，也不要谎称它是"有代码"）。
 */
export function runtimeLabel(runtime: string): string {
  if (runtime === "declarative") return "零代码";
  if (runtime === "logic") return "有代码";
  return runtime;
}

/** 一条记录的副标题：谁发布的、多大、什么许可、跑在哪个运行时。 */
export function entryMetaLine(entry: PluginIndexEntry): string {
  const bits = [
    entry.publisher ? `发布者 ${entry.publisher}` : "",
    entry.version ? `v${entry.version}` : "",
    entry.size > 0 ? formatBytes(entry.size) : "",
    entry.license ? entry.license : "",
    entry.runtime ? runtimeLabel(entry.runtime) : "",
  ].filter(Boolean);
  return bits.join(" · ");
}

/**
 * 索引条目里"外面还有东西"的那几个地址：社区讨论 / 主页 / 更新说明。
 *
 * 为什么要做：这三个字段**规范里一直都有**（`docs/plugin-index-spec.md`：`homepage` /
 * `discussionUrl` / `changelogUrl`），但界面从来没显示过——于是"讨论串挂在插件上"这件事
 * 等于没做，用户只能自己去社区搜。这里只做一件事：把**能安全打开**的地址挑出来并给出人话标签。
 *
 * 两条口径：
 *   · 空值不显示（不显示一个点了没反应的链接）；
 *   · 非 http(s) 一律丢掉——与"打开外部链接"那条路复用同一个 `sanitizeExternalUrl`，
 *     安全判定只有一处，别在界面里另写一遍。
 */
export function pluginLinks(
  entry: PluginIndexEntry,
): { kind: "discussion" | "homepage" | "changelog"; label: string; url: string; host: string }[] {
  const candidates: { kind: "discussion" | "homepage" | "changelog"; label: string; raw: string }[] = [
    { kind: "discussion", label: "社区讨论", raw: entry.discussionUrl },
    { kind: "homepage", label: "主页", raw: entry.homepage },
  ];
  const out: { kind: "discussion" | "homepage" | "changelog"; label: string; url: string; host: string }[] = [];
  for (const c of candidates) {
    const url = sanitizeExternalUrl((c.raw ?? "").trim());
    if (!url) continue;
    out.push({ kind: c.kind, label: c.label, url, host: indexHost(url) });
  }
  return out;
}

/**
 * 发布者签名状态。
 *
 * 三种情况必须说成三句话，因为它们给用户的安全含义完全不同：
 *   · 没带签名 → 只有 sha256（保证"下载到的东西没坏"，不保证"是谁发布的"）；
 *   · 带了、且与本地固定的一致 → 这个包确实是你信任的那把 key 签的；
 *   · 带了、但和本地固定的**不是同一把** → 最该被看见的那一种：可能换了密钥，也可能索引被动过。
 *
 * `pinned` 是本地已固定的那个插件的指纹（没有对应已装插件时传 null）。
 */
export function entrySignatureNote(
  entry: PluginIndexEntry,
  pinned?: { fingerprint: string } | null,
  incomingFingerprint?: string | null,
): { text: string; level: "ok" | "warn" | "none" } {
  if (!entry.publisherSigned) {
    return {
      text: "无发布者签名（只有 sha256：能证明下载到的包没坏，不能证明是谁发布的）",
      level: "none",
    };
  }
  if (pinned && incomingFingerprint && pinned.fingerprint !== incomingFingerprint) {
    return {
      text: `发布者公钥变了：已固定 ${pinned.fingerprint}，这份索引里是 ${incomingFingerprint}`,
      level: "warn",
    };
  }
  if (pinned) {
    return { text: `发布者签名：与已固定的公钥一致（${pinned.fingerprint}）`, level: "ok" };
  }
  return {
    text: incomingFingerprint
      ? `发布者公钥 ${incomingFingerprint}（首次安装会固定下来，之后换 key 就拒绝安装）`
      : "带发布者签名（装成功后会固定这把公钥）",
    level: "ok",
  };
}

/** 这次安装会不会**换掉**一把已固定的发布者公钥（换 key 需要用户明确同意）。 */
export function publisherKeyChanged(
  entry: PluginIndexEntry,
  pinned?: { fingerprint: string } | null,
  incomingFingerprint?: string | null,
): boolean {
  return !!(
    entry.publisherSigned &&
    pinned &&
    incomingFingerprint &&
    pinned.fingerprint !== incomingFingerprint
  );
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

export type EntryAction =
  | "install"
  | "upgrade"
  | "reinstall"
  | "blocked"
  | "newer-installed"
  /** 发布者公钥变了：按钮改成"信任新密钥并安装"，确认框里要把两个指纹都摆出来。 */
  | "key-changed";

/**
 * 这一条现在该做什么：新装 / 升级 / 重装 / 装不了。
 *
 * 已装的版本更新时**不让点**（后端也会拒）：装一个更旧的版本几乎总是误操作，
 * 而代价是功能悄悄退回去——事后极难发现。要降级就得先卸载，那是个明确的动作。
 */
export function entryAction(
  entry: PluginIndexEntry,
  installedVersion?: string | null,
  keyChanged = false,
): { action: EntryAction; label: string; reason: string } {
  const gate = entryInstallable(entry);
  if (!gate.ok) return { action: "blocked", label: "安装", reason: gate.reason };
  if (keyChanged) {
    return {
      action: "key-changed",
      label: "信任新密钥并安装",
      reason: "发布者公钥与已固定的那把不一样：确认无误后再信任新的",
    };
  }
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
  publisher?: { pinned?: string | null; incoming?: string | null } | null,
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
  // 换发布者公钥是这一屏里最重的一件事：两个指纹都要摆出来，并说清"这意味着什么"。
  const keyNote =
    publisher?.pinned && publisher.incoming && publisher.pinned !== publisher.incoming
      ? [
          "",
          "⚠ 发布者公钥变了（这是替换信任对象的动作）：",
          `· 你原来固定的：${publisher.pinned}`,
          `· 这份索引里的：${publisher.incoming}`,
          "可能是发布者换了密钥，也可能是这份索引被人动过。确认过发布者的公告之后再继续。",
        ]
      : publisher?.incoming && !publisher.pinned
        ? ["", `发布者公钥（首次安装会固定下来）：${publisher.incoming}`]
        : [];
  return [
    `来源：${sourceLabel}`,
    head,
    ...keyNote,
    `插件：${entry.name || entry.id} v${entry.version}（发布者 ${entry.publisher || "未署名"}）`,
    "它要访问：",
    perms,
    ...growth,
    "",
    ...(() => {
      // 装之前把"这个插件在社区的讨论"摆出来：它是用户在按下确认之前最该看的第二样东西
      //（第一样是权限）。索引条目里本来就有这个字段，不显示等于白给。
      const discussion = pluginLinks(entry).find((l) => l.kind === "discussion");
      return discussion ? ["", `社区讨论：${discussion.url}`] : [];
    })(),
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

/**
 * 已装插件的**发布者密钥被撤回**时的界面文案。
 *
 * 与"版本被撤回"分开说：撤回一个版本说的是"这一个版本别用了"，
 * 撤回一把密钥说的是"它签的东西都不作数了"——后者更重，文案不能混。
 */
export function revokedKeyNotice(
  revoked: { fingerprint: string; reason: string; ignored: boolean } | null | undefined,
): { text: string; blocked: boolean } {
  if (!revoked) return { text: "", blocked: false };
  const why = revoked.reason.trim() || "索引没有写原因";
  if (revoked.ignored) {
    return {
      text: `发布者密钥 ${revoked.fingerprint} 已被索引撤回，你选择继续使用（原因：${why}）`,
      blocked: false,
    };
  }
  return {
    text: `签名它的发布者密钥已被索引撤回，运行已被拦下：${why}（指纹 ${revoked.fingerprint}）`,
    blocked: true,
  };
}

/** 索引撤回了哪些发布者密钥（界面要显示"撤回了谁"，不只是"某个东西被撤了"）。 */
export function revokedKeysSummary(
  keys: { fingerprint: string; reason: string; revokedAt?: string | null }[],
): string {
  if (keys.length === 0) return "";
  const head = `这份索引撤回了 ${keys.length} 把发布者密钥：`;
  const lines = keys.map((k) => {
    const why = k.reason.trim() || "没写原因";
    const at = k.revokedAt ? `（${k.revokedAt}）` : "";
    return `· ${k.fingerprint} —— ${why}${at}`;
  });
  return [head, ...lines].join("\n");
}

/**
 * 一条订阅的当前状态说人话。
 *
 * 三种状态必须分开说（用户要能一眼看出"这条索引还活着吗、它说的东西我能用吗"）：
 * 从没查过 / 上次成功（顺带说清有几条可更新）/ 上次失败（把后端原话带上）。
 * 失败时**不显示可更新数**：那是上一次成功时的旧数字，混在一起会让人以为"刚查过"。
 */
export function subscriptionStatus(sub: {
  last_ok?: boolean | null;
  last_error?: string;
  updates_available?: number;
  plugin_count?: number;
}): { text: string; level: "none" | "ok" | "warn" } {
  if (sub.last_ok === true) {
    const updates = sub.updates_available ?? 0;
    const total = sub.plugin_count ?? 0;
    return {
      text:
        updates > 0
          ? `${total} 个插件，其中 ${updates} 个可更新`
          : `${total} 个插件，没有可更新的`,
      level: "ok",
    };
  }
  if (sub.last_ok === false) {
    return { text: `上次检查失败：${sub.last_error?.trim() || "没有说明"}`, level: "warn" };
  }
  return { text: "还没检查过", level: "none" };
}

/** 订阅行的标题：备注优先，其次域名。 */
export function subscriptionTitle(sub: { label?: string; url: string }): string {
  return sub.label?.trim() || indexHost(sub.url) || sub.url;
}

/** 安装来源说人话（`plugin_install.source` 的取值）。 */
export function sourceLabel(source: string): string {
  if (!source) return "未记录";
  if (source === "local") return "本地文件夹";
  if (source === "zip") return "zip 包";
  if (source === "bundled") return "随应用附带";
  if (source.startsWith("index:")) {
    const host = source.slice("index:".length);
    return host ? `索引（${host}）` : "索引";
  }
  return source;
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
