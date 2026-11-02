// 判据 ①（M1 最后一段 · 导出）：**页行右键菜单里真有「导出为 .shuyodoc」，点下去真的走导出那条链**。
//
// 为什么是**挂载级**而不是只测纯函数：这一段的产物是"用户点了一下之后发生了什么"——
// 菜单项在 `PageTree.tsx` 的页行菜单里，链路是
//   右键 ⇒ 菜单项 ⇒ `lib/docPackageTransfer.ts::exportPageAsDocPackage`
//   ⇒ `api.getPage` / `api.listPageAttachments` / `api.readAttachmentBytes`
//   ⇒ `buildDocumentPackage` ⇒ `platform.dialog.save` ⇒ `api.writeBinaryFile`
// 只测第一段或最后一段都会漏掉中间那几段（历史事故形状：功能写了、没人接上）。
//
// 钉的是三件事：
//   ① 菜单项**在**（文案逐字「导出为 .shuyodoc」），而且**只对页面/数据库出现**（文件夹没有正文）；
//   ② 点下去 `buildDocumentPackage` 真的被调了，且传进去的 `docJson` **不是空串**（是这一页的正文）；
//   ③ 落盘的那个字节流是**真 zip、真 .shuyodoc 包**（用本仓读端 `unzipDocument` + `openDocumentPackage`
//      读回来核对标题/正文/资产字节）—— 证的不是"函数被调过"，是"用户拿到手的是能读回去的包"。
//
// ⚠️ 外部世界只桩两头：**宿主平台**（`setPlatform`：dialog ＋ command 执行器）与**写包函数的一层计数**
//    （`vi.mock` 仍委托**真实现**，所以字节是真包）。存储层（`api`）不动 —— 它的包装与命令名正是要验的接线。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 被点了一次的写包入参（`vi.hoisted` ⇒ 提升到 `vi.mock` 工厂之前）。 */
const buildCalls = vi.hoisted(() => [] as unknown[]);

vi.mock("../lib/docPackWriter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/docPackWriter")>();
  return {
    ...actual,
    // ⚠️ **委托真实现**（判据要的是"传进去的是真正文、出来的是真包"），这里只记一笔入参。
    buildDocumentPackage: vi.fn(async (input: Parameters<typeof actual.buildDocumentPackage>[0]) => {
      buildCalls.push(input);
      return actual.buildDocumentPackage(input);
    }),
  };
});

import { PageTree } from "./PageTree";
import { useNotes } from "../store/notes";
import { useToast } from "../store/toast";
import { setPlatform, type Platform } from "../lib/platform";
import { sha256Hex } from "../lib/docPackage";
import { unzipDocument } from "../lib/docZip";
import { openDocumentPackage } from "../lib/docPackageOpen";
import type { PageMeta } from "../types";

const PAGE_ID = "doc-page-1";
const SAVE_PATH = "C:/tmp/第一页.shuyodoc";

/** 一件真资产：PNG 的魔数 ＋ 几个字节（hash 必须与字节一致 —— 写侧会自证）。 */
const ASSET_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);

const meta = (id: string, title: string, kind = "page"): PageMeta => ({
  id,
  workspace_id: "ws-1",
  parent_id: null,
  title,
  icon: "",
  kind,
  sort_order: 0,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_001_000,
  deleted_at: null,
});

interface Host {
  commands: { cmd: string; args?: Record<string, unknown> }[];
  saved: { path: string; data: number[] } | null;
}

/**
 * 一个只实现"这次导出用得到的那几条"的宿主平台替身。
 * ⚠️ 走 `setPlatform` 而不是 `vi.mock("../lib/api")`：这样 `api.ts` 那一层的**真包装**（命令名、参数形状）
 *    也在判据里 —— 命令名写错、参数包错都会在这里炸（那正是 `check-web-commands` 守的另一半）。
 */
