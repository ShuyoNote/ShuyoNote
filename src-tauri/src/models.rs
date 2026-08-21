use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PageMeta {
    pub id: String,
    pub workspace_id: String,
    pub parent_id: Option<String>,
    pub title: String,
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
    #[serde(default = "default_kind")]
    pub kind: String,
    pub sort_order: f64,
    pub created_at: i64,
    pub updated_at: i64,
}

fn default_kind() -> String {
    "page".to_string()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SearchResult {
    pub id: String,
    pub title: String,
    pub snippet: String,
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
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BoardColumn {
    pub tag: Option<Tag>,
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
