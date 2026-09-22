import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { $convertToMarkdownString } from "@lexical/markdown";
import { $generateHtmlFromNodes } from "@lexical/html";
import { platform, isDesktopPlatform } from "../lib/platform";
import { api } from "../lib/api";
import { useEditorStore } from "../store/editor";
import { useViewStore } from "../store/view";
import { useTemplates } from "../store/templates";
import { toast } from "../store/toast";
import { HistoryPanel } from "./HistoryPanel";
import { DownloadIcon, FileCodeIcon, PrintIcon, SearchIcon, UploadIcon, ContentWidthIcon, TemplateIcon, SendIcon } from "./icons";
import { SHUYONOTE_TRANSFORMERS } from "../editor/markdownTransformers";
import { MarkdownImportDialog } from "./MarkdownImportDialog";
import { CommunityPublishDialog } from "./CommunityPublishDialog";
import { PluginMenuItems } from "./PluginMenuItems";
import { docHtml, printDoc } from "../lib/print";
import { inlineExportMedia } from "../lib/exportInline";

/**
 * 「发布到社区」要的字段。
 *
 * **正文与"发的是哪一份内容"必须同源**：这里只给页面快照的文档 JSON，**不给指纹** ——
 * 指纹由发布对话框按这份快照现算（`community_content_rev`）。在外面另算一个指纹递进去，
 * 就多了一处"正文与指纹错位"的缝：错位时社区会把第二次发布当成重放而**静默丢掉**。
 *
 * 为什么传 `docJson` 而不是算好的 `body`：发布对话框要用**同一份来源**算两份正文
 * （清单里那份、换过图片地址发出去的那份），指纹也必须按**本地态**那一份算。
 * 这里先算一份 Markdown 递进去，等于把图片地址在对话框之外就定死了 —— 上传结果就换不进去了。
 */
interface PublishTarget {
  title: string;
  docJson: string;
  tags: string[];
  noteId: string;
}

function triggerFind() {
  // The find bar listens for Ctrl+F on document; simulate it.
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }),
  );
}

