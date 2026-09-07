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
use crate::smtp::{self, SmtpSecurity};

/// 邮件元信息（阅读流用）。
#[derive(Serialize, Clone)]
pub struct EmailMeta {
    pub uid: u32,
    pub subject: String,
    pub from: String,
    pub date: String,
    pub snippet: String,
    /// 是否已读（IMAP `\Seen` 标志）。
    pub seen: bool,
    /// 是否星标（IMAP `\Flagged` 标志）。
    pub flagged: bool,
    /// 所属文件夹（收件箱/广告邮件/垃圾邮件…），用于多文件夹浏览与正文拉取。
    pub folder: String,
}

/// 建立到 INBOX/目标文件夹的 IMAP 会话（TCP + TLS + 登录 + SELECT）。
/// 供各命令复用，避免重复连接代码。
async fn open_session(
    account: &EmailAccountArgs,
    folder: &str,
) -> Result<async_imap::Session<tokio_native_tls::TlsStream<tokio::net::TcpStream>>, String> {
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
    session.select(folder).await.map_err(|e| format!("选择 {} 失败: {}", folder, e))?;
    Ok(session)
}

/// IMAP 账号参数（spike：应用密码 / 企业 IMAP；OAuth 后续）。
/// 支持序列化，便于持久化到本地配置。
#[derive(Serialize, Deserialize, Clone)]
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
    /// SMTP 发信主机（回复/转发）。缺省时复用 IMAP host。
    #[serde(default)]
    pub smtp_host: String,
    /// SMTP 端口（465 隐式 TLS / 587 STARTTLS）。
    #[serde(default)]
    pub smtp_port: u16,
    /// SMTP 传输方式：ssl(465) / starttls(587) / none。默认 ssl。
    #[serde(default)]
    pub smtp_security: String,
    /// SMTP 认证用户；缺省复用 IMAP username。
    #[serde(default)]
    pub smtp_user: String,
    /// SMTP 认证密码；缺省复用 IMAP password。
    #[serde(default)]
    pub smtp_pass: String,
    /// 可信发件人域名列表：命中域的远程图片自动加载（默认空，serde默认）。
    #[serde(default)]
    pub trusted_domains: Vec<String>,
    /// 打开邮件时自动把发件人域名加入可信（默认开，可在设置关闭）。
    #[serde(default = "default_true")]
    pub auto_trust_senders: bool,
}

fn default_true() -> bool {
    true
}

fn default_email_interval() -> u16 {
    15
}

impl EmailAccountArgs {
    fn smtp(&self) -> (String, u16, SmtpSecurity, String, String) {
        let host = if self.smtp_host.trim().is_empty() { self.host.clone() } else { self.smtp_host.clone() };
        let port = if self.smtp_port == 0 {
            if self.smtp_security == "starttls" { 587 } else { 465 }
        } else {
            self.smtp_port
        };
        let sec = SmtpSecurity::parse(&self.smtp_security);
        let user = if self.smtp_user.is_empty() { self.username.clone() } else { self.smtp_user.clone() };
        let pass = if self.smtp_pass.is_empty() { self.password.clone() } else { self.smtp_pass.clone() };
        (host, port, sec, user, pass)
    }
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
    // 注意：multipart 邮件用 get_body() 会返回包装或其空内容，须用 email_text() 递归
    // 到 text/plain|text/html 子部分取可读正文（与阅读区一致）。
    let body = email_text(&parsed);

    let title = if subject.trim().is_empty() {
        "邮件".to_string()
    } else {
        subject.trim().to_string()
    };
    let (json, text) = email_to_page_parts(&title, &body, &from, &date);
    commands::create_node(db, None, Some(title), "page", Some(json), Some(text))
}

/// “按 UID 存为笔记”入参：账号 + 文件夹 + 邮件 UID。
#[derive(Deserialize)]
pub struct EmailSaveUidArgs {
    pub account: EmailAccountArgs,
    pub uid: u32,
    #[serde(default = "default_folder")]
    pub folder: String,
}

/// 一封邮件的正文（纯文本 + 未消毒 HTML），供前端一次拉取同时拿到两者。
#[derive(Serialize)]
pub struct EmailMessageParts {
    pub text: String,
    pub html: String,
}

fn default_folder() -> String {
    "INBOX".to_string()
}

/// 把 ISO `YYYY-MM-DD` 转成 IMAP 的 `d-MMM-yyyy`（如 `2026-08-01` → `1-Aug-2026`），
/// 用于 `SEARCH SINCE/BEFORE`。无法解析时原样返回。
fn imap_date(s: &str) -> String {
    const MONTHS: [&str; 12] = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    let parts: Vec<&str> = s.split('-').collect();
    if parts.len() == 3 {
        let y = parts[0];
        let m = parts[1].parse::<usize>().ok();
        let d = parts[2].trim_start_matches('0');
        if let (Some(midx), Ok(dv)) = (m.and_then(|m| m.checked_sub(1)), d.parse::<u32>()) {
            if let Some(mon) = MONTHS.get(midx) {
                return format!("{}-{}-{}", dv, mon, y);
            }
        }
    }
    s.to_string()
}

/// 按 UID 拉取完整邮件（`BODY.PEEK[]`，不置已读）→ 存为笔记。
#[tauri::command]
pub async fn email_save_uid(db: State<'_, Db>, args: EmailSaveUidArgs) -> Result<crate::models::PageDetail, String> {
    let raw = fetch_uid_raw(&args.account, &args.folder, args.uid).await?;
    save_raw_note(db, raw)
}

