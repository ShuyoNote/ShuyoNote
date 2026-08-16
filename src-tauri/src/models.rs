use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PageMeta {
    pub id: String,
    pub workspace_id: String,
    pub parent_id: Option<String>,
    pub title: String,
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
    pub sort_order: f64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SearchResult {
    pub id: String,
    pub title: String,
    pub snippet: String,
}
