// 「可进索引的节点」——**一处定义**，索引与覆盖统计共用（2026-10-18）。
//
// 由来（真实现场）：全库索引把 `listPages()` 的**每一个节点**都拿去 `getPage`，而文件夹没有正文
// ⇒ Rust 的 `get_page` 明确拒「该节点不是页面」⇒ 那次索引报「页面 39/42；失败 11」，
// 其中 3 条是文件夹（`folder`）—— 它们**本来就不该被索引**，却被算成失败，
// 于是用户看到的是"有 11 条没成"，而真正需要处理的是附件（`provider_error`）。
//
// 口径：**只有 `folder` 被排除**（其余 kind —— `page` / `database` —— 都有可读内容：
// 数据库页的正文是行/子页标题文本，照样能被搜到 ✓）。
// ⚠️ 用"排除法"而不是"白名单"，是因为 kind 缺失（老载荷/夹具）在运行时不该被静默丢掉。

export function isIndexableNode(kind: string | null | undefined): boolean {
  return kind !== "folder";
}