function installHost(args: {
  page: Record<string, unknown>;
  attachments: unknown[];
  bytesByHash: Map<string, Uint8Array>;
  /** `dialog.save` 的返回：字符串 ＝ 用户选了路径；`null` ＝ 用户取消。 */
  savePath?: string | null;
}): Host {
  const host: Host = { commands: [], saved: null };
  const fake = {
    executor: {
      invoke: async (cmd: string, cmdArgs?: Record<string, unknown>) => {
        host.commands.push({ cmd, args: cmdArgs });
        switch (cmd) {
          case "get_page":
            return args.page;
          case "list_page_attachments":
            return args.attachments;
          case "read_attachment_bytes": {
            const hash = String(cmdArgs?.hash ?? "");
            const bytes = args.bytesByHash.get(hash);
            // 真宿主回的是 ArrayBuffer（`commands.ts::read_attachment_bytes.result`）
            if (!bytes) throw new Error("附件文件不存在（可能被移动或删除）");
            return bytes.buffer.slice(0) as ArrayBuffer;
          }
          case "write_binary_file": {
            host.saved = { path: String(cmdArgs?.path ?? ""), data: (cmdArgs?.data ?? []) as number[] };
            return undefined;
          }
          case "list_pages":
            return [meta(PAGE_ID, "第一页")];
          // 侧栏挂载时会问空间名/空间列表（与导出无关，但不桩就会在 toast 里留一条噪音）
          case "get_workspace_name":
            return "工作区";
          case "list_workspaces":
            return [];
          case "get_active_workspace_id":
            return "ws-1";
          default:
            throw new Error(`[判据] 本用例没有桩这条命令：${cmd}`);
        }
      },
    },
    dialog: { open: async () => null, save: async () => (args.savePath === undefined ? SAVE_PATH : args.savePath) },
    opener: { openUrl: async () => {}, openPath: async () => {}, revealItemInDir: async () => {} },
    event: { listen: async () => () => {} },
    asset: { convertFileSrc: (p: string) => p },
    webview: { onDragDropEvent: async () => () => {} },
  };
  setPlatform(fake as unknown as Platform);
  return host;
}

let hostDiv: HTMLDivElement | null = null;
let root: Root | null = null;

function teardown() {
  if (root) flushSync(() => root?.unmount());
  hostDiv?.remove();
  root = null;
  hostDiv = null;
  useToast.setState({ toasts: [] });
}
afterEach(teardown);

beforeEach(() => {
  buildCalls.length = 0;
  useToast.setState({ toasts: [] });
  useNotes.setState({ pages: [meta(PAGE_ID, "第一页")], loading: false, currentId: PAGE_ID, current: null });
});

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() {
  await tick();
  await tick();
  await tick();
  flushSync(() => {});
}
/**
 * 轮询等一件异步动作**真的做完**（⛔ 不用"固定几个 tick"当同步点：
 * 与别的测试文件并行跑时机器会慢一下，固定次数曾在联合运行里偶发早判 ⇒ 假红）。
 */
async function waitFor(cond: () => boolean, what: string, tries = 300): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await tick();
    flushSync(() => {});
  }
  throw new Error(`等待超时：${what}`);
}

/** 用户的一次右键（与 `treeMenuSingle.test.ts` 同一套事件：按下 → 抬起 → contextmenu）。 */
function rightClick(row: HTMLElement, x = 120, y = 100) {
  const init: MouseEventInit = { bubbles: true, cancelable: true, button: 2, clientX: x, clientY: y };
  flushSync(() => row.dispatchEvent(new MouseEvent("mousedown", init)));
  flushSync(() => row.dispatchEvent(new MouseEvent("mouseup", init)));
  flushSync(() => row.dispatchEvent(new MouseEvent("contextmenu", init)));
}

function mountTree() {
  hostDiv = document.createElement("div");
  document.body.appendChild(hostDiv);
  root = createRoot(hostDiv);
  flushSync(() => root?.render(React.createElement(PageTree)));
  return hostDiv;
}

/** 菜单项按钮：**按文案找**（判据要求文案逐字就是「导出为 .shuyodoc」）。 */
function menuButton(el: HTMLElement, text: string): HTMLElement | null {
  const buttons = [...el.querySelectorAll<HTMLElement>(".tree-node-menu button")];
  return buttons.find((b) => (b.textContent ?? "").trim().includes(text)) ?? null;
}

const toastMessages = () => useToast.getState().toasts.map((t) => t.message);

