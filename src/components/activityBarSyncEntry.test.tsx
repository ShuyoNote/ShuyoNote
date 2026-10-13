// ⭐ **P-2a-2（2026-10-13）**：⭐ 左栏（活动栏）常驻一个「**同步**」入口 ✓ ＋ ⭐ **状态徽标** ✓。
//
// ⚠️ 本片**只动 `ActivityBar.tsx`** ✗（⛔ `App.tsx`／`SyncPanel.tsx` 上一个写者刚动过 ✓ —— 不许碰 ✗）。
//
// **判据①**（今天红）：入口存在 ⇒ 点它 ⇒ `useViewStore.view === "sync"` ✓
//   （今天还没有这个入口 ⇒ 红 ✓；⭐ 它走的是 P-2a-1 已就位的内容区分支 ✓）。
// **判据②**（今天红）：⭐ 徽标**只在有真读数时**出现 ✓ ——
//   · 桩 `api.lanStatus` 回 `{ peers: 1 }` ⇒ 徽标出现且显示 `1` ✓；
//   · ⛔ **拉不到／0 台不许显示"0 台在线"** ✗（那是一个**假结论** ✗）⇒ 显示为空 ✓。
// **锁**（今天应绿 ⇒ ⭐ 如实标"锁，不是本片的修"✗）：
//   · ⛔ `Activity` union **没被塞进 `"sync"`** ✗（它是 `AppView` 的值 ✓，两者不是一回事 ✓）；
//   · ⭐ 其它入口**照旧可用** ✓（点「笔记」仍然 `view === "notes"` ✓）。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { lanStatusSpy } = vi.hoisted(() => {
  (globalThis as unknown as { window: Record<string, unknown> }).window.__TAURI_INTERNALS__ = {
    transformCallback: (cb: unknown) => cb,
  };
  return { lanStatusSpy: vi.fn() };
});

/** ⚠️ 只桩 `lanStatus`（徽标那条真读数 ✓）；其余一律"空读数"（竖条里那些子面板只读、不崩 ✓）。
 *  ⚠️⭐ 但**数组类的**要显式给 `[]` ✗：`Proxy` 的兜底是 `null`，而竖条挂着的子面板会在
 *  `null.filter(...)` 上当场抛 ⇒ 那是**夹具假红**（实测踩到一次 ✓），不是判据红 ✓。 */
vi.mock("../lib/api", () => ({
  api: new Proxy(
    {
      lanStatus: (id: unknown) => lanStatusSpy(id),
      listSyncProfiles: async () => [],
      spaceSecurityOverview: async () => [],
    },
    { get: (t: Record<string, unknown>, k: string) => (k in t ? t[k] : async () => null) },
  ),
}));

/** ⚠️ 本判据不测 i18n：把 `t` 变成"回键名"，于是「同步」那颗按钮的文案是**字面量** ✓（见实现 ✓）。 */
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

/** ⚠️⭐ 隔离这两个**子面板** ✗（`ActivityBar.tsx:181` 挂的 ✓）：它们在测试环境里会去读各自那份料，
 *  拿不到就 `null.filter(...)` 当场抛 ⇒ 那是**夹具假红** ✗（实测踩到 ✓），与"竖条上有没有那个入口"无关 ✓。 */
vi.mock("./TrashPanel", () => ({ TrashPanel: () => null }));
vi.mock("./SearchPanel", () => ({ SearchPanel: () => null }));

import { ActivityBar } from "./ActivityBar";
import { useSpaceStore } from "../store/space";
import { useViewStore } from "../store/view";

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) flushSync(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

/** 渲染活动栏并让徽标那条 effect 落地 ✓。 */
async function renderBar(peers: number | null, opts: { reject?: boolean } = {}): Promise<HTMLElement> {
  if (opts.reject) lanStatusSpy.mockRejectedValue(new Error("读不到"));
  else lanStatusSpy.mockResolvedValue(peers === null ? null : { peers });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  flushSync(() => root!.render(<ActivityBar />));
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1));
    });
    flushSync(() => {});
  }
  return host;
}

