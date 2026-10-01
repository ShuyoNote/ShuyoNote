//! 探针：**一次真实网格窗口的 `/mesh/pull` 在线上到底多少字节**（评估用；默认不跑）
//!
//! 跑法：`cd src-tauri && cargo test --lib mesh_wire_bytes -- --ignored --nocapture`
//!
//! ⚠️ **本文件不改 `mesh.rs`**（那是 AMD 的写域 ✓）——它只读 `crate::mesh` 的 crate 内公开面
//!    （`mod mesh` 是**私有**的 ⇒ 外部 crate 拿不到 ⇒ 探针必须在本 crate 里，但可以放**新文件** ✓）。
//!
//! 为什么要有它：B2 的流量模型里，"一次空轮询"这个数是**拆两半估**出来的
//!   （请求用 reqwest 单发 ＋ 响应照 `respond()` 重建）。本探针把它变成**真窗口、真 reqwest、
//!   真 HTTP** 那一条 —— 而且顺手量准"客户端实际用的 reqwest 版本"到底发多少字节（B2 那半量错了版本 ✗）。
//!
//! 口径：计数代理夹在 client 与 window 之间，两个方向的字节都数 ⇒ **应用层真实字节** ✓
//!   ⚠️ 不含 TCP/IP 头与 ACK（那部分仍要另行推算 ✓）。

use crate::mesh::{start, MeshConfig};
use rusqlite::Connection;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

/// 计数代理：`client → proxy → window`，两个方向分别累加。
fn spawn_counting_proxy(upstream: SocketAddr) -> (u16, Arc<AtomicUsize>, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let up = Arc::new(AtomicUsize::new(0));
    let down = Arc::new(AtomicUsize::new(0));
    let (u, d) = (up.clone(), down.clone());
    std::thread::spawn(move || {
        for sock in listener.incoming() {
            let Ok(client) = sock else { continue };
            let (u, d) = (u.clone(), d.clone());
            std::thread::spawn(move || {
                let Ok(server) = TcpStream::connect(upstream) else { return };
                let (mut cr, mut sw) = (client.try_clone().unwrap(), server.try_clone().unwrap());
                let uc = u.clone();
                let t = std::thread::spawn(move || {
                    let mut buf = [0u8; 65536];
                    loop {
                        match cr.read(&mut buf) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                uc.fetch_add(n, Ordering::Relaxed);
                                if sw.write_all(&buf[..n]).is_err() {
                                    break;
                                }
                            }
                        }
                    }
                    let _ = sw.shutdown(std::net::Shutdown::Write);
                });
                let (mut sr, mut cw) = (server, client);
                let mut buf = [0u8; 65536];
                loop {
                    match sr.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            d.fetch_add(n, Ordering::Relaxed);
                            if cw.write_all(&buf[..n]).is_err() {
                                break;
                            }
                        }
                    }
                }
                let _ = cw.shutdown(std::net::Shutdown::Write);
                let _ = t.join();
            });
        }
    });
    (port, up, down)
}

/// 与 `mesh.rs` 测试里 `conn_with` **同一形状**的夹具（迁移 ＋ `meta` 挂库 ＋ 设备身份）。
fn conn_with(device: &str) -> Connection {
    let c = Connection::open_in_memory().unwrap();
    crate::db::migrate(&c, "ws").unwrap();
    c.execute_batch("ATTACH DATABASE ':memory:' AS meta").unwrap();
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS meta.sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS meta.sync_profiles (
             ws_id TEXT PRIMARY KEY,
             server_url TEXT NOT NULL DEFAULT '',
             token TEXT NOT NULL DEFAULT '',
             space_id TEXT NOT NULL DEFAULT '',
             last_pushed_seq INTEGER NOT NULL DEFAULT 0,
             last_pulled_seq INTEGER NOT NULL DEFAULT 0,
             sync_attachments INTEGER NOT NULL DEFAULT 1
         );",
    )
    .unwrap();
    crate::sync::set_meta_state(&c, "device_id", device).unwrap();
    c
}

/// 造一条"像真 CRDT 增量"的载荷：带大量引号（JSON 转义因此会膨胀）
fn payload_of(target_raw: usize) -> String {
    let unit = r#"{"op":"replace","path":["root","children",0,"children",1],"value":"一段中文文本，用来模拟真实的增量载荷。"}"#;
    let mut s = String::with_capacity(target_raw + unit.len());
    while s.len() < target_raw {
        s.push_str(unit);
    }
    s
}

