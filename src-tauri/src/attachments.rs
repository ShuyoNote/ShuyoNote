use crate::db::{now_ms, Db};
use crate::models::{AttachmentMeta, AttachmentRow};
use crate::sync::record_change;
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tauri::{Emitter, Manager, State};

/// Lowercase-hex a byte slice (sha2 0.11's `Output` no longer implements
/// `LowerHex`, so we format it ourselves).
fn hex_of(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Content-addressed attachment hashes are SHA-256 (32 bytes → 64 lowercase hex).
/// Validating an IPC-supplied hash before joining it into a filesystem path
/// prevents a caller from writing outside the attachments dir via `../../evil`.
fn is_valid_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit())
}

/// Bucket dir name = the first two hex chars of the hash (64-hex SHA-256).
/// Split into 256 subdirectories so a single attachments dir never grows unbounded
/// (avoids O(N) scans and per-dir dentry pressure).
fn bucket_of(hash: &str) -> &str {
    // hash is validated 64-hex elsewhere; guard defensively against short/non-hex.
    if hash.len() >= 2 {
        &hash[0..2]
    } else {
        "_"
    }
}

/// New content-addressed path: `attachments/<hash[0..2]>/<hash>.<ext>`.
/// Keeping the extension on the on-disk filename means the file is a real,
/// OS-openable path (so `openPath`/`revealFile`/asset protocol all work); the
/// extension also mirrors the DB `mime` so it stays consistent. Bucketing by the
/// first two hex chars keeps a single attachment dir from growing unbounded.
///
/// ★ 丙-④ 起 `pub(crate)`：网格那条"发附件字节"的判据要按**这个布局**造现场
/// （判据里手写一遍 `hash[0..2]/hash.ext` 就等于把布局抄成两份，抄的那份迟早会漂）。
pub(crate) fn bucket_path(attachments_dir: &Path, hash: &str, ext: &str) -> PathBuf {
    attachments_dir
        .join(bucket_of(hash))
        .join(format!("{hash}.{ext}"))
}

/// ⭐ 2026-10-11：把一份附件字节**落盘**那一小段抽到这里 —— 生产（`save_image`）与判据**共用它** ✓
///   （本仓规矩：判据与被判对象同源；⛔ 判据不许自己抄一份实现 ✗）。
///
/// ⚠️⚠️⭐ **2026-10-11 交付订正**：这里原先挂了一段「已知的不一致」✗ —— ⭐ **那段是错的** ✗，
///   我已删掉，并把真相留在这里 ✓：
///   · `bucket_path` 确实**不含空间 id** ✓，但**基目录由调用方给** ✗ ——
///     ⭐ 生产里 `save_image` 传的是 `space_attachments_dir(&app_data_dir, &space)` ✓
///     ⇒ ⭐ **落点天然就是"每个空间自己一份"** ✓ ⇒ ⛔ 不存在"两个空间共用一个文件" ✗。
///   · ⭐ 我当时**只读了 `bucket_path` 一层就下了结论** ✗，⭐ 判据的夹具也跟着错（两个"空间"同一个 dir ✓）
///     ⇒ 红得理所当然、但与生产无关 ✓。⭐ 订正后的判据按生产接线跑，**两条都绿** ✓
///     （见文件末尾 `cross_space_attachment_tests` ✓）。
///   · ⭐ 这条设计是 **owner 2026-09-24 拍过的** ✓：见本文件 `space_attachments_dir` 的文档注释（L118 起 ✓）。
///
/// 返回 `(落盘路径, 这次是否真的写了)`。
pub(crate) fn write_attachment_once(
    attachments_dir: &Path,
    hash: &str,
    ext: &str,
    data: &[u8],
    key: Option<&crate::crypto::AppKeys>,
) -> Result<(PathBuf, bool), String> {
    let path = bucket_path(attachments_dir, hash, ext);
    if path.exists() {
        return Ok((path, false));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // 加密开启且本会话已解锁 ⇒ 落盘的就是**密文**；否则**原样透传**（明文 ✓）。
    let bytes = crate::security::encrypt_attachment_bytes(key, data)?;
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok((path, true))
}

/// Locate an attachment's bytes by hash. New layout (`attachments/<bucket>/<hash>.<ext>`)
/// is tried first (O(1) when the extension is known); if absent we fall back to
/// scanning the bucket dir (and then the legacy flat dir) comparing the hash stem,
/// so pre-bucket data keeps working (dual-read compat; we don't auto-migrate/delete).
pub(crate) fn find_path_by_hash(dir: &Path, hash: &str) -> Option<PathBuf> {
    // 1. Bucket dir, exact ext match (fast path).
    if let Ok(entries) = std::fs::read_dir(dir.join(bucket_of(hash))) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(stem) = name.split('.').next() {
                if stem == hash {
                    return Some(entry.path());
                }
            }
        }
    }
    // 2. Legacy flat dir.
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(stem) = name.split('.').next() {
            if stem == hash {
                return Some(entry.path());
            }
        }
    }
    None
}

/// 附件树的**根**（所有空间共用这一棵树）：`<app_data>/attachments`。
pub(crate) fn attachments_root(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("attachments")
}

/// 某个空间的附件目录：`<根>/<空间 id>`。
///
/// ★★ owner 2026-09-24 拍板（②）：附件库**按空间分**。hash 仍按**明文**算（空间内去重照旧），
/// 但**每个空间各存自己那一份**。为什么必须分：附件原来是**全局一份**，而钥匙从"应用级一把"
/// 改成"按空间"之后，同一份内容被"**一个加密空间 ＋ 一个明文空间**"同时引用时，
/// 谁先落盘谁决定那份字节是密文还是明文 —— 后读的那一方拿不到写它那把钥匙，解不开会被
/// **透传**（安静地交出一个坏文件）。分空间之后每个空间只读自己那份，这条缺口就不存在了。
/// 代价是**跨空间去重没了**，而那正是决策稿 §5.1 早就写下的取舍。
///
/// ⚠️ 空间 id 进路径前必须过 `db::is_safe_space_id`（挡 `../` 之类）；不合法 ⇒ 落到 `_invalid`，
/// **绝不**拼出树外的路径。
pub(crate) fn space_attachments_dir(app_data_dir: &Path, space_id: &str) -> PathBuf {
    let safe = if crate::db::is_safe_space_id(space_id) {
        space_id
    } else {
        "_invalid"
    };
    attachments_root(app_data_dir).join(safe)
}

/// 当前（活动）空间的 id；拿不到就退回空串（＝落到"根"，即老布局）—— **绝不 panic**。
pub(crate) fn active_space_id(c: &rusqlite::Connection) -> String {
    crate::workspaces::active_workspace_id(c).unwrap_or_default()
}

/// ⭐ **2026-10-27（owner：「修」）**：**这个空间目录里的附件，用这个空间的钥匙**（一处实现）。
///
/// 病根见 [`crate::security::key_for_space`] 的头注：附件目录按 `space_id` 分，而
/// `key_if_enabled(conn)` 用的是"连接自己的库" —— 两者不一致时会把**密文当明文**交出去
/// （真机：加密空间附件"另存为"得到 105,009 B 乱码）。⇒ 本文件里凡按空间读写附件，
/// 钥匙一律走这一处 ✓。
///
/// ⭐ 2026-10-28：**网格服务端也要走这一处** —— `/mesh/attachment` 收到的是"某个空间"的请求，
/// 钥匙必须按**那个空间**取（`mesh::handle_attachment`），⛔ 不是按连接/全局活动空间取。
pub(crate) fn space_key_for(app_data_dir: &Path, space_id: &str) -> Option<crate::crypto::AppKeys> {
    crate::security::key_for_space(app_data_dir, space_id)
}

/// **读**一个空间的附件：先在这个空间**自己**的目录里找，找不到再回退到**老的全局布局**
/// （`<根>/<桶>/…` 与 `<根>/<hash>.<ext>`）。
///
/// ⚠️ 老文件**不搬**（owner 拍板）：纯位置回退，不涉及密钥、不静默降级 ⇒
/// 升级之后你原来那些附件照样读得到，一个文件都不用动。
pub(crate) fn find_attachment(app_data_dir: &Path, space_id: &str, hash: &str) -> Option<PathBuf> {
    find_path_by_hash(&space_attachments_dir(app_data_dir, space_id), hash)
        .or_else(|| find_path_by_hash(&attachments_root(app_data_dir), hash))
}

/// 在**整棵附件树**里按 hash 找（**不知道空间**的只读场景：存储统计/清理/按 hash 定位）。
/// 先看各空间目录（目录名排序，结果稳定），再看根下的老布局。
pub(crate) fn find_attachment_anywhere(root: &Path, hash: &str) -> Option<PathBuf> {
    if let Ok(entries) = std::fs::read_dir(root) {
        let mut dirs: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();
        dirs.sort();
        for d in dirs {
            if let Some(p) = find_path_by_hash(&d, hash) {
                return Some(p);
            }
        }
    }
    find_path_by_hash(root, hash)
}

/// ⭐ **2026-10-27（owner：「这个页面没有同步完整？」/「补」）**：**空壳附件**判定 ——
/// 盘上有文件、但**明文是 0 字节**（加密后恰好只剩一个信封）。
///
/// ## 为什么必须把它当成"没有"
/// 真机现场（保险柜·濮阳数友企业支付宝）：一次 **0 字节的附件响应**被落成盘（加密后 42 B），
/// 而"盘上有没有这个 hash"是 `ensureAttachmentBytes` 的短路判据 ⇒ **空壳让这一件永远不再重取**，
/// 图片块从此是破图（`naturalWidth=0`）。⇒ 把空壳当"缺失"，下一次渲染就会自动重取 ✓。
///
/// ⚠️ 只在文件 **≤64 B** 时才解密（几乎零成本）；大文件不碰
/// （⛔ 不为了列一遍 hash 去解密几 MB × N ✗ —— 那会把面板拖死）。
pub(crate) fn is_empty_attachment_shell(path: &Path, key: Option<&crate::crypto::AppKeys>) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if meta.len() > 64 {
        return false;
    }
    let Ok(raw) = std::fs::read(path) else {
        return false;
    };
    matches!(
        crate::security::decrypt_attachment_bytes(key, &raw),
        Ok(plain) if plain.is_empty()
    )
}

/// 递归列出附件树里的**所有文件**（三种布局都算：`<根>/<空间>/<桶>/f`、`<根>/<桶>/f`、`<根>/f`）。
/// 给"不知道空间"的那些路径用：存储统计 / 孤儿清理 / 临时文件清理。
#[cfg(test)]
mod empty_shell_tests {
    use super::*;

    /// ⭐ **2026-10-27（owner：「修」）**：**附件命令必须按"这个空间"取钥匙** ——
    /// 病根是 `key_if_enabled(conn)` 拿"连接自己"的钥匙；活动空间与附件空间不一致时
    /// 会把**盘上密文**当明文交出去（真机：另存为得到 105,009 B 的乱码）。
    /// 判据是**源码形状**（命令要真跑就得起 Tauri 窗口，那超出单测边界）：这几个入口里
    /// 一律走 `space_key_for`，⛔ 不许再出现 `key_if_enabled`。
    #[test]
    fn attachment_entry_points_take_the_key_from_the_space() {
        let src = include_str!("attachments.rs");
        let slice = |a: &str, b: &str| -> &str {
            // ⚠️ 用 **rfind**：本判据自己的源码里也写着这些锚点字面量（在文件上方）⇒
            //    `find` 会先命中判据自己，切出来的片段里当然没有实现。
            let i = src.rfind(a).unwrap_or_else(|| panic!("没找到锚点 A：{a}"));
            let j = src[i..]
                .find(b)
                .unwrap_or_else(|| panic!("没找到锚点 B：{b}"))
                + i;
            &src[i..j]
        };
        for (name, body) in [
            (
                "copy_attachment",
                slice("pub fn copy_attachment", "pub fn list_attachment_hashes"),
            ),
            (
                "attachment_path",
                slice("pub fn attachment_path", "pub fn copy_attachment"),
            ),
            (
                "attachment_bytes",
                slice("fn attachment_bytes(", "pub fn read_attachment_bytes"),
            ),
        ] {
            assert!(
                body.contains("space_key_for(&app_data_dir, &space)"),
                "{name} 必须按**这个空间**取钥匙（space_key_for）"
            );
            assert!(
                !body.contains("key_if_enabled(&"),
                "{name} 里不许再拿\"连接自己\"的钥匙（注释里提到它没关系，调用不行）"
            );
        }
        // 协议层（`attachment.localhost` 的解密在 `lib.rs`）也必须按空间取钥匙
        let lib = include_str!("lib.rs");
        assert!(
            lib.contains("security::key_for_space(d, &space)"),
            "attachment 协议处理器必须按空间取钥匙（否则渲染会把密文当明文）"
        );
    }

