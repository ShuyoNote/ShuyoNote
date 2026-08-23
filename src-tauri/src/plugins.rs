use crate::db::Db;
use boa_engine::{Context, JsString, JsValue, NativeFunction, Source};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::sync::MutexGuard;
use tauri::{AppHandle, Manager, State};

// ---------------------------------------------------------------------------
// Plugin model
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct PluginCommandMeta {
    pub id: String,
    pub title: String,
    pub description: String,
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

/// The `__od` host object methods read the current invocation from here.
thread_local! {
    static RUN_STATE: RefCell<RunState> = RefCell::new(RunState::default());
}
#[derive(Default)]
struct RunState {
    current_page_json: String,
    page_count: usize,
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
    // main must be a bare filename inside the dir (no path traversal).
    let main_path = Path::new(&m.main);
    if main_path.components().count() != 1 {
        return Err("manifest.main 必须是同级文件名".to_string());
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

fn host_toast(
    _this: &JsValue,
    args: &[JsValue],
    _ctx: &mut Context,
) -> boa_engine::JsResult<JsValue> {
    let msg = args
        .get(0)
        .and_then(|v| v.as_string())
        .map(|s| s.to_std_string_escaped())
        .unwrap_or_default();
    // Bridge to the UI toast is a later step; for now surface via stderr.
    eprintln!("[plugin toast] {msg}");
    Ok(JsValue::undefined())
}

// `register(cmd)` host fn: capture command metadata during discovery.
thread_local! {
    static DISCOVERED: RefCell<Vec<PluginCommandMeta>> = RefCell::new(vec![]);
}

fn host_register(
    _this: &JsValue,
    args: &[JsValue],
    ctx: &mut Context,
) -> boa_engine::JsResult<JsValue> {
    let mut meta = PluginCommandMeta {
        id: String::new(),
        title: String::new(),
        description: String::new(),
        close_on_run: false,
    };
    if let Some(obj) = args.get(0).and_then(|v| v.as_object()) {
        meta.id = obj
            .get(JsString::from("id"), ctx)
            .ok()
            .and_then(|v| v.as_string())
            .map(|s| s.to_std_string_escaped())
            .unwrap_or_default();
        meta.title = obj
            .get(JsString::from("title"), ctx)
            .ok()
            .and_then(|v| v.as_string())
            .map(|s| s.to_std_string_escaped())
            .unwrap_or_default();
        meta.description = obj
            .get(JsString::from("description"), ctx)
            .ok()
            .and_then(|v| v.as_string())
            .map(|s| s.to_std_string_escaped())
            .unwrap_or_default();
        meta.close_on_run = obj
            .get(JsString::from("closeOnRun"), ctx)
            .ok()
            .and_then(|v| v.as_string())
            .map(|s| s.to_std_string_escaped())
            .unwrap_or_default()
            == "true";
    }
    if !meta.id.is_empty() {
        DISCOVERED.with(|d| d.borrow_mut().push(meta));
    }
    Ok(JsValue::undefined())
}

/// Run a plugin's `main.js` and collect the registered command metadata.
fn discover_commands(source: &str, state: &RunState) -> Result<Vec<PluginCommandMeta>, String> {
    DISCOVERED.with(|d| d.borrow_mut().clear());
    let mut ctx = Context::default();
    set_run_state(&mut ctx, state)?;
    ctx.eval(Source::from_bytes(BOOTSTRAP.as_bytes()))
        .map_err(|e| format!("bootstrap 失败: {e}"))?;
    ctx.eval(Source::from_bytes(source.as_bytes()))
        .map_err(|e| format!("插件初始化失败: {e}"))?;
    let cmds = DISCOVERED.with(|d| d.borrow().clone());
    Ok(cmds)
}

fn set_run_state(ctx: &mut Context, state: &RunState) -> Result<(), String> {
    ctx.register_global_callable(
        JsString::from("register"),
        1,
        NativeFunction::from_fn_ptr(host_register),
    )
    .map_err(|e| e.to_string())?;
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
    RUN_STATE.with(|s| *s.borrow_mut() = RunState {
        current_page_json: state.current_page_json.clone(),
        page_count: state.page_count,
    });
    Ok(())
}

/// Execute a single plugin command in a fresh boa context (re-evaluate the
/// plugin, then run the command). Returns the command's result string.
fn run_command(source: &str, command_id: &str, state: &RunState) -> Result<String, String> {
    let mut ctx = Context::default();
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

// ---------------------------------------------------------------------------
// DB helpers for enabled state
// ---------------------------------------------------------------------------

fn conn<'a>(db: &'a State<'_, Db>) -> MutexGuard<'a, Connection> {
    db.0.lock().unwrap()
}

/// Seed a bundled demo plugin on first run so `list_plugins` / `run_plugin_command`
/// have something to discover and execute (idempotent).
pub fn ensure_demo_plugin(app: &AppHandle) -> Result<(), String> {
    let root = plugins_root(app)?;
    let dir = root.join("demo");
    if dir.join("main.js").exists() {
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
"#,
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn enabled_key(id: &str) -> String {
    format!("plugin_enabled::{id}")
}

fn enabled(c: &Connection, id: &str) -> bool {
    c.query_row(
        "SELECT value FROM sync_state WHERE key = ?1",
        params![enabled_key(id)],
        |r| r.get::<_, String>(0),
    )
    .map(|v| v == "1")
    .unwrap_or(true) // default enabled
}

fn set_enabled(c: &Connection, id: &str, on: bool) -> Result<(), String> {
    c.execute(
        "INSERT INTO sync_state (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![enabled_key(id), if on { "1" } else { "0" }],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_plugins(app: AppHandle, db: State<Db>) -> Result<Vec<PluginMeta>, String> {
    let root = plugins_root(&app)?;
    let c = conn(&db);
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
        let state = RunState::default();
        let commands = discover_commands(&source, &state).unwrap_or_default();
        let pid = manifest.id.clone();
        out.push(PluginMeta {
            id: pid.clone(),
            name: manifest.name,
            version: manifest.version,
            description: manifest.description,
            enabled: enabled(&c, &pid),
            commands,
        });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

#[tauri::command]
pub fn set_plugin_enabled(db: State<Db>, id: String, enabled: bool) -> Result<(), String> {
    let c = conn(&db);
    set_enabled(&c, &id, enabled)
}

#[tauri::command]
pub fn run_plugin_command(
    app: AppHandle,
    db: State<Db>,
    plugin_id: String,
    command_id: String,
    current_id: Option<String>,
) -> Result<String, String> {
    let root = plugins_root(&app)?;
    let dir = root.join(&plugin_id);
    let manifest = read_manifest(&dir)?;
    let source = load_plugin_source(&dir, &manifest)?;
    let c = conn(&db);
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
    let state = RunState {
        page_count,
        current_page_json,
    };
    run_command(&source, &command_id, &state)
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
        let state = RunState { current_page_json: String::new(), page_count: 7 };
        let res = run_command(source, "t.hello", &state).unwrap();
        assert_eq!(res, "hi 7");
    }

    #[test]
    fn reports_missing_command() {
        let source = r#"register({ id: "t.hello", title: "Hello", description: "", closeOnRun: false, run: function(){ return "x"; } });"#;
        let state = RunState { current_page_json: String::new(), page_count: 0 };
        let res = run_command(source, "t.nope", &state).unwrap();
        assert!(res.contains("命令不存在"));
    }
}
