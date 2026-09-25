//! **B 片：配对载荷（换设备零服务器）—— 纯函数内核**
//!
//! 上位是[B 片施工单](docs/plans/2026-09-25-b-zero-server-pairing-workorder.md)。这一层只做**一件**事：
//! 把「第二台设备要用的那份东西」包成一段**可以印在二维码上、也可以念成短码**的文本，并且**解得回来**。
//!
//! ## 三条口径（判据钉着）
//!
//! 1. **载荷里只放"第二台设备必需"的东西**（施工单 §2 ①）：`v` ＋ 公开材料 ＋ 设备指纹。
//!    ⚠️ 这段码可能被**印出来给旁边的人看** ⇒ 多一个诊断字段就是多泄漏一份信息。
//!    ⇒ 用 `deny_unknown_fields` 把它变成**硬判据**：多一个字段**直接拒收**（不是静默忽略）。
//! 2. **公开材料原样搬运**：`material` 存的是 `Keyring::to_json()` 的**原文**，不重新序列化
//!    （重新序列化会改变字节，而"两份材料相等"这件事我们只敢按字节说）。
//! 3. **超容量如实降级、绝不截断**（施工单 §4 判据 ④）：装不下就说装不下。
//!    截断的后果是"扫出来的材料少一截" —— 而它会一路走到**解不开盒子**才暴露。
//!
//! ## ⚠️ 还没接线（与 `lan.rs` 同规矩）
//!
//! 除 `#[cfg(test)]` 外本模块**还没有调用方**：二维码的生成/扫描、短码 PAKE、界面入口都在接线那一片。
//! 所以整个模块显式放行 `dead_code` —— **接线那一片必须把这行删掉**（留着它会盖住真死码）。
//!
//! ## 本片**不做**密码学
//!
//! 短码通道**必须 PAKE**（施工单 §1 F6：公开材料 ＋ 口令 ⇒ 空间密钥，录制通道者可以离线爆破；
//! 6 位数字的熵只有约 20 bit）。**本模块不实现 PAKE** —— 选型要单独过一次目，
//! 在它定下来之前，这里一个字节的密钥派生逻辑都不写（自己攒 PAKE 比不写更危险）。
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

/// 载荷的**线版本**。不认识 ⇒ **不猜**（照 `Keyring::from_json` 的口径）。
pub const PAIRING_VERSION: u32 = 1;

/// **一张二维码能装多少字节**：QR version 40、纠错级 **L**、**字节模式** = **2953** 字节。
/// 取字节模式（不是字母数字模式）是因为 JSON 的键值是小写字母，落不到那个更大的字符表里
/// —— 拿字母数字模式的上限（4296）当判据会让"能生成"的码**扫不出来**。
pub const QR_SINGLE_BYTE_LIMIT: usize = 2953;

/// 配对载荷。**字段就是协议**：见模块头口径 1（多余字段一律拒收）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PairingPayload {
    /// 线版本（[`PAIRING_VERSION`]）。
    pub v: u32,
    /// **公开材料原文**（`Keyring::to_json()` 的输出）。不重新序列化 —— 见模块头口径 2。
    pub material: String,
    /// 源设备的**身份指纹**。今天常常是空串（`LanAnnounce.fp` 还没开始填）⇒ **空是合法的**。
    #[serde(default)]
    pub fp: String,
}

/// 产出侧：从一份公开材料 ＋ 指纹造载荷。
///
/// ⚠️ **先验材料能不能解析**（施工单 §4 判据 ⑤）：一份读不懂的材料**根本不该被发出去**
/// —— 发出去只会让对方在"采纳"那一步才炸，而且现场看起来像"二维码坏了"。
pub fn payload_from_material(material: &str, fp: &str) -> Result<PairingPayload, String> {
    crate::keyring::Keyring::from_json(material)
        .map_err(|e| format!("这份公开材料读不懂（**没有生成载荷**）：{e}"))?;
    Ok(PairingPayload {
        v: PAIRING_VERSION,
        material: material.to_string(),
        fp: fp.to_string(),
    })
}

