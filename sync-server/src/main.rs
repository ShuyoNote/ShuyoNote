use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use futures_util::StreamExt;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path as FsPath, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;

#[derive(Clone)]
struct AppState {
    db: Arc<Mutex<Connection>>,
    attachments_dir: Arc<PathBuf>,
}

#[derive(Deserialize)]
struct OutgoingChange {
    device_seq: i64,
    entity: String,
    entity_id: String,
    op: String,
    payload: Option<String>,
    updated_at: i64,
}

#[derive(Deserialize)]
struct PushRequest {
    device_id: String,
    changes: Vec<OutgoingChange>,
}

#[derive(Serialize)]
struct IncomingChange {
    seq: i64,
    entity: String,
    entity_id: String,
    op: String,
    payload: Option<String>,
    updated_at: i64,
}

#[derive(Serialize)]
struct PullResponse {
    changes: Vec<IncomingChange>,
}

#[derive(Deserialize)]
struct PullQuery {
    since: Option<i64>,
    limit: Option<i64>,
}

fn init_db(path: &PathBuf) -> rusqlite::Result<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("failed to create db dir");
    }
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS changes (
            seq         INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id   TEXT NOT NULL,
            device_seq  INTEGER NOT NULL,
            entity      TEXT NOT NULL,
            entity_id   TEXT NOT NULL,
            op          TEXT NOT NULL,
            payload     TEXT,
            updated_at  INTEGER NOT NULL,
            UNIQUE(device_id, device_seq)
        );
        CREATE INDEX IF NOT EXISTS idx_changes_seq ON changes(seq);

        CREATE TABLE IF NOT EXISTS attachment_meta (
            hash TEXT PRIMARY KEY,
            mime TEXT NOT NULL
        );
        "#,
    )?;
    Ok(conn)
}

async fn push(
    State(state): State<AppState>,
    Json(req): Json<PushRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let conn = state.db.lock().expect("db mutex poisoned");
    let mut count = 0usize;
    for change in req.changes {
        conn.execute(
            "INSERT OR IGNORE INTO changes (device_id, device_seq, entity, entity_id, op, payload, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                req.device_id,
                change.device_seq,
                change.entity,
                change.entity_id,
                change.op,
                change.payload,
                change.updated_at
            ],
        )
        .map_err(|e| {
            eprintln!("push insert error: {e}");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;
        count += 1;
    }
    Ok(Json(serde_json::json!({ "ok": true, "accepted": count })))
}

async fn pull(
    State(state): State<AppState>,
    Query(query): Query<PullQuery>,
) -> Result<Json<PullResponse>, StatusCode> {
    let since = query.since.unwrap_or(0);
    let limit = query.limit.unwrap_or(500).clamp(1, 1000);

    let conn = state.db.lock().expect("db mutex poisoned");
    let mut stmt = conn
        .prepare(
            "SELECT seq, entity, entity_id, op, payload, updated_at
             FROM changes WHERE seq > ?1 ORDER BY seq ASC LIMIT ?2",
        )
        .map_err(|e| {
            eprintln!("pull prepare error: {e}");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

    let rows = stmt
        .query_map(params![since, limit], |row| {
            Ok(IncomingChange {
                seq: row.get(0)?,
                entity: row.get(1)?,
                entity_id: row.get(2)?,
                op: row.get(3)?,
                payload: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })
        .map_err(|e| {
            eprintln!("pull query error: {e}");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

    let changes = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(PullResponse { changes }))
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut port: u16 = 8787;
    let mut db_path: PathBuf = std::env::temp_dir().join("shuyonote-sync-server.db");

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--port" => {
                if let Some(v) = args.get(i + 1) {
                    port = v.parse().unwrap_or(8787);
                    i += 1;
                }
            }
            "--db" => {
                if let Some(v) = args.get(i + 1) {
                    db_path = PathBuf::from(v);
                    i += 1;
                }
            }
            _ => {}
        }
        i += 1;
    }

    let conn = init_db(&db_path).expect("failed to init db");
    let attachments_dir = db_path
        .parent()
        .map(|p| p.join("attachments"))
        .unwrap_or_else(|| PathBuf::from("attachments"));
    std::fs::create_dir_all(&attachments_dir).expect("failed to create attachments dir");

    let state = AppState {
        db: Arc::new(Mutex::new(conn)),
        attachments_dir: Arc::new(attachments_dir.clone()),
    };

    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/push", post(push))
        .route("/pull", get(pull))
        .route("/attachments", get(list_attachments))
        .route("/attachments/{hash}", post(upload_attachment))
        .route("/attachments/{hash}", get(download_attachment))
        .with_state(state)
        .layer(tower_http::cors::CorsLayer::permissive());

    let addr = format!("0.0.0.0:{port}");
    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind failed");
    println!("ShuyoNote sync server listening on http://{addr}");
    println!("DB: {}", db_path.display());
    println!("Attachments: {}", attachments_dir.display());
    axum::serve(listener, app).await.expect("server error");
}

// ---- attachment endpoints ----

#[derive(Serialize)]
struct AttachmentItem {
    hash: String,
    mime: String,
}

#[derive(Serialize)]
struct AttachmentList {
    items: Vec<AttachmentItem>,
}

fn hash_file_path(dir: &FsPath, hash: &str) -> PathBuf {
    dir.join(hash)
}

async fn list_attachments(State(state): State<AppState>) -> Result<Json<AttachmentList>, StatusCode> {
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
struct UploadQuery {
    mime: Option<String>,
}

async fn upload_attachment(
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

async fn download_attachment(
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
