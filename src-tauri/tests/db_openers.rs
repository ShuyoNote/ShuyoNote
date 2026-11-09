//! P3-0c 第一小步：**DB 开库点盘点 ＋ “新增写者”守卫**（只读源码，不改生产行为）。
//!
//! # 这个文件挡什么
//!
//! 同一个空间库今天会被**多条连接**打开：主连接、网格窗口的逐空间连接、后台轮次的
//! 逐空间连接、锁定态被换成内存库的 meta 连接 ……（ADR §2.1／§5.1）。`busy_timeout = 500ms`
//! 意味着“多一个没人知道的写者”会以**偶发 busy/锁等待**的形式出现，而不是报错。
//! ⇒ P3-1b 之前先把“**谁在开库**”钉成一张表：**新增开库点必须登记**，否则本测试红。
//!
//! # 登记表是什么
//!
//! [`REGISTERED`] 的每一条是 `(源文件, 函数名, 允许的连接数, 用途一句话)`：
//! * **只有**这些 `(文件, 函数)` 里允许出现开库调用，且**处数必须等于登记数**；
//! * **同一函数里多开一条连接也要登记** —— 这是 2026-11-08 的收紧点：本文件挡的是“新增写者”，
//!   而“在已登记的函数里再开一条”同样是一个新写者（以前按 `(文件, 函数)` 去重会漏掉它）；
//! * 处数**变少**（删/合并连接）也要同步改：数字偏大 = 给未来偷加的一条留了空位；
//! * 登记表**不许有重复/过期条目**（过期 = 源码里已经没有开库点了 ⇒ 会悄悄放行未来的同名函数）。
//!
//! # 维护动作（**有意**的成本，别绕过）
//!
//! 1. **加**一处开库/旁路连接 ⇒ 那个函数的 `expected_count` ＋1（新函数则整条新增）；
//! 2. **删/合并**连接 ⇒ `expected_count` −1；删到 0 ⇒ 删掉整条登记（否则 `registry_has_no_stale_entries` 红）；
//! 3. 改完跑 `cargo test --manifest-path src-tauri/Cargo.toml --test db_openers`；
//! 4. ⚠️ **不要**为了让红变绿而随手改数字：每个数字背后是一条真连接，先问它和 P3-1b 单连接计划的关系。
//!
//! # 扫描口径（“开库点”指什么）
//!
//! 1. **直连开库**：`Connection::open` / `Connection::open_with_flags` / `Connection::open_in_memory`
//!    / `Connection::open_in_memory_with_flags`（rusqlite 今天的四个入口）；
//! 2. **旁路连接**：对 `open_space_conn` / `open_space_conn_at` / `open_space_conn_inner`
//!    / `open_meta_conn` / `open_meta_conn_at` 的**调用**（它们最终都会开一条新连接）；
//!    ⚠️ 这些 helper 的**定义**不算调用点（它们内部自己的 `Connection::open` 会被第 1 条抓到 ✓）。
//! 3. 每处命中按**所在函数**归属（最近一个 `fn name(`）并**逐处计数**；登记键是 `file + fn`，判据比的是**处数**。
//!
//! # 明确不扫（**已知漏扫**，别把本测试当成“证明没有其它开库点”）
//!
//! * 注释/字符串里的字面量（有夹具判据：`comments_and_strings_are_not_open_points`）；
//! * `#[cfg(test)]` 项/模块里的代码（有夹具判据：`cfg_test_code_is_not_a_production_opener`）；
//! * `build.rs` / `tests/**` / `benches/**`：本测试只看 `src/**/*.rs`；
//! * **宏展开后才出现的**代码（`include!` / `macro_rules!` 的展开体不追；只扫宏定义处的源码文本）；
//! * **别名/间接**：`use rusqlite::Connection as C; C::open(...)`、函数指针、trait 对象上的 open；
//! * 其它 crate 的封装（本仓今天没有；将来有 ⇒ 登记或扩模式）；
//! * ⚠️ **cfg 分支是文本级扫描、不评估 cfg** ⇒ `cfg(feature)`／`cfg(target_os)` 的分支**也照扫**
//!   （宁可多登记、不漏；这与“编译时才知道”的那一半是两回事）。
//!
//! ⚠️ 本测试**只在源码树上跑**：不联网、不开库、不读写用户数据（`env!("CARGO_MANIFEST_DIR")`）。
use regex::Regex;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

