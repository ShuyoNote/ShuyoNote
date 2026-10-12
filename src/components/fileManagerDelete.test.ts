// 「文件管理里那条「未整理」的 `.docx` 删不掉」的判据 —— 钉 owner 2026-10-12 实测的那个症状 ✗。
//
// ⭐ 一条链、四道闸，哪道断了就红在哪道（这样能直接分清 (甲) 按钮没接上 / (乙) 请求被拒 / (丙) 被前置条件挡住）：
//   ① `×`（`title="移除文件"`，`FileManagerView.tsx:1174-1182`）在不在；
//   ② 点它 ⇒ **确认框**出不出来（`confirmDialog` → `store/confirm.ts` + `ConfirmDialog.tsx`）；
//   ③ 点「确定」⇒ `api.removeAttachment(id)` **有没有被调到、参数对不对**（`:392-410`）；
//   ④ 删完 ⇒ 那一行**真的从列表里没了**（`:404` 的 `setFiles(filter)`）。
//
// 形状抄刚落的 `src/components/folderClickView.test.ts`（真组件 ＋ `flushSync` ＋ 原生事件 ＋
// 断言**状态/调用**而非外观）＋ `aboutDialog.test.ts` 的 `vi.mock("../lib/platform")` 写法。
// ⚠️ 本仓 vitest 只收 `src/**/*.test.ts` / `*.test.tsx`，而本文件路径固定是 `.ts`
// ⇒ 用 `React.createElement`（`.ts` 里不转 JSX，见 `vitest.config.ts:9-11`）。
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

const mocks = vi.hoisted(() => ({
  listPageAttachments: vi.fn<(pageId: string | null) => Promise<unknown[]>>(),
  listAttachmentHashes: vi.fn<() => Promise<string[]>>(),
  removeAttachment: vi.fn<(id: string) => Promise<number>>(),
  removeAttachments: vi.fn<(ids: string[]) => Promise<number>>(),
  deletePage: vi.fn<(id: string) => Promise<void>>(),
  // ⚠️ 必须放进 `vi.hoisted`：`vi.mock` 的工厂会被**提升**到模块顶部，
  //    引用外面那些普通 `let` 会撞 vitest 的"工厂不许引用外部变量"检查 ✗。
  seedPages: [] as PageMeta[],
}));

vi.mock("../lib/api", () => {
  const noop = async () => undefined;
  const real: Record<string, unknown> = {
    listPageAttachments: (...a: unknown[]) => mocks.listPageAttachments(...(a as [string | null])),
    listAttachmentHashes: () => mocks.listAttachmentHashes(),
    removeAttachment: (...a: unknown[]) => mocks.removeAttachment(...(a as [string])),
    removeAttachments: (...a: unknown[]) => mocks.removeAttachments(...(a as [string[]])),
    deletePage: (...a: unknown[]) => mocks.deletePage(...(a as [string])),
    // ⚠️ `listPages` **必须**回真种子：第一版没给 ⇒ 落到 `list* ⇒ []` 的兜底 ⇒
    //    `loadPages()` 把 `pages` 清空 ⇒ 侧栏里连文件夹行都没有 ⇒ 那一格红得没有意义 ✗（实测踩到 ✓）。
    listPages: async () => mocks.seedPages,
    downloadAttachment: noop,
    importAttachmentFiles: async () => [],
    moveAttachment: noop,
    getPage: async () => null,
    readAttachmentBytes: async () => new ArrayBuffer(0),
    copyAttachment: noop,
    restoreAttachment: noop,
    renameAttachment: noop,
    savePage: noop,
  };
  // ⚠️ ⛔ 别用 Proxy 包**模块对象**（`return new Proxy({...}, …)`）—— vitest 会给 mock 结果
  //    再套一层代理 ⇒ 报 `Cannot create proxy with a non-object as target or handler`（实测踩到 ✓）。
  //    ✅ 把 Proxy 只放在 `api` **这个值**上就没问题 ✓ ⇒ 没列到的命令一律回空，
  //    这样挂 `PageTree`（它要问空间/页/附件好几条）也不会因为"mock 里少一条"而炸 ✓。
  //    ⚠️ 回什么**必须按形状给**：`list*` 一律回 **数组** —— 第一版统一回 `{}` ✗，
  //    于是 `useNotes.pages` 被写成 `{}` ⇒ `TypeError: pages.filter is not a function` ✗
  //    ⇒ 侧栏整棵渲染不出来 ⇒ 那一格**红得没有意义**（实测踩到 ✓）。
  const api = new Proxy(real, {
    get: (t, k) => {
      if (k in t) return (t as Record<string, unknown>)[k as string];
      const name = String(k);
      if (/^list/.test(name)) return async () => [];
      // ⛔ 别回 `{}` ✗ —— 实测踩到两次：① `useNotes.pages` 被写成 `{}` ⇒ `pages.filter is not a function` ✗；
      //    ② 某条"取名字"的命令回 `{}` ⇒ React 报 `Objects are not valid as a React child` ⇒ 整棵树白屏 ✗。
      //    ⇒ 未桩的命令一律 **reject**（与"后端不可用"同形 ✓）：仓库里那些 `.catch(() => {})` / `try/catch`
      //    会如实接住并留日志 ✓（`folderClickView.test.ts` 当初拿真 api 挂 PageTree 就是这个形状 ✓）。
      return async () => {
        throw new Error(`[判据] 本用例没有桩这条命令：${name}`);
      };
    },
  });
  return { api };
});

