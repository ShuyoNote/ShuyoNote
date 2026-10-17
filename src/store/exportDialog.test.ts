// 判据：导出对话框（C 弹窗）的开关状态 —— 两个入口各自带对目标 ✓（2026-10-18）。
//
// 太薄也值得钉：这两个入口是**命令面板**里唯一能打开浮层的方式；
// 目标错了 ⇒ 点「导出本空间…」却只导当前页（而且用户看不出错在哪儿）。
import { beforeEach, describe, expect, it } from "vitest";
import { useExportDialog } from "./exportDialog";

beforeEach(() => {
  useExportDialog.setState({ open: false, target: "page", pageId: null });
});

describe("exportDialog store —— C 弹窗的开关", () => {
  it("初始：关着、目标是 page、没有页 id ✓", () => {
    expect(useExportDialog.getState()).toMatchObject({ open: false, target: "page", pageId: null });
  });

  it("「导出当前页…」⇒ 目标 page ＋ 带上那一页的 id ✓", () => {
    useExportDialog.getState().openFor("page", "p-42");
    expect(useExportDialog.getState()).toMatchObject({ open: true, target: "page", pageId: "p-42" });
  });

  it("「导出本空间…」⇒ 目标 space（不需要页 id）✓", () => {
    useExportDialog.getState().openFor("space");
    expect(useExportDialog.getState()).toMatchObject({ open: true, target: "space", pageId: null });
  });

  it("关掉 ⇒ 只是 open=false（不清目标，便于调试/再次打开 ✓）", () => {
    useExportDialog.getState().openFor("space");
    useExportDialog.getState().close();
    expect(useExportDialog.getState().open).toBe(false);
    expect(useExportDialog.getState().target).toBe("space");
  });
});
