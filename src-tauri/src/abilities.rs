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
/// ⚠️ `pub(crate)`：`extract_kz.rs` 那条命令也收 base64（抽取层手上只有 bytes ✓，没有路径 ✓）
/// ⇒ **同一份解码器**，⛔ 不写第二份 ✗。
pub(crate) fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
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

/// **纯逻辑**：白名单 ＋ 解码 ＋ 体积 ＋ 指纹 —— 四条判据都在这里 ✓（可单测 ✓，不需要 `AppHandle` ✓）。
/// ⚠️ 命令本体只是"调它 ⇒ 再写盘" ✓，这样"拒收"这件事能被测到 ✓。
pub(crate) fn verify_pack(pack_id: &str, base64: &str) -> Result<Vec<u8>, String> {
    let want = expected_sha256(pack_id)
        .ok_or_else(|| format!("这个能力不在白名单里，不能落盘：{pack_id}"))?;

    let bytes = base64_decode(base64)?;
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
    Ok(bytes)
}

/// 落盘一个能力包。**全部校验通过之后才写盘** ✓。
#[tauri::command]
pub fn save_ability_pack(
    app: tauri::AppHandle,
    pack_id: String,
    base64: String,
) -> Result<SavedPack, String> {
    let bytes = verify_pack(&pack_id, &base64)?;
    let got = sha256_hex(&bytes);
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试用的编码器（生产路径只**解码** ✓ —— 不为了测试给生产代码加一个用不上的函数 ✗）。
    fn b64(bytes: &[u8]) -> String {
        const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for c in bytes.chunks(3) {
            let n = ((c[0] as u32) << 16)
                | ((*c.get(1).unwrap_or(&0) as u32) << 8)
                | (*c.get(2).unwrap_or(&0) as u32);
            out.push(A[(n >> 18 & 63) as usize] as char);
            out.push(A[(n >> 12 & 63) as usize] as char);
            out.push(if c.len() > 1 { A[(n >> 6 & 63) as usize] as char } else { '=' });
            out.push(if c.len() > 2 { A[(n & 63) as usize] as char } else { '=' });
        }
        out
    }

    #[test]
    fn base64_decodes_and_refuses_illegal_bytes() {
        assert_eq!(base64_decode("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(base64_decode(&b64(b"abc")).unwrap(), b"abc");
        assert_eq!(base64_decode(&b64(&[0u8, 255, 1])).unwrap(), vec![0u8, 255, 1]);
        // 换行/空白按惯例忽略 ✓（GitCode 返回的 base64 可能带折行 ✓）
        assert_eq!(base64_decode("aGVs\nbG8=").unwrap(), b"hello");
        // ⛔ 非法字符必须**报错**，不许静默丢字节 ✓
        assert!(base64_decode("!!!!").is_err());
        assert!(base64_decode("aGVs*bG8=").is_err());
    }

    #[test]
    fn whitelist_only_allows_the_packs_we_shipped() {
        assert!(expected_sha256("pdf-engine-win-x64").is_some());
        // 还没上架的四个 ⇒ 一律拒收 ✓
        for id in ["layout", "vlm-ocr", "embeddings", "transcription"] {
            assert!(expected_sha256(id).is_none(), "{id} 不该在白名单里");
        }
        // ⚠️ 路径形状的 id 更不能过 —— 白名单是**闭集**，不是"排除几个坏名字" ✓
        for id in ["../../etc/passwd", "", "PDF-ENGINE-WIN-X64"] {
            assert!(expected_sha256(id).is_none(), "{id} 不该在白名单里");
        }
    }

    #[test]
    fn verify_pack_refuses_unknown_id_wrong_hash_and_empty() {
        // ① 白名单外 ⇒ 拒收（且错误里能看出是哪一条判据拦的 ✓）
        let e = verify_pack("nope", &b64(b"whatever")).unwrap_err();
        assert!(e.contains("白名单"), "{e}");

        // ② 白名单内、但内容不对 ⇒ **sha256 不一致** ⇒ 拒收 ✓
        //    ⭐ 这条就是"前端那段校验被绕过"时的最后一道 ✓（Rust 侧自己再算一遍 ✓）
        let e = verify_pack("pdf-engine-win-x64", &b64(b"not the real pack")).unwrap_err();
        assert!(e.contains("sha256"), "{e}");

        // ③ 空内容 ⇒ 拒收 ✓（不写一个 0 字节的文件进去 ✓）
        let e = verify_pack("pdf-engine-win-x64", "").unwrap_err();
        assert!(e.contains("空") || e.contains("sha256"), "{e}");

        // ⚠️ **未覆盖**：`MAX_PACK_BYTES` 那条分支 —— 造 256 MB 夹具不划算 ✗，
        //    在交接件里如实标"未覆盖" ✓，不写一个假夹具冒充覆盖 ✓。
    }
}
