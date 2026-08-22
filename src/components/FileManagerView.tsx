import { useMemo, useState } from "react";
import { useNotes } from "../store/notes";
import type { PageMeta } from "../types";
import { ChevronRightIcon, DatabaseIcon, FolderIcon, PageIcon } from "./icons";

const KIND_LABELS: Record<string, string> = {
  page: "页面",
  folder: "文件夹",
  database: "数据库",
};

function fmtDate(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function KindIcon({ kind }: { kind: string }) {
  if (kind === "folder") return <FolderIcon />;
  if (kind === "database") return <DatabaseIcon />;
  return <PageIcon />;
}

// FlowUs-style file manager: browse the page/folder hierarchy as a table with
// type + modified/created columns, and create pages/folders inside a folder.
export function FileManagerView() {
  const { pages, openPage, createPage, createFolder } = useNotes();
  const [folderId, setFolderId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const all = useMemo(() => pages.filter((p) => !p.deleted_at), [pages]);
  const entries = useMemo(
    () => all.filter((p) => p.parent_id === folderId),
    [all, folderId],
  );

  // Folders first, then by title.
  const sorted = useMemo(
    () =>
      [...entries].sort((a, b) => {
        const ak = a.kind === "folder" ? 0 : 1;
        const bk = b.kind === "folder" ? 0 : 1;
        if (ak !== bk) return ak - bk;
        return (a.title || "").localeCompare(b.title || "", "zh");
      }),
    [entries],
  );

  // Breadcrumb chain from root to the current folder.
  const crumb = useMemo(() => {
    const chain: PageMeta[] = [];
    let cur = folderId ? all.find((p) => p.id === folderId) : undefined;
    while (cur) {
      chain.unshift(cur);
      cur = cur.parent_id ? all.find((p) => p.id === cur!.parent_id) : undefined;
    }
    return chain;
  }, [all, folderId]);

  const toggleSelect = (id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const newFolder = () => createFolder(folderId);
  // createPage navigates to the editor with the new page already open.
  const newPage = () => createPage(folderId);

  return (
    <div className="file-manager">
      <div className="file-manager-head">
        <div className="file-manager-title-block">
          <span className="file-manager-bigicon">🗂</span>
          <h1 className="file-manager-title">文件管理</h1>
        </div>
        <div className="file-manager-actions">
          <button className="fm-btn" onClick={newFolder}>
            ＋ 新建文件夹
          </button>
          <button className="fm-btn fm-btn-primary" onClick={newPage}>
            ＋ 新建页面
          </button>
        </div>
      </div>

      <div className="file-manager-toolbar">
        <div className="fm-breadcrumb">
          <button
            className={`fm-crumb ${folderId === null ? "fm-crumb-active" : ""}`}
            onClick={() => setFolderId(null)}
          >
            全部
          </button>
          {crumb.map((c) => (
            <span key={c.id} className="fm-crumb-step">
              <ChevronRightIcon width={12} height={12} />
              <button
                className={`fm-crumb ${c.id === folderId ? "fm-crumb-active" : ""}`}
                onClick={() => setFolderId(c.id)}
              >
                {c.title || "未命名"}
              </button>
            </span>
          ))}
        </div>
        <span className="fm-count">{sorted.length} 项</span>
      </div>

      <div className="file-manager-table-wrap">
        <table className="file-manager-table">
          <thead>
            <tr>
              <th className="fm-check-col">
                <input type="checkbox" />
              </th>
              <th className="fm-name-col">文件名</th>
              <th className="fm-kind-col">类型</th>
              <th>上次修改时间</th>
              <th>创建时间</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((p) => (
              <tr
                key={p.id}
                className={selected.has(p.id) ? "fm-row-selected" : ""}
                onClick={() => toggleSelect(p.id)}
              >
                <td className="fm-check-col">
                  <input
                    type="checkbox"
                    checked={selected.has(p.id)}
                    onChange={() => toggleSelect(p.id)}
                    onClick={(e) => e.stopPropagation()}
                  />
                </td>
                <td className="fm-name-col">
                  <button
                    className="fm-name-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (p.kind === "folder") setFolderId(p.id);
                      else openPage(p.id);
                    }}
                  >
                    <span className="fm-kind-icon"><KindIcon kind={p.kind} /></span>
                    <span className="fm-name">{p.title || "未命名"}</span>
                  </button>
                </td>
                <td className="fm-kind-col">{KIND_LABELS[p.kind] ?? p.kind}</td>
                <td className="fm-date">{fmtDate(p.updated_at)}</td>
                <td className="fm-date">{fmtDate(p.created_at)}</td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td className="fm-empty" colSpan={5}>
                  {folderId === null ? "没有内容，点击右上角新建" : "此文件夹为空"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
