//! 备份包**自洽核对**（P2 的第一半：checksums 比对）。
//!
//! ── 挡的是哪一次真实缺口 ────────────────────────────────────────────────────────
//! `docs/plans/2026-10-09-自动备份可行性评估.md` §6 给 P2 的判据逐字是：
//!   「演练脚本对**故意损坏的包**必须报红 ✓（看过它红 ✓），
//!     对好包必须复原出**同样的页数与附件数** ✓」
//!
//! 本条只做**第一半**（⭐ 包自己有没有坏 ✗）；"解出来比页数/附件数"是第二半，另起一笔 ✓。
//! 为什么要这一半：**一个坏掉的备份包在磁盘上看起来完全正常** ✗ —— 只有真的逐条读一遍、
//! 核对每条的大小与 CRC，才可能在"要用它"之前发现它已经坏了 ✓（"未验证恢复的备份等于没有备份" ✓）。
//!
//! ⚠️ 边界（照实）：
//!   · 这里**不检查**"包里的内容是不是用户想要的那一份"（那是第二半：比页数/附件数 ✓）
//!   · 这里**不写回**任何用户数据 ✓（只读包 ＋ 只在调用方给的临时目录里解 ✓）
//!   · 不引新依赖 ✓（用已有的 `zip` ✓）

use std::io::Read;
use std::path::Path;

/// 包里一条记录（⭐ 只留"能比大小、能比内容"的三样 ✓）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntryDigest {
    /// 包内路径（如 `meta.db` ／ `spaces/<id>.db` ／ `attachments/ab/<hash>`）
    pub name: String,
    /// 未压缩大小
    pub size: u64,
    /// 内容 CRC32（⭐ zip 自己带的那个 ✓）
    pub crc32: u32,
}

/// 两份清单的差异（⭐ **纯数据** ⇒ 可单测 ✓）
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Diff {
    /// 只在左边出现的
    pub missing: Vec<String>,
    /// 只在右边出现的
    pub extra: Vec<String>,
    /// 两边都有、但 size/CRC 不同
    pub changed: Vec<String>,
}

impl Diff {
    /// 一处差异都没有 ⇒ 两份清单**逐条一致** ✓
    pub fn is_clean(&self) -> bool {
        self.missing.is_empty() && self.extra.is_empty() && self.changed.is_empty()
    }
    /// 一行摘要（写日志／报告用 ✓）
    pub fn summary(&self) -> String {
        format!(
            "missing={} extra={} changed={}",
            self.missing.len(),
            self.extra.len(),
            self.changed.len()
        )
    }
}