    /// ⭐ **2026-10-27（owner：「修」）**：**拿不到钥匙时，密文绝不当明文导出** ——
    /// 真机现场：加密空间附件"另存为"得到 105,009 B 乱码（开头 `53 01`）。
    /// 现在：看着是密文 + `key=None` ⇒ 报错（说清"先解锁该空间"）；明文照旧直接拷。
    #[test]
    fn exporting_a_ciphertext_attachment_without_the_key_is_refused() {
        let dir = std::env::temp_dir().join(format!("shuyo-export-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        let enc = dir.join("enc.bin");
        std::fs::write(
            &enc,
            [
                crate::crypto::MAGIC,
                crate::crypto::VERSION_XCHACHA,
                1,
                2,
                3,
            ],
        )
        .unwrap();
        assert!(head_is_ciphertext(&enc), "夹具：带密文头的文件要认成密文");
        assert!(
            crate::security::looks_like_attachment_ciphertext(&[crate::crypto::MAGIC, 1, 9]),
            "带 MAGIC 的字节要认成密文"
        );
        assert!(
            !crate::security::looks_like_attachment_ciphertext(b"hello"),
            "明文不许认成密文"
        );
        assert!(
            !crate::security::looks_like_attachment_ciphertext(&[0x89, b'P', b'N', b'G']),
            "PNG 头不许认成密文"
        );

        let out = dir.join("out.bin");
        let err = export_attachment_to(&enc, &out, None).expect_err("密文 + 无钥匙必须拒绝导出");
        assert!(
            err.contains("解锁"),
            "报错要说清下一步（先解锁该空间）：{err}"
        );
        assert!(!out.exists(), "⛔ 不许留下一个乱码文件");

        let plain = dir.join("plain.txt");
        std::fs::write(&plain, b"hello").unwrap();
        let out2 = dir.join("out2.txt");
        export_attachment_to(&plain, &out2, None).unwrap();
        assert_eq!(
            std::fs::read(&out2).unwrap(),
            b"hello",
            "明文空间照旧是纯拷贝"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 空壳判定：**0 字节明文 ⇒ 空壳**；有内容 ⇒ 不是；**>64 B 不参与判定**（不去解密大文件）。
    #[test]
    fn an_empty_plaintext_attachment_counts_as_a_shell() {
        let dir = std::env::temp_dir().join(format!("shuyo-shell-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        let empty = dir.join("empty.bin");
        std::fs::write(&empty, b"").unwrap();
        assert!(
            is_empty_attachment_shell(&empty, None),
            "0 字节文件必须判成空壳"
        );

        let ok = dir.join("ok.bin");
        std::fs::write(&ok, b"hello").unwrap();
        assert!(
            !is_empty_attachment_shell(&ok, None),
            "有内容的文件不许判成空壳"
        );

        let big = dir.join("big.bin");
        std::fs::write(&big, vec![0u8; 128]).unwrap();
        assert!(
            !is_empty_attachment_shell(&big, None),
            ">64 B 的文件不参与空壳判定（⛔ 不为列 hash 去解密大文件 ✗）"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}

pub(crate) fn walk_attachment_files(root: &Path) -> Vec<PathBuf> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, out);
            } else if p.is_file() {
                out.push(p);
            }
        }
    }
    let mut out = Vec::new();
    walk(root, &mut out);
    out
}

/// ⭐ 回收附件树里的**空目录**（后序删除；⛔ 绝不删根）。回「删了几个」。
///
/// ## 为什么需要（2026-10-25 真机）
///
/// 删除路径（迁移、`cleanup_orphan_attachments`）**只删文件**，而 `write_attachment_once` 只会**建**目录
/// ⇒ 于是空目录只增不减：真机量到 261 个目录里 **135 个是空的**
/// （74 个老桶目录 ＋ 61 个空的空间目录，其中不少对应的空间早就不存在了）。
///
/// 代价不是纯观感：`find_attachment_anywhere` 每次按 hash 找文件都要**逐个**读根下这些目录
/// （95 个顶层、61 个空）⇒ 白付 syscall。而它们**永远不会**再长出文件来（空的空间目录会在下次
/// `save_image` 时按需重建 ✓）。
///
/// ⚠️ 口径：① 只删**空**的；② 深度优先（先删子、再删父）；③ ⛔ 根目录本身不删；
///    ④ 删不掉只跳过（权限/占用都当"这次先留着"，⛔ 不报错 —— 这是清理，不是业务 ✓）。
pub(crate) fn prune_empty_attachment_dirs(app_data_dir: &Path) -> usize {
    prune_empty_dirs_under(&attachments_root(app_data_dir))
}

/// [`prune_empty_attachment_dirs`] 的"直接给根"版本（给已经有 `att_dir` 的那几处用 ✓）。
pub(crate) fn prune_empty_dirs_under(root: &Path) -> usize {
    fn walk(dir: &Path, root: &Path, n: &mut usize) {
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        let entries: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
        for p in entries {
            if p.is_dir() {
                walk(&p, root, n);
            }
        }
        // 后序：子目录都处理完了再看自己（⛔ 根不删）
        if dir != root {
            if let Ok(mut rd2) = std::fs::read_dir(dir) {
                if rd2.next().is_none() && std::fs::remove_dir(dir).is_ok() {
                    *n += 1;
                }
            }
        }
    }
    let mut n = 0usize;
    if root.is_dir() {
        walk(&root, &root, &mut n);
    }
    n
}

/// ⭐ 一次「整理附件布局」的读数（⛔ 不静默：每一步都要能对账）。
#[derive(Clone, Default, serde::Serialize)]
pub struct LegacyLayoutMigration {
    /// 扫到的**老布局**文件数（`<根>/<桶>/f` 与 `<根>/f`）
    pub scanned: usize,
    /// 补进各空间目录的份数（一个 hash 被 N 个空间引用 ⇒ 最多补 N 份）
    pub copied: usize,
    /// 删掉的老文件数
    pub deleted: usize,
    /// ⛔ 没删的（有人读不到 / 没有可读引用者 ⇒ 留着）
    pub kept: usize,
    /// ⭐ 顺带回收掉的**空目录**数（见 `prune_empty_attachment_dirs`）
    pub pruned: usize,
    /// 打不开的空间（锁着的加密空间）—— 它们一非空，**整批只复制、不删**
    pub unreadable_spaces: Vec<String>,
    /// 逐条说明（谁为什么没搬 / 哪一份复制失败）
    pub notes: Vec<String>,
}

/// ⭐⭐ **整理附件布局（全量迁移）**：把**老布局**里的附件按"谁引用它"复制进各空间自己的目录。
///
/// ## 为什么是"复制"而不是"搬"
///
/// 老布局（2026-09-24 之前）是**全局一份** ⇒ 同一份内容可能被**多个空间**引用；
/// 而加密空间那份**必须是密文**（它自己的钥匙）。⇒ ⛔ 不能 `mv`：搬走＝别的空间读不到；
/// ⛔ 也不能只复制给一个空间：其余引用者还是"从根读明文"的老样子。
///
/// ## 删除的四道闸门（缺一不删）
///
/// ① 这个 hash 的**每个**引用空间都已经各有一份（复制全成功）；
/// ② 没有任何空间**打不开** —— 锁着的加密空间我们数不到它引用了什么，
///    那份老文件可能是它**唯一**的副本 ⇒ 删了就是"行在字节不在"；
/// ③ 老文件本身名字是内容寻址的（64 hex）；
/// ④ 删除失败只记读数，不抛（迁移是**增量**的，下一趟再来）。
///
/// ⇒ 于是最坏情况：**只复制、不删**（多占一份空间，但一个字节都不丢）✓
pub(crate) fn migrate_legacy_layout(app_data_dir: &Path) -> Result<LegacyLayoutMigration, String> {
    let root = attachments_root(app_data_dir);
    let spaces_dir = crate::db::spaces_dir(app_data_dir);
    let mut out = LegacyLayoutMigration::default();

    // ① 每个空间引用哪些 hash（打不开的记进 `unreadable_spaces`）
    let mut refs: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    let mut space_ids: Vec<String> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&spaces_dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if let Some(id) = name.strip_suffix(".db") {
                if !id.is_empty() && !id.starts_with('.') {
                    space_ids.push(id.to_string());
                }
            }
        }
    }
    space_ids.sort();
    for id in &space_ids {
        // ⚠️ 收进一个 Vec 再放（`stmt` 借着 `conn`）—— 直接在外面留 `rows` 会被借用检查挡下。
        let collected: Result<Vec<String>, String> = (|| {
            let conn = crate::db::open_space_conn_at(id, app_data_dir)?;
            let mut st = conn
                .prepare("SELECT DISTINCT hash FROM attachments")
                .map_err(|e| e.to_string())?;
            let rows = st
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            Ok(rows.flatten().collect())
        })();
        match collected {
            Ok(hs) => {
                for h in hs {
                    refs.entry(h).or_default().push(id.clone());
                }
            }
            Err(e) => out.unreadable_spaces.push(format!("{id}: {e}")),
        }
    }

    // ② 老布局文件（相对路径 < 3 段 ⇒ 不在 `<空间>/<桶>/` 之下）
    let mut legacy: Vec<PathBuf> = walk_attachment_files(&root)
        .into_iter()
        .filter(|p| {
            p.strip_prefix(&root)
                .map(|r| r.components().count() < 3)
                .unwrap_or(false)
        })
        .collect();
    legacy.sort();
    out.scanned = legacy.len();

    // ③ 逐个搬
    for f in &legacy {
        let Some(name) = f.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Some((hash, ext)) = name.split_once('.') else {
            continue;
        };
        if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            continue; // 不是内容寻址的名字 ⇒ ⛔ 不碰
        }
        let who = refs.get(hash).cloned().unwrap_or_default();
        if who.is_empty() {
            out.kept += 1;
            out.notes.push(format!(
                "{name}：没有**可读**空间引用它（可能只有锁着的空间在用）⇒ 留着"
            ));
            continue;
        }
        let mut all_copied = true;
        for sid in &who {
            let own = space_attachments_dir(app_data_dir, sid);
            if find_path_by_hash(&own, hash).is_some() {
                continue; // 已经有自己那份 ⇒ 幂等
            }
            let copy = (|| -> Result<(), String> {
                let conn = crate::db::open_space_conn_at(sid, app_data_dir)?;
                let key = crate::security::key_if_enabled(&conn);
                let enc = crate::security::space_db_is_encrypted(&crate::db::space_db_path(
                    app_data_dir,
                    sid,
                ));
                if enc && key.is_none() {
                    return Err("空间是密文但这一会话拿不到它的钥匙".to_string());
                }
                let bytes = std::fs::read(f).map_err(|e| e.to_string())?;
                // 双读：明文原样返回；密文才解。⇒ 复制出去的那份与今天读到的**逐字节一致** ✓
                let plain = crate::security::decrypt_attachment_bytes(key.as_ref(), &bytes)?;
                write_attachment_once(&own, hash, ext, &plain, key.as_ref())?;
                Ok(())
            })();
            match copy {
                Ok(()) => out.copied += 1,
                Err(e) => {
                    all_copied = false;
                    out.notes.push(format!("{name} → 空间 {sid} 复制失败：{e}"));
                }
            }
        }
        if all_copied && out.unreadable_spaces.is_empty() {
            match std::fs::remove_file(f) {
                Ok(()) => out.deleted += 1,
                Err(e) => {
                    out.kept += 1;
                    out.notes
                        .push(format!("{name}：删老文件失败（{e}）⇒ 留到下一趟"));
                }
            }
        } else {
            out.kept += 1;
            if !out.unreadable_spaces.is_empty() {
                out.notes.push(format!(
                    "{name}：有 {} 个空间读不到 ⇒ 只复制、不删（那份可能正是它们唯一的副本）",
                    out.unreadable_spaces.len()
                ));
            }
        }
    }
    // ⭐ 2026-10-25：**顺带回收空目录** —— 删完文件后那些空壳没有别的地方会清（见 `prune_empty_attachment_dirs`）。
    out.pruned = prune_empty_attachment_dirs(app_data_dir);
    Ok(out)
}

/// 命令面：**整理附件布局**（⛔ 不自动跑：会动用户文件 ⇒ 由人显式触发 ✓）。
#[tauri::command]
pub async fn attachments_migrate_legacy(
    app: tauri::AppHandle,
) -> Result<LegacyLayoutMigration, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let out = migrate_legacy_layout(&dir)?;
    eprintln!(
        "[attachments] 布局整理：扫 {} ｜ 复制 {} ｜ 删除 {} ｜ 保留 {} ｜ 空目录回收 {} ｜ 读不到的空间 {}{}",
        out.scanned,
        out.copied,
        out.deleted,
        out.kept,
        out.pruned,
        out.unreadable_spaces.len(),
        if out.unreadable_spaces.is_empty() {
            String::new()
        } else {
            format!("（只复制不删）：{}", out.unreadable_spaces.join("；"))
        }
    );
    Ok(out)
}
#[derive(Clone, serde::Serialize)]
pub struct ImportProgress {
    pub index: usize,
    pub total: usize,
    pub name: String,
    pub done: u64,
    pub size: u64,
}

/// 我们"不知道这是什么"的那个 mime。`rename_attachment` 用它区分"已知类型"与"未知"。
pub(crate) const GENERIC_MIME: &str = "application/octet-stream";

/// `ext_from_mime` 的 `Option` 版：`None` = **这张表里没有**这个 mime
/// （而不是"它就叫 `.bin`"）。`mime_and_ext` 需要区分这两件事。
fn ext_from_mime_opt(mime: &str) -> Option<&'static str> {
    match mime {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/svg+xml" => Some("svg"),
        "application/pdf" => Some("pdf"),
        // ⭐ **2026-10-28（owner：「打开 html 变成 BIN 文件」）**：同步进来的附件按 mime 定扩展名，
        //   这张表原来只有图片/PDF ⇒ `text/html` 落成 `.bin` ⇒ 系统拿它当二进制（Firefox 弹"保存文件"）✗。
        //   ⇒ 补齐最常见的几类（⛔ 不认识的一律仍落 `.bin`：那是**如实**的"我不知道这是什么"✓）。
        "text/html" => Some("html"),
        "text/plain" => Some("txt"),
        "text/markdown" => Some("md"),
        "text/csv" => Some("csv"),
        "text/css" => Some("css"),
        "application/json" => Some("json"),
        "application/javascript" | "text/javascript" => Some("js"),
        "application/zip" => Some("zip"),
        "application/msword" => Some("doc"),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => Some("docx"),
        "application/vnd.ms-excel" => Some("xls"),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => Some("xlsx"),
        "application/vnd.ms-powerpoint" => Some("ppt"),
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" => Some("pptx"),
        _ => None,
    }
}

/// ⭐ **2026-10-28（owner：「打开 html 变成 BIN 文件」）**：**交给系统打开时**用的扩展名 ——
/// 从**原始文件名**取（`xxx.html` ⇒ `html`），只认 `[a-z0-9]{1,8}`；拿不到 ⇒ `bin`。
///
/// ⚠️ 为什么按**文件名**而不是 mime：用户看到的"这一件是什么"就是名字 ✓；而 mime 可能缺失/是老值 ✓。
/// ⛔ 不把用户文件名直接拼进路径 ✗（见 [`open_stem_for`]）。
pub(crate) fn open_ext_for(name: &str) -> String {
    let ext = name
        .rsplit_once('.')
        .map(|(_, e)| e)
        .unwrap_or("")
        .to_ascii_lowercase();
    let ok = (1..=8).contains(&ext.len()) && ext.chars().all(|c| c.is_ascii_alphanumeric());
    if ok {
        ext
    } else {
        "bin".to_string()
    }
}

/// 给系统打开用的**文件名前缀**：只留字母/数字/汉字/空格/`-`/`_`/`.`，去掉路径分隔符与控制字符；
/// 限长 60（按字符）；空 ⇒ `attachment`。
///
/// ⚠️ 安全面：这个名字会被拼进临时文件路径 ⇒ ⛔ 不许出现 `/`、`\`、`..` 这些（去掉 ⇄ 替换成 `_` ✓）。
pub(crate) fn open_stem_for(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let mut out = String::new();
    for ch in base.chars() {
        if out.chars().count() >= 60 {
            break;
        }
        if ch.is_alphanumeric() || ch == ' ' || ch == '-' || ch == '_' || ch == '.' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    let trimmed = out.trim_matches([' ', '.']).to_string();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        "attachment".to_string()
    } else {
        trimmed
    }
}

fn ext_from_mime(mime: &str) -> &'static str {
    ext_from_mime_opt(mime).unwrap_or("bin")
}

/// Map a file path to (mime, extension) for general file attachments.
fn mime_from_path(path: &Path) -> (String, String) {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "tar" | "gz" => "application/gzip",
        "7z" => "application/x-7z-compressed",
        "md" | "markdown" => "text/markdown",
        "txt" => "text/plain",
        "json" => "application/json",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" => "text/javascript",
        "ts" => "text/plain",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ => "application/octet-stream",
    };
    // Keep the canonical extension for the stored filename (normalize jpeg -> jpg).
    let canonical = match ext.as_str() {
        "jpeg" => "jpg",
        "htm" => "html",
        "markdown" => "md",
        other => other,
    };
    (
        mime.to_string(),
        if canonical.is_empty() {
            "bin".to_string()
        } else {
            canonical.to_string()
        },
    )
}

