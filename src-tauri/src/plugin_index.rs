//! 插件**分发**：索引协议与安装包（M11.11a）。
//!
//! 方案见 [`docs/plans/2026-09-10-plugin-distribution-strategy.md`] §3.1（索引规范）与 §8
//! （M11.11a 的范围）：`plugin-index.json` 静态索引 + 每条 `sha256` + 索引签名（minisign，
//! 复用 updater 的习惯）+ `install_plugin` 支持 zip/URL + **先校验后落盘**；**不做商店 UI**。
//!
//! ## 信任边界（阶段 1，别把它读成"有发布者签名"）
//!
//! * `sha256` 保证**完整性**：下载到的东西和索引里写的是同一份；
//! * 索引签名保证**不可篡改**：这份索引确实出自你信任的那个 key；
//! * 但「**该不该信这个索引**」是用户自己的决定（自托 = 自担）——所以这里的 API 把
//!   "信任哪个公钥"作为**调用方传进来的参数**，不内置任何"官方源"。
//!   publisher 级签名（"谁发布的"）是 M11.11b，本模块不假装有。
//!
//! ## 安全检查都在这一层（zip 解包是经典的越权写盘入口）
//!
//! * 解包路径必须**相对、无 `..`、无反斜杠、非绝对**（zip-slip）；
//! * 拒绝符号链接与目录项以外的特殊类型；
//! * 单文件与总解压体积都有上限（zip bomb）；
//! * `sha256` 与索引不符**直接拒绝**，连解包都不做；
//! * 插件必须**先通过校验器**（含用 Boa 跑一遍 discovery）才落盘——与本地目录安装同一套。

use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 索引规范版本。不认识就拒绝——宁可明确说"这份索引不是给这个版本用的"。
pub const INDEX_VERSION: u32 = 1;

/// 单个插件包的解压体积上限（含全部文件）。插件是"manifest + 一点 JS/资源"，
/// 64 MiB 已经远超正常需要；它挡的是 zip bomb 与"顺手塞个安装包进来"。
pub const MAX_PACKAGE_BYTES: u64 = 64 * 1024 * 1024;

/// 单个插件包里的文件数上限。
pub const MAX_PACKAGE_FILES: usize = 512;

/// 索引里一条插件记录。
///
/// 字段名照**公开规范**（camelCase）：这份 JSON 是给社区托管与手写的，不是内部结构。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct IndexEntry {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub api_version: String,
    #[serde(default)]
    pub min_app_version: String,
    #[serde(default)]
    pub runtime: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub publisher: String,
    /// 合规底线：至少要声明（AGPL 环境下的分发义务）。
    #[serde(default)]
    pub license: String,
    #[serde(default)]
    pub homepage: String,
    /// 「评价」的载体是社区帖子，不是应用内埋点。
    #[serde(default)]
    pub discussion_url: String,
    #[serde(default)]
    pub changelog_url: String,
    #[serde(default)]
    pub permissions: Vec<IndexPermission>,
    pub download_url: String,
    #[serde(default)]
    pub size: u64,
    pub sha256: String,
    /// 阶段 2 才必填（publisher 签名）；这里只解析，不假装校验。
    #[serde(default)]
    pub signature: String,
    #[serde(default)]
    pub revoked_at: Option<String>,
    #[serde(default)]
    pub revoked_reason: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct IndexPermission {
    pub id: String,
    #[serde(default)]
    pub reason: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct IndexOwner {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub url: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PluginIndex {
    pub index_version: u32,
    #[serde(default)]
    pub owner: Option<IndexOwner>,
    #[serde(default)]
    pub generated_at: String,
    #[serde(default)]
    pub plugins: Vec<IndexEntry>,
}

/// 索引里的一条记录**能不能装**（前端据此展示；后端安装时再查一遍，不信前端）。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct IndexEntryView {
    pub id: String,
    pub name: String,
    pub version: String,
    pub api_version: String,
    pub runtime: String,
    pub description: String,
    pub publisher: String,
    pub license: String,
    pub homepage: String,
    pub discussion_url: String,
    pub permissions: Vec<IndexPermission>,
    pub size: u64,
    pub revoked: bool,
    /// 带了发布者签名（`signature` 非空）。**阶段 1 不校验它**，界面必须如实说明。
    pub publisher_signed: bool,
    /// 装不了时的一句人话（空 = 可以装）。**说清为什么**，不静默隐藏。
    pub blocked: String,
}

/// 索引视图（给界面用）。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PluginIndexView {
    pub index_version: u32,
    pub owner: Option<IndexOwner>,
    pub generated_at: String,
    /// 这份索引有没有随附签名、以及签名**是否校验通过**。
    /// `None` = 没有签名（阶段 1 允许，但要如实告诉用户）。
    pub signature_verified: Option<bool>,
    pub plugins: Vec<IndexEntryView>,
}

