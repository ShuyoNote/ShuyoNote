//! 一键发布到社区（客户端侧）：设备码授权、令牌存储、发帖。
//!
//! 社区侧契约：`shuyo-community` `docs/api.md` §7（0.71.20 起）。这一侧要守住三条：
//!   ① **不收用户密码**：走设备码 —— 用户在自己浏览器里确认，客户端只拿一把 180 天、可撤销的令牌；
//!   ② **令牌不进笔记**：只落在 app 数据目录（与附件同处），不进 front matter、不进日志、不进导出；
//!   ③ **同修订重发只落一篇**：幂等键由 `(笔记 id, 修订)` 决定 —— **不用随机数**（社区按 key 回放首次响应，
//!      随机键等于放弃幂等，症状是"重试一次多一篇"）。
//!
//! 另一条与 `community.rs`（抓取侧）共享的纪律：**状态码如实上报**。401 是"令牌被撤销了"、
//! 403 `app_token_scope` 是"我们发错接口了"、409 是"上一个还在处理"、
//! 422 分两种（带 `error` 的 JSON = "审核/校验拦下了"；纯文本 = axum 没收下我们的请求体 = 客户端 bug）。
//! 四件事对用户意味着四种不同动作，压成一句"发布失败"就等于让人去猜。

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// 只认这一个站点（与抓取侧同一策略：不跟配置走，免得多一个可被改写的出口）。
pub const COMMUNITY_BASE: &str = "https://community.shuyo.cn";

const TIMEOUT_SECS: u64 = 20;
/// 社区对幂等键的约束：安全字符、≤128（`posts::idempotency_key`）。
const IDEM_MAX: usize = 128;
/// 社区对 `source_ref` 的约束：安全字符、≤64（`posts::normalize_source_ref`）。
const SOURCE_REF_MAX: usize = 64;
/// 内容指纹的位数（十六进制字符数）：`content_rev` 取 sha256 前 16 字节。
pub const CONTENT_REV_HEX: usize = 32;
/// 社区白名单里认的来源名。
pub const SOURCE: &str = "shuyonote";
/// 设备码申请时自报的名字（用户会在网页上看到它，所以要认得出来是谁）。
pub const CLIENT_NAME: &str = "ShuyoNote 桌面端";
const AUTH_FILE: &str = "community-auth.json";

// ---------------------------------------------------------------------------
// ① 纯函数：不碰网络与磁盘，全部可单测
// ---------------------------------------------------------------------------

/// 只留 `[A-Za-z0-9_-]` —— 与社区侧 `posts::idempotency_key` / `normalize_source_ref` 同一口径。
///
/// 为什么先在这里洗一遍：社区那边**丢弃**非法字符而不是报错（这是对的，客户端换个 id 生成算法
/// 不该让一次发帖失败），所以"我发出去的键"与"它存下来的键"必须同形，否则重试时算出来的键与
/// 第一次存进去的不一致 —— 幂等就**静默失效**了。
pub fn sanitize_token(raw: &str) -> String {
    raw.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

fn clip(s: String, max: usize) -> String {
    if s.chars().count() <= max {
        s
    } else {
        s.chars().take(max).collect()
    }
}

/// 幂等键：`shuyonote-<笔记 id>-<修订>`。**同一个 (id, rev) 永远同一个键** —— 这是 I2 的全部。
///
/// 两侧各自限长 48：直接截整串会把修订号截掉，于是"同一篇笔记的两个修订"会算出同一个键，
/// 表现为"发了新版，社区还是老内容"（那是比多一篇更坏的错）。
pub fn idempotency_key(note_id: &str, rev: &str) -> String {
    let a = clip(sanitize_token(note_id), 48);
    let b = clip(sanitize_token(rev), 48);
    clip(format!("{SOURCE}-{a}-{b}"), IDEM_MAX)
}

/// `source_ref`：客户端自己算的页面指纹。社区只存不解释，用来人工核对"这帖对应哪篇笔记的哪一版"。
pub fn source_ref(note_id: &str, rev: &str) -> String {
    clip(
        format!("{}-{}", sanitize_token(note_id), sanitize_token(rev)),
        SOURCE_REF_MAX,
    )
}

/// **发布内容指纹**（v1）：同一份内容永远同一个指纹，与"这一页什么时候被保存过"无关。
///
/// 为什么不用页面的 `updated_at` 当修订号（这是 0.71.x 那版方案的口子）：`save_page` 每次都写
/// `now_ms()` ⇒ "改一个字再改回去"也会换修订，而内容其实一模一样 —— 于是
/// ① 幂等键变了 ⇒ 同一份内容**多发一篇**；② 界面只能说"不是同一个修订"，说不出"内容到底变没变"。
/// 换成内容指纹后两件事同时变准：同内容 ⇒ 同键 ⇒ 社区回放首次结果（不会多一篇）。
///
/// 输入必须是**本地态**（标题、正文 Markdown、标签）：正文里的图片地址在发布时会被换成社区地址，
/// 拿换过地址的那份算指纹，会让"同一篇笔记、同一批图"因为上传顺序/结果不同而算出两个指纹。
///
/// 分片带长度前缀（`<字节数>:<内容>`，段间 `\n`）：标题/正文里本来就可能出现任何字符，
/// 长度前缀下"两份不同内容拼成同一个串"不会发生（与签名要防的是同一件事）。
/// 标签**排序**后参与 —— 标签顺序变一下不该算新内容。
pub fn content_rev(title: &str, body: &str, tags: &[String]) -> String {
    let mut sorted: Vec<&str> = tags.iter().map(|t| t.as_str()).collect();
    sorted.sort_unstable();
    let mut canonical = String::from("shuyonote-content-v1");
    for part in std::iter::once(title).chain(std::iter::once(body)).chain(sorted) {
        canonical.push('\n');
        canonical.push_str(&part.len().to_string());
        canonical.push(':');
        canonical.push_str(part);
    }
    let digest = Sha256::digest(canonical.as_bytes());
    // 取前 16 字节（32 hex）：这不是密码学用途的摘要，只用来判"是不是同一份内容"。
    digest.iter().take(16).map(|b| format!("{b:02x}")).collect()
}

/// 社区对标签的**服务端口径**（见它 `src/tags.rs` 的 `MAX_TAGS` / `MAX_TAG_CHARS`）：
/// `,` 连接的一个字符串，最多 5 个、每个 ≤16 字、ASCII 转小写。
/// 本地先按同一套裁好，免得"清单里写着 8 个标签、社区只存了 5 个"变成一处静默丢失。
pub const COMMUNITY_MAX_TAGS: usize = 5;
pub const COMMUNITY_MAX_TAG_CHARS: usize = 16;

/// 发给社区的 `NewPost`（字段名与它 `POST /api/posts` 的 JSON 同形）。
///
/// ⚠️ **`tags` 是一个字符串**（`数友,工作流`），**不是数组** —— 2026-09-21 用户第一次真发帖
/// 就撞在这上面：我们此前按"数组"发（`"tags":["插件","Markdown"]`），社区（axum `Json<NewPost>`，
/// 见它 `src/posts.rs` 的 `pub tags: Option<String>`）当场回 422：
/// ```text
/// Failed to deserialize the JSON body into the target type:
/// tags: invalid type: sequence, expected a string at line 1 column 425
/// ```
/// 社区自己的发帖表单也是**一个文本框**（它 `src/render.rs` 里 `input type="text" name="tags"`），
/// 服务端用 `tags::normalize` 按 `,`/`，`/`、`/`;`/`；` 切分。
/// 「字段名同形」这句话当时只对着**字段名**验证过（判据里从来没有真服务器/真契约），
/// 于是类型错了也一路绿到用户面前 —— 所以现在 `tests` 里有一条**线形状**判据，见
/// [`tests::payload_sends_tags_as_a_string_because_that_is_the_wire_contract`]。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NewPostPayload {
    pub title: String,
    pub body: String,
    pub tags: String,
    pub source: String,
    pub source_ref: String,
}

