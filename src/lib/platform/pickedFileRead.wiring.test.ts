// ★ 2026-09-25（真机实测抓到的一处真 bug）：**"用户选来的那份东西"不许当文件路径直接用**。
//
// 现场：B 片"配对码存/读文件"在 Mate 40 上点「从文件读取」，系统选择器正常弹出，选完文件
// **什么都没发生**。根因在 Rust：`read_text_file` 当时只有 `std::fs::read_to_string(&path)`，
// 而 Android 的选择器给回来的是 **`content://…` URI**（`Path::new` 把它当成一个普通相对文件名，
// 必然读不到）。**写的那一半早就走 `SaveTarget` 处理了这件事，读的那一半一直漏着** ——
// 因为它当时没有调用方。
//
// 为什么用**文本级**判据：真机那条路（URI ＋ ContentResolver）在 Windows 单测里跑不出来，
// 而这类 bug 的形态恰恰是"本机全绿、只有真机才炸"。所以这里钉的是**结构**：
// 这两个命令里必须出现那个"落成真实路径 / 走 SaveTarget"的调用。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("src-tauri/src/backup.rs", "utf8");

/** 取某个 `pub fn <name>` 的函数体（到下一个顶层 `#[tauri::command]` 或文件尾为止）。 */
function bodyOf(name: string): string {
  const at = src.indexOf(`pub fn ${name}(`);
  expect(at, `backup.rs 里找不到 ${name}`).toBeGreaterThan(-1);
  const next = src.indexOf("\n#[tauri::command]", at);
  return src.slice(at, next === -1 ? src.length : next);
}

describe("用户选来的文件：读写两条路都必须处理 content:// URI", () => {
  it("★ `read_text_file` 必须先 `picked_file::materialize`（Android 给的是 URI，不是路径）", () => {
    const body = bodyOf("read_text_file");
    expect(
      body,
      "read_text_file 直接 fs::read_to_string(path) ⇒ Android 上选了文件也读不到（2026-09-25 真机实测）",
    ).toContain("picked_file::materialize");
  });

  it("★ `write_text_file` 必须走 `SaveTarget`（写 URI 只能「先写缓存再搬」）", () => {
    const body = bodyOf("write_text_file");
    expect(body, "write_text_file 直接 fs::write(uri) ⇒ 真机实测 EROFS").toContain("SaveTarget");
  });

  it("两条都**不是**把参数直接喂给 std::fs（那是这一族 bug 的形态本身）", () => {
    expect(bodyOf("read_text_file")).not.toMatch(/read_to_string\(&path\)/);
    expect(bodyOf("write_text_file")).not.toMatch(/fs::write\(&?path/);
  });
});