// ⚠️ i18n 与平台都打桩：断言的是"删除这条链"，不是词条/真后端。
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

vi.mock("../lib/platform", () => ({
  platform: {
    event: { listen: async () => () => {} },
    webview: { onDragDropEvent: () => Promise.resolve(() => {}) },
    dialog: { open: async () => null, save: async () => null },
    opener: { openPath: async () => {}, revealItemInDir: async () => {}, openUrl: async () => {} },
  },
  isDesktopPlatform: () => true,
  isMobileUserAgent: () => false,
  isWebPlatform: () => false,
  emailSupported: () => false,
}));

import { FileManagerView } from "./FileManagerView";
import { ConfirmDialog } from "./ConfirmDialog";
import { AttachmentPanel } from "./AttachmentPanel";
import { PageTree } from "./PageTree";
import { useNotes } from "../store/notes";
import { useFileManagerStore } from "../store/fileManager";
import { useToast } from "../store/toast";
import type { AttachmentMeta, PageMeta } from "../types";

/** owner 截图里那一条（`.docx`，空间根下没归属页面 ⇒ 界面标「未整理」）。 */
const DOCX: AttachmentMeta = {
  id: "att-docx",
  name: "百度：ShuyoNote深度分析研究报告.docx",
  hash: "hash-docx",
  mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  size: 52_000,
  path: "/tmp/sample.docx",
  created_at: 1_700_000_000_000,
  mtime: 1_700_000_000_000,
};

const meta = (id: string, kind: string, title: string, sort: number): PageMeta => ({
  id,
  workspace_id: "ws-1",
  parent_id: null,
  title,
  icon: "",
  kind,
  sort_order: sort,
  created_at: 1_700_000_000 + sort,
  updated_at: 1_700_000_000 + sort,
  deleted_at: null,
});

let host: HTMLDivElement | null = null;
let root: Root | null = null;

