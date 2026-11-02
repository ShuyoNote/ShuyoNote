// ⭐ **第 0 片后半（2026-10-14）**：通用「引擎／模型包」下载器 ✗ —— ⭐ 从 `dictionary.rs`
//   **整段搬过来**的 ✓（⭐ 一行逻辑都没改 ✗ —— 搬移可由 `git diff -M` 复核 ✓）。
//
// ⭐ 它凭什么算「通用」：⭐ 判据＝**不引用任何 ECDICT 专有物** ✓（不引用 `ECDICT_PACK_MIRROR_PATH`／
//   `ECDICT_PACK_BYTES`／`ECDICT_DB_*`／`ecdict_pins()`／`default_pack_url()` ✓）——
//   ⭐ 谁要用，就自己把 `path`＋`sha256`（＋解压后那份的 `bytes`＋`sha256`）填进 [`PackPins`] ✓。
//
// ⚠️ 如实两条（⛔ 不假装「已经全通用」✗）：
//   ① [`install_pack_from_archive_with`] 里那一步是 **gzip** ✗（`GzDecoder` ✓）—— 引擎包多半是 zip
//      ⇒ ⭐ 真正的通用要把「解压那一步」参数化 ✓（**留下一片** ✓，本片是**纯搬移**、不动逻辑 ✓）；
//   ② ⭐ **不做断点续传** ✗（缺 `Range`／`Content-Range` ✓ —— 留下一片 ✓）。

use serde::Serialize;
use std::path::Path;
/// 镜像仓的 contents API 前缀（⭐ 与 `AbilitiesPane` 的 `API` 常量**逐字一致**）。
pub const MIRROR_CONTENTS_API: &str =
    "https://api.gitcode.com/api/v5/repos/shuyo-cn/shuyo-mirror/contents/";
/// 镜像仓的 **git blobs** API 前缀 —— ⭐ 实测三种端点（2026-10-10，Lead 量的）：
///
/// ```text
/// · contents（…/contents/<path>?ref=main）⇒ **大文件不回内容**：元数据对（size=39126809 ✓）
///                                          但 `content` 长度 = **0** ✗ ⇒ 照它写下到的会是空
/// · raw（gitcode.com/…/raw/main/…）       ⇒ 回的是**一张 HTML 页**（5793 字节，sha256 完全不同）✗
/// · git/blobs/<blob-sha>                  ⇒ `encoding: base64` ＋ `content` 52,169,080 字符
///                                           （= 39,126,809 × 4/3 ✓，字节数对得上）✓✓
/// ```
///
/// ⇒ 所以默认取法是两步：先用 `contents` 拿 **GitCode 自己的 blob sha**（⛔ 那不是我们的 sha256），
/// 再来这里取内容。
pub const MIRROR_BLOBS_API: &str =
    "https://api.gitcode.com/api/v5/repos/shuyo-cn/shuyo-mirror/git/blobs/";

/// 内存里算 sha256（小写十六进制）—— 与 `sha256_file` 同一把尺子。
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// 从 `git/blobs` 那条 JSON 里取出内容，并核 **`size` 与解出来的长度一致**。
///
/// ⭐ 这是 owner 要求的第 ④(d) 条判据：`content` 是 base64 ⇒ 解出来必须**正好** `size` 字节。
/// ⛔ 对不上就拒收，**不许**拿"差不多"的字节往下走；⛔ 没有 `size` 也拒收（没核过长度的不算校验过）。
pub fn decode_blob_json(j: &serde_json::Value) -> Result<Vec<u8>, String> {
    let enc = j.get("encoding").and_then(|v| v.as_str()).unwrap_or("");
    if enc != "base64" {
        return Err(format!(
            "blobs 返回的形状不是 base64（encoding={enc}）⇒ 不猜"
        ));
    }
    let content = j.get("content").and_then(|v| v.as_str()).unwrap_or("");
    if content.is_empty() {
        return Err(
            "blobs 返回的 content 是空的 ⇒ 拒收（大文件在 `contents` 上就是这个症状：改走 git/blobs）"
                .to_string(),
        );
    }
    let bytes = crate::abilities::base64_decode(&content.replace(['\n', '\r', ' '], ""))?;
    let Some(size) = j.get("size").and_then(|v| v.as_u64()) else {
        return Err("blobs 的 JSON 里没有 size ⇒ 拒收（没有可核的长度就不算校验过）".to_string());
    };
    if size != bytes.len() as u64 {
        return Err(format!(
            "blobs 的 size 与解出来的长度不符：JSON 说 {size} 字节，实际解出 {} 字节 ⇒ 拒收",
            bytes.len()
        ));
    }
    Ok(bytes)
}

