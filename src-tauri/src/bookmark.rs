use crate::db::{now_ms, Db};
use rusqlite::params;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{Manager, State};

#[derive(Serialize)]
pub struct BookmarkMeta {
    pub url: String,
    pub title: String,
    pub description: String,
    pub site_name: String,
    pub image_hash: String,
    pub image_mime: String,
}

// Lowercase-hex a byte slice (custom, since sha2 0.11's Output lost LowerHex).
fn hex_of(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

// Decode a handful of common HTML entities (enough for meta text).
fn unescape(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
}

// Extract the value of a meta `property`/`name`/`itemprop` attribute from raw HTML.
fn meta_value(html: &str, key: &str) -> Option<String> {
    // Grab content of any meta tag whose property|name|itemprop == key.
    let pattern = format!(
        r#"(?is)<meta\b[^>]*?(?:property|name|itemprop)\s*=\s*["']{}["'][^>]*?>"#,
        regex_escape(key)
    );
    let re = regex::Regex::new(&pattern).ok()?;
    let m = re.find(html)?;
    let tag = m.as_str();
    // content="..."
    let content_re =
        regex::Regex::new(r#"(?is)content\s*=\s*["']([^"']*)["']"#).ok()?;
    if let Some(c) = content_re.captures(tag) {
        let v = c.get(1)?.as_str().trim().to_string();
        if !v.is_empty() {
            return Some(v);
        }
    }
    None
}

fn regex_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '.' | '+' | '*' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '^' | '$' | '|' | '\\' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out
}

fn title_from_html(html: &str) -> String {
    // <title>...</title>
    let re = regex::Regex::new(r"(?is)<title[^>]*>(.*?)</title>").ok();
    if let Some(re) = re {
        if let Some(c) = re.captures(html) {
            if let Some(t) = c.get(1) {
                let v = unescape(t.as_str().trim());
                if !v.is_empty() {
                    return v;
                }
            }
        }
    }
    String::new()
}

fn mime_ext(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        _ => "bin",
    }
}

/// Fetch a URL's Open Graph / title metadata and persist the preview image
/// (content-addressed) into the global attachments store. Never blocks the UI
/// thread; degrades gracefully when the page can't be fetched or has no metadata.
#[tauri::command]
pub async fn fetch_bookmark_metadata(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    url: String,
) -> Result<BookmarkMeta, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("网址为空".to_string());
    }
    // Normalize: prefix a bare host with https://.
    let normalized = if !url.contains("://") {
        format!("https://{url}")
    } else {
        url.clone()
    };

    // Fetch + parse (async, non-blocking).
    let meta = fetch_and_parse(&normalized).await?;

    // Persist the preview image (if any) into the global attachments store.
    let meta = if let Some((bytes, mime)) = meta.image_bytes {
        let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let attachments_dir = app_data_dir.join("attachments");
        std::fs::create_dir_all(&attachments_dir).map_err(|e| e.to_string())?;
        let hash = hex_of(&Sha256::digest(&bytes));
        let ext = mime_ext(&mime);
        let path = attachments_dir.join(format!("{hash}.{ext}"));
        if !path.exists() {
            std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
        }
        // Record the attachment row (dedup by hash) so it syncs/shares like any other.
        {
            let c = db.0.lock().expect("db mutex poisoned");
            let size = bytes.len() as i64;
            let name = format!("bookmark-{hash}.{ext}");
            c.execute(
                "INSERT OR IGNORE INTO attachments (id, page_id, name, hash, mime, size, created_at)
                 VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6)",
                params![uuid::Uuid::new_v4().to_string(), name, hash, mime, size, now_ms()],
            )
            .map_err(|e| e.to_string())?;
        }
        BookmarkMeta {
            url: meta.url,
            title: meta.title,
            description: meta.description,
            site_name: meta.site_name,
            image_hash: hash,
            image_mime: mime,
        }
    } else {
        BookmarkMeta {
            url: meta.url,
            title: meta.title,
            description: meta.description,
            site_name: meta.site_name,
            image_hash: String::new(),
            image_mime: String::new(),
        }
    };

    Ok(meta)
}

struct Parsed {
    url: String,
    title: String,
    description: String,
    site_name: String,
    image_bytes: Option<(Vec<u8>, String)>,
}

/// 把错误的**根因一起**描述出来：`reqwest::Error` 的 `Display` 只有
/// `error sending request for url (…)` 这一句，真正的原因（TLS 校验失败 / DNS / 超时）
/// 在 `source()` 链里。
///
/// 为什么非要这个（2026-09-13 真机实测的教训）：Android 上排查 Rust 侧 HTTPS 时，
/// 我们**只打了一层**，于是日志里看到的永远是同一句"发送请求失败"，
/// 完全分不清是"证书校验器没接上"还是"网不通"——而这两件事的修法毫无共同点。
/// 见 `docs/MOBILE.md` §2.4。
fn describe_err(e: &dyn std::error::Error) -> String {
    let mut out = e.to_string();
    let mut cur = e.source();
    while let Some(s) = cur {
        out.push_str(" ← ");
        out.push_str(&s.to_string());
        cur = s.source();
    }
    out
}

