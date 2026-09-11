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
    /// 发布者对这个包（zip 的字节）的 minisign 分离签名。阶段 2 起可用；
    /// 它与 `publisher_key` 必须**同时**给或同时不给，否则索引自己就是矛盾的。
    #[serde(default)]
    pub signature: String,
    /// 发布者的 minisign 公钥（裸 base64 或 `minisign.pub` 文件内容）。
    ///
    /// 信任模型要说清楚：这把 key **来自索引**，所以它证明不了"发布者是谁"——
    /// 它证明的是"这个包与这份索引里声明的那把 key 一致"。真正的价值在**第一次之后**：
    /// 应用会把每个插件的发布者 key 固定下来（TOFU），此后**换了 key 就拒绝安装**并
    /// 告诉用户新旧指纹。索引被换掉/被改，也换不掉你已经固定过的那把 key。
    #[serde(default)]
    pub publisher_key: String,
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

/// 索引级撤回：**发布者密钥**被撤回（泄露、滥用、作者放弃）。
///
/// 与"撤回某个版本"不同：撤回一把 key 等于说"这把 key 签的东西都不作数了"。
/// 它是发布者签名的另一半价值——没有它，签名只能证明"是谁签的"，不能在被滥用时止损。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RevokedKey {
    /// 被撤回的发布者公钥（裸 base64 或 `minisign.pub` 内容）。
    pub key: String,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub revoked_at: Option<String>,
}

