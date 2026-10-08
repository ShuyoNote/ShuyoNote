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

/// 拼给外部 agent 看的工具清单：**读面永远在** ✓；写面在**有写权限时**才拼上去 ✓
/// （M2 · Task W2；⭐ **R152** 起口径修正：跟的是**权限** `write:pages` ✓，**不是**"要不要人确认" ✗ ——
///  「可写（每次确认）」那一档令牌里有权限 ✓，若按"免确认开关"过滤就会**把写工具误藏** ✗，
///   那一档就根本用不了 ✓；要不要确认是**落库那一刻**的事 ✓）。
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
/// ⭐ M2（施工单 Task W3）：**外部草稿的出口** —— Rust 这侧只负责「把草稿交出去」✓，
/// 谁来落库仍然只有 `src/lib/ai/apply.ts` 一处 ✓（⛔ 宿主面绝不自己建页 ✗）。
///
/// 为什么要一个**可替换的出口**（而不是直接调 Tauri 的 `emit`）：判据要能在**没有 App** 的情况下
/// 真跑一次外部调用、并**看见**草稿交出来了 ✓（`set_external_draft_sink` 在测试里换成自己的 ✓ ——
/// 这比「读源码猜有没有 emit」硬 ✗）。
type DraftSink = std::sync::Arc<dyn Fn(&str, &str) + Send + Sync>;
static DRAFT_SINK: std::sync::OnceLock<std::sync::Mutex<Option<DraftSink>>> = std::sync::OnceLock::new();

fn draft_sink_slot() -> &'static std::sync::Mutex<Option<DraftSink>> {
    DRAFT_SINK.get_or_init(|| std::sync::Mutex::new(None))
}

/// 装/换出口（App 启动时装 Tauri 的 `emit` ✓；判据里装自己的 ✓）。
pub(crate) fn set_external_draft_sink(f: impl Fn(&str, &str) + Send + Sync + 'static) {
    if let Ok(mut g) = draft_sink_slot().lock() {
        *g = Some(std::sync::Arc::new(f));
    }
}

/// 把这一批草稿交给出口 ✓（没装出口 ⇒ **出声**：宁可日志里留一句，也不静默吞掉 ✗）。
fn deliver_drafts(source: &str, auto_apply: bool, drafts: &[plugins::PluginDraft]) -> bool {
    let payload = serde_json::json!({
        "source": source,
        // ⭐ 免确认开关**开着** ⇒ 前端直接落库（不再弹确认框）；关着 ⇒ 前端摊给用户确认 ✓
        //   两条路的**落库点同一个** ✓（`applyDraftAndRefresh` ⇒ `ai/apply.ts` ✓）。
        "auto_apply": auto_apply,
        "drafts": drafts,
    });
    let text = payload.to_string();
    let sink = draft_sink_slot().lock().ok().and_then(|g| g.clone());
    match sink {
        Some(f) => {
            f(source, &text);
            true
        }
        None => {
            eprintln!("[mcp] 有一批外部草稿没人接（{} 条，来自 {source}）—— 草稿会被丢掉 ✗", drafts.len());
            false
        }
    }
}

pub(crate) fn handle_external_call(
    session_id: &str,
    granted: &[String],
    method: &str,
    args_json: &str,
) -> Result<String, String> {
    // ⭐ M2（Task W4）：免确认开关的读数**在这里读一次** ✓（生产路径）。
    //    拆出 `_with` 是为了**判据能直说**（`auto_write` 显式传 ✓）—— ⛔ 不让判据去改进程级环境变量
    //    或共享配置（Rust 测试是**并行**跑的 ⇒ 那种写法会时红时绿 ✗）。
    handle_external_call_with(session_id, granted, method, args_json, crate::mcp_channel::allow_write())
}