/// 组装发帖体。标题为空**在这一侧就报错**：社区会回 422，但那时用户看到的是"审核没通过"，
/// 而真实原因是"这篇笔记没标题"——两回事。
pub fn build_payload(
    title: &str,
    body: &str,
    tags: &[String],
    note_id: &str,
    rev: &str,
) -> Result<NewPostPayload, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("这篇笔记没有标题：社区要求标题非空（给笔记起个名，或用文件名当标题）".to_string());
    }
    // 规范化顺序**照着社区 `tags::normalize` 来**（去 `#`、去空、限长 16 字、限 5 个、
    // 去重时比较的是**裁过之后**的值）——顺序不一样就可能"本地留的和社区存的不是同一批"。
    // 唯一不跟它一致的是大小写：它存小写，我们保留原样（本地显示/指纹都用原样，不影响幂等）。
    let mut out: Vec<String> = Vec::new();
    for raw in tags {
        let cleaned = raw.trim().trim_start_matches('#').trim();
        if cleaned.is_empty() {
            continue;
        }
        let capped: String = cleaned.chars().take(COMMUNITY_MAX_TAG_CHARS).collect();
        if out.iter().any(|t| t.eq_ignore_ascii_case(&capped)) {
            continue;
        }
        out.push(capped);
        if out.len() >= COMMUNITY_MAX_TAGS {
            break;
        }
    }
    Ok(NewPostPayload {
        title: title.to_string(),
        body: body.to_string(),
        tags: out.join(","),
        source: SOURCE.to_string(),
        source_ref: source_ref(note_id, rev),
    })
}

fn preview(body: &str) -> String {
    clip(body.trim().to_string(), 200)
}

/// 社区响应的判读结果（= 用户该做什么）。
#[derive(Debug, Clone, PartialEq)]
pub enum PublishOutcome {
    Ok {
        id: i64,
        slug: String,
        url: String,
    },
    /// 同一个幂等键**正在处理中**：稍后重试，不是错误。
    InFlight,
    /// 审核拦下（422），原样带上社区给的理由。
    Rejected {
        error: String,
    },
    /// 令牌失效 / 被撤销 ⇒ 清本地令牌、回到"连接社区"。
    Unauthorized,
    /// 撞上 scope 白名单（403 `app_token_scope`）⇒ 这是客户端 bug，发错接口了。
    OutOfScope,
    Unexpected {
        status: u16,
        error: String,
    },
}

/// 把 HTTP 状态与响应体翻译成"用户该做什么"。
///
/// 注意：成功响应是**整篇 `Post`**（社区直接序列化帖子对象，没有 `ok` 字段），所以判"发成了没有"
/// 靠 `id` + `slug` 在不在，而不是靠某个 `ok: true`。缺了就当没发成 —— 宁可让用户重试，
/// 也不要回写一个空 slug 进笔记。
pub fn classify(status: u16, body: &str, base: &str) -> PublishOutcome {
    let v: serde_json::Value =
        serde_json::from_str(body).unwrap_or(serde_json::Value::Null);
    let err = v
        .get("error")
        .and_then(|e| e.as_str())
        .unwrap_or("")
        .to_string();
    match status {
        200..=299 => {
            let slug = v
                .get("slug")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            let id = v.get("id").and_then(|i| i.as_i64()).unwrap_or(0);
            if slug.is_empty() || id == 0 {
                return PublishOutcome::Unexpected {
                    status,
                    error: format!("社区回了 {} 但响应里没有 id/slug：{}", status, preview(body)),
                };
            }
            let url = format!("{base}/post/{slug}");
            PublishOutcome::Ok { id, slug, url }
        }
        409 => PublishOutcome::InFlight,
        // 422 有两种，**形状能分开**（2026-09-21 真发帖撞出来的）：
        //   ① 社区自己的校验/风控拦下 —— 响应体是 JSON 且带 `error`（`内容不合规` / `defect_incomplete`
        //      / `failed`，见它 `src/posts.rs` 的 create）；
        //   ② axum 的 `Json<NewPost>` 反序列化失败 —— 响应体是**纯文本**
        //      （`Failed to deserialize the JSON body into the target type: …`）。
        // ② 是"我们的请求体形状就不对" = 客户端 bug，被读成"审核拦下"会把 bug 藏起来
        // （用户截图里那句就是它），所以归到 Unexpected 去。
        422 if !err.is_empty() => PublishOutcome::Rejected { error: err },
        422 => PublishOutcome::Unexpected {
            status,
            error: if body.trim().is_empty() {
                "422：社区没给理由（响应体是空的）".to_string()
            } else {
                format!("{}（这不是审核拦下，是社区**没收下这个请求体**：把这句话反馈给开发者）", preview(body))
            },
        },
        401 => PublishOutcome::Unauthorized,
        403 if err == "app_token_scope" => PublishOutcome::OutOfScope,
        403 => PublishOutcome::Rejected {
            // 全站双重提交：这一条多半意味着"我们没先把 csrf_token cookie 取回来"。
            error: if err.is_empty() {
                "403：CSRF 校验没过（本地没拿到 csrf_token cookie）".to_string()
            } else {
                err
            },
        },
        _ => PublishOutcome::Unexpected {
            status,
            error: if err.is_empty() { preview(body) } else { err },
        },
    }
}

/// 从 `Set-Cookie` 里挑出 `csrf_token=…`。
///
/// `reqwest` 在这份 `Cargo.toml` 里**没开 `cookies` feature**（见 §6 的取舍），所以 cookie 由我们
/// 自己接住再显式发回去 —— 顺带也就有了判据：少了这一步，POST 会被社区 403 挡下。
pub fn csrf_from_set_cookies<'a, I: IntoIterator<Item = &'a str>>(cookies: I) -> Option<String> {
    for raw in cookies {
        for part in raw.split(';') {
            let part = part.trim();
            if let Some(v) = part.strip_prefix("csrf_token=") {
                if !v.is_empty() {
                    return Some(v.to_string());
                }
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// ② 令牌存储：一个文件，路径可注入（判据要在临时目录里跑）
// ---------------------------------------------------------------------------

/// 落在磁盘上的授权（**只有这里**有令牌）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAuth {
    pub base: String,
    pub token: String,
    pub username: String,
    pub scope: String,
    pub client: String,
    pub saved_at: String,
}

/// 回给界面的连接信息：**没有令牌** —— 令牌不进前端状态，也就不进任何一次前端日志/崩溃上报。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub base: String,
    pub username: String,
    pub scope: String,
    pub saved_at: String,
}

impl StoredAuth {
    pub fn info(&self) -> ConnectionInfo {
        ConnectionInfo {
            base: self.base.clone(),
            username: self.username.clone(),
            scope: self.scope.clone(),
            saved_at: self.saved_at.clone(),
        }
    }
}

/// 写授权文件。Unix 下把权限收到 0600：这是一把能用 180 天的凭据，同机其它用户不该读得到。
pub fn save_auth_at(path: &Path, auth: &StoredAuth) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("建配置目录失败（{}）：{e}", dir.display()))?;
    }
    let text = serde_json::to_string_pretty(auth).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| format!("写授权文件失败（{}）：{e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// 读授权文件。**读坏了当作"没连接"**（不 panic、不静默用半截数据）——重连一次就好。
pub fn load_auth_at(path: &Path) -> Option<StoredAuth> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<StoredAuth>(&text).ok()
}