/// 允许开库的 `(源文件, 函数, 该函数内允许的连接数, 用途一句话)` —— 2026-11-08 只读盘点的结果：
/// **72 个函数 / 87 处连接**（59 个函数 1 处；10 个 2 处；`space_import::import_space_package_in` 3 处；
/// `db::init` 4 处 —— 分布原因见各条用途；2026-11-09 增 `lan_quic::process_registry` 1 处）。
///
/// ⚠️ 加一条**不是**“让测试变绿”的手段：先问“这条新连接由谁负责、和 P3-1b 的单连接计划什么关系”。
/// ⚠️ **同一个已登记函数里多开一条**也会红（判据 `a_second_connection_in_the_same_function_is_caught_unless_registered`）。
/// ⚠️ 条目过期（源码里已经没有开库点）会让 [`registry_has_no_stale_entries`] 红。
const REGISTERED: &[(&str, &str, usize, &str)] = &[
    (
        "src/attachments.rs",
        "backfill_attachment_changes_all",
        1,
        "跨空间回填附件变更行：逐空间直连打开空间库",
    ),
    (
        "src/attachments.rs",
        "cross_space_refs",
        1,
        "扫附件被哪些空间引用：逐空间只读连接",
    ),
    (
        "src/attachments.rs",
        "delete_attachment_cross_space",
        1,
        "跨空间删附件：逐空间连接清引用",
    ),
    (
        "src/attachments.rs",
        "detach_attachment",
        1,
        "摘下附件引用：逐空间连接",
    ),
    (
        "src/attachments.rs",
        "list_page_attachments",
        1,
        "列页面附件：跨空间读该空间库",
    ),
    (
        "src/attachments.rs",
        "migrate_legacy_layout",
        2,
        "旧附件布局迁移：逐空间连接改引用",
    ),
    (
        "src/attachments.rs",
        "move_attachment",
        1,
        "跨空间移动附件：源/目标空间连接",
    ),
    (
        "src/attachments.rs",
        "rename_attachment",
        1,
        "跨空间改名附件：逐空间连接",
    ),
    ("src/backup.rs", "backup_db", 1, "备份目标库：直开目标文件"),
    (
        "src/backup.rs",
        "export_backup",
        1,
        "导出备份：直开 meta 读清单",
    ),
    (
        "src/backup.rs",
        "import_backup",
        2,
        "导入备份：直开快照与目标库",
    ),
    (
        "src/backup.rs",
        "orphan_space_ids",
        1,
        "备份前找孤儿空间：直开 meta",
    ),
    (
        "src/backup.rs",
        "register_space",
        1,
        "导入/恢复时登记空间：直开 meta",
    ),
    (
        "src/backup.rs",
        "snapshot_spaces",
        1,
        "逐空间拍快照：直开各空间库",
    ),
    (
        "src/backup.rs",
        "space_exists",
        1,
        "备份前查空间存在：直开 meta",
    ),
    (
        "src/backup_verify.rs",
        "count_pages_in_spaces",
        1,
        "备份校验：只读方式逐空间数页数",
    ),
    (
        "src/commands.rs",
        "create_folder",
        1,
        "命令：建文件夹（开该空间库）",
    ),
    (
        "src/commands.rs",
        "create_page_in_space",
        2,
        "命令：在指定空间建页（meta＋空间库）",
    ),
    (
        "src/commands.rs",
        "delete_page",
        1,
        "命令：删页（开该空间库）",
    ),
    (
        "src/commands.rs",
        "get_page",
        1,
        "命令：读某空间单页（开该空间库）",
    ),
    (
        "src/commands.rs",
        "list_workspace_pages",
        1,
        "命令：列某空间页列表（开该空间库）",
    ),
    (
        "src/commands.rs",
        "move_page",
        1,
        "命令：移页（开该空间库）",
    ),
    (
        "src/commands.rs",
        "save_page",
        1,
        "命令：存页（开该空间库）",
    ),
    (
        "src/db.rs",
        "init",
        4,
        "启动初始化：建/开 meta 与空间库主连接",
    ),
    (
        "src/db.rs",
        "open_meta_conn_at",
        1,
        "meta.db 的独立连接（插件/窗口旁路用）",
    ),
    (
        "src/db.rs",
        "open_prepared_space_at",
        1,
        "换库后重开：主连接的唯一准备入口",
    ),
    (
        "src/db.rs",
        "open_space_conn",
        1,
        "任意空间库的旁路连接入口（无显式目录）",
    ),
    (
        "src/db.rs",
        "open_space_conn_at",
        1,
        "任意空间库的旁路连接入口（带显式目录，可测）",
    ),
    (
        "src/db.rs",
        "open_space_conn_inner",
        1,
        "空间库唯一的底层开库实现（key/WAL/ATTACH meta）",
    ),
    (
        "src/dictionary.rs",
        "open_readonly",
        1,
        "词典数据只读打开（第三方只读库）",
    ),
    (
        "src/gm_provider.rs",
        "generate_sm3_fixture",
        1,
        "生成国密夹具临时库（校验用）",
    ),
    (
        "src/gm_provider.rs",
        "library_recognizes_gm_labels",
        1,
        "探测加密后端能力：一次性内存库",
    ),
    (
        "src/lan_quic.rs",
        "process_registry",
        1,
        "QUIC 端点身份：只读打开 meta.db 取 device_identity_sk seed（与公告 pubkey 同源；不写库）",
    ),
    (
        "src/lan_state.rs",
        "spawn_background_round",
        1,
        "后台网格轮次：逐空间旁路连接",
    ),
    (
        "src/mesh.rs",
        "add_space",
        1,
        "窗口增加服务空间：再开一条空间库连接",
    ),
    (
        "src/mesh.rs",
        "ensure_window",
        1,
        "确保网格窗口：开该空间库",
    ),
    (
        "src/mesh.rs",
        "load_cards",
        1,
        "窗口载入配对卡：开 meta 连接",
    ),
    (
        "src/mesh.rs",
        "open_window_at",
        1,
        "网格窗口连接（每窗口一条空间库连接）",
    ),
    (
        "src/mesh.rs",
        "read_public_material",
        1,
        "读加密空间公开材料：开 meta 连接",
    ),
    (
        "src/mesh.rs",
        "sealed_round",
        1,
        "密文轮次收封包：开 meta 连接",
    ),
    (
        "src/mesh.rs",
        "serve_locked_outbox",
        1,
        "锁定态发件箱服务：开 meta 连接",
    ),
    (
        "src/mesh_wire_bytes.rs",
        "conn_with",
        1,
        "测试夹具（未 cfg(test) 隔离：生产模块内的内存库）",
    ),
    (
        "src/plugins.rs",
        "cap_pages_create",
        2,
        "插件能力建页：meta＋空间库",
    ),
    (
        "src/plugins.rs",
        "plugin_settings",
        2,
        "读插件设置：meta 与空间库",
    ),
    (
        "src/plugins.rs",
        "resolve_active_space_from",
        1,
        "解析活动空间：开 meta",
    ),
    (
        "src/plugins.rs",
        "set_plugin_setting",
        2,
        "写插件设置：meta 与空间库",
    ),
    (
        "src/plugins.rs",
        "with_conn_for_space",
        2,
        "插件读写通道：按空间开库",
    ),
    (
        "src/plugins.rs",
        "with_meta_conn",
        1,
        "插件 meta 通道：开 meta",
    ),
    (
        "src/plugins.rs",
        "with_read_conn",
        2,
        "插件只读通道：按空间开库",
    ),
    (
        "src/properties.rs",
        "remove_page_prop",
        1,
        "跨空间删属性：开该空间库",
    ),
    (
        "src/properties.rs",
        "set_page_prop",
        1,
        "跨空间写属性：开该空间库",
    ),
    ("src/search.rs", "search", 1, "跨空间搜索：逐空间只读连接"),
    (
        "src/security.rs",
        "convert_space_db",
        2,
        "加密/解密转换：直开临时/目标库",
    ),
    (
        "src/security.rs",
        "lock_encryption_impl",
        1,
        "锁定加密：把主连接换成内存库",
    ),
    (
        "src/security.rs",
        "provision_spaces_from_keyring",
        1,
        "按钥匙袋补建空间库：直开新建文件",
    ),
    (
        "src/security.rs",
        "rebuild_space_db",
        2,
        "重建空间库：直开源/目标文件",
    ),
    (
        "src/space_crypto.rs",
        "disable_space",
        1,
        "关闭空间加密：同上",
    ),
    (
        "src/space_crypto.rs",
        "enable_space",
        1,
        "开启空间加密：换库前用内存库占位",
    ),
    (
        "src/space_import.rs",
        "import_space_package_in",
        3,
        "导入空间包：开 meta 与目标空间库",
    ),
    (
        "src/storage.rs",
        "purge_deleted_workspaces",
        1,
        "清理已删空间：逐空间旁路连接",
    ),
    (
        "src/storage.rs",
        "scan_attachment_facts",
        1,
        "附件盘点：逐空间旁路连接",
    ),
    (
        "src/sync.rs",
        "mesh_sync_one",
        1,
        "手动/批量网格同步的唯一实现（mesh_sync_now 只做命令面转发）：逐空间旁路连接",
    ),
    ("src/tags.rs", "add_tag", 1, "跨空间加标签：开该空间库"),
    ("src/tags.rs", "remove_tag", 1, "跨空间删标签：开该空间库"),
    (
        "src/trash.rs",
        "restore_page",
        1,
        "跨空间恢复回收站页：开该空间库",
    ),
    (
        "src/versions.rs",
        "restore_version",
        1,
        "跨空间恢复版本：开该空间库",
    ),
    (
        "src/workspace_io.rs",
        "backup_db_to",
        1,
        "快照拷贝：直开目标文件",
    ),
    (
        "src/workspace_io.rs",
        "rewrite_asset_refs_in_space_db",
        1,
        "导入后改写附件引用：直开空间库文件",
    ),
    (
        "src/workspace_io.rs",
        "snapshot_plaintext",
        1,
        "明文快照：直开目标文件",
    ),
    (
        "src/workspace_io.rs",
        "trim_changes_for_export",
        1,
        "导出裁剪变更日志：直开快照",
    ),
    (
        "src/workspaces.rs",
        "copy_page_to_workspace",
        1,
        "跨空间复制页：开目标空间库",
    ),
    (
        "src/workspaces.rs",
        "park_locked_connection",
        1,
        "锁定态：把主连接换成内存库",
    ),
];