/// 与 [`handle_external_call`] 同一条路，但**免确认开关由调用方给** ✓（判据用 ✓）。
pub(crate) fn handle_external_call_with(
    session_id: &str,
    granted: &[String],
    method: &str,
    args_json: &str,
    auto_write: bool,
) -> Result<String, String> {
    // ① 跑这次调用，并把**它产出的草稿**收上来 ✓（外部路以前没人取 ⇒ 静默丢掉 ✗）
    let (out, drafts) = plugins::with_fresh_drafts(|| {
        plugins::with_external_caller(session_id, granted, || {
            // ⭐ 2026-10-08：**装「当前空间」** ✓ —— 缺这一步，`with_read_conn` 必然回
            //   `space_unknown: 无法确定当前空间，数据能力不可用` ✗，7 条只读工具**全都用不了** ✗。
            //   现场、真因与口径写在 `plugins::with_active_space` 的注释里 ✓（owner 让我演示时撞出来的 ✓）。
            plugins::with_active_space(|| plugins::dispatch_capability(method, args_json))
        })
    });
    if drafts.is_empty() {
        return out;
    }
    // ② 交出去 ✓；③ 回给 agent 的话**如实**（是「待确认」就不许说成「已写入」✗）
    let source = format!("external:{session_id}");
    let auto = auto_write;
    let delivered = deliver_drafts(&source, auto, &drafts);
    let summaries: Vec<String> = drafts.iter().map(|d| d.summary.clone()).collect();
    let out_json = out.unwrap_or_else(|e| format!("{{\"error\":{}}}", serde_json::Value::String(e)));
    let mut v: serde_json::Value = serde_json::from_str(&out_json).unwrap_or(serde_json::Value::Null);
    if let Some(obj) = v.as_object_mut() {
        obj.insert("drafted".into(), serde_json::Value::Bool(true));
        obj.insert("summaries".into(), serde_json::json!(summaries));
        // ⚠️ 关着免确认 ⇒ `awaiting_confirm: true`；开着 ⇒ 前端会直接落库（也不弹框 ✓）
        obj.insert("awaiting_confirm".into(), serde_json::Value::Bool(!auto));
        obj.insert("auto_apply".into(), serde_json::Value::Bool(auto));
        if !delivered {
            obj.insert("delivered".into(), serde_json::Value::Bool(false));
            obj.insert("note".into(), serde_json::Value::String(
                "草稿已生成但没人接（App 那侧没装出口）⇒ 这次改动**没有落库** ✓".to_string(),
            ));
        }
    }
    Ok(v.to_string())
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
    fn write_tools_listed_exactly_when_the_write_grant_is_there() {
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

// ═══════════════════════════════════════════════════════════════════════════════
// M2 · Task W3 的判据：**外部写请求在用户确认之前不许落库**（规格 §2 逐字口径 ✓）
//   ⇒ 真读数：隔离数据目录**逐字节不变** ✓ ＋ 草稿**真交出去了**（不是静默丢掉 ✓）
//     ＋ 回给 agent 的话如实（`awaiting_confirm` ✓）＋ 审计里有这一笔 ✓
//   变异 ①（会红）：让 `with_fresh_drafts` 把草稿丢掉（不回交）⇒ 第二条断言红 ✓
//   变异 ②（会红）：在外部调用期间往数据目录里写一个文件（模拟「偷偷落库」）⇒ 第一条断言红 ✓
//   本机跑法：`powershell -File scripts\win-cargo-test.ps1 -Filter w3_draft`（rust 组以 Linux/CI 为准 ✓）
// ═══════════════════════════════════════════════════════════════════════════════
/// ⚠️ **测试级串行锁**：外部草稿出口是**进程级唯一**的（`DRAFT_SINK` ✓）⇒
/// 两条判据并行跑时会互相把对方的出口换掉 ✗（实测：两条一起跑 ⇒ W3 那条红、单跑各自绿 ✓）。
/// ⇒ 凡是要「装出口 ＋ 断言收到什么」的测试，先拿这把锁 ✓（与 `plugins.rs` 里那把同形 ✓）。
#[cfg(test)]
static DRAFT_SINK_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod w3_draft_tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::path::Path;

    /// **库文件**的逐字节指纹（路径 → 内容 sha256 ✓）：只收
    /// ① 应用数据目录**顶层**、② `spaces/` **一层** 里的 `*.db` / `*.db-wal` / `*.db-shm` ✓。
    ///
    /// ⚠️ 为什么**不**扫整棵测试目录：那是**所有测试共用**的（本仓的测试并行跑 ✓），别的测试
    /// 新建的子目录会被误读成「这次调用落库了」⇒ **假红** ✓（本判据第一版就这么红的 ✓）。
    /// ⚠️ 为什么用 sha256 而不是 mtime：mtime 会因为「读一下」就变 ✗，判据要抓的是**内容变化** ✓。
    fn fingerprint(dir: &Path) -> BTreeMap<String, String> {
        use sha2::{Digest, Sha256};
        let mut out = BTreeMap::new();
        let mut dirs = vec![dir.to_path_buf()];
        dirs.push(dir.join("spaces"));
        for d in dirs {
            let Ok(rd) = std::fs::read_dir(&d) else { continue };
            for e in rd.flatten() {
                let p = e.path();
                let is_db = p
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.ends_with(".db") || n.ends_with(".db-wal") || n.ends_with(".db-shm"))
                    .unwrap_or(false);
                if !is_db {
                    continue;
                }
                if let Ok(bytes) = std::fs::read(&p) {
                    let mut h = Sha256::new();
                    h.update(&bytes);
                    let hex: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
                    out.insert(p.display().to_string(), hex);
                }
            }
        }
        out
    }

    #[test]
    fn external_write_is_drafted_not_landed() {
        // 出口是全局的 ⇒ 与 W4 那条串起来跑 ✓（不拿锁就会互相覆盖 ✗）
        let _serial = DRAFT_SINK_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = crate::db::ensure_test_app_data_dir().to_path_buf();
        // 装一个**测试出口**：真看见草稿才算数 ✓（比读源码猜有没有 emit 硬 ✗）
        let seen: std::sync::Arc<std::sync::Mutex<Vec<String>>> = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen2 = seen.clone();
        set_external_draft_sink(move |source, payload| {
            if let Ok(mut g) = seen2.lock() {
                g.push(format!("{source}|{payload}"));
            }
        });

        let before = fingerprint(&dir);
        let session = "sdk-w3-draft-1";
        // 权限取**注册表里写的那一条** ✓（⛔ 不在测试里手抄权限名 ✗）
        let cap = crate::capabilities_gen::lookup("pages.create").expect("pages.create 必须存在 ✓");
        let perm = cap.permission.expect("写能力必须有 permission（注册表里写着 ✓）");
        assert!(!perm.is_empty());
        let out = handle_external_call(
            session,
            &[perm.to_string()],
            "pages.create",
            r#"{"title":"周报","content":"第一段"}"#,
        )
        .expect("外部写请求本身应当成功（它产出的是草稿 ✓）");
        let after = fingerprint(&dir);

        // ① 数据目录**逐字节不变** ✓ —— 这是规格那条不变量的机械形态 ✓
        assert_eq!(before, after, "外部写请求在用户确认之前**不许落库** ✗：数据目录变了");
        // ② 草稿**交出去了** ✓（以前是塞进线程局、没人取 ⇒ 静默丢掉 ✗）
        let got = seen.lock().map(|g| g.clone()).unwrap_or_default();
        assert_eq!(got.len(), 1, "草稿必须交出去一次（拿到 {} 条）✗", got.len());
        assert!(got[0].contains("新建页面"), "出口里要带**后端生成的** summary ✓：{got:?}");
        assert!(got[0].contains("create_page"), "payload 的 kind 也要在 ✓：{got:?}");
        // ③ 回给 agent 的话**如实** ✓（是「待确认」就不许说成「已写入」✗）
        assert!(out.contains("\"drafted\":true"), "回话要带 drafted ✓：{out}");
        assert!(out.contains("\"awaiting_confirm\":true"), "默认（免确认关着）必须 awaiting_confirm ✓：{out}");
        // ④ 留痕 ✓
        let rows: Vec<_> = crate::plugins::plugin_audit(Some("external".to_string()), Some(200))
            .into_iter()
            .filter(|e| e.source == format!("external:{session}"))
            .collect();
        assert_eq!(rows.len(), 1, "写请求也要留痕 ✓（拿到 {} 条）", rows.len());
        assert!(rows[0].ok, "这次调用本身是成功的（草稿生成了 ✓）");
        assert_eq!(rows[0].capability, "pages.create");
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// M2 · Task W4 的判据：**免确认写必须留痕**（R87 逐字：「没有留痕的免确认写不算实现」✗ ✓）
//   变异（会红证据）：把 `plugins.rs` 里 `dispatch_capability` 那笔**成功**的审计推送注释掉
//   （`src-tauri/src/plugins.rs:2287` 那一行 ✓）⇒ 本测试最后那段断言必须红 ✓。
//   ⚠️ 这里**刻意不把那个入队函数的名字写全** ✗ —— `check-audit-shape` 是按**整份文件文本**
//   认「谁在写审计」的（它匹配「静态账本名」或「入队函数名」这两种字样 ✓），注释里出现就会被
//   算成**第二个写审计的文件** ⇒ 那条判据假红 ✓（2026-10-06 实测踩到两次：先是变异说明里写了，
//   接着**解释这件事的注释里又写了一遍** ✗）。根治办法是让那条判据**跳过注释与 `#[cfg(test)]` 区**
//   （`check-mcp-host-channel.mjs` 里已有 `rustRegions` 那个帮手 ✓）；本次先用措辞把它摘掉 ✓。
//   本机跑法：`powershell -File scripts\win-cargo-test.ps1 -Filter w4_audit`
// ═══════════════════════════════════════════════════════════════════════════════
#[cfg(test)]
mod w4_audit_tests {
    use super::*;

    #[test]
    fn confirm_free_write_is_marked_and_audited() {
        let _serial = DRAFT_SINK_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _dir = crate::db::ensure_test_app_data_dir();
        let seen: std::sync::Arc<std::sync::Mutex<Vec<String>>> = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen2 = seen.clone();
        set_external_draft_sink(move |source, payload| {
            if let Ok(mut g) = seen2.lock() {
                g.push(format!("{source}|{payload}"));
            }
        });

        let session = "sdk-w4-1";
        let cap = crate::capabilities_gen::lookup("pages.create").expect("pages.create 必须存在 ✓");
        let perm = cap.permission.expect("写能力必须有 permission ✓");
        let out = handle_external_call_with(
            session,
            &[perm.to_string()],
            "pages.create",
            r#"{"title":"周报","content":"第一段"}"#,
            true, // ⭐ 免确认开关**开着** ✓
        )
        .expect("免确认写本身应当成功（草稿＋落库由前端同一条路做 ✓）");

        // ① 回话如实：免确认 ⇒ 不等确认，且标明 auto_apply ✓
        assert!(out.contains("\"auto_apply\":true"), "免确认时必须标明 auto_apply ✓：{out}");
        assert!(out.contains("\"awaiting_confirm\":false"), "免确认时不该说在等确认 ✓：{out}");
        // ② 出口里也带 auto_apply:true ⇒ 前端**不弹框**、直接走同一条落库路 ✓（落库仍只有 `ai/apply.ts` 一处 ✓）
        let got = seen.lock().map(|g| g.clone()).unwrap_or_default();
        assert_eq!(got.len(), 1, "草稿要交出去一次 ✓（拿到 {} 条）", got.len());
        assert!(got[0].contains("\"auto_apply\":true"), "出口里必须带 auto_apply:true ✓：{}", got[0]);
        // ③ ⭐ **必须留痕** —— 这一条就是 R87 那句话的机械形态 ✓
        let rows: Vec<_> = crate::plugins::plugin_audit(Some("external".to_string()), Some(200))
            .into_iter()
            .filter(|e| e.source == format!("external:{session}"))
            .collect();
        assert_eq!(
            rows.len(),
            1,
            "免确认写**也必须**留一行审计 ✗（R87：没有留痕的免确认写不算实现 ✓）—— 拿到 {} 条",
            rows.len()
        );
        assert!(rows[0].ok, "这一笔本身是成功的 ✓");
        assert_eq!(rows[0].capability, "pages.create", "审计里要看得出改的是哪一类能力 ✓");
        assert_eq!(rows[0].plugin_id, "external", "外部会话不是插件 ⇒ 不许冒用插件 id ✓");
    }
}
