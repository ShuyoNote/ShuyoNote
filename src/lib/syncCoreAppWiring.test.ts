// ⭐ P3-1a 第五刀（task-58）：App 的 **Core 接管 / 前端定时器回退** 接线判据（文本级）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync("src/App.tsx", "utf8");

describe("App · Core 与前端定时器的启停决策", () => {
  it("① 按纯函数决策去开关 Core；评估时点覆盖 mount/online/offline/visibility/换档", () => {
    expect(app).toContain("shouldEnableRustCore(");
    expect(app).toContain("api.syncCoreSetEnabled(");
    for (const ev of ['"online"', '"offline"', '"visibilitychange"', "AUTO_SYNC_CHANGED_EVENT"]) {
      expect(app, `缺评估时点 ${ev}`).toContain(ev);
    }
    // 只有"要开 ＋ 命令回报 enabled"才算 Core 接管（老内核/Web 回落 timer）。
    expect(app).toContain("st?.enabled === true");
    expect(app).toContain("setCoreActive(active)");
  });

  it("①b ⭐ task-69：桌面 Core 决策**不再调用** shouldAutoSyncNow（闸门在 Rust Core 内）", () => {
    const start = app.indexOf("const desktop = isDesktopPlatform();");
    expect(start, "Core 决策 effect 必须在").toBeGreaterThan(-1);
    const effect = app.slice(start, app.indexOf("}, [autoSyncMs]);", start));
    expect(effect).toContain("shouldEnableRustCore({ isDesktop: desktop, autoSyncMs })");
    expect(effect).not.toContain("shouldAutoSyncNow");
    expect(effect).not.toContain("gateAllowed");
    // 前端闸门仍保留在回退定时器/编辑触发那条路上（runAutoSyncRound 内）。
    expect(app).toContain("shouldAutoSyncNow()");
    expect(app).toContain("await shouldAutoSyncNow()");
  });

  it("② Core 接管时**不排**前端定时器；关闭/回退时保留今天的 setTimeout 循环", () => {
    const timerEffect = app.slice(
      app.indexOf("if (coreActive) return;"),
      app.indexOf("}, [api, loadPages, autoSyncMs, coreActive]);"),
    );
    expect(timerEffect, "缺 Core 接管时的早退 ⇒ 会双发").toContain("if (coreActive) return;");
    expect(timerEffect, "回退路径必须保留原来的 3 秒首跳").toContain("setTimeout(tick, 3000)");
    expect(app, "effect 依赖要跟 coreActive（Core 开关后立即重挂）").toContain(
      "}, [api, loadPages, autoSyncMs, coreActive]);",
    );
    // 卸载/换档时把 Core 关掉（避免残留调度器 + 前端又开定时器）。
    expect(app).toContain("api.syncCoreSetEnabled(false)");
  });

  it("③ 编辑触发保留（仍走命令路径，与定时节拍是两件事）", () => {
    expect(app).toContain("onAnyLocalEdit(");
    expect(app).toContain("requestAutoSyncRound()");
    const edit = app.slice(app.indexOf("const off = onAnyLocalEdit"), app.indexOf("}, [pageId, flushPendingSave]"));
    expect(edit).toContain("flushPendingSave()");
    expect(edit).toContain("requestAutoSyncRound()");
    // 编辑触发没有被 coreActive 提前掐掉（用户刚敲完仍要立刻上传）。
    expect(edit).not.toContain("coreActive");
  });

  it("④ 双发防护：Core 与前端定时器互斥（同一时刻只有一条路排节拍）", () => {
    // 决策纯函数保证 core ⇒ 不排 timer；App 侧再用 coreActive 早退兜一层。
    expect(app).toContain("setCoreActive(false)");
    // ⚠️ 不按字面查 `setInterval`（注释里就有历史说明）；本条的承重是"Core 接管时直接早退"，
    //    上面那条 `if (coreActive) return;` 已经钉死。
    expect(app).toContain("if (coreActive) return;");
  });
});
