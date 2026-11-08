#![cfg(all(feature = "lan-quic", not(feature = "relay")))]
//! ⭐ **P3-2a 两 OS 进程无中继 QUIC 直连验收**。
//!
//! ## 为什么要有它
//! 单进程里的 QUIC 判据（`lan_quic::tests` / `mesh_endpoint`）证明不了"**两个独立 OS 进程**
//! 各持一个 iroh Endpoint、交换 node_id/地址后真能直连"——而 P3-2a 的最小验收正是这件事。
//! 本文件用 integration test 拉起**两个子进程**（同一个测试二进制、不同角色），不依赖第二个
//! App 实例（单实例限制下也能跑）。
//!
//! ## 子进程协议（父 → 子：环境变量；子 → 父：JSON 文件）
//! * 角色：`SHUYONOTE_QUIC_TEST_ROLE=server|client`；目录：`SHUYONOTE_QUIC_TEST_DIR`；
//! * server：`bind_direct(随机 secret)` → 写 `server.json { nodeId, port, pid }`（tmp+rename 原子）
//!   → `accept` 一条连接、读一次请求、回 `200/two-process-ok`、退出；
//! * client：读 `server.json` → 自己 `bind_direct` → 向 `127.0.0.1:<port>` 发一次 `GET` →
//!   写 `client.json { status, body, pid }` → 退出；
//! * 父：等 `server.json`（≤20s）→ 起 client → 等两边退出（总超时 60s）→ 断言 200/正文/
//!   **两个不同 PID**；失败/超时杀子进程、清临时目录。
//!
//! ## 无中继
//! 两侧都用 `lan_quic::bind_direct`（`Minimal` 预设：⛔ 不配中继、⛔ 不配发现 ⇒ 只走直连地址）；
//! 父测试同时断言**没有**相关中继环境变量（⛔ 不靠外部配置蒙混过关）。

use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use shuyonote_lib::lan_quic::{
    bind_direct, endpoint_addr, request_text, serve_one_request_text, LanQuicEndpoint,
};

const ROLE_ENV: &str = "SHUYONOTE_QUIC_TEST_ROLE";
const DIR_ENV: &str = "SHUYONOTE_QUIC_TEST_DIR";
const SERVER_TEST: &str = "child_server_binds_and_serves_one_request";
const CLIENT_TEST: &str = "child_client_requests_over_direct_quic";
const TARGET: &str = "/mesh/manifest?space_id=two-process";
const REPLY: &str = "two-process-ok";
const TOTAL_TIMEOUT: Duration = Duration::from_secs(60);
const WAIT_FILE_TIMEOUT: Duration = Duration::from_secs(20);

fn atomic_write(path: &Path, text: &str) {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, text).expect("写临时文件");
    std::fs::rename(&tmp, path).expect("原子 rename");
}

fn read_json(path: &Path) -> serde_json::Value {
    let text = std::fs::read_to_string(path).expect("读子进程产物");
    serde_json::from_str(&text).expect("产物必须是 JSON")
}

/// 等一个文件出现（内容完整可读），超时 ⇒ None。
fn wait_for_file(path: &Path, timeout: Duration) -> Option<serde_json::Value> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(text) = std::fs::read_to_string(path) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                return Some(v);
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    None
}

/// 等某个 JSON 键出现（文件存在但**内容还会被补写**时用它；光等"能解析"会拿到旧内容）。
fn wait_for_json_key(path: &Path, key: &str, timeout: Duration) -> Option<serde_json::Value> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(text) = std::fs::read_to_string(path) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                if v.get(key).is_some() {
                    return Some(v);
                }
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    None
}

/// 子进程守卫：**Drop 即杀**（父测试任何一步 panic 都不留孤儿进程）。
struct ChildGuard {
    child: Option<Child>,
    label: &'static str,
}