async fn fetch_uid_raw(account: &EmailAccountArgs, folder: &str, uid: u32) -> Result<String, String> {
    use futures_util::StreamExt;

    let mut session = open_session(account, folder).await?;
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

/// 拉取邮件头部。入参：账号 + 要拉取的文件夹列表（多选；空则默认为 INBOX）。
/// 走 `async-imap`（tokio + native-tls），对每个文件夹 `SELECT` 后 `FETCH (ENVELOPE UID FLAGS)`，
/// 合并到一个列表，每封标注其所属 `folder`。
#[derive(Deserialize)]
pub struct EmailFetchArgs {
    pub account: EmailAccountArgs,
    #[serde(default)]
    pub folders: Vec<String>,
    /// 分页：返回按「最新在前」排序后的第 offset..offset+limit 条。默认取全量（limit=0 视为全部）。
    #[serde(default)]
    pub limit: u32,
    #[serde(default)]
    pub offset: u32,
    /// 按日期区间过滤（ISO `YYYY-MM-DD`，含端点）。给定时用 IMAP `SEARCH SINCE/BEFORE` 只取该区间邮件。
    #[serde(default)]
    pub date_from: Option<String>,
    #[serde(default)]
    pub date_to: Option<String>,
}

#[tauri::command]
pub async fn email_fetch_inbox(args: EmailFetchArgs) -> Result<Vec<EmailMeta>, String> {
    use futures_util::StreamExt;

    let folders = if args.folders.is_empty() {
        vec!["INBOX".to_string()]
    } else {
        args.folders.clone()
    };

    let mut session = open_session(&args.account, "INBOX").await?;

    // 把一条 FETCH 消息的 ENVELOPE 行转成 EmailMeta（供「全量 FETCH」与「按日期 SEARCH+FETCH」两条路径复用）。
    let build_meta = |m: &async_imap::types::Fetch, folder: &str| -> Option<EmailMeta> {
        let env = m.envelope()?;
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
                let addr = format!("{}@{}", mb, host);
                // 显示名称（RFC2047 可能编码），如 "NetBird <no-reply@netbird.io>"。
                let name = a
                    .name
                    .as_ref()
                    .map(|n| decode_mime_words(&String::from_utf8_lossy(n.as_ref())).trim().to_string())
                    .unwrap_or_default();
                if !name.is_empty() && !name.eq_ignore_ascii_case(&addr) {
                    format!("{} <{}>", name, addr)
                } else {
                    addr
                }
            })
            .unwrap_or_default();
        let date = env
            .date
            .as_ref()
            .map(|d| String::from_utf8_lossy(d.as_ref()).to_string())
            .unwrap_or_default();
        let seen = m.flags().any(|f| f == async_imap::types::Flag::Seen);
        let flagged = m.flags().any(|f| f == async_imap::types::Flag::Flagged);
        Some(EmailMeta {
            uid: m.uid.unwrap_or(0),
            subject,
            from,
            date,
            snippet: String::new(),
            seen,
            flagged,
            folder: folder.to_string(),
        })
    };

    let mut out = Vec::new();
    for folder in &folders {
        session.select(folder).await.map_err(|e| format!("选择 {} 失败: {}", folder, e))?;

        if let (Some(df), Some(dt)) = (&args.date_from, &args.date_to) {
            // 按日期区间：先用 IMAP SEARCH SINCE/BEFORE 拿该区间 UID，再只 FETCH 这些。
            // IMAP 日期格式为 `d-MMM-yyyy`，如 `01-Aug-2026`。
            let from_s = imap_date(df);
            let to_s = imap_date(dt);
            let query = format!("SINCE {} BEFORE {}", from_s, to_s);
            let ids = session
                .uid_search(&query)
                .await
                .map_err(|e| format!("按日期搜索 {} 失败: {}", folder, e))?;
            if !ids.is_empty() {
                let set = ids.iter().map(|u| u.to_string()).collect::<Vec<_>>().join(",");
                let mut stream = session
                    .uid_fetch(set, "(ENVELOPE UID FLAGS)")
                    .await
                    .map_err(|e| format!("拉取 {} 失败: {}", folder, e))?;
                while let Some(Ok(m)) = stream.next().await {
                    if let Some(meta) = build_meta(&m, folder) {
                        out.push(meta);
                    }
                }
            }
        } else {
            let mut stream = session
                .fetch("1:*", "(ENVELOPE UID FLAGS)")
                .await
                .map_err(|e| format!("拉取 {} 失败: {}", folder, e))?;
            while let Some(Ok(m)) = stream.next().await {
                if let Some(meta) = build_meta(&m, folder) {
                    out.push(meta);
                }
            }
        }
    }
    // 分页：按 UID 降序（最新在前），取 offset..offset+limit。
    out.sort_by(|a, b| b.uid.cmp(&a.uid));
    if args.limit > 0 {
        let start = (args.offset as usize).min(out.len());
        let end = (start + args.limit as usize).min(out.len());
        out = out[start..end].to_vec();
    }
    Ok(out)
}

/// 枚举收件箱里**所有含邮件的月份**（含未加载的历史），供月份选择器启用对应月份。
/// 只拉 ENVELOPE（不含正文），按每封 Date 提取 `YYYY-M` 去重，结果升序。
#[derive(Deserialize)]
pub struct EmailMonthsArgs {
    pub account: EmailAccountArgs,
    #[serde(default)]
    pub folders: Vec<String>,
}

#[tauri::command]
pub async fn email_list_months(args: EmailMonthsArgs) -> Result<Vec<String>, String> {
    use futures_util::StreamExt;

    let folders = if args.folders.is_empty() { vec!["INBOX".to_string()] } else { args.folders };
    let mut session = open_session(&args.account, "INBOX").await?;
    let mut months: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();

    for folder in &folders {
        session.select(folder).await.map_err(|e| format!("选择 {} 失败: {}", folder, e))?;
        let mut stream = session
            .fetch("1:*", "(ENVELOPE UID FLAGS)")
            .await
            .map_err(|e| format!("拉取 {} 失败: {}", folder, e))?;
        while let Some(Ok(m)) = stream.next().await {
            if let Some(env) = m.envelope() {
                if let Some(d) = env.date.as_ref() {
                    let s = String::from_utf8_lossy(d.as_ref());
                    if let Some(k) = month_key_from_date(&s) {
                        months.insert(k);
                    }
                }
            }
        }
    }
    Ok(months.into_iter().collect())
}

