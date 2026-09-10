// 本文件由 scripts/gen-capabilities.mjs 生成（源：capabilities/capabilities.json）——请勿手改。

use serde::Serialize;

/// 生成物：字段不全都在当前版本被读到，但它们是被门禁与后续能力档用到的事实。
#[allow(dead_code)]
#[derive(Debug, Clone, Copy)]
pub struct Capability {
    pub id: &'static str,
    pub kind: &'static str,
    pub scope: &'static str,
    pub permission: Option<&'static str>,
    pub since: &'static str,
    /// 写能力的中介方式：`draft`（落库前需用户确认）/ `immediate`（即时）/ `-`（非写）。
    pub mediate: &'static str,
    /// 实现函数名（在 plugins.rs 里），供 check-capabilities 做覆盖校验。
    pub rust: &'static str,
}

pub const API_VERSION: &str = "1.0.0";
pub const API_MAJOR: u32 = 1;

pub const CAPABILITIES: &[Capability] = &[
    Capability { id: "page.current", kind: "read", scope: "current-space", permission: Some("read:page.current"), since: "1.0.0", mediate: "-", rust: "cap_page_current" },
    Capability { id: "pages.count", kind: "read", scope: "current-space", permission: Some("read:pages"), since: "1.0.0", mediate: "-", rust: "cap_pages_count" },
    Capability { id: "pages.list", kind: "read", scope: "current-space", permission: Some("read:pages"), since: "1.0.0", mediate: "-", rust: "cap_pages_list" },
    Capability { id: "pages.get", kind: "read", scope: "current-space", permission: Some("read:pages"), since: "1.0.0", mediate: "-", rust: "cap_pages_get" },
    Capability { id: "pages.search", kind: "read", scope: "current-space", permission: Some("read:pages"), since: "1.0.0", mediate: "-", rust: "cap_pages_search" },
    Capability { id: "tags.list", kind: "read", scope: "current-space", permission: Some("read:tags"), since: "1.0.0", mediate: "-", rust: "cap_tags_list" },
    Capability { id: "blocks.list", kind: "read", scope: "current-space", permission: Some("read:pages"), since: "1.0.0", mediate: "-", rust: "cap_blocks_list" },
    Capability { id: "backlinks.list", kind: "read", scope: "current-space", permission: Some("read:backlinks"), since: "1.0.0", mediate: "-", rust: "cap_backlinks_list" },
    Capability { id: "files.list", kind: "read", scope: "current-space", permission: Some("read:files"), since: "1.0.0", mediate: "-", rust: "cap_files_list" },
    Capability { id: "editor.insertText", kind: "write", scope: "current-space", permission: Some("write:page.current"), since: "1.0.0", mediate: "immediate", rust: "cap_editor_insert_text" },
    Capability { id: "pages.create", kind: "write", scope: "current-space", permission: Some("write:pages"), since: "1.0.0", mediate: "draft", rust: "cap_pages_create" },
    Capability { id: "blocks.append", kind: "write", scope: "current-space", permission: Some("write:pages"), since: "1.0.0", mediate: "draft", rust: "cap_blocks_append" },
    Capability { id: "user.notify", kind: "host", scope: "app", permission: None, since: "1.0.0", mediate: "-", rust: "cap_user_notify" },
    Capability { id: "kv.get", kind: "read", scope: "app", permission: Some("kv:own"), since: "1.0.0", mediate: "-", rust: "cap_kv_get" },
    Capability { id: "kv.set", kind: "write", scope: "app", permission: Some("kv:own"), since: "1.0.0", mediate: "immediate", rust: "cap_kv_set" },
    Capability { id: "kv.remove", kind: "write", scope: "app", permission: Some("kv:own"), since: "1.0.0", mediate: "immediate", rust: "cap_kv_remove" },
    Capability { id: "settings.get", kind: "read", scope: "app", permission: Some("kv:own"), since: "1.0.0", mediate: "-", rust: "cap_settings_get" },
    Capability { id: "properties.list", kind: "read", scope: "current-space", permission: Some("read:properties"), since: "1.0.0", mediate: "-", rust: "cap_properties_list" },
    Capability { id: "properties.set", kind: "write", scope: "current-space", permission: Some("write:properties"), since: "1.0.0", mediate: "draft", rust: "cap_properties_set" },
    Capability { id: "tags.add", kind: "write", scope: "current-space", permission: Some("write:tags"), since: "1.0.0", mediate: "draft", rust: "cap_tags_add" },
    Capability { id: "log.write", kind: "host", scope: "app", permission: None, since: "1.0.0", mediate: "-", rust: "cap_log_write" },
    Capability { id: "files.export", kind: "write", scope: "app", permission: Some("export:files"), since: "1.0.0", mediate: "draft", rust: "cap_files_export" },
];

