// 社区帖子抓取（原生侧）。
//
// 为什么要有这一份，而不是继续用前端的 `fetch`——**这是实测出来的**：
// 桌面端的 WebView 是 `http://tauri.localhost`，而社区站点只面向同源（CSP `connect-src 'self'`），
// `/api/posts/{id}.json` 不带任何 `Access-Control-Allow-Origin`。于是浏览器**拦下响应**，
// `fetch` 只能抛 `TypeError: Failed to fetch` —— 我们那条写得很好的
// `取不到这篇帖子：HTTP ${status}` **永远执行不到**，用户看到的是"网络错误"，
// 而真实原因可能是 401/404（Windows 侧实测：任何 id 都回 401）。
//
// 仓库里已经有一条**证明可行**的原生路径：插件索引走的就是 Rust `reqwest`（`fetch_plugin_index`），
// CORS 根本不存在于那条路上。所以社区抓取也走这里：
//   · 同一套加固（30 秒超时、≤5 次重定向、**读字节时也守上限**、落地地址复查）；
//   · 同一个安全策略（仅 https、仅白名单主机、拒带凭据的 URL、拒非默认端口）；
//   · 状态码如实上报（401/404 不会再被压成一句 Failed to fetch）。
//
// 前端那条实现仍然保留：**Web 版**必须走浏览器 `fetch`（那里没有 Rust），
// 所以社区侧仍需给 `Access-Control-Allow-Origin`（这条是社区侧的事，已在信中说明）。

use serde::{Deserialize, Serialize};

/// 允许作为帖子来源的主机（**逐个列，不用通配**）。
pub const COMMUNITY_HOSTS: &[&str] = &["community.shuyo.cn"];

/// 帖子 JSON 的体积上限（读字节时就守着）。
pub const MAX_POST_JSON_BYTES: u64 = 256 * 1024;

/// 请求超时：比插件索引的 30 秒短——这是"用户点了一下等结果"的交互。
const TIMEOUT_SECS: u64 = 15;

/// 抓回来的帖子（字段名给前端用 camelCase）。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommunityPost {
    pub id: String,
    pub title: String,
    pub body_markdown: String,
    pub author: String,
    pub created_at: String,
    pub updated_at: String,
    pub tags: Vec<String>,
    pub url: String,
}

/// 地址策略：与前端 `deepLink.checkCommunityUrl` **同一条规则的独立实现**。
///
/// 为什么两边各写一份：前端那份是为了"尽早、当着用户的面说清为什么不行"，
/// 这份是为了"后端不信前端"。安全判定在两侧都必须成立，重复是刻意的。
pub fn check_post_url(raw: &str, hosts: &[&str]) -> Result<String, String> {
    let url = raw.trim();
    if url.is_empty() {
        return Err("地址不能为空".to_string());
    }
    if url.len() > 4096 {
        return Err(format!("地址过长（{} 字符，上限 4096）", url.len()));
    }
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("地址里不能有空白或控制字符".to_string());
    }
    let lower = url.to_ascii_lowercase();
    if !lower.starts_with("https://") {
        // 与深链那条一致：**不接受明文 http，也不接受回环**。
        // 回环在这里比在插件索引那边更危险——链接是**网页发出的**，
        // 一个用户恰好访问的页面就能让应用去 fetch 本机地址。
        let scheme = url.split("://").next().unwrap_or("").to_ascii_lowercase();
        return Err(format!("只接受 https 地址（现在是 {}）", if scheme.is_empty() { "未知协议" } else { scheme.as_str() }));
    }
    let rest = &url["https://".len()..];
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.contains('@') {
        return Err("地址里不能带账号密码".to_string());
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (authority, None),
    };
    if let Some(p) = port {
        if p != "443" {
            return Err(format!("只接受默认端口（现在是 {p}）"));
        }
    }
    let host = host.to_ascii_lowercase();
    if !hosts.iter().any(|h| h.eq_ignore_ascii_case(&host)) {
        return Err(format!("只接受这些来源：{}（现在是 {}）", hosts.join("、"), host));
    }
    Ok(url.to_string())
}

