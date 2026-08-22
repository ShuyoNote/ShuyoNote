import { useState } from "react";
import { useNotes } from "../store/notes";
import { toast } from "../store/toast";
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

// Empty-state guide for a fresh page (Notion-style): a subtitle, an action list,
// and a "create as database" view row.
export function NewPageGuide() {
  const { createDatabase } = useNotes();
  const [importing, setImporting] = useState(false);

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
      <div className="new-page-guide" onMouseDown={(e) => e.stopPropagation()}>
        <div className="new-page-guide-desc">回车开始编辑，或者从下方选择</div>
          <div className="new-page-guide-list">
            <button className="npg-act" onClick={() => toast("AI 创作即将推出", "info")}>
              <SparkleIcon className="npg-act-icon" /> 用 AI 开始创作
            </button>
            <button className="npg-act" onClick={() => toast("模板中心即将推出", "info")}>
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
        </div>
        {importing && <MarkdownImportDialog onClose={() => setImporting(false)} />}
      </>
  );
}
