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

/// 触发指向的命令**是否真的注册了**（以及它带不带参数表单、有没有申报需要的权限）。
///
/// 单独一步的原因：这份名单要等 discovery（真跑一遍顶层代码）之后才有。放在这里而不是
/// 塞进上面的共用检查，是因为共用检查在**两档**都要跑，而声明式插件没有命令可查。
///
/// 为什么值得查：命令 id 写错、或者忘了 `register`，宿主这边什么都不报——入口照常出现在
/// 命令面板里，用户点下去才看到「命令不存在」。作者不该靠用户点一次才知道。
fn check_trigger_targets(
    value: Option<&serde_json::Value>,
    commands: &[PluginCommandMeta],
    declared_permissions: Option<&[String]>,
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
        // 导出触发最终会调 `api.files.export`（除非命令压根不导出，那这条触发本身就没意义）：
        // 显式声明了权限、却没写 `export:files` 时提醒一句——否则用户点了会看到权限不足。
        // 只在**显式声明过 permissions** 时提醒：没声明 permissions 的老插件走基线授权，
        // 那是全给的，不会缺这一项。
        let kind = t.get("kind").and_then(|k| k.as_str()).unwrap_or_default().trim();
        if kind == "export" {
            if let Some(perms) = declared_permissions {
                if !perms.iter().any(|p| p == "export:files") {
                    problems.push(PluginProblem::warn(
                        "trigger_export_without_permission",
                        format!(
                            "triggers[{i}] 是导出触发，但 manifest.permissions 里没有「export:files」：命令里调 api.files.export 会被拒（要么补上这项权限，要么删掉这条触发）"
                        ),
                        Some("manifest.json"),
                    ));
                }
            }
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

/// 视图查询字段的**取值形态**检查（看原始 JSON，不看解析后的类型）。
///
/// 为什么必须单独看原始 JSON：查询字段是 `字面量 | { fromSetting }` 的联合类型，写错形态
/// （例如 `"limit": "20"`）会让**整份 manifest 解析失败**——加载器直接拒载，而校验器如果
/// 只看解析结果，就会报出「必须声明 views 或 theme 之一」这种把作者引向反方向的错误。
/// 所以这一层专门负责说清「哪一项、写成什么才对」。
fn check_view_field_shapes(value: Option<&serde_json::Value>, problems: &mut Vec<PluginProblem>) {
    let Some(list) = value.and_then(|v| v.get("views")).and_then(|v| v.as_array()) else {
        return;
    };
    for (i, vw) in list.iter().enumerate() {
        // `placement` 与查询字段同属"形态写错就整份拒载"那一类，所以也在这里看原始 JSON。
        // （取值不认识是另一回事：那是**提醒**，视图照常打得开，见 check_view_declarations。）
        if let Some(raw) = vw.get("placement") {
            if !raw.is_string() {
                problems.push(PluginProblem::error(
                    "view_field_shape",
                    format!(
                        "views[{i}].placement 的写法不对：只能是字符串 \"overlay\"（浮层，默认）或 \"rail\"（右侧常驻面板）（现在是 {raw}）——形态不对会让整份 manifest 解析失败、插件被拒载"
                    ),
                    Some("manifest.json"),
                ));
            }
        }
        let Some(query) = vw.get("query").and_then(|q| q.as_object()) else {
            continue;
        };
        for (field, numeric) in [
            ("limit", true),
            ("updatedWithinDays", true),
            ("kind", false),
            ("sort", false),
            ("titleContains", false),
        ] {
            let Some(raw) = query.get(field) else {
                continue;
            };
            // 合法形态只有两种：字面量，或 `{ "fromSetting": "key" }`
            let from_setting = raw
                .get("fromSetting")
                .and_then(|s| s.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty());
            if from_setting.is_some() {
                continue;
            }
            let literal_ok = if numeric {
                raw.as_i64().is_some()
            } else {
                raw.as_str().is_some()
            };
            if literal_ok {
                continue;
            }
            problems.push(PluginProblem::error(
                "view_field_shape",
                format!(
                    "views[{i}].query.{field} 的写法不对：只能是{}，或指向一个设置 {{\"fromSetting\": \"设置key\"}}（现在是 {}）——形态不对会让整份 manifest 解析失败、插件被拒载",
                    if numeric { "数字" } else { "字符串" },
                    raw
                ),
                Some("manifest.json"),
            ));
        }
    }
}

/// 视图参数（`{ "fromSetting": "key" }`）的检查：**引用的设置必须存在，且能产出这个字段要的值**。
///
/// 这是声明式插件「用户可配」的全部契约，两个端都在宿主手里（设置表单由宿主渲染、视图由宿主
/// 渲染），所以这一层能把「永远拿不到可用值」写法的错误在作者那边就拦下来：
/// - 引用的 key 没声明 → **错误**（这条参数永远不会生效）；
/// - 类型对不上（例如数字字段引用一个布尔设置）→ **错误**（用户无论怎么填都解析不出数字）；
/// - `select` 的候选项不在白名单里 / 不是数字 → **错误**（每个选项都会被忽略，选哪个都一样；
///   这类错最阴——界面看起来完全正常，只是筛选永远按默认来）；
/// - 用字符串设置去驱动数字/枚举字段 → **提醒**（可能填出可用值，也可能填不出来）。
///
/// 只在**声明式**这一档跑：逻辑档插件的 `views` 整体不生效（已由 `views_ignored` 提醒），
/// 它的设置是给它自己的代码读的。
fn check_view_params(value: Option<&serde_json::Value>, problems: &mut Vec<PluginProblem>) {
    let Some(list) = value.and_then(|v| v.get("views")).and_then(|v| v.as_array()) else {
        return;
    };
    // 设置声明：key → (类型, 候选项)
    let settings: Vec<(String, String, Vec<String>)> = value
        .and_then(|v| v.get("settings"))
        .and_then(|s| s.as_array())
        .map(|arr| {
            arr.iter()
                .map(|d| {
                    let key = d.get("key").and_then(|k| k.as_str()).unwrap_or_default().to_string();
                    let ty = d.get("type").and_then(|t| t.as_str()).unwrap_or("string").to_string();
                    let options = d
                        .get("options")
                        .and_then(|o| o.as_array())
                        .map(|a| {
                            a.iter()
                                .filter_map(|o| match o {
                                    serde_json::Value::String(s) => Some(s.clone()),
                                    v => v.get("value").and_then(|v| v.as_str()).map(str::to_string),
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    (key, ty, options)
                })
                .collect()
        })
        .unwrap_or_default();

    let mut used: Vec<String> = Vec::new();
    for (i, vw) in list.iter().enumerate() {
        let Some(query) = vw.get("query").and_then(|q| q.as_object()) else {
            continue;
        };
        for (field, shape, allowed) in [
            ("limit", Shape::Number, None),
            ("updatedWithinDays", Shape::Number, None),
            ("kind", Shape::Enum, Some(crate::plugins::VIEW_KINDS)),
            ("sort", Shape::Enum, Some(crate::plugins::VIEW_SORTS)),
            ("titleContains", Shape::Text, None),
        ] {
            let Some(key) = query
                .get(field)
                .and_then(|f| f.get("fromSetting"))
                .and_then(|s| s.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            let Some((_, ty, options)) = settings.iter().find(|(k, _, _)| k == key) else {
                problems.push(PluginProblem::error(
                    "view_param_unknown_setting",
                    format!(
                        "views[{i}].query.{field} 引用了设置「{key}」，但 manifest.settings 里没有这一项——这条参数永远不会生效{}",
                        if settings.is_empty() { "（这个插件没有声明任何设置）" } else { "" }
                    ),
                    Some("manifest.json"),
                ));
                continue;
            };
            used.push(key.to_string());

            let shape_name = match shape {
                Shape::Number => "数字",
                Shape::Enum => "白名单里的值",
                Shape::Text => "文本",
            };
            match ty.as_str() {
                "number" | "select" if shape == Shape::Number => {
                    if ty == "select" {
                        let bad: Vec<&String> = options.iter().filter(|o| o.parse::<f64>().is_err()).collect();
                        if !bad.is_empty() {
                            problems.push(PluginProblem::error(
                                "view_param_bad_options",
                                format!(
                                    "views[{i}].query.{field} 用设置「{key}」取值，但它是 select、候选项里有不是数字的：{}——用户选到那些项时这条参数会被忽略",
                                    bad.iter().map(|s| format!("「{s}」")).collect::<Vec<_>>().join("、")
                                ),
                                Some("manifest.json"),
                            ));
                        }
                    }
                }
                "select" | "string" if shape == Shape::Enum => {
                    if let Some(allowed) = allowed {
                        let bad: Vec<&String> = options.iter().filter(|o| !allowed.contains(&o.as_str())).collect();
                        if ty == "select" && !bad.is_empty() {
                            problems.push(PluginProblem::error(
                                "view_param_bad_options",
                                format!(
                                    "views[{i}].query.{field} 用设置「{key}」取值，但它的候选项不在白名单里：{}（可用：{}）——用户选哪个都会被忽略，界面看着正常、筛选却永远按默认来",
                                    bad.iter().map(|s| format!("「{s}」")).collect::<Vec<_>>().join("、"),
                                    allowed.join(" / ")
                                ),
                                Some("manifest.json"),
                            ));
                        } else if ty == "string" {
                            problems.push(PluginProblem::warn(
                                "view_param_string_source",
                                format!(
                                    "views[{i}].query.{field} 由文本设置「{key}」驱动：用户填出白名单外的值（可用：{}）时这条参数会被忽略，筛选会**静默**回到默认——建议改成 select 把可选项固定下来",
                                    allowed.join(" / ")
                                ),
                                Some("manifest.json"),
                            ));
                        }
                    }
                }
                "string" | "select" if shape == Shape::Text => {}
                "string" if shape == Shape::Number => problems.push(PluginProblem::warn(
                    "view_param_string_source",
                    format!("views[{i}].query.{field} 由文本设置「{key}」驱动：用户填的不是数字时这条参数会被忽略（视图退回默认）——建议把设置的 type 改成 number"),
                    Some("manifest.json"),
                )),
                _ => problems.push(PluginProblem::error(
                    "view_param_bad_type",
                    format!(
                        "views[{i}].query.{field} 需要{shape_name}，但设置「{key}」的 type 是「{ty}」——它永远产不出可用的值，这条参数等于白写"
                    ),
                    Some("manifest.json"),
                )),
            }
        }
    }

    // 声明了设置、却没有任何视图用到：它只会让用户在设置面板里填一个对什么都不起作用的值
    for (key, _, _) in &settings {
        if !used.contains(key) {
            problems.push(PluginProblem::warn(
                "declarative_setting_unused",
                format!("设置「{key}」没有被任何视图用到：声明式插件没有代码去读设置，所以用户填了它也不会改变任何东西（要么让某个视图 query 用 {{\"fromSetting\": \"{key}\"}} 引用它，要么删掉它）"),
                Some("manifest.json"),
            ));
        }
    }
}

/// 一个查询字段期望的取值形态（用于把「设置能产出什么」与「字段要什么」对上）。
#[derive(PartialEq)]
enum Shape {
    Number,
    Enum,
    Text,
}

/// 声明式（零代码）插件的校验。
///
/// **单独一个函数**，而不是在主流程里插条件分支：两档的检查项几乎没有交集——声明式没有
/// 入口文件、没有 Boa 语法、没有命令注册、也不需要权限/事件；硬塞在一起只会让
/// 「逻辑档走到一半被声明式的判断截住」这种错法变得容易发生（写这段时就这么错过一次）。
#[allow(clippy::too_many_arguments)]
fn validate_declarative(
    dir: &Path,
    value: Option<&serde_json::Value>,
    dir_name: String,
    id: String,
    name: String,
    version: String,
    api_version: String,
    main: String,
    mut problems: Vec<PluginProblem>,
) -> ValidateReport {
    let parsed = value.and_then(|v| manifest_from_value(v, &dir_name));
    let views: Vec<crate::plugins::ViewDecl> = parsed
        .as_ref()
        .and_then(|m| m.views.clone())
        .unwrap_or_default();
    // 声明式插件的设置**不是摆设**：视图的查询字段可以写成 `{ "fromSetting": "key" }`，
    // 由宿主在渲染时按用户设的值解析（M11.9 收口）——所以它要进报告。
    let settings: Vec<crate::plugins::SettingDecl> = parsed
        .as_ref()
        .and_then(|m| m.settings.clone())
        .unwrap_or_default();

    // 声明式插件没有代码，所以权限/事件/触发都无从使用——写了要**如实告知**，
    // 而不是默默收下（那会让作者以为自己申请到了什么）。
    //
    // 设置是个例外（它曾经也在这张表里）：**视图可以引用设置**，所以声明式插件声明设置
    // 是有意义的，只提醒"没有任何视图用到它"（见下面的 declarative_setting_unused）。
    if let Some(v) = value {
        for (field, code, msg) in [
            ("permissions", "declarative_has_permissions", "声明式插件没有代码，manifest.permissions 不会被用到（它可以不申请任何权限）"),
            ("events", "declarative_has_events", "声明式插件没有代码，manifest.events 收不到任何事件（需要事件就用 logic 档）"),
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
    // 视图参数（`{ "fromSetting": "key" }`）：形态 + 引用的设置存不存在 + 类型能不能对上。
    // 与主题/触发一样是独立函数、显式调用——它要同时看 settings 与 views 两边，塞进下面
    // 那个"逐视图"的循环里必然写成内外两层嵌套判断。
    check_view_field_shapes(value, &mut problems);
    check_view_params(value, &mut problems);

    // 声明了 views、却因为字段写错而整份 manifest 解析不出来时，**不能**报成
    // 「必须声明 views 或 theme」——那会把作者引到完全错误的方向（他明明写了）。
    // 此时具体是哪一项写错了由 check_view_field_shapes 指出来。
    let raw_views_declared = value
        .and_then(|v| v.get("views"))
        .and_then(|v| v.as_array())
        .map(|a| !a.is_empty())
        .unwrap_or(false);
    if views.is_empty() && !has_theme && !raw_views_declared {
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
        // 白名单只对**字面量**判定；`{ fromSetting }` 形态由 check_view_params 判定
        // （它要看设置声明的类型与候选项，是另一套判断）。
        if let Some(kind) = vw.query.kind.as_ref().and_then(|f| f.literal()) {
            if !crate::plugins::VIEW_KINDS.contains(&kind) {
                problems.push(PluginProblem::warn("view_bad_kind", format!("视图 {} 的 query.kind「{kind}」不认识（可用：{}）", vw.id, crate::plugins::VIEW_KINDS.join(" / ")), Some("manifest.json")));
            }
        }
        if let Some(sort) = vw.query.sort.as_ref().and_then(|f| f.literal()) {
            if !crate::plugins::VIEW_SORTS.contains(&sort) {
                problems.push(PluginProblem::warn("view_bad_sort", format!("视图 {} 的 query.sort「{sort}」不认识（可用：{}）", vw.id, crate::plugins::VIEW_SORTS.join(" / ")), Some("manifest.json")));
            }
        }
        if let Some(limit) = vw.query.limit.as_ref().and_then(|f| f.literal()) {
            if !(1..=500).contains(&limit) {
                problems.push(PluginProblem::warn("view_bad_limit", format!("视图 {} 的 query.limit {limit} 超出范围（1–500）", vw.id), Some("manifest.json")));
            }
        }
        // 落点（`overlay` 浮层 / `rail` 右侧常驻面板）：不认识的值按浮层处理、视图照样打得开，
        // 所以是**提醒**不是错误——口径与 kind / sort / columns 一致（声明式插件的原则是
        // "永远打得开"）。这里多说一句它按什么处理，作者才知道自己看到的不是他要的形态。
        if let Some(p) = vw.placement.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
            if !crate::plugins::VIEW_PLACEMENTS.contains(&p) {
                problems.push(PluginProblem::warn(
                    "view_bad_placement",
                    format!(
                        "视图 {} 的 placement「{}」不认识（可用：{}）——按 overlay（浮层）处理",
                        vw.id,
                        p,
                        crate::plugins::VIEW_PLACEMENTS.join(" / ")
                    ),
                    Some("manifest.json"),
                ));
            }
        }
    }

    // ---- 兜底：按加载器的真实路径再走一遍 ----
    //
    // 逻辑档那一步还有一个「加载器会不会拒」的硬保证（`loader_rejected`），而声明式这边
    // 此前**没有**：manifest 解析失败（例如某个字段形态写错、类型对不上）时，各条具体检查
    // 可能一条都不报，报告于是显示 ok=true，可应用其实拒载——作者会以为没问题。
    // 这里只走 `read_manifest`：`load_plugin_source` 对零代码插件必然返回
    // `declarative_no_code`，那是设计如此，不是错误。
    if let Err(e) = read_manifest(dir) {
        if !problems.iter().any(|p| p.severity == "error") {
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
        entry_bytes: 0,
        commands: Vec::new(),
        // 没有代码 → 不需要权限、收不到事件、也不走基线授权：这里必须是空的，
        // 否则界面会显示「按 v1 基线授权 11 项」这种与事实不符的信息。
        permissions: Vec::new(),
        granted: Vec::new(),
        events: Vec::new(),
        // 设置**要列出来**：声明式插件的视图可以引用它（`{ "fromSetting": "key" }`），
        // 所以它是这个插件真实产出的一部分——对用户来说，那是"这个面板我能不能调"。
        settings,
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
        return validate_declarative(dir, value.as_ref(), dir_name, id, name, version, api_version, main, problems);
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

    // 「作者显式声明了哪些权限」：导出触发的预检要用（在 discovery 之前先取出来，
    // 那段之后的 `value` 已经借给了别的调用）。
    let declared_trigger_perms: Option<Vec<String>> = value
        .as_ref()
        .and_then(|v| v.get("permissions"))
        .and_then(|p| p.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|d| d.get("id").and_then(|i| i.as_str()).map(str::to_string))
                .collect()
        });

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
                check_trigger_targets(
                    value.as_ref(),
                    &commands,
                    declared_trigger_perms.as_deref(),
                    &mut problems,
                );
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
    fn an_export_trigger_without_the_export_permission_is_flagged() {
        // 导出触发最终会调 api.files.export：显式声明了权限却没写 export:files 时，
        // 用户点下去只会看到「权限不足」——那不该靠他点一次才知道。
        let dir = plugin(
            "exp-noperm",
            &manifest_json(
                "exp-noperm",
                r#", "permissions": [ { "id": "read:pages", "reason": "x" } ], "triggers": [
                     { "kind": "export", "extensions": [".md"], "command": "exp-noperm.export" }
                   ]"#,
            ),
        );
        write_main(
            &dir,
            "main.js",
            "register({ id: 'exp-noperm.export', title: '导出', run: function(){ return ''; } });",
        );
        let r = validate_dir(&dir);
        assert!(r.ok, "只是提醒：{:?}", r.problems);
        assert!(codes(&r).contains(&"trigger_export_without_permission".to_string()), "{:?}", r.problems);

        // 声明了就没事
        let ok = plugin(
            "exp-ok",
            &manifest_json(
                "exp-ok",
                r#", "permissions": [ { "id": "export:files", "reason": "存成文件" } ], "triggers": [
                     { "kind": "export", "extensions": [".md"], "command": "exp-ok.export" }
                   ]"#,
            ),
        );
        write_main(&ok, "main.js", "register({ id: 'exp-ok.export', title: '导出', run: function(){ return ''; } });");
        let r2 = validate_dir(&ok);
        assert_eq!(r2.errors().count(), 0, "{:?}", r2.problems);
        assert!(
            r2.problems.iter().all(|p| !p.code.starts_with("trigger")),
            "写得对的导出触发不该有任何话说：{:?}",
            r2.problems
        );
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

    // ---- 声明式视图的参数化（M11.9 收口）：查询字段引用用户设置 ----

    #[test]
    fn a_view_can_take_its_query_from_settings() {
        let dir = declarative_plugin(
            "param-view",
            r#"{ "id": "param-view", "name": "可调视图", "version": "1.0.0", "apiVersion": "1.0.0",
                 "runtime": "declarative",
                 "settings": [
                   { "key": "recentDays", "label": "看多少天内更新的", "type": "number", "default": 30 },
                   { "key": "order", "label": "排序", "type": "select", "options": ["updated_desc", "title_asc"] }
                 ],
                 "views": [ { "id": "v", "title": "最近更新", "columns": ["title"],
                              "query": { "updatedWithinDays": { "fromSetting": "recentDays" },
                                         "sort": { "fromSetting": "order" },
                                         "limit": 20 } } ] }"#,
        );
        let r = validate_dir(&dir);
        assert_eq!(r.errors().count(), 0, "{:?}", r.problems);
        assert!(
            r.problems.iter().all(|p| !p.code.starts_with("view_param") && p.code != "declarative_setting_unused"),
            "写得对的参数化视图不该有任何话说：{:?}",
            r.problems
        );
        // 设置要进报告：它是这个插件真实产出的一部分（用户在设置面板里能调的就是它）
        assert_eq!(r.settings.len(), 2, "{:?}", r.settings);
    }

    #[test]
    fn view_param_mistakes_are_reported() {
        let dir = declarative_plugin(
            "bad-param-view",
            r#"{ "id": "bad-param-view", "name": "坏参数", "version": "1.0.0", "apiVersion": "1.0.0",
                 "runtime": "declarative",
                 "settings": [
                   { "key": "flag", "label": "开关", "type": "boolean" },
                   { "key": "text", "label": "文本", "type": "string" },
                   { "key": "order", "label": "排序", "type": "select", "options": ["最近更新", "标题"] },
                   { "key": "unused", "label": "没人用", "type": "number" }
                 ],
                 "views": [ { "id": "v", "title": "V", "columns": ["title"],
                              "query": { "limit": { "fromSetting": "flag" },
                                         "updatedWithinDays": { "fromSetting": "text" },
                                         "sort": { "fromSetting": "order" },
                                         "kind": { "fromSetting": "nowhere" } } } ] }"#,
        );
        let r = validate_dir(&dir);
        assert!(!r.ok, "「永远拿不到可用值」的引用必须是错误：{:?}", r.problems);
        assert!(codes(&r).contains(&"view_param_bad_type".to_string()), "布尔设置当数字用：{:?}", r.problems);
        assert!(codes(&r).contains(&"view_param_unknown_setting".to_string()), "引用了不存在的设置：{:?}", r.problems);
        assert!(codes(&r).contains(&"view_param_bad_options".to_string()), "select 的候选项不在白名单里：{:?}", r.problems);
        assert!(codes(&r).contains(&"view_param_string_source".to_string()), "文本设置驱动数字字段只是提醒：{:?}", r.problems);
        assert!(codes(&r).contains(&"declarative_setting_unused".to_string()), "没人用的设置要提醒：{:?}", r.problems);
        let string_source = r.problems.iter().find(|p| p.code == "view_param_string_source").unwrap();
        assert_eq!(string_source.severity, "warning", "能填对也可能填错，所以只是提醒");
    }

    #[test]
    fn view_placement_is_a_whitelist_with_a_fallback_not_a_rejection() {
        // `rail` 是认识的落点 → 干净通过；不认识的值 → **提醒**（视图照常打得开，按 overlay
        // 处理），绝不能报成错误：声明式插件的原则是"永远打得开"。
        let good = declarative_plugin(
            "rail-view",
            r#"{ "id": "rail-view", "name": "常驻面板", "version": "1.0.0", "apiVersion": "1.0.0",
                 "runtime": "declarative",
                 "views": [ { "id": "v", "title": "V", "columns": ["title"], "placement": "rail" } ] }"#,
        );
        let r = validate_dir(&good);
        assert!(r.ok, "{:?}", r.problems);
        assert!(r.problems.is_empty(), "认识的落点不该有任何提示：{:?}", r.problems);

        let bad = declarative_plugin(
            "weird-view",
            r#"{ "id": "weird-view", "name": "落点写错", "version": "1.0.0", "apiVersion": "1.0.0",
                 "runtime": "declarative",
                 "views": [ { "id": "v", "title": "V", "columns": ["title"], "placement": "sidebar" } ] }"#,
        );
        let r = validate_dir(&bad);
        assert!(r.ok, "落点不认识只是提醒，不该拒载：{:?}", r.problems);
        let p = r.problems.iter().find(|p| p.code == "view_bad_placement").expect("应提示 view_bad_placement");
        assert!(p.message.contains("sidebar") && p.message.contains("overlay"), "要说清按什么处理：{}", p.message);
    }

    #[test]
    fn malformed_view_placement_shape_is_explained_before_anything_else() {
        // `"placement": 1` 形态不对 → 整份 manifest 解析失败（`Option<String>` 收不下数字）。
        // 这时必须指出是 placement 写错了，而不是让兜底报一句笼统的"加载器会拒载"。
        let dir = declarative_plugin(
            "bad-placement",
            r#"{ "id": "bad-placement", "name": "形态不对", "version": "1.0.0", "apiVersion": "1.0.0",
                 "runtime": "declarative",
                 "views": [ { "id": "v", "title": "V", "columns": ["title"], "placement": 1 } ] }"#,
        );
        let r = validate_dir(&dir);
        assert!(!r.ok, "加载器会拒就必须报错：{:?}", r.problems);
        let shape = r.problems.iter().find(|p| p.code == "view_field_shape").expect("应提示 view_field_shape");
        assert!(shape.message.contains("placement"), "{}", shape.message);
        assert!(!codes(&r).contains(&"declarative_no_views".to_string()), "别把形态错报成没写视图：{:?}", r.problems);
    }

    #[test]
    fn malformed_view_field_shape_is_explained_instead_of_misleading() {
        // `"limit": "20"` 会让整份 manifest 解析失败。此时**不能**报成
        // 「必须声明 views 或 theme 之一」——作者明明写了 views，那会把他引到反方向。
        let dir = declarative_plugin(
            "bad-shape",
            r#"{ "id": "bad-shape", "name": "形态不对", "version": "1.0.0", "apiVersion": "1.0.0",
                 "runtime": "declarative",
                 "views": [ { "id": "v", "title": "V", "columns": ["title"], "query": { "limit": "20" } } ] }"#,
        );
        let r = validate_dir(&dir);
        let shape = r.problems.iter().find(|p| p.code == "view_field_shape");
        assert!(shape.is_some(), "要说清是哪一项、该写成什么：{:?}", r.problems);
        assert!(shape.unwrap().message.contains("query.limit"), "{:?}", shape);
        assert!(
            !codes(&r).contains(&"declarative_no_views".to_string()),
            "别把「写错了形态」报成「没写 views」：{:?}",
            r.problems
        );
    }

    #[test]
    fn declarative_manifest_that_the_loader_rejects_is_never_reported_ok() {
        // 兜底保证：声明式这边原先**没有**「加载器会不会拒」这一步。manifest 解析失败
        // （这里是 `summary` 写成了字符串）时各条具体检查可能一条都不报，报告会显示
        // ok=true，可应用其实拒载——作者会以为没问题，装上去才发现。
        let dir = declarative_plugin(
            "silent-reject",
            r#"{ "id": "silent-reject", "name": "S", "version": "1.0.0", "apiVersion": "1.0.0",
                 "runtime": "declarative",
                 "views": [ { "id": "v", "title": "V", "columns": ["title"], "summary": "yes" } ] }"#,
        );
        let r = validate_dir(&dir);
        assert!(!r.ok, "加载器会拒就必须报错：{:?}", r.problems);
        assert!(codes(&r).contains(&"loader_rejected".to_string()), "{:?}", r.problems);
    }

    #[test]
    fn select_options_accept_both_the_short_and_the_full_form() {
        // 作者文档（生成物 §4.8）给的是短写法 `["最近更新", "标题"]`：它必须能装上去。
        // 此前只认 { value, label } 对象，于是文档里那个例子会被加载器拒载。
        let dir = declarative_plugin(
            "short-options",
            r#"{ "id": "short-options", "name": "短写法", "version": "1.0.0", "apiVersion": "1.0.0",
                 "runtime": "declarative",
                 "settings": [
                   { "key": "a", "label": "短写法", "type": "select", "options": ["updated_desc", "title_asc"] },
                   { "key": "b", "label": "全写法", "type": "select",
                     "options": [ { "value": "page", "label": "普通页" }, { "value": "database", "label": "数据库" } ] }
                 ],
                 "views": [ { "id": "v", "title": "V", "columns": ["title"],
                              "query": { "sort": { "fromSetting": "a" }, "kind": { "fromSetting": "b" } } } ] }"#,
        );
        let r = validate_dir(&dir);
        assert_eq!(r.errors().count(), 0, "两种写法都该被收下：{:?}", r.problems);
        assert_eq!(r.settings.len(), 2);
        assert_eq!(r.settings[0].options.len(), 2);
        assert_eq!(r.settings[0].options[0].value, "updated_desc");
        assert_eq!(r.settings[0].options[0].label, "updated_desc", "短写法里取值与显示名是同一个");
    }
}
