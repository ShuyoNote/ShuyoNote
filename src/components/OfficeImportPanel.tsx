// **Office 导入的**结果面板**（第一期只做 .docx）—— Office 导入 · task-14 接线。
//
// ## 触发**只剩一条**（⭐ 2026-10-11 owner 拍板去掉按钮 ✓）
//  ⭐ **外部请求** ✗：`office-import://request`（双击 .docx ⇒ Rust 侧 `--import` ＋ 单实例转发 ✓）
//     ⇒ 同一个 `importOfficeFromPath` ⇒ **直接建页**，并把结果摆到面板上 ＋ 弹一句 ✓
//  ⛔⭐ **原来那颗右下角小按钮（`office-import-open`）已删** ✗ —— owner：「去掉右下角这个图示按钮」✓
//     ⭐ 人要点的话走**新建页面那儿的「从导入文件创建…」** ✓（⭐ 那条现在也吃 .docx ✓）。
//     ⚠️⭐ 顺带治了 CI：⭐ 那颗按钮在 390 视口下只有 **79×25** ✓ ⇒ ⭐ "命中端 ≥44"那条门禁一直判它不合格 ✓
//        （⭐ 2026-10-11 本机复现：⭐ `mobile-overlays` 5 失败 ＋ ⭐ `mobile-views` 1 失败 ✓，⭐ 都是它 ✓）。
//     ⚠️ 去掉按钮**不等于**去掉入口：⭐ 下面那个 `useEffect` 的订阅**必须留着** ✓（⭐ 否则双击就没反应了 ✓）。
//  ⚠️ 两条路**共用** `pathImport.ts` 的实现与 `requestBridge.ts` 的处理器 ⇒ ⛔ 不写第二份 ✓。
//
// ## 挂载（⛔ 只需一行 ⇒ 见 App.tsx 末尾）
// ```tsx
// <OfficeImportPanel parentId={null} />
// ```
// ⚠️ 它**不是浮层**：容器类名不以 `-overlay` / `-popover` 结尾 ⇒ 不需要登记返回栈，
//    也不会有"安卓返回键直接退出应用"那条问题 ✓（那一族要登记的是浮层 ✓）。
//    代价（如实）：它是 `position: fixed` 的小卡片，**没有**模态语义/背景遮罩 ✓。
//    ⭐ 并且**没请求就 `return null`** ✓ ⇒ ⭐ 平时一个像素都不占 ✓（⭐ 也不给门禁量到东西 ✓）。
//
// ## 三步都**如实**
//  ① 选文件 ⇒ 原文档作为**附件**入库（内容寻址：同一份选两次不会存两份 ✓）
//  ② 转换 ⇒ 打印**五类计数（源 → 转出）＋ 耗时**，⚠️ 提示逐条列出（先给读数再落库 ✓）
//  ③ 确认 ⇒ 走**现有**的 md → Lexical → 建页那条路 ✓
// ⛔ 转换/读取失败**不建页**：面板与 toast 都给人话（含失败码 ✓），⛔ 不静默 ✓。
// ⛔ 图片没落库 ⇒ 正文里逐张留一行说明 ＋ 读数里计数 ✗ 不静默丢 ✓。

import { useEffect, useState } from "react";

import { importOfficeBytes } from "../lib/office/importPipeline";
import { measureOne, renderRetentionReport, type RetentionRow } from "../lib/office/retention";
import { realOfficePathDeps, type OfficePathOutcome } from "../lib/office/pathImport";
import { mountOfficeImportRequests, realOfficeImportRequestHandler } from "../lib/office/requestBridge";
import { platform } from "../lib/platform";
import { toast } from "../store/toast";

interface PickedFile {
  path: string;
  name: string;
  bytes: Uint8Array;
}

