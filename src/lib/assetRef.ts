/**
 * ⭐ 2026-10-23（owner 报「web 移动端插的图刷新就没了」）：**稳定附件引用** `asst:<hash>`。
 *
 * 病根：web 的 `save_image` 返回 `URL.createObjectURL` 造的一次性 `blob:` 地址，
 * 而正文把它原样存进页面的内容 JSON ⇒ 刷新/换设备后那条地址就是废纸
 * （字节还在 IndexedDB 的 blobStore 里，却没有任何线索能把两者对上）。
 *
 * 口径（本文件是**唯一**的拼/拆实现，别处不要各写一份）：
 * · 只对 **web** 生效：桌面 `save_image` 返回真实文件路径 ⇒ 本来就持久，不需要这一层；
 * · 引用形态固定 `asst:<contentHash>`，hash 由内容算出 ⇒ 同一张图天然去重；
 * · **解析发生在渲染时**（`platform.asset.resolveRef`），所以拿到的对象 URL 永远新鲜；
 * · 解析不到（IndexedDB 被清 / 换设备）⇒ 返回空串 ⇒ 界面画占位框（⛔ 不画碎图）。
 */

export const ASSET_REF_PREFIX = "asst:";

/** 由内容指纹拼一个稳定引用；hash 缺失 ⇒ `null`（调用方退回原路径，不编造）。 */
export function makeAssetRef(hash: string | null | undefined): string | null {
  const h = (hash ?? "").trim();
  if (!h) return null;
  return `${ASSET_REF_PREFIX}${h}`;
}

/** 是不是稳定引用（旧数据里的 `blob:` / 文件路径都不算）。 */
export function isAssetRef(src: string | null | undefined): boolean {
  return (
    typeof src === "string" &&
    src.startsWith(ASSET_REF_PREFIX) &&
    src.length > ASSET_REF_PREFIX.length
  );
}

/** 取出 hash（不是稳定引用 ⇒ 空串）。 */
export function assetRefHash(src: string | null | undefined): string {
  return isAssetRef(src) ? String(src).slice(ASSET_REF_PREFIX.length) : "";
}
