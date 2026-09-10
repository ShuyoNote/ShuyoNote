use crate::capabilities_gen;
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
    /// 这个插件要哪些权限、为什么 —— 直接摊给用户看（「用户敢装」的前提）。
    pub permissions: Vec<PluginPermissionMeta>,
    /// 是否走了「老 manifest 无 permissions」的基线授权（界面需要如实标注）。
    pub permissions_baseline: bool,
}

/// 一条权限的展示形态：id + 人类可读标题 + 插件自己给的理由。
#[derive(Serialize, Clone)]
pub struct PluginPermissionMeta {
    pub id: String,
    pub title: String,
    pub reason: String,
    pub risk: String,
}

/// 把 manifest 的权限声明整理成给用户看的清单。
fn permission_metas(manifest: &Manifest) -> (Vec<PluginPermissionMeta>, bool) {
    let baseline = manifest.permissions.is_none();
    let (granted, _) = resolve_permissions(manifest);
    let reasons: std::collections::HashMap<&str, &str> = manifest
        .permissions
        .as_ref()
        .map(|ds| ds.iter().map(|d| (d.id.as_str(), d.reason.as_str())).collect())
        .unwrap_or_default();
    let metas = granted
        .iter()
        .map(|id| {
            let p = capabilities_gen::permission(id);
            PluginPermissionMeta {
                id: id.clone(),
                title: p.map(|p| p.title.to_string()).unwrap_or_else(|| id.clone()),
                reason: if baseline {
                    "（旧 manifest 未声明权限，按 v1 基线授权）".to_string()
                } else {
                    reasons.get(id.as_str()).copied().unwrap_or_default().to_string()
                },
                risk: p.map(|p| p.risk.to_string()).unwrap_or_default(),
            }
        })
        .collect();
    (metas, baseline)
}

// The `__od` host object methods read the current invocation from here.
thread_local! {
    static RUN_STATE: RefCell<RunState> = RefCell::new(RunState::default());
}
#[derive(Default, Clone)]
struct RunState {
    /// 当前调用属于哪个插件（用于把日志/提示归因到插件）。
    plugin_id: String,
    current_page_json: String,
    page_count: usize,
    /// Text a plugin requested to insert at the cursor via `__insert(...)`.
    insert_text: String,
    /// 本次执行被授权的权限（来自 manifest.permissions；老 manifest 走基线授权）。
    permissions: Vec<String>,
    /// 当前打开的页面 id（`api.backlinks.list()` / `api.files.list()` 省略参数时用它）。
    current_page_id: Option<String>,
    /// 数据能力的读取目标：**活动空间** id（由主线程解析后传入）。
    read_space: Option<String>,
    /// 显式 app 数据目录。生产为 None（用全局目录）；测试注入临时目录用。
    read_dir: Option<PathBuf>,
    /// 写能力产出的草稿：**随结果回传前端**，用户确认后才落库（方案 §3.5 的写中介）。
    drafts: Vec<PluginDraft>,
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
    /// 写能力产出的草稿：**还没落库**，等用户在界面上确认。
    pub drafts: Vec<PluginDraft>,
}

/// 插件写能力产出的一条草稿。
///
/// 复用前端既有的「草稿 → 确认 → 落库」链路（`src/lib/ai/apply.ts` 的 `applyDraft`），
/// 所以载荷形状与 AI 工具层一致——**不为插件再造一套确认机制**。
#[derive(Serialize, Clone, Debug)]
pub struct PluginDraft {
    /// 去重键（同一插件同一次执行里 key 相同的草稿只保留一条）。
    pub key: String,
    /// 给用户看的一句话（"新建页面「X」"/"向「Y」追加内容"）。
    pub summary: String,
    /// `applyDraft` 认识的原样载荷。
    pub payload: serde_json::Value,
}

/// 一条能力调用审计记录（方案 §3.10）。
///
/// **只记元数据，不记内容**：哪个插件、调了哪个能力、什么 scope、什么时候、成没成。
/// 「用户敢装」需要证据链——出问题时能查到"这个插件用过哪些权限、被拒过几次"，
/// 而权限被拒的记录恰恰是最该留的那部分。
#[derive(Serialize, Clone)]
pub struct PluginAuditEntry {
    pub plugin_id: String,
    pub capability: String,
    pub scope: String,
    pub at_ms: i64,
    pub ok: bool,
    /// 失败时的错误码前缀（permission_denied / unknown_capability / bad_args …）。
    pub error_code: Option<String>,
}

/// 审计环形缓冲容量。内存里留最近这些，足够复盘一次会话里的行为。
const PLUGIN_AUDIT_CAPACITY: usize = 500;

static PLUGIN_AUDIT: std::sync::Mutex<std::collections::VecDeque<PluginAuditEntry>> =
    std::sync::Mutex::new(std::collections::VecDeque::new());

fn error_code_of(msg: &str) -> Option<String> {
    let code = msg.split(':').next().unwrap_or("").trim();
    if code.is_empty() || code.contains(' ') {
        None
    } else {
        Some(code.to_string())
    }
}

fn push_audit(plugin_id: &str, capability: &str, scope: &str, ok: bool, error_code: Option<String>) {
    let mut q = PLUGIN_AUDIT.lock().unwrap_or_else(|e| e.into_inner());
    if q.len() >= PLUGIN_AUDIT_CAPACITY {
        q.pop_front();
    }
    q.push_back(PluginAuditEntry {
        plugin_id: plugin_id.to_string(),
        capability: capability.to_string(),
        scope: scope.to_string(),
        at_ms: now_ms(),
        ok,
        error_code,
    });
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

#[derive(serde::Deserialize, Debug)]
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
    /// 插件针对的 API 版本（如 `"1.0.0"`）。缺省按当前版本处理并记一条警告。
    #[serde(default, rename = "apiVersion")]
    api_version: Option<String>,
    /// 逐条声明的权限，带理由。缺省 = 走 v1 基线授权（见 resolve_permissions）。
    #[serde(default)]
    permissions: Option<Vec<PermissionDecl>>,
}

