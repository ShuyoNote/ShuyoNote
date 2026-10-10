//! 本地英汉词典（ECDICT）——「应用内划词查词」第一期。
//!
//! ## 口径（owner 2026-10-09 拍三条 ＋ 评估文档 §3-③；⛔ 不许自行更改）
//!
//! · **只做应用内划词** ⇒ 本模块**不碰**任何系统钩子／全局监听／辅助功能授权
//!   （`monio` / `selection` 那两个 crate 是"系统级全局划词"那条路的，**本期不引**）。
//!   选中文本由前端 Lexical 的原生选区给（见 `src/editor/plugins/DictionaryLookupPlugin.tsx`）。
//! · **只做 ECDICT 英汉** ⇒ 中文词条（"方法论"／"核聚变"）**查不到是这个词典的事实**，
//!   必须**如实**返回 [`MissKind::NotEnglish`] ＋ 一句人话（"未收录 ⇒ 可走 AI"）；
//!   ⛔ **绝不允许**在这里编造释义、也**不允许**返回空串让界面静默空白（评估文档 §3-③／§3-④）。
//! · 术语卡片＝普通页面＋模板（本期不做）⇒ 本模块**只读**，一个字都不写用户笔记。
//!
//! ## 数据从哪来（owner 2026-10-09 追加拍板：「**词库放能力包，按需下载**」）
//!
//! 词库**不随安装包分发**（ECICT 的 CSV 实测 65,933,428 字节，随包会让安装包 +63MB），
//! 而是走**仓里已有的能力包链**：`src-tauri/src/abilities.rs`（白名单 ＋ 钉死 sha256 ＋ fail-closed）
//! ⇒ pack id = [`crate::abilities::ECDICT_PACK_ID`]，
//! 落点 `<app_data_dir>/packs/<pack_id>/<pack_id>.bin`。
//! 产出那份 pack 的**开发侧**工具是 `scripts/fetch-ecdict.mjs`（钉 commit/blob sha ＋ 报 pack 的 sha256）；
//! 许可归属见 `src-tauri/assets/ecdict/LICENSE-ECDICT.txt`（**MIT**，`Copyright (c) 2025 Linwei`）。
//! 本模块只认那个脚本产出的 schema（表 `stardict`，列名与上游 CSV 表头一致）。
//!
//! ## 路径解析顺序（**单一来源**，判据与实现同一处）
//!
//! 1. `SHUYONOTE_ECDICT_DB`（环境变量；`cargo test` 与 `scripts/dictionary-bench.mjs` 用它）
//! 2. 能力包：`<app_data_dir>/packs/<pack_id>/<pack_id>.bin`
//!
//! ⚠️ **没有第三条**（"资源目录随包"那条已按 owner 拍板**删掉** —— 它会让安装包 +63MB ✗）。
//! 两处都没有 ⇒ [`dictionary_status`] 如实报 `available: false`，界面说"词库未就绪"，
//! ⛔ 不许假装查过。
//!
//! ## ⭐ 半包/损坏**不许**被当成"已就绪"
//!
//! 能力包链在**落盘之前**已核过 sha256（`abilities.rs:8` 的 fail-closed ✓），但落盘是一次
//! 60MB 级的 `std::fs::write`：进程在中间死掉会留下**截断文件**。所以这里再核一次：
//! · **字节数**（便宜 ⇒ 每次用之前都核）—— 截断立刻可见；
//! · **sha256**（贵 ⇒ **每进程一次**并缓存结果）—— 防"长度巧合但内容被换/写坏"。
//! 任一不过 ⇒ [`LookupOutcome::Unavailable`]（把"不完整/指纹不符"明说出来），⛔ 不查、不猜。

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// 环境变量：开发与判据用。**它是路径解析的第 1 顺位**（见模块头）。
pub const ENV_DB: &str = "SHUYONOTE_ECDICT_DB";
/// 上游表名（ECDICT 的 SQLite 版就叫 `stardict`）。
const TABLE: &str = "stardict";
/// 查询词长度上限（字符）。超过它按"选中的是一整段"处理 —— 划词会选到句子甚至段落。
const QUERY_MAX_CHARS: usize = 64;
/// 单个释义字段的回传上限（字符）。上游 `detail` 可以很长，浮层不该吞下它。
const FIELD_MAX_CHARS: usize = 800;

/// 一条词条（只带上界面要用的列；上游还有 `bnc`/`frq`/`collins` 等，本期不消费）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DictEntry {
    /// 词条原形（上游 `word` 列，原样回传）。
    pub word: String,
    pub phonetic: String,
    pub translation: String,
    pub definition: String,
    pub pos: String,
    pub tag: String,
    pub exchange: String,
}

