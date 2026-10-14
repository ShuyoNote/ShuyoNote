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
  // ⭐ **2026-10-14（owner：「去掉侧边工具栏里面的按钮汉字」）** ✗ —— ⭐ 那颗按钮不再有汉字 ✓
  //   ⇒ ⭐ 判据改**按 `data-testid` 认它** ✓（⭐ 断言一条没删 ✓ —— 按 R192「换对象不删断言」✓）。
  return el.querySelector<HTMLButtonElement>('[data-testid="rail-sync"]') ?? undefined;
}


// ⭐ **2026-10-14（owner 逐字：「侧边工具栏按钮用 svg，统一样式风格」）** ✗ ——
//   ⭐ 那颗邮箱原来用的是**文字字形** `✉` ✗ ⇒ ⭐ 换成 ⭐ **与其余 10 颗同一套写法**的 SVG ✓
//   （⭐ 自绘 ✓、同一处 `src/components/icons.tsx` ✓、⭐ 同一个 `<Icon>` 外壳 ⇒ 同一个 `viewBox` ✓）。
// ⚠️ ① ② ③ 都是**源码级**判据 ✓（⭐ 如实标 ✗ —— ⭐ 它们量的是源码里那两个字面 ✓，⛔ 不是渲染 ✓）；
//   ⭐ **改前红** ✓（⭐ `✉` 字形在 ✓、⭐ 没有 `<MailIcon` ✓、⭐ `MailIcon` 还没定义 ✓）；⭐ ④ 是锁 ✓。
describe("2026-10-14：左栏「邮箱」换成 SVG（与其余图标同一套写法）", () => {
  const src = (p: string) => readFileSync(resolve(__dirname, p), "utf8");

  it("① ⭐（源码级）`ActivityBar.tsx` 里**不再**出现 `✉` 那个文字字形（今天【红】✓）", () => {
    // ⚠️ ⭐ **先剥注释** ✗ —— ⭐ 我自己的说明里就写着那个字形 ✓ ⇒ ⛔ 不剥会**假红** ✗（实测踩到 ✓）。
    const bar = src("ActivityBar.tsx")
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(bar, "⛔ 不许再用文字字形 ✗（owner：按钮用 svg ✓）").not.toContain("✉");
  });

  it("② ⭐（源码级）那颗邮箱**用的是新 SVG 组件** `MailIcon`（今天【红】✓）", () => {
    const bar = src("ActivityBar.tsx");
    // ⚠️ **2026-10-14**：⭐ 这句原来把**尺寸字面**也钉进去了 ✗ —— ⭐ 而尺寸刚被对齐过 ✓
    //   ⇒ ⭐ 按 R192「换对象不删断言」：⭐ 只钉**用的是 `MailIcon` 这个组件** ✓，⛔ 不再钉具体像素 ✗。
    expect(bar, "⭐ 必须用的是 `MailIcon` 这个 SVG 组件 ✓").toContain("<MailIcon width={");
    expect(bar, "⭐ `MailIcon` 也要在 import 名单里 ✓").toContain("  MailIcon,");
  });

  it("③ ⭐（源码级）新图标与既有那套**同风格**（同一处定义 ＋ 同一个 `<Icon>` 外壳 ⇒ 同一 `viewBox`）（今天【红】✓）", () => {
    const icons = src("icons.tsx");
    expect(icons, "⭐ 必须定义在同一处 ✓（`src/components/icons.tsx` ✓ —— 这才是统一样式 ✓）").toContain(
      "export function MailIcon(props: IconProps)",
    );
    const at = icons.indexOf("export function MailIcon(props: IconProps)");
    const body = icons.slice(at, at + 400);
    expect(body, "⭐ 必须走同一个 `Icon` 外壳 ✓（⭐ viewBox／描边口径／props 由它统一 ✓）").toContain("<Icon {...props}>");
    expect(icons, "⭐ 那个外壳的 viewBox 就是 24×24 ✓（⭐ 与隔壁那颗同一个 ✓）").toContain('viewBox="0 0 24 24"');
  });

  it("④ 锁（今天已绿 ✓）：⛔ 没引新依赖 ✗（自绘 ✓）＋ ⭐ 那颗的其余属性逐字未变 ✓", () => {
    const icons = src("icons.tsx");
    expect(icons, "⛔ 图标必须是**自绘**的 ✗（⛔ 不许从库引 ✗ —— 与既有 10 颗同源 ✓）").not.toContain("lucide");
    const bar = src("ActivityBar.tsx");
    expect(bar, "⭐ `rail-mail` 的 testid 未变 ✓").toContain('data-testid="rail-mail"');
    expect(bar, "⭐ 标题／无障碍名逐字未变 ✓").toContain('title="邮箱"');
    expect(bar, "⭐ 动作仍是走 store ✓（⛔ 不改计数逻辑 ✗）").toContain("useEmailPanel.getState().openPanel()");
  });
});

