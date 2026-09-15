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
///
/// `android_url` / `android_sha256` 取自清单里的 `platforms["android-aarch64"]`
/// （**不是**新开的顶层键）：Android 的更新形态与桌面不同——不下发 minisign 签名，
/// 而是记 `sha256:<hex>` 字节指纹，由前端拿 url 交给系统浏览器/DownloadManager 下载、
/// 用户自行安装。清单里没有这个键时两个字段都是 `None`，**老清单照常解析**
/// （桌面更新通道不受影响）。
#[derive(Serialize)]
pub struct UpdateManifest {
    pub version: Option<String>,
    pub notes: Option<String>,
    pub pub_date: Option<String>,
    pub android_url: Option<String>,
    pub android_sha256: Option<String>,
}

/// 稳定发布渠道：gitcode 的 "latest" 通道，永远携带最新元数据。
const DEFAULT_MANIFEST_URL: &str =
    "https://gitcode.com/shuyo-cn/ShuyoNote/releases/download/latest/latest.json";

/// Android 发版件在更新器清单里的平台键（与 `scripts/lib/releaseArtifacts.mjs` 的
/// `ANDROID_PLATFORM_KEY` 必须是同一个字符串）。
const ANDROID_PLATFORM_KEY: &str = "android-aarch64";

fn describe_net(e: &reqwest::Error, url: &str) -> String {
    if e.is_connect() || e.is_timeout() {
        format!("无法连接到 {url}，请确认网络/地址可访问。")
    } else {
        format!("请求 {url} 失败：{e}")
    }
}

