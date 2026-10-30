//! `frontend_tool.rs` —— **Rust → 前端** 的请求/应答桥（B1c 收尾；也是 B3 的前置地基）。
//!
//! ## 它解决什么
//! `export.markdown` / `export.docpackage` 的**唯一实现是 TS**（`exportMarkdownBundle.ts` /
//! `docPackWriter.ts`，界面菜单走的就是那两条）。要在外部 MCP 面按**句柄**交付，就必须让
//! 「前端算字节 → Rust 登记句柄」——⛔ Rust 侧重写一遍导出＝两套实现，而它们的漂移不会报错
//! （本仓最贵的那一课）。所以这里只做**搬运**：发一条事件、等一次应答、把字节交回去。
//!
//! ## 四条硬口径
//! * **方法白名单**：只认 [`ALLOWED_METHODS`] 里登记的那几个（⛔ 不是任意前端代码执行）；
//! * **超时**：默认 **5 秒**（导出要读附件/打 zip，够用且不把调用方拖死）；超时 ⇒ `frontend_timeout`，
//!   并**清掉** pending 条目（不留内存垃圾，也不让迟到的应答串到下一条）；
//! * **"前端在不在"要能分开说**：前端窗口挂载时调一次 `mark_ready`（命令 `mcp_frontend_tool_ready`）；
//!   没就绪 ⇒ **立刻** `frontend_unavailable`（⛔ 不空等 5 秒才说"没人"）；
//! * **一条请求一个 id**：应答按 id 精确投递；不认识的 id ⇒ `not_found`（重复应答的第二条就落这里）。
//!
//! ## 不做什么
//! 不落盘、不写日志：字节只在内存里传到 `mcp_blobs`（句柄表），语法与 `mcp_blobs` 同一套。
//!
//! ## 为什么用事件而不是新开一条 HTTP/管道
//! 外部 agent 那条路已经是一条回环 HTTP；这里只需要「能力层 ↔ 已在运行的前端窗口」的一次函数调用，
//! 用 Tauri 的事件 + 一条回执命令就够（⛔ 不新造传输层）。出口在 `lib.rs` 的 setup 里装成 `emit`
//! —— 与 `mcp:external-drafts` 的出口同一个位置、同一种形态。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// 发出去的事件名（前端 `useMcpFrontendTools` 监听这一个）。
pub(crate) const BRIDGE_EVENT: &str = "mcp:frontend-tool-request";
/// 等应答的上限（默认 5 秒；判据用短超时注入，⛔ 不真等 5 秒）。
const TIMEOUT_MS: u64 = 5_000;
/// **方法白名单**：只有这几个方法能被能力层调用（⛔ 任意方法名 ⇒ `bad_args`）。
const ALLOWED_METHODS: &[&str] = &[
    "export.markdown",
    "export.docpackage",
    "coverage.report",
    "markdown.render",
    "files.confirm_download",
];

/// 前端算出来的一件东西：建议文件名 ＋ 字节。
#[derive(Debug, Clone)]
pub(crate) struct BridgeReply {
    pub name: String,
    pub bytes: Vec<u8>,
}

type Emitter = std::sync::Arc<dyn Fn(&str, &str) + Send + Sync>;

fn emitter_slot() -> &'static Mutex<Option<Emitter>> {
    static SLOT: OnceLock<Mutex<Option<Emitter>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

fn pending() -> &'static Mutex<HashMap<String, mpsc::Sender<Result<BridgeReply, String>>>> {
    static PENDING: OnceLock<Mutex<HashMap<String, mpsc::Sender<Result<BridgeReply, String>>>>> =
        OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 装/换出口（App 启动时装 Tauri 的 `emit` ✓；判据里装自己的 ✓）。
#[cfg(test)]
thread_local! {
    static NOTIFY_LOG: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
}
#[cfg(test)]
pub(crate) fn take_notify_log() -> Vec<String> {
    NOTIFY_LOG.with(|l| std::mem::take(&mut *l.borrow_mut()))
}