pub fn clear_auth_at(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("删授权文件失败（{}）：{e}", path.display())),
    }
}

fn auth_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("拿不到应用数据目录：{e}"))?;
    Ok(dir.join(AUTH_FILE))
}

// ---------------------------------------------------------------------------
// ③ 网络：设备码 + 发帖（core 都带 base 参数，测试打回环地址）
// ---------------------------------------------------------------------------

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| e.to_string())
}

/// `GET /` 取 CSRF cookie（全站双重提交：cookie 与 `X-CSRF-Token` 必须同值）。
async fn csrf(client: &reqwest::Client, base: &str) -> Result<String, String> {
    let resp = client.get(base).send().await.map_err(|e| {
        if e.is_connect() || e.is_timeout() {
            format!("连不上社区（{base}）：网络不可达")
        } else {
            format!("取 CSRF cookie 失败：{e}")
        }
    })?;
    let cookies: Vec<String> = resp
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .collect();
    csrf_from_set_cookies(cookies.iter().map(|s| s.as_str())).ok_or_else(|| {
        format!("{base} 没有下发 csrf_token cookie —— 没有它任何 POST 都会被 403 挡下")
    })
}

struct Auth<'a> {
    bearer: Option<&'a str>,
    csrf: &'a str,
    idempotency: Option<&'a str>,
}

