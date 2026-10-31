// `titleLimits`：长标题的**阈值唯一出处** ＋ 三件纯函数（方案 2026-10-30 §3 / §B4）。
//
// 为什么这些判据必须存在：标题这件小事在方案 §3 那张表里被写了十行（字号三档、软提示、
// 硬上限、侧边栏/标签页两种省略、窗口标题、导出文件名）。阈值一旦分两处写就必有一处过期，
// 所以这里钉三件事：
//   ① **数字与方案一致**（120 / 300 / 1000；34 / 28 / 24）——改数字就必须改判据；
//   ② 计数与截断**按 Unicode 码点**：emoji / 代理对算 1 个字符，且**不许**被切成半个
//      （`"📝".length === 2` 是 UTF-16 码元数；按它数，含 emoji 的标题全部算错一档）；
//   ③ 边界值落在正确的一档（40/41、80/81、1000/1001、max、max+1）。
import { describe, expect, it } from "vitest";
import {
  EMPTY_TITLE_FALLBACK,
  TITLE_FONT_SIZES,
  TITLE_FONT_BREAKS,
  TITLE_HARD_LIMIT,
  TITLE_SOFT_CHARS,
  TITLE_WARN_CHARS,
  clampTitle,
  ellipsizeMiddle,
  fallbackTitle,
  isTitleTooLong,
  titleFontSize,
  titleLength,
  truncateForDisplay,
} from "./titleLimits";

const repeat = (ch: string, n: number) => ch.repeat(n);

describe("titleLimits（长标题阈值与纯函数）", () => {
  it("① 阈值数字与方案 §3 一致（改数字会在这里红）", () => {
    expect(TITLE_SOFT_CHARS).toBe(120);
    expect(TITLE_WARN_CHARS).toBe(300);
    expect(TITLE_HARD_LIMIT).toBe(1000);
    expect([...TITLE_FONT_BREAKS]).toEqual([40, 80]);
    expect([...TITLE_FONT_SIZES]).toEqual([34, 28, 24]);
  });

  it("② 按 Unicode 码点计数：emoji / 生僻字算 1（不是 UTF-16 码元）", () => {
    expect(titleLength("")).toBe(0);
    expect(titleLength("abc")).toBe(3);
    // 📝 是代理对：`.length === 2`，但"几个字符"的答案是 1
    expect("📝".length).toBe(2);
    expect(titleLength("📝")).toBe(1);
    expect(titleLength("a📝b")).toBe(3);
    // 𠮷（U+20BB7）也是代理对
    expect("𠮷".length).toBe(2);
    expect(titleLength("𠮷")).toBe(1);
  });

  it("③ 字号三档：40/41、80/81 两个边界各落哪一档", () => {
    expect(titleFontSize("")).toBe(34);
    expect(titleFontSize(repeat("a", 40))).toBe(34);
    expect(titleFontSize(repeat("a", 41))).toBe(28);
    expect(titleFontSize(repeat("a", 80))).toBe(28);
    expect(titleFontSize(repeat("a", 81))).toBe(24);
    // 40 个 emoji 是 40 个字（UTF-16 长度 80）⇒ 仍是第一档；按码元数会错落成 28px
    expect(repeat("📝", 40)).toHaveLength(80);
    expect(titleFontSize(repeat("📝", 40))).toBe(34);
  });

  it("④ clampTitle：只在超过硬上限时裁到上限，且不切断代理对", () => {
    expect(clampTitle("短标题")).toBe("短标题");
    expect(clampTitle(repeat("a", TITLE_HARD_LIMIT))).toHaveLength(TITLE_HARD_LIMIT);
    expect(clampTitle(repeat("a", TITLE_HARD_LIMIT + 1))).toHaveLength(TITLE_HARD_LIMIT);
    expect(clampTitle(repeat("a", 5_000))).toHaveLength(TITLE_HARD_LIMIT);
    // 裁在代理对上：结果必须是完整的码点（长度 4 = 2 个 emoji；切坏会是 3）
    const cut = clampTitle(repeat("📝", 3), 2);
    expect(cut).toBe("📝📝");
    expect(cut.length).toBe(4);
    expect(clampTitle("abc", 0)).toBe("");
  });

  it("⑤ isTitleTooLong：1000 不算超，1001 才算；可传自定义上限", () => {
    expect(isTitleTooLong(repeat("a", TITLE_HARD_LIMIT))).toBe(false);
    expect(isTitleTooLong(repeat("a", TITLE_HARD_LIMIT + 1))).toBe(true);
    expect(isTitleTooLong(repeat("📝", 1001))).toBe(true);
    expect(isTitleTooLong("abcde", 5)).toBe(false);
    expect(isTitleTooLong("abcdef", 5)).toBe(true);
  });

  it("⑥ truncateForDisplay：省略号占 1 格（总长 = maxChars），不切断代理对", () => {
    // 不超长 ⇒ 原样，一个字都不动
    expect(truncateForDisplay("短标题", 10)).toBe("短标题");
    expect(truncateForDisplay(repeat("a", 5), 5)).toBe(repeat("a", 5));
    // 超长 ⇒ 前 max-1 个 + …，总长正好 5
    const shown = truncateForDisplay(repeat("a", 10), 5);
    expect(shown).toBe("aaaa…");
    expect(titleLength(shown)).toBe(5);
    // emoji：3 个码点上限 ⇒ 2 个 emoji + 省略号（切坏会是半个字符）
    const emoji = truncateForDisplay(repeat("📝", 4), 3);
    expect(emoji).toBe("📝📝…");
    expect(emoji.length).toBe(5);
    expect(truncateForDisplay("abc", 0)).toBe("");
    expect(truncateForDisplay("abc", 1)).toBe("…");
  });

  it("⑦ ellipsizeMiddle：标签页首 10 + … + 尾 8；短标题原样", () => {
    expect(ellipsizeMiddle("短标题")).toBe("短标题");
    // 刚好 head+tail+1 个字符 ⇒ 原样（省略后一样长，只会白丢中间信息）
    expect(ellipsizeMiddle(repeat("a", 19))).toBe(repeat("a", 19));
    const long = `${repeat("首", 12)}${repeat("中", 20)}${repeat("尾", 10)}`;
    const elided = ellipsizeMiddle(long);
    expect(elided).toBe(`${repeat("首", 10)}…${repeat("尾", 8)}`);
    expect(titleLength(elided)).toBe(19);
    // emoji 同样按码点切，不切出半个代理对
    const emoji = ellipsizeMiddle(repeat("📝", 30));
    expect(emoji).toBe(`${repeat("📝", 10)}…${repeat("📝", 8)}`);
    expect(emoji.length).toBe((10 + 8) * 2 + 1);
  });

  it("⑧ 空标题兜底：全空白（含全角空格）才用兜底名，非空标题原样不改", () => {
    expect(fallbackTitle("")).toBe(EMPTY_TITLE_FALLBACK);
    expect(fallbackTitle("   ")).toBe(EMPTY_TITLE_FALLBACK);
    expect(fallbackTitle("\t\n ")).toBe(EMPTY_TITLE_FALLBACK);
    expect(fallbackTitle("　")).toBe(EMPTY_TITLE_FALLBACK); // U+3000 全角空格
    expect(fallbackTitle("  ", "未命名")).toBe("未命名");
    // 有内容 ⇒ 原样（首尾空格也是用户打的，不许悄悄 trim 掉）
    expect(fallbackTitle(" 我的笔记 ")).toBe(" 我的笔记 ");
  });
});