/// ⭐ B：**只发不等**的前端通知（超限确认用）。
///
/// 与 `call` 的区别：不登记 pending、不等待回执 ⇒ **不触碰 5s 超时语义**；
/// 前端没挂载/没就绪也只是这一次通知丢掉（前端会按"没显示确认框"处理）。
pub(crate) fn notify(method: &str, args_json: &str) {
    #[cfg(test)]
    NOTIFY_LOG.with(|l| l.borrow_mut().push(method.to_string()));
    let method = method.to_string();
    let args = args_json.to_string();
    std::thread::spawn(move || {
        let _ = call(&method, &args);
    });
}

pub(crate) fn set_emitter(f: impl Fn(&str, &str) + Send + Sync + 'static) {
    if let Ok(mut g) = emitter_slot().lock() {
        *g = Some(std::sync::Arc::new(f));
    }
}

/// 前端桥**就绪**标记：`useMcpFrontendTools` 挂载时调 `mcp_frontend_tool_ready` 置真。
///
/// 为什么需要它：只有"事件出口装没装"是 Rust 侧知道的；**前端有没有在听**只能由前端自己说。
/// 没有它就分不出「前端没挂载」（应立刻 `frontend_unavailable`）与「前端在、但这次没回」
/// （等满超时 ⇒ `frontend_timeout`）—— 这两种情况给用户的下一步完全不同。
static READY: AtomicBool = AtomicBool::new(false);

/// 前端挂载时调用（幂等）：此后同进程内都算"前端在"。
pub(crate) fn mark_ready() {
    READY.store(true, Ordering::SeqCst);
}

pub(crate) fn is_ready() -> bool {
    READY.load(Ordering::SeqCst)
}

/// 调一次前端工具：发事件 → 等应答（带超时）。
///
/// `args_json` 是**前端方法自己的参数对象**（字符串原样透传，Rust 不解释它 ——
/// 解释权在实现那一侧，避免两处各自理解一遍参数）。
pub(crate) fn call(method: &str, args_json: &str) -> Result<BridgeReply, String> {
    call_with_timeout(method, args_json, TIMEOUT_MS)
}

/// [`call`] 的可测形态：超时由调用方给（判据用 50ms，⛔ 不真等 5 秒）。
pub(crate) fn call_with_timeout(
    method: &str,
    args_json: &str,
    timeout_ms: u64,
) -> Result<BridgeReply, String> {
    if !ALLOWED_METHODS.contains(&method) {
        return Err(format!(
            "bad_args: 不支持的前端工具 {method}（只登记了：{}）",
            ALLOWED_METHODS.join(" / ")
        ));
    }
    let args: serde_json::Value =
        serde_json::from_str(args_json).unwrap_or(serde_json::Value::Null);
    let request_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::channel();
    {
        let mut g = pending()
            .lock()
            .map_err(|_| "internal: 前端桥 pending 表锁坏了".to_string())?;
        g.insert(request_id.clone(), tx);
    }
    let payload = serde_json::json!({
        "requestId": request_id,
        "method": method,
        "args": args,
    })
    .to_string();
    let emitter = emitter_slot().lock().ok().and_then(|g| g.clone());
    let Some(emit) = emitter else {
        cleanup(&request_id);
        return Err(
            "frontend_unavailable: 前端桥出口没有安装（这个构建/形态没有接上）".to_string(),
        );
    };
    // ⚠️ 前端没挂载 ⇒ **立刻**报 unavailable（⛔ 不空等 5 秒才说"没人"）
    if !is_ready() {
        cleanup(&request_id);
        return Err(
            "frontend_unavailable: 前端窗口没有挂载（应用窗口还没打开/正在启动）".to_string(),
        );
    }
    emit(BRIDGE_EVENT, &payload);
    match rx.recv_timeout(Duration::from_millis(timeout_ms)) {
        Ok(Ok(reply)) => Ok(reply),
        Ok(Err(e)) => Err(e),
        Err(_) => {
            cleanup(&request_id);
            Err(format!(
                "frontend_timeout: 前端 {timeout_ms}ms 内没有应答（窗口可能正忙/卡住；重试一次，或稍后再试）"
            ))
        }
    }
}

fn cleanup(request_id: &str) {
    if let Ok(mut g) = pending().lock() {
        g.remove(request_id);
    }
}

