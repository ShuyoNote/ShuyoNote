//! `mcp_host.rs` —— MCP **宿主面**（M1 · Task 5；**R106 = A：进程内模块** ✓）。
//!
//! 它是什么：外部 agent 那侧（`tools/shuyonote-mcp` 的桥 ✓）与 App 的**能力层**之间的那一层 ✓。
//! 它只做三件事，一件多的都不做 ✓：
//!   ① 把「这次是谁在调」交给 `plugins::with_external_caller` ✓（会话号 ＋ 该会话被授予的权限 ✓）；
//!   ② 把整件事交给**唯一鉴权点** `plugins::dispatch_capability` ✓
//!      （权限判定／未解锁大声失败／每次调用留审计／写走草稿确认 —— 全在那边 ✓）；
//!   ③ 把结果回给调用方 ✓（⚠️ 唯一的改写：`pages.search` 外面包一层**范围信封** ——
//!      `[]` 必须说得出"是哪个空间没有"，见 [`with_search_scope`]）。
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
pub(crate) const MCP_TOOLS_WRITE_JSON: &str =
    include_str!("../../capabilities/mcp-tools-write.json");

/// 拼给外部 agent 看的工具清单：**读面永远在** ✓；写面在**有写权限时**才拼上去 ✓
/// （M2 · Task W2；⭐ **R152** 起口径修正：跟的是**权限** `write:pages` ✓，**不是**"要不要人确认" ✗ ——
///  「可写（每次确认）」那一档令牌里有权限 ✓，若按"免确认开关"过滤就会**把写工具误藏** ✗，
///   那一档就根本用不了 ✓；要不要确认是**落库那一刻**的事 ✓）。
///
/// 为什么关着时**不列**（而不是「列了但一调就拒」）✗：M1 真端到端踩过一次
/// （`coverage.report` 列在面上却调不通 ✓）—— 面里出现用不了的东西，agent 会照它去调、然后撞墙 ✓。
/// ⇒ 这里的口径是**面 = 此刻真能调的能力** ✓。
pub fn tools_list_json(include_write: bool) -> String {
    let read: serde_json::Value =
        serde_json::from_str(MCP_TOOLS_JSON).unwrap_or(serde_json::Value::Array(Vec::new()));
    if !include_write {
        return serde_json::to_string(&read).unwrap_or_else(|_| "[]".to_string());
    }
    let write: serde_json::Value =
        serde_json::from_str(MCP_TOOLS_WRITE_JSON).unwrap_or(serde_json::Value::Array(Vec::new()));
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
static DRAFT_SINK: std::sync::OnceLock<std::sync::Mutex<Option<DraftSink>>> =
    std::sync::OnceLock::new();

fn draft_sink_slot() -> &'static std::sync::Mutex<Option<DraftSink>> {
    DRAFT_SINK.get_or_init(|| std::sync::Mutex::new(None))
}

/// 装/换出口（App 启动时装 Tauri 的 `emit` ✓；判据里装自己的 ✓）。
pub(crate) fn set_external_draft_sink(f: impl Fn(&str, &str) + Send + Sync + 'static) {
    if let Ok(mut g) = draft_sink_slot().lock() {
        *g = Some(std::sync::Arc::new(f));
    }
}

/// 这次调用**必须**留给人点确认吗（即使「免确认」档开着）。
///
/// 为什么单独一条（2026-10-18）：`pages.update` 是**整页替换** —— 一次调用把整页正文换成别的，
/// 而这条路上**没有 undo、没有 dry-run、没有"改前快照"回传**（审计也只记能力名、不记参数）。
/// 加法式写（新建页 / 追加块 / 导入 Markdown）可以由用户显式开免确认；
/// **覆盖式的不行** —— 对一份"默认推荐"级别的知识库来说，一次误会就是一次数据丢失。
fn needs_confirmation(method: &str) -> bool {
    matches!(method, "pages.update")
}

/// 把这一批草稿交给出口 ✓（没装出口 ⇒ **出声**：宁可日志里留一句，也不静默吞掉 ✗）。
fn deliver_drafts(source: &str, auto_apply: bool, drafts: &[plugins::PluginDraft]) -> bool {
    let payload = serde_json::json!({
        "source": source,
        // ⭐ 免确认开关**开着** ⇒ 前端直接落库（不再弹确认框）；关着 ⇒ 前端摊给用户确认 ✓
        //   ⚠️ 但**覆盖式写**（`pages.update`）永远走"确认"那一路（见 [`needs_confirmation`]）✓
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
            eprintln!(
                "[mcp] 有一批外部草稿没人接（{} 条，来自 {source}）—— 草稿会被丢掉 ✗",
                drafts.len()
            );
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
    handle_external_call_with(
        session_id,
        granted,
        method,
        args_json,
        crate::mcp_channel::allow_write(),
    )
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
            plugins::with_active_space(|| {
                // ⭐ 2026-10-17：检索结果**自带范围**（`with_search_scope`）✓。
                //   放在这个闭包里做，是因为范围快照读的**必须**是这次调用用的那个空间 ✓
                //   （出了闭包 `read_space` 就恢复了 ⇒ 再读会得到 `space_unknown` ✗）。
                with_search_scope(
                    method,
                    args_json,
                    plugins::dispatch_capability(method, args_json),
                )
            })
        })
    });
    if drafts.is_empty() {
        return out;
    }
    // ② 交出去 ✓；③ 回给 agent 的话**如实**（是「待确认」就不许说成「已写入」✗）
    let source = format!("external:{session_id}");
    // ⭐ 2026-10-18：**覆盖式写永远要人确认**（见 [`needs_confirmation`]）——
    //   「免确认」档只对**加法式**写生效 ✓。
    let auto = auto_write && !needs_confirmation(method);
    let delivered = deliver_drafts(&source, auto, &drafts);
    let summaries: Vec<String> = drafts.iter().map(|d| d.summary.clone()).collect();
    let out_json =
        out.unwrap_or_else(|e| format!("{{\"error\":{}}}", serde_json::Value::String(e)));
    let mut v: serde_json::Value =
        serde_json::from_str(&out_json).unwrap_or(serde_json::Value::Null);
    if let Some(obj) = v.as_object_mut() {
        obj.insert("drafted".into(), serde_json::Value::Bool(true));
        obj.insert("summaries".into(), serde_json::json!(summaries));
        // ⚠️ 关着免确认 ⇒ `awaiting_confirm: true`；开着 ⇒ 前端会直接落库（也不弹框 ✓）
        obj.insert("awaiting_confirm".into(), serde_json::Value::Bool(!auto));
        obj.insert("auto_apply".into(), serde_json::Value::Bool(auto));
        if !delivered {
            obj.insert("delivered".into(), serde_json::Value::Bool(false));
            obj.insert(
                "note".into(),
                serde_json::Value::String(
                    "草稿已生成但没人接（App 那侧没装出口）⇒ 这次改动**没有落库** ✓".to_string(),
                ),
            );
        }
    }
    Ok(v.to_string())
}

