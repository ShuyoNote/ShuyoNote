import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { platform } from "../lib/platform";
import { usePopover } from "../hooks/usePopover";
import { api } from "../lib/api";
import { useNotes } from "../store/notes";
import { toast } from "../store/toast";
import type { AppView } from "../store/view";
import type { AttachmentMeta, PageMeta, WorkspaceMeta } from "../types";
import { useFileManagerStore } from "../store/fileManager";
import { useViewStore } from "../store/view";
import { useSpaceStore } from "../store/space";
import { useTemplateCenterStore } from "../store/templateCenter";
import { useAiStore } from "../store/ai";
import { useTreeSelection } from "../store/treeSelection";
import { useTreeDrag } from "../store/treeDrag";
import * as reorder from "../lib/treeReorder";
import { confirmDialog } from "../store/confirm";
import { SearchPanel } from "./SearchPanel";
import { SyncPanel } from "./SyncPanel";
import { TrashPanel } from "./TrashPanel";
import { BackupButton } from "./BackupButton";
import { StoragePanel } from "./StoragePanel";
import { ThemeSettings } from "./ThemeSettings";
import { ChevronDownIcon, DatabaseIcon, FolderIcon, PageIcon, TemplateIcon, BoardIcon, GraphIcon, SparkleIcon } from "./icons";

interface TreeNode extends PageMeta {
  children: TreeNode[];
}

// Mirrors the backend ACCENTS palette (workspaces.rs).
const SPACE_ACCENTS = [
  "#3370FF", "#00B578", "#FF8A1E", "#7B61FF", "#00A9C7", "#D9A300", "#F54A45", "#646A73",
];

// A pointer-drag ending fires a click on mouseup; this one-shot flag lets the row
// onClick drop that trailing click so a dropped node isn't also opened.
const dragJustFinishedRef = { current: false };

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

// Compute the target { parentId, sortOrder } for a completed drag.
// zone "inside" nests the dragged node as the first child of the target; the other
// zones insert it as a sibling before/after the target (midpoint sort order).
export function computeReorder(
  pages: PageMeta[],
  dragId: string,
  targetId: string,
  zone: "before" | "after" | "inside",
): { parentId: string | null; sortOrder: number } | null {
  return reorder.computeReorder(pages, dragId, targetId, zone);
}