/// **一处**真实开库命中（⛔ 不按函数归并：同一函数里两条连接就是两个 `Hit` —— 判据数的是处数）。
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Hit {
    /// `src/xxx.rs`（相对 `src-tauri/`，正斜杠）。
    file: String,
    /// 所在函数名；不在函数里 ⇒ `<top>`。
    func: String,
    /// `"direct"`（`Connection::open*`）／`"helper"`（`open_space_conn*`／`open_meta_conn*` 调用）。
    kind: &'static str,
    /// 1 起的行号（只用于报错点名）。
    line: usize,
}

impl std::fmt::Display for Hit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}:{} fn={} [{}]",
            self.file, self.line, self.func, self.kind
        )
    }
}

fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// 从 `quote`（一个 `"` 的下标）扫到配对的收尾引号之后（半开区间右端）。
fn scan_quoted(b: &[u8], quote: usize) -> usize {
    let mut j = quote + 1;
    while j < b.len() {
        if b[j] == b'\\' {
            j += 2;
            continue;
        }
        if b[j] == b'"' {
            return j + 1;
        }
        j += 1;
    }
    b.len()
}

/// 从 `quote` 扫到 raw 字符串的收尾（`"` + `hashes` 个 `#`）之后。
fn scan_raw(b: &[u8], quote: usize, hashes: usize) -> usize {
    let mut j = quote + 1;
    while j < b.len() {
        if b[j] == b'"' {
            let mut k = 0;
            while k < hashes && j + 1 + k < b.len() && b[j + 1 + k] == b'#' {
                k += 1;
            }
            if k == hashes {
                return j + 1 + hashes;
            }
        }
        j += 1;
    }
    b.len()
}

