use crate::db::Db;
use boa_engine::vm::RuntimeLimits;
use boa_engine::{Context, JsString, JsValue, NativeFunction, Source};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::path::{Component, Path, PathBuf};
use std::sync::MutexGuard;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

// ---------------------------------------------------------------------------
// Plugin model
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone)]
pub struct PluginCommandMeta {
    pub id: String,
    pub title: String,
    pub description: String,
    /// JS 侧（`__describe()`）用 camelCase 交回，前端契约仍是 snake_case：
    /// 反序列化接受 `closeOnRun`，序列化仍输出 `close_on_run`。
    #[serde(alias = "closeOnRun")]
    pub close_on_run: bool,
}

#[derive(Serialize, Clone)]
pub struct PluginMeta {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub enabled: bool,
    pub commands: Vec<PluginCommandMeta>,
}

// The `__od` host object methods read the current invocation from here.
thread_local! {
    static RUN_STATE: RefCell<RunState> = RefCell::new(RunState::default());
}
#[derive(Default)]
struct RunState {
    /// 当前调用属于哪个插件（用于把日志/提示归因到插件）。
    plugin_id: String,
    current_page_json: String,
    page_count: usize,
    /// Text a plugin requested to insert at the cursor via `__insert(...)`.
    insert_text: String,
    /// `__toast(...)` 收集到的提示：**随调用结果回传前端**，由前端弹 toast。
    /// 走返回值而不是事件，是因为命令本来就是一次性的——不需要跨线程推事件。
    toasts: Vec<String>,
}

/// Result of running a plugin command: a display `message`, plus an optional
/// `insert` payload the plugin wants to drop into the current page.
#[derive(Serialize, Clone)]
pub struct PluginRunResult {
    pub message: String,
    pub insert: Option<String>,
    /// 插件在本次执行里通过 `__toast(...)` 发出的提示（此前只写 stderr，用户完全看不到）。
    pub toasts: Vec<String>,
}

/// 一条插件日志（作者侧 `__log(...)` 与 `__toast(...)` 都会进环形缓冲）。
#[derive(Serialize, Clone)]
pub struct PluginLogLine {
    pub plugin_id: String,
    /// `info` / `warn` / `error`
    pub level: String,
    pub message: String,
    pub at_ms: i64,
}

/// 日志环形缓冲容量：够定位问题，又不会无限增长。
const PLUGIN_LOG_CAPACITY: usize = 200;

