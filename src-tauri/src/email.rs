//! 聚合邮箱（邮件即笔记）— P0。
//!
//! 最小验证链路：**邮件(RFC822) → 解析 → ShuyoNote 页面**。
//! - `email_save_as_note`：用 `mailparse` 解析一条原始邮件，生成页面（复用 `commands::create_node`，
//!   建页 + 内容 + FTS + blocks/backlinks + 同步 change 一条龙）。
//! - `email_fetch_inbox`：`async-imap`（tokio + native-tls）拉取收件箱头部（Envelope）。
//!
//! 备注：OAuth 见私有仓库 `docs/email-aggregate-monetization.md`。

use serde::{Deserialize, Serialize};
use tauri::Manager;
use tauri::State;
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
}

/// IMAP 账号参数（spike：应用密码 / 企业 IMAP；OAuth 后续）。
/// IMAP 账号参数（应用密码 / 企业 IMAP；OAuth 后续）。
/// 支持序列化，便于持久化到本地配置。
#[derive(Serialize, Deserialize)]
pub struct EmailAccountArgs {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub use_tls: bool,
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
        .fetch("1:*", "(ENVELOPE UID)")
        .await
        .map_err(|e| format!("拉取失败: {}", e))?;

    let mut out = Vec::new();
    while let Some(Ok(m)) = stream.next().await {
        if let Some(env) = m.envelope() {
            let subject = env
                .subject
                .as_ref()
                .map(|s| String::from_utf8_lossy(s.as_ref()).to_string())
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
            out.push(EmailMeta {
                uid: m.uid.unwrap_or(0),
                subject,
                from,
                date,
                snippet: String::new(),
            });
        }
    }
    Ok(out)
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
}
