// 库级国密 provider 的**运行期反向验证**（P2/P3 那一半里属于 AMD 的那半）。
//
// ⚠️ `allow(dead_code)` 是**显式的、有期限的**：本模块今天只有判据（`#[cfg(test)]`）与探针在用 ——
// P2 的接线（`security.rs` 开库路径上调用 `configure_gm_cipher()` / `read_gm_cipher_status()`）还没落。
// 不加这一行，`cargo check --lib` 会为它报 **8 条 never used 告警**，把真正的告警淹掉；
// 而"我声称零警告"这种话一旦对不上账，后面所有读数都要打折 —— 这次正是被抓到的：
// macOS 侧独立跑 `cargo check --lib --tests` 数到 8 条 `gm_provider::*`
// （见 `2026-09-19-gm-p1-application-layer.reply-6.md`；我那条"零警告"是从一次 grep 读数里来的，
//  而那次 grep 在 `&&` 链里、输出为空被我当成了"没有告警"——**空输出与零命中是两件事**）。
// ⇒ **P2 接线落地那天把这一行删掉**（那时它不再是死代码）。
#![allow(dead_code)]
//
// 为什么要有这个模块（与 mac 在 `2026-09-19-gm-p1-application-layer.reply-2.md` §七 对齐的分法）：
//   · **构建期**（mac 出）：编进去的到底是哪个后端 —— 由构建脚本决定（macOS 现在实测是 CommonCrypto）；
//   · **运行期**（本模块）：SM3/SM4 到底有没有被 SQLCipher **真的走通** —— 链接进来 ≠ 被用上。
// 两条合起来才闭环；任何一条单独都会变成"安全感的来源"。
//
// ## 先量后写：SQLCipher 4.14.0 community 的**实测**行为（本模块的探针，`--ignored --nocapture`）
//
// | 动作 | 实测结果 |
// |---|---|
// | 默认参数 | `cipher_hmac_algorithm = HMAC_SHA512`、`cipher_kdf_algorithm = PBKDF2_HMAC_SHA512` |
// | `PRAGMA cipher_hmac_algorithm = HMAC_SM3;`（**key 之前**） | **不报错**，回显**仍是** `HMAC_SHA512`，连接照常可读写 |
// | 同上（**key 之后**） | 不报错，但连接随即进 error state：之后读写都是 `SQL logic error` |
// | `PRAGMA cipher_hmac_algorithm = NOT_A_REAL_ALGO;` | 与国密标签**一模一样的反应** ⇒ 这一层**根本不校验标签** |
// | 用国密标签写盘再重开 | 读到数据、回显 `HMAC_SHA512` ⇒ **什么都没发生**（数据仍是 SHA512 那套） |
//
// ⚠️ 上面第 2/5 行就是这一路上最坏的一种失败：**静默降级** ——
// 用户以为在用国密，库里其实还是 SHA512/HMAC-SHA512，而本机所有测试都绿（库照常能开、数据照常能读）。
// ⇒ 所以这一层的判据**不是**"能不能设上"，而是"**设了以后到底生效没有，且不许含糊**"。
//
// ## 本模块提供什么
// `configure_gm_cipher()`：给**还没设 key** 的连接配上国密参数，并**如实回答生效与否**
// （`Applied` / `Unsupported{回显是什么}`），外加把"标签设晚了"这种用法错误**诊断成人话**而不是
// 留一句 `SQL logic error`。
// 它是 P2 的接线点：provider 补丁落地后，同一个函数会自然从 `Unsupported` 翻成 `Applied`，
// 判据不用改一行 —— **判据写"期望"，不写"现状"**。

use rusqlite::Connection;

/// 库级国密要给 SQLCipher 的两个标签（方案 §3.1 的 provider 补丁会新增它们）。
pub const GM_HMAC_LABEL: &str = "HMAC_SM3";
pub const GM_KDF_LABEL: &str = "PBKDF2_HMAC_SM3";

/// 配完国密参数之后的**事实状态**（不是"我以为"）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GmProviderStatus {
    /// provider 真的吃下了国密标签（回显就是它）⇒ 后面写出来的库才是国密那套。
    Applied { hmac: String, kdf: String },
    /// 没生效：**把回显原样带出来**，因为"回显仍是 HMAC_SHA512"正是静默降级的证据。
    Unsupported { hmac: String, kdf: String, note: String },
}

impl GmProviderStatus {
    pub fn is_applied(&self) -> bool {
        matches!(self, GmProviderStatus::Applied { .. })
    }

