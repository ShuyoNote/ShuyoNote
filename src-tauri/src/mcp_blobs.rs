//! `mcp_blobs.rs` —— B1c 的**句柄表**与**唯一落盘处**（导出/下载）。
//!
//! ## 它解决什么
//! 外部 agent 要"把一份附件/导出拿到手"，但**不能把字节塞进上下文**（200 KB 上限、也不该让
//! 笔记内容顺着模型对话流出去）。矩阵 §6 定的口径是：**返回句柄、不返回字节**；
//! 句柄由**消费方** `blobs.fetch` 换成文件。
//!
//! ## 四条契约（都在这里实现，别处不许再写一份）
//! * **128 bit 以上随机**：两枚 UUIDv4 拼起来（约 244 bit 随机）——句柄不可猜；
//! * **单次**：`take` 成功即从表里删掉；二次使用 ⇒ `not_found`；
//! * **TTL 120 秒**：过期条目在 `put`/`take` 时清掉，取到过期 ⇒ `not_found`；
//! * **绑定会话**：句柄记着发起调用的身份（外部 `external:<会话号>` / 插件 `plugin:<插件 id>`），
//!   `take` 时对不上 ⇒ `not_found`（**不区分"不存在/过期/别人的"**：区分了就成了探测面）。
//!
//! ## 不做什么
//! * **不落盘、不写日志**：字节只在内存里（`Vec<u8>`）；审计/日志里只有"哪个对象"。
//! * **不接受任意目标路径**：落盘只进 `<app data>/exports/`（[`exports_dir`]），文件名由
//!   [`clean_file_name`] 清洗 —— 调用方给不出路径，也就没有路径穿越这回事。
//!
//! ## 为什么在内存里（而不是临时文件）
//! 句柄生命周期只有 120 秒且**一次性**；写临时文件反而留下"删不掉的明文副本"。
//! 代价是进程重启后句柄全部失效 —— 这恰好是**想要**的（重启即会话结束）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// 句柄有效期（矩阵 §6：120 秒）。
pub(crate) const HANDLE_TTL_MS: i64 = 120_000;
/// 同时最多保留多少个句柄 / 总字节上限：外部 agent 连发下载时**不能把内存撑爆**。
/// 超了先清过期，再按最早到期淘汰（淘汰是**可见**的：那个句柄会 `not_found`）。
const MAX_HANDLES: usize = 16;
const MAX_TOTAL_BYTES: usize = 96 * 1024 * 1024;

/// 句柄里携带的"这是什么"（不含字节）。字段与回给调用方的形状同名，便于一比一核对。
#[derive(Debug, Clone)]
pub(crate) struct BlobMeta {
    pub name: String,
    pub mime: String,
    pub size: i64,
    pub sha256: String,
    pub space_id: String,
}

struct Entry {
    meta: BlobMeta,
    bytes: Vec<u8>,
    /// 发起调用的身份：`external:<会话号>` / `plugin:<插件 id>`（见 `plugins::caller_identity`）。
    session: String,
    expires_at: i64,
}

fn store() -> &'static Mutex<HashMap<String, Entry>> {
    static STORE: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn locked() -> Result<std::sync::MutexGuard<'static, HashMap<String, Entry>>, String> {
    store()
        .lock()
        .map_err(|_| "internal: 句柄表锁坏了".to_string())
}

/// 清掉过期条目（每次 put/take 顺手做，不常驻线程）。
fn purge_expired(g: &mut HashMap<String, Entry>, now: i64) {
    g.retain(|_, e| e.expires_at > now);
}

/// 登记一份字节，返回 `(handle, expiresAt, 规范化后的元数据)`。
///
/// `sha256` / `size` 一律由**本函数**按字节真算（⛔ 不信调用方传进来的值）：句柄声明的指纹必须是
/// 这份字节的指纹，否则消费方拿到的文件与声明对不上。
pub(crate) fn put(
    session: &str,
    meta: BlobMeta,
    bytes: Vec<u8>,
) -> Result<(String, i64, BlobMeta), String> {
    let sha = sha256_hex(&bytes);
    let mut meta = meta;
    meta.sha256 = sha;
    meta.size = bytes.len() as i64;

    let now = now_ms();
    let expires_at = now + HANDLE_TTL_MS;
    let mut g = locked()?;
    purge_expired(&mut g, now);
    // 容量：先按最早到期淘汰，直到放得下（新句柄本身最大 96 MiB 的余量由常量保证）。
    while g.len() >= MAX_HANDLES
        || g.values().map(|e| e.bytes.len()).sum::<usize>() + bytes.len() > MAX_TOTAL_BYTES
    {
        let Some((victim, _)) = g
            .iter()
            .min_by_key(|(_, e)| e.expires_at)
            .map(|(k, e)| (k.clone(), e.expires_at))
        else {
            break;
        };
        g.remove(&victim);
    }
    // 两枚 UUIDv4 = 约 244 bit 随机（≥ 矩阵要求的 128 bit），32 字节 hex 共 64 字符。
    let handle = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    g.insert(
        handle.clone(),
        Entry {
            meta: meta.clone(),
            bytes,
            session: session.to_string(),
            expires_at,
        },
    );
    Ok((handle, expires_at, meta))
}