/** 卸干净（`afterEach` 与"同一个用例里要重挂"的循环都用它 ✓）。 */
function teardown() {
  if (root) flushSync(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  useFileManagerStore.setState({ folderId: null });
  useToast.setState({ toasts: [] });
}

afterEach(teardown);

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() {
  await tick();
  await tick();
  flushSync(() => {});
}

/**
 * 假后端（**有状态**的）：`listPageAttachments` 列的是"库里现在真有什么"，
 * `removeAttachment` 按 `deletes` 决定**真删**还是走那条"查不到 id 也照样成功"的静默路，
 * 并且**照 owner 2026-10-12 拍的口径如实返回"删掉了几条"**（幂等 ⇒ 查不到就 `0`、不报错 ✓）。
 *
 * ⚠️ 这里第一版是"永远返回 `[DOCX]`、删了也不变" ✗ —— 那是个**会忽略删除的后端**：
 *    它让"补 `loadFiles()`（以重列结果为准）"那条修法**看起来是错的** ✗（实测：修完第一条判据当场红 ✓）。
 *    判据的假后端必须**忠实**，否则红的绿的都是假的 ✓。
 */
let backendRows: AttachmentMeta[] = [];

/** 把假后端装好（三个挂载 helper 共用 ✓）：`deletes:false` = owner 那条**幂等路**（如实回 0 ✓）。 */
function setupBackend(deletes: boolean) {
  // ⚠️ 每个用例都要清一次调用史：不清的话"小按钮 / 右键 / 批量"三条会互相看见对方的调用
  //    （实测踩到：右键那条被判成"调了两次" ✗ —— 那是判据自己的错，不是产品的错）。
  mocks.listPageAttachments.mockReset();
  mocks.listAttachmentHashes.mockReset();
  mocks.removeAttachment.mockReset();
  mocks.removeAttachments.mockReset();
  mocks.deletePage.mockReset();
  backendRows = [DOCX];
  mocks.listPageAttachments.mockImplementation(async () => backendRows);
  mocks.listAttachmentHashes.mockResolvedValue([DOCX.hash]);
  mocks.removeAttachment.mockImplementation(async (id: string) => {
    // `deletes: true` ⇒ 真后端（那一行从库里没了 ⇒ 重列时不再出现 ✓，返回 **1** ✓）；
    // `deletes: false` ⇒ owner 拍的那条**幂等**路：**什么都不删、返回 0**（⛔ **不报错** ✓）。
    const hit = backendRows.some((f) => f.id === id);
    if (deletes && hit) {
      backendRows = backendRows.filter((f) => f.id !== id);
      return 1;
    }
    return 0;
  });
  mocks.removeAttachments.mockImplementation(async (ids: string[]) => {
    // ⭐ 与后端同口径：**只在真删到时 +1**（`attachments.rs:1050-1054` 原来按 id 计 ✗）；
    //    `deletes: false` ⇒ 幂等路：一条也不删、如实返回 **0** ✓。
    const hit = backendRows.filter((f) => ids.includes(f.id));
    if (!deletes) return 0;
    backendRows = backendRows.filter((f) => !ids.includes(f.id));
    return hit.length;
  });
}

/** 挂一个 React 树到全新的宿主上（三个 helper 共用 ✓）；**把宿主返回**，调用方就不必跟 `| null` 纠缠 ✓
 *  （⚠️ 第一版让它写模块级的 `host` 再让 helper `return host` ⇒ TS 收窄不了 ⇒ 12 条 `possibly null` ✗）。 */
function mount(element: React.ReactElement): HTMLDivElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  host = el;
  root = createRoot(el);
  flushSync(() => root?.render(element));
  return el;
}

async function mountFileManager(opts: { deletes?: boolean } = {}) {
  setupBackend(opts.deletes ?? true);
  useFileManagerStore.setState({ folderId: null });
  const pages = [
    meta("f1", "folder", "设计方案", 0),
    meta("f2", "folder", "效果图", 1),
    meta("f3", "folder", "研究报告", 2),
  ];
  mocks.seedPages = pages;
  useNotes.setState({ pages, loading: false, currentId: null });
  const el = mount(
    React.createElement(React.Fragment, null, React.createElement(FileManagerView), React.createElement(ConfirmDialog)),
  );
  await settle();
  return el;
}

/**
 * 挂「页面附件面板」（`AttachmentPanel.tsx`）—— 它自己就是一个删除入口 ✓
 * （`removeFile` `:129-137` 直接调同一条命令 ✓，**没有确认框** ✓）。
 */
