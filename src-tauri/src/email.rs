//! 聚合邮箱（邮件即笔记）— P0。
//!
//! 最小验证链路：**邮件(RFC822) → 解析 → ShuyoNote 页面**。
//! - `email_save_as_note`：用 `mailparse` 解析一条原始邮件，生成页面（复用 `commands::create_node`，
//!   建页 + 内容 + FTS + blocks/backlinks + 同步 change 一条龙）。
//! - `email_fetch_inbox`：`async-imap`（tokio + native-tls）拉取收件箱头部（Envelope）。
//!
//! 备注：OAuth 见私有仓库 `docs/email-aggregate-monetization.md`。

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use crate::commands;
use crate::db::Db;

/// 邮件元信息（阅读流用）。
#[derive(Serialize)]
pub struct EmailMeta {
    pub uid: u32,
    pub subject: String,
    pub from: String,
    pub date: String,
    pub snippet: String,
    /// 是否已读（IMAP `\Seen` 标志）。
    pub seen: bool,
}

/// IMAP 账号参数（spike：应用密码 / 企业 IMAP；OAuth 后续）。
/// 支持序列化，便于持久化到本地配置。
#[derive(Serialize, Deserialize)]
pub struct EmailAccountArgs {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub use_tls: bool,
    /// 是否开启定时自动收取（后台轮询）。
    #[serde(default)]
    pub auto_fetch: bool,
    /// 定时收取间隔（分钟）。默认 15。
    #[serde(default = "default_email_interval")]
    pub interval_minutes: u16,
}

fn default_email_interval() -> u16 {
    15
}

/// “存为笔记”入参：一次携带一条原始 RFC822 邮件文本。
#[derive(Deserialize)]
pub struct EmailSaveArgs {
    pub raw: String,
}

/// 纯函数：把邮件内容改造成页面需要的 (content_json, content_text)。
/// 顶部附加「发件人 / 日期」信息，其余按行拆成段落。
pub fn email_to_page_parts(_title: &str, body: &str, from: &str, date: &str) -> (String, String) {
    fn para(text: &str) -> serde_json::Value {
        serde_json::json!({
            "children": [{
                "detail": 0, "format": 0, "mode": "normal", "style": "", "text": text,
                "type": "text", "version": 1
            }],
            "direction": null, "format": "", "indent": 0, "type": "paragraph",
            "version": 1, "textFormat": 0, "textStyle": "",
            "blockId": Uuid::new_v4().to_string()
        })
    }

    let mut lines: Vec<String> = Vec::new();
    if !from.is_empty() {
        lines.push(format!("发件人: {}", from));
    }
    if !date.is_empty() {
        lines.push(format!("日期: {}", date));
    }
    for l in body.lines() {
        if !l.trim().is_empty() {
            lines.push(l.to_string());
        }
    }

    let children: Vec<serde_json::Value> = lines.iter().map(|l| para(l)).collect();
    let root = serde_json::json!({
        "root": { "children": children, "direction": null, "format": "", "indent": 0, "type": "root", "version": 1 }
    });
    let text = lines.join("\n");
    (serde_json::to_string(&root).unwrap_or_else(|_| "{}".to_string()), text)
}

/// 把一条原始邮件存为笔记（capture-first 核心）。
#[tauri::command]
pub fn email_save_as_note(db: State<Db>, args: EmailSaveArgs) -> Result<crate::models::PageDetail, String> {
    save_raw_note(db, args.raw)
}

/// 解析 RFC822 → 建页。供「粘贴存为笔记」与「按 UID 存为笔记」共用。
fn save_raw_note(db: State<Db>, raw: String) -> Result<crate::models::PageDetail, String> {
    let parsed = mailparse::parse_mail(raw.as_bytes()).map_err(|e| format!("邮件解析失败: {}", e))?;
    let subject = parsed
        .headers
        .iter()
        .find(|h| h.get_key().eq_ignore_ascii_case("Subject"))
        .map(|h| h.get_value())
        .unwrap_or_default();
    let from = parsed
        .headers
        .iter()
        .find(|h| h.get_key().eq_ignore_ascii_case("From"))
        .map(|h| h.get_value())
        .unwrap_or_default();
    let date = parsed
        .headers
        .iter()
        .find(|h| h.get_key().eq_ignore_ascii_case("Date"))
        .map(|h| h.get_value())
        .unwrap_or_default();
    let body = parsed.get_body().unwrap_or_default();

    let title = if subject.trim().is_empty() {
        "邮件".to_string()
    } else {
        subject.trim().to_string()
    };
    let (json, text) = email_to_page_parts(&title, &body, &from, &date);
    commands::create_node(db, None, Some(title), "page", Some(json), Some(text))
}

/// “按 UID 存为笔记”入参：账号 + 邮件 UID。
#[derive(Deserialize)]
pub struct EmailSaveUidArgs {
    pub account: EmailAccountArgs,
    pub uid: u32,
}

