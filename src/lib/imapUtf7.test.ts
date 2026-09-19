import { describe, expect, it } from "vitest";
import { decodeImapUtf7 } from "./imapUtf7";

// 判据口径：这些串**不是我造的**，是两类真实来源 ——
//  ① 用户截图里「聚合收件箱」文件夹下拉实际显示的四个乱码名（QQ/163 那类中文邮箱）；
//  ② RFC 3501 §5.1.3 的官方例子（含 `,` 代 `/` 与大小写混合的 ASCII 段）。
// 期望值用独立实现（Python 的 base64 + utf-16-be 手写解码）逐条反推并 round-trip 校验过。
describe("decodeImapUtf7（IMAP modified UTF-7 解码）", () => {
  it("中文邮箱的中文文件夹名 —— 截图里那四条", () => {
    expect(decodeImapUtf7("&V4NXPpCuTvY-")).toBe("垃圾邮件");
    expect(decodeImapUtf7("&XfJSIJZkkK5O9g-")).toBe("已删除邮件");
    expect(decodeImapUtf7("&XfJT0ZAB-")).toBe("已发送");
    expect(decodeImapUtf7("&g0l6Pw-")).toBe("草稿");
    // 常见变体（同一家邮箱的另一种叫法）
    expect(decodeImapUtf7("&XfJSIJZk-")).toBe("已删除");
    expect(decodeImapUtf7("&ZTZO9nux-")).toBe("收件箱");
  });

  it("RFC 3501 §5.1.3 的例子：ASCII 段 + 编码段混排、`,` 代 `/`", () => {
    expect(decodeImapUtf7("&ZeVnLIqe-")).toBe("日本語");
    expect(decodeImapUtf7("~peter/mail/&U,BTFw-/&ZeVnLIqe-")).toBe("~peter/mail/台北/日本語");
  });

  it("ASCII 名与空串原样返回：INBOX 绝不能被改写", () => {
    expect(decodeImapUtf7("INBOX")).toBe("INBOX");
    expect(decodeImapUtf7("Sent Items")).toBe("Sent Items");
    expect(decodeImapUtf7("")).toBe("");
  });

  it("`&-` 是字面量 `&`（RFC 规定），不是编码段", () => {
    expect(decodeImapUtf7("A&-B")).toBe("A&B");
    expect(decodeImapUtf7("&-")).toBe("&");
  });

  it("坏数据一律原样返回：渲染路径上宁可不解，也不能抛", () => {
    expect(decodeImapUtf7("&V4NXpPcuTvY")).toBe("&V4NXpPcuTvY"); // 缺收尾 `-`
    expect(decodeImapUtf7("&!!!!-")).toBe("&!!!!-"); // 非 base64 字符
    expect(decodeImapUtf7("&V4NX-")).toBe("&V4NX-"); // 解出奇数字节，不是 UTF-16 码元序列
    expect(decodeImapUtf7("&A-")).toBe("&A-"); // 尾部多余位非 0
  });
});
