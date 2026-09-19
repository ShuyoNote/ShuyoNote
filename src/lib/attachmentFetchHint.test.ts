// `attachmentFetchHint` 的判据：三条真实分支各给不同的下一步，未知分支不吞原因。
//
// 用例里的报错原文都是 `src-tauri/src/sync.rs` 里**真实会返回**的字符串
// （`请先配置同步服务器` / `服务端返回 404 ...`）。写死它们是有意的：
// 哪天 Rust 侧改了文案，这条判据会红，而不是让界面悄悄退回一句含糊话。
import { describe, expect, it } from "vitest";
import { attachmentFetchHint } from "./attachmentFetchHint";

describe("attachmentFetchHint：把「取不回字节」翻成能行动的一句话", () => {
  it("这个空间没配同步服务器 ⇒ 指出只能在原电脑上重新导入", () => {
    const msg = attachmentFetchHint("请先配置同步服务器");
    expect(msg).toContain("导入它的那台电脑");
    expect(msg).toContain("重新导入");
    // 不该让用户以为"再点一次就好"
    expect(msg).not.toContain("重试");
  });

  it("服务端 404 ⇒ 说清服务器上没有、只能重新导入（也不该说重试）", () => {
    const msg = attachmentFetchHint("服务端返回 404 Not Found");
    expect(msg).toContain("服务器上没有这份字节");
    expect(msg).toContain("重新导入");
    expect(msg).not.toContain("重试");
  });

  it("401/403 ⇒ 指向同步面板（可修，且与'重新导入'是两条不同的路）", () => {
    expect(attachmentFetchHint("服务端返回 403 Forbidden")).toContain("同步面板");
    expect(attachmentFetchHint("服务端返回 401 Unauthorized")).toContain("同步面板");
  });

  it("5xx / 网络类 ⇒ 明确说可以重试", () => {
    expect(attachmentFetchHint("服务端返回 502 Bad Gateway")).toContain("重试");
    expect(attachmentFetchHint("error sending request for url (http://…)")).toContain("重试");
    expect(attachmentFetchHint("operation timed out")).toContain("重试");
  });

  it("未知错误 ⇒ 原样带上原因（本仓'错误不许被吞'那条纪律）", () => {
    const msg = attachmentFetchHint("No such file or directory (os error 2)");
    expect(msg).toContain("os error 2");
  });

  it("空值 / undefined / 对象形态都不炸", () => {
    expect(attachmentFetchHint(undefined)).toContain("取回文件失败");
    expect(attachmentFetchHint("")).toContain("取回文件失败");
    expect(attachmentFetchHint({ message: "请先配置同步服务器" })).toContain("重新导入");
  });
});
