// 受控上传通道的**前端逻辑**（用户亲自选文件 → 走既有附件写入路径）。
//
// 三条硬口径：
//   ① ⛔ Agent 不能给路径：路径只来自 `platform.dialog.open`（系统文件选择框）；
//   ② 同名**不覆盖**（自动 `-N`）；>10MB ⇒ 明确 `needs_confirm`（本批限额，不静默收下）；
//   ③ 用户取消 ⇒ `cancelled`（⛔ 不静默成功/失败）。
import type { AttachmentMeta } from "../types";

/** 单文件上限（矩阵 §7：>10 MB 需用户确认）。 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export interface UploadDeps {
  pickFile: () => Promise<string | null>;
  importFiles: (pageId: string | null, paths: string[]) => Promise<AttachmentMeta[]>;
  listAttachments: (pageId: string | null) => Promise<AttachmentMeta[]>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export type UploadOutcome =
  | { kind: "ok"; attId: string; sha256: string; size: number; name: string }
  | { kind: "cancelled" }
  | { kind: "needs_confirm"; size: number; message: string }
  | { kind: "failed"; message: string };

/** 同名不覆盖：`报告.pdf` → `报告 (1).pdf`（⛔ 不覆盖既有附件）。 */
export function uniqueAttachmentName(wanted: string, taken: ReadonlySet<string>): string {
  if (!taken.has(wanted)) return wanted;
  const dot = wanted.lastIndexOf(".");
  const base = dot > 0 ? wanted.slice(0, dot) : wanted;
  const ext = dot > 0 ? wanted.slice(dot) : "";
  for (let i = 1; i < 1000; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${wanted}-${Date.now()}`;
}

/** 用户选文件 → 内容寻址入库（既有路径）→ 同名改名 → 返回 attId/sha/size。 */
export async function uploadAttachmentFromPicker(
  pageId: string,
  nameHint: string | undefined,
  deps: UploadDeps,
): Promise<UploadOutcome> {
  try {
    const path = await deps.pickFile();
    if (!path) return { kind: "cancelled" };
    const metas = await deps.importFiles(pageId, [path]);
    const meta = Array.isArray(metas) ? metas[0] : undefined;
    if (!meta?.hash) {
      return { kind: "failed", message: "文件没能读入（拿不到内容指纹）—— 换个位置再试" };
    }
    const size = Number(meta.size ?? 0);
    if (size > MAX_UPLOAD_BYTES) {
      // 先入库后判大小：>10MB ⇒ **不保留**（尽力清掉这一行，字节无引用时一并释放）
      await deps.remove(meta.id).catch(() => undefined);
      return {
        kind: "needs_confirm",
        size,
        message: `needs_confirm: 文件 ${size} 字节超过 10MB 上限（本批限额，未保留）`,
      };
    }
    const taken = new Set(
      (await deps.listAttachments(pageId)).filter((a) => a.id !== meta.id).map((a) => a.name),
    );
    const wanted = (nameHint ?? "").trim() || meta.name || "附件";
    const finalName = uniqueAttachmentName(wanted, taken);
    if (finalName !== meta.name) await deps.rename(meta.id, finalName);
    return { kind: "ok", attId: meta.id, sha256: meta.hash, size, name: finalName };
  } catch (e) {
    return {
      kind: "failed",
      message: `上传失败：${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