/// 从清单 JSON 里取出 android 条目的 (url, sha256)。
///
/// **解析必须容错**：清单可能是老格式（没有 `platforms`，或没有 android 键），
/// 也可能将来多出别的字段。这里的每一层都用 `get` + `and_then` 逐级取值，缺哪层
/// 就返回 `(None, None)` —— 绝不能因为一个平台条目缺失而让整份清单读取失败
/// （那会把桌面更新一起带下去）。
///
/// `signature` 对 android 约定是 `sha256:<hex>`：这里剥掉前缀、顺便校验形状，
/// 形状不对就当没有（宁可前端退回"前往发布页"，也不要拿一个错指纹去比）。
fn android_entry(j: &serde_json::Value) -> (Option<String>, Option<String>) {
    let entry = j.get("platforms").and_then(|p| p.get(ANDROID_PLATFORM_KEY));
    let url = entry
        .and_then(|e| e.get("url"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .filter(|u| u.starts_with("https://"));
    let sha256 = entry
        .and_then(|e| e.get("signature"))
        .and_then(|v| v.as_str())
        .and_then(|s| s.trim().strip_prefix("sha256:"))
        .map(str::to_string)
        .filter(|s| s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit()));
    (url, sha256)
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
    let (android_url, android_sha256) = android_entry(&j);
    Ok(Some(UpdateManifest {
        version: j.get("version").and_then(|v| v.as_str()).map(str::to_string),
        notes: j.get("notes").and_then(|v| v.as_str()).map(str::to_string),
        pub_date: j.get("pub_date").and_then(|v| v.as_str()).map(str::to_string),
        android_url,
        android_sha256,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 与 `scripts/release.mjs` 写盘形状一致的清单片段（桌面三键 + android）。
    fn manifest_with_android() -> serde_json::Value {
        json!({
            "version": "1.90.2",
            "notes": "本轮更新说明",
            "pub_date": "2026-09-15T02:00:00Z",
            "platforms": {
                "windows-x86_64": {
                    "signature": "dW50cnVzdGVkIGNvbW1lbnQ6...",
                    "url": "https://gitcode.com/shuyo-cn/ShuyoNote/releases/download/v1.90.2/ShuyoNote_1.90.2_x64-setup.exe"
                },
                "linux-x86_64": {
                    "signature": "dW50cnVzdGVkIGNvbW1lbnQ6...",
                    "url": "https://gitcode.com/shuyo-cn/ShuyoNote/releases/download/v1.90.2/ShuyoNote_1.90.2_amd64.deb"
                },
                "darwin-aarch64": {
                    "signature": "dW50cnVzdGVkIGNvbW1lbnQ6...",
                    // macOS 的更新通道产物是 `.app.tar.gz`（tauri-plugin-updater 在 macOS 上
                    // 只会 `GzDecoder` + tar 解包它）；dmg 只用于人工下载安装。
                    "url": "https://gitcode.com/shuyo-cn/ShuyoNote/releases/download/v1.90.2/ShuyoNote.app.tar.gz"
                },
                "android-aarch64": {
                    "signature": format!("sha256:{}", "ab".repeat(32)),
                    "url": "https://gitcode.com/shuyo-cn/ShuyoNote/releases/download/v1.90.2/ShuyoNote_1.90.2_android-arm64-release.apk"
                }
            }
        })
    }

    #[test]
    fn manifest_with_android_entry_is_parsed() {
        let j = manifest_with_android();
        let (url, sha) = android_entry(&j);
        assert_eq!(
            url.as_deref(),
            Some("https://gitcode.com/shuyo-cn/ShuyoNote/releases/download/v1.90.2/ShuyoNote_1.90.2_android-arm64-release.apk")
        );
        assert_eq!(sha.as_deref(), Some("ab".repeat(32).as_str()));
        // 顶层字段不受影响
        assert_eq!(j.get("version").and_then(|v| v.as_str()), Some("1.90.2"));
    }

    #[test]
    fn manifest_without_android_entry_still_parses() {
        // 老清单（v1.84.x 那类）根本没有 platforms，或只有桌面三键——都必须能读，
        // 且**不能报错**（否则 Android 一上线就会把桌面更新通道弄挂）。
        let legacy = json!({ "version": "1.84.5", "notes": "n", "pub_date": "p" });
        assert_eq!(android_entry(&legacy), (None, None));

        let mut deskonly = manifest_with_android();
        deskonly["platforms"]
            .as_object_mut()
            .unwrap()
            .remove(ANDROID_PLATFORM_KEY);
        assert_eq!(android_entry(&deskonly), (None, None));

        // 桌面三键仍然完整可读（证明"没有 android 不影响别人"）
        assert_eq!(
            deskonly["platforms"]["windows-x86_64"]["url"].as_str().map(|s| s.ends_with(".exe")),
            Some(true)
        );
    }

    #[test]
    fn android_entry_is_defensive() {
        // android 条目在、但字段不合约定：一律当作"没有"对应字段，绝不 panic 也不报错。
        let cases = [
            json!({ "platforms": { "android-aarch64": {} } }),
            json!({ "platforms": { "android-aarch64": { "url": "http://insecure.example/x.apk", "signature": "sha256:aa" } } }),
            json!({ "platforms": { "android-aarch64": { "url": "https://e/x.apk", "signature": "dW50cnVzdGVkIGNvbW1lbnQ6..." } } }),
            json!({ "platforms": { "android-aarch64": { "url": "https://e/x.apk", "signature": format!("sha256:{}", "zz".repeat(32)) } } }),
            json!({ "platforms": { "android-aarch64": { "url": "https://e/x.apk", "signature": "sha256:abc" } } }),
            json!({ "platforms": "not-an-object" }),
            json!({}),
        ];
        for (i, c) in cases.iter().enumerate() {
            assert_eq!(android_entry(c).1, None, "case {i} 的 sha256 都应被当作「没有」");
        }
        // url 只要求绝对 https：只有 sha256 不合约定时，地址仍然可用（按钮照旧能打开，
        // 只是没有指纹可比）——**不要**因为指纹缺失就连地址一起丢掉。
        let bad_sig = json!({ "platforms": { "android-aarch64": {
            "url": "https://e/x.apk", "signature": "sha256:abc" } } });
        assert_eq!(android_entry(&bad_sig).0.as_deref(), Some("https://e/x.apk"));
        assert_eq!(android_entry(&bad_sig).1, None);
        // 非 https（含明文 http）的地址一律丢掉
        let plain = json!({ "platforms": { "android-aarch64": {
            "url": "http://e/x.apk", "signature": format!("sha256:{}", "ab".repeat(32)) } } });
        assert_eq!(android_entry(&plain).0, None);
        // 大小写不敏感地接受大写 hex（发布脚本产出小写，这里只做兼容）
        let upper = json!({ "platforms": { "android-aarch64": {
            "url": "https://e/x.apk", "signature": format!("sha256:{}", "AB".repeat(32)) } } });
        assert!(android_entry(&upper).1.is_some());
    }
}