/// 按 UID 拉取完整邮件（`BODY.PEEK[]`，不置已读）→ 存为笔记。
#[tauri::command]
pub async fn email_save_uid(db: State<'_, Db>, args: EmailSaveUidArgs) -> Result<crate::models::PageDetail, String> {
    let raw = fetch_uid_raw(&args.account, args.uid).await?;
    save_raw_note(db, raw)
}

async fn fetch_uid_raw(account: &EmailAccountArgs, uid: u32) -> Result<String, String> {
    use futures_util::StreamExt;
    use tokio::net::TcpStream;

    let tcp = TcpStream::connect((account.host.as_str(), account.port))
        .await
        .map_err(|e| format!("TCP 连接失败: {}", e))?;
    let tls = tokio_native_tls::TlsConnector::from(
        native_tls::TlsConnector::new().map_err(|e| e.to_string())?,
    );
    let tls_stream = tls
        .connect(&account.host, tcp)
        .await
        .map_err(|e| format!("TLS 失败: {}", e))?;

    let client = async_imap::Client::new(tls_stream);
    let mut session = client
        .login(&account.username, &account.password)
        .await
        .map_err(|(e, _c)| format!("登录失败: {}", e))?;
    session.select("INBOX").await.map_err(|e| format!("选择 INBOX 失败: {}", e))?;
    let mut stream = session
        .uid_fetch(format!("{}", uid), "(BODY.PEEK[])")
        .await
        .map_err(|e| format!("拉取失败: {}", e))?;

    let mut body = Vec::new();
    while let Some(item) = stream.next().await {
        if let Ok(m) = item {
            if let Some(b) = m.body() {
                body.extend_from_slice(b);
            }
        }
    }
    if body.is_empty() {
        return Err(format!("未取到邮件正文（UID {}）", uid));
    }
    Ok(String::from_utf8_lossy(&body).to_string())
}

/// 解码 MIME RFC 2047 编码词（`=?...?B|Q?...?=`），支持 utf-8 / gbk 等字符集。
/// 中文主题在 IMAP Envelope 里常以编码词形式返回，不解码会显示成 `=?utf-8?B?...?=`。
fn decode_mime_words(s: &str) -> String {
    let mut out = String::new();
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if s[i..].starts_with("=?") {
            if let Some(end_rel) = s[i..].find("?=") {
                let token = &s[i..i + end_rel + 2];
                if let Some(dec) = decode_mime_word(token) {
                    out.push_str(&dec);
                    i += end_rel + 2;
                    // 相邻编码词之间可能有一个空格，跳过
                    while i < bytes.len() && bytes[i] == b' ' {
                        i += 1;
                    }
                    continue;
                }
            }
        }
        // 非编码部分：ASCII 直接收进；非 ASCII 用 lossy 处理
        let ch_len = utf8_len(bytes[i]);
        let chunk = &s[i..i + ch_len.min(s.len() - i)];
        out.push_str(&String::from_utf8_lossy(chunk.as_bytes()));
        i += ch_len.min(s.len() - i);
    }
    out
}

fn utf8_len(b: u8) -> usize {
    if b < 0x80 { 1 } else if b >> 5 == 0b110 { 2 } else if b >> 4 == 0b1110 { 3 } else if b >> 3 == 0b11110 { 4 } else { 1 }
}

fn decode_mime_word(token: &str) -> Option<String> {
    let inner = token.strip_prefix("=?")?.strip_suffix("?=")?;
    let mut parts = inner.splitn(3, '?');
    let charset = parts.next()?;
    let enc = parts.next()?;
    let data = parts.next()?;
    let bytes = match enc.to_ascii_uppercase().as_str() {
        "B" => base64::engine::general_purpose::STANDARD.decode(data).ok()?,
        "Q" => {
            let mut v = Vec::new();
            let mb = data.as_bytes();
            let mut k = 0;
            while k < mb.len() {
                if mb[k] == b'_' {
                    v.push(b' ');
                    k += 1;
                } else if mb[k] == b'=' && k + 2 < mb.len() {
                    if let Ok(n) = u8::from_str_radix(&data[k + 1..k + 3], 16) {
                        v.push(n);
                        k += 3;
                    } else {
                        v.push(b'=');
                        k += 1;
                    }
                } else {
                    v.push(mb[k]);
                    k += 1;
                }
            }
            v
        }
        _ => return None,
    };
    let enc = encoding_rs::Encoding::for_label(charset.as_bytes())?;
    let (decoded, _, _) = enc.decode(&bytes);
    Some(decoded.into_owned())
}

