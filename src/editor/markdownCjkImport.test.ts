// Markdown 导入/导出与**中文相邻**的回归测试。
//
// 为什么值得单独钉：CommonMark 的强调规则与中文标点不合——`**粗体**中文` 里右分隔符后面
// 紧跟的是汉字，而规则要求"右分隔符之后必须是空白或标点"，汉字算**字母** ⇒ 这一对标记
// **原样显示**（页面上出现两个星号）。姊妹项目（数友社区）为此专门写过 `fix_cjk_bold`
// （见 shuyo-community 的 markdown.rs），所以**这条链路必须有自己的判据**，不能靠"应该没事"。
//
// 这里测的是应用真正的两条链路：
//   · 导入：`markdownToPageContent()`（社区分享/粘贴 Markdown 走它）
//   · 导出：`parseEditorState(content_json)` + `$convertToMarkdownString(SHUYONOTE_TRANSFORMERS)`
// 判据是**用户看得见的两件事**：文字里不许残留 `*`，格式要真的保住（往返后标记还在）。
import { describe, expect, it } from "vitest";
import { createEditor } from "lexical";
import { $convertToMarkdownString } from "@lexical/markdown";
import { markdownToPageContent } from "../lib/mdPreview";
import { SHUYONOTE_TRANSFORMERS } from "./markdownTransformers";
import { EDITOR_NODES } from "./config";

/** 把导出的 JSON 再转回 Markdown（与导出功能同一条路径）。 */
function backToMarkdown(contentJson: string): string {
  const editor = createEditor({ nodes: EDITOR_NODES, namespace: "md-cjk-roundtrip" });
  editor.setEditorState(editor.parseEditorState(contentJson));
  let md = "";
  editor.getEditorState().read(() => {
    md = $convertToMarkdownString(SHUYONOTE_TRANSFORMERS);
  });
  return md;
}

/** 往返一次：Markdown → 页面内容 → Markdown。 */
function roundTrip(md: string): { text: string; back: string } {
  const content = markdownToPageContent(md);
  if (!content) throw new Error(`markdownToPageContent 返回 null：${md}`);
  return { text: content.content_text, back: backToMarkdown(content.content_json) };
}

describe("Markdown 里标记紧跟中文（CommonMark 的老坑）", () => {
  it("`**粗体**中文`：不留字面星号，粗体也保住", () => {
    const { text, back } = roundTrip("**粗体**中文");
    expect(text).not.toContain("*");
    expect(text).toContain("粗体中文");
    // 往返后标记还在（说明它真的成了 bold，而不是被当成普通文字）
    expect(back).toContain("**粗体**");
  });

  it("`*斜体*中文`：同理", () => {
    const { text, back } = roundTrip("*斜体*中文");
    expect(text).not.toContain("*");
    expect(text).toContain("斜体中文");
    expect(back).toContain("*斜体*");
  });

  it("`~~删除~~中文`：同理", () => {
    const { text, back } = roundTrip("~~删除~~中文");
    expect(text).not.toContain("~");
    expect(text).toContain("删除中文");
    expect(back).toContain("~~删除~~");
  });

  it("`[链接](url)中文`：链接不被吞掉，中文跟在后面", () => {
    const { text, back } = roundTrip("[数友](https://shuyo.cn)中文");
    expect(text).toContain("数友中文");
    expect(back).toContain("https://shuyo.cn");
  });

  it("对照：`**中文**English` 与 `**中文**，标点` 也都要正常（证明用例不是空转）", () => {
    for (const md of ["**中文**English", "**中文**，逗号", "**中文**。句号"]) {
      const { text, back } = roundTrip(md);
      expect(text).not.toContain("*");
      expect(back).toContain("**中文**");
    }
  });
});
