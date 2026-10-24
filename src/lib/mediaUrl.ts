// ⭐ 2026-10-24（owner 报「图片块同步不正常」）：**渲染期按 `hash` 解析图片地址**。
//
// 病根两条（真机实测）：
//   ① 桌面插图时 `src` 存的是**本机绝对地址**（`attachment://…` / `http://attachment.localhost/C:\…`）
//      ⇒ 随页面同步到另一台机器后，那个地址在对面**不存在**；而桌面渲染只认 `src`
//      （`MediaResolver` 原来的 `blobStore` 那条是 Web 的 IndexedDB）⇒ 只能画碎图；
//   ② 附件**字节**不随页面走（网格只同步元数据行；字节按需取）⇒ 就算地址对了也没文件。
//
// 修法（渲染期解析，**不改正文** —— 改正文会让两端互相改写 `src`、同步来回打架）：
//   · 桌面：`hash → api.attachmentPath() → convertFileSrc()` 拿本机地址；
//     本地没有字节 ⇒ `ensureAttachmentBytes(hash)`（服务端/对端两条路，现成的）后再解析一次；
//   · Web：保持原样（`blobStore` → object URL）；
//   · 都失败 ⇒ 回落原来的 `src`（不改变历史行为）。
//
// 这一层只做"顺序与回落"，不碰 DOM/网络实现 —— 依赖全部注入，判据见 `mediaUrl.test.ts`。

export interface MediaUrlInput {
  hash?: string | null;
  mime?: string | null;
  src?: string | null;
}

export interface MediaUrlDeps {
  /** 桌面档（有 Rust 内核、附件在盘上）。 */
  desktop: boolean;
  /** 桌面：`hash → 本机路径`（本地没有字节时**抛/回空**）。 */
  localPathForHash: (hash: string) => Promise<string>;
  /** 桌面：本机路径 → 可显示 URL。 */
  urlForPath: (path: string) => string;
  /** 桌面：本地没字节时**按需取回**（服务端/对端），返回是否取到。 */
  fetchBytes: (hash: string) => Promise<boolean>;
  /** Web：从 blobStore 读字节（没有 ⇒ null）。 */
  readBlob: (hash: string) => Promise<ArrayBuffer | Uint8Array | null>;
  /** Web：造一个 object URL（调用方负责 revoke）。 */
  objectUrl: (bytes: ArrayBuffer | Uint8Array, mime?: string | null) => string;
  /** 取回后再解析时给 URL 加一个"非空变化"标记（同一资源不换字符串 ⇒ <img> 不会重试）。 */
  retryTag?: () => string;
}

async function tryLocalPath(hash: string, deps: MediaUrlDeps): Promise<string> {
  try {
    const path = await deps.localPathForHash(hash);
    if (!path) return "";
    return deps.urlForPath(path);
  } catch {
    return "";
  }
}

/**
 * 解析一个媒体节点的可显示 URL。返回 `""` ⇒ 调用方画占位框（⛔ 不画碎图）。
 *
 * 顺序（桌面）：本机路径 → 按需取回 → 再解析（带 retry 标记）→ 回落 `src`。
 * 顺序（Web）  ：blobStore → object URL → 回落 `src`（与原实现一致）。
 */
export async function resolveMediaUrl(input: MediaUrlInput, deps: MediaUrlDeps): Promise<string> {
  const hash = (input.hash ?? "").trim();
  const fallback = input.src ?? "";
  if (!hash) return fallback;

  if (!deps.desktop) {
    const bytes = await deps.readBlob(hash).catch(() => null);
    if (!bytes) return fallback;
    return deps.objectUrl(bytes, input.mime);
  }

  // ── 桌面：先看本机盘上有没有
  const first = await tryLocalPath(hash, deps);
  if (first) return first;

  // 本机没有 ⇒ 按需取回（服务端/对端；这一步是"图片块能不能在另一台机器上显示"的关键）
  const fetched = await deps.fetchBytes(hash).catch(() => false);
  if (!fetched) return fallback;

  const again = await tryLocalPath(hash, deps);
  if (!again) return fallback;
  // ⚠️ 取回成功时 URL 字符串可能与刚才那次失败**一模一样** ⇒ React 认为 state 没变、
  //    <img> 不会重试。加一个不参与资源定位的 fragment 让它"看起来变了"（浏览器不带 fragment 请求）。
  const tag = deps.retryTag ? deps.retryTag() : `#r${Date.now()}`;
  return `${again}${tag.startsWith("#") ? tag : `#${tag}`}`;
}
