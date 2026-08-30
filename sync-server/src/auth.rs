// S3 — user registration / login / logout + bearer-token auth middleware.
//
// Tokens are 32 random bytes (hex-encoded), stored in `sessions` with a 30-day
// TTL. Passwords are hashed with argon2id. `auth_user` resolves `Authorization:
// Bearer <token>` into a `UserId` + `SessionToken` for downstream handlers.
//
// HA note: when scaling past a single instance, swap `sessions` for stateless
// JWT (see docs-private/team-edition-implementation.md §9.1); the middleware
// boundary here is what makes that swap a drop-in.
use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{
    extract::{Request, State},
    http::{header, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use rand::RngCore;
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;

use crate::db::AppState;

const SESSION_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000; // 30 days

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn random_bytes(n: usize) -> Vec<u8> {
    let mut bytes = vec![0u8; n];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes
}

fn gen_token() -> String {
    hex::encode(random_bytes(32))
}

fn gen_id() -> String {
    hex::encode(random_bytes(16))
}

fn hash_password(password: &str) -> Result<String, StatusCode> {
    let salt = SaltString::generate(&mut rand::rngs::OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

fn verify_password(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash)
        .map(|h| Argon2::default().verify_password(password.as_bytes(), &h).is_ok())
        .unwrap_or(false)
}

/// Identity injected by `auth_user` into request extensions. Consumed by the
/// per-space handlers in S4/S5 (currently only injected, hence the allow).
#[derive(Clone)]
#[allow(dead_code)]
pub struct UserId(pub String);

/// The raw bearer token injected by `auth_user` (so `/auth/logout` can revoke it).
#[derive(Clone)]
pub struct SessionToken(pub String);

#[derive(Deserialize)]
pub struct AuthRequest {
    email: String,
    password: String,
    display: Option<String>,
}

#[derive(serde::Serialize)]
pub struct AuthResponse {
    token: String,
}

fn issue_session(conn: &rusqlite::Connection, user_id: &str) -> Result<String, StatusCode> {
    let token = gen_token();
    conn.execute(
        "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)",
        params![token, user_id, now_ms(), now_ms() + SESSION_TTL_MS],
    )
    .map_err(|e| {
        eprintln!("issue_session: {e}");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    Ok(token)
}

pub async fn register(
    State(state): State<AppState>,
    Json(req): Json<AuthRequest>,
) -> Result<Json<AuthResponse>, StatusCode> {
    let email = req.email.trim().to_lowercase();
    if email.is_empty() || req.password.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let password_hash = hash_password(&req.password)?;
    let conn = state.db.lock().expect("db mutex poisoned");

    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM users WHERE email = ?1)",
            params![email],
            |r| r.get(0),
        )
        .map_err(|e| {
            eprintln!("register exists: {e}");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;
    if exists {
        return Err(StatusCode::CONFLICT);
    }

    let user_id = gen_id();
    conn.execute(
        "INSERT INTO users (id, email, display, password, role, created_at)
         VALUES (?1, ?2, ?3, ?4, 'member', ?5)",
        params![user_id, email, req.display, password_hash, now_ms()],
    )
    .map_err(|e| {
        eprintln!("register insert: {e}");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;

    let token = issue_session(&conn, &user_id)?;
    Ok(Json(AuthResponse { token }))
}

pub async fn login(
    State(state): State<AppState>,
    Json(req): Json<AuthRequest>,
) -> Result<Json<AuthResponse>, StatusCode> {
    let email = req.email.trim().to_lowercase();
    let conn = state.db.lock().expect("db mutex poisoned");

    let (id, hash): (String, String) = conn
        .query_row(
            "SELECT id, password FROM users WHERE email = ?1 AND disabled_at IS NULL",
            params![email],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| {
            eprintln!("login query: {e}");
            StatusCode::INTERNAL_SERVER_ERROR
        })?
        .ok_or(StatusCode::UNAUTHORIZED)?;

    if !verify_password(&req.password, &hash) {
        return Err(StatusCode::UNAUTHORIZED);
    }

    let token = issue_session(&conn, &id)?;
    Ok(Json(AuthResponse { token }))
}

pub async fn logout(
    State(state): State<AppState>,
    axum::extract::Extension(SessionToken(token)): axum::extract::Extension<SessionToken>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let conn = state.db.lock().expect("db mutex poisoned");
    conn.execute("DELETE FROM sessions WHERE token = ?1", params![token])
        .map_err(|e| {
            eprintln!("logout delete: {e}");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// Resolve `Authorization: Bearer <token>` → active session → inject `UserId`
/// and `SessionToken`. Returns 401 when missing, unknown, or expired.
///
/// The DB lookup is isolated in a synchronous helper so the `MutexGuard` never
/// lives across the `next.run(...).await` point (a non-`Send` guard across an
/// await would make the middleware future non-`Send` and fail to compile).
fn resolve_user(state: &AppState, token: &str) -> Result<String, StatusCode> {
    let conn = state.db.lock().expect("db mutex poisoned");
    match conn
        .query_row(
            "SELECT user_id FROM sessions WHERE token = ?1 AND expires_at > ?2",
            params![token, now_ms()],
            |r| r.get::<_, String>(0),
        )
        .optional()
    {
        Ok(Some(id)) => Ok(id),
        Ok(None) => Err(StatusCode::UNAUTHORIZED),
        Err(e) => {
            eprintln!("auth_user query: {e}");
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

pub async fn auth_user(
    State(state): State<AppState>,
    mut req: Request,
    next: Next,
) -> Response {
    let token = match req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        Some(t) => t,
        None => return StatusCode::UNAUTHORIZED.into_response(),
    };

    let user_id = match resolve_user(&state, &token) {
        Ok(id) => id,
        Err(status) => return status.into_response(),
    };

    req.extensions_mut().insert(UserId(user_id));
    req.extensions_mut().insert(SessionToken(token));
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_hash_roundtrips() {
        let hash = hash_password("correct horse battery staple").unwrap();
        assert!(verify_password("correct horse battery staple", &hash));
        assert!(!verify_password("wrong", &hash));
    }

    #[test]
    fn token_and_id_are_unique_hex() {
        let a = gen_token();
        let b = gen_token();
        assert_ne!(a, b);
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));

        let id = gen_id();
        assert_eq!(id.len(), 32);
    }
}