/// 发一个 JSON POST，返回 (状态码, 响应体)。状态码**不在这里判**（判读是 `classify` 的事）。
async fn post_json(
    client: &reqwest::Client,
    url: &str,
    auth: Auth<'_>,
    body: &serde_json::Value,
) -> Result<(u16, String), String> {
    let mut req = client
        .post(url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header("X-CSRF-Token", auth.csrf)
        .header(reqwest::header::COOKIE, format!("csrf_token={}", auth.csrf))
        .json(body);
    if let Some(t) = auth.bearer {
        req = req.bearer_auth(t);
    }
    if let Some(k) = auth.idempotency {
        req = req.header("Idempotency-Key", k);
    }
    let resp = req.send().await.map_err(|e| {
        // 超时/连接失败要说清"可能已经发出了"：发布这条路上重发是安全的（幂等键），
        // 但用户得知道"重试不会多一篇"这件事成立。
        if e.is_timeout() {
            format!("请求超时（{url}）：网络慢或服务端无响应，稍后用同一个幂等键重试即可，不会多发")
        } else if e.is_connect() {
            format!("连不上社区（{url}）：网络不可达")
        } else {
            format!("请求失败（{url}）：{e}")
        }
    })?;
    let status = resp.status().as_u16();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读响应失败：{e}"))?;
    Ok((status, text))
}

/// 发帖的 core（可注入 base）。
pub async fn publish_at(
    base: &str,
    auth: &StoredAuth,
    payload: &NewPostPayload,
    key: &str,
) -> Result<PublishOutcome, String> {
    let client = client()?;
    let csrf = csrf(&client, base).await?;
    let body = serde_json::to_value(payload).map_err(|e| e.to_string())?;
    let (status, text) = post_json(
        &client,
        &format!("{base}/api/posts"),
        Auth {
            bearer: Some(&auth.token),
            csrf: &csrf,
            idempotency: Some(key),
        },
        &body,
    )
    .await?;
    Ok(classify(status, &text, base))
}

/// 设备码：换到令牌、确认身份、存下来。core 带 base。
pub async fn poll_at(
    base: &str,
    device_code: &str,
) -> Result<(String, Option<StoredAuth>), String> {
    let client = client()?;
    let csrf = csrf(&client, base).await?;
    let (status, text) = post_json(
        &client,
        &format!("{base}/api/auth/app/token"),
        Auth {
            bearer: None,
            csrf: &csrf,
            idempotency: None,
        },
        &serde_json::json!({ "device_code": device_code }),
    )
    .await?;
    let v: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    let token = v.get("token").and_then(|t| t.as_str()).unwrap_or("");
    if token.is_empty() {
        // 还没批准 / 过期 / 未知码：错误码原样带出去，别统一成 "failed"。
        let state = v
            .get("status")
            .and_then(|s| s.as_str())
            .or_else(|| v.get("error").and_then(|e| e.as_str()))
            .unwrap_or("");
        let state = if state.is_empty() {
            format!("failed_{status}")
        } else {
            state.to_string()
        };
        return Ok((state, None));
    }
    let username = me_username(&client, base, token).await.unwrap_or_default();
    let scope = v
        .get("scope")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();
    let auth = StoredAuth {
        base: base.to_string(),
        token: token.to_string(),
        username,
        scope,
        client: CLIENT_NAME.to_string(),
        saved_at: now(),
    };
    Ok(("approved".to_string(), Some(auth)))
}

/// `GET /api/me`：只为一个问题 —— "这把令牌是谁的"（界面上要能让用户核对）。
async fn me_username(
    client: &reqwest::Client,
    base: &str,
    token: &str,
) -> Result<String, String> {
    let resp = client
        .get(format!("{base}/api/me"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    Ok(v.get("username")
        .and_then(|u| u.as_str())
        .unwrap_or("")
        .to_string())
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

// ---------------------------------------------------------------------------
// ④ Tauri 命令（薄壳：读文件 / 调 core / 写文件）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStart {
    pub user_code: String,
    pub device_code: String,
    pub verify_url: String,
    pub interval_seconds: i64,
    pub expires_in_seconds: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectPoll {
    /// `pending` / `approved` / `expired` / `unknown` / `already_used` / `failed_<code>`
    pub state: String,
    pub username: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisconnectOutcome {
    pub local_cleared: bool,
    pub remote_revoked: bool,
    pub note: String,
}

/// 发布结果（前端照 `status` 分支：它对应"用户该做什么"，不是"HTTP 发生了什么"）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum PublishResult {
    #[serde(rename_all = "camelCase")]
    Ok {
        id: i64,
        slug: String,
        url: String,
        idempotency_key: String,
    },
    InFlight,
    Rejected {
        error: String,
    },
    Unauthorized,
    OutOfScope,
    #[serde(rename_all = "camelCase")]
    Unexpected {
        http_status: u16,
        error: String,
    },
}

/// 当前连接（没有令牌字段）。
#[tauri::command]
pub fn community_connection(app: tauri::AppHandle) -> Result<Option<ConnectionInfo>, String> {
    let path = auth_path(&app)?;
    Ok(load_auth_at(&path).map(|a| a.info()))
}

/// 起设备码流程：返回 `user_code`（给用户看）与 `device_code`（自己轮询用）。
#[tauri::command]
pub async fn community_connect_start() -> Result<DeviceStart, String> {
    let base = COMMUNITY_BASE;
    let client = client()?;
    let csrf = csrf(&client, base).await?;
    let (status, text) = post_json(
        &client,
        &format!("{base}/api/auth/app/device"),
        Auth {
            bearer: None,
            csrf: &csrf,
            idempotency: None,
        },
        &serde_json::json!({ "client": CLIENT_NAME }),
    )
    .await?;
    let v: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    let user_code = v
        .get("user_code")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();
    let device_code = v
        .get("device_code")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();
    if user_code.is_empty() || device_code.is_empty() {
        return Err(format!(
            "社区没有给出设备码（HTTP {status}）：{}",
            preview(&text)
        ));
    }
    Ok(DeviceStart {
        user_code,
        device_code,
        verify_url: format!("{base}/device"),
        interval_seconds: v
            .get("interval")
            .and_then(|i| i.as_i64())
            .unwrap_or(5),
        expires_in_seconds: v
            .get("expires_in")
            .and_then(|i| i.as_i64())
            .unwrap_or(600),
    })
}

/// 轮询一次（由界面按 `interval_seconds` 驱动：这样关掉对话框就能停，不必在 Rust 侧挂一个定时任务）。
/// 批准那一刻**顺手把令牌存下来**，界面不必再传一次凭据。
#[tauri::command]
pub async fn community_connect_poll(
    app: tauri::AppHandle,
    device_code: String,
) -> Result<ConnectPoll, String> {
    let (state, auth) = poll_at(COMMUNITY_BASE, &device_code).await?;
    let Some(auth) = auth else {
        return Ok(ConnectPoll {
            state,
            username: None,
        });
    };
    save_auth_at(&auth_path(&app)?, &auth)?;
    Ok(ConnectPoll {
        state,
        username: Some(auth.username),
    })
}

/// 断开连接 = **真撤销**（`POST /api/auth/app/tokens/revoke`），不是只删本地文件。
///
/// 顺序有意：先撤销、再删本地。撤销失败也删本地（否则用户被一把撤不掉的令牌"钉"在已连接态），
/// 但要**把话说明**：那把令牌在网页端撤销前仍然有效。
#[tauri::command]
pub async fn community_disconnect(app: tauri::AppHandle) -> Result<DisconnectOutcome, String> {
    let path = auth_path(&app)?;
    let Some(auth) = load_auth_at(&path) else {
        return Ok(DisconnectOutcome {
            local_cleared: true,
            remote_revoked: false,
            note: "本来就没有连接".to_string(),
        });
    };
    let remote = revoke_remote(&auth).await;
    clear_auth_at(&path)?;
    Ok(match remote {
        Ok(true) => DisconnectOutcome {
            local_cleared: true,
            remote_revoked: true,
            note: "已在社区侧撤销，本地凭据已删除".to_string(),
        },
        Ok(false) => DisconnectOutcome {
            local_cleared: true,
            remote_revoked: false,
            note: "本地凭据已删除，但社区侧没找到这把授权（可能已被网页端撤销）".to_string(),
        },
        Err(e) => DisconnectOutcome {
            local_cleared: true,
            remote_revoked: false,
            note: format!(
                "本地凭据已删除，但社区侧撤销失败（{e}）—— 那把令牌在到期或被网页端撤销前仍然有效"
            ),
        },
    })
}

/// 撤销远端：先列出自己的应用授权，认领 `client` 相同的那一条（客户端自报的名字即标识）。
async fn revoke_remote(auth: &StoredAuth) -> Result<bool, String> {
    let client = client()?;
    let csrf = csrf(&client, &auth.base).await?;
    let resp = client
        .get(format!("{}/api/auth/app/tokens", auth.base))
        .bearer_auth(&auth.token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    let id = v
        .get("items")
        .and_then(|i| i.as_array())
        .and_then(|items| {
            items
                .iter()
                .filter(|it| {
                    it.get("client").and_then(|c| c.as_str()).unwrap_or("") == auth.client
                })
                .filter_map(|it| it.get("id").and_then(|i| i.as_i64()))
                .max()
        });
    let Some(id) = id else {
        return Ok(false);
    };
    let (status, body) = post_json(
        &client,
        &format!("{}/api/auth/app/tokens/revoke", auth.base),
        Auth {
            bearer: Some(&auth.token),
            csrf: &csrf,
            idempotency: None,
        },
        &serde_json::json!({ "id": id }),
    )
    .await?;
    if !(200..300).contains(&status) {
        return Err(format!("HTTP {status}：{}", preview(&body)));
    }
    let v: serde_json::Value = serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
    Ok(v.get("ok").and_then(|o| o.as_bool()).unwrap_or(false))
}

/// 发布一篇笔记。幂等键由 `(note_id, rev)` 算出来 —— 界面**不要**自己造 key。
///
/// `rev` 必须是 [`content_rev`] 的返回值（32 位十六进制的**内容指纹**），不是页面更新时间戳：
/// 传时间戳会让"同一份内容"在每次保存后换一个新的幂等键 ⇒ 多发一篇，而且界面上只能含混地说
/// "不是同一个修订"。这一条用**显式校验**挡住（见下），因为传错的症状是静默的。
#[tauri::command]
pub async fn community_publish_note(
    app: tauri::AppHandle,
    title: String,
    body: String,
    tags: Vec<String>,
    note_id: String,
    rev: String,
) -> Result<PublishResult, String> {
    let path = auth_path(&app)?;
    let Some(auth) = load_auth_at(&path) else {
        return Err(
            "还没连接社区：先点「连接社区」（不用输密码，在自己浏览器里确认一次即可）".to_string(),
        );
    };
    // 显式挡"把时间戳当修订号"：指纹是 32 位十六进制，`updated_at` 是 13 位十进制。
    if rev.len() != CONTENT_REV_HEX || !rev.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!(
            "rev 必须是内容指纹（32 位十六进制，来自 community_content_rev），当前是「{rev}」——\
             传时间戳会让同一份内容每保存一次就多发一篇"
        ));
    }
    let payload = build_payload(&title, &body, &tags, &note_id, &rev)?;
    let key = idempotency_key(&note_id, &rev);
    let outcome = publish_at(&auth.base, &auth, &payload, &key).await?;
    let result = match outcome {
        PublishOutcome::Ok { id, slug, url } => PublishResult::Ok {
            id,
            slug,
            url,
            idempotency_key: key,
        },
        PublishOutcome::InFlight => PublishResult::InFlight,
        PublishOutcome::Rejected { error } => PublishResult::Rejected { error },
        PublishOutcome::Unauthorized => PublishResult::Unauthorized,
        PublishOutcome::OutOfScope => PublishResult::OutOfScope,
        PublishOutcome::Unexpected { status, error } => PublishResult::Unexpected {
            http_status: status,
            error,
        },
    };
    // **只有真发成了才回写**：失败留下一条"发过了"的台账，会让人以为不用再发。
    if let PublishResult::Ok { slug, url, .. } = &result {
        record_into_db(&app, &note_id, slug, url, &rev);
    }
    Ok(result)
}

/// 发原始字节（图片上传用）。与 `post_json` 同一套头：CSRF 双重提交 + Bearer。
async fn post_bytes(
    client: &reqwest::Client,
    url: &str,
    auth: Auth<'_>,
    bytes: Vec<u8>,
) -> Result<(u16, String), String> {
    let resp = client
        .post(url)
        .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
        .header("X-CSRF-Token", auth.csrf)
        .header(reqwest::header::COOKIE, format!("csrf_token={}", auth.csrf))
        .bearer_auth(auth.bearer.unwrap_or(""))
        .body(bytes)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                format!("上传超时（{url}）：图可能偏大或网慢，重试即可（内容寻址，重复上传不会占两份）")
            } else if e.is_connect() {
                format!("连不上社区（{url}）：网络不可达")
            } else {
                format!("上传失败（{url}）：{e}")
            }
        })?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(|e| format!("读响应失败：{e}"))?;
    Ok((status, text))
}

// ---------------------------------------------------------------------------
// ④ 图片：上传附件（社区内容寻址，正文里按 `/attachments/<hash>` 引用）
// ---------------------------------------------------------------------------

/// 社区附件的体积上限（`shuyo-community` 的 `POST /api/attachments` 是 5 MiB）。
pub const MAX_ATTACHMENT_BYTES: usize = 5 * 1024 * 1024;

/// 上传前的本地判据（纯函数，好单测）：**先把话说清**，别把 6 MB 传上去等对面 413。
pub fn ensure_uploadable(size: usize) -> Result<(), String> {
    if size == 0 {
        return Err("这个附件是空文件，社区不会收".to_string());
    }
    if size > MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "附件约 {} MiB，超过社区上限 5 MiB —— 先在笔记里压一下这张图再发",
            (size + 1024 * 1024 - 1) / (1024 * 1024)
        ));
    }
    Ok(())
}