/// 拉取收件箱头部（读最近 20 条 Envelope）。走 `async-imap`（tokio + native-tls）。
#[tauri::command]
pub async fn email_fetch_inbox(args: EmailAccountArgs) -> Result<Vec<EmailMeta>, String> {
    use futures_util::StreamExt;
    use tokio::net::TcpStream;

    let tcp = TcpStream::connect((args.host.as_str(), args.port))
        .await
        .map_err(|e| format!("TCP 连接失败: {}", e))?;
    let tls = tokio_native_tls::TlsConnector::from(
        native_tls::TlsConnector::new().map_err(|e| e.to_string())?,
    );
    let tls_stream = tls
        .connect(&args.host, tcp)
        .await
        .map_err(|e| format!("TLS 失败: {}", e))?;

    let client = async_imap::Client::new(tls_stream);
    let mut session = client
        .login(&args.username, &args.password)
        .await
        .map_err(|(e, _c)| format!("登录失败: {}", e))?;
    session.select("INBOX").await.map_err(|e| format!("选择 INBOX 失败: {}", e))?;
    let mut stream = session
        .fetch("1:*", "(ENVELOPE UID FLAGS)")
        .await
        .map_err(|e| format!("拉取失败: {}", e))?;

    let mut out = Vec::new();
    while let Some(Ok(m)) = stream.next().await {
        if let Some(env) = m.envelope() {
            let subject = env
                .subject
                .as_ref()
                .map(|s| decode_mime_words(&String::from_utf8_lossy(s.as_ref())))
                .unwrap_or_default();
            let from = env
                .from
                .as_ref()
                .and_then(|v| v.first())
                .map(|a| {
                    let mb = a
                        .mailbox
                        .as_ref()
                        .map(|x| String::from_utf8_lossy(x.as_ref()).to_string())
                        .unwrap_or_default();
                    let host = a
                        .host
                        .as_ref()
                        .map(|x| String::from_utf8_lossy(x.as_ref()).to_string())
                        .unwrap_or_default();
                    format!("{}@{}", mb, host)
                })
                .unwrap_or_default();
            let date = env
                .date
                .as_ref()
                .map(|d| String::from_utf8_lossy(d.as_ref()).to_string())
                .unwrap_or_default();
            let seen = m.flags().any(|f| f == async_imap::types::Flag::Seen);
            out.push(EmailMeta {
                uid: m.uid.unwrap_or(0),
                subject,
                from,
                date,
                snippet: String::new(),
                seen,
            });
        }
    }
    Ok(out)
}

/// 拉取 INBOX 未读数量（轻量 `STATUS INBOX (UNSEEN)`），供定时收取/未读角标用。
#[tauri::command]
pub async fn email_unseen_count(args: EmailAccountArgs) -> Result<u32, String> {
    fetch_unseen(&args).await
}

async fn fetch_unseen(account: &EmailAccountArgs) -> Result<u32, String> {
    use tokio::net::TcpStream;

    let tcp = TcpStream::connect((account.host.as_str(), account.port))
        .await
        .map_err(|e| format!("TCP 连接失败: {}", e))?;
    let tls = tokio_native_tls::TlsConnector::from(
        native_tls::TlsConnector::new().map_err(|e| e.to_string())?,
    );
    let tls_stream = tls
        .connect(&account.host, tcp)
        .await
        .map_err(|e| format!("TLS 失败: {}", e))?;

    let client = async_imap::Client::new(tls_stream);
    let mut session = client
        .login(&account.username, &account.password)
        .await
        .map_err(|(e, _c)| format!("登录失败: {}", e))?;
    let mbox = session
        .status("INBOX", "(UNSEEN)")
        .await
        .map_err(|e| format!("STATUS 失败: {}", e))?;
    Ok(mbox.unseen.unwrap_or(0))
}

/// 定时收取的全局状态：`Mutex<()>` 作为互斥门闩，防止一次轮询与手动拉取重叠
/// （连两次 IMAP 会抢同一个账号的会话）。`last_ms` 记上次成功时间，用于错误退避。
#[derive(Default)]
pub struct EmailPollState {
    pub busy: tokio::sync::Mutex<()>,
    pub last_ms: std::sync::Mutex<u64>,
}

const POLL_EVENT: &str = "email-unread";