/// 读一个包的**目录信息**（不读内容 ⇒ 快 ✓）：每条记录的 name / size / crc32 ✓
pub fn digest_of(path: &Path) -> Result<Vec<EntryDigest>, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("打不开包：{e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("不是可读的 zip：{e}"))?;
    let mut out: Vec<EntryDigest> = Vec::new();
    for i in 0..zip.len() {
        let entry = zip.by_index(i).map_err(|e| format!("读第 {i} 条记录失败：{e}"))?;
        if entry.is_dir() {
            continue;
        }
        out.push(EntryDigest {
            name: entry.name().to_string(),
            size: entry.size(),
            crc32: entry.crc32(),
        });
    }
    // ⭐ 顺序稳定 ⇒ 两份清单可比（zip 顺序不保证 ⇒ 按名字排 ✓）
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// 比对两份清单（⭐ 纯函数 ✓）
pub fn diff(a: &[EntryDigest], b: &[EntryDigest]) -> Diff {
    let mut d = Diff::default();
    for x in a {
        match b.iter().find(|y| y.name == x.name) {
            None => d.missing.push(x.name.clone()),
            Some(y) => {
                if x.size != y.size || x.crc32 != y.crc32 {
                    d.changed.push(x.name.clone());
                }
            }
        }
    }
    for y in b {
        if !a.iter().any(|x| x.name == y.name) {
            d.extra.push(y.name.clone());
        }
    }
    d.missing.sort();
    d.extra.sort();
    d.changed.sort();
    d
}

/// ⭐ P2 判据的第一半：**这个包自己是不是好的**？
///
/// 做法：逐条**真的读一遍内容**（不是只看目录信息 ✗）—— zip 在读完一条时会核对它的 CRC ✓
/// ⇒ 内容被改过一个字节 ⇒ 这里必然拿到错误 ✓
///
/// 返回：问题清单（⭐ 空 = 好包 ✓；非空 = 报红 ✓，每条都是人话 ✓）
pub fn verify_self_consistent(path: &Path) -> Result<Vec<String>, String> {
    let mut problems: Vec<String> = Vec::new();

    // ① 目录本身能不能读（中央目录被改坏 ⇒ 这一步就红 ✓）
    let digests = match digest_of(path) {
        Ok(d) => d,
        Err(e) => return Ok(vec![format!("包读不出来：{e}")]),
    };
    if digests.is_empty() {
        problems.push("包里一条记录都没有".to_string());
    }
    // ② `meta.db` 必须在（⭐ 用户看到的是"备份成功"，那就必须真的有它 ✓）
    if !digests.iter().any(|d| d.name == "meta.db") {
        problems.push("包里没有 meta.db".to_string());
    }

    // ③ 逐条读内容 ⇒ 让 zip 核对 CRC（⭐ "故意损坏 ⇒ 必须红"就落在这里 ✓）
    let file = std::fs::File::open(path).map_err(|e| format!("打不开包：{e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("不是可读的 zip：{e}"))?;
    for i in 0..zip.len() {
        let mut entry = match zip.by_index(i) {
            Ok(e) => e,
            Err(e) => {
                problems.push(format!("第 {i} 条记录打不开：{e}"));
                continue;
            }
        };
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().to_string();
        let mut sink = Vec::new();
        if let Err(e) = entry.read_to_end(&mut sink) {
            problems.push(format!("{name} 读不完（多半是内容对不上 CRC）：{e}"));
            continue;
        }
        if sink.len() as u64 != entry.size() {
            problems.push(format!(
                "{name} 解出来 {} 字节、声明 {} 字节",
                sink.len(),
                entry.size()
            ));
        }
    }
    problems.sort();
    Ok(problems)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmpdir(tag: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "shuyonote-verify-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&p).expect("建临时目录");
        p
    }

    /// 造一个**好包**：`meta.db` ＋ 一条附件 ✓
    fn make_good_zip(path: &Path) {
        let file = std::fs::File::create(path).expect("建包");
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default();
        zip.start_file("meta.db", opts).unwrap();
        zip.write_all(b"meta-content-1234").unwrap();
        zip.start_file("attachments/ab/abcdef", opts).unwrap();
        zip.write_all(b"attachment-bytes").unwrap();
        zip.finish().unwrap();
    }

    #[test]
    fn good_package_has_zero_problems() {
        let dir = tmpdir("good");
        let p = dir.join("good.zip");
        make_good_zip(&p);
        let problems = verify_self_consistent(&p).expect("核对不该在环境上失败");
        assert!(
            problems.is_empty(),
            "好包必须是 0 条问题 ✓（实测：{problems:?}）"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ⭐ §6 P2 判据逐字：「对**故意损坏的包**必须报红 ✓（看过它红 ✓）」
    #[test]
    fn corrupted_package_is_reported() {
        let dir = tmpdir("corrupt");
        let p = dir.join("bad.zip");
        make_good_zip(&p);
        // ⭐ 故意损坏：把包中间一个字节翻掉（大概率打在压缩数据或中央目录上 ✓）
        let mut bytes = std::fs::read(&p).expect("读包");
        let mid = bytes.len() / 2;
        bytes[mid] ^= 0xFF;
        std::fs::write(&p, &bytes).expect("写坏包");
        let problems = verify_self_consistent(&p).expect("核对不该在环境上失败");
        assert!(
            !problems.is_empty(),
            "⭐ 故意损坏的包**必须**报红（这正是 P2 的判据 ✓）"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn digest_is_stable_and_sorted() {
        let dir = tmpdir("digest");
        let p = dir.join("d.zip");
        make_good_zip(&p);
        let a = digest_of(&p).expect("读包");
        let b = digest_of(&p).expect("读包");
        assert_eq!(a, b, "同一个包两次摘要必须一致 ✓");
        assert_eq!(
            a.iter().map(|d| d.name.clone()).collect::<Vec<_>>(),
            vec!["attachments/ab/abcdef".to_string(), "meta.db".to_string()],
            "⭐ 必须按名字排序（zip 顺序不保证 ⇒ 不排就没法比 ✓）"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn diff_finds_missing_extra_and_changed() {
        let a = vec![
            EntryDigest { name: "meta.db".into(), size: 10, crc32: 1 },
            EntryDigest { name: "spaces/x.db".into(), size: 20, crc32: 2 },
            EntryDigest { name: "attachments/aa/1".into(), size: 30, crc32: 3 },
        ];
        let b = vec![
            EntryDigest { name: "meta.db".into(), size: 10, crc32: 1 },
            EntryDigest { name: "spaces/x.db".into(), size: 20, crc32: 999 }, // 内容变了
            EntryDigest { name: "attachments/bb/2".into(), size: 40, crc32: 4 }, // 多出来的
        ];
        let d = diff(&a, &b);
        assert_eq!(d.missing, vec!["attachments/aa/1".to_string()]);
        assert_eq!(d.extra, vec!["attachments/bb/2".to_string()]);
        assert_eq!(d.changed, vec!["spaces/x.db".to_string()]);
        assert!(!d.is_clean());
        assert_eq!(d.summary(), "missing=1 extra=1 changed=1");
        assert!(diff(&a, &a).is_clean(), "自己跟自己比必须干净 ✓");
    }

    #[test]
    fn missing_meta_db_is_reported() {
        let dir = tmpdir("nometa");
        let p = dir.join("n.zip");
        let file = std::fs::File::create(&p).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default();
        zip.start_file("attachments/aa/1", opts).unwrap();
        zip.write_all(b"x").unwrap();
        zip.finish().unwrap();
        let problems = verify_self_consistent(&p).expect("核对不该在环境上失败");
        assert!(
            problems.iter().any(|s| s.contains("meta.db")),
            "缺 meta.db 必须被点名 ✓（实测：{problems:?}）"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