impl ChildGuard {
    fn spawn(label: &'static str, role: &str, dir: &Path, exe: &Path, test_name: &str) -> Self {
        let child = Command::new(exe)
            .env(ROLE_ENV, role)
            .env(DIR_ENV, dir)
            // 子进程只跑**这一个** `#[ignore]` 测试（exact 过滤；`--ignored` 让 libtest 允许跑它）。
            .args(["--ignored", "--exact", test_name, "--test-threads=1"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap_or_else(|e| panic!("起 {label} 子进程失败：{e}"));
        ChildGuard {
            child: Some(child),
            label,
        }
    }

    fn id(&self) -> u32 {
        self.child.as_ref().expect("子进程还在").id()
    }

    /// 等退出（带超时；超时 ⇒ kill 后返回 None）。
    fn wait_timeout(&mut self, timeout: Duration) -> Option<std::process::ExitStatus> {
        let deadline = Instant::now() + timeout;
        let child = self.child.as_mut().expect("子进程还在");
        loop {
            match child.try_wait() {
                Ok(Some(st)) => return Some(st),
                Ok(None) => {}
                Err(e) => panic!("等 {} 子进程失败：{e}", self.label),
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// 成功后收走 Child（Drop 不再 kill）；同时把子进程输出打出来便于排障。
    fn take(&mut self) -> Child {
        let mut child = self.child.take().expect("子进程还在");
        let _ = dump_output(&mut child);
        child
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn dump_output(child: &mut Child) -> Option<String> {
    let mut out = String::new();
    if let Some(mut s) = child.stdout.take() {
        let _ = s.read_to_string(&mut out);
    }
    let mut err = String::new();
    if let Some(mut s) = child.stderr.take() {
        let _ = s.read_to_string(&mut err);
    }
    if !out.trim().is_empty() {
        eprintln!("[子进程 stdout]\n{out}");
    }
    if !err.trim().is_empty() {
        eprintln!("[子进程 stderr]\n{err}");
    }
    Some(format!("{out}\n{err}"))
}

fn unique_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "shuyonote-quic-two-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).expect("建临时目录");
    dir
}

// ─────────────────────────────── 父测试（唯一的非 ignore 测试） ───────────────────────────────

#[test]
fn two_processes_move_one_request_over_direct_quic() {
    // ① 无中继配置：本测试**不设且不允许**这些环境变量（否则"直连"可能被中继兜底冒充）。
    for k in [
        "SHUYONOTE_RELAY_URL",
        "SHUYONOTE_RELAY_TOKEN",
        "SHUYONOTE_MESH_RELAY",
    ] {
        assert!(
            std::env::var(k).is_err(),
            "两进程验收要求**无中继配置**，但环境里设了 {k}"
        );
    }
    let dir = unique_dir("quic");
    let exe = std::env::current_exe().expect("current_exe");
    let server_file = dir.join("server.json");
    let client_file = dir.join("client.json");

    // ② 起 server 子进程 → 等它写出 node_id/port。
    let mut server = ChildGuard::spawn("server", "server", &dir, &exe, SERVER_TEST);
    let addr = match wait_for_file(&server_file, WAIT_FILE_TIMEOUT) {
        Some(v) => v,
        None => {
            let _ = dump_output(server.child.as_mut().unwrap());
            panic!(
                "server 子进程没有在 {WAIT_FILE_TIMEOUT:?} 内写出地址文件（{} 不存在或坏）",
                server_file.display()
            );
        }
    };
    let server_node = addr["nodeId"].as_str().expect("nodeId").to_string();
    let server_port = addr["port"].as_u64().expect("port") as u16;
    let server_pid_in_file = addr["pid"].as_u64().expect("pid") as u32;
    assert!(
        !server_node.is_empty() && server_port != 0,
        "server 必须报出非空 node_id 与真实 UDP 端口：{addr}"
    );
    assert_eq!(
        server_pid_in_file,
        server.id(),
        "server 产物里的 pid 必须就是父进程起的那个子进程"
    );

    // ③ 起 client 子进程（它自己读 server.json、自己 bind、发一次 GET）。
    let mut client = ChildGuard::spawn("client", "client", &dir, &exe, CLIENT_TEST);
    let deadline = Instant::now() + TOTAL_TIMEOUT;
    let server_st = server
        .wait_timeout(deadline.saturating_duration_since(Instant::now()))
        .expect("server 子进程超时未退出");
    let client_st = client
        .wait_timeout(deadline.saturating_duration_since(Instant::now()))
        .expect("client 子进程超时未退出");
    // ④ 断言：真两个不同 OS 进程（都不是父进程）—— **先取 pid 再 take**（take 会收走 Child）。
    let server_pid = server.id();
    let client_pid = client.id();
    let _ = server.take();
    let _ = client.take();
    assert!(
        server_st.success(),
        "server 子进程必须成功退出：{server_st:?}"
    );
    assert!(
        client_st.success(),
        "client 子进程必须成功退出：{client_st:?}"
    );
    assert_ne!(server_pid, client_pid, "两个角色必须是两个不同的 OS 进程");
    assert_ne!(server_pid, std::process::id(), "server 不许是父进程自己");
    assert_ne!(client_pid, std::process::id(), "client 不许是父进程自己");

    // ⑤ 断言：一次真的 QUIC 请求/应答（状态 200、正文逐字来自 server 子进程）。
    let result = read_json(&client_file);
    assert_eq!(
        result["pid"].as_u64(),
        Some(client_pid as u64),
        "client 产物 pid"
    );
    assert_eq!(
        result["status"].as_u64(),
        Some(200),
        "QUIC 应答状态：{result}"
    );
    assert_eq!(
        result["body"].as_str(),
        Some(REPLY),
        "正文必须逐字来自 server 子进程：{result}"
    );
    assert_eq!(
        result["targetSeen"].as_str(),
        Some(TARGET),
        "server 收到的 target 必须原样：{result}"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

// ─────────────────────────────── 子进程角色（`#[ignore]` + `--exact` 调度） ───────────────────────────────

fn child_env() -> Option<(String, PathBuf)> {
    let role = std::env::var(ROLE_ENV).ok()?;
    let dir = std::env::var(DIR_ENV).ok()?;
    Some((role, PathBuf::from(dir)))
}

fn v4_port(ep: &LanQuicEndpoint) -> u16 {
    ep.local_addrs()
        .iter()
        .find_map(|s| match s {
            std::net::SocketAddr::V4(v4) if v4.port() != 0 => Some(v4.port()),
            _ => None,
        })
        .expect("端点必须至少绑上一个 IPv4 端口")
}

/// 子进程（server）：绑无中继端点 → 写 `{nodeId,port,pid}` → 服务一次请求。
#[test]
#[ignore = "两进程验收的子进程角色：由父测试用 --ignored --exact 调度"]
fn child_server_binds_and_serves_one_request() {
    let Some((role, dir)) = child_env() else {
        return; // 无角色环境 ⇒ 普通 `--ignored` 全跑时**无害空转**
    };
    if role != "server" {
        return;
    }
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("子进程 runtime");
    rt.block_on(async move {
        let ep = bind_direct(iroh::SecretKey::generate())
            .await
            .expect("server bind_direct");
        let payload = serde_json::json!({
            "nodeId": ep.node_id_hex(),
            "port": v4_port(&ep),
            "pid": std::process::id(),
        });
        atomic_write(&dir.join("server.json"), &payload.to_string());
        let seen = serve_one_request_text(&ep, REPLY)
            .await
            .expect("server 服务一次请求");
        // 把 server 看到的 target 也写出来（父测试核对原样）。
        let mut v = read_json(&dir.join("server.json"));
        v["targetSeen"] = serde_json::Value::String(seen);
        atomic_write(&dir.join("server.json"), &v.to_string());
    });
}

/// 子进程（client）：读 `server.json` → 自绑端点 → 一次 QUIC 请求 → 写结果。
#[test]
#[ignore = "两进程验收的子进程角色：由父测试用 --ignored --exact 调度"]
fn child_client_requests_over_direct_quic() {
    let Some((role, dir)) = child_env() else {
        return;
    };
    if role != "client" {
        return;
    }
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("子进程 runtime");
    rt.block_on(async move {
        // 等 server 写好地址文件（父测试已经等过一次；这里再等一小会儿防竞态）。
        let server = wait_for_file(&dir.join("server.json"), Duration::from_secs(10))
            .expect("client 等不到 server.json");
        let node = server["nodeId"].as_str().expect("nodeId");
        let port = server["port"].as_u64().expect("port") as u16;
        let addr = endpoint_addr(node, &[format!("127.0.0.1:{port}")])
            .expect("server 地址必须能解析成 EndpointAddr");
        let ep = bind_direct(iroh::SecretKey::generate())
            .await
            .expect("client bind_direct");
        let (status, body) = request_text(&ep, addr, TARGET)
            .await
            .expect("直连 QUIC 请求必须成功");
        // 等 server 把 targetSeen 补上（最多 10s），并把它带进 client 产物 —— 父测试据此核对
        // "server 收到的 target 原样"。
        let server_after = wait_for_json_key(
            &dir.join("server.json"),
            "targetSeen",
            Duration::from_secs(10),
        )
        .unwrap_or(server);
        let target_seen = server_after["targetSeen"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let out = serde_json::json!({
            "status": status,
            "body": body,
            "pid": std::process::id(),
            "targetSeen": target_seen,
        });
        atomic_write(&dir.join("client.json"), &out.to_string());
    });
}
