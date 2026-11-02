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

use std::path::{Path, PathBuf};
use tauri::Manager;

/// 单包上限 256 MB ✓（按需下载的都是引擎/模型，超过这个尺寸就不该走这条路 ✓）。
const MAX_PACK_BYTES: usize = 256 * 1024 * 1024;

/// 本地英汉词库（ECDICT）的 pack id —— ⭐ **与 `src/components/AbilitiesPane.tsx` 清单里那条逐字一致**
/// （`abilities.rs:21` 的"同源"要求；改一处必须改另一处）。
pub(crate) const ECDICT_PACK_ID: &str = "ecdict-en-zh";

/// 词库 pack（**压缩包**，`mirror/ecdict/ecdict-en-zh-v1.db.gz`）的字节数 —— ⭐ 2026-10-10 起钉的是
/// **下载到的那个 gzip**（不是解压后的库）；**解压后**那份的字节数与 sha256 钉在
/// `dictionary.rs`（`ECDICT_DB_BYTES` / `ECDICT_DB_SHA256`）—— 两处**各有各的用处**，⛔ 不要合并。
///
/// ⚠️ 这个常数是"便宜的第一道"判据：长度对不上 ⇒ 立刻不算就绪（截断/半包），再用 sha256 做第二道。
///
/// 实测（2026-10-10，镜像仓 `shuyo-cn/shuyo-mirror` 上那份）：39,126,809 字节。
pub(crate) const ECDICT_PACK_BYTES: u64 = 39_126_809;

/// 白名单 ＋ 钉住的 sha256 ✓（与 `src/components/AbilitiesPane.tsx` 里那份清单**同源** ✓；
/// ⚠️ 将来清单搬进 `src/lib/abilities/manifest.json` 时，这里必须跟着一起搬 ✓）。
pub(crate) fn expected_sha256(pack_id: &str) -> Option<&'static str> {
    match pack_id {
        "pdf-engine-win-x64" => {
            Some("808d36da9bc5a3104315fb307c80998121f565ee53953633bf33e80d7429e5ac")
        }
        // 本地英汉词库（ECDICT）：**数据不入库**，pack 由 `scripts/fetch-ecdict.mjs` 产出（钉上游
        // commit/blob sha ＋ 报产物 sha256）。⭐ 这里钉的是**镜像仓上那个 gzip 压缩包**的 sha256：
        //   gzip 39,126,809 字节 / ce0a2cf3…537b ⇒ 解压后 89,735,168 字节 / 5dc10a51…aaaea2bb31（见 dictionary.rs）
        x if x == ECDICT_PACK_ID => {
            Some("ce0a2cf36c690038ff3d0e4d385ec18c04110db7a34e9bd8ba4ad30d76ee537b")
        }
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
    let line = format!(
        "{stamp}\tpack={pack_id}\tbytes={}\tsha256={got}\n",
        bytes.len()
    );
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

// ---------------------------------------------------------------------------
// 能力的**启停**与**卸载**（2026-11-01 · task-14）
//
// ## 口径（这一节的要害）
// · **白名单是闭集**：只认能力页那张表上真有的三个 id（`office-import` / `ecdict-en-zh` /
//   `vlm-ocr`）。传别的 ⇒ **拒**（⛔ 不"尽量处理"，也⛔ 不拼路径出去 ✗）。
// · **只有"真的下载过一个 pack"的能力才能卸载**：今天只有词库（`ecdict-en-zh`）。
//   `office-import` 随安装包内置、`vlm-ocr` 的模型在用户自己的 Ollama 里 —— 这两条
//   **没有可删的东西** ⇒ 命令直接拒，并把理由给人话（界面那颗按钮也是禁用的）。
// · 卸载**只删** `<app_data>/packs/<pack_id>` 这一个目录：⛔ 不碰笔记、附件、设置，
//   也⛔ 不去猜"顺手清理"别的目录 ✗。**幂等**：已经不在 ⇒ 成功 ＋ `removed: false`。
// · 状态文件 `<app_data>/abilities-state.json`，**只登记"被停用的"**（没有它 = 启用）。
//   写盘是 **tmp ＋ rename**（同目录内改名 ⇒ 要么是旧内容、要么是新内容，⛔ 不留半份 ✗）。
// · **读不出来 ⇒ 按"全启用"**（fail-open）：把"禁用偏好"读丢了最多是"又能用了"；
//   反过来（fail-closed）会让用户的词库/导入在没有任何解释的情况下全部失效 ✗。
// ---------------------------------------------------------------------------

/// 内置能力（随安装包一起提供）—— **可禁用，不可卸载**（没有下载包可删）。
pub(crate) const OFFICE_IMPORT_ID: &str = "office-import";

/// 本机端点能力（模型在用户自己的 Ollama 里）—— **可禁用，不可卸载**
/// （本应用没有下载过任何东西 ⇒ 没有可删的 pack）。
pub(crate) const VLM_OCR_ID: &str = "vlm-ocr";

/// 能力 id 的**闭集**（⛔ 与 `AbilitiesPane.tsx` 的清单同源，改一处必须改另一处）。
pub(crate) fn is_known_ability(id: &str) -> bool {
    matches!(id, OFFICE_IMPORT_ID | ECDICT_PACK_ID | VLM_OCR_ID)
}

/// 可卸载的能力 ＝ 本应用**真的下载过一个 pack** 的那些（今天只有词库）。
pub(crate) fn is_uninstallable(id: &str) -> bool {
    id == ECDICT_PACK_ID
}

/// 不可卸载时那句**人话理由**（命令错误与界面那颗按钮的 `title` 共用一句 ⇒ ⛔ 不写第二份 ✗）。
pub(crate) fn uninstall_refusal(id: &str) -> Option<&'static str> {
    match id {
        OFFICE_IMPORT_ID => {
            Some("内置能力：它随安装包一起提供，没有可卸载的下载包（想关掉请用「禁用」）")
        }
        VLM_OCR_ID => Some(
            "本机端点能力：模型在你自己的 Ollama 里，本应用没有下载任何东西（想关掉请用「禁用」）",
        ),
        _ => None,
    }
}