/// 索引里的 id 规则：比本地安装**更紧**。
///
/// 本地安装还得兼容历史插件（允许 `_` / `.`），而索引里的条目都是**新发布**的，所以按公开
/// 规范收紧：`^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$`。松的那套留给 legacy 本地目录。
fn is_index_safe_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    if bytes.len() < 2 || bytes.len() > 40 {
        return false;
    }
    let ok = |c: u8| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-';
    ok(bytes[0]) && bytes[0] != b'-' && bytes[bytes.len() - 1] != b'-' && bytes.iter().all(|&c| ok(c))
}

/// 粗粒度 semver：`x.y.z`（允许 `-pre` / `+build` 尾巴）。索引里的版本要能与 manifest 对上，
/// 这里不做完整 semver 实现，只保证"形状对、能比较"。
fn parse_version(v: &str) -> Option<(u32, u32, u32)> {
    // 要求**三段齐全**（`1.2.0`）：少写一段在索引里只会造成"展示成 1.2、实际装出 1.2.0"
    // 这种说不清的差异，不如直接拒。
    let core = v.split(['-', '+']).next()?;
    let parts: Vec<&str> = core.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let major = parts[0].parse().ok()?;
    let minor = parts[1].parse().ok()?;
    let patch = parts[2].parse().ok()?;
    Some((major, minor, patch))
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// 解析索引（**纯函数**，不碰网络也不碰盘）。任何不合规都返回一句能给人看的话。
pub fn parse_index(bytes: &[u8]) -> Result<PluginIndex, String> {
    let index: PluginIndex =
        serde_json::from_slice(bytes).map_err(|e| format!("索引不是合法 JSON：{e}"))?;
    if index.index_version != INDEX_VERSION {
        return Err(format!(
            "索引规范版本不认识：{}（本版本认 {INDEX_VERSION}）",
            index.index_version
        ));
    }
    if index.plugins.is_empty() {
        return Err("索引里一个插件都没有".to_string());
    }
    let mut seen: Vec<&str> = Vec::new();
    for p in &index.plugins {
        if !is_index_safe_id(&p.id) {
            return Err(format!(
                "插件 id「{}」不合规：只允许小写字母/数字/短横线，长度 2–40，且不以短横线开头或结尾",
                p.id
            ));
        }
        if seen.contains(&p.id.as_str()) {
            return Err(format!("索引里插件 id 重复：{}", p.id));
        }
        seen.push(&p.id);
        if parse_version(&p.version).is_none() {
            return Err(format!("插件 {} 的 version「{}」不是 semver", p.id, p.version));
        }
        if parse_version(&p.api_version).is_none() {
            return Err(format!(
                "插件 {} 的 apiVersion「{}」不是 semver（应当形如 \"1.0.0\"）",
                p.id, p.api_version
            ));
        }
        let major = parse_version(&p.api_version).map(|v| v.0).unwrap_or(0);
        if major != crate::capabilities_gen::API_MAJOR {
            return Err(format!(
                "插件 {} 的 apiVersion 是 {}.x，本版本只支持 {}.x（未知 major 直接拒载）",
                p.id,
                major,
                crate::capabilities_gen::API_MAJOR
            ));
        }
        if parse_version(&p.min_app_version).is_none() {
            return Err(format!(
                "插件 {} 的 minAppVersion「{}」不是 semver",
                p.id, p.min_app_version
            ));
        }
        if p.license.trim().is_empty() {
            return Err(format!("插件 {} 没写 license（合规底线，至少要声明）", p.id));
        }
        // `ui` 型插件本版本还跑不了（M11.10 未做）：**明确拒绝**而不是装上去什么都不发生。
        match p.runtime.as_str() {
            "logic" | "declarative" => {}
            "ui" => {
                return Err(format!(
                    "插件 {} 是 ui 型，本版本还不支持（沙盒 UI 插件尚未实现）",
                    p.id
                ))
            }
            other => return Err(format!("插件 {} 的 runtime「{other}」不认识", p.id)),
        }
        if !is_hex64(&p.sha256) {
            return Err(format!("插件 {} 的 sha256 不是 64 位十六进制", p.id));
        }
        if p.size == 0 {
            return Err(format!("插件 {} 没写 size（安装前要按它做体积预检）", p.id));
        }
        if p.size > MAX_PACKAGE_BYTES {
            return Err(format!(
                "插件 {} 声明的大小 {} 字节超过上限 {} MiB",
                p.id,
                p.size,
                MAX_PACKAGE_BYTES / (1024 * 1024)
            ));
        }
        if !(p.download_url.starts_with("https://") || p.download_url.starts_with("http://")) {
            return Err(format!(
                "插件 {} 的 downloadUrl 必须是 http(s)（现在是「{}」）",
                p.id, p.download_url
            ));
        }
        for perm in &p.permissions {
            if perm.reason.trim().is_empty() {
                return Err(format!(
                    "插件 {} 的权限「{}」没写 reason——安装界面必须显示「权限 + 理由」",
                    p.id, perm.id
                ));
            }
        }
    }
    Ok(index)
}

/// 一条索引记录"为什么不能装"（空 = 能装）。
///
/// **界面上显示的和安装时判定的必须是同一个函数**：展示用一套、安装用另一套，
/// 就会出现「界面说能装、点了报错」或更糟的「界面说不能装、其实装进去了」。
pub fn entry_block_reason(entry: &IndexEntry, app_version: &str) -> String {
    if entry.revoked_at.is_some() {
        return if entry.revoked_reason.trim().is_empty() {
            "已被索引撤回".to_string()
        } else {
            format!("已被索引撤回：{}", entry.revoked_reason)
        };
    }
    if let (Some(app), Some(min)) = (parse_version(app_version), parse_version(&entry.min_app_version)) {
        if min > app {
            return format!("需要应用 {}+（当前 {app_version}）", entry.min_app_version);
        }
    }
    String::new()
}

/// 把索引转成界面用的视图：逐条算出"能不能装"，并**说清为什么不能**。
pub fn index_view(index: &PluginIndex, app_version: &str, signature_verified: Option<bool>) -> PluginIndexView {
    let plugins = index
        .plugins
        .iter()
        .map(|p| IndexEntryView {
            id: p.id.clone(),
            name: p.name.clone(),
            version: p.version.clone(),
            api_version: p.api_version.clone(),
            runtime: p.runtime.clone(),
            description: p.description.clone(),
            publisher: p.publisher.clone(),
            license: p.license.clone(),
            homepage: p.homepage.clone(),
            discussion_url: p.discussion_url.clone(),
            permissions: p.permissions.clone(),
            size: p.size,
            revoked: p.revoked_at.is_some(),
            blocked: entry_block_reason(p, app_version),
            // 阶段 1 只校验索引签名，**不校验发布者签名**（那是阶段 2）。带了签名就如实说
            // "带了、但这一版没验"，别让界面看起来像"验过了"。
            publisher_signed: !p.signature.trim().is_empty(),
        })
        .collect();
    PluginIndexView {
        index_version: index.index_version,
        owner: index.owner.clone(),
        generated_at: index.generated_at.clone(),
        signature_verified,
        plugins,
    }
}

// ---------------------------------------------------------------------------
// 插件包（zip）
// ---------------------------------------------------------------------------

/// 插件包解压用的临时目录（**尚不存在**，交给 `extract_package` 创建；调用方负责删）。
///
/// 解压**永远**先落在临时目录：装失败时不能留下半个插件目录占住那个 id。
pub fn package_temp_dir() -> PathBuf {
    std::env::temp_dir().join(format!("shuyonote-plugin-{}", uuid::Uuid::new_v4()))
}

/// 插件包解压后的**真正根目录**。
///
/// 常见做法是 `zip -r pkg.zip my-plugin/`，于是包里多一层目录；直接按解压结果找
/// `manifest.json` 会报"读不到 manifest.json"，而用户看不出自己哪里错了。
/// 规则收紧到只有一种情况才下钻：**解压结果里恰好只有一个目录、且它里面有 manifest.json**。
/// 其它情况一律按原样处理（让 `install_from_dir` 去报它那句清楚的错）。
pub fn resolve_package_root(dest: &Path) -> PathBuf {
    if dest.join("manifest.json").is_file() {
        return dest.to_path_buf();
    }
    let mut entries = match std::fs::read_dir(dest) {
        Ok(it) => it.filter_map(|e| e.ok()),
        Err(_) => return dest.to_path_buf(),
    };
    let first = match entries.next() {
        Some(e) => e,
        None => return dest.to_path_buf(),
    };
    if entries.next().is_some() {
        return dest.to_path_buf(); // 不止一项：不做猜测
    }
    let path = first.path();
    if path.is_dir() && path.join("manifest.json").is_file() {
        return path;
    }
    dest.to_path_buf()
}

/// 解压一个插件包到 `dest`（**必须是一个尚不存在的空目标**，调用方负责）。
///
/// 返回写出来的文件数。这里的每一条拒绝都对应一个真实的攻击面：
/// zip-slip（`../../` 写出去）、绝对路径、符号链接逃逸、zip bomb（体积/文件数）。
pub fn extract_package(zip_bytes: &[u8], dest: &Path) -> Result<usize, String> {
    let reader = std::io::Cursor::new(zip_bytes);
    let mut archive = zip::ZipArchive::new(reader).map_err(|e| format!("不是合法的 zip：{e}"))?;
    if archive.len() > MAX_PACKAGE_FILES {
        return Err(format!(
            "包里的文件太多（{} 个，上限 {MAX_PACKAGE_FILES}）",
            archive.len()
        ));
    }

    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let mut total: u64 = 0;
    let mut written = 0usize;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        // 只认普通文件与目录：符号链接（以及任何 unix 特殊类型）直接拒绝——
        // 解包出一个指向别处的链接再往里写，是绕开下面路径检查的经典手法。
        let mode = entry.unix_mode();
        if mode.is_some_and(|m| m & 0o170000 != 0o100000 && m & 0o170000 != 0o040000) {
            return Err(format!("包里第 {} 项不是普通文件或目录（拒绝符号链接等）", i + 1));
        }
        let name = entry.name().to_string();
        let rel = safe_relative_path(&name)?;
        let out = dest.join(&rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        total = total.saturating_add(entry.size());
        if total > MAX_PACKAGE_BYTES {
            return Err(format!(
                "解压后体积超过上限 {} MiB（拒绝 zip bomb）",
                MAX_PACKAGE_BYTES / (1024 * 1024)
            ));
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut buf = Vec::with_capacity(entry.size().min(1024 * 1024) as usize);
        entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        std::fs::write(&out, &buf).map_err(|e| e.to_string())?;
        written += 1;
    }
    Ok(written)
}

/// 包内路径 → 安全的相对路径。**这是 zip-slip 的唯一闸门**，所以写得啰嗦一点。
fn safe_relative_path(name: &str) -> Result<PathBuf, String> {
    if name.is_empty() {
        return Err("包里有一项没有名字".to_string());
    }
    // Windows 上 `a\..\..\b` 也是分隔符，所以反斜杠一律不认。
    if name.contains('\\') {
        return Err(format!("包内路径「{name}」含反斜杠（不做平台差异猜测）"));
    }
    let p = Path::new(name);
    if p.is_absolute() || name.starts_with('/') || name.starts_with("//") {
        return Err(format!("包内路径「{name}」是绝对路径"));
    }
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            std::path::Component::Normal(seg) => {
                // Windows 盘符/保留名：`C:` 会被当成 Normal，这里挡掉盘符样式的段。
                let s = seg.to_string_lossy();
                if s.len() == 2 && s.ends_with(':') {
                    return Err(format!("包内路径「{name}」含盘符"));
                }
                out.push(seg);
            }
            std::path::Component::CurDir => {}
            _ => return Err(format!("包内路径「{name}」试图跳出插件目录")),
        }
    }
    if out.as_os_str().is_empty() {
        return Err(format!("包内路径「{name}」解析后为空（拒绝目录外的写入）"));
    }
    Ok(out)
}

