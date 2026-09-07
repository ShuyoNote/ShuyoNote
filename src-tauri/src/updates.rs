//! 更新检查（桌面端 native 拉取发布清单）。
//!
//! 桌面 WebView 里用浏览器 `fetch` 请求 gitcode 的 `latest.json` 会被跨域拦截：
//! gitcode 对该地址返回 **302 重定向**到 `file-cdn.gitcode.com` 的签名 URL
//! （带 `auth_key`），而目标 CDN 响应不带 `Access-Control-Allow-Origin`，于是
//! 浏览器按 CORS 拒绝，控制台报 `[Error] Cross-origin redirection ... denied`。
//!
//! 这里改走 native HTTP（reqwest）：不经过浏览器 CORS，且 reqwest 默认会
//! 自动跟随 302→file-cdn 的重定向并拿到 `latest.json` 本体，前端桌面端再据此
//! 对比版本。`fetch` 路径在浏览器里无法绕过 CORS，native 请求可以。

use serde::Serialize;

/// 与前端 `updates.ts` 的 `UpdateManifest` 对应。
#[derive(Serialize)]
pub struct UpdateManifest {
    pub version: Option<String>,
    pub notes: Option<String>,
    pub pub_date: Option<String>,
}

/// 稳定发布渠道：gitcode 的 "latest" 通道，永远携带最新元数据。
const DEFAULT_MANIFEST_URL: &str =
    "https://gitcode.com/shuyo-cn/ShuyoNote/releases/download/latest/latest.json";

fn describe_net(e: &reqwest::Error, url: &str) -> String {
    if e.is_connect() || e.is_timeout() {
        format!("无法连接到 {url}，请确认网络/地址可访问。")
    } else {
        format!("请求 {url} 失败：{e}")
    }
}

/// 拉取 gitcode 最新发布清单（latest.json）。前端桌面端调用，替代会被 CORS
/// 拦截的浏览器 fetch。`url` 缺省用稳定发布渠道；失败返回 `Err`（前端按
/// 「无更新」降级，不会抛到 UI）。
#[tauri::command]
pub async fn fetch_update_manifest(url: Option<String>) -> Result<Option<UpdateManifest>, String> {
    let url = url.unwrap_or_else(|| DEFAULT_MANIFEST_URL.to_string());
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(&url).send().await.map_err(|e| describe_net(&e, &url))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let j = resp
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;
    Ok(Some(UpdateManifest {
        version: j.get("version").and_then(|v| v.as_str()).map(str::to_string),
        notes: j.get("notes").and_then(|v| v.as_str()).map(str::to_string),
        pub_date: j.get("pub_date").and_then(|v| v.as_str()).map(str::to_string),
    }))
}
