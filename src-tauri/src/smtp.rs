//! 最小 SMTP 客户端：仅用于「邮箱回复/转发/发件」——从应用内直接发一封纯文本邮件。
//!
//! 由于 crate 镜像里没有 lettre/async-smtp，这里基于已有的 tokio + native-tls + base64
//! 实现一个足够用的 SMTP 会话（AUTH LOGIN / AUTH PLAIN，支持隐式 TLS(465) 与 STARTTLS(587)）。
//! 不做 DKIM/大附件/HTML 富文本；纯文本正文即可满足"回复/转发"。
//!
//! 安全：生产应改用系统凭据库 + 最小权限；见私有仓库 docs/email-aggregate-monetization.md。

use std::io;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// SMTP 传输加密方式。
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum SmtpSecurity {
    /// 隐式 TLS（常用 465）。
    Ssl,
    /// 先 STARTTLS 升级（常用 587）。
    StartTls,
    /// 明文（25，不安全，仅测试）。
    None,
}

impl SmtpSecurity {
    pub fn parse(s: &str) -> Self {
        match s {
            "starttls" => SmtpSecurity::StartTls,
            "none" => SmtpSecurity::None,
            _ => SmtpSecurity::Ssl,
        }
    }
}

/// 会话流：STARTTLS 前是 TCP，升级后可切换成 TLS。用枚举统一读写，避免泛型所有权问题。
enum SmtpStream {
    Plain(TcpStream),
    Tls(tokio_native_tls::TlsStream<TcpStream>),
}

impl SmtpStream {
    async fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self {
            SmtpStream::Plain(s) => s.read(buf).await,
            SmtpStream::Tls(s) => s.read(buf).await,
        }
    }
    async fn write_all(&mut self, buf: &[u8]) -> io::Result<()> {
        match self {
            SmtpStream::Plain(s) => s.write_all(buf).await,
            SmtpStream::Tls(s) => s.write_all(buf).await,
        }
    }
    async fn flush(&mut self) -> io::Result<()> {
        match self {
            SmtpStream::Plain(s) => s.flush().await,
            SmtpStream::Tls(s) => s.flush().await,
        }
    }
}

