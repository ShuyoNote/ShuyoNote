// `safeFilename`：导出文件名的 sanitize（方案 2026-10-30 §B5）。
//
// 为什么是 Windows 口径：三平台里它最严（非法字符最多、还有"设备名"这种别的系统没有的坑）。
// 这里钉八类现场：非法字符、路径穿越、设备名、尾点/空格、双扩展名截断、空名兜底、
// 中文/emoji 不转码、UTF-8 字节限长。**每一条都对应一个"不红但用户那边会出事"的形状**：
//   · 没去尾点 ⇒ `报告.` 与 `报告` 是同一个文件（Windows 静默丢点），导出两次互相覆盖；
//   · 没消解 `../` ⇒ 名字里带路径分隔符，写到别处去；
//   · 没处理 `CON` ⇒ 在 Windows 上打开的是设备，不是文件（写进去的东西全丢）；
//   · 按 UTF-16 长度限长 ⇒ emoji 被切成半个，名字里出现 `�`。
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILENAME_FALLBACK,
  FILENAME_MAX_BYTES,
  ID_SUFFIX_BYTES,
  isWindowsReservedName,
  safeFilename,
} from "./safeFilename";

const bytes = (text: string) => new TextEncoder().encode(text).length;
const repeat = (ch: string, n: number) => ch.repeat(n);

describe("safeFilename（导出文件名 sanitize）", () => {
  it("① 正常名字原样返回（中文 + 内部空格 + 扩展名一个字都不动）", () => {
    expect(safeFilename("周报 第2版.md")).toBe("周报 第2版.md");
    expect(safeFilename("report-2026-10-31.txt")).toBe("report-2026-10-31.txt");
    expect(safeFilename("我的笔记.shuyodoc")).toBe("我的笔记.shuyodoc");
  });

  it("② 非法字符与控制字符替换成 `_`（不删掉：删掉会让两个名字撞成同一个）", () => {
    expect(safeFilename('a<b>c:d"e|f?g*h')).toBe("a_b_c_d_e_f_g_h");
    expect(safeFilename("a\u0000b")).toBe("a_b"); // NUL
    expect(safeFilename("a\u001fb")).toBe("a_b"); // C0 控制字符
    expect(safeFilename("a\u009fb")).toBe("a_b"); // C1 控制字符
  });

  it("③ 路径穿越消解：`../` 段直接丢掉，结果里不许再出现分隔符", () => {
    const traversal = safeFilename("../../etc/passwd");
    expect(traversal).toBe("etc_passwd");
    expect(traversal.includes("/")).toBe(false);
    expect(traversal.includes("\\")).toBe(false);
    expect(traversal.includes("..")).toBe(false);
    // 中间夹一个 `..` 段也不许拼出目录
    expect(safeFilename("a/../b")).toBe("a_b");
    expect(safeFilename("..\\..\\x")).toBe("x");
    expect(safeFilename("a//b")).toBe("a_b");
    // 整个名字就是路径段 ⇒ 空名 ⇒ 兜底
    expect(safeFilename("..")).toBe(DEFAULT_FILENAME_FALLBACK);
  });

  it("④ Windows 保留名加 `_` 前缀（含带扩展名的 `CON.txt` 形态）", () => {
    expect(safeFilename("CON")).toBe("_CON");
    expect(safeFilename("con.txt")).toBe("_con.txt");
    expect(safeFilename("COM1.log")).toBe("_COM1.log");
    expect(safeFilename("lpt9")).toBe("_lpt9");
    expect(safeFilename("NUL.")).toBe("_NUL"); // 尾点先被去掉，再按保留名处理
    // 不是保留名的不许被乱改
    expect(safeFilename("CONSOLE.txt")).toBe("CONSOLE.txt");
    expect(safeFilename("com10.log")).toBe("com10.log"); // 只到 1–9
    // 导出判据函数本身
    expect(isWindowsReservedName("CON.txt")).toBe(true);
    expect(isWindowsReservedName("com3.tar.gz")).toBe(true);
    expect(isWindowsReservedName("AUX")).toBe(true);
    expect(isWindowsReservedName("CONSOLE")).toBe(false);
    expect(isWindowsReservedName("prn.txt")).toBe(true);
  });

  it("⑤ 结尾的点和空格去掉（Windows 会静默丢弃它们 ⇒ 不然两次导出会互相覆盖）", () => {
    expect(safeFilename("报告...")).toBe("报告");
    expect(safeFilename("报告 . ")).toBe("报告");
    expect(safeFilename("报告.md. ")).toBe("报告.md");
    expect(safeFilename("   ")).toBe(DEFAULT_FILENAME_FALLBACK);
  });

  it("⑥ 双扩展名超长：保留**最后一段**扩展名，字节数压到 180 以内", () => {
    const long = repeat("中", 200) + ".tar.gz"; // 600 + 7 字节
    const out = safeFilename(long);
    expect(out.endsWith(".gz")).toBe(true); // 保最后一段（资源管理器认的就是它）
    expect(out.includes(".tar")).toBe(false); // 主干被截掉，`.tar` 不再留
    expect(bytes(out)).toBeLessThanOrEqual(FILENAME_MAX_BYTES);
    expect(bytes(out)).toBeGreaterThan(FILENAME_MAX_BYTES - 3); // 预算用满（不是截太狠）
  });

  it("⑦ 超长：按 UTF-8 字节限长（不是字符数），且可传自定义预算", () => {
    expect(safeFilename(repeat("a", 500))).toHaveLength(FILENAME_MAX_BYTES);
    expect(bytes(safeFilename(repeat("a", 500)))).toBe(180);
    // 中文 3 字节/字 ⇒ 180 字节只装得下 60 个字
    expect(bytes(safeFilename(repeat("中", 200)))).toBe(180);
    expect(repeat("中", 60)).toHaveLength(safeFilename(repeat("中", 200)).length);
    expect(safeFilename("abcdef", { maxBytes: 3 })).toBe("abc");
  });

  it("⑧ 空输入用 fallback；fallback 自己也会被 sanitize", () => {
    expect(safeFilename("")).toBe(DEFAULT_FILENAME_FALLBACK);
    expect(safeFilename("", { fallback: "导出" })).toBe("导出");
    // 非法字符的 fallback 不许原样漏出去（它会变成真实文件名）
    expect(safeFilename("", { fallback: "a/b:c" })).toBe("a_b_c");
    // 空 fallback ⇒ 硬兜底
    expect(safeFilename("", { fallback: "" })).toBe(DEFAULT_FILENAME_FALLBACK);
  });

  it("⑨ 中文与 emoji 不转码（拼音化 / URL 编码都算改坏用户文件）", () => {
    const name = "周报 📝 第2版.md";
    expect(safeFilename(name)).toBe(name);
    expect(bytes(safeFilename("📝".repeat(30)))).toBeLessThanOrEqual(FILENAME_MAX_BYTES);
    expect(bytes(safeFilename("📝".repeat(30)))).toBe(120); // 4 字节/个，不切断代理对
  });

  it("⑩ 给 id 后缀留预算：180 - 9 = 171 字节（导出侧拼 `-<id8>` 前要扣）", () => {
    expect(FILENAME_MAX_BYTES - ID_SUFFIX_BYTES).toBe(171);
    const out = safeFilename(repeat("中", 300), { maxBytes: FILENAME_MAX_BYTES - ID_SUFFIX_BYTES });
    expect(bytes(out)).toBeLessThanOrEqual(171);
    expect(bytes(out) + ID_SUFFIX_BYTES).toBeLessThanOrEqual(FILENAME_MAX_BYTES);
  });
});
