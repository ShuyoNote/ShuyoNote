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
import { DownloadIcon, FileCodeIcon, PrintIcon, SearchIcon, UploadIcon, ContentWidthIcon, TemplateIcon, SendIcon, ListIcon, CommentIcon, BellIcon, MicIcon } from "./icons";
import { useSpeechInput } from "../editor/useSpeechInput";
import { useRightPanel } from "../store/rightPanel";
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
  // ⭐ 2026-10-02（owner）：「在页面顶端工具栏添加目录开关按钮」。
  // ⚠️ 目录那颗**已经在窗口标题栏**里了（`TopTools.tsx` ✓，2026-10-01 owner 拍板把右侧竖条搬过去 ✓）——
  //    这里再加一颗，是因为**笔记页这一排**才是手会自然落下的地方 ✓（标题栏那颗是 16px 图标，容易没注意 ✓）。
  // ⚠️ 两颗**共用同一个 store**（`useRightPanel` ✓）⇒ ⛔ 不会出现两份状态 ✗；store 内部本来就互斥
  //    （开目录会自动关掉 AI／讨论／插件面板 ✓）。⚠️ 订阅一律**取字段**，⛔ 不整店订阅 ✗（`check-store-subscriptions` 守这条 ✓）。
  const tocOpen = useRightPanel((s) => s.toc);
  const openToc = useRightPanel((s) => s.openToc);
  // ⭐ 2026-10-06（owner）：「点话筒按钮后说话自动转成文字插到笔记当前位置」✓
  //    —— 走 Web Speech API（Lexical playground 那颗话筒就是它 ✓，见 `src/lib/speechInput.ts` 头注 ✓）。
  //    ⚠️ hooks 一律在这一层取（早退不许越过 hooks ⇒ `check-hook-order` 守这条 ✓）。
  const speech = useSpeechInput();
  // ⭐ 2026-10-06（owner）：「关闭这个顶部工具栏」⇒ 顶端那四颗（AI／讨论／通知／目录）撤掉，
  //    出口补到**两处**：这一排的「⋯ 更多」菜单（可见 ✓）＋ 命令面板（键盘可及 ✓）。
  //    ⚠️ 只有「讨论 / 通知」是**必须**补的 —— 它们此前**只有**那条工具栏进得去
  //    （命令面板里当时没有对应命令，编辑器的 TOC 则另有入口 ✓）。
  //    ⚠️ 与「目录」那颗同一个 store（`useRightPanel` ✓）：store 内部互斥，⛔ 不会有两份状态 ✗。
  const openComments = useRightPanel((s) => s.openComments);
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
      {/* ⭐ 2026-10-06（owner）：「把这个话筒按钮放在页面顶部的工具栏最左边」✓ —— 所以它在**查找**之前 ✓。
          点一下开始听写、再点一下停 ✓；识别到的**定稿**文字插到光标处 ✓（`useSpeechInput` / `insertTextAtCaret` ✓）。
          ⚠️ 这套 API 在有些 WebView 里**整条不存在** ✗ ⇒ 点了会**如实**说一句人话（⛔ 不是静默没反应 ✗）。 */}
      <button
        className={`toolbar-btn${speech.listening ? " active is-recording" : ""}${speech.supported ? "" : " is-unsupported"}`}
        onClick={speech.toggle}
        title={
          speech.listening
            ? "语音输入：正在听（点击停止）"
            : speech.supported
              ? "语音输入：点击开始，说话会转成文字插到光标处"
              : "语音输入：这个外壳不带语音识别（点击看原因）"
        }
        aria-label="语音输入"
        aria-pressed={speech.listening}
      >
        <MicIcon />
      </button>
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
      {/* ⭐ 目录开关（2026-10-02 owner 要求）—— 写法照隔壁「内容宽度」那颗：`active` 类 ＋ 说明性 title ✓；
          额外补 `aria-pressed` ✓（读屏能念出这是开/关，而不是"一个按钮"✓）。 */}
      <button
        className={`toolbar-btn ${tocOpen ? "active" : ""}`}
        onClick={() => openToc(!tocOpen)}
        title={tocOpen ? "目录：已显示（点击隐藏）" : "目录：已隐藏（点击显示）"}
        aria-label="目录"
        aria-pressed={tocOpen}
      >
        <ListIcon />
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
            {/* ⭐ 2026-10-06：顶端工具栏撤掉后，「讨论 / 通知」的**可见**入口在这里
                （命令面板另有 `panels.comments` / `panels.notifications` 两条 ✓）。
                ⚠️ 这两颗与「目录」共用同一个右栏槽位 ⇒ 打开会顶掉目录/AI ✓（store 内部互斥 ✓）。 */}
            <button
              className="toolbar-menu-item"
              onClick={() => { setExportOpen(false); openComments(true, "comments"); }}
              title={t("editor.discuss")}
            >
              <CommentIcon /> {t("editor.discuss")}
            </button>
            <button
              className="toolbar-menu-item"
              onClick={() => { setExportOpen(false); openComments(true, "notifications"); }}
              title={t("editor.notifications")}
            >
              <BellIcon /> {t("editor.notifications")}
            </button>
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
