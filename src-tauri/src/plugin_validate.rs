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
    /// 声明的可配置项（宿主据此渲染设置表单）。
    pub settings: Vec<crate::plugins::SettingDecl>,
    /// 运行档：`logic`（有代码）或 `declarative`（零 JS，只有声明）。
    pub runtime: String,
    /// 声明式视图（宿主渲染；逻辑档恒为空）。
    pub views: Vec<crate::plugins::ViewDecl>,
    /// 是否走了老 manifest 的基线授权（作者应显式声明）。
    pub permissions_baseline: bool,
    pub problems: Vec<PluginProblem>,
}

impl ValidateReport {
    pub fn errors(&self) -> impl Iterator<Item = &PluginProblem> {
        self.problems.iter().filter(|p| p.severity == "error")
    }
}

/// 主题声明的检查（**两档共用**：主题是纯数据，逻辑档插件同样可以出主题）。
///
/// 为什么单独一个函数：这条检查要同时在「逻辑档」与「声明式」两条路径上跑，而在主流程里
/// 插条件分支已经让我错过一次（把声明式的早退嵌进了 `if !declarative` 里）。独立函数 +
/// 两处显式调用，谁都不会漏。
fn check_theme_declaration(value: Option<&serde_json::Value>, problems: &mut Vec<PluginProblem>) {
    let Some(theme) = value.and_then(|v| v.get("theme")) else {
        return;
    };
    let Some(map) = theme.get("tokens").and_then(|t| t.as_object()) else {
        problems.push(PluginProblem::error(
            "theme_no_tokens",
            "theme 里没有 tokens（主题插件就是一组设计变量）",
            Some("manifest.json"),
        ));
        return;
    };
    if map.len() > crate::plugins::MAX_THEME_TOKENS {
        problems.push(PluginProblem::warn(
            "theme_too_many",
            format!(
                "声明了 {} 个主题变量（上限 {}）：主题是一组外观值，堆量只会让界面变成四不像",
                map.len(),
                crate::plugins::MAX_THEME_TOKENS
            ),
            Some("manifest.json"),
        ));
    }
    let mut names: Vec<&String> = map.keys().collect();
    names.sort();
    for name in names {
        let val = map.get(name).and_then(|x| x.as_str()).unwrap_or("");
        match capabilities_gen::theme_token(name) {
            None => problems.push(PluginProblem::warn(
                "theme_unknown_token",
                format!(
                    "主题变量 {name} 不在白名单里（宿主只应用外观类变量，布局度量刻意不给改）——这一项会被忽略"
                ),
                Some("manifest.json"),
            )),
            Some(tok) => {
                if let Err(e) = crate::plugins::validate_theme_value(tok, val) {
                    // 值不合法是**错误**而不是提醒：它会被写进页面样式，一个 url( 就能对外发请求。
                    problems.push(PluginProblem::error(
                        "theme_bad_value",
                        format!("主题变量 {name} 的值「{val}」不合法：{e}"),
                        Some("manifest.json"),
                    ));
                }
            }
        }
    }
}