/// 校验 sha256（十六进制小写/大写都收，比较前统一小写）。
pub fn verify_sha256(bytes: &[u8], expected_hex: &str) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let got = hex::encode(hasher.finalize());
    if got.eq_ignore_ascii_case(expected_hex) {
        Ok(())
    } else {
        Err(format!(
            "sha256 不符（索引里写的是 {}，实际下载到的是 {}）——拒绝安装",
            expected_hex, got
        ))
    }
}

// ---------------------------------------------------------------------------
// 索引 / 插件包的来源（URL）
// ---------------------------------------------------------------------------

/// 索引 JSON 的体积上限：索引是**清单**，不是数据。64 MiB 的"索引"只会是攻击。
pub const MAX_INDEX_BYTES: u64 = 4 * 1024 * 1024;
/// 签名文件（`.minisig`）的体积上限。
pub const MAX_SIGNATURE_BYTES: u64 = 64 * 1024;
/// URL 长度上限（超长 URL 没有正当用途，只会是解析器的负担）。
const MAX_URL_LEN: usize = 2048;

/// 校验一个索引 / 插件包 URL，返回规范化后的地址。
///
/// 规则：**必须 https**。明文 http 拉下来的东西，"完整性"只剩一个哈希在裸奔——
/// 中间人能同时改包和索引里的哈希。唯一的例外是回环地址（`127.0.0.1` / `localhost` /
/// `[::1]`），那是自托调试用的，出不了本机。
pub fn check_source_url(raw: &str) -> Result<String, String> {
    let url = raw.trim();
    if url.is_empty() {
        return Err("地址不能为空".to_string());
    }
    if url.len() > MAX_URL_LEN {
        return Err(format!("地址过长（超过 {MAX_URL_LEN} 字符）"));
    }
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("地址里不能有空白或控制字符".to_string());
    }
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("https://") {
        return Ok(url.to_string());
    }
    if lower.starts_with("http://") {
        let rest = &lower["http://".len()..];
        let host = rest.split(['/', '?', '#']).next().unwrap_or("");
        // 端口要剥掉再比：`localhost:8080` 是本地，`localhost.evil.com` 不是。
        let host_no_port = if host.starts_with('[') {
            host.split(']').next().map(|h| format!("{h}]")).unwrap_or_default()
        } else {
            host.split(':').next().unwrap_or("").to_string()
        };
        if host_no_port == "127.0.0.1" || host_no_port == "localhost" || host_no_port == "[::1]" {
            return Ok(url.to_string());
        }
        return Err("索引 / 插件包地址必须是 https（明文 http 只允许本机回环地址，用于自托调试）".to_string());
    }
    Err("地址必须以 https:// 开头".to_string())
}