#[tokio::test]
#[ignore = "评估用探针：起真网格窗口 + 真 HTTP，量线上字节；默认不跑"]
async fn mesh_pull_wire_bytes() {
    let space = "space-wire";
    let token = "wire-token";
    let device = "dev-wire";

    let conn = Arc::new(Mutex::new(conn_with(device)));
    {
        let c = conn.lock().unwrap();
        for i in 1..=10i64 {
            let p = payload_of(10_000);
            c.execute(
                "INSERT INTO changes (device_id, device_seq, entity, entity_id, op, payload, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![
                    device,
                    i,
                    "page",
                    format!("91f96e7f-c789-4689-968e-e8c60417dd{:02}", i),
                    "update",
                    p,
                    crate::db::now_ms(),
                ],
            )
            .unwrap();
        }
    }

    // \u2b50 U8\uff1a\u4e00\u6247\u95e8\u53ea\u670d\u52a1\u8fd9\u4e00\u4e2a\u7a7a\u95f4 \u21d2 `start` \u6536\u7684\u662f**\u8fde\u63a5\u8868**\uff08\u952e\uff1d`proto_space`\uff09\u2713
    let win = start(
        MeshConfig {
            bind: "127.0.0.1:0".into(),
            device_id: device.into(),
            token: Some(token.into()),
            data_dir: None,
        },
        {
            let mut m = std::collections::HashMap::new();
            m.insert(space.to_string(), conn.clone());
            Arc::new(Mutex::new(m))
        },
    )
    .unwrap();
    let upstream = win.addr();
    let (proxy_port, up, down) = spawn_counting_proxy(upstream);

    println!("\n============ mesh /mesh/pull 线上字节 ============");
    println!("窗口 {upstream} ｜ 计数代理 127.0.0.1:{proxy_port} ｜ reqwest = 本 crate 的直接依赖版本");
    println!("库里有 10 条记录，每条原始 payload ≈ 10,000 B（带大量引号）");

    let client = reqwest::Client::new();
    let cases: [(&str, i64); 4] = [
        ("空轮询（游标已在最前）", 10),
        ("拉 1 条", 9),
        ("拉 5 条", 5),
        ("拉 10 条", 0),
    ];

    for (label, since) in cases {
        up.store(0, Ordering::Relaxed);
        down.store(0, Ordering::Relaxed);
        let url = format!(
            "http://127.0.0.1:{proxy_port}/mesh/pull?space_id={space}&since={since}&limit=1000"
        );
        let resp = client
            .get(&url)
            .bearer_auth(token)
            .send()
            .await
            .expect("请求失败");
        let status = resp.status();
        let body = resp.text().await.unwrap();
        let (u, d) = (up.load(Ordering::Relaxed), down.load(Ordering::Relaxed));
        println!(
            "  {label:<22} ⇒ 请求 {u:>5} B ＋ 响应 {d:>6} B ＝ **{:>6} B** ｜ HTTP {status} ｜ body {} B",
            u + d,
            body.len()
        );
    }

    // ★ 2026-09-30 追加：**把"空轮询"再跑 N 轮**（默认只跑上面那 4 例）——
    //   好让外部能对**真实那一次交换**做 OS 层对照测量（`nettop` 按进程读 bytes_in/bytes_out
    //   ⇒ 不必减背景噪声 ✓）。
    //   ⭐ 为什么要这一档：我先前的 OS 层测量用的是**手写的裸 TCP 字节串** ✗ ——
    //   它的请求侧是 **186 B**，而**真实 reqwest 发的是 137 B**（差 49 B）✗
    //   ⇒ 那个 186 是**我模板的长度、不是产品的** ⇒ 量 OS 层必须跑**这一条真路径** ✓。
    //   跑法：`MESH_WIRE_ROUNDS=200 cargo test --lib mesh_wire_bytes -- --ignored --nocapture`
    let rounds: usize = std::env::var("MESH_WIRE_ROUNDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|n| *n > 1)
        .unwrap_or(1);
    if rounds > 1 {
        let mut tu = 0usize;
        let mut td = 0usize;
        // `since` 取最大那条 ⇒ **空轮询**（库里 10 条、游标在最前 ⇒ 一条也不返回 ✓）
        let url = format!(
            "http://127.0.0.1:{proxy_port}/mesh/pull?space_id={space}&since=10&limit=1000"
        );
        for i in 1..=rounds {
            up.store(0, Ordering::Relaxed);
            down.store(0, Ordering::Relaxed);
            let resp = client
                .get(&url)
                .bearer_auth(token)
                .send()
                .await
                .expect("请求失败");
            let _ = resp.text().await.unwrap();
            let (u, d) = (up.load(Ordering::Relaxed), down.load(Ordering::Relaxed));
            tu += u;
            td += d;
            if i % 50 == 0 {
                println!("  [空轮询] 已跑 {i}/{rounds} 轮");
            }
        }
        println!(
            "★ 空轮询 ×{rounds} ⇒ 请求共 {tu} B ＋ 响应共 {td} B ＝ **{} B**（每轮 **{:.1} B**）",
            tu + td,
            (tu + td) as f64 / rounds as f64
        );
    }

    // 把"原始 payload"与"转义后"的差也打出来（验证 1.257× 那个系数）
    let raw = payload_of(10_000);
    let escaped = serde_json::to_string(&raw).unwrap();
    println!(
        "\n载荷形态核对：原始 {} B ⇒ JSON 转义后 {} B（膨胀 {:.3}×）",
        raw.len(),
        escaped.len() - 2,
        (escaped.len() - 2) as f64 / raw.len() as f64
    );
    println!("===============================================\n");
}
