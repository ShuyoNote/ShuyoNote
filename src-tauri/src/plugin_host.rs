//! 插件宿主**子进程化**（M11.13）——协议与骨架。
//!
//! 方案：[`docs/plans/2026-09-10-plugin-host-isolation-plan.md`]（结论见 §1，设计见 §3）。
//! 这里只做**阶段 1**：把"父进程 ←→ 纯解释器子进程"这条通道打通并测住，
//! 真正的能力 RPC 上移（阶段 2）与 OS 级上限（阶段 3）还没做。
//!
//! ## 边界：子进程是**纯解释器**
//!
//! 子进程不碰数据库、不拿解密密钥、没有路径；它只会：读一帧请求 → 跑一段插件 JS →
//! 回一帧结果。今天的能力调用在子进程里回一个**假应答**（阶段 2 起改成 RPC 回父进程，
//! 那里已经有权限校验、审计与写中介）。也就是说：**"密钥与不可信代码同进程"这条边界，
//! 从阶段 1 起就已经换掉了**——不可信代码跑的进程里没有任何秘密可偷。
//!
//! ## 传输：同二进制 re-exec + 长度前缀 JSON
//!
//! `current_exe() --plugin-host`（**同一个二进制**，所以打包/签名/公证都不变），
//! stdin/stdout 上跑长度前缀（4 字节大端）+ UTF-8 JSON 的帧。不用 TCP/命名管道：
//! 多平台行为一致、没有端口与权限问题、父进程一死管道就断（子进程的 EOF 语义免费拿到）。
//!
//! 分流**必须在任何 Tauri / 单实例初始化之前**（见 `lib.rs::run` 的第一行）：
//! 否则 macOS 上会多出一个 Dock 图标、单实例插件会把子进程当成"第二个实例"。
//!
//! 一个容易被问到的平台细节：Windows 发布档的二进制带 `windows_subsystem = "windows"`
//! （没有控制台）。这**不影响**这条通道——父进程用 `Stdio::piped()` 起子进程时，标准句柄
//! 是父进程给的**管道**，与控制台是否存在无关。

use std::io::{BufReader, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde::{Deserialize, Serialize};

/// 协议版本。父进程与子进程对不上就**直接失败**（不做向后兼容：两边是同一个二进制，
/// 版本不一致只可能是有人把旧进程留着跑）。
pub const PROTOCOL_VERSION: u32 = 1;

/// 命令行开关：带这个开关启动 = 当宿主子进程跑（不是开界面）。
pub const HOST_FLAG: &str = "--plugin-host";

/// 单帧上限。插件源码、入参、以及结果里的草稿/导出都在帧里，所以给得比调用参数宽
/// （`MAX_ARGS_BYTES` 是 1 MiB），但仍然是个**界**：没有它，一个坏掉的对端就能让
/// 另一边无限分配。
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------
// 协议
// ---------------------------------------------------------------------------

/// 父进程 → 子进程。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum HostIn {
    /// 跑一次命令。
    Run(HostRunRequest),
    /// 收工：子进程退出 0（一次调用一个子进程，见方案 §3.3）。
    Shutdown,
}

/// 子进程 → 父进程。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum HostOut {
    /// 握手：子进程起来了、协议版本对得上。父进程必须**先收到它**才敢发请求。
    Ready { protocol: u32, pid: u32 },
    /// 这次命令跑完了。
    Done(HostRunResult),
    /// 跑失败了（插件自己的异常、语法错、预算超限……都走这里，不是"通道坏了"）。
    Failed { code: String, message: String },
}

/// 一次命令执行请求。字段都是**纯数据**（可跨进程）：源码、入参、以及本次运行的上下文。
///
/// 注意这里**没有**数据库句柄、没有解密密钥、没有插件目录——那正是这条边界的意义。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct HostRunRequest {
    pub plugin_id: String,
    /// 插件源码（父进程读盘后传进来；子进程没有路径，也就读不了别的文件）。
    pub source: String,
    pub command_id: String,
    #[serde(default)]
    pub args_json: String,
    /// 本次运行被授权的权限（父进程按 manifest 解析后传进来）。
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub current_page_id: Option<String>,
    #[serde(default)]
    pub current_page_json: String,
    #[serde(default)]
    pub page_count: usize,
}

