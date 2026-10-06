import { useEffect, useState } from "react";
import { $createParagraphNode, $getRoot, type ElementNode } from "lexical";
import { useNotes } from "../store/notes";
import { useEditorStore } from "../store/editor";
import { useViewStore } from "../store/view";
import { useAiStore } from "../store/ai";
import { useRightPanel } from "../store/rightPanel";
import { MarkdownImportDialog } from "./MarkdownImportDialog";
import {
  SparkleIcon,
  TemplateIcon,
  DownloadIcon,
  TableIcon,
  BoardIcon,
  GalleryIcon,
  ListIcon,
  CalendarIcon,
  TimelineIcon,
  DirectoryIcon,
} from "./icons";

// ⚠️ **2026-10-06（owner）：「去掉新手清单」** —— 原先这下面还有一块
//   `.first-steps`「新手清单 · 点一下即上手」（五步：新建页面 / 开始输入 / 建数据表格 /
//   看快捷键 / 试 AI，勾选状态存 `localStorage["shuyonote-firststeps"]`）**整块撤掉** ✓。
//   理由：这是一张空白页面上的**起手式**面板，而"清单"把它变成了一个**待办列表** ——
//   与"开始写"这件事抢注意力（同一页上已经有那句「点这里开始编辑」＋ 三个起手式了）。
//   ⚠️ 用户浏览器里那条 `shuyonote-firststeps` 键**留着不动**：读它的人没了、它也不再增长，
//   删它属于"动用户的 localStorage"，收益为零（几十字节）⇒ 不删 ✓。
//   ⛔ 别把清单从别处再拉回来：要"教新用户"就走使用指南页（`lib/guide.ts`）与快捷键面板 ✓。

// Empty-state guide for a fresh page (Notion-style): a subtitle, an action list,
// and a "create as database" view row.
export function NewPageGuide() {
  const [dismissed, setDismissed] = useState(false);
  const [importing, setImporting] = useState(false);
  const editor = useEditorStore((s) => s.editor);
  // Show the "用 AI 开始创作" action only when the AI feature is enabled.
  const aiEnabled = useAiStore((s) => s.config.enabled);

  // Start editing: dismiss the guide, ensure a paragraph block exists, and place
  // the caret in it.
  const startEditing = () => {
    setDismissed(true);
    if (!editor) return;
    editor.update(() => {
      const root = $getRoot();
      let block = root.getChildren()[0] as ElementNode | undefined;
      if (!block) {
        block = $createParagraphNode();
        root.append(block);
      }
      block.selectStart();
    });
    editor.focus();
  };

  // Press Enter (anywhere while the guide shows) to start editing.
  useEffect(() => {
    if (dismissed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        startEditing();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dismissed]);

  const importMarkdown = () => setImporting(true);

  const views = [
    { key: "table", name: "表格", Icon: TableIcon },
    { key: "board", name: "看板", Icon: BoardIcon },
    { key: "gallery", name: "画廊", Icon: GalleryIcon },
    { key: "list", name: "列表", Icon: ListIcon },
    { key: "calendar", name: "日历", Icon: CalendarIcon },
    { key: "timeline", name: "时间轴", Icon: TimelineIcon },
    { key: "directory", name: "目录", Icon: DirectoryIcon },
  ];

  return (
    <>
      {!dismissed && (
        <div className="new-page-guide" onMouseDown={(e) => e.stopPropagation()}>
        {/* ⚠️ 这一行**本身就是入口**，不只是提示（2026-09-13 真机暴露的问题）：
            手机上**没有回车键**，而空页面上没有任何元素有焦点 ⇒ 按 Enter 无处置放，
            用户进不去编辑态。原文案"回车开始编辑"是桌面假设。
            现在点它就开始编辑；桌面按回车那条路仍然保留（键盘处理没动）。 */}
        <div
          className="new-page-guide-desc"
          role="button"
          tabIndex={0}
          onClick={startEditing}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              startEditing();
            }
          }}
        >
          点这里开始编辑，或者从下方选择
        </div>
        <div className="new-page-guide-list">
            {aiEnabled && (
              <button className="npg-act" onClick={() => useRightPanel.getState().openAi(true)}>
                <SparkleIcon className="npg-act-icon" /> 用 AI 开始创作
              </button>
            )}
            <button className="npg-act" onClick={() => useViewStore.getState().setView("templates")}>
              <TemplateIcon className="npg-act-icon" /> 从模板中心创建...
            </button>
            <button className="npg-act" onClick={importMarkdown}>
              <DownloadIcon className="npg-act-icon" /> 从导入文件创建...
            </button>
          </div>
          <div className="new-page-guide-db">
            <div className="npg-db-title">创建为数据表格</div>
            <div className="npg-db-row">
              {views.map((v) => (
                <button
                  key={v.key}
                  className="npg-db-item"
                  title={`创建${v.name}数据库`}
                  onClick={() => void useNotes.getState().createDatabase(null)}
                >
                  <v.Icon className="npg-db-icon" />
                  <span className="npg-db-name">{v.name}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {importing && <MarkdownImportDialog onClose={() => setImporting(false)} />}
      </>
  );
}