/// 撤回的发布者密钥（给界面用：指纹 + 原因）。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RevokedKeyView {
    pub fingerprint: String,
    pub reason: String,
    pub revoked_at: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PluginIndex {
    pub index_version: u32,
    #[serde(default)]
    pub owner: Option<IndexOwner>,
    #[serde(default)]
    pub generated_at: String,
    /// 索引撤回了哪些发布者密钥（可选）。
    #[serde(default)]
    pub revoked_keys: Vec<RevokedKey>,
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
    /// 带了发布者签名（`signature` 非空）。
    pub publisher_signed: bool,
    /// 这把发布者公钥的指纹（**由后端算**，空 = 没带签名）。
    ///
    /// 为什么不让界面自己算：指纹只该有一处算法。前端另算一份，迟早会与后端不一致，
    /// 而"两个不一样的指纹"恰好会让用户在最需要判断的时候判断错。
    pub publisher_key_fingerprint: String,
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
    /// 这份索引撤回的发布者密钥（指纹 + 原因）。界面要显示它们——被撤回的是"谁"，
    /// 而这正是用户需要知道的事。
    pub revoked_keys: Vec<RevokedKeyView>,
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
///
/// 同一个函数也用来判断"这一次安装算升级还是降级"（见 `plugins::install_action`）——
/// 两处必须是同一口径，否则会出现"界面按一种比较说能装、后端按另一种拒了"。
pub fn parse_version(v: &str) -> Option<(u32, u32, u32)> {
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
    // 撤回的发布者密钥：形状不对的 key 会让"撤回"静默失效（永远匹配不上）。
    let mut revoked_fps: Vec<String> = Vec::new();
    for rk in &index.revoked_keys {
        let fp = publisher_key_fingerprint(&rk.key)
            .map_err(|e| format!("revokedKeys 里有一把公钥不合法：{e}"))?;
        if revoked_fps.contains(&fp) {
            return Err(format!("revokedKeys 里有重复的公钥（指纹 {fp}）"));
        }
        revoked_fps.push(fp);
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
        // 发布者签名与公钥必须成对：只给签名（没 key 可验）或只给 key（没签名可验）
        // 都是索引自己的矛盾，早拒比装到一半才发现好。
        let has_sig = !p.signature.trim().is_empty();
        let has_key = !p.publisher_key.trim().is_empty();
        if has_sig != has_key {
            return Err(format!(
                "插件 {} 的 signature 与 publisherKey 必须一起给（现在 {}）",
                p.id,
                if has_sig { "只有签名" } else { "只有公钥" }
            ));
        }
        if has_key {
            // 形状不对的 key 会让**每一次安装**都失败在验签那一步，而原因看起来像"签名不对"。
            parse_index_pubkey(&p.publisher_key)
                .map_err(|e| format!("插件 {} 的 publisherKey 不合法：{e}", p.id))?;
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
pub fn entry_block_reason(entry: &IndexEntry, app_version: &str, revoked_keys: &[RevokedKey]) -> String {
    if entry.revoked_at.is_some() {
        return if entry.revoked_reason.trim().is_empty() {
            "已被索引撤回".to_string()
        } else {
            format!("已被索引撤回：{}", entry.revoked_reason)
        };
    }
    // 发布者密钥被撤回 → 这一条整个不可信（它签的包都不作数了）。
    if let Some(rk) = key_revoked(revoked_keys, &entry.publisher_key) {
        let why = if rk.reason.trim().is_empty() {
            "索引没写原因".to_string()
        } else {
            rk.reason.clone()
        };
        return format!("发布者密钥已被索引撤回：{why}");
    }
    if let (Some(app), Some(min)) = (parse_version(app_version), parse_version(&entry.min_app_version)) {
        if min > app {
            return format!("需要应用 {}+（当前 {app_version}）", entry.min_app_version);
        }
    }
    String::new()
}

/// 这把发布者公钥有没有被这份索引撤回（按指纹比；没给 key 就是没有）。
pub fn key_revoked<'a>(revoked_keys: &'a [RevokedKey], key: &str) -> Option<&'a RevokedKey> {
    if key.trim().is_empty() {
        return None;
    }
    let fp = publisher_key_fingerprint(key).ok()?;
    revoked_keys
        .iter()
        .find(|rk| publisher_key_fingerprint(&rk.key).ok().as_deref() == Some(fp.as_str()))
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
            blocked: entry_block_reason(p, app_version, &index.revoked_keys),
            publisher_signed: !p.signature.trim().is_empty(),
            // 指纹算不出来时留空 + 在下面被当成"没有指纹"（索引解析已经校验过 key 形状，
            // 走到这里还失败只可能是极端情况，不该让整份索引打不开）。
            publisher_key_fingerprint: if p.publisher_key.trim().is_empty() {
                String::new()
            } else {
                publisher_key_fingerprint(&p.publisher_key).unwrap_or_default()
            },
        })
        .collect();
    PluginIndexView {
        index_version: index.index_version,
        owner: index.owner.clone(),
        generated_at: index.generated_at.clone(),
        signature_verified,
        revoked_keys: index
            .revoked_keys
            .iter()
            .map(|rk| RevokedKeyView {
                fingerprint: publisher_key_fingerprint(&rk.key).unwrap_or_default(),
                reason: rk.reason.clone(),
                revoked_at: rk.revoked_at.clone(),
            })
            .collect(),
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

/// 公钥指纹：解码后的 42 字节的 sha256 前 16 位十六进制（按 4 位一组显示更易读）。
///
/// 用它而不是整把 key 来做"是不是同一把钥匙"的判断与界面展示：一串 56 字符的 base64
/// 没有人会去比对，而 16 位指纹可以让人在发布者的公告里对着看。
pub fn publisher_key_fingerprint(pubkey: &str) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    // 先按同一个解析器校验形状（不合法的 key 在这里就报「公钥不合法」，而不是算出一个
    // 看着像指纹的东西）；再从 base64 那一行取原始字节——`PublicKey` 不暴露原始字节。
    parse_index_pubkey(pubkey)?;
    let b64 = pubkey.trim().lines().last().unwrap_or("").trim();
    let raw = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, b64)
        .map_err(|e| format!("公钥不合法：{e}"))?;
    let mut h = Sha256::new();
    h.update(&raw);
    let hex = hex::encode(h.finalize());
    let short = &hex[..16];
    Ok(short
        .as_bytes()
        .chunks(4)
        .map(|c| std::str::from_utf8(c).unwrap_or("").to_string())
        .collect::<Vec<_>>()
        .join("-"))
}