static PLUGIN_LOGS: std::sync::Mutex<std::collections::VecDeque<PluginLogLine>> =
    std::sync::Mutex::new(std::collections::VecDeque::new());

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 记一条插件日志。锁被 poison 也照记（丢日志不该连累插件执行）。
fn push_log(plugin_id: &str, level: &str, message: &str) {
    let mut q = PLUGIN_LOGS.lock().unwrap_or_else(|e| e.into_inner());
    let line = PluginLogLine {
        plugin_id: plugin_id.to_string(),
        level: level.to_string(),
        message: message.to_string(),
        at_ms: now_ms(),
    };
    if q.len() >= PLUGIN_LOG_CAPACITY {
        q.pop_front();
    }
    q.push_back(line);
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
struct Manifest {
    id: String,
    name: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    #[allow(dead_code)] // parsed manifest metadata; not currently surfaced
    author: Option<String>,
    #[serde(default = "default_main")]
    main: String,
}

fn default_main() -> String {
    "main.js".to_string()
}

fn plugins_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("plugins");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 插件 id / 目录名白名单：只允许字母数字、`_`、`.`、`-`，且不得是 `.`/`..`。
/// 用于 `root.join(&id)` 前校验，杜绝 `id=".."` / `id="../../x"` 导致的
/// 任意目录删除/穿越（`uninstall_plugin` 此前可 `remove_dir_all` 整个应用数据目录）。
///
/// 另外拒掉「全是点」与「以点结尾」：Windows 会规范化结尾的点
/// （`...` / `foo.` 在磁盘上会落到与预期不同的名字），这类 id 没有合法用途。
fn is_safe_plugin_id(id: &str) -> bool {
    !id.is_empty()
        && id != "."
        && id != ".."
        && !id.chars().all(|c| c == '.')
        && !id.ends_with('.')
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
}

/// `manifest.main` 必须是**同级文件名**：不得含路径分隔符，也不得是 `.` / `..`。
///
/// 用「单一 `Component::Normal`」判定，而不是此前那句
/// `components().count() != 1`——那个写法两头都不对：
/// **误拒**常见的 `./main.js`（它有两个组件），**放行** `.` 与 `..`（它们各只有一个组件）。
fn is_bare_file_name(main: &str) -> bool {
    // 结尾的分隔符会被 Path 规范化掉（`sub/` 看起来就是一个组件），
    // 但它语义上是目录，直接按原文拒掉。
    if main.ends_with('/') || main.ends_with('\\') {
        return false;
    }
    let mut parts = Path::new(main)
        .components()
        .filter(|c| !matches!(c, Component::CurDir));
    matches!(parts.next(), Some(Component::Normal(_))) && parts.next().is_none()
}

fn read_manifest(dir: &Path) -> Result<Manifest, String> {
    let p = dir.join("manifest.json");
    let text = std::fs::read_to_string(&p).map_err(|e| format!("读取 manifest 失败: {e}"))?;
    let m: Manifest = serde_json::from_str(&text).map_err(|e| format!("manifest 解析失败: {e}"))?;
    let dirname = dir
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or_default();
    if m.id != dirname {
        return Err("manifest.id 必须等于目录名".to_string());
    }
    if !is_bare_file_name(&m.main) {
        return Err("manifest.main 必须是同级文件名（不得含路径分隔符，也不得是 . 或 ..）".to_string());
    }
    Ok(m)
}

fn load_plugin_source(dir: &Path, manifest: &Manifest) -> Result<String, String> {
    let p = dir.join(&manifest.main);
    if !p.exists() {
        return Err("插件入口文件不存在".to_string());
    }
    std::fs::read_to_string(&p).map_err(|e| format!("读取插件失败: {e}"))
}

// ---------------------------------------------------------------------------
// Boa runtime (restricted)
// ---------------------------------------------------------------------------

const BOOTSTRAP: &str = r#"
var __cmds = {};
function register(cmd){ if(cmd && cmd.id){ __cmds[cmd.id] = cmd; } }
// 把已注册命令的元数据交回宿主（discovery 用）。走 JSON 而不是「注册时回调宿主」，
// 是为了让命令对象只活在 JS 里，宿主不持有它；顺带 closeOnRun 能保持真正的布尔值。
function __describe(){
  var out = [];
  for (var k in __cmds) {
    var c = __cmds[k];
    out.push({
      id: String(c.id),
      title: c.title === undefined ? "" : String(c.title),
      description: c.description === undefined ? "" : String(c.description),
      closeOnRun: c.closeOnRun === true
    });
  }
  return JSON.stringify(out);
}
function __run(id){
  var c = __cmds[id];
  if(!c) return "__plugin: 命令不存在";
  try {
    var res = c.run();
    return res === undefined ? "" : String(res);
  } catch(e) {
    return "__plugin: 执行出错 " + e;
  }
}
"#;

// ---------------------------------------------------------------------------
// 执行预算
// ---------------------------------------------------------------------------

/// 单次命令执行的循环迭代预算。
///
/// ⚠️ 这个值**不只是 CPU 预算，同时是「分配循环」的实际内存上限**：
/// 峰值 ≈ 迭代次数 × 每次迭代分配字节。1e6 次 ≈ 最坏几十 MB 量级；
/// 刻意不取 1e7 —— 那允许 GB 级累积分配，而 Boa **没有堆上限 API**
/// （已核实 0.21.1 与最新 0.22.0 均无，见
/// `docs/plans/2026-09-10-plugin-evolution-plan.md` §3.11）。
/// 调大之前请先读那一节。
const RUN_LOOP_LIMIT: u64 = 1_000_000;

/// 插件顶层代码（发现 / 注册）的循环预算：正常插件顶层几乎没有循环。
const DISCOVER_LOOP_LIMIT: u64 = 100_000;

/// 单次命令执行的墙钟上限。
const RUN_TIMEOUT: Duration = Duration::from_secs(5);

/// 发现（跑插件顶层代码）的墙钟上限。
/// 此前 discovery **完全没有超时**，一个顶层死循环就能让 `list_plugins` 永不返回。
const DISCOVER_TIMEOUT: Duration = Duration::from_secs(3);

/// 建一个带预算的插件上下文。
///
/// 所有执行插件代码的地方都必须走这里，**不要直接 `Context::default()`** ——
/// 那等于循环迭代无上限（Boa 默认 `loop_iteration = u64::MAX`）。
fn plugin_context(loop_limit: u64) -> Context {
    let mut ctx = Context::default();
    let mut limits = RuntimeLimits::default();
    limits.set_loop_iteration_limit(loop_limit);
    // Boa 默认递归 512 / 栈 10KB 本来就有界；这里把递归收紧到更贴近插件实际需要的量。
    limits.set_recursion_limit(256);
    ctx.set_runtime_limits(limits);
    ctx
}

/// 把一段「跑插件代码」的闭包丢进独立线程并加墙钟超时。
///
/// ⚠️ 已知边界（诚实记账，不在本档解决）：超时后**只是遗弃那个线程**——
/// Boa 没有中断/取消 API，无法真正终止它，线程会继续跑到自己结束。
/// 彻底方案是宿主子进程化（M11.13）。这里的价值是**主线程不被无限占用**。
fn with_timeout<T, F>(timeout: Duration, what: &str, f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("plugin-run".to_string())
        .spawn(move || {
            // 内存预算只武装在本线程上（其它线程不受影响）。超预算时分配器会
            // panic —— 这里捕获它并转成一条干净错误，而不是让 abort 带走整个应用。
            // 依据见 `plugin_budget` 模块头注释（stable Rust 下返回 null 会 abort）。
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                crate::plugin_budget::with_budget(crate::plugin_budget::PLUGIN_ALLOC_BUDGET, f)
            }));
            let res = match outcome {
                Ok(r) => r,
                Err(payload) => {
                    let over_budget = payload
                        .downcast_ref::<&str>()
                        .is_some_and(|s| *s == crate::plugin_budget::BUDGET_PANIC);
                    Err(if over_budget {
                        format!(
                            "插件超出内存预算（{} MiB）",
                            crate::plugin_budget::PLUGIN_ALLOC_BUDGET / (1024 * 1024)
                        )
                    } else {
                        "插件线程 panic（引擎内部错误）".to_string()
                    })
                }
            };
            let _ = tx.send(res);
        })
        .map_err(|e| format!("插件线程启动失败: {e}"))?;

    match rx.recv_timeout(timeout) {
        Ok(r) => r,
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            Err(format!("{what}超时（>{:?}）", timeout))
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            Err("插件线程异常退出".to_string())
        }
    }
}


fn host_get_current_page(
    _this: &JsValue,
    _args: &[JsValue],
    _ctx: &mut Context,
) -> boa_engine::JsResult<JsValue> {
    let json = RUN_STATE.with(|s| s.borrow().current_page_json.clone());
    Ok(JsString::from(json).into())
}

fn host_page_count(
    _this: &JsValue,
    _args: &[JsValue],
    _ctx: &mut Context,
) -> boa_engine::JsResult<JsValue> {
    let n = RUN_STATE.with(|s| s.borrow().page_count);
    Ok(JsValue::from(n as i64))
}

