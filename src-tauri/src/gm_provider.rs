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
// 第一张表量于 **2026-09-19，无 provider 补丁的构建**：
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
// ## ⚠️ 2026-09-20 更正：那条"**设晚了会坏**"的归因是我读错的，真机制在 `if(ctx)`
//
// 补丁落地后，同一份探针在**有补丁的构建**（Tongsuo 后端）上重跑，读数变了：
//
// | 动作 | 有补丁的构建 |
// |---|---|
// | 标签在 **`PRAGMA key` 之前** | 不报错，**key 之后回显仍是 `HMAC_SHA512`** ⇒ 标签被**静默丢掉** |
// | 标签在 **`PRAGMA key` 之后** | 不报错，**回显就是 `HMAC_SM3`**，而且连接**照常可读写** |
//
// 两行合起来的真机制（源码可对：`sqlcipher_codec_pragma()` 的每个分支都是 `if(ctx) { … }`）：
//   · **key 之前** codec ctx 还不存在 ⇒ 整块被跳过 ⇒ 语句返回 Ok 而**什么都没做**；
//   · **key 之后** ctx 存在 ⇒ 真的会落值 —— 而**这个取值认不认识**决定成败：不认识
//     （无补丁构建上的 `HMAC_SM3`，或任何构建上乱填的值）⇒ `rc` 停在 `SQLITE_ERROR`
//     ⇒ `sqlcipher_codec_ctx_set_error()` 把连接打进 error state —— **这才是当初被我记成"设晚了"的现象**。
// ⇒ **正确接线：先 `PRAGMA key`，再设两条 `cipher_*`，然后才做第一次读写**（`set_cipher_key()` 之后、
//   第一次访问之前）。而"设了到底生效没有"仍然只能看**回显**：上表第一行说明**顺序对了也会被静默丢掉**。
// 教训（要记进 `docs/TESTING.md` 的那种）：**一次探针同时动了两个变量（先后 × 认不认识），我却只归因了一个。**
//
// ## 本模块提供什么
// `configure_gm_cipher()`：给**已设 key、还没做过第一次读写**的连接配上国密参数，并**如实回答生效与否**
// （`Applied` / `Unsupported{回显是什么}`），外加把"设了一个本构建**不认识**的标签、连接被悄悄打进 error state"
// 这种用法错误**诊断成人话**，而不是留一句 `SQL logic error`。
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

/// 给一条**已设 key、还没做过第一次读写**的连接配上国密加密参数。
///
/// ## ⚠️ 调用时机（2026-09-20 实测更正，别再照旧文档接）
/// 必须在 `PRAGMA key` **之后**、第一次读写**之前**：
///   · key **之前**设 ⇒ codec ctx 还不存在，`sqlcipher_codec_pragma()` 那层的 `if(ctx)` 整块被跳过
///     ⇒ 语句返回 Ok 而**什么都没做**（回显仍是 SHA512）—— 这就是"设了却不生效"的静默降级；
///   · key **之后**设 ⇒ 真的落值（有补丁的构建上回显就是 `HMAC_SM3`）。
/// 详见文件头那两张表：我第一版把"设晚了会坏"当成顺序问题，真机制是**取值认不认识**。
///
/// ## 返回值只说明"语句被接受、连接没坏"，**不代表生效**
/// 生效与否必须用 `read_gm_cipher_status()` 读回显判断。把"配置"与"验证"分成两步是刻意的：
/// **"设下去了"与"生效了"在这条路上是两件事**。
pub fn configure_gm_cipher(c: &Connection) -> Result<(), String> {
    configure_cipher_algorithms(c, GM_HMAC_LABEL, GM_KDF_LABEL)
}