/// 读取完整 SMTP 响应（处理多行回复：`250-...` 是续行，直到 `250 ...` 结束）。
async fn read_response(stream: &mut SmtpStream) -> String {
    let mut full = String::new();
    let mut line = String::new();
    let mut byte = [0u8; 1];
    loop {
        match stream.read(&mut byte).await {
            Ok(0) => break,
            Ok(_) => {
                line.push(byte[0] as char);
                if line.ends_with("\n") {
                    let trimmed = line.trim_end().to_string();
                    full.push_str(&trimmed);
                    full.push('\n');
                    // 服务器回复的最后一行：`250 ...`（状态码后是空格），
                    // 而续行是 `250-...`。检查是否有续行。
                    let is_cont = trimmed.as_bytes().get(3) == Some(&b'-');
                    line.clear();
                    if !is_cont {
                        break;
                    }
                }
                if line.len() > 8192 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    full.trim_end().to_string()
}

async fn write_cmd(stream: &mut SmtpStream, cmd: &str) -> io::Result<()> {
    stream.write_all(cmd.as_bytes()).await?;
    stream.write_all(b"\r\n").await?;
    stream.flush().await
}

fn ehlo() -> String {
    "EHLO shuyonote".to_string()
}

/// 发送一封邮件。`from` / `to` 为邮箱地址，`msg` 为完整 MIME 消息文本（含头 + 空行 + 正文）。
pub async fn send(
    host: &str,
    port: u16,
    username: &str,
    password: &str,
    security: SmtpSecurity,
    from: &str,
    to: &str,
    msg: &str,
) -> Result<(), String> {
    let tcp = TcpStream::connect((host, port))
        .await
        .map_err(|e| format!("SMTP 连接失败: {}", e))?;

    // 隐式 TLS：连上就升级。
    let mut stream = if security == SmtpSecurity::Ssl {
        let tls = tokio_native_tls::TlsConnector::from(
            native_tls::TlsConnector::new().map_err(|e| e.to_string())?,
        );
        let tls_stream = tls
            .connect(host, tcp)
            .await
            .map_err(|e| format!("SMTP TLS 失败: {}", e))?;
        SmtpStream::Tls(tls_stream)
    } else {
        SmtpStream::Plain(tcp)
    };

    // 服务器问候（220 可选，先读掉）。
    let _greeting = read_response(&mut stream).await;

    // EHLO
    write_cmd(&mut stream, &ehlo()).await.map_err(|e| e.to_string())?;
    let _r = read_response(&mut stream).await;

    // STARTTLS
    if security == SmtpSecurity::StartTls {
        write_cmd(&mut stream, "STARTTLS").await.map_err(|e| e.to_string())?;
        let r = read_response(&mut stream).await;
        if !r.starts_with("220") {
            return Err(format!("STARTTLS 不被支持: {}", r));
        }
        // 升级：取出 TcpStream 包成 TLS
        let tcp = match stream {
            SmtpStream::Plain(s) => s,
            SmtpStream::Tls(_) => return Err("状态异常：STARTTLS 后不应已是 TLS".to_string()),
        };
        let tls = tokio_native_tls::TlsConnector::from(
            native_tls::TlsConnector::new().map_err(|e| e.to_string())?,
        );
        let tls_stream = tls
            .connect(host, tcp)
            .await
            .map_err(|e| format!("SMTP TLS 失败: {}", e))?;
        stream = SmtpStream::Tls(tls_stream);
        write_cmd(&mut stream, &ehlo()).await.map_err(|e| e.to_string())?;
        let _r = read_response(&mut stream).await;
    }

    // AUTH LOGIN（多数服务商），失败则 AUTH PLAIN。
    write_cmd(&mut stream, "AUTH LOGIN").await.map_err(|e| e.to_string())?;
    let r = read_response(&mut stream).await;
    if r.starts_with("334") {
        use base64::Engine as _;
        let user = base64::engine::general_purpose::STANDARD.encode(username);
        let pass = base64::engine::general_purpose::STANDARD.encode(password);
        write_cmd(&mut stream, &user).await.map_err(|e| e.to_string())?;
        let _r = read_response(&mut stream).await;
        write_cmd(&mut stream, &pass).await.map_err(|e| e.to_string())?;
        let r = read_response(&mut stream).await;
        if !r.starts_with("235") {
            return Err(format!("SMTP 认证失败: {}", r));
        }
    } else {
        use base64::Engine as _;
        let plain = format!("\x00{}\x00{}", username, password);
        let b64 = base64::engine::general_purpose::STANDARD.encode(plain);
        write_cmd(&mut stream, &format!("AUTH PLAIN {}", b64)).await.map_err(|e| e.to_string())?;
        let r = read_response(&mut stream).await;
        if !r.starts_with("235") {
            return Err(format!("SMTP 认证失败: {}", r));
        }
    }

    // MAIL FROM / RCPT TO
    write_cmd(&mut stream, &format!("MAIL FROM:<{}>", from)).await.map_err(|e| e.to_string())?;
    let r = read_response(&mut stream).await;
    if !r.starts_with("250") {
        return Err(format!("MAIL FROM 失败: {}", r));
    }
    write_cmd(&mut stream, &format!("RCPT TO:<{}>", to)).await.map_err(|e| e.to_string())?;
    let r = read_response(&mut stream).await;
    if !(r.starts_with("250") || r.starts_with("251")) {
        return Err(format!("RCPT TO 失败: {}", r));
    }

    // DATA
    write_cmd(&mut stream, "DATA").await.map_err(|e| e.to_string())?;
    let r = read_response(&mut stream).await;
    if !r.starts_with("354") {
        return Err(format!("DATA 失败: {}", r));
    }
    // 规范化换行为 CRLF，并以 "." 结束。
    let body = normalize_crlf(msg);
    stream.write_all(body.as_bytes()).await.map_err(|e| e.to_string())?;
    stream.write_all(b"\r\n.\r\n").await.map_err(|e| e.to_string())?;
    stream.flush().await.map_err(|e| e.to_string())?;
    let r = read_response(&mut stream).await;
    if !r.starts_with("250") {
        return Err(format!("发送失败: {}", r));
    }

    // QUIT
    write_cmd(&mut stream, "QUIT").await.map_err(|e| e.to_string())?;
    let _r = read_response(&mut stream).await;
    Ok(())
}

/// 把 \n 统一成 CRLF（SMTP 规范要求），并防止正文行首点被吞。
fn normalize_crlf(msg: &str) -> String {
    let mut out = String::with_capacity(msg.len() + 16);
    for line in msg.split('\n') {
        let line = line.trim_end_matches('\r');
        // 行首点做点转义（\.），避免被当作结束符。
        if line.starts_with('.') {
            out.push('.');
        }
        out.push_str(line);
        out.push_str("\r\n");
    }
    out
}
