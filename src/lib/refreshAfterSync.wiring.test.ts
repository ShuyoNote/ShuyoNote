// ⭐ 2026-10-24（owner 报「同步了没有自动刷新页面」）：**接线判据**。
//
// 为什么用文本级判据：这条修复跨三处（store 的新动作 ＋ 自动同步那一轮 ＋ 服务端 SSE 那条路），
// 而"数据落库了但界面不动"正是这一族 bug 的典型症状 —— 单测能证明 `refreshCurrent` 本身对，
// 却证明不了**同步路径真的会调它**。钉住三件事：
//   · 两条同步收口都调 `refreshCurrent()`；
//   · 两条都先过 `isLocalEditRecent()`（不许在用户打字时重挂编辑器）；
//   · 本地编辑那一处要 `markLocalEdit()`（否则节流判据永远读到"没编辑过" ⇒ 等于没接）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("同步收口 ⇒ 当前打开的页要重读（接线判据）", () => {
  const store = read("src/store/notes.ts");
  const app = read("src/App.tsx");
  const stream = read("src/hooks/useSyncStream.ts");

  it("① store 的 refreshCurrent：重新取页 ＋ 记外部写 ＋ bumpReload（三件缺一不可）", () => {
    const at = store.indexOf("refreshCurrent: async () =>");
    expect(at, "store 里没有 refreshCurrent 实现").toBeGreaterThan(-1);
    const body = store.slice(at, at + 1_200);
    expect(body, "没重新取页").toContain("api.getPage(currentId)");
    expect(body, "没记外部写 ⇒ 正在保存的那一版会把远端盖回去").toContain("noteExternalWrite(currentId)");
    expect(body, "没 bumpReload ⇒ 编辑器不重挂，界面还是旧内容").toContain("bumpReload()");
  });

  it("② 自动同步那一轮：真换到东西之后调 refreshCurrent，且先过「正在打字」节流", () => {
    expect(app, "App 没引节流判据").toContain('from "./lib/editIdle"');
    expect(app, "自动同步那一轮没调 refreshCurrent ⇒ 列表会刷、当前页永远不刷").toContain(
      "useNotes.getState().refreshCurrent()",
    );
    expect(app, "没做「正在打字就别抢编辑器」的节流").toContain("isLocalEditRecent()");
    expect(app, "本地编辑那一处没记时间 ⇒ 节流判据永远说「没编辑过」").toContain("markLocalEdit()");
  });

  it("③ 服务端 SSE 那条拉取：同样要重读当前页（两条同步路不许只修一条）", () => {
    expect(stream, "SSE 拉取路径没引节流判据").toContain('from "../lib/editIdle"');
    expect(stream, "SSE 拉取路径没调 refreshCurrent ⇒ 服务端同步照样不刷当前页").toContain(
      "useNotes.getState().refreshCurrent()",
    );
  });
});
