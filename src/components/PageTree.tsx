import { useEffect, useMemo, useRef, useState } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import { usePopover } from "../hooks/usePopover";
import { api } from "../lib/api";
import { useNotes } from "../store/notes";
import { toast } from "../store/toast";
import type { AppView } from "../store/view";
import type { AttachmentMeta, PageMeta } from "../types";
import { useFileManagerStore } from "../store/fileManager";
import { useViewStore } from "../store/view";
import { useSpaceStore } from "../store/space";
import { useTemplateCenterStore } from "../store/templateCenter";
import { confirmDialog } from "../store/confirm";
import { SearchPanel } from "./SearchPanel";
import { SyncPanel } from "./SyncPanel";
import { TrashPanel } from "./TrashPanel";
import { BackupButton } from "./BackupButton";
import { ThemeSettings } from "./ThemeSettings";
import { ChevronDownIcon, DatabaseIcon, FolderIcon, PageIcon, TemplateIcon } from "./icons";

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

// Copy a page (and its descendants) into another workspace, choosing the target
// from a small dropdown. Block graphs stay workspace-scoped, so references to
// blocks outside the copied subtree are documented to not resolve in the target.
function CopyPageAction({ pageId }: { pageId: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const spaces = useSpaceStore((s) => s.spaces);
  const activeId = useSpaceStore((s) => s.activeId);
  const loadSpaces = useSpaceStore((s) => s.load);

  useEffect(() => {
    if (!open) return;
    loadSpaces();
  }, [open, loadSpaces]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const copyTo = async (wsId: string) => {
    setOpen(false);
    try {
      await api.copyPageToWorkspace(pageId, wsId, null);
      toast("已复制到目标工作空间", "success");
    } catch (e) {
      toast(`复制失败：${e}`, "error");
    }
  };

  return (
    <span ref={ref} className="copy-page-wrap">
      <button
        title="复制到其他工作空间"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        ⇄
      </button>
      {open && (
        <div className="copy-page-menu">
          <div className="copy-page-title">复制到…</div>
          {spaces
            .filter((s) => s.id !== activeId)
            .map((s) => (
              <button key={s.id} className="copy-page-item" onClick={() => copyTo(s.id)}>
                {s.name}
              </button>
            ))}
          {spaces.filter((s) => s.id !== activeId).length === 0 && (
            <div className="copy-page-empty">没有其他工作空间</div>
          )}
        </div>
      )}
    </span>
  );
}

function treeFileIcon(mime: string): string {
  if (mime.startsWith("image/")) return "🖼";
  if (mime.startsWith("video/")) return "🎬";
  if (mime.startsWith("audio/")) return "🎵";
  if (mime === "application/pdf") return "📕";
  if (mime.includes("zip") || mime.includes("gzip") || mime.includes("7z")) return "🗜";
  if (mime.includes("sheet") || mime.includes("excel") || mime === "text/csv") return "📊";
  if (mime.includes("word") || mime === "text/markdown") return "📄";
  if (mime.startsWith("text/")) return "📝";
  return "📎";
}

// Files uploaded into a folder, shown as non-expandable leaf items under the
// folder in the sidebar (loaded lazily when the folder is expanded).
function TreeFiles({ folderId, depth }: { folderId: string; depth: number }) {
  const [files, setFiles] = useState<AttachmentMeta[]>([]);
  const revision = useFileManagerStore((s) => s.revision);
  useEffect(() => {
    let alive = true;
    api
      .listPageAttachments(folderId)
      .then((fs) => {
        if (alive) setFiles(fs);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [folderId, revision]);

  if (files.length === 0) return null;

  return (
    <>
      {files.map((f) => (
        <div
          key={f.id}
          className="tree-row tree-file-row"
          style={{ paddingLeft: depth * 16 + 8 }}
          title={f.name}
          onClick={() =>
            openPath(f.path).catch((e) => toast(`打开失败：${e}`, "error"))
          }
        >
          <span className="tree-toggle" style={{ visibility: "hidden" }} />
          <span className="tree-icon">{treeFileIcon(f.mime)}</span>
          <span className="tree-title">{f.name}</span>
        </div>
      ))}
    </>
  );
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

  const isFolder = node.kind === "folder";
  const isDatabase = node.kind === "database";
  // Highlight the focused folder while browsing the file manager; otherwise
  // highlight the open page/database in the notes/board/graph views.
  const view = useViewStore((s) => s.view);
  const fmFolderId = useFileManagerStore((s) => s.folderId);
  const isCurrent =
    view === "files"
      ? isFolder && fmFolderId === node.id
      : currentId === node.id;

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
      // Clicking a folder opens the file manager focused on it; the ▸/▾ toggle
      // still expands/collapses the tree. Close any overlay (template center).
      useFileManagerStore.getState().setFolderId(node.id);
      useViewStore.getState().setView("files");
      useTemplateCenterStore.getState().setOpen(false);
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
          {isFolder ? (expanded ? "▾" : "▸") : node.children.length > 0 ? (expanded ? "▾" : "▸") : "·"}
        </span>
        <span className={`tree-icon${isFolder ? " tree-icon-folder" : isDatabase ? " tree-icon-database" : ""}`}>
          {isFolder ? "📁" : isDatabase ? "🗂" : "📄"}
        </span>
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
          <CopyPageAction pageId={node.id} />
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
              if (await confirmDialog({ title: "删除页面", message: `删除「${node.title || "未命名"}」及其所有子节点？`, danger: true })) {
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
      {isFolder && <TreeFiles folderId={node.id} depth={depth + 1} />}
      {dragging && null}
    </div>
  );
}

export function PageTree({
  view,
  onViewChange,
}: {
  view: AppView;
  onViewChange: (v: AppView) => void;
}) {
  const { pages, createPage, createFolder, createDatabase, loading } = useNotes();
  const collapsed = false;
  const {
    open: newMenuOpen,
    pos: newMenuPos,
    triggerRef: newMenuRef,
    contentRef: newMenuContentRef,
    toggle: toggleNewMenu,
    close: closeNewMenu,
  } = usePopover<HTMLButtonElement>();
  const [workspaceName, setWorkspaceName] = useState("默认空间");
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState("");
  const spaceChooser = usePopover<HTMLButtonElement>();

  const spaces = useSpaceStore((s) => s.spaces);
  const activeSpaceId = useSpaceStore((s) => s.activeId);

  useEffect(() => {
    api
      .getWorkspaceName()
      .then(setWorkspaceName)
      .catch((e) => {
        console.error("get workspace name failed", e);
        toast(`加载空间名失败：${e}`, "error");
      });
    useSpaceStore.getState().load();
  }, []);

  const switchSpace = async (id: string) => {
    const ok = await useSpaceStore.getState().switchTo(id);
    if (ok) {
      await useNotes.getState().loadPages();
      const name = useSpaceStore
        .getState()
        .spaces.find((s) => s.id === id)?.name;
      if (name) setWorkspaceName(name);
    }
    spaceChooser.close();
    setEditingName(false);
  };

  const createSpace = async () => {
    const ok = await useSpaceStore.getState().create();
    if (ok) {
      await useNotes.getState().loadPages();
      setWorkspaceName("新建工作区");
    }
    spaceChooser.close();
    setEditingName(false);
  };

  const removeSpace = async (id: string) => {
    const name = spaces.find((s) => s.id === id)?.name ?? "该工作空间";
    if (
      !(await confirmDialog({
        title: "删除工作空间",
        message: `删除「${name}」及其所有内容？（软删除，可在数据目录恢复）`,
        danger: true,
      }))
    ) {
      return;
    }
    const ok = await useSpaceStore.getState().remove(id);
    if (ok) {
      await useNotes.getState().loadPages();
      setWorkspaceName("默认空间");
    }
    spaceChooser.close();
    setEditingName(false);
  };

  const tree = useMemo(() => buildTree(pages), [pages]);

  const commitName = async () => {
    const v = nameValue.trim();
    setEditingName(false);
    if (v && v !== workspaceName) {
      try {
        await api.renameWorkspace(v);
        setWorkspaceName(v);
      } catch (e) {
        toast(`重命名失败：${e}`, "error");
      }
    }
  };

  return (
    <div className={`sidebar ${collapsed ? "sidebar-collapsed" : ""}`}>
      <div className="sidebar-header">
        {!collapsed && (
          <span className="sidebar-title">
            <span className="logo-mark">{workspaceName.charAt(0) || "S"}</span>
            {editingName ? (
              <input
                className="tree-rename-input workspace-rename-input"
                autoFocus
                value={nameValue}
                onChange={(e) => setNameValue(e.target.value)}
                onBlur={commitName}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitName();
                  } else if (e.key === "Escape") {
                    setEditingName(false);
                  }
                }}
              />
            ) : (
              <span
                className="sidebar-title-text"
                title="双击重命名空间 · 单点右侧切换"
                onDoubleClick={() => {
                  setNameValue(workspaceName);
                  setEditingName(true);
                }}
              >
                {workspaceName}
              </span>
            )}
            <button
              ref={spaceChooser.triggerRef}
              className="sidebar-title-switch"
              onClick={spaceChooser.toggle}
              title="切换工作空间"
            >
              ▾
            </button>
            {spaceChooser.open && (
              <div
                ref={spaceChooser.contentRef}
                className="space-switcher"
                style={{ top: spaceChooser.pos.top, left: spaceChooser.pos.left }}
              >
                <div className="space-switcher-title">切换工作空间</div>
                {spaces.length === 0 ? (
                  <div className="space-switcher-empty">暂无工作空间</div>
                ) : (
                  spaces.map((s) => (
                    <div
                      key={s.id}
                      className={`space-item ${s.id === activeSpaceId ? "space-item-active" : ""}`}
                      onClick={() => switchSpace(s.id)}
                    >
                      <span className="space-item-mark">{s.name.charAt(0)}</span>
                      <span className="space-item-name">{s.name}</span>
                      {s.id === activeSpaceId && <span className="space-item-check">✓</span>}
                      {spaces.length > 1 && s.id !== activeSpaceId && (
                        <button
                          className="space-item-del"
                          title="删除工作空间"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeSpace(s.id);
                          }}
                        >
                          ×
                        </button>
                      )}
                    </div>
                  ))
                )}
                <button className="space-item space-item-new" onClick={createSpace}>
                  <span className="space-item-mark">＋</span>
                  <span className="space-item-name">新建工作空间</span>
                </button>
              </div>
            )}
          </span>
        )}
        </div>
        <div className="sidebar-header-actions">
          <div className="sidebar-actions-group">
            <SyncPanel />
            <BackupButton />
            <ThemeSettings />
          </div>
          <div className="new-menu">
            <button ref={newMenuRef} className="btn-new" onClick={toggleNewMenu}>
              <span className="btn-new-label">新建</span>
              <ChevronDownIcon width={14} height={14} className="btn-new-caret" />
            </button>
            {newMenuOpen && (
              <div ref={newMenuContentRef} className="new-menu-dropdown" style={{ top: newMenuPos.top, left: newMenuPos.left }}>
                <div className="new-menu-title">新建</div>
                <button
                  className="new-menu-item"
                  onClick={() => {
                    closeNewMenu();
                    createPage(null);
                  }}
                >
                  <span className="new-menu-icon"><PageIcon /></span>
                  <span className="new-menu-body">
                    <span className="new-menu-name">页面</span>
                    <span className="new-menu-desc">空白文书</span>
                  </span>
                  <kbd className="new-menu-kbd">Ctrl+N</kbd>
                </button>
                <button
                  className="new-menu-item"
                  onClick={() => {
                    closeNewMenu();
                    createFolder(null);
                  }}
                >
                  <span className="new-menu-icon"><FolderIcon /></span>
                  <span className="new-menu-body">
                    <span className="new-menu-name">文件夹</span>
                    <span className="new-menu-desc">组织子页面</span>
                  </span>
                </button>
                <button
                  className="new-menu-item"
                  onClick={() => {
                    closeNewMenu();
                    createDatabase(null);
                  }}
                >
                  <span className="new-menu-icon"><DatabaseIcon /></span>
                  <span className="new-menu-body">
                    <span className="new-menu-name">数据库</span>
                    <span className="new-menu-desc">表格 / 画廊 / 看板</span>
                  </span>
                </button>
              </div>
            )}
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
            <button
              className={`view-switch-btn ${view === "graph" ? "view-switch-active" : ""}`}
              onClick={() => onViewChange("graph")}
            >
              🕸 关系图
            </button>
          </div>
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
            {collapsed ? "·" : "暂无页面，点击「新建页面」开始"}
          </div>
        ) : (
          tree.map((node) => <TreeItem key={node.id} node={node} depth={0} />)
        )}
      </div>
      {!collapsed && (
        <div className="sidebar-bottom">
          <TrashPanel />
          <button
            className="sidebar-bottom-btn"
            onClick={() => useTemplateCenterStore.getState().setOpen(true)}
          >
            <TemplateIcon className="sidebar-bottom-icon" /> 模板中心
          </button>
        </div>
      )}
    </div>
  );
}
