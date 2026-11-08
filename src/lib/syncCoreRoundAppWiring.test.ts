// ⭐ P3-1a 第四刀（task-57）：App 对 `sync-core-round` 的消费 —— **接线判据**（文本级）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync("src/App.tsx", "utf8");

describe("App · sync-core-round 监听", () => {
  it("挂一次、卸载取消；收到后走与 mesh-applied 同一条刷新路径", () => {
    expect(app).toContain('"sync-core-round"');
    expect(app).toContain("refreshAfterBackgroundApply()");
    // 两个事件共用同一个刷新实现（⛔ 各写一份）。
    expect(app).toContain('"mesh-applied"');
    const mesh = app.slice(app.indexOf('"mesh-applied"'), app.indexOf('"sync-core-round"'));
    const core = app.slice(app.indexOf('"sync-core-round"'), app.indexOf('"spaces-changed"'));
    expect(mesh).toContain("refreshAfterBackgroundApply()");
    expect(core).toContain("refreshAfterBackgroundApply()");
    // 卸载取消监听。
    expect(core).toContain("return () => unlisten?.()");
  });

  it("刷新路径保留节流（打字中不重挂编辑器）且不弹 toast/不新增同步调用", () => {
    const helper = app.slice(
      app.indexOf("function refreshAfterBackgroundApply"),
      app.indexOf("/**\n * 跑一轮自动同步")
    );
    expect(helper).toContain("useNotes.getState().loadPages()");
    expect(helper).toContain("isLocalEditRecent()");
    expect(helper).toContain("refreshCurrent()");
    expect(helper).not.toContain("toast");
    const core = app.slice(app.indexOf('"sync-core-round"'), app.indexOf('"spaces-changed"'));
    expect(core).not.toContain("toast(");
    expect(core).not.toContain("syncCoreRound(");
    expect(core).not.toContain("meshSync");
  });
});