export function EditorToolbar({ pageId }: { pageId: string }) {
  const { t } = useTranslation();
  const editor = useEditorStore((s) => s.editor);
  const [importing, setImporting] = useState(false);
  const contentWidth = useViewStore((s) => s.contentWidth);
  const setContentWidth = useViewStore((s) => s.setContentWidth);
  const [exportOpen, setExportOpen] = useState(false);
  const [publishTarget, setPublishTarget] = useState<PublishTarget | null>(null);

  // Apply the adaptive-width body class so content fills the available width.
  useEffect(() => {
    document.body.classList.toggle("content-full", contentWidth === "full");
    return () => document.body.classList.remove("content-full");
  }, [contentWidth]);
  // 点击「⋯」菜单以外区域关闭。
  useEffect(() => {
    if (!exportOpen) return;
    const onDown = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest(".editor-toolbar-more, .editor-more-menu")) return;
      setExportOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [exportOpen]);

  const toggleWidth = () =>
    setContentWidth(contentWidth === "full" ? "centered" : "full");

  const exportMarkdown = () => {
    if (!editor) return;
    editor.update(() => {
      const markdown = $convertToMarkdownString(SHUYONOTE_TRANSFORMERS);
      navigator.clipboard
        .writeText(markdown)
        .then(() => toast("已复制 Markdown 到剪贴板", "success"))
        .catch(() => toast("复制失败", "error"));
    });
  };

  const exportHtml = async () => {
    if (!editor) return;
    try {
      const path = await platform.dialog.save({
        title: "导出 HTML",
        defaultPath: "note.html",
        filters: [{ name: "HTML", extensions: ["html"] }],
      });
      if (!path) return;
      let body = "";
      let title = "未命名";
      editor.read(() => {
        body = $generateHtmlFromNodes(editor);
        title = (document.querySelector(".title-input") as HTMLInputElement | null)?.value || "未命名";
      });
      // 先把 body 里的图片/缩略图内联成 data: URL，**再**包成完整文档 ——
      // 反过来会把 <head>/<style> 丢掉（`inlineExportMedia` 只处理片段、返回片段）。
      const { html: inlinedBody, report } = await inlineExportMedia(body);
      const html = docHtml(inlinedBody, { title });
      await api.writeTextFile(path, html);
      if (report.missing > 0) {
        toast(`已导出 HTML（${report.missing} 张图片的字节不在本机，未能内联）`, "info");
      } else if (report.tooLarge > 0) {
        toast(`已导出 HTML（${report.tooLarge} 个附件超过 8MB，未内联）`, "info");
      } else {
        toast("已导出 HTML", "success");
      }
    } catch (e) {
      toast(`导出失败：${e}`, "error");
    }
  };

  const exportPdf = () => {
    if (!editor) return;
    let body = "";
    let title = "未命名";
    editor.read(() => {
      body = $generateHtmlFromNodes(editor);
      title = (document.querySelector(".title-input") as HTMLInputElement | null)?.value || "未命名";
    });
    // 两步都是必须的：
    //   ① 内联媒体 —— 打印是一次性快照，`attachment://` 取不到就是空白；
    //   ② 等图片就绪再开打印对话框（这一步在 printDoc 里做）。
    void (async () => {
      try {
        const { html: inlined } = await inlineExportMedia(body);
        await printDoc(inlined, { title });
      } catch (e) {
        toast(`导出失败：${e}`, "error");
      }
    })();
  };

  const importMarkdown = () => setImporting(true);

  /**
   * 「发布到社区」：这一步**只组装清单**，一个字节都不发出去。
   * 真正的发送在 `CommunityPublishDialog` 里，且必须由人点「确认发布」（I7）。
   */
  const openPublishDialog = async () => {
    setExportOpen(false);
    try {
      // 5 个字段**一次读齐**（同一次 get_page 快照）。
      const page = await api.getPage(pageId);
      if (page.kind !== "page") {
        toast("只有普通笔记能发布到社区", "error");
        return;
      }
      // 标签失败不该挡住发布：没有标签也能发（少一项，不是错误）。
      const tags = await api
        .pageTags(pageId)
        .then((ts) => ts.map((t) => t.name))
        .catch(() => [] as string[]);
      setPublishTarget({
        title: page.title || "",
        // 正文传**页面快照的文档 JSON**（不是编辑器的实时状态）：实时状态可能比这次
        // 快照新一次防抖（600ms）。快照 → Markdown 的转换、以及**这一份内容的内容指纹**，
        // 都由发布对话框自己按这份快照算（清单、指纹、发出去的正文三者同源）。
        docJson: page.content_json || "{}",
        tags,
        // `noteId` = 页面 id（`PageDetail.id`）：与内容指纹一起算幂等键（I2）。
        // 指纹不再从这里传 —— 它必须由对话框按上面那份 `docJson` 现算，见 `PublishTarget` 的注释。
        noteId: page.id,
      });
    } catch (e) {
      toast(`打开发布清单失败：${e}`, "error");
    }
  };

  const saveAsTemplate = async () => {
    try {
      const page = await api.getPage(pageId);
      if (!page || (page.kind !== "page" && page.kind !== "database")) {
        toast("当前不是可保存为模板的页面", "error");
        return;
      }
      // 数据库模板：补上列定义(database_json)与 kind，创建时才能还原列。
      let kind = "page";
      let database_json = "{}";
      if (page.kind === "database") {
        kind = "database";
        try {
          const q = await api.queryDatabase(pageId);
          database_json = JSON.stringify({ columns: (q?.columns ?? []).map((c) => ({ name: c.name, type: c.attr_type, options: c.options ?? [] })) });
        } catch { /* keep {} */ }
      }
      const ok = await useTemplates
        .getState()
        .saveAs({ name: page.title || "未命名", content_json: page.content_json, content_text: page.content_text, cover: page.cover, icon: page.icon, kind, database_json });
      if (ok) toast(`已保存为模板「${page.title || "未命名"}」`, "success");
      else toast("保存失败", "error");
    } catch (e) {
      toast(`保存失败：${e}`, "error");
    }
  };

  return (
    <div className="editor-toolbar">
      <button className="toolbar-btn" onClick={triggerFind} title={t("editor.find")}>
        <SearchIcon />
      </button>
      <button className="toolbar-btn" onClick={importMarkdown} title={t("editor.importMarkdown")}>
        <DownloadIcon />
      </button>
      <button className="toolbar-btn" onClick={saveAsTemplate} title={t("editor.saveAsTemplate")}>
        <TemplateIcon />
      </button>
      <button
        className={`toolbar-btn ${contentWidth === "full" ? "active" : ""}`}
        onClick={toggleWidth}
        title={contentWidth === "full" ? "内容宽度：自适应（点击恢复居中）" : "内容宽度：居中（点击自适应全宽）"}
      >
        <ContentWidthIcon />
      </button>
      <HistoryPanel pageId={pageId} />
      <div className="editor-toolbar-more">
        <button
          className="toolbar-btn"
          onClick={() => setExportOpen((v) => !v)}
          title={t("editor.more")}
        >
          ⋯
        </button>
        {exportOpen && (
          <div className="editor-more-menu">
            <button className="toolbar-menu-item" onClick={() => { setExportOpen(false); exportMarkdown(); }} title={t("editor.exportMarkdown")}>
              <UploadIcon /> {t("editor.exportMarkdown")}
            </button>
            <button className="toolbar-menu-item" onClick={() => { setExportOpen(false); exportHtml(); }} title={t("editor.exportHtml")}>
              <FileCodeIcon /> {t("editor.exportHtml")}
            </button>
            <button className="toolbar-menu-item" onClick={() => { setExportOpen(false); exportPdf(); }} title={t("editor.exportPdf")}>
              <PrintIcon /> {t("editor.exportPdf")}
            </button>
            {/* 一键发布到社区：入口先放这里（方案 §5：「先放详情/编辑器工具条一枚」，P1 再考虑右键菜单）。
                只在 Tauri 壳（有 Rust 内核 ⇒ 有应用数据目录放令牌、有不被 CORS 拦的出口）里显示；
                Web 版那 4 条命令会如实抛「不支持」（`web.ts`），与其给一个"看起来能连、实际发不出去"
                的假入口，不如不显示 —— 与插件/同步那些桌面专属入口同一条做法。 */}
            {isDesktopPlatform() && (
              <button
                className="toolbar-menu-item"
                onClick={() => void openPublishDialog()}
                title="发布到社区"
              >
                <SendIcon /> 发布到社区
              </button>
            )}
            {/* 插件命令（`menus: ["editor.toolbar"]`）：放在这里而不是那排图标按钮上——
                插件给不出图标，一排一模一样的 🔌 反而更难认；这里的文字项正合适。
                pageId 传的是**正在编辑的这一页**，所以省略 pageId 的能力调用作用在它身上。 */}
            <PluginMenuItems
              menuId="editor.toolbar"
              pageId={pageId}
              itemClass="toolbar-menu-item"
              onDone={() => setExportOpen(false)}
            />
          </div>
        )}
      </div>
      {importing && <MarkdownImportDialog onClose={() => setImporting(false)} />}
      {publishTarget && (
        <CommunityPublishDialog
          {...publishTarget}
          // 关掉即卸载 ⇒ 组件里的轮询 interval 一起停（见 `CommunityPublishDialog`）。
          onClose={() => setPublishTarget(null)}
        />
      )}
    </div>
  );
}