/// 状态文件名（与 `packs/` 并列放在应用数据目录根上）。
pub(crate) const STATE_FILE: &str = "abilities-state.json";

/// 状态文件的落点。
pub(crate) fn state_path(app_data: &Path) -> PathBuf {
    app_data.join(STATE_FILE)
}

/// 状态文件的内容。⚠️ **只记"被停用的"** ⇒ 文件里没有某个 id ＝ 它是启用的。
#[derive(Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) struct AbilityStateFile {
    #[serde(default)]
    pub disabled: Vec<String>,
}

/// 读状态文件。⚠️ 读不出来 / JSON 坏 / 白名单外的 id ⇒ **都按"没有这一条"处理**
/// （fail-open，理由见本节抬头）；白名单外的 id 顺手滤掉（⛔ 不让旧条目一直攒着 ✗）。
pub(crate) fn read_state(app_data: &Path) -> AbilityStateFile {
    let Ok(text) = std::fs::read_to_string(state_path(app_data)) else {
        return AbilityStateFile::default();
    };
    let parsed: AbilityStateFile = serde_json::from_str(&text).unwrap_or_default();
    AbilityStateFile {
        disabled: parsed
            .disabled
            .into_iter()
            .filter(|id| is_known_ability(id))
            .collect(),
    }
}

/// 当前被停用的 id 表（已过滤白名单外的）。
pub(crate) fn disabled_ids(app_data: &Path) -> Vec<String> {
    read_state(app_data).disabled
}

/// 某个能力**现在是不是被停用的**。
pub(crate) fn is_ability_disabled(app_data: &Path, id: &str) -> bool {
    disabled_ids(app_data).iter().any(|d| d == id)
}

/// **原子写**状态文件：先写 `<file>.tmp`，再同目录 `rename` 覆盖。
///
/// ⚠️ Windows 上 `std::fs::rename` 走 `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` ⇒ 覆盖已有文件是成立的
/// （这条不是猜：`cargo test --lib abilities` 的 `state_file_is_written_tmp_then_renamed` 真的覆盖写两次）。
/// 失败时顺手把 `.tmp` 清掉（⛔ 不在用户目录里留垃圾 ✗）。
pub(crate) fn write_state(app_data: &Path, disabled: &[String]) -> Result<(), String> {
    std::fs::create_dir_all(app_data).map_err(|e| format!("建应用数据目录失败：{e}"))?;
    let path = state_path(app_data);
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_vec_pretty(&AbilityStateFile {
        disabled: disabled.to_vec(),
    })
    .map_err(|e| format!("能力状态序列化失败：{e}"))?;
    std::fs::write(&tmp, &body)
        .map_err(|e| format!("写能力状态临时文件失败（{}）：{e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!(
            "能力状态改名失败（{} → {}）：{e}",
            tmp.display(),
            path.display()
        )
    })
}