/// 决定这次导入的 `(mime, ext)`。三层，逐层变弱——**桌面恒走 ①（或它的兜底）**，
/// 所以桌面行为与改这行之前逐字节一致。
///
/// ① **扩展名表**（[`mime_from_path`]）**认得**这个扩展名时就用它。
///    为什么它排在"系统说的 mime"前面：那张表是**我们自己的规范词汇**，
///    前端的 `mime === "text/markdown"` / `=== "application/pdf"` / `startsWith("image/")`
///    这些分支就是按它写的。而 `ContentResolver.getType` 可能给 `text/x-markdown`、
///    `image/x-png` 这类**非规范写法** —— 让它抢在前面会把前端**认得的**类型换成
///    **认不得的**，那是把 bug 换个方向（`.md` 的内置预览会消失）。
/// ② **系统说的 mime**（Android `ContentResolver.getType(uri)`）：扩展名表**不认识**
///    这个扩展名（含"根本没有扩展名"= Android 上那批裸 UUID）时的权威来源。
/// ③ **内容嗅探**（[`crate::magic`]）：连系统都问不到时兜底。这一层不依赖任何 Android
///    专属代码，所以"图片能预览、PDF 能进内置阅读器"能在本机单测里钉住。
///
/// 落盘扩展名 `ext` 的原则：**名字/嗅探给了就用它**（它决定
/// `attachments/<bucket>/<hash>.<ext>` 的文件名），只有完全没有时才退到
/// `ext_from_mime`（再不行 `bin`）。
fn mime_and_ext(
    src: &Path,
    system_mime: Option<&str>,
    sniffed: Option<crate::magic::Magic>,
) -> (String, String) {
    let (ext_mime, ext) = mime_from_path(src);

    if ext_mime != GENERIC_MIME {
        return (ext_mime, ext);
    }
    if let Some(sys_mime) = system_mime {
        let ext = if ext == "bin" {
            ext_from_mime(sys_mime).to_string()
        } else {
            ext
        };
        return (sys_mime.to_string(), ext);
    }
    if let Some(m) = sniffed {
        return (m.mime.to_string(), m.ext.to_string());
    }
    (ext_mime, ext)
}

/// 改名时按新名字重算 mime（语义见 [`rename_attachment`] 的文档）。
///
/// 判据只有一条：**新名字认得出类型就用它，认不出就原样保留**。
/// `mime_from_path` 认不出时给的是 `GENERIC_MIME`（`application/octet-stream`），
/// 那一支**不写回** —— 这是"永远不降级"的全部秘密：
///
/// - `report.pdf` → `report`（或 `report.unknownext`）：认不出 ⇒ 保留 `application/pdf`，
///   **PDF 阅读器不会被改名弄丢**；
/// - `x.txt` → `x.pdf`：认得出 ⇒ `application/pdf`，改名后就能进内置阅读器；
/// - 老数据（裸 UUID 名 + octet-stream，Android 导入那批）→ `photo.png`：认得出 ⇒ `image/png`，
///   用户靠改名**能自救**。
fn repaired_mime(current: &str, new_name: &str) -> String {
    let (mime, _) = mime_from_path(Path::new(new_name));
    if mime == GENERIC_MIME {
        current.to_string()
    } else {
        mime
    }
}

/// Stream-copy `src` to `dst` while computing SHA-256, without loading the
/// whole file into memory. Returns (hex hash, byte size). Invokes `on_progress`
/// after each chunk with (bytes_done, total_bytes).
fn copy_and_hash<F: FnMut(u64, u64)>(
    src: &Path,
    dst: &Path,
    mut on_progress: F,
) -> Result<(String, i64), String> {
    let total = std::fs::metadata(src).map(|m| m.len()).unwrap_or(0);
    let mut input =
        std::fs::File::open(src).map_err(|e| format!("无法打开 {}: {e}", src.display()))?;
    let mut output = std::fs::File::create(dst).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024]; // 1 MiB chunks
    let mut size: i64 = 0;
    loop {
        let n = std::io::Read::read(&mut input, &mut buf).map_err(|e| {
            let _ = std::fs::remove_file(dst);
            e.to_string()
        })?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        std::io::Write::write_all(&mut output, &buf[..n]).map_err(|e| {
            let _ = std::fs::remove_file(dst);
            e.to_string()
        })?;
        size += n as i64;
        on_progress(size as u64, total);
    }
    Ok((hex_of(&hasher.finalize()), size))
}

#[derive(Deserialize)]
pub struct SaveImageArgs {
    pub page_id: Option<String>,
    pub name: Option<String>,
    pub mime: String,
    pub data: Vec<u8>,
}

/// Resolve a single attachment by id, including its on-disk path (for the
/// "file reference card" node, which shows a snapshot of metadata and can open
/// the file with the system default app).
#[tauri::command]
pub fn get_attachment(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    id: String,
) -> Result<AttachmentMeta, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let c = db.0.lock().expect("db mutex poisoned");
    let (name, hash, mime, size): (String, String, String, i64) = c
        .query_row(
            "SELECT name, hash, mime, size FROM attachments WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|_| "附件不存在".to_string())?;
    // ★ 按空间找（`<根>/<空间>/…`），老位置（全局那份）仍回退得动。
    let path = find_attachment(&app_data_dir, &active_space_id(&c), &hash)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(AttachmentMeta {
        id,
        name,
        hash,
        mime,
        size,
        path,
    })
}

/// 按 hash 在**某个目录**里把文件读出来（"找路径 + 读字节 + 出错怎么说"三件事的纯函数）。
/// ⚠️ 生产路径现在走 [`read_attachment_bytes_at`]（按空间 + 老位置回退）；这一条**只剩判据在用**
/// （它把"桶布局/扁平布局/找不到"三种形态钉在一处）。
#[cfg(test)]
pub(crate) fn read_bytes_at(dir: &Path, hash: &str) -> Result<Vec<u8>, String> {
    let path = find_path_by_hash(dir, hash).ok_or_else(|| {
        // 说清是"文件不在盘上"，而不是笼统的"读取失败"：这一条最常见的成因是
        // 外部把文件删了/移走了，而数据库里那行还在。
        "附件文件不存在（可能被移动或删除）".to_string()
    })?;
    std::fs::read(&path).map_err(|e| format!("读取附件失败：{e}"))
}

/// **按空间**读字节：先本空间目录，再回退老位置（老库升级后仍然读得到）。
pub(crate) fn read_attachment_bytes_at(
    app_data_dir: &Path,
    space_id: &str,
    hash: &str,
) -> Result<Vec<u8>, String> {
    let path = find_attachment(app_data_dir, space_id, hash)
        .ok_or_else(|| "附件文件不存在（可能被移动或删除）".to_string())?;
    std::fs::read(&path).map_err(|e| format!("读取附件失败：{e}"))
}