/// 编码成**一段文本**（紧凑 JSON）。
///
/// ⚠️ 返回 `Result` 而不是静默空串：发出去的东西不许无声地变成空（与 `encode_announce` 同一纪律）。
pub fn encode_payload(p: &PairingPayload) -> Result<String, String> {
    serde_json::to_string(p).map_err(|e| format!("配对载荷编码失败：{e}"))
}

/// 解码一段文本。
///
/// 三条都**当场报错、不猜**：版本不认识、字段多出来（`deny_unknown_fields`）、材料不像钥匙袋。
/// 最后一条是**故意**放在这里的：让它**扫码那一步**就失败，而不是拖到采纳那一步。
pub fn decode_payload(raw: &str) -> Result<PairingPayload, String> {
    let p: PairingPayload =
        serde_json::from_str(raw).map_err(|e| format!("这不是一个配对载荷（或字段对不上）：{e}"))?;
    if p.v != PAIRING_VERSION {
        return Err(format!(
            "配对载荷版本 {} 本版不认识（本版认到 {PAIRING_VERSION}）—— 请升级应用后再扫",
            p.v
        ));
    }
    crate::keyring::Keyring::from_json(&p.material)
        .map_err(|e| format!("载荷里的公开材料读不懂：{e}"))?;
    Ok(p)
}

/// 这段文本**装得进一张二维码**吗（按 [`QR_SINGLE_BYTE_LIMIT`]）。
pub fn fits_single_qr(raw: &str) -> bool {
    raw.len() <= QR_SINGLE_BYTE_LIMIT
}

/// 装不下时给一句**人话**（装得下 ⇒ `None`）。★ 判据 ④ 的落点。
///
/// ⚠️ **绝不返回被截断的文本**：本函数只回答"够不够 + 怎么办"，截断由**调用方**去决定
/// —— 而在本片的口径里，唯一的正确答案是**降级到另一条通道**（短码/拆码），不是截断。
pub fn qr_capacity_error(raw: &str) -> Option<String> {
    if fits_single_qr(raw) {
        return None;
    }
    Some(format!(
        "这段配对码有 {} 字节，超过一张二维码的上限 {} 字节 ⇒ **装不下**。\n\
         出路：① 用短码通道（不经二维码）；② 或把空间拆开、分几张码传。\n\
         ⚠️ **不要截断**：截断后的材料会一路走到「解不开盒子」才暴露。",
        raw.len(),
        QR_SINGLE_BYTE_LIMIT
    ))
}

// ── 比对码（路线 ①：路线 ③ 的 PAKE 未做，见 docs/plans/2026-09-25-b-slice-pake-selection.md）──────
//
// 为什么需要它：二维码那条通道**不经网络**，所以它缺的不是机密性，而是**来源真实性**
// —— 有人把自己的码换上去，收下的人就会把数据同步进一个**攻击者知道钥匙**的空间。
// 而"材料 ＋ 口令"里的口令**不在本片保护范围内**（盒子是口令包的，这是既有设计）。
// ⇒ 两端各算一个**比对码**、由人核对一致，这就是路线 ① 的那一半承重。

/// 比对码的**熵下限**（bit）。
///
/// ⚠️ 这个数字不是拍脑袋：攻击者**不需要**爆破这个码，他可以**离线改自己的假载荷**、
/// 试到比对码撞上为止（第二原像）。所以长度必须让这种搜索不可行 ——
/// 2³⁰ 秒级、2⁴⁰ 分钟级、**2⁶⁰ 才是"要花掉很大一笔算力"**。设计稿 §3 那张表把这三行分开写了。
pub const CHECK_CODE_MIN_BITS: u32 = 60;

/// 比对码的**域分隔串**。
///
/// 为什么要它：同一个哈希函数在这个仓里被用去好几件事（附件寻址、书签、指纹…），
/// 不隔开的话，"某个别的用途的哈希前缀"可能恰好能当比对码用。
/// ⚠️ 字面量只写这一处，改它要一次改全（与 `crdt_wire` / `WIRE_VERSION` 同一条纪律）。
const CHECK_DOMAIN: &[u8] = b"shuyo-pair-check-v1";

