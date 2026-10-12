// ⭐ **把文件移动到另一个文件夹之后，侧边栏那棵树不跟着变** —— owner 2026-10-12 实测的症状判据。
//
// ── 两条路（都在 `repos/ShuyoNote/src/`）───────────────────────────────────
//   **移动那条路**：文件管理视图里那一行的「移动到文件夹」＝
//     · 按钮 `button[title="移动到文件夹"]`：`components/FileManagerView.tsx:1140-1148`（`setMoving(row.file!)`）；
//     · 浮层里点目标文件夹：`FileManagerView.tsx:1348-1369`（`.fm-move-item` ⇒ `moveTo(moving, f.id)`）；
//     · ⭐ 真正的动作 `moveTo()`：`FileManagerView.tsx:361-374` —— 逐字：
//         `await api.moveAttachment(f.id, targetFolderId);`（:367，`lib/api.ts:661` ⇒ 命令 `move_attachment`）
//         `setFiles((prev) => prev.filter((x) => x.id !== f.id));`（:368，只更新**它自己**那一份 `files`）
//       ⛔ 这里**没有** `useFileManagerStore.getState().bumpRevision()` ✗ —— 而同一个文件里
//       上传（:334）／移除（:413）／批量删（:642）／右键删（:741）／改名（:768）**五处都 bump** ✓；
//       改名那处的注释还逐字写着为什么（`FileManagerView.tsx:765-766`）：
//         「强制刷新：页面树（侧边栏）订阅 useNotes.pages 与 fileManager.revision，
//           两者都刷新才能让侧边栏 / 文件管理网格及时显示新名字。」
//   **侧边栏那棵树的数据源**：`components/PageTree.tsx` 的 `TreeFiles`（`:186`；`:853` 渲染在文件夹下）。
//     · `const revision = useFileManagerStore((s) => s.revision);`（`PageTree.tsx:211`）；
//     · `useEffect(() => { api.listPageAttachments(folderId).then(setFiles) }, [folderId, revision])`
//       （`PageTree.tsx:212-223`）⇒ ⭐ **只有 `folderId` 或 `revision` 变，它才重取** ✓；
//     · `revision` 的写入处只有 `bumpRevision()`（`store/fileManager.ts:25`；该 store 的注释
//       `:7-8` 逐字：「revision lets the sidebar refresh its file lists after uploads/removals」）✓。
//   ⇒ ⭐ **真因（判据级）**：一次移动**改了 A 处**（后端 ＋ 文件管理器自己的 `files`，`:367-368`），
//     **没通知 B 处**（`revision` 没 bump）✗ ⇒ 侧栏 `TreeFiles` 的 effect 不重跑 ⇒ 那一行留在侧栏里 ✗，
//     直到刷新/切走再回来（`folderId` 变或整树重挂）才对 ✓ —— 与 owner 那句逐字吻合 ✓。
//   ⚠️ 附件**不在** `useNotes.pages` 里 ⇒ 「刷新页面树」的另一半（`loadPages()`）与本案无关 ✓：
//     附件的唯一出处就是 `api.listPageAttachments(pageId)`（`PageTree.tsx:215`）✓。
//
// ⚠️ 本文件里所有 `文件:行` 都是 **2026-10-12 当前工作树**的读数（同目录有**并行改动**：
//    `FileManagerView.tsx` 的 `removeFile` 一处、`PageTree.tsx` 的菜单广播一处 ⇒ 行号已经整体挪过）
//    ⇒ ⭐ **以锚点文本为准**（判据⑤就是按文本找 `const moveTo = async`，⛔ 不写死行号 ✗）。
//
// ── 判据（4 条）────────────────────────────────────────────────────────
//   ① 前提：同一次挂载里**侧栏**与**文件管理器**都列出了这份文件（否则下面的红没有意义 ✓）；
//   ② ⭐ **本判据今天红**：走真的「移动到文件夹」那条 UI 路径之后 ——
//      移动命令**真的发出去了** ✓ ／ 文件管理器自己那一份**已经更新** ✓（这两条绿 ⇒ 证明这一击真的落到 `moveTo` ✓），
//      但 ⭐ `revision` **没变** ✗ ＋ 侧栏那一行**还在** ✗；
//   ③ 机制证明（今天绿）：**手动** `bumpRevision()` ⇒ 侧栏真的重取、那一行真的消失 ✓
//      ⇒ 把"修法方向＝补那一个通知"钉死 ✓（⛔ 不是"侧栏坏了"✗，也不是"要换数据源"✗）；
//   ④ 反面对照：点「取消」⇒ 一条命令都不发、`revision` 不许白动、侧栏那一行不许动 ✓
//      （⛔ 别把"什么都没干"当修好 ✗）；
//   ⑤ 判据级读数（今天红）：**只读源码** —— `moveTo()` 的函数体里必须出现 `bumpRevision()`
//      ⇒ 把"修法落点"钉成可核的一格，最小修法一落地它就自动转绿 ✓
//      （形状同 `src/editor/blockDragWiring.test.ts:17-25` 读源码那条 ✓）。
//
// 形状抄刚落的 `src/components/folderClickView.test.ts`（真组件 ＋ `flushSync` ＋ 原生事件 ＋
// 断言**状态/调用**而非外观 ✓）。⚠️ 路径固定是 `.ts` ⇒ 用 `React.createElement`（`.ts` 里不转 JSX，
// `vitest.config.ts:9-11`）✓。⚠️ 宿主同形：`App.tsx:1142` `<PageTree/>` 与 `:1196` `<FileManagerView/>`
// 在真应用里是**同时挂着**的 ✓ ⇒ 本判据也把它俩挂在同一个宿主里 ✓（`tableMenu.test.tsx:16-31` 的"同形宿主" ✓）。
// ⚠️ 如实交代一处环境坑（踩了才这么写）：本仓 vitest 里 `vi.mock` 工厂**返回 `new Proxy(...)` 会直接炸**
// `TypeError: Cannot create proxy with a non-object as target or handler`（同目录 `fileManagerDelete.test.ts`
// 也踩过 ⇒ 它现在也是**普通对象**）⇒ 这里一律用**普通对象**、把用到的键**显式列全** ✓。
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