/// 若 `i` 处开始一个 raw 字符串（`r"…"` / `r#"…"#` / `br"…"` / `br#"…"#`），返回 (引号下标, `#` 数)。
fn raw_string_at(b: &[u8], i: usize) -> Option<(usize, usize)> {
    if i > 0 && is_ident_byte(b[i - 1]) {
        return None; // 是标识符的一部分（例如 `rebuild`），不是 r"" 前缀
    }
    let mut j = i;
    if b[j] == b'b' && j + 1 < b.len() && b[j + 1] == b'r' {
        j += 2;
    } else if b[j] == b'r' {
        j += 1;
    } else {
        return None;
    }
    let mut hashes = 0;
    while j < b.len() && b[j] == b'#' {
        hashes += 1;
        j += 1;
    }
    if j < b.len() && b[j] == b'"' {
        Some((j, hashes))
    } else {
        None
    }
}

/// 注释 ＋ 普通/字节/raw 字符串 ＋ 字符字面量的跨度（半开区间；字节下标）。
///
/// ⚠️ **必须**认 raw 字符串：本仓大量 SQL 夹具就是 `r#"…{…}…"#`，不认它就会把 SQL 里的
/// `{`／`}` 当代码括号（测试模块范围算错 ⇒ 把测试代码当产品开库点，或反过来漏扫）。
fn noncode_spans(src: &str) -> Vec<(usize, usize)> {
    let b = src.as_bytes();
    let n = b.len();
    let mut spans = Vec::new();
    let mut i = 0usize;
    while i < n {
        // 行注释
        if b[i] == b'/' && i + 1 < n && b[i + 1] == b'/' {
            let mut j = i + 2;
            while j < n && b[j] != b'\n' {
                j += 1;
            }
            spans.push((i, j));
            i = j;
            continue;
        }
        // 块注释（Rust 允许嵌套）
        if b[i] == b'/' && i + 1 < n && b[i + 1] == b'*' {
            let mut depth = 1usize;
            let mut j = i + 2;
            while j < n && depth > 0 {
                if j + 1 < n && b[j] == b'/' && b[j + 1] == b'*' {
                    depth += 1;
                    j += 2;
                } else if j + 1 < n && b[j] == b'*' && b[j + 1] == b'/' {
                    depth -= 1;
                    j += 2;
                } else {
                    j += 1;
                }
            }
            spans.push((i, j));
            i = j;
            continue;
        }
        // raw 字符串（含 br""）
        if let Some((quote, hashes)) = raw_string_at(b, i) {
            let end = scan_raw(b, quote, hashes);
            spans.push((i, end));
            i = end;
            continue;
        }
        // 字节串 b"…" / C 串 c"…"：从引号那个字节起都按普通串扫
        if (b[i] == b'b' || b[i] == b'c')
            && i + 1 < n
            && b[i + 1] == b'"'
            && (i == 0 || !is_ident_byte(b[i - 1]))
        {
            let end = scan_quoted(b, i + 1);
            spans.push((i, end));
            i = end;
            continue;
        }
        // 普通字符串
        if b[i] == b'"' {
            let end = scan_quoted(b, i);
            spans.push((i, end));
            i = end;
            continue;
        }
        // 字符字面量 / 生命周期
        if b[i] == b'\'' {
            // 转义形式：'\n' / '\'' / '\u{…}'
            if i + 1 < n && b[i + 1] == b'\\' {
                let mut j = i + 2;
                while j < n && b[j] != b'\'' {
                    j += 1;
                }
                let end = if j < n { j + 1 } else { n };
                spans.push((i, end));
                i = end;
                continue;
            }
            // 普通单字符：'x' / '中'
            if let Some(ch) = src[i + 1..].chars().next() {
                let clen = ch.len_utf8();
                let close = i + 1 + clen;
                if close < n && b[close] == b'\'' {
                    spans.push((i, close + 1));
                    i = close + 1;
                    continue;
                }
            }
            // 生命周期（'a、'static …）不是字面量：跳过这个 `'`
            i += 1;
            continue;
        }
        i += 1;
    }
    spans
}

