// 设置-空间面板 · 「点一行就切换空间」的判据 —— owner 2026-10-10 亲口要求：
// 「设置-空间面板要可以切换空间，效果等同于在侧边栏的空间切换。」
//
// 为什么值得判据：这一屏原先**只能配色/删除**，切换被那句文案明确排除在外 ✗
//（`:282` 逐字「切换空间在侧栏顶部——这里只做低频管理」）⇒ 现在要把它打开，
// 而"打开"最容易出的两个事故正是下面两条**反向**判据钉的：
//   ① 「配色／删除」的点击**冒泡成切换** ✗（删一个空间不能顺手把当前空间切了）；
//   ② 点了**要删的那一行** ⇒ **先切过去再删** ✗（那是灾难）。
//
// ⚠️ 判据钉的是"**走的是同一条路**"：设置面板必须调 `useSpaceStore.switchTo`（侧栏那一条 ✓），
//    ⛔ 不许自己写一遍 `api.setActiveWorkspaceId` ＋ 刷新 ✗（那就会出现两条路 ✓）。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 判据 c) 要读**真的** CSS 规则（⛔ 不是凭印象说"卡片不会塌"✗）。 */
const APP_CSS = resolve(dirname(fileURLToPath(import.meta.url)), "../App.css");

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(async () => true),
  removeSpace: vi.fn(async () => true),
}));

// 这一屏用到的那几条：api 一律给"空数组"够它安静渲染；删除走桩（⛔ 不碰真文件系统）。
vi.mock("../lib/api", () => ({
  api: new Proxy({}, { get: () => async () => [] }),
}));
vi.mock("../lib/platform", () => ({ isDesktopPlatform: () => true, emailSupported: () => false }));
vi.mock("../store/confirm", () => ({ confirmDialog: mocks.confirm }));
vi.mock("../lib/spaceTransfer", () => ({
  exportCurrentSpace: vi.fn(async () => undefined),
  importSpacePackage: vi.fn(async () => true),
  removeSpace: mocks.removeSpace,
}));

import "../i18n";
import { useEditorStore } from "../store/editor";
import { useSpaceStore } from "../store/space";
import { SettingsDialog } from "./SettingsDialog";

let host: HTMLDivElement;
let root: Root;
/** 切换动作的桩：**真的改 store 的 activeId**（＝真 `switchTo` 的行为）。
 *  ⚠️ 只有真改它，"当前"标跟着走那条判据才测得到东西（否则是空转 ✗）。 */
let switchTo: ReturnType<typeof vi.fn<(id: string) => Promise<boolean>>>;

const card = (name: string): HTMLElement => {
  const hit = [...document.querySelectorAll<HTMLElement>(".set-space-card")].find((c) =>
    (c.textContent ?? "").includes(name),
  );
  if (!hit) throw new Error(`找不到空间卡片：${name}`);
  return hit;
};
const button = (scope: HTMLElement, text: string): HTMLButtonElement => {
  const hit = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => (b.textContent ?? "").trim() === text,
  );
  if (!hit) throw new Error(`卡片里找不到按钮：${text}`);
  return hit;
};
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};
/** 点"那一行"：打在**名字那一片**上（冒泡到行的处理器）——
 *  ⛔ 不直接打容器 ✗：那样不管处理器挂在哪一层都过，测不出"整行可点"。 */
const clickRow = (name: string) => click(card(name).querySelector<HTMLElement>(".set-row-name")!);