/// 从**整段载荷文本**派生比对码（20 位十进制，按 4 位一组给人念）。
///
/// 两条性质是**承重**的（判据钉着）：
/// 1. **确定性** —— 同一份载荷在任何一台设备上派生出同一个码（否则两个人没法"对一下"）；
/// 2. **整段参与** —— 载荷里**任何一个字节**变了，码就变。若只取材料的一部分参与派生，
///    攻击者就能在与派生无关的那部分上自由改动而保持码不变 ⇒ "换码"照样能过。
///
/// 渲染：20 位十进制。为什么不是词：**本仓没有词表**（2048 词那种要另引一份资源并谈许可），
/// 而"念起来顺口"是**渲染**问题 —— 安全性只取决于上面那两条 ＋ [`CHECK_CODE_MIN_BITS`]，
/// 换成词表渲染不动这条判据。词表留作 UX 决定（见施工单 §8）。
pub fn check_code(payload_text: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(CHECK_DOMAIN);
    h.update([0u8]); // 分隔符：域串与载荷的拼接不许有歧义（否则两个不同输入可能拼出同一串）
    h.update(payload_text.as_bytes());
    let d = h.finalize();
    // 取前 11 字节 = 88 bit，再 `% 10^20`（≈2^66.4）⇒ 有效熵约 66 bit，满足 ≥60。
    let mut v: u128 = 0;
    for b in d.iter().take(11) {
        v = (v << 8) | u128::from(*b);
    }
    let n = v % 10u128.pow(20);
    let s = format!("{n:020}");
    s.as_bytes()
        .chunks(4)
        .map(|c| std::str::from_utf8(c).unwrap_or("????"))
        .collect::<Vec<_>>()
        .join(" ")
}

/// 只留十进制数字（人念/人抄的时候会带空格或短横，不该因此判错）。
fn digits_only(s: &str) -> String {
    s.chars().filter(char::is_ascii_digit).collect()
}

