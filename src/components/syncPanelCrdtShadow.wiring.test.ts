// ⭐ P3-3a 第三小步（task-56）：SyncPanel 的「CRDT 影子体检」手动入口 —— **接线判据**（文本级）。
//
// Node 里跑不起真窗口，因此钉结构：入口/调用/运行中禁用/只显示计数/不写数据/不自动修复。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8");

describe("SyncPanel · CRDT 影子体检入口", () => {
  const panel = read("src/components/SyncPanel.tsx");

  it("① 高级区有入口；点它才调 `shadowScanSpace(当前空间)`（不是自动扫）", () => {
    expect(panel).toContain('data-testid="crdt-shadow-diagnose-row"');
    expect(panel).toContain('data-testid="crdt-shadow-run"');
    expect(panel).toContain("shadowScanSpace(activeId)");
    // 只在按钮 onClick 里调用（⛔ 不许在挂载 effect 里自动体检）。
    const handler = panel.slice(panel.indexOf("const runCrdtShadowDiagnose"), panel.indexOf("const copyCrdtShadowSummary"));
    expect(handler).toContain("await shadowScanSpace(activeId)");
    expect(handler).toContain("if (!activeId)");
    expect(panel).not.toContain('useEffect(() => {\n    void shadowScanSpace(');
  });

  it("② 运行中禁用（防重复点击）；失败只 toast/行内，不影响同步", () => {
    expect(panel).toContain("disabled={crdtShadowBusy}");
    expect(panel).toContain("if (crdtShadowBusy) return;");
    expect(panel).toContain('data-testid="crdt-shadow-error"');
    expect(panel).toContain("diagnoseErrorText(e)");
    expect(panel, "失败只 toast（不许把整块面板打崩）").toContain('toast(msg, "error")');
  });

  it("③ 结果**只显示计数/结论**（不显示正文、不列 page id）", () => {
    expect(panel).toContain("diagnoseHeadline(crdtShadowResult)");
    expect(panel).toContain("diagnoseDetailLines(crdtShadowResult)");
    expect(panel).toContain("diagnoseFootnote(crdtShadowResult)");
    const resultBlock = panel.slice(
      panel.indexOf('data-testid="crdt-shadow-result"'),
      panel.indexOf("复制摘要"),
    );
    // ⛔ 结果块里不许渲染正文/差异页 id 列表/文件路径。
    expect(resultBlock).not.toContain("differPageIds");
    expect(resultBlock).not.toContain("content_json");
    expect(resultBlock).not.toContain("content_text");
    expect(resultBlock).not.toContain(".path");
  });

  it("④ 只读：⛔ 不自动修复、⛔ 不写任何数据", () => {
    const handler = panel.slice(panel.indexOf("const runCrdtShadowDiagnose"), panel.indexOf("const copyHistoryDiagnostics"));
    for (const forbidden of [
      "savePageState",
      "writePageCrdtState",
      "savePage(",
      "api.set",
      "api.update",
      "api.delete",
      "fetch(",
    ]) {
      expect(handler, `体检不许改数据/发写请求：${forbidden}`).not.toContain(forbidden);
    }
    expect(panel).toContain("不自动修复");
    expect(panel).toContain("不改数据");
  });

  it("⑤ 复制摘要走唯一脱敏实现（只有计数/结论）", () => {
    expect(panel).toContain("diagnoseCopyText(crdtShadowResult)");
    expect(panel).toContain('data-testid="crdt-shadow-copy"');
    expect(panel).toContain("不含正文/内部标识");
  });
});
