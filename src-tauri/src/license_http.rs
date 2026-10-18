//! 发卡站（license-issuer）的**受控 HTTP** 与**签名**入口。
//!
//! 为什么 HTTP 在 Rust、而"被签名字节"在前端：
//! · 私钥**只在 Rust 里**（设备身份）⇒ 签名必须在这里 ✓；
//! · 四条被签名字节是**契约**（`src/lib/license/signedBytes.ts`，判据逐字钉着）⇒
//!   布局**只有那一份**，本模块只签调用方给的那串字节（⛔ 不自己拼 ✗，否则两份实现）。
//!
//! ## 两条安全边界（都写死在这里，⛔ 不许放宽）
//! ① **只许打登记过的那台发卡站**：`license_set_issuer` 记下 base URL，
//!    `license_http` 的 URL 必须与它**同源**（scheme+host+port）⇒ 前端拿不到"任意 URL 的 fetch"。
//! ② 没配地址 ⇒ 两条都明确拒绝（⛔ 不许"先跑起来再说" ✗）。
use std::sync::Mutex;

const DEFAULT_TIMEOUT_SECS: u64 = 20;

static ISSUER_BASE: Mutex<Option<String>> = Mutex::new(None);

fn origin_of(url: &str) -> Option<String> {
    let u = reqwest::Url::parse(url).ok()?;
    let scheme = u.scheme().to_ascii_lowercase();
    if scheme != "https" && scheme != "http" {
        return None;
    }
    let host = u.host_str()?.to_ascii_lowercase();
    Some(format!("{}://{}{}", scheme, host, u.port_or_known_default().map(|p| format!(":{p}")).unwrap_or_default()))
}

/// 登记发卡站地址（只接受 http/https；留空 = 关闭整块）。
pub fn set_issuer(base: &str) -> Result<(), String> {
    let b = base.trim().trim_end_matches('/');
    if b.is_empty() {
        *ISSUER_BASE.lock().unwrap() = None;
        return Ok(());
    }
    let origin = origin_of(b).ok_or_else(|| format!("发卡站地址不合法：{b}"))?;
    if origin != b {
        // 允许路径前缀（如 https://x/api），但必须能解析成同源；这里只记 origin 之外的完整 base
        reqwest::Url::parse(b).map_err(|_| format!("发卡站地址不合法：{b}"))?;
    }
    *ISSUER_BASE.lock().unwrap() = Some(b.to_string());
    Ok(())
}

fn issuer_base() -> Result<String, String> {
    ISSUER_BASE
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "没配发卡站地址 —— 这一块功能已关闭（不是网络错误）".to_string())
}

/// 把 `path`（必须 `/` 开头、可带 query）拼到登记的 base 上，并**复核同源**。
fn join_url(base: &str, path: &str) -> Result<String, String> {
    if !path.starts_with('/') {
        return Err(format!("路径必须以 / 开头：{path}"));
    }
    let url = format!("{}{}", base.trim_end_matches('/'), path);
    let (bo, uo) = (
        origin_of(base).ok_or("发卡站地址不合法")?,
        origin_of(&url).ok_or("请求地址不合法")?,
    );
    if bo != uo {
        return Err("请求地址与登记的发卡站不同源 —— 拒绝".to_string());
    }
    Ok(url)
}

/// **受控请求**：方法、路径（可带 query）、可选头与 body。返回 `{status, body}`。
pub async fn http(
    method: &str,
    path: &str,
    headers: Vec<(String, String)>,
    body: Option<String>,
) -> Result<(u16, String), String> {
    let base = issuer_base()?;
    let url = join_url(&base, path)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(DEFAULT_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("建不了 HTTP 客户端：{e}"))?;
    let m = reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| format!("不认识的 HTTP 方法：{method}"))?;
    let mut req = client.request(m, &url);
    for (k, v) in headers {
        req = req.header(k, v);
    }
    if let Some(b) = body {
        req = req.body(b);
    }
    let res = req.send().await.map_err(|e| format!("连不上发卡站：{e}"))?;
    let status = res.status().as_u16();
    let text = res.text().await.map_err(|e| format!("读响应失败：{e}"))?;
    Ok((status, text))
}