/// 从 Date 字符串提取 `YYYY-M`（0-based 月）键；无法解析返回 None。
fn month_key_from_date(s: &str) -> Option<String> {
    // Date 形如 "Mon, 31 Aug 2026 11:40:54 +0800 (CST)" 或已标准化的 RFC2822。
    use chrono::{DateTime, Datelike};
    let t = DateTime::parse_from_rfc2822(s.trim()).ok()?;
    Some(format!("{}-{}", t.year(), t.month0()))
}

/// 列出账号下所有可选文件夹（`LIST "" "*"`），供多选下拉用；跳过不可 SELECT 的（\Noselect）。
#[tauri::command]
pub async fn email_list_folders(args: EmailAccountArgs) -> Result<Vec<String>, String> {
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
    let mut stream = session
        .list(None, Some("*"))
        .await
        .map_err(|e| format!("LIST 失败: {}", e))?;

    let mut out = Vec::new();
    while let Some(Ok(name)) = stream.next().await {
        let no_select = name
            .attributes()
            .iter()
            .any(|a| matches!(a, async_imap::types::NameAttribute::NoSelect));
        if !no_select {
            out.push(name.name().to_string());
        }
    }
    out.sort();
    Ok(out)
}

/// 收件箱内操作入参：账号 + 文件夹 + 邮件 UID。
#[derive(Deserialize)]
pub struct EmailOpArgs {
    pub account: EmailAccountArgs,
    pub uid: u32,
    #[serde(default = "default_folder")]
    pub folder: String,
}

/// 设置邮件星标（`\Flagged`）。`flag=true` 打星，否则取消。
#[tauri::command]
pub async fn email_set_flag(args: EmailOpArgs, flag: bool) -> Result<(), String> {
    use futures_util::StreamExt;
    let mut session = open_session(&args.account, &args.folder).await?;
    let q = if flag { "+FLAGS.SILENT (\\Flagged)" } else { "-FLAGS.SILENT (\\Flagged)" };
    let mut stream = session
        .uid_store(format!("{}", args.uid), q)
        .await
        .map_err(|e| format!("设置星标失败: {}", e))?;
    while stream.next().await.is_some() {}
    Ok(())
}

/// 标记邮件已读/未读（`\Seen`）。
#[tauri::command]
pub async fn email_mark_read(args: EmailOpArgs, read: bool) -> Result<(), String> {
    use futures_util::StreamExt;
    let mut session = open_session(&args.account, &args.folder).await?;
    let q = if read { "+FLAGS.SILENT (\\Seen)" } else { "-FLAGS.SILENT (\\Seen)" };
    let mut stream = session
        .uid_store(format!("{}", args.uid), q)
        .await
        .map_err(|e| format!("标记已读失败: {}", e))?;
    while stream.next().await.is_some() {}
    Ok(())
}

/// 删除邮件：`UID MOVE` 到「已删除」文件夹（可回收）。依次尝试常见文件夹名，
/// 都失败时回退到标记 `\Deleted` + EXPUNGE（至少从列表移除）。
#[tauri::command]
pub async fn email_move_to_trash(args: EmailOpArgs) -> Result<(), String> {
    use futures_util::StreamExt;
    let mut session = open_session(&args.account, &args.folder).await?;
    let uid = format!("{}", args.uid);
    let candidates = ["Trash", "Deleted Messages", "Deleted Items", "垃圾箱", "已删除"];

    for trash in candidates {
        if session.uid_mv(&uid, trash).await.is_ok() {
            return Ok(());
        }
    }

    // 回退：标记删除并 EXPUNGE（消费流，完成服务器端处理）。
    {
        let store = session
            .uid_store(&uid, "+FLAGS.SILENT (\\Deleted)")
            .await
            .map_err(|e| format!("删除失败: {}", e))?;
        futures_util::pin_mut!(store);
        while store.next().await.is_some() {}
    }
    let expunge = session.expunge().await.map_err(|e| format!("删除失败: {}", e))?;
    futures_util::pin_mut!(expunge);
    while expunge.next().await.is_some() {}
    Ok(())
}

/// 批量删除邮件：一次连接对多个 UID `UID MOVE` 到「已删除」。返回成功删除的 UID 数。
#[derive(Deserialize)]
pub struct EmailBatchOpArgs {
    pub account: EmailAccountArgs,
    pub uids: Vec<u32>,
    #[serde(default = "default_folder")]
    pub folder: String,
}

#[tauri::command]
pub async fn email_move_many_to_trash(args: EmailBatchOpArgs) -> Result<u32, String> {
    let mut session = open_session(&args.account, &args.folder).await?;
    let candidates = ["Trash", "Deleted Messages", "Deleted Items", "垃圾箱", "已删除"];

    let mut moved = 0u32;
    for uid in &args.uids {
        let uid_str = format!("{}", uid);
        let mut ok = false;
        for trash in candidates {
            if session.uid_mv(&uid_str, trash).await.is_ok() {
                ok = true;
                break;
            }
        }
        if !ok {
            // 回退：标记删除并 EXPUNGE。
            if session
                .uid_store(&uid_str, "+FLAGS.SILENT (\\Deleted)")
                .await
                .is_ok()
            {
                let _ = session.expunge().await;
                ok = true;
            }
        }
        if ok {
            moved += 1;
        }
    }
    Ok(moved)
}