/// ★ **把"人眼核过"变成机器可执行的那一步**（路线 ① 唯一的防换码手段）。
///
/// - `confirmed = None` ⇒ **不检查**：两台设备就在一起、用眼睛对屏幕看比对码的那条路；
/// - `confirmed = Some(用户记下的码)` ⇒ **必须逐位相同**（空格/短横忽略），否则 `Err`。
///
/// 为什么要它：如果比对码只是"显示出来让人看一眼"，那么**绕过去是零成本的** ——
/// 一次赶时间的点击就能把被换过的载荷收进来，而没有任何东西会记录这件事。
/// 做成参数以后，"我核过了"就有了一个**可断言**的落点：界面上必须真核过才拿得到那个值。
///
/// 成功时返回**这段载荷算出来的**比对码（界面拿它去显示/复述）。
pub fn verify_confirm_code(payload_text: &str, confirmed: Option<&str>) -> Result<String, String> {
    let computed = check_code(payload_text);
    let Some(user) = confirmed else {
        return Ok(computed);
    };
    if digits_only(&computed) != digits_only(user) {
        return Err(format!(
            "比对码对不上 ⇒ **没有采纳，本机一个字节都没改**。\n\
             这段码算出来是：{computed}\n\
             你记下的是：    {user}\n\
             ⚠️ 这**可能意味着这段码被换过**（也可能只是抄错了）—— 请回到给出这段码的那台设备上重新核对。"
        ));
    }
    Ok(computed)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一份**真的**公开材料（复用 keyring 的构造，不手写 JSON —— 手写的会随格式改动悄悄失效）。
    /// 返回**两种形态**：`to_json()` 的 canonical 形态，与紧凑形态（`from_json` 一样收，
    /// 但**字节不同** —— 后者才是"原样搬运"那条判据的试金石，见往返那条用例）。
    fn material_pair(spaces: &[&str]) -> (String, String) {
        let mut kr = crate::keyring::Keyring::new();
        let m = kr.kdf.derive_master("口令八个字以上").unwrap();
        for id in spaces {
            kr.wrap(&m, id, &crate::keyring::random_space_key()).unwrap();
        }
        (kr.to_json().unwrap(), serde_json::to_string(&kr).unwrap())
    }

    fn material_with(spaces: &[&str]) -> String {
        material_pair(spaces).0
    }

    /// ★ 判据 ①（往返）：**逐字节**原样回来 —— 不是"语义相同"。
    ///
    /// 退化会怎样：第二台设备拿到的材料与源机那份**不是同一份字节**（例如解码时重新序列化），
    /// 而"能不能解开盒子"整条链就建立在这一份字节上。
    ///
    /// ⚠️ **这条判据差点是摆设**（2026-09-25 变异实测抓到的）：只测 ①（canonical 材料）时，
    /// 把解码改成「重新 `to_json()`」**不会红** —— 因为输入本来就是 `to_json()` 的输出，
    /// 重新序列化得到同一串。⇒ 必须再加 ② 一个**非 canonical**（紧凑）样本，
    /// 它才分得出「原样搬运」与「重新序列化」。
    #[test]
    fn a_payload_round_trips_byte_for_byte() {
        let (pretty, compact) = material_pair(&["sp-a", "sp-b"]);
        assert_ne!(pretty, compact, "两种形态必须真的不同，否则②这条判据也是空的");

        // ① canonical 形态
        let p = payload_from_material(&pretty, "fp-abc").unwrap();
        let raw = encode_payload(&p).unwrap();
        let back = decode_payload(&raw).unwrap();
        assert_eq!(back.material, pretty, "★ 材料必须**逐字节**原样回来");
        assert_eq!(back.fp, "fp-abc");
        assert_eq!(back.v, PAIRING_VERSION);

        // ② ★ 非 canonical 形态：这才是「原样搬运」的试金石
        let p = payload_from_material(&compact, "fp-abc").unwrap();
        let raw = encode_payload(&p).unwrap();
        let back = decode_payload(&raw).unwrap();
        assert_eq!(
            back.material, compact,
            "★ 紧凑形态也必须逐字节原样 —— 解码时**重新序列化**会在这里现形"
        );
    }

    /// ★ 判据（口径 1）：载荷的顶层字段**只许**是那三个 —— 多一个**直接拒收**。
    ///
    /// 退化会怎样：有人顺手加一个"诊断字段"（设备名、内网地址、用户名…），
    /// 而这段码**会被印出来给旁边的人看**。`serde` 默认是**静默忽略**未知字段
    /// ⇒ 那种字段会一路传下去、没人会注意到它进了载荷。所以这里靠 `deny_unknown_fields`。
    #[test]
    fn a_payload_rejects_any_extra_field() {
        let material = material_with(&["sp-a"]);
        let mut v: serde_json::Value = serde_json::from_str(&encode_payload(&payload_from_material(&material, "").unwrap()).unwrap()).unwrap();
        // 先确认没有多字段时是好的（否则下面那条断言可能是"因为别的原因"才红）
        let ok = serde_json::to_string(&v).unwrap();
        assert!(decode_payload(&ok).is_ok(), "干净载荷本来就该过");

        v.as_object_mut().unwrap().insert("device_name".into(), serde_json::json!("张三的 MacBook"));
        let with_extra = serde_json::to_string(&v).unwrap();
        let err = decode_payload(&with_extra).unwrap_err();
        assert!(
            err.contains("字段对不上") || err.contains("unknown field") || err.contains("device_name"),
            "多一个字段必须**当场拒收**（不是静默忽略）：{err}"
        );
    }

    /// ★ 判据 ④：**超容量如实降级，绝不截断**。
    ///
    /// 退化会怎样：为了"让它扫得出来"而砍掉尾巴 ⇒ 第二台设备拿到的是一份**残缺的材料**，
    /// 而它一路走到"解不开盒子"才暴露，现场看起来像"二维码坏了"或"口令错了"。
    #[test]
    fn an_oversized_payload_says_so_instead_of_being_truncated() {
        // 造一份远超上限的材料（很多空间）
        let ids: Vec<String> = (0..80).map(|i| format!("sp-{i:03}")).collect();
        let refs: Vec<&str> = ids.iter().map(|s| s.as_str()).collect();
        let material = material_with(&refs);
        let p = payload_from_material(&material, "").unwrap();
        let raw = encode_payload(&p).unwrap();

        assert!(raw.len() > QR_SINGLE_BYTE_LIMIT, "造出来的样本必须真的超限（否则这条判据是空的）");
        assert!(!fits_single_qr(&raw));
        let msg = qr_capacity_error(&raw).expect("超限必须给一句人话");
        assert!(msg.contains("装不下"), "{msg}");
        assert!(msg.contains("不要截断"), "★ 必须明确说「别截断」：{msg}");

        // ★ 核心断言：**编码结果没有被截断** —— 它仍然能原样解回来
        let back = decode_payload(&raw).unwrap();
        assert_eq!(back.material, material, "★ 超限也不许截断：整段仍要能逐字节解回");

        // 边界：正好等于上限 ⇒ 装得下；多 1 字节 ⇒ 装不下
        let at_limit = "x".repeat(QR_SINGLE_BYTE_LIMIT);
        assert!(fits_single_qr(&at_limit), "正好等于上限算装得下");
        assert!(qr_capacity_error(&at_limit).is_none());
        let over = "x".repeat(QR_SINGLE_BYTE_LIMIT + 1);
        assert!(!fits_single_qr(&over), "多一个字节就算装不下");
    }

    /// 判据 ⑤：**版本不认识 ⇒ 报错不猜**（照 `Keyring::from_json` 的口径）。
    #[test]
    fn an_unknown_payload_version_is_refused_not_guessed() {
        let material = material_with(&["sp-a"]);
        let raw = format!(
            "{{\"v\":{},\"material\":{},\"fp\":\"\"}}",
            PAIRING_VERSION + 1,
            serde_json::to_string(&material).unwrap()
        );
        let err = decode_payload(&raw).unwrap_err();
        assert!(err.contains("版本"), "{err}");
        assert!(err.contains("不认识"), "{err}");
    }

    /// 判据：**材料读不懂 ⇒ 两头都不许过**（产出侧与解析侧各一次）。
    #[test]
    fn a_material_that_is_not_a_keyring_is_refused_on_both_ends() {
        let err = payload_from_material("这不是材料", "").unwrap_err();
        assert!(err.contains("读不懂"), "{err}");
        assert!(err.contains("没有生成载荷"), "产出侧要明说「什么都没生成」：{err}");

        let raw = "{\"v\":1,\"material\":\"也不是材料\",\"fp\":\"\"}";
        let err = decode_payload(raw).unwrap_err();
        assert!(err.contains("读不懂"), "{err}");
    }

    /// 判据：**空指纹是合法的今天**（`LanAnnounce.fp` 还没开始填）——
    /// 否则 B 片落地之前产出的每一份载荷都会被自己拒掉。
    #[test]
    fn an_empty_fingerprint_is_accepted() {
        let material = material_with(&["sp-a"]);
        let p = payload_from_material(&material, "").unwrap();
        let raw = encode_payload(&p).unwrap();
        assert_eq!(decode_payload(&raw).unwrap().fp, "");
        // 也让"字段缺省即空"这条成立（老产出方可能根本不写 fp）
        let raw_no_fp = format!(
            "{{\"v\":1,\"material\":{}}}",
            serde_json::to_string(&material).unwrap()
        );
        assert_eq!(decode_payload(&raw_no_fp).unwrap().fp, "");
    }

    /// 量纲自检：本模块的尺寸预期要跟施工单 §1 F3 的实测对得上。
    /// （一旦 keyring 的格式变大，这条会先红 —— 比"某天二维码突然装不下"早得多。）
    ///
    /// ★ 它同时是**读数源**：选型设计稿附录里那条命令靠它给出数字。
    /// ⚠️ 过滤器要写准：真实路径是 `pairing::tests::the_measured_sizes_still_match_the_workorder`，
    ///    写成 `pairing::the_measured_sizes` 会**安静地跑 0 条**（2026-09-25 我自己踩到过）。
    #[test]
    fn the_measured_sizes_still_match_the_workorder() {
        let one = encode_payload(&payload_from_material(&material_with(&["sp-000"]), "").unwrap()).unwrap();
        println!("PAIRING-SIZE 1 个空间：载荷 {} 字节（二维码上限 {}）", one.len(), QR_SINGLE_BYTE_LIMIT);
        for n in [3usize, 5, 10] {
            let ids: Vec<String> = (0..n).map(|i| format!("sp-{i:03}")).collect();
            let refs: Vec<&str> = ids.iter().map(|s| s.as_str()).collect();
            let raw = encode_payload(&payload_from_material(&material_with(&refs), "").unwrap()).unwrap();
            println!(
                "PAIRING-SIZE {n} 个空间：载荷 {} 字节 ⇒ {}",
                raw.len(),
                if fits_single_qr(&raw) { "单张二维码装得下" } else { "**装不下**" }
            );
        }
        // 施工单 F3 实测：1 个空间的**紧凑材料**是 360 字节；载荷还多包了一层，
        // 所以这里只断言"同一量级"（材料自身 300~500，载荷比它大但不到两倍）。
        assert!(one.len() > 360, "载荷比裸材料大（外面还包了一层）：{}", one.len());
        assert!(one.len() < 720, "载荷不该比裸材料大出一倍：{}", one.len());
    }

    // ── 比对码（路线 ①）────────────────────────────────────────────────────────────

    /// 判据：**确定性 ＋ 形状** —— 两端要能"对一下"，所以同一份载荷必须派生出同一个码。
    #[test]
    fn the_check_code_is_deterministic_and_well_shaped() {
        let raw = encode_payload(&payload_from_material(&material_with(&["sp-a"]), "fp-1").unwrap()).unwrap();
        let a = check_code(&raw);
        let b = check_code(&raw);
        assert_eq!(a, b, "同一份载荷必须派生出同一个码（否则两个人没法对）");

        let groups: Vec<&str> = a.split(' ').collect();
        assert_eq!(groups.len(), 5, "给人念的形状：4 位一组、共 5 组：{a}");
        for g in &groups {
            assert_eq!(g.len(), 4, "每组 4 位：{a}");
            assert!(g.chars().all(|c| c.is_ascii_digit()), "只许十进制数字：{a}");
        }
    }

    /// ★ 判据：**整段参与派生** —— 载荷里任何一个字节变了，码就变。
    ///
    /// 退化会怎样：若只拿材料的一部分参与派生，攻击者就能在**与派生无关的那部分**上
    /// 自由改动而保持比对码不变 ⇒ 人眼核对照样通过，"换码"就防不住了。
    #[test]
    fn the_check_code_covers_the_whole_payload() {
        let m1 = material_with(&["sp-a"]);
        let m2 = material_with(&["sp-b"]);
        let base = encode_payload(&payload_from_material(&m1, "fp-1").unwrap()).unwrap();
        let other_material = encode_payload(&payload_from_material(&m2, "fp-1").unwrap()).unwrap();
        let other_fp = encode_payload(&payload_from_material(&m1, "fp-2").unwrap()).unwrap();

        assert_ne!(check_code(&base), check_code(&other_material), "★ 材料变了，码必须变");
        assert_ne!(check_code(&base), check_code(&other_fp), "★ 指纹变了，码必须变");
        // 连"只多一个空格"也要变（说明是按字节派生的，不是按解析后的字段）
        assert_ne!(
            check_code(&base),
            check_code(&format!("{base} ")),
            "★ 末尾多一个空格也要变：按**字节**派生，不按解析后的字段"
        );
    }

    /// ★ 判据：**域分隔真的在起作用**。
    ///
    /// 退化会怎样：去掉域分隔串，`check_code` 就退化成"某个裸 SHA-256 的前缀渲染" ——
    /// 而同一个哈希在这个仓里被用去好几件事（附件寻址、书签…），
    /// 于是"别处那个哈希的前缀"可能恰好能当比对码用。这条把"域串必须在"钉住。
    #[test]
    fn the_check_code_is_domain_separated() {
        fn render_without_domain(payload: &str) -> String {
            use sha2::{Digest, Sha256};
            let d = Sha256::digest(payload.as_bytes());
            let mut v: u128 = 0;
            for b in d.iter().take(11) {
                v = (v << 8) | u128::from(*b);
            }
            let s = format!("{:020}", v % 10u128.pow(20));
            s.as_bytes()
                .chunks(4)
                .map(|c| std::str::from_utf8(c).unwrap_or("????"))
                .collect::<Vec<_>>()
                .join(" ")
        }
        let raw = encode_payload(&payload_from_material(&material_with(&["sp-a"]), "").unwrap()).unwrap();
        assert_ne!(
            check_code(&raw),
            render_without_domain(&raw),
            "★ 去掉域分隔串就会与裸 SHA-256 的前缀渲染相同 —— 这条就是用来发现那件事的"
        );
    }

    /// 判据：**熵下限**（设计稿 §3 那张表：第二原像的代价）。
    /// 这条是"数字自己别漂"的自检：谁把下限调低、或把渲染空间改小，都会在这里红。
    #[test]
    fn the_check_code_stays_above_the_agreed_entropy_floor() {
        assert!(
            CHECK_CODE_MIN_BITS >= 60,
            "下限不许低于 60 bit（设计稿 §3）：{}",
            CHECK_CODE_MIN_BITS
        );
        // 渲染空间 10^20 ≈ 2^66.4，必须不小于下限
        let bits = (10f64.powi(20)).log2();
        assert!(
            bits >= f64::from(CHECK_CODE_MIN_BITS),
            "渲染空间只有 {bits:.1} bit，低于下限 {}",
            CHECK_CODE_MIN_BITS
        );
    }

    /// ★ 判据：**"我核过了"必须能被机器判定**（路线 ① 唯一的防换码手段）。
    ///
    /// 三种情形分别钉住：对不上 ⇒ **拒**；对得上（含带空格/短横的写法）⇒ 过；
    /// 不给 ⇒ 过（两台设备就在一起、用眼睛对屏幕那条路）。
    #[test]
    fn a_confirmed_check_code_is_enforced_when_given() {
        let raw = encode_payload(&payload_from_material(&material_with(&["sp-a"]), "fp-1").unwrap()).unwrap();
        let truth = check_code(&raw);

        // ① 对得上（原样 / 去掉空格 / 换成短横，都算对）⇒ 过，并返回算出来的那个码
        assert_eq!(verify_confirm_code(&raw, Some(&truth)).unwrap(), truth);
        assert_eq!(
            verify_confirm_code(&raw, Some(&truth.replace(' ', ""))).unwrap(),
            truth,
            "人抄的时候不带空格也算对"
        );
        assert_eq!(
            verify_confirm_code(&raw, Some(&truth.replace(' ', "-"))).unwrap(),
            truth,
            "人抄的时候用短横也算对"
        );

        // ② ★ 对不上 ⇒ **拒**，且话要说清"本机一个字节都没改"
        let wrong = "0000 0000 0000 0000 0000";
        assert_ne!(truth, wrong, "这条用例要的是真的对不上");
        let err = verify_confirm_code(&raw, Some(wrong)).unwrap_err();
        assert!(err.contains("对不上"), "{err}");
        assert!(err.contains("一个字节都没改"), "★ 要说清本机没被改动：{err}");

        // ③ 不给比对码 ⇒ 过（旁边核对那条路）
        assert_eq!(verify_confirm_code(&raw, None).unwrap(), truth);
    }

    /// 判据：对不上的拒绝**必须给出两边各自的读数** ——
    /// 只回一句"码不对"，人没法判断是自己抄错了，还是这段码真被换过。
    #[test]
    fn a_rejected_check_code_shows_both_sides() {
        let raw = encode_payload(&payload_from_material(&material_with(&["sp-a"]), "").unwrap()).unwrap();
        let truth = check_code(&raw);
        let err = verify_confirm_code(&raw, Some("1111 2222 3333 4444 5555")).unwrap_err();
        assert!(err.contains(&truth), "要把**算出来的**那个码摆出来：{err}");
        assert!(err.contains("1111 2222 3333 4444 5555"), "也要把用户记下的摆出来：{err}");
        assert!(err.contains("被换过"), "要点明「可能是被换过」：{err}");
    }
}
