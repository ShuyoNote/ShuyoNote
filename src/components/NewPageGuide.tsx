import { useEffect, useState } from "react";
import { $createParagraphNode, $getRoot, type ElementNode } from "lexical";
import { useNotes } from "../store/notes";
import { useEditorStore } from "../store/editor";
import { toast } from "../store/toast";
import { useTemplateCenterStore } from "../store/templateCenter";
import { useAiStore } from "../store/ai";
import { useRightPanel } from "../store/rightPanel";
import { MarkdownImportDialog } from "./MarkdownImportDialog";
import {
  SparkleIcon,
  TemplateIcon,
  UploadIcon,
  PersonIcon,
  TableIcon,
  BoardIcon,
  GalleryIcon,
  ListIcon,
  CalendarIcon,
  TimelineIcon,
  DirectoryIcon,
} from "./icons";

// M25 P1 — a small first-experience checklist on the empty-page onboarding.
// Persisted in localStorage so completed steps stay checked across sessions.
const FIRST_STEPS_KEY = "shuyonote-firststeps";
const FIRST_STEPS = [
  { id: "new-page", label: "新建页面（Ctrl+N）" },
  { id: "slash", label: "输入 / 插入块（分栏 / 表格 / 绘图…）" },
  { id: "db", label: "从下方创建一个数据表格" },
  { id: "shortcuts", label: "看快捷键（Ctrl+/ 或 ?）" },
  { id: "ai", label: "试试 AI 助手（在设置里启用后）" },
];

function FirstSteps() {
  const [done, setDone] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(FIRST_STEPS_KEY) || "{}");
    } catch {
      return {};
    }
  });

  const toggle = (id: string) => {
    setDone((d) => {
      const next = { ...d, [id]: !d[id] };
      try {
        localStorage.setItem(FIRST_STEPS_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  };

  return (
    <div className="first-steps">
      <div className="first-steps-title">新手清单</div>
      {FIRST_STEPS.map((s) => (
        <label key={s.id} className="first-step">
          <input type="checkbox" checked={!!done[s.id]} onChange={() => toggle(s.id)} />
          <span className={done[s.id] ? "done" : ""}>{s.label}</span>
        </label>
      ))}
    </div>
  );
}

// Empty-state guide for a fresh page (Notion-style): a subtitle, an action list,
// and a "create as database" view row.
export function NewPageGuide() {
  const { createDatabase } = useNotes();
  const [dismissed, setDismissed] = useState(false);
  const [importing, setImporting] = useState(false);
  const editor = useEditorStore((s) => s.editor);
  // Show the "用 AI 开始创作" action only when the AI feature is enabled.
  const aiEnabled = useAiStore((s) => s.config.enabled);

  // Press Enter (anywhere while the guide shows) to start editing: dismiss the
  // guide, ensure a paragraph block exists, and place the caret in it.
  useEffect(() => {
    if (dismissed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
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
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dismissed, editor]);

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
        <div className="new-page-guide-desc">回车开始编辑，或者从下方选择</div>
        <div className="new-page-guide-list">
            {aiEnabled && (
              <button className="npg-act" onClick={() => useRightPanel.getState().openAi(true)}>
                <SparkleIcon className="npg-act-icon" /> 用 AI 开始创作
              </button>
            )}
            <button className="npg-act" onClick={() => useTemplateCenterStore.getState().setOpen(true)}>
              <TemplateIcon className="npg-act-icon" /> 从模板中心创建...
            </button>
            <button className="npg-act" onClick={importMarkdown}>
              <UploadIcon className="npg-act-icon" /> 从导入文件创建...
            </button>
            <button className="npg-act" onClick={() => toast("个人模板即将推出", "info")}>
              <PersonIcon className="npg-act-icon" /> 设置个人模板
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
                  onClick={() => createDatabase(null)}
                >
                  <v.Icon className="npg-db-icon" />
                  <span className="npg-db-name">{v.name}</span>
                </button>
              ))}
            </div>
          </div>
          <FirstSteps />
        </div>
      )}
      {importing && <MarkdownImportDialog onClose={() => setImporting(false)} />}
      </>
  );
}
