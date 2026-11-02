// 判据 ②③（M1 最后一段 · 导入）：文件区那颗「导入文档包」真的会**解包校验**、真的**新建一页**，
// 而且**失败时把 `openDocumentPackage` 的那句人话原样显示**。
//
// 为什么是**挂载级**：这段接线横跨四层 ——
//   文件区按钮（`FileManagerView.tsx`）⇒ `lib/docPackageTransfer.ts::importDocumentPackage`
//   ⇒ `unzipDocument` ⇒ `openDocumentPackage` ⇒ `write_attachment_bytes`（资产入库）⇒ `create_page`。
// 只测纯函数等于放掉"按钮没接上 / 接上了但用了覆盖接口"这两类真事故（本仓栽过：功能写了没人接）。
//
// 钉的三件事：
//   ② 会调 `unzipDocument` ＋ `openDocumentPackage`；**失败时 toast 里就是那句原文**
//      （**逐字相等**，⛔ 不许加前缀、⛔ 不许换成"导入失败"这种废话）；
//   ③ 走的是"**新建页**"：`create_page` 恰好一次、父级＝当前文件夹，且**没有任何** update/覆盖类命令
//      （`save_page` / `save_page_state` / `move_page`… 一个都不许出现 —— 项目铁律：导入永远新建）。
//
// ⚠️ 外部世界只桩**宿主平台**（`setPlatform`：对话框 ＋ command 执行器）；`api` / `docZip` /
//    `docPackageOpen` / `docPackWriter` 全是真实现（那两个读包函数额外包一层**计数**，仍委托真实现）。
//    ⇒ 因此这里跑的 zip 是**真 zip**、包是**真 `.shuyodoc`**、校验走的是**真判据**。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { zipSync, strToU8 } from "fflate";

/** 两个读包函数的调用次数（`vi.hoisted` ⇒ 提升到 `vi.mock` 工厂之前）。 */
const wired = vi.hoisted(() => ({ unzip: 0, open: 0 }));

vi.mock("../lib/docZip", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/docZip")>();
  return {
    ...actual,
    unzipDocument: async (bytes: Uint8Array) => {
      wired.unzip += 1;
      return actual.unzipDocument(bytes); // 真解压
    },
  };
});

vi.mock("../lib/docPackageOpen", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/docPackageOpen")>();
  return {
    ...actual,
    openDocumentPackage: async (entries: Parameters<typeof actual.openDocumentPackage>[0]) => {
      wired.open += 1;
      return actual.openDocumentPackage(entries); // 真整包校验
    },
  };
});

import { FileManagerView } from "./FileManagerView";
import { useNotes } from "../store/notes";
import { useFileManagerStore } from "../store/fileManager";
import { useSpaceStore } from "../store/space";
import { useToast } from "../store/toast";
import { setPlatform, type Platform } from "../lib/platform";
import { sha256Hex } from "../lib/docPackage";
import { buildDocumentPackage } from "../lib/docPackWriter";
import type { PageMeta } from "../types";

const PICKED_PATH = "C:/tmp/拿到的包.shuyodoc";
/** 源包被"借道入库"时那条临时行（马上就会被删）的 id / hash。 */
const TEMP_ATT_ID = "att-temp-package";
const TEMP_ATT_HASH = "a".repeat(64);

const NEW_PAGE_ID = "page-imported-1";

const pageMeta = (id: string, title: string): PageMeta => ({
  id,
  workspace_id: "ws-1",
  parent_id: null,
  title,
  icon: "",
  kind: "page",
  sort_order: 0,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_001_000,
  deleted_at: null,
});

const pageDetail = (id: string, title: string, contentJson: string) => ({
  id,
  workspace_id: "ws-1",
  parent_id: null,
  title,
  content_json: contentJson,
  content_text: "",
  cover: "",
  icon: "",
  cover_height: 0,
  kind: "page",
  sort_order: 0,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_001_000,
});

interface Host {
  commands: { cmd: string; args?: Record<string, unknown> }[];
}

/**
 * 宿主平台替身：对话框给一条"选中的路径"，命令执行器按 cmd 分发。
 * ⚠️ `import_attachment_files` 的语义与 Rust 一致：**新插一行**并回 `{ id, hash }`
 *    （导入侧读回字节之后会把它删掉 —— 判据要看到那次删除）。
 */