/// 查不到的**类别**。
///
/// ⚠️ 存在的理由：界面文案要"如实"（评估文档 §3-③）。用一个 `Option::None` 表达不了
/// "没选中"／"中文词条"／"英文词但未收录"三种不同的话，于是界面只能写一句含糊的话
/// —— 那正是"不许静默空白"要挡的东西。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MissKind {
    /// 选中的是空白。
    Empty,
    /// 选中里有 CJK（中日韩）文字 ⇒ 英汉词典**结构性**查不到，不是"这个词冷门"。
    NotEnglish,
    /// 是英文词形，但上游词典没有这一条。
    NotFound,
    /// 选中的东西太长，不像一个词条。
    TooLong,
}

/// 一次查询的结果。**三种状态互斥**，没有"空结果"这种第四态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum LookupOutcome {
    /// 命中。`matched` 是**真的命中的那个词形**（可能是规范化后的形式，如大小写折叠）。
    Found {
        query: String,
        matched: String,
        entry: DictEntry,
    },
    /// 没命中 —— 但**说清是哪一种**，并给一句界面可直接显示的话。
    NotFound {
        query: String,
        kind: MissKind,
        message: String,
    },
    /// 词典本身不可用（没装／文件不认识）。⚠️ 与 `NotFound` **分开**：界面要说的是
    /// "本地词典未安装"，而不是"这个词未收录" —— 后者会让人以为查过了。
    Unavailable { message: String },
}

/// 词典状态读数（界面/诊断用）。**如实**报路径与词条数，没有就报没有。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DictionaryStatus {
    pub available: bool,
    /// 实际用到的文件（没有就是 `None`）。
    pub path: Option<String>,
    /// 文件字节数（`available` 时才有）。
    pub bytes: Option<u64>,
    /// 词条数（`available` 时才有；读不出来就是 `None`，不猜）。
    pub entries: Option<i64>,
    /// 数据来源（`env` / `pack`），排错用。
    pub source: Option<String>,
    /// ⭐ 完整性：`Some(true)` 字节数与 sha256 都过了、`Some(false)` 没过（半包/指纹不符）、
    /// `None` = 没有文件可核。**界面据此区分"没装"与"装了但坏了"**（⛔ 两者都不许说成"已就绪"）。
    pub verified: Option<bool>,
    /// 一句话（界面可直接显示）。
    pub message: String,
}

// ---------------------------------------------------------------------------
// 路径解析 ＋ 完整性（**纯函数**：不摸全局状态 ⇒ 可单测）
// ---------------------------------------------------------------------------

/// 能力包在应用数据目录里的落点（⭐ 与 `abilities.rs::save_ability_pack` 的落盘形状**逐字一致**）。
pub fn pack_path(app_data: &Path) -> PathBuf {
    app_data
        .join("packs")
        .join(crate::abilities::ECDICT_PACK_ID)
        .join(format!("{}.bin", crate::abilities::ECDICT_PACK_ID))
}

/// 两个候选路径，**按优先级**排好。
///
/// 抽成纯函数（而不是在里面直接 `std::env::var` + `app.path()`）是为了能单测：
/// 路径优先级搞反了不会有任何症状，只会"永远读不到词库"。
pub fn candidate_paths(env: Option<&Path>, app_data: Option<&Path>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(p) = env {
        out.push(p.to_path_buf());
    }
    if let Some(d) = app_data {
        out.push(pack_path(d));
    }
    out
}

/// 每个候选路径的人话标签（`DictionaryStatus::source` 用）。
fn source_of(env: Option<&Path>, app_data: Option<&Path>, hit: &Path) -> &'static str {
    if env.map(|p| p == hit).unwrap_or(false) {
        "env"
    } else if app_data.map(|d| pack_path(d) == hit).unwrap_or(false) {
        "pack"
    } else {
        "unknown"
    }
}

/// 第一个**真的存在**的候选（都不在 ⇒ `None`）。
pub fn resolve_db_path(env: Option<&Path>, app_data: Option<&Path>) -> Option<PathBuf> {
    candidate_paths(env, app_data)
        .into_iter()
        .find(|p| p.is_file())
}

/// 核一个已装好的 pack 文件：**字节数 ＋ sha256**。
///
/// ⚠️ 这两条是 owner 2026-10-09 第 ④ 条（"下载中断/半包 ⇒ 不许被当成已就绪"）的落点。
/// 返回 `Err(一句人话)` —— 调用方把它**原样**交给界面（⛔ 不许吞掉，也⛔ 不许降级成"就绪"）。
///
/// `expected_bytes == 0` 表示"字节数这条没钉"（样本/联调场景）⇒ 只核 sha256。
pub fn pack_check(path: &Path, expected_bytes: u64, expected_sha: &str) -> Result<(), String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("读不到词库文件（{}）：{e}", path.display()))?;
    if expected_bytes > 0 && meta.len() != expected_bytes {
        return Err(format!(
            "词库文件不完整：{} 字节 ≠ 钉住的 {expected_bytes} 字节（半包/写坏都不会被当成已就绪，请重新下载）",
            meta.len()
        ));
    }
    if expected_sha.is_empty() {
        return Err("词库的 sha256 还没钉住 ⇒ 无法核对指纹（开发态才可能走到这里）".to_string());
    }
    let got = sha256_file(path)?;
    if got != expected_sha {
        return Err(format!(
            "词库指纹不符：算出 {} ≠ 钉住的 {expected_sha} ⇒ 拒用（内容被换过或写坏了）",
            &got[..12.min(got.len())]
        ));
    }
    Ok(())
}