// Copy a page (and its descendants) into another workspace, choosing the target
// from a small dropdown. Block graphs stay workspace-scoped, so references to
// blocks outside the copied subtree are documented to not resolve in the target.
function CopyPageAction({ pageId }: { pageId: string }) {
  const [open, setOpen] = useState(false);
  const [spaces, setSpaces] = useState<WorkspaceMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const ref = useRef<HTMLSpanElement>(null);

  // Read spaces lazily (only when the menu opens) so a space change doesn't
  // re-render every page row's CopyPageAction — this was causing UI to freeze
  // on delete/switch for large trees.
  useEffect(() => {
    if (!open) return;
    useSpaceStore.getState().load();
    api.listWorkspaces().then(setSpaces).catch(() => {});
    api
      .getActiveWorkspaceId()
      .then(setActiveId)
      .catch(() => {});
  }, [open]);

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
            platform.opener.openPath(f.path).catch((e) => toast(`打开失败：${e}`, "error"))
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
  onRowPointerDown,
}: {
  node: TreeNode;
  depth: number;
  onRowPointerDown: (id: string, e: React.MouseEvent) => void;
}) {
  const { currentId, openPage, createPage, createFolder, deletePage, renamePage } = useNotes();
  const selectedIds = useTreeSelection((s) => s.ids);
  const toggleSelect = useTreeSelection((s) => s.toggle);
  const clearSelection = useTreeSelection((s) => s.clear);
  const draggingId = useTreeDrag((s) => s.draggingId);
  const overId = useTreeDrag((s) => s.overId);
  const zone = useTreeDrag((s) => s.zone);
  const [expanded, setExpanded] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(node.title);

  const isFolder = node.kind === "folder";
  const isDatabase = node.kind === "database";

  // Auto-expand this folder when a drag requests it (hovering its "inside" zone).
  const dragExpandId = useTreeDrag((s) => s.expandId);
  useEffect(() => {
    if (isFolder && node.id === dragExpandId) {
      setExpanded(true);
      useTreeDrag.getState().requestExpand(null); // one-shot
    }
  }, [dragExpandId, node.id, isFolder]);

  // Highlight the focused folder while browsing the file manager; otherwise
  // highlight the open page/database in the notes/board/graph views.
  const view = useViewStore((s) => s.view);
  const fmFolderId = useFileManagerStore((s) => s.folderId);
  const isCurrent =
    view === "files"
      ? isFolder && fmFolderId === node.id
      : currentId === node.id;
  const isSelected = selectedIds.has(node.id);
  const isDragSource = draggingId === node.id;
  const isDragTarget = draggingId !== null && node.id !== draggingId && overId === node.id;

  const commitRename = async () => {
    const v = editValue.trim();
    setEditing(false);
    if (v && v !== node.title) {
      await renamePage(node.id, v);
    } else {
      setEditValue(node.title);
    }
  };

  const handleClick = (e: React.MouseEvent) => {
    // A completed pointer-drag fires a click afterward; suppress it so the node
    // isn't opened after being dropped.
    if (dragJustFinishedRef.current) {
      dragJustFinishedRef.current = false;
      e.preventDefault();
      return;
    }
    // Ctrl/⌘+click toggles a node into/out of the multi-select set without
    // navigating (the standard "select without opening" gesture in file managers).
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      toggleSelect(node.id);
      return;
    }
    // A plain click drops any pending multi-selection and opens the node.
    if (selectedIds.size > 0) clearSelection();
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
        data-node-id={node.id}
        data-node-kind={isFolder ? "folder" : isDatabase ? "database" : "page"}
        className={`tree-row ${isCurrent ? "tree-row-active" : ""} ${isSelected ? "tree-row-selected" : ""} ${isDragSource ? "tree-row-dragging" : ""} ${isDragTarget && zone ? `tree-drop-${zone}` : ""}`}
        style={{ paddingLeft: depth * 16 + 8 }}
        onMouseDown={(e) => {
          // Left-button on a row starts a potential pointer-drag (works in Tauri's
          // WebView where HTML5 drag-and-drop is suppressed by dragDropEnabled).
          if (e.button !== 0 || editing) return;
          onRowPointerDown(node.id, e);
        }}
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
        {isSelected && (
          <span className="tree-select-mark" aria-hidden="true">
            ✓
          </span>
        )}
        <span className={`tree-icon${isFolder ? " tree-icon-folder" : isDatabase ? " tree-icon-database" : ""}`}>
          {isFolder ? (
            <FolderIcon width={16} height={16} />
          ) : isDatabase ? (
            <DatabaseIcon width={16} height={16} />
          ) : (
            <PageIcon width={16} height={16} />
          )}
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
          <TreeItem key={child.id} node={child} depth={depth + 1} onRowPointerDown={onRowPointerDown} />
        ))}
      {isFolder && expanded && <TreeFiles folderId={node.id} depth={depth + 1} />}
    </div>
  );
}