    /// 一句话人话（给 `encryption_status` 那种面用）。
    pub fn describe(&self) -> String {
        match self {
            GmProviderStatus::Applied { hmac, kdf } => {
                format!("库级国密已生效（HMAC={hmac}，KDF={kdf}）")
            }
            GmProviderStatus::Unsupported { hmac, kdf, .. } => format!(
                "库级国密**未生效**：标签设下去了但算法没变（回显 HMAC={hmac}、KDF={kdf}）—— \
                 SQLCipher 这一层不校验标签，会**静默按默认算法**继续；需要 §3.1 的 provider 补丁"
            ),
        }
    }
}

/// 读一条 PRAGMA 的当前值（`PRAGMA x;` 返回一行一列）。
fn pragma_str(c: &Connection, name: &str) -> Result<String, String> {
    c.query_row(&format!("PRAGMA {name};"), [], |r| {
        // 有的 PRAGMA 回整数、有的回字符串 ⇒ 统一成字符串，免得"读不出来"被当成"值是对的"
        let v = r.get_ref(0)?;
        Ok(match v {
            rusqlite::types::ValueRef::Text(t) => String::from_utf8_lossy(t).to_string(),
            rusqlite::types::ValueRef::Integer(i) => i.to_string(),
            rusqlite::types::ValueRef::Real(f) => f.to_string(),
            rusqlite::types::ValueRef::Null => "(null)".to_string(),
            rusqlite::types::ValueRef::Blob(b) => format!("(blob {} 字节)", b.len()),
        })
    })
    .map_err(|e| format!("读 PRAGMA {name} 失败: {e}"))
}

/// 设一条 PRAGMA，并把"成没成"如实报出来（**不吞错**：SQLCipher 对未知标签的行为正是要量的东西）。
fn set_pragma(c: &Connection, stmt: &str) -> Result<(), String> {
    c.execute_batch(stmt).map_err(|e| format!("{stmt} ⇒ {e}"))
}

/// 给一条**还没设 key** 的连接配上国密加密参数。
///
/// ## 返回值只说明"语句被接受、连接没坏"，**不代表生效**
/// 生效与否要在**设 key 之后**用 `read_gm_cipher_status()` 读回显才能判断（实测：
/// 未 key 的连接上 `PRAGMA cipher_hmac_algorithm;` **查不出行** —— 这两个值只在加密模式下存在）。
/// 把"配置"与"验证"分成两步是刻意的：**"设下去了"与"生效了"在这条路上是两件事**。
///
/// ## 为什么必须在 `PRAGMA key` **之前**调用
/// 实测（见文件头表）：标签在 key **之后**设时，语句照样返回 Ok，但连接随即进 error state
/// —— 用户看到的是若干步之后某个莫名其妙的 `SQL logic error`。所以本函数自己探一下连接健康度，
/// 把这种用法错误**就地**说清。
pub fn configure_gm_cipher(c: &Connection) -> Result<(), String> {
    set_pragma(c, &format!("PRAGMA cipher_hmac_algorithm = {GM_HMAC_LABEL};"))?;
    set_pragma(c, &format!("PRAGMA cipher_kdf_algorithm = {GM_KDF_LABEL};"))?;

    // 健康度自检：把"标签设晚了"（连接已进过加密路径）与"真不支持"这两种情形分开。
    // 没有这一步，两种情形在调用方看来都是"设置成了、后面莫名报错"。
    if let Err(e) = c.query_row("SELECT 1", [], |r| r.get::<_, i64>(0)) {
        return Err(format!(
            "配国密参数后连接已不可用（{e}）—— 多半是**标签设晚了**：\
             `cipher_*` 必须在 `PRAGMA key` **之前**设；这两个顺序在 SQLCipher 里不会报错，只会静默把连接弄坏"
        ));
    }
    Ok(())
}