describe("M1 · 导出：页行右键「导出为 .shuyodoc」", () => {
  it("① 菜单项在（文案逐字）＋ 文件夹行**没有**这一项（文件夹没正文）", async () => {
    installHost({ page: {}, attachments: [], bytesByHash: new Map() });
    useNotes.setState({
      pages: [meta(PAGE_ID, "第一页"), meta("folder-1", "一个文件夹", "folder")],
      loading: false,
      currentId: PAGE_ID,
      current: null,
    });
    const el = mountTree();
    await settle();

    const pageRow = el.querySelector<HTMLElement>(`[data-node-id="${PAGE_ID}"]`);
    if (!pageRow) throw new Error("夹具失败：页面行没渲染出来");
    rightClick(pageRow);
    const item = menuButton(el, "导出为 .shuyodoc");
    expect(item, "页行右键菜单里没有「导出为 .shuyodoc」").not.toBeNull();

    // 反面：文件夹行**不允许**有这一项（`api.getPage(folder)` 会被后端如实拒 ⇒ 不许把用户引到必错的一步）
    rightClick(el.querySelector<HTMLElement>('[data-node-id="folder-1"]')!);
    expect(menuButton(el, "导出为 .shuyodoc"), "文件夹行不该出现「导出为 .shuyodoc」").toBeNull();
  });

  it("②③ 点下去 ⇒ `buildDocumentPackage` 收到**这一页的正文**（非空）＋ 落盘的是能读回去的真 .shuyodoc", async () => {
    const hash = await sha256Hex(ASSET_BYTES);
    const docJson = JSON.stringify({
      root: {
        children: [
          { type: "paragraph", children: [{ type: "text", text: "这一页的正文" }] },
          // 媒体节点带指纹（`hash` ＋ `mime`）—— 导出侧据此把资产一起带走
          { type: "image", version: 1, src: `attachment://localhost/C%3A/${hash}.png`, altText: "图", hash, mime: "image/png" },
        ],
      },
    });
    const page = {
      id: PAGE_ID,
      workspace_id: "ws-1",
      parent_id: null,
      title: "第一页",
      content_json: docJson,
      content_text: "这一页的正文",
      cover: "",
      icon: "",
      cover_height: 0,
      kind: "page",
      sort_order: 0,
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_001_000,
    };
    const host = installHost({
      page,
      attachments: [{ id: "att-1", name: "图.png", hash, mime: "image/png", size: ASSET_BYTES.length, path: "" }],
      bytesByHash: new Map([[hash, ASSET_BYTES]]),
    });
    const el = mountTree();
    await settle();

    const row = el.querySelector<HTMLElement>(`[data-node-id="${PAGE_ID}"]`);
    if (!row) throw new Error("夹具失败：页面行没渲染出来");
    rightClick(row);
    const item = menuButton(el, "导出为 .shuyodoc");
    if (!item) throw new Error("夹具失败：菜单项没出现");
    flushSync(() => item.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
    await waitFor(() => host.saved !== null, "导出落盘（write_binary_file）");

    // ── ② 写包那一步：收的是**这一页的正文**，不是空串 ──
    expect(buildCalls, "点了菜单项却没有调 buildDocumentPackage").toHaveLength(1);
    const input = buildCalls[0] as {
      documentId: string;
      title: string;
      createdAt: string;
      updatedAt: string;
      docJson: string;
      assets?: { path: string; bytes: Uint8Array }[];
      sourceAppVersion: string;
    };
    expect(input.docJson, "传给 buildDocumentPackage 的正文是空串（等于导出一个空页）").not.toBe("");
    expect(input.docJson).toBe(docJson); // 正文原样：⛔ 不许在这一层改写/重排
    expect(JSON.parse(input.docJson).root.children[0].children[0].text).toBe("这一页的正文");
    expect(input.documentId).toBe(PAGE_ID);
    expect(input.title).toBe("第一页");
    expect(input.createdAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(input.updatedAt).toBe(new Date(1_700_000_001_000).toISOString());
    expect(input.sourceAppVersion, "sourceAppVersion 必须非空（写包会拒空串）").not.toBe("");
    // 资产：页附件 ＋ 正文引用，按内容寻址 `assets/<sha256>.<ext>`
    expect(input.assets ?? [], "附件没有被打进包").toHaveLength(1);
    expect(input.assets![0].path).toBe(`assets/${hash}.png`);

    // ── ③ 落盘走的是**既有保存路径**（`write_binary_file`），字节是**真包** ──
    expect(host.commands.map((c) => c.cmd)).toContain("write_binary_file");
    expect(host.saved?.path).toBe(SAVE_PATH);
    const written = new Uint8Array(host.saved!.data);
    expect(written[0], "落盘的不是 zip（缺 PK 头）").toBe(0x50);
    expect(written[1]).toBe(0x4b);

    const opened = await openDocumentPackage(await unzipDocument(written));
    expect(opened.ok, "导出的字节用本仓读端读不回来").toBe(true);
    if (!opened.ok) return;
    expect(opened.pkg.manifest.title).toBe("第一页");
    expect(opened.pkg.docJson).toBe(docJson);
    expect(opened.pkg.assets).toHaveLength(1);
    expect([...opened.pkg.assets[0].bytes]).toEqual([...ASSET_BYTES]);

    // 成功要有那句给人看的话（落盘路径在里）
    expect(toastMessages().some((m) => m.includes("已导出「第一页」")), "没有「已导出」那句结果话").toBe(true);
    expect(toastMessages().some((m) => m.includes("已导出「第一页」") && m.includes(SAVE_PATH))).toBe(true);
  });

  it("取消保存（dialog 回 null）⇒ 一个字节都不写，且如实说「已取消导出」", async () => {    const docJson = JSON.stringify({ root: { children: [{ type: "paragraph", children: [{ type: "text", text: "x" }] }] } });
    const host = installHost({
      savePath: null,
      page: {
        id: PAGE_ID,
        workspace_id: "ws-1",
        parent_id: null,
        title: "第一页",
        content_json: docJson,
        content_text: "x",
        cover: "",
        icon: "",
        cover_height: 0,
        kind: "page",
        sort_order: 0,
        created_at: 1,
        updated_at: 1,
      },
      attachments: [],
      bytesByHash: new Map(),
    });
    const el = mountTree();
    await settle();

    rightClick(el.querySelector<HTMLElement>(`[data-node-id="${PAGE_ID}"]`)!);
    const item = menuButton(el, "导出为 .shuyodoc");
    if (!item) throw new Error("夹具失败：菜单项没出现");
    flushSync(() => item.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await waitFor(() => toastMessages().length > 0, "取消的结果 toast");

    expect(host.saved, "取消之后仍然写了文件").toBeNull();
    expect(buildCalls, "取消之后还在打包（白读一遍大附件）").toHaveLength(0);
    expect(toastMessages()).toContain("已取消导出");
  });
});

// ⭐ 2026-10-31（owner 截图）：「⋯ 更多（导出等）」菜单里也要有「导出为 .shuyodoc」。
// 钉的是**同一函数**：两处入口都调 `docPackageTransfer.ts::exportPageAsDocPackage`，
// ⛔ 不许在工具栏里再写一份打包／资产／落盘逻辑（那正是本仓最贵的一类事故）。
describe("导出入口 ②：编辑器「⋯ 更多」菜单", () => {
  it("菜单里有「导出为 .shuyodoc」，且调的是同一个 exportPageAsDocPackage（zh/en 文案都在）", () => {
    const src = readFileSync(resolve(HERE, "EditorToolbar.tsx"), "utf8");
    expect(src, "EditorToolbar 没有 import 文档包导出函数").toMatch(
      /import \{ exportPageAsDocPackage \} from "\.\.\/lib\/docPackageTransfer"/,
    );
    expect(src, "菜单项文案没接上 i18n").toContain('t("editor.exportShuyodoc")');
    expect(src, "点下去没有调用 exportPageAsDocPackage(pageId)").toMatch(/exportPageAsDocPackage\(pageId\)/);
    const zh = readFileSync(resolve(HERE, "../i18n/locales/zh.ts"), "utf8");
    const en = readFileSync(resolve(HERE, "../i18n/locales/en.ts"), "utf8");
    expect(zh, "zh 缺 exportShuyodoc").toMatch(/exportShuyodoc:\s*"导出为 \.shuyodoc/);
    expect(en, "en 缺 exportShuyodoc（⛔ 只改 zh 会造出不一致）").toMatch(/exportShuyodoc:\s*"Export as \.shuyodoc/);
  });
});
