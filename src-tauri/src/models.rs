use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PageMeta {
    pub id: String,
    pub workspace_id: String,
    pub parent_id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default = "default_kind")]
    pub kind: String,
    pub sort_order: f64,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PageDetail {
    pub id: String,
    pub workspace_id: String,
    pub parent_id: Option<String>,
    pub title: String,
    pub content_json: String,
    pub content_text: String,
    #[serde(default)]
    pub cover: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default = "default_cover_height")]
    pub cover_height: i64,
    /// Cover background vertical position (0-100%). 上下拖动定位题头图。
    #[serde(default = "default_cover_pos")]
    pub cover_pos: f64,
    #[serde(default = "default_kind")]
    pub kind: String,
    pub sort_order: f64,
    pub created_at: i64,
    pub updated_at: i64,
}

fn default_kind() -> String {
    "page".to_string()
}

fn default_cover_height() -> i64 {
    300
}

fn default_cover_pos() -> f64 {
    50.0
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorkspaceMeta {
    pub id: String,
    pub name: String,
    /// Accent color (hex) for the space switcher/header; empty = default theme.
    #[serde(default)]
    pub theme: Option<String>,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub sort_order: f64,
    pub created_at: i64,
    pub updated_at: i64,
    /// ⭐ **空间分类**：`"personal"` ／ `"team"` ／ `""`（未分类）。
    ///
    /// ⚠️ **2026-10-10 加**（owner 口径：「**个人空间没有服务器，就不显示**」）：
    /// 界面要按它判那个同步标识显不显示 —— 而这一格原先**到不了渲染层**
    /// （`workspaces.rs` 的 `WS_COLS` 没选 `kind`，TS `WorkspaceMeta` 也没这个字段）⇒ 补上 ✓。
    /// ⚠️ 数据库里是 `TEXT NOT NULL DEFAULT ''`（`db.rs` 建表处）⇒ 不会为 NULL ✓。
    /// ⛔ 判据不看这一格的**文案**，只看"个人 ⇒ 不显示"（`src/lib/syncTag.test.ts`）✓。
    #[serde(default)]
    pub kind: String,
    /// ⭐ **这个空间的库在磁盘上是不是密文**（2026-10-10 加，`task-27`：owner「加密空间要做个特殊标识」）。
    ///
    /// ⚠️ 语义**只有这一条**：`Some(true)` ＝ 磁盘上是密文 ／ `Some(false)` ＝ 明文 ／
    /// **`None` ＝ 读不到**（连 app data 目录都拿不到 ⇒ 拼不出库路径）⇒ 界面**不显示**那个标识 ✓，
    /// ⛔ 不许当成"没加密" ✗（`#[serde(default)]` ⇒ 老形状／缺字段也落在 `None` ✓）。
    /// ⚠️ 判定规则**只有一处**：`crate::security::space_db_is_encrypted`（只读头 16 字节 ✓）——
    ///   它与 `space_security_overview` 的 `encrypted_on_disk` **同源**（⛔ 不是第二份规则 ✗，
    ///   只是第二个**调用点** ✓）。
    /// ⚠️ 它**不是** `meta.workspaces` 的列（是**文件系统**上的事实）⇒ ⛔ 不进 `WS_COLS` ✗。
    #[serde(default)]
    pub encrypted_on_disk: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TemplateMeta {
    pub id: String,
    pub name: String,
    pub category: String,
    pub kind: String,
    pub icon: String,
    pub cover: String,
    pub summary: String,
    pub content_json: String,
    pub content_text: String,
    #[serde(default)]
    pub database_json: String,
    #[serde(default)]
    pub built_in: i64,
    pub space_id: Option<String>,
    pub sort_order: f64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DbViewMeta {
    pub id: String,
    pub db_page_id: String,
    pub name: String,
    pub view_type: String,
    #[serde(default)]
    pub config: String,
    pub sort_order: f64,
    pub created_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SearchResult {
    pub id: String,
    pub title: String,
    pub snippet: String,
    /// Workspace name, populated when searching across all workspaces.
    #[serde(default)]
    pub space: Option<String>,
    /// Workspace id the result belongs to (for "全空间" clicking to jump there).
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// M20 打磨 — 语义相关度（越大越相关，0 = 未提供/无语义分）。
    #[serde(default)]
    pub score: f32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AttachmentMeta {
    pub id: String,
    pub name: String,
    pub hash: String,
    pub mime: String,
    pub size: i64,
    /// Local file path for display via convertFileSrc.
    pub path: String,
}

/// 文件管理**列表**用的一行：`AttachmentMeta` 的全部字段（`#[serde(flatten)]`，线上形状**向后兼容**，
/// 只是多两个）＋ 表格里那两列时间。
///
/// 为什么单开一个结构而不往 `AttachmentMeta` 上加字段：后者有 **9 处构造点**
/// （导入 / 重命名 / 解析单条 / PDF 列表 / 保存图片…），只为"文件管理这两列"去动 9 处既没必要、
/// 也更容易在**跑不了 `cargo test`** 的机器上引入低级错。`flatten` 让前端不必改既有的
/// `AttachmentMeta` 类型（新增字段可选），其它命令的返回形状也一个字节不变。
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AttachmentRow {
    #[serde(flatten)]
    pub meta: AttachmentMeta,
    /// DB 里 `attachments.created_at`（毫秒）。**总是有值**（该列 NOT NULL）。
    pub created_at: i64,
    /// **本地文件**的 mtime（毫秒）。字节还没下载到本机时是 **0**，前端据此显示「—」——
    /// 表里没有 `updated_at`，所以这一列只能**说实话**：本地副本的修改时间，没有就是没有。
    pub mtime: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Tag {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub page_count: i64,
    /// Custom tag color (hex). None = deterministic auto color.
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BoardColumn {
    pub tag: Option<Tag>,
    pub pages: Vec<PageMeta>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BoardGroup {
    pub id: String,
    pub name: String,
    pub pages: Vec<PageMeta>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AttrDef {
    pub id: String,
    pub name: String,
    pub attr_type: String,
    #[serde(default)]
    pub options: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PageProp {
    pub attr_id: String,
    pub name: String,
    pub attr_type: String,
    pub value: String,
    #[serde(default)]
    pub options: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DatabaseRow {
    pub page_id: String,
    pub title: String,
    pub values: std::collections::HashMap<String, String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DatabaseQuery {
    pub columns: Vec<AttrDef>,
    pub rows: Vec<DatabaseRow>,
}
