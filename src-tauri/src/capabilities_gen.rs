// 本文件由 scripts/gen-capabilities.mjs 生成（源：capabilities/capabilities.json）——请勿手改。

/// 生成物：字段不全都在当前版本被读到，但它们是被门禁与后续能力档用到的事实。
#[allow(dead_code)]
#[derive(Debug, Clone, Copy)]
pub struct Capability {
    pub id: &'static str,
    pub kind: &'static str,
    pub scope: &'static str,
    pub permission: Option<&'static str>,
    pub since: &'static str,
    /// 实现函数名（在 plugins.rs 里），供 check-capabilities 做覆盖校验。
    pub rust: &'static str,
}

pub const API_VERSION: &str = "1.0.0";
pub const API_MAJOR: u32 = 1;

pub const CAPABILITIES: &[Capability] = &[
    Capability { id: "page.current", kind: "read", scope: "current-space", permission: Some("read:page.current"), since: "1.0.0", rust: "cap_page_current" },
    Capability { id: "pages.count", kind: "read", scope: "current-space", permission: Some("read:pages"), since: "1.0.0", rust: "cap_pages_count" },
    Capability { id: "editor.insertText", kind: "write", scope: "current-space", permission: Some("write:page.current"), since: "1.0.0", rust: "cap_editor_insert_text" },
    Capability { id: "user.notify", kind: "host", scope: "app", permission: None, since: "1.0.0", rust: "cap_user_notify" },
    Capability { id: "log.write", kind: "host", scope: "app", permission: None, since: "1.0.0", rust: "cap_log_write" },
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

pub fn lookup(id: &str) -> Option<&'static Capability> {
    CAPABILITIES.iter().find(|c| c.id == id)
}