/// 前端回执（命令层直接调它）：成功带 `(name, data)`。
pub(crate) fn respond(request_id: &str, name: &str, data: Vec<u8>) -> Result<(), String> {
    settle(
        request_id,
        Ok(BridgeReply {
            name: name.to_string(),
            bytes: data,
        }),
    )
}

/// 前端回执（失败路径）：错误文本原样给调用方（导出侧已经写成「人话 + 前缀」）。
pub(crate) fn respond_error(request_id: &str, error: &str) -> Result<(), String> {
    settle(request_id, Err(error.to_string()))
}

fn settle(request_id: &str, out: Result<BridgeReply, String>) -> Result<(), String> {
    let tx = {
        let mut g = pending()
            .lock()
            .map_err(|_| "internal: 前端桥 pending 表锁坏了".to_string())?;
        g.remove(request_id.trim())
    };
    // ⚠️ 不认识的 id（重复应答/已超时）⇒ `not_found`：⛔ 不把迟到的应答塞给下一条请求。
    let Some(tx) = tx else {
        return Err("not_found: 这条前端请求不存在、已超时或已应答过".to_string());
    };
    tx.send(out)
        .map_err(|_| "internal: 等待方已经走了（超时后被清掉）".to_string())
}

/// Tauri 命令：前端桥就绪（`useMcpFrontendTools` 挂载时调一次；幂等）。
///
/// 这是"前端在不在"的唯一信号：没有它，Rust 只能等满超时才知道没人应答。
#[tauri::command]
pub fn mcp_frontend_tool_ready() {
    mark_ready();
}

/// Tauri 命令：前端把一次工具请求的结果交回来。
///
/// ⚠️ 这是**前端 → Rust 的唯一回执口**，只做投递、不判权限、不落盘（权限仍只在
/// `dispatch_capability` 一处判；字节只进 `mcp_blobs` 的内存句柄表）。
#[tauri::command]
pub fn mcp_frontend_tool_respond(
    request_id: String,
    name: Option<String>,
    data: Option<Vec<u8>>,
    error: Option<String>,
) -> Result<(), String> {
    match error {
        Some(e) if !e.trim().is_empty() => respond_error(&request_id, e.trim()),
        _ => respond(
            &request_id,
            name.as_deref().unwrap_or(""),
            data.unwrap_or_default(),
        ),
    }
}

/// ⭐ 判据用：串行化"前端桥状态"（ready 标记与假前端是进程级唯一的）。
#[cfg(test)]
pub(crate) fn test_lock() -> std::sync::MutexGuard<'static, ()> {
    static L: std::sync::Mutex<()> = std::sync::Mutex::new(());
    L.lock().unwrap_or_else(|e| e.into_inner())
}

/// ⭐ 判据用：直接改 ready（"前端没挂载"那条判据要在可控时刻造它）。
#[cfg(test)]
pub(crate) fn set_ready_for_tests(v: bool) {
    READY.store(v, Ordering::SeqCst);
}

/// ⭐ 判据用（其它模块的导出判据也走这条桥）：装假前端并标就绪。
#[cfg(test)]
pub(crate) fn install_test_frontend_for_tests() {
    tests::install_test_emitter();
}