/// `configure_gm_cipher` 的实体（标签当参数传 ⇒ 判据可以拿它去撞"本构建不认识的标签"那条路）。
fn configure_cipher_algorithms(c: &Connection, hmac: &str, kdf: &str) -> Result<(), String> {
    set_pragma(c, &format!("PRAGMA cipher_hmac_algorithm = {hmac};"))?;
    set_pragma(c, &format!("PRAGMA cipher_kdf_algorithm = {kdf};"))?;

    // 健康度自检：把"这个取值本构建不认识 ⇒ 连接被 SQLCipher 打进 error state"与
    // "语句被接受、后面真的生效了"分开。没有这一步，二者在调用方看来都是"设成了、然后莫名报错"。
    if let Err(e) = c.query_row("SELECT 1", [], |r| r.get::<_, i64>(0)) {
        return Err(format!(
            "配国密参数后连接已不可用（{e}）—— 多半是**这个取值本构建不认识**：\
             SQLCipher 对不认识的算法标签不会响亮拒绝，而是把连接打进 error state（实测：无 provider 补丁的\
             构建上设 `HMAC_SM3`、或任何构建上乱填一个值，都是这个结果）。请先确认这份构建带 §3.1 provider 补丁"
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

// ---------------------------------------------------------------------------
// SM3 夹具：跨构建的**唯一不可伪造**证据
// ---------------------------------------------------------------------------

/// SM3 夹具的落点（与 mac 的 `sqlcipher-backend-fixture.db` 同一个目录习惯）。
pub fn sm3_fixture_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/sqlcipher-sm3-fixture.db")
}

/// 生成 SM3 夹具 —— **必须由带 provider 补丁的构建运行**，且**自证**。
///
/// ## 为什么生成器要自证（mac 2026-09-19 指出，我照办）
/// 补丁落地之前，"SM3 夹具"其实会是一份 **SHA512 密文戴着一顶 SM3 标签**（就是实测到的"静默降级"）
/// —— 那份夹具**看起来完全正常**，然后把"国密生效"这条判据变成假话，而从文件头上看不出来。
/// ⇒ 所以：先写到**临时文件**，验完回显确实是 `HMAC_SM3`/`PBKDF2_HMAC_SM3` 才 `rename` 到夹具路径；
/// 不是就**删掉临时文件并报错**（宁可没有夹具，也不要一份骗人的夹具）。
///
/// ## ⚠️ 夹具**不是可复现产物**：每次生成字节都不同（SQLCipher 每次写库用**随机 salt**）
/// ⇒ **别跨机比它的哈希**（要判的是"**读得开／读不开**"，见判据 9）。也正因为如此，生成器是
/// `#[ignore]` 的、**常规门禁不会重写它**：只有显式 `cargo test … -- --ignored --include-ignored`
/// 才会动盘上那一份，那时工作树里的夹具会变脏 —— 这是**预期的**，`git checkout -- <夹具>` 还原即可。
///
/// ## 与"默认构建读不开它"那条断言的关系
/// 那条只能在**另一种构建**（没有补丁的默认构建）里判 ⇒ 它与夹具**同一个 commit 进**
/// （先放断言再等夹具 = 它会走"跳过"，而跳过多了没人再看）。今天先落的是**生成器 ＋ 它的自证判据**。
pub fn generate_sm3_fixture(dest: &std::path::Path) -> Result<(), String> {
    let tmp = dest.with_extension("tmp");
    let _ = std::fs::remove_file(&tmp);

    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("建目录失败 {}: {e}", dir.display()))?;
    }

    // 写库 + 自证；任何一步失败都要**把临时文件删掉**再返回（不留半成品）
    let write = |tmp: &std::path::Path| -> Result<(), String> {
        let c = Connection::open(tmp).map_err(|e| format!("开临时库失败: {e}"))?;
        // 顺序（2026-09-20 实测更正）：**先 `PRAGMA key`，再配国密参数，然后才做第一次读写**。
        // 反过来（先配再 key）在 SQLCipher 里**不会报错**，但标签会被**静默丢掉** —— 那时 codec ctx
        // 还没建起来，`sqlcipher_codec_pragma()` 的 `if(ctx)` 整块被跳过。见文件头第二张表。
        let key_hex = "07".repeat(32); // 与 mac 的后端夹具同一把 key 习惯，便于人工核对
        set_pragma(&c, &format!("PRAGMA key = \"x'{key_hex}'\";"))?;
        configure_gm_cipher(&c)?;

        // ★ 自证第 ①：这份构建的回显**必须**是国密（否则整份夹具就是假的）
        match read_gm_cipher_status(&c)? {
            GmProviderStatus::Applied { .. } => {}
            GmProviderStatus::Unsupported { hmac, kdf, .. } => {
                return Err(format!(
                    "拒绝生成 SM3 夹具：这份构建的回显是 HMAC={hmac} / KDF={kdf}，\
                     **国密 provider 没生效** —— 现在写出去的会是一份「SHA512 密文戴 SM3 标签」的假夹具。\
                     夹具必须由带 §3.1 provider 补丁的构建生成。"
                ));
            }
        }

        // ⚠️ 列名刻意**不叫**文档正文那两列的名字（`check-doc-content-access` 按字面量统计"绕过文档内容层
        //    直接访问"，夹具这行 SQL 会被算成一处，而它跟那件事毫无关系）。
        //    夹具要证明的是"这份库是不是 SQLCipher/国密写的"，列名叫什么都不影响 ✓。
        //    （本条注释也刻意不把那两个列名写出来 —— 门禁连注释一起数。）
        c.execute_batch(
            "CREATE TABLE pages (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL); \
             INSERT INTO pages VALUES ('p1','国密夹具','由带 SM3 provider 的构建写下的密文'); \
             INSERT INTO pages VALUES ('p2','第二行','确认多行与顺序');",
        )
        .map_err(|e| format!("写夹具数据失败: {e}"))?;
        // 强制落盘（否则可能还在 WAL 里，夹具文件会是个空壳）
        c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .map_err(|e| format!("checkpoint 失败: {e}"))?;
        c.close().map_err(|(_c, e)| format!("关库失败: {e}"))?;
        Ok(())
    };

    let outcome = write(&tmp);
    match outcome {
        Ok(()) => {
            let n = std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
            if n <= 4096 {
                let _ = std::fs::remove_file(&tmp);
                return Err(format!("夹具太小，像个空库：{n} 字节 ⇒ 已丢弃"));
            }
            std::fs::rename(&tmp, dest).map_err(|e| format!("把夹具放到 {} 失败: {e}", dest.display()))?;
            Ok(())
        }
        Err(e) => {
            // ⚠️ 失败路径必须**不留文件**：半成品夹具比没有夹具更坏（它会被当成"已验证过"的东西）
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
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

    /// 这份构建的国密 provider 生效了吗？—— **不 panic** 的探法。
    ///
    /// ⚠️ 为什么不能写成 `configure_gm_cipher(&c).expect(...)`：**没有 provider 补丁的构建上，
    /// 配置这一步本身就会失败**（`HMAC_SM3` 是它不认识的取值 ⇒ 连接被 SQLCipher 打进 error state）。
    /// 那个失败**本身就是**"没生效"的证据，不该被当成测试故障。所以：设不上 ⇒ `false`。
    fn provider_applied() -> bool {
        let c = fresh();
        if set_pragma(&c, KEY_PRAGMA).is_err() {
            return false;
        }
        if configure_gm_cipher(&c).is_err() {
            return false;
        }
        read_gm_cipher_status(&c).map(|s| s.is_applied()).unwrap_or(false)
    }

    /// ★ 判据 1：**"设下去了" ≠ "生效了"** —— 只有在**回显就是国密标签**时才允许算生效。
    ///
    /// 判据写的是**期望**（不是现状）：provider 补丁（P2）落地后，`provider_applied()` 会从 false 翻成 true，
    /// 下面两支自动换边，**一行都不用改**。
    ///
    /// 顺序按 2026-09-20 的更正读数：**key → 配国密参数 → 第一次读写**（先配再 key 会被静默丢掉，见判据 5）。
    #[test]
    fn gm_cipher_reports_applied_only_when_the_echo_matches() {
        let c = fresh();
        set_pragma(&c, KEY_PRAGMA).expect("设 key");
        if provider_applied() {
            // ① 有 provider：配置必须成功，且**回显就是国密标签**（不能只看"语句没报错"）
            configure_gm_cipher(&c).expect("有 provider 的构建上配置不该报错");
            match read_gm_cipher_status(&c).expect("设 key 之后必须读得出状态") {
                GmProviderStatus::Applied { hmac, kdf } => {
                    assert_eq!(hmac, GM_HMAC_LABEL, "回显的 HMAC 算法必须就是国密标签");
                    assert_eq!(kdf, GM_KDF_LABEL, "回显的 KDF 算法必须就是国密标签");
                }
                other => panic!("provider 已生效却没报 Applied：{other:?}"),
            }
        } else {
            // ② 没 provider：这个取值不被认识 ⇒ 必须**响亮失败**（而不是"设成了、其实没生效"）
            let e = configure_gm_cipher(&c).expect_err("没有 provider 时配置必须响亮失败");
            assert!(
                e.contains("不认识") || e.contains("error state"),
                "失败原因要能指向「取值本构建不认识」，实际是：{e}"
            );
        }
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
    /// 两支都要能跑：有 provider ⇒ 配完照常读写；没有 ⇒ **配的时候就必须响亮失败**（而不是"配成功、
    /// 之后某一步莫名其妙的 `SQL logic error`"）。
    #[test]
    fn gm_cipher_keeps_the_connection_usable() {
        let c = fresh();
        set_pragma(&c, KEY_PRAGMA).expect("设 key");
        match configure_gm_cipher(&c) {
            Ok(()) => {
                c.execute_batch("CREATE TABLE t(x INTEGER); INSERT INTO t VALUES (7);")
                    .expect("配过国密参数的连接必须还能建表写值");
                let n: i64 = c.query_row("SELECT x FROM t", [], |r| r.get(0)).expect("必须还能读");
                assert_eq!(n, 7);
            }
            Err(e) => {
                assert!(
                    e.contains("不认识") || e.contains("error state"),
                    "没 provider 时应当是「取值不认识」这条响亮失败，实际是：{e}"
                );
            }
        }
    }

    /// ★ 判据 4：**本构建不认识的算法标签**要诊断成人话。
    ///
    /// 实测（2026-09-19 在无补丁构建上量到、2026-09-20 更正归因）：不认识的取值**不会**被响亮拒绝 ——
    /// 语句返回 Ok，但 `rc` 停在 `SQLITE_ERROR` ⇒ `sqlcipher_codec_ctx_set_error()` 把连接打进 error state，
    /// 之后每个读写都是 `SQL logic error`。若这里也静默通过，排查成本会很高（错点离原因很远）。
    ///
    /// ⚠️ 这条**不能用国密标签**判：在有补丁的构建上 `HMAC_SM3` 是**认识**的（那时不该报错）。
    /// 用乱填的值 ⇒ 两种构建上都成立，判据才不随构建漂移。
    #[test]
    fn gm_cipher_diagnoses_an_unknown_label_killing_the_connection() {
        let c = fresh();
        set_pragma(&c, KEY_PRAGMA).expect("设 key");
        let e = configure_cipher_algorithms(&c, "NOT_A_REAL_ALGO", "NOT_A_REAL_ALGO")
            .expect_err("不认识的标签必须报错，而不是静默把连接弄坏");
        assert!(
            e.contains("不认识") || e.contains("error state"),
            "错误信息要点明「取值不认识 ⇒ 连接进 error state」，实际是：{e}"
        );
    }

    /// ★ 判据 5（2026-09-20 新增）：**`PRAGMA key` 之前设的标签会被静默丢掉** ⇒ 接线点必须在 key 之后。
    ///
    /// 这条钉的是 P2 最容易接错的一格：顺序反了**不会报任何错**，只是"回显还是 SHA512"——
    /// 也就是我们一路在防的静默降级。它同时也是那条被我读错的归因的**回归判据**：
    /// 当初记成"标签设晚了会坏"，真机制是"`if(ctx)` 把 key 之前的设置整块跳过"。
    #[test]
    fn gm_labels_before_the_key_are_silently_dropped() {
        let c = fresh();
        // 先配（错的顺序）——这一步**不会**报错，这正是它危险的地方
        configure_gm_cipher(&c).expect("key 之前配置不该报错（它只是什么都不做）");
        set_pragma(&c, KEY_PRAGMA).expect("设 key");
        match read_gm_cipher_status(&c).expect("读状态（连接是健康的，回显读得到）") {
            GmProviderStatus::Applied { hmac, kdf } => panic!(
                "key 之前设的标签居然生效了（{hmac}/{kdf}）—— SQLCipher 行为变了，接线顺序的结论要重量一遍"
            ),
            GmProviderStatus::Unsupported { hmac, kdf, .. } => {
                // 这就是**静默降级**的原样：连接健康、语句没报错、盘上仍是默认那套
                assert_eq!(hmac, "HMAC_SHA512", "被悄悄丢掉之后回显应当还是默认算法");
                assert_eq!(kdf, "PBKDF2_HMAC_SHA512", "被悄悄丢掉之后回显应当还是默认算法");
            }
        }
    }

    /// ★ 判据 6：`describe()` 是给界面/状态面用的一句话 —— 未生效时必须**说得出"没生效"**。
    ///
    /// 用**连接健康**的那种未生效来判文案（key 之前设标签 ⇒ 被静默丢掉）：这样"读得到回显、但没生效"
    /// 这条支路在任何构建上都跑得起来（没 provider 的构建上若按 key→配置 的顺序，连接会先被弄坏）。
    #[test]
    fn gm_status_describes_the_unsupported_case_loudly() {
        let c = fresh();
        configure_gm_cipher(&c).expect("key 之前配置不该报错");
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

    /// ★ 判据 7：**没有 provider 补丁的构建上，生成器必须拒绝、且不留文件**。
    ///
    /// 这条是"自证"逻辑本身的判据 —— 今天就能跑、今天必须绿；补丁落地后它自动变成
    /// "生成器应当成功"（见判据 8），**判据写的是期望**。
    #[test]
    fn sm3_fixture_generator_refuses_without_the_provider_and_leaves_nothing() {
        let dir = std::env::temp_dir().join(format!(
            "shuy_sm3_gen_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ));
        let dest = dir.join("fixture.db");
        let r = generate_sm3_fixture(&dest);

        // 这份构建的回显是不是国密（**不 panic** 的探法：没 provider 时"配置"这一步自己就会失败）
        if provider_applied() {
            // 补丁已落地：生成器**应当成功**（判据 8 会要求夹具确实存在）
            r.expect("provider 已生效时生成器不该失败");
            assert!(dest.exists(), "生成成功却没有夹具文件");
        } else {
            let e = r.expect_err("provider 没生效时生成器必须拒绝，而不是写出一份假夹具");
            assert!(
                e.contains("回显") || e.contains("国密"),
                "拒绝的理由要说清是回显不对（否则看不出是「静默降级」）：{e}"
            );
            assert!(!dest.exists(), "拒绝时必须不留下夹具文件");
            assert!(!dest.with_extension("tmp").exists(), "拒绝时必须把临时文件也删掉（不留半成品）");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ★ 判据 8：**补丁落地之后，夹具必须真的在仓库里**。
    ///
    /// 今天它是 no-op（前置条件"这份构建有 provider"不成立）；补丁一落地它立刻变成硬要求 ——
    /// 这样"夹具忘了生成"不会变成一条谁都不看的跳过（mac 的原话：跳过多了没人再看）。
    #[test]
    fn sm3_fixture_must_exist_once_the_provider_is_applied() {
        if provider_applied() {
            assert!(
                sm3_fixture_path().exists(),
                "这份构建的国密 provider **已生效**，但 {} 不存在 ⇒ 请用 `cargo test --lib gm_provider::tests::gen_sm3_fixture -- --ignored` 生成它，\
                 并把「默认构建读不开它」那条断言一起提交（夹具与断言必须同时进）",
                sm3_fixture_path().display()
            );
        } else {
            // 未生效：不假装通过，把"为什么今天不需要它"打出来（`--nocapture` 可见）
            println!("（跳过要求：这份构建的国密 provider 未生效 ⇒ 夹具按设计还不该存在）");
        }
    }

    /// ★ 判据 9：夹具的**双向**判据 —— 有 provider 的构建必须读得开它，没有的必须读不开。
    ///
    /// "夹具存在"只证明有人写过文件；**"默认算法读不开它"才是"这份密文真的是国密那套"的证据**。
    /// 但没有 provider 的构建上跑不了第一支，有 provider 的构建上跑不了第二支 ⇒ 判据按**当前构建**分派，
    /// 两支都留着，谁在哪台上跑都能出一半的读数（这也是 mac 那边要跑的另一半）。
    #[test]
    fn sm3_fixture_is_readable_only_with_the_gm_provider() {
        let path = sm3_fixture_path();
        if !path.exists() {
            println!("（夹具还不存在 ⇒ 判据 8 会负责要求它；这里不重复报）");
            return;
        }
        let key_hex = "07".repeat(32);
        let key = format!("PRAGMA key = \"x'{key_hex}'\";");

        // 读 A：**默认算法**（不设任何 cipher_*）读它
        let default_read = {
            let c = Connection::open(&path).expect("开夹具");
            set_pragma(&c, &key).expect("设 key");
            c.query_row("SELECT count(*) FROM pages", [], |r| r.get::<_, i64>(0))
        };

        // 读 B：**国密参数**读它（顺序：key → 配置）
        // ⚠️ 没有 provider 的构建上这一步**会**失败（不认识的标签 ⇒ 连接进 error state）——
        //    所以这里不 expect，把结果原样带出来；有 provider 时才断言它必须成功。
        let gm_read = (|| -> Result<i64, String> {
            let c = Connection::open(&path).map_err(|e| e.to_string())?;
            set_pragma(&c, &key)?;
            configure_gm_cipher(&c)?;
            c.query_row("SELECT count(*) FROM pages", [], |r| r.get::<_, i64>(0))
                .map_err(|e| e.to_string())
        })();

        let has_provider = provider_applied();

        if has_provider {
            let n = gm_read.expect("有 provider 的构建必须能按国密参数读开夹具");
            assert!(n >= 2, "夹具里应当有两行数据，读到 {n}");
            println!("夹具读数（有 provider）：默认算法 {default_read:?}／国密参数 {n} 行");
        } else {
            assert!(
                default_read.is_err(),
                "**没有** provider 的构建居然按默认算法读开了这份夹具 ⇒ 它根本不是国密写的（假夹具）"
            );
            println!("夹具读数（无 provider）：默认算法 {default_read:?} ⇒ 读不开，符合预期");
        }
    }

    /// 夹具生成器（**只在带 provider 补丁的构建上有意义**；无补丁时会拒绝并留下说明）。
    ///
    /// 跑法：`cargo test --lib gm_provider::tests::gen_sm3_fixture -- --ignored --nocapture`
    #[test]
    #[ignore = "夹具生成器：必须由带 §3.1 provider 补丁的构建运行（自证不过会拒绝写出）"]
    fn gen_sm3_fixture() {
        let dest = sm3_fixture_path();
        match generate_sm3_fixture(&dest) {
            Ok(()) => println!("夹具已生成：{}", dest.display()),
            Err(e) => panic!("夹具未生成（这是**有意义**的失败，不是环境问题）：{e}"),
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

    /// 探针：**顺序**是不是关键 —— 国密标签在 `PRAGMA key` **之前**／**之后**设，行为会不会不同？
    ///
    /// ★ 这个探针正是 2026-09-20 那次更正的读数来源：**key 之前设 = 被静默丢掉；key 之后设 = 真的生效**
    /// （有 provider 补丁的构建上回显 `HMAC_SM3`、连接照常可读写）。当初我只归因了"顺序"，
    /// 其实同时动了第二个变量：**这个取值本构建认不认识**（见文件头第二张表）。
    /// ⇒ 结论：P2 的接线点 = `set_cipher_key()` **之后**、第一次读写之前；"设上了没有"只能看回显。
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