/// 取第 `idx` 个参数并转成 Rust 字符串（类型不符/缺失一律当空串）。
fn js_string_arg(args: &[JsValue], idx: usize) -> String {
    args.get(idx)
        .and_then(|v| v.as_string())
        .map(|s| s.to_std_string_escaped())
        .unwrap_or_default()
}

/// `__toast(msg)`：插件给用户的一句提示。
///
/// 现在**真的能到用户眼前**：提示随本次调用结果回传前端、由前端弹 toast，
/// 同时进日志环形缓冲供作者侧排查。此前只 `eprintln!`，用户完全看不到。
fn host_toast(
    _this: &JsValue,
    args: &[JsValue],
    _ctx: &mut Context,
) -> boa_engine::JsResult<JsValue> {
    let msg = js_string_arg(args, 0);
    if !msg.is_empty() {
        let pid = RUN_STATE.with(|s| s.borrow().plugin_id.clone());
        push_log(&pid, "info", &msg);
        RUN_STATE.with(|s| s.borrow_mut().toasts.push(msg));
    }
    Ok(JsValue::undefined())
}

/// `__log(level, msg)`：作者侧日志。
///
/// 必要性：插件的运行时**连 `console` 都没有**（`boa_engine` 0.21 不含 console
/// 对象，它只在 `boa_runtime` 里），此前作者在沙箱里没有任何打日志的手段，
/// 排错只能靠猜。日志进环形缓冲，可在插件面板里查看。
fn host_log(
    _this: &JsValue,
    args: &[JsValue],
    _ctx: &mut Context,
) -> boa_engine::JsResult<JsValue> {
    let level = js_string_arg(args, 0);
    let msg = js_string_arg(args, 1);
    let pid = RUN_STATE.with(|s| s.borrow().plugin_id.clone());
    let level = if level.is_empty() { "info" } else { level.as_str() };
    push_log(&pid, level, &msg);
    Ok(JsValue::undefined())
}

// `__insert(text)`: request the plugin's text be inserted into the current page.
fn host_insert(
    _this: &JsValue,
    args: &[JsValue],
    _ctx: &mut Context,
) -> boa_engine::JsResult<JsValue> {
    let text = js_string_arg(args, 0);
    if !text.is_empty() {
        RUN_STATE.with(|s| s.borrow_mut().insert_text.push_str(&text));
    }
    Ok(JsValue::undefined())
}

/// Run a plugin's `main.js` and collect the registered command metadata.
fn discover_commands(source: &str, state: &RunState) -> Result<Vec<PluginCommandMeta>, String> {
    let mut ctx = plugin_context(DISCOVER_LOOP_LIMIT);
    set_run_state(&mut ctx, state)?;
    ctx.eval(Source::from_bytes(BOOTSTRAP.as_bytes()))
        .map_err(|e| format!("bootstrap 失败: {e}"))?;
    ctx.eval(Source::from_bytes(source.as_bytes()))
        .map_err(|e| format!("插件初始化失败: {e}"))?;
    // 命令元数据由 BOOTSTRAP 的 `__describe()` 以 JSON 形式交回。
    // 此前是「宿主也注册一个 register 全局」靠回调收集——那个全局会被 BOOTSTRAP 里
    // 同名的 JS `function register` 覆盖，导致 discovery **一直返回空数组**：
    // 插件能装、能启停，但命令永远不出现在命令面板里（等于装了用不了）。
    let described = ctx
        .eval(Source::from_bytes(b"__describe()".as_slice()))
        .map_err(|e| format!("读取命令列表失败: {e}"))?
        .to_string(&mut ctx)
        .map_err(|e| e.to_string())?
        .to_std_string_escaped();
    let cmds: Vec<PluginCommandMeta> = serde_json::from_str(&described)
        .map_err(|e| format!("命令元数据解析失败: {e}"))?;
    Ok(cmds)
}

/// 带墙钟超时的 discovery：插件顶层代码跑在独立线程里，超时不再挂住调用方。
fn discover_commands_timed(
    plugin_id: &str,
    source: &str,
    timeout: Duration,
) -> Result<Vec<PluginCommandMeta>, String> {
    let src = source.to_string();
    let pid = plugin_id.to_string();
    with_timeout(timeout, "插件加载", move || {
        discover_commands(
            &src,
            &RunState {
                plugin_id: pid,
                ..Default::default()
            },
        )
    })
}

fn set_run_state(ctx: &mut Context, state: &RunState) -> Result<(), String> {
    ctx.register_global_callable(
        JsString::from("__get_current_page"),
        0,
        NativeFunction::from_fn_ptr(host_get_current_page),
    )
    .map_err(|e| e.to_string())?;
    ctx.register_global_callable(
        JsString::from("__pages"),
        0,
        NativeFunction::from_fn_ptr(host_page_count),
    )
    .map_err(|e| e.to_string())?;
    ctx.register_global_callable(
        JsString::from("__toast"),
        1,
        NativeFunction::from_fn_ptr(host_toast),
    )
    .map_err(|e| e.to_string())?;
    ctx.register_global_callable(
        JsString::from("__insert"),
        1,
        NativeFunction::from_fn_ptr(host_insert),
    )
    .map_err(|e| e.to_string())?;
    // `__log(level, msg)`：作者侧日志（插件运行时没有 console，见 host_log）。
    ctx.register_global_callable(
        JsString::from("__log"),
        2,
        NativeFunction::from_fn_ptr(host_log),
    )
    .map_err(|e| e.to_string())?;
    RUN_STATE.with(|s| {
        *s.borrow_mut() = RunState {
            plugin_id: state.plugin_id.clone(),
            current_page_json: state.current_page_json.clone(),
            page_count: state.page_count,
            insert_text: String::new(),
            toasts: Vec::new(),
        }
    });
    Ok(())
}