/// 一次命令执行的结果。
///
/// 草稿与导出用 `serde_json::Value` 原样透传：阶段 1 只证明"数据过得去"，它们的**形状**
/// 与落地规则仍然只在前端与父进程那一侧（写中介没变，也不需要变）。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct HostRunResult {
    pub message: String,
    #[serde(default)]
    pub insert_text: String,
    #[serde(default)]
    pub toasts: Vec<String>,
    #[serde(default)]
    pub drafts: serde_json::Value,
    #[serde(default)]
    pub exports: serde_json::Value,
}

/// 通道层面的错误（与"插件跑失败"区分开：那是 `HostOut::Failed`）。
#[derive(Debug)]
pub enum HostError {
    /// 对端在帧中间就没了。
    Eof,
    /// 帧太大（超 [`MAX_FRAME_BYTES`]）。
    TooLarge(usize),
    /// 帧不是合法 JSON / 不认识的消息。
    Malformed(String),
    Io(std::io::Error),
}

impl std::fmt::Display for HostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HostError::Eof => write!(f, "宿主通道已关闭（对端退出）"),
            HostError::TooLarge(n) => write!(f, "宿主帧过大（{n} 字节，上限 {MAX_FRAME_BYTES}）"),
            HostError::Malformed(m) => write!(f, "宿主帧不合法：{m}"),
            HostError::Io(e) => write!(f, "宿主通道 IO 错误：{e}"),
        }
    }
}

impl From<std::io::Error> for HostError {
    fn from(e: std::io::Error) -> Self {
        HostError::Io(e)
    }
}

// ---------------------------------------------------------------------------
// 帧编解码
// ---------------------------------------------------------------------------

/// 写一帧：4 字节大端长度 + UTF-8 JSON。
pub fn write_frame<W: Write, T: Serialize>(w: &mut W, msg: &T) -> Result<(), HostError> {
    let body = serde_json::to_vec(msg).map_err(|e| HostError::Malformed(e.to_string()))?;
    if body.len() > MAX_FRAME_BYTES {
        return Err(HostError::TooLarge(body.len()));
    }
    w.write_all(&(body.len() as u32).to_be_bytes())?;
    w.write_all(&body)?;
    w.flush()?;
    Ok(())
}

/// 读一帧。**干净的对端关闭**（一字节都还没读）返回 `Ok(None)`——那是"父进程收工了"，
/// 不是错误；读到一半断掉才算 [`HostError::Eof`]。
pub fn read_frame<R: Read, T: serde::de::DeserializeOwned>(r: &mut R) -> Result<Option<T>, HostError> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(HostError::Io(e)),
    }
    let n = u32::from_be_bytes(len) as usize;
    if n > MAX_FRAME_BYTES {
        return Err(HostError::TooLarge(n));
    }
    let mut body = vec![0u8; n];
    r.read_exact(&mut body).map_err(|_| HostError::Eof)?;
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|e| HostError::Malformed(e.to_string()))
}

// ---------------------------------------------------------------------------
// 子进程侧
// ---------------------------------------------------------------------------

