// 空间名的**形状归一** ＋ 空间筛选 —— **一份实现，三处用**（同名融合判等 ／ 侧栏空间切换器 ／ 设置-空间列表）。
//
// ⚠️ 规则的同序实现在 Rust：`src-tauri/src/mesh_merge_ledger.rs::normalize_space_name`（五步逐字同序）：
//   ① 去不可见字符（零宽族 `200B–200F` ／ 词连接符 `2060` ／ BOM `FEFF` ／ 软连字符 `00AD`）
//   ② 去首尾空白（**含全角空格 U+3000**）
//   ③ 全角 ASCII 折半角（`U+FF01..=U+FF5E` 平移 `0xFEE0`；⚠️ 不做完整 NFKC）
//   ④ 大小写折叠（**只 ASCII**，CJK 原样）
//   ⑤ 内部连续空白折成**一个**半角空格
//   ⚠️ **简繁/异体明确不做**（owner 2026-10-10 拍定「不算同名」✓）—— 那是**拍定不做**，
//   ⛔ 不是"还没做" ✗：猜了就会把两个本来不同名的空间悄悄融在一起 ✓。
//
// ⛔ **不要拿 `normalizeForMatch` 替代本规则** ✗（它就在 `src/lib/extract/normalize.ts`，很容易被顺手合并）：
//   ① 它在**全角标点**这一格上与本规则**相反** —— 本规则 `，`⇒`,`，而它文件头**逐字**写着
//      「全角标点／全角字母数字**不**折叠」（它是为"派生文本检索"设计的**窄口径**）；
//   ② 它与 Rust 侧有**跨语言 parity 契约**（`tests/normalize-parity.json`；`textnorm.rs:1` 逐字
//      「与 TS 侧 `normalize.ts` **逐字符同口径**（契约 §15.9）」）⇒ 为了筛选去改它 ＝ **拆别处的一致性** ✓。
//
// ⚠️ 跨语言一致性由 `tests/space-name-parity.json` 承担（同一份夹具、两侧各跑一遍 ✓）。
//   而 **Rust 侧的消费者**（`include_str!("../../tests/space-name-parity.json")` 那条 `#[test]`）
//   **待 `task-16` 落库后由那位 owner 补** —— ⚠️ 本模块落地时 `mesh_merge_ledger.rs` 还是**未跟踪**的
//   （`??`）⇒ ⛔ 本模块的判据**不去读它** ✗（免得耦合到别人未提交的东西），只在注释里点名 ✓。
//
// ⛔ 这一层**不排序** ✗（「最近使用」是另一笔 ✓），也**碰不到**"当前空间"（签名里没有它 ✓）。

/** Unicode `White_Space` 集合（⛔ 不用 JS 的 `\s` 图省事 ✗：它**少** U+0085 NEL，
 *  而 Rust 侧是 `char::is_whitespace()`＝White_Space ⇒ 两侧会静默分家 ✓）。
 *  ⚠️ `FEFF` 不在这里 —— 它归 ① 的不可见字符（先被去掉 ✓）。 */
const WHITE_SPACE = /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u;

/** ① 的字符集（逐字照 Rust 那份 `matches!` 清单 ✓）：零宽族 ／ 词连接符 ／ BOM ／ 软连字符。 */
const INVISIBLE = /[\u200b-\u200f\u2060\ufeff\u00ad]/gu;

/**
 * 空间名的**形状归一**（五步，与 Rust `normalize_space_name` 同序 ✓）。
 *
 * ⚠️ **只用于判等／筛选**，⛔ 不拿它改写用户写的名字 ✗（库里存的、界面上显示的永远是原样 ✓）。
 */
export function normalizeSpaceName(raw: string): string {
  let out = "";
  let pendingSpace = false;
  let started = false;
  for (const ch of raw.replace(INVISIBLE, "")) {
    const cp = ch.codePointAt(0) ?? 0;
    // ③ 全角 ASCII ⇒ 半角；U+3000 当空白（与 Rust 的 `'\u{3000}' => ' '` 同处置 ✓）
    const c =
      cp === 0x3000
        ? " "
        : cp >= 0xff01 && cp <= 0xff5e
          ? String.fromCodePoint(cp - 0xfee0)
          : ch;
    // ② 首尾空白（`started` 门）／ ⑤ 内部连续空白（`pendingSpace` 延迟到下一个实字才落一个空格 ✓）
    if (WHITE_SPACE.test(c)) {
      if (started) pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      out += " ";
      pendingSpace = false;
    }
    started = true;
    // ④ 大小写折叠：**只 ASCII**（Rust 是 `to_ascii_lowercase` ✓ —— ⛔ 别用 `toLowerCase()` ✗，
    //    那会把西里尔/希腊字母也折了，与规则不符 ✓）
    out += c >= "A" && c <= "Z" ? c.toLowerCase() : c;
  }
  return out;
}

/**
 * 归一后**包含**匹配（空查询 ⇒ 一律命中 ✓）。
 *
 * ⚠️ 只用于**筛选**：名字**判等**那半在融合那边（`mesh_merge_ledger.rs` 的同名判定 ✓）——
 * 两处共用的是**归一规则**，不是一个函数 ✓。
 */
export function matchSpace(name: string, query: string): boolean {
  const q = normalizeSpaceName(query);
  if (!q) return true;
  return normalizeSpaceName(name).includes(q);
}

/**
 * 过滤空间列表（**保持输入顺序** ✓；空查询 ⇒ 原样返回**全部** ✓）。
 *
 * ⛔ 不排序 ✗（「最近使用」要记"最近打开过哪个空间"，那是数据面的另一笔 ✓）；
 * ⛔ 不碰"当前空间" ✗（签名里没有它 ⇒ 筛选改不动 active ✓）。
 */
export function filterSpaces<T extends { name: string }>(
  spaces: readonly T[],
  query: string,
): T[] {
  const q = normalizeSpaceName(query);
  if (!q) return [...spaces];
  return spaces.filter((s) => normalizeSpaceName(s.name).includes(q));
}
