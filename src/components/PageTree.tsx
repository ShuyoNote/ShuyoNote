import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { platform } from "../lib/platform";
import { usePopover } from "../hooks/usePopover";
import { api, type SyncProfile } from "../lib/api";
import { useNotes } from "../store/notes";
import { toast } from "../store/toast";
import type { AppView } from "../store/view";
import type { AttachmentMeta, PageMeta } from "../types";
import { useFileManagerStore } from "../store/fileManager";
import { useViewStore } from "../store/view";
import { useSpaceStore } from "../store/space";
import { useTemplateCenterStore } from "../store/templateCenter";
import { useEditorStore } from "../store/editor";
import { usePdfReader } from "../store/pdfReader";
import { useFilePreview } from "../store/filePreview";
import { useTreeSelection } from "../store/treeSelection";
import { useTreeDrag } from "../store/treeDrag";
import { useActivity } from "../store/activity";
import { useWindowChrome } from "../store/windowChrome";
import { syncTagLabel, syncTagColor } from "../lib/syncTag";
import * as reorder from "../lib/treeReorder";
import { confirmDialog } from "../store/confirm";
import { SyncPanel } from "./SyncPanel";
import { PlusIcon, DatabaseIcon, FolderIcon, PageIcon } from "./icons";

interface TreeNode extends PageMeta {
  children: TreeNode[];
}

// Mirrors the backend ACCENTS palette (workspaces.rs).
// 同步标签的 label/color 抽到 lib/syncTag.ts——标题栏与同步面板要用同一份，
// 同一个服务器地址在各处必须是同一个颜色。

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

// Copy a page (and its descendants) into another workspace. After choosing a
// target workspace, show that workspace's folder tree so the user can pick a
// parent folder (or "根") to place the copy under. Block graphs stay
// workspace-scoped, so cross-block refs outside the subtree don't resolve.
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
          onClick={() => {
            // PDF 文件节点：直接进内置阅读器做批注/阅读，而不是用默认程序打开。
            if (f.mime === "application/pdf") {
              void usePdfReader.getState().openPdf(f.id, f.name);
              return;
            }
            // MD / 图片 / 视频 / 音频文件节点：直接在应用内打开预览（铺满），不跳系统外部应用。
            if (
              f.mime === "text/markdown" ||
              f.mime.startsWith("image/") ||
              f.mime.startsWith("video/") ||
              f.mime.startsWith("audio/")
            ) {
              useFilePreview.getState().open(f);
              return;
            }
            // 其它类型（office/zip/csv 等）无内置预览，用系统默认应用打开——明确提示。
            toast("正在用系统默认应用打开…", "info");
            platform.opener.openPath(f.path).catch((e) => toast(`打开失败：${e}`, "error"));
          }}
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
  const [menuOpen, setMenuOpen] = useState(false);

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
          {node.icon ? (
            /^(data:image|https?:|\.svg)/i.test(node.icon) ? (
              <img className="tree-icon-img" src={node.icon} alt="" draggable={false} />
            ) : (
              <span className="tree-icon-emoji">{node.icon}</span>
            )
          ) : isFolder ? (
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
        <span className={`tree-actions${menuOpen ? " is-open" : ""}`}>
          {/* 折叠成「…」菜单：hover 显示一个 …，点开弹出动作菜单。 */}
          <button
            className="tree-more"
            title="更多操作"
            aria-expanded={menuOpen}
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
          >
            ⋯
          </button>
          {menuOpen && (
            <span className="tree-node-menu" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  setEditValue(node.title || "");
                  setEditing(true);
                }}
              >
                ✎ 重命名
              </button>
              {!isFolder && (
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    api.openPageWindow(node.id);
                  }}
                >
                  ⧉ 新窗口打开
                </button>
              )}
              <button
                onClick={() => {
                  setMenuOpen(false);
                  createPage(node.id);
                }}
              >
                + 新建子页面
              </button>
              {isFolder && (
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    createFolder(node.id);
                  }}
                >
                  📁 新建子文件夹
                </button>
              )}
              <button
                className="tree-menu-danger"
                onClick={async () => {
                  setMenuOpen(false);
                  if (await confirmDialog({ title: "删除页面", message: `删除「${node.title || "未命名"}」及其所有子节点？`, danger: true })) {
                    await deletePage(node.id);
                    toast("已移到回收站", "success");
                  }
                }}
              >
                × 删除
              </button>
            </span>
          )}
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

