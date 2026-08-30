// Attachment content-addressed endpoints: list metadata, upload, download.
// Per-space bucket / access checks will be added in S6 (space_id + permission).
use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::IntoResponse,
    Json,
};
use futures_util::StreamExt;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::path::{Path as FsPath, PathBuf};
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;

use crate::db::AppState;

#[derive(Serialize)]
pub struct AttachmentItem {
    pub hash: String,
    pub mime: String,
}

#[derive(Serialize)]
pub struct AttachmentList {
    pub items: Vec<AttachmentItem>,
}

fn hash_file_path(dir: &FsPath, hash: &str) -> PathBuf {
    dir.join(hash)
}

pub async fn list_attachments(State(state): State<AppState>) -> Result<Json<AttachmentList>, StatusCode> {
    let conn = state.db.lock().expect("db mutex poisoned");
    let mut stmt = conn
        .prepare("SELECT hash, mime FROM attachment_meta ORDER BY hash ASC")
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let rows = stmt
        .query_map([], |row| {
            Ok(AttachmentItem {
                hash: row.get(0)?,
                mime: row.get(1)?,
            })
        })
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let items = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(AttachmentList { items }))
}

#[derive(Deserialize)]
pub struct UploadQuery {
    pub mime: Option<String>,
}

pub async fn upload_attachment(
    State(state): State<AppState>,
    Path(hash): Path<String>,
    Query(query): Query<UploadQuery>,
    body: Body,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if hash.is_empty() || hash.len() > 128 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(StatusCode::BAD_REQUEST);
    }
    // Dedup: skip write if already present (still drain the incoming body).
    let path = state.attachments_dir.join(&hash);
    if path.exists() {
        let mut stream = body.into_data_stream();
        while stream.next().await.is_some() {}
    } else {
        let tmp = state.attachments_dir.join(format!("{hash}.part"));
        let mut file = tokio::fs::File::create(&tmp).await.map_err(|e| {
            eprintln!("create tmp: {e}");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;
        let mut stream = body.into_data_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| StatusCode::BAD_REQUEST)?;
            file.write_all(&chunk).await.map_err(|e| {
                eprintln!("write: {e}");
                StatusCode::INTERNAL_SERVER_ERROR
            })?;
        }
        file.flush().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        drop(file);
        std::fs::rename(&tmp, &path).map_err(|e| {
            eprintln!("rename: {e}");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;
    }
    let mime = query.mime.unwrap_or_else(|| "application/octet-stream".to_string());
    let conn = state.db.lock().expect("db mutex poisoned");
    conn.execute(
        "INSERT OR IGNORE INTO attachment_meta (hash, mime) VALUES (?1, ?2)",
        params![hash, mime],
    )
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn download_attachment(
    State(state): State<AppState>,
    Path(hash): Path<String>,
) -> Result<impl IntoResponse, StatusCode> {
    let path = hash_file_path(state.attachments_dir.as_ref(), &hash);
    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    let stream = ReaderStream::new(file);
    let body = Body::from_stream(stream);
    Ok(([(header::CONTENT_TYPE, "application/octet-stream")], body))
}