/// 两套钉子（压缩包那份从 `abilities.rs` 取 ⇒ ⛔ 不抄第二份；库那份是本文件的常量）。
///
/// ⚠️ 用 `String` 而不是 `&'static str`：判据要能用**夹具算出来的**指纹构造一份（否则那两条
/// "危险方向"的判据就只能拿真 39MB 产物才跑得起来 ⇒ 等于跑不了）。
#[derive(Debug, Clone)]
pub struct PackPins {
    pub archive_bytes: u64,
    pub archive_sha: String,
    pub db_bytes: u64,
    pub db_sha: String,
}

/// **两段校验**：先核"下载到的压缩包"，再核"解压出来的库"，最后才落盘。
///
/// ① 压缩包：长度 ＋ sha256（不过 ⇒ 拒绝，⛔ 一个字节都不落盘）
/// ② 解压：直接把 `GzDecoder` 接到 `install_pack_from_reader` —— 那个函数**本来就是**
///    "边写边核长度与 sha256，不过就删 `.part`" ⇒ 解压段**复用**它，不另写一份校验逻辑。
pub fn install_pack_from_archive_with(
    pins: &PackPins,
    archive: &[u8],
    part: &Path,
    dest: &Path,
    on_progress: PackProgress<'_>,
) -> Result<PackInstallReport, String> {
    if archive.len() as u64 != pins.archive_bytes {
        return Err(format!(
            "下载不完整：收到 {} 字节 ≠ 清单里钉的 {} 字节 ⇒ 拒绝落盘（没有写进你的目录）",
            archive.len(),
            pins.archive_bytes
        ));
    }
    let got = sha256_hex(archive);
    if got != pins.archive_sha {
        return Err(format!(
            "压缩包 sha256 不匹配 ⇒ 拒绝使用（算出 {}… ≠ 清单里钉的 {}…）—— 这次没有写进你的目录",
            &got[..12],
            &pins.archive_sha[..12.min(pins.archive_sha.len())]
        ));
    }
    let mut gz = flate2::read::GzDecoder::new(std::io::Cursor::new(archive));
    install_pack_from_reader(
        &mut gz,
        pins.db_bytes,
        &pins.db_sha,
        part,
        dest,
        Some(pins.db_bytes),
        on_progress,
    )
}

/// 下载完成后的读数（界面直接显示）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PackInstallReport {
    /// 落点（就是 `dictionary.rs` 第 2 顺位读的那个文件）。
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
    /// 取数来源（`mirror` 或调用方给的地址），排错用。
    pub source: String,
}

/// 进度回调：`(已收字节, 总字节)`；`None` = 服务端没给 `Content-Length` ⇒ **如实为 None**（⛔ 不猜）。
pub type PackProgress<'a> = &'a mut dyn FnMut(u64, Option<u64>);