/// 批量标记已读/未读：一次连接对多个 UID 设置 `\Seen`。返回成功标记数。
#[tauri::command]
pub async fn email_mark_many_read(args: EmailBatchOpArgs, read: bool) -> Result<u32, String> {
    use futures_util::StreamExt;

    let mut session = open_session(&args.account, &args.folder).await?;
    let q = if read { "+FLAGS.SILENT (\\Seen)" } else { "-FLAGS.SILENT (\\Seen)" };
    let mut done = 0u32;
    for uid in &args.uids {
        let stream = session
            .uid_store(format!("{}", uid), q)
            .await
            .map_err(|e| format!("标记失败: {}", e))?;
        futures_util::pin_mut!(stream);
        while stream.next().await.is_some() {}
        done += 1;
    }
    Ok(done)
}

/// 发送邮件（回复/转发）：入参为账号 + 收件人 + 主题 + 正文，后端用 SMTP 发出。
#[derive(Deserialize)]
pub struct EmailSendArgs {
    pub account: EmailAccountArgs,
    pub to: String,
    pub subject: String,
    pub body: String,
}

/// 构造纯文本 MIME 消息（含头 + 空行 + 正文），并规范化换行。
fn build_mime(from: &str, to: &str, subject: &str, body: &str) -> String {
    let msg_id = format!("<{}-{}@shuyonote.local>", Uuid::new_v4().simple(), chrono::Utc::now().timestamp_millis());
    let date = chrono::Utc::now().to_rfc2822();
    // 头部字段值若有非 ASCII，简单 base64 编码（RFC2047），保证中文主题/收件人不乱码。
    let subj_enc = encode_header(subject);
    let to_enc = encode_header(to);
    format!(
        "From: {from}\r\nTo: {to}\r\nSubject: {subj}\r\nDate: {date}\r\nMessage-ID: {msg_id}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n{body}",
        from = from,
        to = to_enc,
        subj = subj_enc,
    )
}

/// RFC2047：含非 ASCII 时按 UTF-8 base64 编码为 `=?utf-8?B?..?=`。
fn encode_header(v: &str) -> String {
    if v.is_ascii() {
        return v.to_string();
    }
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(v.as_bytes());
    format!("=?utf-8?B?{}?=", b64)
}

#[tauri::command]
pub async fn email_send(args: EmailSendArgs) -> Result<(), String> {
    let (host, port, sec, user, pass) = args.account.smtp();
    if args.to.trim().is_empty() {
        return Err("收件人不能为空".to_string());
    }
    let from = args.account.username.clone();
    let msg = build_mime(&from, &args.to, &args.subject, &args.body);
    smtp::send(&host, port, &user, &pass, sec, &from, &args.to, &msg).await
}

/// 拉取 INBOX 未读数量（轻量 `STATUS INBOX (UNSEEN)`），供定时收取/未读角标用。
#[tauri::command]
pub async fn email_unseen_count(args: EmailAccountArgs) -> Result<u32, String> {
    fetch_unseen(&args).await
}

async fn fetch_unseen(account: &EmailAccountArgs) -> Result<u32, String> {
    let mut session = open_session(account, "INBOX").await?;
    let mbox = session
        .status("INBOX", "(UNSEEN)")
        .await
        .map_err(|e| format!("STATUS 失败: {}", e))?;
    Ok(mbox.unseen.unwrap_or(0))
}

/// 定时收取的全局状态：`Mutex<()>` 作为互斥门闩，防止一次轮询与手动拉取重叠
/// （连两次 IMAP 会抢同一个账号的会话）。
#[derive(Default)]
pub struct EmailPollState {
    pub busy: tokio::sync::Mutex<()>,
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
            let accounts = email_list_accounts(app.state::<Db>(), app.clone()).unwrap_or_default();
            let fetchable: Vec<&EmailAccountArgs> = accounts.iter().filter(|a| a.auto_fetch).collect();
            if fetchable.is_empty() {
                // 未配置 / 未开启自动收取：每 30s 醒来看一眼配置变化，几乎零开销。
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                continue;
            }
            let minutes = fetchable.iter().map(|a| (a.interval_minutes.max(5)) as u64).min().unwrap_or(15);
            // 门闩：加锁失败说明上次轮询或手动拉取仍在进行，跳过本轮。
            if let Ok(_guard) = state.busy.try_lock() {
                let mut total = 0u32;
                let mut ok = false;
                for a in &fetchable {
                    if let Ok(n) = fetch_unseen(*a).await {
                        total += n;
                        ok = true;
                    }
                }
                if ok {
                    failures = 0;
                    let _ = app.emit(POLL_EVENT, total);
                    tokio::time::sleep(std::time::Duration::from_secs(minutes * 60)).await;
                } else {
                    failures += 1;
                    // 退避：30s 起，指数翻倍，封顶 10 分钟。
                    let backoff = 30u64.saturating_mul(2u64.saturating_pow(failures.min(6))).min(600);
                    tokio::time::sleep(std::time::Duration::from_secs(backoff)).await;
                }
            } else {
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            }
        }
    });
}

/// 按 UID 取邮件正文（纯文本，供右侧阅读窗格显示）。
#[tauri::command]
pub async fn email_get_body(args: EmailSaveUidArgs) -> Result<String, String> {
    let raw = fetch_uid_raw(&args.account, &args.folder, args.uid).await?;
    let parsed = mailparse::parse_mail(raw.as_bytes()).map_err(|e| e.to_string())?;
    Ok(email_text(&parsed))
}

/// 按 UID 取邮件正文的 HTML（未消毒，供前端 DOMPurify 富文本渲染）。
/// 选中无 text/html 子部分时回退为纯文本（此时前端按文本显示）。
#[tauri::command]
pub async fn email_get_html(args: EmailSaveUidArgs) -> Result<String, String> {
    let raw = fetch_uid_raw(&args.account, &args.folder, args.uid).await?;
    let parsed = mailparse::parse_mail(raw.as_bytes()).map_err(|e| e.to_string())?;
    let mut html = String::new();
    if email_html_collect(&parsed, &mut html) {
        Ok(html)
    } else {
        Ok(email_text(&parsed))
    }
}