/// 把**续期拿回来的租约**交给中继（写进中继配置的 `token` 那一格）。
///
/// ## 为什么必须写进配置而不是留在内存
/// 中继连接是**另一个进程/另一次启动**也要读的东西（`relay_client::token_text` 从配置读）⇒
/// 只留在内存里 ⇒ 下次启动又变回"未授权"（用户会以为"续了费却没用"）。
///
/// ## 三条不许省的
/// ① **先验签再落盘**（`relay_license::verify_lease`，设备号必须是本机）—— ⛔ 不验就写 = 把可伪造的串当凭证；
/// ② 只改 `token` 一格，其余字段（`url` 等）**原样保留**（读 `serde_json::Value` 而不是结构体 ⇒ 不丢未知字段）；
/// ③ 先写 `.tmp` 再 rename（同目录）。
pub fn apply_lease(lease: &str) -> Result<serde_json::Value, String> {
    let text = lease.trim();
    if text.is_empty() {
        return Err("租约是空的".to_string());
    }
    let id = crate::device_identity::load_default()?;
    let claims = crate::relay_license::verify_lease(text, now_unix(), &id.dev())
        .map_err(|e| format!("租约验不过（{e:?}）—— 没写进配置"))?;

    let path = crate::relay_client::resolve_config_path()
        .ok_or_else(|| "拿不到中继配置路径（app data dir 还没初始化）".to_string())?;
    let mut cfg: serde_json::Value = if path.exists() {
        let raw = std::fs::read_to_string(&path).map_err(|e| format!("读不了中继配置：{e}"))?;
        serde_json::from_str(&raw).map_err(|e| format!("中继配置不是合法 JSON：{e}"))?
    } else {
        serde_json::json!({})
    };
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("建不了中继配置目录：{e}"))?;
    }
    cfg["token"] = serde_json::Value::String(text.to_string());
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&cfg).map_err(|e| e.to_string())?)
        .map_err(|e| format!("写不了临时配置文件：{e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("落盘中继配置失败：{e}"))?;

    Ok(serde_json::json!({
        "applied": true,
        "leaseExp": claims.exp,
        "relayUrl": cfg.get("url").cloned().unwrap_or(serde_json::Value::Null),
    }))
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 把续期拿到的租约交给中继（**先验签**再落盘；只改 `token` 一格）。
#[tauri::command]
pub fn license_apply_lease(lease: String) -> Result<serde_json::Value, String> {
    apply_lease(&lease)
}

// ── 命令层（薄壳）──────────────────────────────────────────────────────────────
/// 登记发卡站地址（空串 = 关闭这一整块；界面据 `license_issuer_ready` 决定显不显示按钮）。
#[tauri::command]
pub fn license_set_issuer(base: String) -> Result<(), String> {
    set_issuer(&base)
}

/// 这一块现在**能不能用**（没配地址 ⇒ `false` ＋ 一句为什么，⛔ 不是"网络错误"）。
#[tauri::command]
pub fn license_issuer_ready() -> serde_json::Value {
    match issuer_base() {
        Ok(base) => serde_json::json!({ "ready": true, "base": base }),
        Err(why) => serde_json::json!({ "ready": false, "why": why }),
    }
}

/// **受控请求**：只许打登记过的那台发卡站（同源复核）。返回 `{ status, body }`。
#[tauri::command]
pub async fn license_http_request(
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
) -> Result<serde_json::Value, String> {
    let (status, text) = http(&method, &path, headers, body).await?;
    Ok(serde_json::json!({ "status": status, "body": text }))
}

#[cfg(test)]
mod tests {
    // ⚠️ 这一行**不能省**：2026-10-18 我把它删掉后，`cargo check`（不编测试）照样绿，
    //    而 CI 的 `cargo test` 直接 8 处 `E0425`（`origin_of`／`ISSUER_BASE` 找不到）⇒ 整条 Rust 红。
    //    ⇒ 本地验 Rust 改动一律用 `cargo check --tests`（或 `cargo test --lib`）。
    use super::*;

    #[test]
    fn same_origin_and_missing_base() {
        assert_eq!(origin_of("https://license.shuyo.cn").as_deref(), Some("https://license.shuyo.cn:443"));
        assert!(origin_of("file:///etc/passwd").is_none());
        // 没配 ⇒ 明确拒绝（不是"网络错误"）
        *ISSUER_BASE.lock().unwrap() = None;
        let err = issuer_base().unwrap_err();
        assert!(err.contains("没配发卡站地址"), "{err}");
    }

    #[test]
    fn path_must_be_absolute_and_join_keeps_origin() {
        set_issuer("https://license.shuyo.cn").unwrap();
        assert_eq!(join_url("https://license.shuyo.cn", "/v1/orders").unwrap(), "https://license.shuyo.cn/v1/orders");
        assert!(join_url("https://license.shuyo.cn", "v1/orders").is_err());
        set_issuer("").unwrap();
    }
}
