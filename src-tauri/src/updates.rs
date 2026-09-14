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

/// 校验一个 `sha256:<hex>` / 裸 hex 指纹，返回规范化的小写 hex。
///
/// 抽成纯函数是为了能单测：**这段是整条更新链上唯一的完整性判据**（Android 不发 minisign），
/// 判错一次就等于把一个来路不明的 APK 交给系统安装器。
fn normalize_sha256(raw: &str) -> Option<String> {
    let hex = raw.trim().strip_prefix("sha256:").unwrap_or(raw.trim());
    if hex.len() == 64 && hex.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(hex.to_ascii_lowercase())
    } else {
        None
    }
}

/// 更新包落盘的文件名（按指纹前 8 位）：同一个版本重下会复用同一个文件名 ⇒
/// 用户"装失败再点一次"不必重下整包。
fn android_apk_file_name(sha256_hex: &str) -> String {
    format!("ShuyoNote-android-{}.apk", &sha256_hex[..8.min(sha256_hex.len())])
}

/// `sha2` 的 `finalize()` 给的是 `GenericArray`，**没有** `LowerHex` 实现
/// （CI 上就是这么红的：`the trait bound Array<u8, …>: LowerHex is not satisfied`），
/// 所以自己按字节转十六进制。
fn hex_of(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        // 写进 String 不会失败；真失败了也没别的办法，忽略即可。
        let _ = write!(out, "{b:02x}");
    }
    out
}

#[derive(Clone, Serialize)]
struct AndroidUpdateProgress {
    done: u64,
    total: u64,
    percent: f64,
}

/// **Android 应用内更新第一步**：把 APK 下到应用缓存里，并**边下边算 sha256**。
///
/// 为什么不让浏览器/DownloadManager 去下：那条路只能给用户一个文件，用户还得自己
/// 去文件管理器点"安装"；手机上应有的形态是"下完直接把系统安装器拉起来"
/// （第二步见 [`install_android_update`]，实现见 MOBILE.md §2.5）。
///
/// 三道自保：
/// 1. **只收 https**（清单里已经是 https，这里再挡一次，避免前端被改出 http 地址）；
/// 2. **指纹必须形状合法**，否则直接拒绝——宁可不更新，也不装一个没法校验的包；
/// 3. **校验不通过就删文件**，不把半成品或改过的包留在缓存里等人误装。
#[tauri::command]
pub async fn download_android_update(
    app: tauri::AppHandle,
    url: String,
    sha256: String,
) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use std::io::Write;
    use tauri::{Emitter, Manager}; // Manager 提供 `app.path()`

    if !url.starts_with("https://") {
        return Err("更新地址必须是 https".to_string());
    }
    let expect = normalize_sha256(&sha256).ok_or_else(|| "更新指纹格式不对（应为 64 位十六进制）".to_string())?;

    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("updates");
    std::fs::create_dir_all(&dir).map_err(|e| format!("建更新缓存目录失败：{e}"))?;
    let dest = dir.join(android_apk_file_name(&expect));

    // 已经有同一指纹的包（上次装到一半/装失败）⇒ 不重下。
    if let Ok(existing) = std::fs::read(&dest) {
        let mut h = Sha256::new();
        h.update(&existing);
        if hex_of(&h.finalize()) == expect {
            return Ok(dest.to_string_lossy().into_owned());
        }
    }

    let client = reqwest::Client::builder()
        // 不设总超时：几十 MB 的包在慢网上会超。只设"连接/首字节"超时。
        .connect_timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let mut resp = client.get(&url).send().await.map_err(|e| describe_net(&e, &url))?;
    if !resp.status().is_success() {
        return Err(format!("下载更新失败：HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);

    let tmp = dir.join(format!("{}.part", android_apk_file_name(&expect)));
    let mut out = std::fs::File::create(&tmp).map_err(|e| format!("建临时文件失败：{e}"))?;
    let mut hasher = Sha256::new();
    let mut done: u64 = 0;
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("下载中断：{e}"))? {
        out.write_all(&chunk).map_err(|e| format!("写入失败：{e}"))?;
        hasher.update(&chunk);
        done += chunk.len() as u64;
        let _ = app.emit(
            "android-update-progress",
            AndroidUpdateProgress {
                done,
                total,
                percent: if total > 0 { (done as f64 / total as f64) * 100.0 } else { 0.0 },
            },
        );
    }
    out.flush().map_err(|e| format!("写入失败：{e}"))?;
    drop(out);

    let got = hex_of(&hasher.finalize());
    if got != expect {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("更新包校验不通过（期望 {expect}，实际 {got}）——已丢弃，请重试或前往发布页手动下载"));
    }
    std::fs::rename(&tmp, &dest).map_err(|e| format!("落盘失败：{e}"))?;
    Ok(dest.to_string_lossy().into_owned())
}

/// **Android 应用内更新第二步**：把下好的 APK 交给**系统安装器**（不是我们静默安装）。
///
/// Android 8 起"从应用里装 APK"需要用户给本应用开「安装未知应用」权限，这个选择权
/// **必须留给用户**：所以这里只 `startActivity(ACTION_VIEW)`，后面的确认界面是系统的。
/// 路径经 `FileProvider` 换成 `content://`（`file://` 从 Android 7 起会抛
/// `FileUriExposedException`）；Kotlin 侧的实现在 `scripts/android-mobile-shell.mjs`
/// 注入的 `ShuyoFsPlugin.installApk`。
#[tauri::command]
pub fn install_android_update(app: tauri::AppHandle, path: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        crate::android_fs::install_apk(&app, &path)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, path);
        Err("应用内安装只在 Android 上可用".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 指纹规范化：这是整条 Android 更新链上**唯一**的完整性判据（Android 不发 minisign），
    /// 判松了就等于把来路不明的 APK 交给系统安装器。
    #[test]
    fn sha256_shape_is_enforced() {
        let ok = "a".repeat(64);
        assert_eq!(normalize_sha256(&ok).as_deref(), Some(ok.as_str()));
        assert_eq!(normalize_sha256(&format!("sha256:{ok}")).as_deref(), Some(ok.as_str()));
        // 大写要归一化（清单里出现过小写，但别假设）
        assert_eq!(normalize_sha256(&"A".repeat(64)).as_deref(), Some(ok.as_str()));
        // 形状不对一律拒绝：短、长、非十六进制、空
        assert_eq!(normalize_sha256("abc"), None);
        assert_eq!(normalize_sha256(&"a".repeat(63)), None);
        assert_eq!(normalize_sha256(&"a".repeat(65)), None);
        assert_eq!(normalize_sha256(&"z".repeat(64)), None);
        assert_eq!(normalize_sha256(""), None);
        assert_eq!(normalize_sha256("sha256:"), None);
    }

    /// 文件名按指纹前 8 位：同版本重下复用同名（"装失败再点一次"不必重下整包），
    /// 不同版本不会互相覆盖。
    #[test]
    fn apk_file_name_is_derived_from_the_hash() {
        let a = android_apk_file_name(&"1".repeat(64));
        assert_eq!(a, "ShuyoNote-android-11111111.apk");
        assert_ne!(a, android_apk_file_name(&"2".repeat(64)));
        // 极端输入不许 panic（内部只在前 8 位切片，短串也不会越界）
        assert!(android_apk_file_name("ab").ends_with(".apk"));
    }

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
                    "url": "https://gitcode.com/shuyo-cn/ShuyoNote/releases/download/v1.90.2/ShuyoNote_1.90.2_aarch64.dmg"
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
