import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { useNotes } from "../store/notes";
import { useSidebar } from "../store/sidebar";
import { toast } from "../store/toast";
import { tagColor } from "../lib/tagColor";
import type { PageMeta } from "../types";
import { SearchPanel } from "./SearchPanel";
import { SyncPanel } from "./SyncPanel";
import { TrashPanel } from "./TrashPanel";
import { BackupButton } from "./BackupButton";
import { ThemeToggle } from "./ThemeToggle";

interface TreeNode extends PageMeta {
  children: TreeNode[];
}

function buildTree(pages: PageMeta[]): TreeNode[] {
  const map = new Map<string, TreeNode>();
  for (const p of pages) map.set(p.id, { ...p, children: [] });
  const roots: TreeNode[] = [];
  for (const p of map.values()) {
    if (p.parent_id && map.has(p.parent_id)) {
      map.get(p.parent_id)!.children.push(p);
    } else {
      roots.push(p);
    }
  }
  const sortRec = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => a.sort_order - b.sort_order || a.created_at - b.created_at);
    for (const n of nodes) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}

function TreeItem({
  node,
  depth,
}: {
  node: TreeNode;
  depth: number;
}) {
  const { currentId, openPage, createPage, createFolder, deletePage, movePage, renamePage, pages } = useNotes();
  const [expanded, setExpanded] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(node.title);

  const isCurrent = currentId === node.id;
  const isFolder = node.kind === "folder";

  const commitRename = async () => {
    const v = editValue.trim();
    setEditing(false);
    if (v && v !== node.title) {
      await renamePage(node.id, v);
    } else {
      setEditValue(node.title);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const id = e.dataTransfer.getData("text/plain");
    if (!id || id === node.id) return;

    // Insert before or after the target based on mouse Y (top half = before).
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const insertAfter = e.clientY > rect.top + rect.height / 2;

    // Siblings (same parent, excluding the dragged node), already sorted.
    const siblings = pages
      .filter((p) => p.parent_id === node.parent_id && p.id !== id)
      .sort((a, b) => a.sort_order - b.sort_order || a.created_at - b.created_at);

    const targetIdx = siblings.findIndex((s) => s.id === node.id);
    let sortOrder: number;
    if (insertAfter) {
      const next = siblings[targetIdx + 1];
      sortOrder = next ? (node.sort_order + next.sort_order) / 2 : node.sort_order + 1;
    } else {
      const prev = siblings[targetIdx - 1];
      sortOrder = prev ? (prev.sort_order + node.sort_order) / 2 : node.sort_order - 1;
    }

    await movePage(id, node.parent_id, sortOrder);
  };

  const handleClick = () => {
    if (isFolder) {
      setExpanded((v) => !v);
    } else {
      openPage(node.id);
    }
  };

  return (
    <div>
      <div
        className={`tree-row ${isCurrent ? "tree-row-active" : ""} ${dragOver ? "tree-row-over" : ""}`}
        style={{ paddingLeft: depth * 16 + 8 }}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", node.id);
          setDragging(true);
        }}
        onDragEnd={() => setDragging(false)}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={handleClick}
      >
        <span
          className="tree-toggle"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
        >
          {node.children.length > 0 ? (expanded ? "▾" : "▸") : "·"}
        </span>
        <span className="tree-icon">{isFolder ? "📁" : "📄"}</span>
        {editing ? (
          <input
            className="tree-rename-input"
            autoFocus
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitRename();
              } else if (e.key === "Escape") {
                setEditing(false);
                setEditValue(node.title);
              }
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span
            className="tree-title"
            title="双击重命名"
            onDoubleClick={(e) => {
              e.stopPropagation();
              setEditValue(node.title || "");
              setEditing(true);
            }}
          >
            {node.title || (isFolder ? "新建文件夹" : "未命名")}
          </span>
        )}
        <span className="tree-actions">
          <button
            title="在新窗口打开"
            onClick={(e) => {
              e.stopPropagation();
              if (!isFolder) api.openPageWindow(node.id);
            }}
          >
            ⧉
          </button>
          <button
            title="新建子页面"
            onClick={(e) => {
              e.stopPropagation();
              createPage(node.id);
            }}
          >
            +
          </button>
          {isFolder && (
            <button
              title="新建子文件夹"
              onClick={(e) => {
                e.stopPropagation();
                createFolder(node.id);
              }}
            >
              📁
            </button>
          )}
          <button
            title="删除"
            onClick={async (e) => {
              e.stopPropagation();
              if (confirm(`删除「${node.title || "未命名"}」及其所有子节点？`)) {
                await deletePage(node.id);
                toast("已移到回收站", "success");
              }
            }}
          >
            ×
          </button>
        </span>
      </div>
      {expanded &&
        node.children.map((child) => (
          <TreeItem key={child.id} node={child} depth={depth + 1} />
        ))}
      {dragging && null}
    </div>
  );
}