/// 一张附件上传成功后的结果。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadedAttachment {
    /// 本地 hash（也就调用方手里的那个），用来把正文里的本地引用换成社区地址。
    pub local_hash: String,
    /// 社区算出来的 hash。**正常情况下与本地一致**（两边都是同一份字节的 sha256），
    /// 但以它为准 —— 正文里引用的是社区那份。
    pub hash: String,
    /// 写进正文用的地址：**相对路径**（社区自己的文档就是这么引用的：`![图](/attachments/<hash>)`）。
    pub url: String,
    pub mime: String,
    pub size: usize,
}

/// 上传的 core（可注入 base，判据打回环地址）。
pub async fn upload_at(
    base: &str,
    auth: &StoredAuth,
    bytes: &[u8],
) -> Result<(String, String, usize), String> {
    let client = client()?;
    let csrf = csrf(&client, base).await?;
    let (status, text) = post_bytes(
        &client,
        &format!("{base}/api/attachments"),
        Auth {
            bearer: Some(&auth.token),
            csrf: &csrf,
            idempotency: None,
        },
        bytes.to_vec(),
    )
    .await?;
    let v: serde_json::Value =
        serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    if !(200..300).contains(&status) {
        // 社区的拒绝理由要说清是**哪一类**（太大 / 类型不支持 / 审核），原样带出去。
        let why = v
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("")
            .to_string();
        let why = if why.is_empty() { preview(&text) } else { why };
        return Err(format!("社区拒收这张图（HTTP {status}）：{why}"));
    }
    let hash = v.get("hash").and_then(|h| h.as_str()).unwrap_or("").to_string();
    if hash.is_empty() {
        return Err(format!("社区回了 {status} 但没给 hash：{}", preview(&text)));
    }
    Ok((
        hash,
        v.get("mime").and_then(|m| m.as_str()).unwrap_or("").to_string(),
        v.get("size").and_then(|s| s.as_u64()).unwrap_or(bytes.len() as u64) as usize,
    ))
}

/// 上传一篇笔记里的一张本地图片，返回写进正文用的社区地址。
///
/// **为什么字节要从 `attachments::attachment_bytes` 拿，而不是自己 `fs::read`**：
/// 附件在盘上可能是**加密**的（应用加密开着时），`fs::read` 拿到的是密文 ——
/// 传上去会被社区的魔数白名单挡下，而报错会说"不支持的文件类型"，把人指向完全错的方向。
/// 那个函数会把密钥解开再给明文（`security::decrypt_attachment_bytes`）。
#[tauri::command]
pub async fn community_upload_attachment(
    app: tauri::AppHandle,
    db: tauri::State<'_, crate::db::Db>,
    hash: String,
) -> Result<UploadedAttachment, String> {
    let auth_path = auth_path(&app)?;
    let Some(auth) = load_auth_at(&auth_path) else {
        return Err(
            "还没连接社区：先点「连接社区」（不用输密码，在自己浏览器里确认一次即可）".to_string(),
        );
    };
    // 同步读 + 解密，**在 await 之前**把 `State` 放掉（`attachment_bytes` 会借 db 取密钥）。
    let bytes = {
        let db = db;
        crate::attachments::attachment_bytes(app.clone(), db, &hash)?
    };
    ensure_uploadable(bytes.len())?;
    let (remote, mime, size) = upload_at(&auth.base, &auth, &bytes).await?;
    Ok(UploadedAttachment {
        local_hash: hash,
        url: format!("/attachments/{remote}"),
        hash: remote,
        mime,
        size,
    })
}

// ---------------------------------------------------------------------------
// ⑤ 发布状态（回写）："这一页最近发到哪儿了、发的是哪一版"
// ---------------------------------------------------------------------------

/// 一页的发布状态（回给界面的形状）。**没有令牌** —— 它只回答"发到哪儿了、哪一份内容"。
///
/// 为什么要记：`published_rev` 是**内容指纹**（`content_rev`），所以"这篇发过没有、线上那一份
/// 是不是现在这一份"可以本地判 —— 界面靠它说明"再发一次是重复（社区会回放首次结果）还是新建一篇"
/// （P2 之前每次都会新建一篇，用户更该知道）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishState {
    pub page_id: String,
    pub slug: String,
    pub url: String,
    /// 发出去的那一份内容的指纹（与 `community_publish_note` 收到的 `rev` 同源）。
    pub published_rev: String,
    pub published_at: i64,
}

/// 记下"这一页最近一次发布到哪儿、发的哪一版"。
///
/// 只记**最近一次**（`page_id` 主键，后来的覆盖先前的）：一篇笔记现在可能对应社区上的多篇
/// （改完再发就是新的一篇，P2 才会改成"更新已有帖子"）；这张表要回答的是
/// "我这篇最近发到哪儿了、线上那一篇是哪一版"。要留全部历史得另开一张表（P2 再谈）。
pub fn record_publish(
    conn: &rusqlite::Connection,
    page_id: &str,
    slug: &str,
    url: &str,
    rev: &str,
    at: i64,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO page_community_publish(page_id, slug, url, published_rev, published_at) \
         VALUES (?1, ?2, ?3, ?4, ?5) \
         ON CONFLICT(page_id) DO UPDATE SET \
           slug = excluded.slug, url = excluded.url, \
           published_rev = excluded.published_rev, published_at = excluded.published_at",
        rusqlite::params![page_id, slug, url, rev, at],
    )
    .map(|_| ())
    .map_err(|e| format!("记发布状态失败：{e}"))
}

/// 读一页的发布状态（没发过就是 `None`）。表不存在也当 `None` —— 老库还没迁移时，
/// 界面该显示"没发过"，而不是让整个对话框打不开。
pub fn publish_state(conn: &rusqlite::Connection, page_id: &str) -> Option<PublishState> {
    conn.query_row(
        "SELECT page_id, slug, url, published_rev, published_at \
         FROM page_community_publish WHERE page_id = ?1",
        [page_id],
        |r| {
            Ok(PublishState {
                page_id: r.get(0)?,
                slug: r.get(1)?,
                url: r.get(2)?,
                published_rev: r.get(3)?,
                published_at: r.get(4)?,
            })
        },
    )
    .ok()
}

/// 从 `AppHandle` 取库并落一条状态。
///
/// **这一步失败不许把发布判成失败**：帖子已经在社区上了，它只是记本地台账 ——
/// 报错会让人以为没发出去、于是再发一篇（那正好是最不想要的结果）。所以只打一行日志。
fn record_into_db(app: &tauri::AppHandle, page_id: &str, slug: &str, url: &str, rev: &str) {
    use tauri::Manager;
    let db = app.state::<crate::db::Db>();
    let Ok(conn) = db.0.lock() else {
        eprintln!("[community] 记发布状态失败：库锁坏了（帖子已发出，不影响结果）");
        return;
    };
    if let Err(e) = record_publish(&conn, page_id, slug, url, rev, crate::db::now_ms()) {
        eprintln!("[community] 记发布状态失败（帖子已发出，不影响结果）：{e}");
    }
}

/// 读一页的发布状态。界面用它显示"上次发布：…"，并在**内容指纹不同**时提醒
/// "再发会新建一篇"（P2 之前不会更新已有帖子）。
#[tauri::command]
pub fn community_publish_state(
    db: tauri::State<'_, crate::db::Db>,
    page_id: String,
) -> Result<Option<PublishState>, String> {
    let conn = db.0.lock().map_err(|_| "库锁坏了".to_string())?;
    Ok(publish_state(&conn, &page_id))
}