async function mountAttachmentPanel(opts: { deletes?: boolean } = {}) {
  setupBackend(opts.deletes ?? true);
  const el = mount(React.createElement(AttachmentPanel, { pageId: "p1" }));
  await settle();
  return el;
}

/** 挂侧栏（`PageTree.tsx`）：它那条"文件行 → 右键 → 删除"（`:281-297` / `:451-461`）也调同一条命令 ✓。 */
async function mountPageTree(opts: { deletes?: boolean } = {}) {
  setupBackend(opts.deletes ?? true);
  useFileManagerStore.setState({ folderId: null });
  const pages = [meta("f1", "folder", "设计方案", 0), meta("p1", "page", "一页笔记", 1)];
  mocks.seedPages = pages;
  useNotes.setState({ pages, loading: false, currentId: null });
  const el = mount(
    React.createElement(React.Fragment, null, React.createElement(PageTree), React.createElement(ConfirmDialog)),
  );
  await settle();
  // ⚠️ 侧栏那些文件行挂在**展开的文件夹**下面（`PageTree.tsx:853` 的
  //    `{isFolder && expanded && <TreeFiles folderId={node.id} />}` ✓）。
  //    ⚠️ 但文件夹**默认就是展开的**（`TreeItem` 的 `useState(true)`，`:491` ✓）⇒
  //    ⛔ 别"一律点一下展开箭头" ✗ —— 那会把它**收起来** ⇒ 文件行反而没了
  //    （实测踩到：那一格因此红得没有意义 ✗）。⇒ 只在"现在没有文件行"时才点 ✓。
  if (!el.querySelector(".tree-file-row")) {
    const toggle = el.querySelector<HTMLElement>('[data-node-id="f1"] .tree-toggle');
    if (!toggle) throw new Error("侧栏里没找到文件夹行的展开箭头");
    flushSync(() => toggle.click());
    await settle();
  }
  return el;
}

/** 那条 `.docx` 所在的 `<tr>`（按 `.fm-name` 的文本找，别靠行序）。 */
function fileRow(el: HTMLElement): HTMLElement {
  const name = Array.from(el.querySelectorAll<HTMLElement>(".fm-name")).find((n) => n.textContent === DOCX.name);
  const tr = name?.closest("tr");
  if (!tr) throw new Error("列表里没找到那条 .docx 的行");
  return tr as HTMLElement;
}

