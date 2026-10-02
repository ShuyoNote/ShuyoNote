//! 「能力」按需下载包的**落盘**（2026-10-02 windows 侧）。
//!
//! ## 口径（这一层的全部意义）
//! ⛔ **不信任 webview** ✗：页面上那次 sha256 校验是"给用户看的" ✓；
//! 真正决定能不能落盘的是**这里自己再算一遍** ✓，而且：
//!   · **白名单**：只有清单里上架过的 `pack_id` 能落盘 ✓（前端传什么都写不出别的目录 ✓）
//!   · **体积上限**：超过 `MAX_PACK_BYTES` 直接拒收 ✓
//!   · **sha256 比对**：算出来与钉住的值不一致 ⇒ 拒收 ✓（fail-closed ✓）
//! ⇒ 三条任一不过，**磁盘上不留半个字节** ✓（先全部校验完再写 ✓）。
//!
//! ## 为什么传 base64 而不是 `Vec<u8>`
//! IPC 传字节数组会被序列化成 JSON 数字数组（3.8 MB ⇒ 上千万字符 ✗）；
//! base64 只放大 33% ✓ 且**不需要新依赖**（自己解 ✓ —— 本机取 crates 索引的 TLS 当时是坏的 ✗）。

use std::path::PathBuf;
use tauri::Manager;

/// 单包上限 256 MB ✓（按需下载的都是引擎/模型，超过这个尺寸就不该走这条路 ✓）。
const MAX_PACK_BYTES: usize = 256 * 1024 * 1024;

/// 白名单 ＋ 钉住的 sha256 ✓（与 `src/components/AbilitiesPane.tsx` 里那份清单**同源** ✓；
/// ⚠️ 将来清单搬进 `src/lib/abilities/manifest.json` 时，这里必须跟着一起搬 ✓）。
fn expected_sha256(pack_id: &str) -> Option<&'static str> {
    match pack_id {
        "pdf-engine-win-x64" => Some("808d36da9bc5a3104315fb307c80998121f565ee53953633bf33e80d7429e5ac"),
        // ⚠️ 还没上架的（版面分析/VLM/向量/转写）**故意不在白名单里** ✓ ⇒ 传了也拒收 ✓
        _ => None,
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// 自己解 base64（标准字母表 ＋ `=` 填充 ✓）。⛔ 非法字符直接报错 ✗（不猜、不丢字节 ✓）。
fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\n' | b'\r' | b' ' | b'\t' => continue,
            _ => return Err(format!("base64 里有非法字符：0x{c:02x}")),
        };
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Ok(out)
}

#[derive(serde::Serialize)]
pub struct SavedPack {
    pub path: String,
    pub bytes: usize,
    pub sha256: String,
    pub audit: String,
}

/// 落盘一个能力包。**全部校验通过之后才写盘** ✓。
#[tauri::command]
pub fn save_ability_pack(
    app: tauri::AppHandle,
    pack_id: String,
    base64: String,
) -> Result<SavedPack, String> {
    let want = expected_sha256(&pack_id)
        .ok_or_else(|| format!("这个能力不在白名单里，不能落盘：{pack_id}"))?;

    let bytes = base64_decode(&base64)?;
    if bytes.is_empty() {
        return Err("解出来的内容是空的 ⇒ 拒收".into());
    }
    if bytes.len() > MAX_PACK_BYTES {
        return Err(format!(
            "包太大（{} 字节 > 上限 {} 字节）⇒ 拒收",
            bytes.len(),
            MAX_PACK_BYTES
        ));
    }
    let got = sha256_hex(&bytes);
    if got != want {
        // ⚠️ 只报读数、不落盘 ✓；也不算"半个成功" ✓。
        return Err(format!("sha256 与清单不一致 ⇒ 拒收（算出 {got}）"));
    }

    let dir: PathBuf = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("packs")
        .join(&pack_id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("建目录失败：{e}"))?;

    let file = dir.join(format!("{pack_id}.bin"));
    std::fs::write(&file, &bytes).map_err(|e| format!("写文件失败：{e}"))?;

    // 本地审计一条 ✓（谁、何时、多大、什么指纹 ✓ —— 便于日后核对"这份是哪来的"✓）
    let stamp = chrono::Utc::now().to_rfc3339();
    let audit = dir.join("audit.log");
    let line = format!("{stamp}\tpack={pack_id}\tbytes={}\tsha256={got}\n", bytes.len());
    {
        use std::io::Write as _;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&audit)
            .map_err(|e| format!("写审计失败：{e}"))?;
        f.write_all(line.as_bytes())
            .map_err(|e| format!("写审计失败：{e}"))?;
    }

    Ok(SavedPack {
        path: file.to_string_lossy().into_owned(),
        bytes: bytes.len(),
        sha256: got,
        audit: audit.to_string_lossy().into_owned(),
    })
}
