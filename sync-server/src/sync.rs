// Outbox change-log sync endpoints: `/push` (write changes) and `/pull` (read
// changes after a sequence cursor). Multi-user / per-space scope will be added
// in S3–S5 (space_id + permission). Behaviour matches the original single-file
// server.
use axum::{extract::{Query, State}, Json, http::StatusCode};
use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::db::AppState;

#[derive(Deserialize)]
pub struct OutgoingChange {
    pub device_seq: i64,
    pub entity: String,
    pub entity_id: String,
    pub op: String,
    pub payload: Option<String>,
    pub updated_at: i64,
}

#[derive(Deserialize)]
pub struct PushRequest {
    pub device_id: String,
    pub changes: Vec<OutgoingChange>,
}

#[derive(Serialize)]
pub struct IncomingChange {
    pub seq: i64,
    pub entity: String,
    pub entity_id: String,
    pub op: String,
    pub payload: Option<String>,
    pub updated_at: i64,
}

#[derive(Serialize)]
pub struct PullResponse {
    pub changes: Vec<IncomingChange>,
}

#[derive(Deserialize)]
pub struct PullQuery {
    pub since: Option<i64>,
    pub limit: Option<i64>,
}

pub async fn push(
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

pub async fn pull(
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