#[tauri::command]
pub fn save_image(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    args: SaveImageArgs,
) -> Result<AttachmentMeta, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    // ★ 写入位置与钥匙都**按空间**（两者必须在同一把锁里取，免得中间空间被切走）。
    let space = {
        let c = db.0.lock().expect("db mutex poisoned");
        active_space_id(&c)
    };
    // ⭐ 2026-10-27（owner：「修」）：钥匙按**这个空间**取（⛔ 不用 `key_if_enabled(conn)` ✗）
    let key = space_key_for(&app_data_dir, &space);
    let attachments_dir = space_attachments_dir(&app_data_dir, &space);
    std::fs::create_dir_all(&attachments_dir).map_err(|e| e.to_string())?;

    // Content-addressed storage: filename = sha256 + ext inside a 2-char bucket dir.
    let mut hasher = Sha256::new();
    hasher.update(&args.data);
    let hash = hex_of(&hasher.finalize());
    let ext = ext_from_mime(&args.mime);
    // ⭐ 2026-10-11：落盘那几行**抽成一处**（`write_attachment_once`）⇒ 生产与判据**共用同一处** ✓
    //    ⛔ 判据不再"自己抄一份落盘逻辑"（本仓规矩：判据与被判对象同源 ✓）。行为**逐字未变** ✓。
    let (path, _wrote) =
        write_attachment_once(&attachments_dir, &hash, ext, &args.data, key.as_ref())?;

    let c = db.0.lock().expect("db mutex poisoned");

    // Return existing row if already saved (dedup by hash).
    if let Some(existing) = c
        .query_row(
            "SELECT id, name, hash, mime, size FROM attachments WHERE hash = ?1",
            params![hash],
            |row| {
                Ok(AttachmentMeta {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    hash: row.get(2)?,
                    mime: row.get(3)?,
                    size: row.get(4)?,
                    path: String::new(),
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?
    {
        return Ok(AttachmentMeta {
            path: path.to_string_lossy().into_owned(),
            ..existing
        });
    }

    let id = uuid::Uuid::new_v4().to_string();
    let filename = format!("{hash}.{ext}");
    let name = args.name.unwrap_or_else(|| filename.clone());
    let size = args.data.len() as i64;
    c.execute(
        "INSERT INTO attachments (id, page_id, name, hash, mime, size, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![id, args.page_id, name, hash, args.mime, size, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    // Sync the attachment row metadata (bytes transfer separately via sync_attachments).
    let now = now_ms();
    let payload = serde_json::json!({ "id": &id, "page_id": &args.page_id, "name": &name, "hash": &hash, "mime": &args.mime, "size": size }).to_string();
    record_change(&c, "attachment", &id, "upsert", Some(&payload), now)?;

    Ok(AttachmentMeta {
        id,
        name,
        hash,
        mime: args.mime,
        size,
        path: path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn attachment_path(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    hash: String,
) -> Result<String, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    // ★ 按空间找（老位置仍回退）。⚠️ **不做**"满树乱找"：别的空间那一份可能是**另一种密文**
    //   （那把钥匙不属于当前空间），把它交给系统去打开 = 安静地交出一个坏文件。
    let space = {
        let c = db.0.lock().expect("db mutex poisoned");
        active_space_id(&c)
    };
    // ⭐ 2026-10-27（owner：「修」）：钥匙按**这个空间**取（⛔ 不用 `key_if_enabled(conn)` ✗）
    let key = space_key_for(&app_data_dir, &space);
    let p =
        find_attachment(&app_data_dir, &space, &hash).ok_or_else(|| "附件不存在".to_string())?;
    // ⭐ **2026-10-27（owner：「补」）**：**空壳不是"有字节"** —— 如实报缺失，
    //   让渲染那一层去走 `ensureAttachmentBytes` 重取（否则它会拿到一个打不开的路径 ✓）。
    if is_empty_attachment_shell(&p, key.as_ref()) {
        return Err("这一件只有空壳（字节没取到过）—— 需要重新从对端/服务器取回".to_string());
    }
    Ok(p.to_string_lossy().into_owned())
}

/// Copy an attachment (by hash) to a user-chosen destination path (download). When app
/// encryption is on, the bytes are decrypted from disk first so the user gets the
/// plaintext file (when off, passthrough — the on-disk bytes are already plaintext).
#[tauri::command]
pub fn copy_attachment(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    hash: String,
    dest_path: String,
) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let space = {
        let c = db.0.lock().expect("db mutex poisoned");
        active_space_id(&c)
    };
    // ⭐ 2026-10-27（owner：「修」）：钥匙按**这个空间**取（⛔ 不用 `key_if_enabled(conn)` ✗）
    let key = space_key_for(&app_data_dir, &space);
    let p = find_attachment(&app_data_dir, &space, &hash).ok_or("附件不存在")?;
    // Android：保存对话框给的是 `content://` URI，`std::fs::write(uri)` 会 EROFS（真机实测）。
    // 走 SaveTarget：桌面=直接写（行为不变），URI=先写缓存再整份搬进去。
    // ⚠️ P2a/B3 复核过：`write_path()` 在**桌面**是目标本身、在 **Android URI** 目标是缓存里的
    // 真文件路径 ⇒ 两种情况下它都是**真实文件系统路径**，`fs::copy` 都能写（见 `save_target.rs`）。
    let target = crate::save_target::SaveTarget::new(&app, &dest_path, "shuyonote-att")?;
    export_attachment_to(&p, target.write_path(), key.as_ref())?;
    target.commit()
}

/// 把附件字节**以明文**落到 `write_path`。抽成纯函数就为了让"未加密 = 纯拷贝"这条能被单测钉住。
///
/// **P2a / B3（2026-09-15）**：未加密时磁盘上本来就是明文，原先却是
/// `read`（整份进内存）→ `decrypt_attachment_bytes(None, …)`（透传，还是在内存里）→ `write`，
/// **一读一写纯属白费**。这是全仓**唯一无条件**发生的整块读——导入 / 同步上传 / 同步下载
/// 都只在"用户开了静态加密"时才整块读（见 `docs/plans/2026-09-15-attachment-sync-scope-plan.md` §2.6(2)）。
/// 手机上"把传进去的视频导出到下载目录"当场 OOM 的就是它 ⇒ 改成 `fs::copy`（内核态拷贝，RSS 不随文件增长）。
///
/// ⚠️ **加密开启时仍是整块解密**，这里**不做**假优化："流式读 → 整块加密 → 流式写"并不降低
/// 峰值内存（整块 AEAD 必然要求整个明文同时在内存里）。要真流式得改成分块 AEAD ⇒ 那是 P2b，
/// 前提是**先真机实测是否真的 OOM**，且要兼容存量附件。
fn export_attachment_to(
    src: &Path,
    write_path: &Path,
    key: Option<&crate::crypto::AppKeys>,
) -> Result<(), String> {
    match key {
        // 未加密：磁盘上就是明文 ⇒ 直接拷，别把整份读进内存。
        // ⭐ 2026-10-27（owner：「修」）：但**先看头** —— 拿不到钥匙、盘上却是密文时
        //   ⛔ 不能把密文当明文拷出去（"另存为"得到乱码是比报错更坏的结局）✗
        None => {
            if head_is_ciphertext(src) {
                return Err(
                    "这一件在盘上是**密文**，但本会话拿不到\"这个空间\"的钥匙 —— 先在应用里解锁该空间再另存"
                        .to_string(),
                );
            }
            std::fs::copy(src, write_path)
                .map(|_| ())
                .map_err(|e| format!("复制失败: {e}"))
        }
        Some(k) => {
            let raw = std::fs::read(src).map_err(|e| e.to_string())?;
            let plain = crate::security::decrypt_attachment_bytes(Some(k), &raw)?;
            std::fs::write(write_path, &plain).map_err(|e| format!("复制失败: {e}"))
        }
    }
}

/// 只看**前 8 字节**判断"是不是附件密文"（大文件不整份读）。
pub(crate) fn head_is_ciphertext(path: &Path) -> bool {
    use std::io::Read;
    let Ok(mut f) = std::fs::File::open(path) else {
        return false;
    };
    let mut b = [0u8; 8];
    match f.read(&mut b) {
        Ok(n) => crate::security::looks_like_attachment_ciphertext(&b[..n]),
        Err(_) => false,
    }
}

#[tauri::command]
pub fn list_attachment_hashes(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let root = attachments_root(&app_data_dir);
    let mut hashes = Vec::new();
    // ★ 递归扫**整棵树**：`<根>/<空间>/<桶>/<hash>.<ext>`（新）、`<根>/<桶>/…` 与 `<根>/<hash>.<ext>`
    //   （老布局）三种都算 —— 这是一条"盘上到底有哪些附件字节"的读数，不该因为分层就漏。
    // ⭐ **2026-10-27（owner：「修」）**：空壳判定要**按这个文件所属空间**取钥匙 ——
    //   旧写法只有"连接自己"那一把钥匙 ⇒ 别的加密空间里的空壳用错钥匙解不开（透传成非空）
    //   ⇒ 被判成"已有字节" ⇒ 又走回"永久不重取"那条 ✗。
    for p in walk_attachment_files(&root) {
        let name = p
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        // Ignore stray .part files.
        if name.ends_with(".part") {
            continue;
        }
        if let Some(stem) = name.split('.').next() {
            if stem.len() == 64 && stem.chars().all(|c| c.is_ascii_hexdigit()) {
                // 只有小文件才需要解密判空壳（`is_empty_attachment_shell` 内部也只解 ≤64 B）。
                let small = std::fs::metadata(&p)
                    .map(|m| m.len() <= 64)
                    .unwrap_or(false);
                let shell_key = if small {
                    let space_of_file = p
                        .strip_prefix(&root)
                        .ok()
                        .and_then(|r| r.components().next())
                        .and_then(|c| c.as_os_str().to_str())
                        .filter(|s| s.len() == 36)
                        .map(str::to_string)
                        .unwrap_or_default();
                    space_key_for(&app_data_dir, &space_of_file)
                } else {
                    None
                };
                if is_empty_attachment_shell(&p, shell_key.as_ref()) {
                    // 空壳：报"没有"（下一轮会自动重取；⛔ 不能拿去短路 ✗）
                    continue;
                }
                hashes.push(stem.to_string());
            }
        }
    }
    hashes.sort();
    hashes.dedup();
    Ok(hashes)
}

#[tauri::command]
pub(crate) fn attachment_bytes(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    hash: &str,
) -> Result<Vec<u8>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let space = {
        let c = db.0.lock().expect("db mutex poisoned");
        active_space_id(&c)
    };
    plain_bytes_of(&app_data_dir, &space, hash)
}

/// 一个附件的**明文字节**（按空间取钥匙 → 读盘 → 解密 → 空壳/内容指纹校验）。
///
/// ⭐ B1c（2026-10-29）：从 [`attachment_bytes`] 里**抽出来**的 —— 能力层（`files.download`
/// 的句柄登记）没有 `AppHandle`/`State`，但它必须与界面走**同一条**字节口径
/// （尤其"密文不许当明文交出去""坏件不交"这两条）⇒ 抽成 `pub(crate)`，⛔ 不抄第二份。
pub(crate) fn plain_bytes_of(
    app_data_dir: &Path,
    space: &str,
    hash: &str,
) -> Result<Vec<u8>, String> {
    // ⭐ 2026-10-27（owner：「修」）：钥匙按**这个空间**取（⛔ 不用 `key_if_enabled(conn)` ✗）
    let key = space_key_for(app_data_dir, space);
    // 找不到文件时说清是"文件不在盘上"：这一条最常见的成因是外部把文件删了/移走了，
    // 而数据库里那行还在——笼统的"附件不存在"会让人以为是数据库的问题。
    let raw = read_attachment_bytes_at(app_data_dir, space, hash)?;
    // ⭐ **2026-10-27（owner：「修」）**：拿不到钥匙、盘上却是**密文** ⇒ 拒绝（⛔ 不把密文当明文交出去 ✗）。
    if key.is_none() && crate::security::looks_like_attachment_ciphertext(&raw) {
        return Err(
            "这一件在盘上是**密文**，但本会话拿不到\"这个空间\"的钥匙 —— 先在应用里解锁该空间"
                .to_string(),
        );
    }
    let plain = crate::security::decrypt_attachment_bytes(key.as_ref(), &raw)?;
    // ⭐ **2026-10-27（owner：「补」）**：**空壳不是"0 字节的附件"，是"字节没取到"** ——
    //   如实报缺失（调用方会去重取），⛔ 不把空字节当成内容交给渲染层 ✗。
    if plain.is_empty() && raw.len() <= 64 {
        return Err("这一件只有空壳（字节没取到过）—— 需要重新从对端/服务器取回".to_string());
    }
    // ⭐ **2026-10-27（owner：「彻底解决」）**：**读出来之前先对内容指纹** —— 文件在、大小也对，
    //   但内容是坏的（截断/串件）时，交给渲染层只会得到"看起来像正常文件"的破图/坏文档；
    //   如实报错并让调用方去重取，才是能自救的那条路 ✓。
    if !crate::sync::attachment_digest_ok(hash, &plain) {
        return Err(
            "这一件字节与**内容指纹**对不上（坏件或被截断）—— 需要重新从对端/服务器取回"
                .to_string(),
        );
    }
    Ok(plain)
}

#[tauri::command]
pub fn read_attachment_bytes(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    hash: String,
) -> Result<tauri::ipc::Response, String> {
    // 用 `Response` 回原始字节（JS 侧拿到 ArrayBuffer）而不是 `Vec<u8>`：
    // 后者会序列化成 JSON 数字数组——2 MB 的 PDF 就是两千多万字符的文本，
    // 白白让 IPC 与 webview 各扛一次巨型 JSON 解析。图片/PDF 这类"要完整字节"的
    // 调用点都受益。（纯函数 `attachment_bytes` 留给 Rust 侧自己用的调用点。）
    Ok(tauri::ipc::Response::new(attachment_bytes(app, db, &hash)?))
}

/// ⭐ **2026-10-28（owner：「打开 html 变成 BIN 文件」）**：把这一件**以正确的文件名/扩展名**
/// 落到临时目录，返回那个路径（由界面交给系统默认应用打开 ✓）。
///
/// ## 为什么必须另落一份
/// 附件是**内容寻址**存的（`<hash>.<ext>`）✓，而**同步进来的**那些扩展名是由 mime 推的 ——
/// 老表里没有 `text/html` ⇒ 落成 `<hash>.bin` ✗ ⇒ 系统把它当二进制（Firefox 直接弹"保存文件"）。
/// ⇒ 打开时按**原始文件名**取扩展名，写一份到临时目录再打开；⛔ 不改盘上那份（内容寻址的名字不许动 ✗）。
#[tauri::command]
pub fn prepare_attachment_open(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    hash: String,
    name: String,
) -> Result<String, String> {
    if !is_valid_hash(&hash) {
        return Err("附件哈希无效".to_string());
    }
    let bytes = attachment_bytes(app, db, &hash)?;
    let ext = open_ext_for(&name);
    let stem = open_stem_for(&name);
    let path = crate::tempdir::file(&stem, &ext);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn write_attachment_bytes(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    hash: String,
    mime: String,
    name: String,
    data: Vec<u8>,
) -> Result<AttachmentMeta, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let space = {
        let c = db.0.lock().expect("db mutex poisoned");
        active_space_id(&c)
    };
    // ⭐ 2026-10-27（owner：「修」）：钥匙按**这个空间**取（⛔ 不用 `key_if_enabled(conn)` ✗）
    let key = space_key_for(&app_data_dir, &space);
    let attachments_dir = space_attachments_dir(&app_data_dir, &space);
    std::fs::create_dir_all(&attachments_dir).map_err(|e| e.to_string())?;

    // `hash` is IPC-supplied and joined into a path below; validate it before
    // touching the filesystem.
    if !is_valid_hash(&hash) {
        return Err("附件哈希无效".to_string());
    }

    let ext = ext_from_mime(&mime);
    let path = bucket_path(&attachments_dir, &hash, ext);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if !path.exists() {
        let bytes = crate::security::encrypt_attachment_bytes(key.as_ref(), &data)?;
        std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    }

    let c = db.0.lock().expect("db mutex poisoned");
    let id = uuid::Uuid::new_v4().to_string();
    let size = data.len() as i64;
    c.execute(
        "INSERT OR IGNORE INTO attachments (id, page_id, name, hash, mime, size, created_at)
         VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6)",
        params![id, name, hash, mime, size, now_ms()],
    )
    .map_err(|e| e.to_string())?;

    Ok(AttachmentMeta {
        id,
        name,
        hash,
        mime,
        size,
        path: path.to_string_lossy().into_owned(),
    })
}

/// Import arbitrary files by their on-disk paths (streaming, content-addressed).
/// The file picker runs in the frontend; only the chosen paths cross the IPC
/// boundary, so arbitrarily large files never get serialized into memory.
#[tauri::command]
pub fn import_attachment_files(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    page_id: Option<String>,
    paths: Vec<String>,
) -> Result<Vec<AttachmentMeta>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    // ★ 导入进来的文件落进**当前空间**的目录（老位置只读回退，不再往里写）。
    let space = {
        let c = db.0.lock().expect("db mutex poisoned");
        active_space_id(&c)
    };
    let attachments_dir = space_attachments_dir(&app_data_dir, &space);
    std::fs::create_dir_all(&attachments_dir).map_err(|e| e.to_string())?;

    let total_files = paths.len();
    let mut results = Vec::new();
    for (index, p) in paths.into_iter().enumerate() {
        // Android：系统选择器给的是 `content://` URI，不是文件路径。先落成真实临时路径
        // （桌面原样返回、不做任何多余的事）；那份拷出来的临时文件随 `picked` 析构删除。
        // 它同时会把"这是什么文件"问清楚（名字/类型，见 `picked_file` 的模块头注释）。
        let picked = crate::picked_file::materialize(&app, &p)?;
        let src = picked.path().to_path_buf();
        // ⚠️ **名字不能用 `src.file_name()` 打头**：Android 上它是我们自己的临时文件名。
        // 改这行之前它就是**裸 UUID**，真机上列表显示成
        // `📎41449ced-… 未整理 文件 1.8 KB` —— 那就是这条 bug 的正面。
        // `effective_name()` 在桌面等价于 `src.file_name()`（选择器名字恒为 None）。
        let name = picked.effective_name();
        // mime/ext 的三层决策见 `mime_and_ext`（桌面恒走扩展名那一层，行为不变）。
        let (mime, ext) = mime_and_ext(&src, picked.system_mime(), picked.sniffed());

        // tmp lives in the flat attachments dir (part files never published); the
        // final file goes into a 2-char bucket dir once the hash is known.
        let tmp = attachments_dir.join(format!("{}.part", uuid::Uuid::new_v4()));
        let app_progress = app.clone();
        let name_progress = name.clone();
        let (hash, size) = match copy_and_hash(&src, &tmp, move |done, total| {
            let _ = app_progress.emit(
                "attachment-import-progress",
                ImportProgress {
                    index,
                    total: total_files,
                    name: name_progress.clone(),
                    done,
                    size: total,
                },
            );
        }) {
            Ok(v) => v,
            Err(e) => return Err(e),
        };

        // Recompute the final path now that the real hash is known.
        let final_path = bucket_path(&attachments_dir, &hash, &ext);
        if let Some(parent) = final_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        // ⭐ 2026-10-27（owner：「修」）：钥匙按**这个空间**取（⛔ 不用 `key_if_enabled(conn)` ✗）
        let key = space_key_for(&app_data_dir, &space);
        if final_path.exists() {
            // Content-addressed dedup **within this space**: identical file already stored
            // here (leave as-is, the read path decrypts/passthroughs).
            let _ = std::fs::remove_file(&tmp);
        } else if let Err(e) = std::fs::rename(&tmp, &final_path) {
            let _ = std::fs::remove_file(&tmp);
            return Err(e.to_string());
        } else if key.is_some() {
            // Encrypt at rest (the streamed tmp was plaintext; hash is over plaintext).
            if let Ok(plain) = std::fs::read(&final_path) {
                if let Ok(bytes) = crate::security::encrypt_attachment_bytes(key.as_ref(), &plain) {
                    let _ = std::fs::write(&final_path, &bytes);
                }
            }
        }

        let c = db.0.lock().expect("db mutex poisoned");
        let id = uuid::Uuid::new_v4().to_string();
        c.execute(
            "INSERT INTO attachments (id, page_id, name, hash, mime, size, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, page_id, name, hash, mime, size, now_ms()],
        )
        .map_err(|e| e.to_string())?;
        // Sync the attachment row metadata (bytes transfer separately via sync_attachments).
        let now = now_ms();
        let payload = serde_json::json!({ "id": &id, "page_id": &page_id, "name": &name, "hash": &hash, "mime": &mime, "size": size }).to_string();
        record_change(&c, "attachment", &id, "upsert", Some(&payload), now)?;

        results.push(AttachmentMeta {
            id,
            name,
            hash,
            mime,
            size,
            path: final_path.to_string_lossy().into_owned(),
        });
    }
    Ok(results)
}

#[tauri::command]
pub fn list_page_attachments(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    page_id: Option<String>,
) -> Result<Vec<AttachmentRow>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let c = db.0.lock().expect("db mutex poisoned");
    let space = active_space_id(&c);
    // `page_id = NULL` 永远不成立，所以「空间根下的未整理文件」必须走 IS NULL 分支。
    //
    // `created_at` 从 2026-09-19 起**选出来**：文件管理表里有「创建时间 / 上次修改时间」两列，
    // 而附件行这两列此前是前端写死的 `"—"`（用户截图报的"时间全是 —"就是这个）。
    let sql = if page_id.is_some() {
        "SELECT id, name, hash, mime, size, created_at FROM attachments
         WHERE page_id = ?1 ORDER BY created_at DESC"
    } else {
        "SELECT id, name, hash, mime, size, created_at FROM attachments
         WHERE page_id IS NULL ORDER BY created_at DESC"
    };
    let mut stmt = c.prepare(sql).map_err(|e| e.to_string())?;
    let map_row = |row: &rusqlite::Row<'_>| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, i64>(5)?,
        ))
    };
    let rows = match &page_id {
        Some(pid) => stmt.query_map(params![pid], map_row),
        None => stmt.query_map([], map_row),
    }
    .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for r in rows {
        let (id, name, hash, mime, size, created_at) = r.map_err(|e| e.to_string())?;
        let path = find_attachment(&app_data_dir, &space, &hash)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let meta = AttachmentMeta {
            id,
            name,
            hash,
            mime,
            size,
            path,
        };
        out.push(attachment_row(meta, created_at));
    }
    Ok(out)
}

/// 组装文件管理的一行：`created_at` 直接来自 DB；`mtime` 取 **`meta.path` 指向的本地文件**的修改时间，
/// **取不到就是 0**（未下载 / 路径为空 / 是目录），前端据此显示「—」。
///
/// 抽成纯函数是为了**可测**：`list_page_attachments` 需要 `tauri::AppHandle`，单元测试里造不出来，
/// 而"哪来的时间戳、取不到给什么"正是这条判据真正承重的地方。
fn attachment_row(meta: AttachmentMeta, created_at: i64) -> AttachmentRow {
    let mtime = if meta.path.is_empty() {
        0
    } else {
        std::fs::metadata(&meta.path)
            // **只认常规文件**：路径不存在、是目录、权限不足 ⇒ 一律 0（目录的 mtime 不是"这份附件的修改时间"）
            .ok()
            .filter(|m| m.is_file())
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    };
    AttachmentRow {
        meta,
        created_at,
        mtime,
    }
}

/// 文件管理那两列时间的口径判据（**跑不了 `cargo test` 的机器请交给能跑的那两台复核**，
/// 见 `docs/` 里"Windows 跑不了 cargo test"那条纪律）。
#[cfg(test)]
mod attachment_byte_free_tests {
    use super::*;
    use std::collections::HashSet;

    /// ★ 删附件字节的**跨空间**规则（2026-09-20 自查发现老实现只在当前空间里 `COUNT(*)`）：
    /// 附件目录是全局共享的，别的空间还引用同一个 hash 时**绝不能删**。
    /// 这里把三种输入直接钉住（改回"只看当前空间"这条就红）。
    #[test]
    fn bytes_are_only_freeable_when_no_other_space_references_the_hash() {
        let h = "f2534c73fa62c0a6e0e5b6c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1";
        let mut others: HashSet<String> = HashSet::new();
        others.insert(h.to_string());

        // 别的空间还在引用 ⇒ **不删**，哪怕本空间已经 0 行（老实现会删 —— 就是那条路径）。
        assert!(!bytes_are_freeable(0, &Some(others.clone()), h));

        // 别的空间没人引用、本空间也 0 行 ⇒ 才删。
        assert!(bytes_are_freeable(0, &Some(HashSet::new()), h));

        // 本空间还有别的行引用 ⇒ 不删。
        assert!(!bytes_are_freeable(1, &Some(HashSet::new()), h));

        // **读不全（None）⇒ 一律不删**：字节留着只占空间，删错就是数据丢失。
        assert!(!bytes_are_freeable(0, &None, h));
        assert!(!bytes_are_freeable(1, &None, h));
    }
}