/// 算文件的 sha256（60MB 级 ⇒ 只在"每进程一次"的缓存里做，⛔ 别放进每次查询）。
fn sha256_file(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use std::io::Read as _;
    let mut f = std::fs::File::open(path).map_err(|e| format!("打开词库失败：{e}"))?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).map_err(|e| format!("读词库失败：{e}"))?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

/// 规范化用户输入：去首尾空白、去首尾的引号/标点、折叠大小写。
///
/// ⚠️ **只做这几件"不会有歧义"的事**：任何"猜词形"（去复数/去时态）都可能把
/// `apples` 猜成 `apple` 而给出**不是用户选中那个词**的释义 —— 那与"编造"只差一步。
/// 词形还原该由上游 `exchange` 列显式表达，不该在这里猜。
pub fn normalize(raw: &str) -> String {
    raw.trim()
        .trim_matches(|c: char| {
            matches!(
                c,
                '"' | '\'' | '“' | '”' | '‘' | '’' | '(' | ')' | '[' | ']' | '{' | '}' | ',' | '.'
                    | ';' | ':' | '!' | '?' | '。' | '，' | '、' | '：' | '；' | '！' | '？'
            )
        })
        .trim()
        .to_lowercase()
}

/// 某一个字符是不是 CJK（汉字/假名/韩文）。
///
/// 判据用它而不是"含非 ASCII"：`café` 这类带音符的**英文词**是该词典收的，
/// 拿"非 ASCII"当"中文"会把它们误判成查不到。
fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3040..=0x30FF        // 平假名/片假名
        | 0x3400..=0x4DBF      // 扩展 A
        | 0x4E00..=0x9FFF      // 基本区
        | 0xF900..=0xFAFF      // 兼容表意
        | 0xAC00..=0xD7AF      // 谚文
        | 0x20000..=0x2FA1F    // 扩展 B 及以后
    )
}

