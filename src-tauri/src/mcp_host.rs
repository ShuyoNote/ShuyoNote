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

/// **只读工具清单**（M1 的 8 条 ✓）—— 直接**内嵌生成物** ✓。
///
/// ⚠️ 为什么不在这里手写一份（或从注册表现算一份）：`capabilities/mcp-tools.json` 是
/// `scripts/gen-capabilities.mjs` 的**第 10 件生成物** ✓，JS 侧（桥/判据）与这里**必须**是同一份
/// ⇒ `include_str!` 是编译期内嵌（打包后的 App 也带着它 ✓，不依赖运行时文件 ✓）。
/// ⛔ 一旦在这里另抄一份，就会出现"注册表改了、宿主面还回老清单"这种**两份真相源** ✗
/// （判据：`scripts/check-agent-surface.mjs` 负责"面与注册表一致" ✓；这里只负责**原样**吐出来 ✓）。
pub(crate) const MCP_TOOLS_JSON: &str = include_str!("../../capabilities/mcp-tools.json");
/// M2 的**写面**清单（第 11 件生成物 ✓）—— 与读面同一纪律：**编译期内嵌** ✓，
/// ⛔ 不在 Rust 里手抄一份工具名（那正是 `INV-MCP-tools-generated` 要挡的 ✗）。
pub(crate) const MCP_TOOLS_WRITE_JSON: &str = include_str!("../../capabilities/mcp-tools-write.json");

/// 拼给外部 agent 看的工具清单：**读面永远在** ✓；写面**只在免确认开关开着时**才拼上去 ✓（M2 · Task W2）。
///
/// 为什么关着时**不列**（而不是「列了但一调就拒」）✗：M1 真端到端踩过一次
/// （`coverage.report` 列在面上却调不通 ✓）—— 面里出现用不了的东西，agent 会照它去调、然后撞墙 ✓。
/// ⇒ 这里的口径是**面 = 此刻真能调的能力** ✓。
pub fn tools_list_json(include_write: bool) -> String {
    let read: serde_json::Value = serde_json::from_str(MCP_TOOLS_JSON).unwrap_or(serde_json::Value::Array(Vec::new()));
    if !include_write {
        return serde_json::to_string(&read).unwrap_or_else(|_| "[]".to_string());
    }
    let write: serde_json::Value = serde_json::from_str(MCP_TOOLS_WRITE_JSON).unwrap_or(serde_json::Value::Array(Vec::new()));
    let mut all = read.as_array().cloned().unwrap_or_default();
    all.extend(write.as_array().cloned().unwrap_or_default());
    serde_json::to_string(&serde_json::Value::Array(all)).unwrap_or_else(|_| "[]".to_string())
}

/// ⚠️ 这个「原样吐读面清单」的旧函数已在 2026-10-06（M2 · Task W2）被上面那个
/// `tools_list_json(include_write)` **取代** ✓ —— 不并存两份（否则"写面到底列不列"会有两个答案 ✗）。

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

// ═════════════════════════════════════════════════════════════════════════════━━
// M2 · Task W2 的判据：**写面只在免确认开关开着时才出现在工具清单里** ✓
//   变异（会红证据）：把 `tools_list_json` 里的 `if !include_write` 那一段去掉（＝永远带写面）
//   ⇒ 本测试第一条断言必须红 ✓。
//   本机跑法：`powershell -File scripts\win-cargo-test.ps1 -Filter mcp_host`（本机 rust 组以 Linux/CI 为准 ✓）
// ═════════════════════════════════════════════════════════════════════════════━━
#[cfg(test)]
mod tools_list_tests {
    use super::*;

    fn names(json: &str) -> Vec<String> {
        let v: serde_json::Value = serde_json::from_str(json).expect("工具清单必须是合法 JSON ✓");
        v.as_array()
            .expect("工具清单是**裸数组**（生成物的形态 ✓）")
            .iter()
            .map(|t| t["name"].as_str().unwrap_or_default().to_string())
            .collect()
    }

    #[test]
    fn write_tools_only_listed_when_allowed() {
        let off = names(&tools_list_json(false));
        let on = names(&tools_list_json(true));
        // ① 开关**关着**时：⛔ 一个写工具都不许出现（不是「列了但一调就拒」✗）
        for n in ["pages_create", "blocks_append"] {
            assert!(
                !off.iter().any(|x| x == n),
                "开关关着时清单里出现了写工具 {n} ✗ —— 「面 = 此刻真能调的能力」（M1 在 coverage.report 上踩过 ✓）: {off:?}"
            );
        }
        // ② 读面永远是那 7 条 ✓（写面开关不影响读面 ✓）
        assert!(off.len() >= 7, "读面至少 7 条 ✓（实际 {}）", off.len());
        assert!(!off.iter().any(|x| x == "coverage_report"), "host=frontend 的那条**不在**面上 ✓（M1 修过 ✓）");
        // ③ 开关**开着**时：两个写工具都在 ✓，且正好多出写面那 2 条 ✓
        for n in ["pages_create", "blocks_append"] {
            assert!(on.iter().any(|x| x == n), "开着时清单里必须有写工具 {n} ✓: {on:?}");
        }
        assert_eq!(on.len(), off.len() + 2, "开着 ＝ 关着 ＋ 写面 2 条 ✓（实际 {off:?} / {on:?}）");
    }
}