export function PageTree({
  view,
  onViewChange,
}: {
  view: "notes" | "board";
  onViewChange: (v: "notes" | "board") => void;
}) {
  const { pages, createPage, createFolder, loading } = useNotes();
  const { collapsed, toggle } = useSidebar();
  const [tags, setTags] = useState<{ id: string; name: string }[]>([]);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [taggedIds, setTaggedIds] = useState<Set<string> | null>(null);
  const [newMenuOpen, setNewMenuOpen] = useState(false);

  useEffect(() => {
    api.listTags().then(setTags).catch(() => {});
  }, []);

  useEffect(() => {
    if (activeTag) {
      api.pagesByTag(activeTag).then((ps) => setTaggedIds(new Set(ps.map((p) => p.id))));
    } else {
      setTaggedIds(null);
    }
  }, [activeTag]);

  const visiblePages = useMemo(() => {
    if (!taggedIds) return pages;
    return pages.filter((p) => taggedIds.has(p.id));
  }, [pages, taggedIds]);

  const tree = useMemo(() => buildTree(visiblePages), [visiblePages]);

  return (
    <div className={`sidebar ${collapsed ? "sidebar-collapsed" : ""}`}>
      <div className="sidebar-header">
        {!collapsed && <span className="sidebar-title">ShuyoNote</span>}
        <div className="sidebar-header-actions">
          {!collapsed && (
            <>
              <TrashPanel />
              <SyncPanel />
              <BackupButton />
              <ThemeToggle />
              <div className="new-menu">
                <button className="btn-new" onClick={() => setNewMenuOpen((v) => !v)}>
                  新建 ▾
                </button>
                {newMenuOpen && (
                  <div className="new-menu-dropdown">
                    <button
                      onClick={() => {
                        setNewMenuOpen(false);
                        createPage(null);
                      }}
                    >
                      📄 新建页面
                    </button>
                    <button
                      onClick={() => {
                        setNewMenuOpen(false);
                        createFolder(null);
                      }}
                    >
                      📁 新建文件夹
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
          <button
            className="btn-sidebar-toggle"
            onClick={toggle}
            title={collapsed ? "展开侧边栏" : "折叠侧边栏"}
          >
            {collapsed ? "»" : "«"}
          </button>
        </div>
      </div>
      {!collapsed && (
        <>
          <div className="sidebar-search">
            <SearchPanel />
          </div>
          <div className="view-switch">
            <button
              className={`view-switch-btn ${view === "notes" ? "view-switch-active" : ""}`}
              onClick={() => onViewChange("notes")}
            >
              📝 笔记
            </button>
            <button
              className={`view-switch-btn ${view === "board" ? "view-switch-active" : ""}`}
              onClick={() => onViewChange("board")}
            >
              📋 看板
            </button>
          </div>
          {tags.length > 0 && (
            <div className="sidebar-tags">
              <button
                className={`tag-filter ${activeTag === null ? "tag-filter-active" : ""}`}
                onClick={() => setActiveTag(null)}
              >
                全部
              </button>
              {tags.map((t) => (
                <button
                  key={t.id}
                  className={`tag-filter ${activeTag === t.id ? "tag-filter-active" : ""}`}
                  onClick={() => setActiveTag(t.id)}
                >
                  <span className="tag-dot" style={{ background: tagColor(t.name).solid }} />
                  {t.name}
                </button>
              ))}
            </div>
          )}
        </>
      )}
      <div className="sidebar-tree">
        {loading && pages.length === 0 ? (
          <div className="sidebar-skeleton">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="skeleton-row" style={{ width: `${100 - i * 12}%` }} />
            ))}
          </div>
        ) : tree.length === 0 ? (
          <div className="sidebar-empty">
            {collapsed ? "·" : activeTag ? "该标签下暂无页面" : "暂无页面，点击「新建页面」开始"}
          </div>
        ) : (
          tree.map((node) => <TreeItem key={node.id} node={node} depth={0} />)
        )}
      </div>
    </div>
  );
}