/// 校验**插件包**的发布者签名（同一个 minisign 习惯，只是签的字节是 zip 本身）。
pub fn verify_package_signature(
    package_bytes: &[u8],
    signature: &str,
    pubkey: &str,
) -> Result<(), String> {
    let pk = parse_index_pubkey(pubkey)?;
    let sig = minisign_verify::Signature::decode(signature)
        .map_err(|e| format!("发布者签名不合法：{e}"))?;
    pk.verify(package_bytes, &sig, false)
        .map_err(|_| "发布者签名校验失败（这个包不是那把发布者 key 签的，或包被换过）".to_string())
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
            publisher_key: String::new(),
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
            revoked_keys: Vec::new(),
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

    #[test]
    fn the_documented_example_index_stays_parseable() {
        // 文档里的样例是**给人照抄的**：它一旦解析不过，"照着抄"就会直接装不上。
        // 所以把它当固定装置：改了规范/校验规则而忘了同步样例，这里就会红。
        let bytes = include_bytes!("../../docs/plugin-index.example.json");
        let index = parse_index(bytes).unwrap_or_else(|e| panic!("文档里的样例索引应当能解析：{e}"));
        assert_eq!(index.plugins.len(), 1);
        let entry = &index.plugins[0];
        assert_eq!(entry.id, "weekly-review");
        assert_eq!(entry.api_version, crate::capabilities_gen::API_VERSION);
        assert!(!entry.permissions.is_empty(), "样例要演示「权限 + 理由」这项必填");
        assert!(entry.permissions.iter().all(|p| !p.reason.trim().is_empty()));
        let view = index_view(&index, "1.87.0", None);
        assert_eq!(view.plugins[0].blocked, "", "样例在声明的 minAppVersion 上应当是可安装的");
        assert_eq!(view.signature_verified, None);
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
    fn a_publisher_key_has_a_stable_short_fingerprint() {
        let fp = publisher_key_fingerprint(MINISIGN_TEST_PUBKEY).unwrap();
        assert_eq!(fp.len(), 19, "16 位十六进制 + 3 个分隔符：{fp}");
        assert_eq!(fp, publisher_key_fingerprint(MINISIGN_TEST_PUBKEY).unwrap());
        // 文件形式（带注释行）与裸 base64 是同一把 key → 同一个指纹
        let file_form =
            format!("untrusted comment: minisign public key E7620F1842B4E81F\n{MINISIGN_TEST_PUBKEY}");
        assert_eq!(publisher_key_fingerprint(&file_form).unwrap(), fp);
        // 改一个字节就是另一把 key
        let other = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO2";
        assert_ne!(publisher_key_fingerprint(other).unwrap(), fp);
        assert!(publisher_key_fingerprint("not-a-key").is_err());
    }

    #[test]
    fn publisher_signature_and_key_must_come_as_a_pair() {
        let with = |sig: &str, key: &str| {
            let mut e = good_entry("weekly-report");
            e.signature = sig.into();
            e.publisher_key = key.into();
            index_json(vec![e])
        };
        // 只有签名、没有公钥 → 索引自己就矛盾
        let err = parse_index(&with("untrusted comment: x\nAAAA", "")).unwrap_err();
        assert!(err.contains("必须一起给") && err.contains("只有签名"), "{err}");
        // 只有公钥、没有签名
        let err = parse_index(&with("", MINISIGN_TEST_PUBKEY)).unwrap_err();
        assert!(err.contains("只有公钥"), "{err}");
        // 形状不对的公钥：早拒，别让它变成"每次安装都失败在验签那一步"
        let err = parse_index(&with("untrusted comment: x\nAAAA", "not-a-key")).unwrap_err();
        assert!(err.contains("publisherKey 不合法"), "{err}");
        // 成对且形状正确 → 过
        assert!(parse_index(&with("untrusted comment: x\nAAAA", MINISIGN_TEST_PUBKEY)).is_ok());
        // 两个都不给（阶段 1 的索引）→ 也过
        assert!(parse_index(&with("", "")).is_ok());
    }

    #[test]
    fn a_package_signature_is_verified_against_the_package_bytes() {
        // 官方测试向量签的是 4 个字节 "test"；这里把"包"就当那 4 个字节，
        // 验的是**包字节这一层**的校验路径（而不是索引 JSON 那一层）。
        verify_package_signature(b"test", &minisign_test_signature(), MINISIGN_TEST_PUBKEY)
            .expect("真签名应当通过");
        let err = verify_package_signature(b"test!", &minisign_test_signature(), MINISIGN_TEST_PUBKEY)
            .unwrap_err();
        assert!(err.contains("发布者签名校验失败"), "{err}");
        let err = verify_package_signature(b"test", "garbage", MINISIGN_TEST_PUBKEY).unwrap_err();
        assert!(err.contains("发布者签名不合法"), "{err}");
    }

    #[test]
    fn the_spec_documents_minimal_example_actually_parses() {
        // 公开规范里那段"最小可用索引"是给人照抄的：它一旦解析不过，"照着抄"就直接装不上。
        // 从 markdown 里把第一个 ```json 代码块抠出来喂给同一个解析器——文档与实现
        // 从此不能再各说各话（这条和"样例索引是固定装置"那条是同一类保护）。
        let spec = include_str!("../../docs/plugin-index-spec.md");
        let block = spec
            .split("```json")
            .nth(1)
            .and_then(|rest| rest.split("```").next())
            .expect("规范里应当有一段 json 示例");
        let index = parse_index(block.as_bytes())
            .unwrap_or_else(|e| panic!("规范里的最小示例必须能解析：{e}"));
        assert_eq!(index.plugins.len(), 1);
        assert_eq!(index.plugins[0].id, "weekly-review");
        // 示例里的 sha256 是占位的 64 个 0：形状对（这正是"形状校验"该干的事）
        assert!(is_hex64(&index.plugins[0].sha256));
        assert_eq!(index.plugins[0].api_version, crate::capabilities_gen::API_VERSION);
    }

    // ---- 自己有钥匙的一次端到端：真包 + 真签名 ----
    //
    // 上面用的是 minisign 官方测试向量（签的是 4 个字节 "test"）——那证明了"我们这一层
    // 真在验签"，但没有证明"**我们自己签的包，我们自己验得过**"。本机没有 minisign
    // 可执行文件，所以夹具是用 `scripts/minisign-fixture.mjs`（Node 的 Ed25519 + 一份带
    // 官方向量自检的 BLAKE2b 实现）签的：一个**独立实现**签出来的向量被我们的校验器接受，
    // 这比"用同一份代码签、同一份代码验"更有说服力。
    //
    // 夹具是一次性密钥，公钥与签名都在 `src-tauri/tests/fixtures/` 里，可以随时重签：
    //   node scripts/minisign-fixture.mjs src-tauri/tests/fixtures/signed-plugin.zip \
    //     --out src-tauri/tests/fixtures/
    const SIGNED_PKG: &[u8] = include_bytes!("../tests/fixtures/signed-plugin.zip");
    const SIGNED_PKG_SIG: &str = include_str!("../tests/fixtures/signed-plugin.zip.minisig");
    const SIGNED_PKG_PUB: &str = include_str!("../tests/fixtures/signed-plugin-zip.pub");

    #[test]
    fn a_package_we_signed_ourselves_verifies_end_to_end() {
        // 1) 真包 + 真签名 → 过
        verify_package_signature(SIGNED_PKG, SIGNED_PKG_SIG, SIGNED_PKG_PUB)
            .expect("我们自己签的包必须验得过（这条是「签名链路真的通」的端到端验收）");
        // 2) 包被改一个字节 → 拒
        let mut tampered = SIGNED_PKG.to_vec();
        let last = tampered.len() - 1;
        tampered[last] ^= 0x01;
        let err = verify_package_signature(&tampered, SIGNED_PKG_SIG, SIGNED_PKG_PUB).unwrap_err();
        assert!(err.contains("发布者签名校验失败"), "{err}");
        // 3) 拿别的 key 来验 → 拒
        let err = verify_package_signature(SIGNED_PKG, SIGNED_PKG_SIG, MINISIGN_TEST_PUBKEY)
            .unwrap_err();
        assert!(err.contains("发布者签名校验失败"), "{err}");
        // 4) 这个包本身也得是一个能被解包的合法插件包（否则"验过了"没有意义）
        let dir = crate::plugins::tests_support::temp_dir("signed-pkg");
        extract_package(SIGNED_PKG, &dir).expect("夹具必须是一个真的插件包");
        let root = resolve_package_root(&dir);
        assert!(root.join("manifest.json").is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 用**真解析器**验收一份外部生成的索引（默认忽略）。给"要托管索引的人"用：
    /// 交出去之前先让它过一遍应用真正会跑的解析 + 拦阻检查，而不是"看着像对的"。
    ///
    ///   SHUYONOTE_INDEX_FIXTURE=/path/plugin-index.json \
    ///   SHUYONOTE_INDEX_APP_VERSION=1.89.1 \
    ///     cargo test --lib external_index -- --ignored --nocapture
    #[test]
    #[ignore]
    fn external_index_fixture_parses_and_validates() {
        let Ok(path) = std::env::var("SHUYONOTE_INDEX_FIXTURE") else {
            eprintln!("跳过：未设置 SHUYONOTE_INDEX_FIXTURE");
            return;
        };
        let app_version = std::env::var("SHUYONOTE_INDEX_APP_VERSION")
            .unwrap_or_else(|_| env!("CARGO_PKG_VERSION").to_string());
        let bytes = std::fs::read(&path).expect("读取索引失败");
        let index = parse_index(&bytes).expect("索引必须能被应用解析");
        eprintln!(
            "索引合法：owner={} 插件 {} 个，应用版本 {}",
            index
                .owner
                .as_ref()
                .map(|o| o.name.as_str())
                .unwrap_or("（未声明 owner）"),
            index.plugins.len(),
            app_version
        );
        for p in &index.plugins {
            let fingerprint = if p.publisher_key.trim().is_empty() {
                "（无发布者签名）".to_string()
            } else {
                publisher_key_fingerprint(&p.publisher_key).expect("publisherKey 必须能被解析")
            };
            let blocked = entry_block_reason(p, &app_version, &index.revoked_keys);
            eprintln!(
                "  - {} v{} · {} 字节 · sha256 {}… · 发布者指纹 {} · {}",
                p.id,
                p.version,
                p.size,
                &p.sha256[..12.min(p.sha256.len())],
                fingerprint,
                if blocked.is_empty() { "可安装" } else { blocked.as_str() }
            );
            // 索引里**故意**带撤回条目是合法的（撤回就是拿来拦的），所以只对
            // "没有被撤回声明"的条目断言它不该被拦——否则这个工具会把合法索引判成坏索引。
            if p.revoked_at.is_none() {
                assert!(
                    blocked.is_empty(),
                    "这份索引里的 {} 在当前应用版本下装不了：{blocked}",
                    p.id
                );
            }
        }
    }

    /// 用**真校验器**验一个外部产出的包（默认忽略）。给"要发插件包的人"用：
    /// `scripts/plugin-fragment.mjs` 打完包签完名之后，先用这里过一遍，再交给社区。
    ///
    ///   SHUYONOTE_PKG_ZIP=/tmp/frag/x-1.0.0.zip \
    ///   SHUYONOTE_PKG_SIG=/tmp/frag/x-1.0.0.zip.minisig \
    ///   SHUYONOTE_PKG_PUB=/tmp/frag/publisher.pub \
    ///     cargo test --lib external_package -- --ignored --nocapture
    #[test]
    #[ignore]
    fn external_package_signature_verifies() {
        let (Ok(zip), Ok(sig), Ok(pub_path)) = (
            std::env::var("SHUYONOTE_PKG_ZIP"),
            std::env::var("SHUYONOTE_PKG_SIG"),
            std::env::var("SHUYONOTE_PKG_PUB"),
        ) else {
            eprintln!("跳过：需要 SHUYONOTE_PKG_ZIP / SHUYONOTE_PKG_SIG / SHUYONOTE_PKG_PUB");
            return;
        };
        let bytes = std::fs::read(&zip).expect("读取包失败");
        let sig_text = std::fs::read_to_string(&sig).expect("读取签名失败");
        let pub_text = std::fs::read_to_string(&pub_path).expect("读取公钥失败");
        verify_package_signature(&bytes, &sig_text, &pub_text).expect("发布者签名必须验得过");
        // **还要能真的解开**：签名验过但解不开的包，装的时候才会炸——
        // 而"打包方式换了"（例如从命令行 zip 换成库）恰好会改字节布局，
        // 所以这条必须走应用**真正的**解包器，而不是拿 unzip 看一眼就算。
        let dir = crate::plugins::tests_support::temp_dir("external-pkg");
        extract_package(&bytes, &dir).expect("发布者签过名的包必须能被应用解包");
        let root = resolve_package_root(&dir);
        let manifest = root.join("manifest.json");
        assert!(manifest.is_file(), "解出来必须能找到 manifest.json（包内根目录结构不对）");
        let text = std::fs::read_to_string(&manifest).expect("读 manifest");
        let id = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v.get("id").and_then(|x| x.as_str()).map(|s| s.to_string()))
            .unwrap_or_default();
        assert!(!id.is_empty(), "manifest 里必须写出 id");
        let _ = std::fs::remove_dir_all(&dir);
        eprintln!(
            "包可验且可解：{}（{} 字节，插件 {}）· 发布者指纹 {}",
            zip.rsplit('/').next().unwrap_or(&zip),
            bytes.len(),
            id,
            publisher_key_fingerprint(&pub_text).expect("指纹必须算得出")
        );
    }

    #[test]
    fn the_fixture_publisher_key_fingerprint_is_stable() {
        // 指纹是"人用来比对"的东西：它在界面上出现，也在发布者的公告里出现。
        // 夹具的指纹写死在这里，改了夹具（或改了算法）就会红——那正是想被发现的时刻。
        assert_eq!(
            publisher_key_fingerprint(SIGNED_PKG_PUB).unwrap(),
            "5ee2-b2a1-c3cf-565c"
        );
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
            assert_eq!(
                entry_block_reason(entry, "1.87.0", &[]),
                shown.blocked,
                "界面与安装判定必须同源"
            );
        }
        assert!(!view.plugins[2].publisher_signed, "没写签名就不该显示成「已签名」");
        let mut signed = ok.clone();
        signed.signature = "untrusted comment: x\nAAAA".into();
        signed.publisher_key = MINISIGN_TEST_PUBKEY.into();
        let idx = parse_index(&index_json(vec![signed])).unwrap();
        assert!(index_view(&idx, "1.87.0", None).plugins[0].publisher_signed);
    }
}
