use crate::capabilities_gen;
use crate::db::Db;
use crate::plugin_index;
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

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PluginCommandMeta {
    pub id: String,
    pub title: String,
    pub description: String,
    /// JS 侧（`__describe()`）用 camelCase 交回，前端契约仍是 snake_case：
    /// 反序列化接受 `closeOnRun`，序列化仍输出 `close_on_run`。
    #[serde(alias = "closeOnRun")]
    pub close_on_run: bool,
    /// 命令要出现在哪些**触发面**（作者在 `register({ menus })` 里写）。
    ///
    /// 原样透传作者写的值（不做静默归一）：宿主只渲染自己认识的那些，而**校验器**
    /// 会明确指出哪些值本版本还没有对应的宿主入口——静默丢掉等于让作者白写。
    /// 入口清单见注册表（`menus`）：`slash`（编辑器 `/` 菜单）、`page.context`（页面列表行菜单）、
    /// `file.context`（文件列表右键菜单）；命令面板里的出现是所有命令的默认行为，不用声明。
    #[serde(default)]
    pub menus: Vec<String>,
    /// 命令参数声明（作者在 `register({ params })` 里写）。
    ///
    /// **这是宿主渲染参数表单的唯一依据**——作者声明什么，表单就渲染什么、就校验什么，
    /// 所以不存在"表单与实现不一致"。参数值本身**不构成安全边界**（它只会流进插件自己的
    /// JS；真正碰数据的是 `api.*`，那一步宿主逐次校验权限与参数），因此这里不做第二套
    /// 校验实现，只做 JSON 体积上限。
    #[serde(default)]
    pub params: Vec<PluginCommandParam>,
}

/// 一个命令参数的声明（对应作者侧的 `register({ params: [...] })`）。
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PluginCommandParam {
    pub name: String,
    /// 表单上显示的名字；作者不写就用 `name`。
    #[serde(default)]
    pub label: String,
    /// `string` | `number` | `boolean` | `select`（未知值在 JS 侧已归一为 `string`）。
    #[serde(rename = "type", default = "default_param_type")]
    pub param_type: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub placeholder: String,
    /// `select` 的候选项。
    #[serde(default)]
    pub options: Vec<PluginCommandParamOption>,
    /// 默认值（`serde_json::Value`：可能是字符串/数字/布尔）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<serde_json::Value>,
}

/// `select` 的一个候选项。
///
/// **两种写法都收**：`"最近更新"` 与 `{ "value": "updated_desc", "label": "最近更新" }`。
/// 为什么必须两种都收：作者文档（生成物 §4.8）给的就是短写法，而 `value`/`label` 分开写
/// 在需要「用户看到中文、实际取值是英文枚举」时才有必要。此前只认后者，于是文档里那个
/// 例子**会被加载器拒载**（结构体反序列化遇到裸字符串直接失败）——而且是静默的：
/// 声明式插件那边当时没有"加载器会不会拒"的兜底检查，报告会显示一切正常。
/// 命令参数（JS 侧 `register({ params })`）由 BOOTSTRAP 里的 `__normParams` 归一成对象，
/// 走的是同一个类型，所以这里收两种形态对它也无害。
#[derive(Serialize, Clone, Debug)]
pub struct PluginCommandParamOption {
    pub value: String,
    #[serde(default)]
    pub label: String,
}

impl<'de> serde::Deserialize<'de> for PluginCommandParamOption {
    fn deserialize<D>(d: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(serde::Deserialize)]
        #[serde(untagged)]
        enum Raw {
            /// 短写法：一个字符串既是取值也是显示名。
            Plain(String),
            Full {
                value: String,
                #[serde(default)]
                label: String,
            },
        }
        Ok(match Raw::deserialize(d)? {
            Raw::Plain(s) => PluginCommandParamOption { label: s.clone(), value: s },
            Raw::Full { value, label } => PluginCommandParamOption { value, label },
        })
    }
}

/// 校验用户填的值是否符合该项声明。**这是宿主侧的边界**：插件拿到的值必然是
/// 声明类型里的一种，所以插件不需要自己防御"用户填了乱七八糟的东西"。
pub(crate) fn validate_setting_value(decl: &SettingDecl, raw: &str) -> Result<String, String> {
    let label = if decl.label.trim().is_empty() { decl.key.as_str() } else { decl.label.as_str() };
    match decl.setting_type.as_str() {
        "number" => {
            let n: f64 = raw.trim().parse().map_err(|_| format!("「{label}」需要一个数字"))?;
            Ok(if n.fract() == 0.0 { format!("{}", n as i64) } else { format!("{n}") })
        }
        "boolean" => match raw {
            "true" | "false" => Ok(raw.to_string()),
            _ => Err(format!("「{label}」只能是 true 或 false")),
        },
        "select" => {
            if decl.options.iter().any(|o| o.value == raw) {
                Ok(raw.to_string())
            } else if decl.options.is_empty() {
                Err(format!("「{label}」声明了 select 却没有 options"))
            } else {
                Err(format!("「{label}」的值不在候选项里"))
            }
        }
        _ => Ok(raw.to_string()),
    }
}

/// 主题声明：一组设计变量（纯数据，插件侧没有代码）。
#[derive(serde::Deserialize, Serialize, Clone, Debug, Default)]
pub(crate) struct ThemeDecl {
    #[serde(default)]
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) tokens: std::collections::BTreeMap<String, String>,
}

/// 单个主题变量值的长度上限（它就该是 `#fff` 这种短值）。
const MAX_THEME_VALUE_LEN: usize = 64;
/// 一个主题最多覆盖多少个变量。
pub(crate) const MAX_THEME_TOKENS: usize = 40;

/// 校验一个主题变量的值。
///
/// **这不是风格检查，是安全边界**：这些值会被写进页面样式，所以必须挡住 `url(` 这类
/// 会造成**外部请求**的写法（本项目「绝不跟踪」的承诺不允许这种口子），以及能破坏声明
/// 结构的字符。前端应用前还会再筛一遍（纵深防御：校验器报错不代表加载时就不会遇到坏值）。
pub(crate) fn validate_theme_value(token: &capabilities_gen::ThemeToken, raw: &str) -> Result<(), String> {
    let v = raw.trim();
    if v.is_empty() {
        return Err("值是空的".to_string());
    }
    if v.chars().count() > MAX_THEME_VALUE_LEN {
        return Err(format!("值太长（上限 {MAX_THEME_VALUE_LEN} 字符）"));
    }
    let lower = v.to_ascii_lowercase();
    for bad in ["url(", "@", ";", "{", "}", "<", ">", "\\", "\n", "/*"] {
        if lower.contains(bad) {
            return Err(format!(
                "值里不允许出现 `{bad}`：主题变量会被写进页面样式，这类写法会造成外部请求或破坏样式"
            ));
        }
    }
    match token.kind {
        "color" => {
            let hex = v.starts_with('#')
                && (4..=9).contains(&v.len())
                && v[1..].chars().all(|c| c.is_ascii_hexdigit());
            let func = lower.starts_with("rgb(") || lower.starts_with("rgba(") || lower.starts_with("hsl(") || lower.starts_with("hsla(");
            let named = matches!(lower.as_str(), "transparent" | "currentcolor" | "inherit")
                || v.chars().all(|c| c.is_ascii_alphabetic());
            if !(hex || func || named) {
                return Err("看起来不是颜色（可以是 #rgb / #rrggbb / rgb(...) / hsl(...) / 颜色名）".to_string());
            }
        }
        "length" => {
            let starts_number = v.chars().next().map(|c| c.is_ascii_digit() || c == '.').unwrap_or(false);
            let unit = ["px", "em", "rem", "%"].iter().any(|u| lower.ends_with(u));
            if !(v == "0" || (starts_number && unit)) {
                return Err("看起来不是长度（可以是 0 / 4px / 0.5rem / 8% 这类）".to_string());
            }
        }
        _ => {}
    }
    Ok(())
}

/// 取一个插件**可用**的主题变量：白名单内 + 值通过校验。
///
/// 无效的**丢弃而不是整体失败**：一个写错的主题不该让插件装不上（校验器会明确报错），
/// 但它也绝不该被应用到界面上——所以这里与前端各筛一遍。
pub(crate) fn sanitized_theme(manifest: &Manifest) -> Option<ThemeDecl> {
    let t = manifest.theme.as_ref()?;
    let tokens: std::collections::BTreeMap<String, String> = t
        .tokens
        .iter()
        .filter(|(k, v)| {
            capabilities_gen::theme_token(k)
                .map(|tok| validate_theme_value(tok, v).is_ok())
                .unwrap_or(false)
        })
        .map(|(k, v)| (k.clone(), v.trim().to_string()))
        .collect();
    if tokens.is_empty() {
        None
    } else {
        Some(ThemeDecl { name: t.name.clone(), tokens })
    }
}

fn default_param_type() -> String {
    "string".to_string()
}

/// 一次调用能携带的参数 JSON 上限：**这是「行为」的界，不是「参数必须是短值」的语义**。
///
/// 这条通道实际承载两种东西：① 用户在参数表单里填的短值；② **导入触发**把用户选中的
/// 文件读成文本后的 `{ fileName, content }`。1 MiB 是按后者定的——够装下常见的文本 /
/// 表格文件（一本几万字的 md、一张几千行的 csv），又不让单次调用携带**不可控**的数据量
/// （这是个参数通道，不该被当成批量数据的搬运面）。
///
/// 两个边界必须说清，否则这个常量会被后人按错误的理解调整：
/// - 它**不是安全边界**：参数只会流进插件自己的 JS，真正碰数据的是 `api.*`（宿主逐次
///   校验权限与参数）。所以这里不做第二套 schema 校验，只做体积上限。
/// - 它**不是数据通道**：插件要读笔记 / 文件数据，能力面只有 `api.*`——把内容塞进参数
///   不会让插件多出任何能力，写能力照样出草稿、照样要用户确认。
const MAX_ARGS_BYTES: usize = 1024 * 1024;

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
    /// 订阅了哪些事件：**必须在启用前让用户看到**（事件 = 用户没点命令时也会跑代码）。
    pub events: Vec<PluginEventMeta>,
    /// 运行档（`logic` / `declarative`）——界面要能说清"这个插件有没有代码"。
    pub runtime: String,
    /// 声明式视图：宿主渲染，插件零代码。
    pub views: Vec<ViewDecl>,
    /// 导入触发（**只带通过校验的那些**）：命令面板据此加入口。
    pub triggers: Vec<TriggerDecl>,
    /// 授权状态：插件文件被换成声明更大的版本时 `required = true`（宿主会暂停它，
    /// 直到用户点了「重新确认」）。**这是后端强制的**，不是界面上的提醒而已。
    pub approval: ApprovalState,
    /// 主题声明（只有**通过校验**的变量会被带上）。
    pub theme: Option<ThemeDecl>,
    /// 这一次安装**替换掉**的那个版本（升级 / 重装的返回值才有；`list_plugins` 不带）。
    /// 有它，界面才能说清"这不是新装、是把它从 v1 换成了 v2"，而不是假装一切都全新。
    #[serde(default)]
    pub replaced_version: Option<String>,
    /// 这个**已装的版本**被索引撤回过（离线记忆，见 `plugin_revocation`）。
    /// 有值时：宿主已经拒绝运行它（除非 `ignored`），界面必须显示出来。
    #[serde(default)]
    pub revoked: Option<RevocationView>,
    /// 装它时固定下来的发布者公钥（TOFU）。界面显示指纹，用户才有机会在别处对比。
    #[serde(default)]
    pub publisher_key: Option<PublisherKeyView>,
    /// 这个插件当初固定的那把发布者密钥**已被索引撤回**（离线记忆）。
    /// 有值时宿主已经拒绝运行它（除非用户点过「仍然使用」）。
    #[serde(default)]
    pub publisher_key_revoked: Option<RevokedKeyEntry>,
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
pub(crate) fn permission_metas(manifest: &Manifest) -> (Vec<PluginPermissionMeta>, bool) {
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
    /// 设置项 key → scope（`space`/`app`）：**scope 由 manifest 声明决定，不由插件选**。
    /// 宿主在运行前从 manifest 填好，避免每次 `settings.get` 都去读盘。
    setting_scopes: std::collections::HashMap<String, String>,
    drafts: Vec<PluginDraft>,
    /// 本次执行里 `api.files.export` 产出的导出请求：**不写盘**，随结果回传前端，
    /// 由前端逐个弹系统保存对话框（用户选位置才算数）。与草稿同一个中介思路：插件
    /// 只能"申请"，落盘与否由用户决定。
    exports: Vec<PluginExport>,
    /// `__toast(...)` 收集到的提示：**随调用结果回传前端**，由前端弹 toast。
    /// 走返回值而不是事件，是因为命令本来就是一次性的——不需要跨线程推事件。
    toasts: Vec<String>,
    /// M11.13 阶段 1：这次运行在**子进程**里，能力调用回一个假应答（echo）。
    ///
    /// 子进程没有数据库、没有密钥、没有路径——它跑不动真能力，也不该跑。阶段 2 会把
    /// `__cap` 改成 RPC 回父进程（那里已经有权限校验、审计与写中介）；在那之前，
    /// 这个开关让"通道 + 解释器 + 插件 JS"这三段能在真进程边界上先跑通、被测住。
    /// M11.13 阶段 2：能力调用的**传输**。有它时每次 `api.*` 都走它回父进程（父进程在那里
    /// 查库并回答）；没有时才轮到上面的假应答。
    ///
    /// 用 `Arc<dyn Fn>` 而不是把 io 句柄塞进来：跑插件的是工作线程，而"怎么跟父进程说话"
    /// 是子进程那一侧的知识——`plugins` 这一层不该知道帧、stdin、pid 这些东西。
    cap_rpc: Option<std::sync::Arc<dyn Fn(&str, &str) -> Result<String, String> + Send + Sync>>,
}

/// 一次导出请求（`api.files.export` 的产物）。
///
/// **插件给不出路径**（只给建议文件名，且目录部分会被去掉）：存到哪里由用户在系统保存
/// 对话框里定。所以这条能力不是"写任意路径"——它没有那个自由度，也就没有那个风险。
#[derive(Serialize, Clone, Debug)]
pub struct PluginExport {
    /// 建议的文件名（已去掉目录、已限长）。
    pub file_name: String,
    pub content: String,
    pub bytes: usize,
}

/// 单个导出文件的体积上限。定在 4 MiB：够装"把一批笔记导出成一份 md"，又不至于让
/// 一次执行的返回值（它要过 IPC 回前端、再交给保存对话框那一步）变得不可控。
/// 一次运行最多几个文件同理（见 [`MAX_EXPORTS_PER_RUN`]）。
const MAX_EXPORT_BYTES: usize = 4 * 1024 * 1024;
/// 一次运行最多产出几个导出请求（会话里是逐个弹保存对话框，多了就是折磨人）。
pub(crate) const MAX_EXPORTS_PER_RUN: usize = 4;

/// 把一个"建议文件名"收拾成**光秃秃的文件名**：去掉目录、去掉控制字符、限长。
///
/// 不做"猜作者想要什么"的事，只做减法：插件可能习惯性写成 `dir/name.md`，那不该报错
/// （用户本来就在下一步选真实位置），但宿主也绝不把它当成路径用。
pub(crate) fn sanitize_export_file_name(raw: &str) -> Option<String> {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("").trim();
    let cleaned: String = base.chars().filter(|c| !c.is_control()).collect();
    let cleaned = cleaned.trim().trim_matches('.').to_string();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." || cleaned.contains("..") && cleaned.ends_with('.') {
        return None;
    }
    let mut out: String = cleaned.chars().take(120).collect();
    if out.is_empty() {
        return None;
    }
    // Windows 不允许结尾的点/空格；截断后可能正好落在那里
    while out.ends_with('.') || out.ends_with(' ') {
        out.pop();
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// Result of running a plugin command: a display `message`, plus an optional
/// `insert` payload the plugin wants to drop into the current page.
#[derive(Serialize, Clone)]
pub struct PluginRunResult {
    pub message: String,
    pub insert: Option<String>,
    /// `api.files.export` 的产物：**还没写盘**，前端逐个弹保存对话框。
    pub exports: Vec<PluginExport>,
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
    /// `capability = "host.run"` 这类**运行记录**上带的峰值常驻内存（字节）。
    ///
    /// 为什么记它：内存看门狗只能"拦住暴走"，而"这个插件平时吃多少"是另一件同样有用的事——
    /// 用户据此判断要不要禁用它，作者据此判断自己是不是写得太肥。读不到读数时是 `None`。
    #[serde(default)]
    pub peak_rss_bytes: Option<u64>,
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

/// 记一条**运行记录**（不是能力调用）：一次命令/事件跑完（或被杀）之后的结局。
///
/// 与能力审计共用同一个环与同一份界面，因为它回答的是同一个问题——"这个插件刚才干了什么"。
fn push_run_audit(
    plugin_id: &str,
    kind: &str,
    ok: bool,
    error_code: Option<String>,
    peak_rss_bytes: Option<u64>,
) {
    let mut q = PLUGIN_AUDIT.lock().unwrap_or_else(|e| e.into_inner());
    if q.len() >= PLUGIN_AUDIT_CAPACITY {
        q.pop_front();
    }
    q.push_back(PluginAuditEntry {
        plugin_id: plugin_id.to_string(),
        capability: "host.run".to_string(),
        scope: kind.to_string(),
        at_ms: now_ms(),
        ok,
        error_code,
        peak_rss_bytes,
    });
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
        peak_rss_bytes: None,
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
pub(crate) struct Manifest {
    pub(crate) id: String,
    pub(crate) name: String,
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
    pub(crate) permissions: Option<Vec<PermissionDecl>>,
    /// 运行档：`logic`（默认，有 main.js 的脚本插件）或 `declarative`（零 JS，只有声明）。
    #[serde(default)]
    pub(crate) runtime: Option<String>,
    /// 主题：一组设计变量（纯数据，两档插件都可以声明）。
    #[serde(default)]
    pub(crate) theme: Option<ThemeDecl>,
    /// 声明式视图：宿主按这份声明渲染（零 JS 插件唯一的产出方式）。
    #[serde(default)]
    pub(crate) views: Option<Vec<ViewDecl>>,
    /// 导入触发：命令面板里按扩展名加入口，用户选中文件后宿主读内容并交给命令。
    #[serde(default)]
    pub(crate) triggers: Option<Vec<TriggerDecl>>,
    /// 用户可配置项：宿主据此渲染设置表单（**写只发生在宿主界面**）。
    #[serde(default)]
    pub(crate) settings: Option<Vec<SettingDecl>>,
    /// 声明要订阅的事件，带理由。
    ///
    /// 与权限不同，**缺失 = 一个事件都不订阅**（没有基线）：在用户没点命令时后台跑代码，
    /// 更不能默认给——老插件不会因为升级就突然有了后台行为。
    #[serde(default)]
    pub(crate) events: Option<Vec<EventDecl>>,
}

/// 一个声明式视图：宿主据此查询并渲染，插件侧**没有代码**。
#[derive(serde::Deserialize, Serialize, Clone, Debug)]
pub(crate) struct ViewDecl {
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) title: String,
    #[serde(default)]
    pub(crate) query: ViewQuery,
    /// 要显示的列（宿主只认白名单里的列，未知列由校验器指出）。
    #[serde(default)]
    pub(crate) columns: Vec<String>,
    /// 是否在顶部显示一行汇总（共几篇、最近 N 天更新几篇）。
    #[serde(default)]
    pub(crate) summary: bool,
    /// 这个视图**开在哪里**（M11.9 收尾）：`overlay`（默认，占满屏幕的浮层）或 `rail`（右侧
    /// 常驻面板，与正文并排）。
    ///
    /// 为什么要有第二种形态：浮层是"看完了就关"的形态，而"面板"是"一边看正文一边看着它"的
    /// 形态——周回顾、待整理清单这类清单**本来就该常驻**，每次都要开一次浮层、关一次浮层，
    /// 那不是插件的错，是宿主只给了一种形态。它同时也是 M11.10（沙盒 UI 插件）的启动闸门
    /// 里的那句话：多数「我要一个插件面板」应当由声明式渲染器满足。
    ///
    /// 取值不认识时**不拒载**（与 `query.kind`/`sort`、`columns` 同一套口径）：视图照常打得开，
    /// 只是按 `overlay` 处理，校验器会指出哪个值不认识——声明式插件的原则是"永远打得开"。
    #[serde(default)]
    pub(crate) placement: Option<String>,
}

/// 视图的落点白名单：`overlay` = 浮层（默认），`rail` = 右侧常驻面板。
pub(crate) const VIEW_PLACEMENTS: &[&str] = &["overlay", "rail"];

/// 查询字段的取值：**字面量**，或**指向用户在插件管理里设的那个设置**（M11.9 收口）。
///
/// 为什么要有第二种：声明式插件没有代码，查询原先被钉死在 manifest 里——用户想改
/// 「看多少天内更新的」就只能去写一个 logic 插件。可这件事的两端**本来就都在宿主手里**：
/// 设置由宿主渲染表单、宿主校验、宿主落库（`plugin_settings`），视图也由宿主渲染。
/// 没有理由不让它们接上——接上之后，「用户可配」不再必然意味着「必须有代码」。
///
/// 语法：`"limit": { "fromSetting": "recentCount" }`（`"updatedWithinDays"` 同理）。
///
/// **默认值只有一处**：设置声明里的 `default`——刻意不在这里再给一个 `default`，两个默认值
/// 必然会漂。设置也没设过、也没有 `default` 时，该字段按「没给」处理（即宿主的默认行为：
/// 排序按最近更新、limit 50、不按天数筛…），校验器会在作者那边把问题指出来。
#[derive(serde::Deserialize, Serialize, Clone, Debug)]
#[serde(untagged)]
pub(crate) enum NumericField {
    /// 先试这个变体：带 `fromSetting` 的对象。
    Setting {
        #[serde(rename = "fromSetting")]
        from_setting: String,
    },
    /// 字面量（`20`）。写成字符串/布尔会两个变体都落空 → manifest 解析失败（校验器会给出
    /// 具体是哪一项写错了，见 `check_view_field_shapes`）。
    Value(i64),
}

/// 文本型查询字段（`kind` / `sort` / `titleContains`）的取值，形态与 [`NumericField`] 相同。
#[derive(serde::Deserialize, Serialize, Clone, Debug)]
#[serde(untagged)]
pub(crate) enum TextField {
    Setting {
        #[serde(rename = "fromSetting")]
        from_setting: String,
    },
    Value(String),
}

impl NumericField {
    /// 字面量取值（不是字面量则 `None`）。
    pub(crate) fn literal(&self) -> Option<i64> {
        match self {
            NumericField::Value(v) => Some(*v),
            NumericField::Setting { .. } => None,
        }
    }
}

impl TextField {
    pub(crate) fn literal(&self) -> Option<&str> {
        match self {
            TextField::Value(v) => Some(v.as_str()),
            TextField::Setting { .. } => None,
        }
    }
}

/// 视图查询。
///
/// **manifest 里写的是 camelCase**（`titleContains` / `updatedWithinDays`）——与
/// `apiVersion` / `closeOnRun` / `fromSetting` 一致。这一条必须靠测试钉住：结构体字段是
/// snake_case，早先漏了 `rename_all`，于是**作者文档与示例里写的 `updatedWithinDays` 被
/// 静默丢掉**（"最近 30 天"从来没生效过，文档却写着能用）。同时用 `alias` 收下 snake_case
/// 写法：那是照着结构体反推出来的形态，收下它不花任何代价。
#[derive(serde::Deserialize, Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ViewQuery {
    /// `any`（默认）或 `page` / `database`（按页面的 kind 过滤）。
    #[serde(default)]
    pub(crate) kind: Option<TextField>,
    /// 标题包含（大小写不敏感的子串）。
    #[serde(default, alias = "title_contains")]
    pub(crate) title_contains: Option<TextField>,
    /// 只看最近 N 天内更新过的。
    #[serde(default, alias = "updated_within_days")]
    pub(crate) updated_within_days: Option<NumericField>,
    /// `updated_desc`（默认）/ `created_desc` / `title_asc`。
    #[serde(default)]
    pub(crate) sort: Option<TextField>,
    #[serde(default)]
    pub(crate) limit: Option<NumericField>,
}

/// 宿主支持的视图列（白名单：宿主渲染什么，作者只能从这里选）。
pub(crate) const VIEW_COLUMNS: &[(&str, &str)] = &[
    ("title", "标题"),
    ("kind", "类型"),
    ("updated_at", "更新时间"),
    ("created_at", "创建时间"),
    ("days_since_update", "距上次更新（天）"),
    ("title_length", "标题长度"),
];

/// 宿主支持的排序与 kind 取值（校验器据此指出写错的值）。
pub(crate) const VIEW_SORTS: &[&str] = &["updated_desc", "created_desc", "title_asc", "title_desc"];
pub(crate) const VIEW_KINDS: &[&str] = &["any", "page", "database"];

/// 声明式插件允许的视图数量上限（声明是给人看的，不是拿来堆量的）。
pub(crate) const MAX_VIEWS: usize = 8;

/// 一条**导入触发**（manifest `triggers[]`）：宿主按扩展名在命令面板里加一个入口，
/// 用户选中文件后由**宿主**把它读成文本，作为命令参数 `{ fileName, content }` 交给插件。
///
/// 和命令参数（`register({ params })`）是同一类东西——**入参不是能力**：插件拿到的
/// 只是这一次调用的数据，它要碰笔记数据仍然只能走 `api.*`（写能力照样出草稿、要用户确认）。
/// 也正因如此，它不需要新能力、不需要新命令，权限模型与写中介原样成立。
///
/// 为什么声明在 manifest 而不是 JS 里：它是**给用户看的**功能声明（插件管理里要能说出
/// "这个插件会接住哪些文件"），而 JS 只能等点了才知道。
#[derive(serde::Deserialize, Serialize, Clone, Debug)]
pub(crate) struct TriggerDecl {
    /// 触发类型：只认识注册表里的值（`capabilities_gen::trigger`），目前只有 `import`。
    pub(crate) kind: String,
    /// 接住的扩展名（**规范化后**形如 `.md`，见 `normalize_extension`）。
    #[serde(default)]
    pub(crate) extensions: Vec<String>,
    /// 被调用的命令 id（必须是这个插件自己 `register` 过的命令）。
    #[serde(default)]
    pub(crate) command: String,
    /// 命令面板里那条入口的标题；不写就用默认的「导入：用「插件名」打开 .md」。
    #[serde(default)]
    pub(crate) title: String,
}

/// 一条触发最多声明多少个扩展名（够用即可：一个命令通常只处理一两种格式）。
pub(crate) const MAX_TRIGGER_EXTENSIONS: usize = 12;
/// 一个插件最多声明多少条触发（与视图同理：声明是给人看的，不是拿来堆量的）。
pub(crate) const MAX_TRIGGERS: usize = 4;

/// 把一个扩展名规范化成 `.md` 这种**小写带点**形式；不合法返回 `None`。
///
/// 规范化而不是原样透传：`"MD"` / `".Md"` / `" md "` 说的是同一件事，而宿主只需要一种
/// 形态——命令面板的入口文案与文件选择器的过滤器都按它来，两处各写一遍必然出现
/// 「文案说 .md、选择器却在筛 MD」这种不一致。
///
/// 不合法的**一律不接**（而不是猜作者想接什么）：扩展名里出现空格 / 分隔符 / 通配符
/// 只可能是写错了，猜着接住会变成"这个插件连 xx 文件都吃"。
pub(crate) fn normalize_extension(raw: &str) -> Option<String> {
    let t = raw.trim().trim_start_matches('.').to_ascii_lowercase();
    if t.is_empty() || t.len() > 16 {
        return None;
    }
    if !t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return None;
    }
    Some(format!(".{t}"))
}

/// 取一个插件**可用**的触发声明：kind 认识且宿主已实现、命令非空、至少一个合法扩展名。
///
/// 与主题同样的取舍：无效的**丢弃而不是整体失败**（校验器会明确报错），但宿主绝不按一条
/// 读不懂的声明去接文件。
///
/// 另外，**声明式插件（零代码）的触发恒为空**：它没有命令可以调用，留着入口只会让用户
/// 点到一个必然报「命令不存在」的按钮。这条规则放在这里（而不是各个调用点），是为了让
/// `list_plugins` / `install_plugin` 自动一致。
pub(crate) fn sanitized_triggers(manifest: &Manifest) -> Vec<TriggerDecl> {
    if runtime_of(manifest) == "declarative" {
        return Vec::new();
    }
    let Some(list) = &manifest.triggers else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for t in list.iter().take(MAX_TRIGGERS) {
        // 只渲染宿主真的接了的触发：kind 不认识、或认识了但还没实现的，一律不出现
        // （作者那边由校验器明说，而不是让他对着一个不出现的入口猜）。
        if !capabilities_gen::trigger(t.kind.trim()).map(|k| k.hosted).unwrap_or(false) {
            continue;
        }
        if t.command.trim().is_empty() {
            continue;
        }
        let mut extensions: Vec<String> = Vec::new();
        for e in t.extensions.iter() {
            if let Some(n) = normalize_extension(e) {
                if !extensions.contains(&n) {
                    extensions.push(n);
                }
            }
            if extensions.len() >= MAX_TRIGGER_EXTENSIONS {
                break;
            }
        }
        if extensions.is_empty() {
            continue;
        }
        out.push(TriggerDecl {
            kind: t.kind.trim().to_string(),
            extensions,
            command: t.command.trim().to_string(),
            title: t.title.trim().to_string(),
        });
    }
    out
}

/// 这项声明的运行档（缺省 `logic`）。
pub(crate) fn runtime_of(manifest: &Manifest) -> &str {
    match manifest.runtime.as_deref() {
        Some(r) if !r.is_empty() => r,
        _ => "logic",
    }
}

/// 一项用户设置的声明（宿主据此渲染设置表单，并据此校验用户填的值）。
#[derive(serde::Deserialize, Serialize, Clone, Debug)]
pub(crate) struct SettingDecl {
    pub(crate) key: String,
    #[serde(default)]
    pub(crate) label: String,
    /// `string` | `number` | `boolean` | `select`（未知值按 string 处理）。
    #[serde(rename = "type", default = "default_param_type")]
    pub(crate) setting_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) default: Option<serde_json::Value>,
    #[serde(default)]
    pub(crate) options: Vec<PluginCommandParamOption>,
    #[serde(default)]
    pub(crate) description: String,
    /// `space`（默认，随空间加密）或 `app`（应用级，明文）。
    #[serde(default = "default_setting_scope")]
    pub(crate) scope: String,
}

fn default_setting_scope() -> String {
    "space".to_string()
}

#[derive(serde::Deserialize, Clone, Debug)]
pub(crate) struct EventDecl {
    /// 事件名（`capabilities/capabilities.json` 的 `events[].id`）。
    pub(crate) on: String,
    #[serde(default)]
    pub(crate) reason: String,
}

#[derive(serde::Deserialize, Clone, Debug)]
pub(crate) struct PermissionDecl {
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) reason: String,
}

fn default_main() -> String {
    "main.js".to_string()
}