/// `manifest.triggers` 的**共用检查**（导入触发，M11.9）。
///
/// 与主题检查同样是**独立函数 + 两档各显式调一次**：这条检查要在「逻辑档」与「声明式」
/// 两条路径上都跑，而在主流程里插条件分支已经让我错过一次（把声明式的早退嵌进了
/// `if !declarative` 里，逻辑档的检查全被截住）。独立函数 + 两处显式调用，谁都不会漏。
///
/// 严重度按「用户会不会白点一次」分：
/// - **kind 不认识 → 错误**：宿主不会为它加入口，作者以为接住了某类文件，实际什么都不发生；
/// - **command 为空 → 错误**：入口就算出现，点了也只会拿到「命令不存在」；
/// - **extensions 为空 / 不合法 → 提醒**：宿主会忽略这一项（不猜作者想接什么文件），
///   插件本身仍然装得上、跑得起来，所以只是提醒。
fn check_triggers_declaration(value: Option<&serde_json::Value>, problems: &mut Vec<PluginProblem>) {
    let Some(raw) = value.and_then(|v| v.get("triggers")) else {
        return;
    };
    let Some(list) = raw.as_array() else {
        // 写成对象/字符串会被加载器整个拒载（serde 解析失败），所以这是错误而不是提醒。
        problems.push(PluginProblem::error(
            "trigger_not_array",
            "manifest.triggers 必须是数组：[{ kind, extensions, command }]",
            Some("manifest.json"),
        ));
        return;
    };
    if list.len() > crate::plugins::MAX_TRIGGERS {
        problems.push(PluginProblem::warn(
            "trigger_too_many",
            format!(
                "声明了 {} 条导入触发（上限 {}）：声明是给人看的，堆量只会让命令面板变成一锅粥",
                list.len(),
                crate::plugins::MAX_TRIGGERS
            ),
            Some("manifest.json"),
        ));
    }
    let known: Vec<&str> = capabilities_gen::TRIGGERS.iter().map(|t| t.id).collect();
    for (i, t) in list.iter().enumerate() {
        let at = format!("triggers[{i}]");
        let kind = t.get("kind").and_then(|k| k.as_str()).unwrap_or_default().trim().to_string();
        let command = t.get("command").and_then(|c| c.as_str()).unwrap_or_default().trim().to_string();

        match capabilities_gen::trigger(&kind) {
            None => problems.push(PluginProblem::error(
                "trigger_unknown_kind",
                format!(
                    "{at} 的 kind「{kind}」不认识（本版本支持：{}）：宿主不会为它加入口，写上去什么都不会发生",
                    known.join(" / ")
                ),
                Some("manifest.json"),
            )),
            Some(k) if !k.hosted => problems.push(PluginProblem::warn(
                "trigger_not_hosted",
                format!("{at} 的 kind「{kind}」本版本还没有宿主入口（{}）：写了现在也不会出现", k.title),
                Some("manifest.json"),
            )),
            Some(_) => {}
        }

        if command.is_empty() {
            problems.push(PluginProblem::error(
                "trigger_no_command",
                format!("{at} 没有 command：导入触发要把文件内容交给一个命令，没写就等于让用户点了没反应"),
                Some("manifest.json"),
            ));
        }

        match t.get("extensions").and_then(|e| e.as_array()) {
            None => problems.push(PluginProblem::warn(
                "trigger_no_extensions",
                format!("{at} 没有声明 extensions：宿主不知道该在哪些文件上出现这个入口（例如 [\".md\", \".csv\"]）"),
                Some("manifest.json"),
            )),
            Some(items) if items.is_empty() => problems.push(PluginProblem::warn(
                "trigger_no_extensions",
                format!("{at} 的 extensions 是空的：没有任何扩展名，入口就不会出现"),
                Some("manifest.json"),
            )),
            Some(items) => {
                for item in items {
                    let raw_ext = item.as_str().unwrap_or_default();
                    if crate::plugins::normalize_extension(raw_ext).is_none() {
                        problems.push(PluginProblem::warn(
                            "trigger_bad_extension",
                            format!(
                                "{at} 的扩展名「{raw_ext}」不合法（写成 .md 这样：小写、带点、一个扩展名）：这一项会被忽略"
                            ),
                            Some("manifest.json"),
                        ));
                    }
                }
            }
        }
    }
}