/// Execute a single plugin command in a fresh boa context (re-evaluate the
/// plugin, then run the command). Returns the command's result string.
fn run_command(source: &str, command_id: &str, state: &RunState) -> Result<String, String> {
    let mut ctx = plugin_context(RUN_LOOP_LIMIT);
    set_run_state(&mut ctx, state)?;
    ctx.eval(Source::from_bytes(BOOTSTRAP.as_bytes()))
        .map_err(|e| format!("bootstrap 失败: {e}"))?;
    ctx.eval(Source::from_bytes(source.as_bytes()))
        .map_err(|e| format!("插件初始化失败: {e}"))?;
    // __run('<id>') — Rust `{:?}` yields a quoted, escaped JS string literal.
    let expr = format!("__run({:?})", command_id);
    let value = ctx
        .eval(Source::from_bytes(expr.as_bytes()))
        .map_err(|e| format!("命令执行失败: {e}"))?;
    if value.is_undefined() || value.is_null() {
        return Ok(String::new());
    }
    let s = value.to_string(&mut ctx).map_err(|e| e.to_string())?;
    Ok(s.to_std_string_escaped())
}

/// 带超时的插件命令执行：把 JS 运行放到独立线程，主线程 `recv_timeout`。
///
/// 此前它是**同步执行且持有全局 DB 锁**，一个死循环插件会让整个应用命令面雪崩；
/// 现在锁已在执行前释放，且主线程最多等 `RUN_TIMEOUT`。
/// ⚠️ 超时只保证「主线程不再被占用」——被遗弃的线程本身停不下来（Boa 无中断 API，
/// 见 `with_timeout` 的说明与 M11.13）。
fn run_command_timeout(
    source: &str,
    command_id: &str,
    state: &RunState,
) -> Result<(String, String, Vec<String>), String> {
    let source = source.to_string();
    let command_id = command_id.to_string();
    // RunState 是纯数据（String/usize），可 move 进线程；RUN_STATE/thread_local
    // 会在该线程内由 set_run_state 正确重建。
    let state = RunState {
        plugin_id: state.plugin_id.clone(),
        current_page_json: state.current_page_json.clone(),
        page_count: state.page_count,
        insert_text: String::new(),
        toasts: Vec::new(),
    };
    with_timeout(RUN_TIMEOUT, "插件执行", move || {
        let msg = run_command(&source, &command_id, &state)?;
        let (insert, toasts) = RUN_STATE.with(|s| {
            let st = s.borrow();
            (st.insert_text.clone(), st.toasts.clone())
        });
        Ok((msg, insert, toasts))
    })
}

// ---------------------------------------------------------------------------
// DB helpers for enabled state
// ---------------------------------------------------------------------------

fn conn<'a>(db: &'a State<'_, Db>) -> MutexGuard<'a, Connection> {
    // 不让 poison 变成"整个插件面板永久打不开"：锁被 poison 说明此前有个
    // 持锁 panic，但连接本身仍可用，取回内层数据继续用即可。
    db.0.lock().unwrap_or_else(|e| e.into_inner())
}

/// 播种标记文件名：`<plugins>/.demo-seeded`。
///
/// 用「标记文件」而不是「看 demo 目录在不在」，是为了让用户**真的能把示例插件卸掉**——
/// 此前卸载 `demo` 后每次启动都会被原样复活，等于一个删不掉的插件。
const DEMO_SEED_MARKER: &str = ".demo-seeded";