function installHost(args: { pickedPath?: string | null; packageBytes: Uint8Array; createPageFails?: boolean }): Host {
  const host: Host = { commands: [] };
  const fake = {
    executor: {
      invoke: async (cmd: string, cmdArgs?: Record<string, unknown>) => {
        host.commands.push({ cmd, args: cmdArgs });
        switch (cmd) {
          case "import_attachment_files":
            return [
              { id: TEMP_ATT_ID, name: "拿到的包.shuyodoc", hash: TEMP_ATT_HASH, mime: "application/zip", size: args.packageBytes.length, path: "" },
            ];
          case "read_attachment_bytes": {
            const hash = String(cmdArgs?.hash ?? "");
            if (hash === TEMP_ATT_HASH) return args.packageBytes.buffer.slice(0) as ArrayBuffer;
            throw new Error("附件文件不存在（可能被移动或删除）");
          }
          case "remove_attachment":
            return 1;
          case "write_attachment_bytes":
            return {
              id: "att-asset",
              name: String(cmdArgs?.name ?? ""),
              hash: String(cmdArgs?.hash ?? ""),
              mime: String(cmdArgs?.mime ?? ""),
              size: ((cmdArgs?.data ?? []) as number[]).length,
              path: "",
            };
          case "create_page": {
            if (args.createPageFails) throw new Error("权限不足：这个空间现在不接受写入");
            const a = (cmdArgs?.args ?? {}) as Record<string, unknown>;
            return pageDetail(NEW_PAGE_ID, String(a.title ?? ""), String(a.content_json ?? ""));
          }
          case "list_pages":
            return [pageMeta(NEW_PAGE_ID, "导入的标题")];
          case "get_page":
            return pageDetail(NEW_PAGE_ID, "导入的标题", "{}");
          case "list_page_attachments":
          case "list_attachment_hashes":
            return [];
          case "download_attachment":
            // 个人空间没有服务器、对端也拿不到 ⇒ 自动预取必然失败（与真机同形，静默即可）
            throw new Error("no peer");
          default:
            throw new Error(`[判据] 本用例没有桩这条命令：${cmd}`);
        }
      },
    },
    dialog: {
      open: async () => (args.pickedPath === undefined ? PICKED_PATH : args.pickedPath),
      save: async () => null,
    },
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
  useFileManagerStore.setState({ folderId: null });
}
afterEach(teardown);

beforeEach(() => {
  wired.unzip = 0;
  wired.open = 0;
  useToast.setState({ toasts: [] });
  useNotes.setState({ pages: [], currentId: null, current: null, loading: false, lastPageRestored: true, startupSettled: true });
  useFileManagerStore.setState({ folderId: null });
  useSpaceStore.setState({ activeId: null });
});

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() {
  for (let i = 0; i < 5; i++) await tick();
  flushSync(() => {});
}
/**
 * 轮询等一件异步动作**真的做完**（⛔ 不用"固定几个 tick"当同步点：与别的测试文件并行跑时
 * 机器会慢一下，固定次数曾在联合运行里偶发早判 ⇒ 假红）。
 */
async function waitFor(cond: () => boolean, what: string, tries = 300): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await tick();
    flushSync(() => {});
  }
  throw new Error(`等待超时：${what}`);
}