#[derive(serde::Deserialize, Clone, Debug)]
struct PermissionDecl {
    id: String,
    #[serde(default)]
    reason: String,
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
    // ABI 闸门：主版本不认识就直接拒载，而不是让插件在运行时零零碎碎地失败。
    if let Some(v) = &m.api_version {
        let major = v.split('.').next().unwrap_or_default().parse::<u32>().unwrap_or(0);
        if major != capabilities_gen::API_MAJOR {
            return Err(format!(
                "插件 API 主版本不受支持：manifest.apiVersion={v}，本应用支持 {}",
                capabilities_gen::API_VERSION
            ));
        }
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

/// 插件看到的 `api.*`（由 capabilities/capabilities.json 生成）。
/// 宿主只认 `__cap(method, argsJson)` 一个原语，换引擎/加传输都不破坏插件（方案 §3.3）。
const API_SHIM: &str = include_str!("../../capabilities/plugin-api-shim.js");

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


/// 取第 `idx` 个参数并转成 Rust 字符串（类型不符/缺失一律当空串）。
fn js_string_arg(args: &[JsValue], idx: usize) -> String {
    args.get(idx)
        .and_then(|v| v.as_string())
        .map(|s| s.to_std_string_escaped())
        .unwrap_or_default()
}

/// `__toast(msg)`：插件给用户的一句提示。
///
/// `__log(level, msg)`：作者侧日志。
///
// `__insert(text)`: request the plugin's text be inserted into the current page.
// ---------------------------------------------------------------------------
// 能力派发：宿主能力面的**唯一入口**
// ---------------------------------------------------------------------------

/// v1 基线权限：给「没有 permissions 字段的老 manifest」用，避免升级即失效。
fn baseline_permissions() -> Vec<String> {
    capabilities_gen::permission_ids().iter().map(|s| s.to_string()).collect()
}

/// 解析 manifest 的能力授权，并给出要记录给用户的警告。
///
///   - 没有 `permissions` 字段 → v1 基线授权 + 警告（老插件兼容）；
///   - 声明了但引用了本版本不认识的权限 → 忽略该条 + 警告（前向兼容）；
///   - 声明了权限但没写 `reason` → 警告（用户看不到它为什么要这项权限）。
fn resolve_permissions(manifest: &Manifest) -> (Vec<String>, Vec<String>) {
    let mut warnings = Vec::new();
    if manifest.api_version.is_none() {
        warnings.push(format!(
            "manifest 未声明 apiVersion：按 {} 处理（建议显式声明）",
            capabilities_gen::API_VERSION
        ));
    }
    match &manifest.permissions {
        None => {
            warnings.push(
                "manifest 未声明 permissions：按 v1 基线权限授权（新插件请显式声明）".to_string(),
            );
            (baseline_permissions(), warnings)
        }
        Some(decls) => {
            let mut granted: Vec<String> = Vec::new();
            for d in decls {
                if capabilities_gen::permission(&d.id).is_some() {
                    if d.reason.trim().is_empty() {
                        warnings.push(format!(
                            "权限 {} 没有写 reason（用户看不到它为什么要这项权限）",
                            d.id
                        ));
                    }
                    if !granted.contains(&d.id) {
                        granted.push(d.id.clone());
                    }
                } else {
                    warnings.push(format!("忽略未知权限 {}（当前 API 版本不认识它）", d.id));
                }
            }
            (granted, warnings)
        }
    }
}

thread_local! {
    /// 插件线程内的一次性读连接（**惰性**打开，随线程结束释放）。
    /// 插件线程没有 `State<Db>`，所以数据能力自己开一条连接：`open_space_conn` 已经
    /// 处理好 E1 加密（PRAGMA key）、WAL、meta attach 与建表迁移。
    static READ_CONN: RefCell<Option<Connection>> = const { RefCell::new(None) };
}

/// 把打开空间库的失败映射成**稳定错误码**（作者能据此分支处理，用户看到人话）。
///
/// 加密空间在会话锁定时会走到 `space_locked`——插件调用不能成为绕过启动锁的通路，
/// 更不能静默返回空数据装作"没有内容"（方案 §3.9）。
fn map_open_error(e: String) -> String {
    if e.contains("会话未解锁") || e.contains("locked") {
        "space_locked: 当前空间已加密且会话未解锁，插件不可读".to_string()
    } else {
        format!("db_error: {e}")
    }
}

/// 在插件线程内借一条到**活动空间**的读连接。
///
/// 三条约束（方案 §3.9）：
///   1. 只作用于活动空间——插件拿不到别的空间的数据，不是靠自觉而是宿主不给；
///   2. 空间已加密而会话未解锁 → 返回 `space_locked`，**明确报错**，不静默返回空、
///      更不得隐式触发解锁（插件调用不能成为绕过启动锁的通路）；
///   3. 惰性打开：不用数据能力的插件不付这个成本。
fn with_read_conn<T>(f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
    READ_CONN.with(|cell| {
        if cell.borrow().is_none() {
            let (space, dir) = RUN_STATE.with(|s| {
                let st = s.borrow();
                (st.read_space.clone(), st.read_dir.clone())
            });
            let space =
                space.ok_or_else(|| "space_unknown: 无法确定当前空间，数据能力不可用".to_string())?;
            let opened = match &dir {
                Some(d) => crate::db::open_space_conn_at(&space, d),
                None => crate::db::open_space_conn(&space),
            };
            let conn = opened.map_err(map_open_error)?;
            // 插件线程的连接与主连接并发：给一点 busy 等待，别一撞就 SQLITE_BUSY。
            let _ = conn.busy_timeout(Duration::from_millis(500));
            *cell.borrow_mut() = Some(conn);
        }
        let borrow = cell.borrow();
        f(borrow.as_ref().expect("read conn 刚被赋值"))
    })
}

thread_local! {
    /// 插件线程内的 meta.db 连接（**app scope** 的私有数据用）。
    /// 单独开一条的原因：meta.db 是明文库，即使当前空间被加密锁定，app 级数据也应该能读
    /// ——否则"锁定空间"会顺带让插件的应用级配置不可用（那是另一件事，不该被连带）。
    static META_CONN: RefCell<Option<Connection>> = const { RefCell::new(None) };
}

/// 每个插件、每个 scope 的私有数据配额（方案 §3.7）。超限报错，不静默截断。
const PLUGIN_KV_QUOTA: i64 = 256 * 1024;

fn with_meta_conn<T>(f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
    META_CONN.with(|cell| {
        if cell.borrow().is_none() {
            let dir = RUN_STATE.with(|s| s.borrow().read_dir.clone());
            let dir = match dir {
                Some(d) => d,
                None => crate::db::app_data_dir_ref()
                    .ok_or_else(|| "db_error: app data dir 未初始化".to_string())?
                    .to_path_buf(),
            };
            // 走 db 的入口（打开 + 确保 schema + busy timeout），不自己拼路径开连接。
            let conn = crate::db::open_meta_conn_at(&dir).map_err(|e| format!("db_error: {e}"))?;
            *cell.borrow_mut() = Some(conn);
        }
        let borrow = cell.borrow();
        f(borrow.as_ref().expect("meta conn 刚被赋值"))
    })
}

/// 按 scope 选库：`space`（默认）走空间库（随该空间加密/备份/搬移），
/// `app` 走明文 meta.db（**只该放非敏感配置**——这条是方案 §3.7 的硬约定）。
fn kv_in_scope<T>(
    scope: &str,
    f: impl FnOnce(&Connection, &str) -> Result<T, String>,
) -> Result<T, String> {
    match scope {
        "space" => with_read_conn(|c| f(c, "space")),
        "app" => with_meta_conn(|c| f(c, "app")),
        other => Err(format!("bad_args: scope 只能是 space 或 app（收到 {other}）")),
    }
}

fn cap_kv_get(key: &str, scope: &str) -> CapResult {
    let pid = RUN_STATE.with(|s| s.borrow().plugin_id.clone());
    let found = kv_in_scope(scope, |c, sc| {
        use rusqlite::OptionalExtension;
        c.query_row(
            "SELECT value FROM plugin_data WHERE plugin_id = ?1 AND scope = ?2 AND key = ?3",
            params![pid, sc, key],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("db_error: {e}"))
    })?;
    Ok(match found {
        Some(v) => serde_json::Value::String(v),
        None => serde_json::Value::Null,
    })
}

fn cap_kv_set(key: &str, value: &str, scope: &str) -> CapResult {
    let pid = RUN_STATE.with(|s| s.borrow().plugin_id.clone());
    kv_in_scope(scope, |c, sc| {
        let used: i64 = c
            .query_row(
                "SELECT COALESCE(SUM(LENGTH(value)), 0) FROM plugin_data
                 WHERE plugin_id = ?1 AND scope = ?2",
                params![pid, sc],
                |r| r.get(0),
            )
            .map_err(|e| format!("db_error: {e}"))?;
        let existing: i64 = c
            .query_row(
                "SELECT COALESCE(LENGTH(value), 0) FROM plugin_data
                 WHERE plugin_id = ?1 AND scope = ?2 AND key = ?3",
                params![pid, sc, key],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let after = used - existing + value.len() as i64;
        if after > PLUGIN_KV_QUOTA {
            return Err(format!(
                "quota_exceeded: 插件私有数据超出配额（{} KiB / scope），当前 {} 字节",
                PLUGIN_KV_QUOTA / 1024,
                after
            ));
        }
        c.execute(
            "INSERT INTO plugin_data (plugin_id, scope, key, value, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(plugin_id, scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![pid, sc, key, value, now_ms()],
        )
        .map_err(|e| format!("db_error: {e}"))?;
        Ok(())
    })?;
    Ok(serde_json::Value::Null)
}

fn cap_kv_remove(key: &str, scope: &str) -> CapResult {
    let pid = RUN_STATE.with(|s| s.borrow().plugin_id.clone());
    kv_in_scope(scope, |c, sc| {
        c.execute(
            "DELETE FROM plugin_data WHERE plugin_id = ?1 AND scope = ?2 AND key = ?3",
            params![pid, sc, key],
        )
        .map_err(|e| format!("db_error: {e}"))?;
        Ok(())
    })?;
    Ok(serde_json::Value::Null)
}

/// 一个能力的实现：成功给 JSON 值（shim 侧 JSON.parse），失败给「错误码: 说明」。
type CapResult = Result<serde_json::Value, String>;

fn cap_page_current() -> CapResult {
    Ok(serde_json::Value::String(
        RUN_STATE.with(|s| s.borrow().current_page_json.clone()),
    ))
}

fn cap_pages_count() -> CapResult {
    Ok(serde_json::json!(RUN_STATE.with(|s| s.borrow().page_count)))
}

fn cap_editor_insert_text(text: &str) -> CapResult {
    if !text.is_empty() {
        RUN_STATE.with(|s| s.borrow_mut().insert_text.push_str(text));
    }
    Ok(serde_json::Value::Null)
}

fn cap_user_notify(message: &str) -> CapResult {
    if !message.is_empty() {
        let pid = RUN_STATE.with(|s| s.borrow().plugin_id.clone());
        push_log(&pid, "info", message);
        RUN_STATE.with(|s| s.borrow_mut().toasts.push(message.to_string()));
    }
    Ok(serde_json::Value::Null)
}

fn cap_log_write(message: &str, level: &str) -> CapResult {
    let pid = RUN_STATE.with(|s| s.borrow().plugin_id.clone());
    let level = if level.is_empty() { "info" } else { level };
    push_log(&pid, level, message);
    Ok(serde_json::Value::Null)
}

fn cap_pages_list(limit: i64) -> CapResult {
    let limit = limit.clamp(1, 200);
    with_read_conn(|c| {
        let mut stmt = c
            .prepare(
                "SELECT id, title, updated_at FROM pages WHERE deleted_at IS NULL
                 ORDER BY updated_at DESC LIMIT ?1",
            )
            .map_err(|e| format!("db_error: {e}"))?;
        let rows = stmt
            .query_map(params![limit], |r| {
                Ok(serde_json::json!({
                    "id": r.get::<_, String>(0)?,
                    "title": r.get::<_, String>(1)?,
                    "updated_at": r.get::<_, i64>(2)?,
                }))
            })
            .map_err(|e| format!("db_error: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(serde_json::Value::Array(rows))
    })
}

fn cap_pages_get(id: &str) -> CapResult {
    with_read_conn(|c| {
        use rusqlite::OptionalExtension;
        let row = c
            .query_row(
                "SELECT id, title, content_text, kind FROM pages WHERE id = ?1 AND deleted_at IS NULL",
                params![id],
                |r| {
                    Ok(serde_json::json!({
                        "id": r.get::<_, String>(0)?,
                        "title": r.get::<_, String>(1)?,
                        "content_text": r.get::<_, String>(2)?,
                        "kind": r.get::<_, String>(3)?,
                    }))
                },
            )
            .optional()
            .map_err(|e| format!("db_error: {e}"))?;
        Ok(row.unwrap_or(serde_json::Value::Null))
    })
}

fn cap_pages_search(q: &str, limit: i64) -> CapResult {
    let limit = limit.clamp(1, 100);
    // v1 用子串匹配（诚实标注：不做相关度排序，FTS 复用留后续）。
    let escaped = q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    let pattern = format!("%{escaped}%");
    with_read_conn(|c| {
        let mut stmt = c
            .prepare(
                "SELECT id, title, content_text FROM pages
                 WHERE deleted_at IS NULL
                   AND (title LIKE ?1 ESCAPE '\\' OR content_text LIKE ?1 ESCAPE '\\')
                 ORDER BY updated_at DESC LIMIT ?2",
            )
            .map_err(|e| format!("db_error: {e}"))?;
        let rows = stmt
            .query_map(params![pattern, limit], |r| {
                let text: String = r.get::<_, String>(2)?;
                let snippet: String = text.chars().take(80).collect();
                Ok(serde_json::json!({
                    "id": r.get::<_, String>(0)?,
                    "title": r.get::<_, String>(1)?,
                    "snippet": snippet,
                }))
            })
            .map_err(|e| format!("db_error: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(serde_json::Value::Array(rows))
    })
}

fn cap_tags_list() -> CapResult {
    with_read_conn(|c| {
        let mut stmt = c
            .prepare(
                "SELECT t.id, t.name, COUNT(pt.page_id) FROM tags t
                 LEFT JOIN page_tags pt ON pt.tag_id = t.id
                 GROUP BY t.id, t.name ORDER BY t.name",
            )
            .map_err(|e| format!("db_error: {e}"))?;
        let rows = stmt
            .query_map([], |r| {
                Ok(serde_json::json!({
                    "id": r.get::<_, String>(0)?,
                    "name": r.get::<_, String>(1)?,
                    "page_count": r.get::<_, i64>(2)?,
                }))
            })
            .map_err(|e| format!("db_error: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(serde_json::Value::Array(rows))
    })
}

/// 省略 pageId 时用当前打开的页面（没有就明确报错，而不是猜一个）。
fn target_page_or_current(page_id: Option<&str>) -> Result<String, String> {
    match page_id {
        Some(p) if !p.is_empty() => Ok(p.to_string()),
        _ => RUN_STATE
            .with(|s| s.borrow().current_page_id.clone())
            .ok_or_else(|| "bad_args: 未指定 pageId，且当前没有打开的页面".to_string()),
    }
}

fn cap_backlinks_list(page_id: Option<&str>) -> CapResult {
    let target = target_page_or_current(page_id)?;
    with_read_conn(|c| {
        let mut stmt = c
            .prepare(
                "SELECT b.source_page_id, COALESCE(p.title, ''), b.kind FROM backlinks b
                 LEFT JOIN pages p ON p.id = b.source_page_id
                 WHERE b.target_page_id = ?1",
            )
            .map_err(|e| format!("db_error: {e}"))?;
        let rows = stmt
            .query_map(params![target], |r| {
                Ok(serde_json::json!({
                    "source_page_id": r.get::<_, String>(0)?,
                    "source_title": r.get::<_, String>(1)?,
                    "kind": r.get::<_, String>(2)?,
                }))
            })
            .map_err(|e| format!("db_error: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(serde_json::Value::Array(rows))
    })
}

fn cap_files_list(page_id: Option<&str>) -> CapResult {
    let target = target_page_or_current(page_id)?;
    with_read_conn(|c| {
        // 只给元数据，**不给字节**——读文件内容是另一个（更高风险的）能力。
        let mut stmt = c
            .prepare("SELECT id, name, mime, size FROM attachments WHERE page_id = ?1 ORDER BY created_at DESC")
            .map_err(|e| format!("db_error: {e}"))?;
        let rows = stmt
            .query_map(params![target], |r| {
                Ok(serde_json::json!({
                    "id": r.get::<_, String>(0)?,
                    "name": r.get::<_, String>(1)?,
                    "mime": r.get::<_, String>(2)?,
                    "size": r.get::<_, i64>(3)?,
                }))
            })
            .map_err(|e| format!("db_error: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(serde_json::Value::Array(rows))
    })
}

/// 把一条草稿塞进本次执行（同 key 只留一条，避免插件在循环里刷屏）。
fn push_draft(key: String, summary: String, payload: serde_json::Value) {
    RUN_STATE.with(|s| {
        let mut st = s.borrow_mut();
        if !st.drafts.iter().any(|d| d.key == key) {
            st.drafts.push(PluginDraft { key, summary, payload });
        }
    });
}

/// `pages.create`：**不建页**，只产出草稿。
///
/// Lexical 的 content_json 由前端在落库时按纯文本构造（那头才知道块结构），
/// 这里只交出 `content_text` —— 保持"Rust 不猜编辑器格式"。
fn cap_pages_create(title: &str, content: &str, parent_id: Option<&str>) -> CapResult {
    if title.trim().is_empty() {
        return Err("bad_args: 新建页面需要 title".to_string());
    }
    let summary = format!("新建页面「{title}」");
    push_draft(
        format!("create_page:{title}"),
        summary.clone(),
        serde_json::json!({
            "kind": "create_page",
            "args": { "parent_id": parent_id, "title": title, "content_text": content },
        }),
    );
    Ok(serde_json::json!({ "drafted": true, "summary": summary }))
}

/// `blocks.append`：**不写库**，只产出草稿。省略 pageId 时用当前打开的页面。
fn cap_blocks_append(page_id: Option<&str>, text: &str) -> CapResult {
    if text.trim().is_empty() {
        return Err("bad_args: 追加内容需要 text".to_string());
    }
    let target = target_page_or_current(page_id)?;
    let title = RUN_STATE.with(|s| {
        // 顺手把目标页标题查出来给用户看（只读，不改状态）；查不到就用 id。
        let _ = s.borrow().plugin_id.clone();
        String::new()
    });
    let _ = title;
    let summary = format!("向页面 {target} 追加内容");
    push_draft(
        format!("append_block:{target}"),
        summary.clone(),
        serde_json::json!({ "kind": "append_block", "pageId": target, "text": text }),
    );
    Ok(serde_json::json!({ "drafted": true, "summary": summary }))
}

/// `__cap(method, argsJson)` 的实现。**所有**能力调用（含老全局别名）都走这里，
/// 所以权限校验只有一个点，不存在绕过路径。
fn dispatch_capability(method: &str, args_json: &str) -> Result<String, String> {
    let plugin_id = RUN_STATE.with(|s| s.borrow().plugin_id.clone());
    let cap = match capabilities_gen::lookup(method) {
        Some(c) => c,
        None => {
            push_audit(&plugin_id, method, "?", false, Some("unknown_capability".into()));
            return Err(format!("unknown_capability: 宿主没有名为 {method} 的能力"));
        }
    };

    // 权限：逐次调用校验，不是只在 UI 上隐藏。
    if let Some(perm) = cap.permission {
        let granted = RUN_STATE.with(|s| s.borrow().permissions.iter().any(|p| p == perm));
        if !granted {
            push_audit(&plugin_id, method, cap.scope, false, Some("permission_denied".into()));
            return Err(format!(
                "permission_denied: 能力 {method} 需要权限 {perm}，但 manifest.permissions 未声明它"
            ));
        }
    }

    let args: serde_json::Value = if args_json.trim().is_empty() {
        serde_json::Value::Object(serde_json::Map::new())
    } else {
        match serde_json::from_str(args_json) {
            Ok(v) => v,
            Err(e) => {
                push_audit(&plugin_id, method, cap.scope, false, Some("bad_args".into()));
                return Err(format!("bad_args: 参数不是合法 JSON（{e}）"));
            }
        }
    };
    let arg_str = |name: &str| -> Result<String, String> {
        match args.get(name) {
            Some(serde_json::Value::String(v)) => Ok(v.clone()),
            Some(other) => Ok(other.to_string()), // 宽容：非字符串就 stringify
            None => Err(format!("bad_args: 缺少参数 {name}")),
        }
    };
    let arg_i64 = |name: &str, default: i64| -> i64 {
        args.get(name)
            .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
            .unwrap_or(default)
    };
    // kv 的 scope：默认 space（随空间加密的那一侧），显式 'app' 才落到明文 meta。
    let scope_arg = |args: &serde_json::Value| -> String {
        args.get("scope")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("space")
            .to_string()
    };
    let arg_opt_str = |name: &str| -> Option<String> {
        match args.get(name) {
            Some(serde_json::Value::String(s)) if !s.is_empty() => Some(s.clone()),
            _ => None,
        }
    };

    let out = match cap.id {
        "page.current" => cap_page_current(),
        "pages.count" => cap_pages_count(),
        "pages.list" => cap_pages_list(arg_i64("limit", 50)),
        "pages.get" => cap_pages_get(&arg_str("id")?),
        "pages.search" => cap_pages_search(&arg_str("q")?, arg_i64("limit", 20)),
        "tags.list" => cap_tags_list(),
        "backlinks.list" => cap_backlinks_list(arg_opt_str("pageId").as_deref()),
        "files.list" => cap_files_list(arg_opt_str("pageId").as_deref()),
        "kv.get" => cap_kv_get(&arg_str("key")?, &scope_arg(&args)),
        "kv.set" => cap_kv_set(&arg_str("key")?, &arg_str("value")?, &scope_arg(&args)),
        "kv.remove" => cap_kv_remove(&arg_str("key")?, &scope_arg(&args)),
        "pages.create" => cap_pages_create(
            &arg_str("title")?,
            &args.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            arg_opt_str("parentId").as_deref(),
        ),
        "blocks.append" => cap_blocks_append(arg_opt_str("pageId").as_deref(), &arg_str("text")?),
        "editor.insertText" => cap_editor_insert_text(&arg_str("text")?),
        "user.notify" => cap_user_notify(&arg_str("message")?),
        "log.write" => {
            let level = args.get("level").and_then(|v| v.as_str()).unwrap_or("info");
            cap_log_write(&arg_str("message")?, level)
        }
        other => {
            push_audit(&plugin_id, other, cap.scope, false, Some("unknown_capability".into()));
            return Err(format!("unknown_capability: {other}"));
        }
    };
    match out {
        Ok(v) => {
            push_audit(&plugin_id, method, cap.scope, true, None);
            serde_json::to_string(&v).map_err(|e| e.to_string())
        }
        Err(e) => {
            let code = error_code_of(&e);
            push_audit(&plugin_id, method, cap.scope, false, code);
            Err(e)
        }
    }
}

/// `__cap(method, argsJson)` → JSON 字符串（shim 侧解析）。
/// 失败抛 JS 异常：插件可以 catch，也可以让宿主把它显示成可见错误。
fn host_cap(_this: &JsValue, args: &[JsValue], _ctx: &mut Context) -> boa_engine::JsResult<JsValue> {
    let method = js_string_arg(args, 0);
    let args_json = js_string_arg(args, 1);
    match dispatch_capability(&method, &args_json) {
        Ok(json) => Ok(JsString::from(json).into()),
        Err(e) => Err(boa_engine::JsNativeError::error().with_message(e).into()),
    }
}

/// 老全局名（v1 之前）：内部走同一套派发，保证权限校验不被绕过。
/// 仅用于兼容已装在磁盘上的插件——新插件请用 `api.*`。
fn legacy_dispatch(id: &str, args_json: &str) -> boa_engine::JsResult<JsValue> {
    match dispatch_capability(id, args_json) {
        Ok(json) => Ok(JsString::from(json).into()),
        Err(e) => Err(boa_engine::JsNativeError::error().with_message(e).into()),
    }
}

fn legacy_get_current_page(
    _t: &JsValue,
    _a: &[JsValue],
    _c: &mut Context,
) -> boa_engine::JsResult<JsValue> {
    legacy_dispatch("page.current", "{}")
}

fn legacy_pages(_t: &JsValue, _a: &[JsValue], _c: &mut Context) -> boa_engine::JsResult<JsValue> {
    legacy_dispatch("pages.count", "{}")
}

fn legacy_toast(_t: &JsValue, args: &[JsValue], _c: &mut Context) -> boa_engine::JsResult<JsValue> {
    let message = js_string_arg(args, 0);
    legacy_dispatch(
        "user.notify",
        &serde_json::json!({ "message": message }).to_string(),
    )
}

fn legacy_insert(_t: &JsValue, args: &[JsValue], _c: &mut Context) -> boa_engine::JsResult<JsValue> {
    let text = js_string_arg(args, 0);
    legacy_dispatch(
        "editor.insertText",
        &serde_json::json!({ "text": text }).to_string(),
    )
}

/// 老写法是 `__log(level, message)`（新的 `api.log(message, level)` 参数顺序相反）。
fn legacy_log(_t: &JsValue, args: &[JsValue], _c: &mut Context) -> boa_engine::JsResult<JsValue> {
    let level = js_string_arg(args, 0);
    let message = js_string_arg(args, 1);
    legacy_dispatch(
        "log.write",
        &serde_json::json!({ "message": message, "level": level }).to_string(),
    )
}

/// evaluate 插件前导：BOOTSTRAP（register / __describe / __run）+ 生成的 api.* shim。
/// 两处执行路径（发现与运行）必须用同一套前导，否则 ABI 会分叉。
fn eval_plugin_preamble(ctx: &mut Context) -> Result<(), String> {
    ctx.eval(Source::from_bytes(BOOTSTRAP.as_bytes()))
        .map_err(|e| format!("bootstrap 失败: {e}"))?;
    ctx.eval(Source::from_bytes(API_SHIM.as_bytes()))
        .map_err(|e| format!("api shim 加载失败: {e}"))?;
    Ok(())
}

/// Run a plugin's `main.js` and collect the registered command metadata.
fn discover_commands(source: &str, state: &RunState) -> Result<Vec<PluginCommandMeta>, String> {
    let mut ctx = plugin_context(DISCOVER_LOOP_LIMIT);
    set_run_state(&mut ctx, state)?;
    eval_plugin_preamble(&mut ctx)?;
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
    permissions: &[String],
    source: &str,
    timeout: Duration,
) -> Result<Vec<PluginCommandMeta>, String> {
    let src = source.to_string();
    let pid = plugin_id.to_string();
    let perms = permissions.to_vec();
    with_timeout(timeout, "插件加载", move || {
        discover_commands(
            &src,
            &RunState {
                plugin_id: pid,
                permissions: perms,
                ..Default::default()
            },
        )
    })
}

fn set_run_state(ctx: &mut Context, state: &RunState) -> Result<(), String> {
    let mut reg = |name: &str, argc: usize, f: NativeFunction| -> Result<(), String> {
        ctx.register_global_callable(JsString::from(name), argc, f)
            .map_err(|e| e.to_string())
    };
    // 唯一的能力原语：生成的 api.* shim 调它（换引擎/加传输都不破坏插件）。
    reg("__cap", 2, NativeFunction::from_fn_ptr(host_cap))?;
    // v1 之前的老全局名：仅为兼容已装在磁盘上的插件。它们内部走**同一套**派发与权限校验，
    // 所以不构成绕过点；新插件请用 api.*。
    reg(
        "__get_current_page",
        0,
        NativeFunction::from_fn_ptr(legacy_get_current_page),
    )?;
    reg("__pages", 0, NativeFunction::from_fn_ptr(legacy_pages))?;
    reg("__toast", 1, NativeFunction::from_fn_ptr(legacy_toast))?;
    reg("__insert", 1, NativeFunction::from_fn_ptr(legacy_insert))?;
    reg("__log", 2, NativeFunction::from_fn_ptr(legacy_log))?;
    RUN_STATE.with(|s| {
        *s.borrow_mut() = RunState {
            plugin_id: state.plugin_id.clone(),
            current_page_json: state.current_page_json.clone(),
            page_count: state.page_count,
            permissions: state.permissions.clone(),
            current_page_id: state.current_page_id.clone(),
            read_space: state.read_space.clone(),
            read_dir: state.read_dir.clone(),
            drafts: Vec::new(),
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
    eval_plugin_preamble(&mut ctx)?;
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
) -> Result<(String, String, Vec<String>, Vec<PluginDraft>), String> {
    let source = source.to_string();
    let command_id = command_id.to_string();
    // RunState 是纯数据（String/usize），可 move 进线程；RUN_STATE/thread_local
    // 会在该线程内由 set_run_state 正确重建。
    let state = RunState {
        plugin_id: state.plugin_id.clone(),
        current_page_json: state.current_page_json.clone(),
        page_count: state.page_count,
        permissions: state.permissions.clone(),
        current_page_id: state.current_page_id.clone(),
        read_space: state.read_space.clone(),
        read_dir: state.read_dir.clone(),
        drafts: Vec::new(),
        insert_text: String::new(),
        toasts: Vec::new(),
    };
    with_timeout(RUN_TIMEOUT, "插件执行", move || {
        let msg = run_command(&source, &command_id, &state)?;
        let (insert, toasts, drafts) = RUN_STATE.with(|s| {
            let st = s.borrow();
            (st.insert_text.clone(), st.toasts.clone(), st.drafts.clone())
        });
        Ok((msg, insert, toasts, drafts))
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
        r#"{"id":"demo","name":"示例插件","version":"0.2.0","description":"ShuyoNote 示例插件（用 v1 的 api.* 写）","apiVersion":"1.0.0","main":"main.js","permissions":[{"id":"read:pages","reason":"在提示里显示本空间页面数"},{"id":"read:page.current","reason":"演示读取当前页"},{"id":"write:page.current","reason":"演示把文本插入当前页"}]}"#,
    )
    .map_err(|e| e.to_string())?;
    std::fs::write(
        dir.join("main.js"),
        r#"
// 示例插件：用 API v1 的 api.* 写。日志见「插件管理 → 日志」。
register({ id: "demo.hello", title: "你好", description: "示例命令：读取本空间页面数", closeOnRun: false,
  run: function(){ api.log("demo.hello 开始执行"); api.notify("你好，ShuyoNote！本空间页面数=" + api.pages.count()); return "你好，ShuyoNote！"; } });
register({ id: "demo.inspect", title: "查看当前页", description: "演示读取当前页的 content_json", closeOnRun: false,
  run: function(){ var raw = api.page.current(); return raw ? ("当前页 JSON 长度=" + raw.length) : "没有打开页面"; } });
register({ id: "demo.insert", title: "插入文本", description: "把一段文本插入到当前页面", closeOnRun: false,
  run: function(){ api.editor.insertText("由示例插件插入的一段文本。"); return "已请求插入文本"; } });
"#,
    )
    .map_err(|e| e.to_string())?;
    std::fs::write(&marker, b"1").map_err(|e| e.to_string())?;
    // 出厂内容也留一行安装记录（seeded=1）：插件管理面板能看出它是随应用带的，
    // 而且"用户之前禁用过它"不会被这里覆盖（record_install 只更新版本/来源）。
    if let Some(db) = app.try_state::<Db>() {
        let c = db.0.lock().unwrap_or_else(|e| e.into_inner());
        let _ = record_install(&c, "demo", "0.2.0", "bundled", true, true);
    }
    Ok(())
}

/// 读启停状态：以 `plugin_install` 行为准；**没有行时默认启用**。
///
/// "没有行却默认启用"是有意的：手动往插件目录丢文件夹的人（专家操作）本来就在表达同意，
/// 且示例插件等出厂内容没有行走过安装流程。走「从文件夹安装」的路径会显式写入
/// `enabled=0`（安装 ≠ 授权），那条才是需要用户确认的入口。
fn enabled(c: &Connection, id: &str) -> bool {
    c.query_row(
        "SELECT enabled FROM meta.plugin_install WHERE plugin_id = ?1",
        params![id],
        |r| r.get::<_, i64>(0),
    )
    .map(|v| v != 0)
    .unwrap_or(true) // 没有安装行 → 默认启用（见上面的说明）
}

fn set_enabled(c: &Connection, id: &str, on: bool) -> Result<(), String> {
    c.execute(
        "INSERT INTO meta.plugin_install (plugin_id, enabled, installed_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(plugin_id) DO UPDATE SET enabled = excluded.enabled",
        params![id, if on { 1 } else { 0 }, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 记一条安装记录（安装成功 / 出厂播种时调用）。
/// 已存在则只补**版本 / 来源 / 播种位**（这些是事实），**绝不覆盖 `enabled`**（那是用户的选择）。
fn record_install(
    c: &Connection,
    id: &str,
    version: &str,
    source: &str,
    seeded: bool,
    enabled: bool,
) -> Result<(), String> {
    c.execute(
        "INSERT INTO plugin_install (plugin_id, version, enabled, installed_at, source, seeded)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(plugin_id) DO UPDATE SET
             version = excluded.version,
             source = excluded.source,
             seeded = excluded.seeded",
        params![id, version, if enabled { 1 } else { 0 }, now_ms(), source, if seeded { 1 } else { 0 }],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 卸载时删掉安装行。
///
/// 此前卸载只删目录、不删状态行，于是**重装同一个 id 会静默继承旧的「已禁用」**，
/// 而且残留行永远没人回收。现在"安装记录"本身就是一行，卸载 = 删行，残留从结构上消失。
fn clear_enabled(c: &Connection, id: &str) -> Result<(), String> {
    c.execute(
        "DELETE FROM meta.plugin_install WHERE plugin_id = ?1",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    // 连带清掉这个插件的私有数据：卸载后不该留数据（也不该让重装继承）。
    c.execute(
        "DELETE FROM meta.plugin_data WHERE plugin_id = ?1",
        params![id],
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
        let (permissions, warnings) = resolve_permissions(&manifest);
        for w in &warnings {
            push_log(&manifest.id, "warn", w);
        }
        let commands =
            discover_commands_timed(&manifest.id, &permissions, &source, DISCOVER_TIMEOUT)
                .unwrap_or_default();
        let pid = manifest.id.clone();
        let (permissions, permissions_baseline) = permission_metas(&manifest);
        out.push(PluginMeta {
            id: pid.clone(),
            name: manifest.name,
            version: manifest.version,
            description: manifest.description,
            enabled: enabled_map.get(&pid).copied().unwrap_or(false),
            commands,
            permissions,
            permissions_baseline,
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
        let current_page_json = if let Some(id) = current_id.as_deref() {
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
    // 数据能力的读取目标：活动空间。由主线程解析后交给插件线程（它没有 State<Db>）。
    let read_space = {
        let c = conn(&db);
        c.query_row(
            "SELECT value FROM meta.sync_state WHERE key = ?1",
            params![crate::db::ACTIVE_KEY],
            |r| r.get::<_, String>(0),
        )
        .ok()
    };
    let (permissions, warnings) = resolve_permissions(&manifest);
    for w in &warnings {
        push_log(&plugin_id, "warn", w);
    }
    let state = RunState {
        plugin_id: plugin_id.clone(),
        page_count,
        current_page_json,
        permissions,
        current_page_id: current_id,
        read_space,
        read_dir: None,
        drafts: Vec::new(),
        insert_text: String::new(),
        toasts: Vec::new(),
    };
    let (message, insert, toasts, drafts) = run_command_timeout(&source, &command_id, &state)?;
    Ok(PluginRunResult {
        message: if message.is_empty() { "已执行".to_string() } else { message },
        insert: if insert.is_empty() { None } else { Some(insert) },
        toasts,
        drafts,
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
pub async fn install_plugin(
    app: AppHandle,
    db: State<'_, Db>,
    source_path: String,
) -> Result<PluginMeta, String> {
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
    // 权限警告先记下来，装完在插件日志里就能看到（例如"没写 permissions，走基线授权"）。
    let (permissions, warnings) = resolve_permissions(&manifest);
    for w in &warnings {
        push_log(&manifest.id, "warn", w);
    }
    let commands = discover_commands_timed(&manifest.id, &permissions, &source, DISCOVER_TIMEOUT)?;

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
    // 新装的插件**默认禁用**：先让用户看清它要哪些权限、干什么，再自己去启用。
    // （插件默认启用时，"安装"就等于一次性授予了它声明的全部数据访问权。）
    {
        let c = conn(&db);
        record_install(&c, &manifest.id, &manifest.version, "local", false, false)?;
    }
    let (permissions, permissions_baseline) = permission_metas(&manifest);
    Ok(PluginMeta {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        enabled: false,
        commands,
        permissions,
        permissions_baseline,
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

/// 读取能力调用审计（最近若干条，正序）。
///
/// 只回元数据，不回内容——审计的用途是"这个插件碰过哪些权限、有没有被拒"，
/// 而不是记录它读到了什么。
#[tauri::command]
pub fn plugin_audit(plugin_id: Option<String>, limit: Option<usize>) -> Vec<PluginAuditEntry> {
    let all: Vec<PluginAuditEntry> = {
        let q = PLUGIN_AUDIT.lock().unwrap_or_else(|e| e.into_inner());
        q.iter().cloned().collect()
    };
    let mut filtered: Vec<PluginAuditEntry> = all
        .into_iter()
        .filter(|e| plugin_id.as_deref().is_none_or(|p| e.plugin_id == p))
        .collect();
    let keep = limit.unwrap_or(PLUGIN_AUDIT_CAPACITY).min(PLUGIN_AUDIT_CAPACITY);
    if filtered.len() > keep {
        filtered.drain(0..filtered.len() - keep);
    }
    filtered
}

/// 清空能力调用审计。
#[tauri::command]
pub fn clear_plugin_audit() {
    PLUGIN_AUDIT.lock().unwrap_or_else(|e| e.into_inner()).clear();
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
        let state = RunState {
            page_count: 7,
            permissions: vec!["read:pages".to_string()],
            ..Default::default()
        };
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
        let state = RunState {
            permissions: vec!["write:page.current".to_string()],
            ..Default::default()
        };
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
        let res = discover_commands_timed("t.discover", &[], "while(true){}", DISCOVER_TIMEOUT);
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

    /// 只带插件相关表的内存库（真实 SQL，含 `meta.` 限定名）。
    fn state_conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "ATTACH DATABASE ':memory:' AS meta;
             CREATE TABLE meta.plugin_install (
                 plugin_id TEXT PRIMARY KEY,
                 version TEXT NOT NULL DEFAULT '',
                 enabled INTEGER NOT NULL DEFAULT 1,
                 installed_at INTEGER NOT NULL DEFAULT 0,
                 source TEXT NOT NULL DEFAULT 'local',
                 content_hash TEXT,
                 seeded INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE meta.plugin_data (
                 plugin_id TEXT NOT NULL,
                 scope TEXT NOT NULL,
                 key TEXT NOT NULL,
                 value TEXT NOT NULL,
                 updated_at INTEGER NOT NULL DEFAULT 0,
                 PRIMARY KEY (plugin_id, scope, key)
             );",
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
            .query_row("SELECT COUNT(*) FROM meta.plugin_install", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0, "卸载不应留下任何安装行");
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

    // ---- 能力注册表 / api.* / 权限 ----

    fn state_with(permissions: &[&str]) -> RunState {
        RunState {
            plugin_id: "t".to_string(),
            permissions: permissions.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn api_shim_exposes_v1_surface_with_permissions() {
        let _g = log_test_guard();
        clear_plugin_logs();
        let source = r#"register({ id: "t.api", title: "A", description: "", closeOnRun: false,
  run: function(){
    api.log("来自 api.log");
    api.notify("来自 api.notify");
    api.editor.insertText("新文本");
    return "count=" + api.pages.count();
  } });"#;
        let state = state_with(&["read:pages", "write:page.current"]);
        let (msg, insert, toasts, _drafts) = run_command_timeout(source, "t.api", &state).unwrap();
        assert_eq!(msg, "count=0");
        assert_eq!(insert, "新文本");
        assert_eq!(toasts, vec!["来自 api.notify".to_string()]);
        let logs = plugin_logs(Some("t".to_string()), None);
        assert!(logs.iter().any(|l| l.message == "来自 api.log"));
    }

    #[test]
    fn capability_call_without_declared_permission_is_denied() {
        // 关键性质：权限是**后端逐次调用校验**的，不是只在 UI 上隐藏。
        let source = r#"register({ id: "t.deny", title: "D", description: "", closeOnRun: false,
  run: function(){ return "count=" + api.pages.count(); } });"#;
        let res = run_command(source, "t.deny", &state_with(&[])).unwrap();
        assert!(res.contains("permission_denied"), "实际: {res}");
        assert!(res.contains("read:pages"), "错误里应点明缺哪个权限");
    }

    #[test]
    fn legacy_globals_go_through_the_same_permission_check() {
        // 老写法不能成为绕过点。
        let source = r#"register({ id: "t.legacy", title: "L", description: "", closeOnRun: false,
  run: function(){ return "count=" + __pages(); } });"#;
        let denied = run_command(source, "t.legacy", &state_with(&[])).unwrap();
        assert!(denied.contains("permission_denied"), "老全局也要过权限校验，实际: {denied}");

        let mut ok_state = state_with(&["read:pages"]);
        ok_state.page_count = 7;
        assert_eq!(run_command(source, "t.legacy", &ok_state).unwrap(), "count=7");
    }

    #[test]
    fn unknown_capability_is_rejected() {
        let source = r#"register({ id: "t.unknown", title: "U", description: "", closeOnRun: false,
  run: function(){ return String(__cap("pages.deleteEverything", "{}")); } });"#;
        let res = run_command(source, "t.unknown", &state_with(&[])).unwrap();
        assert!(res.contains("unknown_capability"), "实际: {res}");
    }

    #[test]
    fn registered_api_surface_matches_the_generated_table() {
        // 门禁之外的运行时抽检：注册表里的每条能力都真的能派发（不认识的能力会被拒）。
        for cap in capabilities_gen::CAPABILITIES {
            assert!(
                capabilities_gen::lookup(cap.id).is_some(),
                "{} 在表里却查不到",
                cap.id
            );
            assert!(!cap.rust.is_empty(), "{} 缺少实现函数名", cap.id);
        }
        assert!(capabilities_gen::lookup("pages.deleteEverything").is_none());
        assert_eq!(capabilities_gen::API_MAJOR, 1);
    }

    #[test]
    fn manifest_api_major_is_enforced() {
        let base = temp_dir("api-version");
        let mk = |dir: &str, v: serde_json::Value| {
            let d = base.join(dir);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("manifest.json"), v.to_string()).unwrap();
            d
        };
        let good = mk("good", serde_json::json!({"id":"good","name":"G","main":"main.js","apiVersion":"1.0.0"}));
        assert!(read_manifest(&good).is_ok(), "同主版本应当放行");

        let future = mk("future", serde_json::json!({"id":"future","name":"F","main":"main.js","apiVersion":"2.0.0"}));
        let err = read_manifest(&future).unwrap_err();
        assert!(err.contains("主版本不受支持"), "实际: {err}");

        // 缺 apiVersion：放行（老 manifest 兼容），由 resolve_permissions 记警告
        let legacy = mk("legacy", serde_json::json!({"id":"legacy","name":"L","main":"main.js"}));
        assert!(read_manifest(&legacy).is_ok());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn missing_permissions_gets_the_v1_baseline_and_a_warning() {
        let m = Manifest {
            id: "legacy".into(),
            name: "L".into(),
            version: String::new(),
            description: String::new(),
            author: None,
            main: "main.js".into(),
            api_version: None,
            permissions: None,
        };
        let (granted, warnings) = resolve_permissions(&m);
        assert_eq!(
            granted.len(),
            capabilities_gen::PERMISSION_LIST.len(),
            "老 manifest 应拿到基线授权"
        );
        assert!(warnings.iter().any(|w| w.contains("基线")), "应记录基线授权警告: {warnings:?}");
        assert!(warnings.iter().any(|w| w.contains("apiVersion")), "应提醒补 apiVersion");
    }

    #[test]
    fn unknown_permission_is_ignored_and_missing_reason_warns() {
        let m = Manifest {
            id: "p".into(),
            name: "P".into(),
            version: String::new(),
            description: String::new(),
            author: None,
            main: "main.js".into(),
            api_version: Some("1.0.0".into()),
            permissions: Some(vec![
                PermissionDecl { id: "read:pages".into(), reason: String::new() },
                PermissionDecl { id: "net:https:example.com".into(), reason: "未来能力".into() },
            ]),
        };
        let (granted, warnings) = resolve_permissions(&m);
        assert_eq!(granted, vec!["read:pages".to_string()], "未知权限应被忽略而不是静默全拒");
        assert!(warnings.iter().any(|w| w.contains("没有写 reason")));
        assert!(warnings.iter().any(|w| w.contains("未知权限")));
    }

    #[test]
    fn permission_metas_explains_what_is_granted() {
        let declared = Manifest {
            id: "p".into(),
            name: "P".into(),
            version: String::new(),
            description: String::new(),
            author: None,
            main: "main.js".into(),
            api_version: Some("1.0.0".into()),
            permissions: Some(vec![PermissionDecl {
                id: "read:pages".into(),
                reason: "为了显示页面数".into(),
            }]),
        };
        let (metas, baseline) = permission_metas(&declared);
        assert!(!baseline);
        assert_eq!(metas.len(), 1);
        assert_eq!(metas[0].id, "read:pages");
        assert_eq!(metas[0].title, "读取本空间页面统计", "标题来自注册表，不是裸 id");
        assert_eq!(metas[0].reason, "为了显示页面数");

        // 老 manifest：走基线授权，且界面要能如实标注
        let legacy = Manifest {
            id: "l".into(),
            name: "L".into(),
            version: String::new(),
            description: String::new(),
            author: None,
            main: "main.js".into(),
            api_version: None,
            permissions: None,
        };
        let (metas2, baseline2) = permission_metas(&legacy);
        assert!(baseline2);
        assert_eq!(metas2.len(), capabilities_gen::PERMISSION_LIST.len());
        assert!(metas2[0].reason.contains("基线"), "基线授权必须说清楚是怎么来的");
    }

    // ---- 安装行 / 私有数据 / 审计 ----

    #[test]
    fn uninstall_also_drops_the_plugins_private_data() {
        let c = state_conn();
        record_install(&c, "p1", "1.0.0", "local", false, true).unwrap();
        c.execute(
            "INSERT INTO meta.plugin_data (plugin_id, scope, key, value, updated_at)
             VALUES ('p1', 'app', 'k', 'v', 0)",
            [],
        )
        .unwrap();
        set_enabled(&c, "p1", false).unwrap();
        assert!(!enabled(&c, "p1"));

        clear_enabled(&c, "p1").unwrap();
        assert!(enabled(&c, "p1"), "卸载后重装不该继承旧的已禁用");
        let left: i64 = c
            .query_row("SELECT COUNT(*) FROM meta.plugin_data", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0, "卸载应当连私有数据一起清掉");
    }

    #[test]
    fn record_install_keeps_the_users_enabled_choice() {
        let c = state_conn();
        record_install(&c, "p1", "1.0.0", "local", false, false).unwrap();
        assert!(!enabled(&c, "p1"), "新装默认禁用（安装 ≠ 授权）");
        set_enabled(&c, "p1", true).unwrap();

        // 再次播种/记录（例如升级）不该把用户的选择冲掉
        record_install(&c, "p1", "2.0.0", "bundled", true, true).unwrap();
        assert!(enabled(&c, "p1"));
        let (v, src, seeded): (String, String, i64) = c
            .query_row(
                "SELECT version, source, seeded FROM meta.plugin_install WHERE plugin_id = 'p1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!((v.as_str(), src.as_str(), seeded), ("2.0.0", "bundled", 1));
    }

    /// 审计是进程级环形缓冲，与日志同样需要串行。
    static AUDIT_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn audit_records_success_and_permission_denial() {
        let _g = AUDIT_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_plugin_audit();

        // 被拒的调用也要留痕 —— 这恰恰是最该查的那类记录
        let denied = r#"register({ id: "t.audit", title: "A", description: "", closeOnRun: false,
  run: function(){ try { api.pages.count(); } catch (e) { return "caught"; } return "no-throw"; } });"#;
        let state = RunState {
            plugin_id: "auditp".to_string(),
            ..Default::default()
        };
        assert_eq!(run_command(denied, "t.audit", &state).unwrap(), "caught");
        let rows = plugin_audit(Some("auditp".to_string()), None);
        assert_eq!(rows.len(), 1, "应当留下一条审计");
        assert!(!rows[0].ok);
        assert_eq!(rows[0].capability, "pages.count");
        assert_eq!(rows[0].scope, "current-space");
        assert_eq!(rows[0].error_code.as_deref(), Some("permission_denied"));

        // 授权后的成功调用
        let mut ok_state = state.clone();
        ok_state.permissions = vec!["read:pages".to_string()];
        assert_eq!(run_command(denied, "t.audit", &ok_state).unwrap(), "no-throw");
        let rows = plugin_audit(Some("auditp".to_string()), None);
        assert_eq!(rows.len(), 2);
        assert!(rows[1].ok);
        assert_eq!(rows[1].error_code, None);

        clear_plugin_audit();
        assert!(plugin_audit(None, None).is_empty());
    }

    #[test]
    fn audit_is_scoped_per_plugin_and_capped() {
        let _g = AUDIT_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_plugin_audit();
        for i in 0..(PLUGIN_AUDIT_CAPACITY + 5) {
            push_audit("cap", "pages.count", "current-space", true, None);
            let _ = i;
        }
        let all = plugin_audit(Some("cap".to_string()), None);
        assert_eq!(all.len(), PLUGIN_AUDIT_CAPACITY, "审计缓冲必须封顶");
        assert!(plugin_audit(Some("别的插件".to_string()), None).is_empty());
        assert_eq!(plugin_audit(Some("cap".to_string()), Some(3)).len(), 3);
        clear_plugin_audit();
    }

    // ---- 读能力（活动空间的数据访问） ----

    /// 准备一个带内容的临时空间库，返回 (空间 id, 目录)。
    fn seed_space(tag: &str) -> (String, PathBuf) {
        let dir = temp_dir(tag);
        // 生产路径由 db::init 建 spaces/ 目录；测试里自己补上。
        std::fs::create_dir_all(crate::db::spaces_dir(&dir)).unwrap();
        let space = "s1".to_string();
        {
            let c = crate::db::open_space_conn_at(&space, &dir).unwrap();
            let now = now_ms();
            c.execute(
                "INSERT INTO pages (id, workspace_id, title, content_json, content_text, kind, created_at, updated_at)
                 VALUES ('p1','s1','会议纪要','{}','本周进展与下周计划','page',?1,?1)",
                params![now],
            )
            .unwrap();
            c.execute(
                "INSERT INTO pages (id, workspace_id, title, content_json, content_text, kind, created_at, updated_at)
                 VALUES ('p2','s1','读书笔记','{}','无关内容','page',?1,?1)",
                params![now + 1],
            )
            .unwrap();
            c.execute("INSERT INTO tags (id, name) VALUES ('t1','工作')", []).unwrap();
            c.execute("INSERT INTO page_tags (page_id, tag_id) VALUES ('p1','t1')", []).unwrap();
            c.execute(
                "INSERT INTO backlinks (source_page_id, source_block_id, target_page_id, target_block_id, kind)
                 VALUES ('p2','','p1','','link')",
                [],
            )
            .unwrap();
            c.execute(
                "INSERT INTO attachments (id, page_id, name, hash, mime, size, created_at)
                 VALUES ('a1','p1','周报.pdf','h','application/pdf',1024,?1)",
                params![now],
            )
            .unwrap();
        }
        (space, dir)
    }

    fn state_for_space(space: &str, dir: &Path) -> RunState {
        RunState {
            plugin_id: "t".to_string(),
            permissions: capabilities_gen::permission_ids().iter().map(|s| s.to_string()).collect(),
            current_page_id: Some("p1".to_string()),
            read_space: Some(space.to_string()),
            read_dir: Some(dir.to_path_buf()),
            ..Default::default()
        }
    }

    fn call(state: &RunState, method: &str, args: &str) -> Result<serde_json::Value, String> {
        RUN_STATE.with(|s| *s.borrow_mut() = state.clone());
        let out = dispatch_capability(method, args)?;
        serde_json::from_str(&out).map_err(|e| e.to_string())
    }

    #[test]
    fn read_capabilities_query_the_active_space() {
        let (space, dir) = seed_space("read-caps");
        let st = state_for_space(&space, &dir);

        let list = call(&st, "pages.list", "{}").unwrap();
        assert_eq!(list.as_array().unwrap().len(), 2, "应当列出本空间两个页面");
        assert_eq!(list[0]["title"], "读书笔记", "按更新时间倒序");

        let one = call(&st, "pages.get", r#"{"id":"p1"}"#).unwrap();
        assert_eq!(one["title"], "会议纪要");
        assert_eq!(one["content_text"], "本周进展与下周计划");
        assert!(
            call(&st, "pages.get", r#"{"id":"nope"}"#).unwrap().is_null(),
            "不存在的页面返回 null 而不是报错"
        );

        let hits = call(&st, "pages.search", r#"{"q":"进展"}"#).unwrap();
        assert_eq!(hits.as_array().unwrap().len(), 1, "只应命中含关键词的那页");
        assert_eq!(hits[0]["id"], "p1");
        assert!(hits[0]["snippet"].as_str().unwrap().contains("进展"));

        let tags = call(&st, "tags.list", "{}").unwrap();
        assert_eq!(tags[0]["name"], "工作");
        assert_eq!(tags[0]["page_count"], 1);

        let backs = call(&st, "backlinks.list", "{}").unwrap();
        assert_eq!(backs.as_array().unwrap().len(), 1);
        assert_eq!(backs[0]["source_page_id"], "p2");
        assert_eq!(backs[0]["source_title"], "读书笔记");

        let files = call(&st, "files.list", "{}").unwrap();
        assert_eq!(files[0]["name"], "周报.pdf");
        assert_eq!(files[0]["size"], 1024);
        assert!(files[0].get("content").is_none(), "只能给元数据，不给字节");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_capabilities_still_need_permission() {
        let (space, dir) = seed_space("read-perm");
        let mut st = state_for_space(&space, &dir);
        st.permissions = vec![]; // 什么都不授权
        let err = call(&st, "pages.list", "{}").unwrap_err();
        assert!(err.contains("permission_denied"), "实际: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn data_capability_without_a_space_says_so_instead_of_guessing() {
        // 无法确定活动空间时必须明确失败，而不是静默返回空列表装作"没有数据"。
        let st = RunState {
            plugin_id: "t".to_string(),
            permissions: vec!["read:pages".to_string()],
            read_space: None,
            ..Default::default()
        };
        let err = call(&st, "pages.list", "{}").unwrap_err();
        assert!(err.contains("space_unknown"), "实际: {err}");
    }

    #[test]
    fn page_scoped_capability_needs_an_id_or_an_open_page() {
        let (space, dir) = seed_space("read-target");
        let mut st = state_for_space(&space, &dir);
        st.current_page_id = None;
        let err = call(&st, "backlinks.list", "{}").unwrap_err();
        assert!(err.contains("bad_args"), "实际: {err}");
        // 显式给 id 就没事
        let ok = call(&st, "backlinks.list", r#"{"pageId":"p1"}"#).unwrap();
        assert_eq!(ok.as_array().unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn locked_space_maps_to_a_stable_error_code() {
        // 端到端要真建一个加密空间；这里钉住映射本身，保证错误码稳定（作者可分支）。
        assert!(map_open_error("工作空间已加密但会话未解锁".to_string()).starts_with("space_locked"));
        assert!(map_open_error("file is not a database (locked)".to_string()).starts_with("space_locked"));
        assert!(map_open_error("disk I/O error".to_string()).starts_with("db_error"));
    }

    // ---- kv.own（插件私有数据 + scope 路由） ----

    #[test]
    fn kv_round_trips_and_is_scoped_by_plugin() {
        let (space, dir) = seed_space("kv");
        let mut st = state_for_space(&space, &dir);
        st.permissions = vec!["kv:own".to_string()];

        assert!(call(&st, "kv.get", r#"{"key":"a"}"#).unwrap().is_null(), "没存过就是 null");
        call(&st, "kv.set", r#"{"key":"a","value":"1"}"#).unwrap();
        assert_eq!(call(&st, "kv.get", r#"{"key":"a"}"#).unwrap(), "1");

        // 不同插件的同名键互不可见（命名空间隔离）
        let mut other = st.clone();
        other.plugin_id = "other".to_string();
        assert!(call(&other, "kv.get", r#"{"key":"a"}"#).unwrap().is_null());

        call(&st, "kv.remove", r#"{"key":"a"}"#).unwrap();
        assert!(call(&st, "kv.get", r#"{"key":"a"}"#).unwrap().is_null());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn kv_scope_routing_puts_data_in_the_right_database() {
        // space（默认）→ 空间库（随 SQLCipher 加密）；app → 明文 meta.db。
        // 这条约定就是方案 §3.7：空间级数据塞进 meta 会静默逃出 E2EE 边界。
        let (space, dir) = seed_space("kv-scope");
        let mut st = state_for_space(&space, &dir);
        st.permissions = vec!["kv:own".to_string()];

        call(&st, "kv.set", r#"{"key":"inspace","value":"s"}"#).unwrap();
        call(&st, "kv.set", r#"{"key":"inapp","value":"a","scope":"app"}"#).unwrap();

        {
            let sc = crate::db::open_space_conn_at(&space, &dir).unwrap();
            let in_space: i64 = sc
                .query_row("SELECT COUNT(*) FROM plugin_data WHERE key = 'inspace'", [], |r| r.get(0))
                .unwrap();
            let not_in_space: i64 = sc
                .query_row("SELECT COUNT(*) FROM plugin_data WHERE key = 'inapp'", [], |r| r.get(0))
                .unwrap();
            assert_eq!(in_space, 1, "默认 scope 必须落空间库");
            assert_eq!(not_in_space, 0, "app scope 不该出现在空间库");
        }
        {
            let meta = Connection::open(crate::db::meta_path(&dir)).unwrap();
            let in_app: i64 = meta
                .query_row("SELECT COUNT(*) FROM plugin_data WHERE key = 'inapp'", [], |r| r.get(0))
                .unwrap();
            assert_eq!(in_app, 1, "app scope 必须落 meta.db");
        }

        // 非法 scope 明确报错，而不是猜一个
        let err = call(&st, "kv.set", r#"{"key":"k","value":"v","scope":"space:s1"}"#).unwrap_err();
        assert!(err.contains("bad_args"), "实际: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn kv_quota_is_enforced_per_scope() {
        let (space, dir) = seed_space("kv-quota");
        let mut st = state_for_space(&space, &dir);
        st.permissions = vec!["kv:own".to_string()];

        let big = "x".repeat(PLUGIN_KV_QUOTA as usize + 1);
        let err = call(&st, "kv.set", &serde_json::json!({ "key": "k", "value": big }).to_string())
            .unwrap_err();
        assert!(err.contains("quota_exceeded"), "超配额要报错而不是静默截断，实际: {err}");

        // 覆盖写不该被"自己占的空间"挡住：先写小值再覆盖成大值（仍在配额内）
        call(&st, "kv.set", r#"{"key":"k","value":"small"}"#).unwrap();
        let ok = "y".repeat(1024);
        call(&st, "kv.set", &serde_json::json!({ "key": "k", "value": ok }).to_string()).unwrap();
        assert_eq!(
            call(&st, "kv.get", r#"{"key":"k"}"#).unwrap().as_str().unwrap().len(),
            1024
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn kv_also_needs_its_permission() {
        let (space, dir) = seed_space("kv-perm");
        let mut st = state_for_space(&space, &dir);
        st.permissions = vec![];
        let err = call(&st, "kv.set", r#"{"key":"k","value":"v"}"#).unwrap_err();
        assert!(err.contains("permission_denied"), "实际: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- 受控写（草稿确认） ----

    #[test]
    fn write_capabilities_produce_drafts_instead_of_writing() {
        let (space, dir) = seed_space("write-draft");
        let mut st = state_for_space(&space, &dir);
        st.permissions = vec!["write:pages".to_string(), "read:pages".to_string()];
        st.current_page_id = Some("p1".to_string());

        let out = call(&st, "pages.create", r#"{"title":"周报","content":"第一段"}"#).unwrap();
        assert_eq!(out["drafted"], true, "写能力应返回「已产出草稿」而非「已写入」");
        let list = call(&st, "pages.list", "{}").unwrap();
        assert_eq!(list.as_array().unwrap().len(), 2, "**草稿阶段不得真的建页**");

        // 走完整链路：草稿必须随结果回传，前端才能拿它去确认
        let source = r#"register({ id: "w.one", title: "W", description: "", closeOnRun: false,
  run: function(){ api.pages.create("新页", "正文"); api.blocks.append("附注"); return "ok"; } });"#;
        let (msg, _insert, _toasts, drafts) = run_command_timeout(source, "w.one", &st).unwrap();
        assert_eq!(msg, "ok");
        let keys: Vec<&str> = drafts.iter().map(|d| d.key.as_str()).collect();
        assert_eq!(keys, vec!["create_page:新页", "append_block:p1"]);
        assert_eq!(drafts[0].summary, "新建页面「新页」");
        assert_eq!(drafts[0].payload["kind"], "create_page");
        assert_eq!(drafts[0].payload["args"]["content_text"], "正文");
        assert_eq!(drafts[1].payload["kind"], "append_block");
        assert_eq!(drafts[1].payload["pageId"], "p1");
        assert_eq!(drafts[1].payload["text"], "附注");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_capability_needs_permission_and_valid_args() {
        let (space, dir) = seed_space("write-perm");
        let mut denied = state_for_space(&space, &dir);
        denied.permissions = vec![];
        let err = call(&denied, "pages.create", r#"{"title":"x"}"#).unwrap_err();
        assert!(err.contains("permission_denied"), "实际: {err}");

        let mut ok = state_for_space(&space, &dir);
        ok.permissions = vec!["write:pages".to_string()];
        assert!(
            call(&ok, "pages.create", r#"{"title":"   "}"#).unwrap_err().contains("bad_args"),
            "空标题应当被拒"
        );
        assert!(
            call(&ok, "blocks.append", r#"{"text":""}"#).unwrap_err().contains("bad_args"),
            "空文本应当被拒"
        );
        // shim 的回归防线：必填参数缺失时不能被强转成字符串 "undefined"
        // （曾把 api.blocks.append("文本") 的文本当成 pageId、text 变成 "undefined"）。
        assert!(
            call(&ok, "blocks.append", "{}").unwrap_err().contains("bad_args"),
            "缺 text 必须报 bad_args"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_mediation_is_declared_for_every_write_capability() {
        // 注册表层面的不变式：写能力必须说清自己是"草稿确认"还是"即时"，
        // 非写能力不该声明。draft 类能力（会动用户内容）在实现里只产出草稿。
        for cap in capabilities_gen::CAPABILITIES {
            if cap.kind == "write" {
                assert!(
                    cap.mediate == "draft" || cap.mediate == "immediate",
                    "{} 缺少 mediate",
                    cap.id
                );
            } else {
                assert_eq!(cap.mediate, "-", "非写能力 {} 不该有 mediate", cap.id);
            }
        }
        assert_eq!(capabilities_gen::lookup("pages.create").unwrap().mediate, "draft");
        assert_eq!(capabilities_gen::lookup("kv.set").unwrap().mediate, "immediate");
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
        let (msg, _, _, _) = run_command_timeout(ok, "t.ok", &RunState::default()).unwrap();
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
        let (msg, _insert, toasts, _drafts) = run_command_timeout(source, "t.toast", &state).unwrap();
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