async function render() {
  await act(async () => {
    root.render(createElement(SettingsDialog));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  mocks.confirm.mockClear();
  mocks.removeSpace.mockClear();
  switchTo = vi.fn(async (id: string) => {
    useSpaceStore.setState({ activeId: id });
    return true;
  });
  useSpaceStore.setState({
    spaces: [
      { id: "s1", name: "工作", created_at: 1, updated_at: 1, kind: "personal" },
      { id: "s2", name: "生活", created_at: 2, updated_at: 2, kind: "team" },
    ],
    activeId: "s1",
    switchTo: switchTo as unknown as (id: string) => Promise<boolean>,
  });
  useEditorStore.setState({ settingsOpen: true, settingsTab: "spaces" });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  useEditorStore.setState({ settingsOpen: false });
});

describe("设置-空间 · 点一行就切换", () => {
  it("a) 点「生活」那一行 ⇒ 切换动作**恰好被调一次**（走的是 store 同一条路）", async () => {
    await render();
    expect(switchTo, "还没点就切了？").not.toHaveBeenCalled();

    await clickRow("生活");

    expect(switchTo, "点了一行却没有切换 ⇒ 这一屏还是只能配色/删除").toHaveBeenCalledTimes(1);
    expect(switchTo).toHaveBeenCalledWith("s2");
  });

  it("b) **反向**：点「配色」⇒ ⛔ 不许触发切换", async () => {
    await render();
    await click(button(card("生活"), "配色"));
    expect(switchTo, "点配色把空间切走了").not.toHaveBeenCalled();
  });

  it("c) **反向**：点「删除」⇒ ⛔ 不许**先切过去再删**", async () => {
    await render();
    await click(button(card("生活"), "删除"));
    // 删除那条路照常问过确认（这里桩成"确认"）⇒ 说明点到的确实是删除，而不是行
    expect(mocks.confirm, "删除没走确认（判据没打到删除那条路）").toHaveBeenCalled();
    expect(switchTo, "点删除却先把空间切过去了 —— 那是灾难").not.toHaveBeenCalled();
  });

  it("d) 切完「当前」标跟着走 ＋ 重开面板仍是新的那个（回归闸）", async () => {
    await render();
    expect(card("工作").textContent, "起初「当前」应当在「工作」上").toContain("当前");

    await clickRow("生活");
    expect(card("生活").textContent, "切完「当前」没跟着走").toContain("当前");
    expect(card("工作").textContent, "切完旧的那张还挂着「当前」").not.toContain("当前");

    // 重开面板（unmount + remount）⇒ 「当前」从 store 读出来，仍是「生活」✓
    act(() => root.unmount());
    root = createRoot(host);
    await render();
    expect(card("生活").textContent, "重开面板后「当前」指的是旧的").toContain("当前");
  });

  it("③ 那句「切换空间在侧栏顶部——这里只做低频管理」必须改掉（⛔ 不许留一句与事实不符的话）", async () => {
    await render();
    const copy = document.body.textContent ?? "";
    expect(copy, "那句旧文案还在（它现在不成立了）").not.toContain("切换空间在侧栏顶部");
    expect(copy, "没把新的说法写出来：点一行就能切").toContain("点一行就能切过去");
    // 软删除那句说明照旧留着 ✓（别为了改这句把它删掉）
    expect(copy).toContain("软删除");
  });
});

// ── 空间 20+ 时的**筛选**（owner 2026-10-10：「如何用户的空间很多，比如 20+，怎么办？」）──
// ⚠️ 这里钉的是**这一屏真的用上了**那份共用匹配（规则本身在 `src/lib/spaceFilter.test.ts` ✓，
//    含 25 项夹具「恰好 3 个」那条 ✓）——⛔ 两处都只测纯函数 ＝ 谁都没验"接上了没有" ✗。
describe("设置-空间 · 筛选", () => {
  const cards = () => [...document.querySelectorAll<HTMLElement>(".set-space-card")];
  const filter = () => document.querySelector<HTMLInputElement>(".set-space-filter")!;

  /** 往**受控输入框**里打字（React 的 value setter ＋ `input` 事件 ✓）。 */
  const type = async (el: HTMLInputElement, v: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  it("a) 输入一段字 ⇒ 列表**真的变短**（只列匹配的）", async () => {
    await render();
    expect(cards(), "起初两个空间都要在").toHaveLength(2);
    expect(filter(), "这一屏没有筛选框").not.toBeNull();

    await type(filter(), "生活");

    expect(cards(), "输入了却没有变短 ⇒ 筛选没接上").toHaveLength(1);
    expect(cards()[0].textContent).toContain("生活");
  });

  it("b) **反向**：清空筛选 ⇒ 全部**一个不少**地回来", async () => {
    await render();
    await type(filter(), "生活");
    expect(cards()).toHaveLength(1);

    await type(filter(), ""); // 把筛选词清掉（最直接的那条路）

    expect(cards(), "清空之后应当两个都回来（⛔ 不许把不匹配的丢掉）").toHaveLength(2);
    expect(cards().map((c) => c.textContent).join(" ")).toContain("工作");
  });

  it("⑤ 零命中 ⇒ **说人话 ＋ 给「清空筛选」的出路**（⛔ 不许只剩一个空列表）", async () => {
    await render();
    await type(filter(), "zzz");
    expect(cards(), "零命中却还有卡片").toHaveLength(0);
    expect(document.body.textContent, "零命中没说人话 —— 用户会以为空间没了").toContain("没有匹配的空间");
    expect(document.body.textContent, "零命中没有出路").toContain("清空筛选");

    // ⭐ 那条"出路"**真的能用**（不是一句摆设）：点了 ⇒ 全部回来 ✓
    await click(button(document.body, "清空筛选"));
    expect(cards(), "点了「清空筛选」却没回来").toHaveLength(2);
  });

  it("c) **反向**：筛选**不许**改变「当前空间」（输字不能顺手切空间）", async () => {
    await render();
    await type(filter(), "生活");
    expect(switchTo, "筛选把空间切走了").not.toHaveBeenCalled();
    expect(useSpaceStore.getState().activeId, "筛选改了 activeId").toBe("s1");

    // 被筛掉不等于"不再是当前"：清空后「当前」仍应在「工作」上 ✓
    await type(filter(), "");
    expect(card("工作").textContent, "筛选把「当前」标也带走了").toContain("当前");
  });
});

// ── 「加密空间要有特殊标识」（owner 2026-10-10）· 设置这一侧 ──
// ⚠️ 这里钉的是**这一屏真的用上了**那份映射（规则本身在 `src/lib/spaceSecurity.test.ts` ✓，
//    含三态与禁词判据 ✓）——两处都只看纯函数 ＝ 谁都没验"两处都接上了没有" ✗。
describe("设置-空间 · 加密标识", () => {
  /** 一个加密 / 一个明文 / 一个读数拿不到 ✓ */
  const seed = () =>
    useSpaceStore.setState({
      spaces: [
        { id: "s1", name: "加密的", created_at: 1, updated_at: 1, kind: "personal", encrypted_on_disk: true },
        { id: "s2", name: "明文的", created_at: 2, updated_at: 2, kind: "personal", encrypted_on_disk: false },
        { id: "s3", name: "读不到的", created_at: 3, updated_at: 3, kind: "personal" },
      ],
      activeId: "s1",
    });

  it("a) 加密那个有标识、明文那个没有、**读不到的那个也没有**（⛔ 不许当成明文）", async () => {
    seed();
    await render();

    expect(card("加密的").textContent, "加密空间没标识 ⇒ owner 那条要求没落地").toContain("已加密");
    expect(card("明文的").textContent, "明文也带标识 ⇒ 标识没信息量").not.toContain("已加密");
    expect(card("读不到的").textContent, "读不到却当了明文/显示了标识").not.toContain("已加密");
  });

  it("⛔ 不许只靠颜色：标识是**文字**，且带可读的悬停/读屏说明", async () => {
    seed();
    await render();

    const badge = card("加密的").querySelector<HTMLElement>(".set-space-crypto");
    expect(badge, "标识元素不在（可能只加了个颜色）").not.toBeNull();
    expect((badge!.textContent ?? "").trim(), "标识里没有文字 ⇒ 色弱用户看不到").toMatch(/\S/);
    expect(badge!.getAttribute("aria-label"), "读屏拿不到说明").toMatch(/\S/);
    expect(badge!.getAttribute("title")).toContain("磁盘");
  });

  it("④ 回归：「仅本机／已同步」那一格照旧在（标识是**另加**的，⛔ 不是顶掉它）", async () => {
    seed();
    await render();
    expect(card("加密的").textContent, "同步状态那一格被标识顶掉了").toContain("仅本机");
  });
});

// ⭐ 2026-10-10（owner **第二次**提：「去掉这两个图标」）：
//   「单空间迁移」两张卡片顶上原本各有一个方块图标（↑ ／ ↓）✗ ⇒ owner 要只留 **标题 ＋ 说明 ＋ 按钮** ✓。
//   ⚠️ 上一次提过、**没落** ✗ ⇒ 所以判据里要有两条**反向**（挡"顺手把整块删了"✗）＋ 一条"卡片别塌" ✓：
//     · a) 结构级：图标节点不在了 ✓
//     · b) 反向：标题 ＋ 说明 ＋ 两个按钮**都还在** ✓
//     · c) 卡片**不会塌**：那两条规则里**没有**写死高度 ✓（内容撑高 ⇒ 少一个 28px 图标只是矮一截 ✓）
//   ⚠️ ⭐ **c) 的"真高度"不在这个文件里量** ✗ —— happy-dom **没有布局引擎** ✗，
//      所以真高度由 `_tmp/scratch/migrate-card-height.mjs`（真 Chromium／Edge，走仓库自己的
//      `scripts/lib/launch-chrome.mjs`）量，读数写进提交信息与汇报 ✓（⛔ 不假装这里量过 ✗）。
describe("设置-空间 · 单空间迁移：⛔ 那两个图标不许再回来", () => {
  const migrateCards = () => [...document.querySelectorAll<HTMLElement>(".set-migrate-card")];

  it("⭐ a) 两张卡片里**只有**那三样（标题／说明／按钮）—— ⛔ 没有第四个节点（图标）", async () => {
    await render();

    const cards = migrateCards();
    expect(cards.length, "两张对称卡片还在").toBe(2);
    // ⭐ 判据**不点名图标的类名** ✗（点名了就会"类名一改、这条判据空转"✗），而是钉**子元素的确切形状** ✓：
    //    卡片里**只能**有这三样 ⇒ 任何被塞回来的第四个节点（图标／徽章／箭头…）都会红 ✓。
    //    ⚠️ 所以那条死 CSS（`.set-migrate-icon`）可以**跟着删掉** ✓ —— 全仓不再引用它 ✓。
    const EXPECTED = ["set-migrate-name", "set-migrate-sub", "set-btn"];
    for (const [i, c] of cards.entries()) {
      const got = [...c.children].map((el) => String(el.className).trim());
      expect(got, `第 ${i + 1} 张卡片的子节点形状变了（多/少了东西）`).toEqual(EXPECTED);
      expect(c.textContent ?? "", `第 ${i + 1} 张卡片里还有箭头字符`).not.toMatch(/[↑↓]/);
    }
  });

  it("⭐ b) 反向：标题 ＋ 说明 ＋ 两个按钮**都还在**（⛔ 不许顺手把整块删了）", async () => {
    await render();

    const text = document.body.textContent ?? "";
    expect(text, "左卡标题").toContain("导出当前空间");
    expect(text, "右卡标题").toContain("导入空间包");
    expect(text, "左卡说明那一句").toContain("打包成一个 zip");
    expect(text, "右卡说明那一句").toContain("绝不覆盖现有空间");

    // 两个动作按钮：按**文字**找（⛔ 不按下标 —— 下标一变这条就变成空转 ✓）
    // ⚠️ ⛔ **别用 `.sort()` 去比顺序** ✗：这两条文案**首字相同**（都是「导」）⇒ 默认 `.sort()`
    //    按**码位**比第二个字（入 U+5165 < 出 U+51FA）⇒ 结果与**读的顺序**相反 ✗
    //    （我第一版就这么写，于是这条判据**因为排序**变红、而不是因为产品 ✗ ⇒ 改成与顺序无关 ✓）
    const btns = [...document.querySelectorAll<HTMLButtonElement>(".set-migrate-card .set-btn")].map(
      (b) => (b.textContent ?? "").trim(),
    );
    expect(btns.length, "迁移卡片里恰好两个动作按钮").toBe(2);
    expect(btns, "「导出…」「导入…」两个按钮都要在").toEqual(
      expect.arrayContaining(["导出…", "导入…"]),
    );
  });

  it("⭐ c) 卡片**不会塌**：那两条规则里没有写死高度 ＋ 三样可见内容各自都在", async () => {
    await render();

    const css = readFileSync(APP_CSS, "utf8");
    for (const sel of [".set-migrate-card", ".set-migrate"]) {
      const m = new RegExp(`\\${sel}\\s*\\{([^}]*)\\}`).exec(css);
      expect(m, `${sel} 的规则不见了`).not.toBeNull();
      expect(/\bheight\s*:/.test(m![1]), `${sel} 写死了高度 ⇒ 少一个子节点就可能塌`).toBe(false);
    }

    // 结构级：卡片里那三样可见内容**各自**还在（真高度见文件头那条说明 ⇒ 由 Edge 那次量 ✓）
    for (const [i, c] of migrateCards().entries()) {
      expect(c.querySelector(".set-migrate-name"), `第 ${i + 1} 张：标题`).not.toBeNull();
      expect(c.querySelector(".set-migrate-sub"), `第 ${i + 1} 张：说明`).not.toBeNull();
      expect(c.querySelector(".set-btn"), `第 ${i + 1} 张：按钮`).not.toBeNull();
    }
  });
});