/** 挂载文件区并点那颗「导入文档包」（按文案找，与用户看到的是同一个）。 */
async function mountAndClick(): Promise<HTMLDivElement> {
  hostDiv = document.createElement("div");
  document.body.appendChild(hostDiv);
  root = createRoot(hostDiv);
  flushSync(() => root?.render(React.createElement(FileManagerView)));
  await settle();

  const buttons = [...hostDiv.querySelectorAll<HTMLButtonElement>(".file-manager-actions button")];
  const entry = buttons.find((b) => (b.textContent ?? "").includes("导入文档包"));
  if (!entry) throw new Error("文件区没有「导入文档包」这个入口（夹具失败）");
  flushSync(() => entry.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
  // 等到"结果那一句"出现为止（成功/失败/取消三条路都必然弹一条）
  await waitFor(() => useToast.getState().toasts.length > 0, "导入的结果 toast");
  return hostDiv;
}

const toastMessages = () => useToast.getState().toasts.map((t) => t.message);
const pageWrites = (host: Host) =>
  host.commands.filter((c) => /^(save_page|save_page_state|move_page|rename_page|delete_page|restore_page)/.test(c.cmd));

/** 一件真资产（写包时按 `assets/<sha256>.<ext>` 内容寻址自证）。 */
const ASSET_BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

/** 造一个**真的** `.shuyodoc` 包（用仓里的写包函数，不是手搓 zip）。 */
async function makePackage(): Promise<{ bytes: Uint8Array; contentJson: string; assetHash: string }> {
  const assetHash = await sha256Hex(ASSET_BYTES);
  const contentJson = JSON.stringify({
    root: {
      children: [
        { type: "paragraph", children: [{ type: "text", text: "导入进来的正文" }] },
        { type: "image", version: 1, src: `attachment://${assetHash}.png`, altText: "图", hash: assetHash, mime: "image/png" },
      ],
    },
  });
  const bytes = await buildDocumentPackage({
    documentId: "source-doc-1",
    title: "导入的标题",
    createdAt: "2026-10-29T00:00:00.000Z",
    updatedAt: "2026-10-29T01:00:00.000Z",
    docJson: contentJson,
    assets: [{ path: `assets/${assetHash}.png`, bytes: ASSET_BYTES }],
    sourceAppVersion: "1.92.0",
  });
  return { bytes, contentJson, assetHash };
}

describe("M1 · 导入：文件区「导入文档包」→ 永远新建一页", () => {
  it("②③ 成功：解包校验走真判据 ⇒ 资产入库 ⇒ **create_page 一次**、父级＝当前文件夹、**零覆盖类写入**", async () => {
    const { bytes, contentJson, assetHash } = await makePackage();
    const host = installHost({ packageBytes: bytes });
    useFileManagerStore.setState({ folderId: "folder-42" }); // 用户当前站在某个文件夹里
    useNotes.setState({ pages: [pageMeta("folder-42", "某个文件夹")], currentId: "folder-42", current: null, loading: false, lastPageRestored: true, startupSettled: true });
    await mountAndClick();

    // ── ② 真的解了 zip、真的过了整包校验（不是"看起来导入了"） ──
    expect(wired.unzip, "导入入口没有调 unzipDocument").toBeGreaterThanOrEqual(1);
    expect(wired.open, "导入入口没有调 openDocumentPackage").toBeGreaterThanOrEqual(1);
    expect(toastMessages().some((m) => m.includes("已导入「导入的标题」为新页面")), "没有「已导入…为新页面」那句结果话").toBe(true);
    expect(toastMessages().some((m) => m.includes("未覆盖任何已有页面"))).toBe(true);

    // 源包只是"借道读字节"：那条临时附件行必须被清掉（⛔ 不许在文件区留一个 .shuyodoc）
    const removed = host.commands.filter((c) => c.cmd === "remove_attachment");
    expect(removed.map((c) => c.args?.id)).toContain(TEMP_ATT_ID);

    // 资产走**既有**写入路径：`write_attachment_bytes`（内容寻址，hash 来自包内文件名）
    const assetWrites = host.commands.filter((c) => c.cmd === "write_attachment_bytes");
    expect(assetWrites, "资产没有写进附件库").toHaveLength(1);
    expect(assetWrites[0].args?.hash).toBe(assetHash);
    expect(assetWrites[0].args?.mime, "正文里声明了 image/png ⇒ 不该猜错").toBe("image/png");
    expect(assetWrites[0].args?.data).toEqual([...ASSET_BYTES]);

    // ── ③ 走"新建页"：create_page 恰好一次，父级＝当前文件夹，正文原样 ──
    const creates = host.commands.filter((c) => c.cmd === "create_page");
    expect(creates, "导入没有新建页面（那用户的东西去哪了？）").toHaveLength(1);
    const created = (creates[0].args?.args ?? {}) as Record<string, unknown>;
    expect(created.parent_id, "新页应该落在用户当前所在的文件夹里").toBe("folder-42");
    expect(created.title).toBe("导入的标题");
    expect(created.content_json, "新页没带正文（等于建了个空页）").toBe(contentJson);
    expect(String(created.content_text ?? "")).toContain("导入进来的正文");

    // ⛔ 任何 update/覆盖类命令都不许出现：owner 定的口径是"永远新建、同名也新建"
    expect(pageWrites(host), "导入路径出现了覆盖类写入 —— 违反「导入永远新建」").toEqual([]);

    // 新页要被打开（"导入了却看不到"＝用户眼里等于失败）
    expect(useNotes.getState().currentId).toBe(NEW_PAGE_ID);
  });

  it("② 失败：包不是 .shuyodoc ⇒ toast 里是 `openDocumentPackage` 的**原文**（逐字），且一页都不建", async () => {
    // 合法 zip，但没有 manifest.json ⇒ 走的是**真的**整包拒绝那条路
    const notAPackage = zipSync({ "content.json": strToU8("{}") });
    const host = installHost({ packageBytes: notAPackage });
    await mountAndClick();

    const expected = "包里没有 manifest.json（不是 .shuyodoc）";
    expect(wired.unzip).toBeGreaterThanOrEqual(1);
    expect(wired.open, "没走到整包校验就失败了（那就不是「原样显示 openDocumentPackage 的话」）").toBeGreaterThanOrEqual(1);

    // ⭐ 逐字相等：⛔ 不许加"导入失败："前缀、⛔ 不许换成笼统的话
    const shown = useToast.getState().toasts;
    const hit = shown.find((t) => t.message === expected);
    expect(hit, `toast 里没有那句原文（实际弹的是：${JSON.stringify(shown.map((t) => t.message))}）`).toBeTruthy();
    expect(hit?.kind).toBe("error");
    expect(shown.some((t) => t.message.startsWith("导入失败")), "被包了一层「导入失败：…」⇒ 不再是原文").toBe(false);

    expect(host.commands.filter((c) => c.cmd === "create_page"), "包是坏的却还是建了页").toHaveLength(0);
    expect(host.commands.filter((c) => c.cmd === "write_attachment_bytes"), "包是坏的却往库里写了资产").toHaveLength(0);
    // 借道的临时附件仍要清掉（失败也不许留垃圾）
    expect(host.commands.filter((c) => c.cmd === "remove_attachment").map((c) => c.args?.id)).toContain(TEMP_ATT_ID);
  });

  it("取消选文件 ⇒ 一页不建、什么都不写，如实说「已取消导入」", async () => {
    const host = installHost({ packageBytes: new Uint8Array(0), pickedPath: null });
    await mountAndClick();
    expect(toastMessages()).toContain("已取消导入");
    expect(host.commands.filter((c) => /create_page|write_attachment_bytes|import_attachment_files/.test(c.cmd))).toEqual([]);
  });
});