/// 权限清单（manifest 校验 + 旧 manifest 无 permissions 时的基线授权 + 安装界面展示用）。
#[allow(dead_code)]
#[derive(Debug, Clone, Copy)]
pub struct Permission {
    pub id: &'static str,
    pub title: &'static str,
    pub risk: &'static str,
}

pub const PERMISSION_LIST: &[Permission] = &[
    Permission { id: "read:page.current", title: "读取当前页正文", risk: "low" },
    Permission { id: "read:pages", title: "读取本空间页面统计", risk: "low" },
    Permission { id: "write:page.current", title: "向当前页写入纯文本", risk: "low" },
    Permission { id: "read:tags", title: "读取本空间标签", risk: "low" },
    Permission { id: "read:backlinks", title: "读取反链", risk: "low" },
    Permission { id: "read:files", title: "读取附件元数据", risk: "low" },
    Permission { id: "kv:own", title: "存储自己的数据", risk: "low" },
    Permission { id: "write:pages", title: "新建页面 / 追加内容", risk: "medium" },
    Permission { id: "read:properties", title: "读取属性定义", risk: "low" },
    Permission { id: "write:properties", title: "设置页面属性", risk: "medium" },
    Permission { id: "write:tags", title: "给页面加标签", risk: "medium" },
    Permission { id: "export:files", title: "把内容保存成文件", risk: "medium" },
];

pub fn permission(id: &str) -> Option<&'static Permission> {
    PERMISSION_LIST.iter().find(|p| p.id == id)
}

/// 全部权限 id（基线授权用）。
#[allow(dead_code)]
pub fn permission_ids() -> Vec<&'static str> {
    PERMISSION_LIST.iter().map(|p| p.id).collect()
}

/// v1 之前的老全局名 → 能力 id（脚本检查用，运行时由宿主直接注册为别名）。
#[allow(dead_code)]
pub const LEGACY_GLOBALS: &[(&str, &str)] = &[
    ("__get_current_page", "page.current"),
    ("__pages", "pages.count"),
    ("__toast", "user.notify"),
    ("__insert", "editor.insertText"),
];

/// 一个事件：`id` 是 manifest `events[].on` 用的名字。
#[derive(Serialize, Clone, Debug)]
pub struct PluginEvent {
    pub id: &'static str,
    pub title: &'static str,
    pub desc: &'static str,
    pub since: &'static str,
    /// 宿主是否已经在发这个事件。**没接的不会进类型包**，且校验器会如实告知订阅者。
    pub hosted: bool,
}

pub const EVENTS: &[PluginEvent] = &[
    PluginEvent { id: "app.started", title: "应用启动", desc: "应用启动完成、插件已加载后触发一次", since: "1.0.0", hosted: true },
    PluginEvent { id: "space.switched", title: "切换空间", desc: "切换到另一个空间后触发（payload: spaceId）", since: "1.0.0", hosted: true },
    PluginEvent { id: "page.opened", title: "打开页面", desc: "打开一个页面后触发（payload: pageId）", since: "1.0.0", hosted: true },
    PluginEvent { id: "page.saved", title: "页面已保存", desc: "页面内容或标题保存后触发（payload: pageId, title）", since: "1.0.0", hosted: true },
    PluginEvent { id: "page.deleted", title: "页面已删除", desc: "页面被删除后触发（payload: pageId）", since: "1.0.0", hosted: true },
    PluginEvent { id: "import.finished", title: "导入完成", desc: "一次附件导入结束后触发（payload: count = 导入了几份、pageId = 导到哪一页；封面/画布这类不属于页面的导入为 null）", since: "1.0.0", hosted: true },
    PluginEvent { id: "sync.completed", title: "同步完成", desc: "一次同步结束后触发（payload: pushed, pulled = 本次推送/拉取的变更数；整次调用失败时不发）", since: "1.0.0", hosted: true },
];

/// 一个触发面：命令能出现在哪里（作者在 `register({ menus })` 里声明）。
#[derive(Serialize, Clone, Debug)]
pub struct PluginMenu {
    pub id: &'static str,
    pub title: &'static str,
    /// 宿主是否已经接了这个入口。**没接的值会被如实告知作者**，而不是静默丢掉。
    pub hosted: bool,
    pub desc: &'static str,
}