/// 解析帖子 JSON（纯函数）。缺字段是**报错**而不是填空：
/// 一篇没有来路的空笔记比失败更糟。
pub fn parse_post(json: &str) -> Result<CommunityPost, String> {
    let v: serde_json::Value = serde_json::from_str(json).map_err(|e| format!("帖子 JSON 解析失败：{e}"))?;
    let obj = v.as_object().ok_or_else(|| "帖子接口返回的不是一个 JSON 对象".to_string())?;
    let get_str = |key: &str| -> String {
        obj.get(key)
            .map(|x| match x {
                serde_json::Value::String(s) => s.clone(),
                serde_json::Value::Number(n) => n.to_string(),
                _ => String::new(),
            })
            .unwrap_or_default()
            .trim()
            .to_string()
    };
    let id = get_str("id");
    let title = get_str("title");
    let body_markdown = obj
        .get("body_markdown")
        .or_else(|| obj.get("bodyMarkdown"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let url = get_str("url");
    if id.is_empty() {
        return Err("帖子 JSON 缺少 id（社区侧约定用 id 当稳定键）".to_string());
    }
    if title.is_empty() {
        return Err("帖子 JSON 缺少 title".to_string());
    }
    if body_markdown.trim().is_empty() {
        return Err("帖子 JSON 缺少 body_markdown（正文源码）".to_string());
    }
    if title.chars().count() > 300 {
        return Err(format!("帖子标题过长（{} 字，上限 300）", title.chars().count()));
    }
    // 帖子里的 url 是写进笔记的"来源"，必须也是同一个白名单里的地址。
    check_post_url(&url, COMMUNITY_HOSTS).map_err(|e| format!("帖子里的 url 不可信：{e}"))?;
    let tags = obj
        .get("tags")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|t| t.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .take(20)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(CommunityPost {
        id,
        title,
        body_markdown,
        author: get_str("author"),
        created_at: {
            let a = get_str("created_at");
            if a.is_empty() { get_str("createdAt") } else { a }
        },
        updated_at: {
            let a = get_str("updated_at");
            if a.is_empty() { get_str("updatedAt") } else { a }
        },
        tags,
        url,
    })
}

/// 带体积上限的 GET，返回 (字节, 落地地址)。
///
/// 上限在**读取过程中**也守着：只看 `Content-Length` 会被"不报长度、慢慢灌"的服务器绕过。
async fn get_capped(
    client: &reqwest::Client,
    url: &str,
    cap: u64,
) -> Result<(Vec<u8>, String), String> {
    // **带上 `Accept: application/json`**：深链里带的是**帖子页地址**（用户从浏览器复制的那条），
    // 而社区侧最省的落地方式就是在同一个地址上做内容协商（返回 JSON）——这样应用不需要知道
    // slug→id 的映射（那是他们的实现细节）。实测过：当前那个地址只回 HTML，
    // 所以下面那条"不是 JSON"的错误信息要把**该怎么修**说清楚，而不是只说"类型不对"。
    let resp = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|e| {
        if e.is_connect() || e.is_timeout() {
            format!("取不到这篇帖子：无法连接到 {url}（网络或地址不可达）")
        } else {
            format!("取不到这篇帖子：{e}")
        }
    })?;
    let landed = resp.url().to_string();
    // 状态码如实上报：**别让 401/404 被压成一句"网络错误"**（这正是前端 fetch 的病）。
    if !resp.status().is_success() {
        return Err(format!(
            "取不到这篇帖子：HTTP {}（{url}）",
            resp.status().as_u16()
        ));
    }
    let ctype = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !ctype.contains("json") {
        // 不内置 HTML 正文抽取（社区方案第七节）：拿到网页就说清"这不是 JSON"。
        let got = if ctype.is_empty() { "未提供".to_string() } else { ctype.clone() };
        return Err(format!(
            "这个地址返回的不是 JSON（Content-Type: {got}）——应用已经带着 `Accept: application/json` 去要了；\
             社区侧要么在**同一个帖子页地址**上按 Accept 返回 JSON，要么给出 JSON 的 alternate 链接"
        ));
    }
    if let Some(len) = resp.content_length() {
        if len > cap {
            return Err(format!("帖子 JSON 超过体积上限（{} KiB）", cap / 1024));
        }
    }
    let mut buf: Vec<u8> = Vec::new();
    let mut resp = resp;
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("读取帖子失败：{e}"))?
    {
        if buf.len() as u64 + chunk.len() as u64 > cap {
            return Err(format!("帖子 JSON 超过体积上限（{} KiB）", cap / 1024));
        }
        buf.extend_from_slice(&chunk);
    }
    Ok((buf, landed))
}

