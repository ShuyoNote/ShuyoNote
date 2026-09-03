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
