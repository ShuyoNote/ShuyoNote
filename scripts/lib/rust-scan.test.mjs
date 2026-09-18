// `rust-scan` 的判据：**门禁"切测试尾部"这一步不许漏切生产代码**。
//
// 这一组测试的存在理由很具体：旧实现用"`#[cfg(test)] mod tests` 在文件后半段 ⇒ 切到文件尾"，
// 我们用一个**变异实验**证到它会漏 —— 在 `src-tauri/src/db.rs` 末尾（测试模块之后）追加一段
// 含 `content_json` 的生产代码，旧规则**放行（绿）**，而在文件 62% 处插一个短测试模块、
// 其后再写生产代码，旧规则同样放行。两处漏报都在下面各有一条用例。
//
// 反向性质同样重要：**不许因为过度保守而把本该排除的测试尾部算成生产代码**（那会让
// "谁写内容相关测试谁红"的老问题回来），所以命名各异的测试模块、短文件里的测试尾部都要能切。
import { describe, expect, it } from "vitest";
import { isTestFile, productionText, rustTestTailStart } from "./rust-scan.mjs";

const count = (text) => (text.match(/content_json/g) ?? []).length;

describe("productionText：该切的一定切", () => {
  it("末尾是 `#[cfg(test)] mod tests` ⇒ 切掉（生产部分不含测试里的 token）", () => {
    const src = [
      "pub fn read() -> String {",
      '    "content_json".to_string()',
      "}",
      "",
      "#[cfg(test)]",
      "mod tests {",
      "    #[test]",
      '    fn t() { assert_eq!(super::read(), "content_json"); }',
      "}",
      "",
    ].join("\n");
    const out = productionText("src-tauri/src/a.rs", src);
    expect(count(out)).toBe(1); // 只剩生产那处
    expect(out).not.toContain("mod tests");
  });

  it("测试模块**不必叫 `mod tests`**（旧正则匹配不到，这是实测的 4 个文件之一）", () => {
    const src = ["pub fn f() {}", "", "#[cfg(test)]", "mod read_bytes_tests {", "    #[test]", "    fn t() {}", "}", ""].join("\n");
    expect(rustTestTailStart(src)).not.toBeNull();
    expect(productionText("src-tauri/src/a.rs", src)).not.toContain("read_bytes_tests");
  });

  it("测试尾部落在文件**前半段**（短文件）也要切", () => {
    const src = ["pub fn f() {}", "#[cfg(test)]", "mod tests {", "    #[test]", "    fn t() {}", "}"].join("\n");
    expect(rustTestTailStart(src)).not.toBeNull();
  });

  it("模块名后面跟的注释/空行不影响（尾部只剩 trivia）", () => {
    const src = ["pub fn f() {}", "#[cfg(test)]", "mod tests {", "}", "// 尾巴上的一行注释", ""].join("\n");
    expect(rustTestTailStart(src)).not.toBeNull();
  });
});

describe("productionText：不该切的一定不切（**防假绿**）", () => {
  it("★ 变异 1：测试模块**之后**还有生产代码 ⇒ 不切（旧规则在这里漏报过）", () => {
    const src = [
      "pub fn f() {}",
      "#[cfg(test)]",
      "mod tests {",
      "    #[test]",
      "    fn t() {}",
      "}",
      "",
      "/// 测试模块之后追加的生产代码",
      'pub fn sneaky() -> &\'static str { "SELECT content_json FROM pages" }',
      "",
    ].join("\n");
    expect(rustTestTailStart(src)).toBeNull();
    expect(count(productionText("src-tauri/src/a.rs", src))).toBe(1);
  });

  it("★ 变异 2：后半段插一个短测试模块、其后再写生产代码 ⇒ 不切（旧规则在这里也漏报过）", () => {
    const filler = Array.from({ length: 40 }, (_, i) => `pub fn f${i}() {}`).join("\n");
    const src = [
      filler,
      "#[cfg(test)]",
      "mod tests {",
      "    #[test]",
      "    fn dummy() {}",
      "}",
      "",
      'pub fn also_sneaky() -> &\'static str { "SELECT content_text FROM pages" }',
      "",
      "#[cfg(test)]",
      "mod tests2 {",
      "    #[test]",
      "    fn t() {}",
      "}",
    ].join("\n");
    // 真正的尾部是 `mod tests2`，切点必须落在它上面；`also_sneaky` 必须仍被计数。
    const out = productionText("src-tauri/src/a.rs", src);
    expect(out).toContain("also_sneaky");
    expect(out).toContain("content_text");
    expect(out).not.toContain("mod tests2");
  });

  it("`#[cfg(test)] use x;` 这种无花括号的 item 之后的代码仍被计数", () => {
    const src = [
      "#[cfg(test)]",
      "use std::io;",
      'pub fn f() -> &\'static str { "content_json" }',
      "#[cfg(test)]",
      "mod tests {}",
    ].join("\n");
    expect(productionText("src-tauri/src/a.rs", src)).toContain("pub fn f");
  });

  it("配对失败（花括号不闭合）⇒ 宁可全量计数", () => {
    const src = ["pub fn f() {", "#[cfg(test)]", "mod tests {", "    fn t() {}"].join("\n");
    expect(rustTestTailStart(src)).toBeNull();
    expect(productionText("src-tauri/src/a.rs", src)).toBe(src);
  });

  it("非 Rust 文件原样返回；TS 测试文件返回 null", () => {
    const ts = 'const a = "content_json";';
    expect(productionText("src/lib/x.ts", ts)).toBe(ts);
    expect(productionText("src/lib/x.test.ts", ts)).toBeNull();
    expect(isTestFile("src/lib/x.test.tsx")).toBe(true);
    expect(isTestFile("src/lib/x.ts")).toBe(false);
  });
});

describe("扫描器：注释与字符串里的花括号/属性都不算数", () => {
  it("字符串里的 `{` `}` 不参与配对（`format!` 组 SQL 的常见形态）", () => {
    const src = [
      "pub fn q() -> String {",
      '    format!("{{\\"content_json\\": 1}}")',
      "}",
      "#[cfg(test)]",
      "mod tests {",
      '    #[test]',
      '    fn t() { let s = "}"; let c = \'{\'; assert_eq!(s.len(), 1); }',
      "}",
    ].join("\n");
    expect(rustTestTailStart(src)).not.toBeNull();
  });

  it("注释里的 `#[cfg(test)] mod tests {` 是假属性，不算切点", () => {
    const src = [
      "// 说明：#[cfg(test)]",
      "// mod tests {",
      'pub fn f() -> &\'static str { "content_json" }',
    ].join("\n");
    expect(rustTestTailStart(src)).toBeNull();
    expect(count(productionText("src-tauri/src/a.rs", src))).toBe(1);
  });

  it("块注释（可嵌套）里的假属性也不算", () => {
    const src = ["/* 外层 /* 内层 */ 还是注释", "#[cfg(test)]", "mod tests { }", "*/", "pub fn f() {}"].join("\n");
    expect(rustTestTailStart(src)).toBeNull();
  });

  it("原始字符串 r#\"…\"# 里的花括号不算", () => {
    const src = ["pub fn f() {", '    let _ = r#"{ "a": } }"#;', "}", "#[cfg(test)]", "mod tests {}"].join("\n");
    expect(rustTestTailStart(src)).not.toBeNull();
  });

  it("字符串里的 `#[cfg(test)]` 不算属性", () => {
    const src = ['pub fn f() -> &\'static str { "#[cfg(test)]" }'].join("\n");
    expect(rustTestTailStart(src)).toBeNull();
  });
});