export function OfficeImportPanel({ parentId = null }: { parentId?: string | null }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<PickedFile | null>(null);
  const [preview, setPreview] = useState<RetentionRow | null>(null);
  const [outcome, setOutcome] = useState<OfficePathOutcome | null>(null);

  /**
   * ⭐ 外部请求那一路（task-14 ②）：订阅 ⇒ 建页 ⇒ **把结果摆出来**（⛔ 不静默 ✓）。
   * ⚠️ 已知缺口（**冷启动**那条事件早于前端挂载 ⇒ 会丢）写在 `requestBridge.ts` 文件头 ✓。
   */
  useEffect(() => {
    let off: (() => void) | null = null;
    let disposed = false;
    const handle = realOfficeImportRequestHandler(parentId);
    void mountOfficeImportRequests(async (path) => {
      const result = await handle(path);
      setOutcome(result);
      setOpen(true);
      announce(result);
      return result;
    })
      .then((u) => {
        if (disposed) u();
        else off = u;
      })
      .catch((e) => {
        // ⛔ 不静默：订阅没装上也要说出来（否则"双击没反应"没人知道为什么 ✓）
        toast(`Office 导入：请求监听没装上（${e}）`, "error");
      });
    return () => {
      disposed = true;
      off?.();
    };
  }, [parentId]);

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
      // ① 原文档入库（内容寻址）⇒ 拿 hash ⇒ 读**解密后**的字节（与事件那条路**同一份**实现 ✓）
      const { name, bytes } = await realOfficePathDeps(parentId).fetchBytes(String(path));
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
      const deps = realOfficePathDeps(parentId);
      const result = await importOfficeBytes(picked.bytes, picked.name, parentId, deps.importDeps);
      // ⚠️ 这里**复用预览时已经读到的字节**（不再走一次 IPC ✓）；成功那一支补上 attachmentName
      //    以对齐 `OfficePathOutcome` 的形状（两条入口共用同一份"结果"类型 ✓）
      const asPathOutcome: OfficePathOutcome = result.ok
        ? { ...result, attachmentName: picked.name }
        : result;
      setOutcome(asPathOutcome);
      announce(asPathOutcome);
    } catch (e) {
      toast(`导入失败：${e}`, "error");
    } finally {
      setBusy(false);
    }
  };

  // ⛔ 这一句只在**结果出来之后**用（所以写在 hooks 之后 ✓，hooks 顺序不受影响 ✓）
  function announce(result: OfficePathOutcome): void {
    if (!result.ok) {
      toast(`没导入：${result.message}`, "error");
      return;
    }
    const lost = result.report.categories.filter((c) => c.retention !== null && c.retention < 1);
    if (lost.length > 0) {
      toast(`已导入，但有 ${lost.length} 类内容有丢失（${lost.map((c) => c.label).join("、")}）—— 见面板读数`, "info");
    } else {
      toast("已导入为新笔记", "success");
    }
  }

  // ⭐ 2026-10-11（owner：「去掉右下角这个图示按钮」）：⭐ **没请求就什么都不渲染** ✗ ——
  //    ⚠️ 只删那颗按钮**不够** ⇒ ⭐ 外面那个固定定位的 `office-import-dock` 还在 ✓（⭐ 白占一层 ✓，
  //       而且 ⭐ 门禁照样能量到它 ✓）。
  //    ⚠️⭐ **功能没丢** ✗：⭐ 外部那条 `office-import://request`（⭐ 双击 .docx ✓）仍在上面的 `useEffect` 里 ✓，
  //       ⭐ 请求一来就 `setOpen(true)` ⇒ ⭐ 面板照旧弹出来 ✓。
  //    ⭐ 顺手治了 CI：⭐ 那颗按钮在 390 视口下只有 **79×25** ✓ ⇒ ⭐ "命中区 ≥44"那条一直判它不合格 ✓
  //       （⭐ 本机复现：⭐ `mobile-overlays` 5 失败 ＋ ⭐ `mobile-views` 1 失败 ✓）。
  //    ⚠️ 这一句写在**所有 hooks 之后**（⭐ 与下面 `announce` 那条注记同一个理由 ✓）。
  if (!open) return null;

  return (
    <div
      className="office-import-dock"
      style={{ position: "fixed", right: 12, bottom: 12, zIndex: 60, maxWidth: 420 }}
    >
      <div
          className="office-import-card"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            padding: 10,
            borderRadius: 10,
            border: "1px solid var(--border, #d0d0d0)",
            background: "var(--panel-bg, #ffffff)",
            boxShadow: "0 6px 20px rgba(0,0,0,.18)",
            maxHeight: "70vh",
            overflow: "auto",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <strong className="office-import-title">导入 Office 文档</strong>
            <button className="office-import-close" onClick={() => setOpen(false)} title="收起">
              关闭
            </button>
          </div>

          <button className="office-import-pick" onClick={() => void pickFile()} disabled={busy}>
            {busy ? "处理中…" : "选择 .docx 文件"}
          </button>
          <div className="office-import-hint" style={{ opacity: 0.7, fontSize: 12 }}>
            第一期只做 .docx 单文件；原文档会作为附件存进库（同一份重复选不会存两份），再转成一页新笔记。
            ⚠️ 双击 .docx 唤起应用时也会走这里（前提：应用已经开着 ⇒ 见说明里的已知缺口）。
            {/* ⚠️ owner 2026-10-12（拍「甲：只把话说清」）：⭐ 老二进制 `.doc` **不在上面的 filter 里** ✗
                ⇒ 用户选不到 ⇒ **必须说清出路** ✓。⛔ 别把 `.doc` 加进 `extensions` ✗（导入链只解析 docx
                ⇒ 加了就是"选得到、然后失败"）。措辞与 `src/lib/extract/ooxml.ts:1108` **同口径** ✓。 */}
            ⚠️ 老格式 .doc 请先用 Word/WPS「另存为 .docx」再导入。
          </div>

          {picked && (
            <div className="office-import-file" style={{ fontSize: 12 }}>
              已选：{picked.name}（{(picked.bytes.length / 1024).toFixed(1)} KB）
            </div>
          )}

          {preview && (
            <pre
              className="office-import-preview"
              style={{ whiteSpace: "pre-wrap", fontSize: 12, margin: 0, maxHeight: 220, overflow: "auto" }}
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
              style={{ whiteSpace: "pre-wrap", fontSize: 12, margin: 0, maxHeight: 220, overflow: "auto" }}
            >
              {outcome.ok
                ? `已建页（id ${outcome.pageId}）\n${renderingSummary(outcome)}`
                : `没导入 [${outcome.code}]：${outcome.message}`}
            </pre>
          )}
        </div>
    </div>
  );
}

/** 成功后的读数摘要（⛔ 与判据管道同源，不另写措辞 ✓）。 */
function renderingSummary(outcome: Extract<OfficePathOutcome, { ok: true }>): string {
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