const mocks = vi.hoisted(() => ({
  listPageAttachments: vi.fn<(pageId: string | null) => Promise<unknown[]>>(),
  moveAttachment: vi.fn<(id: string, newPageId: string) => Promise<void>>(),
  listAttachmentHashes: vi.fn<() => Promise<string[]>>(),
}));

vi.mock("../lib/api", () => {
  const noop = async () => undefined;
  return {
    api: {
      listPageAttachments: (...a: unknown[]) => mocks.listPageAttachments(...(a as [string | null])),
      listAttachmentHashes: () => mocks.listAttachmentHashes(),
      moveAttachment: (...a: unknown[]) => mocks.moveAttachment(...(a as [string, string])),
      // 其余命令本判据不关心；显式列全（⛔ 不能用 Proxy ✗，见文件头那条坑）。
      downloadAttachment: noop,
      importAttachmentFiles: async () => [],
      removeAttachment: noop,
      removeAttachments: async () => 0,
      deletePage: noop,
      getPage: async () => null,
      readAttachmentBytes: async () => new ArrayBuffer(0),
      copyAttachment: noop,
      restoreAttachment: noop,
      renameAttachment: noop,
      savePage: noop,
      copyPageToWorkspace: noop,
      listWorkspaces: async () => [],
      getActiveWorkspaceId: async () => "ws-1",
      // ⚠️ 侧栏挂载时**真的会调**这两个（`PageTree.tsx:1084/1107` `listSyncProfiles`、
      //    `:1102/1115` `getWorkspaceName`）⇒ 少一个就是 `api.xxx is not a function` 的 unhandled error ✓。
      getWorkspaceName: async () => "空间",
      listSyncProfiles: async () => [],
      setActiveWorkspaceId: noop,
      spaceSecurityOverview: async () => [],
    },
  };
});