/// 按 UID 一次拉取并解析，同时返回纯文本 + 未消毒 HTML（供前端一次调用拿到两者，
/// 避免此前点开一封邮件时并发两次 IMAP 连接 + 两次拉取完整报文 + 两次解析）。
#[tauri::command]
pub async fn email_get_message(args: EmailSaveUidArgs) -> Result<EmailMessageParts, String> {
    let raw = fetch_uid_raw(&args.account, &args.folder, args.uid).await?;
    let parsed = mailparse::parse_mail(raw.as_bytes()).map_err(|e| e.to_string())?;
    let text = email_text(&parsed);
    let mut html = String::new();
    let html = if email_html_collect(&parsed, &mut html) { html } else { text.clone() };
    Ok(EmailMessageParts { text, html })
}

/// 提取邮件附件并写入内容寻址附件库，返回附件元信息（供插入笔记/列表展示）。
/// 递归解析 MIME 子部分，把 `Content-Disposition: attachment`（或带 filename 的）
/// 子部分的字节用 sha256 内容寻址存储，同名/同内容自动去重。
#[tauri::command]
pub async fn email_get_attachments(
    app: tauri::AppHandle,
    db: State<'_, crate::db::Db>,
    args: EmailSaveUidArgs,
) -> Result<Vec<crate::models::AttachmentMeta>, String> {
    use sha2::{Digest, Sha256};

    let raw = fetch_uid_raw(&args.account, &args.folder, args.uid).await?;
    let parsed = mailparse::parse_mail(raw.as_bytes()).map_err(|e| e.to_string())?;

    fn walk<'a>(
        p: &'a mailparse::ParsedMail<'a>,
        out: &mut Vec<(&'a str, String, Vec<u8>)>,
    ) {
        // 从 Content-Disposition header 判断是否附件，并取 filename。
        let mut filename: Option<String> = None;
        let mut is_attachment = false;
        for h in &p.headers {
            if h.get_key().eq_ignore_ascii_case("Content-Disposition") {
                let cd = mailparse::parse_content_disposition(&h.get_value());
                filename = cd.params.get("filename").cloned().or_else(|| cd.params.get("name").cloned());
                is_attachment = cd.params.get("filename").map(|s| !s.is_empty()).unwrap_or(false)
                    || cd.params.get("name").map(|s| !s.is_empty()).unwrap_or(false)
                    || matches!(cd.disposition, mailparse::DispositionType::Attachment);
                break;
            }
        }
        // ctype 里也可能带 filename/name 参数。
        if filename.is_none() {
            filename = p.ctype.params.get("filename").cloned().or_else(|| p.ctype.params.get("name").cloned());
        }
        if is_attachment || filename.as_ref().map(|s| !s.is_empty()).unwrap_or(false) {
            let name = filename.unwrap_or_else(|| "attachment".to_string());
            if let Ok(bytes) = p.get_body_raw() {
                out.push((&p.ctype.mimetype, name, bytes));
            }
        }
        for sub in &p.subparts {
            walk(sub, out);
        }
    }

    let mut found: Vec<(&str, String, Vec<u8>)> = Vec::new();
    walk(&parsed, &mut found);

    let mut result = Vec::new();
    for (mime, name, data) in found {
        if data.is_empty() {
            continue;
        }
        let hash = {
            let mut h = Sha256::new();
            h.update(&data);
            hex_of(&h.finalize())
        };
        let meta = crate::attachments::write_attachment_bytes(app.clone(), db.clone(), hash, mime.to_string(), name, data)
            .map_err(|e| format!("附件写入失败: {}", e))?;
        result.push(meta);
    }
    Ok(result)
}

