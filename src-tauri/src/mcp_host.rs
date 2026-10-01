//! `mcp_host.rs` —— MCP **宿主面**（M1 · Task 5；**R106 = A：进程内模块** ✓）。
//!
//! 它是什么：外部 agent 那侧（`tools/shuyonote-mcp` 的桥 ✓）与 App 的**能力层**之间的那一层 ✓。
//! 它只做三件事，一件多的都不做 ✓：
//!   ① 把「这次是谁在调」交给 `plugins::with_external_caller` ✓（会话号 ＋ 该会话被授予的权限 ✓）；
//!   ② 把整件事交给**唯一鉴权点** `plugins::dispatch_capability` ✓
//!      （权限判定／未解锁大声失败／每次调用留审计／写走草稿确认 —— 全在那边 ✓）；
//!   ③ 把结果原样回给调用方 ✓。
//!
//! ⚠️ 它**不许**自己开库、**不许**自己判权限 —— 判据 `scripts/check-mcp-host-authz.mjs` 逐条核
//! 「必须调用 `dispatch_capability`」＋「不许出现 `Connection::…`」＋「不许出现 `*_permission`」
//! （规格 `docs/specs/2026-09-28-mcp-host-spec.md` 的 `INV-MCP-single-authz` ✓）。
//! 一旦这里长出第二条鉴权路径，权限/解锁/审计/草稿确认**全部只对插件那条路成立** ✗ 而测试全绿（本仓最忌的形状 ✗）。
//!
//! ## ⚠️ 帧形状：**本形态（A）不用长度前缀帧** ✓ —— 这一条是拍板的结果，别照施工单那半做 ✗
//! 施工单 Task 5 原文写的是「长度前缀 JSON 帧，形状照 `plugin_host.rs:434/:447`」—— 那是
//! **父子进程管道**的形态（**形态 B**：App spawn 一个子进程 ✓）。**R106 拍的是形态 A：进程内模块** ✓
//! ⇒ 面对的是桥那条**回环 HTTP 通道** ✓ ⇒ `plugin_host::read_frame` / `write_frame` 在这里**用不上** ✓
//! （它们仍归 `plugin_host` 那条管道用 ✓ —— 两种帧各有其位，**别混** ✗）。
//! ⇒ 通道那一侧（**谁来调** `handle_external_call`、token/`Origin`/`Host` 在哪校验 ✓）是下一步 ✓；
//!   在那之前这个函数没有调用方 ⇒ 挂着带日期的 `#[allow(dead_code)]` 收据 ✓
//!   （`scripts/check-dead-code-receipts.mjs` 只要求"有人签过字 ＋ 有删除条件" ✓）。

use crate::plugins;

/// 一次**外部**能力调用（宿主面的唯一入口 ✓）。
///
/// * `session_id` —— 这次调用的会话号 ✓（进审计 `source` ＝ `external:<会话号>` ⇒ 答得出"是谁" ✓，R104=A ✓）
/// * `granted`    —— 这次会话**被授予**的权限清单 ✓（**判定不在这里** ✗ —— 这里只转交，判定仍只有一处 ✓）
/// * `method` / `args_json` —— 能力 id 与参数 JSON 文本 ✓（与插件那条路**逐字同形** ✓）
pub(crate) fn handle_external_call(
    session_id: &str,
    granted: &[String],
    method: &str,
    args_json: &str,
) -> Result<String, String> {
    plugins::with_external_caller(session_id, granted, || plugins::dispatch_capability(method, args_json))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 按 `source` 取**自己那条**审计 ✓ —— 会话号取唯一值、审计环是进程级共享的、测试并行跑 ⇒
    /// 不抢 `plugins.rs` 里那把测试锁、也不清环（清了会踩别人 ✓）。
    fn audit_of(source: &str) -> Vec<crate::plugins::PluginAuditEntry> {
        crate::plugins::plugin_audit(Some("external".to_string()), Some(200))
            .into_iter()
            .filter(|e| e.source == source)
            .collect()
    }

    /// 外部路**必须**经唯一鉴权点 ⇒ 未知能力被拒，且**被拒也留痕**、`source` 指得出是谁 ✓。
    #[test]
    fn unknown_capability_is_denied_and_audited_with_external_source() {
        let session = "sdk-unknown-1";
        let err = handle_external_call(session, &[], "这个能力不存在", "{}").unwrap_err();
        assert!(err.contains("unknown_capability"), "错误码必须逐字不变：{err}");
        let rows = audit_of(&format!("external:{session}"));
        assert_eq!(rows.len(), 1, "被拒的调用也必须留痕（这恰恰是最该查的那类记录 ✓）；读到 {} 条", rows.len());
        assert_eq!(rows[0].error_code.as_deref(), Some("unknown_capability"));
        assert!(!rows[0].ok);
        assert_eq!(rows[0].plugin_id, "external", "外部会话不是插件 ⇒ 别冒用插件 id ✓");
    }

    /// 权限不够时**点名缺哪个** ✓ —— 与插件那条路**同一份**消息与错误码 ✓（判定只有一处 ✓）。
    #[test]
    fn missing_permission_is_denied_by_the_same_judgement() {
        let session = "sdk-denied-1";
        // `pages.count` 需要 `read:pages`（`capabilities_gen.rs` ✓）⇒ 一个都不授予 ⇒ 必拒 ✓
        let err = handle_external_call(session, &[], "pages.count", "{}").unwrap_err();
        assert!(err.contains("permission_denied"), "错误码必须逐字不变：{err}");
        assert!(err.contains("read:pages"), "要点名「缺哪个权限」（给人看的那半 ✓）：{err}");
        let rows = audit_of(&format!("external:{session}"));
        assert_eq!(rows.len(), 1, "被拒的调用也必须留痕；读到 {} 条", rows.len());
        assert_eq!(rows[0].error_code.as_deref(), Some("permission_denied"));
    }
}