// ─────────────────────────────────────────────────────────────────────────────
// 判据：真跑一遍 pending 表 + 超时 + 白名单（不碰 Tauri，也不碰库）
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;

    /// 判据专用的假前端：同步解析出 `requestId`，按方法/参数给应答。
    ///
    /// 与生产同一条 pending 路径（⛔ 不 mock 掉 `call` 本身）：这样才能证明"发出去的东西真能
    /// 按 id 回来"，而不是证明一个空函数返回了常量。
    /// 测试钩子（只存在于判据里）：`__silent` ⇒ 不应答（超时分支）；`__fail` ⇒ 回一条错误。
    pub(crate) fn install_test_emitter() {
        set_emitter(|_event, payload| {
            let v: serde_json::Value = serde_json::from_str(payload).unwrap();
            let id = v["requestId"].as_str().unwrap_or("").to_string();
            let method = v["method"].as_str().unwrap_or("");
            let args = &v["args"];
            if args["__silent"].as_bool() == Some(true) {
                return; // 静默 ⇒ 超时分支
            }
            if let Some(msg) = args["__fail"].as_str() {
                let _ = respond_error(&id, msg);
                return;
            }
            match method {
                "export.markdown" => {
                    let _ = respond(&id, "测试.md", "# 测试\n".as_bytes().to_vec());
                }
                "export.docpackage" => {
                    let _ = respond(&id, "测试.shuyodoc", b"PK-test".to_vec());
                }
                "coverage.report" => {
                    let _ = respond(&id, "报告", b"{\"ok\":true}".to_vec());
                }
                "markdown.render" => {
                    let _ = respond(
                        &id,
                        "markdown.json",
                        "{\"markdown\":\"current markdown\\n<!-- b:blk1 -->\"}"
                            .as_bytes()
                            .to_vec(),
                    );
                }
                _ => {}
            }
        });
        mark_ready();
    }

    /// ⭐ 判据：前端没挂载 ⇒ **立刻** `frontend_unavailable`（⛔ 不空等 5 秒）。
    #[test]
    fn a_missing_frontend_is_reported_immediately() {
        let _serial = test_lock();
        install_test_emitter();
        set_ready_for_tests(false);
        let t0 = std::time::Instant::now();
        // 给一个很长的超时：如果实现是"等超时"，这条会慢到 5 秒 ⇒ 用短超时断言"没等"
        let e = call_with_timeout("export.markdown", r#"{"pageId":"p1"}"#, 5_000)
            .expect_err("前端没挂载必须报错");
        assert!(e.contains("frontend_unavailable"), "{e}");
        assert!(
            t0.elapsed() < std::time::Duration::from_millis(1000),
            "unavailable 必须立刻返回，不能等满超时（实际 {:?}）",
            t0.elapsed()
        );
        set_ready_for_tests(true);
    }

    /// ⭐ 判据：前端在、但不回应 ⇒ `frontend_timeout`（短超时注入，⛔ 不真等 5 秒）。
    #[test]
    fn a_silent_frontend_times_out_and_leaves_no_pending_entry() {
        let _serial = test_lock();
        install_test_emitter();
        let before = pending().lock().unwrap().len();
        let e = call_with_timeout("export.markdown", r#"{"pageId":"p1","__silent":true}"#, 50)
            .expect_err("没有应答就必须超时");
        assert!(e.contains("frontend_timeout"), "{e}");
        assert_eq!(
            pending().lock().unwrap().len(),
            before,
            "超时必须清掉 pending（⛔ 不留内存垃圾，也不让迟到的应答串到下一条）"
        );
    }

    #[test]
    fn bridge_round_trips_bytes_by_request_id() {
        let _serial = test_lock();
        install_test_emitter();
        let md = call("export.markdown", r#"{"pageId":"p1"}"#).expect("应能拿到前端的字节");
        assert_eq!(md.name, "测试.md");
        assert_eq!(md.bytes, "# 测试\n".as_bytes());
        let dp = call("export.docpackage", r#"{"pageId":"p1"}"#).expect("docpackage 也应能拿回");
        assert_eq!(dp.name, "测试.shuyodoc");
        assert_eq!(dp.bytes, b"PK-test");
    }

    #[test]
    fn frontend_errors_are_passed_through_verbatim() {
        let _serial = test_lock();
        install_test_emitter();
        let e = call(
            "export.markdown",
            r#"{"pageId":"p1","__fail":"needs_confirm: 导出包含 30 个文件（>20）"}"#,
        )
        .expect_err("前端报错必须原样传出去");
        assert!(
            e.starts_with("needs_confirm:"),
            "错误文本必须原样（导出侧已写好前缀）：{e}"
        );
    }

    #[test]
    fn methods_outside_the_whitelist_are_rejected() {
        for bad in ["fs.read", "test.echo", "export.execute"] {
            let e = call(bad, "{}").expect_err("白名单外的方法必须被拒");
            assert!(e.contains("bad_args"), "{bad} ⇒ {e}");
        }
    }

    #[test]
    fn respond_to_an_unknown_request_is_not_found() {
        let e = respond("no-such-request", "x", vec![]).unwrap_err();
        assert!(e.contains("not_found"), "{e}");
    }
}