/// **纯逻辑**：把 `reader` 落到 `dest`（先 `part` 再改名）。四条判据全在这里，可单测。
///
/// 顺序（⭐ 危险方向优先）：**边收边核长度上限** → 收完核长度 → 核 sha256 → 才 `rename`。
/// 任一不过 ⇒ 删 `.part` ＋ 返回**可读原因**；⛔ 磁盘上不留半个字节（与 `abilities.rs:9` 同族）。
pub fn install_pack_from_reader<R: std::io::Read>(
    reader: &mut R,
    expected_bytes: u64,
    expected_sha: &str,
    part: &Path,
    dest: &Path,
    total_hint: Option<u64>,
    on_progress: PackProgress<'_>,
) -> Result<PackInstallReport, String> {
    use sha2::{Digest, Sha256};
    use std::io::Write as _;

    if expected_sha.is_empty() {
        return Err("清单里没有钉 sha256 ⇒ 拒绝落盘（不核指纹就不算校验过）".to_string());
    }
    if expected_bytes == 0 {
        return Err("清单里没有钉字节数 ⇒ 拒绝落盘（没有上限就没法挡半包）".to_string());
    }
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("建目录失败（{}）：{e}", dir.display()))?;
    }

    // ⭐ `.part` 策略（**选一个并写明**，owner 2026-10-10 要求）：
    //   · **残留 ⇒ 覆盖**：`File::create` 是**截断打开**（⛔ 不是 append）⇒ 上一次崩溃留下的 `.part`
    //     会被整份覆盖，**下次自然能重来**，不需要用户先手工删文件。
    //     ⚠️ 这一条不是"顺手"：若哪天改成 append，旧字节会被**拼**进新内容里 ⇒ 长度与 sha256 都会不符，
    //     而失败现象是"下载完却校验不过"（**静默坏法**）—— `a_stale_part_file_does_not_corrupt_the_install` 守着它。
    //   · **检测到的失败 ⇒ 删**：读到一半断流/写失败/长度不符/指纹不符，每一处 return 前都 `remove_file(part)`
    //     ⇒ ⛔ 磁盘上不留半个字节，也不会把半成品留给下一次"以为已经下好了"。
    let cleanup = |part: &Path| {
        let _ = std::fs::remove_file(part);
    };

    let mut file = std::fs::File::create(part)
        .map_err(|e| format!("建临时文件失败（{}）：{e}", part.display()))?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut buf = vec![0u8; 1 << 20];
    on_progress(0, total_hint);
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                // 半包 ⇒ 删掉临时文件（⛔ 不许留一个"看起来像词库"的残片）
                drop(file);
                cleanup(part);
                return Err(format!("下载中断（已收到 {received} 字节）：{e}"));
            }
        };
        received += n as u64;
        if received > expected_bytes {
            // 上限＝**清单里钉的字节数**：多一个字节就说明这不是那一份 ⇒ 当场停（⛔ 不先写完再说）。
            drop(file);
            cleanup(part);
            return Err(format!(
                "下载内容超过清单里钉的 {expected_bytes} 字节（已收到 {received}）⇒ 拒绝落盘"
            ));
        }
        hasher.update(&buf[..n]);
        if let Err(e) = file.write_all(&buf[..n]) {
            drop(file);
            cleanup(part);
            return Err(format!("写临时文件失败：{e}"));
        }
        on_progress(received, total_hint);
    }
    if let Err(e) = file.flush() {
        drop(file);
        cleanup(part);
        return Err(format!("落盘失败：{e}"));
    }
    drop(file);

    if received != expected_bytes {
        cleanup(part);
        return Err(format!(
            "下载不完整：收到 {received} 字节 ≠ 清单里钉的 {expected_bytes} 字节 ⇒ 拒绝落盘"
        ));
    }

    let got = hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    // ⚠️ 这一条就是"危险方向优先"那一条：不匹配 ⇒ 删掉 `.part` ＋ 拒绝，⛔ 绝不 rename 成正式文件。
    if got != expected_sha {
        cleanup(part);
        return Err(format!(
            "sha256 不匹配 ⇒ 拒绝使用（算出 {}… ≠ 清单里钉的 {}…）—— 这次没有写进你的目录",
            &got[..12],
            &expected_sha[..12.min(expected_sha.len())]
        ));
    }

    if let Err(e) = std::fs::rename(part, dest) {
        cleanup(part);
        return Err(format!("改名失败（{}）：{e}", dest.display()));
    }
    Ok(PackInstallReport {
        path: dest.display().to_string(),
        bytes: received,
        sha256: got,
        source: String::new(),
    })
}

/// 一个地址 ⇒ 压缩包字节：**两种形状都认**（普通二进制 / `git/blobs` 那条 base64 JSON）。
///
/// ⚠️ 判据不联网 ⇒ 判据不调它；它只是"真下载"那一层（`install_pack_from_archive_with` 才是纯逻辑）。
pub(crate) async fn fetch_archive_from(url: &str) -> Result<Vec<u8>, String> {
    let res = reqwest::get(url)
        .await
        .map_err(|e| format!("连不上下载地址（{url}）：{e}"))?;
    if !res.status().is_success() {
        return Err(format!("下载失败：HTTP {}（{url}）", res.status().as_u16()));
    }
    let ctype = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    if ctype.contains("json") {
        let j: serde_json::Value = res
            .json()
            .await
            .map_err(|e| format!("返回结构不是 JSON：{e}"))?;
        decode_blob_json(&j)
    } else {
        Ok(res
            .bytes()
            .await
            .map_err(|e| format!("读响应失败：{e}"))?
            .to_vec())
    }
}