/// 外部面的**检索信封**（2026-10-17）：`pages.search` 的结果要**自带范围**。
///
/// 为什么必须有这一层（现场）：外部 agent 实测「四次搜索全空」之后，对着 `[]` 只能得出
/// 「这个库是空的」——而它其实**不知道**自己搜的是哪个空间（当时活动空间是一块只有 0–2 页的
/// 新空间，知识库主体在另一个 42 页的空间里）。空数组把「这个空间没有」与「搜错空间了」
/// 压成同一个答案 ⇒ 调用方只能猜，而猜错的代价是"这个产品不能当知识库用"。
///
/// 三条口径：
///   1. **只在外部面加**：插件面拿到的仍是裸数组（`api.pages.search(...) || []` 是既有写法 ✓，
///      `capabilities.json` 的 `returns.type` 也还是 array ✓）——信封是**协议面**的呈现，
///      不是第二套检索语义（结果仍由同一个 `cap_pages_search` 产出 ✓）。
///   2. **失败不伪装成空**：`dispatch_capability` 的 Err 原样上抛（错就是错，不许变成 `matched:0` ✗）。
///   3. **范围取不到也不许装**：`scope` 给 null ＋ `scopeError` 说明原因，而不是编一个 0 页 ✓。
fn with_search_scope(
    method: &str,
    args_json: &str,
    out: Result<String, String>,
) -> Result<String, String> {
    if method != "pages.search" {
        return out;
    }
    // 先看这次到底是不是「命中数组」：失败与空都不必去读范围 ✓（只有检索才付这次查询 ✓）
    let items = match out.as_ref() {
        Ok(json) => search_items(json),
        Err(_) => None,
    };
    match items {
        Some(items) => {
            let target = target_space_id(args_json);
            let mut hints: Vec<String> = Vec::new();
            // 没指定空间时，才提"可以带 spaceId 直接搜别的空间"（否则等于劝它改条件 ✓）
            if target.is_none() {
                hints.push(
                    "若目标在别的空间、且已获「只读（全部空间）」授权，可直接用 spaceId 参数搜那个空间\
                     （不会改变你界面上的活动空间）。"
                        .to_string(),
                );
            }
            if let Some(h) = long_cjk_retry_hint(args_json) {
                hints.push(h);
            }
            let hint = if hints.is_empty() {
                None
            } else {
                Some(hints.join("\n"))
            };
            Ok(search_envelope(
                items,
                plugins::space_scope_snapshot_of(target.as_deref()),
                hint.as_deref(),
            )
            .to_string())
        }
        None => out,
    }
}