/// 兑换一个句柄：**成功即作废**（单次）。
///
/// 三种失败（不存在／过期／不属于本会话）都回**同一句** `not_found` —— 区分它们等于告诉
/// 调用方"这个句柄是真的，只是不是你的"，那是没必要的探测面。
pub(crate) fn take(session: &str, handle: &str) -> Result<(BlobMeta, Vec<u8>), String> {
    let h = handle.trim();
    if h.is_empty() {
        return Err("bad_args: handle 不能为空".to_string());
    }
    let now = now_ms();
    let mut g = locked()?;
    purge_expired(&mut g, now);
    let Some(entry) = g.get(h) else {
        return Err("not_found: 句柄不存在、已用过或已过期（句柄一次性、120 秒有效）".to_string());
    };
    if entry.session != session {
        return Err("not_found: 句柄不存在、已用过或已过期（句柄一次性、120 秒有效）".to_string());
    }
    // 走到这里才删 ⇒ 失败的那几次**不会**把别人的句柄消耗掉。
    let entry = g
        .remove(h)
        .ok_or_else(|| "not_found: 句柄不存在、已用过或已过期".to_string())?;
    Ok((entry.meta, entry.bytes))
}

/// **唯一落盘目录**：`<app data>/exports/`（矩阵 §6 的"句柄消费方"落点；⛔ 不接受任意路径）。
pub(crate) fn exports_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("exports")
}

/// 文件名清洗：只留**一个文件名**，去掉目录、控制字符与 Windows 非法字符。
///
/// 为什么这么严：文件名来自笔记里的附件名（用户/对端可写），而它会被拼进落盘路径 ⇒
/// 必须保证拼出来**永远**落在 [`exports_dir`] 里（`..`、`/`、`\`、盘符、NUL 全在这里被摘掉）。
/// 清洗规则（判据逐条钉住）：① 只取最后一段；② `< > : " | ? *` 与控制字符 ⇒ `_`；
/// ③ 首尾的 `.`/空格去掉；④ 空 ⇒ `下载`；⑤ 超过 120 个字符截断。
pub(crate) fn clean_file_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let mut cleaned: String = base
        .chars()
        .map(|c| {
            if matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') || (c as u32) < 0x20 {
                '_'
            } else {
                c
            }
        })
        .collect();
    cleaned = cleaned.trim_matches(['.', ' ']).to_string();
    // 首尾都剥掉后可能又露出新的控制字符（例如 `"  ..a..  "`），再走一遍 trim 即可。
    cleaned = cleaned.trim_matches(['.', ' ']).to_string();
    if cleaned.chars().count() > 120 {
        cleaned = cleaned.chars().take(120).collect();
        cleaned = cleaned.trim_matches(['.', ' ']).to_string();
    }
    if cleaned.is_empty() {
        "下载".to_string()
    } else {
        cleaned
    }
}

/// 把句柄里的字节**写进导出目录**，返回 `(绝对路径, 字节数, sha256)`。
///
/// 两条承重：
/// 1. **不覆盖**已有文件（加 `-1`、`-2` …）：导出是可重做的动作，静默覆盖用户旧导出 = 丢数据；
/// 2. **路径必须仍在导出目录里**：拼完之后再核一次父目录（文件名已清洗，这是第二道）。
pub(crate) fn write_to_exports(
    app_data_dir: &Path,
    meta: &BlobMeta,
    bytes: &[u8],
) -> Result<(String, i64, String), String> {
    let sha = sha256_hex(bytes);
    if sha != meta.sha256 {
        return Err("bad_blob: 字节与句柄声明的 sha256 不一致（拒绝落盘）".to_string());
    }
    let dir = exports_dir(app_data_dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("db_error: 建导出目录失败：{e}"))?;
    let name = clean_file_name(&meta.name);
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.clone(), String::new()),
    };
    let mut dest = dir.join(&name);
    let mut n = 1usize;
    while dest.exists() {
        dest = dir.join(format!("{stem}-{n}{ext}"));
        n += 1;
        if n > 9999 {
            return Err("db_error: 导出目录里同名文件太多，换个名字再试".to_string());
        }
    }
    if dest.parent() != Some(dir.as_path()) {
        // 理论上到不了（文件名已清洗）；留着是为了"边界只由一个地方保证"这句话是真的。
        return Err("bad_args: 文件名不合法（拒绝写到导出目录之外）".to_string());
    }
    std::fs::write(&dest, bytes).map_err(|e| format!("db_error: 写导出文件失败：{e}"))?;
    Ok((dest.to_string_lossy().into_owned(), bytes.len() as i64, sha))
}

