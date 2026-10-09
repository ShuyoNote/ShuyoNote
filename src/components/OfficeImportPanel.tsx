// **应用内入口：导入 Office 文档（第一期只做 .docx）** —— Office 导入第一期 · 2026-10-09。
//
// ## 怎么挂（⛔ 挂载点不在本文件的写域里，由接线的人加一行 ✓）
// ```tsx
// import { OfficeImportPanel } from "./OfficeImportPanel";
// <OfficeImportPanel parentId={null} />
// ```
// 它**不是浮层**（没有以 `-overlay` / `-popover` 结尾的容器类名）⇒ 不需要登记返回栈，
// 也不会有"安卓返回键直接退出应用"那条问题 ✓（那一族要登记的是浮层，见 `check-overlay-registry` ✓）。
//
// ## 三步，每步都**如实**
//  ① 选文件 ⇒ 原文档作为**附件**入库（内容寻址：同一份选两次不会存两份 ✓）⇒ 读字节
//  ② 转换 ⇒ 打印**五类计数（源 → 转出）＋ 耗时**，⚠️ 提示逐条列出（这是"先给读数再落库" ✓）
//  ③ 点"导入为新笔记" ⇒ 走**现有**的 md → Lexical → 建页那条路 ✓
//
// ⛔ 转换失败**不建页**：面板上给一句人话（含失败码 ✓），⛔ 不静默建一个空笔记 ✗。
// ⛔ 图片没落库 ⇒ 正文里逐张留一行说明 ＋ 读数里计数 ✗ 不静默丢。

import { useState } from "react";

import { importOfficeBytes, type OfficeImportOutcome } from "../lib/office/importPipeline";
import { measureOne, renderRetentionReport, type RetentionRow } from "../lib/office/retention";
import { api } from "../lib/api";
import { platform } from "../lib/platform";
import { toast } from "../store/toast";

interface PickedFile {
  path: string;
  name: string;
  bytes: Uint8Array;
}

export function OfficeImportPanel({ parentId = null }: { parentId?: string | null }) {
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<PickedFile | null>(null);
  const [preview, setPreview] = useState<RetentionRow | null>(null);
  const [outcome, setOutcome] = useState<OfficeImportOutcome | null>(null);

  const pickFile = async () => {
    if (busy) return;
    setBusy(true);
    setOutcome(null);
    setPreview(null);
    setPicked(null);
    try {
      const selected = await platform.dialog.open({
        title: "选择 Office 文档（第一期只认 .docx）",
        filters: [{ name: "Word 文档", extensions: ["docx"] }],
        multiple: false,
      });
      if (!selected) return;
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (!path) return;
      // ① 原文档入库（内容寻址）⇒ 拿 hash ⇒ 读**解密后**的字节
      //    ⚠️ 读路径上的字节要用 `read_attachment_bytes`（E1 静态加密下直接读磁盘会拿到密文 ✓）
      const metas = await api.importAttachmentFiles(parentId, [String(path)]);
      const meta = metas[0];
      if (!meta?.hash) {
        toast("这个文件没能入库（拿不到内容指纹）⇒ 不继续", "error");
        return;
      }
      const buffer = await api.readAttachmentBytes(meta.hash);
      const bytes = new Uint8Array(buffer);
      const name = meta.name || String(path);
      setPicked({ path: String(path), name, bytes });
      // ② 转换（纯解析、不落库）⇒ 先把读数摆出来
      setPreview(measureOne(name, "面板预览：只转换、不建页", bytes));
    } catch (e) {
      toast(`读取文件失败：${e}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const confirmImport = async () => {
    if (busy || !picked) return;
    setBusy(true);
    try {
      const result = await importOfficeBytes(picked.bytes, picked.name, parentId, {
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
          // ⚠️ 懒引用 store（与 `store/filePreview.ts` 同一理由：顶层引会成环 ✓）
          const { useNotes } = await import("../store/notes");
          // ⚠️ 载荷**整份转交**（本文件不出现那两个存储列名 ⇒ 门禁 `check-doc-content-access` ✓）
          return useNotes.getState().createPage(parent, { title, ...payload });
        },
      });
      setOutcome(result);
      if (result.ok) {
        const lost = result.report.categories.filter((c) => c.retention !== null && c.retention < 1);
        if (lost.length > 0) {
          toast(
            `已导入，但有 ${lost.length} 类内容有丢失（${lost.map((c) => c.label).join("、")}）—— 见面板读数`,
            "info",
          );
        } else {
          toast("已导入为新笔记", "success");
        }
      } else {
        toast(`没导入：${result.message}`, "error");
      }
    } catch (e) {
      toast(`导入失败：${e}`, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="office-import" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <button className="office-import-pick" onClick={() => void pickFile()} disabled={busy}>
        {busy ? "处理中…" : "导入 Office 文档（.docx）"}
      </button>
      <div className="office-import-hint" style={{ opacity: 0.7, fontSize: 12 }}>
        第一期只做 .docx 单文件；原文档会作为附件存进库（同一份重复选不会存两份），再转成一页新笔记。
      </div>

      {picked && (
        <div className="office-import-file" style={{ fontSize: 12 }}>
          已选：{picked.name}（{(picked.bytes.length / 1024).toFixed(1)} KB）
        </div>
      )}

      {preview && (
        <pre
          className="office-import-preview"
          style={{ whiteSpace: "pre-wrap", fontSize: 12, margin: 0, maxHeight: 260, overflow: "auto" }}
        >
          {renderRetentionReport([preview])}
          {preview.ok ? "" : "\n⇒ 这份文档转不了，⛔ 不会建页。"}
        </pre>
      )}

      {preview?.ok && (
        <button className="office-import-confirm" onClick={() => void confirmImport()} disabled={busy}>
          导入为新笔记
        </button>
      )}

      {outcome && (
        <pre
          className="office-import-result"
          style={{ whiteSpace: "pre-wrap", fontSize: 12, margin: 0, maxHeight: 260, overflow: "auto" }}
        >
          {outcome.ok
            ? `已建页（id ${outcome.pageId}）\n${renderingSummary(outcome)}`
            : `没导入 [${outcome.code}]：${outcome.message}`}
        </pre>
      )}
    </div>
  );
}

/** 成功后的读数摘要（⛔ 与判据管道同源，不另写措辞 ✓）。 */
function renderingSummary(outcome: Extract<OfficeImportOutcome, { ok: true }>): string {
  const r = outcome.report;
  const lines: string[] = [];
  for (const c of r.categories) {
    if (c.source === 0) continue;
    lines.push(`   ${c.label}：${c.converted} / ${c.source}`);
  }
  lines.push(`   耗时：转换 ${r.ms.convert} ms，图片 ${r.ms.saveImages} ms，共 ${r.ms.total} ms`);
  if (r.images.referenced > 0) {
    lines.push(`   图片：引用 ${r.images.referenced} 处 ⇒ 进正文 ${r.images.saved} 张，失败 ${r.images.failed} 张`);
  }
  for (const w of r.warnings) lines.push(`   ⚠️ ${w}`);
  return lines.join("\n");
}