/// 抓取实现（可注入主机白名单：命令用常量，测试可以换成回环地址）。
pub async fn fetch_post_with_hosts(url: &str, hosts: &[&str]) -> Result<CommunityPost, String> {
    let target = check_post_url(url, hosts)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| e.to_string())?;
    let (bytes, landed) = get_capped(&client, &target, MAX_POST_JSON_BYTES).await?;
    // **落地地址复查**：重定向可能把我们带到别处（前端那条也是这么做的）。
    if landed != target {
        check_post_url(&landed, hosts)
            .map_err(|e| format!("这个地址被重定向到了不允许的地方（{landed}）：{e}"))?;
    }
    let text = String::from_utf8(bytes).map_err(|_| "帖子 JSON 不是合法的 UTF-8".to_string())?;
    parse_post(&text)
}

/// 把一篇社区帖子抓成结构化对象。**不做任何写入**——落库由前端"预览 → 确认"那一步决定。
#[tauri::command]
pub async fn fetch_community_post(url: String) -> Result<CommunityPost, String> {
    fetch_post_with_hosts(&url, COMMUNITY_HOSTS).await
}

/// 抓一个社区托管的**文档**（模板文件那类），返回 JSON 文本。
///
/// 为什么不复用 `fetch_community_post`：那条要求"帖子"的形状（`body_markdown` 等），
/// 而 `import` 拿到的是一份**模板文件**——形状不同、校验规则也不同（模板的校验在前端，
/// 因为"模板长什么样"是那边的知识）。所以这里只做**传输**：同一个策略、同一个上限、
/// 同样只认 JSON；解析与校验各归其位。
#[tauri::command]
pub async fn fetch_community_json(url: String) -> Result<String, String> {
    let target = check_post_url(&url, COMMUNITY_HOSTS)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| e.to_string())?;
    let (bytes, landed) = get_capped(&client, &target, MAX_POST_JSON_BYTES).await?;
    if landed != target {
        check_post_url(&landed, COMMUNITY_HOSTS)
            .map_err(|e| format!("这个地址被重定向到了不允许的地方（{landed}）：{e}"))?;
    }
    String::from_utf8(bytes).map_err(|_| "这个地址返回的不是合法的 UTF-8".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    const HOSTS: &[&str] = COMMUNITY_HOSTS;

    // ---- 地址策略 ----

    #[test]
    fn only_https_and_allowlisted_hosts_pass() {
        assert!(check_post_url("https://community.shuyo.cn/post/x", HOSTS).is_ok());
        for bad in [
            "http://community.shuyo.cn/post/x",
            "http://127.0.0.1:8787/post.json",
            "https://evil.example.com/post/x",
            "https://community.shuyo.cn.evil.com/post/x",
            "https://community.shuyo.cn:8443/post/x",
            "https://user:pass@community.shuyo.cn/post/x",
            "",
        ] {
            assert!(check_post_url(bad, HOSTS).is_err(), "{bad} 不该通过");
        }
    }

    // ---- 解析 ----

    #[test]
    fn required_fields_are_enforced_and_the_source_url_is_trusted() {
        let ok = r#"{"id":30,"title":"标题","body_markdown":"正文","author":"社区","created_at":"t1","updated_at":"t2","tags":["a"],"url":"https://community.shuyo.cn/post/x"}"#;
        let post = parse_post(ok).expect("正常帖子必须解析成功");
        assert_eq!(post.id, "30");
        assert_eq!(post.title, "标题");
        assert_eq!(post.tags, vec!["a".to_string()]);

        let base = |id: &str, title: &str, body: &str, url: &str| {
            format!(r#"{{"id":"{id}","title":"{title}","body_markdown":"{body}","url":"{url}"}}"#)
        };
        assert!(parse_post(&base("", "t", "b", "https://community.shuyo.cn/post/x")).is_err());
        assert!(parse_post(&base("1", "", "b", "https://community.shuyo.cn/post/x")).is_err());
        assert!(parse_post(&base("1", "t", "", "https://community.shuyo.cn/post/x")).is_err());
        // 帖子里的 url 必须也过白名单：它是写进笔记的"来源"
        let err = parse_post(&base("1", "t", "b", "https://evil.example.com/post/x")).unwrap_err();
        assert!(err.contains("帖子里的 url 不可信"), "{err}");
        assert!(parse_post("不是 JSON").is_err());
    }

    // 帖子里那条 url 必须是白名单里的 https 地址（它是写进笔记的"来源"）；
    // 抓取用的是回环夹具，两者不需要相同——这里测的是"取数机制"。
    const POST_BODY: &str = r#"{"id":1,"title":"t","body_markdown":"b","url":"https://community.shuyo.cn/post/x"}"#;

    // ---- 抓取的**取数机制**（真环回服务器）----
    //
    // 这里直接测 `get_capped` 而不是 `fetch_post_with_hosts`：策略只认 https + 白名单主机，
    // 而本机夹具只能是明文回环。**不去为了测试放宽策略**（那正好会把"只认 https"这条
    // 最该守的规则测成假的），而是把"机制"单独拎出来用真 HTTP 打一遍——
    // 状态码如实上报、只认 JSON、读字节时守上限，这三条都是前端 fetch 那条路上丢掉的。
    fn serve_once(response: String) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 2048];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
            }
        });
        format!("http://{addr}/post.json")
    }

    fn with_body(body: &str, ctype: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.as_bytes().len()
        )
    }

    fn client() -> reqwest::Client {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .expect("client")
    }

    /// 按 `Accept` 协商的环回服务器：要 JSON 就给 JSON，否则给网页。
    /// 用来证明**我们确实在要 JSON**，以及"社区只要支持内容协商，应用一行都不用改"。
    fn serve_negotiating(json_body: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_ascii_lowercase();
                let resp = if req.contains("accept: application/json") {
                    with_body(json_body, "application/json")
                } else {
                    with_body("<html>页面</html>", "text/html; charset=utf-8")
                };
                let _ = stream.write_all(resp.as_bytes());
                let _ = stream.flush();
            }
        });
        format!("http://{addr}/post/x")
    }

    #[tokio::test]
    async fn we_ask_for_json_so_content_negotiation_is_enough() {
        let url = serve_negotiating(POST_BODY);
        let (bytes, _) = get_capped(&client(), &url, MAX_POST_JSON_BYTES)
            .await
            .expect("带着 Accept: application/json 去要，就该拿到 JSON");
        assert_eq!(parse_post(&String::from_utf8(bytes).unwrap()).unwrap().id, "1");
    }

    #[tokio::test]
    async fn html_answer_says_how_to_fix_it() {
        // 只回 HTML 的服务器（当前社区的真实表现）：错误信息要说清"我们已经在要 JSON 了"。
        let url = serve_once(with_body("<html>页面</html>", "text/html; charset=utf-8"));
        let err = get_capped(&client(), &url, MAX_POST_JSON_BYTES).await.unwrap_err();
        assert!(err.contains("返回的不是 JSON"), "{err}");
        assert!(err.contains("Accept: application/json"), "要说清我们已经在要 JSON：{err}");
    }

    #[tokio::test]
    async fn capped_get_reports_status_content_type_and_size_honestly() {
        // 401 要如实说 401：前端 fetch 那条路上它会变成一句 "Failed to fetch"（实测）
        let url = serve_once("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string());
        let err = get_capped(&client(), &url, MAX_POST_JSON_BYTES).await.unwrap_err();
        assert!(err.contains("HTTP 401"), "{err}");

        // 404 同理
        let url = serve_once("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string());
        let err = get_capped(&client(), &url, MAX_POST_JSON_BYTES).await.unwrap_err();
        assert!(err.contains("HTTP 404"), "{err}");

        // 返回网页 → 说"不是 JSON"，不抽正文
        let url = serve_once(with_body("<html></html>", "text/html"));
        let err = get_capped(&client(), &url, MAX_POST_JSON_BYTES).await.unwrap_err();
        assert!(err.contains("返回的不是 JSON"), "{err}");

        // 体积超限（Content-Length 就超）
        let big = "x".repeat(64);
        let url = serve_once(format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 999999\r\nConnection: close\r\n\r\n{big}"
        ));
        let err = get_capped(&client(), &url, 1024).await.unwrap_err();
        assert!(err.contains("超过体积上限"), "{err}");

        // 正常 JSON：拿到字节与**落地地址**
        let url = serve_once(with_body(POST_BODY, "application/json"));
        let (bytes, landed) = get_capped(&client(), &url, MAX_POST_JSON_BYTES).await.expect("必须取到");
        assert!(landed.starts_with("http://127.0.0.1"));
        assert_eq!(parse_post(&String::from_utf8(bytes).expect("utf8")).expect("解析").id, "1");
    }
}
