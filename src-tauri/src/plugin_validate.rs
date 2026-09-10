// 插件校验内核：给作者工具链（应用内「验证」、`scripts/plugin-cli.mjs` 的对照面、
// 示例插件的回归测试）提供**与加载器同源**的检查。
//
// 为什么单独一层：作者最怕的不是报错，而是「本地说没问题、应用装上去才发现不行」。
// 所以这里做两件事：
//   1. **不短路**——一次列出所有要改的地方（加载器只需第一个错误就够，作者不够）；
//   2. **以加载器为准**——收集完细节后，再按加载器的真实路径（`read_manifest` +
//      `load_plugin_source`）走一遍；只要加载器会拒，报告里必然至少有一条 error
//      （`loader_rejected`）。这样「报告说 ok、应用却拒载」在结构上不可能发生，
//      而不是靠两套规则手工保持一致。
//
// 检查项按作者能改的东西组织：manifest 字段 → 权限（含 reason）→ JS 语法 →
// 顶层代码能不能跑起来并注册命令。

use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use boa_engine::Source;
use serde::Serialize;
use tauri::AppHandle;

use crate::capabilities_gen;
use crate::plugins::{
    PluginCommandMeta, PluginEventMeta, is_bare_file_name, is_safe_plugin_id, plugins_root,
    read_manifest, resolve_permissions,
};

/// 入口文件超过这个体积就提醒（插件应当是脚本，不是打包产物）。
const BIG_ENTRY_BYTES: u64 = 512 * 1024;

#[derive(Serialize, Clone, Debug)]
pub struct PluginProblem {
    /// 稳定错误码：作者文档按它写说明，前端按它分组，测试按它断言。
    pub code: String,
    /// 给人看的一句话（含怎么改）。
    pub message: String,
    /// `error` 会让插件装不进去/跑不起来；`warning` 只是建议。
    pub severity: String,
    /// 相关文件（相对插件目录），无则为 None。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
}

impl PluginProblem {
    fn error(code: &str, message: impl Into<String>, file: Option<&str>) -> Self {
        Self { code: code.into(), message: message.into(), severity: "error".into(), file: file.map(str::to_string) }
    }
    fn warn(code: &str, message: impl Into<String>, file: Option<&str>) -> Self {
        Self { code: code.into(), message: message.into(), severity: "warning".into(), file: file.map(str::to_string) }
    }
}