/// 小写 hex（sha2 0.11 的 Output 不再实现 LowerHex）。
fn hex_of(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 递归取邮件正文：收集所有候选（text/plain 与 text/html），返回**最长**的一个。
/// 这样 multipart/alternative 里即便 text/plain 只有简短版权、text/html 才是完整正文，
/// 也会取到内容更全的那份；纯 HTML 时剥标签。
fn email_text(p: &mailparse::ParsedMail) -> String {
    let mut best = String::new();
    email_text_collect(p, &mut best);
    best
}

fn email_text_collect(p: &mailparse::ParsedMail, best: &mut String) {
    if p.ctype.mimetype == "text/plain" || p.ctype.mimetype == "text/html" {
        // 用 get_body()（已解码 Content-Transfer-Encoding）；不要用 get_body_raw()——
        // 它会返回 QP/Base64 编码的原始字节，转成 string 是 `=E5..` 乱码且更长，会盖过正确解码的正文。
        let t = strip_html(&p.get_body().unwrap_or_default());
        if t.len() > best.len() {
            *best = t;
        }
        return;
    }
    for sub in &p.subparts {
        email_text_collect(sub, best);
    }
}

/// 从邮件里提取「可富文本渲染」的 HTML 部分（未消毒，交由前端 DOMPurify）。
/// 只剔除 script/style 与 display:none 预读，其余保留。返回整封邮件里第一个含富文本
/// 的 text/html 子部分；没有则回退纯文本。
fn email_html_collect(p: &mailparse::ParsedMail, best: &mut String) -> bool {
    if p.ctype.mimetype == "text/html" {
        let body = p.get_body().unwrap_or_default();
        // 剔除 script/style 与 display:none 预读，其余 HTML 原样保留给前端消毒。
        let cleaned = sanitize_pre_html(&body);
        *best = cleaned;
        return true;
    }
    for sub in &p.subparts {
        if email_html_collect(sub, best) {
            return true;
        }
    }
    false
}

/// 从原始 HTML 里仅剔除 script/style 与 display:none 预读文本（不做标签白名单——
/// 那是前端 DOMPurify 的职责）。
fn sanitize_pre_html(s: &str) -> String {
    let re_script = regex::Regex::new(r"(?is)<(script|style)\b[^>]*>.*?<\/(script|style)\s*>").unwrap();
    let re_hidden = regex::Regex::new(r"(?is)<(span|div|p|td|tr)\b[^>]*style[^>]*display\s*:\s*none[^>]*>.*?<\/(?:span|div|p|td|tr)\s*>").unwrap();
    let s = re_hidden.replace_all(s, "").into_owned();
    let s = re_script.replace_all(&s, "").into_owned();
    s.trim().to_string()
}

/// 把 HTML/混合正文转成可读纯文本。
///
/// 保守处理：只移除 script/style 与标签本身、把 <br>/块级闭合标签换成换行，
/// 不额外切割开标签——避免误伤正文内容（营销邮件常把每行嵌进 <div>/<span>）。
/// 段落由 <br>、块级闭合标签或连续空行自然形成，前端再按空行分段。
fn strip_html(s: &str) -> String {
    // 注意：regex crate 不支持反向引用 `\1`，故用「对应闭合标签」展开替代。
    let re_script = regex::Regex::new(r"(?is)<(script|style)\b[^>]*>.*?<\/(script|style)\s*>").unwrap();
    // 移除 display:none 的预读/隐藏文本（营销邮件常把"此邮件由X发送，请勿直接回复"放在这里）。
    // regex 不支持反向引用，按标签名分别匹配常见的隐藏容器（span/div/p）。
    let re_hidden = regex::Regex::new(r"(?is)<(span|div|p|td|tr)\b[^>]*style[^>]*display\s*:\s*none[^>]*>.*?<\/(?:span|div|p|td|tr)\s*>").unwrap();
    let re_br = regex::Regex::new(r"(?i)<br\s*/?>").unwrap();
    // 仅对「块级闭合标签」插入换行（形成段落），不处理开标签，避免把正文拆碎或误删。
    let re_block = regex::Regex::new(
        r"(?i)</(p|div|h[1-6]|li|tr|td|th|table|blockquote|ul|ol|dl|dt|dd|section|article|header|footer|nav|pre)\s*>"
    ).unwrap();
    let re_tag = regex::Regex::new(r"(?s)<[^>]+>").unwrap();
    let re_space = regex::Regex::new(r"[ \t]+").unwrap();
    let re_nl = regex::Regex::new(r"[ \t]*\n[ \t]*").unwrap();
    let re_blank = regex::Regex::new(r"\n\s*\n\s*\n+").unwrap();
    let s = re_hidden.replace_all(s, "").into_owned();
    let s = re_script.replace_all(&s, " ").into_owned();
    let s = re_br.replace_all(&s, "\n").into_owned();
    let s = re_block.replace_all(&s, "\n\n").into_owned();
    let s = re_tag.replace_all(&s, "").into_owned();
    let s = re_space.replace_all(&s, " ").into_owned();
    // 保留单换行，多个空行压成一个。
    let s = re_nl.replace_all(&s, "\n").into_owned();
    let s = re_blank.replace_all(&s, "\n\n").into_owned();
    // 去掉 QP 软换行残渣：`=\n`/`=\r\n`（紧跟换行的 `=`，是软续行，不会误伤正文）。
    let re_qp_soft = regex::Regex::new(r"=\r?\n").unwrap();
    let s = re_qp_soft.replace_all(&s, "\n").into_owned();
    let re_qp_lone = regex::Regex::new(r"(?m)^[ \t]*=[ \t]*$").unwrap();
    let s = re_qp_lone.replace_all(&s, "").into_owned();
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

/// 账号唯一键：host + username（同一邮箱服务器 + 用户名视为同一账号）。
fn account_key(a: &EmailAccountArgs) -> String {
    format!("{}|{}", a.host.to_lowercase(), a.username.to_lowercase())
}

/// 读取账号列表（未配置返回空）。兼容旧的单对象格式（包装成单元素列表）。
fn load_accounts(path: &std::path::Path) -> Result<Vec<EmailAccountArgs>, String> {
    let content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    // 先按数组解析；失败则按单对象（旧格式）解析，包装成单元素。
    if let Ok(list) = serde_json::from_str::<Vec<EmailAccountArgs>>(&content) {
        return Ok(list);
    }
    if let Ok(single) = serde_json::from_str::<EmailAccountArgs>(&content) {
        return Ok(vec![single]);
    }
    Ok(Vec::new())
}

/// 对账号列表按会话密钥加密密码后写盘。
fn save_accounts(
    path: &std::path::Path,
    key: Option<&[u8; 32]>,
    accounts: &[EmailAccountArgs],
) -> Result<(), String> {
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    let mut list = accounts.to_vec();
    for a in list.iter_mut() {
        if let Some(k) = key {
            a.password = crate::crypto::encrypt_str(&a.password, k).unwrap_or_else(|_| a.password.clone());
            if !a.smtp_pass.is_empty() {
                a.smtp_pass = crate::crypto::encrypt_str(&a.smtp_pass, k).unwrap_or_else(|_| a.smtp_pass.clone());
            }
        }
    }
    let json = serde_json::to_string_pretty(&list).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

/// 解密账号列表的密码（配合会话密钥）。
fn decrypt_accounts(key: Option<&[u8; 32]>, mut accounts: Vec<EmailAccountArgs>) -> Vec<EmailAccountArgs> {
    if let Some(k) = key {
        for a in accounts.iter_mut() {
            if let Ok(p) = crate::crypto::decrypt_str(&a.password, k) {
                a.password = p;
            }
            if !a.smtp_pass.is_empty() {
                if let Ok(p) = crate::crypto::decrypt_str(&a.smtp_pass, k) {
                    a.smtp_pass = p;
                }
            }
        }
    }
    accounts
}

fn session_key(db: &State<'_, Db>) -> Option<[u8; 32]> {
    crate::security::key_if_enabled(&db.0.lock().expect("db mutex poisoned"))
}

/// 保存 IMAP 账号配置（支持多账号：按 host+username upsert，并把该账号设为「当前活动」）。
/// 安全：开启 E1 且解锁时用会话密钥加密 password/smtp_pass 后落盘。
#[tauri::command]
pub fn email_save_account(db: State<Db>, app: tauri::AppHandle, account: EmailAccountArgs) -> Result<(), String> {
    let path = account_path(&app)?;
    let key = session_key(&db);
    let mut list = if path.exists() {
        load_accounts(&path).unwrap_or_default()
    } else {
        Vec::new()
    };
    // upsert：同 host+username 替换，否则追加。
    let k = account_key(&account);
    list.retain(|a| account_key(a) != k);
    list.insert(0, account); // 最新保存的设为活动（列表首位）
    save_accounts(&path, key.as_ref(), &list)
}

/// 读取当前活动账号（列表首位；兼容旧单对象）。密码在未加密/未锁定时应为明文。
#[tauri::command]
pub fn email_get_account(db: State<Db>, app: tauri::AppHandle) -> Result<Option<EmailAccountArgs>, String> {
    let path = account_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let key = session_key(&db);
    let list = load_accounts(&path)?;
    let decrypted = decrypt_accounts(key.as_ref(), list);
    Ok(decrypted.first().cloned())
}

/// 列出所有已保存邮箱账号（含解密后的密码），供前端标签/管理。
#[tauri::command]
pub fn email_list_accounts(db: State<Db>, app: tauri::AppHandle) -> Result<Vec<EmailAccountArgs>, String> {
    let path = account_path(&app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let key = session_key(&db);
    let list = load_accounts(&path)?;
    Ok(decrypt_accounts(key.as_ref(), list))
}

/// 删除一个邮箱账号（按 host+username）。返回是否删除到。
#[tauri::command]
pub fn email_remove_account(db: State<Db>, app: tauri::AppHandle, account: EmailAccountArgs) -> Result<bool, String> {
    let path = account_path(&app)?;
    if !path.exists() {
        return Ok(false);
    }
    let key = session_key(&db);
    let k = account_key(&account);
    let mut list = load_accounts(&path)?;
    list = decrypt_accounts(key.as_ref(), list);
    let before = list.len();
    list.retain(|a| account_key(a) != k);
    save_accounts(&path, key.as_ref(), &list)?;
    Ok(list.len() != before)
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

    #[test]
    fn email_text_extracts_html_body_with_paragraphs() {
        // 多段 HTML：验证段落被空行隔开，而不是连成一坨。
        let raw = "From: a@b.com\r\nSubject: test\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<html><body><h1>Header</h1><p>First paragraph.</p><p>Second para.</p><div>Div text</div><p>Third line <br> break.</p></body></html>";
        let parsed = mailparse::parse_mail(raw.as_bytes()).unwrap();
        let t = email_text(&parsed);
        assert!(t.contains("Header"));
        assert!(t.contains("First paragraph."));
        assert!(t.contains("Second para."));
        assert!(t.contains("Div text"));
        assert!(!t.contains("<p>"), "html tag leaked: {:?}", t);
        // 段落之间应有空行（\n\n）分隔。
        assert!(t.contains("First paragraph.\n\nSecond para."), "paragraphs not separated: {:?}", t);
    }

    #[test]
    fn email_text_extracts_plain_text() {
        let raw = "From: a@b.com\r\nSubject: hi\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nhello body";
        let parsed = mailparse::parse_mail(raw.as_bytes()).unwrap();
        assert_eq!(email_text(&parsed), "hello body");
    }

    #[test]
    fn email_text_marketing_html_preserves_body() {
        // 模拟营销邮件的嵌套结构（div/table/链接/分隔线 + 底部版权），验证正文不丢失、只留版权。
        let raw = "From: a@b.com\r\nSubject: t\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<html><body><table><tr><td><div style=\"p\">尊敬的客户：您好</div><div>您的备案已提交至管理局审核！</div><div>请点击<a href=\"https://x.com\">查看详情</a>。</div><div>———</div><div>Copyright © 阿里云 2026 All Rights Reserved</div></td></tr></table></body></html>";
        let parsed = mailparse::parse_mail(raw.as_bytes()).unwrap();
        let t = email_text(&parsed);
        assert!(t.contains("尊敬的客户"), "body lost: {:?}", t);
        assert!(t.contains("备案已提交"), "body lost: {:?}", t);
        assert!(t.contains("Copyright"), "footer lost: {:?}", t);
        // 正文应该远不止底部版权一行。
        assert!(t.len() > "Copyright © 阿里云 2026 All Rights Reserved".len(), "only footer returned: {:?}", t);
    }

    #[test]
    fn email_text_multipart_alternative_picks_rich_part() {
        // multipart/alternative：text/plain 只含版权，text/html 含正文 —— 应优先显示完整正文。
        let raw = "From: a@b.com\r\nSubject: t\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary=\"B\"\r\n\r\n--B\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nCopyright © 阿里云\r\n--B\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>尊敬的客户，备案已提交。</p>\r\n--B--\r\n";
        let parsed = mailparse::parse_mail(raw.as_bytes()).unwrap();
        let t = email_text(&parsed);
        assert!(t.contains("尊敬的客户"), "rich part not preferred: {:?}", t);
        assert!(t.contains("备案已提交"), "rich part body lost: {:?}", t);
    }

    #[test]
    fn strip_html_keeps_text_amid_style_and_attrs() {
        // 模拟带 <style> 头部 + 大量属性/标签的营销 HTML，正文应完整保留。
        let html = "<html><head><style>body{margin:0}a{color:#333}</style></head><body><table role=\"presentation\" width=\"100%\"><tr><td><a href=\"https://x.com\"><img src=\"x.png\" alt=\"logo\"></a></td></tr><tr><td><h1>备案通知</h1><p>尊敬的客户：您的备案已提交至交通管理局审核。</p><p>请点击<a href=\"d\">此处链接</a>查看。</p></td></tr></table></body></html>";
        let t = strip_html(html);
        assert!(t.contains("备案通知"), "h1 lost: {:?}", t);
        assert!(t.contains("尊敬的客户"), "body lost: {:?}", t);
        assert!(t.contains("备案已提交至交通管理局"), "body lost: {:?}", t);
        assert!(t.contains("查看"), "link text lost: {:?}", t);
        assert!(!t.contains("<"), "tag leaked: {:?}", t);
    }

    #[test]
    fn strip_html_keeps_real_alibaba_body() {
        let html = "<html><head><style>.a{padding:10px}.b{margin:0}</style></head><body><div style=\"...\"><table><tr><td><p>尊敬的濮阳数友信息科技服务有限责任公司：</p><p>您的备案信息已经提交至通信管理局审核！</p><p>如您对此有更多疑问，请点击<a href=\"x\">联系我们</a>登录阿里云账号。</p><p class=\"f\">Copyright © 阿里云 2009-2026 All Rights Reserved</p></td></tr></table></div></body></html>";
        let t = strip_html(html);
        assert!(t.contains("尊敬的濮阳数友信息科技服务有限责任公司"), "leading content lost: {:?}", t);
        assert!(t.contains("您的备案信息已经提交至通信管理局审核"), "content lost: {:?}", t);
        assert!(t.contains("如您对此有更多疑问"), "content lost: {:?}", t);
        assert!(t.contains("联系我们"), "link text lost: {:?}", t);
    }

    #[test]
    fn strip_html_keeps_alibaba_with_preheader_and_nav() {
        // 还原真实报文的关键结构：display:none 预读 + 顶部导航 <a> 列表 + 正文多段 + 版权。
        let html = "<html><head><style type=\"text/css\">a{color:#1366ec;text-decoration:none}</style></head><body><span style=\"display:none\">此邮件由阿里云发送，请勿直接回复</span><div max-width=\"1200px\"><div class=\"nav\"><a href=\"x\">产品</a><a href=\"x\">解决方案</a><a href=\"x\">了解阿里云</a></div><div class=\"email-body\"><p>尊敬的濮阳数友信息科技服务有限责任公司：</p><p>您的备案信息已经提交至通信管理局审核！</p><p>如您对此有更多疑问，请点击<a href=\"x\">联系我们</a>登录阿里云账号。</p></div><div class=\"footer\">Copyright © 阿里云 2009-2026 All Rights Reserved</div></div></body></html>";
        let t = strip_html(html);
        assert!(t.contains("尊敬的濮阳数友信息科技服务有限责任公司"), "main content lost: {:?}", t);
        assert!(t.contains("您的备案信息已经提交至通信管理局审核"), "main content lost: {:?}", t);
        assert!(t.contains("如您对此有更多疑问"), "main content lost: {:?}", t);
        assert!(t.contains("Copyright"), "footer lost: {:?}", t);
    }

    // 手动把 UTF-8 字节编码成 quoted-printable（每非 ASCII 字符 =XX，每 76 列软换行加 =）。
    fn qp_encode(s: &str) -> String {
        let mut out = String::new();
        let mut col = 0;
        for b in s.as_bytes() {
            let cap = if *b == b'\n' {
                '='.to_string()
            } else if *b < 0x20 || *b > 0x7e || *b == b'=' {
                format!("={:02X}", b)
            } else {
                (*b as char).to_string()
            };
            if col + cap.len() > 76 {
                out.push_str("=\r\n");
                col = 0;
            }
            out.push_str(&cap);
            col += cap.len();
        }
        // 模拟真实邮件软换行结尾（部分行以 = 结束再接下一行）。
        out
    }

    #[test]
    fn email_text_real_alibaba_raw() {
        // 复现真实阿里云报文形态：multipart/mixed → text/html quoted-printable，
        // 中文以 QP(=E5..) 编码，且每 76 列用 `=` 软换行 + \r\n（与真实报文一致）。
        let html = "<html lang=\"zh-cn\">\r\n<head><style type=\"text/css\">a {color:#1366ec}</style></head>\r\n<body>\r\n<span style=\"display:none\">此邮件由阿里云发送，请勿直接回复</span>\r\n<div class=\"email-body\">\r\n<p>尊敬的濮阳数友信息科技服务有限责任公司：</p>\r\n<p>您的备案信息已经提交至通信管理局审核！</p>\r\n<p>如您对此有更多疑问，请点击<a href=\"x\">联系我们</a>登录阿里云账号。</p>\r\n<p class=\"f\">Copyright © 阿里云 2009-2026 All Rights Reserved</p>\r\n</div>\r\n</body>\r\n</html>\r\n";
        let qp = qp_encode(html);
        let raw = format!(
            "From: =?UTF-8?B?6Zi/6YeM5LqR?= <system@notice.aliyun.com>\r\nTo: zhaizy@qq.com\r\nSubject: t\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"B\"\r\n\r\n--B\r\nContent-Type: text/html;charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n{}\r\n--B--\r\n",
            qp
        );
        let parsed = mailparse::parse_mail(raw.as_bytes()).unwrap();
        let body = parsed.subparts[0].get_body().unwrap_or_default();
        // 定位：如果 get_body 只回版权（脱字符），说明 QP 解码后非 ASCII 被丢；
        // 打印以便诊断。
        eprintln!("EMAIL_TEXT body len={} zh?={}", body.len(), body.contains("尊敬的"));
        let stripped = strip_html(&body);
        eprintln!("EMAIL_TEXT stripped >>>{:?}<<<", stripped);
        assert!(stripped.contains("尊敬的濮阳数友信息科技服务有限责任公司"), "body lost: {:?}", stripped);
        assert!(stripped.contains("您的备案信息已经提交至通信管理局审核"), "body lost: {:?}", stripped);
        assert!(stripped.contains("Copyright"), "footer lost: {:?}", stripped);
    }
}