/// 在**设 key 之后**读回"国密参数到底生效没有"。
///
/// 观察点只有回显（`cipher_hmac_algorithm` / `cipher_kdf_algorithm`）—— 实测 `cipher_hmac_sz` /
/// `cipher_kdf_iter` **查不出行**，拿不到。
///
/// ⚠️ 未 key（或明文模式）的连接上这两个 PRAGMA 也查不出行 ⇒ 本函数返回 Err 并点明"先设 key"，
/// 免得把"读不出来"当成"值不对"。
pub fn read_gm_cipher_status(c: &Connection) -> Result<GmProviderStatus, String> {
    let hmac = pragma_str(c, "cipher_hmac_algorithm")?;
    let kdf = pragma_str(c, "cipher_kdf_algorithm")?;
    if hmac == GM_HMAC_LABEL && kdf == GM_KDF_LABEL {
        Ok(GmProviderStatus::Applied { hmac, kdf })
    } else {
        Ok(GmProviderStatus::Unsupported {
            hmac,
            kdf,
            note: "SQLCipher 接受了语句但没改变算法（这一层不校验标签）⇒ 若继续用它写库，写出来的**仍是默认算法**"
                .to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一条**还没设 key** 的连接（国密参数只能在这个阶段配 —— 见 `configure_gm_cipher` 文档）。
    fn fresh() -> Connection {
        Connection::open_in_memory().expect("开内存库")
    }

    const KEY_PRAGMA: &str =
        "PRAGMA key = \"x'00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'\";";

    /// ★ 判据 1：**"设下去了" ≠ "生效了"** —— 只有在**回显就是国密标签**时才允许算生效。
    ///
    /// 判据写的是**期望**（不是现状）：provider 补丁（P2）落地后，这条会自动从 `Unsupported` 那一支
    /// 翻到 `Applied` 那一支，**一行都不用改**；而在补丁之前，它必须如实报"未生效"并把回显带出来。
    #[test]
    fn gm_cipher_reports_applied_only_when_the_echo_matches() {
        let c = fresh();
        configure_gm_cipher(&c).expect("配置国密参数不该报错");
        set_pragma(&c, KEY_PRAGMA).expect("设 key");
        let st = read_gm_cipher_status(&c).expect("设 key 之后必须读得出状态");

        match &st {
            GmProviderStatus::Applied { hmac, kdf } => {
                // 生效时必须**回显就是它**（不能只看"语句没报错"）
                assert_eq!(hmac, GM_HMAC_LABEL, "回显的 HMAC 算法必须就是国密标签");
                assert_eq!(kdf, GM_KDF_LABEL, "回显的 KDF 算法必须就是国密标签");
            }
            GmProviderStatus::Unsupported { hmac, kdf, note } => {
                // 未生效时：回显必须是"别的算法"（这就是静默降级的证据），且说明不能为空
                assert_ne!(hmac, GM_HMAC_LABEL, "回 Unsupported 却回显了国密标签 —— 状态判定自相矛盾");
                assert_ne!(kdf, GM_KDF_LABEL, "回 Unsupported 却回显了国密标签 —— 状态判定自相矛盾");
                assert!(!note.is_empty(), "未生效时必须给出可读的原因");
                // 实测现状：默认构建（无 provider 补丁）回显 HMAC_SHA512 —— 写进断言，
                // 这样"哪天悄悄变了"（例如有人加了标签却接错算法）会立刻暴露
                assert_eq!(hmac, "HMAC_SHA512", "默认构建的回显应为 HMAC_SHA512");
                assert_eq!(kdf, "PBKDF2_HMAC_SHA512", "默认构建的回显应为 PBKDF2_HMAC_SHA512");
            }
        }
        assert_eq!(st.is_applied(), matches!(st, GmProviderStatus::Applied { .. }));
    }

    /// ★ 判据 2：**未 key 的连接读不出状态** ⇒ 必须报错并点明"先设 key"。
    ///
    /// 这条来自实测（未 key 时 `PRAGMA cipher_hmac_algorithm;` 查不出行）：
    /// 若不这样处理，"读不出来"会被当成"值不对"，进而被误判成"provider 不支持"。
    #[test]
    fn gm_status_refuses_to_guess_before_the_key() {
        let c = fresh();
        configure_gm_cipher(&c).expect("配置不该报错");
        let e = read_gm_cipher_status(&c).expect_err("未 key 时读状态必须报错，而不是猜一个值");
        assert!(e.contains("cipher_hmac_algorithm"), "错误信息要点出是哪条 PRAGMA 读不出来：{e}");
    }

    /// ★ 判据 3：配过国密参数的连接**仍然可用**（P2 的接线点就在这个位置）。
    ///
    /// 这条挡的是"配完就坏"：实测**标签设晚了**会坏，所以这条同时也是顺序约束的哨兵。
    #[test]
    fn gm_cipher_keeps_the_connection_usable() {
        let c = fresh();
        configure_gm_cipher(&c).expect("配置不该报错");
        set_pragma(&c, KEY_PRAGMA).expect("设 key");
        c.execute_batch("CREATE TABLE t(x INTEGER); INSERT INTO t VALUES (7);")
            .expect("配过国密参数的连接必须还能建表写值");
        let n: i64 = c.query_row("SELECT x FROM t", [], |r| r.get(0)).expect("必须还能读");
        assert_eq!(n, 7);
    }

    /// ★ 判据 4：**用法错误要诊断成人话**。
    ///
    /// 实测：在 `PRAGMA key` 之后设 `cipher_*`，SQLCipher **不报错**，但连接进 error state，
    /// 之后每个读写都是 `SQL logic error`。若这里也静默通过，排查成本会很高（错点离原因很远）。
    #[test]
    fn gm_cipher_diagnoses_the_too_late_mistake() {
        let c = fresh();
        set_pragma(&c, KEY_PRAGMA).expect("设 key");
        let e = configure_gm_cipher(&c).expect_err("标签设晚了必须报错，而不是静默把连接弄坏");
        assert!(
            e.contains("设晚了") || e.contains("之前"),
            "错误信息要点明顺序问题，实际是：{e}"
        );
    }

    /// ★ 判据 5：`describe()` 是给界面/状态面用的一句话 —— 未生效时必须**说得出"没生效"**。
    #[test]
    fn gm_status_describes_the_unsupported_case_loudly() {
        let c = fresh();
        configure_gm_cipher(&c).expect("配置不该报错");
        set_pragma(&c, KEY_PRAGMA).expect("设 key");
        let st = read_gm_cipher_status(&c).expect("读状态");
        let s = st.describe();
        if st.is_applied() {
            assert!(s.contains("已生效"), "生效时的描述应正面说明：{s}");
        } else {
            assert!(s.contains("未生效"), "未生效时必须明说未生效，不能含糊：{s}");
            assert!(s.contains("HMAC_SHA512"), "未生效时应把回显带出来（可核对）：{s}");
        }
    }

    // ------------------------------------------------------------------
    // 探针（`--ignored --nocapture`）：**先量后写**留下的读数工具。
    // 留着是因为"事实会变"（provider 补丁、SQLCipher 升级）——它们是本文件那三张表的取证入口。
    // ------------------------------------------------------------------

    /// 探针：把"默认构建对国密标签的反应"完整量出来（只打印，不断言）。
    ///
    /// 跑法（WSL2 / Linux）：
    ///   cargo test --manifest-path src-tauri/Cargo.toml --lib gm_provider:: -- --nocapture --ignored
    #[test]
    #[ignore = "探针：读数工具，不是判据"]
    fn probe_how_default_build_reacts_to_gm_labels() {
        let c = Connection::open_in_memory().expect("开内存库");
        // 先上 key，让"加密参数"这条路真的被走到（没 key 时 SQLCipher 是明文模式，PRAGMA 值不代表加密路径）
        set_pragma(&c, "PRAGMA key = \"x'00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'\";")
            .expect("设 key");

        println!("== 事实：默认构建自己报的加密参数 ==");
        for p in [
            "cipher_version",
            "cipher_page_size",
            "cipher_hmac_algorithm",
            "cipher_kdf_algorithm",
            "cipher_kdf_iter",
            "cipher_hmac_sz",
        ] {
            println!("  {p} = {}", pragma_str(&c, p).unwrap_or_else(|e| format!("<{e}>")));
        }

        // 基线：先确认这个库确实能读写（否则下面的"拒绝"可能只是别的原因）
        c.execute_batch("CREATE TABLE t(x); INSERT INTO t VALUES (1);").expect("建表插值");
        let n: i64 = c.query_row("SELECT count(*) FROM t", [], |r| r.get(0)).unwrap();
        println!("  读写自检：t 里有 {n} 行");

        println!("== 尝试 1：把 HMAC 换成国密标签 ==");
        match set_pragma(&c, "PRAGMA cipher_hmac_algorithm = HMAC_SM3;") {
            Ok(()) => {
                let back = pragma_str(&c, "cipher_hmac_algorithm").unwrap_or_default();
                println!("  设置**没有报错**；回显 = {back}");
                // 关键：回显若不是 HMAC_SM3，那就是"静默忽略/静默降级" —— 必须记下来
                let n2: Result<i64, _> = c.query_row("SELECT count(*) FROM t", [], |r| r.get(0));
                println!("  设置后还能读：{n2:?}");
            }
            Err(e) => println!("  设置**报错**（这正是我们要的「响亮拒绝」）：{e}"),
        }

        println!("== 尝试 2：把 KDF 换成国密标签 ==");
        match set_pragma(&c, "PRAGMA cipher_kdf_algorithm = PBKDF2_HMAC_SM3;") {
            Ok(()) => {
                let back = pragma_str(&c, "cipher_kdf_algorithm").unwrap_or_default();
                println!("  设置**没有报错**；回显 = {back}");
            }
            Err(e) => println!("  设置**报错**：{e}"),
        }

        println!("== 尝试 3：明文垃圾值（对照：未知标签与乱填是不是同一种反应） ==");
        match set_pragma(&c, "PRAGMA cipher_hmac_algorithm = NOT_A_REAL_ALGO;") {
            Ok(()) => println!(
                "  乱填也**不报错**；回显 = {}",
                pragma_str(&c, "cipher_hmac_algorithm").unwrap_or_default()
            ),
            Err(e) => println!("  乱填**报错**：{e}"),
        }
    }

    /// 探针：**顺序**是不是关键 —— 国密标签在 `PRAGMA key` **之前**设，行为会不会不同？
    ///
    /// 为什么值得单独量：SQLCipher 的 cipher 参数只在"第一次真正访问库"之前生效；
    /// 若标签只能在 key 之前设，那 P2 的接线点就必须在 `set_cipher_key()` **之前**，
    /// 而"设晚了"这件事不能靠读文档确认 —— 它会安静地什么都不做（见探针 1）。
    #[test]
    #[ignore = "探针：读数工具，不是判据"]
    fn probe_label_before_key_vs_after() {
        for before_key in [true, false] {
            let c = Connection::open_in_memory().expect("开内存库");
            let label = "PRAGMA cipher_hmac_algorithm = HMAC_SM3;";
            if before_key {
                let r = set_pragma(&c, label);
                println!("== 顺序 A：标签在前 ==\n  设标签：{r:?}");
            }
            let rk = set_pragma(&c, "PRAGMA key = \"x'00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'\";");
            println!("  设 key：{}", rk.map(|_| "ok".to_string()).unwrap_or_else(|e| e));
            if !before_key {
                let r = set_pragma(&c, label);
                println!("== 顺序 B：标签在后 ==\n  设标签：{r:?}");
            }
            println!("  回显 hmac = {}", pragma_str(&c, "cipher_hmac_algorithm").unwrap_or_default());
            let w = c.execute_batch("CREATE TABLE t(x); INSERT INTO t VALUES (1);");
            println!("  写：{}", w.map(|_| "ok".to_string()).unwrap_or_else(|e| e.to_string()));
            let rd: Result<i64, _> = c.query_row("SELECT count(*) FROM t", [], |r| r.get(0));
            println!("  读：{rd:?}");
        }
    }

    /// 探针：国密标签**落盘后**会不会被持久化（"设置成功"与"下次开库还是它"是两件事）。
    #[test]
    #[ignore = "探针：读数工具，不是判据"]
    fn probe_whether_gm_labels_persist_to_disk() {
        let dir = std::env::temp_dir().join(format!(
            "shuy_gm_probe_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let path = dir.join("probe.db");
        // ⚠️ 与 `security.rs::set_cipher_key` 同一种写法（`PRAGMA key = "x'…'";`）：
        //    少一层引号会直接 syntax error —— 我第一版就是这么错的，记在这里免得重踩
        let key = "PRAGMA key = \"x'00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'\";";

        {
            let c = Connection::open(&path).expect("开库");
            // 顺序 A：标签先设（P2 应当采用的位置）
            match set_pragma(&c, "PRAGMA cipher_hmac_algorithm = HMAC_SM3;") {
                Ok(()) => println!("  写入端：设标签不报错"),
                Err(e) => println!("  写入端：设标签报错 ⇒ {e}"),
            }
            set_pragma(&c, key).expect("设 key");
            c.execute_batch("CREATE TABLE t(x); INSERT INTO t VALUES (42);").expect("写数据");
        }

        // 重开：**同一把 key** 能不能读回来（能读回来 ≠ 真的用了 SM3 —— 那要看回显）
        let c2 = Connection::open(&path).expect("重开库");
        set_pragma(&c2, key).expect("重设 key");
        let r: Result<i64, _> = c2.query_row("SELECT x FROM t", [], |row| row.get(0));
        println!("  重开后读到 = {r:?}");
        println!(
            "  重开后回显 cipher_hmac_algorithm = {}",
            pragma_str(&c2, "cipher_hmac_algorithm").unwrap_or_default()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