/// 算当前内容的指纹（**纯函数、不碰网络与磁盘**）。
///
/// 界面用它与台账里的 `publishedRev` 比对 —— 比的是"内容是不是同一份"，
/// 而不是"页面有没有被保存过"。**正文要传本地态**（见 `content_rev` 的注释）。
#[tauri::command]
pub fn community_content_rev(title: String, body: String, tags: Vec<String>) -> String {
    content_rev(&title, &body, &tags)
}

// ---------------------------------------------------------------------------
// ⑥ 判据
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn tmp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "shuyonote-community-{}-{}",
            std::process::id(),
            name
        ));
        let _ = std::fs::create_dir_all(&dir);
        dir.join(AUTH_FILE)
    }

    #[test]
    fn idempotency_key_is_stable_and_only_safe_chars() {
        // 同一个 (id, rev) 永远同一个键 —— 这是"重发只落一篇"的全部依据。
        assert_eq!(
            idempotency_key("笔记 A/1", "rev 2"),
            idempotency_key("笔记 A/1", "rev 2")
        );
        let k = idempotency_key("笔记 A/1", "rev 2");
        assert!(
            k.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'),
            "键里混进了社区不认的字符：{k}"
        );
        assert!(k.starts_with("shuyonote-"), "来源要能从键上认出来：{k}");
        // 换一版必须换一个键，否则"发了新版，社区还是老内容"。
        assert_ne!(idempotency_key("n", "1"), idempotency_key("n", "2"));
        assert!(k.chars().count() <= IDEM_MAX);
    }

    #[test]
    fn idempotency_key_keeps_both_parts_when_id_is_long() {
        let long = "长".repeat(200);
        let k = idempotency_key(&long, "7");
        assert!(k.chars().count() <= IDEM_MAX);
        assert!(
            k.ends_with("-7"),
            "超长 id 不能把修订号挤掉（否则两个修订会算出同一个键）：{k}"
        );
    }

    #[test]
    fn payload_needs_a_title_and_dedups_tags() {
        let e = build_payload("   ", "正文", &[], "n", "1").unwrap_err();
        assert!(e.contains("标题"), "标题为空要说清是这个原因：{e}");

        let tags = vec![
            "  Rust ".to_string(),
            "#rust".to_string(),
            "".to_string(),
            "Note".to_string(),
        ];
        let p = build_payload("标题", "正文", &tags, "n", "1").unwrap();
        // 去重（`Rust` / `#rust` 是同一个）后**拼成一个字符串**：社区收的是 `tags` 字符串。
        assert_eq!(p.tags, "Rust,Note");
        assert_eq!(p.source, SOURCE);
        assert_eq!(p.source_ref, "n-1");
        // 上站前先自证：发出去的 JSON 字段名就是社区要的那几个。
        let j = serde_json::to_value(&p).unwrap();
        for f in ["title", "body", "tags", "source", "source_ref"] {
            assert!(j.get(f).is_some(), "少了字段 {f}");
        }
    }

    /// **线形状判据**：`tags` 必须是 JSON **字符串**，不能是数组。
    ///
    /// 2026-09-21 用户第一次真发帖就被这条挡住（社区 422 原文见 `NewPostPayload` 的注释）：
    /// 我们此前按数组发，而本地全部判据都只对**字段名**做断言（`j.get("tags").is_some()`），
    /// 类型错了照样绿 —— 这条就是补那个洞。任何"顺手把 tags 改回 Vec"的改动都会在这里红。
    #[test]
    fn payload_sends_tags_as_a_string_because_that_is_the_wire_contract() {
        let p = build_payload("标题", "正文", &["插件".to_string()], "n", "1").unwrap();
        let json = serde_json::to_string(&p).unwrap();
        assert!(
            json.contains(r#""tags":"插件""#),
            "tags 必须是字符串（社区 `NewPost.tags: Option<String>`）：{json}"
        );
        assert!(
            !json.contains(r#""tags":["#),
            "tags 不许发成数组 —— 社区会回 422 `invalid type: sequence, expected a string`：{json}"
        );
        // 没有标签时是**空字符串**，也不是 `[]`
        let none = build_payload("标题", "正文", &[], "n", "1").unwrap();
        assert!(serde_json::to_string(&none).unwrap().contains(r#""tags":"""#));
    }

    /// 本地就按社区的上限裁（5 个 / 每个 ≤16 字）：否则"清单里 8 个标签、社区只存 5 个"
    /// 又是一处静默丢失。
    #[test]
    fn payload_caps_tags_the_way_the_community_does() {
        let many: Vec<String> = (0..8).map(|i| format!("tag{i}")).collect();
        let p = build_payload("标题", "正文", &many, "n", "1").unwrap();
        assert_eq!(p.tags, "tag0,tag1,tag2,tag3,tag4", "最多 5 个");

        let long = vec!["一二三四五六七八九十一二三四五六七八".to_string()];
        let p2 = build_payload("标题", "正文", &long, "n", "1").unwrap();
        assert_eq!(p2.tags.chars().count(), COMMUNITY_MAX_TAG_CHARS, "每个标签限 16 字");

        // 裁完之后才去重：两个只差尾部的长标签会变成同一个，只留一个。
        let dup = vec![
            "一二三四五六七八九十一二三四五六".to_string(),
            "一二三四五六七八九十一二三四五六七".to_string(),
        ];
        let p3 = build_payload("标题", "正文", &dup, "n", "1").unwrap();
        assert!(!p3.tags.contains(','), "裁完相同的两个标签只该留一个：{}", p3.tags);
    }

    #[test]
    fn source_ref_is_within_the_server_side_rules() {
        let r = source_ref(&"x".repeat(200), "rev");
        assert!(r.chars().count() <= SOURCE_REF_MAX, "超长了：{}", r.len());
        assert!(r
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'));
    }

    #[test]
    fn classify_reads_the_community_response_shapes() {
        let base = "https://community.shuyo.cn";
        // 成功响应是整篇 Post（没有 ok 字段）。
        let ok = classify(
            200,
            r#"{"id":42,"title":"t","slug":"my-post","body":"b","tags":[],"source":"shuyonote"}"#,
            base,
        );
        assert_eq!(
            ok,
            PublishOutcome::Ok {
                id: 42,
                slug: "my-post".to_string(),
                url: "https://community.shuyo.cn/post/my-post".to_string()
            }
        );
        // 200 但没有 slug/id ⇒ 当没发成（绝不回写空 slug 进笔记）。
        assert!(matches!(
            classify(200, r#"{"ok":true}"#, base),
            PublishOutcome::Unexpected { .. }
        ));
        assert_eq!(
            classify(409, r#"{"ok":false,"error":"duplicate_in_flight"}"#, base),
            PublishOutcome::InFlight
        );
        assert_eq!(
            classify(422, r#"{"ok":false,"error":"内容不合规"}"#, base),
            PublishOutcome::Rejected {
                error: "内容不合规".to_string()
            }
        );
        // 422 但**没有** JSON `error`：这是 axum 没收下我们的请求体（响应体是纯文本），
        // 即客户端 bug —— 2026-09-21「tags 发成了数组」那次就是它，用户看到的那句
        // 「社区没有通过这篇（审核拦下）」是错的标题。判据要求：原样带上社区那句话 + 明说不是审核。
        match classify(
            422,
            "Failed to deserialize the JSON body into the target type: \
             tags: invalid type: sequence, expected a string at line 1 column 425",
            base,
        ) {
            PublishOutcome::Unexpected { status, error } => {
                assert_eq!(status, 422);
                assert!(
                    error.contains("invalid type: sequence"),
                    "要原样带上社区那句话：{error}"
                );
                assert!(error.contains("不是审核拦下"), "要说清这不是审核拦下：{error}");
            }
            other => panic!("纯文本 422 判读错了：{other:?}"),
        }
        assert_eq!(classify(401, "", base), PublishOutcome::Unauthorized);
        assert_eq!(
            classify(403, r#"{"ok":false,"error":"app_token_scope"}"#, base),
            PublishOutcome::OutOfScope
        );
        // 403 但不是 scope：CSRF 那条，措辞要指向真因。
        match classify(403, "", base) {
            PublishOutcome::Rejected { error } => assert!(error.contains("CSRF")),
            other => panic!("403 没有 CSRF 时判读错了：{other:?}"),
        }
        match classify(500, "boom", base) {
            PublishOutcome::Unexpected { status, error } => {
                assert_eq!(status, 500);
                assert!(error.contains("boom"));
            }
            other => panic!("500 判读错了：{other:?}"),
        }
    }

    #[test]
    fn csrf_cookie_is_picked_out_of_set_cookie_headers() {
        let got = csrf_from_set_cookies(vec![
            "other=1; Path=/",
            "csrf_token=abc123; Path=/; SameSite=Lax; HttpOnly".to_string().as_str(),
        ]);
        assert_eq!(got.as_deref(), Some("abc123"));
        assert_eq!(csrf_from_set_cookies(vec!["csrf_token=; Path=/"]), None);
        assert_eq!(csrf_from_set_cookies(Vec::<&str>::new()), None);
    }

    #[test]
    fn auth_file_round_trips_and_is_not_world_readable() {
        let path = tmp_path("roundtrip");
        let _ = std::fs::remove_file(&path);
        assert_eq!(load_auth_at(&path), None, "没文件时就是未连接");

        let auth = StoredAuth {
            base: COMMUNITY_BASE.to_string(),
            token: "tok".to_string(),
            username: "数友".to_string(),
            scope: "post:create post:update".to_string(),
            client: CLIENT_NAME.to_string(),
            saved_at: "2026-09-20T00:00:00Z".to_string(),
        };
        save_auth_at(&path, &auth).unwrap();
        assert_eq!(load_auth_at(&path), Some(auth.clone()));
        // 回给界面的信息里**没有令牌**。
        let info = serde_json::to_value(auth.info()).unwrap();
        assert!(info.get("token").is_none(), "令牌不该进前端状态");
        assert_eq!(info.get("username").unwrap(), "数友");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "授权文件权限应该是 0600，实际 {mode:o}");
        }

        clear_auth_at(&path).unwrap();
        assert_eq!(load_auth_at(&path), None);
        // 读坏了当"没连接"，不 panic。
        std::fs::write(&path, "{ 这不是 json").unwrap();
        assert_eq!(load_auth_at(&path), None);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// 真起一个假社区：① 只给带 `Set-Cookie: csrf_token=…` 的 `GET /`；
    /// ② `POST /api/posts` 没有 `X-CSRF-Token` / `Cookie` / `Authorization` / `Idempotency-Key`
    ///    就 403，齐了才 200 一整篇 Post。
    ///
    /// 为什么值得起个真监听：这一步的坑全在**头**上（CSRF 双重提交、Bearer、幂等键），
    /// 用 mock 掉 reqwest 的方式测，等于把要验的东西一起 mock 掉了。
    #[test]
    fn publish_sends_csrf_bearer_and_idempotency_key() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let seen_srv = seen.clone();
        std::thread::spawn(move || {
            for _ in 0..2 {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                let mut buf = vec![0u8; 8192];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let mut lines = req.lines();
                let head = lines.next().unwrap_or("").to_string();
                seen_srv.lock().unwrap().push(req.clone());
                let (code, extra, body): (u16, &str, &str) = if head.starts_with("GET /") {
                    (
                        200,
                        "Set-Cookie: csrf_token=testcsrf; Path=/; SameSite=Lax\r\n",
                        "<html>home</html>",
                    )
                } else {
                    let lower = req.to_ascii_lowercase();
                    // **照真服务器的口径验请求体**：`tags` 必须是字符串（社区 `NewPost.tags: Option<String>`）。
                    // 2026-09-21 真发帖撞的就是这一条（我们发成数组 ⇒ 社区 422 `invalid type: sequence`）；
                    // 假社区此前只看请求头，于是这条契约在本地判据里是**空的**。
                    let body_txt = req.split("\r\n\r\n").nth(1).unwrap_or("");
                    let tags_is_string = serde_json::from_str::<serde_json::Value>(body_txt)
                        .ok()
                        .and_then(|v| v.get("tags").cloned())
                        .map(|t| t.is_string())
                        .unwrap_or(false);
                    let ok = tags_is_string
                        && lower.contains("x-csrf-token: testcsrf")
                        && lower.contains("cookie: csrf_token=testcsrf")
                        && lower.contains("authorization: bearer tok")
                        && lower.contains("idempotency-key: shuyonote-note1-rev1");
                    if ok {
                        (
                            200,
                            "",
                            r#"{"id":9,"slug":"note-one","body":"b","tags":[]}"#,
                        )
                    } else if !tags_is_string {
                        // 逐字照抄社区 axum 那句话的形状，好让判据里的失败信息一眼认出来。
                        (
                            422,
                            "",
                            "Failed to deserialize the JSON body into the target type: \
                             tags: invalid type: sequence, expected a string at line 1 column 425",
                        )
                    } else {
                        (403, "", r#"{"ok":false,"error":"bad_csrf"}"#)
                    }
                };
                let resp = format!(
                    "HTTP/1.1 {code} OK\r\n{extra}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(resp.as_bytes());
                let _ = stream.flush();
            }
        });

        let base = format!("http://{}", addr);
        let auth = StoredAuth {
            base: base.clone(),
            token: "tok".to_string(),
            username: "u".to_string(),
            scope: "post:create".to_string(),
            client: CLIENT_NAME.to_string(),
            saved_at: now(),
        };
        let payload = build_payload("标题", "正文", &[], "note1", "rev1").unwrap();
        let key = idempotency_key("note1", "rev1");
        let out = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(publish_at(&base, &auth, &payload, &key))
            .unwrap();
        assert_eq!(
            out,
            PublishOutcome::Ok {
                id: 9,
                slug: "note-one".to_string(),
                url: format!("{base}/post/note-one"),
            },
            "假社区收到的请求：{:#?}",
            seen.lock().unwrap()
        );
    }

    #[test]
    fn upload_guard_speaks_before_the_wire() {
        assert!(ensure_uploadable(1).is_ok(), "一字节的图也该放行");
        assert!(ensure_uploadable(MAX_ATTACHMENT_BYTES).is_ok(), "正好 5 MiB 是允许的");
        let e = ensure_uploadable(0).unwrap_err();
        assert!(e.contains("空文件"), "空文件要说清是空文件：{e}");
        let e = ensure_uploadable(MAX_ATTACHMENT_BYTES + 1).unwrap_err();
        assert!(e.contains("5 MiB"), "超限要说清上限：{e}");
    }

    /// 假社区收图：两个请求（`GET /` 拿 CSRF、`POST /api/attachments` 送字节）。
    /// 返回 (base, 收到的原始请求文本)。
    fn serve_upload(reply: (u16, &'static str)) -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let seen_srv = seen.clone();
        std::thread::spawn(move || {
            for _ in 0..2 {
                let Ok((mut stream, _)) = listener.accept() else { return };
                let mut buf = vec![0u8; 8192];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let is_get = req.starts_with("GET /");
                seen_srv.lock().unwrap().push(req);
                let (code, extra, body) = if is_get {
                    (200u16, "Set-Cookie: csrf_token=testcsrf; Path=/\r\n", "<html></html>")
                } else {
                    (reply.0, "", reply.1)
                };
                let resp = format!(
                    "HTTP/1.1 {code} X\r\n{extra}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(resp.as_bytes());
                let _ = stream.flush();
            }
        });
        (format!("http://{}", addr), seen)
    }

    /// 上传要带齐四样（原始字节 / `application/octet-stream` / CSRF 双重提交 / Bearer），
    /// 且社区拒收时**理由要原样带出去**（"不支持的文件类型"这种话不能丢）。
    #[test]
    fn upload_sends_raw_bytes_and_passes_the_reason_back() {
        let auth = StoredAuth {
            base: String::new(),
            token: "tok".to_string(),
            username: "u".to_string(),
            scope: "post:create".to_string(),
            client: CLIENT_NAME.to_string(),
            saved_at: now(),
        };
        // 一张最小的 PNG 头（社区按魔数认类型，所以字节得真像图）
        let png: Vec<u8> = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

        // ① 正常收下
        let (base, seen) = serve_upload((
            200,
            r#"{"ok":true,"hash":"deadbeef","mime":"image/png","size":8}"#,
        ));
        let out = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(upload_at(&base, &auth, &png))
            .unwrap();
        assert_eq!(out, ("deadbeef".to_string(), "image/png".to_string(), 8));
        let reqs = seen.lock().unwrap().clone();
        let post = reqs.iter().find(|r| r.starts_with("POST ")).expect("应有 POST");
        let lower = post.to_ascii_lowercase();
        assert!(post.starts_with("POST /api/attachments "), "打错了路径：{post}");
        assert!(lower.contains("content-type: application/octet-stream"), "社区只认 octet-stream");
        assert!(lower.contains("x-csrf-token: testcsrf"), "少了 CSRF 头");
        assert!(lower.contains("cookie: csrf_token=testcsrf"), "少了 CSRF cookie");
        assert!(lower.contains("authorization: bearer tok"), "少了 Bearer");
        assert!(post.contains("PNG"), "字节没跟着上去（魔数都找不到）");

        // ② 被拒：理由原样带出去
        let (base2, _) = serve_upload((422, r#"{"ok":false,"error":"不支持的文件类型"}"#));
        let err = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(upload_at(&base2, &auth, &png))
            .unwrap_err();
        assert!(err.contains("422"), "要说清状态码：{err}");
        assert!(err.contains("不支持的文件类型"), "社区的理由要原样带出去：{err}");
    }

    /// 发布状态：写 → 读 → 覆盖（只记最近一次），且"没发过"与"表不存在"都当作没有（不炸）。
    #[test]
    fn publish_state_round_trips_and_keeps_only_the_latest() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn, "space-test").unwrap();

        assert!(publish_state(&conn, "p1").is_none(), "没发过就是 None");

        record_publish(
            &conn,
            "p1",
            "note-one",
            "https://community.shuyo.cn/post/note-one",
            "rev-1",
            1000,
        )
        .unwrap();
        let s = publish_state(&conn, "p1").expect("刚写进去的要读得回来");
        assert_eq!(s.slug, "note-one");
        assert_eq!(s.published_rev, "rev-1");
        assert_eq!(s.published_at, 1000);

        // 同一页再发一次（内容改了 ⇒ 新 rev）：**只记最近一次**
        record_publish(
            &conn,
            "p1",
            "note-one-v2",
            "https://community.shuyo.cn/post/note-one-v2",
            "rev-2",
            2000,
        )
        .unwrap();
        let s = publish_state(&conn, "p1").unwrap();
        assert_eq!(s.slug, "note-one-v2");
        assert_eq!(s.published_rev, "rev-2");
        assert_eq!(s.published_at, 2000);

        // 别的页不受影响
        assert!(publish_state(&conn, "p2").is_none());

        // 老库（还没建这张表）：读 ⇒ None（界面显示"没发过"，不是打不开）；写 ⇒ 如实报错
        let old = rusqlite::Connection::open_in_memory().unwrap();
        assert!(
            publish_state(&old, "p1").is_none(),
            "表不存在时该当作没发过，而不是让对话框炸掉"
        );
        assert!(
            record_publish(&old, "p1", "s", "u", "r", 1).is_err(),
            "表不存在时写入要如实报错（别静默丢）"
        );
    }

    /// 迁移要真的把这张表建出来。`CREATE TABLE IF NOT EXISTS` 拼错一个字母就会被静默忽略，
    /// 而症状是"发过了却永远显示没发过" —— 所以盯的是**表本身在不在**。
    #[test]
    fn migrate_creates_the_publish_state_table() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn, "space-test").unwrap();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='page_community_publish'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1, "migrate 应该建出 page_community_publish");
    }

    /// 内容指纹：同一份内容永远同一个指纹；**字段边界不许串味**；标签顺序无关；换内容必换指纹。
    #[test]
    fn content_rev_is_content_addressed_not_time_addressed() {
        let tags = vec!["笔记".to_string(), "同步".to_string()];
        let a = content_rev("标题", "正文", &tags);
        assert_eq!(a, content_rev("标题", "正文", &tags), "同输入必须同输出");
        assert_eq!(a.len(), CONTENT_REV_HEX, "指纹是 32 位十六进制");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));

        // 标签顺序无关（社区那边标签也只是个集合）
        let reordered = vec!["同步".to_string(), "笔记".to_string()];
        assert_eq!(a, content_rev("标题", "正文", &reordered));

        // 任何一段变了都要换（尤其正文改了却没事，正是我们要防的）
        assert_ne!(a, content_rev("标题2", "正文", &tags));
        assert_ne!(a, content_rev("标题", "正文2", &tags));
        assert_ne!(a, content_rev("标题", "正文", &["笔记".to_string()]));

        // 长度前缀：[title="ab", body="c"] 与 [title="a", body="bc"] 拼起来若不加长度就同串
        assert_ne!(
            content_rev("ab", "c", &[]),
            content_rev("a", "bc", &[]),
            "字段边界必须靠长度前缀分开，否则两份不同内容会算出同一个指纹"
        );

        // 空内容也有指纹（不是空串），且与"只剩标签"那种不同
        assert!(!content_rev("", "", &[]).is_empty());
        assert_ne!(content_rev("", "", &[]), content_rev("", "", &["a".to_string()]));
    }

    /// 指纹必须由**本地态**正文算出：发布时正文里的图片会被换成社区地址，
    /// 拿换过地址的那份算，同一篇笔记会因为上传结果不同而算出两个指纹（那就白换了）。
    #[test]
    fn content_rev_differs_between_local_and_published_body() {
        let tags: Vec<String> = vec![];
        let local = "![图](attachment://localhost/a.png)";
        let published = "![图](/attachments/deadbeef)";
        assert_ne!(
            content_rev("标题", local, &tags),
            content_rev("标题", published, &tags),
            "这条不是在夸实现，是在说明**调用方必须传本地态**（界面传的就是 prepareContent 的本地那份）"
        );
    }

    /// 幂等键要能吃内容指纹：同一个 `(笔记, 指纹)` 两次算出来必须一样（重发只落一篇的依据）。
    #[test]
    fn idempotency_key_is_derived_from_the_content_rev() {
        let rev = content_rev("标题", "正文", &[]);
        assert_eq!(
            idempotency_key("page-1", &rev),
            idempotency_key("page-1", &rev)
        );
        // 内容变了 ⇒ 指纹变了 ⇒ 键也变了（那是**新的一篇**，本来就该是新内容）
        let other = content_rev("标题", "正文改了", &[]);
        assert_ne!(idempotency_key("page-1", &rev), idempotency_key("page-1", &other));
    }
}