/// 启动后台定时收取任务（在 `setup` 里调用一次）。
///
/// 折中策略：默认 15 分钟、最小 5 分钟轮询 `STATUS (UNSEEN)`（轻量，不重复拉全量），
/// 通过 `email-unread` 事件把未读数推给前端；失败时指数退避（最快 30s，封顶 10 分钟）。
/// 轮询只在 `auto_fetch` 开启时进行，且用一个 `Mutex` 门闩避免与手动拉取重叠。
pub fn start_email_poller(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<EmailPollState>();
        let mut failures: u32 = 0;
        loop {
            // 每次唤醒都重新读配置，这样账号/间隔/开关在运行中也能实时生效。
            let account = email_get_account(app.clone()).ok().flatten();
            match account {
                Some(a) if a.auto_fetch => {
                    let minutes = (a.interval_minutes.max(5)) as u64;
                    // 门闩：加锁失败说明上次轮询或手动拉取仍在进行，跳过本轮。
                    if let Ok(_guard) = state.busy.try_lock() {
                        match fetch_unseen(&a).await {
                            Ok(n) => {
                                failures = 0;
                                let _ = app.emit(POLL_EVENT, n);
                                tokio::time::sleep(std::time::Duration::from_secs(minutes * 60)).await;
                            }
                            Err(_) => {
                                failures += 1;
                                // 退避：30s 起，指数翻倍，封顶 10 分钟。
                                let backoff = 30u64.saturating_mul(2u64.saturating_pow(failures.min(6))).min(600);
                                tokio::time::sleep(std::time::Duration::from_secs(backoff)).await;
                            }
                        }
                    } else {
                        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                    }
                }
                _ => {
                    // 未配置 / 未开启自动收取：每 30s 醒来看一眼配置变化，几乎零开销。
                    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                }
            }
        }
    });
}

/// 按 UID 取邮件正文（纯文本，供右侧阅读窗格显示）。
#[tauri::command]
pub async fn email_get_body(args: EmailSaveUidArgs) -> Result<String, String> {
    let raw = fetch_uid_raw(&args.account, args.uid).await?;
    let parsed = mailparse::parse_mail(raw.as_bytes()).map_err(|e| e.to_string())?;
    Ok(email_text(&parsed))
}

/// 递归取邮件正文：优先 text/plain；仅 HTML 时剥标签。
fn email_text(p: &mailparse::ParsedMail) -> String {
    if p.ctype.mimetype == "text/plain" {
        return strip_html(&p.get_body().unwrap_or_default());
    }
    for sub in &p.subparts {
        let t = email_text(sub);
        if !t.is_empty() {
            return t;
        }
    }
    strip_html(&p.get_body().unwrap_or_default())
}

/// 把 HTML/混合正文转成可读纯文本（去 script/style、块级标签换行、剥标签、解实体、收空格）。
fn strip_html(s: &str) -> String {
    let re_script = regex::Regex::new(r"(?is)<(script|style)[^>]*>.*?</\1>").unwrap();
    let re_br = regex::Regex::new(r"(?i)<br\s*/?>").unwrap();
    let re_block = regex::Regex::new(r"(?i)</(p|div|tr|li|h[1-6]|table|td|blockquote|ul|ol)\s*>").unwrap();
    let re_tag = regex::Regex::new(r"(?s)<[^>]+>").unwrap();
    let re_space = regex::Regex::new(r"[ \t]+").unwrap();
    let re_nl = regex::Regex::new(r"\n\s*\n+").unwrap();
    let s = re_script.replace_all(s, " ").into_owned();
    let s = re_br.replace_all(&s, "\n").into_owned();
    let s = re_block.replace_all(&s, "\n").into_owned();
    let s = re_tag.replace_all(&s, "").into_owned();
    let s = re_space.replace_all(&s, " ").into_owned();
    let s = re_nl.replace_all(&s, "\n").into_owned();
    let s = s.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&apos;", "'");
    s.trim().to_string()
}

/// 本地配置文件路径（`app_data_dir/email-account.json`）。
fn account_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("email-account.json"))
        .map_err(|e| e.to_string())
}

/// 保存 IMAP 账号配置到本地（便于打开面板自动回填）。
/// 注意：生产中密码应加密（E1 / 系统凭据库），见私有仓库 `docs/email-aggregate-monetization.md`。
#[tauri::command]
pub fn email_save_account(app: tauri::AppHandle, account: EmailAccountArgs) -> Result<(), String> {
    let path = account_path(&app)?;
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&account).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

/// 读取已保存的 IMAP 账号配置（未配置返回 None）。
#[tauri::command]
pub fn email_get_account(app: tauri::AppHandle) -> Result<Option<EmailAccountArgs>, String> {
    let path = account_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(serde_json::from_str(&content).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn email_to_page_parts_builds_lexical_and_text() {
        let (json, text) = email_to_page_parts("你好", "第一行\n\n第二行", "a@x.com", "2026-09-06");
        assert!(json.contains("\"type\":\"paragraph\""));
        assert!(json.contains("第一行"));
        assert!(text.contains("发件人: a@x.com"));
        assert!(text.contains("日期: 2026-09-06"));
        assert!(text.contains("第一行"));
        assert!(text.contains("第二行"));
    }

    #[test]
    fn decode_mime_words_decodes_rfc2047_base64() {
        // "你好" 的 utf-8 base64 编码词
        let encoded = "=?utf-8?B?5L2g5aW9?=";
        assert_eq!(decode_mime_words(encoded), "你好");
    }
}