// i18n 与平台都打桩（形状同 `fileManagerDelete.test.ts:52-65`）：断言的是"移动这条链"，不是词条/真后端。
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

vi.mock("../lib/platform", () => ({
  platform: {
    event: { listen: async () => () => {} },
    webview: { onDragDropEvent: () => Promise.resolve(() => {}) },
    dialog: { open: async () => null, save: async () => null },
    opener: { openPath: async () => {}, revealItemInDir: async () => {}, openUrl: async () => {} },
    asset: { convertFileSrc: (p: string) => p },
  },
  isDesktopPlatform: () => true,
  isWebPlatform: () => false,
  isMobileUserAgent: () => false,
  emailSupported: () => false,
}));

import { PageTree } from "./PageTree";
import { FileManagerView } from "./FileManagerView";
import { useNotes } from "../store/notes";
import { useFileManagerStore } from "../store/fileManager";
import { FM_VIEW_KEY } from "../lib/fileManagerView";
import type { AttachmentMeta, PageMeta } from "../types";

/** 源文件夹（文件现在在它下面）／目标文件夹（「移动到…」的落点）。 */
const FOLDER_FROM = "folder-from";
const FOLDER_TO = "folder-to";

/** 那份被移动的文件（形状同 `fileManagerDelete.test.ts:74-83` 的附件元数据）。 */
const FILE: AttachmentMeta = {
  id: "att-moved",
  name: "要搬家的报告.docx",
  hash: "hash-moved",
  mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  size: 52_000,
  path: "/tmp/moved.docx",
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

/** 「后端现在把附件放在哪个文件夹下」—— 两处（侧栏 `TreeFiles` ＋ 文件管理器 `loadFiles`）都读它 ✓。 */
let filesByFolder: Record<string, AttachmentMeta[]> = {};

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) flushSync(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  // ⚠️ `vi.fn()` 是**模块级**的，调用历史跨用例累积 ⇒ 不清的话下一条会读到上一条的命令
  //（实测：④ 的 `calls.length` 读到 1，红的是判据自己而不是产品 ✓）。
  vi.clearAllMocks();
  useFileManagerStore.setState({ folderId: null, revision: 0 });
  try {
    localStorage.removeItem(FM_VIEW_KEY);
  } catch {
    /* ignore */
  }
});

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() {
  await tick();
  await tick();
  flushSync(() => {});
}