pub(crate) fn plugins_root(app: &AppHandle) -> Result<PathBuf, String> {
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
pub(crate) fn is_safe_plugin_id(id: &str) -> bool {
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
pub(crate) fn is_bare_file_name(main: &str) -> bool {
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

pub(crate) fn read_manifest(dir: &Path) -> Result<Manifest, String> {
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
    // 运行档闸门：只认识 logic / declarative，其它值直接拒载（与 apiVersion 同样的思路：
    // 不认识就明说，而不是让它跑起来一半再零碎失败）。
    let runtime = runtime_of(&m);
    if runtime != "logic" && runtime != "declarative" {
        return Err(format!(
            "manifest.runtime 不认识：{runtime}（本应用支持 logic / declarative）"
        ));
    }
    // 声明式插件没有代码，所以不校验 main（写了的也不执行，由校验器提醒作者删掉）。
    if runtime == "logic" && !is_bare_file_name(&m.main) {
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

pub(crate) fn load_plugin_source(dir: &Path, manifest: &Manifest) -> Result<String, String> {
    if runtime_of(manifest) == "declarative" {
        return Err("declarative_no_code: 声明式插件没有代码（只有 manifest 声明）".to_string());
    }
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
// 触发面声明：只做「字符串化 + 去重 + 限量」，**不**过滤不认识的值——
// 宿主渲染自己认识的，校验器负责告诉作者哪些值还没有对应入口。
function __normMenus(list){
  if(!list || !list.length) return [];
  var out = [];
  for(var i=0;i<list.length && out.length<8;i++){
    var m = list[i];
    if(m === undefined || m === null) continue;
    var v = String(m).slice(0, 32);
    if(!v) continue;
    if(out.indexOf(v) < 0) out.push(v);
  }
  return out;
}

// 参数声明归一化：宿主按它渲染表单。类型不认识就当 string（宁可给个文本框，
// 也不要因为作者写错一个词就让整个命令消失）。
function __normParams(list){
  if(!list || !list.length) return [];
  var out = [];
  for(var i=0;i<list.length;i++){
    var p = list[i];
    if(!p || !p.name) continue;
    var t = String(p.type === undefined ? "string" : p.type);
    if(t !== "string" && t !== "number" && t !== "boolean" && t !== "select") t = "string";
    var item = {
      name: String(p.name),
      label: p.label === undefined ? String(p.name) : String(p.label),
      type: t,
      required: p.required === true,
      placeholder: p.placeholder === undefined ? "" : String(p.placeholder),
      options: []
    };
    if(p.options && p.options.length){
      for(var j=0;j<p.options.length;j++){
        var o = p.options[j];
        if(o === undefined || o === null) continue;
        if(typeof o === "object") item.options.push({ value: String(o.value === undefined ? "" : o.value), label: o.label === undefined ? "" : String(o.label) });
        else item.options.push({ value: String(o), label: String(o) });
      }
    }
    if(p.default !== undefined) item.default = p.default;
    out.push(item);
  }
  return out;
}
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
      closeOnRun: c.closeOnRun === true,
      menus: __normMenus(c.menus),
      params: __normParams(c.params)
    });
  }
  return JSON.stringify(out);
}
// 命令执行。`argsJson` 是宿主渲染的参数表单交回的值（没有参数时为空串）。
//
// 返回值两种形态都支持：
//   字符串/数字          —— 直接作为结果消息（老写法，保持兼容）；
//   对象 {message, toast, toasts, insert} —— 结构化返回，等价于调用对应的宿主原语。
//   刻意**没有** `open`：那是"让宿主导航到某页"的新副作用面，属于 ABI 决策，
//   不夹带在参数这一档里（见路线图 M11.8 备注）。
// 事件订阅：作者在顶层 `on(name, handler)`。宿主派发时用 `__emit` 触发。
// 与 register 一样，处理器只活在 JS 里，宿主不持有任何回调对象。
var __handlers = {};
function on(name, handler){
  if(!name || typeof handler !== "function") return;
  var k = String(name);
  if(!__handlers[k]) __handlers[k] = [];
  __handlers[k].push(handler);
}
function __emit(name, payloadJson){
  var hs = __handlers[name];
  if(!hs || !hs.length) return "";
  var payload = {};
  if(payloadJson){
    try { payload = JSON.parse(payloadJson); } catch(e) { payload = {}; }
    if(payload === null || typeof payload !== "object" || payload.length !== undefined) payload = {};
  }
  var out = [];
  for(var i=0;i<hs.length;i++){
    try {
      var r = hs[i](payload);
      if(r !== undefined && r !== null && r !== "") out.push(String(r));
    } catch(e) {
      // 一个处理器出错不该吃掉其它处理器，也不该静默：错误随结果回传，宿主写进插件日志
      out.push("出错：" + e);
    }
  }
  return out.join("；");
}

function __run(id, argsJson){
  var c = __cmds[id];
  if(!c) return "__plugin: 命令不存在";
  var args = {};
  if(argsJson){
    try { args = JSON.parse(argsJson); } catch(e) { return "__plugin: 参数不是合法 JSON"; }
    // 数组也是 typeof "object"，但命令参数是**具名**的：退回空对象而不是把数组塞进去
    if(args === null || typeof args !== "object" || args.length !== undefined) args = {};
  }
  try {
    var res = c.run(args);
    if(res !== null && typeof res === "object"){
      if(res.insert !== undefined && res.insert !== null) __insert(String(res.insert));
      var list = res.toasts === undefined ? res.toast : res.toasts;
      if(list !== undefined && list !== null){
        if(typeof list === "string") __toast(list);
        else if(list.length) for(var i=0;i<list.length;i++) __toast(String(list[i]));
      }
      return res.message === undefined || res.message === null ? "" : String(res.message);
    }
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
pub(crate) const DISCOVER_TIMEOUT: Duration = Duration::from_secs(3);

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

/// 只做语法解析的上下文（Boa 的 `Script::parse` 也要求一个 Context）。
/// 解析不执行代码，所以不给循环预算也无所谓；单独一个函数是为了让「解析用」与
/// 「执行用」在调用点一眼可分。
pub(crate) fn plugin_parse_context() -> Context {
    plugin_context(DISCOVER_LOOP_LIMIT)
}

/// v1 基线权限集合（校验内核在 manifest 不可用时也要能跑一次 discovery）。
pub(crate) fn baseline_permission_ids() -> Vec<String> {
    baseline_permissions()
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
pub(crate) fn resolve_permissions(manifest: &Manifest) -> (Vec<String>, Vec<String>) {
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

/// 解析 manifest 的事件订阅，并给出要记录给用户的警告。
///
/// 与权限同样的前向兼容策略（未知事件名忽略 + 警告），但**没有基线授权**：
/// 没写 `events` 就是一个都不订阅。
pub(crate) fn resolve_events(manifest: &Manifest) -> (Vec<String>, Vec<String>) {
    let mut warnings = Vec::new();
    let Some(decls) = &manifest.events else {
        return (Vec::new(), warnings);
    };
    let mut subscribed: Vec<String> = Vec::new();
    for d in decls {
        let decision = decide_event(capabilities_gen::event(&d.on), &d.on, &d.reason);
        warnings.extend(decision.warnings);
        if decision.subscribe && !subscribed.contains(&d.on) {
            subscribed.push(d.on.clone());
        }
    }
    (subscribed, warnings)
}

/// 一条事件声明的判定：**算不算订阅成功**，以及要告诉作者什么。
///
/// 单独抽出来是因为这里有一条**必须一直有覆盖**的保护：宿主还没开始发的事件不算订阅
/// （写对了名字、启用了插件、却永远收不到，比报错更难查）。2026-09 把最后两个事件
/// （`import.finished` / `sync.completed`）接上之后，注册表里已经没有这种事件了——
/// 但保护本身不能因此失去测试：它由一条**合成的** `hosted: false` 声明直接调这个函数来覆盖，
/// 另有一条测试钉住"注册表里不许再出现还没接的事件"。将来谁想"先声明、后实现"，
/// 两条中的任何一条都会当场拦下来。
struct EventDecision {
    subscribe: bool,
    warnings: Vec<String>,
}

fn decide_event(ev: Option<&capabilities_gen::PluginEvent>, on: &str, reason: &str) -> EventDecision {
    let Some(ev) = ev else {
        return EventDecision {
            subscribe: false,
            warnings: vec![format!("忽略未知事件 {on}（当前 API 版本不认识它）")],
        };
    };
    if !ev.hosted {
        return EventDecision {
            subscribe: false,
            warnings: vec![format!("事件 {} 宿主还没开始发（订阅了现在也收不到）", ev.id)],
        };
    }
    let mut warnings = Vec::new();
    if reason.trim().is_empty() {
        warnings.push(format!(
            "事件 {} 没有写 reason（用户看不到它为什么要在后台运行）",
            ev.id
        ));
    }
    EventDecision { subscribe: true, warnings }
}

/// 事件派发时展示给用户的事件声明（安装/启用界面看得到，才能授权）。
#[derive(Serialize, Clone, Debug)]
pub struct PluginEventMeta {
    pub id: String,
    pub title: String,
    pub reason: String,
}

pub(crate) fn event_metas(manifest: &Manifest) -> Vec<PluginEventMeta> {
    let (subscribed, _) = resolve_events(manifest);
    let reasons: std::collections::HashMap<&str, &str> = manifest
        .events
        .as_ref()
        .map(|ds| ds.iter().map(|d| (d.on.as_str(), d.reason.as_str())).collect())
        .unwrap_or_default();
    subscribed
        .iter()
        .map(|id| PluginEventMeta {
            id: id.clone(),
            title: capabilities_gen::event(id).map(|e| e.title.to_string()).unwrap_or_else(|| id.clone()),
            reason: reasons.get(id.as_str()).copied().unwrap_or_default().to_string(),
        })
        .collect()
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
/// 设置项的键前缀：这一命名空间**由宿主界面独占写入**。
///
/// 为什么必须挡住插件：设置是用户为了这个插件亲手填的（例如"导入到哪个文件夹"），
/// 如果插件能自己改，那用户看到的配置就不再是他设的那个——插件就绕过了唯一一处
/// 需要他本人在场才能做的决定。读取不受限（插件当然要读自己的设置）。
const SETTING_PREFIX: &str = "setting:";

fn is_reserved_setting_key(key: &str) -> bool {
    key.starts_with(SETTING_PREFIX)
}

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
    if is_reserved_setting_key(key) {
        return Err(format!(
            "permission_denied: {SETTING_PREFIX}* 由宿主界面管理（设置里填的值不该被插件改写）"
        ));
    }
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

/// `api.settings.get(key)` —— 读用户在插件管理里填的值。
///
/// 落库位置与 kv 相同（`plugin_data`），键加 `setting:` 前缀，所以：scope=space 时随
/// 空间 SQLCipher 加密、scope=app 时在 meta.db（明文）。默认 scope 是 **space**——
/// 设置里常有 token / 路径这类东西，默认落明文不合适（见作者文档）。
/// 从 manifest 取出「设置项 → scope」表，交给插件线程（避免每次调用读盘）。
pub(crate) fn setting_scopes_of(manifest: &Manifest) -> std::collections::HashMap<String, String> {
    manifest
        .settings
        .as_ref()
        .map(|ds| {
            ds.iter()
                .map(|d| (d.key.clone(), if d.scope == "app" { "app".to_string() } else { "space".to_string() }))
                .collect()
        })
        .unwrap_or_default()
}

fn cap_settings_get(key: &str) -> CapResult {
    let (pid, scope) = RUN_STATE.with(|s| {
        let st = s.borrow();
        (st.plugin_id.clone(), st.setting_scopes.get(key).cloned())
    });
    // 未声明的 key 直接报错（而不是返回 null）：写错 key 名是最常见的低级错误，
    // 静默返回 null 会让作者以为"用户没设过"，查很久。
    let scope = scope.ok_or_else(|| {
        format!("bad_args: manifest.settings 里没有声明设置项 {key}（可用键在插件管理里能看到）")
    })?;
    let full = format!("{SETTING_PREFIX}{key}");
    let found = kv_in_scope(&scope, |c, sc| {
        use rusqlite::OptionalExtension;
        c.query_row(
            "SELECT value FROM plugin_data WHERE plugin_id = ?1 AND scope = ?2 AND key = ?3",
            rusqlite::params![pid, sc, full],
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

fn cap_kv_remove(key: &str, scope: &str) -> CapResult {
    if is_reserved_setting_key(key) {
        return Err(format!(
            "permission_denied: {SETTING_PREFIX}* 由宿主界面管理（设置里填的值不该被插件改写）"
        ));
    }
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
        // created_at 一起给：插件判断"这页是不是刚建的"只能靠它（updated_at 会被编辑
        // 刷新）。写「孤立页巡检」「本周新建了哪些」这类插件时撞到的就是这个字段的缺失——
        // 加字段是非破坏性的（读不到就别读），比新加一条能力便宜得多。
        let mut stmt = c
            .prepare(
                "SELECT id, title, created_at, updated_at FROM pages WHERE deleted_at IS NULL
                 ORDER BY updated_at DESC LIMIT ?1",
            )
            .map_err(|e| format!("db_error: {e}"))?;
        let rows = stmt
            .query_map(params![limit], |r| {
                Ok(serde_json::json!({
                    "id": r.get::<_, String>(0)?,
                    "title": r.get::<_, String>(1)?,
                    "created_at": r.get::<_, i64>(2)?,
                    "updated_at": r.get::<_, i64>(3)?,
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

/// 把一条导出请求塞进本次执行（同文件名只留一条，避免插件在循环里刷屏）。
fn push_export(file_name: String, content: String) -> Result<(), String> {
    RUN_STATE.with(|s| {
        let mut st = s.borrow_mut();
        if st.exports.len() >= MAX_EXPORTS_PER_RUN {
            return Err(format!("quota_exceeded: 一次运行最多导出 {MAX_EXPORTS_PER_RUN} 个文件"));
        }
        if st.exports.iter().any(|e| e.file_name == file_name) {
            // 同名只留第一条：用户看到的是"保存 a.md"，多弹几次同样的对话框只会让人困惑
            return Ok(());
        }
        let bytes = content.len();
        st.exports.push(PluginExport { file_name, content, bytes });
        Ok(())
    })
}

/// `files.export`：**不写盘**，只登记一条导出请求。
///
/// 为什么不在这次调用里就写：插件跑在**后台线程**上，而系统保存对话框只能在主线程弹。
/// 更要紧的是**用户必须有机会说不**——所以流程和草稿一样：先收集，命令跑完后由前端
/// 逐个弹保存对话框，点了取消就什么都没写。
fn cap_files_export(file_name: &str, content: &str) -> CapResult {
    let Some(name) = sanitize_export_file_name(file_name) else {
        return Err("bad_args: 文件名不可用（只给文件名，不要路径；也不能是 . / ..）".to_string());
    };
    if content.is_empty() {
        return Err("bad_args: 要导出的内容为空".to_string());
    }
    if content.len() > MAX_EXPORT_BYTES {
        return Err(format!(
            "quota_exceeded: 单个导出文件上限 {} MiB（这次是 {:.1} MiB）",
            MAX_EXPORT_BYTES / (1024 * 1024),
            content.len() as f64 / 1048576.0
        ));
    }
    let bytes = content.len();
    match push_export(name.clone(), content.to_string()) {
        Ok(()) => Ok(serde_json::json!({ "queued": true, "bytes": bytes, "fileName": name })),
        Err(e) => Err(e),
    }
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

fn cap_properties_list() -> CapResult {
    with_read_conn(|c| {
        let mut stmt = c
            .prepare("SELECT id, name, type FROM attr_defs ORDER BY sort_order, name")
            .map_err(|e| format!("db_error: {e}"))?;
        let rows = stmt
            .query_map([], |r| {
                Ok(serde_json::json!({
                    "id": r.get::<_, String>(0)?,
                    "name": r.get::<_, String>(1)?,
                    "type": r.get::<_, String>(2)?,
                }))
            })
            .map_err(|e| format!("db_error: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(serde_json::Value::Array(rows))
    })
}

/// `properties.set`：**不写库**，只产出草稿（改的是既有页面的属性）。
fn cap_properties_set(attr_id: &str, value: &str, page_id: Option<&str>) -> CapResult {
    if attr_id.trim().is_empty() {
        return Err("bad_args: 设置属性需要 attrId".to_string());
    }
    let target = target_page_or_current(page_id)?;
    let summary = format!("给页面 {target} 设置属性 {attr_id} = {value}");
    push_draft(
        format!("set_page_prop:{target}:{attr_id}"),
        summary.clone(),
        serde_json::json!({ "kind": "set_page_prop", "pageId": target, "attrId": attr_id, "value": value }),
    );
    Ok(serde_json::json!({ "drafted": true, "summary": summary }))
}

/// `tags.add`：**不写库**，只产出草稿（标签不存在时由落库那一步新建）。
fn cap_tags_add(name: &str, page_id: Option<&str>) -> CapResult {
    let name = name.trim();
    if name.is_empty() {
        return Err("bad_args: 加标签需要 name".to_string());
    }
    let target = target_page_or_current(page_id)?;
    let summary = format!("给页面 {target} 加标签「{name}」");
    push_draft(
        format!("add_tag:{target}:{name}"),
        summary.clone(),
        serde_json::json!({ "kind": "add_tag", "pageId": target, "name": name }),
    );
    Ok(serde_json::json!({ "drafted": true, "summary": summary }))
}

/// `blocks.list`：列出页面顶级块（id + 文本）。
///
/// Lexical 的 JSON 走查复用 `blocks.rs` 里既有的一套辅助函数，**不在这里手写第二份**。
/// `blocks.list`：列出某页的顶级块。**省略 pageId = 当前打开的页面**——与
/// `blocks.append` / `tags.add` / `backlinks.list` / `files.list` 一致。
///
/// 之前这个能力是唯一一个"必须显式给 id"的读能力，而插件又**拿不到当前页 id**
/// （`page.current` 只给 content_json）：等于"能往当前页写，却读不到当前页"。
/// 写参考插件时撞到的就是这个不对称——大纲 / 改写 / 导出当前页这一整类插件都被卡住。
fn cap_blocks_list(page_id: Option<&str>, limit: i64) -> CapResult {
    let limit = limit.clamp(1, 500) as usize;
    let target = target_page_or_current(page_id)?;
    with_read_conn(|c| {
        let content_json: String = c
            .query_row(
                "SELECT content_json FROM pages WHERE id = ?1 AND deleted_at IS NULL",
                params![target],
                |r| r.get(0),
            )
            .map_err(|_| format!("bad_args: 未找到页面 {target}"))?;
        let v = crate::blocks::parse_json(&content_json).map_err(|e| format!("db_error: {e}"))?;
        let blocks: Vec<serde_json::Value> = crate::blocks::root_children(&v)
            .iter()
            .filter_map(|child| {
                child.get("blockId").and_then(|b| b.as_str()).map(|id| {
                    serde_json::json!({
                        "blockId": id,
                        "text": crate::blocks::node_text(child).trim(),
                    })
                })
            })
            .take(limit)
            .collect();
        Ok(serde_json::Value::Array(blocks))
    })
}

/// `__cap(method, argsJson)` 的实现。**所有**能力调用（含老全局别名）都走这里，
/// 所以权限校验只有一个点，不存在绕过路径。
fn dispatch_capability(method: &str, args_json: &str) -> Result<String, String> {
    // M11.13：装了传输就说明这次运行在**子进程**里——把这一问一答发回父进程，由那边
    // 查库、校验权限、记审计、出草稿。下面这些 arm 只会跑在**父进程**：子进程没有库、
    // 没有密钥、没有路径，它根本走不到这里。
    let rpc = RUN_STATE.with(|s| s.borrow().cap_rpc.clone());
    if let Some(rpc) = rpc {
        return rpc(method, args_json);
    }
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
        "files.export" => cap_files_export(&arg_str("fileName")?, &arg_str("content")?),
        "kv.get" => cap_kv_get(&arg_str("key")?, &scope_arg(&args)),
        "kv.set" => cap_kv_set(&arg_str("key")?, &arg_str("value")?, &scope_arg(&args)),
        "kv.remove" => cap_kv_remove(&arg_str("key")?, &scope_arg(&args)),
        // scope 由 manifest 声明决定（不由插件选）：设置里常有 token/路径这类东西，
        // 声明为 space 才落加密库，声明为 app 才落 meta.db（明文）。
        "settings.get" => cap_settings_get(&arg_str("key")?),
        "blocks.list" => cap_blocks_list(arg_opt_str("pageId").as_deref(), arg_i64("limit", 100)),
        "properties.list" => cap_properties_list(),
        "properties.set" => cap_properties_set(
            &arg_str("attrId")?,
            &arg_str("value")?,
            arg_opt_str("pageId").as_deref(),
        ),
        "tags.add" => cap_tags_add(&arg_str("name")?, arg_opt_str("pageId").as_deref()),
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
pub(crate) fn discover_commands_timed(
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
            setting_scopes: state.setting_scopes.clone(),
            drafts: Vec::new(),
            exports: Vec::new(),
            insert_text: String::new(),
            toasts: Vec::new(),
            cap_rpc: state.cap_rpc.clone(),
        }
    });
    Ok(())
}

/// Execute a single plugin command in a fresh boa context (re-evaluate the
/// plugin, then run the command). Returns the command's result string.
fn run_command(source: &str, command_id: &str, args_json: &str, state: &RunState) -> Result<String, String> {
    let mut ctx = plugin_context(RUN_LOOP_LIMIT);
    set_run_state(&mut ctx, state)?;
    eval_plugin_preamble(&mut ctx)?;
    ctx.eval(Source::from_bytes(source.as_bytes()))
        .map_err(|e| format!("插件初始化失败: {e}"))?;
    // __run('<id>', '<args>') — Rust `{:?}` yields a quoted, escaped JS string literal,
    // 所以参数里的引号/换行不会破坏这次 eval。
    let expr = format!("__run({:?}, {:?})", command_id, args_json);
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
    args_json: &str,
    state: &RunState,
) -> Result<(String, String, Vec<String>, Vec<PluginDraft>, Vec<PluginExport>), String> {
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
        setting_scopes: state.setting_scopes.clone(),
        drafts: Vec::new(),
        exports: Vec::new(),
        insert_text: String::new(),
        toasts: Vec::new(),
        cap_rpc: state.cap_rpc.clone(),
    };
    let args = args_json.to_string();
    with_timeout(RUN_TIMEOUT, "插件执行", move || {
        let msg = run_command(&source, &command_id, &args, &state)?;
        let (insert, toasts, drafts, exports) = RUN_STATE.with(|s| {
            let st = s.borrow();
            (
                st.insert_text.clone(),
                st.toasts.clone(),
                st.drafts.clone(),
                st.exports.clone(),
            )
        });
        Ok((msg, insert, toasts, drafts, exports))
    })
}

/// 用户点「取消」时调用：**终止**那次运行的宿主子进程（D4）。
///
/// 返回是否真的杀到了（运行已经结束或 id 不认识都返回 false，不报错——取消本身是"尽力而为"，
/// 用户点的那一下不该因为他手慢而弹一个错误）。
#[tauri::command]
pub fn cancel_plugin_run(run_id: u64) -> bool {
    let killed = cancel_run(run_id);
    if !killed {
        push_log("host", "info", &format!("取消 run {run_id}：它已经结束了"));
    }
    killed
}

/// 在飞的插件运行：`run id → (killer, 是否被用户取消)`。
///
/// 为什么需要它：**取消 = 终止进程**（D4）。前端在发起调用时就带一个 `runId` 过来，于是用户在
/// 等待期间点「取消」，后端能凭它找到那一刻的宿主子进程并**真的杀掉**——而不是像从前那样
/// 只是不再等它（插件代码还在后台跑完）。
///
/// 只登记**用户发起**的命令运行：事件派发是后台行为，没有"用户点取消"这个动作。
static RUN_KILLERS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<u64, crate::plugin_host::HostKiller>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));
/// 被用户取消的 run id（运行结束时据此把错误说成"已终止"而不是"崩了"）。
static CANCELLED_RUNS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashSet<u64>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashSet::new()));

fn register_run(run_id: u64, killer: crate::plugin_host::HostKiller) {
    let mut m = RUN_KILLERS.lock().unwrap_or_else(|e| e.into_inner());
    m.insert(run_id, killer);
}

fn unregister_run(run_id: u64) -> bool {
    let mut m = RUN_KILLERS.lock().unwrap_or_else(|e| e.into_inner());
    m.remove(&run_id).is_some()
}

/// 用户取消：杀掉那次运行的宿主子进程。返回"是否真的杀到了"（已经跑完就返回 false）。
pub(crate) fn cancel_run(run_id: u64) -> bool {
    let killer = {
        let m = RUN_KILLERS.lock().unwrap_or_else(|e| e.into_inner());
        m.get(&run_id).cloned()
    };
    let Some(killer) = killer else { return false };
    CANCELLED_RUNS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(run_id);
    killer.kill();
    true
}

fn take_cancelled(run_id: u64) -> bool {
    CANCELLED_RUNS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&run_id)
}

/// M11.13 阶段 2b：把一次命令放到**子进程**里跑，能力由**本进程**服务。
///
/// 这是生产路径（`run_plugin_command` 与事件派发都走它）。它做的事：
///   1. 在本线程上装好 `RunState`（能力执行时要从这里读权限、空间、当前页、设置 scope）；
///   2. 起一个宿主子进程，把源码/入参/上下文递过去；
///   3. **同步回答**子进程的每一次能力调用（`dispatch_capability` —— 查库、校验权限、
///      记审计、把草稿/导出收进 RunState）；
///   4. 把两边的产出合起来：草稿与导出在**本进程**产生（能力在这里跑），
///      `insert_text` 与 `__toast` 的提示在**子进程**产生（JS 侧的原生函数）。
///
/// ⚠️ 铁律（方案 §7）：回答能力调用时**绝不能持着数据库锁等子进程**。`dispatch_capability`
/// 内部只在单次查询期间持锁，而它是被同步调用的（子进程此刻正阻塞等这个回答），所以
/// 顺序天然是"子进程问 → 父进程查完就答"——不要在这中间插入等待子进程的代码。
fn run_command_via_host(
    source: &str,
    command_id: &str,
    args_json: &str,
    state: &RunState,
    run_id: Option<u64>,
) -> Result<(String, String, Vec<String>, Vec<PluginDraft>, Vec<PluginExport>), String> {
    let (message, insert, toasts, drafts, exports, _dropped) = run_via_host(
        source,
        command_id,
        args_json,
        state,
        crate::plugin_host::HostRunMode::Command,
        run_id,
    )?;
    Ok((message, insert, toasts, drafts, exports))
}

/// 事件路径的同一条路（阶段 2b 起事件也跑在子进程里）。
///
/// 与命令那条共用全部机制：装 RunState、起子进程、同步回答能力、合并产出。差别只有
/// 子进程里调哪个入口（`run_event_timeout` vs `run_command_timeout`）与错误码前缀。
fn run_event_via_host(
    source: &str,
    event: &str,
    payload_json: &str,
    state: &RunState,
) -> Result<(String, Vec<String>, Vec<PluginDraft>), String> {
    let (message, _insert, toasts, drafts, exports, _dropped) =
        run_via_host(source, event, payload_json, state, crate::plugin_host::HostRunMode::Event, None)?;
    // 事件里没有保存对话框可弹，也没有人在等：真的出现导出请求就**明确丢弃并留痕**
    // （与"事件里的 insert 会被忽略"同一条规矩，见调用点）。
    if !exports.is_empty() {
        push_log(
            &state.plugin_id,
            "warn",
            &format!("事件 {event} 里有 {} 次 api.files.export：事件没有保存对话框，已忽略", exports.len()),
        );
    }
    Ok((message, toasts, drafts))
}

fn run_via_host(
    source: &str,
    what: &str,
    args_json: &str,
    state: &RunState,
    mode: crate::plugin_host::HostRunMode,
    run_id: Option<u64>,
) -> Result<(String, String, Vec<String>, Vec<PluginDraft>, Vec<PluginExport>, usize), String> {
    let timeout = if mode == crate::plugin_host::HostRunMode::Event {
        EVENT_TIMEOUT
    } else {
        RUN_TIMEOUT
    };
    run_via_host_with_timeout(source, what, args_json, state, mode, timeout, run_id)
}

/// 同上，但可以指定墙钟预算（测试用：几百毫秒就能验证"超时 = 杀进程"）。
///
/// **超时语义（M11.13 阶段 3）**：到点就**杀掉宿主子进程**，并把这次调用判为 `timeout`。
/// 在阶段 3 之前这里是"放弃等待"——线程与子进程会继续跑到自然结束（旧行为）。
fn run_via_host_with_timeout(
    source: &str,
    what: &str,
    args_json: &str,
    state: &RunState,
    mode: crate::plugin_host::HostRunMode,
    timeout: std::time::Duration,
    run_id: Option<u64>,
) -> Result<(String, String, Vec<String>, Vec<PluginDraft>, Vec<PluginExport>, usize), String> {
    let req = crate::plugin_host::HostRunRequest {
        plugin_id: state.plugin_id.clone(),
        source: source.to_string(),
        // 命令 id 与事件名是同一件事："跑哪一个"（见 HostRunRequest 的注释）。
        command_id: what.to_string(),
        mode,
        args_json: args_json.to_string(),
        permissions: state.permissions.clone(),
        current_page_id: state.current_page_id.clone(),
        current_page_json: state.current_page_json.clone(),
        page_count: state.page_count,
    };
    let what_label = if mode == crate::plugin_host::HostRunMode::Event { "插件事件" } else { "插件执行" };

    // 子进程在**本线程**起（约 5 ms），句柄留一份给"超时即杀"用，流交给工作线程。
    let mut client = spawn_host_client()?;
    let killer = client.killer();
    if let Some(id) = run_id {
        register_run(id, killer.clone());
    }
    // 峰值内存要在 `client` 被移进工作线程**之前**拿一个共享句柄（运行结束后读它）。
    let peak_rss_handle = client.peak_rss_handle();
    let serve_state = state.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("plugin-host-serve".to_string())
        .spawn(move || {
            // 能力在**这条线程**上执行：上下文装在这里，`with_read_conn` 也在这里惰性开连接。
            install_run_state(&serve_state);
            let served = client.run_with_server(req, |method, args| dispatch_capability(method, args));
            let (drafts, exports, cap_toasts, cap_insert) = take_run_state_outputs();
            let dropped = exports.len();
            clear_run_state();
            // 调用方可能已经超时走人了（那时这条 send 失败，无害）。
            let _ = tx.send((served, drafts, exports, cap_toasts, cap_insert, dropped));
        })
        .map_err(|e| format!("插件宿主线程启动失败：{e}"))?;

    let received = rx.recv_timeout(timeout);
    // 不管哪条路，先把这次运行从"可取消"里摘掉（否则用户还能"取消"一个已经结束的运行）。
    if let Some(id) = run_id {
        unregister_run(id);
    }
    let cancelled_by_user = run_id.is_some_and(take_cancelled);
    // 峰值内存在这里读一次（进程被杀之后读不到了），下面的每条出口都要带上它。
    let peak_rss = peak_rss_handle.bytes();
    let kind = if mode == crate::plugin_host::HostRunMode::Event { "event" } else { "command" };
    let (served, drafts, exports, cap_toasts, cap_insert, dropped) = match received {
        Ok(v) => v,
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            // **超时 = 杀进程**（方案 §3.3）：不再"放弃等待"留一个跑到天荒地老的子进程。
            // 杀掉之后工作线程会因管道断开而自行退出。
            killer.kill();
            let msg = format!("timeout: {what_label}超时（>{:?}），已终止宿主进程", timeout);
            record_run_end(&state.plugin_id, kind, &Err(msg.clone()), peak_rss);
            return Err(msg);
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            killer.kill();
            let msg = format!(
                "plugin_crash: {what_label}的宿主线程异常结束（{}）",
                killer.describe_exit()
            );
            record_run_end(&state.plugin_id, kind, &Err(msg.clone()), peak_rss);
            return Err(msg);
        }
    };

    let res = match served {
        Ok(res) => res,
        // 用户取消 → 说清是**被他终止的**，而不是"插件崩了"（两者都会让通道断开）。
        Err(e) if cancelled_by_user => {
            let msg = format!("cancelled: 已终止插件（用户取消）；底层原因：{e}");
            record_run_end(&state.plugin_id, kind, &Err(msg.clone()), peak_rss);
            return Err(msg);
        }
        Err(e) => {
            record_run_end(&state.plugin_id, kind, &Err(e.clone()), peak_rss);
            return Err(e);
        }
    };
    // 两种插入来源合并：能力那条（父进程）优先，JS 原生那条（子进程）兜底。
    let insert_text = if cap_insert.is_empty() { res.insert_text } else { cap_insert };
    let mut toasts = cap_toasts;
    for t in res.toasts {
        if !toasts.contains(&t) {
            toasts.push(t);
        }
    }
    // 子进程不会产出草稿/导出（它没有能力，只能问），所以这两个字段正常是空的。
    // 这里仍然只认**本进程**收集到的那份：能力的产出全部发生在这一侧。
    let _ = (&res.drafts, &res.exports);
    record_run_end(&state.plugin_id, kind, &Ok(res.message.clone()), peak_rss);
    Ok((res.message, insert_text, toasts, drafts, exports, dropped))
}

/// 一次运行结束时记一条审计。
///
/// 记哪些：**命令**每次都记（用户点一下才跑，量小、也正是他想复盘的东西）；
/// **事件**只在**失败时**记——事件是后台高频行为（每次保存 × 每个订阅插件），
/// 每条都记会把环灌满、把真正想看的能力调用挤掉。
fn record_run_end(
    plugin_id: &str,
    kind: &str,
    outcome: &Result<String, String>,
    peak_rss_bytes: Option<u64>,
) {
    let is_event = kind == "event";
    if is_event && outcome.is_ok() && !plugin_raised(outcome) {
        return;
    }
    let (ok, error_code) = match outcome {
        // 插件**抛错**在宿主这一层是"跑完了、结果是一句话"（shim 把异常转成返回值），
        // 所以这里按前缀认出来——否则审计会把这个插件记成"一切正常"，而那正是最误导的。
        // （更干净的做法是让 shim 回一个结构化标志；那要动 ABI 生成物，等有需要再说。）
        Ok(msg) if plugin_raised(outcome) => {
            let _ = msg;
            (false, Some("plugin_error".to_string()))
        }
        Ok(_) => (true, None),
        Err(e) => (false, Some(classify_run_error(e).0)),
    };
    push_run_audit(plugin_id, kind, ok, error_code, peak_rss_bytes);
}

/// 结果里那句话是不是"插件抛错了"（见 `record_run_end` 的注释）。
fn plugin_raised(outcome: &Result<String, String>) -> bool {
    matches!(outcome, Ok(msg) if msg.starts_with("__plugin: 执行出错") || msg.starts_with("出错："))
}

/// 起宿主子进程。生产用**当前可执行文件**（同二进制 re-exec）。
///
/// 唯一的例外是测试：`cargo test` 里"当前可执行文件"是测试二进制，不是宿主，所以允许
/// 用 `SHUYONOTE_PLUGIN_HOST_EXE` 显式指定（测试专用，应用永远不会设它）。
fn spawn_host_client() -> Result<crate::plugin_host::HostClient, String> {
    match std::env::var("SHUYONOTE_PLUGIN_HOST_EXE") {
        Ok(p) if !p.trim().is_empty() => {
            crate::plugin_host::HostClient::spawn_with_exe(std::path::Path::new(p.trim()))
        }
        _ => crate::plugin_host::HostClient::spawn(),
    }
}

/// 在**当前线程**装上一次运行的上下文（能力执行时要读它）。
fn install_run_state(state: &RunState) {
    RUN_STATE.with(|s| *s.borrow_mut() = state.clone());
    // 能力用的是本线程的连接：换一次运行就换一次上下文，连接要跟着重开。
    READ_CONN.with(|c| *c.borrow_mut() = None);
    META_CONN.with(|c| *c.borrow_mut() = None);
}

/// 取走本线程上收集到的**能力产出**：草稿 / 导出 / 提示 / 插入文本。
///
/// 插入文本有两种来源：`__insert(...)`（JS 侧原生函数，发生在**子进程**）与能力
/// `editor.insertText`（结构化返回里的 `insert` 走它，发生在**父进程**）。两边都要收。
fn take_run_state_outputs() -> (Vec<PluginDraft>, Vec<PluginExport>, Vec<String>, String) {
    RUN_STATE.with(|s| {
        let mut st = s.borrow_mut();
        (
            std::mem::take(&mut st.drafts),
            std::mem::take(&mut st.exports),
            std::mem::take(&mut st.toasts),
            std::mem::take(&mut st.insert_text),
        )
    })
}

/// 清掉本线程的运行上下文（别把一次运行的权限/空间留给下一次）。
fn clear_run_state() {
    RUN_STATE.with(|s| *s.borrow_mut() = RunState::default());
    READ_CONN.with(|c| *c.borrow_mut() = None);
    META_CONN.with(|c| *c.borrow_mut() = None);
}

/// M11.13：在**子进程**里跑一次命令或派发一次事件（`--plugin-host` 时由 `plugin_host` 调用）。
///
/// 权限解析、草稿确认、导出对话框这些仍然只发生在父进程那一侧——子进程是纯解释器，
/// 它没有库、没有密钥、没有路径，所以它**做不到**这些事，也不需要能做。
pub(crate) fn run_in_host_process(
    req: &crate::plugin_host::HostRunRequest,
) -> Result<crate::plugin_host::HostRunResult, (String, String)> {
    let state = RunState {
        plugin_id: req.plugin_id.clone(),
        current_page_json: req.current_page_json.clone(),
        page_count: req.page_count,
        permissions: req.permissions.clone(),
        current_page_id: req.current_page_id.clone(),
        // 子进程里这些一律没有：读哪张表、哪个空间、哪个目录都由父进程决定。
        read_space: None,
        read_dir: None,
        setting_scopes: Default::default(),
        drafts: Vec::new(),
        exports: Vec::new(),
        insert_text: String::new(),
        toasts: Vec::new(),
        // 子进程里的每一次能力调用都要问父进程——这正是这条边界：子进程没有库、没有密钥、
        // 没有路径，它做不了数据访问，只能问。
        cap_rpc: Some(crate::plugin_host::rpc_transport()),
    };
    let outcome = match req.mode {
        crate::plugin_host::HostRunMode::Command => {
            run_command_timeout(&req.source, &req.command_id, &req.args_json, &state)
        }
        crate::plugin_host::HostRunMode::Event => run_event_timeout(&req.source, &req.command_id, &req.args_json, &state)
            .map(|(message, toasts, drafts)| (message, String::new(), toasts, drafts, Vec::new())),
    };
    match outcome {
        Ok((message, insert_text, toasts, drafts, exports)) => Ok(crate::plugin_host::HostRunResult {
            message,
            insert_text,
            toasts,
            // 形状原样透传：草稿/导出的落地规则只在父进程与前端那一侧，这里不做第二套。
            drafts: serde_json::to_value(&drafts).unwrap_or(serde_json::Value::Null),
            exports: serde_json::to_value(&exports).unwrap_or(serde_json::Value::Null),
        }),
        Err(e) => Err(classify_run_error(&e)),
    }
}

/// 把内部错误串分成 `(code, message)`。
///
/// 为什么要 code：前端与日志要能区分"预算超了 / 超时了 / 插件自己抛错"，而现有的错误串
/// 是人话（"插件超出内存预算（64 MiB）"）。这里按**已有串**归类，不新造一套错误文案——
/// 阶段 2 把能力 RPC 挪上来之后，这套归类仍然是唯一的出口。
pub(crate) fn classify_run_error(e: &str) -> (String, String) {
    // 错误码是**作者文档的一部分**（注册表里的 `errorCodes`），所以这里只认那套名字，
    // 不自造第二套（此前这里冒出过 `plugin_budget` / `plugin_timeout`，文档里根本查不到）。
    for code in [
        "unknown_capability",
        "permission_denied",
        "bad_args",
        "space_locked",
        "quota_exceeded",
        "loop_limit",
        "timeout",
        "out_of_memory",
        "plugin_crash",
        "plugin_error",
        // 宿主侧的门（不是能力错误，但作者会看到，保持原样透传）
        "approval_required",
        "cancelled",
    ] {
        if e.starts_with(code) {
            return (code.to_string(), e.to_string());
        }
    }
    let code = if e.contains("超出内存预算") {
        "out_of_memory"
    } else if e.contains("超时") && e.contains("终止") {
        "timeout"
    } else if e.contains("宿主进程异常退出") || e.contains("宿主线程异常结束") {
        "plugin_crash"
    } else if e.contains("超时") {
        "timeout"
    } else if e.contains("loop iteration limit") {
        // Boa 的原文（"RuntimeLimit: Maximum loop iteration limit exceeded"）要归到
        // 注册表里的 `loop_limit`——否则作者按文档找这个码，永远找不到。
        "loop_limit"
    } else {
        "plugin_error"
    };
    (code.to_string(), e.to_string())
}

/// 给同 crate 其它模块的测试用的小工具（不参与生产路径，`cfg(test)` 时不编译）。
#[cfg(test)]
pub(crate) mod tests_support {
    use std::path::PathBuf;

    /// 一个空临时目录（与测试模块里的那个同语义；生产代码永远不调用它）。
    pub(crate) fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "shuyonote-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::create_dir_all(&dir);
        dir
    }
}

// ---------------------------------------------------------------------------
// 插件设置（M11.8）：声明在 manifest，写只发生在宿主界面
// ---------------------------------------------------------------------------

/// 一项设置的当前状态（宿主渲染设置表单用）。
#[derive(Serialize, Clone, Debug)]
pub struct PluginSettingView {
    pub key: String,
    pub label: String,
    #[serde(rename = "type")]
    pub setting_type: String,
    pub description: String,
    pub scope: String,
    pub options: Vec<PluginCommandParamOption>,
    /// 用户设过的值；没设过为 None（表单里显示成空，插件侧 `settings.get` 返回 null）。
    pub value: Option<String>,
    /// manifest 里声明的默认值（表单预填用；插件拿不到它——插件自己写默认值）。
    pub default: Option<serde_json::Value>,
}

/// 读一个插件的设置声明 + 当前值。
#[tauri::command]
pub async fn plugin_settings(app: AppHandle, db: State<'_, Db>, plugin_id: String) -> Result<Vec<PluginSettingView>, String> {
    if !is_safe_plugin_id(&plugin_id) {
        return Err("非法插件 id".to_string());
    }
    let dir = plugins_root(&app)?.join(&plugin_id);
    let manifest = read_manifest(&dir)?;
    let decls = manifest.settings.clone().unwrap_or_default();
    let mut out = Vec::new();
    for d in decls {
        let full = format!("{SETTING_PREFIX}{}", d.key);
        let scope = if d.scope == "app" { "app" } else { "space" };
        let value = {
            let c = conn(&db);
            if scope == "app" {
                // app 级设置落 meta.db（明文）
                let dir = crate::db::app_data_dir_ref();
                match dir {
                    Some(dir) => crate::db::open_meta_conn_at(dir)
                        .ok()
                        .and_then(|mc| {
                            use rusqlite::OptionalExtension;
                            mc.query_row(
                                "SELECT value FROM plugin_data WHERE plugin_id = ?1 AND scope = 'app' AND key = ?2",
                                params![plugin_id, full],
                                |r| r.get::<_, String>(0),
                            )
                            .optional()
                            .ok()
                            .flatten()
                        }),
                    None => None,
                }
            } else {
                // space 级：落当前活动空间的库（随 SQLCipher 加密）
                let active: Option<String> = c
                    .query_row(
                        "SELECT value FROM meta.sync_state WHERE key = ?1",
                        params![crate::db::ACTIVE_KEY],
                        |r| r.get::<_, String>(0),
                    )
                    .ok();
                match active {
                    Some(space) => {
                        use rusqlite::OptionalExtension;
                        crate::db::open_space_conn(&space)
                            .ok()
                            .and_then(|sc| {
                                sc.query_row(
                                    "SELECT value FROM plugin_data WHERE plugin_id = ?1 AND scope = ?2 AND key = ?3",
                                    params![plugin_id, space, full],
                                    |r| r.get::<_, String>(0),
                                )
                                .optional()
                                .ok()
                                .flatten()
                            })
                    }
                    None => None,
                }
            }
        };
        out.push(PluginSettingView {
            key: d.key.clone(),
            label: if d.label.trim().is_empty() { d.key.clone() } else { d.label.clone() },
            setting_type: d.setting_type.clone(),
            description: d.description.clone(),
            scope: scope.to_string(),
            options: d.options.clone(),
            value,
            default: d.default.clone(),
        });
    }
    Ok(out)
}

/// 写入一项设置。**只有这里（宿主界面）能写**——插件侧对 `setting:` 前缀是只读的。
#[tauri::command]
pub async fn set_plugin_setting(
    app: AppHandle,
    db: State<'_, Db>,
    plugin_id: String,
    key: String,
    value: String,
) -> Result<(), String> {
    if !is_safe_plugin_id(&plugin_id) {
        return Err("非法插件 id".to_string());
    }
    let dir = plugins_root(&app)?.join(&plugin_id);
    let manifest = read_manifest(&dir)?;
    let decls = manifest.settings.clone().unwrap_or_default();
    let decl = decls
        .iter()
        .find(|d| d.key == key)
        .ok_or_else(|| format!("manifest 里没有声明设置项 {key}"))?;
    // 类型/候选项在**宿主侧**把关：插件因此可以假设"用户填的一定是声明里那种值"。
    let normalized = validate_setting_value(decl, &value)?;
    if normalized.len() > 8 * 1024 {
        return Err("设置项内容过长（上限 8 KiB）".to_string());
    }
    let full = format!("{SETTING_PREFIX}{key}");
    let now = now_ms();
    if decl.scope == "app" {
        let dir = crate::db::app_data_dir_ref().ok_or_else(|| "db_error: app data dir 未初始化".to_string())?;
        let mc = crate::db::open_meta_conn_at(dir).map_err(|e| format!("db_error: {e}"))?;
        mc.execute(
            "INSERT INTO plugin_data (plugin_id, scope, key, value, updated_at) VALUES (?1, 'app', ?2, ?3, ?4)
             ON CONFLICT(plugin_id, scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![plugin_id, full, normalized, now],
        )
        .map_err(|e| format!("db_error: {e}"))?;
    } else {
        let active: Option<String> = {
            let c = conn(&db);
            c.query_row(
                "SELECT value FROM meta.sync_state WHERE key = ?1",
                params![crate::db::ACTIVE_KEY],
                |r| r.get::<_, String>(0),
            )
            .ok()
        };
        let space = active.ok_or_else(|| "space_unknown: 当前没有活动空间，无法保存空间级设置".to_string())?;
        let sc = crate::db::open_space_conn(&space).map_err(|e| map_open_error(e))?;
        sc.execute(
            "INSERT INTO plugin_data (plugin_id, scope, key, value, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(plugin_id, scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![plugin_id, space, full, normalized, now],
        )
        .map_err(|e| format!("db_error: {e}"))?;
    }
    push_log(&plugin_id, "info", &format!("设置 {key} 已更新"));
    Ok(())
}

// ---------------------------------------------------------------------------
// 事件派发（M11.8）
// ---------------------------------------------------------------------------

/// 事件处理器的墙钟预算。
///
/// 明显短于命令执行（5s）：事件跑在**保存路径**上，用户在等保存落地；
/// 一个后台钩子不该让保存变慢。超时只终结这次派发，并写进插件日志。
const EVENT_TIMEOUT: Duration = Duration::from_secs(2);

/// 事件 payload 的体积上限（它就是页面 id / 标题这类小字段）。
const MAX_EVENT_PAYLOAD_BYTES: usize = 4 * 1024;

fn run_event(source: &str, event: &str, payload_json: &str, state: &RunState) -> Result<String, String> {
    let mut ctx = plugin_context(RUN_LOOP_LIMIT);
    set_run_state(&mut ctx, state)?;
    eval_plugin_preamble(&mut ctx)?;
    ctx.eval(Source::from_bytes(source.as_bytes()))
        .map_err(|e| format!("插件初始化失败: {e}"))?;
    let expr = format!("__emit({:?}, {:?})", event, payload_json);
    let value = ctx
        .eval(Source::from_bytes(expr.as_bytes()))
        .map_err(|e| format!("事件处理失败: {e}"))?;
    if value.is_undefined() || value.is_null() {
        return Ok(String::new());
    }
    let msg = value.to_string(&mut ctx).map_err(|e| e.to_string())?;
    Ok(msg.to_std_string_escaped())
}

/// 带超时的事件执行。返回值里**没有 `insert`**：事件触发时没人在等你插入文本，
/// 凭空出现文字比不支持更糟（见作者文档 §4.6）。
fn run_event_timeout(
    source: &str,
    event: &str,
    payload_json: &str,
    state: &RunState,
) -> Result<(String, Vec<String>, Vec<PluginDraft>), String> {
    let state = RunState {
        plugin_id: state.plugin_id.clone(),
        current_page_json: state.current_page_json.clone(),
        page_count: state.page_count,
        permissions: state.permissions.clone(),
        current_page_id: state.current_page_id.clone(),
        read_space: state.read_space.clone(),
        read_dir: state.read_dir.clone(),
        setting_scopes: state.setting_scopes.clone(),
        drafts: Vec::new(),
        exports: Vec::new(),
        insert_text: String::new(),
        toasts: Vec::new(),
        cap_rpc: state.cap_rpc.clone(),
    };
    let src = source.to_string();
    let ev = event.to_string();
    // 日志文案用同一份拷贝（闭包要求 'static，不能借用入参）
    let ev_for_log = ev.clone();
    let payload = payload_json.to_string();
    with_timeout(EVENT_TIMEOUT, "插件事件", move || {
        let msg = run_event(&src, &ev, &payload, &state)?;
        let (toasts, drafts, dropped_exports) = RUN_STATE.with(|s| {
            let st = s.borrow();
            (st.toasts.clone(), st.drafts.clone(), st.exports.len())
        });
        // 事件里没有保存对话框可弹，也没有人在等：导出请求在这里**明确丢弃并留痕**，
        // 而不是静默消失（与"事件里的 insert 会被忽略"同一条规矩）。
        if dropped_exports > 0 {
            push_log(
                &state.plugin_id,
                "warn",
                &format!("事件 {ev_for_log} 里有 {dropped_exports} 次 api.files.export：事件没有保存对话框，已忽略"),
            );
        }
        Ok((msg, toasts, drafts))
    })
}

/// 一次事件派发给一个插件的结果。
#[derive(Serialize, Clone, Debug)]
pub struct PluginEventOutcome {
    pub plugin_id: String,
    pub plugin_name: String,
    pub message: String,
    pub toasts: Vec<String>,
    /// 事件里产出的草稿：**没有落库**，由前端汇总成一次用户确认。
    pub drafts: Vec<PluginDraft>,
    /// 该插件这次失败的原因（写进插件日志；前端只在有失败时提示一句）。
    pub error: Option<String>,
}

/// 把一个事件派发给所有**启用中且声明订阅了它**的插件。
///
/// 顺序执行、逐个独立上下文（不变式：每次调用新 Context、无常驻）；一个插件失败
/// 不影响其它插件，也不影响主流程（调用方是 fire-and-forget）。
#[tauri::command]
pub async fn emit_plugin_event(
    app: AppHandle,
    db: State<'_, Db>,
    event: String,
    payload_json: Option<String>,
) -> Result<Vec<PluginEventOutcome>, String> {
    if capabilities_gen::event(&event).is_none() {
        return Err(format!("未知事件：{event}"));
    }
    let payload_json = payload_json.unwrap_or_default();
    if payload_json.len() > MAX_EVENT_PAYLOAD_BYTES {
        return Err(format!("事件 payload 过大（上限 {MAX_EVENT_PAYLOAD_BYTES} 字节）"));
    }
    if !payload_json.is_empty() {
        match serde_json::from_str::<serde_json::Value>(&payload_json) {
            Ok(v) if v.is_object() => {}
            Ok(_) => return Err("事件 payload 必须是 JSON 对象".to_string()),
            Err(_) => return Err("事件 payload 不是合法 JSON".to_string()),
        }
    }
    let payload_value: serde_json::Value = if payload_json.is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(&payload_json).unwrap_or_else(|_| serde_json::json!({}))
    };
    // 事件里的「当前页」= payload 里的 pageId（例如保存事件：作者省略 pageId 时
    // 应当作用在刚保存的那一页，而不是别处）。
    let payload_page_id = payload_value
        .get("pageId")
        .and_then(|v| v.as_str())
        .map(str::to_string);

    let root = plugins_root(&app)?;
    // 结果里带插件显示名，前端提示才写得像人话。
    let mut out: Vec<PluginEventOutcome> = Vec::new();
    let mut targets: Vec<(String, String, String, Vec<String>, std::collections::HashMap<String, String>)> = Vec::new();
    let (page_count, current_page_json, read_space, enabled_ids) = {
        let c = conn(&db);
        let page_count: usize = c
            .query_row("SELECT COUNT(*) FROM pages WHERE deleted_at IS NULL", [], |r| {
                r.get::<_, i64>(0)
            })
            .map(|n| n as usize)
            .unwrap_or(0);
        let current_page_json = payload_page_id
            .as_deref()
            .and_then(|id| {
                c.query_row(
                    "SELECT content_json FROM pages WHERE id = ?1 AND deleted_at IS NULL",
                    params![id],
                    |r| r.get::<_, String>(0),
                )
                .ok()
            })
            .unwrap_or_default();
        let read_space = c
            .query_row(
                "SELECT value FROM meta.sync_state WHERE key = ?1",
                params![crate::db::ACTIVE_KEY],
                |r| r.get::<_, String>(0),
            )
            .ok();
        let mut enabled_ids: Vec<String> = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                if let Ok(m) = read_manifest(&path) {
                    if enabled(&c, &m.id) {
                        enabled_ids.push(m.id);
                    }
                }
            }
        }
        (page_count, current_page_json, read_space, enabled_ids)
    };

    for id in enabled_ids {
        let dir = root.join(&id);
        let manifest = match read_manifest(&dir) {
            Ok(m) => m,
            Err(_) => continue, // 坏插件在 list_plugins 里已经暴露，这里不重复打扰
        };
        let (subscribed, warnings) = resolve_events(&manifest);
        for w in &warnings {
            push_log(&id, "warn", w);
        }
        if !subscribed.iter().any(|e| e == &event) {
            continue; // 没声明订阅这个事件：连代码都不跑（这是 manifest 声明的意义）
        }
        // 与命令执行同一条规矩：声明扩张过、还没重新确认的插件**后台也不跑**。
        // 事件恰恰是最需要拦的那种——用户没点任何东西，插件自己在后台动。
        let approval = {
            let c = conn(&db);
            approval_state(&c, &manifest, false)
        };
        if approval.required {
            push_log(
                &id,
                "warn",
                &format!(
                    "声明新增了{}，已暂停运行（事件 {event} 被跳过）；在插件管理里重新确认后才会恢复",
                    describe_drift(&approval)
                ),
            );
            continue;
        }
        match load_plugin_source(&dir, &manifest) {
            Ok(src) => targets.push((
                id,
                manifest.name.clone(),
                src,
                resolve_permissions(&manifest).0,
                setting_scopes_of(&manifest),
            )),
            Err(e) => out.push(PluginEventOutcome {
                plugin_id: id.clone(),
                plugin_name: manifest.name.clone(),
                message: String::new(),
                toasts: Vec::new(),
                drafts: Vec::new(),
                error: Some(e),
            }),
        }
    }

    for (id, name, source, permissions, setting_scopes) in targets {
        let state = RunState {
            plugin_id: id.clone(),
            page_count,
            current_page_json: current_page_json.clone(),
            permissions,
            current_page_id: payload_page_id.clone(),
            read_space: read_space.clone(),
            read_dir: None,
            cap_rpc: None,
            setting_scopes,
            drafts: Vec::new(),
            exports: Vec::new(),
            insert_text: String::new(),
            toasts: Vec::new(),
        };
        match run_event_via_host(&source, &event, &payload_json, &state) {
            Ok((message, toasts, drafts)) => {
                push_log(
                    &id,
                    if drafts.is_empty() { "info" } else { "info" },
                    &format!(
                        "事件 {event}：{}{}",
                        if message.is_empty() { "已处理" } else { message.as_str() },
                        if drafts.is_empty() { String::new() } else { format!("（产出 {} 项待确认改动）", drafts.len()) }
                    ),
                );
                out.push(PluginEventOutcome { plugin_id: id, plugin_name: name, message, toasts, drafts, error: None });
            }
            Err(e) => {
                push_log(&id, "error", &format!("事件 {event} 处理失败：{e}"));
                out.push(PluginEventOutcome {
                    plugin_id: id,
                    plugin_name: name,
                    message: String::new(),
                    toasts: Vec::new(),
                    drafts: Vec::new(),
                    error: Some(e),
                });
            }
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// DB helpers for enabled state
// ---------------------------------------------------------------------------

fn conn<'a>(db: &'a State<'_, Db>) -> MutexGuard<'a, Connection> {
    lock_db(&db.0)
}

/// 同一把锁，但接受裸 `&Db`（异步命令里"锁不跨 await"的写法要用它，测试里也用它）。
fn lock_db(m: &std::sync::Mutex<Connection>) -> MutexGuard<'_, Connection> {
    // 不让 poison 变成"整个插件面板永久打不开"：锁被 poison 说明此前有个
    // 持锁 panic，但连接本身仍可用，取回内层数据继续用即可。
    m.lock().unwrap_or_else(|e| e.into_inner())
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
        let _ = record_install(&c, "demo", "0.2.0", "bundled", true, true, None);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 授权快照（M11.9 收口）：声明扩张必须重新征求同意
// ---------------------------------------------------------------------------

/// 用户在启用那一刻看到并同意的**能力面**（权限 + 事件）快照。
///
/// 为什么需要它：插件是磁盘上的一个目录，更新它的方式就是"把新文件盖进去"。而
/// `resolve_permissions` 每次运行都重读 manifest——于是**声明扩张是静默生效的**：
/// 用户当初在"没有事件、只有一项只读权限"的前提下点了启用，更新后它可能已经在后台
/// 收 `page.saved`、读全部页面。这不是"多给了一项权限"的技术问题，而是**用户同意的
/// 那份东西已经不等于跑起来的那份东西**，而这套体系卖的就是"用户敢装"。
///
/// 快照里存的是**列表而不是哈希**：界面要说得出"这次新增了什么"，哈希只能说"变了"。
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub(crate) struct ApprovalSnapshot {
    /// 当时被授予的权限（排序后）。
    pub permissions: Vec<String>,
    /// 当时订阅到的事件（排序后）。
    pub events: Vec<String>,
    /// 只是给人看的事实（"你同意的是 v1.0.0，现在是 v1.2.0"）。
    #[serde(default)]
    pub version: String,
}

/// 这份声明"现在"的能力面（排序去重，便于比较与展示）。
pub(crate) fn approval_snapshot(manifest: &Manifest) -> ApprovalSnapshot {
    let (mut permissions, _) = resolve_permissions(manifest);
    let (mut events, _) = resolve_events(manifest);
    permissions.sort();
    permissions.dedup();
    events.sort();
    events.dedup();
    ApprovalSnapshot {
        permissions,
        events,
        version: manifest.version.clone(),
    }
}

/// 相对快照**扩张**了什么（两边都空 = 没扩张）。
///
/// 只认"新增"：收敛声明（删掉一项权限/事件）**不需要**重新确认——用户当初同意的是更多
/// 东西，缩减不会让他多承担任何风险，为此打断他一次是纯粹的骚扰。
#[derive(Serialize, Clone, Debug, Default)]
pub struct ApprovalDrift {
    pub added_permissions: Vec<String>,
    pub added_events: Vec<String>,
}

impl ApprovalDrift {
    pub fn is_empty(&self) -> bool {
        self.added_permissions.is_empty() && self.added_events.is_empty()
    }
}

pub(crate) fn approval_drift(snapshot: &ApprovalSnapshot, current: &ApprovalSnapshot) -> ApprovalDrift {
    ApprovalDrift {
        added_permissions: current
            .permissions
            .iter()
            .filter(|p| !snapshot.permissions.contains(p))
            .cloned()
            .collect(),
        added_events: current
            .events
            .iter()
            .filter(|e| !snapshot.events.contains(e))
            .cloned()
            .collect(),
    }
}

/// 读授权快照（没有行 / 没有快照 → `None`，见 `approval_state` 怎么处理"从没记录过"）。
fn read_approval(c: &Connection, id: &str) -> Option<ApprovalSnapshot> {
    let raw: Option<Option<String>> = c
        .query_row(
            "SELECT approved_json FROM meta.plugin_install WHERE plugin_id = ?1",
            params![id],
            |r| r.get::<_, Option<String>>(0),
        )
        .ok();
    raw.flatten()
        .and_then(|t| serde_json::from_str::<ApprovalSnapshot>(&t).ok())
}

/// 写授权快照（用户启用 / 点了「重新确认」时调用）。
///
/// 用 upsert：插件可能根本没有安装行（手动丢进目录的那种，`enabled()` 默认启用），
/// 但"用户同意了什么"必须记下来，否则下一次改动就没人能比对。
fn write_approval(c: &Connection, id: &str, snapshot: &ApprovalSnapshot) -> Result<(), String> {
    let json = serde_json::to_string(snapshot).map_err(|e| e.to_string())?;
    c.execute(
        "INSERT INTO meta.plugin_install (plugin_id, approved_json, installed_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(plugin_id) DO UPDATE SET approved_json = excluded.approved_json",
        params![id, json, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 一个插件当前的授权状态：需要重新确认时，带上**具体新增了什么**。
#[derive(Serialize, Clone, Debug, Default)]
pub struct ApprovalState {
    pub required: bool,
    pub added_permissions: Vec<String>,
    pub added_events: Vec<String>,
    /// 快照里的版本（用户当时同意的那版）；没有快照时为空。
    pub approved_version: String,
}

/// 现在是需要重新确认、还是可以照常跑。
///
/// **从没记录过快照时按"照常"处理并顺手补记一次**（grandfather）：这个机制是随升级进来的，
/// 存量插件的用户从来没有"同意过某个快照"这一事实可查——把老插件一律暂停等于升级后所有
/// 插件集体停摆，那是拿用户当测试。补记之后，**后续**的扩张才受约束。
fn approval_state(c: &Connection, manifest: &Manifest, grandfather: bool) -> ApprovalState {
    let current = approval_snapshot(manifest);
    let Some(saved) = read_approval(c, &manifest.id) else {
        if grandfather {
            let _ = write_approval(c, &manifest.id, &current);
        }
        return ApprovalState::default();
    };
    let drift = approval_drift(&saved, &current);
    ApprovalState {
        required: !drift.is_empty(),
        added_permissions: drift.added_permissions,
        added_events: drift.added_events,
        approved_version: saved.version,
    }
}

/// 给 `PluginMeta` 用的授权状态。
///
/// **只对"启用中"的插件算**（也只在此时补记快照）：
/// - 禁用中的插件根本不跑，没有什么需要用户现在就同意的；
/// - 更要紧的是作者工作流：插件装在那儿、还没启用，作者一边改 manifest 一边点「校验」——
///   如果这时候给他弹"声明变了，需重新确认"，他就得为每次编辑点一遍确认，纯噪音。
///   等他真去点「启用」时，快照按当下的声明记，不会漏掉任何东西。
fn approval_for_meta(db: &State<'_, Db>, manifest: &Manifest, is_enabled: bool) -> ApprovalState {
    if !is_enabled {
        return ApprovalState::default();
    }
    let c = conn(db);
    approval_state(&c, manifest, true)
}

/// 把"新增了什么"写成一句给人看的话（错误提示与插件日志共用，避免两处措辞漂移）。
fn describe_drift(state: &ApprovalState) -> String {
    let mut parts: Vec<String> = Vec::new();
    if !state.added_permissions.is_empty() {
        parts.push(format!("权限 {}", state.added_permissions.join("、")));
    }
    if !state.added_events.is_empty() {
        parts.push(format!("事件 {}", state.added_events.join("、")));
    }
    if parts.is_empty() {
        "内容".to_string()
    } else {
        parts.join(" 与 ")
    }
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

/// 记启停状态。**启用时同时记一份授权快照**——"点启用"就是用户看那份权限清单并同意的时刻。
fn set_enabled(c: &Connection, id: &str, on: bool, snapshot: Option<&ApprovalSnapshot>) -> Result<(), String> {
    c.execute(
        "INSERT INTO meta.plugin_install (plugin_id, enabled, installed_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(plugin_id) DO UPDATE SET enabled = excluded.enabled",
        params![id, if on { 1 } else { 0 }, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    if on {
        if let Some(snap) = snapshot {
            write_approval(c, id, snap)?;
        }
    }
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
    // 最后一个参数是**装完之后磁盘上那份内容**的指纹（`dir_content_hash`），空 = 没记。
    // 记它的理由只有一个：装完之后那份文件有没有被改过。下载时我们验 sha256 与发布者签名，
    // 但装到盘上之后那就是用户自己的目录了——这个指纹让"被改过"在事实清单里看得出来
    // （作者自己改的也会显示成"不一致"，那同样是真的）。
    content_hash: Option<&str>,
) -> Result<(), String> {
    c.execute(
        "INSERT INTO plugin_install (plugin_id, version, enabled, installed_at, source, seeded, content_hash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(plugin_id) DO UPDATE SET
             version = excluded.version,
             source = excluded.source,
             seeded = excluded.seeded,
             content_hash = excluded.content_hash",
        params![
            id,
            version,
            if enabled { 1 } else { 0 },
            now_ms(),
            source,
            if seeded { 1 } else { 0 },
            content_hash.unwrap_or("")
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 一条**事实**（不是结论）。
///
/// 治理这一块刻意只做"把可查证的事摆出来"：不评分、不排好坏、不说"这个插件危险"。
/// 判断留给用户，而用户要做出判断，就得先看到事实——而且事实必须是**看得出来怎么来的**
/// （所以在哪里出现、出现几次都写进 `text` 里）。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PluginFact {
    /// 机器可读的短标识（`uses_eval` / `embedded_blob` …），便于以后按需过滤。
    pub code: String,
    /// 给人看的一句话。
    pub text: String,
}

/// 一个插件的"事实清单"（M11.11b 治理部分里唯一能自动化的那块）。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PluginFacts {
    pub id: String,
    pub version: String,
    /// 安装来源：`local` / `zip` / `index:<域名>` / `bundled`（或空=不知道）。
    pub source: String,
    pub runtime: String,
    pub main_file: String,
    pub main_bytes: u64,
    pub file_count: usize,
    pub total_bytes: u64,
    /// 声明的权限 id（风险与中文标题由前端注册表映射，后端不重复维护一份）。
    pub declared_permissions: Vec<String>,
    /// 走了"旧 manifest 没声明权限"的基线授权（等于全给）。
    pub baseline_permissions: bool,
    /// 订阅的事件（订阅了事件 = 用户没点命令时也会跑代码）。
    pub events: Vec<String>,
    /// 安装时记下的内容指纹（空 = 这一版之前装的，没记）。
    pub installed_hash: String,
    /// 现在磁盘上那份内容的指纹。
    pub current_hash: String,
    /// 装完之后被改动过吗（`None` = 没记过安装时的指纹，无从判断）。
    pub content_changed: Option<bool>,
    /// 静态看得出来的事实（不执行代码）。
    pub facts: Vec<PluginFact>,
}

/// 静态扫描插件源码，只报**看得出来**的事实。
///
/// 边界写在最前面：这只是文本匹配，**不是安全分析**。它不判断好坏，也抓不住真正聪明的
/// 恶意代码（那正是"不评分"的理由——一个假的安全感比没有更糟）。它能做的是：把"这段代码
/// 里有 eval""里面塞了大段编码数据"这类事摆在用户和审阅者眼前。
pub fn scan_plugin_source(source: &str) -> Vec<PluginFact> {
    let mut facts = Vec::new();
    let count = |needle: &str| source.matches(needle).count();

    // 动态代码执行：代码的内容不完全是你能读到的那些。
    let eval_n = count("eval(");
    let fn_n = count("new Function(");
    if eval_n > 0 || fn_n > 0 {
        let mut parts = Vec::new();
        if eval_n > 0 {
            parts.push(format!("eval( ×{eval_n}"));
        }
        if fn_n > 0 {
            parts.push(format!("new Function( ×{fn_n}"));
        }
        facts.push(PluginFact {
            code: "dynamic_code".into(),
            text: format!(
                "会在运行时构造并执行代码（{}）——执行的到底是什么，只有跑起来才知道",
                parts.join("、")
            ),
        });
    }

    // 大段编码数据：常见于内嵌资源，也常见于混淆/打包产物。
    let longest_encoded = source
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '='))
        .filter(|tok| tok.len() >= 512 && tok.chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '='))
        .map(|tok| tok.len())
        .max();
    if let Some(len) = longest_encoded {
        facts.push(PluginFact {
            code: "embedded_blob".into(),
            text: format!("含一段 {len} 字符的连续编码文本（通常是内嵌资源，也可能是打包/混淆后的代码）"),
        });
    }

    // 超长单行：压缩/打包过的代码几乎总是这样。
    if let Some((line_no, len)) = source
        .lines()
        .enumerate()
        .map(|(i, l)| (i + 1, l.chars().count()))
        .max_by_key(|(_, l)| *l)
    {
        if len >= 2000 {
            facts.push(PluginFact {
                code: "long_line".into(),
                text: format!("第 {line_no} 行有 {len} 个字符（压缩或打包后的代码通常长这样）"),
            });
        }
    }

    // 网络访问：这一版**没有任何联网能力**，所以任何「看起来在联网」的写法都值得指出
    // ——它要么是死代码，要么是在等一个还不存在的能力。
    for needle in ["XMLHttpRequest", "fetch(", "WebSocket", "require(\"http", "require('http"] {
        if source.contains(needle) {
            facts.push(PluginFact {
                code: "network_hint".into(),
                text: format!(
                    "出现了 {needle} —— 本版本的插件能力面**没有任何联网能力**，这段代码现在做不了任何网络请求"
                ),
            });
            break;
        }
    }

    facts
}

/// 把"关于这个插件已知的事实"装配成一份清单（纯函数：分离出来才好测）。
pub fn build_plugin_facts(
    runtime: &str,
    main_bytes: u64,
    file_count: usize,
    total_bytes: u64,
    source_text: Option<&str>,
    content_changed: Option<bool>,
    installed_hash: &str,
    current_hash: &str,
) -> Vec<PluginFact> {
    let mut facts = Vec::new();
    // "装完之后被改过吗"对所有插件都成立（零代码插件也一样：它的 manifest 也能被改）。
    // 三种情况分开说，其中"没记过指纹"必须说出来——否则用户会把它读成"没被改过"。
    match content_changed {
        Some(true) => facts.push(PluginFact {
            code: "content_changed".into(),
            text: format!(
                "**内容与安装时不同**：装完之后这个目录被改动过（安装时 {}，现在 {}）——作者自己改的也会是这样，但它确实不是当初装下来的那一份",
                &installed_hash[..8.min(installed_hash.len())],
                &current_hash[..8.min(current_hash.len())]
            ),
        }),
        Some(false) => facts.push(PluginFact {
            code: "content_unchanged".into(),
            text: format!(
                "内容与安装时一致（指纹 {}）",
                &current_hash[..8.min(current_hash.len())]
            ),
        }),
        None => facts.push(PluginFact {
            code: "content_unknown".into(),
            text: "没有安装时的内容指纹可对（这一版之前装的），所以无法判断装完之后有没有被改过".into(),
        }),
    }
    if runtime == "declarative" {
        facts.push(PluginFact {
            code: "no_code".into(),
            text: "零代码插件：没有一行可执行的代码，界面由宿主按声明渲染".into(),
        });
        return facts;
    }
    facts.push(PluginFact {
        code: "entry_size".into(),
        text: format!(
            "入口文件 {} 字节；整个插件目录 {} 个文件、共 {} 字节",
            main_bytes, file_count, total_bytes
        ),
    });
    if let Some(src) = source_text {
        facts.extend(scan_plugin_source(src));
    }
    facts
}

/// 一条**订阅的索引**（多源：自托 / 社区 / 企业内网各一条）。
///
/// 只存订阅关系与上次检查的结果；索引内容永远现场拉——用一份过期的清单做判断
/// （"可更新"、"已撤回"）比不判断更糟。
#[derive(Serialize, Clone, Debug)]
pub struct IndexSubscriptionView {
    pub url: String,
    /// 该索引的签名公钥（空 = 不验签，界面要如实说）。
    pub pubkey: String,
    pub label: String,
    pub added_at: i64,
    pub last_checked_at: Option<i64>,
    /// `Some(true)` 上次拉取成功；`Some(false)` + `last_error` 说明白为什么失败。
    pub last_ok: Option<bool>,
    pub last_error: String,
    /// 上次成功时索引里的插件数，以及其中**比已装的更新**的条数。
    pub plugin_count: i64,
    pub updates_available: i64,
}

/// 数一数"这份索引里有多少条比已装的更新"（纯函数，好测）。
///
/// 与安装时的判定共用 `install_action`：界面说"可更新"、点下去却报"拒绝降级"这种
/// 不一致，比不显示更糟。
pub fn count_updates(index: &plugin_index::PluginIndex, installed: &[(String, String)]) -> usize {
    index
        .plugins
        .iter()
        .filter(|e| {
            installed
                .iter()
                .find(|(id, _)| id == &e.id)
                .is_some_and(|(_, v)| install_action(Some(v), &e.version) == InstallAction::Replace)
        })
        .count()
}

/// 一个插件当前信任的发布者公钥（TOFU 固定下来的那一把）。
#[derive(Serialize, Clone, Debug)]
pub struct PublisherKeyView {
    pub plugin_id: String,
    pub fingerprint: String,
    /// 这把 key 是从哪来的（今天的来源是索引地址的域名）。
    pub source: String,
    pub pinned_at: i64,
}

/// 一次安装里，"发布者公钥"这件事的判断结果。
#[derive(Debug, PartialEq, Eq)]
pub enum PublisherKeyVerdict {
    /// 索引没给签名（阶段 1 的索引）→ 不涉及。
    None,
    /// 第一次见到这把 key：装成功后就把它固定下来。
    FirstPin,
    /// 与固定的那把一致 → 正常。
    Match,
    /// **换了 key**：拒绝，并让用户明确决定（新旧指纹都要摆出来）。
    Changed { pinned_fingerprint: String, incoming_fingerprint: String },
}

/// 索引里的发布者签名这一关：**验签 + TOFU 判定**，返回"装成功后要固定哪把 key"。
///
/// 抽出来是为了可测（这条路上的每一段——真签名、被换过的包、换过的 key——都需要
/// 一个连接和几份字节，不该被整条安装命令的 AppHandle 挡在测试之外）。
fn check_entry_publisher_signature(
    c: &Connection,
    plugin_id: &str,
    entry: &plugin_index::IndexEntry,
    package_bytes: &[u8],
    trust_new_key: bool,
    source: &str,
) -> Result<Option<String>, String> {
    if entry.publisher_key.trim().is_empty() {
        return Ok(None);
    }
    // 被撤回的 key 直接拒（离线记忆也算）：这把 key 签的东西都不作数了，
    // 连"验签通过"都不必给——那不是用户此刻该关心的事。
    if let Some(why) = revoked_key_blocks(c, &entry.publisher_key) {
        return Err(format!("publisher_key_revoked: {why}。不接受这份包"));
    }
    // 验签：包不是那把 key 签的，后面的一切都不必谈。
    plugin_index::verify_package_signature(package_bytes, &entry.signature, &entry.publisher_key)?;
    match publisher_key_verdict(c, plugin_id, &entry.publisher_key)? {
        PublisherKeyVerdict::None | PublisherKeyVerdict::Match => Ok(None),
        // 第一次见到：**装成功之后**才固定（这里只把它交出去）。
        PublisherKeyVerdict::FirstPin => Ok(Some(entry.publisher_key.clone())),
        PublisherKeyVerdict::Changed {
            pinned_fingerprint,
            incoming_fingerprint,
        } => {
            if !trust_new_key {
                return Err(format!(
                    "publisher_key_changed: 插件「{plugin_id}」的发布者公钥变了（原来 {pinned_fingerprint}，现在 {incoming_fingerprint}）。                     这可能是发布者换了密钥，也可能是这份索引被人动过——确认无误后可以点「信任新密钥并安装」"
                ));
            }
            // 用户明确同意换信任对象：把新 key 固定下来（旧的那把就此不再受信）。
            let view = pin_publisher_key(c, plugin_id, &entry.publisher_key, source)?;
            push_log(
                plugin_id,
                "warn",
                &format!(
                    "用户信任了新的发布者公钥：{pinned_fingerprint} → {}",
                    view.fingerprint
                ),
            );
            Ok(None)
        }
    }
}

/// 判断"这次的发布者公钥算不算异常"。
///
/// 这条判断是整个 TOFU 的核心，也是它能买到的东西：**索引被换掉/被改，也换不掉你已经
/// 固定过的那把 key**。索引声明的 key 本身证明不了发布者身份（它来自同一份索引），
/// 所以第一次只能"见到就固定"（并把指纹显示给用户，让他有机会在别处对比），
/// 而第二次开始就有了真正的约束力。
fn publisher_key_verdict(
    c: &Connection,
    plugin_id: &str,
    incoming_key: &str,
) -> Result<PublisherKeyVerdict, String> {
    if incoming_key.trim().is_empty() {
        return Ok(PublisherKeyVerdict::None);
    }
    let incoming_fp = plugin_index::publisher_key_fingerprint(incoming_key)?;
    let pinned = read_publisher_key(c, plugin_id);
    match pinned {
        None => Ok(PublisherKeyVerdict::FirstPin),
        Some(p) if p.fingerprint == incoming_fp => Ok(PublisherKeyVerdict::Match),
        Some(p) => Ok(PublisherKeyVerdict::Changed {
            pinned_fingerprint: p.fingerprint,
            incoming_fingerprint: incoming_fp,
        }),
    }
}

/// 读一个插件固定下来的发布者公钥。
fn read_publisher_key(c: &Connection, id: &str) -> Option<PublisherKeyView> {
    c.query_row(
        "SELECT plugin_id, fingerprint, source, pinned_at FROM plugin_publisher_key WHERE plugin_id = ?1",
        params![id],
        |r| {
            Ok(PublisherKeyView {
                plugin_id: r.get(0)?,
                fingerprint: r.get(1)?,
                source: r.get(2)?,
                pinned_at: r.get(3)?,
            })
        },
    )
    .ok()
}

/// 固定（或改固定）一个插件的发布者公钥。
fn pin_publisher_key(c: &Connection, id: &str, key: &str, source: &str) -> Result<PublisherKeyView, String> {
    let fingerprint = plugin_index::publisher_key_fingerprint(key)?;
    let now = now_ms();
    c.execute(
        "INSERT INTO plugin_publisher_key (plugin_id, key_b64, fingerprint, source, pinned_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(plugin_id) DO UPDATE SET
             key_b64 = excluded.key_b64,
             fingerprint = excluded.fingerprint,
             source = excluded.source,
             pinned_at = excluded.pinned_at",
        params![id, key.trim(), fingerprint, source, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(PublisherKeyView {
        plugin_id: id.to_string(),
        fingerprint,
        source: source.to_string(),
        pinned_at: now,
    })
}

/// 一把被撤回的发布者密钥（`plugin_revoked_key` 一行）的展示形态。
#[derive(Serialize, Clone, Debug)]
pub struct RevokedKeyEntry {
    pub fingerprint: String,
    pub reason: String,
    pub revoked_at: String,
    pub seen_at: i64,
    /// 用户明确说过"我知道，仍然使用"（在那之后不再拦；界面照旧显示）。
    pub ignored: bool,
}

/// 把一份索引里"被撤回的发布者密钥"记进离线列表（与版本撤回同一套语义）。
fn record_revoked_keys(
    c: &Connection,
    index: &plugin_index::PluginIndex,
) -> Result<usize, String> {
    let now = now_ms();
    let mut n = 0usize;
    for rk in &index.revoked_keys {
        let fp = plugin_index::publisher_key_fingerprint(&rk.key)?;
        let changed = c
            .execute(
                "INSERT INTO plugin_revoked_key (fingerprint, key_b64, reason, revoked_at, seen_at, ignored_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL)
                 ON CONFLICT(fingerprint) DO UPDATE SET
                     key_b64 = excluded.key_b64,
                     reason = excluded.reason,
                     revoked_at = excluded.revoked_at,
                     seen_at = excluded.seen_at",
                params![
                    fp,
                    rk.key.trim(),
                    rk.reason,
                    rk.revoked_at.clone().unwrap_or_default(),
                    now
                ],
            )
            .map_err(|e| e.to_string())?;
        n += changed;
    }
    Ok(n)
}

/// 读一把被撤回的 key（按指纹）。
fn read_revoked_key(c: &Connection, fingerprint: &str) -> Option<RevokedKeyEntry> {
    c.query_row(
        "SELECT fingerprint, reason, revoked_at, seen_at, ignored_at
         FROM plugin_revoked_key WHERE fingerprint = ?1",
        params![fingerprint],
        |r| {
            Ok(RevokedKeyEntry {
                fingerprint: r.get(0)?,
                reason: r.get(1)?,
                revoked_at: r.get(2)?,
                seen_at: r.get(3)?,
                ignored: r.get::<_, Option<i64>>(4)?.is_some(),
            })
        },
    )
    .ok()
}

fn all_revoked_keys(c: &Connection) -> Vec<RevokedKeyEntry> {
    let mut stmt = match c.prepare(
        "SELECT fingerprint, reason, revoked_at, seen_at, ignored_at
         FROM plugin_revoked_key ORDER BY seen_at DESC",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map([], |r| {
        Ok(RevokedKeyEntry {
            fingerprint: r.get(0)?,
            reason: r.get(1)?,
            revoked_at: r.get(2)?,
            seen_at: r.get(3)?,
            ignored: r.get::<_, Option<i64>>(4)?.is_some(),
        })
    });
    match rows {
        Ok(it) => it.filter_map(|r| r.ok()).collect(),
        Err(_) => Vec::new(),
    }
}

/// **这把 key 是不是被撤回且用户没有忽略**。是 → 返回给人看的原因。
///
/// 撤回一把 key 比撤回一个版本更重：它说的是"这把 key 签的东西都不作数了"。
/// 但语义上仍然一致——用户明确表态过就不再拦，索引拥有者不是用户的上司。
fn revoked_key_blocks(c: &Connection, key: &str) -> Option<String> {
    let fp = plugin_index::publisher_key_fingerprint(key).ok()?;
    let r = read_revoked_key(c, &fp)?;
    if r.ignored {
        return None;
    }
    Some(if r.reason.trim().is_empty() {
        format!("指纹 {fp} 的发布者密钥已被索引撤回（索引没有写原因）")
    } else {
        format!("指纹 {fp} 的发布者密钥已被索引撤回：{}", r.reason)
    })
}

/// 一条撤回记忆（`plugin_revocation` 一行）的展示形态。
#[derive(Serialize, Clone, Debug)]
pub struct RevocationView {
    pub plugin_id: String,
    pub version: String,
    pub reason: String,
    pub revoked_at: String,
    pub seen_at: i64,
    /// 用户明确说过"我知道，继续用"（在那之后不再拦运行/安装，但界面照旧显示）。
    pub ignored: bool,
}

/// 把一份索引里"被撤回"的条目记进离线撤回列表。
///
/// 为什么必须落库：撤回的意义在于"**别再用这个版本**"，而用户可能再也不会重新拉这份索引
/// （或者索引整个下线）。只在拉索引的那一刻显示一次"已撤回"，等于把安全性寄托在"用户正好
/// 看到过"上。这里记下来之后，运行与安装两条路都会拦，且拦得住离线。
///
/// 只记 id/版本/原因这三种元数据。用户已经点过「仍然使用」时：
/// **同一个版本**再看到一次就保住他的表态（刷新索引不该复活它），
/// 而**换了版本**的撤回是一条新事实，要重新问他——否则一句「我知道」会顺着插件 id
/// 无限延长到将来所有版本上，正好是撤回最该起作用的时候。
fn record_revocations(c: &Connection, index: &plugin_index::PluginIndex) -> Result<usize, String> {
    let now = now_ms();
    let mut n = 0usize;
    for e in index.plugins.iter().filter(|p| p.revoked_at.is_some()) {
        let changed = c
            .execute(
                "INSERT INTO plugin_revocation (plugin_id, version, reason, revoked_at, seen_at, ignored_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL)
                 ON CONFLICT(plugin_id) DO UPDATE SET
                     version = excluded.version,
                     reason = excluded.reason,
                     revoked_at = excluded.revoked_at,
                     seen_at = excluded.seen_at,
                     -- 同一个版本的撤回，用户表达过的意思要保住（刷新索引不该复活它）；
                     -- 换成**另一个版本**的撤回则是新事实，得重新问他一次——否则一句
                     -- 「我知道」会顺着插件 id 无限延长到将来所有版本上。
                     ignored_at = CASE
                         WHEN plugin_revocation.version = excluded.version
                         THEN plugin_revocation.ignored_at
                         ELSE NULL
                     END",
                params![
                    e.id,
                    e.version,
                    e.revoked_reason,
                    e.revoked_at.clone().unwrap_or_default(),
                    now
                ],
            )
            .map_err(|e| e.to_string())?;
        n += changed;
    }
    Ok(n)
}

/// **运行前的三道闸门**（全部在后端强制，不靠前端从命令面板里过滤——IPC 直调绕不过）。
///
/// 顺序即优先级：先看用户自己的开关，再看"他同意过的那份能力"，最后看索引的撤回记忆。
/// 抽成一个函数是为了**可测**：这三条各自都对应一次真实的事故类型（禁用插件照样被跑、
/// 插件被换成更大声明后静默拿到新权限、有问题的版本撤回后照跑），而它们的判定只需要
/// 一个连接和一个 manifest——不必把整个命令（要 AppHandle）搬进测试。
fn run_gates(c: &Connection, manifest: &Manifest) -> Result<(), String> {
    let id = &manifest.id;
    // 「禁用」：否则被禁用的插件仍然可以被 IPC 直接调用执行。
    if !enabled(c, id) {
        return Err(format!("插件「{id}」已被禁用"));
    }
    // 声明扩张（新增权限/事件）：插件文件被换成更大声明的版本之后，在用户重新确认之前它不跑
    // ——否则"用户同意的那份能力"就被静默改写了。这里 **不** grandfather（不补记快照）：
    // 存量插件由 list_plugins 补记，而这里出现"没有快照"只可能是 IPC 直调，不该顺手授予。
    let approval = approval_state(c, manifest, false);
    if approval.required {
        return Err(format!(
            "approval_required: 插件「{id}」的声明新增了{}，运行已暂停——请在插件管理里重新确认",
            describe_drift(&approval)
        ));
    }
    // 撤回记忆（离线撤回列表）：索引说过这个版本不该再用，那就别跑——**离线也拦得住**。
    // 用户明确选择过「仍然使用」就不再拦（记忆里带着 ignored 标记）。
    if let Some(why) = revocation_blocks(c, id, &manifest.version) {
        return Err(format!(
            "plugin_revoked: 插件「{id}」v{} {why}。你可以在插件管理里选择「仍然使用」，或者卸载它",
            manifest.version
        ));
    }
    // 发布者密钥被撤回：这个插件当初就是那把 key 签的 → 它签的东西都不作数了。
    if let Some(pinned) = read_publisher_key(c, id) {
        if let Some(why) = pinned_key_revoked(c, &pinned) {
            return Err(format!(
                "publisher_key_revoked: 插件「{id}」的{why}。你可以在插件管理里选择「仍然使用」，或者卸载它"
            ));
        }
    }
    Ok(())
}

/// 已固定的那把发布者 key 有没有被撤回。**用记忆里的 key 原文重算指纹**，
/// 因为撤回记录按指纹索引，而固定记录里存的也是原文（两处必须按同一口径比）。
fn pinned_key_revoked(c: &Connection, pinned: &PublisherKeyView) -> Option<String> {
    match read_revoked_key(c, &pinned.fingerprint) {
        Some(r) if !r.ignored => Some(if r.reason.trim().is_empty() {
            "发布者密钥已被索引撤回（索引没有写原因）".to_string()
        } else {
            format!("发布者密钥已被索引撤回：{}", r.reason)
        }),
        _ => None,
    }
}

/// 读一条撤回记忆。
fn read_revocation(c: &Connection, id: &str) -> Option<RevocationView> {
    c.query_row(
        "SELECT plugin_id, version, reason, revoked_at, seen_at, ignored_at
         FROM plugin_revocation WHERE plugin_id = ?1",
        params![id],
        |r| {
            Ok(RevocationView {
                plugin_id: r.get(0)?,
                version: r.get(1)?,
                reason: r.get(2)?,
                revoked_at: r.get(3)?,
                seen_at: r.get(4)?,
                ignored: r.get::<_, Option<i64>>(5)?.is_some(),
            })
        },
    )
    .ok()
}

/// 全部撤回记忆（界面要能一次列出来，不只是"被撤的那个插件旁边一行"）。
fn all_revocations(c: &Connection) -> Vec<RevocationView> {
    let mut stmt = match c.prepare(
        "SELECT plugin_id, version, reason, revoked_at, seen_at, ignored_at
         FROM plugin_revocation ORDER BY seen_at DESC",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map([], |r| {
        Ok(RevocationView {
            plugin_id: r.get(0)?,
            version: r.get(1)?,
            reason: r.get(2)?,
            revoked_at: r.get(3)?,
            seen_at: r.get(4)?,
            ignored: r.get::<_, Option<i64>>(5)?.is_some(),
        })
    });
    match rows {
        Ok(it) => it.filter_map(|r| r.ok()).collect(),
        Err(_) => Vec::new(),
    }
}

/// **撤回是否拦住这个版本**。
///
/// 判定只看两件事：这条记忆记的是不是**同一个版本**，以及用户有没有选择忽略。
/// 索引后来发布了修好的新版本时，记忆里仍是旧版本号 → 新版本不受影响（这是刻意的：
/// 撤回撤的是那个有问题的版本，不是这个插件）。
///
/// 用户选过「仍然使用」就不再拦——索引拥有者不是用户的上司，这一层的作用是
/// **让他知道并明确表态**，而不是替他把插件关掉。
fn revocation_blocks(c: &Connection, id: &str, version: &str) -> Option<String> {
    let r = read_revocation(c, id)?;
    if r.ignored || r.version != version {
        return None;
    }
    let why = if r.reason.trim().is_empty() {
        "索引没有写原因".to_string()
    } else {
        r.reason.clone()
    };
    Some(format!("已被你订阅的索引撤回：{why}"))
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
        let runtime = runtime_of(&manifest).to_string();
        let is_enabled = enabled_map.get(&manifest.id).copied().unwrap_or(false);
        // 撤回记忆：只在**记的就是这个版本**时才算数（索引后来发的修好的版本不该被牵连）。
        // 发布者公钥一起读出来（界面要显示指纹）。
        let (revoked, publisher_key, publisher_key_revoked) = {
            let c = conn(&db);
            let pinned = read_publisher_key(&c, &manifest.id);
            let key_revoked = pinned.as_ref().and_then(|p| read_revoked_key(&c, &p.fingerprint));
            (
                read_revocation(&c, &manifest.id).filter(|r| r.version == manifest.version),
                pinned,
                key_revoked,
            )
        };
        // 声明式插件没有代码：不读入口、不跑 Boa（这正是它安全的原因——没有可执行的东西）。
        if runtime == "declarative" {
            // 声明式插件**没有代码**，所以它不可能调用能力、也收不到事件：
            // 这里必须给空集合，否则界面会显示「需要 11 项基线权限」这种假信息
            // （那是给「有代码但没声明权限」的老插件用的兜底）。
            if manifest.permissions.is_some() {
                push_log(&manifest.id, "warn", "声明式插件没有代码，manifest.permissions 不会被用到");
            }
            if manifest.events.is_some() {
                push_log(&manifest.id, "warn", "声明式插件没有代码，manifest.events 收不到任何事件");
            }
            let permissions = Vec::new();
            let permissions_baseline = false;
            let events = Vec::new();
            // 主题是纯数据，声明式插件同样可以出主题（它没有代码，这正是最安全的一类）
            let theme = sanitized_theme(&manifest);
            let views = manifest.views.clone().unwrap_or_default();
            let pid = manifest.id.clone();
            let approval = approval_for_meta(&db, &manifest, is_enabled);
            if approval.required {
                push_log(
                    &pid,
                    "warn",
                    "插件声明新增了权限/事件，已暂停运行；在插件管理里重新确认后才会恢复",
                );
            }
            out.push(PluginMeta {
                id: pid.clone(),
                name: manifest.name,
                version: manifest.version,
                description: manifest.description,
                enabled: is_enabled,
                commands: Vec::new(),
                permissions,
                permissions_baseline,
                events,
                runtime,
                views,
                // 零代码插件没有命令可调，触发声明接不了任何东西（sanitized_triggers 里
                // 也按这条规则返回空）——这里写死空集合，界面就不会出现点不动的入口。
                triggers: Vec::new(),
                theme,
                approval,
                replaced_version: None,
                revoked,
                publisher_key,
                publisher_key_revoked,
            });
            continue;
        }
        let source = match load_plugin_source(&path, &manifest) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let (permissions, warnings) = resolve_permissions(&manifest);
        for w in &warnings {
            push_log(&manifest.id, "warn", w);
        }
        let (_subscribed, event_warnings) = resolve_events(&manifest);
        for w in &event_warnings {
            push_log(&manifest.id, "warn", w);
        }
        let is_enabled = enabled_map.get(&manifest.id).copied().unwrap_or(false);
        let commands =
            discover_commands_timed(&manifest.id, &permissions, &source, DISCOVER_TIMEOUT)
                .unwrap_or_default();
        let pid = manifest.id.clone();
        let (permissions, permissions_baseline) = permission_metas(&manifest);
        let events = event_metas(&manifest);
        let theme = sanitized_theme(&manifest);
        let triggers = sanitized_triggers(&manifest);
        let approval = approval_for_meta(&db, &manifest, is_enabled);
        if approval.required {
            push_log(
                &pid,
                "warn",
                "插件声明新增了权限/事件，已暂停运行；在插件管理里重新确认后才会恢复",
            );
        }
        out.push(PluginMeta {
            id: pid.clone(),
            name: manifest.name,
            version: manifest.version,
            description: manifest.description,
            enabled: is_enabled,
            commands,
            permissions,
            permissions_baseline,
            events,
            runtime,
            views: manifest.views.clone().unwrap_or_default(),
            triggers,
            theme,
            approval,
            replaced_version: None,
            revoked,
            publisher_key,
            publisher_key_revoked,
        });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

#[tauri::command]
pub fn set_plugin_enabled(app: AppHandle, db: State<Db>, id: String, enabled: bool) -> Result<(), String> {
    if !is_safe_plugin_id(&id) {
        return Err("非法插件 id".to_string());
    }
    // 启用 = 用户看着那份权限清单点下去的：这一刻把"他同意了什么"记成快照。
    // 禁用只需改开关，不必读 manifest（插件目录可能已经被删了）。
    let snapshot = if enabled {
        let dir = plugins_root(&app)?.join(&id);
        read_manifest(&dir).ok().map(|m| approval_snapshot(&m))
    } else {
        None
    };
    let c = conn(&db);
    set_enabled(&c, &id, enabled, snapshot.as_ref())
}

/// 「重新确认」：把插件**现在**的声明记成用户已经同意的那一份。
///
/// 这是插件新增权限/事件之后唯一的放行方式（见 `approval_state`）——不是让用户去点一次
/// 无关的开关，而是一个明确的动作：他看了新增的那几项再确认。
#[tauri::command]
pub fn approve_plugin(app: AppHandle, db: State<'_, Db>, id: String) -> Result<ApprovalState, String> {
    if !is_safe_plugin_id(&id) {
        return Err("非法插件 id".to_string());
    }
    let dir = plugins_root(&app)?.join(&id);
    let manifest = read_manifest(&dir)?;
    let snapshot = approval_snapshot(&manifest);
    {
        let c = conn(&db);
        write_approval(&c, &id, &snapshot)?;
    }
    push_log(&id, "info", "已重新确认插件声明（授权快照已更新）");
    Ok(ApprovalState::default())
}

#[tauri::command]
pub async fn run_plugin_command(
    app: AppHandle,
    db: State<'_, Db>,
    plugin_id: String,
    command_id: String,
    current_id: Option<String>,
    args_json: Option<String>,
    run_id: Option<u64>,
) -> Result<PluginRunResult, String> {
    if !is_safe_plugin_id(&plugin_id) {
        return Err("非法插件 id".to_string());
    }
    // 参数是这次调用的入参：限个体积，别让它变成数据传输通道。
    // 上限的语义见 MAX_ARGS_BYTES 的注释（导入触发要靠它装下**一个文件**的内容）。
    // 这里**不做**第二套 schema 校验：参数只会流进插件自己的 JS，真正碰数据的是
    // `api.*`（宿主逐次校验权限与参数），所以校验留在表单侧（作者自己声明的 schema）
    // 与能力侧即可，多一套实现只会多一处漂移。
    let args_json = args_json.unwrap_or_default();
    if args_json.len() > MAX_ARGS_BYTES {
        return Err(format!(
            "命令参数过大（上限 {} MiB）",
            MAX_ARGS_BYTES / (1024 * 1024)
        ));
    }
    if !args_json.is_empty() {
        match serde_json::from_str::<serde_json::Value>(&args_json) {
            Ok(v) if v.is_object() => {}
            Ok(_) => return Err("命令参数必须是 JSON 对象（如 {\"title\":\"…\"}）".to_string()),
            Err(_) => return Err("命令参数不是合法 JSON".to_string()),
        }
    }
    let root = plugins_root(&app)?;
    let dir = root.join(&plugin_id);
    let manifest = read_manifest(&dir)?;
    let source = load_plugin_source(&dir, &manifest)?;
    // 读 DB 的数据在锁内取出，之后立即释放锁（drop c），再把 JS 执行放到
    // 独立线程 + 超时 —— 避免一个死循环插件无限占住全局 DB 锁（全应用雪崩）。
    let (page_count, current_page_json) = {
        let c = conn(&db);
        run_gates(&c, &manifest)?;
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
        cap_rpc: None,
        setting_scopes: setting_scopes_of(&manifest),
        drafts: Vec::new(),
        exports: Vec::new(),
        insert_text: String::new(),
        toasts: Vec::new(),
    };
    let (message, insert, toasts, drafts, exports) =
        run_command_via_host(&source, &command_id, &args_json, &state, run_id)?;
    Ok(PluginRunResult {
        message: if message.is_empty() { "已执行".to_string() } else { message },
        insert: if insert.is_empty() { None } else { Some(insert) },
        toasts,
        drafts,
        // 导出请求**还没写盘**：前端拿到后逐个弹保存对话框（用户选位置才算数）
        exports,
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
    if src.is_dir() {
        return install_from_dir(&plugins_root(&app)?, &conn(&db), &src, "local");
    }
    if src.is_file() {
        // `.zip` 插件包：解到临时目录，再走**同一条**目录安装路径（校验全部在写盘之前完成）。
        if !source_path.to_ascii_lowercase().ends_with(".zip") {
            return Err("只支持 .zip 插件包，或一个插件目录".to_string());
        }
        let bytes = std::fs::read(&src).map_err(|e| format!("读取插件包失败：{e}"))?;
        if bytes.len() as u64 > plugin_index::MAX_PACKAGE_BYTES {
            return Err(format!(
                "插件包超过上限 {} MiB",
                plugin_index::MAX_PACKAGE_BYTES / (1024 * 1024)
            ));
        }
        return install_from_zip_bytes(&app, &db, &bytes, "zip");
    }
    Err("插件源不存在（要么是插件目录，要么是 .zip 包）".to_string())
}

/// 解压 → 安装（临时目录一定清理）。zip 与索引两条来源共用。
fn install_from_zip_bytes(
    app: &AppHandle,
    db: &State<Db>,
    bytes: &[u8],
    source_kind: &str,
) -> Result<PluginMeta, String> {
    install_bytes_into(&plugins_root(app)?, &conn(db), bytes, source_kind)
}

/// 与 `install_from_zip_bytes` 同一条路，但**不依赖 AppHandle**：插件根目录与数据库连接
/// 由调用方给。这样整条链（索引条目 → sha256 → 签名 → 解包 → manifest 校验 → 落盘 → 记账）
/// 都能在测试里跑完，而不是"除了最后一层胶水都有测试"。
fn install_bytes_into(
    root: &Path,
    c: &Connection,
    bytes: &[u8],
    source_kind: &str,
) -> Result<PluginMeta, String> {
    let dir = plugin_index::package_temp_dir();
    let result = (|| {
        plugin_index::extract_package(bytes, &dir)?;
        // `zip -r pkg.zip my-plugin/` 会在包里多一层目录，这里自动下钻；
        // 其它情况按原样交给 install_from_dir（它会报"读不到 manifest.json"）。
        let pkg_root = plugin_index::resolve_package_root(&dir);
        install_from_dir(root, c, &pkg_root, source_kind)
    })();
    let _ = std::fs::remove_dir_all(&dir);
    result
}

/// 同名（同 id）目录里已经装着一个时，这一次安装算什么。
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(crate) enum InstallAction {
    /// 没装过。
    Fresh,
    /// 装过别的版本 → 整体替换（升级 / 降级式替换由版本比较决定，见下）。
    Replace,
    /// 装的就是这个版本 → 覆盖一遍（"重装修好它"）。
    Same,
    /// 已装的版本**明确更新** → 拒绝。
    Downgrade,
}

/// 装之前先判断"这一次算什么"。
///
/// 版本比不出来（作者写的不是 `x.y.z`）时**不拒绝**：那种情况下"谁更新"本来就无从判断，
/// 而用户已经明确选了这份包（自己挑的 zip，或来自他订阅的索引）。唯一硬拒的是**能证明的
/// 降级**——装一个更旧的版本几乎总是误操作，而代价是"功能悄悄退回去"，事后极难发现。
/// 同版本允许覆盖：那正是"重装一遍，把它修回来"。
///
/// 比较口径与索引里的兼容性判定共用 `plugin_index::parse_version`，避免两处各有一套。
pub(crate) fn install_action(installed: Option<&str>, incoming: &str) -> InstallAction {
    let Some(installed) = installed else {
        return InstallAction::Fresh;
    };
    if installed == incoming {
        return InstallAction::Same;
    }
    match (
        plugin_index::parse_version(installed),
        plugin_index::parse_version(incoming),
    ) {
        (Some(a), Some(b)) if b < a => InstallAction::Downgrade,
        _ => InstallAction::Replace,
    }
}

/// 用 `src` 的内容**整体替换** `dest`（升级 / 重装）。
///
/// 替换是「先备份、再动手、出事回滚」：这是这个函数存在的全部理由——插件目录被清空到一半
/// 就失败，会留下一个占着 id 的半残目录，用户连重装都做不到（早先 `install_plugin`
/// 踩过这个坑，当时的修法是"先校验后写盘"，但那挡不住"写盘中途失败"）。
///
/// 备份放在系统临时目录，**不放在插件目录里**：插件目录会被扫描，多出来的备份目录里同样有
/// `manifest.json`，会被当成"第二个同名插件"。跨卷也没关系——这里用的是拷贝不是改名。
fn replace_plugin_dir(src: &Path, dest: &Path, manifest: &Manifest) -> Result<(), String> {
    let backup = plugin_index::package_temp_dir();
    copy_dir(dest, &backup).map_err(|e| format!("备份已装版本失败（还没动过任何东西）：{e}"))?;
    let rollback = |why: String| -> String {
        let _ = std::fs::remove_dir_all(dest);
        match copy_dir(&backup, dest) {
            Ok(()) => {
                let _ = std::fs::remove_dir_all(&backup);
                format!("{why}（已回滚到原来那一版）")
            }
            // 回滚也失败时**不删备份**：那是用户唯一还能拿回旧版本的地方，把路径告诉他。
            Err(e) => format!(
                "{why}；回滚也失败了：{e}（原版本还在 {}，可手工拷回）",
                backup.display()
            ),
        }
    };
    if let Err(e) = std::fs::remove_dir_all(dest) {
        return Err(rollback(format!("清空旧版本失败：{e}")));
    }
    if let Err(e) = copy_dir(src, dest) {
        return Err(rollback(format!("写入新版本失败：{e}")));
    }
    if let Err(e) = load_plugin_source(dest, manifest) {
        return Err(rollback(format!("新版本的入口文件加载失败：{e}")));
    }
    let _ = std::fs::remove_dir_all(&backup);
    Ok(())
}

/// 安装一个**已经在磁盘上**的插件目录。
///
/// 顺序是刻意的：先把所有前置条件验完（含**入口文件真的能被加载**），再往盘上写。
/// 此前是「先 copy_dir 再 load_plugin_source」：一旦入口文件有问题，
/// 已经拷过去的目录会留下并占住这个 id，用户连重装都做不到。
/// 同 id 已装时不再一律拒绝（那条路让"升级"无路可走），而是按 `install_action` 判定：
/// 升级/重装整体替换并且**可回滚**，明确降级拒掉。
fn install_from_dir(
    root: &Path,
    c: &Connection,
    src: &Path,
    source_kind: &str,
) -> Result<PluginMeta, String> {
    if !src.is_dir() {
        return Err("插件源目录不存在".to_string());
    }
    let manifest = read_manifest(src)?;
    if !is_safe_plugin_id(&manifest.id) {
        return Err("非法插件 id（manifest.id）".to_string());
    }
    // 撤回记忆同样拦安装：装一个有问题的版本（哪怕是从别处拿到的同一份包）没有意义。
    // 只拦**同一个版本**；索引后来发的修好的新版本不受影响。
    if let Some(why) = revocation_blocks(c, &manifest.id, &manifest.version) {
        return Err(format!(
            "不能安装「{}」v{}：{why}。确实要装，请先在插件管理里对它选择「仍然使用」",
            manifest.id, manifest.version
        ));
    }
    let source = load_plugin_source(src, &manifest)?;
    // 顶层就死循环的插件不该被装进来：用带超时的 discovery 先跑一遍。
    // 权限警告先记下来，装完在插件日志里就能看到（例如"没写 permissions，走基线授权"）。
    let (permissions, warnings) = resolve_permissions(&manifest);
    for w in &warnings {
        push_log(&manifest.id, "warn", w);
    }
    let commands = discover_commands_timed(&manifest.id, &permissions, &source, DISCOVER_TIMEOUT)?;

    let dest = root.join(&manifest.id);
    // "现在装着哪个版本"以**磁盘上的 manifest** 为准：手工拷进去的插件目录没有 DB 行，
    // 而它恰恰是用户看得见、跑得起来的那个。
    let installed = if dest.is_dir() {
        read_manifest(&dest).ok().map(|m| m.version)
    } else {
        None
    };
    let action = install_action(installed.as_deref(), &manifest.version);
    if action == InstallAction::Downgrade {
        return Err(format!(
            "已装的版本更新（{} → {}）：拒绝安装更旧的版本。确实要降级，请先卸载再装",
            installed.as_deref().unwrap_or("未知"),
            manifest.version
        ));
    }
    let replaced = match action {
        InstallAction::Fresh => {
            copy_dir(src, &dest)?;
            None
        }
        // 升级 / 重装：整体替换（内部自带备份与回滚）。
        _ => {
            replace_plugin_dir(src, &dest, &manifest)?;
            installed.clone()
        }
    };
    // 新装这条路上再确认一次入口文件真的落到盘上；失败就把这次装的东西清掉，别留垃圾。
    // （替换那条路由 `replace_plugin_dir` 自己验并回滚，这里不必重来一遍。）
    if replaced.is_none() {
        if let Err(e) = load_plugin_source(&dest, &manifest) {
            let _ = std::fs::remove_dir_all(&dest);
            return Err(format!("安装失败（已回滚）：{e}"));
        }
    }
    // 新装的插件**默认禁用**：先让用户看清它要哪些权限、干什么，再自己去启用。
    // （插件默认启用时，"安装"就等于一次性授予了它声明的全部数据访问权。）
    // 记下**装完之后磁盘上那份内容**的指纹：以后就能回答"装完之后被改过吗"。
    // 算不出来（读目录失败）不该让安装失败——那只是少了一条日后可查证的事实。
    let installed_hash = dir_content_hash(&dest).ok();
    let approval_state_after = {
        // `record_install` 在冲突时**不动** `enabled`（用户的选择不能被一次升级冲掉），
        // 只更新版本与来源。授权快照同理不动：新版本要是多声明了权限/事件，
        // `approval_state` 立刻就会说 `required`，宿主会在用户「重新确认」之前拒绝运行它。
        record_install(
            &c,
            &manifest.id,
            &manifest.version,
            source_kind,
            false,
            false,
            installed_hash.as_deref(),
        )?;
        approval_state(&c, &manifest, false)
    };
    match &replaced {
        Some(old) => push_log(
            &manifest.id,
            "info",
            &format!("已更新：{old} → {}（来源：{source_kind}）", manifest.version),
        ),
        None => {
            // 来源不是"本地文件夹"时，在插件日志里留一行出处（索引装完之后能追溯是谁给的）。
            if source_kind != "local" {
                push_log(&manifest.id, "info", &format!("已安装（来源：{source_kind}）"));
            }
        }
    }
    if approval_state_after.required {
        push_log(
            &manifest.id,
            "warn",
            &format!(
                "新版本新增了{}：运行已暂停，等你重新确认",
                describe_drift(&approval_state_after)
            ),
        );
    }
    let (permissions, permissions_baseline) = permission_metas(&manifest);
    let events = event_metas(&manifest);
    // 先取出这两项再移动其它字段（避免部分移动后还要借用 manifest）
    let runtime = runtime_of(&manifest).to_string();
    let views = manifest.views.clone().unwrap_or_default();
    let triggers = sanitized_triggers(&manifest);
    let theme = sanitized_theme(&manifest);
    Ok(PluginMeta {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        enabled: false,
        commands,
        permissions,
        permissions_baseline,
        events,
        runtime,
        views,
        triggers,
        theme,
        // 新装默认禁用、也还没"同意过"任何东西：等用户看权限清单点启用时才会记快照。
        // 替换（升级/重装）时这里可能是 `required`——那时它说的是实话：新版本声明更大，
        // 宿主已经暂停它，等用户重新确认。界面据此提示，而不是等用户点命令才发现跑不动。
        approval: approval_state_after,
        replaced_version: replaced,
        revoked: None,
        publisher_key: None,
        publisher_key_revoked: None,
    })
}

// ---------------------------------------------------------------------------
// 索引安装（M11.11a）：给一个 URL，拉索引 → 校验 → 下载 → 校验 → 解包 → 安装
// ---------------------------------------------------------------------------

fn app_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

fn index_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| e.to_string())
}

/// 带体积上限的 GET。上限在**读取过程中**也守着：只看 `Content-Length` 会被
/// "不报长度、慢慢灌"的服务器绕过。
async fn http_get_capped(
    client: &reqwest::Client,
    url: &str,
    cap: u64,
) -> Result<Vec<u8>, String> {
    let mut resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| {
            if e.is_connect() || e.is_timeout() {
                format!("无法连接到 {url}（网络或地址不可达）")
            } else {
                format!("请求 {url} 失败：{e}")
            }
        })?;
    if !resp.status().is_success() {
        return Err(format!("{url} 返回 HTTP {}", resp.status()));
    }
    // 重定向可能把我们带到 http://（reqwest 允许降级）；落地地址要**再查一遍**。
    let landed = resp.url().to_string();
    if landed != url {
        plugin_index::check_source_url(&landed)
            .map_err(|e| format!("{url} 重定向到了不允许的地址（{landed}）：{e}"))?;
    }
    if let Some(len) = resp.content_length() {
        if len > cap {
            return Err(format!(
                "{url} 体积 {len} 字节，超过体积上限 {} MiB",
                cap / (1024 * 1024)
            ));
        }
    }
    let mut out: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("读取 {url} 失败：{e}"))? {
        if out.len() as u64 + chunk.len() as u64 > cap {
            return Err(format!(
                "{url} 超过体积上限 {} MiB（已中止下载）",
                cap / (1024 * 1024)
            ));
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

/// 拉一份索引并按需验签。**没给公钥就不假装验过**（`signatureVerified: null`）。
async fn load_plugin_index(
    url: &str,
    pubkey: Option<&str>,
    app_version: &str,
) -> Result<(plugin_index::PluginIndexView, plugin_index::PluginIndex), String> {
    let url = plugin_index::check_source_url(url)?;
    let client = index_http_client()?;
    let bytes = http_get_capped(&client, &url, plugin_index::MAX_INDEX_BYTES).await?;
    let verified = match pubkey.map(str::trim).filter(|k| !k.is_empty()) {
        Some(key) => {
            // 给了公钥就必须验签**成功**才继续：拉不到签名 = 失败（fail closed），
            // 否则"签名服务器挂了"就成了绕过校验的开关。
            let sig_url = plugin_index::signature_url(&url);
            let raw = http_get_capped(&client, &sig_url, plugin_index::MAX_SIGNATURE_BYTES)
                .await
                .map_err(|e| format!("指定了索引公钥，但取不到签名文件：{e}"))?;
            let text = String::from_utf8(raw).map_err(|_| "签名文件不是 UTF-8 文本".to_string())?;
            plugin_index::verify_index_signature(&bytes, &text, key)?;
            Some(true)
        }
        None => None,
    };
    let index = plugin_index::parse_index(&bytes)?;
    Ok((
        plugin_index::index_view(&index, app_version, verified),
        index,
    ))
}

/// 拉取并校验一份插件索引（**只读**：不下载任何插件包，也不碰磁盘）。
#[tauri::command]
pub async fn fetch_plugin_index(
    app: AppHandle,
    db: State<'_, Db>,
    url: String,
    pubkey: Option<String>,
) -> Result<plugin_index::PluginIndexView, String> {
    let (view, index) = load_plugin_index(&url, pubkey.as_deref(), &app_version(&app)).await?;
    // **离线撤回列表**：把这份索引里"被撤回"的条目记下来。之后即使再也不联网、索引下线，
    // 宿主仍然拦得住那个版本（运行与安装两条路都会查这条记忆）。
    // 记失败不该让"看索引"这件事失败——所以只记日志，不把它变成错误。
    // 每条撤回也写进**对应插件自己**的日志（插件管理里点「日志」能看到）——
    // 日志面板是按插件开的，挂在一个不存在的插件 id 上等于没人看得见。
    let revoked_keys = {
        let c = conn(&db);
        record_revoked_keys(&c, &index).unwrap_or(0)
    };
    if revoked_keys > 0 {
        for rk in &index.revoked_keys {
            let fp = plugin_index::publisher_key_fingerprint(&rk.key).unwrap_or_default();
            push_log(
                &format!("key:{fp}"),
                "warn",
                &format!(
                    "索引撤回了这把发布者密钥：{}（用它签的插件会被拦下）",
                    if rk.reason.trim().is_empty() {
                        "索引没写原因"
                    } else {
                        rk.reason.as_str()
                    }
                ),
            );
        }
    }
    let n = {
        let c = conn(&db);
        match record_revocations(&c, &index) {
            Ok(n) => n,
            // 记不下来不该让"看索引"失败，但也不能装作没发生
            Err(e) => {
                eprintln!("记录撤回失败：{e}");
                0
            }
        }
    };
    if n > 0 {
        for e in index.plugins.iter().filter(|p| p.revoked_at.is_some()) {
            push_log(
                &e.id,
                "warn",
                &format!(
                    "索引撤回了 v{}：{}（已记入离线撤回列表，该版本会被拦下）",
                    e.version,
                    if e.revoked_reason.trim().is_empty() {
                        "索引没写原因"
                    } else {
                        e.revoked_reason.as_str()
                    }
                ),
            );
        }
    }
    Ok(view)
}

/// 用户对一条撤回表态：「我知道，仍然使用」。
///
/// 索引拥有者不是用户的上司：这一层的作用是**让他知道并明确表态**，而不是替他把插件关掉。
/// 表态会被记住（`ignored_at`），之后运行/安装都不再拦，但界面照旧显示"你忽略过一次撤回"。
#[tauri::command]
pub fn ignore_plugin_revocation(db: State<'_, Db>, id: String) -> Result<RevocationView, String> {
    if !is_safe_plugin_id(&id) {
        return Err("非法插件 id".to_string());
    }
    let c = conn(&db);
    let v = read_revocation(&c, &id).ok_or_else(|| format!("没有「{id}」的撤回记录"))?;
    c.execute(
        "UPDATE plugin_revocation SET ignored_at = ?2 WHERE plugin_id = ?1",
        params![id, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    push_log(&id, "warn", "用户选择忽略索引的撤回（仍然使用）");
    Ok(RevocationView {
        ignored: true,
        ..v
    })
}

/// 已固定下来的发布者公钥（界面显示指纹用）。
#[tauri::command]
pub fn plugin_publisher_keys(db: State<'_, Db>) -> Vec<PublisherKeyView> {
    let c = conn(&db);
    let mut stmt = match c.prepare(
        "SELECT plugin_id, fingerprint, source, pinned_at FROM plugin_publisher_key ORDER BY pinned_at DESC",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map([], |r| {
        Ok(PublisherKeyView {
            plugin_id: r.get(0)?,
            fingerprint: r.get(1)?,
            source: r.get(2)?,
            pinned_at: r.get(3)?,
        })
    });
    match rows {
        Ok(it) => it.filter_map(|r| r.ok()).collect(),
        Err(_) => Vec::new(),
    }
}

/// 读一条订阅。
fn read_subscription(c: &Connection, url: &str) -> Option<IndexSubscriptionView> {
    c.query_row(
        "SELECT url, pubkey, label, added_at, last_checked_at, last_ok, last_error,
                plugin_count, updates_available
         FROM plugin_index_subscription WHERE url = ?1",
        params![url],
        |r| {
            Ok(IndexSubscriptionView {
                url: r.get(0)?,
                pubkey: r.get(1)?,
                label: r.get(2)?,
                added_at: r.get(3)?,
                last_checked_at: r.get(4)?,
                last_ok: r.get::<_, Option<i64>>(5)?.map(|v| v != 0),
                last_error: r.get(6)?,
                plugin_count: r.get(7)?,
                updates_available: r.get(8)?,
            })
        },
    )
    .ok()
}

/// 全部订阅（最近添加的在前）。
fn all_subscriptions(c: &Connection) -> Vec<IndexSubscriptionView> {
    let mut stmt = match c.prepare(
        "SELECT url, pubkey, label, added_at, last_checked_at, last_ok, last_error,
                plugin_count, updates_available
         FROM plugin_index_subscription ORDER BY added_at DESC, url ASC",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map([], |r| {
        Ok(IndexSubscriptionView {
            url: r.get(0)?,
            pubkey: r.get(1)?,
            label: r.get(2)?,
            added_at: r.get(3)?,
            last_checked_at: r.get(4)?,
            last_ok: r.get::<_, Option<i64>>(5)?.map(|v| v != 0),
            last_error: r.get(6)?,
            plugin_count: r.get(7)?,
            updates_available: r.get(8)?,
        })
    });
    match rows {
        Ok(it) => it.filter_map(|r| r.ok()).collect(),
        Err(_) => Vec::new(),
    }
}

/// 已装插件的 (id, 版本) 列表（判"可更新"用）。
fn installed_versions(c: &Connection) -> Vec<(String, String)> {
    let mut stmt = match c.prepare("SELECT plugin_id, version FROM plugin_install") {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)));
    match rows {
        Ok(it) => it.filter_map(|r| r.ok()).collect(),
        Err(_) => Vec::new(),
    }
}

/// 加一条订阅（同 URL 重复添加 = 更新它的公钥与备注，不报错——用户的意图很清楚）。
#[tauri::command]
pub fn subscribe_plugin_index(
    db: State<'_, Db>,
    url: String,
    pubkey: Option<String>,
    label: Option<String>,
) -> Result<IndexSubscriptionView, String> {
    let url = plugin_index::check_source_url(&url)?;
    let pubkey = pubkey.unwrap_or_default().trim().to_string();
    if !pubkey.is_empty() {
        // 公钥形状要先校验：存下去之后每次检查都会失败在验签那一步，
        // 而错误看起来像"索引有问题"，其实是这里存错了。
        plugin_index::parse_index_pubkey(&pubkey)?;
    }
    let label = label.unwrap_or_default().trim().to_string();
    let c = conn(&db);
    let now = now_ms();
    c.execute(
        "INSERT INTO plugin_index_subscription (url, pubkey, label, added_at, last_checked_at, last_ok, last_error, plugin_count, updates_available)
         VALUES (?1, ?2, ?3, ?4, NULL, NULL, '', 0, 0)
         ON CONFLICT(url) DO UPDATE SET pubkey = excluded.pubkey, label = excluded.label",
        params![url, pubkey, label, now],
    )
    .map_err(|e| e.to_string())?;
    read_subscription(&c, &url).ok_or_else(|| "订阅写入后读不到".to_string())
}

#[tauri::command]
pub fn unsubscribe_plugin_index(db: State<'_, Db>, url: String) -> Result<(), String> {
    let c = conn(&db);
    c.execute("DELETE FROM plugin_index_subscription WHERE url = ?1", params![url])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn plugin_index_subscriptions(db: State<'_, Db>) -> Vec<IndexSubscriptionView> {
    all_subscriptions(&conn(&db))
}

/// 逐个检查订阅：拉索引（该验签就验签）、记下结果、并把撤回记忆刷新一遍。
///
/// **一条失败不影响其它条**：网络本来就会断，用户要看的是"哪几条还活着、哪条为什么挂了"，
/// 而不是整批失败。所以这里逐条返回结果，失败只写进那条自己的 `last_error`。
#[tauri::command]
pub async fn check_plugin_index_subscriptions(
    app: AppHandle,
    db: State<'_, Db>,
    // 只查这一条（省略 = 全部）
    url: Option<String>,
) -> Result<Vec<IndexSubscriptionView>, String> {
    let version = app_version(&app);
    let subs = {
        let c = conn(&db);
        match url.as_deref() {
            Some(u) => read_subscription(&c, u).into_iter().collect::<Vec<_>>(),
            None => all_subscriptions(&c),
        }
    };
    check_subscriptions_into(&db, &subs, &version).await;
    let c = conn(&db);
    Ok(match url.as_deref() {
        Some(u) => read_subscription(&c, u).into_iter().collect(),
        None => all_subscriptions(&c),
    })
}

/// 逐个检查的主体（**不依赖 AppHandle**，所以能在测试里对着两个环回服务器跑：
/// 一个正常、一个 404——"一条失败不影响其它"这句承诺只有这样才验证得了）。
///
/// 逐条记结果，失败只写进那条自己的 `last_error`；成功的那些顺带刷新撤回记忆
/// （订阅的意义之一就是"它说了什么，我就记住什么"）。
///
/// 注意每个数据库操作都**单独取一次锁**，锁不跨 `await`：这不是风格问题，是编译期要求
/// （`MutexGuard` 不是 `Send`，而 Tauri 的命令 future 必须是 `Send`）。
async fn check_subscriptions_into(db: &Db, subs: &[IndexSubscriptionView], app_version: &str) {
    for sub in subs {
        match load_plugin_index(&sub.url, Some(sub.pubkey.as_str()), app_version).await {
            Ok((_view, index)) => {
                let c = lock_db(&db.0);
                let _ = record_revocations(&c, &index);
                let _ = record_revoked_keys(&c, &index);
                let updates = count_updates(&index, &installed_versions(&c)) as i64;
                let _ = c.execute(
                    "UPDATE plugin_index_subscription
                     SET last_checked_at = ?2, last_ok = 1, last_error = '', plugin_count = ?3, updates_available = ?4
                     WHERE url = ?1",
                    params![sub.url, now_ms(), index.plugins.len() as i64, updates],
                );
            }
            Err(e) => {
                let c = lock_db(&db.0);
                let _ = c.execute(
                    "UPDATE plugin_index_subscription
                     SET last_checked_at = ?2, last_ok = 0, last_error = ?3
                     WHERE url = ?1",
                    params![sub.url, now_ms(), e],
                );
            }
        }
    }
}

/// 一个插件的**事实清单**：来源、体积、权限与事件的声明，加上静态扫描看得出来的事实。
///
/// 刻意不含任何评分或结论——治理这一块只把可查证的东西摆出来，判断留给用户。
#[tauri::command]
pub async fn plugin_facts(app: AppHandle, db: State<'_, Db>, id: String) -> Result<PluginFacts, String> {
    if !is_safe_plugin_id(&id) {
        return Err("非法插件 id".to_string());
    }
    let dir = plugins_root(&app)?.join(&id);
    if !dir.is_dir() {
        return Err("插件不存在".to_string());
    }
    let manifest = read_manifest(&dir)?;
    let runtime = runtime_of(&manifest).to_string();
    let main_file = manifest.main.clone();
    let main_bytes = std::fs::metadata(dir.join(&main_file)).map(|m| m.len()).unwrap_or(0);
    let (file_count, total_bytes) = dir_stats(&dir);
    let source = if runtime == "logic" {
        load_plugin_source(&dir, &manifest).ok()
    } else {
        None
    };
    let (permissions, baseline) = {
        let (perm_metas, baseline) = permission_metas(&manifest);
        (
            perm_metas.into_iter().map(|p| p.id).collect::<Vec<_>>(),
            baseline,
        )
    };
    let events = manifest
        .events
        .as_ref()
        .map(|evs| evs.iter().map(|e| e.on.clone()).collect())
        .unwrap_or_default();
    let (source_kind, installed_hash) = {
        let c = conn(&db);
        c.query_row(
            "SELECT source, COALESCE(content_hash, '') FROM plugin_install WHERE plugin_id = ?1",
            params![id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .unwrap_or_default()
    };
    let current_hash = dir_content_hash(&dir).unwrap_or_default();
    let content_changed = if installed_hash.is_empty() || current_hash.is_empty() {
        None
    } else {
        Some(installed_hash != current_hash)
    };
    Ok(PluginFacts {
        id: manifest.id.clone(),
        version: manifest.version.clone(),
        source: source_kind,
        runtime: runtime.clone(),
        main_file,
        main_bytes,
        file_count,
        total_bytes,
        declared_permissions: permissions,
        baseline_permissions: baseline,
        events,
        installed_hash: installed_hash.clone(),
        current_hash: current_hash.clone(),
        content_changed,
        facts: build_plugin_facts(
            &runtime,
            main_bytes,
            file_count,
            total_bytes,
            source.as_deref(),
            content_changed,
            &installed_hash,
            &current_hash,
        ),
    })
}

/// 一个插件目录的**内容指纹**（确定性：与文件顺序、mtime 无关，只看相对路径与字节）。
///
/// 用途只有一个：和"安装时记下的那个指纹"比一比，回答"装完之后这份文件有没有被改过"。
/// 所以它必须**稳定**——目录遍历顺序、mtime、inode 都不该影响结果，否则每次读都会"不一致"，
/// 这个事实就变成了噪音。
fn dir_content_hash(dir: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    fn walk(dir: &Path, base: &Path, out: &mut Vec<(String, PathBuf)>) -> Result<(), String> {
        let mut entries: Vec<_> = std::fs::read_dir(dir)
            .map_err(|e| e.to_string())?
            .flatten()
            .map(|e| e.path())
            .collect();
        entries.sort();
        for p in entries {
            if p.is_dir() {
                walk(&p, base, out)?;
            } else if p.is_file() {
                let rel = p
                    .strip_prefix(base)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .replace('\\', "/");
                out.push((rel, p));
            }
        }
        Ok(())
    }
    let mut files = Vec::new();
    walk(dir, dir, &mut files)?;
    files.sort();
    let mut h = Sha256::new();
    for (rel, path) in files {
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        // 路径与长度都进哈希：只hash内容的话，"把 a.js 改名成 b.js"看起来会像没变。
        h.update(rel.as_bytes());
        h.update([0u8]);
        h.update((bytes.len() as u64).to_le_bytes());
        h.update(&bytes);
    }
    Ok(hex::encode(h.finalize()))
}

/// 目录里的文件数与总字节数（插件目录很小，直接递归统计）。
fn dir_stats(dir: &Path) -> (usize, u64) {
    let mut count = 0usize;
    let mut bytes = 0u64;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return (0, 0);
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            let (c, b) = dir_stats(&p);
            count += c;
            bytes += b;
        } else if let Ok(m) = e.metadata() {
            count += 1;
            bytes += m.len();
        }
    }
    (count, bytes)
}

/// 被撤回的发布者密钥（界面显示用）。
#[tauri::command]
pub fn plugin_revoked_keys(db: State<'_, Db>) -> Vec<RevokedKeyEntry> {
    all_revoked_keys(&conn(&db))
}

/// 用户对"某个发布者密钥被撤回"表态：我知道，仍然使用。
///
/// 与版撤回同一套语义：索引拥有者不是用户的上司，这一层的作用是让他知道并明确表态。
#[tauri::command]
pub fn ignore_revoked_publisher_key(
    db: State<'_, Db>,
    fingerprint: String,
) -> Result<RevokedKeyEntry, String> {
    let c = conn(&db);
    let entry = read_revoked_key(&c, &fingerprint)
        .ok_or_else(|| format!("没有指纹为 {fingerprint} 的撤回记录"))?;
    c.execute(
        "UPDATE plugin_revoked_key SET ignored_at = ?2 WHERE fingerprint = ?1",
        params![fingerprint, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    push_log(
        &format!("key:{fingerprint}"),
        "warn",
        "用户选择忽略这次密钥撤回（仍然使用）",
    );
    Ok(RevokedKeyEntry {
        ignored: true,
        ..entry
    })
}

/// 撤回记忆全貌（界面"撤回"一栏用）。
#[tauri::command]
pub fn plugin_revocations(db: State<'_, Db>) -> Vec<RevocationView> {
    all_revocations(&conn(&db))
}

/// 从索引安装一个插件：索引里能找到、能装、sha256 对得上，才落盘。
#[tauri::command]
pub async fn install_plugin_from_index(
    app: AppHandle,
    db: State<'_, Db>,
    url: String,
    id: String,
    pubkey: Option<String>,
    trust_new_key: Option<bool>,
) -> Result<PluginMeta, String> {
    let version = app_version(&app);
    let (_, index) = load_plugin_index(&url, pubkey.as_deref(), &version).await?;
    let entry = index
        .plugins
        .iter()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("这份索引里没有插件「{id}」"))?;
    // 装不装得了以**索引里的原始数据**为准（和界面显示用的是同一个判定函数）。
    let blocked = plugin_index::entry_block_reason(entry, &version, &index.revoked_keys);
    if !blocked.is_empty() {
        return Err(format!("不能安装「{id}」：{blocked}"));
    }
    let pkg_url = plugin_index::check_source_url(&entry.download_url)?;
    let client = index_http_client()?;
    let bytes = http_get_capped(&client, &pkg_url, plugin_index::MAX_PACKAGE_BYTES).await?;
    if entry.size != 0 && bytes.len() as u64 != entry.size {
        return Err(format!(
            "下载到的插件包体积（{} 字节）与索引里写的（{} 字节）不一致，拒绝安装",
            bytes.len(),
            entry.size
        ));
    }
    // 完整性：索引说这个包是这个哈希，下载到的东西就必须是它。先验再解包。
    plugin_index::verify_sha256(&bytes, &entry.sha256)?;
    let host = plugin_index::url_host(&url);
    // 发布者签名（阶段 2）：索引给了 key 与签名就必须验过；TOFU 固定过的那把 key
    // 一旦被换掉就拒绝——**索引被换掉也换不掉你已经固定过的 key**。
    let pin_after = check_entry_publisher_signature(
        &conn(&db),
        &id,
        entry,
        &bytes,
        trust_new_key.unwrap_or(false),
        &host,
    )?;
    let kind = format!("index:{host}");
    let meta = install_from_zip_bytes(&app, &db, &bytes, &kind)?;
    // 第一次见到的 key：**装成功之后**才固定（装失败的东西不该留下信任记录）。
    if let Some(key) = pin_after {
        let c = conn(&db);
        let view = pin_publisher_key(&c, &id, &key, &host)?;
        push_log(
            &id,
            "info",
            &format!("已固定发布者公钥：{}（来源 {host}）", view.fingerprint),
        );
        return Ok(PluginMeta {
            publisher_key: Some(view),
            ..meta
        });
    }
    Ok(meta)
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
        let res = run_command_msg_in_host_for_test(source, "t.hello", "", &state).unwrap();
        assert_eq!(res, "hi 7");
    }

    #[test]
    fn reports_missing_command() {
        let source = r#"register({ id: "t.hello", title: "Hello", description: "", closeOnRun: false, run: function(){ return "x"; } });"#;
        let state = RunState { page_count: 0, ..Default::default() };
        let res = run_command_msg_in_host_for_test(source, "t.nope", "", &state).unwrap();
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
        let (message, insert, ..) = run_command_in_host_for_test(source, "t.ins", "", &state).unwrap();
        assert_eq!(message, "ok");
        // 插入文本产生在**子进程**（JS 侧的原生函数），随结果帧回来；
        // 父进程那边的 `editor.insertText` 能力走的是另一条（同样会被合并进来）。
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
        let res = run_command_msg_in_host_for_test(source, "t.probe", "", &RunState::default()).unwrap();
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
        let err = run_command_msg_in_host_for_test(source, "t.loop", "", &RunState::default())
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
                 seeded INTEGER NOT NULL DEFAULT 0,
                 approved_json TEXT
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

        set_enabled(&c, "p1", false, None).unwrap();
        assert!(!enabled(&c, "p1"));
        set_enabled(&c, "p1", true, None).unwrap();
        assert!(enabled(&c, "p1"));
    }

    #[test]
    fn uninstall_clears_enabled_state_so_reinstall_is_not_poisoned() {
        let c = state_conn();
        // 用户禁用了插件，然后卸载
        set_enabled(&c, "p1", false, None).unwrap();
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

    /// 把"宿主二进制"指对。
    ///
    /// 生产路径是**同二进制 re-exec**（`current_exe()`）；但 `cargo test` 里 current_exe 是
    /// **测试二进制**（它没有 `--plugin-host` 分支），所以测试要么显式指定，要么测不到真边界。
    fn ensure_host_exe() {
        use std::sync::OnceLock;
        static DONE: OnceLock<()> = OnceLock::new();
        DONE.get_or_init(|| {
            let exe = std::env::current_exe().expect("current_exe");
            // target/<profile>/deps/<test-bin> → target/<profile>/shuyonote
            let profile_dir = exe
                .parent()
                .and_then(|p| p.parent())
                .expect("拿不到 target/<profile>");
            let candidate = profile_dir.join(format!("shuyonote{}", std::env::consts::EXE_SUFFIX));
            assert!(
                candidate.exists(),
                "找不到宿主二进制 {}：请用 `cargo test`（会先构建应用二进制），不要用 `cargo test --lib`",
                candidate.display()
            );
            std::env::set_var("SHUYONOTE_PLUGIN_HOST_EXE", &candidate);
        });
    }

    /// 测试里跑插件命令**必须走生产那条路**：真子进程 + 父进程服务能力。
    ///
    /// D7 明确不留"测试走进程内、生产走子进程"的分叉——那种分叉会让两条路的语义差异**
    /// 恰好两边都测不到**（各自都能过）。所以这里不调 `run_command_timeout`（那已经是
    /// **子进程内部**的入口），而是调生产用的 `run_command_via_host`。
    fn run_command_in_host_for_test(
        source: &str,
        command_id: &str,
        args_json: &str,
        state: &RunState,
    ) -> Result<(String, String, Vec<String>, Vec<PluginDraft>, Vec<PluginExport>), String> {
        let _g = capability_test_guard();
        ensure_host_exe();
        run_command_via_host(source, command_id, args_json, state, None)
    }

    /// 事件路径同理（生产也跑在子进程里了）。
    fn run_event_in_host_for_test(
        source: &str,
        event: &str,
        payload_json: &str,
        state: &RunState,
    ) -> Result<(String, Vec<String>, Vec<PluginDraft>), String> {
        let _g = capability_test_guard();
        ensure_host_exe();
        run_event_via_host(source, event, payload_json, state)
    }

    /// **超时 = 杀进程**（M11.13 阶段 3）：插件死循环时这次调用要在预算内返回 `timeout`，
    /// 而且**不能留下一个跑到天荒地老的宿主子进程**（阶段 3 之前这里是"放弃等待"）。
    #[test]
    fn a_hung_plugin_is_killed_and_reported_as_timeout() {
        let _g = log_test_guard();
        let _cap = capability_test_guard();
        ensure_host_exe();
        // 用一个"每次迭代都问一次能力"的循环：`while (true) {}` 会先撞上 Boa 的循环预算
        // （1e6 次）而不是墙钟超时；而每次能力调用都是一次真 IPC，几百毫秒内注定撞上墙钟。
        let hang = "register({ id: 'h', title: 'H', run: function () { var i = 0; while (i < 200000) { api.notify('x'); i = i + 1; } return 'done'; } });";
        let t0 = std::time::Instant::now();
        let err = run_via_host_with_timeout(
            hang,
            "h",
            "",
            &RunState::default(),
            crate::plugin_host::HostRunMode::Command,
            std::time::Duration::from_millis(400),
            None,
        )
        .expect_err("死循环的插件必须超时");
        let elapsed = t0.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(3),
            "超时要在预算附近就返回（实际 {:?}）——拖到插件自己跑完就等于没超时",
            elapsed
        );
        assert!(err.contains("timeout") || err.contains("超时"), "{err}");
        assert!(
            err.contains("终止"),
            "要说清是「已经把它终止了」，而不是「不再等它了」：{err}"
        );
        let (code, _) = classify_run_error(&err);
        assert_eq!(code, "timeout", "错误码要落在注册表里：{err}");
    }

    /// 崩溃语义：子进程异常退出 → 明确的 `plugin_crash`（而不是笼统的"没回结果"），
    /// 而且**不该**被当成通道坏了之后悄悄重试或静默成功。
    #[test]
    fn a_crashed_host_process_is_reported_as_a_crash() {
        let _g = log_test_guard();
        let _cap = capability_test_guard();
        ensure_host_exe();
        let exe = std::env::var("SHUYONOTE_PLUGIN_HOST_EXE").expect("宿主二进制");
        let mut client = crate::plugin_host::HostClient::spawn_with_exe_args(
            std::path::Path::new(&exe),
            &[crate::plugin_host::CRASH_FLAG],
        )
        .expect("子进程应当起得来");
        let err = client
            .run(crate::plugin_host::HostRunRequest {
                plugin_id: "t".into(),
                source: "register({ id: 'c', title: 'C', run: function () { return 'x'; } });".into(),
                command_id: "c".into(),
                mode: crate::plugin_host::HostRunMode::Command,
                ..Default::default()
            })
            .expect_err("崩溃要变成错误");
        assert!(err.contains("plugin_crash"), "{err}");
        assert!(
            err.contains("退出码") || err.contains("信号"),
            "要说清进程是怎么结束的：{err}"
        );
        let (code, _) = classify_run_error(&err);
        assert_eq!(code, "plugin_crash", "{err}");
    }

    /// **取消 = 终止那次运行的宿主子进程**（D4）。这一条把"登记 → 取消 → 错误文案 → 清理"
    /// 整条链走一遍：前端点一下取消，用户该看到"已终止插件"，而且进程真的没了。
    #[test]
    fn cancelling_a_run_kills_its_host_process() {
        let _g = log_test_guard();
        let _cap = capability_test_guard();
        ensure_host_exe();
        let run_id = 4242;

        let started = std::time::Instant::now();
        let handle = std::thread::spawn(move || {
            run_via_host_with_timeout(
                // **无限**问能力：没有取消的话它永远不会自己结束（只会撞上 30s 墙钟）。
                // 这样这条测试才真的在测"杀掉它"，而不是"等它跑完"。
                "register({ id: 'c', title: 'C', run: function () { while (true) { api.notify('x'); } } });",
                "c",
                "",
                &RunState::default(),
                crate::plugin_host::HostRunMode::Command,
                std::time::Duration::from_secs(30),
                Some(run_id),
            )
        });

        // 等它**真的登记**进来（否则可能取消了一个还没开始的运行，测了个寂寞）。
        let mut registered = false;
        for _ in 0..300 {
            if RUN_KILLERS
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .contains_key(&run_id)
            {
                registered = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(registered, "运行应当先登记进来（否则前端无从取消）");

        assert!(cancel_run(run_id), "取消应当真的杀到");
        let err = handle.join().unwrap().expect_err("被取消的运行必须报错");
        let elapsed = started.elapsed();
        assert!(err.contains("cancelled") && err.contains("已终止"), "{err}");
        // 三条一起才说明"是**杀**掉了它"，而不是"它自己跑完了"或"被别的原因终结了"：
        // ① 很快返回（不然就是等满了 30s 墙钟）；② 不是超时；③ 不是内存看门狗。
        assert!(elapsed < std::time::Duration::from_secs(5), "取消要立刻生效（实际 {elapsed:?}）");
        assert!(!err.contains("timeout"), "不该是等到墙钟超时：{err}");
        assert!(!err.contains("out_of_memory"), "不该是内存看门狗动的刀：{err}");

        // 收尾要干净：取消标记被消费、登记被摘掉（再取消一次应当返回 false）
        assert!(!take_cancelled(run_id), "取消标记不该留到下一次运行");
        assert!(!cancel_run(run_id), "已经结束的运行不该还能被取消");
    }

    /// 测试里跑一次命令、只要它的返回值（插入文本/提示/草稿用五元组那版）。
    ///
    /// 存在意义就是让"迁移到生产那条路"变成一次改名：这 13 处此前直接调**进程内**解释器入口
    /// `run_command`（没有 IPC 传输），按 D7 属于"测试走进程内、生产走子进程"的分叉。
    fn run_command_msg_in_host_for_test(
        source: &str,
        command_id: &str,
        args_json: &str,
        state: &RunState,
    ) -> Result<String, String> {
        run_command_in_host_for_test(source, command_id, args_json, state).map(|(msg, ..)| msg)
    }

    /// **运行记录进审计**：跑完一次命令之后，审计里要有一条 `host.run`，带上结局与**峰值内存**。
    /// 没有这条，用户就只能看到"能力被调过"，看不到"这次运行吃了多少、是不是被杀过"。
    #[test]
    fn a_run_records_its_outcome_and_peak_memory_in_the_audit() {
        let _g = log_test_guard();
        let _cap = capability_test_guard();
        clear_plugin_audit();
        let st = RunState {
            plugin_id: "audit-run".to_string(),
            ..Default::default()
        };
        let (msg, ..) = run_command_in_host_for_test(
            r#"register({ id: "a.run", title: "A", run: function () { return "ok"; } });"#,
            "a.run",
            "",
            &st,
        )
        .unwrap();
        assert_eq!(msg, "ok");

        let rows = plugin_audit(Some("audit-run".to_string()), None);
        let run = rows
            .iter()
            .find(|r| r.capability == "host.run")
            .expect("应当有一条运行记录");
        assert!(run.ok, "跑成功要记 ok");
        assert_eq!(run.scope, "command", "要能区分命令与事件");
        assert!(run.error_code.is_none());
        // 三个平台都能读了（Windows 走工作集，见 `resident_bytes`），所以这里
        // **不再按平台分叉**：任何一个平台上"读到 0 / 读不到"都是缺陷。
        // （上一版曾在 Windows 上断言"必须如实记 None"——那时 Windows 确实还没实现；
        //   实现补上之后那条断言就该退回强断言，否则它会拦住正确的行为。）
        assert!(
            run.peak_rss_bytes.unwrap_or(0) > 0,
            "峰值内存要真的读到（读不到就等于这条兜底的可见性没了）：{:?}",
            (run.capability.as_str(), run.ok, run.peak_rss_bytes)
        );

        // 失败的那次：插件**抛错**在宿主这层是"跑完了、结果是一句话"（shim 把异常转成返回值），
        // 但审计必须把它记成**失败**——否则用户看到的是"一切正常"。
        let (msg, ..) = run_command_in_host_for_test(
            r#"register({ id: "a.boom", title: "B", run: function () { throw new Error("炸了"); } });"#,
            "a.boom",
            "",
            &st,
        )
        .unwrap();
        assert!(msg.contains("炸了"), "{msg}");
        let rows = plugin_audit(Some("audit-run".to_string()), None);
        let failed = rows.iter().rev().find(|r| r.capability == "host.run").expect("应当有记录");
        assert!(!failed.ok);
        assert_eq!(failed.error_code.as_deref(), Some("plugin_error"));
        clear_plugin_audit();
    }

    /// 事件**成功**时不记运行记录：事件是后台高频行为（每次保存 × 每个订阅插件），
    /// 每条都记会把环灌满、把真正想看的能力调用挤掉；失败才记。
    #[test]
    fn successful_events_do_not_flood_the_audit() {
        let _g = log_test_guard();
        let _cap = capability_test_guard();
        clear_plugin_audit();
        let st = RunState {
            plugin_id: "audit-event".to_string(),
            ..Default::default()
        };
        let (msg, ..) = run_event_in_host_for_test(
            r#"on("page.saved", function () { return "handled"; });"#,
            "page.saved",
            r#"{"pageId":"p1"}"#,
            &st,
        )
        .unwrap();
        assert_eq!(msg, "handled");
        assert!(
            plugin_audit(Some("audit-event".to_string()), None)
                .iter()
                .all(|r| r.capability != "host.run"),
            "成功的事件不该往审计里灌运行记录"
        );

        // 失败的事件要记（那正是用户需要知道的）
        let (msg, ..) = run_event_in_host_for_test(
            r#"on("page.saved", function () { throw new Error("事件炸了"); });"#,
            "page.saved",
            r#"{"pageId":"p1"}"#,
            &st,
        )
        .unwrap();
        assert!(msg.contains("事件炸了"), "{msg}");
        assert!(
            plugin_audit(Some("audit-event".to_string()), None)
                .iter()
                .any(|r| r.capability == "host.run" && !r.ok),
            "失败的事件要留下运行记录"
        );
        clear_plugin_audit();
    }

    fn state_with(permissions: &[&str]) -> RunState {
        RunState {
            plugin_id: "t".to_string(),
            permissions: permissions.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }
    }

    // ---- 插件设置（M11.8）----

    #[test]
    fn setting_values_are_validated_host_side() {
        let decl = |t: &str, opts: Vec<&str>| SettingDecl {
            key: "k".into(),
            label: "目标文件夹".into(),
            setting_type: t.into(),
            default: None,
            options: opts
                .into_iter()
                .map(|v| PluginCommandParamOption { value: v.into(), label: String::new() })
                .collect(),
            description: String::new(),
            scope: "space".into(),
        };
        // 数字：规范化成整/小数
        assert_eq!(validate_setting_value(&decl("number", vec![]), " 42 ").unwrap(), "42");
        assert_eq!(validate_setting_value(&decl("number", vec![]), "1.5").unwrap(), "1.5");
        assert!(validate_setting_value(&decl("number", vec![]), "abc").unwrap_err().contains("目标文件夹"));
        // 布尔：只认 true/false
        assert_eq!(validate_setting_value(&decl("boolean", vec![]), "true").unwrap(), "true");
        assert!(validate_setting_value(&decl("boolean", vec![]), "yes").is_err());
        // 下拉：必须是候选项之一
        assert_eq!(validate_setting_value(&decl("select", vec!["a", "b"]), "b").unwrap(), "b");
        assert!(validate_setting_value(&decl("select", vec!["a"]), "c").is_err());
        assert!(validate_setting_value(&decl("select", vec![]), "c").is_err(), "声明了 select 却没有选项要报错");
        // 未知类型当字符串
        assert_eq!(validate_setting_value(&decl("weird", vec![]), "随便").unwrap(), "随便");
    }

    #[test]
    fn plugins_cannot_rewrite_the_settings_users_set() {
        let _g = log_test_guard();
        // `setting:*` 是宿主界面独占的命名空间：插件能读自己的设置，但**不能改**——
        // 否则用户看到的配置就不再是他亲手设的那个。
        let state = state_with(&["kv:own"]);
        let set = run_command_msg_in_host_for_test(
            r#"register({ id: "s.set", title: "t", run: function () { api.kv.set("setting:mode", "被插件改掉"); return "done"; } });"#,
            "s.set",
            "",
            &state,
        )
        .unwrap();
        assert!(set.contains("permission_denied"), "写保留键必须被拒：{set}");
        let remove = run_command_msg_in_host_for_test(
            r#"register({ id: "s.rm", title: "t", run: function () { api.kv.remove("setting:mode"); return "done"; } });"#,
            "s.rm",
            "",
            &state,
        )
        .unwrap();
        assert!(remove.contains("permission_denied"), "删保留键也必须被拒：{remove}");
    }

    #[test]
    fn settings_get_is_null_when_unset_and_errors_on_undeclared_keys() {
        let _g = log_test_guard();
        // 声明过、但用户没设过 → null（插件据此用自己的默认值）
        let mut state = RunState {
            plugin_id: "no-such-plugin".into(),
            permissions: vec!["kv:own".into()],
            ..Default::default()
        };
        state.setting_scopes.insert("mode".into(), "app".into());
        let out = run_command_msg_in_host_for_test(
            r#"register({ id: "s.get", title: "t", run: function () { var v = api.settings.get("mode"); return v === null ? "null" : String(v); } });"#,
            "s.get",
            "",
            &state,
        )
        .unwrap();
        assert_eq!(out, "null");

        // 没声明的 key → 明确报错而不是静默返回 null：key 名字写错是最常见的低级错误，
        // 返回 null 会让作者以为"用户没设过"，查很久。
        let err = run_command_msg_in_host_for_test(
            r#"register({ id: "s.bad", title: "t", run: function () { api.settings.get("没声明的"); return "不应到这里"; } });"#,
            "s.bad",
            "",
            &state,
        )
        .unwrap();
        assert!(err.contains("没有声明设置项"), "{err}");
    }

    // ---- 事件（M11.8）----

    fn manifest_of(json: &str) -> Manifest {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn events_are_opt_in_and_unknown_names_are_ignored() {
        let _g = log_test_guard();
        // 声明了：认识的留下，不认识的忽略 + 警告
        let m = manifest_of(
            r#"{ "id": "e", "name": "E", "events": [
                 { "on": "page.saved", "reason": "保存后补标签" },
                 { "on": "不存在的.事件", "reason": "试试" }
               ] }"#,
        );
        let (subscribed, warnings) = resolve_events(&m);
        assert_eq!(subscribed, vec!["page.saved".to_string()]);
        assert!(warnings.iter().any(|w| w.contains("未知事件")), "{warnings:?}");

        // 没写 events → **一个都不订阅**（与权限的基线授权不同：后台运行不能默认给）
        let none = manifest_of(r#"{ "id": "e", "name": "E" }"#);
        let (subscribed, warnings) = resolve_events(&none);
        assert!(subscribed.is_empty());
        assert!(warnings.is_empty(), "缺 events 不该报警告：那是显式的默认值");
    }

    #[test]
    fn registry_never_advertises_an_event_the_host_does_not_send() {
        // **注册表门禁**：`hosted: false` 意味着"作者写对了名字、启用了插件、却永远收不到"。
        // 校验器会提醒他（下面那条测试钉住提醒本身），但那份声明仍然是白写的——作者不该
        // 需要知道"这个事件接没接"。所以口径是：**要么接上，要么从注册表里删掉**。
        // 2026-09 之前 `import.finished` / `sync.completed` 就挂在这里，两个都已接上。
        let unshipped: Vec<&str> = capabilities_gen::EVENTS
            .iter()
            .filter(|e| !e.hosted)
            .map(|e| e.id)
            .collect();
        assert!(
            unshipped.is_empty(),
            "注册表里还有宿主不发的 {}：接上它，或从注册表删掉（别让作者订阅一个永远不来的事件）",
            unshipped.join(" / ")
        );
    }

    #[test]
    fn an_unshipped_event_is_not_a_real_subscription() {
        // 上一条门禁保证注册表里暂时没有这种事件，所以这条用**合成的**声明直接测保护本身：
        // 将来谁想"先声明、后实现"，这条保护仍然在（而不是等着作者踩）。
        let future = capabilities_gen::PluginEvent {
            id: "future.event",
            title: "将来的事件",
            desc: "还没实现",
            since: "1.0.0",
            hosted: false,
        };
        let d = decide_event(Some(&future), "future.event", "想订阅它");
        assert!(!d.subscribe, "宿主还没开始发的事件不该算订阅成功");
        assert!(
            d.warnings.iter().any(|w| w.contains("还没开始发")),
            "必须告知作者而不是静默无效：{:?}",
            d.warnings
        );

        // 未知事件：同样不算订阅，提示是另一句（别把"没接"和"不认识"混成一句）
        let unknown = decide_event(None, "no.such.event", "随便写");
        assert!(!unknown.subscribe);
        assert!(unknown.warnings.iter().any(|w| w.contains("未知事件")), "{:?}", unknown.warnings);
    }

    #[test]
    fn every_hosted_event_subscribes_and_asks_for_a_reason() {
        let _g = log_test_guard();
        // 注册表里**每一个**已接的事件都必须真的能订阅成功（名字、hosted、reason 判定这条链）。
        for ev in capabilities_gen::EVENTS {
            let m = manifest_of(&format!(
                r#"{{ "id": "e", "name": "E", "events": [ {{ "on": "{}", "reason": "测试" }} ] }}"#,
                ev.id
            ));
            let (subscribed, warnings) = resolve_events(&m);
            assert_eq!(subscribed, vec![ev.id.to_string()], "{} 应当订阅成功", ev.id);
            assert!(warnings.is_empty(), "{} 不该有警告：{warnings:?}", ev.id);
            assert_eq!(event_metas(&m).len(), 1, "{} 应当出现在启用界面", ev.id);
        }

        // 缺 reason：仍然订阅（理由是否齐全不该让订阅失败），但必须提醒——用户看不到
        // 一个后台运行理由，就没法授权。
        let no_reason = manifest_of(
            r#"{ "id": "e", "name": "E", "events": [ { "on": "import.finished" } ] }"#,
        );
        let (subscribed, warnings) = resolve_events(&no_reason);
        assert_eq!(subscribed, vec!["import.finished".to_string()]);
        assert!(warnings.iter().any(|w| w.contains("没有写 reason")), "{warnings:?}");
    }

    #[test]
    fn event_without_reason_is_warned() {
        let _g = log_test_guard();
        let m = manifest_of(r#"{ "id": "e", "name": "E", "events": [ { "on": "page.saved" } ] }"#);
        let (subscribed, warnings) = resolve_events(&m);
        assert_eq!(subscribed.len(), 1);
        assert!(warnings.iter().any(|w| w.contains("reason")), "{warnings:?}");
    }

    #[test]
    fn event_metas_gives_user_visible_title_and_reason() {
        let _g = log_test_guard();
        let m = manifest_of(
            r#"{ "id": "e", "name": "E", "events": [ { "on": "page.saved", "reason": "保存后补标签" } ] }"#,
        );
        let metas = event_metas(&m);
        assert_eq!(metas.len(), 1);
        assert_eq!(metas[0].id, "page.saved");
        assert_eq!(metas[0].title, "页面已保存");
        assert_eq!(metas[0].reason, "保存后补标签");
    }

    #[test]
    fn event_handler_runs_and_drafts_are_collected() {
        let _g = log_test_guard();
        let src = r#"
on("page.saved", function (payload) {
  api.tags.add("已保存-" + payload.title);   // 写能力 → 产出草稿，不落库
  return "处理了 " + payload.title;
});
"#;
        // 事件派发时「当前页」= payload 里的 pageId（生产路径由 emit_plugin_event 设置），
        // 所以作者省略 pageId 时写的是刚保存的那一页。
        let mut state = state_with(&["write:tags"]);
        state.current_page_id = Some("p1".to_string());
        let (msg, _toasts, drafts) =
            run_event_in_host_for_test(src, "page.saved", r#"{"pageId":"p1","title":"甲"}"#, &state).unwrap();
        assert!(msg.contains("处理了 甲"), "{msg}");
        assert_eq!(drafts.len(), 1, "事件里的写操作必须产出草稿，由用户确认后才落库");
        assert!(drafts[0].summary.contains("已保存-甲"), "{:?}", drafts[0].summary);
    }

    #[test]
    fn event_handler_without_permission_is_denied_not_silently_ignored() {
        let _g = log_test_guard();
        let src = r#"on("page.saved", function () { api.tags.add("x"); return "done"; });"#;
        let mut state = state_with(&[]); // 没给 write:tags
        state.current_page_id = Some("p1".to_string());
        let (msg, _toasts, drafts) =
            run_event_in_host_for_test(src, "page.saved", r#"{"pageId":"p1"}"#, &state).unwrap();
        // 能力被拒时 shim 会**抛错**（作者看得见），处理器就此中止：
        // 既不会静默成功，也不会产出草稿——错误随结果回传，宿主写进插件日志。
        assert!(msg.contains("permission_denied"), "拒绝必须可见：{msg}");
        assert!(drafts.is_empty(), "未授予权限时不能有草稿");
    }

    #[test]
    fn one_throwing_handler_does_not_eat_the_others() {
        let _g = log_test_guard();
        let src = r#"
on("page.saved", function () { throw new Error("第一个炸了"); });
on("page.saved", function () { return "第二个正常"; });
"#;
        let (msg, _, _) = run_event_in_host_for_test(src, "page.saved", "{}", &RunState::default()).unwrap();
        assert!(msg.contains("第一个炸了"), "错误必须回传而不是被吞：{msg}");
        assert!(msg.contains("第二个正常"), "后面的处理器仍要执行：{msg}");
    }

    #[test]
    fn unsubscribed_event_runs_nothing() {
        let _g = log_test_guard();
        let src = r#"on("page.saved", function () { return "不该被触发"; });"#;
        let (msg, toasts, drafts) =
            run_event_in_host_for_test(src, "page.deleted", "{}", &RunState::default()).unwrap();
        assert_eq!(msg, "");
        assert!(toasts.is_empty() && drafts.is_empty());
    }

    // ---- 命令参数（M11.8）----

    #[test]
    fn command_params_are_described_and_reach_run() {
        let _g = log_test_guard();
        let src = r#"
register({
  id: "p.run", title: "带参数", description: "",
  params: [
    { name: "title", type: "string", required: true, label: "标题" },
    { name: "count", type: "number", default: 3 },
    { name: "mode", type: "select", options: ["a", { value: "b", label: "乙" }] },
    { name: "loud", type: "boolean" },
    { name: "weird", type: "不认识的类型" }
  ],
  run: function (args) {
    return args.title + "/" + args.count + "/" + args.mode + "/" + args.loud + "/" + typeof args.weird;
  }
});
"#;
        let (msg, _, _, _, _) = run_command_in_host_for_test(
            src,
            "p.run",
            r#"{"title":"你好","count":2,"mode":"b","loud":true,"weird":"x"}"#,
            &RunState::default(),
        )
        .unwrap();
        assert_eq!(msg, "你好/2/b/true/string");

        // 宿主渲染表单只依据 `__describe()` 交回的这份声明
        let cmds = discover_commands(src, &RunState::default()).unwrap();
        assert_eq!(cmds.len(), 1);
        let params = &cmds[0].params;
        assert_eq!(params.len(), 5);
        assert_eq!(params[0].name, "title");
        assert_eq!(params[0].label, "标题");
        assert!(params[0].required);
        assert_eq!(params[1].param_type, "number");
        assert_eq!(params[1].default, Some(serde_json::json!(3)));
        assert_eq!(params[2].param_type, "select");
        assert_eq!(params[2].options.len(), 2);
        assert_eq!(params[2].options[1].value, "b");
        assert_eq!(params[2].options[1].label, "乙");
        assert_eq!(params[3].param_type, "boolean");
        // 不认识的类型归一为 string：宁可给个文本框，也不要让命令从面板里消失
        assert_eq!(params[4].param_type, "string");
        assert!(!params[0].placeholder.is_empty() || params[0].placeholder.is_empty());
    }

    #[test]
    fn command_menus_are_passed_through_verbatim() {
        let _g = log_test_guard();
        // 原样透传：宿主渲染自己认识的入口，**不认识的交给校验器去说**（静默丢掉
        // 等于让作者白写一行声明却毫无反馈）
        let src = r#"register({ id: "m.a", title: "甲", menus: ["slash", "page.context", "不存在的入口"], run: function(){ return ""; } });"#;
        let cmds = discover_commands(src, &RunState::default()).unwrap();
        assert_eq!(cmds[0].menus, vec!["slash", "page.context", "不存在的入口"]);
        // 重复值去重、非字符串被字符串化、数量有上限（防奇怪输入撑爆元数据）
        let messy = r#"register({ id: "m.b", title: "乙", menus: ["slash", "slash", 42], run: function(){ return ""; } });"#;
        let cmds = discover_commands(messy, &RunState::default()).unwrap();
        assert_eq!(cmds[0].menus, vec!["slash", "42"]);
        let none = r#"register({ id: "m.c", title: "丙", run: function(){ return ""; } });"#;
        let cmds = discover_commands(none, &RunState::default()).unwrap();
        assert!(cmds[0].menus.is_empty(), "没声明触发面时不该凭空多出来");
    }

    #[test]
    fn command_without_params_keeps_working() {
        let _g = log_test_guard();
        // 老插件：`run()` 不声明参数、也不接受参数 —— 必须原样可用
        let src = r#"register({ id: "old.run", title: "老命令", run: function () { return "ok"; } });"#;
        let (msg, _, _, _, _) = run_command_in_host_for_test(src, "old.run", "", &RunState::default()).unwrap();
        assert_eq!(msg, "ok");
        let cmds = discover_commands(src, &RunState::default()).unwrap();
        assert!(cmds[0].params.is_empty(), "没声明参数时不应凭空多出参数");
    }

    #[test]
    fn structured_return_translates_to_host_primitives() {
        let _g = log_test_guard();
        // 对象返回 = 结构化返回：message 走结果消息，insert/toast 等价于对应宿主原语
        let src = r#"
register({ id: "s.run", title: "结构化", run: function () {
  return { message: "完成", insert: "追加的文本", toasts: ["提示一", "提示二"] };
}});
"#;
        let (msg, insert, toasts, _, _) =
            run_command_in_host_for_test(src, "s.run", "", &state_with(&["write:page.current"])).unwrap();
        assert_eq!(msg, "完成");
        assert_eq!(insert, "追加的文本");
        assert_eq!(toasts, vec!["提示一".to_string(), "提示二".to_string()]);
    }

    // ---- 导出能力（files.export）：登记请求，不写盘 ----

    #[test]
    fn export_is_queued_not_written() {
        let _g = log_test_guard();
        let dir = temp_dir("export-queued");
        let target = dir.join("想要的名字.md");
        // 插件把"文件名"写成带目录的样子：宿主只取最后一段，绝不拿它当路径用。
        //
        // ★ 路径要塞进**JS 字符串字面量**，所以反斜杠必须再转义一层：
        //   Windows 上 `display()` 给出 `C:\Users\…\想要的名字.md`，直接拼进去的话
        //   JS 会把 `\U`、`\c` 当成转义吃掉，宿主收到的就成了"连分隔符都没有"的字符串
        //   （实测：C:UserscnzenAppData…想要的名字.md）——测试因此红了好几轮，
        //   而产品代码其实是对的。转义之后这条测试才**真的**覆盖 Windows 分隔符。
        let target_js = target.display().to_string().replace('\\', "\\\\");
        let src = format!(
            r#"register({{ id: "e.run", title: "E", description: "", closeOnRun: false,
  run: function () {{
    var r = api.files.export("../../{target}", "正文内容");
    return "queued=" + r.queued + " bytes=" + r.bytes;
  }} }});"#,
            target = target_js
        );
        let state = state_with(&["export:files"]);
        let (msg, _insert, _toasts, _drafts, exports) =
            run_command_in_host_for_test(&src, "e.run", "", &state).unwrap();

        assert_eq!(exports.len(), 1, "应当登记一条导出请求");
        assert_eq!(exports[0].file_name, "想要的名字.md", "目录部分必须被去掉：插件给不出路径");
        assert_eq!(exports[0].content, "正文内容");
        assert_eq!(exports[0].bytes, "正文内容".len());
        assert!(msg.contains("queued=true"));
        assert!(!target.exists(), "**这一步绝不能写盘**：写不写由用户在保存对话框里决定");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn export_needs_the_permission() {
        let _g = log_test_guard();
        // 没声明 export:files：拒绝（与其他能力一样，逐次校验，不靠 UI 隐藏）
        let src = r#"register({ id: "e.deny", title: "E", description: "", closeOnRun: false,
  run: function () { try { api.files.export("a.md", "x"); } catch (e) { return String(e); } return "no-throw"; } });"#;
        let (msg, _i, _t, _d, exports) = run_command_in_host_for_test(src, "e.deny", "", &state_with(&[])).unwrap();
        assert!(msg.contains("permission_denied"), "实际：{msg}");
        assert!(exports.is_empty(), "被拒的调用不该留下导出请求");

        // 文件名不可用 / 内容为空 → bad_args（走 JS，确认错误能回到插件里）
        let bad = r#"register({ id: "e.bad", title: "E", description: "", closeOnRun: false,
  run: function () {
    var out = [];
    try { api.files.export("..", "x"); } catch (e) { out.push(String(e).indexOf("bad_args") >= 0 ? "bad_args" : String(e)); }
    try { api.files.export("a.md", ""); } catch (e) { out.push(String(e).indexOf("bad_args") >= 0 ? "bad_args" : String(e)); }
    return out.join(" | ");
  } });"#;
        let (msg, ..) = run_command_in_host_for_test(bad, "e.bad", "", &state_with(&["export:files"])).unwrap();
        assert_eq!(msg, "bad_args | bad_args");
    }

    #[test]
    fn export_has_size_and_count_limits() {
        let _g = log_test_guard();
        // 直接调能力函数来卡边界：**不经过 Boa**。理由很实在——在 JS 里造一个 4 MiB 的字符串
        // 会先撞到插件自己的内存预算（64 MiB，M11.5），根本走不到这条上限；那说明
        //「导出上限是兜底，真正常先撞到的是插件的内存预算」，两条线分别测才说得清楚。
        let big = "x".repeat(MAX_EXPORT_BYTES + 1);
        let err = cap_files_export("a.md", &big).unwrap_err();
        assert!(err.contains("quota_exceeded"), "实际：{err}");
        assert!(cap_files_export("a.md", &"x".repeat(MAX_EXPORT_BYTES)).is_ok(), "正好到上限应当放行");

        // 次数上限：超出的那条被拒，已登记的不受影响
        RUN_STATE.with(|s| s.borrow_mut().exports.clear());
        for i in 0..MAX_EXPORTS_PER_RUN {
            cap_files_export(&format!("f{i}.md"), "x").unwrap();
        }
        let err = cap_files_export("over.md", "x").unwrap_err();
        assert!(err.contains("quota_exceeded"), "实际：{err}");
        RUN_STATE.with(|s| assert_eq!(s.borrow().exports.len(), MAX_EXPORTS_PER_RUN));

        // 同名只留一条（用户在保存对话框里看到两次同样的名字只会困惑）
        RUN_STATE.with(|s| s.borrow_mut().exports.clear());
        cap_files_export("same.md", "第一次").unwrap();
        cap_files_export("same.md", "第二次").unwrap();
        RUN_STATE.with(|s| {
            let st = s.borrow();
            assert_eq!(st.exports.len(), 1);
            assert_eq!(st.exports[0].content, "第一次");
        });
        RUN_STATE.with(|s| s.borrow_mut().exports.clear());
    }

    #[test]
    fn export_file_names_are_sanitized() {
        assert_eq!(sanitize_export_file_name("a.md").as_deref(), Some("a.md"));
        assert_eq!(sanitize_export_file_name("  /tmp/x/笔记.md  ").as_deref(), Some("笔记.md"));
        assert_eq!(sanitize_export_file_name(r"C:\Users\me\导出.csv").as_deref(), Some("导出.csv"));
        // 结尾的点/空格在 Windows 上会落到别的名字，直接切掉
        assert_eq!(sanitize_export_file_name("名字.").as_deref(), Some("名字"));
        // 只剩点、纯空白、带控制字符到什么都不剩 → 拒
        assert!(sanitize_export_file_name("..").is_none());
        assert!(sanitize_export_file_name("   ").is_none());
        assert!(sanitize_export_file_name("/").is_none());
        assert!(sanitize_export_file_name("a\u{0}b").is_some(), "控制字符是滤掉而不是整名作废");
        assert_eq!(sanitize_export_file_name("a\u{0}b").as_deref(), Some("ab"));
    }

    #[test]
    fn structured_return_still_obeys_permissions() {
        let _g = log_test_guard();
        // 结构化返回**不是**绕过权限的后门：没有 write:page.current 时 insert 仍被拒
        let src = r#"register({ id: "s.deny", title: "结构化", run: function () { return { insert: "不该写入" }; } });"#;
        let (_msg, insert, _, _, _) = run_command_in_host_for_test(src, "s.deny", "", &state_with(&[])).unwrap();
        assert!(insert.is_empty(), "未授予写权限时不应写入，实际：{insert:?}");
    }

    #[test]
    fn bad_args_json_is_reported_not_silently_ignored() {
        let _g = log_test_guard();
        let src = r#"register({ id: "a.run", title: "参数", run: function (args) { return "收到" + JSON.stringify(args); } });"#;
        // 第一道在命令层（`run_plugin_command` 要求 JSON 对象）；这里验证第二道：
        // 直接 eval 到 `__run` 时，非具名的参数（数组）也退回空对象而不是被当成参数用
        let (msg, _, _, _, _) = run_command_in_host_for_test(src, "a.run", "[1,2,3]", &RunState::default()).unwrap();
        assert_eq!(msg, "收到{}", "数组不是合法参数对象，应退回空对象");
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
        let (msg, insert, toasts, _drafts, _exports) = run_command_in_host_for_test(source, "t.api", "", &state).unwrap();
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
        let res = run_command_msg_in_host_for_test(source, "t.deny", "", &state_with(&[])).unwrap();
        assert!(res.contains("permission_denied"), "实际: {res}");
        assert!(res.contains("read:pages"), "错误里应点明缺哪个权限");
    }

    #[test]
    fn legacy_globals_go_through_the_same_permission_check() {
        // 老写法不能成为绕过点。
        let source = r#"register({ id: "t.legacy", title: "L", description: "", closeOnRun: false,
  run: function(){ return "count=" + __pages(); } });"#;
        let denied = run_command_msg_in_host_for_test(source, "t.legacy", "", &state_with(&[])).unwrap();
        assert!(denied.contains("permission_denied"), "老全局也要过权限校验，实际: {denied}");

        let mut ok_state = state_with(&["read:pages"]);
        ok_state.page_count = 7;
        assert_eq!(run_command_msg_in_host_for_test(source, "t.legacy", "", &ok_state).unwrap(), "count=7");
    }

    #[test]
    fn unknown_capability_is_rejected() {
        let source = r#"register({ id: "t.unknown", title: "U", description: "", closeOnRun: false,
  run: function(){ return String(__cap("pages.deleteEverything", "{}")); } });"#;
        let res = run_command_msg_in_host_for_test(source, "t.unknown", "", &state_with(&[])).unwrap();
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
            settings: None,
            runtime: None,
            theme: None,
            views: None,
            triggers: None,
            events: None,
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
            settings: None,
            runtime: None,
            theme: None,
            views: None,
            triggers: None,
            events: None,
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
            settings: None,
            runtime: None,
            theme: None,
            views: None,
            triggers: None,
            events: None,
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
            settings: None,
            runtime: None,
            theme: None,
            views: None,
            triggers: None,
            events: None,
        };
        let (metas2, baseline2) = permission_metas(&legacy);
        assert!(baseline2);
        assert_eq!(metas2.len(), capabilities_gen::PERMISSION_LIST.len());
        assert!(metas2[0].reason.contains("基线"), "基线授权必须说清楚是怎么来的");
    }

    // ---- 导入触发（M11.9）：扩展名规范化 + 只渲染读得懂的声明 ----

    /// 用一段 `triggers` JSON 造一个逻辑档 manifest（其余字段用默认值）。
    fn trigger_manifest(triggers: serde_json::Value) -> Manifest {
        serde_json::from_value(serde_json::json!({
            "id": "imp",
            "name": "导入",
            "main": "main.js",
            "triggers": triggers,
        }))
        .unwrap()
    }

    #[test]
    fn extensions_are_normalized_to_a_lowercase_dotted_form() {
        assert_eq!(normalize_extension("md").as_deref(), Some(".md"));
        assert_eq!(normalize_extension(".MD").as_deref(), Some(".md"));
        assert_eq!(normalize_extension("  .Csv ").as_deref(), Some(".csv"));
        assert_eq!(normalize_extension(".tar_gz").as_deref(), Some(".tar_gz"));

        // 只接**一个**扩展名：`md.txt` 不是「两个扩展名」，而是写错了；带空格/分隔符/
        // 通配符的同样不是——猜着接住会变成"这个插件连不该吃的文件也吃"。
        for bad in [
            "",
            " ",
            ".",
            "...",
            "m d",
            "m/d",
            "*.md",
            "md.txt",
            "md\\",
            "aaaaaaaaaaaaaaaaaaaa",
        ] {
            assert!(normalize_extension(bad).is_none(), "{bad:?} 不该被当成扩展名");
        }
    }

    #[test]
    fn view_placement_is_carried_through_to_the_ui() {
        // 落点（`overlay` / `rail`）必须是**前端读得到**的：声明在 manifest 里、由宿主决定
        // 开在浮层还是右侧常驻面板。这条测试钉住"声明真的流到了 PluginMeta"——否则前端只会
        // 永远按默认（浮层）渲染，作者写了 `rail` 却看不到任何变化，而且不会有任何报错。
        let base = temp_dir("view-placement");
        let dir = base.join("board");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("manifest.json"),
            r#"{ "id": "board", "name": "B", "runtime": "declarative",
                 "views": [ { "id": "v", "title": "V", "columns": ["title"], "placement": "rail" },
                            { "id": "w", "title": "W", "columns": ["title"] } ] }"#,
        )
        .unwrap();
        let m = read_manifest(&dir).unwrap();
        let views = m.views.as_ref().unwrap();
        assert_eq!(views[0].placement.as_deref(), Some("rail"), "manifest 里的落点要被读到");
        assert_eq!(views[1].placement, None, "没写就是没写（前端按 overlay 处理，默认只有一处）");
    }

    #[test]
    fn view_query_accepts_the_documented_camel_case_fields() {
        // 作者文档（生成物 §4.9）与示例里写的是 `updatedWithinDays` / `titleContains`。
        // 结构体字段是 snake_case，早先漏了 `rename_all = "camelCase"`，于是这两个字段
        // **被静默丢掉**——视图的"最近 N 天"从来没生效过，而文档写着能用，校验器也不报
        // （单字段名 kind/sort/limit 两种写法同名，所以只有多字段名暴露问题）。
        // 这条测试钉的就是"文档写的形态真的能用"。
        let base = temp_dir("view-camel");
        let dir = base.join("camel");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("manifest.json"),
            r#"{ "id": "camel", "name": "C", "runtime": "declarative",
                 "views": [ { "id": "v", "title": "V", "columns": ["title"],
                              "query": { "updatedWithinDays": 30, "titleContains": "周报" } } ] }"#,
        )
        .unwrap();
        let m = read_manifest(&dir).unwrap();
        let q = &m.views.as_ref().unwrap()[0].query;
        assert_eq!(
            q.updated_within_days.as_ref().and_then(|f| f.literal()),
            Some(30),
            "文档写的 updatedWithinDays 必须真的被读到"
        );
        assert_eq!(
            q.title_contains.as_ref().and_then(|f| f.literal()),
            Some("周报"),
            "文档写的 titleContains 必须真的被读到"
        );

        // 顺手收下的 snake_case 写法（照结构体反推出来的形态）也要能用
        std::fs::write(
            dir.join("manifest.json"),
            r#"{ "id": "camel", "name": "C", "runtime": "declarative",
                 "views": [ { "id": "v", "title": "V", "columns": ["title"],
                              "query": { "updated_within_days": 7 } } ] }"#,
        )
        .unwrap();
        let m2 = read_manifest(&dir).unwrap();
        assert_eq!(
            m2.views.as_ref().unwrap()[0].query.updated_within_days.as_ref().and_then(|f| f.literal()),
            Some(7)
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn only_understandable_triggers_are_rendered() {
        let m = trigger_manifest(serde_json::json!([
            { "kind": "import", "extensions": [".MD", "md", ".csv"], "command": " imp.run " },
            { "kind": "export", "extensions": [".md"], "command": "imp.run" },
            { "kind": "wasm", "extensions": [".md"], "command": "imp.run" },
            { "kind": "import", "extensions": [".md"], "command": "" },
            { "kind": "import", "extensions": ["没 有"], "command": "imp.run" }
        ]));
        let got = sanitized_triggers(&m);
        assert_eq!(got.len(), 2, "读得懂的只有 import 与 export 那两条：{got:?}");
        assert_eq!(got[0].kind, "import");
        assert_eq!(got[0].command, "imp.run", "命令 id 去掉首尾空白");
        assert_eq!(
            got[0].extensions,
            vec![".md".to_string(), ".csv".to_string()],
            "扩展名规范化 + 去重 + 保持作者写的顺序"
        );
        assert_eq!(got[1].kind, "export", "导出触发同样只认注册表里的 kind");
    }

    #[test]
    fn declarative_plugins_never_get_triggers() {
        // 零代码插件没有命令可调：留着入口只会让用户点到一个必然报「命令不存在」的按钮
        let m: Manifest = serde_json::from_value(serde_json::json!({
            "id": "d",
            "name": "D",
            "runtime": "declarative",
            "views": [{ "id": "v", "title": "V", "columns": ["title"] }],
            "triggers": [{ "kind": "import", "extensions": [".md"], "command": "d.run" }],
        }))
        .unwrap();
        assert!(sanitized_triggers(&m).is_empty());
    }

    #[test]
    fn triggers_and_extensions_are_capped() {
        let many: Vec<serde_json::Value> = (0..(MAX_TRIGGERS + 3))
            .map(|i| serde_json::json!({ "kind": "import", "extensions": [format!(".e{i}")], "command": "imp.run" }))
            .collect();
        assert_eq!(sanitized_triggers(&trigger_manifest(serde_json::json!(many))).len(), MAX_TRIGGERS);

        let exts: Vec<String> = (0..(MAX_TRIGGER_EXTENSIONS + 5)).map(|i| format!(".e{i}")).collect();
        let one = trigger_manifest(serde_json::json!([
            { "kind": "import", "extensions": exts, "command": "imp.run" }
        ]));
        assert_eq!(sanitized_triggers(&one)[0].extensions.len(), MAX_TRIGGER_EXTENSIONS);
    }

    // ---- 安装行 / 私有数据 / 审计 ----

    #[test]
    fn uninstall_also_drops_the_plugins_private_data() {
        let c = state_conn();
        record_install(&c, "p1", "1.0.0", "local", false, true, None).unwrap();
        c.execute(
            "INSERT INTO meta.plugin_data (plugin_id, scope, key, value, updated_at)
             VALUES ('p1', 'app', 'k', 'v', 0)",
            [],
        )
        .unwrap();
        set_enabled(&c, "p1", false, None).unwrap();
        assert!(!enabled(&c, "p1"));

        clear_enabled(&c, "p1").unwrap();
        assert!(enabled(&c, "p1"), "卸载后重装不该继承旧的已禁用");
        let left: i64 = c
            .query_row("SELECT COUNT(*) FROM meta.plugin_data", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0, "卸载应当连私有数据一起清掉");
    }

    // ---- 授权快照：声明扩张必须重新征求同意 ----

    /// 造一个 manifest（可选权限 / 事件 / 版本）。
    fn manifest_with(perms: &[&str], events: &[&str], version: &str) -> Manifest {
        serde_json::from_value(serde_json::json!({
            "id": "p1",
            "name": "P",
            "version": version,
            "main": "main.js",
            "permissions": perms.iter().map(|p| serde_json::json!({ "id": p, "reason": "x" })).collect::<Vec<_>>(),
            "events": events.iter().map(|e| serde_json::json!({ "on": e, "reason": "x" })).collect::<Vec<_>>(),
        }))
        .unwrap()
    }

    #[test]
    fn approval_drift_only_counts_growth() {
        let base = approval_snapshot(&manifest_with(&["read:pages"], &["page.saved"], "1.0.0"));

        // 一模一样 → 不算扩张
        let same = approval_snapshot(&manifest_with(&["read:pages"], &["page.saved"], "1.0.1"));
        assert!(approval_drift(&base, &same).is_empty(), "只有版本号变了不该要求重新确认");

        // 顺序变了（声明顺序/解析顺序不同）→ 也不算：快照是排序后的集合
        let reordered = approval_snapshot(&manifest_with(&["read:tags", "read:pages"], &["page.opened", "page.saved"], "1.0.0"));
        let base2 = approval_snapshot(&manifest_with(&["read:pages", "read:tags"], &["page.saved", "page.opened"], "1.0.0"));
        assert!(approval_drift(&base2, &reordered).is_empty());

        // 收敛（删掉一项）→ 不算：用户当初同意的是更多东西，缩减不增加他的风险
        let shrunk = approval_snapshot(&manifest_with(&[], &[], "1.0.0"));
        assert!(approval_drift(&base, &shrunk).is_empty(), "缩减声明不该打断用户");

        // 新增权限 / 新增事件 → 都必须报出来，且说得出具体是哪一项
        let grown = approval_snapshot(&manifest_with(&["read:pages", "write:pages"], &["page.saved", "page.deleted"], "1.1.0"));
        let drift = approval_drift(&base, &grown);
        assert_eq!(drift.added_permissions, vec!["write:pages".to_string()]);
        assert_eq!(drift.added_events, vec!["page.deleted".to_string()]);
    }

    #[test]
    fn enabling_records_the_approval_and_growth_pauses_the_plugin() {
        let c = state_conn();
        let v1 = manifest_with(&["read:pages"], &[], "1.0.0");
        // 用户点「启用」→ 记下他同意的快照
        set_enabled(&c, "p1", true, Some(&approval_snapshot(&v1))).unwrap();
        assert!(!approval_state(&c, &v1, false).required, "刚同意的声明当然可以跑");

        // 插件目录被换成声明更大的版本：不用重新启用，**也进不去**
        let v2 = manifest_with(&["read:pages", "write:pages"], &["page.saved"], "1.1.0");
        let state = approval_state(&c, &v2, false);
        assert!(state.required, "新增权限/事件必须要求重新确认");
        assert_eq!(state.added_permissions, vec!["write:pages".to_string()]);
        assert_eq!(state.added_events, vec!["page.saved".to_string()]);
        assert_eq!(state.approved_version, "1.0.0", "界面要说得出你同意的是哪一版");

        // 重新确认 → 放行，且快照更新到当前
        write_approval(&c, "p1", &approval_snapshot(&v2)).unwrap();
        assert!(!approval_state(&c, &v2, false).required);

        // 只收不扩：不再要求确认
        let v3 = manifest_with(&["read:pages"], &[], "1.1.1");
        assert!(!approval_state(&c, &v3, false).required);
    }

    #[test]
    fn legacy_plugins_are_grandfathered_once() {
        let c = state_conn();
        let m = manifest_with(&["read:pages"], &[], "1.0.0");
        // 升级前装的插件没有快照：第一次扫描按"照常"处理，并把当前声明补记成快照——
        // 否则升级后所有存量插件集体停摆，那是拿用户当测试。
        assert!(!approval_state(&c, &m, true).required);
        assert!(!approval_state(&c, &m, false).required, "补记之后照样能跑");

        // 补记之后，扩张就开始受约束了（这才是有意义的那一半）
        let grown = manifest_with(&["read:pages", "write:pages"], &[], "1.1.0");
        assert!(approval_state(&c, &grown, false).required);
    }

    #[test]
    fn baseline_legacy_manifests_do_not_look_like_growth() {
        let c = state_conn();
        // 老 manifest 完全不声明 permissions → 走 v1 基线授权（等于全给）。
        // 快照记的就是那份基线，所以它自己不会跟自己"看起来像新增"。
        let legacy: Manifest = serde_json::from_value(serde_json::json!({
            "id": "p1", "name": "P", "main": "main.js",
        }))
        .unwrap();
        set_enabled(&c, "p1", true, Some(&approval_snapshot(&legacy))).unwrap();
        assert!(!approval_state(&c, &legacy, false).required);
        // 老插件后来显式声明了**一部分**权限：那是收敛，不该要求确认
        let narrowed = manifest_with(&["read:pages"], &[], "1.0.0");
        assert!(!approval_state(&c, &narrowed, false).required);
    }

    #[test]
    fn record_install_keeps_the_users_enabled_choice() {
        let c = state_conn();
        record_install(&c, "p1", "1.0.0", "local", false, false, None).unwrap();
        assert!(!enabled(&c, "p1"), "新装默认禁用（安装 ≠ 授权）");
        set_enabled(&c, "p1", true, None).unwrap();

        // 再次播种/记录（例如升级）不该把用户的选择冲掉
        record_install(&c, "p1", "2.0.0", "bundled", true, true, None).unwrap();
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

    /// 测试里"会走能力的那一段"的**可重入**串行锁。
    ///
    /// 为什么需要它：审计环是**进程级**的（生产里界面就读它），而 Rust 测试默认并行跑。
    /// 任何会走能力的测试都可能往环里推条目、也可能清空它，于是彼此把对方刚推的条目挤掉。
    /// 这不是洁癖——CI 上真的红过：`audit_is_scoped_per_plugin_and_capped` 断言"缓冲必须封顶
    /// （= 我推的 505 条都在）"时，发现自己的条目被另一个测试挤走了（那个测试的插件也在调能力，
    /// 而能力现在跑在父进程里、推的是同一个环）。
    ///
    /// 为什么**可重入**：整段测试（自己的 `clear` + 断言）都要在锁里，而测试装置
    /// （`call` / `run_*_in_host_for_test`）内部也会拿同一把锁——同一个线程重复加锁不能死锁。
    struct CapabilityTestGuard(Option<std::sync::MutexGuard<'static, ()>>);

    static CAPABILITY_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    thread_local! {
        static CAPABILITY_TEST_DEPTH: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    }

    fn capability_test_guard() -> CapabilityTestGuard {
        let depth = CAPABILITY_TEST_DEPTH.with(|d| d.get());
        if depth == 0 {
            let g = CAPABILITY_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            CAPABILITY_TEST_DEPTH.with(|d| d.set(1));
            CapabilityTestGuard(Some(g))
        } else {
            CAPABILITY_TEST_DEPTH.with(|d| d.set(depth + 1));
            CapabilityTestGuard(None)
        }
    }

    impl Drop for CapabilityTestGuard {
        fn drop(&mut self) {
            if self.0.is_some() {
                CAPABILITY_TEST_DEPTH.with(|d| d.set(0));
            }
        }
    }

    #[test]
    fn audit_records_success_and_permission_denial() {
        // **整段持锁**：连 `clear_plugin_audit()` 与断言都要在锁里，否则并行跑的另一条审计测试
        // 会在我们"清完还没断言"之间把环清掉（CI 上就是这样红的）。锁可重入，所以下面的测试
        // 装置还会再拿一次，不会死锁。
        let _g = capability_test_guard();
        clear_plugin_audit();

        // 被拒的调用也要留痕 —— 这恰恰是最该查的那类记录
        let denied = r#"register({ id: "t.audit", title: "A", description: "", closeOnRun: false,
  run: function(){ try { api.pages.count(); } catch (e) { return "caught"; } return "no-throw"; } });"#;
        let state = RunState {
            plugin_id: "auditp".to_string(),
            ..Default::default()
        };
        let (msg, ..) = run_command_in_host_for_test(denied, "t.audit", "", &state).unwrap();
        assert_eq!(msg, "caught");
        let rows: Vec<_> = plugin_audit(Some("auditp".to_string()), None)
            .into_iter()
            .filter(|r| r.capability != "host.run") // 运行记录是另一类，见 a_run_records_…
            .collect();
        assert_eq!(rows.len(), 1, "应当留下一条能力审计");
        assert!(!rows[0].ok);
        assert_eq!(rows[0].capability, "pages.count");
        assert_eq!(rows[0].scope, "current-space");
        assert_eq!(rows[0].error_code.as_deref(), Some("permission_denied"));

        // 授权后的成功调用
        let mut ok_state = state.clone();
        ok_state.permissions = vec!["read:pages".to_string()];
        let (msg, ..) = run_command_in_host_for_test(denied, "t.audit", "", &ok_state).unwrap();
        assert_eq!(msg, "no-throw");
        let rows: Vec<_> = plugin_audit(Some("auditp".to_string()), None)
            .into_iter()
            .filter(|r| r.capability != "host.run")
            .collect();
        assert_eq!(rows.len(), 2);
        assert!(rows[1].ok);
        assert_eq!(rows[1].error_code, None);

        clear_plugin_audit();
        assert!(plugin_audit(None, None).is_empty());
    }

    #[test]
    fn audit_is_scoped_per_plugin_and_capped() {
        let _g = capability_test_guard();
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
        let _g = capability_test_guard();
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
        assert!(
            list[0]["created_at"].as_i64().unwrap_or(0) > 0,
            "创建时间要给出来（插件判断「刚建的页面」只能靠它）：{list:?}"
        );

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
    fn blocks_list_defaults_to_the_current_page() {
        let (space, dir) = seed_space("blocks-current");
        let mut st = state_for_space(&space, &dir);
        // 当前打开的页面：插件拿不到 id（page.current 只给 content_json），
        // 所以"省略 pageId = 当前页"是这类能力唯一的用法。
        st.current_page_id = Some("p1".to_string());

        let blocks = call(&st, "blocks.list", r#"{"limit":10}"#).unwrap();
        assert!(blocks.is_array(), "省略 pageId 应当作用于当前页而不是报错：{blocks:?}");

        // 显式给了 id 也一样能用；没给 id 又没有当前页时才报错
        assert!(call(&st, "blocks.list", r#"{"pageId":"p1"}"#).is_ok());
        let mut no_page = state_for_space(&space, &dir);
        no_page.current_page_id = None;
        let err = call(&no_page, "blocks.list", "{}").unwrap_err();
        assert!(err.contains("bad_args"), "实际：{err}");
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
        let (msg, _insert, _toasts, drafts, _exports) = run_command_in_host_for_test(source, "w.one", "", &st).unwrap();
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

    #[test]
    fn property_and_tag_writes_are_also_drafts() {
        let (space, dir) = seed_space("write-pt");
        let mut st = state_for_space(&space, &dir);
        st.permissions = vec![
            "write:properties".to_string(),
            "write:tags".to_string(),
            "read:properties".to_string(),
        ];
        st.current_page_id = Some("p1".to_string());

        // 读属性定义（供插件找到 attrId）
        {
            let c = crate::db::open_space_conn_at(&space, &dir).unwrap();
            c.execute(
                "INSERT INTO attr_defs (id, name, type, options, sort_order, created_at, updated_at)
                 VALUES ('attr1','状态','select','[]',0,0,0)",
                [],
            )
            .unwrap();
        }
        let defs = call(&st, "properties.list", "{}").unwrap();
        assert_eq!(defs[0]["name"], "状态");
        assert_eq!(defs[0]["type"], "select");

        // 先记下落库前的真实状态（seed_space 里已有一页一标签，所以比"绝对值"不可靠）
        let before = {
            let c = crate::db::open_space_conn_at(&space, &dir).unwrap();
            let props: i64 = c.query_row("SELECT COUNT(*) FROM page_props", [], |r| r.get(0)).unwrap();
            let tags: i64 = c.query_row("SELECT COUNT(*) FROM page_tags", [], |r| r.get(0)).unwrap();
            (props, tags)
        };

        // 两个写能力都只产出草稿
        assert_eq!(call(&st, "properties.set", r#"{"attrId":"attr1","value":"进行中"}"#).unwrap()["drafted"], true);
        assert_eq!(call(&st, "tags.add", r#"{"name":"工作"}"#).unwrap()["drafted"], true);

        // 关键：草稿阶段不得落库（与落库前的状态逐项相同）
        {
            let c = crate::db::open_space_conn_at(&space, &dir).unwrap();
            let props: i64 = c.query_row("SELECT COUNT(*) FROM page_props", [], |r| r.get(0)).unwrap();
            let tags: i64 = c.query_row("SELECT COUNT(*) FROM page_tags", [], |r| r.get(0)).unwrap();
            assert_eq!((props, tags), before, "草稿阶段不该写入任何属性或标签");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn property_and_tag_drafts_carry_the_frontend_payload() {
        let (space, dir) = seed_space("write-pt-payload");
        let mut st = state_for_space(&space, &dir);
        st.permissions = vec!["write:properties".to_string(), "write:tags".to_string()];
        st.current_page_id = Some("p1".to_string());

        let source = r#"register({ id: "w.pt", title: "W", description: "", closeOnRun: false,
  run: function(){ api.properties.set("attr1", "进行中"); api.tags.add("工作"); return "ok"; } });"#;
        let (_msg, _insert, _toasts, drafts, _exports) = run_command_in_host_for_test(source, "w.pt", "", &st).unwrap();
        assert_eq!(drafts.len(), 2);
        assert_eq!(drafts[0].payload["kind"], "set_page_prop");
        assert_eq!(drafts[0].payload["attrId"], "attr1");
        assert_eq!(drafts[0].payload["value"], "进行中");
        assert_eq!(drafts[0].payload["pageId"], "p1");
        assert_eq!(drafts[1].payload["kind"], "add_tag");
        assert_eq!(drafts[1].payload["name"], "工作");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- 内存预算（分配炸弹） ----

    #[test]
    fn alloc_bomb_only_kills_that_invocation() {
        // Boa 侧设不了内存上限（无堆 API），所以由插件线程的限流分配器兜：
        // 一次要 100 MB（> 64 MiB 预算）应当被截断。`repeat` 的保护是
        // MAX_STRING_LENGTH ≈ 4 GB 的"规范形状"保护，不是预算，所以拦不住这个。
        let bomb = r#"register({ id: "t.bomb", title: "B", description: "", closeOnRun: false,
  run: function(){ return "x".repeat(1e8); } });"#;
        let err = run_command_in_host_for_test(bomb, "t.bomb", "", &RunState::default())
            .expect_err("分配炸弹应当失败而不是正常返回");
        assert!(
            err.contains("内存预算"),
            "应当报内存预算超限（说明是分配器拦下的），实际: {err}"
        );

        // 关键性质：**只终结这一次调用**。新调用是新线程 + 新预算，照常工作
        // ——能跑到这里就说明进程没有被 abort 掉。
        let ok = r#"register({ id: "t.ok", title: "O", description: "", closeOnRun: false,
  run: function(){ return "fine"; } });"#;
        let (msg, _, _, _, _) = run_command_in_host_for_test(ok, "t.ok", "", &RunState::default()).unwrap();
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
        let (msg, _insert, toasts, _drafts, _exports) = run_command_in_host_for_test(source, "t.toast", "", &state).unwrap();
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
        run_command_in_host_for_test(source, "t.log", "", &state).unwrap();
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

    // ---- 离线撤回列表（M11.11b 第一块）----

    /// 撤回表加进测试用的内存库（生产库里由 db.rs 建表）。
    fn state_conn_with_revocation() -> Connection {
        let c = state_conn();
        c.execute_batch(
            "CREATE TABLE meta.plugin_revocation (
                 plugin_id   TEXT PRIMARY KEY,
                 version     TEXT NOT NULL DEFAULT '',
                 reason      TEXT NOT NULL DEFAULT '',
                 revoked_at  TEXT NOT NULL DEFAULT '',
                 seen_at     INTEGER NOT NULL DEFAULT 0,
                 ignored_at  INTEGER
             );",
        )
        .unwrap();
        c
    }

    fn index_with(entries: Vec<crate::plugin_index::IndexEntry>) -> crate::plugin_index::PluginIndex {
        serde_json::from_value(serde_json::json!({
            "indexVersion": 1,
            "generatedAt": "2026-09-10T00:00:00Z",
            "plugins": entries,
        }))
        .unwrap()
    }

    fn index_entry(id: &str, version: &str, revoked: Option<(&str, &str)>) -> crate::plugin_index::IndexEntry {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "name": "P",
            "version": version,
            "downloadUrl": "https://example.com/p.zip",
            "sha256": "a".repeat(64),
            "revokedAt": revoked.map(|(at, _)| at),
            "revokedReason": revoked.map(|(_, why)| why).unwrap_or(""),
        }))
        .unwrap()
    }

    #[test]
    fn a_revocation_from_an_index_is_remembered() {
        let c = state_conn_with_revocation();
        let index = index_with(vec![
            index_entry("bad-one", "1.0.0", Some(("2026-09-01T00:00:00Z", "有严重漏洞"))),
            index_entry("fine", "1.0.0", None),
        ]);
        assert_eq!(record_revocations(&c, &index).unwrap(), 1, "只有被撤回的那条要记");
        let r = read_revocation(&c, "bad-one").expect("应当记住了");
        assert_eq!(r.version, "1.0.0");
        assert_eq!(r.reason, "有严重漏洞");
        assert!(!r.ignored);
        assert!(read_revocation(&c, "fine").is_none(), "没撤回的不该凭空冒出记忆");
    }

    #[test]
    fn the_memory_blocks_that_version_only_and_offline() {
        let c = state_conn_with_revocation();
        record_revocations(&c, &index_with(vec![index_entry("p1", "1.0.0", Some(("2026-09-01", "有问题")))])).unwrap();

        // 记忆里的那个版本：拦，且说清原因
        let why = revocation_blocks(&c, "p1", "1.0.0").expect("这个版本应当被拦");
        assert!(why.contains("撤回") && why.contains("有问题"), "{why}");
        // 修好的新版本：不拦（撤回撤的是那个版本，不是这个插件）
        assert!(revocation_blocks(&c, "p1", "1.1.0").is_none());
        // 别的插件：不拦
        assert!(revocation_blocks(&c, "p2", "1.0.0").is_none());
        // 没有原因时也要说得出话，而不是留空
        let c2 = state_conn_with_revocation();
        record_revocations(&c2, &index_with(vec![index_entry("p9", "2.0.0", Some(("2026-09-01", "")))])).unwrap();
        assert!(revocation_blocks(&c2, "p9", "2.0.0").unwrap().contains("没有写原因"));
    }

    #[test]
    fn the_user_can_explicitly_override_a_revocation() {
        let c = state_conn_with_revocation();
        record_revocations(&c, &index_with(vec![index_entry("p1", "1.0.0", Some(("2026-09-01", "有问题")))])).unwrap();
        assert!(revocation_blocks(&c, "p1", "1.0.0").is_some());

        // 用户说"我知道，仍然使用" → 不再拦（但记忆还在，界面照旧显示）
        c.execute(
            "UPDATE meta.plugin_revocation SET ignored_at = 1 WHERE plugin_id = 'p1'",
            [],
        )
        .unwrap();
        assert!(revocation_blocks(&c, "p1", "1.0.0").is_none());
        let r = read_revocation(&c, "p1").unwrap();
        assert!(r.ignored, "界面要能显示「你选择忽略过一次撤回」");
        assert_eq!(r.reason, "有问题", "忽略不等于删掉记忆");
    }

    #[test]
    fn refreshing_the_index_does_not_undo_the_users_override() {
        let c = state_conn_with_revocation();
        record_revocations(&c, &index_with(vec![index_entry("p1", "1.0.0", Some(("2026-09-01", "有问题")))])).unwrap();
        c.execute(
            "UPDATE meta.plugin_revocation SET ignored_at = 42 WHERE plugin_id = 'p1'",
            [],
        )
        .unwrap();
        // 再拉一次同一份索引（撤回条目还在）：用户的表态不能被悄悄改回去
        record_revocations(&c, &index_with(vec![index_entry("p1", "1.0.0", Some(("2026-09-02", "还是有问题")))])).unwrap();
        let r = read_revocation(&c, "p1").unwrap();
        assert!(r.ignored, "刷新索引不该复活已经忽略的撤回");
        assert_eq!(r.reason, "还是有问题", "原因要跟着索引更新");
        // 索引撤回了**另一个版本**：那是新的一条事实，仍然要拦（用户之前忽略的是旧版本）
        record_revocations(&c, &index_with(vec![index_entry("p1", "1.1.0", Some(("2026-09-03", "新版本也有问题")))])).unwrap();
        assert!(revocation_blocks(&c, "p1", "1.1.0").is_some());
    }

    #[test]
    fn run_gates_stop_disabled_pending_approval_and_revoked_plugins() {
        let c = state_conn_with_revocation();
        let small = manifest_with(&["read:pages"], &[], "1.0.0");
        // 默认启用、没有快照、没有撤回 → 放行
        assert!(run_gates(&c, &small).is_ok());

        // 1) 用户关了它（前端过滤只是方便，后端必须自己拦）
        set_enabled(&c, "p1", false, None).unwrap();
        assert!(run_gates(&c, &small).unwrap_err().contains("已被禁用"));
        set_enabled(&c, "p1", true, None).unwrap();

        // 2) 用户同意过的声明是 read:pages，现在文件被换成多一项的版本 → 拦
        write_approval(&c, "p1", &approval_snapshot(&small)).unwrap();
        let bigger = manifest_with(&["read:pages", "write:pages"], &[], "1.0.0");
        let err = run_gates(&c, &bigger).unwrap_err();
        assert!(err.contains("approval_required") && err.contains("write:pages"), "{err}");

        // 3) 索引撤回了这个版本 → 拦（离线也拦得住：这条记忆已经落库）
        record_revocations(
            &c,
            &index_with(vec![index_entry("p1", "1.0.0", Some(("2026-09-01", "有严重漏洞")))]),
        )
        .unwrap();
        let err = run_gates(&c, &small).unwrap_err();
        assert!(err.contains("plugin_revoked") && err.contains("有严重漏洞"), "{err}");
        // 用户点过「仍然使用」之后放行（记忆仍在，但不再拦）
        c.execute("UPDATE meta.plugin_revocation SET ignored_at = 1 WHERE plugin_id = 'p1'", [])
            .unwrap();
        assert!(run_gates(&c, &small).is_ok());
        // 撤回的是 1.0.0，装的是 1.1.0 → 不拦
        let c2 = state_conn_with_revocation();
        record_revocations(
            &c2,
            &index_with(vec![index_entry("p1", "1.0.0", Some(("2026-09-01", "x")))]),
        )
        .unwrap();
        assert!(run_gates(&c2, &manifest_with(&["read:pages"], &[], "1.1.0")).is_ok());
    }

    // ---- 发布者公钥固定（TOFU，M11.11b 第二块）----

    fn state_conn_with_trust_store() -> Connection {
        let c = state_conn_with_revocation();
        c.execute_batch(
            "CREATE TABLE meta.plugin_publisher_key (
                 plugin_id    TEXT PRIMARY KEY,
                 key_b64      TEXT NOT NULL,
                 fingerprint  TEXT NOT NULL,
                 source       TEXT NOT NULL DEFAULT '',
                 pinned_at    INTEGER NOT NULL DEFAULT 0
             );",
        )
        .unwrap();
        c
    }

    const KEY_A: &str = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
    const KEY_B: &str = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO2";

    #[test]
    fn a_publisher_key_is_pinned_once_and_compared_afterwards() {
        let c = state_conn_with_trust_store();
        // 第一次见到 → 固定（此时还没有任何信任记录）
        assert_eq!(
            publisher_key_verdict(&c, "p1", KEY_A).unwrap(),
            PublisherKeyVerdict::FirstPin
        );
        let pinned = pin_publisher_key(&c, "p1", KEY_A, "example.com").unwrap();
        assert_eq!(pinned.fingerprint, plugin_index::publisher_key_fingerprint(KEY_A).unwrap());
        assert_eq!(pinned.source, "example.com");
        // 同一把 key 再来 → 正常
        assert_eq!(
            publisher_key_verdict(&c, "p1", KEY_A).unwrap(),
            PublisherKeyVerdict::Match
        );
        // 换了 key → 拒，并且要把新旧指纹都摆出来（用户没法比对一串 base64）
        match publisher_key_verdict(&c, "p1", KEY_B).unwrap() {
            PublisherKeyVerdict::Changed { pinned_fingerprint, incoming_fingerprint } => {
                assert_ne!(pinned_fingerprint, incoming_fingerprint);
                assert_eq!(pinned_fingerprint, pinned.fingerprint);
            }
            other => panic!("换 key 必须判成 Changed，实际 {other:?}"),
        }
        // 别的插件不受影响
        assert_eq!(
            publisher_key_verdict(&c, "p2", KEY_B).unwrap(),
            PublisherKeyVerdict::FirstPin
        );
        // 索引没给签名（阶段 1 的索引）→ 不涉及
        assert_eq!(
            publisher_key_verdict(&c, "p1", "  ").unwrap(),
            PublisherKeyVerdict::None
        );
        // 形状不对的 key 要报错，而不是"算出一个指纹就固定下来"
        assert!(publisher_key_verdict(&c, "p1", "not-a-key").is_err());
    }

    /// 夹具：一个真包 + 两把不同的一次性密钥各自对它的签名（字节完全相同，
    /// 所以两份签名都对这个包成立——这正是"发布者换 key"该有的样子）。
    fn signed_package() -> &'static [u8] {
        include_bytes!("../tests/fixtures/signed-plugin.zip")
    }
    fn fixture_entry(key: &str, signature: &str, sha_hex: &str) -> crate::plugin_index::IndexEntry {
        serde_json::from_value(serde_json::json!({
            "id": "fixture-plugin",
            "name": "签名夹具插件",
            "version": "1.0.0",
            "downloadUrl": "https://example.com/p.zip",
            "size": signed_package().len(),
            "sha256": sha_hex,
            "publisherKey": key,
            "signature": signature,
        }))
        .unwrap()
    }

    #[test]
    fn a_real_signed_package_passes_and_a_tampered_one_does_not() {
        let c = state_conn_with_trust_store();
        let key_a = include_str!("../tests/fixtures/signed-plugin-zip.pub");
        let sig_a = include_str!("../tests/fixtures/signed-plugin.zip.minisig");
        let sha = {
            use sha2::{Digest, Sha256};
            let mut h = Sha256::new();
            h.update(signed_package());
            hex::encode(h.finalize())
        };
        let entry = fixture_entry(key_a, sig_a, &sha);

        // 第一次见到这把 key：验签通过，返回"装成功后固定它"
        let pin = check_entry_publisher_signature(&c, "fixture-plugin", &entry, signed_package(), false, "example.com")
            .unwrap();
        assert_eq!(pin.as_deref().map(str::trim), Some(key_a.trim()));

        // 包被改一个字节：先验签就拦下来（连 TOFU 都不必谈）
        let mut tampered = signed_package().to_vec();
        tampered[0] ^= 0x01;
        let err = check_entry_publisher_signature(&c, "fixture-plugin", &entry, &tampered, false, "example.com")
            .unwrap_err();
        assert!(err.contains("发布者签名校验失败"), "{err}");

        // 固定之后同一把 key 再来 → 不需要再固定（Match）
        pin_publisher_key(&c, "fixture-plugin", key_a, "example.com").unwrap();
        assert!(check_entry_publisher_signature(&c, "fixture-plugin", &entry, signed_package(), false, "example.com")
            .unwrap()
            .is_none());

        // 索引没声明发布者 key（阶段 1 的索引）→ 这一关整段跳过
        let no_key = fixture_entry("", "", &sha);
        assert!(check_entry_publisher_signature(&c, "fixture-plugin", &no_key, signed_package(), false, "example.com")
            .unwrap()
            .is_none());
    }

    #[test]
    fn a_changed_publisher_key_needs_explicit_consent_and_then_wins() {
        let c = state_conn_with_trust_store();
        let key_a = include_str!("../tests/fixtures/signed-plugin-zip.pub");
        let key_b = include_str!("../tests/fixtures/signed-plugin-alt-zip.pub");
        let sig_b = include_str!("../tests/fixtures/signed-plugin-alt.zip.minisig");
        // 用户已经固定了 A
        pin_publisher_key(&c, "fixture-plugin", key_a, "example.com").unwrap();
        let entry = fixture_entry(key_b, sig_b, &"a".repeat(64));

        // B 的签名本身是**真的**（同一个包、另一把 key）——所以拦下它的不是"验签失败"，
        // 而是"你固定过的不是这把"。这正是要被测的那条路。
        let err =
            check_entry_publisher_signature(&c, "fixture-plugin", &entry, signed_package(), false, "example.com")
                .unwrap_err();
        assert!(err.contains("publisher_key_changed"), "{err}");
        assert!(err.contains("发布者公钥变了"), "{err}");
        let fp_b = plugin_index::publisher_key_fingerprint(key_b).unwrap();
        assert!(err.contains(&fp_b), "报错里要给出新指纹：{err}");

        // 用户明确同意之后：固定被换成 B，且以后 A 反而成了"变了"的那一个
        assert!(check_entry_publisher_signature(&c, "fixture-plugin", &entry, signed_package(), true, "example.com")
            .unwrap()
            .is_none());
        assert_eq!(read_publisher_key(&c, "fixture-plugin").unwrap().fingerprint, fp_b);
        let entry_a = fixture_entry(key_a, include_str!("../tests/fixtures/signed-plugin.zip.minisig"), &"a".repeat(64));
        let err = check_entry_publisher_signature(&c, "fixture-plugin", &entry_a, signed_package(), false, "example.com")
            .unwrap_err();
        assert!(err.contains("publisher_key_changed"), "{err}");
    }

    /// 撤回表加进测试用的内存库（生产库里由 db.rs 建表）。
    fn state_conn_with_revoked_keys() -> Connection {
        let c = state_conn_with_trust_store();
        c.execute_batch(
            "CREATE TABLE meta.plugin_revoked_key (
                 fingerprint TEXT PRIMARY KEY,
                 key_b64     TEXT NOT NULL DEFAULT '',
                 reason      TEXT NOT NULL DEFAULT '',
                 revoked_at  TEXT NOT NULL DEFAULT '',
                 seen_at     INTEGER NOT NULL DEFAULT 0,
                 ignored_at  INTEGER
             );",
        )
        .unwrap();
        c
    }

    fn index_with_revoked(keys: Vec<(&str, &str)>) -> crate::plugin_index::PluginIndex {
        serde_json::from_value(serde_json::json!({
            "indexVersion": 1,
            "generatedAt": "2026-09-10T00:00:00Z",
            "revokedKeys": keys
                .iter()
                .map(|(k, why)| serde_json::json!({ "key": k, "reason": why, "revokedAt": "2026-09-01T00:00:00Z" }))
                .collect::<Vec<_>>(),
            "plugins": [{
                "id": "fixture-plugin",
                "name": "P",
                "version": "1.0.0",
                "downloadUrl": "https://example.com/p.zip",
                "sha256": "a".repeat(64),
            }],
        }))
        .unwrap()
    }

    #[test]
    fn a_revoked_publisher_key_is_remembered_and_blocks_that_key() {
        let c = state_conn_with_revoked_keys();
        let key_b = include_str!("../tests/fixtures/signed-plugin-alt-zip.pub");
        let fp_b = plugin_index::publisher_key_fingerprint(key_b).unwrap();

        assert_eq!(
            record_revoked_keys(&c, &index_with_revoked(vec![(key_b.trim(), "这把 key 泄露了")])).unwrap(),
            1
        );
        let r = read_revoked_key(&c, &fp_b).expect("应当记住了");
        assert_eq!(r.reason, "这把 key 泄露了");
        assert!(!r.ignored);

        // 这把 key 签的东西一律拒，且**离线也拒**（记忆已落库，不必再拉索引）
        let why = revoked_key_blocks(&c, key_b).expect("这把 key 应当被拦");
        assert!(why.contains(&fp_b) && why.contains("泄露"), "{why}");
        // 别的 key 不受影响
        let key_a = include_str!("../tests/fixtures/signed-plugin-zip.pub");
        assert!(revoked_key_blocks(&c, key_a).is_none());

        // 用户明确表态之后不再拦
        c.execute(
            "UPDATE meta.plugin_revoked_key SET ignored_at = 1 WHERE fingerprint = ?1",
            params![fp_b],
        )
        .unwrap();
        assert!(revoked_key_blocks(&c, key_b).is_none());
        assert!(read_revoked_key(&c, &fp_b).unwrap().ignored, "记忆还在，只是不再拦");
    }

    #[test]
    fn an_index_marks_entries_signed_by_a_revoked_key_as_not_installable() {
        let key_b = include_str!("../tests/fixtures/signed-plugin-alt-zip.pub");
        let index = plugin_index::parse_index(
            &serde_json::to_vec(
                &serde_json::from_value::<serde_json::Value>(serde_json::json!({
                    "indexVersion": 1,
                    "revokedKeys": [{ "key": key_b.trim(), "reason": "滥用" }],
                    "plugins": [{
                        "id": "fixture-plugin",
                        "name": "P",
                        "version": "1.0.0",
                        "apiVersion": "1.0.0",
                        "minAppVersion": "1.0.0",
                        "runtime": "logic",
                        "license": "MIT",
                        "downloadUrl": "https://example.com/p.zip",
                        "size": 10,
                        "sha256": "a".repeat(64),
                        "publisherKey": key_b.trim(),
                        "signature": "untrusted comment: x\nAAAA",
                    }],
                }))
                .unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
        let view = plugin_index::index_view(&index, "1.88.0", None);
        assert!(view.plugins[0].blocked.contains("发布者密钥已被索引撤回"), "{:?}", view.plugins[0].blocked);
        assert!(view.plugins[0].blocked.contains("滥用"));
        // 界面也要能看到"撤回了哪把 key"
        assert_eq!(view.revoked_keys.len(), 1);
        assert_eq!(
            view.revoked_keys[0].fingerprint,
            plugin_index::publisher_key_fingerprint(key_b).unwrap()
        );
    }

    #[test]
    fn the_run_gate_refuses_a_plugin_whose_publisher_key_was_revoked() {
        let c = state_conn_with_revoked_keys();
        let key_b = include_str!("../tests/fixtures/signed-plugin-alt-zip.pub");
        let manifest: Manifest = serde_json::from_value(serde_json::json!({
            "id": "fixture-plugin", "name": "P", "version": "1.0.0", "main": "main.js"
        }))
        .unwrap();
        pin_publisher_key(&c, "fixture-plugin", key_b, "example.com").unwrap();
        assert!(run_gates(&c, &manifest).is_ok(), "没撤回之前应当放行");

        record_revoked_keys(&c, &index_with_revoked(vec![(key_b.trim(), "泄露")])).unwrap();
        let err = run_gates(&c, &manifest).unwrap_err();
        assert!(err.contains("publisher_key_revoked") && err.contains("泄露"), "{err}");

        // 用户表态后放行；而换成另一把 key 的插件不受影响
        c.execute(
            "UPDATE meta.plugin_revoked_key SET ignored_at = 1",
            [],
        )
        .unwrap();
        assert!(run_gates(&c, &manifest).is_ok());
    }

    #[test]
    fn installing_a_package_signed_by_a_revoked_key_is_refused() {
        let c = state_conn_with_revoked_keys();
        let key_b = include_str!("../tests/fixtures/signed-plugin-alt-zip.pub");
        let sig_b = include_str!("../tests/fixtures/signed-plugin-alt.zip.minisig");
        let entry = fixture_entry(key_b, sig_b, &"a".repeat(64));
        record_revoked_keys(&c, &index_with_revoked(vec![(key_b.trim(), "泄露")])).unwrap();

        let err = check_entry_publisher_signature(&c, "fixture-plugin", &entry, signed_package(), false, "example.com")
            .unwrap_err();
        assert!(err.contains("publisher_key_revoked") && err.contains("不接受这份包"), "{err}");
        // 用户表态之后才可能装上（这里只验"放行到下一步"：不再是撤回拦的）
        c.execute("UPDATE meta.plugin_revoked_key SET ignored_at = 1", []).unwrap();
        assert!(check_entry_publisher_signature(&c, "fixture-plugin", &entry, signed_package(), false, "example.com")
            .is_ok());
    }

    #[test]
    fn accepting_a_new_publisher_key_replaces_the_pinned_one() {
        let c = state_conn_with_trust_store();
        pin_publisher_key(&c, "p1", KEY_A, "example.com").unwrap();
        assert!(matches!(
            publisher_key_verdict(&c, "p1", KEY_B).unwrap(),
            PublisherKeyVerdict::Changed { .. }
        ));
        // 用户点了「信任新密钥」→ 记录被换掉，此后按新的比
        let view = pin_publisher_key(&c, "p1", KEY_B, "example.com").unwrap();
        assert_eq!(view.fingerprint, plugin_index::publisher_key_fingerprint(KEY_B).unwrap());
        assert_eq!(
            publisher_key_verdict(&c, "p1", KEY_B).unwrap(),
            PublisherKeyVerdict::Match
        );
        // 旧 key 现在反而是"变了"
        assert!(matches!(
            publisher_key_verdict(&c, "p1", KEY_A).unwrap(),
            PublisherKeyVerdict::Changed { .. }
        ));
    }

    // ---- 事实清单（M11.11b 治理：只摆事实，不评分）----

    #[test]
    fn the_scan_reports_what_it_can_actually_see() {
        // 干净的小插件：一条事实都不该编出来
        assert!(scan_plugin_source("register({ id: 'a', run: function(){ return __pages(); } });").is_empty());

        // 动态代码
        let f = scan_plugin_source("var x = eval('1+1'); var y = new Function('return 1');");
        let dyn_fact = f.iter().find(|x| x.code == "dynamic_code").expect("要报出动态代码");
        assert!(dyn_fact.text.contains("eval( ×1"), "{}", dyn_fact.text);
        assert!(dyn_fact.text.contains("new Function( ×1"), "{}", dyn_fact.text);

        // 大段编码文本（放在一处不代表它是恶意的——事实就是"有这么一段"）
        let blob = "A".repeat(600);
        let f = scan_plugin_source(&format!("var data = '{blob}';"));
        let blob_fact = f.iter().find(|x| x.code == "embedded_blob").expect("要报出内嵌编码段");
        assert!(blob_fact.text.contains("600 字符"), "{}", blob_fact.text);
        // 短一点的编码串不报（避免噪音）
        let f = scan_plugin_source(&format!("var data = '{}';", "A".repeat(64)));
        assert!(f.iter().all(|x| x.code != "embedded_blob"));

        // 超长单行（压缩/打包产物）
        let f = scan_plugin_source(&format!("var a = 1;\nvar b = '{}';", "x".repeat(2500)));
        let line_fact = f.iter().find(|x| x.code == "long_line").expect("要报出超长单行");
        assert!(line_fact.text.contains("第 2 行"), "{}", line_fact.text);

        // 看起来在联网：报，并且说清"这一版没有联网能力"
        let f = scan_plugin_source("fetch('https://example.com')");
        let net = f.iter().find(|x| x.code == "network_hint").expect("要报出联网迹象");
        assert!(net.text.contains("没有任何联网能力"), "{}", net.text);
    }

    #[test]
    fn the_fact_sheet_says_what_kind_of_plugin_it_is() {
        // 零代码插件：一条事实就够（也是最重要的一条）
        let f = build_plugin_facts("declarative", 0, 1, 512, None, Some(false), "abcdef1234", "abcdef1234");
        // 内容一致性 + "零代码"这两条：对零代码插件同样成立（它的 manifest 也能被改）
        assert_eq!(f.len(), 2);
        assert_eq!(f[0].code, "content_unchanged");
        assert!(f[0].text.contains("abcdef12"), "要给出可核对的前缀：{}", f[0].text);
        assert_eq!(f[1].code, "no_code");
        assert!(f[1].text.contains("没有一行可执行的代码"));

        // 有代码的：体积事实 + 扫描事实
        let f = build_plugin_facts("logic", 1024, 3, 4096, Some("eval('x')"), Some(false), "aaa", "aaa");
        // 第一条是"内容有没有被改过"（对所有插件都成立），第二条才是体积
        assert_eq!(f[0].code, "content_unchanged");
        assert_eq!(f[1].code, "entry_size");
        assert!(f[1].text.contains("1024 字节"));
        assert!(f[1].text.contains("3 个文件"));
        assert!(f.iter().any(|x| x.code == "dynamic_code"));
    }

    // ---- 多源订阅（M11.11a：一组索引 URL，可增删）----

    fn state_conn_with_subscriptions() -> Connection {
        let c = state_conn_with_revoked_keys();
        c.execute_batch(
            "CREATE TABLE meta.plugin_index_subscription (
                 url            TEXT PRIMARY KEY,
                 pubkey         TEXT NOT NULL DEFAULT '',
                 label          TEXT NOT NULL DEFAULT '',
                 added_at       INTEGER NOT NULL DEFAULT 0,
                 last_checked_at INTEGER,
                 last_ok        INTEGER,
                 last_error     TEXT NOT NULL DEFAULT '',
                 plugin_count   INTEGER NOT NULL DEFAULT 0,
                 updates_available INTEGER NOT NULL DEFAULT 0
             );",
        )
        .unwrap();
        c
    }

    #[test]
    fn subscriptions_are_added_deduped_and_removed() {
        let c = state_conn_with_subscriptions();
        let now = now_ms();
        let add = |url: &str, key: &str, label: &str| {
            c.execute(
                "INSERT INTO plugin_index_subscription (url, pubkey, label, added_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(url) DO UPDATE SET pubkey = excluded.pubkey, label = excluded.label",
                params![url, key, label, now],
            )
            .unwrap();
        };
        add("https://a.test/index.json", "", "自托");
        add("https://b.test/index.json", KEY_A, "社区");
        assert_eq!(all_subscriptions(&c).len(), 2);

        // 同一个 URL 再加一次 = 更新公钥/备注，不是多一条
        add("https://a.test/index.json", KEY_A, "自托（带签名）");
        let subs = all_subscriptions(&c);
        assert_eq!(subs.len(), 2);
        let a = subs.iter().find(|s| s.url.contains("a.test")).unwrap();
        assert_eq!(a.label, "自托（带签名）");
        assert_eq!(a.pubkey, KEY_A);
        assert_eq!(a.last_ok, None, "还没查过就说「查过了」，那是编的");

        c.execute("DELETE FROM plugin_index_subscription WHERE url = ?1", params!["https://b.test/index.json"])
            .unwrap();
        assert_eq!(all_subscriptions(&c).len(), 1);
    }

    #[test]
    fn only_newer_versions_count_as_updates() {
        let index = index_with(vec![
            index_entry("newer", "2.0.0", None),
            index_entry("same", "1.0.0", None),
            index_entry("older", "1.0.0", None),
            index_entry("not-installed", "1.0.0", None),
        ]);
        let installed = vec![
            ("newer".to_string(), "1.0.0".to_string()),
            ("same".to_string(), "1.0.0".to_string()),
            ("older".to_string(), "2.0.0".to_string()),
        ];
        // 只有 newer 比已装的更新；same 是同版本（重装，不算更新）；older 是降级（不算）
        assert_eq!(count_updates(&index, &installed), 1);
        // 一个都没装 → 没有"更新"（那是新装）
        assert_eq!(count_updates(&index, &[]), 0);
        // 版本比不出来时不谎报"可更新"（install_action 会判成 Replace——这里如实跟着它）
        let vague = index_with(vec![index_entry("vague", "2.0", None)]);
        assert_eq!(count_updates(&vague, &[("vague".to_string(), "weird".to_string())]), 1);
    }

    /// 逐个检查的**真**验收：一个正常索引 + 一个 404，两条各自记各自的结果。
    ///
    /// 为什么必须在环回服务器上跑：这条命令的承诺是"一条失败不影响其它"，而那正是最容易
    /// 悄悄坏掉的地方（一个 `?` 提前返回、或者循环里把错误当成整批失败）。同时它还顺手
    /// 验证了另一个承诺：检查订阅会**刷新撤回记忆**（"它说了什么，我就记住什么"）。
    #[tokio::test]
    async fn checking_subscriptions_records_each_source_separately() {
        // 正常的那条：索引里有 2 个插件（一个比已装的更新），外加一条撤回
        let good = serve(vec![("/index.json", {
            serde_json::to_vec(&serde_json::json!({
                "indexVersion": 1,
                "generatedAt": "2026-09-11T00:00:00Z",
                "plugins": [
                    {
                        "id": "pkg-a", "name": "A", "version": "2.0.0",
                        "apiVersion": crate::capabilities_gen::API_VERSION,
                        "minAppVersion": "1.0.0", "runtime": "logic", "license": "MIT",
                        "downloadUrl": "https://e.test/a.zip", "size": 10, "sha256": "a".repeat(64),
                        "revokedAt": "2026-09-01T00:00:00Z", "revokedReason": "有严重漏洞",
                    },
                    {
                        "id": "pkg-b", "name": "B", "version": "1.0.0",
                        "apiVersion": crate::capabilities_gen::API_VERSION,
                        "minAppVersion": "1.0.0", "runtime": "logic", "license": "MIT",
                        "downloadUrl": "https://e.test/b.zip", "size": 10, "sha256": "b".repeat(64),
                    },
                ],
            }))
            .unwrap()
        })]).await;
        let bad = serve(vec![("/nothing.json", b"x".to_vec())]).await;

        let c = state_conn_with_subscriptions();
        // **坏的那条排在前面**（added_at 更大 = 更靠前）：顺序在这里是有意义的——
        // 如果实现里"一条失败就整批中断"，后面那条正常索引就根本不会被查到，
        // 于是断言会看到它的 last_ok 还是 None。把失败的放最后，这个 bug 就藏起来了。
        for (url, label, at) in [
            (format!("{bad}/index.json"), "坏的", 2i64),
            (format!("{good}/index.json"), "好的", 1i64),
        ] {
            c.execute(
                "INSERT INTO plugin_index_subscription (url, pubkey, label, added_at) VALUES (?1, '', ?2, ?3)",
                params![url, label, at],
            )
            .unwrap();
        }
        // 已装 pkg-a 1.0.0（索引里是 2.0.0 → 可更新），pkg-b 没装
        record_install(&c, "pkg-a", "1.0.0", "local", false, true, None).unwrap();

        let db = Db(std::sync::Mutex::new(c));
        let subs = all_subscriptions(&lock_db(&db.0));
        assert_eq!(subs.len(), 2);
        check_subscriptions_into(&db, &subs, "1.88.0").await;

        let after = all_subscriptions(&lock_db(&db.0));
        let good_row = after.iter().find(|s| s.url.contains(&good)).unwrap();
        assert_eq!(good_row.last_ok, Some(true));
        assert_eq!(good_row.plugin_count, 2);
        assert_eq!(good_row.updates_available, 1, "只有 pkg-a 比已装的更新");

        let bad_row = after.iter().find(|s| s.url.contains(&bad)).unwrap();
        assert_eq!(bad_row.last_ok, Some(false), "坏的那条要记成失败");
        assert!(
            bad_row.last_error.contains("404"),
            "失败原因要说得出是 HTTP 404：{}",
            bad_row.last_error
        );
        assert_eq!(
            good_row.last_ok,
            Some(true),
            "一条失败**不能**把另一条也拖下水"
        );

        // 顺带：检查订阅会把撤回记忆刷新一遍
        let revoked = read_revocation(&lock_db(&db.0), "pkg-a").expect("索引里的撤回应当被记住");
        assert_eq!(revoked.version, "2.0.0");
        assert_eq!(revoked.reason, "有严重漏洞");
    }

    #[test]
    fn a_failing_subscription_records_its_own_error() {
        let c = state_conn_with_subscriptions();
        // 只验"逐条记结果"这件事本身：直接照 check_plugin_index_subscriptions 的写法更新一行
        c.execute(
            "INSERT INTO plugin_index_subscription (url, pubkey, label, added_at) VALUES ('https://a.test/i.json', '', 'A', 1)",
            [],
        )
        .unwrap();
        c.execute(
            "UPDATE plugin_index_subscription SET last_checked_at = 2, last_ok = 0, last_error = '无法连接到 …' WHERE url = 'https://a.test/i.json'",
            [],
        )
        .unwrap();
        let s = read_subscription(&c, "https://a.test/i.json").unwrap();
        assert_eq!(s.last_ok, Some(false));
        assert!(s.last_error.contains("无法连接"));
        // 失败的记录不该把上一次成功的数字改掉（用户要看的是"上次成功时有多少"）
        assert_eq!(s.plugin_count, 0);
    }

    #[test]
    fn the_content_hash_is_stable_and_notices_real_changes() {
        let dir = temp_dir("hash-a");
        write_plugin_dir(&dir, "p1", "1.0.0", "register({id:'p1.a'});", &[("x.txt", "hello")]);
        let h1 = dir_content_hash(&dir).unwrap();
        // 同样的内容 → 同样的指纹（mtime 之类不该掺进来，否则每次读都"被改过"）
        std::thread::sleep(std::time::Duration::from_millis(20));
        assert_eq!(dir_content_hash(&dir).unwrap(), h1, "指纹必须只由内容决定");

        // 改一个字节
        std::fs::write(dir.join("x.txt"), "hellp").unwrap();
        assert_ne!(dir_content_hash(&dir).unwrap(), h1);
        std::fs::write(dir.join("x.txt"), "hello").unwrap();
        assert_eq!(dir_content_hash(&dir).unwrap(), h1, "改回去应当回到同一个指纹");

        // 加文件 / 删文件 / 改名（只hash内容的话改名会看不出来）
        std::fs::write(dir.join("y.txt"), "new").unwrap();
        assert_ne!(dir_content_hash(&dir).unwrap(), h1);
        std::fs::remove_file(dir.join("y.txt")).unwrap();
        std::fs::rename(dir.join("x.txt"), dir.join("z.txt")).unwrap();
        assert_ne!(dir_content_hash(&dir).unwrap(), h1, "改名也是变化");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_fact_sheet_says_whether_the_files_were_touched() {
        // 一致
        let same = build_plugin_facts("logic", 1, 1, 1, None, Some(false), "aaaaaaaa", "aaaaaaaa");
        assert!(same[0].text.contains("内容与安装时一致"));
        // 不一致：两个指纹都要给出来（用户要能自己对）
        let diff = build_plugin_facts("logic", 1, 1, 1, None, Some(true), "aaaa1111", "bbbb2222");
        assert!(diff[0].text.contains("内容与安装时不同"));
        assert!(diff[0].text.contains("aaaa1111") && diff[0].text.contains("bbbb2222"));
        // 没记过：**必须说出来**，否则会被读成"没被改过"
        let unknown = build_plugin_facts("logic", 1, 1, 1, None, None, "", "");
        assert!(unknown[0].text.contains("无法判断"));
    }

    #[test]
    fn all_revocations_lists_what_was_seen() {
        let c = state_conn_with_revocation();
        record_revocations(&c, &index_with(vec![
            index_entry("a", "1.0.0", Some(("2026-09-01", "x"))),
            index_entry("b", "2.0.0", Some(("2026-09-02", "y"))),
        ]))
        .unwrap();
        let all = all_revocations(&c);
        assert_eq!(all.len(), 2);
        assert!(all.iter().all(|r| !r.ignored));
    }

    // ---- 升级 / 重装（同名 id 再装一次）----

    #[test]
    fn install_action_only_refuses_a_provable_downgrade() {
        assert_eq!(install_action(None, "1.0.0"), InstallAction::Fresh);
        assert_eq!(install_action(Some("1.0.0"), "1.0.0"), InstallAction::Same);
        assert_eq!(install_action(Some("1.0.0"), "1.2.0"), InstallAction::Replace);
        // 逐段比较，不是字符串比较（1.10 > 1.9）
        assert_eq!(install_action(Some("1.9.0"), "1.10.0"), InstallAction::Replace);
        assert_eq!(install_action(Some("1.10.0"), "1.9.0"), InstallAction::Downgrade);
        // 预发布尾巴不参与主段比较
        assert_eq!(install_action(Some("1.0.0"), "1.0.1-rc.1"), InstallAction::Replace);

        // 比不出来（作者写 1.2 / v2 / 日期串）→ 不拒：那种情况下"谁更新"无从判断，
        // 而用户已经明确选了这份包。硬拒只留给能证明的降级。
        for (was, now) in [("1.2", "1.3"), ("v2", "1.0.0"), ("1.0.0", "v2"), ("2026.09", "2026.1")] {
            assert_eq!(
                install_action(Some(was), now),
                InstallAction::Replace,
                "{was} → {now} 不该被当成降级"
            );
        }
    }

    /// 写一个最小可用插件目录（`manifest.json` + 入口文件）。
    fn write_plugin_dir(dir: &Path, id: &str, version: &str, entry: &str, extra: &[(&str, &str)]) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(
            dir.join("manifest.json"),
            serde_json::json!({ "id": id, "name": "P", "version": version, "main": "main.js" })
                .to_string(),
        )
        .unwrap();
        std::fs::write(dir.join("main.js"), entry).unwrap();
        for (name, body) in extra {
            std::fs::write(dir.join(name), body).unwrap();
        }
    }

    #[test]
    fn replacing_an_installed_plugin_swaps_content_and_drops_removed_files() {
        let src = temp_dir("upgrade-src");
        let dest = temp_dir("upgrade-dest");
        write_plugin_dir(&dest, "p1", "1.0.0", "register({id:'p1.a'});", &[("legacy.txt", "old")]);
        write_plugin_dir(&src, "p1", "1.1.0", "register({id:'p1.a'});", &[("fresh.txt", "new")]);

        let manifest: Manifest = serde_json::from_value(serde_json::json!({
            "id": "p1", "name": "P", "version": "1.1.0", "main": "main.js"
        }))
        .unwrap();
        replace_plugin_dir(&src, &dest, &manifest).unwrap();

        assert!(dest.join("fresh.txt").exists(), "新版本的文件要到位");
        assert!(
            !dest.join("legacy.txt").exists(),
            "新版本里删掉的文件必须跟着消失——否则旧代码会以「没人再引用」的方式留在盘上"
        );
        let on_disk: Manifest =
            serde_json::from_str(&std::fs::read_to_string(dest.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(on_disk.version, "1.1.0");
        let _ = std::fs::remove_dir_all(&src);
        let _ = std::fs::remove_dir_all(&dest);
    }

    #[test]
    fn a_failed_replacement_rolls_back_to_the_old_version() {
        let src = temp_dir("upgrade-src-bad");
        let dest = temp_dir("upgrade-dest-keep");
        write_plugin_dir(&dest, "p1", "1.0.0", "register({id:'p1.a'});", &[("legacy.txt", "old")]);
        // 新版本的入口文件**不存在**：写盘过程中必然失败，正是要验的那条路
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(
            src.join("manifest.json"),
            serde_json::json!({ "id": "p1", "name": "P", "version": "2.0.0", "main": "main.js" }).to_string(),
        )
        .unwrap();

        let manifest: Manifest = serde_json::from_value(serde_json::json!({
            "id": "p1", "name": "P", "version": "2.0.0", "main": "main.js"
        }))
        .unwrap();
        let err = replace_plugin_dir(&src, &dest, &manifest).unwrap_err();
        assert!(err.contains("已回滚"), "失败必须回滚，且说清回滚了：{err}");

        // 磁盘上还是原来那一版，能跑的老插件不该被半装的新版本毁掉
        let on_disk: Manifest =
            serde_json::from_str(&std::fs::read_to_string(dest.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(on_disk.version, "1.0.0");
        assert!(dest.join("main.js").exists());
        assert!(dest.join("legacy.txt").exists());
        let _ = std::fs::remove_dir_all(&src);
        let _ = std::fs::remove_dir_all(&dest);
    }

    /// **线上那份托管索引**的端到端验收（默认忽略；要联网）。
    ///
    /// 与下面那条环回夹具测试互补：那条证明"这条链是通的"，这条证明"**线上真正托管的
    /// 那一份**也是通的"——用的是同一套生产代码（`index_http_client` / `http_get_capped` /
    /// 发布者签名校验 / `install_bytes_into` / 真 discovery），只是把夹具换成了公网地址。
    ///
    ///   SHUYONOTE_LIVE_INDEX=https://community.shuyo.cn/plugins/plugin-index.json \
    ///   SHUYONOTE_LIVE_PLUGIN=md-outline \
    ///     cargo test --lib live_hosted_index -- --ignored --nocapture
    ///
    /// 装进的是**临时插件根目录**（不碰用户的插件目录），所以随便跑。
    #[tokio::test]
    #[ignore]
    async fn live_hosted_index_installs_end_to_end() {
        // 社区索引的公钥（公开信息，写死在这里是为了可复现；要换就换这一处）
        const COMMUNITY_INDEX_PUBKEY: &str = "untrusted comment: minisign public key 305A2DFBAC0773C1\nRWTBcwes+y1aMIEdFdER5PCz4QsdYqVlBSMr6++SnWdoRUVI3DLcduK4\n";
        let index_url = std::env::var("SHUYONOTE_LIVE_INDEX")
            .unwrap_or_else(|_| "https://community.shuyo.cn/plugins/plugin-index.json".to_string());
        let wanted = std::env::var("SHUYONOTE_LIVE_PLUGIN").unwrap_or_else(|_| "md-outline".to_string());
        let pubkey = std::env::var("SHUYONOTE_LIVE_INDEX_PUBKEY").unwrap_or_else(|_| COMMUNITY_INDEX_PUBKEY.to_string());

        // 1) 拉索引并**验索引签名**（托管方签了就必须验得过）
        let (view, index) = load_plugin_index(&index_url, Some(&pubkey), "1.89.1")
            .await
            .expect("线上索引必须能拉取并通过索引签名校验");
        eprintln!("索引 OK：owner={} 插件 {} 个", view.owner.as_ref().map(|o| o.name.as_str()).unwrap_or("?"), index.plugins.len());

        // 2) 挑一个条目：**必须是"可安装"的**（被撤回/版本不够的会被拦住，这里直接失败更醒目）
        let entry = index
            .plugins
            .iter()
            .find(|p| p.id == wanted)
            .unwrap_or_else(|| panic!("索引里没有插件 {wanted}"))
            .clone();
        let blocked = plugin_index::entry_block_reason(&entry, "1.89.1", &index.revoked_keys);
        assert!(blocked.is_empty(), "{wanted} 装不了：{blocked}");

        // 3) 下载 + 两层校验（sha256 与发布者签名），并固定发布者密钥
        let client = index_http_client().unwrap();
        let bytes = http_get_capped(&client, &entry.download_url, plugin_index::MAX_PACKAGE_BYTES)
            .await
            .expect("线上包必须下载得到");
        plugin_index::verify_sha256(&bytes, &entry.sha256).expect("线上包 sha256 必须与索引一致");
        let conn = state_conn_with_revoked_keys();
        let pin = check_entry_publisher_signature(&conn, &entry.id, &entry, &bytes, false, "community.shuyo.cn")
            .expect("发布者签名必须验得过");
        assert!(pin.is_some(), "线上条目应当带发布者签名");

        // 4) 装进**临时**插件根目录：真解包 + 真 discovery + 真落盘 + 真记账
        let root = temp_dir("live-index-root");
        let meta = install_bytes_into(&root, &conn, &bytes, "index:community.shuyo.cn")
            .expect("从线上索引安装必须成功");
        assert_eq!(meta.id, wanted);
        assert!(!meta.enabled, "新装必须默认未启用（安装 ≠ 授权）");
        assert!(root.join(format!("{wanted}/manifest.json")).is_file(), "插件目录要就位");
        let _ = pin_publisher_key(&conn, &entry.id, pin.as_deref().unwrap(), "community.shuyo.cn");

        eprintln!(
            "端到端 OK：{} v{}（{} 字节）· 解出 {} 个命令 · 插件根目录 {}",
            meta.id,
            meta.version,
            bytes.len(),
            meta.commands.len(),
            root.display()
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // ---- 整条链跑一遍：索引 → 下载 → 校验 → 解包 → 装进插件目录 → 记账 ----
    //
    // 这是"分发"这件事最该有的一条测试：此前每一段都有自己的测试（索引解析、签名、sha256、
    // 解包、安装、记账），但**接起来**那一段只有人读过。所以这里把 `install_from_dir` 从
    // AppHandle 上解耦出来（改成吃"插件根目录 + 连接"），用真夹具、真环回 HTTP、真子进程
    // discovery 从头走到尾。

    #[tokio::test]
    async fn the_whole_chain_installs_a_signed_package_from_an_index() {
        use sha2::{Digest, Sha256};
        ensure_host_exe();

        let pkg = signed_package();
        let sha = {
            let mut h = Sha256::new();
            h.update(pkg);
            hex::encode(h.finalize())
        };
        let key_a = include_str!("../tests/fixtures/signed-plugin-zip.pub");
        let sig_a = include_str!("../tests/fixtures/signed-plugin.zip.minisig");
        // 包与索引分成两个服务器：索引里的 downloadUrl 必须写出**真实**地址，
        // 而端口要等服务起来才知道——所以先起"包"那台，拿到地址再拼索引。
        let pkg_base = serve(vec![("/pkg.zip", pkg.to_vec())]).await;
        let index_json = serde_json::to_vec(&serde_json::json!({
            "indexVersion": 1,
            "owner": { "id": "local", "name": "本机演示", "url": "http://127.0.0.1/" },
            "generatedAt": "2026-09-11T00:00:00Z",
            "plugins": [{
                "id": "fixture-plugin",
                "name": "签名夹具插件",
                "version": "1.0.0",
                "apiVersion": crate::capabilities_gen::API_VERSION,
                "minAppVersion": "1.0.0",
                "runtime": "logic",
                "description": "夹具",
                "publisher": "tester",
                "license": "MIT",
                "permissions": [{ "id": "read:pages", "reason": "读标题" }],
                "downloadUrl": format!("{pkg_base}/pkg.zip"),
                "size": pkg.len(),
                "sha256": sha,
                "publisherKey": key_a.trim(),
                "signature": sig_a,
            }],
        }))
        .unwrap();
        let base = serve(vec![("/index.json", index_json)]).await;

        // 1) 拉索引（并验签：这里不给索引公钥，所以只解析）
        let (view, index) = load_plugin_index(&format!("{base}/index.json"), None, "1.88.0")
            .await
            .unwrap();
        assert_eq!(view.plugins[0].blocked, "");
        let entry = index.plugins[0].clone();

        // 2) 下载 + 两层校验（sha256 与发布者签名）
        let client = index_http_client().unwrap();
        let bytes = http_get_capped(&client, &entry.download_url, plugin_index::MAX_PACKAGE_BYTES)
            .await
            .unwrap();
        plugin_index::verify_sha256(&bytes, &entry.sha256).unwrap();
        // 安装表 + 信任存储（生产库里由 db.rs 建；测试库里由前面几个 helper 建）
        let conn = state_conn_with_revoked_keys();
        let pin = check_entry_publisher_signature(&conn, "fixture-plugin", &entry, &bytes, false, "127.0.0.1")
            .unwrap();
        assert_eq!(pin.as_deref().map(str::trim), Some(key_a.trim()));

        // 3) 装进一个临时插件根目录（真解包 + 真 discovery + 真落盘 + 真记账）
        let root = temp_dir("chain-root");
        let meta = install_bytes_into(&root, &conn, &bytes, "index:127.0.0.1").unwrap();
        assert_eq!(meta.id, "fixture-plugin");
        assert_eq!(meta.version, "1.0.0");
        assert!(!meta.enabled, "新装必须默认未启用（安装 ≠ 授权）");
        assert_eq!(meta.replaced_version, None, "这是新装，不该报「替换了哪一版」");
        assert_eq!(meta.commands.len(), 1, "真跑了一遍 discovery，应当发现夹具里那个命令");
        assert!(root.join("fixture-plugin/manifest.json").is_file(), "插件目录要就位");

        // 4) 装成功之后才固定发布者密钥（并且能在库里查到）
        let pinned = pin_publisher_key(&conn, "fixture-plugin", &pin.unwrap(), "127.0.0.1").unwrap();
        assert_eq!(
            pinned.fingerprint,
            plugin_index::publisher_key_fingerprint(key_a).unwrap()
        );
        let (ver, src): (String, String) = conn
            .query_row(
                "SELECT version, source FROM plugin_install WHERE plugin_id = 'fixture-plugin'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(ver, "1.0.0");
        assert_eq!(src, "index:127.0.0.1", "来源要记成「从哪来的」，而不是笼统的 local");

        // 5) 同一份包再装一次：同版本 → 重装（替换），并且报出替换掉的那一版
        let again = install_from_dir(&root, &conn, &resolve_extracted(&bytes), "index:127.0.0.1");
        let again = again.unwrap();
        assert_eq!(again.replaced_version.as_deref(), Some("1.0.0"));
        // 降级要拒：把目录里的 manifest 改成更高的版本再装旧包
        let mut higher: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(root.join("fixture-plugin/manifest.json")).unwrap())
                .unwrap();
        higher["version"] = serde_json::json!("9.9.9");
        std::fs::write(
            root.join("fixture-plugin/manifest.json"),
            serde_json::to_vec(&higher).unwrap(),
        )
        .unwrap();
        let err = match install_bytes_into(&root, &conn, &bytes, "index:127.0.0.1") {
            Err(e) => e,
            Ok(_) => panic!("装了更旧的版本——降级必须被拒"),
        };
        assert!(err.contains("拒绝安装更旧的版本"), "{err}");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 解包到临时目录并返回真正的包根（测试里复用生产那两步）。
    fn resolve_extracted(bytes: &[u8]) -> PathBuf {
        let dir = plugin_index::package_temp_dir();
        plugin_index::extract_package(bytes, &dir).unwrap();
        plugin_index::resolve_package_root(&dir)
    }

    // ---- 索引安装（M11.11a）：下载与上限 ----

    /// 极小的回环 HTTP 服务器：只按路径回固定内容，用来测"下载这一层"。
    ///
    /// 只绑 127.0.0.1（正是 `check_source_url` 允许的那一种明文地址），不碰外网。
    /// `with_length = false` 时不发 `Content-Length` 就关连接：用来测"服务器不报长度、
    /// 只想慢慢灌"的那条路径（只看响应头的上限在这里是挡不住的）。
    async fn serve_full(routes: Vec<(&'static str, Vec<u8>, bool)>) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let routes = routes.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let path = req.split_whitespace().nth(1).unwrap_or("/").to_string();
                    let hit = routes
                        .iter()
                        .find(|(p, _, _)| *p == path)
                        .map(|(_, b, l)| (b.clone(), *l));
                    let (head, body) = match hit {
                        Some((b, true)) => (
                            format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                b.len()
                            ),
                            b,
                        ),
                        Some((b, false)) => (
                            "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_string(),
                            b,
                        ),
                        None => (
                            "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                                .to_string(),
                            Vec::new(),
                        ),
                    };
                    let _ = sock.write_all(head.as_bytes()).await;
                    let _ = sock.write_all(&body).await;
                    let _ = sock.flush().await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        format!("http://{addr}")
    }

    async fn serve(routes: Vec<(&'static str, Vec<u8>)>) -> String {
        serve_full(routes.into_iter().map(|(p, b)| (p, b, true)).collect()).await
    }

    fn index_body() -> Vec<u8> {
        format!(
            r#"{{"indexVersion":1,"owner":{{"id":"self","name":"自托","url":"http://127.0.0.1"}},
"generatedAt":"2026-09-10T00:00:00Z","plugins":[
{{"id":"weekly-report","name":"周报","version":"1.2.0","apiVersion":"{}","minAppVersion":"1.0.0",
"runtime":"logic","description":"d","publisher":"alice","license":"MIT",
"permissions":[{{"id":"read:pages","reason":"读标题"}}],
"downloadUrl":"https://example.com/p.zip","size":2048,"sha256":"{}"}}]}}"#,
            crate::capabilities_gen::API_VERSION,
            "a".repeat(64)
        )
        .into_bytes()
    }

    #[tokio::test]
    async fn download_stops_at_the_size_cap() {
        let base = serve_full(vec![
            ("/big.bin", vec![7u8; 512 * 1024], true),
            // 不发 Content-Length：只能靠"读的过程中"守住上限
            ("/stream.bin", vec![7u8; 512 * 1024], false),
        ])
        .await;
        let client = index_http_client().unwrap();
        // 上限之内的正常下载
        let ok = http_get_capped(&client, &format!("{base}/big.bin"), 1024 * 1024)
            .await
            .unwrap();
        assert_eq!(ok.len(), 512 * 1024);
        // 报了长度的：看响应头就拒，不必先收完
        let err = http_get_capped(&client, &format!("{base}/big.bin"), 64 * 1024)
            .await
            .unwrap_err();
        assert!(err.contains("超过体积上限") && !err.contains("已中止下载"), "{err}");
        // 不报长度的：必须在读取途中中止（只看响应头的实现会在这里放行）
        let err = http_get_capped(&client, &format!("{base}/stream.bin"), 64 * 1024)
            .await
            .unwrap_err();
        assert!(err.contains("已中止下载"), "{err}");
        // 404 要说清是 HTTP 状态，不是"解析失败"
        let err = http_get_capped(&client, &format!("{base}/nope.bin"), 1024)
            .await
            .unwrap_err();
        assert!(err.contains("HTTP 404"), "{err}");
    }

    #[tokio::test]
    async fn index_signature_state_is_reported_honestly() {
        let base = serve(vec![("/index.json", index_body())]).await;
        // 没给公钥：不验签，但必须如实说"没有验"（None），而不是假装验过
        let (view, index) = load_plugin_index(&format!("{base}/index.json"), None, "1.87.0")
            .await
            .unwrap();
        assert_eq!(view.signature_verified, None);
        assert_eq!(index.plugins.len(), 1);
        assert_eq!(view.plugins[0].blocked, "", "这条应当是可安装的");

        // 给了公钥却没签名文件 → 失败（fail closed，不能"取不到就当没要求"）
        let err = load_plugin_index(&format!("{base}/index.json"), Some("RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3"), "1.87.0")
            .await
            .unwrap_err();
        assert!(err.contains("取不到签名文件"), "{err}");

        // 签名文件是垃圾 → 明确报"签名不合法"
        let bad = serve(vec![
            ("/index.json", index_body()),
            ("/index.json.minisig", b"garbage".to_vec()),
        ])
        .await;
        let err = load_plugin_index(
            &format!("{bad}/index.json"),
            Some("RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3"),
            "1.87.0",
        )
        .await
        .unwrap_err();
        assert!(err.contains("签名不合法"), "{err}");

        // 真签名，但签的不是这份索引 → 必须拒（这就是"索引被改过"的样子）
        let sig_of_other_data = [
            "untrusted comment: signature from minisign secret key",
            "RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=",
            "trusted comment: timestamp:1556193335\tfile:test",
            "y/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==",
        ]
        .join("\n")
        .into_bytes();
        let mismatched = serve(vec![
            ("/index.json", index_body()),
            ("/index.json.minisig", sig_of_other_data),
        ])
        .await;
        let err = load_plugin_index(
            &format!("{mismatched}/index.json"),
            Some("RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3"),
            "1.87.0",
        )
        .await
        .unwrap_err();
        assert!(err.contains("签名校验失败"), "{err}");

        // 索引本身不合规（版本形状不对）→ 解析阶段就拒
        let broken = serve(vec![("/index.json", b"{\"indexVersion\":1,\"plugins\":[{\"id\":\"x\",\"version\":\"1\",\"downloadUrl\":\"https://e.com/p.zip\",\"sha256\":\"aa\"}]}".to_vec())]).await;
        let err = load_plugin_index(&format!("{broken}/index.json"), None, "1.87.0")
            .await
            .unwrap_err();
        assert!(!err.is_empty(), "不合规的索引要有明确报错");
    }

    #[tokio::test]
    async fn index_sources_must_be_https_before_any_network_call() {
        // 明文 http 的外网地址：在发请求**之前**就拒（因此不会真的联网）
        let err = load_plugin_index("http://example.com/index.json", None, "1.87.0")
            .await
            .unwrap_err();
        assert!(err.contains("https"), "{err}");
        let err = load_plugin_index("ftp://example.com/index.json", None, "1.87.0")
            .await
            .unwrap_err();
        assert!(err.contains("https://"), "{err}");
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