// 视图切换已收编进左侧竖条 <ActivityBar />，这里不再需要 view / onViewChange，
// 但 App 仍按老签名传参，故保留可选 props 以免调用点大改。
export function PageTree(_props: {
  view?: AppView;
  onViewChange?: (v: AppView) => void;
}) {
  const { pages, createPage, createFolder, createDatabase, loading, movePage } = useNotes();
  const collapsed = false;
  // 侧栏是否展开由左侧竖条控制（搜索是弹层，不改变侧栏内容）。
  const sidebarOpen = useActivity((s) => s.sidebarOpen);
  // 自绘标题栏开着时，同步状态显示在顶栏，侧栏不再重复一份。
  const customTitleBar = useWindowChrome((s) => s.custom);
  const {
    open: newMenuOpen,
    pos: newMenuPos,
    triggerRef: newMenuRef,
    contentRef: newMenuContentRef,
    toggle: toggleNewMenu,
    close: closeNewMenu,
  } = usePopover<HTMLButtonElement>();
  // Sidebar resizable width (persisted), applied as --sidebar-w so overlays follow.
  const SIDEBAR_W_KEY = "shuyonote.sidebarWidth";
  const loadSidebarWidth = () => {
    try {
      const n = Number(localStorage.getItem(SIDEBAR_W_KEY));
      return Number.isFinite(n) && n >= 200 ? n : 264;
    } catch {
      return 264;
    }
  };
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const sidebarWidthRef = useRef(sidebarWidth);
  useEffect(() => {
    sidebarWidthRef.current = sidebarWidth;
    document.documentElement.style.setProperty("--sidebar-w", `${sidebarWidth}px`);
  }, [sidebarWidth]);
  const onSidebarResizeStart = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidthRef.current;
    const clamp = (w: number) => Math.min(460, Math.max(200, w));
    const onMove = (ev: PointerEvent) => setSidebarWidth(clamp(startW + (ev.clientX - startX)));
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.classList.remove("is-sidebar-resizing");
      try {
        localStorage.setItem(SIDEBAR_W_KEY, String(sidebarWidthRef.current));
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.classList.add("is-sidebar-resizing");
  };
  const [workspaceName, setWorkspaceName] = useState("默认空间");
  const [renamingSpace, setRenamingSpace] = useState<string | null>(null);
  const [renameSpaceValue, setRenameSpaceValue] = useState("");
  // 空间面板比默认弹层宽，把尺寸告知 usePopover，靠边打开才不会被裁切。
  const spaceChooser = usePopover<HTMLButtonElement>({ width: 380, minSpace: 400 });
  const [syncProfiles, setSyncProfiles] = useState<Record<string, SyncProfile>>({});
  const isDesktop = useMemo(() => (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window), []);

  // Load sync identities when the space switcher opens so the per-space tags
  // stay fresh (SyncPanel edits update sync_profiles).
  useEffect(() => {
    if (!spaceChooser.open) return;
    api
      .listSyncProfiles()
      .then((list) => {
        const byWs: Record<string, SyncProfile> = {};
        for (const p of list) byWs[p.ws_id] = p;
        setSyncProfiles(byWs);
      })
      .catch(() => {});
  }, [spaceChooser.open]);

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
  const activeSyncProfile = activeSpaceId ? syncProfiles[activeSpaceId] : undefined;

  // Also load identities when the active space changes so the header pill
  // ("当前同步目标") reflects the current space's sync target.
  useEffect(() => {
    if (!isDesktop) return;
    api
      .listSyncProfiles()
      .then((list) => {
        const byWs: Record<string, SyncProfile> = {};
        for (const p of list) byWs[p.ws_id] = p;
        setSyncProfiles(byWs);
      })
      .catch(() => {});
  }, [activeSpaceId, isDesktop]);

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
  };

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

  const tree = useMemo(() => buildTree(pages), [pages]);
  return (
    <div className={`sidebar ${collapsed ? "sidebar-collapsed" : ""}`} hidden={!sidebarOpen}>
      {!collapsed && (
        <div className="sidebar-resizer" onPointerDown={onSidebarResizeStart} title="拖拽调整侧边栏宽度" />
      )}
      <div className="sidebar-header">
        {!collapsed && (
          <button
            ref={spaceChooser.triggerRef}
            className="sidebar-title"
            onClick={spaceChooser.toggle}
            title="切换工作空间"
          >
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
            <span className="sidebar-title-text">{workspaceName}</span>
            <span className="sidebar-title-caret">▾</span>
          </button>
        )}
        {/* 同步状态：自绘标题栏开着时由 <TitleBar /> 承担（顶栏本就要有内容，
            也省下侧栏一行）；关掉自绘标题栏用系统栏时，这里补回来，否则这条
            信息会整个消失。 */}
        {!collapsed && isDesktop && !customTitleBar && activeSyncProfile && (
          <div className="sidebar-sync-pill" title={`同步目标：${activeSyncProfile.server_url}`}>
            <span
              className="sidebar-sync-dot"
              style={{ background: syncTagColor(activeSyncProfile.server_url) }}
            />
            <span className="sidebar-sync-pill-text">
              正在以 {syncTagLabel(activeSyncProfile.server_url)} 同步
            </span>
          </div>
        )}
        {spaceChooser.open && (
          <div
            ref={spaceChooser.contentRef}
            className="space-switcher"
            style={{ top: spaceChooser.pos.top, left: spaceChooser.pos.left }}
            role="dialog"
            aria-label="工作空间"
          >
            <header className="space-switcher-head">
              <div className="space-switcher-head-text">
                <div className="space-switcher-title">工作空间</div>
                <div className="space-switcher-sub">每个空间独立存储，可单独导出与加密</div>
              </div>
              <span className="space-switcher-count">{spaces.length}</span>
            </header>

            <div className="space-switcher-list">
              {spaces.length === 0 ? (
                <div className="space-switcher-empty">暂无工作空间</div>
              ) : (
                spaces.map((s) => {
                  const active = s.id === activeSpaceId;
                  const prof = syncProfiles[s.id];
                  return (
                    <Fragment key={s.id}>
                      <div
                        className={`space-item${active ? " is-active" : ""}`}
                        role="button"
                        tabIndex={0}
                        onClick={() => switchSpace(s.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            void switchSpace(s.id);
                          }
                        }}
                      >
                        <span
                          className="space-item-mark"
                          style={s.theme ? { background: s.theme, color: "#fff", border: "none" } : undefined}
                        >
                          {s.name.charAt(0)}
                        </span>
                        <div className="space-item-body">
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
                            <span className="space-item-name" title={s.name}>{s.name}</span>
                          )}
                          {/* 第二行放「当前 / 同步目标」，让每个空间的状态一眼可见， */}
                          {/* 而不是把同步标签硬塞进名字后面挤成一行。 */}
                          <div className="space-item-meta">
                            {active && <span className="space-item-current">当前</span>}
                            {isDesktop && prof ? (
                              <span
                                className="space-item-sync-tag"
                                style={{ color: syncTagColor(prof.server_url) }}
                                title={`同步：${prof.server_url}`}
                              >
                                {syncTagLabel(prof.server_url)}
                              </span>
                            ) : (
                              <span className="space-item-local">仅本机</span>
                            )}
                          </div>
                        </div>
                        <div className="space-item-ops" onClick={(e) => e.stopPropagation()}>
                          {renamingSpace !== s.id && (
                            <button
                              className="space-item-op"
                              title="重命名工作空间"
                              aria-label={`重命名 ${s.name}`}
                              onClick={() => startRenameSpace(s)}
                            >
                              ✎
                            </button>
                          )}
                        </div>
                      </div>
                    </Fragment>
                  );
                })
              )}
            </div>

            <footer className="space-switcher-foot">
              <button className="space-action is-primary" onClick={createSpace}>
                <span className="space-action-icon">＋</span>
                <span>新建工作空间</span>
              </button>
              {/* 配色 / 删除 / 导出导入这些低频且有破坏性的操作已移到设置中心，
                  这里只留高频的「切换 + 重命名 + 新建」。 */}
              <button
                className="space-action"
                onClick={() => {
                  spaceChooser.close();
                  useEditorStore.getState().openSettings("spaces");
                }}
              >
                <span className="space-action-icon">⚙</span>
                <span>管理空间（配色 / 删除 / 导入导出）</span>
              </button>
            </footer>
          </div>
        )}
        </div>
        <div className="sidebar-header-actions">
          <div className="sidebar-actions-group">
            {/* 搜索已收编进左侧竖条（activity=search，侧栏变搜索面板），
                这里不再放第二个搜索入口；快速跳转仍可用 Ctrl+K 命令面板。
                同步留在这里：它与「当前空间」强相关，且需要状态胶囊常驻可见。 */}
            <SyncPanel />
          </div>
          <div className="new-menu">
            {/* 「新建」是侧栏最高频动作，做成带文字的整行按钮：比一个蓝色实心
                方块克制，也比纯图标好认（点开是页面/文件夹/数据库三选一）。 */}
            <button ref={newMenuRef} className="btn-new" onClick={toggleNewMenu} title="新建" aria-label="新建">
              <PlusIcon width={15} height={15} strokeWidth={2.2} />
              <span className="btn-new-label">新建</span>
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
      {/* 侧栏底部栏已整条移除：回收站归左侧竖条（看内容=导航），
          备份与存储清理归设置中心「数据」页（低频 + 不可逆）。
          页面树因此占满整个侧栏高度。 */}

      {/* 空间导出/导入进度条已随迁移逻辑一起移出侧栏，由 App 级
          <SpaceTransferProgress /> 订阅 useSpaceTransfer 统一渲染 —— 这样
          任何面板关掉后进度仍然可见。 */}

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