/// 选中的文本像不像一个"词条"。
pub fn looks_like_english(text: &str) -> bool {
    let has_latin = text.chars().any(|c| c.is_ascii_alphabetic());
    let has_cjk = text.chars().any(is_cjk);
    has_latin && !has_cjk
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

/// 未收录时那句**人话**（界面原样显示）。
///
/// 三档分开写，因为它们对用户意味着不同的事：
/// 中文词条是"这个词典结构上没有"，未收录是"这条冷门"，太长是"你选多了"。
fn miss_message(kind: MissKind, query: &str, extra: &str) -> String {
    match kind {
        MissKind::Empty => "没有选中文本 —— 划词查词不会凭空给释义。".to_string(),
        MissKind::NotEnglish => format!(
            "本地词典是英汉词典，不含中文词条：「{query}」未收录 ⇒ 需要解释请走 AI（这里不编造本地释义）。"
        ),
        MissKind::NotFound => format!(
            "「{query}」未收录于本地英汉词典（ECDICT）{extra} ⇒ 可走 AI 解释；这里不猜。"
        ),
        MissKind::TooLong => format!(
            "选中的文本太长（{} 字，上限 {QUERY_MAX_CHARS}）{extra} ⇒ 本地词典只查单词/短语。",
            query.chars().count()
        ),
    }
}

fn row_to_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<DictEntry> {
    let get = |i: usize| -> rusqlite::Result<String> {
        // 上游的列可能为 NULL ⇒ 统一按空串处理（界面不需要知道 NULL 与空串的区别）。
        Ok(row.get::<_, Option<String>>(i)?.unwrap_or_default())
    };
    Ok(DictEntry {
        word: get(0)?,
        phonetic: get(1)?,
        translation: truncate(&get(2)?, FIELD_MAX_CHARS),
        definition: truncate(&get(3)?, FIELD_MAX_CHARS),
        pos: get(4)?,
        tag: get(5)?,
        exchange: get(6)?,
    })
}

/// 表在不在（决定"文件不认识"和"词未收录"是两件事）。
fn table_exists(conn: &Connection) -> rusqlite::Result<bool> {
    let n: i64 = conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [TABLE],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

/// 按一个**规范形式**查一次（走 `word` 上的索引/PK；不做全表扫）。
fn query_exact(conn: &Connection, form: &str) -> rusqlite::Result<Option<DictEntry>> {
    let sql = format!(
        "SELECT word, phonetic, translation, definition, pos, tag, exchange FROM {TABLE} WHERE word = ?1 LIMIT 1"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query([form])?;
    match rows.next()? {
        Some(row) => Ok(Some(row_to_entry(row)?)),
        None => Ok(None),
    }
}

/// 在一个已打开的连接上查（**纯查询逻辑**；单测直接喂内存夹具）。
///
/// 命中顺序：① 规范化小写形式（绝大多数词条）② 用户原样输入去除首尾空白的形式
/// （上游有 `China` 这类首字母大写的词条）。两次都是**索引等值查**，不扫描。
pub fn lookup_in(conn: &Connection, raw: &str) -> LookupOutcome {
    let norm = normalize(raw);
    let query = norm.clone();
    if norm.is_empty() {
        return LookupOutcome::NotFound {
            query,
            kind: MissKind::Empty,
            message: miss_message(MissKind::Empty, "", ""),
        };
    }
    if norm.chars().count() > QUERY_MAX_CHARS {
        return LookupOutcome::NotFound {
            query,
            kind: MissKind::TooLong,
            message: miss_message(MissKind::TooLong, &norm, ""),
        };
    }
    if !looks_like_english(&norm) {
        return LookupOutcome::NotFound {
            query,
            kind: MissKind::NotEnglish,
            message: miss_message(MissKind::NotEnglish, &norm, ""),
        };
    }
    match table_exists(conn) {
        Ok(true) => {}
        Ok(false) => {
            return LookupOutcome::Unavailable {
                message: format!(
                    "词典文件里没有 {TABLE} 表 —— 这个文件不是本应用认识的 ECDICT 产出，拒绝猜测。"
                ),
            }
        }
        Err(e) => {
            return LookupOutcome::Unavailable {
                message: format!("读词典文件失败：{e}"),
            }
        }
    }
    let typed = raw.trim();
    // ⚠️ `norm` 在这一段里既被借（attempts）又被 move 进结果 ⇒ 两次都用 `.clone()`，
    //    别把一个 E0505 留给下一个人（本仓对"能编过"这件事没有别的判据，就是 cargo）。
    let attempts: [&str; 2] = [norm.as_str(), typed];
    for form in attempts {
        if form.is_empty() {
            continue;
        }
        match query_exact(conn, form) {
            Ok(Some(entry)) => {
                return LookupOutcome::Found {
                    query: norm.clone(),
                    matched: entry.word.clone(),
                    entry,
                }
            }
            Ok(None) => continue,
            Err(e) => {
                return LookupOutcome::Unavailable {
                    message: format!("查词典失败：{e}"),
                }
            }
        }
    }
    let extra = if norm != typed {
        format!("（按「{norm}」查的）")
    } else {
        String::new()
    };
    LookupOutcome::NotFound {
        query: norm.clone(),
        kind: MissKind::NotFound,
        message: miss_message(MissKind::NotFound, &query, &extra),
    }
}

/// 打开一个**只读**连接。
///
/// ⚠️ 本仓的 `rusqlite` 是 `bundled-sqlcipher`（`Cargo.toml:60`）—— 这里**不调**
/// `PRAGMA key`，SQLCipher 在没给钥匙时按**标准 SQLite** 走，所以能读明文库。
/// 这条**不是推断**：`plaintext_file_survives_the_sqlcipher_build` 那个单测真的落一个
/// 文件再只读打开一次。
pub fn open_readonly(path: &Path) -> rusqlite::Result<Connection> {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
}

/// 对某个路径查一次（不存在 ⇒ `Unavailable`，⛔ 不是 `NotFound`）。
pub fn lookup_at(path: &Path, raw: &str) -> LookupOutcome {
    if !path.is_file() {
        return LookupOutcome::Unavailable {
            message: format!(
                "本地英汉词库未就绪（找不到 {}）⇒ 这里不会假装查过。取回方式见 src-tauri/assets/ecdict/README.md。",
                path.display()
            ),
        };
    }
    match open_readonly(path) {
        Ok(conn) => lookup_in(&conn, raw),
        Err(e) => LookupOutcome::Unavailable {
            message: format!("打开词典文件失败（{}）：{e}", path.display()),
        },
    }
}

fn count_entries(conn: &Connection) -> Option<i64> {
    conn.query_row(&format!("SELECT count(*) FROM {TABLE}"), [], |r| r.get(0))
        .ok()
}

/// 状态：**如实**报"有没有、在哪、多少条、指纹过没过"。
///
/// `verified` 由调用方算好传进来（它要花几百毫秒 ⇒ 只在命令层按"每进程一次"算）：
/// · `None` = 没有文件；
/// · `Some(false)` = 文件在但**半包/指纹不符** ⇒ `available` 仍为 false（⛔ 不是"就绪"）。
pub fn status_at(
    path: Option<&Path>,
    env: Option<&Path>,
    app_data: Option<&Path>,
    verified: Option<bool>,
) -> DictionaryStatus {
    let Some(path) = path else {
        return DictionaryStatus {
            available: false,
            path: None,
            bytes: None,
            entries: None,
            source: None,
            verified: None,
            message: format!(
                "本地英汉词库未就绪（既没有 {ENV_DB}，也没有能力包 {}）⇒ 划词只会如实说「未收录／可走 AI」，不会编造释义；可在「设置 → 能力」里下载。",
                crate::abilities::ECDICT_PACK_ID
            ),
        };
    };
    let bytes = std::fs::metadata(path).ok().map(|m| m.len());
    let source = Some(source_of(env, app_data, path).to_string());
    if verified == Some(false) {
        return DictionaryStatus {
            available: false,
            path: Some(path.display().to_string()),
            bytes,
            entries: None,
            source,
            verified: Some(false),
            message: "词库文件在，但完整性没过（半包/指纹不符）⇒ 按「未就绪」处理，请重新下载。"
                .to_string(),
        };
    }
    let entries = open_readonly(path)
        .ok()
        .and_then(|c| if table_exists(&c).ok() == Some(true) { count_entries(&c) } else { None });
    DictionaryStatus {
        available: true,
        path: Some(path.display().to_string()),
        bytes,
        entries,
        source,
        verified,
        message: match entries {
            Some(n) => format!("本地英汉词库就绪（{n} 条词条）——中文词条不在其中，界面会如实说走 AI。"),
            None => "词库文件在，但读不出词条数（schema 不认识？）⇒ 界面按「查不到」如实显示。"
                .to_string(),
        },
    }
}

// ---------------------------------------------------------------------------
// Tauri 命令（**只读**两条；本片唯一的对外面）
// ---------------------------------------------------------------------------

/// 本机当前该用哪个词库文件（环境变量 → 能力包），并说明**它是不是能力包**。
///
/// ⚠️ 为什么要把"是不是能力包"带出来：**指纹核对只对能力包做**。
/// `SHUYONOTE_ECDICT_DB` 是开发/判据用的**覆盖口**（`cargo test`、`scripts/dictionary-bench.mjs`
/// 都指它，那里的库是小样本、sha256 与上架那份**必然不同**）⇒ 拿能力包的 pin 去核它会让
/// "开发路径永远被判成坏了"。所以：env ⇒ 不核 pin（但仍核"库读不读得动"）；pack ⇒ 核 pin。
fn current_db_path() -> Option<(PathBuf, bool)> {
    let env = std::env::var_os(ENV_DB).map(PathBuf::from);
    let app_data = crate::db::app_data_dir_ref().map(|p| p.to_path_buf());
    if let Some(p) = env {
        if p.is_file() {
            return Some((p, false));
        }
    }
    let pack = app_data.map(|d| pack_path(&d)).filter(|p| p.is_file())?;
    Some((pack, true))
}

/// ⭐ **每进程一次**的 pack 完整性结果缓存。
///
/// 为什么要有它：pack 是 60MB 级，算 sha256 要几百毫秒 ⇒ ⛔ 不能每次划词都算。
/// 为什么只缓一次而不是"永远信"：那份文件是**一次下载的产物**，进程活着的期间它不会变
/// （变了也是外部改的，那种情况下一进程一次足够挡住绝大多数）。
fn cached_pack_check(path: &Path) -> Result<(), String> {
    use std::sync::OnceLock;
    static CACHE: OnceLock<Result<(), String>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            pack_check(
                path,
                crate::abilities::ECDICT_PACK_BYTES,
                crate::abilities::expected_sha256(crate::abilities::ECDICT_PACK_ID).unwrap_or(""),
            )
        })
        .clone()
}

/// 查一个词/短语。返回的三种状态见 [`LookupOutcome`]。
#[tauri::command]
pub async fn dictionary_lookup(app: tauri::AppHandle, word: String) -> LookupOutcome {
    let _ = &app; // 路径只从 `db::app_data_dir_ref()` 取（与 `save_ability_pack` 同一个来源）
    match current_db_path() {
        // 能力包 ⇒ 先核完整性（长度每次 ＋ sha256 每进程一次）；不过就**不查**，把原因说出来。
        Some((p, true)) => match cached_pack_check(&p) {
            Err(why) => LookupOutcome::Unavailable { message: why },
            Ok(()) => lookup_at(&p, &word),
        },
        // 环境变量覆盖（开发/判据）⇒ 不核 pack 的 pin（那份 pin 是给上架产物的）。
        Some((p, false)) => lookup_at(&p, &word),
        None => LookupOutcome::Unavailable {
            message: format!(
                "本地英汉词库未就绪（既没有 {ENV_DB}，也没有能力包 {}）⇒ 这里不会假装查过；可在「设置 → 能力」里下载。",
                crate::abilities::ECDICT_PACK_ID
            ),
        },
    }
}

/// 词库状态读数（界面用它决定显不显示"本地词典"那一档）。
#[tauri::command]
pub async fn dictionary_status(app: tauri::AppHandle) -> DictionaryStatus {
    let _ = &app;
    let env = std::env::var_os(ENV_DB).map(PathBuf::from);
    let app_data = crate::db::app_data_dir_ref().map(|p| p.to_path_buf());
    let (path, verified) = match current_db_path() {
        Some((p, true)) => {
            let ok = cached_pack_check(&p).is_ok();
            (Some(p), Some(ok))
        }
        Some((p, false)) => (Some(p), None), // 开发覆盖口：没有可核的 pin
        None => (None, None),
    };
    status_at(path.as_deref(), env.as_deref(), app_data.as_deref(), verified)
}

// ---------------------------------------------------------------------------
// 判据（`cargo test --lib dictionary`）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// 一个**真的落盘**的 ECDICT 形状夹具（schema 与 `scripts/fetch-ecdict.mjs` 一致）。
    fn fixture_file(tag: &str) -> PathBuf {
        let path = crate::tempdir::file(tag, "db");
        let conn = Connection::open(&path).expect("建夹具库");
        conn.execute_batch(&format!(
            "CREATE TABLE {TABLE} (word TEXT PRIMARY KEY, phonetic TEXT, definition TEXT, translation TEXT, pos TEXT, collins INTEGER, oxford INTEGER, tag TEXT, bnc INTEGER, frq INTEGER, exchange TEXT, detail TEXT, audio TEXT);"
        ))
        .expect("建表");
        let rows = [
            ("apple", "ˈæpl", "a round fruit", "n. 苹果", "n", "zk gk"),
            ("note", "nəʊt", "a short written record", "n. 笔记；便条", "n v", "zk"),
            ("china", "ˈtʃaɪnə", "a country in east asia", "n. 中国", "n", "zk"),
            ("give up", "", "to stop trying", "phr. 放弃", "phr", ""),
        ];
        for (w, ph, def, tr, pos, tag) in rows {
            conn.execute(
                &format!("INSERT INTO {TABLE} (word, phonetic, definition, translation, pos, tag) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"),
                rusqlite::params![w, ph, def, tr, pos, tag],
            )
            .expect("插夹具行");
        }
        drop(conn);
        path
    }

    #[test]
    fn hits_the_exact_lowercase_word() {
        let p = fixture_file("dict-hit");
        let out = lookup_at(&p, "apple");
        match out {
            LookupOutcome::Found { matched, entry, .. } => {
                assert_eq!(matched, "apple");
                assert!(entry.translation.contains("苹果"), "释义应来自夹具：{:?}", entry);
            }
            other => panic!("apple 应当命中，实际 {other:?}"),
        }
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn normalizes_case_and_surrounding_punctuation() {
        // 划词常常把句号/引号一起选中；大小写也要能查（这是**规范化**，不是猜词形）。
        let p = fixture_file("dict-norm");
        for raw in ["Apple", "  apple  ", "\"apple,\"", "APPLE."] {
            match lookup_at(&p, raw) {
                LookupOutcome::Found { matched, .. } => assert_eq!(matched, "apple", "raw={raw:?}"),
                other => panic!("{raw:?} 应当命中，实际 {other:?}"),
            }
        }
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn capitalized_headword_is_reachable_by_typing_it_as_is() {
        // 上游有 `China` 这类首字母大写的词条 ⇒ 第 2 次尝试用**用户原样输入**查。
        let p = fixture_file("dict-case");
        match lookup_at(&p, "China") {
            LookupOutcome::Found { matched, entry, .. } => {
                assert_eq!(matched, "china");
                assert!(entry.translation.contains("中国"));
            }
            other => panic!("China 应当命中（大小写两条路），实际 {other:?}"),
        }
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn a_word_not_in_the_dictionary_is_reported_as_not_found_and_never_fabricated() {
        // ⭐ 这条就是任务里那条"看过它红"的判据：喂一个**不在词典里**的词。
        let p = fixture_file("dict-miss");
        let out = lookup_at(&p, "zzqxwv");
        match out {
            LookupOutcome::NotFound { kind, message, query } => {
                assert_eq!(kind, MissKind::NotFound);
                assert_eq!(query, "zzqxwv");
                assert!(message.contains("未收录"), "必须明说未收录：{message}");
                assert!(message.contains("AI"), "必须指出可走 AI：{message}");
                // ⛔ 不许出现任何"看起来像释义"的东西 —— 夹具里那几条释义一个都不许漏出来。
                for leaked in ["苹果", "笔记", "中国", "fruit", "record", "country"] {
                    assert!(!message.contains(leaked), "未收录文案里混进了释义「{leaked}」：{message}");
                }
            }
            other => panic!("不存在的词必须走未收录那条，实际 {other:?}"),
        }
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn chinese_terms_are_not_english_and_say_go_to_ai() {
        // ⭐ 评估文档 §3-③ 的那两个例子：中文术语**必然**落到这条。
        let p = fixture_file("dict-zh");
        for raw in ["方法论", "核聚变", "量子纠缠"] {
            match lookup_at(&p, raw) {
                LookupOutcome::NotFound { kind, message, .. } => {
                    assert_eq!(kind, MissKind::NotEnglish, "raw={raw:?}");
                    assert!(message.contains("英汉"), "要说清是英汉词典：{message}");
                    assert!(message.contains("AI"), "要指出走 AI：{message}");
                }
                other => panic!("{raw:?} 必须走「不是英文词条」那条，实际 {other:?}"),
            }
        }
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn empty_selection_and_too_long_selection_are_distinct_misses() {
        let p = fixture_file("dict-edge");
        match lookup_at(&p, "   ") {
            LookupOutcome::NotFound { kind, .. } => assert_eq!(kind, MissKind::Empty),
            other => panic!("空白应报 Empty，实际 {other:?}"),
        }
        let long = "a".repeat(QUERY_MAX_CHARS + 1);
        match lookup_at(&p, &long) {
            LookupOutcome::NotFound { kind, message, .. } => {
                assert_eq!(kind, MissKind::TooLong);
                assert!(message.contains("太长"), "{message}");
            }
            other => panic!("超长应报 TooLong，实际 {other:?}"),
        }
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn phrases_are_looked_up_too() {
        let p = fixture_file("dict-phrase");
        match lookup_at(&p, "give up") {
            LookupOutcome::Found { entry, .. } => assert!(entry.translation.contains("放弃")),
            other => panic!("短语应当能查，实际 {other:?}"),
        }
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn plaintext_file_survives_the_sqlcipher_build() {
        // ⭐ 这条是**实测**，不是推断：本仓的 rusqlite 是 `bundled-sqlcipher`，
        //   而词典库是**明文** SQLite（没调 PRAGMA key）。上面每条夹具测试都已经
        //   在真的文件上跑过一遍 —— 这条单独留一个名字，好让"到底验了没"一眼可核。
        let p = fixture_file("dict-plaintext");
        let conn = open_readonly(&p).expect("明文库必须能被只读打开");
        let n = count_entries(&conn).expect("数得出来词条数");
        assert_eq!(n, 4, "夹具应当是 4 条");
        drop(conn);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn missing_file_is_unavailable_not_a_miss() {
        // "没装词典"与"这个词未收录"必须分开：混在一起会让用户以为查过了。
        let p = crate::tempdir::file("dict-absent", "db");
        let _ = std::fs::remove_file(&p);
        match lookup_at(&p, "apple") {
            LookupOutcome::Unavailable { message } => {
                assert!(message.contains("未就绪"), "{message}")
            }
            other => panic!("词典文件不存在时必须报 Unavailable，实际 {other:?}"),
        }
    }

    #[test]
    fn unknown_schema_is_unavailable_not_an_empty_dictionary() {
        // 一个不认识的文件不该被当成"这本词典没这个词" —— 那会把"装错了"读成"未收录"。
        let p = crate::tempdir::file("dict-wrongschema", "db");
        {
            let conn = Connection::open(&p).expect("建库");
            conn.execute_batch("CREATE TABLE something_else (a TEXT);")
                .expect("建别的表");
        }
        match lookup_at(&p, "apple") {
            LookupOutcome::Unavailable { message } => {
                assert!(message.contains(TABLE), "{message}")
            }
            other => panic!("schema 不认识时必须报 Unavailable，实际 {other:?}"),
        }
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn candidate_paths_are_ordered_env_then_the_ability_pack() {
        let env = PathBuf::from("/tmp/env/ecdict.db");
        let app = PathBuf::from("/tmp/app");
        let got = candidate_paths(Some(&env), Some(&app));
        assert_eq!(
            got,
            vec![env.clone(), pack_path(&app)],
            "第 2 顺位必须是**能力包**落点（与 abilities.rs 的落盘形状一致）"
        );
        assert_eq!(
            pack_path(&app),
            app.join("packs")
                .join(crate::abilities::ECDICT_PACK_ID)
                .join(format!("{}.bin", crate::abilities::ECDICT_PACK_ID))
        );
        // 都没有时不许编一个出来（返回空表，而不是"猜测的默认路径"）。
        assert!(candidate_paths(None, None).is_empty());
    }

    #[test]
    fn pack_check_refuses_truncated_and_wrong_fingerprint() {
        // ⭐ owner 2026-10-09 第 ④ 条：**下载中断/半包 ⇒ 不许被当成已就绪**。
        //    这里用真的文件 ＋ 真的 sha256 验（不 mock）——两条判据各看它红一次。
        let p = fixture_file("dict-packcheck");
        let real_len = std::fs::metadata(&p).unwrap().len();
        let real_sha = sha256_file(&p).unwrap();

        // ① 字节数对不上（半包）⇒ 拒，且理由里能看出是"不完整"
        let e = pack_check(&p, real_len + 1, &real_sha).unwrap_err();
        assert!(e.contains("不完整"), "{e}");

        // ② 长度对得上、但指纹不符（内容被换过/写坏）⇒ 拒
        let bogus = "0".repeat(64);
        let e = pack_check(&p, real_len, &bogus).unwrap_err();
        assert!(e.contains("指纹"), "{e}");

        // ③ 两个都对 ⇒ 过
        assert!(pack_check(&p, real_len, &real_sha).is_ok());

        // ④ 没钉指纹（expected_sha 空）⇒ **也不算过**（不核 = 不能声称就绪）
        let e = pack_check(&p, real_len, "").unwrap_err();
        assert!(e.contains("sha256"), "{e}");

        // ⑤ 文件不存在 ⇒ 拒（不是"未收录"）
        let missing = crate::tempdir::file("dict-packcheck-absent", "bin");
        let _ = std::fs::remove_file(&missing);
        assert!(pack_check(&missing, real_len, &real_sha).is_err());

        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn status_says_not_ready_instead_of_pretending() {
        let st = status_at(None, None, None, None);
        assert!(!st.available);
        assert!(st.path.is_none() && st.entries.is_none());
        assert_eq!(st.verified, None);
        assert!(st.message.contains("未就绪"), "{}", st.message);
        // ⛔ 文案里不许出现**肯定**就绪的说法（"未就绪"里也含"就绪"两字 ⇒ 判据不能只看那两个字）。
        assert!(!st.message.contains("词库就绪"), "{}", st.message);

        let p = fixture_file("dict-status");
        let st = status_at(Some(&p), None, None, Some(true));
        assert!(st.available);
        assert_eq!(st.entries, Some(4));
        assert!(st.bytes.unwrap_or(0) > 0);
        assert_eq!(st.source.as_deref(), Some("unknown"));
        assert_eq!(st.verified, Some(true));
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn status_with_a_failed_integrity_check_is_not_available() {
        // ⭐ 半包/指纹不符时，状态里 `available` 必须是 **false** —— 否则界面会显示"就绪"，
        //    而查询那条路又会拒（同一个文件两种说法 = 用户看到的自相矛盾）。
        let p = fixture_file("dict-status-bad");
        let st = status_at(Some(&p), None, None, Some(false));
        assert!(!st.available);
        assert_eq!(st.verified, Some(false));
        assert!(st.message.contains("完整性"), "{}", st.message);
        let _ = std::fs::remove_file(&p);
    }

    /// ⭐ 对**真的 ECDICT 产出**跑一次（数据不入库 ⇒ 本机没这个环境变量时**自报跳过**）。
    ///
    /// 用法：`$env:SHUYONOTE_ECDICT_DB = "<...>\ecdict.db"; cargo test --lib dictionary -- --nocapture`
    /// ⚠️ **跳过 ≠ 通过** —— 没装数据时它只打印一行 SKIP，不会让这条变绿来充数。
    #[test]
    fn real_ecdict_sample_when_available() {
        let Ok(path) = std::env::var(ENV_DB) else {
            println!("SKIP real_ecdict_sample_when_available：没有 {ENV_DB}（数据不入库）");
            return;
        };
        let path = PathBuf::from(path);
        if !path.is_file() {
            println!("SKIP real_ecdict_sample_when_available：{ENV_DB} 指向的文件不存在");
            return;
        }
        let mut hits = 0;
        let mut total = 0;
        for w in ["apple", "note", "computer", "method"] {
            total += 1;
            if let LookupOutcome::Found { entry, .. } = lookup_at(&path, w) {
                hits += 1;
                println!(
                    "  hit  {w:>10} → {}（{} 字）",
                    truncate(&entry.translation, 60),
                    entry.translation.chars().count()
                );
            } else {
                println!("  MISS {w:>10}（真词典里没有？先核数据，别改判据）");
            }
        }
        // 真词典里必须查不到的东西：中文术语与乱码。
        for w in ["方法论", "核聚变", "zzqxwv"] {
            total += 1;
            match lookup_at(&path, w) {
                LookupOutcome::NotFound { kind, .. } => {
                    hits += 1;
                    println!("  miss {w:>10} → {kind:?}（如实未收录 ✓）");
                }
                other => panic!("{w:?} 在真词典上必须走未收录，实际 {other:?}"),
            }
        }
        assert_eq!(hits, total, "英文样本应全部命中、中文/乱码应全部如实未收录");
    }
}