pub const MENUS: &[PluginMenu] = &[
    PluginMenu { id: "slash", title: "编辑器「/」菜单", hosted: true, desc: "在编辑器里输入 / 就能选到；适合「写到一半要跑一下」的命令" },
    PluginMenu { id: "page.context", title: "页面右键菜单", hosted: true, desc: "页面列表里那一行的「⋯」菜单（在行上右键同样是它）：你的命令会拿到**被点的那一页**作为当前页" },
    PluginMenu { id: "file.context", title: "附件右键菜单", hosted: false, desc: "在附件/文件上右键（宿主还没接这个入口）" },
    PluginMenu { id: "editor.toolbar", title: "编辑器工具栏", hosted: false, desc: "编辑器顶部工具栏按钮（宿主还没接这个入口）" },
];

/// 一个可主题化的 CSS 变量。
#[derive(Serialize, Clone, Debug)]
pub struct ThemeToken {
    pub name: &'static str,
    /// `color` / `length`：值的形态检查据此做。
    pub kind: &'static str,
    pub desc: &'static str,
}

pub const THEME_TOKENS: &[ThemeToken] = &[
    ThemeToken { name: "--bg", kind: "color", desc: "主背景" },
    ThemeToken { name: "--bg-sidebar", kind: "color", desc: "侧栏背景" },
    ThemeToken { name: "--text", kind: "color", desc: "正文色" },
    ThemeToken { name: "--text-dim", kind: "color", desc: "次要文字" },
    ThemeToken { name: "--text-faint", kind: "color", desc: "更浅的文字" },
    ThemeToken { name: "--border", kind: "color", desc: "边框" },
    ThemeToken { name: "--border-strong", kind: "color", desc: "较重的边框" },
    ThemeToken { name: "--hover", kind: "color", desc: "悬停底色" },
    ThemeToken { name: "--hover-strong", kind: "color", desc: "较重的悬停底色" },
    ThemeToken { name: "--card-bg", kind: "color", desc: "卡片背景" },
    ThemeToken { name: "--code-bg", kind: "color", desc: "行内代码背景" },
    ThemeToken { name: "--codeblock-bg", kind: "color", desc: "代码块背景" },
    ThemeToken { name: "--accent", kind: "color", desc: "强调色" },
    ThemeToken { name: "--accent-strong", kind: "color", desc: "强调色（深）" },
    ThemeToken { name: "--accent-soft", kind: "color", desc: "强调色（浅）" },
    ThemeToken { name: "--danger", kind: "color", desc: "危险色" },
    ThemeToken { name: "--cat-red", kind: "color", desc: "分类色·红" },
    ThemeToken { name: "--cat-orange", kind: "color", desc: "分类色·橙" },
    ThemeToken { name: "--cat-yellow", kind: "color", desc: "分类色·黄" },
    ThemeToken { name: "--cat-green", kind: "color", desc: "分类色·绿" },
    ThemeToken { name: "--cat-blue", kind: "color", desc: "分类色·蓝" },
    ThemeToken { name: "--cat-purple", kind: "color", desc: "分类色·紫" },
    ThemeToken { name: "--radius", kind: "length", desc: "圆角" },
    ThemeToken { name: "--radius-sm", kind: "length", desc: "小圆角" },
];

pub fn theme_token(name: &str) -> Option<&'static ThemeToken> {
    THEME_TOKENS.iter().find(|t| t.name == name)
}

pub fn menu(id: &str) -> Option<&'static PluginMenu> {
    MENUS.iter().find(|m| m.id == id)
}

/// 一种导入触发：manifest `triggers[].kind` 只能填这里有的值。
///
/// 与 `menus` 同一类事实（作者声明 → 宿主渲染一个入口），所以同样放在注册表里：
/// 校验器据此区分「kind 不认识」（错误）与「kind 认识但宿主还没接」（提醒）。
#[derive(Serialize, Clone, Debug)]
pub struct PluginTrigger {
    pub id: &'static str,
    pub title: &'static str,
    /// 宿主是否已经接了这个触发。
    pub hosted: bool,
    pub desc: &'static str,
}

pub const TRIGGERS: &[PluginTrigger] = &[
    PluginTrigger { id: "import", title: "导入文件", hosted: true, desc: "命令面板里按扩展名出现；用户选中文件后宿主读成文本，把 { fileName, content } 交给你的命令" },
    PluginTrigger { id: "export", title: "导出文件", hosted: true, desc: "命令面板里按扩展名出现；跑这条命令时插件用 api.files.export 登记内容，宿主逐个弹保存对话框（用户点保存才写）" },
];

pub fn trigger(id: &str) -> Option<&'static PluginTrigger> {
    TRIGGERS.iter().find(|t| t.id == id)
}

/// 按 id 找事件（manifest 声明校验用）。
pub fn event(id: &str) -> Option<&'static PluginEvent> {
    EVENTS.iter().find(|e| e.id == id)
}

pub fn lookup(id: &str) -> Option<&'static Capability> {
    CAPABILITIES.iter().find(|c| c.id == id)
}