/// 把注释/字符串/字符字面量替换成空格（**字节长度与换行都保留**）⇒ 后续正则只会命中“代码”。
fn blank_noncode(src: &str) -> String {
    let mut bytes = src.as_bytes().to_vec();
    for (a, b) in noncode_spans(src) {
        for k in a..b.min(bytes.len()) {
            if bytes[k] != b'\n' {
                bytes[k] = b' ';
            }
        }
    }
    String::from_utf8(bytes).expect("blank 之后仍是合法 UTF-8（跨度边界都在 ASCII 分隔符上）")
}

/// `#[cfg(test)]` 项/模块占的行区间（1 起，闭区间）—— 测试代码里的开库点不算产品开库点。
///
/// 做法：**逐行扫**。遇到 `cfg(test)`／`cfg(all(test`／`cfg(any(test` 标记就记一个区间的开头，
/// 往后数 `{`／`}`（字符串/注释已空掉），回到 0 或先遇到顶层 `;`（`use`/`static` 那种无块项）就收尾。
/// ⚠️ 刻意**不**把 `#[cfg(not(test))]` 当测试：那正相反，是**生产**分支（夹具判据钉着）。
fn test_line_ranges(src: &str) -> Vec<(usize, usize)> {
    let blank = blank_noncode(src);
    let lines: Vec<&str> = blank.split('\n').collect();
    let mut ranges = Vec::new();
    let mut i = 0usize;
    while i < lines.len() {
        let t = lines[i].trim();
        let marker =
            t.contains("cfg(test)") || t.contains("cfg(all(test") || t.contains("cfg(any(test");
        if !marker {
            i += 1;
            continue;
        }
        let start = i + 1; // 1 起
        let mut depth: i64 = 0;
        let mut seen_open = false;
        let mut end = lines.len();
        let mut closed = false;
        for j in i..lines.len() {
            for ch in lines[j].chars() {
                if ch == '{' {
                    depth += 1;
                    seen_open = true;
                } else if ch == '}' {
                    depth -= 1;
                }
            }
            if seen_open && depth <= 0 {
                end = j + 1;
                closed = true;
                break;
            }
            // 无块项（`#[cfg(test)] use …;` / `static …;`）：以该行结尾收
            if !seen_open && lines[j].contains(';') {
                end = j + 1;
                closed = true;
                break;
            }
        }
        ranges.push((start, if closed { end } else { lines.len() }));
        i = if closed { end } else { lines.len() };
    }
    ranges
}

/// 扫**一份源码文本**，返回**每一处**真实开库命中（⛔ 不按函数去重：判据要数“函数内有几处”）。
fn scan_source(file: &str, src: &str) -> Vec<Hit> {
    let blank = blank_noncode(src);
    let ranges = test_line_ranges(src);
    let at_line = |idx: usize| {
        blank.as_bytes()[..idx]
            .iter()
            .filter(|&&b| b == b'\n')
            .count()
            + 1
    };
    // rusqlite 今天的四个开库入口都要认：open / open_in_memory / open_with_flags / open_in_memory_with_flags。
    let direct =
        Regex::new(r"\bConnection::open(?:_with_flags|_in_memory(?:_with_flags)?)?\s*\(").unwrap();
    let helper =
        Regex::new(r"\b(?:open_space_conn(?:_at|_inner)?|open_meta_conn(?:_at)?)\s*\(").unwrap();
    let def_tail = Regex::new(r"\bfn\s+$").unwrap();
    let fn_re = Regex::new(r"\bfn\s+([A-Za-z0-9_]+)\s*[<(]").unwrap();

    let mut out: Vec<Hit> = Vec::new();
    for (re, kind) in [(&direct, "direct"), (&helper, "helper")] {
        for m in re.find_iter(&blank) {
            let idx = m.start();
            let line = at_line(idx);
            if ranges.iter().any(|&(a, b)| line >= a && line <= b) {
                continue; // 测试代码
            }
            let pre = &blank[..idx];
            if kind == "helper" && def_tail.is_match(pre) {
                continue; // helper 的**定义**行，不是调用
            }
            let func = fn_re
                .captures_iter(pre)
                .last()
                .map(|c| c[1].to_string())
                .unwrap_or_else(|| "<top>".to_string());
            out.push(Hit {
                file: file.to_string(),
                func,
                kind,
                line,
            });
        }
    }
    out
}

fn collect_rs_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        let p = entry.path();
        if p.is_dir() {
            collect_rs_files(&p, out);
        } else if p.extension().and_then(|s| s.to_str()) == Some("rs") {
            out.push(p);
        }
    }
}

/// 扫整棵 `src/**/*.rs`；返回 (命中, 扫到的文件数)。
fn scan_tree() -> (Vec<Hit>, usize) {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut files: Vec<PathBuf> = Vec::new();
    collect_rs_files(&root.join("src"), &mut files);
    files.sort();
    let mut hits = Vec::new();
    for p in &files {
        let src = fs::read_to_string(p).expect("读不了源码文件");
        let rel = p
            .strip_prefix(root)
            .expect("文件不在 src-tauri 下？")
            .to_string_lossy()
            .replace('\\', "/");
        hits.extend(scan_source(&rel, &src));
    }
    (hits, files.len())
}

