//! 聚合邮箱（邮件即笔记）— P0 spike。
//!
//! 最小验证链路：**邮件(RFC822) → 解析 → ShuyoNote 页面**。
//! - `email_save_as_note`：用 `mailparse` 解析一条原始邮件，生成页面（复用 `commands::create_node`，
//!   建页 + 内容 + FTS + blocks/backlinks + 同步 change 一条龙）。
//! - `email_fetch_inbox`：IMAP 拉取收件箱头部（Envelope）。当前镜像源缺 `imap` 3.x，
//!   暂为占位（返回明确错误），待接入真实账号 + 依赖后启用。
//!
//! 备注：spike 阶段走阻塞式 IMAP（后续可挪 `spawn_blocking`）；OAuth 见私有仓库
//! `docs/email-aggregate-monetization.md`。

use serde::{Deserialize, Serialize};
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
/// `email_fetch_inbox` 为占位（镜像缺 imap 3.x），字段暂未读取。
#[allow(dead_code)]
#[derive(Deserialize)]
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
    let parsed = mailparse::parse_mail(args.raw.as_bytes()).map_err(|e| format!("邮件解析失败: {}", e))?;
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

/// 拉取收件箱头部（spike：占位）。
/// 依赖 `imap` 3.x，但当前 USTC 镜像索引缺该版本；待依赖可解析 + 真实账号后填充。
#[tauri::command]
pub fn email_fetch_inbox(_db: State<Db>, _args: EmailAccountArgs) -> Result<Vec<EmailMeta>, String> {
    Err("IMAP 拉取待接入：当前镜像源缺 imap 3.x 依赖，需真实邮箱账号 + 依赖可解析后启用".to_string())
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
