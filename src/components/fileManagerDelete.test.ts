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
  removeAttachment: vi.fn<(id: string) => Promise<void>>(),
  removeAttachments: vi.fn<(ids: string[]) => Promise<number>>(),
  deletePage: vi.fn<(id: string) => Promise<void>>(),
}));

vi.mock("../lib/api", () => {
  // ⚠️ 不用 Proxy 包**模块对象**：vitest 会给 mock 结果再套一层代理 ⇒
  //    报 `Cannot create proxy with a non-object as target or handler`（实测踩到 ✓）。
  //    这里把 `FileManagerView.tsx` 真正用到的 14 个命令逐个写出来（其余本判据不碰）。
  const noop = async () => undefined;
  return {
    api: {
      listPageAttachments: (...a: unknown[]) => mocks.listPageAttachments(...(a as [string | null])),
      listAttachmentHashes: () => mocks.listAttachmentHashes(),
      removeAttachment: (...a: unknown[]) => mocks.removeAttachment(...(a as [string])),
      removeAttachments: (...a: unknown[]) => mocks.removeAttachments(...(a as [string[]])),
      deletePage: (...a: unknown[]) => mocks.deletePage(...(a as [string])),
      downloadAttachment: noop,
      importAttachmentFiles: async () => [],
      moveAttachment: noop,
      getPage: async () => null,
      readAttachmentBytes: async () => new ArrayBuffer(0),
      copyAttachment: noop,
      restoreAttachment: noop,
      renameAttachment: noop,
      savePage: noop,
    },
  };
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
import { useNotes } from "../store/notes";
import { useFileManagerStore } from "../store/fileManager";
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

afterEach(() => {
  if (root) flushSync(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  useFileManagerStore.setState({ folderId: null });
});

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() {
  await tick();
  await tick();
  flushSync(() => {});
}

/**
 * 假后端（**有状态**的）：`listPageAttachments` 列的是"库里现在真有什么"，
 * `removeAttachment` 按 `deletes` 决定**真删**还是走那条"查不到 id 也照样返回成功"的静默路。
 *
 * ⚠️ 这里第一版是"永远返回 `[DOCX]`、删了也不变" ✗ —— 那是个**会忽略删除的后端**：
 *    它让"补 `loadFiles()`（以重列结果为准）"那条修法**看起来是错的** ✗（实测：修完第一条判据当场红 ✓）。
 *    判据的假后端必须**忠实**，否则红的绿的都是假的 ✓。
 */
let backendRows: AttachmentMeta[] = [];
async function mountFileManager(opts: { deletes?: boolean } = {}) {
  const deletes = opts.deletes ?? true;
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
    // `deletes: true` ⇒ 真后端（那一行从库里没了 ⇒ 重列时不再出现 ✓）；
    // `deletes: false` ⇒ (乙) 那条静默路（**什么都不做、照样 resolve** ✓，见 `attachments.rs:998-1008`）。
    if (deletes) backendRows = backendRows.filter((f) => f.id !== id);
  });
  mocks.removeAttachments.mockImplementation(async (ids: string[]) => {
    backendRows = backendRows.filter((f) => !ids.includes(f.id));
    return ids.length;
  });
  useFileManagerStore.setState({ folderId: null });
  useNotes.setState({
    pages: [
      meta("f1", "folder", "设计方案", 0),
      meta("f2", "folder", "效果图", 1),
      meta("f3", "folder", "研究报告", 2),
    ],
    loading: false,
    currentId: null,
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  flushSync(() =>
    root?.render(
      React.createElement(React.Fragment, null, React.createElement(FileManagerView), React.createElement(ConfirmDialog)),
    ),
  );
  await settle();
  return host;
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
});