/// 某 `(文件, 函数)` 登记了几处连接（没有 ⇒ `None`）。
fn registered_count(file: &str, func: &str) -> Option<usize> {
    REGISTERED
        .iter()
        .find(|(f, n, _, _)| *f == file && *n == func)
        .map(|(_, _, count, _)| *count)
}

/// 在任意「登记表」里查某函数允许几处（夹具测试喂假表时也走它）。
fn expected_for(expected: &[(&str, &str, usize, &str)], file: &str, func: &str) -> Option<usize> {
    expected.iter().find_map(|e| {
        if e.0 == file && e.1 == func {
            Some(e.2)
        } else {
            None
        }
    })
}

/// 真实命中里**没有登记**的那些（供夹具测试用；守卫本体见 [`count_problems`]）。
fn unregistered(hits: &[Hit]) -> Vec<&Hit> {
    hits.iter()
        .filter(|h| registered_count(&h.file, &h.func).is_none())
        .collect()
}

/// 一处“与登记表对不上”的问题。三类分开说 —— 处置完全不同：
/// * `Unregistered`：整个函数没登记（真·新写者）；
/// * `TooMany`：**同一个已登记函数里多了一条**（本次收紧要抓的那种）；
/// * `TooFew`：登记数比实际多（删/合并了连接但没改数字 ⇒ 会给未来偷加的一条留空位）。
#[derive(Debug, PartialEq, Eq)]
enum CountProblem {
    Unregistered {
        file: String,
        func: String,
        actual: usize,
    },
    TooMany {
        file: String,
        func: String,
        expected: usize,
        actual: usize,
    },
    TooFew {
        file: String,
        func: String,
        expected: usize,
        actual: usize,
    },
}

impl CountProblem {
    fn sort_key(&self) -> (u8, &str, &str) {
        match self {
            CountProblem::Unregistered { file, func, .. } => (0, file, func),
            CountProblem::TooMany { file, func, .. } => (1, file, func),
            CountProblem::TooFew { file, func, .. } => (2, file, func),
        }
    }
}

impl std::fmt::Display for CountProblem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CountProblem::Unregistered { file, func, actual } => write!(
                f,
                "{file}::{func} 有 {actual} 处开库/旁路连接，但**整个函数没登记** \
                 ⇒ 新写者？把 (文件, 函数, {actual}, 用途) 加进 REGISTERED"
            ),
            CountProblem::TooMany {
                file,
                func,
                expected,
                actual,
            } => write!(
                f,
                "{file}::{func} 实际 {actual} 处 > 登记 expected={expected} \
                 ⇒ **同一个已登记函数里又加了一条连接**（同函数新增写者也要登记！）\
                 把 expected 改成 {actual}，并在用途里说清为什么多一条"
            ),
            CountProblem::TooFew {
                file,
                func,
                expected,
                actual,
            } => write!(
                f,
                "{file}::{func} 实际 {actual} 处 < 登记 expected={expected} \
                 ⇒ 连接被删/合并了？把 expected 改成 {actual} —— 数字偏大会给未来偷加的一条留空位"
            ),
        }
    }
}

/// 守卫本体：把「真实命中数」与「登记表」**逐函数、按处数**对比；返回的每条都是要人处理的差异。
///
/// ⚠️ 夹具测试直接喂「假登记表」进来（见 `a_second_connection_in_the_same_function_...`），
/// 所以这里**不读**全局 `REGISTERED`。
fn count_problems(hits: &[Hit], expected: &[(&str, &str, usize, &str)]) -> Vec<CountProblem> {
    let mut actual: std::collections::BTreeMap<(&str, &str), usize> =
        std::collections::BTreeMap::new();
    for h in hits {
        *actual
            .entry((h.file.as_str(), h.func.as_str()))
            .or_default() += 1;
    }
    let mut problems = Vec::new();
    for ((file, func), n) in &actual {
        match expected_for(expected, file, func) {
            None => problems.push(CountProblem::Unregistered {
                file: file.to_string(),
                func: func.to_string(),
                actual: *n,
            }),
            Some(exp) if *n > exp => problems.push(CountProblem::TooMany {
                file: file.to_string(),
                func: func.to_string(),
                expected: exp,
                actual: *n,
            }),
            Some(exp) if *n < exp => problems.push(CountProblem::TooFew {
                file: file.to_string(),
                func: func.to_string(),
                expected: exp,
                actual: *n,
            }),
            _ => {}
        }
    }
    problems.sort_by(|a, b| a.sort_key().cmp(&b.sort_key()));
    problems
}

/// 登记表里**源码中已经找不到**的条目（过期 ⇒ 测试红，免得它悄悄放行未来的同名函数）。
fn stale_entries(hits: &[Hit]) -> Vec<(&'static str, &'static str)> {
    REGISTERED
        .iter()
        .filter(|(file, func, _, _)| !hits.iter().any(|h| h.file == *file && h.func == *func))
        .map(|(file, func, _, _)| (*file, *func))
        .collect()
}

// ─────────────────────────────── 判据 ───────────────────────────────

