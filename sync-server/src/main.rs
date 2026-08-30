// ShuyoNote sync-server entrypoint. S1 refactor: split the original single-file
// `main.rs` into modules (db / auth / space / sync / attachments / audit) so the
// multi-user + per-space work (S2–S9) can proceed without a giant file. Behaviour
// is unchanged from v1.1.0; `auth.rs`/`space.rs`/`audit.rs` are placeholders.
mod attachments;
mod auth;
mod db;
mod space;
mod sync;
mod audit;

use axum::{
    middleware,
    routing::{get, post},
    Router,
};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tower_http::cors::CorsLayer;

use db::AppState;

fn parse_args() -> (u16, PathBuf) {
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
    (port, db_path)
}

#[tokio::main]
async fn main() {
    let (port, db_path) = parse_args();

    let conn = db::init_db(&db_path).expect("failed to init db");
    let attachments_dir = db::init_attachment_dir(&db_path);

    let state = AppState {
        db: Arc::new(Mutex::new(conn)),
        attachments_dir: Arc::new(attachments_dir.clone()),
    };

    // `/auth/logout` is protected by the bearer-token middleware; keep it in its
    // own router so the auth layer only wraps this one route (push/pull/attachments
    // stay unauthenticated until S5/S6 wire up per-space access control).
    let auth_routes = Router::new()
        .route("/auth/logout", post(auth::logout))
        .route_layer(middleware::from_fn_with_state(state.clone(), auth::auth_user));

    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/push", post(sync::push))
        .route("/pull", get(sync::pull))
        .route("/attachments", get(attachments::list_attachments))
        .route("/attachments/{hash}", post(attachments::upload_attachment))
        .route("/attachments/{hash}", get(attachments::download_attachment))
        .route("/auth/register", post(auth::register))
        .route("/auth/login", post(auth::login))
        .merge(auth_routes)
        .with_state(state)
        .layer(CorsLayer::permissive());

    let addr = format!("0.0.0.0:{port}");
    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind failed");
    println!("ShuyoNote sync server listening on http://{addr}");
    println!("DB: {}", db_path.display());
    println!("Attachments: {}", attachments_dir.display());
    axum::serve(listener, app).await.expect("server error");
}