describe("文件管理：删掉那条「未整理」的文件", () => {
  it("⭐ 点 × → 确认 → 真的调 removeAttachment 且那一行消失", async () => {    const el = await mountFileManager();

    // 前提：那一行真的渲染出来了（否则下面红得没有意义）。
    const names = Array.from(el.querySelectorAll(".fm-name")).map((n) => n.textContent ?? "");
    expect(names, "前提：列表里应当有 owner 截图里那条 .docx").toContain(DOCX.name);

    const delBtn = el.querySelector<HTMLButtonElement>('button[title="移除文件"]');
    expect(delBtn, "① `×`（title=移除文件，`FileManagerView.tsx:1174`）应当在操作列里").not.toBeNull();

    flushSync(() => delBtn!.click());
    await settle();

    const okBtn = document.querySelector<HTMLButtonElement>(".confirm-ok");
    expect(
      okBtn,
      "② 点 × 之后**确认框**应当出现（`FileManagerView.tsx:393-401` → `store/confirm.ts` → `ConfirmDialog.tsx:30-35`）",
    ).not.toBeNull();

    flushSync(() => okBtn!.click());
    await settle();

    expect(
      mocks.removeAttachment.mock.calls.map((c) => c[0]),
      "③ 点「确定」之后应当**恰好**用这条附件的 id 调一次 `api.removeAttachment`（`FileManagerView.tsx:403`）",
    ).toEqual([DOCX.id]);
    expect(
      Array.from(el.querySelectorAll(".fm-name")).map((n) => n.textContent ?? ""),
      "④ 删完那一行应当从列表里消失（`FileManagerView.tsx:404` 的 setFiles(filter)）",
    ).not.toContain(DOCX.name);
  });

  // ⛔⛔ 下面两条**故意红**：它们测的是 owner 在桌面上**唯一可能用到的**两个入口 ——
  //      `App.css:15406-15410` 与 `:15385-15392` 把桌面那条文件行的**六个小按钮**
  //      （含 `×`）和 `⋯` 都 `display: none` 了（注释逐字写着"桌面的文件行操作**只走两条**：
  //      行上右键 ＋ 双击文件名改名"）。而这两条**功能上都是通的**（见读数为绿 ✓）——
  //      ⇒ 症状的真正形状是「**看得见的入口被 CSS 藏了，剩下的入口藏在一个手势里**」✗。
  it("⭐ 右键 → 删除 这条路是通的（说明不是「请求被拒」）", async () => {
    const el = await mountFileManager();
    const row = fileRow(el);

    flushSync(() => row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 2, clientX: 120, clientY: 120 })));
    await settle();

    const del = Array.from(document.querySelectorAll<HTMLButtonElement>(".fm-ctx-item")).find((b) =>
      (b.textContent ?? "").includes("删除"),
    );
    expect(del, "右键菜单里应当有「删除」项（`FileManagerView.tsx:1270`）").toBeTruthy();

    flushSync(() => del!.click());
    await settle();
    const ok = document.querySelector<HTMLButtonElement>(".confirm-ok");
    expect(ok, "点「删除」应当弹确认框（`FileManagerView.tsx:725`）").not.toBeNull();

    flushSync(() => ok!.click());
    await settle();
    expect(
      mocks.removeAttachment.mock.calls.map((c) => c[0]),
      "确认后应当调 `removeAttachment(row.file.id)`（`FileManagerView.tsx:728`）",
    ).toEqual([DOCX.id]);
  });

  it("⭐ 勾选 → 顶部「删除选中」这条路也是通的", async () => {
    const el = await mountFileManager();
    const cb = fileRow(el).querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(cb, "行首应当有勾选框（`FileManagerView.tsx:1039-1044`）").not.toBeNull();

    flushSync(() => cb!.click());
    await settle();

    const btn = document.querySelector<HTMLButtonElement>('button[aria-label="删除选中"]');
    expect(btn, "顶部应当有「删除选中」（`FileManagerView.tsx:780-791`）").not.toBeNull();
    expect(btn!.disabled, "勾上之后它应当可点（`:783` disabled={selectedCount === 0}）").toBe(false);

    flushSync(() => btn!.click());
    await settle();
    const ok = document.querySelector<HTMLButtonElement>(".confirm-ok");
    expect(ok, "点它应当弹确认框（`:609-615`）").not.toBeNull();

    flushSync(() => ok!.click());
    await settle();
    expect(
      mocks.removeAttachments.mock.calls[0]?.[0],
      "确认后应当调 `removeAttachments([...])` 且**含这条附件的 id**（`:624`）",
    ).toEqual([DOCX.id]);
  });

  // ⭐⭐ 判据本体：**"删掉了"这件事必须以"重列之后它真没了"为准** ✗ ——
  //   `removeFile`（`:392-410`）原先拿到 `removeAttachment` 的成功返回后**只改本地列表**
  //   （`setFiles(filter)`），然后 `toast("已移除文件", "success")` ⇒ 一旦后端**什么都没删**
  //   （两个后端在"按 id 查不到行"时都**静默返回成功**：`src-tauri/src/attachments.rs:1006-1008`
  //    的 `let Some(hash) = hash else { return Ok(()) }`、`src/lib/platform/web.ts:2597` 的 `if (row)`），
  //   界面就会**谎报成功**：那一行当场消失、重进文件管理又回来 ⇒ 用户说的「**删不掉**」✓。
  //   ⚠️ 右键那条（`:732-734`）本来就有 `loadFiles()`，两条路的"以谁为准"不一致，正是这条判据要钉的 ✓。
  it("⭐ 后端其实没删掉时，界面不许把那一行抹掉还报「已移除文件」", async () => {
    // `deletes: false` ⇒ 假后端走**静默路**：`removeAttachment` **返回成功**、但那一行**还在**
    //（`listPageAttachments` 依旧把它列出来 —— 这就是"重进列表又回来" ✓）。
    const el = await mountFileManager({ deletes: false });

    const delBtn = el.querySelector<HTMLButtonElement>('button[title="移除文件"]');
    expect(delBtn, "前提：`×` 应当在（`FileManagerView.tsx:1174`）").not.toBeNull();
    flushSync(() => delBtn!.click());
    await settle();
    const okBtn = document.querySelector<HTMLButtonElement>(".confirm-ok");
    expect(okBtn, "前提：确认框应当出现").not.toBeNull();
    flushSync(() => okBtn!.click());
    await settle();

    expect(
      Array.from(el.querySelectorAll(".fm-name")).map((n) => n.textContent ?? ""),
      "后端那一行还在 ⇒ 界面必须**如实**还显示它（`removeFile` 里那句 `loadFiles()`，" +
        "与右键那条 `:734` 同一口径）—— 抹掉它 = 用户看到「删了」、重进又回来 ⇒ 就是那句「**删不掉**」",
    ).toContain(DOCX.name);
  });

  /**
   * 三条路各按一遍（都点到确认框的「确定」为止）—— 专供下面那格"0 条时该怎么提示" ✓。
   * ⚠️ 桌面**看得见**的其实只有「右键」与「批量」两条（`App.css:15410` 把行内那六个按钮藏了 ✓，
   *    owner 2026-10-12 拍"保持隐藏" ✓）；`×` 那条一并测，是因为它的代码路径同样要吃这个读数 ✓。
   */
  async function deleteVia(el: HTMLElement, how: "row-x" | "context" | "batch") {
    if (how === "row-x") {
      const btn = el.querySelector<HTMLButtonElement>('button[title="移除文件"]');
      if (!btn) throw new Error("没有 `×` 按钮");
      flushSync(() => btn.click());
    } else if (how === "context") {
      const row = fileRow(el);
      flushSync(() =>
        row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 2, clientX: 120, clientY: 120 })),
      );
      await settle();
      const del = Array.from(document.querySelectorAll<HTMLButtonElement>(".fm-ctx-item")).find((b) =>
        (b.textContent ?? "").includes("删除"),
      );
      if (!del) throw new Error("右键菜单里没有「删除」");
      flushSync(() => del.click());
    } else {
      const cb = fileRow(el).querySelector<HTMLInputElement>('input[type="checkbox"]');
      if (!cb) throw new Error("没有勾选框");
      flushSync(() => cb.click());
      await settle();
      const btn = document.querySelector<HTMLButtonElement>('button[aria-label="删除选中"]');
      if (!btn || btn.disabled) throw new Error("「删除选中」不可用");
      flushSync(() => btn.click());
    }
    await settle();
    const ok = document.querySelector<HTMLButtonElement>(".confirm-ok");
    if (!ok) throw new Error(`[${how}] 确认框没出现`);
    flushSync(() => ok.click());
    await settle();
  }

  // ⭐⭐ owner 2026-10-12 拍的口径：**幂等但如实返回"删了 0 条"** ⇒ 界面**自己决定提示** ✓
  //    （从根上消灭"无声假成功" ✗）。判据：后端如实说 0 条时，三条路都**不许**说「已移除/已删除」✗，
  //    而且**不能一声不吭**（要给一句诚实的提示 ✓）。
  it("⭐ 后端如实报告「删了 0 条」（幂等）⇒ 三条路都不许说「已移除/已删除」，要给诚实提示", async () => {
    for (const how of ["row-x", "context", "batch"] as const) {
      teardown();
      // `deletes: false` ⇒ **幂等路**：一条也不删、如实返回 0（⛔ 不报错 ✓）。
      const el = await mountFileManager({ deletes: false });
      useToast.setState({ toasts: [] });

      await deleteVia(el, how);

      const msgs = useToast.getState().toasts.map((t) => t.message);
      expect(
        msgs.some((m) => m.includes("已移除") || m.includes("已删除")),
        `[${how}] 后端说"删了 0 条" ⇒ ⛔ **不许**报"删掉了"（owner：让界面自己决定提示）—— 实际提示：${JSON.stringify(msgs)}`,
      ).toBe(false);
      expect(
        msgs.length,
        `[${how}] 也不能**一声不吭**：必须给一句诚实的提示（幂等不是错，但不许假装删掉了）`,
      ).toBeGreaterThan(0);
    }
  });

  // ⭐⭐ 同一族的"无声假成功"还有**两个调用方**（Lead 2026-10-12 拍：一处都不该留 ✓）——
  //    · `AttachmentPanel.tsx:129-137` 的 `removeFile`（页面附件面板，**没有确认框** ✓）
  //    · `PageTree.tsx:281-297` 的 `deleteFile`（侧栏文件行的右键菜单 ✓）
  //    它们也调同一条命令，但改之前**不看返回值** ⇒ 后端回 0 也照样说「已移除附件」/「已删除」✗。
  //    这两格就是它们的守门人（先红后绿 ✓）。
  it("⭐ 附件面板：后端如实回「删了 0 条」⇒ 不许说「已移除附件」", async () => {
    const el = await mountAttachmentPanel({ deletes: false });
    const btn = el.querySelector<HTMLButtonElement>('button[title="移除附件"]');
    expect(btn, "前提：附件行上应当有「移除附件」按钮（`AttachmentPanel.tsx:182`）").not.toBeNull();
    useToast.setState({ toasts: [] });

    flushSync(() => btn!.click());
    await settle();

    const msgs = useToast.getState().toasts.map((t) => t.message);
    expect(
      msgs.some((m) => m.includes("已移除")),
      `后端说"删了 0 条" ⇒ ⛔ 不许报"已移除"（同 FileManagerView 那条口径）—— 实际提示：${JSON.stringify(msgs)}`,
    ).toBe(false);
    expect(msgs.length, "也不能一声不吭：必须给一句诚实提示").toBeGreaterThan(0);
  });

  it("⭐ 侧栏文件行（右键 → 删除）：后端如实回「删了 0 条」⇒ 不许说「已删除」", async () => {
    const el = await mountPageTree({ deletes: false });
    const row = el.querySelector<HTMLElement>(".tree-file-row");
    expect(row, "前提：侧栏里应当有那条文件行（`PageTree.tsx:341`）").not.toBeNull();

    flushSync(() =>
      row!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 2, clientX: 100, clientY: 100 })),
    );
    await settle();
    const del = Array.from(document.querySelectorAll<HTMLButtonElement>(".tree-node-menu button")).find((b) =>
      (b.textContent ?? "").includes("删除"),
    );
    expect(del, "前提：文件行菜单里应当有「删除」（`PageTree.tsx:451-461`）").toBeTruthy();
    useToast.setState({ toasts: [] });

    flushSync(() => del!.click());
    await settle();
    const ok = document.querySelector<HTMLButtonElement>(".confirm-ok");
    expect(ok, "前提：删除要走确认框（`PageTree.tsx:284-289`）").not.toBeNull();
    flushSync(() => ok!.click());
    await settle();

    const msgs = useToast.getState().toasts.map((t) => t.message);
    expect(
      msgs.some((m) => m.includes("已删除")),
      `后端说"删了 0 条" ⇒ ⛔ 不许报"已删除"（同 FileManagerView 那条口径）—— 实际提示：${JSON.stringify(msgs)}`,
    ).toBe(false);
    expect(msgs.length, "也不能一声不吭：必须给一句诚实提示").toBeGreaterThan(0);
  });
});