/// 一条能力的**界面读数**（`ability_states` 的返回项）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct AbilityEnabled {
    pub id: String,
    /// ⭐ 缺省（= 文件里没它）就是**启用** ✓（与 `read_state` 同一条口径）。
    pub enabled: bool,
    /// 能不能卸载（builtin / local-endpoint ⇒ `false`）。
    pub uninstallable: bool,
}

/// 三个能力的当前读数（纯逻辑，⛔ 不需要 `AppHandle` ⇒ 可单测）。
pub(crate) fn states_in(app_data: &Path) -> Vec<AbilityEnabled> {
    let disabled = disabled_ids(app_data);
    [OFFICE_IMPORT_ID, ECDICT_PACK_ID, VLM_OCR_ID]
        .iter()
        .map(|id| AbilityEnabled {
            id: (*id).to_string(),
            enabled: !disabled.iter().any(|d| d == id),
            uninstallable: is_uninstallable(id),
        })
        .collect()
}

/// 设置某个能力的启用状态并落盘，返回**落盘之后**的读数（纯逻辑，可单测）。
pub(crate) fn set_enabled_in(
    app_data: &Path,
    id: &str,
    enabled: bool,
) -> Result<Vec<AbilityEnabled>, String> {
    if !is_known_ability(id) {
        return Err(format!(
            "这个 id 不在能力白名单里，不能启停：{id}（只认 {OFFICE_IMPORT_ID} / {ECDICT_PACK_ID} / {VLM_OCR_ID}）"
        ));
    }
    let mut disabled = disabled_ids(app_data);
    if enabled {
        disabled.retain(|d| d != id);
    } else if !disabled.iter().any(|d| d == id) {
        disabled.push(id.to_string());
    }
    write_state(app_data, &disabled)?;
    Ok(states_in(app_data))
}

/// 卸载的读数（界面据此说"删了 / 本来就没有"，⛔ 不假装成功 ✗）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct UninstallReport {
    /// 那个 pack 目录的路径（**删掉之前**记下来的，供界面显示）。
    pub path: String,
    /// `false` ＝ 它本来就不在（幂等：这**不是**错误）。
    pub removed: bool,
    /// 删掉/本来就没有的字节数（用于显示"释放了多少"；读不出来就是 0）。
    pub bytes: u64,
}

/// 递归统计一个目录的字节数（读不出来的项跳过 —— 这里只用于显示，⛔ 不参与判据 ✗）。
fn dir_bytes(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut total = 0u64;
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            total += dir_bytes(&entry.path());
        } else {
            total += meta.len();
        }
    }
    total
}

/// 卸载某个能力包：**只删** `<app_data>/packs/<id>`，幂等（纯逻辑，可单测）。
pub(crate) fn uninstall_in(app_data: &Path, id: &str) -> Result<UninstallReport, String> {
    if !is_known_ability(id) {
        return Err(format!(
            "未知能力 id，拒绝卸载：{id}（白名单是闭集：{OFFICE_IMPORT_ID} / {ECDICT_PACK_ID} / {VLM_OCR_ID}）"
        ));
    }
    if let Some(reason) = uninstall_refusal(id) {
        return Err(format!("不能卸载「{id}」：{reason}"));
    }
    if !is_uninstallable(id) {
        return Err(format!("「{id}」不在可卸载白名单里 ⇒ 拒绝卸载"));
    }
    let packs = app_data.join("packs");
    let dir = packs.join(id);
    // ⚠️ 兜底断言：`id` 是白名单里的常量，理论上不可能拼出别的路径；
    //    但"只删这一个目录"是**会删数据**的动作 ⇒ 删之前再核一次它确实在 `packs/` 下面。
    if dir.parent() != Some(packs.as_path()) || dir == app_data {
        return Err(format!(
            "拒绝卸载：解析出来的路径不像能力包目录（{}）",
            dir.display()
        ));
    }
    if !dir.exists() {
        return Ok(UninstallReport {
            path: dir.display().to_string(),
            removed: false,
            bytes: 0,
        });
    }
    let bytes = dir_bytes(&dir);
    std::fs::remove_dir_all(&dir).map_err(|e| format!("删不掉（{}）：{e}", dir.display()))?;
    Ok(UninstallReport {
        path: dir.display().to_string(),
        removed: true,
        bytes,
    })
}