#[test]
fn the_registry_is_not_empty_and_entries_are_well_formed() {
    assert!(
        REGISTERED.len() >= 70,
        "登记表只有 {} 条 —— 2026-11-08 盘点是 71 条；少了说明盘点被改坏了（不是“开库点变少”这么简单，先重跑盘点）",
        REGISTERED.len()
    );
    let mut seen = BTreeSet::new();
    let mut total = 0usize;
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    for (file, func, count, purpose) in REGISTERED {
        assert!(
            seen.insert((*file, *func)),
            "登记表重复条目：({file}, {func}) —— 重复会让“过期条目”判据失真"
        );
        assert!(
            *count >= 1,
            "登记条目 {file}::{func} 的 expected_count 是 0：没有连接就该删掉整条登记，别留一个放行位"
        );
        total += *count;
        assert!(
            func.trim().len() >= 3,
            "登记条目 {file} 的函数名太短：{func:?}"
        );
        assert!(
            purpose.trim().len() >= 6,
            "登记条目 {file}::{func} 没写清用途（≤5 字符）：{purpose:?}"
        );
        assert!(
            root.join(file).is_file(),
            "登记表指向的源码文件不存在：{file}（改名/删除后要同步登记表）"
        );
    }
    assert!(
        total >= 80,
        "登记表合计只有 {total} 处连接（2026-11-08 收紧时是 86 处）—— 数字被改坏了？先重跑盘点"
    );
}

#[test]
fn the_scan_actually_covers_the_tree_and_the_core_openers() {
    let (hits, files) = scan_tree();
    assert!(
        files >= 100,
        "只扫到 {files} 个 .rs 文件 —— 扫描面明显变小了（是不是目录/扩展名规则改坏了？）"
    );
    assert!(
        hits.len() >= 80,
        "只命中 {} 处开库/旁路连接（2026-11-08 收紧时是 86 处 / 71 个函数）—— 扫描器可能静默失效了（这正是它要防的那类假绿）",
        hits.len()
    );
    let keys: BTreeSet<(&str, &str)> = hits
        .iter()
        .map(|h| (h.file.as_str(), h.func.as_str()))
        .collect();
    // 核心锚点：库的底层实现、主连接、网格窗口、后台轮次、手动同步、锁定态换内存库。
    for anchor in [
        ("src/db.rs", "open_space_conn_inner"),
        ("src/db.rs", "open_meta_conn_at"),
        ("src/db.rs", "init"),
        ("src/mesh.rs", "open_window_at"),
        ("src/lan_state.rs", "spawn_background_round"),
        ("src/sync.rs", "mesh_sync_one"),
        ("src/workspaces.rs", "park_locked_connection"),
    ] {
        assert!(
            keys.contains(&anchor),
            "扫描没看到核心开库点 {anchor:?} —— 不是它没开库，是扫描器坏了/口径变了"
        );
    }
    assert!(
        hits.iter().any(|h| h.kind == "direct"),
        "一个直连开库点都没扫到（`Connection::open*` 模式失效？）"
    );
    assert!(
        hits.iter().any(|h| h.kind == "helper"),
        "一个旁路连接调用都没扫到（`open_space_conn*` / `open_meta_conn*` 模式失效？）"
    );
}

#[test]
fn every_real_db_open_point_is_registered() {
    let (hits, _) = scan_tree();
    // ⚠️ 判据是**逐函数的处数**，不是只看“函数名在不在表里”：同一个已登记函数里多开一条也在这里红。
    let problems = count_problems(&hits, REGISTERED);
    assert!(
        problems.is_empty(),
        "开库点与登记表对不上（{} 条）—— 按下面逐条改 REGISTERED（加/删连接都要同步改 expected_count）：\n{}",
        problems.len(),
        problems
            .iter()
            .map(|p| format!("  - {p}"))
            .collect::<Vec<_>>()
            .join("\n")
    );
}

#[test]
fn registry_has_no_stale_entries() {
    let (hits, _) = scan_tree();
    let stale = stale_entries(&hits);
    assert!(
        stale.is_empty(),
        "登记表里有 {} 条已经**不再开库**（条目过期）：{:?}\n\
         ⇒ 删掉这些条目（它们会让未来的同名函数**默认被放行**）",
        stale.len(),
        stale
    );
}

// ── 扫描器自证：夹具（不依赖真实违规文件，所以判据本身也能在没有 DB/不联网时跑） ──

#[test]
fn the_scanner_catches_a_new_direct_opener() {
    let src = "fn brand_new_opener() {\n    let c = Connection::open(&path)?;\n    let _ = c;\n}\n";
    let hits = scan_source("src/fixture.rs", src);
    assert_eq!(hits.len(), 1, "夹具应当恰好命中 1 个：{hits:?}");
    assert_eq!(hits[0].func, "brand_new_opener");
    assert_eq!(hits[0].kind, "direct");
    assert_eq!(hits[0].line, 2, "行号要点名到位");
    assert!(
        !unregistered(&hits).is_empty(),
        "未登记的直连开库点必须被判为未登记"
    );

    // 另一种直连写法也要认（rusqlite 的 `open_in_memory_with_flags` 今天没用，但将来可能有人用）
    let src2 = "fn mem_opener() {\n    let c = Connection::open_in_memory_with_flags(OpenFlags::default())?;\n}\n";
    let hits2 = scan_source("src/fixture.rs", src2);
    assert_eq!(
        hits2.len(),
        1,
        "`open_in_memory_with_flags` 也要算直连开库点：{hits2:?}"
    );
    assert_eq!(hits2[0].kind, "direct");
}

