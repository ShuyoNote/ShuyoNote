//! 查询侧文本归一化 —— 与 TS 侧 `src/lib/extract/normalize.ts` **逐字符同口径**（契约 §15.9）。
//!
//! ## 它挡的是什么（真发生过的形状）
//! 抽取层在**落库前**会把「兼容表意字」折成统一表意字：Chrome 打印的中文 PDF 里，
//! `第⼀段` 用的是 **U+2F00「康熙部首 ⼀」**而不是 **U+4E00「一」**。落库时折过之后，
//! 正文里存的是「一」；而**查询侧若不折**，用户从 PDF 里粘一个兼容形来搜 —— **搜不到**。
//! 索引归一了、查询没归一，等于白归一。
//!
//! ## 为什么不是"整串跑 NFKC"
//! NFKC 会把**全角标点/全角数字**一起折掉：
//!
//! ```text
//! NFKC("，") === ","      // 同一句里标点风格混杂 ⇒ 可见的质量退化
//! ```
//!
//! ⇒ 口径是**窄的**：只折四个「兼容表意字」区间，且**逐字符**折（不是整串）。
//! 区间与 TS 侧的 `COMPAT_IDEOGRAPH` 正则**一一对应**，两边漂移了没有任何编译期信号
//! ——所以两侧共用 `tests/normalize-parity.json` 做跨语言一致性断言。

/// 四个「兼容表意字」区间（与 TS 侧正则同口径）：
/// `U+2E80–U+2EFF` CJK 部首补充 / `U+2F00–U+2FDF` **康熙部首** / `U+F900–U+FAFF` CJK 兼容表意字
/// / `U+2F800–U+2FA1F` CJK 兼容表意字补充。
fn is_compat_ideograph(c: char) -> bool {
    matches!(
        c as u32,
        0x2E80..=0x2EFF | 0x2F00..=0x2FDF | 0xF900..=0xFAFF | 0x2F800..=0x2FA1F
    )
}

/// 查询侧归一化：只折叠兼容表意字，其余字符**原样保留**。
///
/// 幂等（折过的字符已不在区间内，再折一次不变）；不含目标字符时零拷贝语义的早退
/// （检索是热路径，绝大多数查询一个字都不用折）。
pub fn normalize_for_match(s: &str) -> String {
    if !s.chars().any(is_compat_ideograph) {
        return s.to_string();
    }
    let nfkc = icu_normalizer::ComposingNormalizer::new_nfkc();
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if is_compat_ideograph(c) {
            // 逐字符折：整串 NFKC 会连全角标点一起折掉（见文件头）。
            out.push_str(nfkc.normalize(&c.to_string()).as_ref());
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cps(s: &str) -> Vec<u32> {
        s.chars().map(|c| c as u32).collect()
    }

    #[test]
    fn folds_kangxi_radical_to_unified_ideograph() {
        // 「第⼀段」（U+2F00）必须折成「第一段」（U+4E00）—— 这条就是本次要修的那个 bug。
        let folded = normalize_for_match("第\u{2F00}段");
        assert_eq!(folded, "第一段");
        assert_eq!(cps(&folded), vec![0x7B2C, 0x4E00, 0x6BB5]);
    }

    #[test]
    fn folds_cjk_compatibility_ideograph() {
        // U+F900（CJK 兼容表意字）→ U+8C48
        assert_eq!(cps(&normalize_for_match("\u{F900}")), vec![0x8C48]);
        // U+2F800（补充区）→ U+4E3D
        assert_eq!(cps(&normalize_for_match("\u{2F800}")), vec![0x4E3D]);
    }

    #[test]
    fn keeps_everything_else_untouched() {
        // §15.9 的明文口径：这两类**必须**原样保留 —— 这是最容易被"顺手改成整串 NFKC"的地方。
        for s in [
            "１２３", "ＡＢＣ", "，。！？", "①", "㈱", "ﬁ", "abc 123", "第一段", "",
        ] {
            assert_eq!(normalize_for_match(s), s, "不该被折：{s}");
        }
    }

    #[test]
    fn is_idempotent() {
        let once = normalize_for_match("第\u{2F00}段 ABC １２３");
        assert_eq!(normalize_for_match(&once), once);
    }

    /// 跨语言一致性：与 TS 侧共用同一份夹具（`tests/normalize-parity.json`）。
    /// 两侧口径漂移（比如有人在一边加了全角折叠）在这条上会当场红。
    #[test]
    fn matches_the_shared_cross_language_fixture() {
        let raw = include_str!("../../tests/normalize-parity.json");
        let j: serde_json::Value = serde_json::from_str(raw).expect("夹具 JSON 解析失败");
        let cases = j["cases"].as_array().expect("夹具缺 cases");
        assert!(!cases.is_empty(), "夹具为空 —— 那这条断言等于没跑");
        for case in cases {
            let name = case["name"].as_str().unwrap_or("(无名)");
            let input: String = case["in"]
                .as_array()
                .expect("in 必须是码点数组")
                .iter()
                .map(|v| char::from_u32(v.as_u64().expect("码点必须是整数") as u32).expect("非法码点"))
                .collect();
            let want: String = case["out"]
                .as_array()
                .expect("out 必须是码点数组")
                .iter()
                .map(|v| char::from_u32(v.as_u64().expect("码点必须是整数") as u32).expect("非法码点"))
                .collect();
            assert_eq!(normalize_for_match(&input), want, "夹具不一致：{name}");
        }
    }
}