/** 竖条里那颗「同步」按钮（⭐ 按**可见文案**找 ⇒ ⛔ 不依赖 testid ✗）。 */
function syncEntry(el: HTMLElement): HTMLButtonElement | undefined {
  return [...el.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    (b.textContent ?? "").includes("同步"),
  );
}

describe("P-2a-2：左栏「同步」入口 ＋ 状态徽标", () => {
  beforeEach(() => {
    useViewStore.setState({ view: "notes" });
    // ⚠️ 夹具前提（照邻居那套 ✓）：竖条挂着的子面板会读空间表 ⇒ 给它一个**空数组** ✓（⛔ 别留 `null` ✗）。
    useSpaceStore.setState({ spaces: [], activeId: "ws-1" });
  });

  it("① ⭐ 入口在 ＋ 点它 ⇒ `view === \"sync\"`（今天【红】：入口还没有）", () => {
    return renderBar(1).then((el) => {
      const btn = syncEntry(el);
      expect(
        btn,
        "⭐ 左栏必须常驻一颗「同步」入口 ✓（今天【红】：竖条里没有它 ✗）",
      ).toBeTruthy();
      flushSync(() => btn!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      expect(
        useViewStore.getState().view,
        "⭐ 点它要真的切到 `sync`（那条内容区分支由 P-2a-1 就位 ✓）",
      ).toBe("sync");
    });
  });

  it("② ⭐ 徽标只在有真读数时出现（今天【红】）—— 1 ⇒ 显示；拉不到／0 ⇒ ⛔ 不显示「0 台在线」", async () => {
    const one = await renderBar(1);
    const badge = one.querySelector(".sync-badge");
    expect(badge, "⭐ `lanStatus.peers === 1` ⇒ 徽标要出现 ✓（今天【红】：连入口都没有 ✗）").toBeTruthy();
    expect(badge!.textContent ?? "", "⭐ 徽标要显示那个**真**读数 ✓").toContain("1");

    const none = await renderBar(0);
    expect(
      none.querySelector(".sync-badge"),
      "⛔ `peers === 0` ⇒ **不许**显示徽标 ✗（更不许写「0 台在线」✗ —— 那是一个**假结论** ✗）",
    ).toBeNull();
    expect(none.textContent ?? "", "⛔ 文案里不许出现「0 台在线」✗").not.toContain("0 台在线");

    const broken = await renderBar(null, { reject: true });
    expect(
      broken.querySelector(".sync-badge"),
      "⛔ 拉不到真读数 ⇒ **不显示**徽标 ✓（⛔ 不许补一个 0 ✗）",
    ).toBeNull();
  });

  it("③ 锁（今天已绿 ✓）：⛔ `Activity` union 没被塞进 `\"sync\"`（它是 `AppView` 的值 ✓）", () => {
    const activityTs = readFileSync(resolve(__dirname, "..", "store", "activity.ts"), "utf8");
    expect(
      activityTs.includes('"sync"') || activityTs.includes("'sync'"),
      "⛔ `\"sync\"` 不许进 `Activity` union ✗ —— 它是 `AppView` 的值 ✓（两者不是一回事 ✓）",
    ).toBe(false);
  });

  it("④ 锁（今天已绿 ✓）：其它入口照旧可用（点「笔记」⇒ `view === \"notes\"`）", async () => {
    const el = await renderBar(1);
    const notes = [...el.querySelectorAll<HTMLButtonElement>("button")].find((b) => {
      const s = `${b.getAttribute("title") ?? ""} ${b.getAttribute("aria-label") ?? ""} ${b.textContent ?? ""}`;
      return s.includes("nav.notes");
    });
    expect(notes, "⭐ 既有入口（笔记）要在 ✓").toBeTruthy();
    useViewStore.setState({ view: "files" });
    flushSync(() => notes!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(useViewStore.getState().view, "⭐ 点「笔记」仍要切回 `notes` ✓").toBe("notes");
  });
});