/// 子进程主循环（`--plugin-host` 时由 `lib.rs` 直接调用，**不初始化 Tauri**）。
///
/// 返回进程退出码：0 = 正常收工；2 = 通道层面坏了（父进程读得到错误，能如实报给用户）。
pub fn serve_stdio() -> i32 {
    let stdin = std::io::stdin();
    let mut input = BufReader::new(stdin.lock());
    let stdout = std::io::stdout();
    let mut out = stdout.lock();

    if write_frame(
        &mut out,
        &HostOut::Ready {
            protocol: PROTOCOL_VERSION,
            pid: std::process::id(),
        },
    )
    .is_err()
    {
        return 2;
    }

    loop {
        match read_frame::<_, HostIn>(&mut input) {
            Ok(None) => return 0, // 父进程关了管道 = 收工
            Ok(Some(HostIn::Shutdown)) => return 0,
            Ok(Some(HostIn::Run(req))) => {
                let frame = match crate::plugins::run_command_in_host_process(&req) {
                    Ok(res) => HostOut::Done(res),
                    Err((code, message)) => HostOut::Failed { code, message },
                };
                if write_frame(&mut out, &frame).is_err() {
                    return 2;
                }
            }
            Err(e) => {
                // 通道坏了：尽量告诉对端一句再退，然后以非零码结束。
                let _ = write_frame(
                    &mut out,
                    &HostOut::Failed {
                        code: "host_protocol_error".into(),
                        message: e.to_string(),
                    },
                );
                return 2;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 父进程侧
// ---------------------------------------------------------------------------

/// 父进程手里的子进程句柄。
///
/// `Drop` 会**杀掉**子进程（方案 §3.3：一次调用一个子进程，取消/超时 = 杀进程）。
/// 阶段 3 会把"杀"接上真正的墙钟超时与 OS 级上限；阶段 1 先把句柄与握手管好。
pub struct HostClient {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    /// 握手时子进程报上来的 pid（日志用；测试也靠它断言"确实另起了一个进程"）。
    pub child_pid: u32,
}

impl HostClient {
    /// 起一个宿主子进程（用**当前可执行文件**，即生产路径）。
    pub fn spawn() -> Result<Self, String> {
        let exe = std::env::current_exe().map_err(|e| format!("拿不到当前可执行文件：{e}"))?;
        Self::spawn_with_exe(&exe)
    }

    /// 起一个宿主子进程（可指定可执行文件——集成测试用测试配置里给出的**应用二进制**，
    /// 因为测试进程自己不是宿主）。
    pub fn spawn_with_exe(exe: &std::path::Path) -> Result<Self, String> {
        let mut child = Command::new(exe)
            .arg(HOST_FLAG)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // stderr 继承：子进程的 panic 信息直接进父进程的日志/控制台，
            // 不吞掉（阶段 1 不解析它，但也不该消失）。
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("起插件宿主子进程失败：{e}"))?;

        let stdin = child.stdin.take().ok_or("子进程 stdin 不可用")?;
        let stdout = child.stdout.take().ok_or("子进程 stdout 不可用")?;
        let mut client = HostClient {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            child_pid: 0,
        };
        client.handshake()?;
        Ok(client)
    }

    /// 等握手。**必须先收到 `Ready` 才发请求**：否则父进程可能在子进程还没建好解释器时
    /// 就把它当成"跑完了"，把失败误报成成功。
    fn handshake(&mut self) -> Result<(), String> {
        match read_frame::<_, HostOut>(&mut self.stdout) {
            Ok(Some(HostOut::Ready { protocol, pid })) => {
                if protocol != PROTOCOL_VERSION {
                    return Err(format!(
                        "宿主子进程协议版本不一致（子进程 {protocol}，本进程 {PROTOCOL_VERSION}）"
                    ));
                }
                self.child_pid = pid;
                Ok(())
            }
            Ok(Some(other)) => Err(format!("宿主子进程握手时先发了 {other:?}")),
            Ok(None) => Err("宿主子进程握手前就退出了".into()),
            Err(e) => Err(format!("宿主子进程握手失败：{e}")),
        }
    }

    /// 让子进程跑一次命令。
    pub fn run(&mut self, req: HostRunRequest) -> Result<HostRunResult, String> {
        write_frame(&mut self.stdin, &HostIn::Run(req)).map_err(|e| e.to_string())?;
        match read_frame::<_, HostOut>(&mut self.stdout) {
            Ok(Some(HostOut::Done(res))) => Ok(res),
            Ok(Some(HostOut::Failed { code, message })) => Err(format!("{code}: {message}")),
            Ok(Some(HostOut::Ready { .. })) => Err("宿主子进程重复握手".into()),
            Ok(None) => Err("宿主子进程没回结果就退出了".into()),
            Err(e) => Err(e.to_string()),
        }
    }

    /// 收工：让子进程读到 `Shutdown` 就 return 0，并等它退出。
    ///
    /// 取 `&mut self` 而不是 `self`：`HostClient` 实现了 `Drop`（异常路径兜底杀进程），
    /// 因此不能按字段把 `child`/`stdin` move 出去。等待成功后 `Drop` 里的 `kill` 是空操作
    /// （进程已经退出了），语义仍然干净。
    pub fn shutdown(&mut self) -> Result<(), String> {
        let _ = write_frame(&mut self.stdin, &HostIn::Shutdown);
        match self.child.wait() {
            Ok(st) if st.success() => Ok(()),
            Ok(st) => Err(format!("宿主子进程退出码 {:?}", st.code())),
            Err(e) => Err(format!("等宿主子进程退出失败：{e}")),
        }
    }
}

impl Drop for HostClient {
    fn drop(&mut self) {
        // 父进程无论如何都不留下孤儿子进程（方案 §6.3 的手工验收项）：
        // 正常路径已经 shutdown 过，这里是异常路径。
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req() -> HostRunRequest {
        HostRunRequest {
            plugin_id: "p".into(),
            source: "register({ id: 'x', title: 'X', run: function () { return 'ok'; } });".into(),
            command_id: "x".into(),
            args_json: String::new(),
            permissions: Vec::new(),
            current_page_id: None,
            current_page_json: String::new(),
            page_count: 0,
        }
    }

    #[test]
    fn frames_round_trip() {
        let mut buf = Vec::new();
        write_frame(&mut buf, &HostIn::Run(req())).unwrap();
        write_frame(&mut buf, &HostIn::Shutdown).unwrap();

        let mut r = std::io::Cursor::new(buf);
        assert_eq!(read_frame::<_, HostIn>(&mut r).unwrap(), Some(HostIn::Run(req())));
        assert_eq!(read_frame::<_, HostIn>(&mut r).unwrap(), Some(HostIn::Shutdown));
        // 读完就没了：干净关闭 → None（不是错误）
        assert_eq!(read_frame::<_, HostIn>(&mut r).unwrap(), None);
    }

    #[test]
    fn a_frame_split_across_writes_is_reassembled() {
        // 真实管道里帧会被切开：这里模拟"长度到了、body 还没到"。
        let mut whole = Vec::new();
        write_frame(&mut whole, &HostOut::Failed { code: "c".into(), message: "m".into() }).unwrap();
        let (head, tail) = whole.split_at(6);
        let mut stream = std::io::Cursor::new([head, tail].concat());
        assert_eq!(
            read_frame::<_, HostOut>(&mut stream).unwrap(),
            Some(HostOut::Failed { code: "c".into(), message: "m".into() })
        );
        // 长度前缀说 2 字节、实际只有 1 字节 → 中途断掉，必须报 Eof 而不是当成空帧
        let mut truncated = std::io::Cursor::new(vec![0, 0, 0, 2, b'{']);
        assert!(matches!(read_frame::<_, HostOut>(&mut truncated), Err(HostError::Eof)));
    }

    #[test]
    fn oversized_frame_is_rejected_before_allocating() {
        let mut f = std::io::Cursor::new((MAX_FRAME_BYTES as u32 + 1).to_be_bytes().to_vec());
        assert!(matches!(read_frame::<_, HostOut>(&mut f), Err(HostError::TooLarge(_))));
    }

    #[test]
    fn malformed_frame_is_an_error_not_a_hang() {
        let body = b"not json".to_vec();
        let mut f = std::io::Cursor::new(
            [(body.len() as u32).to_be_bytes().to_vec(), body].concat(),
        );
        assert!(matches!(read_frame::<_, HostOut>(&mut f), Err(HostError::Malformed(_))));
    }

    #[test]
    fn writing_a_frame_larger_than_the_cap_fails_instead_of_truncating() {
        let big = HostOut::Failed { code: "c".into(), message: "x".repeat(MAX_FRAME_BYTES + 1) };
        let mut buf = Vec::new();
        assert!(matches!(write_frame(&mut buf, &big), Err(HostError::TooLarge(_))));
        assert!(buf.is_empty(), "超限的帧不该写出去半个");
    }
}