/// 从调用参数里取 `spaceId`（空串当没给 ✓）。**只在 pages.search / pages.list 上有意义**。
pub(crate) fn target_space_id(args_json: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(args_json)
        .ok()
        .and_then(|v| {
            v.get("spaceId")
                .and_then(|x| x.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        })
}

/// 中文**整句**查询的补救提示（2026-10-18）。
///
/// 检索没有分词：一句没有空格的中文（「找一下焦煤相关的材料」）会当成**一个**超长词去匹配，
/// 必然 0 条 —— 而这不是"库里没有"。与其让调用方下这个判断，不如直接教它怎么重试
/// （拆成 2–4 个关键词、用空格分开）——这条建议**它能立刻执行** ✓。
///
/// 只在「没有空格 且 ≥6 字 且 含 CJK」时给（短词、英文、多词查询都不加，免得噪音）。
fn long_cjk_retry_hint(args_json: &str) -> Option<String> {
    let q = serde_json::from_str::<serde_json::Value>(args_json)
        .ok()
        .and_then(|v| v.get("q").and_then(|x| x.as_str()).map(str::to_string))?;
    let t = q.trim();
    if t.is_empty() || t.split_whitespace().count() != 1 {
        return None;
    }
    let chars = t.chars().count();
    let has_cjk = t.chars().any(|c| ('\u{4E00}'..='\u{9FFF}').contains(&c));
    if chars < 6 || !has_cjk {
        return None;
    }
    Some(
        "这句是一整句中文，而检索**没有分词**（整句被当成一个词）⇒ 建议拆成 2–4 个关键词、\
         用空格分开再试（例如「焦煤 材料」）。"
            .to_string(),
    )
}

/// 把能力面的检索结果（`[{id,title,snippet}]`）解成数组；不是数组就 `None`（原样返回 ✓）。
fn search_items(json: &str) -> Option<Vec<serde_json::Value>> {
    serde_json::from_str::<serde_json::Value>(json)
        .ok()
        .and_then(|v| match v {
            serde_json::Value::Array(a) => Some(a),
            _ => None,
        })
}

/// [`with_search_scope`] 去掉"读范围"那一步的形态：判据可以直接喂范围（不碰库 ✓）。
fn with_search_scope_with(
    method: &str,
    out: Result<String, String>,
    scope: Result<serde_json::Value, String>,
    hint: Option<&str>,
) -> Result<String, String> {
    if method != "pages.search" {
        return out;
    }
    match out.as_ref().ok().and_then(|json| search_items(json)) {
        Some(items) => Ok(search_envelope(items, scope, hint).to_string()),
        None => out,
    }
}

/// [`with_search_scope`] 的纯函数部分（判据直接喂范围，不碰库 ✓）。
fn search_envelope(
    items: Vec<serde_json::Value>,
    scope: Result<serde_json::Value, String>,
    extra_hint: Option<&str>,
) -> serde_json::Value {
    let matched = items.len();
    let mut v = serde_json::json!({ "matched": matched, "results": items });
    match scope {
        Ok(s) => {
            if matched == 0 {
                // 只给**能立刻执行**的下一步（别列一个这时还不存在的工具名 ✗）
                let name = s["spaceName"].as_str().unwrap_or("");
                let pages = s["pageCount"].as_i64().unwrap_or(0);
                let extra = extra_hint.map(|h| format!("\n{h}")).unwrap_or_default();
                v["hint"] = serde_json::Value::String(format!(
                    "当前空间「{name}」（{pages} 页）没有匹配 —— 这不代表别的空间也没有。\
                     可以换更短的词、去掉部分关键词；或用 pages_list 先看一遍本空间最近更新的页面；\
                     也可用 spaces_list 确认当前空间（必要时 spaces_switch 切换）再搜。{extra}"
                ));
            }
            v["scope"] = s;
        }
        Err(e) => {
            v["scope"] = serde_json::Value::Null;
            v["scopeError"] = serde_json::Value::String(e);
        }
    }
    v
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
        assert!(
            err.contains("unknown_capability"),
            "错误码必须逐字不变：{err}"
        );
        let rows = audit_of(&format!("external:{session}"));
        assert_eq!(
            rows.len(),
            1,
            "被拒的调用也必须留痕（这恰恰是最该查的那类记录 ✓）；读到 {} 条",
            rows.len()
        );
        assert_eq!(rows[0].error_code.as_deref(), Some("unknown_capability"));
        assert!(!rows[0].ok);
        assert_eq!(
            rows[0].plugin_id, "external",
            "外部会话不是插件 ⇒ 别冒用插件 id ✓"
        );
    }

    /// 权限不够时**点名缺哪个** ✓ —— 与插件那条路**同一份**消息与错误码 ✓（判定只有一处 ✓）。
    #[test]
    fn missing_permission_is_denied_by_the_same_judgement() {
        let session = "sdk-denied-1";
        // `pages.count` 需要 `read:pages`（`capabilities_gen.rs` ✓）⇒ 一个都不授予 ⇒ 必拒 ✓
        let err = handle_external_call(session, &[], "pages.count", "{}").unwrap_err();
        assert!(
            err.contains("permission_denied"),
            "错误码必须逐字不变：{err}"
        );
        assert!(
            err.contains("read:pages"),
            "要点名「缺哪个权限」（给人看的那半 ✓）：{err}"
        );
        let rows = audit_of(&format!("external:{session}"));
        assert_eq!(
            rows.len(),
            1,
            "被拒的调用也必须留痕；读到 {} 条",
            rows.len()
        );
        assert_eq!(rows[0].error_code.as_deref(), Some("permission_denied"));
    }

    // ═════════════════════════════════════════════════════════════════════════
    // B1a（2026-10-29）· 只读扩容的**挂载级**判据（工具面 ＋ 权限门 ＋ 当前页如实）
    //   数据级的三条（节点数/父子/截断、跨空间、count==listPages.length）在
    //   `plugins.rs` 的 tests 里（那里有真夹具空间；这里是宿主面这一层）。
    // ═════════════════════════════════════════════════════════════════════════

    /// ⭐ **表驱动**：这 5 条 B1a 工具在「不接」档（`granted` 为空）必须**逐条**
    /// `permission_denied`，且拒绝消息里点名的是**注册表里写着的那条权限**
    /// （⛔ 不在测试里手抄权限名 —— 从注册表查，改了它这里自动跟）。
    #[test]
    fn b1a_tools_are_denied_table_driven_without_the_read_grant() {
        let cases = [
            "page.current",
            "pages.count",
            "pages.tree",
            "tags.list",
            "properties.list",
        ];
        for method in cases {
            let cap = crate::capabilities_gen::lookup(method)
                .unwrap_or_else(|| panic!("注册表里必须有 {method} ✓"));
            let perm = cap.permission.expect("只读能力也有权限门 ✓");
            let session = format!("b1a-denied-{}", method.replace('.', "-"));
            let err = match handle_external_call(&session, &[], method, "{}") {
                Ok(v) => panic!("{method} 在无授权时**必须被拒**，实际成功：{v}"),
                Err(e) => e,
            };
            assert!(
                err.contains("permission_denied"),
                "{method} 在无授权时必须 permission_denied：{err}"
            );
            assert!(
                err.contains(perm),
                "{method} 的拒绝必须点名缺哪个权限 {perm}：{err}"
            );
            let rows = audit_of(&format!("external:{session}"));
            assert_eq!(
                rows.len(),
                1,
                "{method} 被拒也必须留痕 ✓（拿到 {} 条）",
                rows.len()
            );
            assert_eq!(rows[0].error_code.as_deref(), Some("permission_denied"));
        }
    }

    /// ⭐ **B1b（2026-10-29）判据 5（挂载级那一半）**：`db.schema` / `db.rows` 在「不接」档
    /// （`granted` 为空）必须**逐条** `permission_denied`，且拒绝消息点名的是**注册表里
    /// 写着的那条权限**（`read:pages`；⛔ 不在测试里手抄 —— 注册表改了这里自动跟）。
    ///
    /// 变异（会红）：把 `db.schema` 的 `permission` 改成 `null` ⇒ 它变成"无需权限"⇒ 这条的第一断
    /// 言红（说明这一格真的由注册表驱动）。
    #[test]
    fn b1b_db_tools_are_denied_table_driven_without_the_read_grant() {
        for method in ["db.schema", "db.rows"] {
            let cap = crate::capabilities_gen::lookup(method)
                .unwrap_or_else(|| panic!("注册表里必须有 {method} ✓"));
            let perm = cap.permission.expect("只读能力也有权限门 ✓");
            let session = format!("b1b-denied-{}", method.replace('.', "-"));
            let err = match handle_external_call(&session, &[], method, "{}") {
                Ok(v) => panic!("{method} 在无授权时**必须被拒**，实际成功：{v}"),
                Err(e) => e,
            };
            assert!(
                err.contains("permission_denied"),
                "{method} 在无授权时必须 permission_denied：{err}"
            );
            assert!(
                err.contains(perm),
                "{method} 的拒绝必须点名缺哪个权限 {perm}：{err}"
            );
            let rows = audit_of(&format!("external:{session}"));
            assert_eq!(
                rows.len(),
                1,
                "{method} 被拒也必须留痕 ✓（拿到 {} 条）",
                rows.len()
            );
            assert_eq!(rows[0].error_code.as_deref(), Some("permission_denied"));
        }
    }

    /// ⭐ **B1c/B3（2026-10-29）挂载级判据**：
    /// ① 这些只读工具在「不接」档（`granted` 为空）**逐条** `permission_denied`，且点名的权限来自注册表；
    /// ② **句柄类**（`files.download` / `blobs.fetch` / 两个 `export.*`）在"只读档但**没有** `export:files`"
    ///    时必须拒 —— 这是矩阵 §6「原字节只走句柄」的权限门那一半；
    /// ③ `coverage.report` 要 `read:files`（B3 起它不再是 host:frontend 的幽灵能力）。
    #[test]
    fn b1c_tools_are_denied_table_driven_and_handles_need_the_export_scope() {
        let methods = [
            "versions.list",
            "version.get",
            "trash.list",
            "files.stat",
            "files.extract_status",
            "files.list_orphan",
            "files.download",
            "blobs.fetch",
            // B3
            "export.markdown",
            "export.docpackage",
            "coverage.report",
        ];
        for method in methods {
            let cap = crate::capabilities_gen::lookup(method)
                .unwrap_or_else(|| panic!("注册表里必须有 {method} ✓"));
            let perm = cap.permission.expect("只读能力也有权限门 ✓");
            let session = format!("b1c-denied-{}", method.replace('.', "-"));
            let err = match handle_external_call(&session, &[], method, "{}") {
                Ok(v) => panic!("{method} 在无授权时**必须被拒**，实际成功：{v}"),
                Err(e) => e,
            };
            assert!(
                err.contains("permission_denied"),
                "{method} 在无授权时必须 permission_denied：{err}"
            );
            assert!(
                err.contains(perm),
                "{method} 的拒绝必须点名缺哪个权限 {perm}：{err}"
            );
            assert_eq!(
                audit_of(&format!("external:{session}")).len(),
                1,
                "{method} 被拒也必须留痕 ✓"
            );
        }
        // ② 句柄类：只读档但**收回** `export:files` ⇒ 必须拒（⛔ 不看"别的读权限在不在"）
        let mut read = crate::mcp_channel::default_read_scopes();
        read.retain(|s| s != "export:files");
        for (method, args) in [
            ("files.download", r#"{"attId":"a1"}"#),
            ("blobs.fetch", r#"{"handle":"whatever"}"#),
            // B3：两个导出也是「句柄类」，同样只认 `export:files`
            ("export.markdown", r#"{"pageId":"p1"}"#),
            ("export.docpackage", r#"{"pageId":"p1"}"#),
        ] {
            let err = match handle_external_call(
                &format!("b1c-noexport-{}", method.replace('.', "-")),
                &read,
                method,
                args,
            ) {
                Ok(v) => panic!("{method} 没有 export:files 时必须被拒，实际成功：{v}"),
                Err(e) => e,
            };
            assert!(
                err.contains("permission_denied") && err.contains("export:files"),
                "{method} 没有 export:files 必须点名拒：{err}"
            );
        }
    }

    /// ⭐ 判据 6：**没有打开的页面 ⇒ 如实说**（不报 500 形状的错、⛔ 不编造一页）。
    ///
    /// 为什么挂在这一层：外部接入**拿不到**界面里「当前页」这个状态（`RunState.current_page_id`
    /// 只在插件运行时被装进来）⇒ 这条工具在外部面上**必然**走 no-page 分支；
    /// 判据要钉的正是"它没为了有东西返回而编一个页面 id"。
    #[test]
    fn b1a_page_current_says_there_is_no_open_page_instead_of_inventing_one() {
        let granted = crate::mcp_channel::default_read_scopes();
        let out = handle_external_call("b1a-current-1", &granted, "page.current", "{}")
            .expect("没有打开的页面**不是错误**（不许报 500 形状的错 ✓）");
        let v: serde_json::Value = serde_json::from_str(&out).expect("回话必须是 JSON ✓");
        assert_eq!(
            v["opened"],
            serde_json::json!(false),
            "必须如实说没有打开的页面：{v}"
        );
        assert!(
            v.get("id").is_none(),
            "⛔ 不许编造一页（回话里不许有 id）：{v}"
        );
        assert!(
            v["note"]
                .as_str()
                .unwrap_or_default()
                .contains("没有打开的页面"),
            "note 要直说「没有打开的页面」：{v}"
        );
        let rows = audit_of("external:b1a-current-1");
        assert_eq!(rows.len(), 1, "成功调用也要留一行审计 ✓");
        assert!(rows[0].ok);
    }
    /// ⭐ **B1c/B3（2026-10-29）判据 1**：新工具在**读面**清单里；清单与注册表同源
    /// （每条 capabilityId 查得到、都是 read）；且**一条写页/写块工具都没有**（零写红测试）。
    #[test]
    fn b1c_tools_are_listed_and_no_write_page_tool_leaks() {
        let parsed: serde_json::Value =
            serde_json::from_str(&tools_list_json(false)).expect("工具清单必须是合法 JSON ✓");
        let off: Vec<String> = parsed
            .as_array()
            .expect("工具清单是裸数组 ✓")
            .iter()
            .map(|t| t["name"].as_str().unwrap_or_default().to_string())
            .collect();
        for n in [
            "versions_list",
            "version_get",
            "trash_list",
            "files_stat",
            "files_extract_status",
            "files_list_orphan",
            "files_download",
            "blobs_fetch",
            // B3：前端桥三条
            "export_markdown",
            "export_docpackage",
            "coverage_report",
        ] {
            assert!(
                off.iter().any(|x| x == n),
                "B1c 工具 {n} 必须在读面清单里 ✓（实际 {off:?}）"
            );
        }
        // 零写：B1c 一条写页/写块工具都不许有
        for forbidden in [
            "pages_create",
            "pages_update",
            "pages_importMarkdown",
            "blocks_append",
            "editor_insertText",
        ] {
            assert!(
                !off.iter().any(|x| x == forbidden),
                "⛔ 读面里出现了写页/写块工具 {forbidden} ✗"
            );
        }
        // 与注册表同源
        for t in parsed.as_array().expect("裸数组 ✓") {
            let id = t["capabilityId"].as_str().unwrap_or_default();
            let cap = crate::capabilities_gen::lookup(id)
                .unwrap_or_else(|| panic!("清单里的 {id} 不在注册表里 ✗"));
            assert_eq!(cap.kind, "read", "读面里混进了非读能力 {id} ✗");
        }
    }

    /// ⭐ **B2-结构（2026-10-29）挂载级判据**：14 条写工具在「不接」档逐条 `permission_denied`，
    /// 且点名的权限来自注册表；带 `spaceId` 写别的空间 ⇒ 点名缺 `write:all-spaces`。
    #[test]
    fn b2_write_tools_are_denied_table_driven_and_space_id_needs_write_all() {
        let methods = [
            "pages.create",
            "pages.update",
            "pages.importMarkdown",
            "blocks.append",
            "folders.create",
            "nodes.move",
            "nodes.rename",
            "nodes.delete",
            "trash.restore",
            "pages.revert",
            "tags.add",
            "tags.remove",
            "properties.set",
            "properties.unset",
            "blocks.patch",
            "blocks.insert",
            "blocks.delete",
            "files.move",
            "files.rename",
            "files.delete",
            "templates.apply",
            "files.upload_to_page",
            "import.docpackage",
            "files.detach",
            "db.rows_write",
            "db.rows_delete",
        ];
        for method in methods {
            let cap = crate::capabilities_gen::lookup(method)
                .unwrap_or_else(|| panic!("注册表里必须有 {method} ✓"));
            let perm = cap.permission.expect("写能力也有权限门 ✓");
            let session = format!("b2-denied-{}", method.replace('.', "-"));
            let err = match handle_external_call(&session, &[], method, "{}") {
                Ok(v) => panic!("{method} 在无授权时**必须被拒**，实际成功：{v}"),
                Err(e) => e,
            };
            assert!(
                err.contains("permission_denied"),
                "{method} 在无授权时必须 permission_denied：{err}"
            );
            assert!(
                err.contains(perm),
                "{method} 的拒绝必须点名缺哪个权限 {perm}：{err}"
            );
            assert_eq!(
                audit_of(&format!("external:{session}")).len(),
                1,
                "{method} 被拒也必须留痕 ✓"
            );
        }
        // ② 有写权限、但带**别的空间**的 spaceId ⇒ permission_denied 并点名 write:all-spaces
        let mut granted = crate::mcp_channel::default_read_scopes();
        granted.push("write:pages".to_string());
        granted.push("write:tags".to_string());
        granted.push("write:properties".to_string());
        let err = match handle_external_call(
            "b2-space-id-wall",
            &granted,
            "nodes.move",
            r#"{"id":"p1","spaceId":"别的空间"}"#,
        ) {
            Ok(v) => panic!("带别的空间 spaceId 必须被拒，实际成功：{v}"),
            Err(e) => e,
        };
        assert!(
            err.contains("permission_denied") && err.contains("write:all-spaces"),
            "跨空间写必须点名 write:all-spaces：{err}"
        );
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
        // ⭐ B3（2026-10-29）改判：`coverage.report` 以前是 `host:"frontend"`、**不在面上**
        //   （M1 修过："面里不许有调不通的工具"）；现在它有了 **Rust→前端桥** ⇒ 它**该在**面上，
        //   而且点开就是真能调（前端没挂载时会立刻 `frontend_unavailable`，不会挂死）。
        assert!(
            off.iter().any(|x| x == "coverage_report"),
            "B3 起 coverage_report 必须**在**读面上（经前端桥真能调）：{off:?}"
        );
        // ③ 开关**开着**时：两个写工具都在 ✓，且正好多出写面那 2 条 ✓
        for n in ["pages_create", "blocks_append"] {
            assert!(
                on.iter().any(|x| x == n),
                "开着时清单里必须有写工具 {n} ✓: {on:?}"
            );
        }
        // ⭐ **2026-10-09（owner 拍「同意」✓）**：这里原来硬断言"写工具**正好 2 条**" ✗ ——
        //   R152 把口径改成"跟**权限** `write:pages` 走、不是跟要不要人确认" ✓ 之后，
        //   写面增删一次这个数字就过期一次 ✓（现场：`left 10 / right 9` ⇒ 差 3 条 ✗）。
        //   ⇒ 改成**语义断言** ✓：开着时**只多出**写工具 ✓、两个写工具**必须在** ✓；
        //   ⛔ 不再钉条数 —— 那正是它过期的方式 ✗。
        let added: Vec<&String> = on.iter().filter(|n| !off.iter().any(|x| x == *n)).collect();
        assert!(
            !added.is_empty(),
            "开着时必须**多出**写工具 ✓（实际 {off:?} / {on:?}）"
        );
        for n in ["pages_create", "blocks_append"] {
            assert!(
                added.iter().any(|x| *x == n),
                "新多出来的必须含写工具 {n} ✓（实际多出 {added:?}）"
            );
        }
    }

    /// ⭐ **B1a（2026-10-29）判据 1**：5 条只读扩容工具**必须在** `tools/list` 里；
    /// 且清单里的每个 `capabilityId` 都能在注册表里查到、都是 `read`、都不是 `host:frontend`
    /// —— 面与注册表**同源**（⛔ 不是手搓的第二套工具表）。
    ///
    /// 变异（会红）：把 `genMcpTools` 的 `c.ai` 过滤去掉/把注册表里某条的 `ai` 关掉并重新生成
    /// ⇒ 对应那条不在清单里 ⇒ 本测试第一条断言红。
    #[test]
    fn b1a_readonly_tools_are_listed_and_every_entry_matches_the_registry() {
        let off = names(&tools_list_json(false));
        for n in [
            "page_current",
            "pages_count",
            "pages_tree",
            "tags_list",
            "properties_list",
            // ⭐ B1b（2026-10-29）：数据库只读两条也在读面清单里（同一份注册表生成 ✓）
            "db_schema",
            "db_rows",
        ] {
            assert!(
                off.iter().any(|x| x == n),
                "B1a 工具 {n} 必须在读面清单里 ✓（实际 {off:?}）"
            );
        }
        // 生成物与注册表同源：每一条都查得到、都是读能力、都不是 host:frontend
        let v: serde_json::Value =
            serde_json::from_str(&tools_list_json(false)).expect("工具清单必须是合法 JSON ✓");
        let arr = v.as_array().expect("工具清单是裸数组 ✓");
        assert!(!arr.is_empty(), "扫到 0 条不等于干净 ✗");
        for t in arr {
            let id = t["capabilityId"]
                .as_str()
                .unwrap_or_else(|| panic!("清单必须带 capabilityId ✓：{t}"));
            let cap = crate::capabilities_gen::lookup(id)
                .unwrap_or_else(|| panic!("清单里的 {id} 不在注册表里 ✗（面与注册表漂了）"));
            assert_eq!(cap.kind, "read", "读面清单里混进了非读能力 {id} ✗");
            // ⚠️ `host: "frontend"` 的能力**根本不在 Rust 绑定表里**（生成器就跳过它）⇒
            //    `lookup` 能查到它，本身已证明"宿主面真能服务它"（M1 在 coverage.report 上踩过：
            //    面里列了、一调 unknown_capability ✗）。这条口径由 `check-capabilities` §2c 再钉一遍。
        }
    }

    /// ⭐ **B1a 判据 7（零写）**：`editor.insertText` / `user.notify` / `kv.*` / `settings.get` /
    /// `log.write` / `spaces.switch` **仍然不在**任何一份 MCP 工具清单里（读面与写面都查）。
    /// 它们要么是注册表里的 ✗ 项、要么是插件私有面 —— 出现在面上就是"外部 AI 能碰应用状态"。
    #[test]
    fn b1a_surface_still_excludes_every_forbidden_tool() {
        let off = names(&tools_list_json(false));
        let on = names(&tools_list_json(true));
        for forbidden in [
            "editor_insertText",
            "user_notify",
            "kv_get",
            "kv_set",
            "kv_remove",
            "settings_get",
            "log_write",
            "spaces_switch",
        ] {
            assert!(
                !off.iter().any(|x| x == forbidden),
                "⛔ 不暴露清单里的 {forbidden} 出现在读面 ✗：{off:?}"
            );
            assert!(
                !on.iter().any(|x| x == forbidden),
                "⛔ 不暴露清单里的 {forbidden} 出现在写面 ✗：{on:?}"
            );
        }
    }

    /// ⭐ **B2-结构（2026-10-29）判据 7**：零写红测试改判成「**预期写工具白名单**」——
    /// 读面里⛔ 一个写工具都不许有；写面**正好**是这 14 条（旧 4 ＋ B2 的 10），多一条少一条都红。
    /// （不是删掉旧测试：它挡的"写能力悄悄多出来"正是要保留的语义，只是从"一条都没有"升级成白名单。）
    #[test]
    fn b2_write_surface_is_exactly_the_expected_whitelist() {
        const EXPECTED_WRITE: [&str; 27] = [
    "blocks_append",
    "blocks_delete",
    "blocks_insert",
    "blocks_patch",
    "db_rows_delete",
    "db_rows_write",
    "files_delete",
    "files_detach",
    "files_move",
    "files_rename",
    "files_upload_to_page",
    "folders_create",
    "import_docpackage",
    "nodes_delete",
    "nodes_move",
    "nodes_rename",
    "pages_create",
    "pages_importMarkdown",
    "pages_import_markdown",
    "pages_revert",
    "pages_update",
    "properties_set",
    "properties_unset",
    "tags_add",
    "tags_remove",
    "templates_apply",
    "trash_restore",
];
        let off = names(&tools_list_json(false));
        let on = names(&tools_list_json(true));
        let added: Vec<&String> = on.iter().filter(|n| !off.iter().any(|x| x == *n)).collect();
        let mut got: Vec<String> = added.iter().map(|s| (*s).clone()).collect();
        got.sort();
        let mut want: Vec<String> = EXPECTED_WRITE.iter().map(|s| s.to_string()).collect();
        want.sort();
        assert_eq!(
            got, want,
            "写面必须**正好**是预期白名单（多/少都红）——got={got:?}"
        );
        for n in EXPECTED_WRITE {
            assert!(
                !off.iter().any(|x| x == n),
                "读写面分离：读面里不该出现写工具 {n}：{off:?}"
            );
        }
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
            let Ok(rd) = std::fs::read_dir(&d) else {
                continue;
            };
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
        let _serial = DRAFT_SINK_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let dir = crate::db::ensure_test_app_data_dir().to_path_buf();
        // 装一个**测试出口**：真看见草稿才算数 ✓（比读源码猜有没有 emit 硬 ✗）
        let seen: std::sync::Arc<std::sync::Mutex<Vec<String>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
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
        let perm = cap
            .permission
            .expect("写能力必须有 permission（注册表里写着 ✓）");
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
        assert_eq!(
            before, after,
            "外部写请求在用户确认之前**不许落库** ✗：数据目录变了"
        );
        // ② 草稿**交出去了** ✓（以前是塞进线程局、没人取 ⇒ 静默丢掉 ✗）
        let got = seen.lock().map(|g| g.clone()).unwrap_or_default();
        assert_eq!(got.len(), 1, "草稿必须交出去一次（拿到 {} 条）✗", got.len());
        assert!(
            got[0].contains("新建页面"),
            "出口里要带**后端生成的** summary ✓：{got:?}"
        );
        assert!(
            got[0].contains("create_page"),
            "payload 的 kind 也要在 ✓：{got:?}"
        );
        // ③ 回给 agent 的话**如实** ✓（是「待确认」就不许说成「已写入」✗）
        assert!(
            out.contains("\"drafted\":true"),
            "回话要带 drafted ✓：{out}"
        );
        assert!(
            out.contains("\"awaiting_confirm\":true"),
            "默认（免确认关着）必须 awaiting_confirm ✓：{out}"
        );
        // ④ 留痕 ✓
        let rows: Vec<_> = crate::plugins::plugin_audit(Some("external".to_string()), Some(200))
            .into_iter()
            .filter(|e| e.source == format!("external:{session}"))
            .collect();
        assert_eq!(rows.len(), 1, "写请求也要留痕 ✓（拿到 {} 条）", rows.len());
        assert!(rows[0].ok, "这次调用本身是成功的（草稿生成了 ✓）");
        assert_eq!(rows[0].capability, "pages.create");
    }

    /// `pages.update`（2026-10-17）：MCP 的**整页替换**入口 —— 同样只产出草稿。
    /// 判据：草稿真的交出去、kind 是 `update_page`、payload 带着**目标页 id**（⛔ 不带=不知道改哪页 ✗）。
    #[test]
    fn pages_update_is_drafted_with_target_page_id() {
        let _serial = DRAFT_SINK_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _dir = crate::db::ensure_test_app_data_dir();
        let dir = _dir.to_path_buf();
        {
            let m = crate::db::open_meta_conn_at(&dir).unwrap();
            let space: String = m
                .query_row("SELECT id FROM workspaces WHERE deleted_at IS NULL LIMIT 1", [], |r| r.get(0))
                .unwrap();
            let c = crate::db::open_space_conn_at(&space, &dir).unwrap();
            c.execute(
                "INSERT OR REPLACE INTO pages (id, workspace_id, parent_id, title, content_json, content_text, kind, sort_order, created_at, updated_at) VALUES (?1, ?2, NULL, 'p', '{}', 'x', 'page', 0, 10, 10)",
                rusqlite::params!["p-update-1", space],
            )
            .unwrap();
        }
        let seen: std::sync::Arc<std::sync::Mutex<Vec<String>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen2 = seen.clone();
        set_external_draft_sink(move |source, payload| {
            if let Ok(mut g) = seen2.lock() {
                g.push(format!("{source}|{payload}"));
            }
        });

        let session = "sdk-w3-update-1";
        let cap = crate::capabilities_gen::lookup("pages.update").expect("pages.update 必须存在 ✓");
        let perm = cap.permission.expect("写能力必须有 permission ✓");
        let out = handle_external_call(
            session,
            &[perm.to_string()],
            "pages.update",
            r##"{"id":"p-update-1","title":"新标题","markdown":"# 新标题\n\n新正文"}"##,
        )
        .expect("外部写请求本身应当成功（它产出的是草稿 ✓）");

        let got = seen.lock().map(|g| g.clone()).unwrap_or_default();
        assert_eq!(got.len(), 1, "草稿必须交出去一次（拿到 {} 条）✗", got.len());
        assert!(
            got[0].contains("update_page"),
            "payload 的 kind 必须是 update_page ✓：{got:?}"
        );
        assert!(
            got[0].contains("p-update-1"),
            "payload 必须带目标页 id ✓：{got:?}"
        );
        assert!(
            out.contains("\"drafted\":true"),
            "回话要带 drafted ✓：{out}"
        );
    }

    /// ⭐ 2026-10-18：**整页替换永远要人确认** —— 即使「免确认」档开着。
    ///
    /// 挡的是哪一幕：`pages.update` 一次调用把整页正文换掉，而这条路没有 undo／dry-run／改前快照，
    /// 审计也只记能力名、不记参数。免确认档把它一起放过去 ⇒ 一次误会就是一次数据丢失。
    /// 三条断言一起说清：回话如实（`auto_apply:false`）／数据目录**逐字节不变**／草稿也标了 false。
    #[test]
    fn pages_update_never_auto_applies_even_when_allow_write_is_on() {
        let _serial = DRAFT_SINK_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let dir = crate::db::ensure_test_app_data_dir().to_path_buf();
        {
            let m = crate::db::open_meta_conn_at(&dir).unwrap();
            let space: String = m
                .query_row("SELECT id FROM workspaces WHERE deleted_at IS NULL LIMIT 1", [], |r| r.get(0))
                .unwrap();
            let c = crate::db::open_space_conn_at(&space, &dir).unwrap();
            c.execute(
                "INSERT OR REPLACE INTO pages (id, workspace_id, parent_id, title, content_json, content_text, kind, sort_order, created_at, updated_at) VALUES (?1, ?2, NULL, 'p', '{}', 'x', 'page', 0, 10, 10)",
                rusqlite::params!["p-update-auto", space],
            )
            .unwrap();
        }
        let seen: std::sync::Arc<std::sync::Mutex<Vec<String>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen2 = seen.clone();
        set_external_draft_sink(move |_source, payload| {
            if let Ok(mut g) = seen2.lock() {
                g.push(payload.to_string());
            }
        });

        let before = fingerprint(&dir);
        let session = "sdk-update-auto-1";
        let cap = crate::capabilities_gen::lookup("pages.update").expect("pages.update 必须存在 ✓");
        let perm = cap.permission.expect("写能力必须有 permission ✓");
        let out = handle_external_call_with(
            session,
            &[perm.to_string()],
            "pages.update",
            r##"{"id":"p-update-auto","markdown":"整页替换的新正文"}"##,
            true, // ⭐ 免确认开关**开着** —— 正是这条判据要挡的场景 ✓
        )
        .expect("调用本身应当成功（它产出的是草稿 ✓）");
        let after = fingerprint(&dir);

        assert_eq!(
            before, after,
            "整页替换在免确认档下也**不许**自动落库 ✗：数据目录变了"
        );
        assert!(
            out.contains("\"auto_apply\":false"),
            "回话必须如实说「没自动写」✓：{out}"
        );
        assert!(
            out.contains("\"awaiting_confirm\":true"),
            "回话必须说「在等人确认」✓：{out}"
        );
        let got = seen.lock().map(|g| g.clone()).unwrap_or_default();
        assert_eq!(got.len(), 1, "草稿要交出去一次 ✓（拿到 {} 条）", got.len());
        assert!(
            got[0].contains("\"auto_apply\":false"),
            "出口那边也必须是「等确认」（否则前端会直接落库 ✗）：{}",
            got[0]
        );
        assert!(
            got[0].contains("update_page"),
            "payload 的 kind 必须是 update_page ✓"
        );
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
        let _serial = DRAFT_SINK_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _dir = crate::db::ensure_test_app_data_dir();
        let seen: std::sync::Arc<std::sync::Mutex<Vec<String>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
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
        assert!(
            out.contains("\"auto_apply\":true"),
            "免确认时必须标明 auto_apply ✓：{out}"
        );
        assert!(
            out.contains("\"awaiting_confirm\":false"),
            "免确认时不该说在等确认 ✓：{out}"
        );
        // ② 出口里也带 auto_apply:true ⇒ 前端**不弹框**、直接走同一条落库路 ✓（落库仍只有 `ai/apply.ts` 一处 ✓）
        let got = seen.lock().map(|g| g.clone()).unwrap_or_default();
        assert_eq!(got.len(), 1, "草稿要交出去一次 ✓（拿到 {} 条）", got.len());
        assert!(
            got[0].contains("\"auto_apply\":true"),
            "出口里必须带 auto_apply:true ✓：{}",
            got[0]
        );
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
        assert_eq!(
            rows[0].capability, "pages.create",
            "审计里要看得出改的是哪一类能力 ✓"
        );
        assert_eq!(
            rows[0].plugin_id, "external",
            "外部会话不是插件 ⇒ 不许冒用插件 id ✓"
        );
    }

    /// 检索信封（2026-10-17）：`pages.search` 的外部结果**必须**带上范围；空结果必须说得出
    /// "是哪个空间没有"。判据把范围直接喂进来（不碰库 ⇒ 不依赖活动空间，也不会被并行测试干扰 ✓）。
    #[test]
    fn pages_search_result_carries_scope_and_says_which_space_is_empty() {
        let scope = || Ok(serde_json::json!({"spaceId":"s1","spaceName":"运营","pageCount":42}));

        // ① 有命中：matched 与 results 都在，**不必**给 hint（有结果时别劝人换词 ✗）
        let one = with_search_scope_with(
            "pages.search",
            Ok(r#"[{"id":"p1","title":"短剧方案","snippet":"…"}]"#.to_string()),
            scope(),
            None,
        )
        .expect("成功的结果不该被信封弄成错误 ✓");
        let v: serde_json::Value = serde_json::from_str(&one).unwrap();
        assert_eq!(v["matched"], 1);
        assert_eq!(v["results"][0]["id"], "p1");
        assert_eq!(
            v["scope"]["spaceName"], "运营",
            "范围必须带空间名（否则调用方仍然不知道搜的是哪）"
        );
        assert_eq!(v["scope"]["pageCount"], 42);
        assert!(
            v.get("hint").is_none(),
            "有命中还劝换词只会让 agent 怀疑结果：{v}"
        );

        // ② 空：**必须**说清楚是哪个空间、有多少页 —— 这就是「[] 让调用方困惑」的修法
        let none =
            with_search_scope_with("pages.search", Ok("[]".to_string()), scope(), None).unwrap();
        let v: serde_json::Value = serde_json::from_str(&none).unwrap();
        assert_eq!(v["matched"], 0);
        let hint = v["hint"].as_str().unwrap_or_default();
        assert!(hint.contains("运营"), "空结果的提示要点名空间：{hint}");
        assert!(
            hint.contains("42"),
            "空结果的提示要给页数（0 页与 42 页是两件事）：{hint}"
        );

        // ②b 整句中文：除了范围，还要给"拆词重试"这句**能立刻执行**的话
        let split_hint = long_cjk_retry_hint(r#"{"q":"找一下焦煤相关的材料"}"#);
        assert!(split_hint.is_some(), "整句中文必须给拆词建议");
        let v: serde_json::Value = serde_json::from_str(
            &with_search_scope_with(
                "pages.search",
                Ok("[]".to_string()),
                scope(),
                split_hint.as_deref(),
            )
            .unwrap(),
        )
        .unwrap();
        let hint = v["hint"].as_str().unwrap_or_default();
        assert!(
            hint.contains("拆成 2–4 个关键词"),
            "空结果 + 整句中文 ⇒ 教它拆词：{hint}"
        );

        // ③ 非检索能力**原样**（信封只属于 pages.search，别的工具结果不许被改形状 ✗）
        let raw = with_search_scope_with(
            "pages.get",
            Ok(r#"{"id":"p1","title":"会议纪要"}"#.to_string()),
            scope(),
            None,
        )
        .unwrap();
        assert_eq!(raw, r#"{"id":"p1","title":"会议纪要"}"#);

        // ④ **失败不许伪装成 0 命中**（错就是错 ✓）
        assert!(
            with_search_scope_with(
                "pages.search",
                Err("bad_args: 缺少参数 q".to_string()),
                scope(),
                None
            )
            .is_err(),
            "检索失败必须是错误，不能变成 matched:0 —— 那会让 agent 以为库里真没有 ✗"
        );

        // ⑤ 范围读不到：给 null ＋ 原因，**不编一个 0 页** ✓
        let v: serde_json::Value = serde_json::from_str(
            &with_search_scope_with(
                "pages.search",
                Ok(r#"[{"id":"p1"}]"#.to_string()),
                Err("db_error: 库打不开".to_string()),
                None,
            )
            .unwrap(),
        )
        .unwrap();
        assert!(v["scope"].is_null());
        assert!(
            v["scopeError"]
                .as_str()
                .unwrap_or_default()
                .contains("db_error"),
            "取不到范围时要如实说明，而不是静默留空：{v}"
        );
        assert_eq!(v["matched"], 1, "范围取不到不影响这次检索本身的读数");
    }

    /// 整句中文的补救提示只在"真的会误伤"的形状上出现（2026-10-18）。
    /// 短词、多词、英文加这句只会变成噪音；空 q 更不该有。
    #[test]
    fn long_cjk_retry_hint_only_fires_on_whole_chinese_sentences() {
        assert!(
            long_cjk_retry_hint(r#"{"q":"找一下焦煤相关的材料"}"#).is_some(),
            "整句中文（无空格、≥6 字）⇒ 要给拆词建议"
        );
        assert!(long_cjk_retry_hint(r#"{"q":"焦煤"}"#).is_none(), "短词不给");
        assert!(
            long_cjk_retry_hint(r#"{"q":"焦煤 材料"}"#).is_none(),
            "已经拆好的多词查询不给"
        );
        assert!(
            long_cjk_retry_hint(r#"{"q":"release notes"}"#).is_none(),
            "英文多词不给"
        );
        assert!(long_cjk_retry_hint(r#"{"q":""}"#).is_none(), "空 q 不给");
        assert!(long_cjk_retry_hint(r#"{}"#).is_none(), "缺 q 不给");
    }
}