#[test]
fn the_scanner_catches_a_new_helper_caller() {
    let src =
        "fn brand_new_caller() {\n    let c = crate::db::open_space_conn_at(&space, dir)?;\n}\n";
    let hits = scan_source("src/fixture.rs", src);
    assert_eq!(hits.len(), 1, "夹具应当恰好命中 1 个：{hits:?}");
    assert_eq!(hits[0].func, "brand_new_caller");
    assert_eq!(hits[0].kind, "helper");
    // helper 的定义行不是调用点（否则 db.rs 的 `fn open_space_conn(` 会被算两次）
    let def = "pub(crate) fn open_space_conn(space_id: &str) -> Result<Connection, String> {\n";
    assert!(
        scan_source("src/fixture.rs", def).is_empty(),
        "helper 定义行不算开库调用"
    );
}

#[test]
fn a_second_connection_in_the_same_function_is_caught_unless_registered() {
    // 同一函数里**两处** `Connection::open` —— 收紧后必须数成 2 处（⛔ 不许按函数去重成 1）。
    let src =
        "fn twice() {\n    let a = Connection::open(&p)?;\n    let b = Connection::open(&q)?;\n}\n";
    let hits = scan_source("src/fixture.rs", src);
    assert_eq!(
        hits.len(),
        2,
        "同一函数的两处连接必须各算一处（旧实现按函数去重 ⇒ 这里会是 1）：{hits:?}"
    );

    // 登记 expected=1 ⇒ 必须红，并点名 TooMany（“同函数新增写者”）。
    let expect_one: &[(&str, &str, usize, &str)] = &[("src/fixture.rs", "twice", 1, "夹具")];
    let problems = count_problems(&hits, expect_one);
    assert_eq!(
        problems.len(),
        1,
        "expected=1 实际 2 处 ⇒ 应恰好一条 TooMany：{problems:?}"
    );
    match &problems[0] {
        CountProblem::TooMany {
            expected,
            actual,
            func,
            ..
        } => {
            assert_eq!(*expected, 1);
            assert_eq!(*actual, 2);
            assert_eq!(func, "twice");
        }
        other => panic!("应当是 TooMany（同函数新增写者），实得 {other:?}"),
    }

    // 登记 expected=2 ⇒ 绿。
    let expect_two: &[(&str, &str, usize, &str)] = &[("src/fixture.rs", "twice", 2, "夹具")];
    assert!(
        count_problems(&hits, expect_two).is_empty(),
        "expected=2 ⇒ 两处连接刚好对上，必须绿"
    );

    // 反向：实际 1 处、登记 2 ⇒ TooFew（删/合并连接没改数字）。
    let one = scan_source(
        "src/fixture.rs",
        "fn once() {\n    let a = Connection::open(&p)?;\n}\n",
    );
    let expect_too_much: &[(&str, &str, usize, &str)] = &[("src/fixture.rs", "once", 2, "夹具")];
    let pf = count_problems(&one, expect_too_much);
    assert!(
        matches!(
            pf.as_slice(),
            [CountProblem::TooFew {
                expected: 2,
                actual: 1,
                ..
            }]
        ),
        "实际 1 处 vs 登记 2 处 ⇒ 必须报 TooFew：{pf:?}"
    );
}

#[test]
fn comments_and_strings_are_not_open_points() {
    let src = r####"
fn docs_only() {
    // Connection::open(&p)
    /// open_space_conn(&p)
    /* Connection::open_with_flags(&p, flags)
       open_meta_conn_at(dir) */
    let _ = "Connection::open(&p)";
    let _ = b"open_space_conn(&p)";
    let _ = r#"open_meta_conn(&p)"#;
    let _ = r##"Connection::open_in_memory()"##;
    let _ = '\'';
}
"####;
    let hits = scan_source("src/fixture.rs", src);
    assert!(
        hits.is_empty(),
        "注释/字符串里的字面量不许算开库点，实得：{hits:?}"
    );
}

#[test]
fn cfg_test_code_is_not_a_production_opener() {
    // ① 测试模块里的开库点不扫
    let src = r#"
fn production_opener() {
    let c = Connection::open(&p);
}
#[cfg(test)]
mod tests {
    fn fake_in_tests() {
        let c = Connection::open(&p);
    }
}
"#;
    let hits = scan_source("src/fixture.rs", src);
    assert_eq!(hits.len(), 1, "只该命中生产函数：{hits:?}");
    assert_eq!(hits[0].func, "production_opener");

    // ② `#[cfg(test)]` 的函数/`use` 项也不扫；而 `#[cfg(not(test))]`（生产分支）**要**扫
    let src2 = r#"
#[cfg(test)]
fn only_in_tests() {
    let c = Connection::open(&p);
}
#[cfg(test)]
use rusqlite::Connection;
#[cfg(not(test))]
fn production_gated() {
    let c = Connection::open(&p);
}
"#;
    let hits2 = scan_source("src/fixture.rs", src2);
    assert_eq!(
        hits2.len(),
        1,
        "只该命中 cfg(not(test)) 那条生产分支：{hits2:?}"
    );
    assert_eq!(hits2[0].func, "production_gated");
}