/// sha256（小写 hex）—— 全文只有这一处实现（句柄登记与落盘校验都用它）。
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(bytes);
    hex::encode(h.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(name: &str) -> BlobMeta {
        BlobMeta {
            name: name.to_string(),
            mime: "text/plain".to_string(),
            size: 0,
            sha256: String::new(),
            space_id: "s1".to_string(),
        }
    }

    /// 文件名清洗的**边界逐条**（这条函数是路径安全的唯一保证 ⇒ 不能只测"正常名字"）。
    #[test]
    fn clean_file_name_strips_everything_dangerous() {
        for (raw, want) in [
            ("周报.md", "周报.md"),
            ("../../etc/passwd", "passwd"),
            ("C:\\Windows\\evil.exe", "evil.exe"),
            ("a/b/c.txt", "c.txt"),
            ("..", "下载"),
            ("   ", "下载"),
            ("", "下载"),
            ("a<b>c:d\"e|f?g*h", "a_b_c_d_e_f_g_h"),
            ("  .hidden.  ", "hidden"),
            ("bad\u{0}name.txt", "bad_name.txt"),
        ] {
            assert_eq!(clean_file_name(raw), want, "清洗 {raw:?}");
        }
        let long = "长".repeat(200) + ".txt";
        let cleaned = clean_file_name(&long);
        assert!(cleaned.chars().count() <= 120, "超长名要截断：{cleaned}");
        // 截断后**仍然**不含任何分隔符/控制字符（判据只认这一个出口）
        assert!(!cleaned.contains(['/', '\\']));
    }

    /// 单次 / 跨会话 / 过期三条契约（过期用测试专用 TTL 造，⛔ 不真等 120 秒）。
    #[test]
    fn handles_are_single_use_session_bound_and_expire() {
        let (h, exp, _) = put("external:s-1", meta("a.txt"), b"hello".to_vec()).unwrap();
        assert!(exp > now_ms(), "expiresAt 必须是未来");
        // 别的会话拿不走（而且**不会**把句柄消耗掉）
        let wrong = take("external:s-2", &h).unwrap_err();
        assert!(
            wrong.contains("not_found"),
            "别人的句柄必须 not_found：{wrong}"
        );
        // 本人第一次拿到
        let (m, bytes) = take("external:s-1", &h).unwrap();
        assert_eq!(bytes, b"hello");
        assert_eq!(m.sha256, sha256_hex(b"hello"));
        // 第二次 ⇒ 已作废
        let again = take("external:s-1", &h).unwrap_err();
        assert!(again.contains("not_found"), "二次使用必须失败：{again}");

        // 过期：直接把条目改成过去（不走 put 的 120 秒）
        let (h2, _, _) = put("external:s-3", meta("b.txt"), b"x".to_vec()).unwrap();
        {
            let mut g = locked().unwrap();
            g.get_mut(&h2).unwrap().expires_at = now_ms() - 1;
        }
        let expired = take("external:s-3", &h2).unwrap_err();
        assert!(
            expired.contains("not_found"),
            "过期必须 not_found：{expired}"
        );
    }

    /// 落盘：sha 与句柄一致、文件名清洗、**不覆盖**已有文件。
    #[test]
    fn write_to_exports_checks_sha_cleans_name_and_never_overwrites() {
        let dir = std::env::temp_dir().join(format!(
            "shuyonote-blobs-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let bytes = b"payload".to_vec();
        let mut m = meta("../../逃逸.txt");
        m.sha256 = sha256_hex(&bytes);
        let (p1, n1, sha1) = write_to_exports(&dir, &m, &bytes).unwrap();
        assert_eq!(n1, bytes.len() as i64);
        assert_eq!(sha1, sha256_hex(&bytes));
        assert!(
            Path::new(&p1).starts_with(exports_dir(&dir)),
            "必须落在 exports/ 里：{p1}"
        );
        assert_eq!(
            Path::new(&p1).file_name().unwrap().to_string_lossy(),
            "逃逸.txt",
            "目录部分必须被摘掉"
        );
        // 再来一次 ⇒ 加序号、不覆盖
        let (p2, ..) = write_to_exports(&dir, &m, &bytes).unwrap();
        assert_ne!(p1, p2, "不许覆盖已有导出");
        assert!(Path::new(&p2).starts_with(exports_dir(&dir)));
        // sha 对不上 ⇒ 拒绝落盘
        let mut bad = m.clone();
        bad.sha256 = sha256_hex(b"other");
        let err = write_to_exports(&dir, &bad, &bytes).unwrap_err();
        assert!(err.contains("sha256"), "指纹不符必须拒绝：{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