/// Seed a bundled demo plugin on first run so `list_plugins` / `run_plugin_command`
/// have something to discover and execute (idempotent, **once ever**).
pub fn ensure_demo_plugin(app: &AppHandle) -> Result<(), String> {
    let root = plugins_root(app)?;
    let marker = root.join(DEMO_SEED_MARKER);
    let dir = root.join("demo");

    if marker.exists() {
        return Ok(()); // 已经播种过：即使用户把它卸了，也不再复活
    }
    if dir.join("main.js").exists() {
        // 已有手放的 demo（老版本或用户自己）：只补标记，不覆盖内容。
        std::fs::write(&marker, b"1").map_err(|e| e.to_string())?;
        return Ok(());
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(
        dir.join("manifest.json"),
        r#"{"id":"demo","name":"示例插件","version":"0.1.0","description":"ShuyoNote 示例插件","main":"main.js"}"#,
    )
    .map_err(|e| e.to_string())?;
    std::fs::write(
        dir.join("main.js"),
        r#"
register({ id: "demo.hello", title: "你好", description: "示例命令", closeOnRun: false, run: function(){ return "你好，ShuyoNote！页面数=" + __pages(); } });
register({ id: "demo.toast", title: "提示", description: "调用 toast", closeOnRun: false, run: function(){ __toast("来自示例插件的提示"); return "已调用 toast"; } });
register({ id: "demo.insert", title: "插入文本", description: "把一段文本插入到当前页面", closeOnRun: false, run: function(){ __insert("由示例插件插入的一段文本。"); return "已请求插入文本"; } });
"#,
    )
    .map_err(|e| e.to_string())?;
    std::fs::write(&marker, b"1").map_err(|e| e.to_string())?;
    Ok(())
}

fn enabled_key(id: &str) -> String {
    format!("plugin_enabled::{id}")
}

fn enabled(c: &Connection, id: &str) -> bool {
    c.query_row(
        "SELECT value FROM meta.plugin_state WHERE key = ?1",
        params![enabled_key(id)],
        |r| r.get::<_, String>(0),
    )
    .map(|v| v == "1")
    .unwrap_or(true) // default enabled
}

fn set_enabled(c: &Connection, id: &str, on: bool) -> Result<(), String> {
    c.execute(
        "INSERT INTO meta.plugin_state (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![enabled_key(id), if on { "1" } else { "0" }],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 卸载时清掉启停状态行。
///
/// 此前卸载只删目录、不删这一行，于是**重装同一个 id 会静默继承旧的「已禁用」**，
/// 而且残留行永远没人回收（`plugin_state` 里此前没有任何 `DELETE`）。
fn clear_enabled(c: &Connection, id: &str) -> Result<(), String> {
    c.execute(
        "DELETE FROM meta.plugin_state WHERE key = ?1",
        params![enabled_key(id)],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_plugins(app: AppHandle, db: State<'_, Db>) -> Result<Vec<PluginMeta>, String> {
    let root = plugins_root(&app)?;
    // 先在锁内取各插件的 enabled 状态，随后立即释放锁（drop c），再在锁外
    // 执行 discover_commands（跑插件顶层 JS）——避免一个坏插件的顶层代码
    // 无限占用全局 DB 锁。
    let mut enabled_map: std::collections::HashMap<String, bool> = Default::default();
    {
        let c = conn(&db);
        let entries = std::fs::read_dir(&root).map_err(|e| e.to_string())?;
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if let Ok(m) = read_manifest(&path) {
                enabled_map.insert(m.id.clone(), enabled(&c, &m.id));
            }
        }
    }

    let mut out = Vec::new();
    let entries = std::fs::read_dir(&root).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let manifest = match read_manifest(&path) {
            Ok(m) => m,
            Err(_) => continue, // skip invalid dirs
        };
        let source = match load_plugin_source(&path, &manifest) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let commands = discover_commands_timed(&manifest.id, &source, DISCOVER_TIMEOUT)
            .unwrap_or_default();
        let pid = manifest.id.clone();
        out.push(PluginMeta {
            id: pid.clone(),
            name: manifest.name,
            version: manifest.version,
            description: manifest.description,
            enabled: enabled_map.get(&pid).copied().unwrap_or(false),
            commands,
        });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

#[tauri::command]
pub fn set_plugin_enabled(db: State<Db>, id: String, enabled: bool) -> Result<(), String> {
    if !is_safe_plugin_id(&id) {
        return Err("非法插件 id".to_string());
    }
    let c = conn(&db);
    set_enabled(&c, &id, enabled)
}

#[tauri::command]
pub async fn run_plugin_command(
    app: AppHandle,
    db: State<'_, Db>,
    plugin_id: String,
    command_id: String,
    current_id: Option<String>,
) -> Result<PluginRunResult, String> {
    if !is_safe_plugin_id(&plugin_id) {
        return Err("非法插件 id".to_string());
    }
    let root = plugins_root(&app)?;
    let dir = root.join(&plugin_id);
    let manifest = read_manifest(&dir)?;
    let source = load_plugin_source(&dir, &manifest)?;
    // 读 DB 的数据在锁内取出，之后立即释放锁（drop c），再把 JS 执行放到
    // 独立线程 + 超时 —— 避免一个死循环插件无限占住全局 DB 锁（全应用雪崩）。
    let (page_count, current_page_json) = {
        let c = conn(&db);
        // 「禁用」必须在后端强制，不能只靠前端从命令面板里过滤掉：
        // 否则被禁用的插件仍然可以被 IPC 直接调用执行。
        if !enabled(&c, &plugin_id) {
            return Err(format!("插件「{plugin_id}」已被禁用"));
        }
        let page_count: usize = c
            .query_row("SELECT COUNT(*) FROM pages WHERE deleted_at IS NULL", [], |r| {
                r.get::<_, i64>(0)
            })
            .map(|n| n as usize)
            .unwrap_or(0);
        let current_page_json = if let Some(id) = current_id {
            c.query_row(
                "SELECT content_json FROM pages WHERE id = ?1 AND deleted_at IS NULL",
                params![id],
                |r| r.get::<_, String>(0),
            )
            .unwrap_or_default()
        } else {
            String::new()
        };
        (page_count, current_page_json)
    };
    let state = RunState {
        plugin_id: plugin_id.clone(),
        page_count,
        current_page_json,
        insert_text: String::new(),
        toasts: Vec::new(),
    };
    let (message, insert, toasts) = run_command_timeout(&source, &command_id, &state)?;
    Ok(PluginRunResult {
        message: if message.is_empty() { "已执行".to_string() } else { message },
        insert: if insert.is_empty() { None } else { Some(insert) },
        toasts,
    })
}

fn copy_dir(src: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
        let from = entry.path();
        let to = dest.join(entry.file_name());
        if from.is_dir() {
            copy_dir(&from, &to)?;
        } else {
            std::fs::copy(&from, &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn uninstall_plugin(app: AppHandle, db: State<Db>, id: String) -> Result<(), String> {
    if !is_safe_plugin_id(&id) {
        return Err("非法插件 id".to_string());
    }
    let root = plugins_root(&app)?;
    let dir = root.join(&id);
    if !dir.is_dir() {
        return Err("插件不存在".to_string());
    }
    std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    // 删目录还不够：启停状态行也要清，否则重装同一个 id 会**静默继承**旧的「已禁用」，
    // 且残留行永远不会被回收。
    clear_enabled(&conn(&db), &id)?;
    Ok(())
}

#[tauri::command]
pub async fn install_plugin(app: AppHandle, source_path: String) -> Result<PluginMeta, String> {
    let src = PathBuf::from(&source_path);
    if !src.is_dir() {
        return Err("插件源目录不存在".to_string());
    }
    // 先把所有前置条件验完（含**入口文件真的能被加载**），再往盘上写。
    // 此前是「先 copy_dir 再 load_plugin_source」：一旦入口文件有问题，
    // 已经拷过去的目录会留下并占住这个 id，用户连重装都做不到（报"同名插件已存在"）。
    let manifest = read_manifest(&src)?;
    if !is_safe_plugin_id(&manifest.id) {
        return Err("非法插件 id（manifest.id）".to_string());
    }
    let source = load_plugin_source(&src, &manifest)?;
    // 顶层就死循环的插件不该被装进来：用带超时的 discovery 先跑一遍。
    let commands = discover_commands_timed(&manifest.id, &source, DISCOVER_TIMEOUT)?;

    let dest = plugins_root(&app)?.join(&manifest.id);
    if dest.exists() {
        return Err("同名插件已存在".to_string());
    }
    copy_dir(&src, &dest)?;
    // 拷贝后确认入口文件确实落到盘上；失败就把半残目录清掉，别留垃圾。
    if let Err(e) = load_plugin_source(&dest, &manifest) {
        let _ = std::fs::remove_dir_all(&dest);
        return Err(format!("安装失败（已回滚）：{e}"));
    }
    Ok(PluginMeta {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        enabled: true,
        commands,
    })
}

#[tauri::command]
pub fn open_plugin_dir(app: AppHandle) -> Result<String, String> {
    let root = plugins_root(&app)?;
    // 此前只有 Windows 分支，导致 macOS / Linux 上这个按钮点了完全没反应
    // （前端又丢掉了返回值，连路径都看不到）。三平台都给上。
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("explorer").arg(&root).spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(&root).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = std::process::Command::new("xdg-open").arg(&root).spawn();
    }
    Ok(root.to_string_lossy().to_string())
}

/// 读取插件日志（作者侧 `__log(...)` 与 `__toast(...)` 都会进这个环形缓冲）。
///
/// `plugin_id` 省略 = 全部插件；`limit` 省略 = 全量（上限即环形缓冲容量）。
/// 返回按时间正序，前端可直接顺序渲染。
#[tauri::command]
pub fn plugin_logs(plugin_id: Option<String>, limit: Option<usize>) -> Vec<PluginLogLine> {
    let all: Vec<PluginLogLine> = {
        let q = PLUGIN_LOGS.lock().unwrap_or_else(|e| e.into_inner());
        q.iter().cloned().collect()
    };
    let mut filtered: Vec<PluginLogLine> = all
        .into_iter()
        .filter(|l| plugin_id.as_deref().is_none_or(|p| l.plugin_id == p))
        .collect();
    let keep = limit.unwrap_or(PLUGIN_LOG_CAPACITY).min(PLUGIN_LOG_CAPACITY);
    if filtered.len() > keep {
        filtered.drain(0..filtered.len() - keep);
    }
    filtered
}

/// 清空插件日志。
#[tauri::command]
pub fn clear_plugin_logs() {
    PLUGIN_LOGS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runs_a_command_and_reads_page_count() {
        let source = r#"
register({ id: "t.hello", title: "Hello", description: "", closeOnRun: false,
  run: function(){ return "hi " + __pages(); } });
"#;
        let state = RunState { page_count: 7, ..Default::default() };
        let res = run_command(source, "t.hello", &state).unwrap();
        assert_eq!(res, "hi 7");
    }

    #[test]
    fn reports_missing_command() {
        let source = r#"register({ id: "t.hello", title: "Hello", description: "", closeOnRun: false, run: function(){ return "x"; } });"#;
        let state = RunState { page_count: 0, ..Default::default() };
        let res = run_command(source, "t.nope", &state).unwrap();
        assert!(res.contains("命令不存在"));
    }

    #[test]
    fn collect_insert_request_from_plugin() {
        // A plugin may call __insert(text) to request content be dropped into the page.
        let source = r#"
register({ id: "t.ins", title: "Insert", description: "", closeOnRun: false,
  run: function(){ __insert("hello from plugin"); return "ok"; } });
"#;
        let state = RunState { page_count: 0, ..Default::default() };
        let message = run_command(source, "t.ins", &state).unwrap();
        assert_eq!(message, "ok");
        let insert = RUN_STATE.with(|s| s.borrow().insert_text.clone());
        assert_eq!(insert, "hello from plugin");
    }

    // ---- 安全回归：沙箱的能力面必须仍然是"什么都不给" ----

    #[test]
    fn sandbox_exposes_no_host_capabilities() {
        // 这条是能力缺席的回归测试：任何一项变成 "不是 undefined"，
        // 都说明有人往宿主里加了能力，必须在这里先红掉。
        let source = r#"
register({ id: "t.probe", title: "P", description: "", closeOnRun: false,
  run: function(){
    var names = ["fetch","require","process","window","document","XMLHttpRequest",
                 "localStorage","sessionStorage","__TAURI__","invoke","setTimeout","setInterval"];
    var found = [];
    for (var i = 0; i < names.length; i++) {
      if (typeof globalThis[names[i]] !== "undefined") { found.push(names[i]); }
    }
    return found.length ? ("LEAK:" + found.join(",")) : "clean";
  } });
"#;
        let res = run_command(source, "t.probe", &RunState::default()).unwrap();
        assert_eq!(res, "clean", "沙箱里出现了宿主能力");
    }

    // ---- 循环 / 时间预算 ----

    #[test]
    fn infinite_loop_is_cut_off_by_the_loop_budget() {
        // 此前 RuntimeLimits 是默认值（loop_iteration = u64::MAX），死循环只能靠
        // 5s 墙钟兜底、且被遗弃的线程会一直占核。现在循环预算先把它截断。
        //
        // 注意实测行为：Boa 的 loop iteration 上限**不是** JS 层可 catch 的异常，
        // 它会让 `eval` 直接返回 Rust 层错误（所以插件 catch 不住、也不会被
        // `__run` 的 try/catch 吞掉），最终表现为一条可见的命令执行错误——正是我们要的。
        let source = r#"register({ id: "t.loop", title: "L", description: "", closeOnRun: false,
  run: function(){ while(true){} } });"#;
        let started = std::time::Instant::now();
        let err = run_command(source, "t.loop", &RunState::default())
            .expect_err("死循环应当被循环预算截断成错误，而不是正常返回");
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "循环预算没生效（跑到墙钟超时了）"
        );
        assert!(!err.is_empty(), "错误信息不应为空");
    }

    #[test]
    fn discovery_of_a_top_level_infinite_loop_fails_fast() {
        // 此前 discovery 完全没有超时：插件顶层写个 while(true) 就能让
        // list_plugins 永不返回（而那是同步命令，会占住调用线程）。
        let started = std::time::Instant::now();
        let res = discover_commands_timed("t.discover", "while(true){}", DISCOVER_TIMEOUT);
        assert!(res.is_err(), "顶层死循环应当失败而不是成功");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "应当很快失败（循环预算或墙钟超时），而不是无限挂住"
        );
    }

    #[test]
    fn with_timeout_reports_a_timeout_instead_of_blocking_forever() {
        let res: Result<(), String> =
            with_timeout(Duration::from_millis(50), "测试任务", || {
                std::thread::sleep(Duration::from_millis(600));
                Ok(())
            });
        let err = res.expect_err("超时应当返回错误");
        assert!(err.contains("超时"), "错误信息里应说明超时，实际: {err}");
    }

    #[test]
    fn with_timeout_passes_through_results_and_errors() {
        let ok: Result<u32, String> = with_timeout(RUN_TIMEOUT, "测试", || Ok(7));
        assert_eq!(ok.unwrap(), 7);
        let err: Result<u32, String> =
            with_timeout(RUN_TIMEOUT, "测试", || Err("插件初始化失败: boom".to_string()));
        assert!(err.unwrap_err().contains("boom"));
    }

    // ---- 标识与 manifest 校验矩阵 ----

    #[test]
    fn plugin_id_whitelist() {
        for good in ["demo", "a", "my-plugin", "plugin_1", "a.b", "x-y-z-9", "a..b"] {
            assert!(is_safe_plugin_id(good), "{good} 应当合法");
        }
        // 注意 `..-` 是**合法**的：`root.join("..-")` 只是名字里带点的普通目录，
        // 不构成穿越（穿越要求组件恰好是 `.` 或 `..`）。
        assert!(is_safe_plugin_id("..-"));
        for bad in ["", ".", "..", "...", "foo.", "a/b", "a\\b", "a b", "插件"] {
            assert!(!is_safe_plugin_id(bad), "{bad} 应当非法");
        }
    }

    #[test]
    fn manifest_main_must_be_a_bare_file_name() {
        // 同级文件名：接受
        for good in ["main.js", "./main.js", "index.js", "a.b.c.js"] {
            assert!(is_bare_file_name(good), "{good} 应当被接受");
        }
        // 目录 / 相对跳转 / 绝对路径 / 空：拒绝
        for bad in ["", ".", "..", "./", "sub/main.js", "../main.js", "a/../main.js", "/etc/passwd", "sub/"] {
            assert!(!is_bare_file_name(bad), "{bad} 应当被拒绝");
        }
    }

    #[test]
    fn read_manifest_accepts_dot_slash_and_rejects_escapes() {
        let base = temp_dir("manifest-matrix");

        // 合法：id 等于目录名；`./main.js` 是常见写法，此前被误拒
        let good = base.join("good");
        std::fs::create_dir_all(&good).unwrap();
        std::fs::write(
            good.join("manifest.json"),
            serde_json::json!({ "id": "good", "name": "G", "main": "./main.js" }).to_string(),
        )
        .unwrap();
        assert!(read_manifest(&good).is_ok(), "./main.js 应当被接受");

        // id 与目录名不一致
        let mismatch = base.join("real-dir");
        std::fs::create_dir_all(&mismatch).unwrap();
        std::fs::write(
            mismatch.join("manifest.json"),
            serde_json::json!({ "id": "other", "name": "O", "main": "main.js" }).to_string(),
        )
        .unwrap();
        assert!(read_manifest(&mismatch).is_err(), "id 必须等于目录名");

        // main 想跑出目录：`.` / `..` 此前恰好只有一个路径组件，会被放行
        for (i, bad) in ["..", ".", "sub/main.js", "../main.js"].iter().enumerate() {
            let d = base.join(format!("bad{i}"));
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(
                d.join("manifest.json"),
                serde_json::json!({ "id": format!("bad{i}"), "name": "B", "main": bad })
                    .to_string(),
            )
            .unwrap();
            assert!(read_manifest(&d).is_err(), "main={bad} 应当被拒绝");
        }

        let _ = std::fs::remove_dir_all(&base);
    }

    // ---- 启停状态：往返 + 卸载清理 ----

    /// 只带 `meta.plugin_state` 的内存库（真实 SQL，含 `meta.` 限定名）。
    fn state_conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "ATTACH DATABASE ':memory:' AS meta;
             CREATE TABLE meta.plugin_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )
        .unwrap();
        c
    }

    #[test]
    fn enabled_state_defaults_on_and_round_trips() {
        let c = state_conn();
        assert!(enabled(&c, "p1"), "没有行时默认启用");

        set_enabled(&c, "p1", false).unwrap();
        assert!(!enabled(&c, "p1"));
        set_enabled(&c, "p1", true).unwrap();
        assert!(enabled(&c, "p1"));
    }

    #[test]
    fn uninstall_clears_enabled_state_so_reinstall_is_not_poisoned() {
        let c = state_conn();
        // 用户禁用了插件，然后卸载
        set_enabled(&c, "p1", false).unwrap();
        clear_enabled(&c, "p1").unwrap();

        // 重装后必须回到"默认启用"，而不是静默继承旧的已禁用
        assert!(enabled(&c, "p1"), "卸载后残留状态会让重装继承旧的已禁用");

        let left: i64 = c
            .query_row("SELECT COUNT(*) FROM meta.plugin_state", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0, "卸载不应留下任何状态行");
    }

    // ---- 探针：discovery 是否真的发现了命令 ----

    #[test]
    fn discovery_actually_finds_registered_commands() {
        let source = r#"
register({ id: "d.one", title: "One", description: "第一", closeOnRun: false, run: function(){ return "1"; } });
register({ id: "d.two", title: "Two", description: "第二", closeOnRun: true, run: function(){ return "2"; } });
"#;
        let cmds = discover_commands(source, &RunState::default()).unwrap();
        let ids: Vec<&str> = cmds.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, vec!["d.one", "d.two"], "discovery 必须真的把命令收集出来");
        assert_eq!(cmds[1].title, "Two");
        assert_eq!(cmds[1].description, "第二");
        // closeOnRun 此前是死字段：宿主版 register 用 as_string() == "true" 解析布尔，
        // 永远是 false。现在由 JS 的 __describe() 给出真布尔值。
        assert!(!cmds[0].close_on_run);
        assert!(cmds[1].close_on_run, "closeOnRun: true 必须被解析出来");
    }

    // ---- 内存预算（分配炸弹） ----

    #[test]
    fn alloc_bomb_only_kills_that_invocation() {
        // Boa 侧设不了内存上限（无堆 API），所以由插件线程的限流分配器兜：
        // 一次要 100 MB（> 64 MiB 预算）应当被截断。`repeat` 的保护是
        // MAX_STRING_LENGTH ≈ 4 GB 的"规范形状"保护，不是预算，所以拦不住这个。
        let bomb = r#"register({ id: "t.bomb", title: "B", description: "", closeOnRun: false,
  run: function(){ return "x".repeat(1e8); } });"#;
        let err = run_command_timeout(bomb, "t.bomb", &RunState::default())
            .expect_err("分配炸弹应当失败而不是正常返回");
        assert!(
            err.contains("内存预算"),
            "应当报内存预算超限（说明是分配器拦下的），实际: {err}"
        );

        // 关键性质：**只终结这一次调用**。新调用是新线程 + 新预算，照常工作
        // ——能跑到这里就说明进程没有被 abort 掉。
        let ok = r#"register({ id: "t.ok", title: "O", description: "", closeOnRun: false,
  run: function(){ return "fine"; } });"#;
        let (msg, _, _) = run_command_timeout(ok, "t.ok", &RunState::default()).unwrap();
        assert_eq!(msg, "fine");
    }

    // ---- 插件日志 / __toast 接通 UI ----

    /// 日志是**进程级**环形缓冲，测试并行跑会互相踩；与日志相关的测试统一串行。
    static LOG_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn log_test_guard() -> std::sync::MutexGuard<'static, ()> {
        LOG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn toast_is_returned_to_the_caller_and_logged() {
        let _g = log_test_guard();
        clear_plugin_logs();
        // 此前 __toast 只 eprintln，用户完全看不到；现在随结果回传前端。
        let source = r#"register({ id: "t.toast", title: "T", description: "", closeOnRun: false,
  run: function(){ __toast("你好"); return "done"; } });"#;
        let state = RunState {
            plugin_id: "tp".to_string(),
            ..Default::default()
        };
        let (msg, _insert, toasts) = run_command_timeout(source, "t.toast", &state).unwrap();
        assert_eq!(msg, "done");
        assert_eq!(
            toasts,
            vec!["你好".to_string()],
            "__toast 必须随结果回传给前端，否则用户还是看不到"
        );
        let logs = plugin_logs(Some("tp".to_string()), None);
        assert!(
            logs.iter().any(|l| l.message == "你好" && l.plugin_id == "tp"),
            "__toast 也应进日志环形缓冲"
        );
    }

    #[test]
    fn plugin_log_goes_to_the_ring_buffer_with_level() {
        let _g = log_test_guard();
        clear_plugin_logs();
        // 插件运行时没有 console（boa_engine 不含 console 对象），__log 是作者唯一手段。
        let source = r#"register({ id: "t.log", title: "L", description: "", closeOnRun: false,
  run: function(){ __log("warn", "注意"); __log("", "默认级别"); return "ok"; } });"#;
        let state = RunState {
            plugin_id: "tlog".to_string(),
            ..Default::default()
        };
        run_command_timeout(source, "t.log", &state).unwrap();
        let logs = plugin_logs(Some("tlog".to_string()), None);
        assert!(logs.iter().any(|l| l.level == "warn" && l.message == "注意"));
        assert!(
            logs.iter().any(|l| l.level == "info" && l.message == "默认级别"),
            "空 level 应当归一为 info"
        );
    }

    #[test]
    fn plugin_logs_are_capped_filterable_and_clearable() {
        let _g = log_test_guard();
        clear_plugin_logs();
        for i in 0..(PLUGIN_LOG_CAPACITY + 10) {
            push_log("cap", "info", &format!("line-{i}"));
        }
        let all = plugin_logs(None, None);
        assert_eq!(all.len(), PLUGIN_LOG_CAPACITY, "环形缓冲必须封顶");
        assert_eq!(
            all.last().unwrap().message,
            format!("line-{}", PLUGIN_LOG_CAPACITY + 9),
            "保留的应当是最新的那批"
        );

        let tail = plugin_logs(Some("cap".to_string()), Some(3));
        assert_eq!(tail.len(), 3, "limit 应当生效");
        assert_eq!(tail.last().unwrap().message, format!("line-{}", PLUGIN_LOG_CAPACITY + 9));

        assert!(plugin_logs(Some("别的插件".to_string()), None).is_empty(), "按插件过滤应当生效");
        clear_plugin_logs();
        assert!(plugin_logs(None, None).is_empty());
    }

    // ---- 工具 ----

    /// 建一个本次测试专属的临时目录（带进程号 + 时间戳，避免并发/残留互相干扰）。
    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "shuyonote-plugin-test-{}-{tag}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