/// `app_data_dir()` 的薄包装（三条命令共用一句错误话）。
fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("拿不到应用数据目录：{e}"))
}

/// 三个能力的当前启停读数（界面挂载时问一次）。
#[tauri::command]
pub fn ability_states(app: tauri::AppHandle) -> Result<Vec<AbilityEnabled>, String> {
    Ok(states_in(&app_data_dir(&app)?))
}

/// 启用/停用某个能力。⚠️ 返回**落盘之后**的读数（界面直接用它刷新，⛔ 不自己猜 ✗）。
#[tauri::command]
pub fn ability_set_enabled(
    app: tauri::AppHandle,
    pack_id: String,
    enabled: bool,
) -> Result<Vec<AbilityEnabled>, String> {
    set_enabled_in(&app_data_dir(&app)?, &pack_id, enabled)
}

/// 卸载某个能力包：**只删** `<app_data>/packs/<pack_id>`，幂等。
#[tauri::command]
pub fn ability_uninstall(
    app: tauri::AppHandle,
    pack_id: String,
) -> Result<UninstallReport, String> {
    uninstall_in(&app_data_dir(&app)?, &pack_id)
}

/// ⭐ **office-import 的 OS 唤起入口放不放行**（`lib.rs` 的 `--import` 转交处用它）。
///
/// 这是 Rust 侧**唯一**能真拦住 office 导入的地方：真正解析 `.docx` 的是 TS 那条链
/// （`src/lib/office/`），Rust 只负责把 OS 给的路径带过去 ⇒ 禁用的执行点只能是"不转交"。
/// ⚠️ 读不到 app data ⇒ **放行**（fail-open：不能因为读不到状态文件就把用户"打开文件"的动作吞掉，
///    而前端那条 guard 仍然会拦并给人话 ⇒ 这里放行不会造成"禁用失效"）。
pub(crate) fn office_import_allowed(app: &tauri::AppHandle) -> bool {
    let Ok(dir) = app.path().app_data_dir() else {
        return true;
    };
    !is_ability_disabled(&dir, OFFICE_IMPORT_ID)
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
            out.push(if c.len() > 1 {
                A[(n >> 6 & 63) as usize] as char
            } else {
                '='
            });
            out.push(if c.len() > 2 {
                A[(n & 63) as usize] as char
            } else {
                '='
            });
        }
        out
    }

    #[test]
    fn base64_decodes_and_refuses_illegal_bytes() {
        assert_eq!(base64_decode("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(base64_decode(&b64(b"abc")).unwrap(), b"abc");
        assert_eq!(
            base64_decode(&b64(&[0u8, 255, 1])).unwrap(),
            vec![0u8, 255, 1]
        );
        // 换行/空白按惯例忽略 ✓（GitCode 返回的 base64 可能带折行 ✓）
        assert_eq!(base64_decode("aGVs\nbG8=").unwrap(), b"hello");
        // ⛔ 非法字符必须**报错**，不许静默丢字节 ✓
        assert!(base64_decode("!!!!").is_err());
        assert!(base64_decode("aGVs*bG8=").is_err());
    }

    #[test]
    fn whitelist_only_allows_the_packs_we_shipped() {
        assert!(expected_sha256("pdf-engine-win-x64").is_some());
        assert!(
            expected_sha256(ECDICT_PACK_ID).is_some(),
            "词库 pack 应在白名单里"
        );
        // ⚠️ 钉的哈希必须是**真的 64 位十六进制** —— 这个位置最容易留下的坏值不是"没有条目"，
        //    而是"占了位、值是空的/占位的"：那样 `verify_pack` 会把它当成"永远对不上"，
        //    表现是"能力页永远装不上"（而不是报错）。判据 machine-check 一次。
        let sha = expected_sha256(ECDICT_PACK_ID).unwrap();
        assert_eq!(sha.len(), 64, "词库 pin 应当是 64 位十六进制，实际 {sha:?}");
        assert!(
            sha.chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
            "词库 pin 应当是小写十六进制，实际 {sha:?}"
        );
        assert!(
            ECDICT_PACK_BYTES > 0,
            "词库 pack 的字节数必须是真的读数（半包判据要用它）"
        );
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

    // -----------------------------------------------------------------------
    // 启停 / 卸载（task-14）
    // -----------------------------------------------------------------------

    /// 一个**真的**存在、空的 app data 目录（`crate::tempdir::dir` ⇒ 不需要 `AppHandle`）。
    fn app_data(tag: &str) -> PathBuf {
        crate::tempdir::dir(tag).expect("建夹具 app data 目录")
    }

    #[test]
    fn state_file_is_written_tmp_then_renamed_and_reads_back() {
        let dir = app_data("abilities-state");
        // ① 没有文件 ⇒ 三条**都是启用**（缺省 ＝ 启用），可卸载的只有词库
        let st = states_in(&dir);
        assert_eq!(st.len(), 3);
        assert!(st.iter().all(|s| s.enabled), "默认必须全启用：{st:?}");
        let uninstallable: Vec<&str> = st
            .iter()
            .filter(|s| s.uninstallable)
            .map(|s| s.id.as_str())
            .collect();
        assert_eq!(
            uninstallable,
            vec![ECDICT_PACK_ID],
            "只有词库真的下载了一个 pack ⇒ 只有它能卸载"
        );

        // ② 停用词库 ⇒ 状态文件真的落了（内容可被独立解析），且**没有 .tmp 残留**
        let after = set_enabled_in(&dir, ECDICT_PACK_ID, false).expect("停用应当成功");
        assert!(
            !after
                .iter()
                .find(|s| s.id == ECDICT_PACK_ID)
                .unwrap()
                .enabled
        );
        let path = state_path(&dir);
        assert!(path.is_file(), "状态文件必须真的写出来：{}", path.display());
        let raw = std::fs::read_to_string(&path).expect("读状态文件");
        assert!(
            raw.contains(ECDICT_PACK_ID),
            "状态文件里应当有那个 id：{raw}"
        );
        assert_eq!(
            read_state(&dir),
            AbilityStateFile {
                disabled: vec![ECDICT_PACK_ID.to_string()]
            },
            "状态必须能原样读回来"
        );
        let tmp = path.with_extension("json.tmp");
        assert!(
            !tmp.exists(),
            "tmp + rename 之后⛔ 不许留 .tmp：{}",
            tmp.display()
        );

        // ③ 覆盖写（第二次写同一个文件）⇒ Windows 上也必须成功（rename 覆盖）
        let back = set_enabled_in(&dir, ECDICT_PACK_ID, true).expect("重新启用应当成功");
        assert!(back.iter().all(|s| s.enabled));
        assert!(
            read_state(&dir).disabled.is_empty(),
            "重新启用之后 disabled 必须是空的"
        );
        assert!(!tmp.exists(), "覆盖写之后⛔ 也不许留 .tmp");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn state_ignores_ids_outside_the_whitelist_and_refuses_unknown_ids() {
        let dir = app_data("abilities-whitelist");
        // 文件里混进白名单外的 id（历史垃圾）⇒ 读的时候滤掉，⛔ 不让它一直攒着
        std::fs::write(
            state_path(&dir),
            r#"{"disabled":["ecdict-en-zh","pdf-engine-win-x64","../../etc/passwd"]}"#,
        )
        .expect("写夹具状态");
        assert_eq!(disabled_ids(&dir), vec![ECDICT_PACK_ID.to_string()]);
        assert!(is_ability_disabled(&dir, ECDICT_PACK_ID));
        // 白名单外的 id 一律不当成"禁用"（`is_known_ability` 也是闭集）
        assert!(!is_ability_disabled(&dir, "pdf-engine-win-x64"));

        for bad in ["nope", "PDF-ENGINE-WIN-X64", "", "../../etc/passwd"] {
            let e = set_enabled_in(&dir, bad, false).unwrap_err();
            assert!(e.contains("白名单"), "对 {bad:?} 的错误应当点明白名单：{e}");
        }
        // 坏 JSON ⇒ 按"全启用"（fail-open），并且下一次写会**自愈**成合法 JSON
        std::fs::write(state_path(&dir), b"{not json").expect("写坏夹具");
        assert!(
            states_in(&dir).iter().all(|s| s.enabled),
            "坏文件必须 fail-open"
        );
        set_enabled_in(&dir, VLM_OCR_ID, false).expect("自愈写应当成功");
        assert_eq!(disabled_ids(&dir), vec![VLM_OCR_ID.to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn uninstall_refuses_builtin_local_endpoint_and_unknown_ids() {
        let dir = app_data("abilities-uninstall-refuse");
        // builtin：可禁用，不可卸载（理由要能看出"内置"）
        let e = uninstall_in(&dir, OFFICE_IMPORT_ID).unwrap_err();
        assert!(e.contains("内置"), "{e}");
        // local-endpoint：可禁用，不可卸载（理由要能看出"模型在用户自己机器上"）
        let e = uninstall_in(&dir, VLM_OCR_ID).unwrap_err();
        assert!(e.contains("本机端点"), "{e}");
        // 未知 id：连"能不能卸载"都不猜
        let e = uninstall_in(&dir, "nope").unwrap_err();
        assert!(e.contains("白名单"), "{e}");
        // 一个都不是"因为不存在所以成功"：这些都不许返回 Ok
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn uninstall_removes_only_the_pack_dir_and_is_idempotent() {
        let dir = app_data("abilities-uninstall");
        // 夹具：词库的 pack 目录（含 bin ＋ audit.log）、**另一个** pack、以及一个不该被碰的文件
        let pack = dir.join("packs").join(ECDICT_PACK_ID);
        std::fs::create_dir_all(&pack).expect("建 pack 目录");
        std::fs::write(pack.join("ecdict-en-zh.bin"), vec![7u8; 32]).expect("写 bin");
        std::fs::write(pack.join("audit.log"), b"line\n").expect("写 audit");
        let other = dir.join("packs").join("someone-else");
        std::fs::create_dir_all(&other).expect("建别的 pack 目录");
        std::fs::write(other.join("keep.bin"), b"keep").expect("写 keep");
        let note = dir.join("notes.db");
        std::fs::write(&note, b"notes").expect("写 notes");

        // ① 真删：只删 packs/<id>，别的目录与文件一个都不许少
        let rep = uninstall_in(&dir, ECDICT_PACK_ID).expect("卸载应当成功");
        assert!(rep.removed, "它真的在 ⇒ removed 必须是 true");
        assert!(!pack.exists(), "packs/<id> 必须真的被删掉");
        assert!(other.join("keep.bin").is_file(), "别的 pack ⛔ 不许碰");
        assert!(note.is_file(), "笔记库 ⛔ 不许碰");
        assert_eq!(rep.bytes, 32 + 5, "读数应当是那个目录里文件的字节数");
        assert!(
            rep.path.contains(ECDICT_PACK_ID),
            "读数要指出删的是哪个目录：{}",
            rep.path
        );

        // ② 幂等：再删一次 ⇒ 成功 ＋ removed=false（⛔ 不是错误、⛔ 不假装删了什么）
        let again = uninstall_in(&dir, ECDICT_PACK_ID).expect("幂等：第二次也应当成功");
        assert!(!again.removed, "本来就没有 ⇒ removed 必须是 false");
        assert_eq!(again.bytes, 0);
        assert!(note.is_file(), "幂等那次也 ⛔ 不许碰别的东西");

        // ③ 卸载**不改**启停偏好（用户停用着就还停用着，⛔ 不替用户做决定）
        set_enabled_in(&dir, ECDICT_PACK_ID, false).expect("停用");
        uninstall_in(&dir, ECDICT_PACK_ID).expect("停用状态下也能卸载");
        assert!(
            is_ability_disabled(&dir, ECDICT_PACK_ID),
            "卸载⛔ 不许顺手把「停用」改回「启用」（那是两件事）"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