// ⭐ **2026-10-14（owner 逐字：「去掉侧边工具栏里面的按钮汉字」）** ✗ ——
//   ⭐ 去掉的是 ⭐ 那两颗里的**文字 span** ✓（`<span>同步</span>` ／ `<span>邮箱</span>` ✓），
//   ⛔ **不动** `title`／`aria-label` ✗（⭐ 它们是**悬停提示 ＋ 无障碍名字** ✓ —— 去了汉字 != 去了名字 ✓）。
// ⚠️ ① ② ④ 都是**源码级**判据 ✓（⭐ 如实标 ✗：量的是源码里那两个字面 ✓，⛔ 不声称渲染 ✓）；
//   ⭐ **改前红** ✓；③ 是锁（⭐ 今天已绿 ✓）。
describe("2026-10-14：左栏按钮去掉汉字（只留图标）", () => {
  const read = (p: string) => readFileSync(resolve(__dirname, p), "utf8");

  it("① ⭐（源码级）那颗「同步」里**不再有** `<span>同步</span>`（今天【红】✓）", () => {
    const bar = read("ActivityBar.tsx");
    expect(bar, "⛔ 那一格汉字 span 必须去掉 ✗（⛔ 也别改成 title 之外的东西 ✗）").not.toContain("<span>同步</span>");
  });

  it("② ⭐（源码级）那颗「邮箱」里**不再有** `<span>邮箱</span>`（今天【红】✓）", () => {
    const bar = read("ActivityBar.tsx");
    expect(bar, "⛔ 那一格汉字 span 必须去掉 ✗").not.toContain("<span>邮箱</span>");
  });

  it("③ 锁（今天已绿 ✓）：`title`／`aria-label` 仍在 ＋ 两颗 testid 仍在 ＋ 徽标那几行仍在", () => {
    const bar = read("ActivityBar.tsx");
    for (const needle of ['title="同步"', 'aria-label="同步"', 'title="邮箱"', 'aria-label="邮箱"']) {
      expect(bar, "⛔ " + needle + " 不许被删 ✗（⭐ 去了汉字 != 去了无障碍名字 ✓）").toContain(needle);
    }
    expect(bar, "⭐ `rail-sync` 仍在 ✓").toContain('data-testid="rail-sync"');
    expect(bar, "⭐ `rail-mail` 仍在 ✓").toContain('data-testid="rail-mail"');
    expect(bar, "⭐ 徽标仍在 ✓").toContain('className="sync-badge"');
    expect(bar, "⭐ 那个 `99+` 封顶口径也在 ✓").toContain('99+');
  });

  it("④ ⭐（源码级）整个 `ActivityBar.tsx` 里**按钮内的汉字 span 为零**（今天【红】✓）", () => {
    // ⚠️ ⭐ **先剥注释** ✗（⭐ 说明里写满了汉字 ✓ —— ⛔ 不剥会**假红** ✓，⭐ 今晚踩过同形的坑 ✓）
    const code = read("ActivityBar.tsx")
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const hits = code.match(/>[\u4e00-\u9fa5]+</g) ?? [];
    expect(hits, "⛔ 按钮里的汉字标签应为 0 ✗（实测 " + JSON.stringify(hits) + "）").toEqual([]);
  });
});
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

describe("2026-10-14 事故：左栏「邮箱」点了没反应（组件在、却没人挂载）", () => {
  const src = (p: string) => readFileSync(resolve(__dirname, p), "utf8");

  it("① ⭐ 宿主 `ActivityBar.tsx` 必须**真的渲染** `<EmailPanel`（今天【红】✓）", () => {
    // 现场（owner 报障）：组件在 ✓、store 在 ✓、按钮也在 ✓（点了 `openPanel()` 确实把 open 置真 ✓），
    // ⛔ 但**全仓没有任何地方挂载** ✗ ⇒ 点了屏幕上什么都没发生 ✓，
    // ⚠️ 而且**一次异常都没有** ✓ —— 正是本仓最怕那类：不炸、不报错、测试全绿 ✗。
    const bar = src("ActivityBar.tsx");
    expect(bar, "⛔ 邮箱面板必须真的被渲染 ✗（只有 store、没有挂载 ＝ 点了没反应 ✓）").toContain("<EmailPanel");
    expect(bar, '⛔ 组件也必须真的 import 进来 ✗').toContain('from "./EmailPanel"');
  });

  it("② ⭐ 而且必须**开着才挂**（那个组件关着**不会**自己隐藏 ✗）", () => {
    const bar = src("ActivityBar.tsx");
    // 实测：`EmailPanel` 根节点没有「`!open` ⇒ 不渲染」那一层 ✓（`!open` 只出现在 effect 里 ✓）
    // ⇒ ⛔ 无条件挂会**一直显示** ✗ ⇒ ⭐ 宿主这一行必须带 `mailOpen` ✓。
    expect(bar, "⭐ 挂载那一行要带 mailOpen ✓（⛔ 不许无条件挂 ✗）").toMatch(/\{[^\n]*mailOpen[^\n]*<EmailPanel/);
    expect(bar, "⭐ 那个开关要从 store 取（单一来源 ✓）").toContain("useEmailPanel((s) => s.open)");
  });
});