/** 挂「侧栏 ＋ 文件管理」两棵树（同形：`App.tsx:1142` ＋ `:1196`），都停在源文件夹上。 */
async function setup() {
  filesByFolder = { [FOLDER_FROM]: [FILE], [FOLDER_TO]: [] };
  mocks.listPageAttachments.mockImplementation(async (pageId: string | null) => filesByFolder[pageId ?? "__root__"] ?? []);
  mocks.moveAttachment.mockResolvedValue(undefined);
  mocks.listAttachmentHashes.mockResolvedValue([]);
  // ⚠️ 视图形态读 localStorage（`FileManagerView.tsx:182`）⇒ 清掉它，保证是 list（行上的动作列才在 ✓）。
  try {
    localStorage.removeItem(FM_VIEW_KEY);
  } catch {
    /* ignore */
  }
  useFileManagerStore.setState({ folderId: FOLDER_FROM, revision: 0 });
  useNotes.setState({
    pages: [meta(FOLDER_FROM, "folder", "源文件夹", 0), meta(FOLDER_TO, "folder", "目标文件夹", 1)],
    loading: false,
    currentId: null,
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  flushSync(() =>
    root?.render(React.createElement(React.Fragment, null, React.createElement(PageTree), React.createElement(FileManagerView))),
  );
  await settle();
  return host;
}

/** 侧栏里那个文件夹下**文件行**的名字（`TreeFiles` 渲染的 `.tree-file-row`，`PageTree.tsx:338-370`）。 */
const sidebarFileNames = (el: HTMLElement) =>
  Array.from(el.querySelectorAll(".tree-file-row")).map((row) => row.getAttribute("title") ?? "");

/** 文件管理器那一列的名字（`.fm-name`，`FileManagerView.tsx:1060`）。 */
const managerFileNames = (el: HTMLElement) =>
  Array.from(el.querySelectorAll(".fm-name")).map((n) => n.textContent ?? "");

/** 打开「移动到文件夹」浮层并返回目标文件夹那一颗按钮（`:1140-1148` ⇒ `:1348-1369`）。 */
function openMoveTo(el: HTMLElement, targetTitle: string) {
  const moveBtn = el.querySelector<HTMLButtonElement>('button[title="移动到文件夹"]');
  expect(
    moveBtn,
    "① 行上的「移动到文件夹」（`FileManagerView.tsx:1140-1148`）应当在（list 视图才有 ⇒ 先确认没读成 grid）",
  ).not.toBeNull();
  flushSync(() => moveBtn!.click());
  const target = Array.from(el.querySelectorAll<HTMLButtonElement>(".fm-move-item")).find((b) =>
    (b.textContent ?? "").includes(targetTitle),
  );
  expect(
    target,
    "① 移动浮层里应当列出目标文件夹（`FileManagerView.tsx:1348-1369`，`folderTargets` 会排掉当前文件夹）",
  ).not.toBeUndefined();
  return target as HTMLButtonElement;
}

describe("移动文件 ⇒ 侧边栏那棵树要跟着变（owner 2026-10-12）", () => {
  it("⭐ 真的走一遍「移动到文件夹」：命令发出去 ✓、管理器自己更新 ✓，但**侧栏没被通知** ✗", async () => {
    const el = await setup();
    const revisionBefore = useFileManagerStore.getState().revision;

    // 前提：同一次挂载里两处都列着它 —— 否则下面的红没有意义 ✓
    expect(sidebarFileNames(el), "前提：侧栏的源文件夹下应当列出这份文件（`PageTree.tsx:212-223`）").toEqual([FILE.name]);
    expect(managerFileNames(el), "前提：文件管理里也列着它").toContain(FILE.name);

    const target = openMoveTo(el, "目标文件夹");
    // 模拟"后端真的把它搬走了"：源文件夹**不再**列出它 ⇒ 任何**重取**都会让那一行消失 ✓
    filesByFolder[FOLDER_FROM] = [];
    flushSync(() => target.click());
    await settle();

    // 前半条（今天绿 ⇒ 证明这一击真的落到了 `moveTo()` ✓）
    expect(
      mocks.moveAttachment.mock.calls.map((c) => [c[0], c[1]]),
      "② 移动命令真的要发出去（`FileManagerView.tsx:367` ⇒ `api.moveAttachment(id, newPageId)`）",
    ).toEqual([[FILE.id, FOLDER_TO]]);
    expect(
      managerFileNames(el),
      "② 文件管理器**自己**那一份列表要立刻更新（`FileManagerView.tsx:368` 的 `setFiles(filter)`）",
    ).not.toContain(FILE.name);

    // ⭐ 判据（今天红）：**谁改了数据 / 谁该被通知而没被通知** —— 一格装两个读数，
    //    失败时那句 diff 本身就同时说明"通知没发"与"侧栏那一行还在" ✓
    const after = {
      revision: useFileManagerStore.getState().revision,
      sidebar: sidebarFileNames(el),
    };
    expect(
      after,
      "③ 移动之后必须：`revision` 变一次（侧栏 `TreeFiles` 只在 `[folderId, revision]` 变时重取，" +
        "`PageTree.tsx:211-223`）＋ 侧栏那一行消失（owner 看到的「侧边栏不能即时更新」）。" +
        "红 ⇒ `moveTo()`（`FileManagerView.tsx:361-374`）里**没有** `bumpRevision()` ✗ —— " +
        "同一个文件里上传(:334)/移除(:413)/批量删(:642)/右键删(:741)/改名(:768) 五处都有 ⇒ 这就是「改了 A 处、没通知 B 处」",
    ).toEqual({ revision: revisionBefore + 1, sidebar: [] });
  });

  it("③ 机制证明（今天绿）：手动 bumpRevision() ⇒ 侧栏真的重取、那一行真的消失", async () => {
    const el = await setup();
    expect(sidebarFileNames(el), "前提：侧栏先列着它").toEqual([FILE.name]);

    filesByFolder[FOLDER_FROM] = [];
    flushSync(() => useFileManagerStore.getState().bumpRevision());
    await settle();

    expect(
      sidebarFileNames(el),
      "`revision` 一变，`TreeFiles` 的 effect（`PageTree.tsx:212-223`）就重跑 ⇒ 列表跟着后端走 ✓" +
        "⇒ 修法方向就是这个**通知**（`moveTo()` 里补一行 `bumpRevision()`），⛔ 不是换数据源/重挂侧栏",
    ).not.toContain(FILE.name);
  });

  it("④ 反面对照：点「取消」⇒ 一条命令都不发、revision 不白动、侧栏那一行不动", async () => {    const el = await setup();
    const revisionBefore = useFileManagerStore.getState().revision;

    const moveBtn = el.querySelector<HTMLButtonElement>('button[title="移动到文件夹"]');
    if (!moveBtn) throw new Error("前提不成立：没有「移动到文件夹」按钮");
    flushSync(() => moveBtn.click());
    filesByFolder[FOLDER_FROM] = [FILE]; // 没移动 ⇒ 后端照旧列着它
    const cancel = el.querySelector<HTMLButtonElement>(".fm-move-cancel");
    expect(cancel, "① 浮层里应当有「取消」（`FileManagerView.tsx:1365-1367`）").not.toBeNull();
    flushSync(() => cancel!.click());
    await settle();

    expect(mocks.moveAttachment.mock.calls.length, "④ 取消 ⇒ 一条移动命令都不许发").toBe(0);
    expect(sidebarFileNames(el), "④ 没移动 ⇒ 侧栏那一行照旧（别把「什么都没干」当修好）").toEqual([FILE.name]);
    expect(useFileManagerStore.getState().revision, "④ 没移动 ⇒ revision 也不该白动一次").toBe(revisionBefore);
  });

  it("⑤ 判据级读数（今天红）：`moveTo()` 里必须**补上** `bumpRevision()`（同族五处都有）", () => {
    // ⚠️ 这一条**只读源码**（与 `src/editor/blockDragWiring.test.ts:17-25` 同一手法 ✓）：
    //    它把"修法落点"钉成一个可核读数，且在**最小修法落地的那一刻**自动转绿 ✓。
    const src = readFileSync(join(process.cwd(), "src", "components", "FileManagerView.tsx"), "utf8");
    const start = src.indexOf("const moveTo = async");
    expect(start, "前提：`FileManagerView.tsx` 里应当有 `const moveTo = async`（`moveTo()` 的入口）").toBeGreaterThan(-1);
    const nextFn = src.indexOf("\n  const openFile", start);
    const body = src.slice(start, nextFn > start ? nextFn : start + 800);

    expect(
      body,
      "`moveTo()`（`FileManagerView.tsx:361-374`）里没有 `bumpRevision()` ⇒ 侧栏 `TreeFiles`（`PageTree.tsx:211-223`）" +
        "不会重取 ⇒ 移动之后那一行留在侧栏里 ✗。逐字现状：\n" +
        body,
    ).toContain("bumpRevision()");
  });
});