/// 一条权限在**作者视角**下的状态：认不认识、有没有写理由、最终授不授予。
#[derive(Serialize, Clone, Debug)]
pub struct PermissionView {
    pub id: String,
    pub title: String,
    pub reason: String,
    pub risk: String,
    /// 当前应用版本是否认识这项权限（不认识 = 该条被忽略）。
    pub known: bool,
    pub has_reason: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct ValidateReport {
    /// 是否没有任何 error（warning 不影响）。
    pub ok: bool,
    /// 目录名（不回传绝对路径：报告可能被贴进 issue）。
    pub dir_name: String,
    pub id: String,
    pub name: String,
    pub version: String,
    pub api_version: String,
    pub main: String,
    pub entry_bytes: u64,
    pub commands: Vec<PluginCommandMeta>,
    /// 权限现状：声明了哪些、认不认识、有没有理由。
    pub permissions: Vec<PermissionView>,
    /// 最终**实际授予**的权限（未声明 permissions 时是 v1 基线集合）。
    pub granted: Vec<String>,
    /// 订阅了哪些事件（用户没点命令时也会跑代码，所以要在报告里说清楚）。
    pub events: Vec<PluginEventMeta>,
    /// 是否走了老 manifest 的基线授权（作者应显式声明）。
    pub permissions_baseline: bool,
    pub problems: Vec<PluginProblem>,
}

impl ValidateReport {
    pub fn errors(&self) -> impl Iterator<Item = &PluginProblem> {
        self.problems.iter().filter(|p| p.severity == "error")
    }
}

/// 从 manifest 字段里取字符串（字段缺失/类型不对都当作缺失，由 schema 检查另外报）。
fn field_str(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(str::to_string)
}

/// 校验一个插件目录。**不短路**：所有问题都会出现在 `problems` 里。
pub fn validate_dir(dir: &Path) -> ValidateReport {
    let dir_name = dir.file_name().and_then(|s| s.to_str()).unwrap_or_default().to_string();
    let mut problems: Vec<PluginProblem> = Vec::new();

    // ---- 1. manifest 能不能读、是不是合法 JSON ----
    let manifest_path = dir.join("manifest.json");
    let text = match std::fs::read_to_string(&manifest_path) {
        Ok(t) => Some(t),
        Err(e) => {
            problems.push(PluginProblem::error(
                "manifest_missing",
                format!("读不到 manifest.json：{e}（插件目录里必须有 manifest.json）"),
                Some("manifest.json"),
            ));
            None
        }
    };
    let value: Option<serde_json::Value> = match &text {
        Some(t) => match serde_json::from_str::<serde_json::Value>(t) {
            Ok(v) => Some(v),
            Err(e) => {
                problems.push(PluginProblem::error(
                    "manifest_json",
                    format!("manifest.json 不是合法 JSON：{e}"),
                    Some("manifest.json"),
                ));
                None
            }
        },
        None => None,
    };

    // ---- 2. 逐字段检查（给作者具体的那一条，而不是笼统的「解析失败」）----
    let mut id = String::new();
    let mut name = String::new();
    let mut version = String::new();
    let mut api_version = String::new();
    let mut main = String::new();
    if let Some(v) = &value {
        id = field_str(v, "id").unwrap_or_default();
        name = field_str(v, "name").unwrap_or_default();
        version = field_str(v, "version").unwrap_or_default();
        api_version = field_str(v, "apiVersion").unwrap_or_default();
        main = field_str(v, "main").unwrap_or_else(|| "main.js".to_string());

        if id.is_empty() {
            problems.push(PluginProblem::error("id_missing", "manifest.id 缺失（每个插件必须有唯一 id）", Some("manifest.json")));
        } else if !is_safe_plugin_id(&id) {
            problems.push(PluginProblem::error(
                "id_unsafe",
                format!("id「{id}」不合法：只允许字母数字与 `_` `.` `-`，且不得是 `.`/`..`/全点/以点结尾"),
                Some("manifest.json"),
            ));
        } else if id != dir_name {
            problems.push(PluginProblem::error(
                "id_mismatch",
                format!("manifest.id（{id}）必须等于目录名（{dir_name}）"),
                Some("manifest.json"),
            ));
        }
        if name.is_empty() {
            problems.push(PluginProblem::error("name_missing", "manifest.name 缺失（界面上要显示它）", Some("manifest.json")));
        }
        if version.is_empty() {
            problems.push(PluginProblem::warn("version_missing", "建议写 manifest.version（如 \"1.0.0\"），便于用户判断装的是哪版", Some("manifest.json")));
        }
        if api_version.is_empty() {
            problems.push(PluginProblem::warn(
                "api_version_missing",
                format!(
                    "建议显式声明 manifest.apiVersion（当前 {}），缺省按它处理",
                    capabilities_gen::API_VERSION
                ),
                Some("manifest.json"),
            ));
        } else {
            let major = api_version.split('.').next().unwrap_or_default().parse::<u32>().unwrap_or(0);
            if major != capabilities_gen::API_MAJOR {
                problems.push(PluginProblem::error(
                    "api_version_unsupported",
                    format!(
                        "apiVersion「{api_version}」的主版本不受支持（本应用支持 {}）：主版本不认识会直接拒载",
                        capabilities_gen::API_VERSION
                    ),
                    Some("manifest.json"),
                ));
            }
        }
        if !is_bare_file_name(&main) {
            problems.push(PluginProblem::error(
                "main_invalid",
                format!("manifest.main（{main}）必须是同级文件名：不得含路径分隔符，也不得是 `.`/`..`"),
                Some("manifest.json"),
            ));
        }
    }

    // ---- 3. 入口文件 ----
    let mut entry_bytes = 0u64;
    let mut source: Option<String> = None;
    if !main.is_empty() && is_bare_file_name(&main) {
        let p = dir.join(&main);
        match std::fs::metadata(&p) {
            Ok(md) => {
                entry_bytes = md.len();
                if entry_bytes == 0 {
                    problems.push(PluginProblem::error("main_empty", format!("入口文件 {main} 是空的"), Some(&main)));
                } else if entry_bytes > BIG_ENTRY_BYTES {
                    problems.push(PluginProblem::warn(
                        "main_large",
                        format!("入口文件 {main} 有 {:.1} MiB：插件应当是脚本而不是打包产物（体积大也会拖慢每次加载）", entry_bytes as f64 / 1048576.0),
                        Some(&main),
                    ));
                }
            }
            Err(e) => problems.push(PluginProblem::error(
                "main_missing",
                format!("入口文件 {main} 不存在或不读：{e}"),
                Some(&main),
            )),
        }
    }

    // ---- 4. 权限：认不认识、有没有理由、重复 ----
    let mut permissions: Vec<PermissionView> = Vec::new();
    let mut permissions_baseline = false;
    let mut granted: Vec<String> = Vec::new();
    if let Some(v) = &value {
        // 与加载器同一套判定：未知权限忽略、缺 reason 警告、无 permissions 走基线授权。
        let manifest_for_perms = manifest_from_value(v, &dir_name);
        if let Some(m) = &manifest_for_perms {
            let (g, warns) = resolve_permissions(m);
            granted = g;
            permissions_baseline = m.permissions.is_none();
            for w in warns {
                problems.push(PluginProblem::warn("permission_note", w, Some("manifest.json")));
            }
            // 这里刻意**不从 `permission_metas` 取**：那个函数只列「实际授予」的权限
            // （安装界面的语义），而校验器要如实列出**作者写了什么**——包括本版本
            // 不认识、会被忽略的那些，否则作者看不到自己那行白写了。
            match &m.permissions {
                Some(decls) => {
                    for d in decls {
                        let p = capabilities_gen::permission(&d.id);
                        permissions.push(PermissionView {
                            id: d.id.clone(),
                            title: p.map(|p| p.title.to_string()).unwrap_or_else(|| d.id.clone()),
                            reason: d.reason.clone(),
                            risk: p.map(|p| p.risk.to_string()).unwrap_or_default(),
                            known: p.is_some(),
                            has_reason: !d.reason.trim().is_empty(),
                        });
                    }
                }
                None => {
                    // 未声明 → 基线授权：把**实际授予**的列出来，作者才知道自己拿到了什么
                    for id in &granted {
                        let p = capabilities_gen::permission(id);
                        permissions.push(PermissionView {
                            id: id.clone(),
                            title: p.map(|p| p.title.to_string()).unwrap_or_else(|| id.clone()),
                            reason: "（旧 manifest 未声明权限，按 v1 基线授权）".to_string(),
                            risk: p.map(|p| p.risk.to_string()).unwrap_or_default(),
                            known: p.is_some(),
                            has_reason: false,
                        });
                    }
                }
            }
            // 重复声明（加载器会去重，但作者多半是改漏了）
            if let Some(decls) = &m.permissions {
                let mut seen: Vec<&str> = Vec::new();
                let mut dupes: Vec<String> = Vec::new();
                for d in decls {
                    if seen.contains(&d.id.as_str()) {
                        if !dupes.contains(&d.id) {
                            dupes.push(d.id.clone());
                        }
                    } else {
                        seen.push(&d.id);
                    }
                }
                if !dupes.is_empty() {
                    problems.push(PluginProblem::warn("permission_duplicate", format!("权限重复声明：{}", dupes.join("、")), Some("manifest.json")));
                }
            }
        }
    }

    // ---- 4.5 事件订阅（与权限同源的判定：未知事件忽略 + 警告、缺 reason 警告）----
    let mut events: Vec<PluginEventMeta> = Vec::new();
    if let Some(v) = &value {
        if let Some(m) = manifest_from_value(v, &dir_name) {
            let (_subscribed, warns) = crate::plugins::resolve_events(&m);
            for w in warns {
                problems.push(PluginProblem::warn("event_note", w, Some("manifest.json")));
            }
            events = crate::plugins::event_metas(&m);
        }
    }

    // ---- 5. JS 语法（Boa 解析，不执行）----
    // 与运行同一个引擎，所以「本地能过、应用装上去语法错」不可能发生。
    if let Some(src) = read_entry_source(dir, &main) {
        source = Some(src.clone());
        let mut ctx = crate::plugins::plugin_parse_context();
        match boa_engine::Script::parse(Source::from_bytes(src.as_bytes()), None, &mut ctx) {
            Ok(_) => {}
            Err(e) => problems.push(PluginProblem::error(
                "syntax_error",
                format!("JS 语法错误（Boa 解析失败）：{e}"),
                Some(&main),
            )),
        }
    }

    // ---- 6. 顶层代码 + 命令注册（真正跑一次 discovery）----
    let mut commands: Vec<PluginCommandMeta> = Vec::new();
    if let Some(src) = &source {
        let manifest_for_run = value.as_ref().and_then(|v| manifest_from_value(v, &dir_name));
        let run_id = manifest_for_run.as_ref().map(|m| m.id.clone()).unwrap_or_else(|| dir_name.clone());
        let perms = if granted.is_empty() && manifest_for_run.is_none() {
            // manifest 完全不可用时也要能报出「顶层代码跑不起来」，给一组基线权限即可。
            crate::plugins::baseline_permission_ids()
        } else {
            granted.clone()
        };
        match crate::plugins::discover_commands_timed(&run_id, &perms, src, crate::plugins::DISCOVER_TIMEOUT) {
            Ok(cmds) => {
                if cmds.is_empty() {
                    problems.push(PluginProblem::warn(
                        "no_commands",
                        "插件没有注册任何命令：`register({ id, title, run })` 之后命令才会出现在命令面板里",
                        Some(&main),
                    ));
                }
                let mut seen: Vec<&str> = Vec::new();
                for c in &cmds {
                    if c.title.trim().is_empty() {
                        problems.push(PluginProblem::warn("command_no_title", format!("命令 {} 没有 title（命令面板里会显示空）", c.id), Some(&main)));
                    }
                    // 触发面：只认识注册表里的入口；**没实现的也如实告知**，不静默丢掉
                    for m in &c.menus {
                        match capabilities_gen::menu(m) {
                            Some(menu) if menu.hosted => {}
                            Some(menu) => problems.push(PluginProblem::warn(
                                "menu_not_hosted",
                                format!(
                                    "命令 {} 声明出现在「{}」，但宿主还没实现这个入口（写了现在也不会出现）",
                                    c.id, menu.title
                                ),
                                Some(&main),
                            )),
                            None => problems.push(PluginProblem::warn(
                                "menu_unknown",
                                format!("命令 {} 声明的触发面「{}」不存在（当前 API 版本不认识）", c.id, m),
                                Some(&main),
                            )),
                        }
                    }
                    if seen.contains(&c.id.as_str()) {
                        problems.push(PluginProblem::warn("command_duplicate", format!("命令 id 重复注册：{}", c.id), Some(&main)));
                    } else {
                        seen.push(&c.id);
                    }
                }
                commands = cmds;
            }
            Err(e) => problems.push(PluginProblem::error(
                "load_failed",
                format!("插件顶层代码没能跑完（发现命令失败）：{e}"),
                Some(&main),
            )),
        }
    }

    // ---- 7. 兜底：按加载器的真实路径再走一遍 ----
    // 前面各步是「给作者看的细节」，这一步是「应用到底会不会拒载」的硬保证：
    // 只要加载器会拒，报告里必然至少有这一条 error。
    if let Err(e) = read_manifest(dir).and_then(|m| crate::plugins::load_plugin_source(dir, &m)) {
        let already = problems.iter().any(|p| p.severity == "error");
        if !already {
            problems.push(PluginProblem::error("loader_rejected", format!("加载器会拒载这个插件：{e}"), None));
        }
    }

    let ok = !problems.iter().any(|p| p.severity == "error");
    ValidateReport {
        ok,
        dir_name,
        id,
        name,
        version,
        api_version: if api_version.is_empty() { capabilities_gen::API_VERSION.to_string() } else { api_version },
        main,
        entry_bytes,
        commands,
        permissions,
        granted,
        events,
        permissions_baseline,
        problems,
    }
}

fn read_entry_source(dir: &Path, main: &str) -> Option<String> {
    if main.is_empty() || !is_bare_file_name(main) {
        return None;
    }
    std::fs::read_to_string(dir.join(main)).ok()
}

/// 宽松地把 JSON 值当 manifest 用（只在字段齐全到足以判定权限时才返回）。
/// 目的是**复用加载器的 `resolve_permissions` / `permission_metas`**，而不是另写一套。
fn manifest_from_value(v: &serde_json::Value, dir_name: &str) -> Option<crate::plugins::Manifest> {
    let mut obj = v.clone();
    let m = obj.as_object_mut()?;
    // id 必须是安全的（否则后续用 id 记日志会出问题），缺失时退回目录名
    if !m.get("id").map(|x| x.as_str().map(is_safe_plugin_id).unwrap_or(false)).unwrap_or(false) {
        m.insert("id".into(), serde_json::Value::String(dir_name.to_string()));
    }
    if !m.contains_key("name") {
        m.insert("name".into(), serde_json::Value::String(dir_name.to_string()));
    }
    serde_json::from_value(serde_json::Value::Object(m.clone())).ok()
}

/// 插件根目录下的目录清单（校验/热重载共用）。
pub fn plugin_dirs(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(root) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}

impl ValidateReport {
    /// 目录不存在时也给一份**同形状**的报告：前端只需处理一种结构。
    fn not_found(dir_name: &str) -> Self {
        Self {
            ok: false,
            dir_name: dir_name.to_string(),
            id: dir_name.to_string(),
            name: String::new(),
            version: String::new(),
            api_version: capabilities_gen::API_VERSION.to_string(),
            main: String::new(),
            entry_bytes: 0,
            commands: Vec::new(),
            permissions: Vec::new(),
            granted: Vec::new(),
            events: Vec::new(),
            permissions_baseline: false,
            problems: vec![PluginProblem::error(
                "dir_missing",
                format!("插件目录不存在：{dir_name}（放进插件目录后重新扫描即可）"),
                None,
            )],
        }
    }
}

/// 校验一个**已安装**插件（按 id）。
///
/// 只允许 id（不接受任意路径）：作者把目录放进插件目录后用应用内「验证」，
/// 仓库里写插件的场景走 `pnpm plugin:validate <dir>`（Node 侧对照面）。
#[tauri::command]
pub fn validate_plugin(app: AppHandle, id: String) -> Result<ValidateReport, String> {
    if !is_safe_plugin_id(&id) {
        return Err(format!("非法插件 id：{id}"));
    }
    let dir = plugins_root(&app)?.join(&id);
    if !dir.is_dir() {
        return Ok(ValidateReport::not_found(&id));
    }
    Ok(validate_dir(&dir))
}

/// 插件目录的指纹（文件名 + 大小 + mtime）。
///
/// 热重载靠它：前端在面板打开期间低频轮询，指纹变了就重新扫描。
/// 之所以不引文件监听库（`notify`）：多一个依赖、多一套跨平台行为差异，
/// 而这里要的只是「有没有变」，一次 `read_dir` + 元数据足够便宜。
#[tauri::command]
pub fn plugin_dir_stamp(app: AppHandle) -> Result<String, String> {
    let root = plugins_root(&app)?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for dir in plugin_dirs(&root) {
        dir.file_name().unwrap_or_default().to_string_lossy().hash(&mut hasher);
        let mut files: Vec<(String, u64, u128)> = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for e in entries.flatten() {
                let md = match e.metadata() {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                if !md.is_file() {
                    continue;
                }
                let mtime = md
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_nanos())
                    .unwrap_or(0);
                files.push((e.file_name().to_string_lossy().to_string(), md.len(), mtime));
            }
        }
        files.sort();
        files.hash(&mut hasher);
    }
    Ok(format!("{:016x}", hasher.finish()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    // ---- 工具 ----

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "shuyonote-validate-test-{}-{tag}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 在 `base` 下建一个插件目录：`manifest` 里用 `{dir}` 占位目录名。
    fn plugin(dirname: &str, manifest: &str) -> PathBuf {
        let base = temp_dir(dirname);
        let dir = base.join(dirname);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("manifest.json"), manifest.replace("{dir}", dirname)).unwrap();
        dir
    }

    fn write_main(dir: &Path, name: &str, src: &str) {
        fs::write(dir.join(name), src).unwrap();
    }

    fn codes(r: &ValidateReport) -> Vec<String> {
        r.problems.iter().map(|p| p.code.clone()).collect()
    }

    const OK_MAIN: &str = "register({ id: 'demo.run', title: '演示', run: function () { return 'ok'; } });";

    fn manifest_json(id: &str, extra: &str) -> String {
        format!(
            r#"{{ "id": "{id}", "name": "演示插件", "version": "1.0.0", "apiVersion": "1.0.0", "main": "main.js"{extra} }}"#
        )
    }

    // ---- 真实示例插件：必须零错误、且真的注册得出命令 ----
    // 这条测试是「示例插件可安装可运行」的机器化验收：它走的是与加载器同源的
    // read_manifest + Boa discovery，而不是「看起来像对」。

    #[test]
    fn examples_in_repo_validate_clean() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/plugins");
        assert!(root.is_dir(), "示例插件目录不存在：{}", root.display());
        let dirs = plugin_dirs(&root);
        assert!(dirs.len() >= 3, "示例插件至少 3 个（当前 {}）", dirs.len());
        for d in &dirs {
            let r = validate_dir(d);
            assert_eq!(
                r.errors().count(),
                0,
                "示例插件 {} 有错误：{:?}",
                d.display(),
                r.problems
            );
            assert!(r.ok, "示例插件 {} 应当 ok", d.display());
            assert!(!r.commands.is_empty(), "示例插件 {} 至少要注册一个命令", d.display());
            assert!(
                !r.permissions.is_empty(),
                "示例插件 {} 应当显式声明权限（示范权限模型）",
                d.display()
            );
            assert!(
                r.permissions.iter().all(|p| p.known && p.has_reason),
                "示例插件 {} 的权限必须都是本版本认识的、且都写了 reason：{:?}",
                d.display(),
                r.permissions
            );
            assert!(!r.permissions_baseline, "示例插件 {} 不应走基线授权（那会示范成坏习惯）", d.display());
            for ev in &r.events {
                assert!(!ev.reason.trim().is_empty(), "示例插件 {} 的事件 {} 应当写 reason（示范给用户看的授权面）", d.display(), ev.id);
            }
        }
    }