async fn fetch_and_parse(url: &str) -> Result<Parsed, String> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (compatible; ShuyoNote/1.0)")
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| {
            let msg = describe_err(&e);
            // 也写一行 logcat：Android 上 toast 是**单行截断**的，而这条错误的根因往往在末尾
            // （`adb logcat -s RustStdoutStderr` 才能看全）。见 docs/MOBILE.md §2.4。
            eprintln!("[http] 取网页失败 {url}：{msg}");
            format!("无法获取网页: {msg}")
        })?;
    if !resp.status().is_success() {
        let host = resp.url().host_str().unwrap_or(url).to_string();
        return Ok(Parsed {
            url: url.to_string(),
            title: host,
            description: String::new(),
            site_name: String::new(),
            image_bytes: None,
        });
    }
    let final_url = resp.url().to_string();
    let html = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {}", describe_err(&e)))?;

    let title = meta_value(&html, "og:title")
        .unwrap_or_else(|| title_from_html(&html))
        .pipe_trim();
    let description = meta_value(&html, "og:description")
        .or_else(|| meta_value(&html, "description"))
        .unwrap_or_default()
        .pipe_trim();
    let site_name = meta_value(&html, "og:site_name").unwrap_or_default();

    // Download the og:image (best-effort; ignore failures).
    let image_bytes = get_image(&client, &final_url, &html).await;

    Ok(Parsed {
        url: final_url,
        title,
        description,
        site_name,
        image_bytes,
    })
}

fn resolve_image_url(page_url: &str, img: &str) -> Option<String> {
    let img = if img.starts_with("//") {
        format!("https:{img}")
    } else if img.starts_with('/') {
        let u = reqwest::Url::parse(page_url).ok()?;
        let base = format!("{}://{}{}", u.scheme(), u.host()?, "/");
        format!("{base}{}", img.trim_start_matches('/'))
    } else {
        img.to_string()
    };
    Some(img)
}

async fn get_image(client: &reqwest::Client, page_url: &str, html: &str) -> Option<(Vec<u8>, String)> {
    let img = meta_value(html, "og:image")
        .or_else(|| meta_value(html, "twitter:image"))?;
    let resolved = resolve_image_url(page_url, &img)?;
    let r = client.get(resolved).send().await.ok()?;
    if !r.status().is_success() {
        return None;
    }
    let mime = r
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.split(';').next().unwrap_or(s).trim().to_string())
        .unwrap_or_else(|| "image/png".to_string());
    let bytes = r.bytes().await.ok()?;
    if bytes.len() > 10 * 1024 * 1024 {
        return None;
    }
    Some((bytes.to_vec(), mime))
}

trait PipeTrim {
    fn pipe_trim(self) -> Self;
}
impl PipeTrim for String {
    fn pipe_trim(self) -> Self {
        self.trim().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `describe_err` 必须**把 source 链串起来**。
    ///
    /// 这条测试的由来：Android 上排查 Rust 侧 HTTPS 失败时，日志里只有 reqwest 的
    /// `error sending request for url (…)`，看不出根因是 TLS 还是网络——
    /// 而这两者的修法毫无共同点。所以"根因必须出现在错误串里"是**要求**，不是装饰。
    #[test]
    fn describe_err_walks_the_source_chain() {
        #[derive(Debug)]
        struct Leaf;
        impl std::fmt::Display for Leaf {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "invalid peer certificate: UnknownIssuer")
            }
        }
        impl std::error::Error for Leaf {}

        #[derive(Debug)]
        struct Mid(Leaf);
        impl std::fmt::Display for Mid {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "tls handshake failed")
            }
        }
        impl std::error::Error for Mid {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                Some(&self.0)
            }
        }

        let s = describe_err(&Mid(Leaf));
        assert!(s.contains("tls handshake failed"), "{s}");
        assert!(s.contains("UnknownIssuer"), "根因没被串进来：{s}");
        // 单层错误也不能炸、也不能多出一个空箭头
        assert_eq!(describe_err(&Leaf), "invalid peer certificate: UnknownIssuer");
    }

    #[test]
    fn extracts_og_meta_and_title() {
        let html = r#"
        <html><head>
          <title>示例新闻 - 某某站</title>
          <meta property="og:title" content="时政微观察 | 想人民之所想" />
          <meta property="og:description" content="这是一段摘要。" />
          <meta property="og:site_name" content="新浪新闻" />
          <meta property="og:image" content="https://img.example.com/pic.jpg" />
        </head><body></body></html>
        "#;
        assert_eq!(meta_value(html, "og:title").unwrap(), "时政微观察 | 想人民之所想");
        assert_eq!(meta_value(html, "og:description").unwrap(), "这是一段摘要。");
        assert_eq!(meta_value(html, "og:site_name").unwrap(), "新浪新闻");
        assert_eq!(meta_value(html, "og:image").unwrap(), "https://img.example.com/pic.jpg");
        assert_eq!(title_from_html(html), "示例新闻 - 某某站");
        // A meta tag with name= instead of property= still matches.
        assert_eq!(meta_value(html, "description"), None);
    }

    #[test]
    fn og_title_wins_over_title() {
        let html = r#"<html><head><title>Fallback</title><meta property="og:title" content="OG Title"/></head></html>"#;
        let title = meta_value(html, "og:title").unwrap_or_else(|| title_from_html(html)).pipe_trim();
        assert_eq!(title, "OG Title");
    }

    #[test]
    fn escapes_entities() {
        assert_eq!(unescape("a &amp; b &lt;c&gt;"), "a & b <c>");
    }

    #[test]
    fn hex_of_works() {
        assert_eq!(hex_of(&[0xab, 0x01, 0xff]), "ab01ff");
    }

    #[test]
    fn resolve_image_url_variants() {
        assert_eq!(resolve_image_url("https://a.com/p/", "//cdn.a.com/i.png").unwrap(), "https://cdn.a.com/i.png");
        assert_eq!(resolve_image_url("https://a.com/p/x", "/img.png").unwrap(), "https://a.com/img.png");
        assert_eq!(resolve_image_url("https://a.com/p/", "https://b.com/i.png").unwrap(), "https://b.com/i.png");
    }
}