/// 索引签名（分离式签名）的地址：索引地址 + `.minisig`，和 updater 的习惯一致
/// （`latest.json` / `latest.json.sig`）。
pub fn signature_url(index_url: &str) -> String {
    format!("{index_url}.minisig")
}

/// 从 URL 里取主机名，用于在界面上**显示来源域名**（"你订阅了谁"）。
pub fn url_host(url: &str) -> String {
    let after = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let host = after.split(['/', '?', '#']).next().unwrap_or("");
    host.to_string()
}

/// 解析用户给的那把 minisign 公钥。两种写法都收：
/// - `minisign.pub` 文件内容（`untrusted comment: …` + 一行 base64）
/// - 裸 base64（和 Tauri 更新器配置里的 pubkey 一个形状）
pub fn parse_index_pubkey(text: &str) -> Result<minisign_verify::PublicKey, String> {
    let t = text.trim();
    if t.is_empty() {
        return Err("公钥不合法：没有填".to_string());
    }
    let r = if t.lines().count() > 1 {
        minisign_verify::PublicKey::decode(t)
    } else {
        minisign_verify::PublicKey::from_base64(t)
    };
    r.map_err(|e| format!("公钥不合法：{e}"))
}

/// 校验索引签名（minisign，与 updater 同一套习惯）。
///
/// `pubkey_b64` 是用户信任的那个 key。
/// **没有内置默认公钥**：信谁是用户的选择（自托 = 自担），这一层只负责"这份签名对不对"。
pub fn verify_index_signature(index_bytes: &[u8], signature: &str, pubkey_b64: &str) -> Result<(), String> {
    let pk = parse_index_pubkey(pubkey_b64)?;
    let sig = minisign_verify::Signature::decode(signature)
        .map_err(|e| format!("签名不合法：{e}"))?;
    pk.verify(index_bytes, &sig, false)
        .map_err(|_| "索引签名校验失败（这份索引不是那个 key 签的，或内容被改过）".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn good_entry(id: &str) -> IndexEntry {
        IndexEntry {
            id: id.to_string(),
            name: "周报生成".to_string(),
            version: "1.2.0".to_string(),
            api_version: crate::capabilities_gen::API_VERSION.to_string(),
            min_app_version: "1.80.0".to_string(),
            runtime: "logic".to_string(),
            description: "汇总本周改动".to_string(),
            publisher: "alice".to_string(),
            license: "MIT".to_string(),
            homepage: String::new(),
            discussion_url: String::new(),
            changelog_url: String::new(),
            permissions: vec![IndexPermission {
                id: "read:pages".to_string(),
                reason: "读本周有改动的页面标题".to_string(),
            }],
            download_url: "https://example.com/p.zip".to_string(),
            size: 2048,
            sha256: "a".repeat(64),
            signature: String::new(),
            revoked_at: None,
            revoked_reason: String::new(),
        }
    }

    fn index_json(entries: Vec<IndexEntry>) -> Vec<u8> {
        let idx = PluginIndex {
            index_version: INDEX_VERSION,
            owner: Some(IndexOwner {
                id: "shuyo-community".to_string(),
                name: "数友社区".to_string(),
                url: "https://example.com".to_string(),
            }),
            generated_at: "2026-09-10T12:00:00Z".to_string(),
            plugins: entries,
        };
        serde_json::to_vec(&idx).unwrap()
    }

    #[test]
    fn a_well_formed_index_parses() {
        let idx = parse_index(&index_json(vec![good_entry("weekly-report")])).unwrap();
        assert_eq!(idx.plugins.len(), 1);
        assert_eq!(idx.plugins[0].id, "weekly-report");
        let view = index_view(&idx, "1.87.0", Some(true));
        assert_eq!(view.plugins[0].blocked, "", "正常条目不该被标成不可安装");
        assert_eq!(view.signature_verified, Some(true));
    }

    #[test]
    fn index_rejects_the_things_that_must_never_install() {
        // id 不合规（大写、下划线、以短横线开头/结尾、太长）
        for bad in ["Weekly", "a_b", "-lead", "trail-", "x", &"a".repeat(41)] {
            let e = parse_index(&index_json(vec![good_entry(bad)])).unwrap_err();
            assert!(e.contains("不合规"), "{bad} 应当被拒：{e}");
        }
        // 版本形状
        let mut e = good_entry("ok-id");
        e.version = "1".into();
        assert!(parse_index(&index_json(vec![e])).unwrap_err().contains("semver"));
        let mut e = good_entry("ok-id");
        e.api_version = "2.0.0".into();
        let err = parse_index(&index_json(vec![e])).unwrap_err();
        assert!(err.contains("只支持"), "未知 major 要直接拒载：{err}");
        // 合规与体积
        let mut e = good_entry("ok-id");
        e.license = "  ".into();
        assert!(parse_index(&index_json(vec![e])).unwrap_err().contains("license"));
        let mut e = good_entry("ok-id");
        e.size = MAX_PACKAGE_BYTES + 1;
        assert!(parse_index(&index_json(vec![e])).unwrap_err().contains("超过上限"));
        let mut e = good_entry("ok-id");
        e.sha256 = "not-hex".into();
        assert!(parse_index(&index_json(vec![e])).unwrap_err().contains("sha256"));
        // 权限必须带理由（安装界面要显示"权限 + 理由"）
        let mut e = good_entry("ok-id");
        e.permissions[0].reason = "".into();
        assert!(parse_index(&index_json(vec![e])).unwrap_err().contains("reason"));
        // ui 型本版本跑不了 → 明确拒绝，而不是装上去什么都不发生
        let mut e = good_entry("ok-id");
        e.runtime = "ui".into();
        assert!(parse_index(&index_json(vec![e])).unwrap_err().contains("ui"));
        // 重复 id
        let err = parse_index(&index_json(vec![good_entry("dup-id"), good_entry("dup-id")])).unwrap_err();
        assert!(err.contains("重复"), "{err}");
        // 规范版本
        let mut idx = serde_json::from_slice::<PluginIndex>(&index_json(vec![good_entry("ok-id")])).unwrap();
        idx.index_version = 99;
        let bytes = serde_json::to_vec(&idx).unwrap();
        assert!(parse_index(&bytes).unwrap_err().contains("规范版本"));
    }

    #[test]
    fn revoked_and_incompatible_entries_are_shown_but_not_installable() {
        let mut revoked = good_entry("revoked-one");
        revoked.revoked_at = Some("2026-09-01T00:00:00Z".into());
        revoked.revoked_reason = "有严重漏洞".into();
        let mut too_new = good_entry("needs-newer-app");
        too_new.min_app_version = "2.0.0".into();
        let idx = parse_index(&index_json(vec![revoked, too_new])).unwrap();
        let view = index_view(&idx, "1.87.0", None);
        assert!(view.plugins[0].revoked && view.plugins[0].blocked.contains("撤回"));
        assert!(view.plugins[1].blocked.contains("需要应用 2.0.0+"));
        assert_eq!(view.signature_verified, None, "没有签名时要说「没有」，而不是假装验过");
    }

    // ---- zip 解包的安全检查 ----

    fn zip_with(entries: &[(&str, &[u8])]) -> Vec<u8> {
        use std::io::Write;
        let mut buf = Vec::new();
        {
            let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts: zip::write::FileOptions<'_, ()> =
                zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
            for (name, data) in entries {
                w.start_file(*name, opts).unwrap();
                w.write_all(data).unwrap();
            }
            w.finish().unwrap();
        }
        buf
    }

    #[test]
    fn a_normal_package_extracts() {
        let dir = crate::plugins::tests_support::temp_dir("pkg-ok");
        let zip = zip_with(&[("manifest.json", b"{}"), ("main.js", b"register({});")]);
        let n = extract_package(&zip, &dir).unwrap();
        assert_eq!(n, 2);
        assert!(dir.join("manifest.json").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn zip_slip_and_absolute_paths_are_refused() {
        let dir = crate::plugins::tests_support::temp_dir("pkg-slip");
        for bad in [
            "../evil.js",
            "../../evil.js",
            "a/../../evil.js",
            "/etc/evil.js",
            "a\\..\\evil.js",
        ] {
            let zip = zip_with(&[(bad, b"x")]);
            let err = extract_package(&zip, &dir).unwrap_err();
            assert!(
                err.contains("跳出插件目录") || err.contains("绝对路径") || err.contains("反斜杠"),
                "{bad} 应当被拒：{err}"
            );
        }
        // 目录外的目标文件绝不能被写出来
        let outside = dir.parent().unwrap().join("evil.js");
        assert!(!outside.exists(), "越权写盘发生了：{}", outside.display());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sha256_mismatch_is_refused_before_extracting() {
        let bytes = b"hello package";
        let mut good = {
            use sha2::{Digest, Sha256};
            let mut h = Sha256::new();
            h.update(bytes);
            hex::encode(h.finalize())
        };
        assert!(verify_sha256(bytes, &good).is_ok(), "正确的摘要要过");
        good.replace_range(0..1, if good.starts_with('a') { "b" } else { "a" });
        let err = verify_sha256(bytes, &good).unwrap_err();
        assert!(err.contains("sha256 不符") && err.contains("拒绝安装"), "{err}");
    }

    #[test]
    fn a_single_wrapping_directory_is_unwrapped() {
        // `zip -r pkg.zip my-plugin/` 的常见产物：包里多一层目录
        let dir = crate::plugins::tests_support::temp_dir("pkg-wrap");
        let zip = zip_with(&[
            ("my-plugin/manifest.json", b"{}"),
            ("my-plugin/main.js", b"register({});"),
        ]);
        extract_package(&zip, &dir).unwrap();
        let root = resolve_package_root(&dir);
        assert_eq!(root, dir.join("my-plugin"), "恰好一层包装目录时应当下钻");

        // 顶层就有 manifest.json：不下钻
        let flat = crate::plugins::tests_support::temp_dir("pkg-flat");
        extract_package(&zip_with(&[("manifest.json", b"{}")]), &flat).unwrap();
        assert_eq!(resolve_package_root(&flat), flat);

        // 有多个顶层项：不猜（交给安装流程报"读不到 manifest.json"）
        let many = crate::plugins::tests_support::temp_dir("pkg-many");
        extract_package(
            &zip_with(&[("a/manifest.json", b"{}"), ("README.md", b"x")]),
            &many,
        )
        .unwrap();
        assert_eq!(resolve_package_root(&many), many);

        // 唯一目录里也没有 manifest.json：同样不猜
        let node = crate::plugins::tests_support::temp_dir("pkg-node");
        extract_package(&zip_with(&[("stuff/x.js", b"x")]), &node).unwrap();
        assert_eq!(resolve_package_root(&node), node);
        for d in [dir, flat, many, node] {
            let _ = std::fs::remove_dir_all(&d);
        }
    }

    // ---- 索引签名 ----
    //
    // 用的是 minisign 官方测试向量（minisign-verify 0.2.5 自带用例里的那对公钥/签名，
    // 签的内容是 4 个字节 "test"，预哈希格式 RUQ…= 也就是 Tauri 更新器用的那种）。
    // 本机没有 minisign 可执行文件，`tauri signer` 在这个环境里也起不来，造不出一对
    // 一次性密钥；所以拿官方向量来证明这一层真在验签，而不是"看起来在验"。
    const MINISIGN_TEST_PUBKEY: &str = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";

    fn minisign_test_signature() -> String {
        [
            "untrusted comment: signature from minisign secret key",
            "RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=",
            "trusted comment: timestamp:1556193335\tfile:test",
            "y/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==",
        ]
        .join("\n")
    }

    #[test]
    fn a_genuine_signature_verifies_and_tampering_is_refused() {
        verify_index_signature(b"test", &minisign_test_signature(), MINISIGN_TEST_PUBKEY)
            .expect("真签名应当通过");

        // 内容改一个字节 → 必须拒
        let err =
            verify_index_signature(b"Test", &minisign_test_signature(), MINISIGN_TEST_PUBKEY)
                .unwrap_err();
        assert!(err.contains("签名校验失败"), "{err}");

        // 换成另一个 key（只改公钥最后一个字节）→ 必须拒，不能"格式对就放行"
        let err = verify_index_signature(
            b"test",
            &minisign_test_signature(),
            "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO2",
        )
        .unwrap_err();
        assert!(err.contains("签名校验失败"), "{err}");

        // key id 对不上（签名不是这个 key 签的）→ 同样拒
        let err = verify_index_signature(
            b"test",
            &minisign_test_signature(),
            "RWQe6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3",
        )
        .unwrap_err();
        assert!(err.contains("签名校验失败"), "{err}");

        // 伪造：签名本身被改过
        let mut forged = minisign_test_signature();
        forged = forged.replace("RUQf", "RUQe");
        assert!(verify_index_signature(b"test", &forged, MINISIGN_TEST_PUBKEY).is_err());

        // 公钥写成 minisign.pub 文件的形式（带注释行）也要能认
        let file_form = format!(
            "untrusted comment: minisign public key E7620F1842B4E81F\n{MINISIGN_TEST_PUBKEY}"
        );
        verify_index_signature(b"test", &minisign_test_signature(), &file_form)
            .expect("minisign.pub 形式应当同样通过");
        // 前后空白不该影响判定（用户从文档里复制粘贴很常见）
        verify_index_signature(b"test", &minisign_test_signature(), &format!("  {MINISIGN_TEST_PUBKEY}\n"))
            .expect("带空白的裸 base64 应当同样通过");
    }

    #[test]
    fn malformed_signature_material_reports_which_side_is_broken() {
        let err = verify_index_signature(b"{}", &minisign_test_signature(), "not-a-key").unwrap_err();
        assert!(err.contains("公钥不合法"), "{err}");
        let err = verify_index_signature(b"{}", "garbage", MINISIGN_TEST_PUBKEY).unwrap_err();
        assert!(err.contains("签名不合法"), "{err}");
        let err = verify_index_signature(b"{}", &minisign_test_signature(), "  ").unwrap_err();
        assert!(err.contains("公钥不合法"), "{err}");
    }

    // ---- 来源地址 ----

    #[test]
    fn only_https_and_loopback_sources_are_accepted() {
        assert_eq!(
            check_source_url("https://example.com/plugins/index.json").unwrap(),
            "https://example.com/plugins/index.json"
        );
        // 回环允许（自托 / 本地调试）
        assert!(check_source_url("http://127.0.0.1:8099/index.json").is_ok());
        assert!(check_source_url("http://localhost:8099/index.json").is_ok());
        assert!(check_source_url("http://[::1]:8099/index.json").is_ok());
        // 明文 http 一律拒（除了回环）
        for bad in [
            "http://example.com/index.json",
            "http://localhost.evil.com/index.json", // 前缀像本地，其实是外网域名
            "http://127.0.0.1.evil.com/index.json",
            "ftp://example.com/index.json",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "/tmp/index.json", // 本地文件走"装 zip"那条路，不走 URL
            "",
            "   ",
        ] {
            assert!(check_source_url(bad).is_err(), "{bad} 不该被接受");
        }
        assert!(check_source_url(&format!("https://e.com/{}", "a".repeat(3000))).is_err());
        assert!(check_source_url("https://e.com/a b.json").is_err());
    }

    #[test]
    fn signature_and_host_helpers_are_consistent() {
        assert_eq!(
            signature_url("https://example.com/p/index.json"),
            "https://example.com/p/index.json.minisig"
        );
        assert_eq!(url_host("https://example.com/p/index.json"), "example.com");
        assert_eq!(url_host("http://127.0.0.1:8099/x"), "127.0.0.1:8099");
        assert_eq!(url_host("garbage"), "garbage");
    }

    #[test]
    fn the_installer_uses_the_same_block_reason_the_ui_shows() {
        let mut revoked = good_entry("revoked-one");
        revoked.revoked_at = Some("2026-09-01T00:00:00Z".into());
        revoked.revoked_reason = "有严重漏洞".into();
        let mut too_new = good_entry("needs-newer");
        too_new.min_app_version = "2.0.0".into();
        let ok = good_entry("fine");
        let idx = parse_index(&index_json(vec![revoked.clone(), too_new.clone(), ok.clone()])).unwrap();
        let view = index_view(&idx, "1.87.0", None);
        for (entry, shown) in [(&revoked, &view.plugins[0]), (&too_new, &view.plugins[1]), (&ok, &view.plugins[2])] {
            assert_eq!(entry_block_reason(entry, "1.87.0"), shown.blocked, "界面与安装判定必须同源");
        }
        assert!(!view.plugins[2].publisher_signed, "没写签名就不该显示成「已签名」");
        let mut signed = ok.clone();
        signed.signature = "untrusted comment: x\nAAAA".into();
        let idx = parse_index(&index_json(vec![signed])).unwrap();
        assert!(index_view(&idx, "1.87.0", None).plugins[0].publisher_signed);
    }
}
