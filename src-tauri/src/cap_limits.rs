//! ⭐ P2（2026-10-30）：能力层的**限额常量唯一出处**。
//!
//! 背景：200 KB 响应体、分页默认/上限、句柄 TTL 原先散落在各 cap 里（各写各的 ⇒ 改一处漂一片）。
//! ⛔ 新加 cap 必须引用这里，不要再写字面量。

/// 单次响应体上限（矩阵 §7：文本返回 ≤ 200 KB/次）。
pub(crate) const BODY_CAP_BYTES: usize = 200 * 1024;

/// 分页：列表类默认/上限（files.* / versions.* / trash.* / pages.list 等）。
pub(crate) const LIST_DEFAULT: i64 = 50;
pub(crate) const LIST_MAX: i64 = 200;

/// 分页：页级/块级检索（pages.search / files.search）。
pub(crate) const SEARCH_DEFAULT: i64 = 10;
pub(crate) const SEARCH_MAX: i64 = 100;

/// pages.list 的默认/上限（与 LIST_* 同值，但语义独立：页面列表不跟附件列表一起改）。
pub(crate) const PAGE_DEFAULT: i64 = 50;
pub(crate) const PAGE_MAX: i64 = 200;

/// db.rows 的默认/上限。
pub(crate) const DB_ROWS_DEFAULT: i64 = 100;
pub(crate) const DB_ROWS_MAX: i64 = 200;

/// blocks.list 上限。
pub(crate) const BLOCKS_MAX: i64 = 500;

/// 导出/下载句柄 TTL（秒）。mcp_blobs 用它换算毫秒。
pub(crate) const HANDLE_TTL_SECS: i64 = 120;

#[cfg(test)]
mod tests {
    use super::*;

    /// ⭐ 判据：能力层必须真的**引用**这些常量（防再各写各的）。
    #[test]
    fn capability_layer_uses_the_shared_limits() {
        let src = include_str!("plugins.rs");
        for needle in [
            "cap_limits::BODY_CAP_BYTES",
            "cap_limits::PAGE_MAX",
            "cap_limits::SEARCH_MAX",
            "cap_limits::LIST_MAX",
            "cap_limits::DB_ROWS_MAX",
            "cap_limits::BLOCKS_MAX",
        ] {
            assert!(src.contains(needle), "能力层没有引用常量：{needle}");
        }
        let blobs = include_str!("mcp_blobs.rs");
        assert!(
            blobs.contains("cap_limits::HANDLE_TTL_SECS"),
            "句柄 TTL 必须来自常量模块"
        );
        assert_eq!(BODY_CAP_BYTES, 200 * 1024);
        assert_eq!(HANDLE_TTL_SECS, 120);
        assert!(LIST_DEFAULT <= LIST_MAX);
        assert!(SEARCH_DEFAULT <= SEARCH_MAX);
    }
}
