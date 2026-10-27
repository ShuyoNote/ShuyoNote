// 「文件上传后被打上『未下载』」的判据 —— 钉 owner 2026-10-27 截图那个症状 ✗。
//
// 真机：拖一个 zip 进文件管理 ⇒ 行出现了、字节也确实落盘了
// （`attachments/<空间>/f7/<hash>.zip`、6081790 B），但行上仍标「未下载」。
// 根因：`FileManagerView.importPaths()` 成功之后只 `setFiles(...)`，
//       没有重读「盘上有哪些 hash」（`loadOnDisk()`）⇒ `onDisk` 还是上传前那份旧集合。
//
// 判据两条（本来就是一条链，缺哪条都红）：
//   ① 上传成功后必须**再读一次** `listAttachmentHashes`（≥2 次：挂载时一次 ＋ 上传后一次）；
//   ② 那一行**不许**再出现 `未下载`（`.fm-missing-tag`）。
//
// ⚠️ 故意把 `downloadAttachment` 桩成 **reject**：真机里个人空间没有服务器、对端也拿不到
//    ⇒ 那条「自动预取」帮不上忙（它只在成功时 `loadOnDisk()`）—— 所以"靠预取把标记刷掉"
//    不是这里要测的路 ✓。
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

const ZIP_HASH = "f739bf18cd7ff653e2283e82a72f9341b9b4063337280f4aaa7fea6afab05b3b";

const ZIP = {
  id: "att-zip",
  name: "焦招统一客户端-效果图-20261027.zip",
  hash: ZIP_HASH,
  mime: "application/zip",
  size: 6_081_790,
  path: "",
  created_at: 1_793_088_644_650,
  mtime: 0,
};

const mocks = vi.hoisted(() => ({
  listPageAttachments: vi.fn<() => Promise<unknown[]>>(),
  listAttachmentHashes: vi.fn<() => Promise<string[]>>(),
  importAttachmentFiles: vi.fn<(pageId: string | null, paths: string[]) => Promise<unknown[]>>(),
  downloadAttachment: vi.fn<() => Promise<unknown>>(),
  seedPages: [] as unknown[],
  drop: null as null | ((event: { payload: { type: string; paths?: string[] } }) => void),
}));

vi.mock("../lib/api", () => {
  const noop = async () => undefined;
  const real: Record<string, unknown> = {
    listPageAttachments: () => mocks.listPageAttachments(),
    listAttachmentHashes: () => mocks.listAttachmentHashes(),
    importAttachmentFiles: (pageId: string | null, paths: string[]) => mocks.importAttachmentFiles(pageId, paths),
    downloadAttachment: () => mocks.downloadAttachment(),
    listPages: async () => mocks.seedPages,
    getPage: async () => null,
    readAttachmentBytes: async () => new ArrayBuffer(0),
    removeAttachment: noop,
    removeAttachments: noop,
    moveAttachment: noop,
    copyAttachment: noop,
    restoreAttachment: noop,
    renameAttachment: noop,
    savePage: noop,
    deletePage: noop,
  };
  const api = new Proxy(real, {
    get: (t, k) => {
      if (k in t) return (t as Record<string, unknown>)[k as string];
      const name = String(k);
      if (/^list/.test(name)) return async () => [];
      return async () => {
        throw new Error(`[判据] 本用例没有桩这条命令：${name}`);
      };
    },
  });
  return { api };
});

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

vi.mock("../lib/platform", () => ({
  platform: {
    event: { listen: async () => () => {} },
    webview: {
      onDragDropEvent: (cb: (event: { payload: { type: string; paths?: string[] } }) => void) => {
        mocks.drop = cb;
        return Promise.resolve(() => {});
      },
    },
    dialog: { open: async () => null, save: async () => null },
    opener: { openPath: async () => {}, revealItemInDir: async () => {}, openUrl: async () => {} },
  },
  isDesktopPlatform: () => true,
  isMobileUserAgent: () => false,
  isWebPlatform: () => false,
  emailSupported: () => false,
}));

import { FileManagerView } from "./FileManagerView";
import { useNotes } from "../store/notes";
import { useFileManagerStore } from "../store/fileManager";
import { useToast } from "../store/toast";
import type { PageMeta } from "../types";

let host: HTMLDivElement | null = null;
let root: Root | null = null;

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
  await tick();
  flushSync(() => {});
}

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

describe("文件上传后不许被打「未下载」", () => {
  it("上传成功 ⇒ 重读盘上 hash（≥2 次）且那一行不再显示「未下载」", async () => {
    // 后端状态：挂载时盘上什么都没有；**上传之后**盘上就有了这一件的字节。
    let uploaded = false;
    mocks.listPageAttachments.mockReset();
    mocks.listAttachmentHashes.mockReset();
    mocks.importAttachmentFiles.mockReset();
    mocks.downloadAttachment.mockReset();
    mocks.drop = null;

    mocks.listPageAttachments.mockImplementation(async () => (uploaded ? [ZIP] : []));
    mocks.listAttachmentHashes.mockImplementation(async () => (uploaded ? [ZIP_HASH] : []));
    mocks.importAttachmentFiles.mockImplementation(async () => {
      uploaded = true;
      return [ZIP];
    });
    // 真机那台机器：个人空间没服务器、对端也拿不到 ⇒ 自动预取必然失败（不许它把标记刷掉）
    mocks.downloadAttachment.mockRejectedValue(new Error("no peer"));

    const pages = [meta("f1", "folder", "山焦招标统一客户端", 0)];
    mocks.seedPages = pages;
    useNotes.setState({ pages, loading: false, currentId: null });
    useFileManagerStore.setState({ folderId: null });

    const el = document.createElement("div");
    document.body.appendChild(el);
    host = el;
    root = createRoot(el);
    flushSync(() => root?.render(React.createElement(FileManagerView)));
    await settle();

    const before = mocks.listAttachmentHashes.mock.calls.length;
    expect(before).toBeGreaterThanOrEqual(1);

    // 拖进来一个 zip（与真机同一条路：`webview.onDragDropEvent` → `importPaths`）
    // ⚠️ `vi.hoisted` 把这一格推成了 `null` 字面量类型（TS 只认字面量）⇒ 这里显式收窄成回调再调。
    const drop = mocks.drop as unknown as
      | ((event: { payload: { type: string; paths?: string[] } }) => void)
      | null;
    if (!drop) throw new Error("组件没注册拖拽监听（onDragDropEvent）");
    drop({ payload: { type: "drop", paths: ["C:/tmp/焦招统一客户端-效果图-20261027.zip"] } });
    await settle();

    // ① 上传成功后必须再读一次「盘上有哪些字节」
    expect(
      mocks.listAttachmentHashes.mock.calls.length,
      "上传成功后**没有**重读盘上 hash ⇒ 新上传的行会被误标「未下载」",
    ).toBeGreaterThanOrEqual(2);

    // ② 那一行真的不再标「未下载」
    expect(el.textContent ?? "", "上传完还挂着「未下载」标记").not.toContain("未下载");
    expect(el.querySelectorAll(".fm-missing-tag").length, "还有 .fm-missing-tag 元素").toBe(0);
  });
});
