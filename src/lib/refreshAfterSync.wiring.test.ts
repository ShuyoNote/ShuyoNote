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

  // ⭐ 2026-10-24（真机：页 B 同页并发后两边各缺一块）：**网格那条路没有 SSE** ——
  //   Rust 后台轮把远端页并进库，前端完全不知道；编辑器里那份旧 doc 之后一保存，
  //   就把刚并进来的块盖掉。判据：后端两条路都要 emit `mesh-applied`，前端要真的监听并刷新。
  it("④ 网格（Rust 后台轮/命令面）也发 mesh-applied，前端收到要刷新当前页", () => {
    const lan = read("src-tauri/src/lan_state.rs");
    const sync = read("src-tauri/src/sync.rs");
    expect(lan, "后台轮没发 mesh-applied ⇒ 网格同步后界面永远不知道").toContain('"mesh-applied"');
    expect(sync, "命令面没发 mesh-applied ⇒ 手动同步那一轮也不会刷新").toContain('"mesh-applied"');
    const at = app.indexOf('listen<{ spaceId: string; pages: string[] }>("mesh-applied"');
    expect(at, "前端没监听 mesh-applied").toBeGreaterThan(-1);
    const body = app.slice(at, at + 700);
    expect(body, "收到 mesh-applied 没刷新当前页").toContain("refreshCurrent()");
    expect(body, "没做「正在打字」节流 ⇒ 会在用户打字时重挂编辑器").toContain("isLocalEditRecent()");
  });

  // ⭐ 2026-10-28（owner 报「同步后空间列表没有自动刷新」）：**空间清单也要有人重读** ✗ ——
  //   自动建空间发生在 `round` **之前** ⇒ 新空间不在 `mesh-applied` 那一批页里
  //   ⇒ 只刷页列表的话，侧栏（`useSpaceStore.spaces`）永远停在旧清单。
  //   判据：命令面在"真的新建了空间"时 emit `spaces-changed`；前端监听它并重读空间清单。
  it("⑤ 网格新建了空间 ⇒ 后端发 spaces-changed，前端重读空间清单", () => {
    const sync = read("src-tauri/src/sync.rs");
    expect(sync, "自动建空间之后没发 spaces-changed ⇒ 侧栏永远停在旧清单").toContain(
      'app.emit("spaces-changed"',
    );
    const at = app.indexOf('"spaces-changed"');
    expect(at, "前端没监听 spaces-changed").toBeGreaterThan(-1);
    const body = app.slice(at, at + 400);
    expect(body, "收到 spaces-changed 没重读空间清单").toContain("useSpaceStore.getState().load()");
    expect(app, "App 没引空间 store").toContain('from "./store/space"');
  });
});