#[cfg(test)]
mod attachment_row_tests {
    use super::*;

    fn meta(path: &str) -> AttachmentMeta {
        AttachmentMeta {
            id: "a1".into(),
            name: "营业执照扫描件.png".into(),
            hash: "h".into(),
            mime: "image/png".into(),
            size: 395 * 1024,
            path: path.into(),
        }
    }

    /// - `created_at` **总是**来自 DB（该列 NOT NULL）⇒ 任何一行都该带出来；
    /// - `mtime` 只反映**本地常规文件**：未下载（path 为空）/ 路径不是文件 ⇒ 0
    ///   （前端显示「—」，**不许**拿 created_at 冒充"上次修改时间"）；本地有文件 ⇒ 正的毫秒时间戳。
    #[test]
    fn attachment_row_carries_db_created_at_and_only_local_file_mtime() {
        // ① 未下载：path 为空
        let row = attachment_row(meta(""), 1_700_000_000_000);
        assert_eq!(
            row.created_at, 1_700_000_000_000,
            "created_at 来自 DB，永远有"
        );
        assert_eq!(row.mtime, 0, "未下载没有本地 mtime ⇒ 0（前端显示「—」）");
        assert_eq!(row.meta.name, "营业执照扫描件.png", "meta 字段要原样带出来");

        // ② 路径存在但不是文件（目录）：也不能把目录的 mtime 当成附件的
        let dir = std::env::temp_dir();
        assert_eq!(
            attachment_row(meta(&dir.to_string_lossy()), 1).mtime,
            0,
            "目录不是附件：取不到文件 mtime ⇒ 0"
        );

        // ③ 本地真的有文件 ⇒ 给出正的 mtime
        let f = std::env::temp_dir().join(format!(
            "shuyonote-attachment-row-{}-{}.bin",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&f, b"x").unwrap();
        let row = attachment_row(meta(&f.to_string_lossy()), 42);
        assert_eq!(row.created_at, 42);
        assert!(
            row.mtime > 0,
            "本地存在的文件应给出 mtime，实际 {}",
            row.mtime
        );
        let _ = std::fs::remove_file(&f);
    }
}

/// M24 — list every PDF attachment across all pages (for the command palette's
/// 「打开 PDF」entry). Sorted by most-recently-created first.
#[tauri::command]
pub fn list_all_pdf_attachments(
    app: tauri::AppHandle,
    db: State<'_, Db>,
) -> Result<Vec<AttachmentMeta>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let c = db.0.lock().expect("db mutex poisoned");
    let space = active_space_id(&c);
    let mut stmt = c
        .prepare(
            "SELECT id, name, hash, mime, size FROM attachments
             WHERE mime = 'application/pdf' ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for r in rows {
        let (id, name, hash, mime, size) = r.map_err(|e| e.to_string())?;
        let path = find_attachment(&app_data_dir, &space, &hash)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        out.push(AttachmentMeta {
            id,
            name,
            hash,
            mime,
            size,
            path,
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn remove_attachment(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    id: String,
    space_id: Option<String>,
) -> Result<usize, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let target = space_id.as_deref().map(str::trim).filter(|s| !s.is_empty());
    if let Some(space) = target {
        let active = {
            let c = db.0.lock().expect("db mutex poisoned");
            crate::workspaces::active_workspace_id(&c)?
        };
        if space != active {
            if crate::plugins::cross_space_write_disabled() {
                return Err("bad_args: 跨空间写已被 SHUYONOTE_MCP_CROSS_SPACE_WRITE 关闭（目标空间未写入）".to_string());
            }
            let c = crate::db::open_space_conn_at(space, &app_data_dir).map_err(|e| {
                format!("permission_denied: 目标空间「{space}」已锁定或无法打开（locked）：{e}")
            })?;
            // WIP：跨空间"目标空间之外"引用扫描下一轮补 ⇒ 字节不删（宁留勿删）
            return remove_attachment_in_with(&c, &app_data_dir, &id, space, &None);
        }
    }
    remove_attachment_inner(&db, &app_data_dir, &id)
}

/// **除当前空间之外**其他空间引用的 hash（严格版）；读不全 ⇒ `None` 且原因打进 stderr。
///
/// ★ 为什么删字节必须问别的空间（2026-09-20 自查发现）：附件目录是**全局共享**的内容寻址目录，
/// 老的 `SELECT COUNT(*) FROM attachments WHERE hash = ?` 只在**当前空间**里数 ⇒ 别的空间还引用着
/// 同一个字节时也会数到 0 ⇒ **把人家还在用的文件删了**（缺陷帖 #6「行在字节不在」的又一条路径）。
/// 读不全（空间打不开/密钥不符）时**宁可不删**：字节留着只占空间，删错就是数据丢失，
/// 而且 `cleanup_orphan_attachments`（同样是严格版）以后能把它收回来。
fn other_spaces_refs(db: &State<'_, Db>) -> Option<std::collections::HashSet<String>> {
    let c = db.0.lock().expect("db mutex poisoned");
    let current = match crate::workspaces::active_workspace_id(&c) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("删除附件字节：拿不到当前空间 id（{e}）⇒ 这一轮不删任何字节（宁留勿删）");
            return None;
        }
    };
    match crate::storage::other_spaces_referenced_hashes(&c, &current) {
        Ok(set) => Some(set),
        Err(unreadable) => {
            eprintln!(
                "删除附件字节：有 {} 个空间读不到 ⇒ 这一轮不删任何字节（宁留勿删，之后可用「清理孤儿附件」回收）：\n  - {}",
                unreadable.len(),
                unreadable.join("\n  - ")
            );
            None
        }
    }
}

/// 该 hash 的字节现在可以删吗？**两个条件都满足才行**：当前空间里没有别的行引用它，
/// **并且**其他空间也没有。单独拎出来是为了让这条跨空间规则有判据守着。
fn bytes_are_freeable(
    local_count: i64,
    other_refs: &Option<std::collections::HashSet<String>>,
    hash: &str,
) -> bool {
    match other_refs {
        Some(set) => local_count == 0 && !set.contains(hash),
        None => false, // 读不全 ⇒ 不删
    }
}

// Delete a single attachment row; remove its on-disk bytes only when no row **in any space**
// references the hash (true global zero-reference).
//
// ★ 2026-09-24（附件按空间分之后）：要删的字节现在是**本空间自己**那份，
//   但**老位置**（全局那份）可能还在 —— 两份都处理：
//   · 本空间那份：`other_refs` 只影响"老位置"那一份的取舍，本空间自己那份在这条规则成立时一起删；
//   · 老位置那份：**只在别的空间也不引用**时才删（`bytes_are_freeable` 的老语义，一字不改）。
fn remove_attachment_inner(
    db: &State<'_, Db>,
    app_data_dir: &Path,
    id: &str,
) -> Result<usize, String> {
    let other_refs = other_spaces_refs(db);
    remove_attachment_inner_with(db, app_data_dir, id, &other_refs)
}

/// 删一行附件，**返回实际删掉的条数**（`1` = 真删到了，`0` = 本来就没有这一行 ✓）。
///
/// ⭐ **2026-10-12（owner 拍：「丙 幂等但返回『删了 0 条』」）**：
///   · **保持幂等** —— 按 id 查不到**不是错** ✗（重复点、别处已删、跨空间同步删过都会走到这里 ✓）；
///   · 但要**如实报读数** ✓ ⇒ 让界面**自己决定**提示什么 ✓。
/// ⛔ 从前这里回 `Ok(())` ✗：前端无从分辨"真删了"和"什么都没删" ⇒ 界面照样 `toast("已移除文件")`
///   ＋ 把那一行从列表里抹掉 ⇒ **无声假成功**（重进文件管理它又回来 = 用户说的「删不掉」✓）。
///   判据：`src/components/fileManagerDelete.test.ts` 的「后端如实报告『删了 0 条』」那一格 ✓。
fn remove_attachment_inner_with(
    db: &State<'_, Db>,
    app_data_dir: &Path,
    id: &str,
    other_refs: &Option<std::collections::HashSet<String>>,
) -> Result<usize, String> {
    let c = db.0.lock().expect("db mutex poisoned");
    let space = active_space_id(&c);
    remove_attachment_in_with(&c, app_data_dir, id, &space, other_refs)
}

/// ⭐ v3-A1：单连接实现（命令层当前空间与跨空间共用；副作用全复用）。
///
/// ⚠️ 跨空间删除的"目标空间之外引用检查"尚未接入 ⇒ 调用方在跨空间时传 `other_refs=None`
/// （字节**不删**，宁留勿删；下一轮补跨空间引用扫描）。
pub(crate) fn remove_attachment_in_with(
    c: &rusqlite::Connection,
    app_data_dir: &Path,
    id: &str,
    space: &str,
    other_refs: &Option<std::collections::HashSet<String>>,
) -> Result<usize, String> {

        let hash: Option<String> = c
        .query_row(
            "SELECT hash FROM attachments WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(hash) = hash else {
        // 查不到这一行 ⇒ **幂等返回 0**（不是错 ✓，见上面的 owner 口径）。
        return Ok(0);
    };

    c.execute("DELETE FROM attachments WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    record_change(&c, "attachment", id, "delete", None, now_ms())?;

    // ⭐ 2026-10-02：**把它的派生行也清掉** —— 那两张表**没有外键** ✗，不清就留孤儿
    //   （占空间 ✓ 且可能进检索 ✓：用户会搜到已删附件的内容）。
    //   ⚠️ 走 `derived_transport`：那两张表的 SQL **只允许出现在那里** ✓
    //   （`scripts/check-derived-writers.mjs` 的意图 ✓ —— 别为了顺手在本文件里写它 ✓）。
    //   ⚠️ 清派生失败**不该**让"删附件"失败（附件已经删了 ✓）⇒ 只记读数 ✓。
    if let Err(e) = crate::derived_transport::clear_derived_for_attachment(&c, id) {
        eprintln!("清派生行失败（att_id={id}）：{e}");
    }

    // 本空间里还有别的行引用它吗？（跨空间那份在 `other_refs` 里）
    let count: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM attachments WHERE hash = ?1",
            params![hash],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    // ⚠️ 这一行**必须**带 `other_refs`：只数当前空间 = 把别的空间还在用的**老位置**字节删掉（缺陷帖 #6）。
    if bytes_are_freeable(count, other_refs, &hash) {
        if let Some(p) = find_path_by_hash(&space_attachments_dir(app_data_dir, &space), &hash) {
            let _ = std::fs::remove_file(p);
        }
        if let Some(p) = find_path_by_hash(&attachments_root(app_data_dir), &hash) {
            let _ = std::fs::remove_file(p);
        }
    }
    // 真删到了这一行 ⇒ 1（查不到那条路在上面 `return Ok(0)` ✓）。
    Ok(1)
}

/// Batch-remove attachments. Each is deleted via the same zero-reference rule:
/// its disk bytes are freed only when no row references the hash anymore.
///
/// ⭐ **2026-10-12（owner 拍的口径）**：返回值是**实际删掉的条数** ✓ —— 从前这里是
/// `removed += 1` **按传进来的 id 计** ✗ ⇒ 与 Web 那份（`src/lib/platform/web.ts` 的
/// `if (!row) continue;`）**口径不一致**，而且前端 `FileManagerView.tsx` 的
/// `if (n !== fileCount)` 那条读数提示**永远不会触发** ✗（等于这个读数一直是死的 ✓）。
#[tauri::command]
pub fn remove_attachments(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    ids: Vec<String>,
) -> Result<usize, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    // 跨空间那一份**只算一次**（批量删除时逐条重算是 O(n×空间数) 次开库）。
    let other_refs = other_spaces_refs(&db);
    let mut removed = 0usize;
    for id in &ids {
        if remove_attachment_inner_with(&db, &app_data_dir, id, &other_refs)? == 1 {
            removed += 1;
        }
    }
    Ok(removed)
}

/// Move an attachment to another folder/page container (update its page_id).
#[tauri::command]
pub fn move_attachment(db: State<'_, Db>, id: String, new_page_id: String) -> Result<(), String> {
    let c = db.0.lock().expect("db mutex poisoned");
    let exists: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pages WHERE id = ?1 AND deleted_at IS NULL)",
            params![new_page_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !exists {
        return Err("目标文件夹不存在".to_string());
    }
    let n = c
        .execute(
            "UPDATE attachments SET page_id = ?1 WHERE id = ?2",
            params![new_page_id, id],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("附件不存在".to_string());
    }
    // Sync the new folder ownership so the other device sees the move.
    let meta = c
        .query_row(
            "SELECT name, hash, mime, size FROM attachments WHERE id = ?1",
            params![id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some((name, hash, mime, size)) = meta {
        let now = now_ms();
        let payload = serde_json::json!({ "id": &id, "page_id": &new_page_id, "name": &name, "hash": &hash, "mime": &mime, "size": size }).to_string();
        record_change(&c, "attachment", &id, "upsert", Some(&payload), now)?;
    }
    Ok(())
}

/// 把附件从页面**摘掉**（`page_id` 置 NULL ⇒ 变"未整理"，**保留文件字节**）。
///
/// ⚠️ 与 delete 是两件事：delete 删这一行、字节只在没有任何引用时才释放；detach 只改归属。
pub(crate) fn detach_attachment_row(
    c: &rusqlite::Connection,
    id: &str,
) -> Result<Option<(String, Option<String>, String, i64)>, String> {
    use rusqlite::OptionalExtension;
    let page: Option<Option<String>> = c
        .query_row("SELECT page_id FROM attachments WHERE id = ?1", params![id], |r| {
            r.get::<_, Option<String>>(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(page) = page else {
        return Err("附件不存在".to_string());
    };
    if page.is_none() {
        return Err("附件已经是未整理状态（无需再摘除）".to_string());
    }
    c.execute("UPDATE attachments SET page_id = NULL WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    let meta = c
        .query_row(
            "SELECT name, hash, mime, size FROM attachments WHERE id = ?1",
            params![id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(meta.map(|(name, hash, mime, size)| (name, hash, mime, size)))
}

/// 命令内层：置空 + 记一条同步变更（需要 device id）。
pub(crate) fn detach_attachment_inner(c: &rusqlite::Connection, id: &str) -> Result<(), String> {
    let meta = detach_attachment_row(c, id)?;
    if let Some((name, hash, mime, size)) = meta {
        let now = now_ms();
        let payload = serde_json::json!({ "id": id, "page_id": serde_json::Value::Null, "name": name, "hash": hash, "mime": mime, "size": size }).to_string();
        record_change(c, "attachment", id, "upsert", Some(&payload), now)?;
    }
    Ok(())
}

/// 桌面命令：把附件从页面摘掉（变未整理，保留字节）。
#[tauri::command]
pub fn detach_attachment(db: State<'_, Db>, id: String) -> Result<(), String> {
    let c = db.0.lock().expect("db mutex poisoned");
    detach_attachment_inner(&c, &id)
}

/// Rename an attachment's display name (bytes/hash unchanged).
///
/// ## mime 随不随改名变（2026-09-17 定的语义，别改回去）
///
/// **按新名字重算**，但只有一条判据：新名字**认得出类型**才写回（[`repaired_mime`]）。
/// 于是两件事同时成立：
///
/// - `x.txt` 改成 `x.pdf` ⇒ 立刻能进内置 PDF 阅读器；老数据（裸 UUID + octet-stream）
///   改成 `photo.png` ⇒ 用户能自救。改名这条路上"用户敲的扩展名"是**显式声明**，
///   该被采信。
/// - 改成一个**认不出**的名字（`report.pdf` → `report`、或改成 `.unknownext`）⇒
///   **原样保留**原来的 mime。改名永远不会把已知类型降级成 `application/octet-stream`
///   —— 否则把 `report.pdf` 改成 `report` 就能把 PDF 阅读器弄丢，那才是把能用的东西改坏。
#[tauri::command]
pub fn rename_attachment(
    db: State<'_, Db>,
    id: String,
    name: String,
    space_id: Option<String>,
) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("名称不能为空".to_string());
    }
    let target = space_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if let Some(space) = target {
        let active = {
            let c = db.0.lock().expect("db mutex poisoned");
            crate::workspaces::active_workspace_id(&c)?
        };
        if space != active {
            if crate::plugins::cross_space_write_disabled() {
                return Err("bad_args: 跨空间写已被 SHUYONOTE_MCP_CROSS_SPACE_WRITE 关闭（目标空间未写入）".to_string());
            }
            let app_data = crate::db::app_data_dir_ref()
                .ok_or_else(|| "bad_args: app data dir 未初始化".to_string())?;
            let c = crate::db::open_space_conn_at(&space, app_data).map_err(|e| {
                format!("permission_denied: 目标空间「{space}」已锁定或无法打开（locked）：{e}")
            })?;
            return rename_attachment_in(&c, &id, &name);
        }
    }
    let c = db.0.lock().expect("db mutex poisoned");
    rename_attachment_in(&c, &id, &name)
}

/// `rename_attachment` 的单连接实现（当前/跨空间同一份；副作用全复用）。
pub(crate) fn rename_attachment_in(
    c: &rusqlite::Connection,
    id: &str,
    name: &str,
) -> Result<(), String> {
    let name = name.trim().to_string();
    // 先在**同一个锁**里读出来：下面的 UPDATE 会用当前 mime 决定新 mime，
    // 两次查询之间不能被别人插进来改掉。
    let meta = c
        .query_row(
            "SELECT page_id, hash, mime, size FROM attachments WHERE id = ?1",
            params![id],
            |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((page_id, hash, cur_mime, size)) = meta else {
        return Err("附件不存在".to_string());
    };
    let mime = repaired_mime(&cur_mime, &name);
    c.execute(
        "UPDATE attachments SET name = ?1, mime = ?2 WHERE id = ?3",
        params![name, mime, id],
    )
    .map_err(|e| e.to_string())?;
    // 同步新名称到其它设备（字节/hash 不变）。
    {
        let now = now_ms();
        let payload = serde_json::json!({ "id": &id, "page_id": page_id, "name": &name, "hash": &hash, "mime": &mime, "size": size }).to_string();
        record_change(&c, "attachment", &id, "upsert", Some(&payload), now)?;
    }
    Ok(())
}

/// Restore a historical version: clone the given attachment (by content hash) as
/// a NEW current attachment in `target_page_id`, so the chosen version becomes
/// the newest same-named file. Content-addressed bytes are shared (no rewrite).
#[tauri::command]
pub fn restore_attachment(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    target_page_id: String,
    source_id: String,
) -> Result<AttachmentMeta, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let c = db.0.lock().expect("db mutex poisoned");
    let space = active_space_id(&c);
    let (name, hash, mime, size): (String, String, String, i64) = c
        .query_row(
            "SELECT name, hash, mime, size FROM attachments WHERE id = ?1",
            params![source_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .map_err(|_| "附件不存在".to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    c.execute(
        "INSERT INTO attachments (id, page_id, name, hash, mime, size, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![id, target_page_id, name, hash, mime, size, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    // Sync the restored attachment as a new row (bytes are shared by content hash).
    let now = now_ms();
    let payload = serde_json::json!({ "id": &id, "page_id": &target_page_id, "name": &name, "hash": &hash, "mime": &mime, "size": size }).to_string();
    record_change(&c, "attachment", &id, "upsert", Some(&payload), now)?;
    let path = find_attachment(&app_data_dir, &space, &hash)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(AttachmentMeta {
        id,
        name,
        hash,
        mime,
        size,
        path,
    })
}

#[cfg(test)]
mod read_bytes_tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "shuyonote-att-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reads_bucketed_and_flat_attachments_and_says_what_is_missing() {
        let dir = temp_dir("read-bytes");
        let hash = "12d785817fcddf344ac33a36113281c27867c85b385f96771410b3ddccb3d223";
        // 分桶布局（新）
        let bucket = dir.join(&hash[..2]);
        std::fs::create_dir_all(&bucket).unwrap();
        std::fs::write(bucket.join(format!("{hash}.pdf")), b"%PDF-1.4 bucketed").unwrap();
        assert_eq!(read_bytes_at(&dir, hash).unwrap(), b"%PDF-1.4 bucketed");

        // 扁平布局（旧）：同一个 hash 也读得到
        let flat = temp_dir("read-bytes-flat");
        let h2 = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
        std::fs::write(flat.join(format!("{h2}.png")), b"flat bytes").unwrap();
        assert_eq!(read_bytes_at(&flat, h2).unwrap(), b"flat bytes");

        // 找不到时要说清是"文件不在盘上"，而不是笼统的读取失败
        let err = read_bytes_at(&dir, h2).unwrap_err();
        assert!(err.contains("附件文件不存在"), "{err}");

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&flat);
    }
}

/// ★★ **附件库按空间分**（owner 2026-09-24 拍板 ②）—— 这一组判据钉的是"缺口真的没了"。
///
/// 缺口原话（收口前）：附件是**全局一份**内容寻址，而钥匙按空间 ⇒ 同一份内容被
/// "一个加密空间 ＋ 一个明文空间"同时引用时，**谁先落盘谁决定那份字节是密文还是明文**，
/// 后读的那一方解不开会被透传（安静地交出坏文件）。
#[cfg(test)]
mod per_space_layout_tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "shuyonote-attspace-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 按空间**写**一份（与命令里那条写入路径同形状：`<根>/<空间>/<桶>/<hash>.<ext>`）。
    fn put(app_data_dir: &Path, space: &str, hash: &str, bytes: &[u8]) -> PathBuf {
        let dir = space_attachments_dir(app_data_dir, space);
        let path = bucket_path(&dir, hash, "bin");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, bytes).unwrap();
        path
    }

    /// ① ★ 同一条 hash 在两个空间里**各自一份**：路径不同、字节不同（＝缺口不存在了）。
    /// 这条就是本次改动的**承重判据**：改回"全局一份"（`find_attachment` 退化成只查根）就红。
    #[test]
    fn the_same_hash_is_two_independent_files_in_two_spaces() {
        let app = temp_root("two-spaces");
        let hash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

        let a = put(&app, "space-a", hash, b"ciphertext written by A");
        let b = put(&app, "space-b", hash, b"plaintext written by B");
        assert_ne!(a, b, "两个空间必须是两份文件（而不是共用一份）");

        // 各读各的：谁也不会拿到对方那份
        assert_eq!(find_attachment(&app, "space-a", hash).unwrap(), a);
        assert_eq!(find_attachment(&app, "space-b", hash).unwrap(), b);
        assert_eq!(
            read_attachment_bytes_at(&app, "space-a", hash).unwrap(),
            b"ciphertext written by A"
        );
        assert_eq!(
            read_attachment_bytes_at(&app, "space-b", hash).unwrap(),
            b"plaintext written by B"
        );

        // 路径也必须**在各自空间目录下**（不是"两个名字指向同一处"）
        assert!(a.starts_with(space_attachments_dir(&app, "space-a")));
        assert!(b.starts_with(space_attachments_dir(&app, "space-b")));

        let _ = std::fs::remove_dir_all(&app);
    }

    /// ② 老位置（全局那份）**照样读得到** —— 升级不搬文件，谁都不会因为分层而丢附件。
    #[test]
    fn a_legacy_global_file_is_still_readable_from_any_space() {
        let app = temp_root("legacy");
        let root = attachments_root(&app);
        let hash = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
        // 老布局两种形态：分桶 ＋ 扁平
        let bucketed = root.join(&hash[..2]).join(format!("{hash}.png"));
        std::fs::create_dir_all(bucketed.parent().unwrap()).unwrap();
        std::fs::write(&bucketed, b"legacy bucketed").unwrap();
        let flat_hash = "0011223344556677889900112233445566778899001122334455667788990011";
        std::fs::write(root.join(format!("{flat_hash}.png")), b"legacy flat").unwrap();

        for space in ["space-a", "space-b"] {
            assert_eq!(
                read_attachment_bytes_at(&app, space, hash).unwrap(),
                b"legacy bucketed",
                "{space} 应当回退读到老位置那份"
            );
            assert_eq!(
                read_attachment_bytes_at(&app, space, flat_hash).unwrap(),
                b"legacy flat",
                "{space} 应当回退读到老位置（扁平）那份"
            );
        }
        // 而**写**永远落在空间目录里（`space_attachments_dir` 不改老位置）
        let mine = put(&app, "space-a", hash, b"mine");
        assert_eq!(
            read_attachment_bytes_at(&app, "space-a", hash).unwrap(),
            b"mine",
            "本空间那份优先"
        );
        assert_eq!(
            read_attachment_bytes_at(&app, "space-b", hash).unwrap(),
            b"legacy bucketed",
            "别的空间不受影响"
        );
        assert!(mine.starts_with(space_attachments_dir(&app, "space-a")));

        let _ = std::fs::remove_dir_all(&app);
    }

    /// ③ 统计/清理那几条路要能看见**所有布局**（递归遍历），否则按空间分之后它们会漏掉新目录。
    #[test]
    fn walking_the_tree_covers_every_layout() {
        let app = temp_root("walk");
        let root = attachments_root(&app);
        let h_new = "1111111111111111111111111111111111111111111111111111111111111111";
        let h_old = "2222222222222222222222222222222222222222222222222222222222222222";
        let h_flat = "3333333333333333333333333333333333333333333333333333333333333333";

        put(&app, "space-a", h_new, b"new layout");
        std::fs::create_dir_all(root.join(&h_old[..2])).unwrap();
        std::fs::write(
            root.join(&h_old[..2]).join(format!("{h_old}.bin")),
            b"old bucketed",
        )
        .unwrap();
        std::fs::write(root.join(format!("{h_flat}.bin")), b"old flat").unwrap();

        let mut found: Vec<String> = walk_attachment_files(&root)
            .iter()
            .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
            .collect();
        found.sort();
        assert_eq!(
            found,
            vec![
                format!("{h_new}.bin"),
                format!("{h_old}.bin"),
                format!("{h_flat}.bin")
            ],
            "三种布局都要被遍历到（统计/孤儿清理靠它）"
        );
        // `find_attachment_anywhere`：不知道空间时也找得到（存储/清理那两条路用）
        assert!(
            find_attachment_anywhere(&root, h_new).is_some(),
            "新布局找得到"
        );
        assert!(
            find_attachment_anywhere(&root, h_old).is_some(),
            "老桶布局找得到"
        );
        assert!(
            find_attachment_anywhere(&root, h_flat).is_some(),
            "老扁平布局找得到"
        );

        let _ = std::fs::remove_dir_all(&app);
    }

    /// ④ 空间 id **不许**穿出附件树（`is_safe_space_id` 把关）。
    #[test]
    fn a_hostile_space_id_cannot_escape_the_attachments_tree() {
        let app = temp_root("traversal");
        let dir = space_attachments_dir(&app, "../../evil");
        assert!(
            dir.starts_with(attachments_root(&app)),
            "空间 id 进路径前必须过白名单，实际：{}",
            dir.display()
        );
        let _ = std::fs::remove_dir_all(&app);
    }
}

/// **P2a / B3 的门禁**：导出（下载 / 另存为）分两条路，且**未加密那条必须是纯拷贝**。
#[cfg(test)]
mod export_attachment_tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "shuyonote-att-export-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 未加密：导出的就是**逐字节相同**的原文件。
    ///
    /// 这条同时是"改成 `fs::copy` 之后行为没变"的判据——因为本分支原先走的是
    /// `read` → `decrypt_attachment_bytes(None, …)`（透传）→ `write`，产物必须一模一样。
    #[test]
    fn unencrypted_export_is_a_byte_for_byte_copy() {
        let dir = temp_dir("plain");
        let src = dir.join("12d785817fcddf344ac33a36113281c27867c85b385f96771410b3ddccb3d223.mp4");
        let dst = dir.join("out.mp4");
        // 比一页大的内容：整块读的老实现在这里会把整份读进内存，拷贝路径不会。
        let payload: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&src, &payload).unwrap();

        export_attachment_to(&src, &dst, None).unwrap();

        assert_eq!(
            std::fs::read(&dst).unwrap(),
            payload,
            "未加密导出必须逐字节相同"
        );
        // 源文件仍在（导出是"另存一份"，不是"搬走"）。
        assert!(src.exists(), "导出不能动源文件");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 加密开启：磁盘上是密文，导出的必须是**明文**（否则用户拿到一个解不开的文件）。
    #[test]
    fn encrypted_export_decrypts_to_plaintext() {
        let dir = temp_dir("enc");
        let src = dir.join("aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899.pdf");
        let dst = dir.join("out.pdf");
        let key = crate::crypto::AppKeys::legacy_only([7u8; 32]);
        let plain = b"%PDF-1.7 real content";
        // 磁盘上存密文（与 security::encrypt_attachment_bytes 的落盘格式一致）。
        std::fs::write(
            &src,
            crate::security::encrypt_attachment_bytes(Some(&key), plain).unwrap(),
        )
        .unwrap();

        export_attachment_to(&src, &dst, Some(&key)).unwrap();

        assert_eq!(
            std::fs::read(&dst).unwrap(),
            plain,
            "加密导出必须解密成明文"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 默认构建（2026-09-20 起国密即默认）：磁盘上那份是 **v2（SM4-CBC ＋ HMAC-SM3）**，
    /// 导出的仍必须逐字节是**明文**。"导出包"这条路径最容易漏 —— 它读的是同一份文件，
    /// 但走的是"解密出来给人"（`export_attachment_to`），与附件预览不是同一段代码。
    #[cfg(feature = "sm-crypto")]
    #[test]
    fn encrypted_export_under_national_crypto_decrypts_to_plaintext() {
        let dir = temp_dir("enc-sm");
        let src = dir.join("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff.pdf");
        let dst = dir.join("out.pdf");
        let keys = crate::crypto::derive_app_keys("pw", &crate::crypto::random_salt()).unwrap();
        assert!(keys.sm.is_some(), "国密构建下派生出来必须有国密密钥");
        let plain = b"%PDF-1.7 national crypto content";
        let on_disk = crate::security::encrypt_attachment_bytes(Some(&keys), plain).unwrap();
        assert_eq!(
            &on_disk[..2],
            &[crate::crypto::MAGIC, crate::crypto::VERSION_SM4],
            "落盘的那份没写成国密 ⇒ 这条用例根本没测到国密路径"
        );
        std::fs::write(&src, &on_disk).unwrap();

        export_attachment_to(&src, &dst, Some(&keys)).unwrap();

        assert_eq!(
            std::fs::read(&dst).unwrap(),
            plain,
            "国密导出必须解密成明文"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// 「Android 导入的附件没有名字也没有类型」那条 bug 的**门禁**。
///
/// 真机症状：列表显示 `📎41449ced-… 未整理 文件 1.8 KB`，点它进不了内置预览
/// （`FileManagerView`/`PageTree` 都按 `file.mime` 分支），PDF 也进不了阅读器。
/// 这里钉住的就是**修好之后必须成立的那几件事**。
#[cfg(test)]
mod picked_mime_tests {
    use super::*;
    use crate::magic::Magic;

    /// 一段真实的 PNG 开头（签名 + IHDR 长度/类型）。
    const PNG_HEAD: &[u8] = &[
        0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, b'I', b'H', b'D',
        b'R',
    ];

    /// **本 bug 的核心断言**：一个**没有扩展名**的临时文件（= Android 上那个裸 UUID），
    /// 只要内容嗅探认出是 PNG，mime 就必须是 `image/png` —— 前端那条
    /// `mime.startsWith("image/")` 分支才会亮，内置预览才进得去。
    #[test]
    fn an_extensionless_png_gets_image_png() {
        let src = Path::new("/tmp/picked/41449ced-d44e-4d3c-8e14-7c6733ad042a");
        let sniffed = crate::magic::sniff(PNG_HEAD);
        assert_eq!(
            sniffed.map(|m| m.ext),
            Some("png"),
            "前提：这段字节确实是 PNG"
        );

        let (mime, ext) = mime_and_ext(src, None, sniffed);
        assert_eq!(mime, "image/png");
        assert_eq!(ext, "png");
    }

    /// 一整个 PDF 也一样要能进内置阅读器（`PageTree` 判的是 `application/pdf`）。
    #[test]
    fn an_extensionless_pdf_gets_application_pdf() {
        let src = Path::new("/tmp/picked/41449ced-d44e-4d3c-8e14-7c6733ad042a");
        let (mime, ext) = mime_and_ext(src, None, crate::magic::sniff(b"%PDF-1.7\n"));
        assert_eq!(mime, "application/pdf");
        assert_eq!(ext, "pdf");
    }

    /// 系统说的 mime 在**扩展名表不认识**时接手：它能认出表里没有的类型，
    /// 而且拿不到扩展名时落盘扩展名要跟着它走（`<hash>.<ext>` 里的 `<ext>` 由这里定）。
    #[test]
    fn the_system_mime_takes_over_where_the_extension_table_gives_up() {
        let bare = Path::new("/tmp/picked/41449ced");
        assert_eq!(
            mime_and_ext(bare, Some("image/png"), None),
            ("image/png".to_string(), "png".to_string())
        );
        // 表里没有的类型（opus）也照系统说的走
        assert_eq!(
            mime_and_ext(bare, Some("audio/opus"), None),
            ("audio/opus".to_string(), "bin".to_string())
        );
        // 表**不认识**的扩展名：mime 用系统说的，扩展名仍用名字给的那个
        assert_eq!(
            mime_and_ext(Path::new("/tmp/picked/x.opus"), Some("audio/opus"), None),
            ("audio/opus".to_string(), "opus".to_string())
        );
        // 表认识的扩展名：与桌面同一条路
        assert_eq!(
            mime_and_ext(Path::new("/tmp/picked/x.webp"), Some("image/webp"), None),
            ("image/webp".to_string(), "webp".to_string())
        );
    }

    /// **不能把前端认得的类型换成认不得的**：`ContentResolver.getType` 会给出
    /// `text/x-markdown` 这类非规范写法，而前端的 markdown 内置预览判的是**恰好等于**
    /// `text/markdown`。所以扩展名表（我们自己的规范词汇）必须先说话。
    #[test]
    fn a_non_canonical_system_mime_must_not_replace_our_canonical_one() {
        assert_eq!(
            mime_and_ext(
                Path::new("/tmp/picked/notes.md"),
                Some("text/x-markdown"),
                None
            ),
            ("text/markdown".to_string(), "md".to_string())
        );
        assert_eq!(
            mime_and_ext(Path::new("/tmp/picked/a.png"), Some("image/x-png"), None),
            ("image/png".to_string(), "png".to_string())
        );
        assert_eq!(
            mime_and_ext(
                Path::new("/tmp/picked/a.pdf"),
                Some("application/x-pdf"),
                None
            ),
            ("application/pdf".to_string(), "pdf".to_string())
        );
    }

    /// **桌面逐字节不变**的门禁：没有系统答案、没有嗅探时，走的必须是原来那条
    /// 扩展名表 —— 逐个类型对一遍，防止有人以后把优先级改错。
    #[test]
    fn without_any_android_layer_the_extension_table_still_decides() {
        for (path, mime, ext) in [
            ("/tmp/a.png", "image/png", "png"),
            ("/tmp/a.jpeg", "image/jpeg", "jpg"),
            ("/tmp/a.zip", "application/zip", "zip"),
            ("/tmp/a.md", "text/markdown", "md"),
            (
                "/tmp/a.docx",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "docx",
            ),
            // 认不出来的扩展名与**没有**扩展名：都是 octet-stream + bin（与今天一致）
            (
                "/tmp/a.unknownext",
                "application/octet-stream",
                "unknownext",
            ),
            (
                "/tmp/41449ced-d44e-4d3c-8e14-7c6733ad042a",
                "application/octet-stream",
                "bin",
            ),
        ] {
            assert_eq!(
                mime_and_ext(Path::new(path), None, None),
                (mime.to_string(), ext.to_string()),
                "{path}"
            );
        }
    }

    /// 嗅探只有在**完全没有扩展名**时才允许开口：有扩展名时它不得推翻扩展名表
    /// （否则同一个 hash 的老数据会从 `<hash>.bin` 漂到 `<hash>.png`，多出孤儿文件）。
    #[test]
    fn sniffing_never_overrides_a_real_extension() {
        let sniffed = Some(Magic {
            mime: "image/png",
            ext: "png",
        });
        assert_eq!(
            mime_and_ext(Path::new("/tmp/a.pdf"), None, sniffed),
            ("application/pdf".to_string(), "pdf".to_string())
        );
    }

    /// 改名那条语义（见 [`rename_attachment`] 的文档）：**按新名字重算，但永不降级**。
    #[test]
    fn renaming_recomputes_from_the_new_name_but_never_downgrades() {
        // ① 老数据（Android 导入那批：名字是裸 UUID、mime 是 octet-stream）改名成 .png ⇒ 救回来
        assert_eq!(repaired_mime(GENERIC_MIME, "photo.png"), "image/png");
        assert_eq!(repaired_mime(GENERIC_MIME, "photo.jpeg"), "image/jpeg");
        // ② 已知类型改成另一个**认得**的扩展名 ⇒ 采信用户敲的那个（改名 .txt→.pdf 之后
        //    要能进内置 PDF 阅读器，这是这条语义存在的理由）
        assert_eq!(repaired_mime("text/plain", "notes.pdf"), "application/pdf");
        assert_eq!(repaired_mime("text/markdown", "readme.md"), "text/markdown");
        // ③ **永不降级**：新名字认不出类型时原样保留 —— 否则 `report.pdf` 改成 `report`
        //    就能把 PDF 阅读器弄丢，那是把能用的东西改坏
        assert_eq!(
            repaired_mime("application/pdf", "report"),
            "application/pdf"
        );
        assert_eq!(
            repaired_mime("image/png", "whatever.unknownext"),
            "image/png"
        );
        assert_eq!(
            repaired_mime("application/pdf", "41449ced-d44e"),
            "application/pdf"
        );
        // ④ 认不出 → 仍然认不出：维持"不知道"，不编
        assert_eq!(repaired_mime(GENERIC_MIME, "file.unknownext"), GENERIC_MIME);
    }

    /// `sniff_file` 要真的读盘（`materialize` 用它给无扩展名的临时文件补扩展名）。
    #[test]
    fn sniff_file_reads_from_disk() {
        let dir = std::env::temp_dir().join(format!(
            "shuyonote-sniff-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        // 名字是裸 UUID、没有扩展名 —— 与 Android 上落下来的那个临时文件同形
        let bare = dir.join("41449ced-d44e-4d3c-8e14-7c6733ad042a");
        std::fs::write(&bare, PNG_HEAD).unwrap();
        assert_eq!(
            crate::magic::sniff_file(&bare).map(|m| m.mime),
            Some("image/png")
        );

        // 读不到的文件返回 None，不 panic（导入路径上"问不到"不能变成"导入失败"）
        assert_eq!(crate::magic::sniff_file(&dir.join("nope")), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// ⭐⭐ **2026-10-11：附件"跨空间同内容"这两条判据**（⚠️ 第一版**夹具写错了** ✗，已订正 ✓）
//
// ⚠️⚠️⭐ **诚实的记录（我自己的错，留在这里免得后人重犯）**：
//   · 我当时的诊断是「注释说去重按空间、实现却是全局路径 ⇒ 两个空间会共用一个文件」✗ ——
//     ⭐ **那是错的** ✓：`bucket_path` 本身确实不含空间 id ✓，但**调用方给的是空间目录**
//     （`save_image` 传 `space_attachments_dir(&app_data_dir, &space)` ✓）。
//   · 我**只读了 `bucket_path` 一层就下了结论** ✗，⭐ 而**判据的夹具也跟着错**：两条都往**同一个 dir** 写 ✓
//     ⇒ 红得理所当然、⭐ 但**跟生产无关** ✓（就是"拿一个不成立的夹具证明一个不存在的 bug" ✗）。
//   · ⭐ 真相：**owner 2026-09-24 已经拍板过「附件库按空间分」** ✓，⭐ 实现就在本文件
//     `space_attachments_dir`（L127）＋ `find_attachment`（L142）＋ `save_image` 那行 ✓ ⇒
//     ⭐ **"按空间隔离 ＋ 读路径分岔 ＋ 老布局双读回退"这套**早就落地了** ✓**。
//
// ⭐ 这两条判据现在按**生产接线**钉两件事（⭐ 都钉结果、⛔ 不钉实现 ⇒ 改实现不会把它们弄红 ✓）：
//   ① 同一份内容，⭐ 加密空间先写 ⇒ **明文空间仍读得回原字节** ✓（⛔ 不许拿到密文 ✗）
//      ＋ ⭐ 两边的落点**不是同一个文件** ✓（⭐ 这才是"按空间分"的要害 ✓）
//   ② 同一份内容，⭐ 两空间各写一份 ⇒ ⭐ 加密那份**是密文且解得回** ✓、⭐ 明文那份**还是明文** ✓、
//      ⭐ 且两者**不共用文件** ✓
//
// ⚠️ **残留（已知、⭐ owner 拍过）**：`find_attachment` 找不到自己那份时会**回退到老根布局** ✓
//    （2026-09-24「老文件不搬」✓）⇒ ⭐ 加密空间**仍可能读到老布局里的明文** ✓，⭐ 但它**永不**再往根写 ✓。
//
// 跑法（本机 Windows；⭐ 只跑这两条 ✓）：
//   powershell -File _tmp\scratch\mesh-lib-test.ps1 -Filter "cross_space_same_content"
// ═══════════════════════════════════════════════════════════════════════════════════════════
#[cfg(test)]
mod cross_space_attachment_tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "shuyonote-xspace-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 与 `save_image` 同一把尺子（`hex_of(sha256(明文))` ⇒ ⛔ 不是照密文算的 ✓）。
    fn hash_of(data: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(data);
        hex_of(&hasher.finalize())
    }

    fn app_key() -> crate::crypto::AppKeys {
        crate::crypto::AppKeys::legacy_only([7u8; 32])
    }

    /// ① 功能那一半：**加密空间先写** ⇒ 明文空间再引用同一内容 ⇒ 它必须读得回原字节。
    #[test]
    fn cross_space_same_content_keeps_plaintext_space_readable() {
        let plain: &[u8] = b"\x89PNG\r\n\x1a\nSAME-CONTENT-ACROSS-TWO-SPACES";
        let hash = hash_of(plain);
        let k = app_key();
        // ⚠️⚠️⭐ **2026-10-11 交付订正（重要）**：这两条判据**第一版的夹具是错的** ✗ ——
        //    它把"两个空间"都写进**同一个 dir**（`write_attachment_once(&dir, …)` 两次 ✓）⇒
        //    ⭐ 那**不是生产接线** ✗：生产里 `save_image` 传的是 `space_attachments_dir(&app_data_dir, &space)`
        //    （⭐ 每个空间**自己的**目录 ✓，见 `save_image` 里那一行 ✓）⇒ ⭐ 于是判据红得**毫无意义** ✗。
        //    ⇒ ⭐ 现在改成**生产接线**：⭐ 两个空间各自 `space_attachments_dir(...)` ✓ ＋ ⭐ 读走
        //      `find_attachment(root, space, hash)`（⭐ 正是生产那条：⭐ 先自己目录、⭐ 再回退老根 ✓）。
        //    ⭐ 结论（下面断言钉着）：⭐ **同一份内容在两个空间里是**两个文件**** ✓ ⇒ 谁先写不影响谁 ✓。
        let root = temp_dir("fn");
        let enc_dir = space_attachments_dir(&root, "space-enc");
        let plain_dir = space_attachments_dir(&root, "space-plain");
        std::fs::create_dir_all(&enc_dir).unwrap();
        std::fs::create_dir_all(&plain_dir).unwrap();

        // ① 加密空间先存这一份内容（⭐ 走生产那一处 ✓）
        write_attachment_once(&enc_dir, &hash, "png", plain, Some(&k)).unwrap();
        // ② 明文空间再引用同一份内容（⭐ 同样走生产那一处 ✓）
        write_attachment_once(&plain_dir, &hash, "png", plain, None).unwrap();

        // ③ 明文空间把它读回来 —— 生产路径就是"无钥匙 ⇒ `decrypt_attachment_bytes(None, …)` 透传"
        let p_plain =
            find_attachment(&root, "space-plain", &hash).expect("明文空间必须找得到自己那份");
        let raw = std::fs::read(&p_plain).unwrap();
        let got = crate::security::decrypt_attachment_bytes(None, &raw).unwrap();
        assert_eq!(
            got, plain,
            "⭐ 明文空间必须拿回**原字节** —— 拿到的是密文 ⇒ 用户看到**坏图** ✗（两个空间共用一个文件才会这样）"
        );
        // ⭐ 反证那一半：两边**不是同一个文件** ✓（⭐ 这就是 2026-09-24「按空间分」那条拍板的要害 ✓）
        let p_enc = find_attachment(&root, "space-enc", &hash).expect("加密空间也该找得到自己那份");
        assert_ne!(
            p_enc, p_plain,
            "⭐ 两个空间**不许**共用同一个文件 ✗ —— ⭐ 共用了就是「谁先写谁说了算」✓（那条缺口 2026-09-24 就该堵上了 ✓）"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// ② 隐私那一半：**明文空间先写** ⇒ 加密空间再引用同一内容 ⇒ 盘上那份**不许还是明文**。
    #[test]
    fn cross_space_same_content_does_not_leave_plaintext_for_encrypted_space() {
        let plain: &[u8] = b"\x89PNG\r\n\x1a\nSAME-CONTENT-ACROSS-TWO-SPACES";
        let hash = hash_of(plain);
        let k = app_key();
        let root = temp_dir("pv");
        let plain_dir = space_attachments_dir(&root, "space-plain");
        let enc_dir = space_attachments_dir(&root, "space-enc");
        std::fs::create_dir_all(&plain_dir).unwrap();
        std::fs::create_dir_all(&enc_dir).unwrap();

        write_attachment_once(&plain_dir, &hash, "png", plain, None).unwrap(); // 明文空间先写
        write_attachment_once(&enc_dir, &hash, "png", plain, Some(&k)).unwrap(); // 加密空间再引用

        // ⭐ 加密空间那一份：⭐ 在**它自己**的目录里，⭐ 而且**不许是明文** ✓
        let p_enc = find_attachment(&root, "space-enc", &hash).expect("加密空间该找得到自己那份");
        let raw_enc = std::fs::read(&p_enc).unwrap();
        assert_ne!(
            raw_enc, plain,
            "⭐ 加密空间那份**不许是明文** ✗（⭐ 也不许复用明文空间那份 ✓ —— 每空间各存自己的 ✓）"
        );
        let got = crate::security::decrypt_attachment_bytes(Some(&k), &raw_enc).unwrap();
        assert_eq!(
            got, plain,
            "而且它必须**解得回原字节**（⛔ 不是随便加密一下就算 ✓）"
        );
        // ⭐ 明文空间那份仍是明文、⭐ 且与加密那份**不是同一个文件** ✓
        let p_plain =
            find_attachment(&root, "space-plain", &hash).expect("明文空间也该找得到自己那份");
        assert_ne!(p_enc, p_plain, "两边不许共用同一个文件 ✗");
        assert_eq!(
            std::fs::read(&p_plain).unwrap(),
            plain,
            "明文空间那份必须还是明文 ✓"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// ⭐⭐ **2026-10-25**：空目录要能被收掉 —— **只收空的**、**整枝收**、⛔ **根永远不删**。
    ///
    /// 真机来由：删文件不删目录 ⇒ 261 个目录里 135 个是空的（74 个老桶 ＋ 61 个空的空间目录）。
    ///
    /// **变异**：把 `if dir != root` 去掉 ⇒ 根被删 ⇒ 最后一条断言红。
    #[test]
    fn pruning_removes_only_empty_dirs_and_never_the_root() {
        let dir = temp_dir("prune");
        let root = attachments_root(&dir);
        std::fs::create_dir_all(root.join("aa")).unwrap(); // 空桶
        std::fs::create_dir_all(root.join("bb").join("cc")).unwrap(); // 空的两层
        std::fs::create_dir_all(root.join("sp-1").join("dd")).unwrap(); // 空间目录里的空桶
        std::fs::write(root.join("sp-1").join("dd").join("keep.png"), b"x").unwrap(); // 非空

        let n = prune_empty_dirs_under(&root);
        assert!(root.is_dir(), "⛔ 根目录不许删（那会把整棵树弄没）");
        assert!(!root.join("aa").exists(), "空桶该收");
        assert!(!root.join("bb").exists(), "空的两层该整枝收掉");
        assert!(
            root.join("sp-1").join("dd").exists(),
            "有文件的那条不许动（连带它的父目录也不空 ⇒ 留）"
        );
        assert!(n >= 3, "至少收掉 aa / cc / bb 三个，实测 {n}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ⭐⭐ **2026-10-25（C：整理附件布局）**：老布局文件被**一个明文空间**引用 ⇒
    /// 复制进它自己的目录，且在没有"读不到的空间"时**删掉老文件**。
    ///
    /// **变异**：把 `migrate_legacy_layout` 里那次 `write_attachment_once` 删掉 ⇒
    /// `copied == 1` 与"空间目录里有一份"两条都红。
    #[test]
    fn migrating_copies_a_legacy_file_into_the_referencing_space_then_removes_it() {
        const H: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let dir = temp_dir("mig-copy");
        let space = "sp-one";
        std::fs::create_dir_all(crate::db::spaces_dir(&dir)).unwrap();
        {
            let c = crate::db::open_space_conn_at(space, &dir).unwrap();
            c.execute(
                "INSERT INTO attachments (id, page_id, name, hash, mime, size, created_at) \
                 VALUES ('a1','p1','x.png',?1,'image/png',3,0)",
                [H],
            )
            .unwrap();
        }
        let root = attachments_root(&dir);
        let legacy = bucket_path(&root, H, "png");
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        std::fs::write(&legacy, b"abc").unwrap();

        let out = migrate_legacy_layout(&dir).unwrap();
        assert_eq!(out.scanned, 1, "应当扫到一个老布局文件");
        assert_eq!(out.copied, 1, "必须给引用它的空间复制一份");
        assert_eq!(out.deleted, 1, "没有读不到的空间 ⇒ 老文件该删");
        assert!(!legacy.exists(), "老文件应当已经删掉");
        let own = find_path_by_hash(&space_attachments_dir(&dir, space), H)
            .expect("空间目录里应当有它自己那份");
        assert_eq!(
            std::fs::read(own).unwrap(),
            b"abc",
            "复制出去的内容必须逐字节一致"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ⭐⭐ **2026-10-25（C：安全闸门）**：只要有**一个空间打不开**（锁着的加密空间）⇒
    /// 老文件**只复制、不删** —— 那份可能正是它唯一的副本，删了就是"行在字节不在"。
    ///
    /// **变异**：把 `&& out.unreadable_spaces.is_empty()` 去掉 ⇒ 本判据红。
    #[test]
    fn migrating_keeps_the_legacy_file_when_some_space_is_unreadable() {
        const H: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let dir = temp_dir("mig-keep");
        let space = "sp-one";
        std::fs::create_dir_all(crate::db::spaces_dir(&dir)).unwrap();
        {
            let c = crate::db::open_space_conn_at(space, &dir).unwrap();
            c.execute(
                "INSERT INTO attachments (id, page_id, name, hash, mime, size, created_at) \
                 VALUES ('a1','p1','x.png',?1,'image/png',3,0)",
                [H],
            )
            .unwrap();
        }
        // 打不开的空间（与"锁着的密文库"同一档：都是 open 不了）
        std::fs::write(
            crate::db::spaces_dir(&dir).join("bad.db"),
            b"not-a-sqlite-header",
        )
        .unwrap();
        let root = attachments_root(&dir);
        let legacy = bucket_path(&root, H, "png");
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        std::fs::write(&legacy, b"abc").unwrap();

        let out = migrate_legacy_layout(&dir).unwrap();
        assert!(
            !out.unreadable_spaces.is_empty(),
            "前提：那个坏库必须被判成读不到"
        );
        assert_eq!(out.copied, 1, "复制照做");
        assert_eq!(
            out.deleted, 0,
            "⛔ 有读不到的空间就不许删（那可能是它唯一的副本）"
        );
        assert!(legacy.exists(), "老文件必须还在");
        assert_eq!(out.kept, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

// ─────────────────────── 附件行补变更记录（一次性修复） ───────────────────────

/// 补变更记录的读数（给人看，不是业务数据）。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct BackfillReport {
    /// 扫到几个空间库（打不开的见 `unreadable`）。
    pub spaces: usize,
    /// 这些空间里一共多少行附件。
    pub scanned: usize,
    /// 实际补了几条 `attachment|upsert`。
    pub appended: usize,
    /// 打不开的空间（加密未解锁 / 旧格式）—— ⛔ 不算成功，也不想让它们静默消失。
    pub unreadable: Vec<String>,
}

/// ⭐ **2026-10-25（真机事故）**：把某个空间库里的**每一行附件**都补一条 `attachment|upsert`。
///
/// ## 为什么会有"有行、没变更"的附件
///
/// 早期导入路径直接 `INSERT INTO attachments`，没走 `record_change` ⇒ 这些行**永远不会进同步队列**，
/// 对端就算游标归零也收不到（真机：濮阳数友 13 个附件里 10 个没有 changes 行）。
///
/// ## 为什么是"全部补"而不是"只补缺的"
///
/// 对端的游标可能早就越过了老的那几条（真机：mac 侧游标 30，而老的 attachment 变更在 seq 9–11）
/// ⇒ 只补缺的那 10 条，剩下 3 条**永远跨不过去**。补全部 13 条、新 seq 一律 > 当前最大值，
/// 对端一次就能收齐。⚠️ 重复补**不会重复建行**（对端按 id 幂等 upsert）⇒ 这条路径可以重复跑。
///
/// ⚠️ 它**不动**附件字节、不动页面、不动其他表 —— 只往 `changes` 里追加行。
pub fn backfill_attachment_changes_in(c: &rusqlite::Connection) -> Result<(usize, usize), String> {
    let rows: Vec<(String, Option<String>, String, String, String, i64)> = {
        // ⚠️ 语句与 rows 必须在**同一个块**里活着（借用检查）
        let mut st = c
            .prepare("SELECT id, page_id, name, hash, mime, size FROM attachments")
            .map_err(|e| format!("读附件行失败（{e}）⇒ 什么都没补"))?;
        let mapped = st
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, i64>(5)?,
                ))
            })
            .map_err(|e| format!("读附件行失败（{e}）⇒ 什么都没补"))?;
        mapped
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("读附件行失败（{e}）⇒ 什么都没补"))?
    };
    let now = crate::db::now_ms();
    let mut appended = 0usize;
    for (id, page_id, name, hash, mime, size) in &rows {
        // ⚠️ payload 必须与正常保存那一路**同形**（见 `save_image` 里那条）
        let payload = serde_json::json!({
            "id": id,
            "page_id": page_id,
            "name": name,
            "hash": hash,
            "mime": mime,
            "size": size,
        })
        .to_string();
        crate::sync::record_change(c, "attachment", id, "upsert", Some(&payload), now)?;
        appended += 1;
    }
    Ok((rows.len(), appended))
}

/// 对**全部空间库**做一遍补记（`<app data>/spaces/*.db`）。
///
/// ⚠️ 打不开的空间（加密未解锁）不静默跳过 —— 记进 `unreadable` 并如实报数。
pub fn backfill_attachment_changes_all(app_data_dir: &std::path::Path) -> BackfillReport {
    let mut out = BackfillReport::default();
    let dir = app_data_dir.join("spaces");
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return out;
    };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("db") {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("?")
            .to_string();
        match rusqlite::Connection::open(&path) {
            Ok(c) => {
                // ⚠️ 设备身份在 **meta** 库里（`meta.sync_state`）⇒ 先挂上再补，
                //    否则 `record_change` 会报"设备 ID 未初始化"（真机第一次跑就撞到了）。
                let meta = app_data_dir.join("meta.db");
                if let Err(e) = c.execute(
                    &format!("ATTACH DATABASE ?1 AS meta"),
                    rusqlite::params![meta.to_string_lossy().to_string()],
                ) {
                    out.unreadable.push(format!("{name}（挂 meta 失败：{e}）"));
                    continue;
                }
                out.spaces += 1;
                match backfill_attachment_changes_in(&c) {
                    Ok((scanned, appended)) => {
                        out.scanned += scanned;
                        out.appended += appended;
                    }
                    Err(e) => out.unreadable.push(format!("{name}（{e}）")),
                }
            }
            Err(_) => out.unreadable.push(name),
        }
    }
    out
}

#[cfg(test)]
mod backfill_attachment_changes_tests {
    use super::*;

    /// ⭐ 判据：**有行没变更**的附件会被补上，且**重复跑会再补一遍**（故意：对端游标可能已越过老 seq）。
    #[test]
    fn rows_without_changes_get_an_upsert_and_a_rerun_resends_the_same_rows() {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        // 真机上 meta 是 ATTACH 进来的库；测试里同样挂一个内存库并建 `sync_state`
        c.execute_batch(
            "ATTACH DATABASE ':memory:' AS meta;
             CREATE TABLE meta.sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE meta.sync_profiles (ws_id TEXT PRIMARY KEY, last_pushed_seq INTEGER NOT NULL DEFAULT 0);",
        )
        .unwrap();
        crate::db::migrate(&c, "w1").unwrap();
        // `record_change` 要设备身份（真机上由 `db::migrate` 那条路径种下）
        crate::sync::set_meta_state(&c, "device_id", "test-dev").unwrap();
        // 两行附件：模拟"早期导入直接插行、没走 record_change"
        c.execute("INSERT INTO attachments (id,page_id,name,hash,mime,size,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
            rusqlite::params!["a1", "p1", "身份证A.jpg", "h1", "image/jpeg", 100i64, 1i64]).unwrap();
        c.execute("INSERT INTO attachments (id,page_id,name,hash,mime,size,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
            rusqlite::params!["a2", "p1", "声明承诺.jpg", "h2", "image/jpeg", 200i64, 2i64]).unwrap();
        let before: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM changes WHERE entity = 'attachment'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(before, 0, "前提：这两行本来没有变更记录");

        let (scanned, appended) = backfill_attachment_changes_in(&c).unwrap();
        assert_eq!((scanned, appended), (2, 2));
        let after: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM changes WHERE entity = 'attachment' AND op = 'upsert'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(after, 2, "两条都要有 upsert");

        // 再补一遍：**行数不涨、seq 必须涨** —— 因为未推送的同实体 upsert 会被并掉
        // （`record_change` 的 R139 规矩：删旧行 + 插新行、拿到**新的 seq**）。
        // 对端看的是 seq（不是本地行数）⇒ 这样它才收得到。
        let max1: i64 = c
            .query_row("SELECT COALESCE(MAX(device_seq),0) FROM changes", [], |r| {
                r.get(0)
            })
            .unwrap();
        let (_, appended2) = backfill_attachment_changes_in(&c).unwrap();
        assert_eq!(appended2, 2, "第二次也是每一行都补一遍");
        let after2: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM changes WHERE entity = 'attachment' AND op = 'upsert'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(after2, 2, "未推送的会被并掉 ⇒ 行数不涨（⛔ 不是堆两倍行）");
        let max2: i64 = c
            .query_row("SELECT COALESCE(MAX(device_seq),0) FROM changes", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(
            max2 > max1,
            "但 seq 必须往前（对端靠它判断要不要收）：{max1} → {max2}"
        );
        // 附件行本身一行都没多
        let rows: i64 = c
            .query_row("SELECT COUNT(*) FROM attachments", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 2, "⛔ 不许重复建附件行");
    }
}

#[cfg(test)]
mod open_temp_name_tests {
    use super::*;

    /// ⭐ **2026-10-28（owner：「打开 html 变成 BIN 文件」）**：交给系统打开时
    /// **按原始文件名取扩展名**（`xxx.html` ⇒ `html`），且**文件名前缀是安全的**（⛔ 不拼路径分隔符 ✗）。
    #[test]
    fn the_open_copy_keeps_a_usable_extension_and_a_safe_stem() {
        assert_eq!(open_ext_for("ShuyoNote企业版-权限管理.html"), "html");
        assert_eq!(open_ext_for("A.HTML"), "html", "大小写不敏感 ✓");
        assert_eq!(open_ext_for("没有扩展名"), "bin", "没扩展名 ⇒ bin ✓");
        assert_eq!(
            open_ext_for("x.weird_ext_123"),
            "bin",
            "超长/不安全的扩展名 ⇒ bin（⛔ 不拼进路径）✓"
        );
        assert_eq!(open_ext_for("x.tar.gz"), "gz");
        // stem：路径分隔符只取最后一段；控制字符替换成 `_`；空 ⇒ attachment；限长 60。
        assert_eq!(open_stem_for("a/b\\c.html"), "c.html", "只取最后一段 ✓");
        assert_eq!(
            open_stem_for("../../evil.html"),
            "evil.html",
            "⛔ 不许把 .. 带进来 ✗"
        );
        assert_eq!(open_stem_for("a\u{1}b"), "a_b", "控制字符 ⇒ _ ✓");
        assert_eq!(open_stem_for("   "), "attachment", "空 ⇒ 兜底名 ✓");
        assert_eq!(open_stem_for("  ..  "), "attachment", "只剩点 ⇒ 兜底 ✓");
        assert!(
            open_stem_for(&"长".repeat(200)).chars().count() <= 60,
            "限长 60 字符（防超长文件名）✓"
        );
    }
}