// Batch-action bar shown when one or more tree nodes are multi-selected
// (Ctrl/⌘+click). Offers "移动到文件夹" and "移入回收站" over the whole selection.
function BatchToolbar({ pages }: { pages: PageMeta[] }) {
  const selectedIds = useTreeSelection((s) => s.ids);
  const clearSelection = useTreeSelection((s) => s.clear);
  const { movePage, deletePage } = useNotes();
  const [moveOpen, setMoveOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const count = selectedIds.size;
  const selected = [...selectedIds];

  useEffect(() => {
    if (!moveOpen) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setMoveOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [moveOpen]);

  if (count === 0) return null;

  // Candidate move targets: every folder except the ones being moved, plus
  // workspace root (move to top level).
  const folders = pages.filter((p) => p.kind === "folder" && !selected.includes(p.id));

  const moveTo = async (parentId: string | null) => {
    setMoveOpen(false);
    try {
      // Append each moved node to the end of the target (deterministic order).
      let order = parentId
        ? Math.max(0, ...pages.filter((p) => p.parent_id === parentId).map((p) => p.sort_order ?? 0)) + 1
        : 0;
      for (const id of selected) {
        await movePage(id, parentId, order++);
      }
      clearSelection();
      toast(`已移动 ${selected.length} 个节点`, "success");
    } catch (e) {
      toast(`移动失败：${e}`, "error");
    }
  };

  const deleteBatch = async () => {
    if (
      await confirmDialog({
        title: "删除页面",
        message: `删除选中的 ${count} 个节点及其所有子节点？`,
        danger: true,
      })
    ) {
      try {
        for (const id of selected) {
          await deletePage(id);
        }
        clearSelection();
        toast(`已删除 ${selected.length} 个节点`, "success");
      } catch (e) {
        toast(`删除失败：${e}`, "error");
      }
    }
  };

  return (
    <div className="tree-batch" ref={ref}>
      <span className="tree-batch-count">已选 {count} 项</span>
      <div className="tree-batch-menu">
        <button
          className="tree-batch-btn"
          onClick={() => setMoveOpen((v) => !v)}
        >
          移动到…
        </button>
        {moveOpen && (
          <div className="tree-batch-dropdown">
            <button className="tree-batch-item" onClick={() => moveTo(null)}>
              ⟨ 工作空间根目录 ⟩
            </button>
            {folders.map((f) => (
              <button key={f.id} className="tree-batch-item" onClick={() => moveTo(f.id)}>
                ⟨ {f.title || "新建文件夹"} ⟩
              </button>
            ))}
          </div>
        )}
        <button className="tree-batch-btn tree-batch-danger" onClick={deleteBatch}>
          移入回收站
        </button>
        <button className="tree-batch-btn" onClick={clearSelection}>
          取消
        </button>
      </div>
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
  const { pages, createPage, createFolder, createDatabase, loading, movePage } = useNotes();
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
  const [renamingSpace, setRenamingSpace] = useState<string | null>(null);
  const [renameSpaceValue, setRenameSpaceValue] = useState("");
  const [colorFor, setColorFor] = useState<string | null>(null);
  const spaceChooser = usePopover<HTMLButtonElement>();
  const [exporting, setExporting] = useState<{ done: number; total: number; message: string } | null>(null);
  const aiEnabled = useAiStore((s) => s.config.enabled);

  // Drag-ghost state (title + cursor position while dragging a tree node).
  const dragLabel = useTreeDrag((s) => s.label);
  const dragX = useTreeDrag((s) => s.x);
  const dragY = useTreeDrag((s) => s.y);
  const dragKind = useTreeDrag((s) => s.kind);
  const dragIcon =
    dragKind === "folder" ? <FolderIcon width={15} height={15} /> :
    dragKind === "database" ? <DatabaseIcon width={15} height={15} /> :
    <PageIcon width={15} height={15} />;

  const spaces = useSpaceStore((s) => s.spaces);
  const activeSpaceId = useSpaceStore((s) => s.activeId);
  const activeSpace = spaces.find((s) => s.id === activeSpaceId);
  const activeTheme = activeSpace?.theme ?? "";

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

  // Re-fetch the sidebar space name whenever the active space changes (including
  // after a full back-up restore or a switch), so the title isn't stale.
  useEffect(() => {
    api
      .getWorkspaceName()
      .then(setWorkspaceName)
      .catch(() => {});
  }, [activeSpaceId]);

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
      const newActive = useSpaceStore.getState().activeId;
      const name = useSpaceStore.getState().spaces.find((s) => s.id === newActive)?.name;
      if (name) setWorkspaceName(name);
    }
    spaceChooser.close();
    setEditingName(false);
  };

  const exportSpace = async () => {
    try {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const safe = (workspaceName || "space")
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
        .replace(/\s+/g, "-")
        .trim()
        .slice(0, 40);
      const path = await platform.dialog.save({
        title: "导出当前工作空间",
        defaultPath: `space-${safe}-${stamp}.zip`,
        filters: [{ name: "ZIP", extensions: ["zip"] }],
      });
      if (!path) return;
      // Stream wiring `workspace-progress` events → the progress bar. Desktop emits
      // the real event; web dispatches it via CustomEvent (same listener works both).
      setExporting({ done: 0, total: 1, message: "准备导出…" });
      const unlisten = await platform.event.listen<{ done: number; total: number; message: string }>(
        "workspace-progress",
        (e) => {
          const p = e.payload;
          if (p && typeof p.done === "number") setExporting({ done: p.done, total: p.total || 1, message: p.message || "导出中…" });
        },
      );
      let result: { size: number; attachments: number };
      try {
        result = await api.exportWorkspace(path);
      } finally {
        setExporting(null);
        unlisten();
      }
      toast(
        `空间导出完成：大小 ${(result.size / 1024).toFixed(1)} KB${result.attachments ? ` · 附件 ${result.attachments} 个` : ""}`,
        "success",
      );
    } catch (e) {
      setExporting(null);
      toast(`空间导出失败：${e}`, "error");
    }
    spaceChooser.close();
  };

  const importSpace = async () => {
    try {
      const path = await platform.dialog.open({
        title: "导入工作空间",
        filters: [{ name: "ZIP", extensions: ["zip"] }],
        multiple: false,
      });
      if (!path) return;
      if (
        !(await confirmDialog({
          title: "导入工作空间",
          message: "导入将新建一个工作空间（不会覆盖现有空间）。确定继续？",
        }))
      ) {
        return;
      }
      setExporting({ done: 0, total: 1, message: "准备导入…" });
      const unlisten = await platform.event.listen<{ done: number; total: number; message: string }>(
        "workspace-progress",
        (e) => {
          const p = e.payload;
          if (p && typeof p.done === "number") setExporting({ done: p.done, total: p.total || 1, message: p.message || "导入中…" });
        },
      );
      let meta: { name: string };
      try {
        meta = await api.importWorkspace(path as string);
      } finally {
        setExporting(null);
        unlisten();
      }
      toast(`已导入工作空间「${meta.name}」`, "success");
      await useSpaceStore.getState().load();
    } catch (e) {
      toast(`空间导入失败：${e}`, "error");
    }
    spaceChooser.close();
  };

  const removeSpace = async (id: string) => {
    const name = spaces.find((s) => s.id === id)?.name ?? "该工作空间";
    if (
      !(await confirmDialog({
        title: "删除工作空间",
        message: `删除「${name}」及其所有内容？建议先导出/备份（软删除，可在数据目录恢复）。`,
        danger: true,
      }))
    ) {
      return;
    }
    const ok = await useSpaceStore.getState().remove(id);
    if (ok) {
      await useNotes.getState().loadPages();
      const newActive = useSpaceStore.getState().activeId;
      const newName = useSpaceStore.getState().spaces.find((s) => s.id === newActive)?.name;
      setWorkspaceName(newName ?? "默认空间");
      toast(`已删除工作空间「${name}」`, "success");
    }
    spaceChooser.close();
    setEditingName(false);
  };

  const tree = useMemo(() => buildTree(pages), [pages]);

  // ---- Pointer-based drag (works in Tauri's WebView where HTML5 drag-drop is
  // suppressed by dragDropEnabled). A row mousedown arms a potential drag; after a
  // small movement threshold we hit-test rows (via data-node-id) and compute the
  // drop zone, then perform the move on mouseup. ----
  const dragRef = useRef<{ id: string; startX: number; startY: number; armed: boolean } | null>(null);
  const lastOverRef = useRef<{ targetId: string; zone: "before" | "after" | "inside" } | null>(null);
  const treeContainerRef = useRef<HTMLDivElement | null>(null);
  const expandTimerRef = useRef<number | null>(null);
  const onRowPointerDown = (id: string, e: React.MouseEvent) => {
    // Ignore drag start from interactive children (toggle / actions / rename).
    const target = e.target as HTMLElement;
    if (target.closest(".tree-toggle, .tree-actions, .tree-rename-input, button, input")) return;
    dragRef.current = { id, startX: e.clientX, startY: e.clientY, armed: false };
  };
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d || d.id === null) return;
      if (!d.armed) {
        if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 5) return;
        d.armed = true;
        const srcNode = pages.find((p) => p.id === d.id);
        useTreeDrag.getState().start(d.id, srcNode?.title || "未命名", srcNode?.kind || "page");
      }
      useTreeDrag.getState().cursor(e.clientX, e.clientY);
      // Auto-scroll the tree container when near its top/bottom edges.
      const cont = treeContainerRef.current;
      if (cont) {
        const rect = cont.getBoundingClientRect();
        const zone = 40; // px threshold
        if (e.clientY < rect.top + zone) cont.scrollBy({ top: -8 });
        else if (e.clientY > rect.bottom - zone) cont.scrollBy({ top: 8 });
      }
      // Hit-test the row under the cursor; fall back to the previous target so the
      // highlight doesn't flash off while moving between rows or over a gap.
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest?.("[data-node-id]") as HTMLElement | null;
      let targetId: string | null = null;
      let z: "before" | "after" | "inside" | null = null;
      let isFolder = false;
      if (el) {
        const id = el.getAttribute("data-node-id")!;
        if (id !== d.id) {
          targetId = id;
          const rect = el.getBoundingClientRect();
          const ratio = (e.clientY - rect.top) / rect.height;
          z = ratio < 0.3 ? "before" : ratio > 0.7 ? "after" : "inside";
          isFolder = el.getAttribute("data-node-kind") === "folder";
        }
      }
      // No row under cursor → keep the last over target (sticky), so a drop still
      // lands somewhere sensible instead of being dropped on nothing.
      if (targetId === null && lastOverRef.current && lastOverRef.current.targetId !== d.id) {
        targetId = lastOverRef.current.targetId;
        z = lastOverRef.current.zone;
        isFolder = pages.find((p) => p.id === targetId)?.kind === "folder";
      }
      if (targetId && z) {
        lastOverRef.current = { targetId, zone: z };
        useTreeDrag.getState().move(targetId, z);
        // Auto-expand a folder when hovering its before/inside zone briefly.
        if (isFolder && z !== "after") {
          if (expandTimerRef.current === null && useTreeDrag.getState().expandId !== targetId) {
            expandTimerRef.current = window.setTimeout(() => {
              expandTimerRef.current = null;
              // If still hovering this folder, ask it to expand.
              if (useTreeDrag.getState().overId === targetId) {
                useTreeDrag.getState().requestExpand(targetId);
              }
            }, 450);
          }
        } else if (expandTimerRef.current !== null) {
          window.clearTimeout(expandTimerRef.current);
          expandTimerRef.current = null;
        }
      } else {
        useTreeDrag.getState().move(null, null);
        if (expandTimerRef.current !== null) {
          window.clearTimeout(expandTimerRef.current);
          expandTimerRef.current = null;
        }
      }
    };
    const onUp = async () => {
      const d = dragRef.current;
      dragRef.current = null;
      if (expandTimerRef.current !== null) { window.clearTimeout(expandTimerRef.current); expandTimerRef.current = null; }
      const { draggingId, overId, zone } = useTreeDrag.getState();
      useTreeDrag.getState().end();
      lastOverRef.current = null;
      // Suppress the trailing click that follows a real drag.
      if (d?.armed) dragJustFinishedRef.current = true;
      if (draggingId && overId) {
        const choice = computeReorder(pages, draggingId, overId, zone ?? "inside");
        if (choice) await movePage(draggingId, choice.parentId, choice.sortOrder);
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (expandTimerRef.current !== null) { window.clearTimeout(expandTimerRef.current); expandTimerRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, movePage]);

  const commitName = async () => {
    const v = nameValue.trim();
    setEditingName(false);
    if (v && v !== workspaceName && activeSpaceId) {
      try {
        await api.renameWorkspace(activeSpaceId, v);
        setWorkspaceName(v);
        useSpaceStore.getState().load();
      } catch (e) {
        toast(`重命名失败：${e}`, "error");
      }
    }
  };

  const startRenameSpace = (s: { id: string; name: string }) => {
    setRenamingSpace(s.id);
    setRenameSpaceValue(s.name);
  };

  const commitRenameSpace = async () => {
    if (!renamingSpace) return;
    const v = renameSpaceValue.trim();
    const targetId = renamingSpace;
    setRenamingSpace(null);
    if (!v) return;
    const ok = await useSpaceStore.getState().rename(targetId, v);
    if (ok) {
      if (targetId === activeSpaceId) setWorkspaceName(v);
      else {
        const nm = useSpaceStore.getState().spaces.find((s) => s.id === targetId)?.name;
        if (nm) setWorkspaceName(nm);
      }
    } else {
      toast("重命名失败", "error");
    }
  };

  const setSpaceColor = async (id: string, color: string) => {
    setColorFor(null);
    const ok = await useSpaceStore.getState().setSettings(id, color);
    if (!ok) toast("设置颜色失败", "error");
  };

  return (
    <div className={`sidebar ${collapsed ? "sidebar-collapsed" : ""}`}>
      <div className="sidebar-header">
        {!collapsed && (
          <span className="sidebar-title">
            <span
              className="logo-mark"
              style={
                activeTheme
                  ? { background: activeTheme, color: "#fff" }
                  : undefined
              }
            >
              {workspaceName.charAt(0) || "S"}
            </span>
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
                    <Fragment key={s.id}>
                      <div
                        className={`space-item ${s.id === activeSpaceId ? "space-item-active" : ""}`}
                        onClick={() => switchSpace(s.id)}
                      >
                        <span
                          className="space-item-mark"
                          style={s.theme ? { background: s.theme, color: "#fff", border: "none" } : undefined}
                        >
                          {s.name.charAt(0)}
                        </span>
                        {renamingSpace === s.id ? (
                          <input
                            className="space-item-rename-input"
                            autoFocus
                            value={renameSpaceValue}
                            onChange={(e) => setRenameSpaceValue(e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.stopPropagation();
                                commitRenameSpace();
                              } else if (e.key === "Escape") {
                                e.stopPropagation();
                                setRenamingSpace(null);
                              }
                            }}
                            onBlur={commitRenameSpace}
                          />
                        ) : (
                          <span className="space-item-name">{s.name}</span>
                        )}
                        {s.id === activeSpaceId && <span className="space-item-check">✓</span>}
                        {renamingSpace !== s.id && (
                          <button
                            className="space-item-op"
                            title="重命名工作空间"
                            onClick={(e) => {
                              e.stopPropagation();
                              startRenameSpace(s);
                            }}
                          >
                            ✎
                          </button>
                        )}
                        <button
                          className={`space-item-op space-color-btn ${colorFor === s.id ? "on" : ""}`}
                          title="设置空间颜色"
                          style={s.theme ? { background: s.theme } : undefined}
                          onClick={(e) => {
                            e.stopPropagation();
                            setColorFor((c) => (c === s.id ? null : s.id));
                          }}
                        />
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
                      {colorFor === s.id && (
                        <div className="space-color-palette">
                          {SPACE_ACCENTS.map((c) => (
                            <button
                              key={c}
                              className={`space-color-swatch ${s.theme === c ? "on" : ""}`}
                              style={{ background: c }}
                              title={c}
                              onClick={(e) => {
                                e.stopPropagation();
                                setSpaceColor(s.id, c);
                              }}
                            />
                          ))}
                        </div>
                      )}
                    </Fragment>
                  ))
                )}
                <button className="space-item space-item-new" onClick={createSpace}>
                  <span className="space-item-mark">＋</span>
                  <span className="space-item-name">新建工作空间</span>
                </button>
                <div className="space-switcher-io">
                  <div className="space-switcher-io-title">单空间迁移</div>
                  <button onClick={exportSpace}>
                    <span className="space-item-mark">⇪</span>
                    <span className="space-item-name">导出当前空间</span>
                  </button>
                  <button onClick={importSpace}>
                    <span className="space-item-mark">⇣</span>
                    <span className="space-item-name">导入空间包（新建空间）</span>
                  </button>
                  {exporting && (
                    <div className="space-export-progress">
                      <div className="space-export-progress-label">
                        <span>{exporting.message}</span>
                        <span>{Math.round((exporting.done / Math.max(1, exporting.total)) * 100)}%</span>
                      </div>
                      <div className="space-export-progress-track">
                        <div
                          className="space-export-progress-fill"
                          style={{ width: `${Math.min(100, Math.round((exporting.done / Math.max(1, exporting.total)) * 100))}%` }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </span>
        )}
        </div>
        <div className="sidebar-header-actions">
          <div className="sidebar-actions-group">
            <SyncPanel />
            <BackupButton />
            <StoragePanel />
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
                    <span className="new-menu-desc">归类嵌套页面 · 也可存放文件</span>
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
              <PageIcon width={15} height={15} />
              <span>笔记</span>
            </button>
            <button
              className={`view-switch-btn ${view === "board" ? "view-switch-active" : ""}`}
              onClick={() => onViewChange("board")}
            >
              <BoardIcon width={15} height={15} />
              <span>看板</span>
            </button>
            <button
              className={`view-switch-btn ${view === "graph" ? "view-switch-active" : ""}`}
              onClick={() => onViewChange("graph")}
            >
              <GraphIcon width={15} height={15} />
              <span>关系图</span>
            </button>
          </div>
        </>
      )}
      <div className="sidebar-tree" ref={treeContainerRef}>
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
          tree.map((node) => <TreeItem key={node.id} node={node} depth={0} onRowPointerDown={onRowPointerDown} />)
        )}
        <BatchToolbar pages={pages} />
      </div>
      {!collapsed && (
        <div className="sidebar-bottom">
          <TrashPanel />
          {aiEnabled && (
            <button
              className="sidebar-bottom-btn"
              onClick={() => useAiStore.getState().setOpen(true)}
            >
              <SparkleIcon className="sidebar-bottom-icon sidebar-bottom-ai" /> AI 助手
            </button>
          )}
          <button
            className="sidebar-bottom-btn"
            onClick={() => useTemplateCenterStore.getState().setOpen(true)}
          >
            <TemplateIcon className="sidebar-bottom-icon" /> 模板中心
          </button>
        </div>
      )}

      {/* Space export/import progress: a fixed overlay so it's always visible while a
          space is being exported/imported — independent of the space-switcher popover
          (which may close or be off-screen during the async work). */}
      {exporting && (
        <div className="space-export-overlay">
          <div className="space-export-progress">
            <div className="space-export-progress-label">
              <span>{exporting.message}</span>
              <span>{Math.min(100, Math.round((exporting.done / Math.max(1, exporting.total)) * 100))}%</span>
            </div>
            <div className="space-export-progress-track">
              <div
                className="space-export-progress-fill"
                style={{ width: `${Math.min(100, Math.round((exporting.done / Math.max(1, exporting.total)) * 100))}%` }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Drag ghost: follows the cursor to show what's being moved. */}
      {dragLabel && (
        <div className="tree-drag-ghost" style={{ left: dragX + 12, top: dragY + 8 }}>
          <span className="tree-ghost-icon">{dragIcon}</span>
          <span className="tree-ghost-title">{dragLabel}</span>
        </div>
      )}
    </div>
  );
}