/// 触发指向的命令**是否真的注册了**（以及它带不带参数表单）。
///
/// 单独一步的原因：这份名单要等 discovery（真跑一遍顶层代码）之后才有。放在这里而不是
/// 塞进上面的共用检查，是因为共用检查在**两档**都要跑，而声明式插件没有命令可查。
///
/// 为什么值得查：命令 id 写错、或者忘了 `register`，宿主这边什么都不报——入口照常出现在
/// 命令面板里，用户点下去才看到「命令不存在」。作者不该靠用户点一次才知道。
fn check_trigger_targets(
    value: Option<&serde_json::Value>,
    commands: &[PluginCommandMeta],
    problems: &mut Vec<PluginProblem>,
) {
    let Some(list) = value.and_then(|v| v.get("triggers")).and_then(|t| t.as_array()) else {
        return;
    };
    for (i, t) in list.iter().enumerate() {
        let command = t.get("command").and_then(|c| c.as_str()).unwrap_or_default().trim();
        if command.is_empty() {
            continue; // 已经在 check_triggers_declaration 里报过
        }
        match commands.iter().find(|c| c.id == command) {
            None => problems.push(PluginProblem::warn(
                "trigger_command_missing",
                format!(
                    "triggers[{i}] 要调用的命令「{command}」没有被注册（register({{ id: \"{command}\", … }})）——现在点这个入口只会得到「命令不存在」"
                ),
                Some("manifest.json"),
            )),
            Some(c) if !c.params.is_empty() => problems.push(PluginProblem::warn(
                "trigger_command_has_params",
                format!(
                    "triggers[{i}] 调用的命令「{command}」声明了参数：导入触发**不会**渲染参数表单，它只把 {{ fileName, content }} 交给命令（参数表单只在命令面板里出现）"
                ),
                Some("manifest.json"),
            )),
            Some(_) => {}
        }
    }
}