    // ---- 作者会犯的错：每种都要报出来，且给稳定的 code ----

    #[test]
    fn id_must_equal_dir_name() {
        let dir = plugin("demo-a", &manifest_json("something-else", ""));
        write_main(&dir, "main.js", OK_MAIN);
        let r = validate_dir(&dir);
        assert!(codes(&r).contains(&"id_mismatch".to_string()), "{:?}", r.problems);
        assert!(!r.ok);
    }

    #[test]
    fn unsafe_id_is_rejected() {
        let dir = plugin("demo-b", &manifest_json("../evil", ""));
        write_main(&dir, "main.js", OK_MAIN);
        let r = validate_dir(&dir);
        assert!(codes(&r).contains(&"id_unsafe".to_string()), "{:?}", r.problems);
    }

    #[test]
    fn unsupported_api_major_is_error() {
        let dir = plugin(
            "demo-c",
            &manifest_json("demo-c", r#", "permissions": []"#).replace(r#""apiVersion": "1.0.0""#, r#""apiVersion": "2.0.0""#),
        );
        write_main(&dir, "main.js", OK_MAIN);
        let r = validate_dir(&dir);
        assert!(codes(&r).contains(&"api_version_unsupported".to_string()), "{:?}", r.problems);
    }

    #[test]
    fn missing_api_version_is_only_a_warning() {
        let dir = plugin("demo-d", &manifest_json("demo-d", "").replace(r#", "apiVersion": "1.0.0""#, ""));
        write_main(&dir, "main.js", OK_MAIN);
        let r = validate_dir(&dir);
        assert!(codes(&r).contains(&"api_version_missing".to_string()), "{:?}", r.problems);
        assert!(r.ok, "缺 apiVersion 只是警告，不该阻断");
    }

    #[test]
    fn syntax_error_is_reported_with_boa() {
        let dir = plugin("demo-e", &manifest_json("demo-e", ""));
        write_main(&dir, "main.js", "register({ id: 'x', title: 'y', run: function () { "); // 少一个 }
        let r = validate_dir(&dir);
        assert!(codes(&r).contains(&"syntax_error".to_string()), "{:?}", r.problems);
        assert!(r.commands.is_empty());
    }

    #[test]
    fn missing_entry_file_is_reported() {
        let dir = plugin("demo-f", &manifest_json("demo-f", r#", "main": "nope.js""#).replace(r#""main": "main.js", "#, ""));
        let r = validate_dir(&dir);
        assert!(codes(&r).contains(&"main_missing".to_string()), "{:?}", r.problems);
    }

    #[test]
    fn invalid_manifest_json_is_reported() {
        let base = temp_dir("demo-g");
        let dir = base.join("demo-g");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("manifest.json"), "{ not json").unwrap();
        let r = validate_dir(&dir);
        assert!(codes(&r).contains(&"manifest_json".to_string()), "{:?}", r.problems);
        assert!(r.errors().count() >= 1);
    }

    #[test]
    fn unknown_permission_and_missing_reason_are_warnings() {
        let dir = plugin(
            "demo-h",
            &manifest_json(
                "demo-h",
                r#", "permissions": [ { "id": "read:pages" }, { "id": "read:不存在的权限", "reason": "试试" } ]"#,
            ),
        );
        write_main(&dir, "main.js", OK_MAIN);
        let r = validate_dir(&dir);
        assert!(r.ok, "未知权限/缺 reason 都只是警告：{:?}", r.problems);
        let notes: Vec<&PluginProblem> = r.problems.iter().filter(|p| p.code == "permission_note").collect();
        assert!(
            notes.iter().any(|p| p.message.contains("reason")),
            "缺 reason 应当被指出：{:?}",
            r.problems
        );
        assert!(
            notes.iter().any(|p| p.message.contains("未知权限")),
            "未知权限应当被指出：{:?}",
            r.problems
        );
        // 未知权限不授予，已知的才授予
        assert_eq!(r.granted, vec!["read:pages".to_string()]);
        // 声明视图如实反映作者写了什么：不认识的也在列（known=false），理由有没有如实标出
        let unknown = r.permissions.iter().find(|p| !p.known).expect("应当有一条未知权限");
        assert_eq!(unknown.id, "read:不存在的权限");
        assert!(unknown.has_reason, "这条作者写了 reason");
        let known = r.permissions.iter().find(|p| p.id == "read:pages").expect("应当有 read:pages");
        assert!(known.known);
        assert!(!known.has_reason, "这条作者没写 reason");
    }

    #[test]
    fn plugin_without_commands_is_warned() {
        let dir = plugin("demo-i", &manifest_json("demo-i", ""));
        write_main(&dir, "main.js", "var x = 1; // 忘了调 register");
        let r = validate_dir(&dir);
        assert!(codes(&r).contains(&"no_commands".to_string()), "{:?}", r.problems);
        assert!(r.ok, "没有命令只是警告（也许作者正在写）");
    }

    /// 兜底那一步的意义：即使前面的细节检查都没意见，只要**加载器**会拒，就必须有 error。
    /// 用 `permissions` 类型错误（对象而非数组）来构造：字段级检查看不出问题，
    /// 但加载器的严格反序列化会失败。
    #[test]
    fn loader_rejection_is_never_missed() {
        let dir = plugin(
            "demo-j",
            &manifest_json("demo-j", r#", "permissions": { "read:pages": true }"#),
        );
        write_main(&dir, "main.js", OK_MAIN);
        let r = validate_dir(&dir);
        assert!(r.errors().count() >= 1, "加载器会拒载时报告里必须有 error：{:?}", r.problems);
        assert!(!r.ok);
    }

    #[test]
    fn report_shape_carries_author_facing_facts() {
        let dir = plugin(
            "demo-k",
            &manifest_json("demo-k", r#", "permissions": [ { "id": "read:pages", "reason": "看页面列表" } ]"#),
        );
        write_main(&dir, "main.js", "register({ id: 'demo-k.a', title: '甲', run: function(){ return ''; } });");
        let r = validate_dir(&dir);
        assert!(r.ok, "{:?}", r.problems);
        assert_eq!(r.id, "demo-k");
        assert_eq!(r.main, "main.js");
        assert_eq!(r.commands.len(), 1);
        assert_eq!(r.granted, vec!["read:pages".to_string()]);
        assert_eq!(r.permissions[0].title.is_empty(), false);
        assert!(r.entry_bytes > 0);
    }
}
