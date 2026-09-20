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
    /// 来源账号标识（`host|username`）。单账号命令为空；聚合命令据此标注来源、定位账号。
    #[serde(default)]
    pub account: String,
}

/// 建立到 INBOX/目标文件夹的 IMAP 会话（TCP + TLS + 登录 + SELECT）。
/// 供各命令复用，避免重复连接代码。
/// 一条已登录并已 SELECT 的 IMAP 会话。抽成别名，免得每处都抄一遍这串泛型。
type ImapSession = async_imap::Session<tokio_native_tls::TlsStream<tokio::net::TcpStream>>;

async fn open_session(account: &EmailAccountArgs, folder: &str) -> Result<ImapSession, String> {
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
        // 带 `\Deleted` 的**不列出来**：删除走"COPY 进回收站 + 打标记"那条路时，原件在
        // 服务器上还留着（只是标了删除），列表里再显示一次就像"没删掉"。IMAP 客户端通常也这么处理。
        if m.flags().any(|f| f == async_imap::types::Flag::Deleted) {
            return None;
        }
        Some(EmailMeta {
            uid: m.uid.unwrap_or(0),
            subject,
            from,
            date,
            snippet: String::new(),
            seen,
            flagged,
            folder: folder.to_string(),
            account: String::new(),
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

/// 枚举单个账号（多文件夹）所有含邮件的月份（含未加载历史），供月份选择器启用对应月份。
/// 只拉 ENVELOPE（不含正文），按每封 Date 提取 `YYYY-M` 去重，结果升序。
async fn list_account_months(account: &EmailAccountArgs, folders: &[String]) -> Result<Vec<String>, String> {
    use futures_util::StreamExt;

    let folders = if folders.is_empty() { vec!["INBOX".to_string()] } else { folders.to_vec() };
    let mut session = open_session(account, "INBOX").await?;
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

#[tauri::command]
pub async fn email_list_months(args: EmailMonthsArgs) -> Result<Vec<String>, String> {
    list_account_months(&args.account, &args.folders).await
}

/// 把邮件 Date 规范化：去掉末尾 " (CST)" 注释、去掉开头的星期（QQ 等常写错星期，
/// 而 chrono 的 %a/rfc2822 会校验星期与日期匹配导致 Impossible）、并把 1 位数字天补零成 "07"。
fn normalize_email_date(s: &str) -> String {
    const MONTHS: [&str; 12] = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const WDAYS: [&str; 7] = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
    let s = s.trim();
    let s = match s.find(" (") { Some(i) => &s[..i], None => s };
    let mut parts: Vec<&str> = s.split_whitespace().collect();
    if let Some(first) = parts.first() {
        let name = first.trim_end_matches(',');
        if WDAYS.contains(&name) && (first.ends_with(',') || first.len() <= 3) {
            parts.remove(0);
        }
    }
    let mut out: Vec<String> = Vec::with_capacity(parts.len());
    let mut padded = false;
    for (i, p) in parts.iter().enumerate() {
        if !padded && p.len() == 1 && p.bytes().all(|b| b.is_ascii_digit()) {
            if let Some(next) = parts.get(i + 1) {
                if MONTHS.contains(next) {
                    out.push(format!("0{}", p));
                    padded = true;
                    continue;
                }
            }
        }
        out.push(p.to_string());
    }
    out.join(" ")
}

/// 尽可能解析邮件 Date 字符串（RFC2822 / RFC3339 / 若干无时区变体），失败返回 None。
/// 已先 normalize（去星期注释、补零），因此不依赖星期是否正确。
fn parse_email_date(s: &str) -> Option<chrono::DateTime<chrono::FixedOffset>> {
    let s = normalize_email_date(s);
    if let Ok(t) = chrono::DateTime::parse_from_rfc3339(&s) {
        return Some(t);
    }
    // 带时区（%z）：用 DateTime<FixedOffset> 解析（NaiveDateTime 不支持 %z）。
    for fmt in ["%d %b %Y %H:%M:%S %z"] {
        if let Ok(t) = chrono::DateTime::parse_from_str(&s, fmt) {
            return Some(t);
        }
    }
    // 无时区：NaiveDateTime + UTC 兜底（仅用于按月/排序，误差可接受）。
    for fmt in ["%d %b %Y %H:%M:%S"] {
        if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(&s, fmt) {
            if let Some(off) = chrono::FixedOffset::east_opt(0) {
                return Some(chrono::DateTime::from_naive_utc_and_offset(naive, off));
            }
        }
    }
    // 纯日期
    if let Ok(d) = chrono::NaiveDate::parse_from_str(&s, "%d %b %Y") {
        if let Some(naive) = d.and_hms_opt(0, 0, 0) {
            if let Some(off) = chrono::FixedOffset::east_opt(0) {
                return Some(chrono::DateTime::from_naive_utc_and_offset(naive, off));
            }
        }
    }
    None
}

/// 从 Date 字符串提取 `YYYY-M`（0-based 月）键；无法解析返回 None。
fn month_key_from_date(s: &str) -> Option<String> {
    use chrono::Datelike;
    let t = parse_email_date(s)?;
    Some(format!("{}-{}", t.year(), t.month0()))
}

/// 从 "YYYY-MM-DD" 提取目标 (year, month)；解析失败兜底为 (1970,1)——几乎不命中。
fn target_month(s: &str) -> (i32, u32) {
    let p: Vec<&str> = s.split('-').collect();
    if p.len() == 3 {
        if let (Ok(y), Ok(m)) = (p[0].parse::<i32>(), p[1].parse::<u32>()) {
            return (y, m);
        }
    }
    (1970, 1)
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

/// 删除邮件：**必须把它放进回收站**（可回收）。知道回收站就 `UID MOVE`，否则 `UID COPY` 进去再打
/// `\Deleted`；连回收站都定位不到就**拒绝删除**（2026-09-20 用户要求「改为进回收站」）。
// ── 删除（移入回收站 / 打删除标记）────────────────────────────────────────────
// 2026-09-20 用户报障：「批量删除以后，重新拉取后依然出现」。根因三层，都在这一小段里：
//   ① mailbox 名在 IMAP 协议里**只能是 modified UTF-7**（RFC 3501 §5.1.3）。旧代码把
//      `垃圾箱` / `已删除` 这类中文名**原样**发出去 —— 阿里云企业邮收到非法字节流后当场
//      把这连接废掉（不回任何响应），于是"逐个候选名 UID MOVE"把连接赔在第 5 个候选名上，
//      后面的回退 STORE/EXPUNGE 全落在一条死连接上，**一封都没删掉**。
//   ② 回收站该**问服务器**（`LIST` 的 `\Trash` 特殊用途标记 / 常见叫法），而不是猜名字：
//      阿里云企业邮的回收站叫「已删除邮件」（`&XfJSIJZkkK5O9g-`），原来那五个候选名一个都不对。
//   ③ 命令的结束码必须**把响应流读到底**才拿得到。旧代码 `uid_store(...).await.is_ok()`
//      只证明"命令写进了 socket"——连接已经断了也返回 Ok，于是 `moved` 是假计数，
//      界面拿这个假计数当成功，把行删掉、刷新又回来（用户看到的那一幕）。

/// IMAP mailbox 名的 modified UTF-7 编码（RFC 3501 §5.1.3）：
/// 可打印 ASCII 原样；`&` 写成 `&-`；其余按 UTF-16BE 分段 base64 后用 `&…-` 包起来（`/` → `,`）。
fn imap_utf7_encode(name: &str) -> String {
    fn flush(pending: &mut Vec<u16>, out: &mut String) {
        if pending.is_empty() {
            return;
        }
        let mut bytes = Vec::with_capacity(pending.len() * 2);
        for u in pending.drain(..) {
            bytes.extend_from_slice(&u.to_be_bytes());
        }
        out.push('&');
        out.push_str(
            &base64::engine::general_purpose::STANDARD_NO_PAD
                .encode(&bytes)
                .replace('/', ","),
        );
        out.push('-');
    }

    let mut out = String::new();
    let mut pending: Vec<u16> = Vec::new();
    for ch in name.chars() {
        if ch == '&' {
            flush(&mut pending, &mut out);
            out.push_str("&-");
        } else if ('\u{20}'..='\u{7e}').contains(&ch) {
            flush(&mut pending, &mut out);
            out.push(ch);
        } else {
            let mut buf = [0u16; 2];
            pending.extend_from_slice(ch.encode_utf16(&mut buf));
        }
    }
    flush(&mut pending, &mut out);
    out
}

/// 从 `LIST` 的结果里挑回收站（纯函数，便于钉判据）。
/// 入参是 `(协议名, 是否带 \Trash 标记)`；返回的是**协议名**，要原样回给 SELECT/MOVE/UID MOVE
/// （**别再编一次** —— 服务器给的已经是协议层名字）。
fn pick_trash(names: &[(String, bool)]) -> Option<String> {
    // ① 服务器自己标了 `\Trash` 最可信（阿里云企业邮就标了，虽然它不广告 SPECIAL-USE）。
    if let Some((name, _)) = names.iter().find(|(_, is_trash)| *is_trash) {
        return Some(name.clone());
    }
    // ② 其次按常见叫法匹配：英文名不区分大小写；中文名在协议层是 UTF-7，按编码后比。
    //    层级名也比**末段**：Gmail 的回收站叫 `[Gmail]/Trash`、Dovecot 常见 `INBOX.Trash`，
    //    整名跟 `trash` 比永远不相等（旧代码正是这么漏的）。
    const WANTED: [&str; 7] = [
        "trash",
        "deleted messages",
        "deleted items",
        "deleted",
        "已删除邮件",
        "已删除",
        "垃圾箱",
    ];
    for want in WANTED {
        for (name, _) in names {
            let tail = name.rsplit(|c| c == '/' || c == '.').next().unwrap_or(name);
            if name.eq_ignore_ascii_case(want)
                || tail.eq_ignore_ascii_case(want)
                || name == &imap_utf7_encode(want)
                || tail == imap_utf7_encode(want)
            {
                return Some(name.clone());
            }
        }
    }
    None
}

/// 问服务器：回收站叫什么。问不出来就 `None` —— 那时 `delete_one` **拒绝删除**并如实报错
/// （宁可"没删"，也不做收不回来的删除）。
async fn resolve_trash(session: &mut ImapSession) -> Option<String> {
    use futures_util::StreamExt;
    let mut stream = session.list(None, Some("*")).await.ok()?;
    let mut names: Vec<(String, bool)> = Vec::new();
    while let Some(item) = stream.next().await {
        let Ok(name) = item else { continue };
        let is_trash = name
            .attributes()
            .iter()
            .any(|a| matches!(a, async_imap::types::NameAttribute::Trash));
        names.push((name.name().to_string(), is_trash));
    }
    pick_trash(&names)
}

/// 删除一封邮件的结果：分「连接类」（重开连接还有救）与「服务器拒绝」（重试也没用）。
enum DeleteErr {
    Conn(String),
    Rejected(String),
}

impl DeleteErr {
    fn message(&self) -> String {
        match self {
            DeleteErr::Conn(m) | DeleteErr::Rejected(m) => m.clone(),
        }
    }
}

/// 连接类错误（掉了 / 读写失败）：值得重开连接再试一次。
fn is_conn_lost(e: &async_imap::error::Error) -> bool {
    matches!(
        e,
        async_imap::error::Error::ConnectionLost | async_imap::error::Error::Io(_)
    )
}

fn delete_err(what: &str, e: async_imap::error::Error) -> DeleteErr {
    let msg = format!("{}：{}", what, e);
    if is_conn_lost(&e) {
        DeleteErr::Conn(msg)
    } else {
        DeleteErr::Rejected(msg)
    }
}

/// 删掉一封邮件 = **把它挪进回收站**（用户 2026-09-20：「改为进回收站」）。
///
/// 三条路，**任何一条都不做"就地永久删除"**：
/// ① 知道回收站名 + 服务器支持 MOVE ⇒ `UID MOVE` 进去（一步到位）；
/// ② 不支持 MOVE ⇒ **先 `UID COPY` 进回收站**（这一步才是"进回收站"的保证），再打 `\Deleted`；
///    能 `UID EXPUNGE <uid>`（RFC 4315 UIDPLUS，只清这一封）就顺手把原件清掉，
///    拿不到 UIDPLUS 就**留着**——回收站里已有一份，列表那侧按 `\Deleted` 过滤，用户看不见；
/// ③ 连回收站在哪儿都不知道 ⇒ **拒绝删除并如实报错**（宁可"没删"，也不做收不回来的删除）。
///
/// ⚠️ 为什么删掉了"整箱 `EXPUNGE`"这条回退：它清的是**本文件夹里所有带 `\Deleted` 的信**，
/// 而且**完全绕过回收站** —— 用户那天用客户端删了上百封，QQ 的「已删除」里一封都没有，就是这么没的。
/// 那批信 IMAP 层面无法恢复，所以这条回退必须消失，而不是"只当兜底"。
/// **每一步都把响应流读到底并检查结束状态** —— 这是 2026-09-20 那次"假成功"的关键。
async fn delete_one(
    session: &mut ImapSession,
    uid: u32,
    trash: Option<&str>,
) -> Result<(), DeleteErr> {
    use futures_util::StreamExt;

    let Some(folder) = trash else {
        return Err(DeleteErr::Rejected(
            "没找到这个邮箱的回收站文件夹，出于安全没有删除（不然就收不回来了）".to_string(),
        ));
    };

    // ① MOVE：服务器支持就一步进回收站
    match session.uid_mv(uid.to_string(), folder).await {
        Ok(()) => return Ok(()),
        Err(e) if is_conn_lost(&e) => {
            return Err(delete_err("移动到回收站时连接中断", e));
        }
        // MOVE 不支持 / 目标不收（`BAD`/`NO`）→ 走 ②
        Err(_) => {}
    }

    // ②-1 先 COPY 进回收站。**这一步失败就什么都不做**：宁可不删，也不能删了收不回。
    session
        .uid_copy(uid.to_string(), folder)
        .await
        .map_err(|e| delete_err("复制到回收站失败（没有删除任何邮件）", e))?;

    // ②-2 再打 `\Deleted`。流必须读到底：结束码只有读出来才知道。
    {
        let store = session
            .uid_store(uid.to_string(), "+FLAGS.SILENT (\\Deleted)")
            .await
            .map_err(|e| delete_err("打删除标记失败（回收站里已有副本）", e))?;
        futures_util::pin_mut!(store);
        while let Some(item) = store.next().await {
            item.map_err(|e| delete_err("打删除标记失败（回收站里已有副本）", e))?;
        }
    }

    // ②-3 能只清这一封就清（UID EXPUNGE）；清不掉就留着 —— 回收站里已有副本，
    //      列表按 `\Deleted` 过滤后用户看不到，**绝不回退到整箱 EXPUNGE**。
    if let Ok(expunge) = session.uid_expunge(uid.to_string()).await {
        futures_util::pin_mut!(expunge);
        while let Some(item) = expunge.next().await {
            match item {
                Ok(_) => {}
                Err(e) if is_conn_lost(&e) => {
                    return Err(delete_err("清掉原件时连接中断（回收站里已有副本）", e));
                }
                // 服务器拒绝清原件：不影响"已进回收站"这个结果，留着即可。
                Err(_) => break,
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn email_move_to_trash(args: EmailOpArgs) -> Result<(), String> {
    let mut session = open_session(&args.account, &args.folder).await?;
    let trash = resolve_trash(&mut session).await;
    delete_one(&mut session, args.uid, trash.as_deref())
        .await
        .map_err(|e| e.message())
}

/// 批量删除邮件：一次连接搬多封，**每封都走 [`delete_one`]**（即"必须进回收站"那三条路）。
/// 返回**真正**删掉的封数；一封都没删掉时返回 `Err`（不再把假成功交给界面）。
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
    let mut trash = resolve_trash(&mut session).await;
    let mut moved = 0u32;
    let mut first_err: Option<String> = None;

    for uid in &args.uids {
        match delete_one(&mut session, *uid, trash.as_deref()).await {
            Ok(()) => moved += 1,
            // 连接断了：重开一次，把这一封补上（一次断连不该让整批静默失败）
            Err(DeleteErr::Conn(msg)) => {
                first_err.get_or_insert(msg);
                if let Ok(mut fresh) = open_session(&args.account, &args.folder).await {
                    trash = resolve_trash(&mut fresh).await;
                    if delete_one(&mut fresh, *uid, trash.as_deref()).await.is_ok() {
                        moved += 1;
                    }
                }
            }
            Err(DeleteErr::Rejected(msg)) => {
                first_err.get_or_insert(msg);
            }
        }
    }

    if moved == 0 && !args.uids.is_empty() {
        return Err(first_err.unwrap_or_else(|| "服务器拒绝了这次删除（一封都没删掉）".to_string()));
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

/// 测试 IMAP 连接（登录 + 选 INBOX），并可选的 SMTP 认证（不发信）。供配置面板「测试」用。
#[tauri::command]
pub async fn email_test_connection(account: EmailAccountArgs) -> Result<String, String> {
    // IMAP：开会话并登录（open_session 已 login），再选 INBOX 验证可读。
    let mut session = open_session(&account, "INBOX").await.map_err(|e| format!("IMAP: {}", e))?;
    session.select("INBOX").await.map_err(|e| format!("IMAP 选择 INBOX 失败: {}", e))?;

    // SMTP：仅当配置了 SMTP 服务器/账号/授权码才验证（不发信）。
    let (host, port, sec, user, pass) = account.smtp();
    let has_smtp = !account.smtp_host.trim().is_empty()
        || !account.smtp_user.trim().is_empty()
        || !account.smtp_pass.is_empty();
    if has_smtp {
        smtp::verify(&host, port, &user, &pass, sec)
            .await
            .map_err(|e| format!("SMTP: {}", e))?;
        Ok("连接成功：IMAP 可用；SMTP 认证通过".to_string())
    } else {
        Ok("连接成功：IMAP 可用（未配置 SMTP，回复/转发不可用）".to_string())
    }
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
    key: Option<&crate::crypto::AppKeys>,
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
fn decrypt_accounts(key: Option<&crate::crypto::AppKeys>, mut accounts: Vec<EmailAccountArgs>) -> Vec<EmailAccountArgs> {
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

fn session_key(db: &State<'_, Db>) -> Option<crate::crypto::AppKeys> {
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

// ---- 多账号聚合（B）----

/// 读取并解密所有已保存账号（供聚合命令用）。
fn read_accounts(db: &State<'_, Db>, app: &tauri::AppHandle) -> Result<Vec<EmailAccountArgs>, String> {
    let path = account_path(app)?;
    if !path.exists() { return Ok(Vec::new()); }
    let key = session_key(db);
    let list = load_accounts(&path)?;
    Ok(decrypt_accounts(key.as_ref(), list))
}

/// 把 Date 字符串解析成可排序的时间戳（毫秒）；失败返回 0。
fn date_ts(s: &str) -> i64 {
    parse_email_date(s).map(|d| d.timestamp_millis()).unwrap_or(0)
}

/// 从一条 FETCH 构造 EmailMeta（复用 email_fetch_inbox 的 build_meta 逻辑）。
fn meta_from_fetch(m: &async_imap::types::Fetch, folder: &str) -> Option<EmailMeta> {
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
            let mb = a.mailbox.as_ref().map(|x| String::from_utf8_lossy(x.as_ref()).to_string()).unwrap_or_default();
            let host = a.host.as_ref().map(|x| String::from_utf8_lossy(x.as_ref()).to_string()).unwrap_or_default();
            let addr = format!("{}@{}", mb, host);
            let name = a.name.as_ref().map(|n| decode_mime_words(&String::from_utf8_lossy(n.as_ref())).trim().to_string()).unwrap_or_default();
            if !name.is_empty() && !name.eq_ignore_ascii_case(&addr) { format!("{} <{}>", name, addr) } else { addr }
        })
        .unwrap_or_default();
    let date = env.date.as_ref().map(|d| String::from_utf8_lossy(d.as_ref()).to_string()).unwrap_or_default();
    let seen = m.flags().any(|f| f == async_imap::types::Flag::Seen);
    let flagged = m.flags().any(|f| f == async_imap::types::Flag::Flagged);
    // 同 `build_meta`：带 `\Deleted` 的不列出来（删除是"进回收站"，原件可能还挂着删除标记）。
    if m.flags().any(|f| f == async_imap::types::Flag::Deleted) {
        return None;
    }
    Some(EmailMeta {
        uid: m.uid.unwrap_or(0),
        subject,
        from,
        date,
        snippet: String::new(),
        seen,
        flagged,
        folder: folder.to_string(),
        account: String::new(),
    })
}

/// 一次 `FETCH <start>:*` 的结果。
struct FetchChunk {
    metas: Vec<EmailMeta>,
    /// 下一条要拉的序号；`None` = 这一箱已经拉完（没有解析错误）。
    resume_at: Option<u32>,
    /// 解析中断的说明（有它 ⇒ 这一条畸形邮件会被跳过，但**后面的会继续拉**）。
    note: Option<String>,
}

/// 从 `start` 起拉这一箱剩下的邮件头。
///
/// ★ 为什么要这么个函数（2026-09-20 用户报障的真根因）：`FETCH 1:*` 的响应是一条**流**，
/// 而 `while let Some(Ok(m)) = stream.next()` 一旦遇到 `Err` 就**静默结束** ——
/// 服务端已经把它后面的邮件都发过来了，应用却再也不读。实测：QQ 收件箱里有一封
/// 工信部的通知，它的 `Message-ID` 里**带一个没转义的 `"`**
/// （`<…JavaMail."zwfw-info@miit.gov.cn"@…>`），IMAP 语法里那个引号会提前结束字符串
/// ⇒ `async-imap` 解析到第 36 条就报错 ⇒ **第 36 条之后的全部邮件（含今天的新邮件）在应用里不存在**。
/// 用户看到的现象是"这个账号最新只到某一天"，而服务端一切正常。
///
/// 修法：把"流中途报错"当成**可恢复**的：记下断点、**重开会话**（那次响应剩下的字节还在 socket 里，
/// 直接再发命令会串味）、从断点下一条继续。代价是"一条畸形邮件只损失它自己"。
async fn fetch_chunk(account: &EmailAccountArgs, folder: &str, start: u32) -> Result<FetchChunk, String> {
    use futures_util::StreamExt;
    let mut session = open_session(account, folder).await?;
    let mut stream = session
        .fetch(format!("{start}:*"), "(ENVELOPE UID FLAGS)")
        .await
        .map_err(|e| format!("拉取 {} 失败: {}", folder, e))?;
    let mut metas = Vec::new();
    let mut next = start;
    let mut note = None;
    while let Some(item) = stream.next().await {
        match item {
            Ok(m) => {
                if let Some(meta) = meta_from_fetch(&m, folder) {
                    metas.push(meta);
                }
                next += 1;
            }
            Err(e) => {
                note = Some(format!("第 {next} 条解析失败（跳过这一条，后面的继续拉）：{e}"));
                break;
            }
        }
    }
    let finished = note.is_none();
    drop(stream);
    let _ = session.logout().await;
    Ok(FetchChunk { metas, resume_at: if finished { None } else { Some(next + 1) }, note })
}

/// 拉取一个账号（多文件夹）的邮件元信息 + 未读数。传 date_from/date_to 时按日期区间过滤。
async fn fetch_account_emails(
    account: &EmailAccountArgs,
    folders: &[String],
    date_from: Option<&str>,
    date_to: Option<&str>,
) -> Result<(Vec<EmailMeta>, u32), String> {
    use chrono::Datelike;
    let mut out = Vec::new();
    let mut unread = 0u32;
    for folder in folders {
        let mut start = 1u32;
        // 上限只是防"服务端每次都报错"时转不出来；正常一箱最多遇到几封畸形邮件。
        for _ in 0..500 {
            let chunk = fetch_chunk(account, folder, start).await?;
            for meta in chunk.metas {
                if let (Some(df), Some(dt)) = (date_from, date_to) {
                    // 按月/日期区间：部分 IMAP 服务端（如 QQ 邮箱）对 SINCE/BEFORE 返回空或挑剔日期格式，
                    // 故改为「拉全量 → 按邮件的年月（以其自身时区）过滤」，服务端无关、更稳。
                    let _ = dt; // (保留 date_to 以维持接口签名；按月直接只用 from 的年月)
                    let m = target_month(df);
                    let in_month = parse_email_date(&meta.date)
                        .map(|t| t.year() == m.0 && t.month() == m.1)
                        .unwrap_or(false);
                    if !in_month {
                        continue;
                    }
                }
                if !meta.seen {
                    unread += 1;
                }
                out.push(meta);
            }
            match (chunk.resume_at, chunk.note) {
                (Some(next), Some(msg)) => {
                    eprintln!("[email] {folder}: {msg}");
                    start = next;
                }
                _ => break,
            }
        }
    }
    Ok((out, unread))
}

#[derive(Deserialize)]
pub struct EmailFetchAllArgs {
    #[serde(default)]
    pub folders: Vec<String>,
    #[serde(default)]
    pub limit: u32,
    #[serde(default)]
    pub offset: u32,
    /// 可选日期区间（YYYY-MM-DD），按 IMAP SEARCH 过滤到某个月。
    #[serde(default)]
    pub date_from: Option<String>,
    #[serde(default)]
    pub date_to: Option<String>,
    /// 可选账号 key（host|username）过滤：空 = 全部账号；非空 = 仅聚合这些账号。
    #[serde(default)]
    pub accounts: Vec<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct EmailAccountError {
    /// 账号 key（`host|username`，与 `account_key` 同口径）。
    pub account: String,
    pub message: String,
}

#[derive(Serialize)]
pub struct EmailAggregate {
    pub emails: Vec<EmailMeta>,
    pub unread: u32,
    pub accounts: Vec<String>,
    /// 拉取失败的账号（**不许静默跳过**）。
    ///
    /// 为什么单列出来（2026-09-20 用户报障）：聚合是"多个账号并成一条时间线"，
    /// 某个账号拉取失败时，旧行为是 `Err(_) => {}` —— 它的邮件**整账号消失**，
    /// 而界面上既没有错误、也没有"少了一个账号"的任何提示 ⇒ 用户看到的是
    /// "这封信没来"（分不清"没收到"和"没拉到"）。现在把失败如实带回前端显示。
    pub errors: Vec<EmailAccountError>,
}

/// 把"每个账号一次拉取的结果"合并成聚合体：按时间降序、汇总未读、**失败如实带出来**。
///
/// 为什么抽成纯函数：`email_fetch_all` 要 `Db`/`AppHandle`，单测进不去；
/// 而"失败要不要吞掉"正是这条链上最容易悄悄回退的一步（旧的 `Err(_) => {}` 就是这么来的）。
fn aggregate_fetches(
    results: Vec<(String, Result<(Vec<EmailMeta>, u32), String>)>,
    limit: u32,
    offset: u32,
) -> EmailAggregate {
    let mut rows: Vec<(i64, EmailMeta)> = Vec::new();
    let mut unread_total = 0u32;
    let mut account_keys = Vec::new();
    let mut errors = Vec::new();
    for (key, res) in results {
        account_keys.push(key.clone());
        match res {
            Ok((metas, u)) => {
                unread_total += u;
                for mut m in metas {
                    let ts = date_ts(&m.date);
                    m.account = key.clone();
                    rows.push((ts, m));
                }
            }
            Err(message) => errors.push(EmailAccountError { account: key, message }),
        }
    }
    rows.sort_by(|a, b| b.0.cmp(&a.0));
    let mut emails: Vec<EmailMeta> = rows.into_iter().map(|(_, m)| m).collect();
    if limit > 0 {
        let start = (offset as usize).min(emails.len());
        let end = (start + limit as usize).min(emails.len());
        emails = emails[start..end].to_vec();
    }
    EmailAggregate { emails, unread: unread_total, accounts: account_keys, errors }
}

/// 聚合所有（或指定）账号的收件流（B）：合并账号、按时间降序、分页。
/// **单账号失败不再吞掉**：它进 `errors` 一并返回（见 `EmailAccountError` 的注释）。
/// 传 date_from/date_to 时，仅合并日期区间内的邮件（供「按月直达」用）。
/// 传 accounts 时仅聚合这些账号；空表示聚合全部已保存账号。
#[tauri::command]
pub async fn email_fetch_all(db: State<'_, Db>, app: tauri::AppHandle, args: EmailFetchAllArgs) -> Result<EmailAggregate, String> {
    let accounts = read_accounts(&db, &app)?;
    let folders = if args.folders.is_empty() { vec!["INBOX".to_string()] } else { args.folders.clone() };
    let mut results: Vec<(String, Result<(Vec<EmailMeta>, u32), String>)> = Vec::new();
    for acc in &accounts {
        let key = account_key(acc);
        if !args.accounts.is_empty() && !args.accounts.contains(&key) { continue; }
        results.push((key, fetch_account_emails(acc, &folders, args.date_from.as_deref(), args.date_to.as_deref()).await));
    }
    Ok(aggregate_fetches(results, args.limit, args.offset))
}

#[derive(Deserialize)]
pub struct EmailFetchAllMonthsArgs {
    #[serde(default)]
    pub folders: Vec<String>,
    /// 可选账号 key（host|username）过滤：空 = 全部账号。
    #[serde(default)]
    pub accounts: Vec<String>,
}

/// 聚合所有（或指定）账号的「含邮件月份」并集（供聚合视图月份选择器用）；单账号失败跳过。
#[tauri::command]
pub async fn email_fetch_all_months(db: State<'_, Db>, app: tauri::AppHandle, args: EmailFetchAllMonthsArgs) -> Result<Vec<String>, String> {
    let accounts = read_accounts(&db, &app)?;
    let folders = if args.folders.is_empty() { vec!["INBOX".to_string()] } else { args.folders };
    let mut months: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for acc in &accounts {
        let key = account_key(acc);
        if !args.accounts.is_empty() && !args.accounts.contains(&key) { continue; }
        match list_account_months(acc, &folders).await {
            Ok(ms) => months.extend(ms),
            Err(_) => { /* 单账号失败跳过，不影响其它账号 */ }
        }
    }
    Ok(months.into_iter().collect())
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
    fn parse_email_date_handles_qq_zone_comment_and_month() {
        // QQ 邮箱日期带末尾括号时区注释 + 可能写错的星期 + 单位数字天，都要能解析。
        assert_eq!(month_key_from_date("Mon, 7 Jul 2026 16:19:49 +0800 (CST)").as_deref(), Some("2026-6"));
        assert_eq!(month_key_from_date("7 Sep 2026 16:19:49 +0800 (CST)").as_deref(), Some("2026-8"));
        // 无括号的标准 RFC2822 也能解析
        assert_eq!(month_key_from_date("Mon, 31 Aug 2026 11:40:54 +0800").as_deref(), Some("2026-7"));
        // date_ts 不再因解析失败而恒为 0
        assert!(date_ts("Mon, 7 Jul 2026 16:19:49 +0800 (CST)") > 0);
    }

    #[test]
    fn decode_mime_words_decodes_rfc2047_base64() {
        // "你好" 的 utf-8 base64 编码词
        let encoded = "=?utf-8?B?5L2g5aW9?=";
        assert_eq!(decode_mime_words(encoded), "你好");
    }

    // ---- 聚合：单账号失败**不许吞掉**（2026-09-20 用户报障：某账号的邮件在聚合列表里"没来"，
    //      而界面既不报错也没有任何提示 —— 旧行为 `Err(_) => {}` 把整个账号静默丢了）----

    fn meta_for(date: &str, uid: u32) -> EmailMeta {
        EmailMeta {
            uid,
            subject: format!("s{uid}"),
            from: "a@x.com".to_string(),
            date: date.to_string(),
            snippet: String::new(),
            seen: false,
            flagged: false,
            folder: "INBOX".to_string(),
            account: String::new(),
        }
    }

    #[test]
    fn aggregate_fetches_reports_failed_account_instead_of_dropping_it() {
        let ok = vec![meta_for("Mon, 20 Sep 2026 18:17:08 +0800", 1)];
        let agg = aggregate_fetches(
            vec![
                ("imap.qq.com|zhaizy@qq.com".to_string(), Err("登录失败: 认证失败".to_string())),
                ("imap.qiye.aliyun.com|sales@shuyo.cn".to_string(), Ok((ok, 2))),
            ],
            0,
            0,
        );
        // ★ 失败的那个：账号 key 与错误原文**原样带出来**（界面要能说清"哪个账号、为什么"）
        assert_eq!(
            agg.errors,
            vec![EmailAccountError {
                account: "imap.qq.com|zhaizy@qq.com".to_string(),
                message: "登录失败: 认证失败".to_string(),
            }]
        );
        // 成功的那个不受影响：邮件还在、未读照加
        assert_eq!(agg.emails.len(), 1);
        assert_eq!(agg.emails[0].account, "imap.qiye.aliyun.com|sales@shuyo.cn");
        assert_eq!(agg.unread, 2);
        // 两个账号都在 `accounts` 里：界面要能分辨"它有账号、只是这一轮没拉到"
        assert_eq!(agg.accounts.len(), 2);
    }

    #[test]
    fn aggregate_fetches_all_ok_has_no_errors_and_sorts_newest_first() {
        let agg = aggregate_fetches(
            vec![
                ("a|1".to_string(), Ok((vec![meta_for("Mon, 7 Jul 2026 16:19:49 +0800", 7)], 0))),
                ("b|2".to_string(), Ok((vec![meta_for("Sun, 20 Sep 2026 20:42:43 +0800", 9)], 1))),
            ],
            0,
            0,
        );
        assert!(agg.errors.is_empty());
        assert_eq!(agg.emails.iter().map(|m| m.uid).collect::<Vec<_>>(), vec![9, 7]);
        assert_eq!(agg.unread, 1);
    }

    #[test]
    fn aggregate_fetches_pages_after_merging_not_per_account() {
        // 先合并再分页：否则"每账号各取 N 封"会把多账号合成的时间线切碎
        let metas = vec![
            meta_for("Sun, 20 Sep 2026 10:00:00 +0800", 3),
            meta_for("Sun, 20 Sep 2026 09:00:00 +0800", 2),
            meta_for("Sun, 20 Sep 2026 08:00:00 +0800", 1),
        ];
        let agg = aggregate_fetches(vec![("a|1".to_string(), Ok((metas, 0)))], 2, 1);
        assert_eq!(agg.emails.iter().map(|m| m.uid).collect::<Vec<_>>(), vec![2, 1]);
    }

    /// **手动探针 ②**（默认不跑）：直接看 `FETCH 1:*` 这条流**到底给了几条、在哪一条断的、报的什么错**。
    ///
    /// 为什么要有它：`fetch_account_emails` 里是 `while let Some(Ok(m)) = stream.next()` ——
    /// 流里出现一个 `Err` 就**静默结束**，剩下的信全部看不到（表现是"这个账号最新只到某一天"）。
    /// 这条探针把那个被吞掉的 `Err` 打出来。
    ///
    /// ```text
    /// $env:SHUYO_EMAIL_PROBE_ACCOUNT='zhaizy@qq.com'
    /// cargo test --lib -- --ignored --nocapture probe_fetch_stream_errors
    /// ```
    #[tokio::test]
    #[ignore = "手动探针：要真账号（SHUYO_EMAIL_PROBE_ACCOUNT=某个已配置的邮箱）"]
    async fn probe_fetch_stream_errors() {
        use futures_util::StreamExt;
        let want = std::env::var("SHUYO_EMAIL_PROBE_ACCOUNT").unwrap_or_default();
        if want.is_empty() {
            eprintln!("跳过：没设 SHUYO_EMAIL_PROBE_ACCOUNT");
            return;
        }
        let cfg = std::env::var("SHUYO_EMAIL_PROBE_CFG").unwrap_or_else(|_| {
            format!(
                "{}\\cn.shuyo.shuyonote\\email-account.json",
                std::env::var("APPDATA").unwrap_or_default()
            )
        });
        let all: Vec<EmailAccountArgs> =
            serde_json::from_str(&std::fs::read_to_string(&cfg).expect("读账号配置失败"))
                .expect("解析账号配置失败");
        let account = all.into_iter().find(|a| a.username == want).expect("配置里没有这个账号");
        let mut session = open_session(&account, "INBOX").await.expect("打开会话失败");
        let mut stream = session
            .fetch("1:*", "(ENVELOPE UID FLAGS)")
            .await
            .expect("FETCH 命令本身失败");
        let mut ok = 0usize;
        let mut last_uid = 0u32;
        let mut first_err: Option<String> = None;
        while let Some(item) = stream.next().await {
            match item {
                Ok(m) => {
                    ok += 1;
                    if let Some(u) = m.uid {
                        last_uid = u;
                    }
                }
                Err(e) => {
                    first_err = Some(format!("{e:?} / 显示: {e}"));
                    break;
                }
            }
        }
        eprintln!("FETCH 1:* 流：收到 Ok {ok} 条，最后一条 uid={last_uid}");
        match first_err {
            Some(e) => eprintln!("★ 第一个 Err（被 `while let Some(Ok(..))` 吞掉的就是它）：{e}"),
            None => eprintln!("没有 Err（流自然结束）"),
        }
        drop(stream);
        let _ = session.logout().await;
    }

    /// **源码哨兵**：拉取路径里不许再出现 `while let Some(Ok(`。
    ///
    /// 那个写法遇到流里的 `Err` 就**静默结束** —— 服务端其实已经把它后面的邮件都发过来了，
    /// 应用却再也不读。2026-09-20 用户报障的真根因就是这个：QQ 收件箱里一封工信部通知的
    /// `Message-ID` 带未转义的 `"`，`async-imap` 解析到第 36 条报错 ⇒ 第 36 条之后的
    /// **全部邮件（含今天的新邮件）在应用里不存在**，而服务端完全正常。
    #[test]
    fn fetch_path_never_stops_silently_on_a_stream_error() {
        let src = include_str!("email.rs");
        let start = src.find("async fn fetch_chunk").expect("fetch_chunk 不见了（改名了？这条哨兵要跟着搬）");
        let end = src[start..].find("async fn email_fetch_all").expect("找不到拉取段的结尾") + start;
        let body = &src[start..end];
        assert!(
            !body.contains("Some(Ok("),
            "拉取路径里又出现了 `while let Some(Ok(..))` —— 它会在流报错时静默丢掉后面的邮件：\n{body}"
        );
        assert!(body.contains("resume_at"), "断点续拉（resume_at）不见了");
    }

    /// **手动探针**（默认不跑）：拿本机 `email-account.json` 里的某个账号，跑一次**聚合那一半**的
    /// 拉取（`fetch_account_emails`），把"到底拉到几封、最新几封是谁/时间/`date_ts`、还是报错"打出来。
    ///
    /// 为什么需要它：聚合邮箱"某个账号的信没来"这类报障，光读代码分不清是
    /// ① 服务端没有 → ② 凭据不对 → ③ 拉取报错（会被 `email_fetch_all` 记进 `errors`）→
    /// ④ 拉到了但排序/分页把今天的信排到了第一页之外（`date_ts` 解析失败 ⇒ 0 ⇒ 沉底）。
    /// 这条探针把 ②③④ 一次读出来。**只读**：`FETCH 1:* (ENVELOPE UID FLAGS)`，不取正文、不改标记。
    ///
    /// ```text
    /// $env:SHUYO_EMAIL_PROBE_ACCOUNT='zhaizy@qq.com'
    /// cargo test --lib -- --ignored --nocapture probe_fetch_account_emails
    /// ```
    #[tokio::test]
    #[ignore = "手动探针：要真账号（SHUYO_EMAIL_PROBE_ACCOUNT=某个已配置的邮箱）"]
    async fn probe_fetch_account_emails() {
        let want = std::env::var("SHUYO_EMAIL_PROBE_ACCOUNT").unwrap_or_default();
        if want.is_empty() {
            eprintln!("跳过：没设 SHUYO_EMAIL_PROBE_ACCOUNT");
            return;
        }
        let cfg = std::env::var("SHUYO_EMAIL_PROBE_CFG").unwrap_or_else(|_| {
            format!(
                "{}\\cn.shuyo.shuyonote\\email-account.json",
                std::env::var("APPDATA").unwrap_or_default()
            )
        });
        let all: Vec<EmailAccountArgs> =
            serde_json::from_str(&std::fs::read_to_string(&cfg).expect("读账号配置失败"))
                .expect("解析账号配置失败");
        let account = all.into_iter().find(|a| a.username == want).expect("配置里没有这个账号");
        eprintln!("探针账号：{} @ {}:{}（auto_fetch={}）", account.username, account.host, account.port, account.auto_fetch);
        match fetch_account_emails(&account, &["INBOX".to_string()], None, None).await {
            Ok((metas, unread)) => {
                let mut v: Vec<EmailMeta> = metas.clone();
                v.sort_by(|a, b| date_ts(&b.date).cmp(&date_ts(&a.date)));
                eprintln!("OK：拉到 {} 封（未读 {}）", metas.len(), unread);
                eprintln!("  最新 5 封（按 date_ts 降序；date_ts=0 表示**日期解析失败**，在多账号聚合里会沉底）：");
                for m in v.iter().take(5) {
                    let subject: String = m.subject.chars().take(46).collect();
                    eprintln!("   uid={:<6} ts={:<14} {} | {} | {}", m.uid, date_ts(&m.date), m.date, m.from, subject);
                }
                // 今天/昨天的信在不在（按本地日历日粗判）
                let today = chrono::Local::now().format("%d %b %Y").to_string();
                let hit = v.iter().filter(|m| m.date.contains(&today)).count();
                eprintln!("  日期里含今天（{today}）的：{hit} 封");
            }
            Err(e) => eprintln!("ERR：{e}"),
        }
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

    /// IMAP mailbox 名的 modified UTF-7 编码。期望值**不是**我推出来的，是阿里云企业邮
    /// `LIST "" "*"` 真回给我们的协议名（2026-09-20 现场抓的）。
    #[test]
    fn imap_utf7_encode_matches_what_the_real_server_sent_us() {
        assert_eq!(imap_utf7_encode("已删除邮件"), "&XfJSIJZkkK5O9g-");
        assert_eq!(imap_utf7_encode("垃圾邮件"), "&V4NXPpCuTvY-");
        assert_eq!(imap_utf7_encode("已发送"), "&XfJT0ZAB-");
        assert_eq!(imap_utf7_encode("草稿"), "&g0l6Pw-");
        // 纯 ASCII 原样；`&` 自身按 RFC 3501 写成 `&-`
        assert_eq!(imap_utf7_encode("INBOX"), "INBOX");
        assert_eq!(imap_utf7_encode("a&b"), "a&-b");
    }

    /// **这条判据就是那次事故的哨兵**：发到线上的 mailbox 名一个字都不许是非 ASCII。
    /// 旧代码把 `垃圾箱` / `已删除` 原文发出去，阿里云企业邮不认、当场废掉那条连接，
    /// 于是整批删除静默失败 —— 用户看到的就是「删了、重新拉取又出现」。
    #[test]
    fn mailbox_names_on_the_wire_are_ascii_only() {
        for name in [
            "垃圾箱",
            "已删除",
            "已删除邮件",
            "垃圾邮件",
            "已发送",
            "Trash",
            "Deleted Messages",
        ] {
            let wire = imap_utf7_encode(name);
            assert!(
                wire.is_ascii(),
                "发到线上的 mailbox 名必须全是 ASCII，收到的是 {:?}",
                wire
            );
        }
    }

    #[test]
    fn pick_trash_prefers_the_server_flag_then_common_names() {
        // ① 服务器自己标了 \Trash ⇒ 认标记，不看名字（阿里云企业邮就标了，尽管它不广告 SPECIAL-USE）
        let names = vec![
            ("INBOX".to_string(), false),
            ("&XfJSIJZkkK5O9g-".to_string(), true),
            ("Trash".to_string(), false),
        ];
        assert_eq!(pick_trash(&names).as_deref(), Some("&XfJSIJZkkK5O9g-"));

        // ② 没有标记时按常见叫法，英文不区分大小写
        let names = vec![
            ("INBOX".to_string(), false),
            ("deleted messages".to_string(), false),
        ];
        assert_eq!(pick_trash(&names).as_deref(), Some("deleted messages"));

        // ③ 中文名在协议层是 UTF-7，按**编码后**比（中文邮箱：QQ/163/企业邮）
        let names = vec![
            ("INBOX".to_string(), false),
            ("&XfJSIJZkkK5O9g-".to_string(), false),
        ];
        assert_eq!(pick_trash(&names).as_deref(), Some("&XfJSIJZkkK5O9g-"));

        // ③′ 层级名看**末段**：Gmail 的 `[Gmail]/Trash`、Dovecot 的 `INBOX.Trash`
        //     （整名跟 `trash` 比永远不相等 —— 旧代码就是这么漏的）
        let names = vec![
            ("INBOX".to_string(), false),
            ("[Gmail]/Trash".to_string(), false),
        ];
        assert_eq!(pick_trash(&names).as_deref(), Some("[Gmail]/Trash"));
        let names = vec![
            ("INBOX".to_string(), false),
            ("INBOX.Deleted Items".to_string(), false),
        ];
        assert_eq!(pick_trash(&names).as_deref(), Some("INBOX.Deleted Items"));

        // ④ 一个都不像 ⇒ None：那时**拒绝删除**（`delete_one` 直接报错），不乱猜名字、
        //    也不做任何"永久删"——收不回来的事，宁可没做
        let names = vec![
            ("INBOX".to_string(), false),
            ("&g0l6Pw-".to_string(), false),
        ];
        assert_eq!(pick_trash(&names), None);
    }

    /// **删信路径里不许再出现"整箱 `EXPUNGE`"**（2026-09-20 用户实测：客户端删了上百封，
    /// QQ 的「已删除」却是空的 —— 那条 `session.expunge()` 把本文件夹里**所有**带 `\Deleted` 的信
    /// 一起永久清了，而且完全绕过回收站，IMAP 层面无法恢复）。
    ///
    /// 这是**源码哨兵**：这种"服务器配合着把信弄没"的行为本地 mock 复现不了（与上面那条
    /// "mailbox 名必须全是 ASCII" 同一个思路）—— 谁把这条回退加回来，判据就要当场变红。
    #[test]
    fn delete_path_never_does_a_mailbox_wide_expunge() {
        let src = include_str!("email.rs");
        let start = src
            .find("async fn delete_one")
            .expect("delete_one 不见了（改名了？这条哨兵要跟着搬）");
        let body = &src[start..];
        let end = body
            .find("\n#[tauri::command]")
            .expect("找不到 delete_one 的结尾");
        let body = &body[..end];
        assert!(
            !body.contains(".expunge()"),
            "delete_one 里出现了整箱 EXPUNGE —— 它会清掉本文件夹里所有带 \\Deleted 的信、且绕过回收站：\n{body}"
        );
        assert!(
            body.contains("uid_copy"),
            "delete_one 必须先把邮件 COPY 进回收站（服务器不支持 MOVE 时，这一步才是\"进回收站\"的保证）：\n{body}"
        );
    }

    /// 拉 `folder` 的**最后 `tail` 封**（按序号取尾段，不拉整箱），按主题前缀认领，返回命中的 UID。
    ///
    /// 为什么不用 `UID SEARCH`：**QQ 的 SEARCH 索引看不见 APPEND 进去的信**（2026-09-20 实测：
    /// APPEND 回了 `[APPENDUID … 9769]`、`UID FETCH 9769` 立刻拿得到，而
    /// `UID SEARCH SUBJECT "shuyo-probe-"` 过 60 秒仍然是空）。序号尾段 FETCH 既便宜又不依赖索引。
    ///
    /// 复用点：探针用它 ①认回刚 APPEND 的信、②清理以前跑挂留下的垃圾、③到回收站里找那封信。
    async fn tail_uids(session: &mut ImapSession, folder: &str, tail: u32, prefix: &str) -> Vec<u32> {
        use futures_util::StreamExt;
        // `UID SEARCH ALL` 只用来估"有多少封"：它对**已存在**的信是准的；对刚 APPEND 的（QQ 上）
        // 会少算一封 —— 但 `<n>:*` 里的 `*` 仍然覆盖真正的末尾，所以照样能拿到。
        let n = session
            .uid_search("ALL")
            .await
            .map(|s| s.len() as u32)
            .unwrap_or(0);
        let start = n.saturating_sub(tail).max(1);
        let mut out = Vec::new();
        if let Ok(mut stream) = session.fetch(format!("{start}:*"), "(UID ENVELOPE)").await {
            while let Some(Ok(m)) = stream.next().await {
                if let Some(meta) = meta_from_fetch(&m, folder) {
                    if meta.subject.starts_with(prefix) {
                        out.push(meta.uid);
                    }
                }
            }
        }
        out
    }

    /// **手动探针**（默认不跑，`#[ignore]`）：拿真账号把「批量删除 → 重新拉取」走一遍。
    ///
    /// 为什么非要真服务器：那次失败的方式是"服务器把连接废掉"，本地怎么 mock 都复现不了。
    /// 2026-09-20 的 bug 就是靠它钉住的 —— 修前 `moved=0` 且邮件仍在 INBOX，修后 `moved=1` 且消失。
    ///
    /// 用法（凭据只从**本机已有的**账号配置读，不进仓库、不打印）：
    /// ```text
    /// cargo test --lib -- --ignored --nocapture probe_batch_delete
    /// ```
    /// 它只对自己 APPEND 进去的那封探针信下手（主题 `shuyo-probe-<时间戳>`），跑完 expunge 掉。
    #[tokio::test]
    #[ignore = "手动探针：要真账号（SHUYO_EMAIL_PROBE_ACCOUNT=某个已配置的邮箱）"]
    async fn probe_batch_delete_round_trip_on_a_real_account() {
        use futures_util::StreamExt;

        let Some(want) = std::env::var("SHUYO_EMAIL_PROBE_ACCOUNT").ok() else {
            eprintln!("跳过：没设 SHUYO_EMAIL_PROBE_ACCOUNT");
            return;
        };
        let cfg = std::env::var("SHUYO_EMAIL_PROBE_CFG").unwrap_or_else(|_| {
            format!(
                "{}\\cn.shuyo.shuyonote\\email-account.json",
                std::env::var("APPDATA").unwrap_or_default()
            )
        });
        let all: Vec<EmailAccountArgs> =
            serde_json::from_str(&std::fs::read_to_string(&cfg).expect("读账号配置失败"))
                .expect("解析账号配置失败");
        let account = all
            .into_iter()
            .find(|a| a.username == want)
            .expect("账号配置里没有这个邮箱");

        let subject = format!("shuyo-probe-{}", chrono::Utc::now().timestamp_millis());
        let raw = format!(
            "From: {u}\r\nTo: {u}\r\nSubject: {s}\r\nDate: {d}\r\nMessage-ID: <{s}@shuyo.cn>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nprobe\r\n",
            u = account.username,
            s = subject,
            d = chrono::Utc::now().to_rfc2822()
        );

        // ⓪ 先把**以前失败留下的探针信**清掉：上一次 APPEND 成功、后面 panic 了，就会留一封在收件箱里。
        //    （2026-09-20 在 QQ 上第一次跑就留了几封 —— 探针自己收拾自己的垃圾，别让人手动去删。
        //      注意这里也**不能靠 SEARCH**：QQ 看不见 APPEND 进去的信，得按尾段 FETCH 找。）
        if let Ok(mut s) = open_session(&account, "INBOX").await {
            for u in tail_uids(&mut s, "INBOX", 80, "shuyo-probe-").await {
                if let Ok(store) = s
                    .uid_store(u.to_string(), "+FLAGS.SILENT (\\Deleted)")
                    .await
                {
                    futures_util::pin_mut!(store);
                    while store.next().await.is_some() {}
                }
                if let Ok(ex) = s.uid_expunge(u.to_string()).await {
                    futures_util::pin_mut!(ex);
                    while ex.next().await.is_some() {}
                }
                println!("PROBE 清掉一封遗留探针信 uid={u}");
            }
            let _ = s.logout().await;
        }

        // ① 往 INBOX APPEND 一封探针信，再把它的 UID 认回来。
        //
        // ⚠️ 两条弯路都在 QQ 上实测踩过（`zhaizy@qq.com`，收件箱 7000+ / 现存 130 封）：
        //   · **`FETCH 1:*`**：拉全量 ENVELOPE，又慢又容易中途出错，而 `while let Some(Ok(m))`
        //     一遇 `Err` 就静默收尾 ⇒ "APPEND 之后没找到那封探针信"；
        //   · **`UID SEARCH HEADER Subject "…"`**：APPEND 完立刻搜、过 60 秒再搜，**都是空**
        //     ——QQ 的 SEARCH 索引看不见 APPEND 进去的信（`UID FETCH <uid>` 却立刻拿得到）。
        // 所以用**序号尾段 FETCH** 认领（见 `tail_uids`），给两轮重试。
        let uid = {
            let mut session = open_session(&account, "INBOX")
                .await
                .expect("连接 INBOX 失败");
            session
                .append("INBOX", Some("(\\Seen)"), None, raw.as_bytes())
                .await
                .expect("APPEND 探针信失败");

            let mut found: Option<u32> = None;
            for attempt in 0..3 {
                if attempt > 0 {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                }
                if let Some(u) = tail_uids(&mut session, "INBOX", 20, &subject)
                    .await
                    .into_iter()
                    .max()
                {
                    found = Some(u);
                    break;
                }
            }
            let _ = session.logout().await;
            found.unwrap_or_else(|| {
                panic!(
                    "APPEND 之后认不回那封探针信（主题 {subject}）—— 连 APPEND 都回不来，\
                     后面的删除探针就没法跑了"
                )
            })
        };

        // ② 调**真**函数（就是界面点「删除所选」时走的那条路）
        let moved = email_move_many_to_trash(EmailBatchOpArgs {
            account: account.clone(),
            uids: vec![uid],
            folder: "INBOX".to_string(),
        })
        .await;

        // ③ 它还在不在收件箱里 —— **按 UID 直接问**，不做整箱 FETCH。
        //
        // 为什么不用 `email_fetch_inbox`（原探针是那么写的）：真邮箱 7000+ 封时，那条路会**在中途
        // 静默截断**（`while let Some(Ok(m))` 一遇 `Err` 就收尾，`Err(_) => {}` 又把整个账号的失败
        // 吞掉），于是"重新拉取"看到的可能只是前一半 —— 拿它判断"这封还在不在"会**假通过**。
        // 这里区分两件事：**物理上还在不在** vs **列表里还看不看得见**（带 `\Deleted` 标记的，
        // 列表那侧已经不显示了）。
        let (present, deleted_flag) = match open_session(&account, "INBOX").await {
            Ok(mut s) => {
                let mut present = false;
                let mut del = false;
                if let Ok(mut st) = s.uid_fetch(uid.to_string(), "(UID FLAGS)").await {
                    while let Some(Ok(m)) = st.next().await {
                        present = true;
                        del = m.flags().any(|f| f == async_imap::types::Flag::Deleted);
                    }
                }
                let _ = s.logout().await;
                (present, del)
            }
            Err(_) => (false, false),
        };
        let still = present && !deleted_flag;
        println!(
            "PROBE account={} uid={} moved={:?} in_inbox={} deleted_flag={} visible_in_list={}",
            account.username, uid, moved, present, deleted_flag, still
        );

        // ③′ **它得在回收站里**（2026-09-20 用户：「改为进回收站」）。
        //     判据不能只看"从收件箱消失了"——旧代码的整箱 EXPUNGE 也能让它消失，代价是永久删掉。
        //     所以这里先问服务器回收站叫什么（`resolve_trash`），再进那个文件夹按主题找回它，
        //     找完**顺手把它从回收站也清掉**（只清这一封），别在用户邮箱里留垃圾。
        let (trash_name, in_trash) = match open_session(&account, "INBOX").await {
            Ok(mut s) => {
                let t = resolve_trash(&mut s).await;
                let _ = s.logout().await;
                match t {
                    Some(folder) => match open_session(&account, &folder).await {
                        Ok(mut tr) => {
                            // 同样按尾段 FETCH 认领（回收站也可能几千封，且 SEARCH 在 QQ 上靠不住）
                            let probe_uid: Option<u32> = tail_uids(&mut tr, &folder, 20, &subject)
                                .await
                                .into_iter()
                                .max();
                            if let Some(u) = probe_uid {
                                if let Ok(store) = tr
                                    .uid_store(u.to_string(), "+FLAGS.SILENT (\\Deleted)")
                                    .await
                                {
                                    futures_util::pin_mut!(store);
                                    while store.next().await.is_some() {}
                                }
                                if let Ok(ex) = tr.uid_expunge(u.to_string()).await {
                                    futures_util::pin_mut!(ex);
                                    while ex.next().await.is_some() {}
                                }
                            }
                            let _ = tr.logout().await;
                            (Some(folder), probe_uid.is_some())
                        }
                        Err(_) => (Some(folder), false),
                    },
                    None => (None, false),
                }
            }
            Err(_) => (None, false),
        };
        println!("PROBE trash={:?} in_trash={}", trash_name, in_trash);

        // ④ 收尾：万一没删掉，也要把这封探针信清掉（读响应 + UID EXPUNGE），别在用户邮箱里留垃圾
        if still {
            if let Ok(mut s) = open_session(&account, "INBOX").await {
                if let Ok(store) = s
                    .uid_store(uid.to_string(), "+FLAGS.SILENT (\\Deleted)")
                    .await
                {
                    futures_util::pin_mut!(store);
                    while store.next().await.is_some() {}
                }
                if let Ok(ex) = s.uid_expunge(uid.to_string()).await {
                    futures_util::pin_mut!(ex);
                    while ex.next().await.is_some() {}
                }
                let _ = s.logout().await;
            }
        }

        assert_eq!(
            moved.as_ref().ok().copied(),
            Some(1),
            "真删掉的封数必须是 1（旧代码这里恒为 Ok(0)：命令写进了 socket 就当成功）"
        );
        assert!(
            !still,
            "批量删除后重新拉取又出现了（uid={uid}）—— 这正是用户 2026-09-20 报的那个 bug"
        );
        assert!(
            in_trash,
            "删掉之后必须能在回收站里找到它（用户 2026-09-20：「改为进回收站」）—— 回收站={trash_name:?}。\
             只「从收件箱消失」不算数：旧代码那条整箱 EXPUNGE 也能让它消失，代价是永久删掉、回收站里什么都没有"
        );
    }
}
