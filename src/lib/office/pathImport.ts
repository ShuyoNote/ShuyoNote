// **文件路径 ⇒ 新笔记页**（task-14）—— 把"用户选到一个 .docx 路径"与"收到 `office-import` 请求"
// **两条触发**收敛到**同一条实现**上 ✓（⛔ 不写第二份 ✓）。
//
// ## 与 `importPipeline.ts` 的分工
//   `importPipeline.ts`：字节 ⇒ 块 ⇒ Markdown ⇒ Lexical ⇒ 建页（**纯编排，依赖注入** ✓）
//   本文件：**再加一步"路径 ⇒ 字节"**（① 原文档作为**附件**入库（内容寻址，重复选不会存两份 ✓）
//   ⇒ ② 读回**解密后**的字节）⇒ 然后交给上面那条链 ✓
//
// ⚠️ **不要用 `read_text_file` 读二进制** ✗：E1 静态加密开着时它读到的是**密文**，
//    而 `read_attachment_bytes` 是按 hash 读、会解密 ✓（这条口径与 `store/filePreview.ts` 一致 ✓）。
//
// ## 失败姿态（与两条触发同一份口径 ✓）
// ⛔ **本层不抛异常**：读不到字节也返回 `{ ok:false, code:"fetch_failed", message }` ✓
//   ⇒ 于是"失败要如实说、⛔ 不静默吞掉"在**面板**与**事件**两条路上是同一段代码 ✓。

import { api } from "../api";
// ⭐ task-14（2026-11-01）：**office-import 被禁用 ⇒ 在这里就把导入拒掉**。
//    ⚠️ 拦在**这一处**是刻意的：三条触发（双击 .docx 的事件、面板里选文件、「新建页 → 从导入文件创建…」）
//    全都收敛到 `importOfficeFromPath` ⇒ 只判一次，就没有"漏掉一条入口"的缺口。
import { OFFICE_IMPORT_ABILITY_ID, isAbilityEnabled } from "../abilities/state";
import {
  importOfficeBytes,
  type OfficeImportDeps,
  type OfficeImportReport,
} from "./importPipeline";

export interface OfficePathDeps {
  /** 路径 ⇒ 附件名 ＋ 字节（真实现见 `realOfficePathDeps`；判据里换成假的 ✓）。 */
  fetchBytes: (path: string) => Promise<{ name: string; bytes: Uint8Array }>;
  importDeps: OfficeImportDeps;
}

export type OfficePathOutcome =
  | { ok: true; pageId: string | null; report: OfficeImportReport; attachmentName: string }
  | { ok: false; code: string; message: string; warnings: string[] };

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 一份**路径** ⇒ 一个新笔记页（两条触发共用 ✓）。
 * ⛔ 空字节 / 读不到 / 转换失败 ⇒ 一律 `{ ok:false, code, message }`，**绝不建页** ✓。
 */
export async function importOfficeFromPath(
  path: string,
  parentId: string | null,
  deps: OfficePathDeps,
): Promise<OfficePathOutcome> {
  // ⭐ task-14：这一项被用户在「设置 → 能力」里禁用了 ⇒ **从这里就拒**（⛔ 不建页、⛔ 附件也不入库）。
  //    ⚠️ 位置在 `fetchBytes` **之前**：禁用了就连附件都不该先存一份、再说"其实没导入" ✗。
  //    ⚠️ `isAbilityEnabled` 读不到状态 ⇒ `true`（fail-open）⇒ 命令面抽风**不会**挡住宿主导入；
  //       而"禁用"的强制一面在 Rust（`dictionary_*`）与这里（office-import）各负其责。
  if (!(await isAbilityEnabled(OFFICE_IMPORT_ABILITY_ID))) {
    return {
      ok: false,
      code: "ability-disabled",
      message:
        "「Word 导入」这一项在「设置 → 能力」里被停用了 ⇒ 这次没有导入任何东西（在那里启用后即可恢复）。",
      warnings: [],
    };
  }
  let got: { name: string; bytes: Uint8Array };
  try {
    got = await deps.fetchBytes(path);
  } catch (e) {
    // ⭐ 原因**原样**带出来（用户/日志要看到是哪一步、为什么 ✓）
    return { ok: false, code: "fetch_failed", message: `读不到这个文件：${messageOf(e)}`, warnings: [] };
  }
  if (!got || got.bytes.length === 0) {
    return {
      ok: false,
      code: "empty_file",
      message: `这个文件是空的（0 字节）⇒ 不建页（⛔ 不生成空笔记）`,
      warnings: [],
    };
  }
  const name = got.name || path;
  const outcome = await importOfficeBytes(got.bytes, name, parentId, deps.importDeps);
  if (!outcome.ok) {
    return { ok: false, code: outcome.code, message: outcome.message, warnings: outcome.warnings };
  }
  return { ok: true, pageId: outcome.pageId, report: outcome.report, attachmentName: name };
}

/**
 * **真实现**：附件库（内容寻址）＋ 解密后读字节 ＋ 落库建页。
 * ⚠️ 这一层**不做任何判断**（判不判得了由上面那条链决定 ✓）；只把 IPC 接上 ✓。
 */
export function realOfficePathDeps(parentId: string | null): OfficePathDeps {
  return {
    fetchBytes: async (path) => {
      const metas = await api.importAttachmentFiles(parentId, [path]);
      const meta = metas[0];
      if (!meta?.hash) throw new Error("这个文件没能入库（拿不到内容指纹）");
      const bytes = new Uint8Array(await api.readAttachmentBytes(meta.hash));
      return { name: meta.name || path, bytes };
    },
    importDeps: {
      saveImage: async (image) => {
        const saved = await api.saveImage({
          page_id: parentId,
          name: image.name,
          mime: image.mime,
          data: Array.from(image.bytes),
        });
        return saved.hash;
      },
      createPage: async ({ parentId: parent, title, payload }) => {
        // ⚠️ 懒引用 store（与 `store/filePreview.ts` 同一理由：顶层引会成环 ✓）；
        //    路径是 `src/store/notes.ts`（本文件在 `src/lib/office/` ⇒ **上两级** ✓）
        const { useNotes } = await import("../../store/notes");
        // ⚠️ 载荷**整份转交**（本文件不出现那两个存储列名 ⇒ 门禁 `check-doc-content-access` ✓）
        return useNotes.getState().createPage(parent, { title, ...payload });
      },
    },
  };
}