/// 声明式（零代码）插件的校验。
///
/// **单独一个函数**，而不是在主流程里插条件分支：两档的检查项几乎没有交集——声明式没有
/// 入口文件、没有 Boa 语法、没有命令注册、也不需要权限/事件/设置；硬塞在一起只会让
/// 「逻辑档走到一半被声明式的判断截住」这种错法变得容易发生（写这段时就这么错过一次）。
#[allow(clippy::too_many_arguments)]
fn validate_declarative(
    value: Option<&serde_json::Value>,
    dir_name: String,
    id: String,
    name: String,
    version: String,
    api_version: String,
    main: String,
    mut problems: Vec<PluginProblem>,
) -> ValidateReport {
    let views: Vec<crate::plugins::ViewDecl> = value
        .and_then(|v| manifest_from_value(v, &dir_name))
        .and_then(|m| m.views.clone())
        .unwrap_or_default();

    // 声明式插件没有代码，所以权限/事件/设置都无从使用——写了要**如实告知**，
    // 而不是默默收下（那会让作者以为自己申请到了什么）。
    if let Some(v) = value {
        for (field, code, msg) in [
            ("permissions", "declarative_has_permissions", "声明式插件没有代码，manifest.permissions 不会被用到（它可以不申请任何权限）"),
            ("events", "declarative_has_events", "声明式插件没有代码，manifest.events 收不到任何事件（需要事件就用 logic 档）"),
            ("settings", "declarative_has_settings", "声明式插件没有代码去读设置（需要用户可配就用 logic 档）"),
            ("triggers", "declarative_has_triggers", "声明式插件没有命令可以调用，manifest.triggers 不会接住任何文件（导入触发要调用命令，那需要 logic 档）"),
            ("main", "declarative_has_main", "runtime=declarative 时 main.js 不会被读取或执行（零代码正是它安全的原因），建议删掉这个字段与文件"),
        ] {
            if v.get(field).is_some() {
                problems.push(PluginProblem::warn(code, msg, Some("manifest.json")));
            }
        }
    }

    // 只出主题、不出视图也是合法的一种声明式插件（主题插件就是这样）：
    // 它的产出是设计变量，不是面板。
    let has_theme = value
        .and_then(|v| v.get("theme"))
        .and_then(|t| t.get("tokens"))
        .and_then(|t| t.as_object())
        .map(|m| !m.is_empty())
        .unwrap_or(false);
    check_theme_declaration(value, &mut problems);
    check_triggers_declaration(value, &mut problems);

    if views.is_empty() && !has_theme {
        problems.push(PluginProblem::error(
            "declarative_no_views",
            "声明式插件必须声明 views 或 theme 之一：它没有代码，视图或主题就是它唯一的产出（否则装了什么都不会发生）",
            Some("manifest.json"),
        ));
    }
    if views.len() > crate::plugins::MAX_VIEWS {
        problems.push(PluginProblem::warn(
            "too_many_views",
            format!("声明了 {} 个视图（上限 {}）：声明是给人看的，堆量只会让插件面板变得难选", views.len(), crate::plugins::MAX_VIEWS),
            Some("manifest.json"),
        ));
    }
    let mut seen: Vec<&str> = Vec::new();
    for vw in &views {
        if vw.id.trim().is_empty() {
            problems.push(PluginProblem::error("view_no_id", "views 里有一项没有 id", Some("manifest.json")));
        } else if seen.contains(&vw.id.as_str()) {
            problems.push(PluginProblem::warn("view_duplicate", format!("视图 id 重复：{}", vw.id), Some("manifest.json")));
        }
        seen.push(&vw.id);
        if vw.title.trim().is_empty() {
            problems.push(PluginProblem::warn("view_no_title", format!("视图 {} 没有 title（菜单里会显示成 id）", vw.id), Some("manifest.json")));
        }
        if vw.columns.is_empty() {
            problems.push(PluginProblem::warn("view_no_columns", format!("视图 {} 没有声明 columns（会只显示标题）", vw.id), Some("manifest.json")));
        }
        for c in &vw.columns {
            if !crate::plugins::VIEW_COLUMNS.iter().any(|(k, _)| k == c) {
                problems.push(PluginProblem::warn(
                    "view_unknown_column",
                    format!(
                        "视图 {} 声明了宿主不支持的列「{}」（可用：{}）",
                        vw.id,
                        c,
                        crate::plugins::VIEW_COLUMNS.iter().map(|(k, _)| *k).collect::<Vec<_>>().join(" / ")
                    ),
                    Some("manifest.json"),
                ));
            }
        }
        if let Some(kind) = &vw.query.kind {
            if !crate::plugins::VIEW_KINDS.contains(&kind.as_str()) {
                problems.push(PluginProblem::warn("view_bad_kind", format!("视图 {} 的 query.kind「{kind}」不认识（可用：{}）", vw.id, crate::plugins::VIEW_KINDS.join(" / ")), Some("manifest.json")));
            }
        }
        if let Some(sort) = &vw.query.sort {
            if !crate::plugins::VIEW_SORTS.contains(&sort.as_str()) {
                problems.push(PluginProblem::warn("view_bad_sort", format!("视图 {} 的 query.sort「{sort}」不认识（可用：{}）", vw.id, crate::plugins::VIEW_SORTS.join(" / ")), Some("manifest.json")));
            }
        }
        if let Some(limit) = vw.query.limit {
            if !(1..=500).contains(&limit) {
                problems.push(PluginProblem::warn("view_bad_limit", format!("视图 {} 的 query.limit {limit} 超出范围（1–500）", vw.id), Some("manifest.json")));
            }
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
        entry_bytes: 0,
        commands: Vec::new(),
        // 没有代码 → 不需要权限、收不到事件、读不了设置：这里必须是空的，
        // 否则界面会显示「按 v1 基线授权 11 项」这种与事实不符的信息。
        permissions: Vec::new(),
        granted: Vec::new(),
        events: Vec::new(),
        settings: Vec::new(),
        runtime: "declarative".to_string(),
        views,
        permissions_baseline: false,
        problems,
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

    // 运行档：从这一步起，声明式与逻辑档走**不同的检查**（前者没有代码，后者没有视图）。
    let runtime = value
        .as_ref()
        .map(|v| v.get("runtime").and_then(|r| r.as_str()).unwrap_or("logic").to_string())
        .unwrap_or_else(|| "logic".to_string());
    if runtime != "logic" && runtime != "declarative" {
        problems.push(PluginProblem::error(
            "runtime_unknown",
            format!("manifest.runtime 不认识：{runtime}（本应用支持 logic / declarative），会被拒载"),
            Some("manifest.json"),
        ));
    }
    if runtime == "declarative" {
        return validate_declarative(value.as_ref(), dir_name, id, name, version, api_version, main, problems);
    }
    if value.as_ref().and_then(|v| v.get("views")).is_some() {
        problems.push(PluginProblem::warn(
            "views_ignored",
            "manifest.views 只在 runtime=declarative 时生效；这个插件有代码（logic 档），视图不会被渲染",
            Some("manifest.json"),
        ));
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

    // ---- 4.6 设置声明（宿主据此渲染表单，所以声明错了用户就会看到一个坏表单）----
    let mut settings: Vec<crate::plugins::SettingDecl> = Vec::new();
    if let Some(v) = &value {
        if let Some(m) = manifest_from_value(v, &dir_name) {
            if let Some(decls) = m.settings.clone() {
                let mut seen: Vec<&str> = Vec::new();
                for d in &decls {
                    if d.key.trim().is_empty() {
                        problems.push(PluginProblem::error("setting_no_key", "settings 里有一项没有 key", Some("manifest.json")));
                        continue;
                    }
                    if seen.contains(&d.key.as_str()) {
                        problems.push(PluginProblem::warn("setting_duplicate", format!("设置项 {} 重复声明", d.key), Some("manifest.json")));
                    }
                    seen.push(&d.key);
                    if d.setting_type == "select" && d.options.is_empty() {
                        problems.push(PluginProblem::error(
                            "setting_select_no_options",
                            format!("设置项 {} 声明为 select 却没有 options（用户将无法选择任何值）", d.key),
                            Some("manifest.json"),
                        ));
                    }
                    if d.scope != "app" && d.scope != "space" {
                        problems.push(PluginProblem::error(
                            "setting_bad_scope",
                            format!("设置项 {} 的 scope 只能是 space（默认，随空间加密）或 app（明文），收到 {}", d.key, d.scope),
                            Some("manifest.json"),
                        ));
                    }
                }
                settings = decls;
            }
        }
    }

    check_theme_declaration(value.as_ref(), &mut problems);
    check_triggers_declaration(value.as_ref(), &mut problems);

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
                // 触发指向的命令是否真的注册了：名单只有 discovery 之后才有，所以在这里查
                // （只有 discovery 成功时才有意义——失败已经在上面报过 load_failed 了）。
                check_trigger_targets(value.as_ref(), &commands, &mut problems);
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
        settings,
        runtime: "logic".to_string(),
        views: Vec::new(),
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
            settings: Vec::new(),
            runtime: "logic".to_string(),
            views: Vec::new(),
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

    /// 该示例目录的 manifest 是否声明了非空 theme.tokens。
    fn value_has_theme(dir: &Path) -> bool {
        std::fs::read_to_string(dir.join("manifest.json"))
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            .and_then(|v| v.get("theme").and_then(|t| t.get("tokens")).and_then(|t| t.as_object()).map(|m| !m.is_empty()))
            .unwrap_or(false)
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
            if r.runtime == "declarative" {
                // 零代码插件：没有命令、不需要权限——但必须有视图，那是它唯一的产出
                // 声明式插件的产出是「视图」或「主题」之一（主题插件就没有视图）
                assert!(
                    !r.views.is_empty() || value_has_theme(d),
                    "声明式示例 {} 至少要声明视图或主题，否则装了什么都不会发生",
                    d.display()
                );
                assert!(r.commands.is_empty(), "声明式插件不该有命令");
                assert!(r.permissions.is_empty(), "声明式插件没有代码，不该申请权限");
                continue;
            }
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
            // 导入触发：示例里写了就必须是「干干净净」的——命令注册过、扩展名合法、
            // 没有拿去接一条带参数表单的命令（这些正是作者最容易写错的地方）。
            assert!(
                r.problems.iter().all(|p| !p.code.starts_with("trigger")),
                "示例插件 {} 的导入触发不该有任何问题（它示范的是正确写法）：{:?}",
                d.display(),
                r.problems
            );
        }
    }

    // ---- 声明式（零代码）插件（M11.9）----

    fn declarative_plugin(dirname: &str, body: &str) -> PathBuf {
        let base = temp_dir(dirname);
        let dir = base.join(dirname);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("manifest.json"), body.replace("{dir}", dirname)).unwrap();
        dir
    }

    #[test]
    fn declarative_plugin_needs_no_js_at_all() {
        let dir = declarative_plugin(
            "reading-board",
            r#"{ "id": "reading-board", "name": "阅读统计", "version": "1.0.0", "apiVersion": "1.0.0",
                 "runtime": "declarative",
                 "views": [ { "id": "recent", "title": "最近更新", "summary": true,
                              "query": { "kind": "any", "sort": "updated_desc", "limit": 20 },
                              "columns": ["title", "kind", "updated_at"] } ] }"#,
        );
        let r = validate_dir(&dir);
        // 关键：没有 main.js 也**不能**被判成「加载器会拒载」——声明式本来就没有代码
        assert_eq!(r.errors().count(), 0, "零代码插件不该有错误：{:?}", r.problems);
        assert!(r.ok);
        assert_eq!(r.runtime, "declarative");
        assert_eq!(r.views.len(), 1);
        assert!(r.commands.is_empty());
        assert!(r.permissions.is_empty(), "没有代码就不该有权限，也不该走基线授权");
        assert!(!r.permissions_baseline);
    }

    #[test]
    fn declarative_without_views_is_an_error() {
        let dir = declarative_plugin(
            "empty-panel",
            r#"{ "id": "empty-panel", "name": "空面板", "apiVersion": "1.0.0", "runtime": "declarative" }"#,
        );
        let r = validate_dir(&dir);
        assert!(codes(&r).contains(&"declarative_no_views".to_string()), "{:?}", r.problems);
        assert!(!r.ok, "没有视图的声明式插件装了什么都不显示，必须报错");
    }

    #[test]
    fn declarative_with_code_or_permissions_is_flagged() {
        let dir = declarative_plugin(
            "confused",
            r#"{ "id": "confused", "name": "混搭", "version": "1.0.0", "apiVersion": "1.0.0", "runtime": "declarative",
                 "main": "main.js", "permissions": [ { "id": "read:pages", "reason": "x" } ],
                 "views": [ { "id": "v", "title": "V", "columns": ["title"] } ] }"#,
        );
        write_main(&dir, "main.js", OK_MAIN); // 有代码但不会被读
        let r = validate_dir(&dir);
        assert!(r.ok, "这些都是提醒而不是错误：{:?}", r.problems);
        for code in ["declarative_has_main", "declarative_has_permissions"] {
            assert!(codes(&r).contains(&code.to_string()), "应提示 {code}：{:?}", r.problems);
        }
    }

    #[test]
    fn unknown_runtime_is_rejected() {
        let dir = declarative_plugin(
            "weird-runtime",
            r#"{ "id": "weird-runtime", "name": "W", "version": "1.0.0", "apiVersion": "1.0.0", "runtime": "wasm" }"#,
        );
        let r = validate_dir(&dir);
        assert!(codes(&r).contains(&"runtime_unknown".to_string()), "{:?}", r.problems);
        assert!(!r.ok);
    }

    #[test]
    fn declarative_view_mistakes_are_reported() {
        let dir = declarative_plugin(
            "bad-views",
            r#"{ "id": "bad-views", "name": "B", "version": "1.0.0", "apiVersion": "1.0.0", "runtime": "declarative",
                 "views": [
                   { "id": "a", "title": "A", "columns": ["title", "不存在的列"],
                     "query": { "kind": "很久以前", "sort": "按心情", "limit": 9999 } },
                   { "id": "a", "title": "", "columns": [] }
                 ] }"#,
        );
        let r = validate_dir(&dir);
        assert!(r.ok, "列/排序/取值写错都只是提醒（宿主会忽略并按默认来）：{:?}", r.problems);
        for code in ["view_unknown_column", "view_bad_kind", "view_bad_sort", "view_bad_limit", "view_duplicate", "view_no_title", "view_no_columns"] {
            assert!(codes(&r).contains(&code.to_string()), "应提示 {code}：{:?}", r.problems);
        }
    }

    #[test]
    fn loader_refuses_to_read_code_from_a_declarative_plugin() {
        let dir = declarative_plugin(
            "no-code",
            r#"{ "id": "no-code", "name": "N", "version": "1.0.0", "apiVersion": "1.0.0", "runtime": "declarative",
                 "views": [ { "id": "v", "title": "V", "columns": ["title"] } ] }"#,
        );
        let m = crate::plugins::read_manifest(&dir).unwrap();
        let err = crate::plugins::load_plugin_source(&dir, &m).unwrap_err();
        assert!(err.contains("declarative_no_code"), "{err}");
    }

    #[test]
    fn views_declared_on_a_logic_plugin_are_flagged() {
        let dir = plugin("logic-with-views", &manifest_json("logic-with-views", ""));
        write_main(&dir, "main.js", OK_MAIN);
        let mut v: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join("manifest.json")).unwrap()).unwrap();
        v["views"] = serde_json::json!([{ "id": "v", "title": "V", "columns": ["title"] }]);
        fs::write(dir.join("manifest.json"), v.to_string()).unwrap();
        let r = validate_dir(&dir);
        assert!(r.ok, "{:?}", r.problems);
        assert!(codes(&r).contains(&"views_ignored".to_string()), "有代码的插件声明 views 要说明它不生效：{:?}", r.problems);
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
    #[test]
    fn theme_declaration_is_checked() {
        let dir = declarative_plugin(
            "bad-theme",
            r##"{ "id": "bad-theme", "name": "坏主题", "version": "1.0.0", "apiVersion": "1.0.0",
                 "runtime": "declarative",
                 "theme": { "name": "坏主题", "tokens": {
                    "--bg": "#1b1714", "--radius": "6px",
                    "--doc-width": "1200px",
                    "--text": "url(http://evil/x.png)" } } }"##,
        );
        let r = validate_dir(&dir);
        assert!(!r.ok, "非法值必须报错（它会被写进页面样式）：{:?}", r.problems);
        assert!(codes(&r).contains(&"theme_unknown_token".to_string()), "布局度量要指出不在白名单：{:?}", r.problems);
        assert!(codes(&r).contains(&"theme_bad_value".to_string()), "url( 必须报错：{:?}", r.problems);
        // 合法的那些不该被牵连
        assert!(r.problems.iter().all(|p| !p.message.contains("--radius")), "{:?}", r.problems);
    }

    #[test]
    fn theme_is_checked_on_logic_plugins_too() {
        let dir = plugin(
            "logic-theme",
            &manifest_json(
                "logic-theme",
                r##", "theme": { "tokens": { "--bg": "url(http://evil/x)", "--不存在的变量": "#fff" } }"##,
            ),
        );
        write_main(&dir, "main.js", OK_MAIN);
        let r = validate_dir(&dir);
        assert!(codes(&r).contains(&"theme_bad_value".to_string()), "逻辑档插件同样要检查主题：{:?}", r.problems);
        assert!(codes(&r).contains(&"theme_unknown_token".to_string()), "{:?}", r.problems);
    }

    // ---- 导入触发（M11.9）----

    #[test]
    fn import_trigger_mistakes_are_reported() {
        let dir = plugin(
            "bad-triggers",
            &manifest_json(
                "bad-triggers",
                r#", "permissions": [ { "id": "read:pages", "reason": "x" } ], "triggers": [
                     { "kind": "import", "extensions": [".md"], "command": "bad-triggers.import" },
                     { "kind": "wasm", "extensions": [".md"], "command": "bad-triggers.import" },
                     { "kind": "import", "extensions": [".md"] },
                     { "kind": "import", "extensions": [], "command": "bad-triggers.import" },
                     { "kind": "import", "command": "bad-triggers.import" },
                     { "kind": "import", "extensions": ["*", "m d", "ok.md"], "command": "bad-triggers.import" }
                   ]"#,
            ),
        );
        write_main(
            &dir,
            "main.js",
            "register({ id: 'bad-triggers.import', title: '导入', run: function(){ return ''; } });",
        );
        let r = validate_dir(&dir);
        assert!(!r.ok, "kind 不认识 / 没有命令必须是错误：{:?}", r.problems);
        assert!(codes(&r).contains(&"trigger_unknown_kind".to_string()), "{:?}", r.problems);
        assert!(codes(&r).contains(&"trigger_no_command".to_string()), "{:?}", r.problems);
        assert!(codes(&r).contains(&"trigger_no_extensions".to_string()), "{:?}", r.problems);
        assert!(codes(&r).contains(&"trigger_bad_extension".to_string()), "通配符/空格不是扩展名：{:?}", r.problems);
        // 严重度：只有「kind 不认识」与「没有命令」是错误，扩展名的问题只是提醒
        let bad_ext = r.problems.iter().find(|p| p.code == "trigger_bad_extension").unwrap();
        assert_eq!(bad_ext.severity, "warning", "扩展名写错不该让插件装不上");
        // 合法的那条不该被牵连
        assert!(
            r.problems.iter().all(|p| !p.message.contains("trigger_no_command") || !p.message.contains("triggers[0]")),
            "{:?}",
            r.problems
        );
    }

    #[test]
    fn a_clean_import_trigger_reports_nothing() {
        let dir = plugin(
            "good-triggers",
            &manifest_json(
                "good-triggers",
                r#", "permissions": [ { "id": "read:pages", "reason": "x" } ], "triggers": [
                     { "kind": "import", "extensions": ["MD", ".csv"], "command": "good-triggers.import" }
                   ]"#,
            ),
        );
        write_main(
            &dir,
            "main.js",
            "register({ id: 'good-triggers.import', title: '导入', run: function(){ return ''; } });",
        );
        let r = validate_dir(&dir);
        assert_eq!(r.errors().count(), 0, "{:?}", r.problems);
        assert!(
            r.problems.iter().all(|p| !p.code.starts_with("trigger")),
            "写得对的触发不该有任何话说：{:?}",
            r.problems
        );
    }

    #[test]
    fn trigger_pointing_at_an_unregistered_command_is_flagged() {
        // 命令 id 写错 / 忘了 register：宿主什么都不报，用户点下去才看到「命令不存在」
        let dir = plugin(
            "lost-trigger",
            &manifest_json(
                "lost-trigger",
                r#", "permissions": [ { "id": "read:pages", "reason": "x" } ], "triggers": [
                     { "kind": "import", "extensions": [".md"], "command": "lost-trigger.nope" }
                   ]"#,
            ),
        );
        write_main(&dir, "main.js", OK_MAIN); // 只注册了 demo.run
        let r = validate_dir(&dir);
        assert!(r.ok, "装得上、跑得起来，所以只是提醒：{:?}", r.problems);
        assert!(codes(&r).contains(&"trigger_command_missing".to_string()), "{:?}", r.problems);
    }

    #[test]
    fn trigger_on_a_command_with_params_is_explained() {
        // 导入触发的入参就是 { fileName, content }：带参数表单的命令不会弹表单，得说清楚
        let dir = plugin(
            "param-trigger",
            &manifest_json(
                "param-trigger",
                r#", "permissions": [ { "id": "read:pages", "reason": "x" } ], "triggers": [
                     { "kind": "import", "extensions": [".md"], "command": "param-trigger.import" }
                   ]"#,
            ),
        );
        write_main(
            &dir,
            "main.js",
            "register({ id: 'param-trigger.import', title: '导入', params: [ { name: 'x' } ], run: function(){ return ''; } });",
        );
        let r = validate_dir(&dir);
        assert!(r.ok, "{:?}", r.problems);
        assert!(codes(&r).contains(&"trigger_command_has_params".to_string()), "{:?}", r.problems);
    }

    #[test]
    fn declarative_plugins_are_told_triggers_do_nothing() {
        // 零代码插件没有命令：写了 triggers 要如实告知，而不是让它显得能接文件
        let dir = declarative_plugin(
            "decl-trigger",
            r#"{ "id": "decl-trigger", "name": "D", "version": "1.0.0", "apiVersion": "1.0.0",
                 "runtime": "declarative",
                 "views": [ { "id": "v", "title": "V", "columns": ["title"] } ],
                 "triggers": [ { "kind": "import", "extensions": [".md"], "command": "decl-trigger.import" } ] }"#,
        );
        let r = validate_dir(&dir);
        assert!(r.ok, "只是提醒（插件本身装得上）：{:?}", r.problems);
        assert!(codes(&r).contains(&"declarative_has_triggers".to_string()), "{:?}", r.problems);
    }
}
