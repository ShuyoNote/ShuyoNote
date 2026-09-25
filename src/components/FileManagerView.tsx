import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { platform } from "../lib/platform";
import { useNotes } from "../store/notes";
import { useSpaceStore } from "../store/space";
import { useFileManagerStore } from "../store/fileManager";
import { confirmDialog } from "../store/confirm";
import { inputDialog } from "../store/input";
import { api } from "../lib/api";
import { toast } from "../store/toast";
import { usePdfReader } from "../store/pdfReader";
import { useSyncStatus } from "../store/syncStatus";
import { useFilePreview } from "../store/filePreview";
import type { AttachmentMeta, PageMeta } from "../types";
import { ChevronRightIcon, DatabaseIcon, FolderIcon, PageIcon, DownloadIcon, TrashIcon, UploadIcon, HistoryIcon } from "./icons";
import { PluginMenuItems } from "./PluginMenuItems";
import { fileContextArgs } from "../lib/pluginMenus";
import { attachmentFetchHint } from "../lib/attachmentFetchHint";
import {
  FM_VIEW_KEY,
  defaultFileView,
  readSavedFileView,
  type FileViewMode,
} from "../lib/fileManagerView";
import { isNarrowViewport, useMobileOverlayViewport } from "../hooks/useMobile";

// 右键菜单用的内联 SVG（打开 / 改名）。
const OpenIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M5 12h14M12 5l7 7-7 7" />
  </svg>
);
const EditIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);
// 「阅读并标注」（PDF）：行内小按钮与动作面板共用一份，免得两处画得不一样。
const AnnotateIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
    <path d="M14 3v6h6" />
    <path d="M9 14l3-3 2.5 2.5-3 3z" />
  </svg>
);
// 「移动到文件夹」：窄屏行内那六个小按钮被收进动作面板，面板里必须有它。
const MoveIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 7a2 2 0 0 1 2-2h3.6l1.8 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <path d="M12 16v-5" />
    <path d="M9.6 13.2 12 10.8l2.4 2.4" />
  </svg>
);

// 表格 / 网格里的一行：页面或文件夹（`pageId`），或一个附件文件（`file` + `versions`）。
// 抽成别名是因为它被**四处**共用——表格行的动作按钮、动作面板（`ctxMenu.row`）、
// `deleteRow` / `renameRow`；少写一个字段就会让"面板里少一个动作"这类漏项通过编译。
type FileRow = {
  kind: string;
  pageId?: string;
  name: string;
  file?: AttachmentMeta;
  versions?: AttachmentMeta[];
};

/**
 * `row.cover` 存的是 **CSS 值**（`url("covers/x.jpg")`，见 `lib/covers.ts` 与 `CoverPicker`），
 * 而这里要用的是 `<img src>` ⇒ 必须剥掉 `url(...)` 外壳。
 *
 * ⚠️ 2026-09-23：原来直接把 CSS 值塞进 `src`，浏览器去取 `/url(%22covers/default-cover.jpg%22)`
 * ⇒ 404（默认封面那张必现）。这条是 web 产物验收新加的 Markdown 探针顺手抓到的。
 * 认不出外壳时原样返回（用户自己上传的封面可能是 data: URL，那种本来就能直接当 src）。
 */
export function coverUrlOf(css: string): string {
  const m = /^url\((['"]?)(.*?)\1\)$/.exec(String(css ?? "").trim());
  return m ? m[2] : String(css ?? "");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(1)} ${units[i]}`;
}

function fileIcon(mime: string): string {
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

interface ImportProgressEvent {
  index: number;
  total: number;
  name: string;
  done: number;
  size: number;
}

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

// 迷你内容预览（页面卡）：标题 + 正文开头几行，像模板卡。
// 迷你内容预览（页面卡）：显示正文开头几行（无标题栏）。
function MiniPreview({ content }: { content: string }) {
  const lines = (content ?? "").split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 4);
  return (
    <div className="fm-grid-mini">
      {lines.length ? (
        lines.map((l, i) => (
          <div
            key={i}
            className="fm-grid-mini-line"
            style={{ width: `${Math.min(96, 58 + (l.length % 5) * 8)}%` }}
          >
            {l}
          </div>
        ))
      ) : (
        <div className="fm-grid-mini-line" style={{ width: "62%" }} />
      )}
    </div>
  );
}

// FlowUs-style file manager: browse the page/folder hierarchy as a table with
// type + modified/created columns, and create pages/folders inside a folder.
export function FileManagerView() {
  const { t } = useTranslation();
  // 窄屏（或矮视口）下动作面板贴底成面板：内联的 x/y 定位在窄屏**不写**，由 CSS 接管
  // ——与 `.pdf-reader` 那条"浮层形态下不许写内联宽度"是同一条纪律（内联样式优先级更高，
  // 两边各改一半必然有一边不生效）。
  const isSheet = useMobileOverlayViewport();
  const { pages, openPage, createPage, createFolder } = useNotes();
  const { folderId, setFolderId } = useFileManagerStore();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [files, setFiles] = useState<AttachmentMeta[]>([]);
  const [importing, setImporting] = useState(false);
  const [fileQuery, setFileQuery] = useState("");
  const [dragging, setDragging] = useState(false);
  const [moving, setMoving] = useState<AttachmentMeta | null>(null);
  const [versionTarget, setVersionTarget] = useState<AttachmentMeta | null>(null);
  const [progress, setProgress] = useState<{ name: string; percent: number } | null>(null);
  const importingRef = useRef(false);
  // 视图默认值：用户**显式选过**就永远听他的；没选过才按真实容器宽决定
  //（策略与依据全在 lib/fileManagerView.ts，这里只负责喂它两个事实）。
  const [savedView] = useState(() => readSavedFileView(localStorage.getItem(FM_VIEW_KEY)));
  const [viewMode, setViewMode] = useState<FileViewMode>(() => savedView ?? "list");
  // 只在"用户没选过"时自动决定，且**只决定一次**：手动切回表格后不许被窗口宽度抢回去。
  const autoDecidedRef = useRef(savedView !== null);
  const viewRootRef = useRef<HTMLDivElement>(null);
  // 用 layout effect（浏览器首次绘制**之前**）量取容器真实宽度，避免"先画表格再跳卡片"的闪动。
  useLayoutEffect(() => {
    if (autoDecidedRef.current) return;
    const w = viewRootRef.current?.clientWidth ?? 0;
    // 量不到（未挂载 / 隐藏）就先不动，保持既有默认表格。
    if (w > 0) {
      setViewMode(defaultFileView(null, w));
      autoDecidedRef.current = true;
    }
    // 有意只跑一次：进入时的宽度决定形态，之后的缩放不强制切换（用户的显式选择优先）。
  }, []);
  const setView = (v: FileViewMode) => {
    try { localStorage.setItem(FM_VIEW_KEY, v); } catch { /* ignore */ }
    setViewMode(v);
  };
  // 网格视图内容预览：pageId -> content_text（按需拉取，避免全列表带正文）。
  const [pageContent, setPageContent] = useState<Record<string, string>>({});
  // 网格视图文本/文档预览：fileId -> 文本内容（按需读取）。
  const [textPreview, setTextPreview] = useState<Record<string, string>>({});
  // 去掉与页面名相同的标题行与空行，返回正文（避免 content_text 首行=标题时重复）。
  const pageBody = (id: string, name: string): string => {
    const raw = pageContent[id] || "";
    return raw.split("\n").map((l) => l.trim()).filter((l) => l && l !== name).join("\n");
  };
  // 页面 cover 图加载失败（Web 端 asset url 常失败）→ 回退图标占位，避免显示 alt/broken 图标。
  const [brokenCovers, setBrokenCovers] = useState<Set<string>>(() => new Set());
  // 网格缩略图大小（列数随之自适应）。
  // ⚠️ 窄屏默认取 140（不是 160）：320px 上可用宽 292，`minmax(160px,1fr)` 只会排到**一列**
  // ——一张 292px 的瓷砖，缩略图被拉成一条。140 时 2×140+12 = 292 正好两列。
  // 断点与 `useMobile.ts` 同源（`isNarrowViewport()` 读的就是 `MOBILE_BREAKPOINT_PX`）。
  const [gridSize, setGridSize] = useState<number>(
    () => Number(localStorage.getItem("shuyonote:fmGridSize")) || (isNarrowViewport() ? 140 : 160),
  );
  const setGrid = (n: number) => {
    try { localStorage.setItem("shuyonote:fmGridSize", String(n)); } catch { /* ignore */ }
    setGridSize(n);
  };
  // 右键菜单。
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; row: FileRow | null }>({ x: 0, y: 0, row: null });

  // folderId 为 null = 空间根：列出「未整理」文件（page_id IS NULL），
  // 而不是像以前那样直接清空——根下也允许上传，文件得有地方显示。
  const loadFiles = () => {
    api
      .listPageAttachments(folderId ?? null)
      .then((fs) => {
        setFiles(fs);
        loadOnDisk();
      })
      .catch(() => {});
  };
  useEffect(loadFiles, [folderId]);

  // P6.2「未下载」状态（2026-09-15）：附件**行**是随 `changes` 同步过来的，**字节不一定在**
  // （这正是 P6.1 每空间开关关掉之后、以及预算刹车跳过之后的既有状态）。
  // 判据用**盘上真实有的 hash**（`list_attachment_hashes` 走附件目录，不是数据库），
  // 所以"数据库里有一行、盘上没文件"能被如实标出来。
  const [onDisk, setOnDisk] = useState<Set<string>>(new Set());
  const [fetching, setFetching] = useState<string | null>(null);
  const loadOnDisk = () => {
    api
      .listAttachmentHashes()
      .then((hs) => setOnDisk(new Set(hs)))
      .catch(() => {});
  };

  // 一次同步**结束时**重载列表（`syncing` 由真变假）。
  //
  // 为什么需要：2026-09-15 真机验收时发现，后台/自动同步拉进来的新附件**不会自己出现**——
  // `loadFiles()` 只在切换文件夹、导入、删除之后才跑，于是「未下载」标记要**重载页面**
  // 才看得见，而那恰好是 P6.1 + P6.2 的主流程（关掉开关 → 同步 → 看哪些没下来）。
  //
  // 判据取 `useSyncStatus` 的下降沿：手动同步（`SyncPanel`）、自动同步（`useAutoSync` /
  // `App.tsx` 的定时器）与 Web 引擎（`web.ts`）**三条路都会配对 begin/end** ⇒ 一处挂载全覆盖。
  const syncing = useSyncStatus((s) => s.syncing);
  const wasSyncing = useRef(false);
  useEffect(() => {
    if (wasSyncing.current && !syncing) loadFiles();
    wasSyncing.current = syncing;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncing]);

  /** 把这一件的字节从服务器取回来（P6.3 按需取字节）。返回是否成功。 */
  const fetchBytes = async (f: AttachmentMeta): Promise<boolean> => {
    const wsId = useSpaceStore.getState().activeId;
    if (!wsId) {
      toast("请先选择一个空间", "error");
      return false;
    }
    setFetching(f.hash);
    try {
      await api.downloadAttachment(wsId, f.hash);
      loadOnDisk();
      toast(`已下载「${f.name}」`, "success");
      return true;
    } catch (e) {
      // 与打开路径共用同一套分类（`attachmentFetchHint`）："取不回"要说清怎么办，
      // 不能一律甩一句原文（2026-09-19 社区缺陷帖 #6）。
      toast(attachmentFetchHint(e), "error");
      return false;
    } finally {
      setFetching(null);
    }
  };

  // Streaming import progress from the backend (content-addressed, large-file safe).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    platform.event.listen<ImportProgressEvent>("attachment-import-progress", (event) => {
      if (!importingRef.current) return;
      const p = event.payload;
      const current = p.size > 0 ? p.done / p.size : 1;
      const overall = ((p.index + current) / p.total) * 100;
      setProgress({ name: p.name, percent: Math.min(100, Math.round(overall)) });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  const uploadFiles = async () => {
    let selectedPath: string | string[] | null;
    try {
      selectedPath = await platform.dialog.open({ multiple: true, title: "选择文件" });
    } catch (e) {
      toast(`选择文件失败：${e}`, "error");
      return;
    }
    const paths = Array.isArray(selectedPath) ? selectedPath : selectedPath ? [selectedPath] : [];
    if (paths.length === 0) return;
    await importPaths(paths);
  };

  const importPaths = async (paths: string[]) => {
    if (paths.length === 0) return;
    setImporting(true);
    importingRef.current = true;
    setProgress({ name: paths[0] ?? "", percent: 0 });
    try {
      // folderId 为 null 时传 null：文件落到空间根的「未整理」区，
      // 而不是被静默丢弃（此前根目录拖拽是直接 return）。
      const metas = await api.importAttachmentFiles(folderId ?? null, paths);
      setFiles((prev) => [...metas, ...prev]);
      useFileManagerStore.getState().bumpRevision();
      toast(`已上传 ${metas.length} 个文件`, "success");
    } catch (e) {
      toast(`上传失败：${e}`, "error");
    } finally {
      importingRef.current = false;
      setImporting(false);
      setProgress(null);
    }
  };

  // Drag OS files into an open folder to upload them (Tauri drag-drop event).
  useEffect(() => {
    const unlisten = platform.webview.onDragDropEvent((event) => {
      if (event.payload.type === "over") setDragging(true);
      else if (event.payload.type === "leave") setDragging(false);
      else if (event.payload.type === "drop") {
        setDragging(false);
        importPaths(event.payload.paths);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderId]);

  const moveTo = async (f: AttachmentMeta, targetFolderId: string) => {
    if (targetFolderId === folderId) {
      setMoving(null);
      return;
    }
    try {
      await api.moveAttachment(f.id, targetFolderId);
      setFiles((prev) => prev.filter((x) => x.id !== f.id));
      toast("已移动", "success");
    } catch (e) {
      toast(`移动失败：${e}`, "error");
    }
    setMoving(null);
  };

  const openFile = async (path: string) => {
    if (!path) return;
    try {
      await platform.opener.openPath(path);
    } catch (e) {
      toast(`打开失败：${e}`, "error");
    }
  };
  const revealFile = async (path: string) => {
    if (!path) return;
    try {
      await platform.opener.revealItemInDir(path);
    } catch (e) {
      toast(`打开失败：${e}`, "error");
    }
  };
  const removeFile = async (id: string) => {
    if (
      !(await confirmDialog({
        title: "移除文件",
        message: "移除后，若该文件不再被任何页面/文件夹引用，其磁盘存储也会被清除。确定移除？",
        danger: true,
      }))
    ) {
      return;
    }
    try {
      await api.removeAttachment(id);
      setFiles((prev) => prev.filter((f) => f.id !== id));
      useFileManagerStore.getState().bumpRevision();
      toast("已移除文件", "success");
    } catch (e) {
      toast(`移除失败：${e}`, "error");
    }
  };

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

  // Unified file list: folders/pages/databases + uploaded files, as table rows.
  // Same-named files in a folder are grouped (the first = current, the rest are
  // implicitly content-addressed historical versions).
  const fileGroups = useMemo(() => {
    const map = new Map<string, AttachmentMeta[]>();
    for (const f of files) {
      const arr = map.get(f.name) ?? [];
      arr.push(f);
      map.set(f.name, arr);
    }
    const out: { current: AttachmentMeta; versions: AttachmentMeta[] }[] = [];
    for (const arr of map.values()) {
      out.push({ current: arr[0], versions: arr.slice(1) });
    }
    return out;
  }, [files]);

  const rows = useMemo(() => {
    type FmRow = {
      key: string;
      kind: "page" | "folder" | "database" | "file";
      name: string;
      size: string;
      updated: string;
      created: string;
      pageId?: string;
      cover?: string;
      file?: AttachmentMeta;
      versions?: AttachmentMeta[];
    };
    const out: FmRow[] = [];
    for (const p of sorted) {
      out.push({
        key: p.id,
        kind: p.kind as FmRow["kind"],
        name: p.title || (p.kind === "folder" ? "新建文件夹" : "未命名"),
        size: "—",
        updated: fmtDate(p.updated_at),
        created: fmtDate(p.created_at),
        pageId: p.id,
        cover: (p as unknown as { cover?: string }).cover ?? "",
      });
    }
    for (const g of fileGroups) {
      out.push({
        key: "file:" + g.current.id,
        kind: "file",
        name: g.current.name,
        size: formatSize(g.current.size),
        // 两列时间的口径（2026-09-19，用户截图报"时间全是 —"）：
        //  - **创建时间** = DB 的 `attachments.created_at`（`listPageAttachments` 现在会带出来）；
        //  - **上次修改时间** = **本地文件**的 mtime（`mtime`）；表里没有 `updated_at`，
        //    所以未下载的行**如实**显示「—」，**不拿 created_at 冒充**（`fmtDate(0)` ⇒ "—"）。
        // 旧后端（不带这两个字段）时两个都是 undefined ⇒ 同样是「—」，不会崩。
        updated: fmtDate(g.current.mtime ?? 0),
        created: fmtDate(g.current.created_at ?? 0),
        file: g.current,
        versions: g.versions,
      });
    }
    return out;
  }, [sorted, fileGroups]);

  // 网格视图：按需拉取可见页面的 content_text 用于内容预览（仅网格 + 未缓存时）。
  // 网格视图：按需取可见页面的 content_text（仅网格；取一次不随 pageContent 重跑，
  // 避免失败页面反复重试导致卡死）。
  useEffect(() => {
    if (viewMode !== "grid") return;
    const ids = rows
      .filter((r) => r.kind !== "file" && r.pageId)
      .map((r) => r.pageId!);
    if (!ids.length) return;
    let cancelled = false;
    Promise.all(ids.map((id) => api.getPage(id).catch(() => null))).then((res) => {
      if (cancelled) return;
      const map: Record<string, string> = {};
      ids.forEach((id, i) => {
        const d = res[i] as (Record<string, unknown> & { content_text?: string }) | null;
        if (d) map[id] = (d.content_text ?? "") as string;
      });
      setPageContent((prev) => ({ ...prev, ...map }));
    });
    return () => { cancelled = true; };
  }, [viewMode, rows]);

  // 网格视图：按需读取文本/文档类文件的内容用于摘要预览（仅网格 + 未读过的）。
  useEffect(() => {
    if (viewMode !== "grid") return;
    const isText = (mime: string) => mime.startsWith("text/") || mime === "application/json" || mime === "application/xml";
    const todo = rows
      .filter((r) => r.kind === "file" && r.file && r.file.path && isText(r.file.mime || "") && !textPreview[r.file.id])
      .map((r) => r.file!);
    if (!todo.length) return;
    let cancelled = false;
    Promise.all(todo.map((f) => api.readTextFile(f.path).catch(() => ""))).then((res) => {
      if (cancelled) return;
      const map: Record<string, string> = {};
      todo.forEach((f, i) => { map[f.id] = res[i] ?? ""; });
      setTextPreview((prev) => ({ ...prev, ...map }));
    });
    return () => { cancelled = true; };
  }, [viewMode, rows]);

  // 点击任意处关闭右键菜单。
  useEffect(() => {
    if (!ctxMenu.row) return;
    const onMouseDown = () => closeCtx();
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [ctxMenu.row]);

  const selectedFileIds = useMemo(
    () => rows.filter((r) => r.kind === "file" && selected.has(r.key)).map((r) => r.file!.id),
    [rows, selected],
  );
  const selectedPageIds = useMemo(
    () => rows.filter((r) => r.kind !== "file" && selected.has(r.key)).map((r) => r.pageId!),
    [rows, selected],
  );
  const selectedCount = selected.size;

  // Select-all covers every visible row (pages / folders / databases / files).
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.key));

  const toggleSelectAll = () => {
    setSelected((s) => {
      const next = new Set(s);
      if (allSelected) {
        for (const r of rows) next.delete(r.key);
      } else {
        for (const r of rows) next.add(r.key);
      }
      return next;
    });
  };

  const batchRemove = async () => {
    if (selectedCount === 0) return;
    const fileCount = selectedFileIds.length;
    const pageCount = selectedPageIds.length;
    const parts: string[] = [];
    if (pageCount) parts.push(`${pageCount} 个页面/文件夹`);
    if (fileCount) parts.push(`${fileCount} 个文件`);
    if (!(await confirmDialog({
      title: "批量删除",
      message: `删除选中的 ${parts.join("、")}？${fileCount ? "文件若无引用其磁盘存储也会被清除。" : ""}`,
      danger: true,
    }))) {
      return;
    }
    try {
      // Delete pages/folders first (children then parents), then files.
      // 用后端 api.deletePage 逐个软删（含后代），最后统一 reload，避免逐个 loadPages 中断。
      for (const pageId of selectedPageIds) {
        await api.deletePage(pageId).catch(() => {});
      }
      if (pageCount > 0) await useNotes.getState().loadPages();
      if (fileCount > 0) {
        const n = await api.removeAttachments(selectedFileIds);
        setFiles((prev) => prev.filter((f) => !selectedFileIds.includes(f.id)));
        toast(`已删除 ${parts.join("、")}`, "success");
        if (n !== fileCount) {
          toast(`文件删除完成：${n} 个`, "info");
        }
      } else if (pageCount > 0) {
        toast(`已删除 ${pageCount} 个页面/文件夹`, "success");
      }
      setSelected(new Set());
      useFileManagerStore.getState().bumpRevision();
    } catch (e) {
      toast(`批量删除失败：${e}`, "error");
    }
  };

  const newFolder = () => createFolder(folderId);
  // createPage navigates to the editor with the new page already open.
  const newPage = () => createPage(folderId);

  // 打开一行（列表 / 网格共用）：图片/视频/音频/PDF 应用内预览，文件用系统应用，
  // 文件夹/页面进入。
  const openRow = (row: { kind: string; pageId?: string; file?: AttachmentMeta }) => {
    if (row.kind === "file") {
      if (row.file!.mime === "application/pdf") {
        void usePdfReader.getState().openPdf(row.file!.id, row.file!.name);
      } else if (
        row.file!.mime === "text/markdown" ||
        row.file!.mime.startsWith("image/") ||
        row.file!.mime.startsWith("video/") ||
        row.file!.mime.startsWith("audio/")
      ) {
        // 打开文件预览时关掉可能仍开着的 PDF 阅读器，避免两个查看器叠一起。
        usePdfReader.getState().close();
        useFilePreview.getState().open(row.file!);
      } else {
        toast("正在用系统默认应用打开…", "info");
        openFile(row.file!.path);
      }
    } else if (row.kind === "folder") {
      setFolderId(row.pageId!);
    } else {
      openPage(row.pageId!);
    }
  };

  // 网格视图按「照片/视频优先」排序（照片墙），页面/文件夹/其它文件靠后。
  const isMediaRow = (r: (typeof rows)[number]) =>
    r.kind === "file" && !!r.file && (r.file.mime.startsWith("image/") || r.file.mime.startsWith("video/"));
  const gridRows = useMemo(() => {
    const media = rows.filter(isMediaRow);
    const rest = rows.filter((r) => !isMediaRow(r));
    return [...media, ...rest];
  }, [rows]);

  const fileTotalBytes = useMemo(
    () => files.reduce((s, f) => s + (f.size || 0), 0),
    [files],
  );
  const q = fileQuery.trim().toLowerCase();
  const visibleRows = useMemo(
    () => (q ? rows.filter((r) => r.name.toLowerCase().includes(q)) : rows),
    [rows, q],
  );
  const folderTargets = useMemo(
    () => pages.filter((p) => p.kind === "folder" && p.id !== folderId),
    [pages, folderId],
  );

  const downloadFile = async (f: AttachmentMeta) => {
    const dest = await platform.dialog.save({ title: "保存文件", defaultPath: f.name });
    if (!dest) return;
    try {
      await api.copyAttachment(f.hash, dest);
      toast("已保存", "success");
    } catch (e) {
      toast(`下载失败：${e}`, "error");
    }
  };

  const restoreVersion = async (sourceId: string) => {
    if (!folderId) return;
    try {
      await api.restoreAttachment(folderId, sourceId);
      loadFiles();
      setVersionTarget(null);
      toast("已恢复到此版本", "success");
    } catch (e) {
      toast(`恢复失败：${e}`, "error");
    }
  };

  const closeCtx = () => setCtxMenu({ x: 0, y: 0, row: null });

  // 右键「删除」：文件硬删（附件），页面/文件夹软删（进回收站）。
  const deleteRow = async (row: FileRow) => {
    const label = row.name || "未命名";
    const isFile = row.kind === "file" && !!row.file;
    const msg = isFile
      ? `删除文件「${label}」？若不被引用，其磁盘存储也会被清除。`
      : `删除「${label}」？页面/文件夹将移入回收站（可恢复）。`;
    if (!(await confirmDialog({ title: "删除", message: msg, danger: true }))) return;
    try {
      if (isFile) {
        await api.removeAttachment(row.file!.id);
      } else if (row.pageId) {
        await api.deletePage(row.pageId);
      }
      await useNotes.getState().loadPages();
      useFileManagerStore.getState().bumpRevision();
      loadFiles();
      toast("已删除", "success");
    } catch (e) {
      toast(`删除失败：${e}`, "error");
    }
  };

  // 右键「改名」：文件改附件名，页面/文件夹改标题。
  const renameRow = (row: FileRow) => {
    const current = row.name || "未命名";
    inputDialog({
      title: "改名",
      placeholder: "名称",
      defaultValue: current,
      onSubmit: async (name) => {
        const n = name.trim();
        if (!n || n === current) return;
        try {
          if (row.kind === "file" && row.file) {
            await api.renameAttachment(row.file.id, n);
          } else if (row.pageId) {
            await api.savePage({ id: row.pageId, title: n });
          }
          // 强制刷新：页面树（侧边栏）订阅 useNotes.pages 与 fileManager.revision，
          // 两者都刷新才能让侧边栏 / 文件管理网格及时显示新名字。
          await useNotes.getState().loadPages();
          useFileManagerStore.getState().bumpRevision();
          loadFiles();
          toast("已改名", "success");
        } catch (e) {
          toast(`改名失败：${e}`, "error");
        }
      },
    });
  };

  return (
    <div className="file-manager" ref={viewRootRef}>
      <div className="file-manager-head">
        <div className="file-manager-title-block">
          <span className="file-manager-bigicon">
            <FolderIcon width={26} height={26} />
          </span>
          <h1 className="file-manager-title">{t("files.title")}</h1>
        </div>
        <div className="file-manager-actions">
          <button
            className="fm-btn fm-btn-danger"
            onClick={batchRemove}
            disabled={selectedCount === 0}
            title="删除选中的页面/文件夹/文件"
            aria-label="删除选中"
          >
            <TrashIcon className="fm-btn-icon" width={18} height={18} />
            <span className="fm-btn-text">
              {selectedCount > 0 ? `${t("files.removeSelected")} (${selectedCount})` : t("files.removeSelected")}
            </span>
          </button>
          <button className="fm-btn" onClick={newFolder} title={t("files.newFolder")} aria-label={t("files.newFolder")}>
            <FolderIcon className="fm-btn-icon" width={18} height={18} />
            <span className="fm-btn-text">＋ {t("files.newFolder")}</span>
          </button>
          <button className="fm-btn" onClick={newPage} title={t("files.newPage")} aria-label={t("files.newPage")}>
            <PageIcon className="fm-btn-icon" width={18} height={18} />
            <span className="fm-btn-text">＋ {t("files.newPage")}</span>
          </button>
          <button
            className="fm-btn"
            onClick={uploadFiles}
            disabled={importing}
            title={folderId ? "批量上传文件" : "上传到空间根目录（未整理）"}
            aria-label={t("files.upload")}
          >
            <UploadIcon className="fm-btn-icon" width={18} height={18} />
            <span className="fm-btn-text">{importing ? t("files.uploading") : `＋ ${t("files.upload")}`}</span>
          </button>
          <div className="fm-view-toggle" role="group" aria-label="视图切换">
            <button
              className={`fm-view-btn${viewMode === "list" ? " is-on" : ""}`}
              title={t("files.list")}
              onClick={() => setView("list")}
            >☰</button>
            <button
              className={`fm-view-btn${viewMode === "grid" ? " is-on" : ""}`}
              title={t("files.grid")}
              onClick={() => setView("grid")}
            >▦</button>
          </div>
          {viewMode === "grid" && (
            <label className="fm-size-slider" title={t("files.sort")}>
              <input
                type="range"
                min={120}
                max={280}
                step={8}
                value={gridSize}
                style={{ "--fill": `${((gridSize - 120) / 160) * 100}%` } as unknown as CSSProperties}
                onChange={(e) => setGrid(Number(e.target.value))}
              />
            </label>
          )}
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
        <span className="fm-count">
          {files.length} 个文件 · 共 {formatSize(fileTotalBytes)} · {visibleRows.length} 项
        </span>
        <input
          className="fm-search"
          placeholder="搜索文件…"
          value={fileQuery}
          onChange={(e) => setFileQuery(e.target.value)}
        />
      </div>

      {progress && (
        <div className="fm-progress">
          <div className="fm-progress-label">
            <span>上传：{progress.name}</span>
            <span>{progress.percent}%</span>
          </div>
          <div className="fm-progress-track">
            <div className="fm-progress-fill" style={{ width: `${progress.percent}%` }} />
          </div>
        </div>
      )}

      <div className="file-manager-table-wrap">
        {viewMode === "grid" && (
          <div className="fm-grid" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${gridSize}px, 1fr))` }}>
            {gridRows.length === 0 && <div className="fm-empty">没有文件</div>}
            {gridRows.map((row) => {
              const isImage = row.kind === "file" && row.file?.mime.startsWith("image/") && row.file.path;
              const isVideo = row.kind === "file" && row.file?.mime.startsWith("video/") && row.file.path;
              const isAudio = row.kind === "file" && row.file?.mime.startsWith("audio/") && row.file.path;
              const isTextFile = row.kind === "file" && row.file?.mime && (
                row.file.mime.startsWith("text/") || row.file.mime === "application/json" || row.file.mime === "application/xml"
              );
              // 页面/数据库有 cover（题头图）时显示缩略图，否则小图标占位。
              const pageCover =
                row.kind !== "file" &&
                row.cover &&
                typeof row.cover === "string" &&
                !row.cover.startsWith("#") &&
                row.cover.length > 6 &&
                row.cover;
              return (
                <div
                  key={row.key}
                  className={`fm-grid-card${selected.has(row.key) ? " is-selected" : ""}`}
                  onClick={(e) => {
                    if (e.ctrlKey || e.metaKey || e.shiftKey) toggleSelect(row.key);
                    else openRow(row);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setCtxMenu({ x: e.clientX, y: e.clientY, row });
                  }}
                >
                  {/* 窄屏把命中区交给外面这层 `label`（44×44）——见 App.css 的
                      `.fm-grid-checkwrap`。桌面它只是个"位置透明"的包裹层，勾选框照旧
                      绝对定位在右上角、照旧只在 hover/选中时显形。 */}
                  <label
                    className="fm-grid-checkwrap"
                    title="选择"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      className="fm-grid-check"
                      checked={selected.has(row.key)}
                      onChange={() => toggleSelect(row.key)}
                      onClick={(e) => e.stopPropagation()}
                      title="选择"
                    />
                  </label>
                  {isImage ? (
                    <img
                      className="fm-grid-thumb"
                      src={platform.asset.convertFileSrc(row.file!.path)}
                      alt={row.name}
                      loading="lazy"
                    />
                  ) : isVideo ? (
                    <video
                      className="fm-grid-thumb"
                      src={platform.asset.convertFileSrc(row.file!.path)}
                      muted
                      preload="metadata"
                    />
                  ) : isAudio ? (
                    <div className="fm-grid-audio">
                      <audio
                        controls
                        preload="none"
                        src={platform.asset.convertFileSrc(row.file!.path)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </div>
                  ) : isTextFile && textPreview[row.file!.id] ? (
                    <MiniPreview content={textPreview[row.file!.id]} />
                  ) : pageCover && !brokenCovers.has(row.key) ? (
                    <img
                      className="fm-grid-thumb"
                      // ⚠️ `row.cover` 存的是**CSS 值**（`url("covers/x.jpg")`，见 `lib/covers.ts`
                      //    与 `CoverPicker`）；直接塞进 `src` 会让浏览器去取
                      //    `/url(%22covers/default-cover.jpg%22)` ⇒ 404（默认封面那张必现，
                      //    2026-09-23 由 web 产物验收的新探针抓到）。这里先剥掉 `url(...)` 外壳。
                      src={coverUrlOf(pageCover)}
                      alt={row.name}
                      loading="lazy"
                      onError={() => setBrokenCovers((prev) => new Set(prev).add(row.key))}
                    />
                  ) : row.pageId && pageContent[row.pageId] && pageBody(row.pageId, row.name) ? (
                    <MiniPreview content={pageBody(row.pageId, row.name) as string} />
                  ) : (
                    <span className="fm-grid-page">
                      <span className="fm-grid-page-icon">
                        {row.kind === "file" ? fileIcon(row.file!.mime) : <KindIcon kind={row.kind} />}
                      </span>
                    </span>
                  )}
                  <div className="fm-grid-name">{row.name}</div>
                  {row.kind === "file" && folderId === null && (
                    <div className="fm-grid-tag">未整理</div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {viewMode === "list" && (
        <table className="file-manager-table">
          <thead>
            <tr>
              <th className="fm-check-col">
                {/* 窄屏把命中区交给这个 `label`（44×44）——`input[type=checkbox]` 是
                    替换元素，Chrome 对它的 `padding` 不生效（实测 `padding:12px` 算出来是 0，
                    所以"content-box 撑大命中区"那招在这里没用）。label 包住 input 时
                    点 label 就是点 input，命中区就真的到了 44。 */}
                <label className="fm-selectall">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    title="全选/取消全选"
                  />
                </label>
              </th>
              <th className="fm-name-col">文件名</th>
              <th className="fm-kind-col">类型</th>
              <th className="fm-size-col">大小</th>
              <th className="fm-date-col">上次修改时间</th>
              <th className="fm-date-col">创建时间</th>
              <th className="fm-ops-col" />
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => (
              <tr
                key={row.key}
                className={selected.has(row.key) ? "fm-row-selected" : ""}
                onClick={() => toggleSelect(row.key)}
                // 窄屏没有 hover、右键也只能靠长按：列表模式此前**根本没有**右键入口
                // （只有网格那一支接了 `onContextMenu`）。手机上行内那六个 20px 小按钮
                // 换成下面那个 `⋯`，其余动作全在这一份面板里。
                onContextMenu={(e) => {
                  e.preventDefault();
                  setCtxMenu({ x: e.clientX, y: e.clientY, row });
                }}
              >
                <td className="fm-check-col">
                  <input
                    type="checkbox"
                    checked={selected.has(row.key)}
                    onChange={() => toggleSelect(row.key)}
                    onClick={(e) => e.stopPropagation()}
                  />
                </td>
                <td className="fm-name-col">
                  <button
                    className="fm-name-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      openRow(row);
                    }}
                  >
                    <span className="fm-kind-icon">
                      {row.kind === "file" ? fileIcon(row.file!.mime) : <KindIcon kind={row.kind} />}
                    </span>
                    <span className="fm-name">{row.name}</span>
                    {/* 根目录下的文件没有归属文件夹——明确标成「未整理」，
                        既解释了它为什么在这儿，也提示可以用 ↔ 移进文件夹。 */}
                    {row.kind === "file" && folderId === null && (
                      <span className="fm-inbox-tag">未整理</span>
                    )}
                    {/* P6.2：**行有、字节不在**（P6.1 关了开关 / 预算刹车跳过 / 还没轮到）。
                        不标出来的话，用户点开只会得到一句"附件文件不存在（可能被移动或删除）"，
                        而其实字节完好地躺在服务器上 —— 那是把人往"文件坏了"的方向误导。 */}
                    {row.kind === "file" && row.file && !onDisk.has(row.file.hash) && (
                      <span className="fm-missing-tag" title="字节还没下载到本机（在服务器上）">
                        未下载
                      </span>
                    )}
                  </button>
                </td>
                <td className="fm-kind-col">
                  {row.kind === "file" ? "文件" : KIND_LABELS[row.kind] ?? row.kind}
                </td>
                <td className="fm-size-col">{row.size}</td>
                {/* 附件这两列的**真实含义**要挂在 title 上，别让人误读：
                    「创建时间」= 附件入库时间（随同步走，跨设备一致）；
                    「上次修改时间」= **本地副本**的写入时间 —— 下载回来的文件显示的是**下载时刻**，
                    不是远端何时被改过（表里没有 updated_at）；字节还没下载时是「—」。 */}
                <td
                  className="fm-date"
                  title={row.kind === "file" ? "本地副本的修改时间（未下载到本机时为「—」；下载后 ≈ 下载时刻）" : undefined}
                >
                  {row.updated}
                </td>
                <td className="fm-date" title={row.kind === "file" ? "附件入库时间（随同步走，跨设备一致）" : undefined}>
                  {row.created}
                </td>
                <td className="fm-ops-col">
                  {/* 窄屏：六个小按钮 → 一个 `⋯`（44×44 命中区）。桌面 `display:none`。 */}
                  <button
                    className="fm-more-btn"
                    title="更多操作"
                    aria-label="更多操作"
                    onClick={(e) => {
                      e.stopPropagation();
                      setCtxMenu({ x: 0, y: 0, row });
                    }}
                  >
                    ⋯
                  </button>
                  {row.kind === "file" && (
                    <span className="fm-file-actions">
                      {/* M24 PDF 批注：直达阅读器，跳过预览层。openPdf 内自带 attachmentId+name。 */}
                      {row.file?.mime === "application/pdf" && (
                        <button
                          className="fm-file-annotate"
                          title="阅读并标注"
                          onClick={(e) => {
                            e.stopPropagation();
                            void usePdfReader.getState().openPdf(row.file!.id, row.file!.name);
                          }}
                        >
                          <AnnotateIcon size={15} />
                        </button>
                      )}
                      {row.versions && row.versions.length > 0 && (
                        <button
                          title={`${row.versions.length + 1} 个历史版本`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setVersionTarget(row.file!);
                          }}
                        >
                          ↻
                        </button>
                      )}
                      <button
                        title="移动到文件夹"
                        onClick={(e) => {
                          e.stopPropagation();
                          setMoving(row.file!);
                        }}
                      >
                        ↔
                      </button>
                      {/* P6.2/P6.3：字节不在本机时，「下载」的含义变成**先从服务器取回来**
                          （否则 save-as 只会失败说"附件不存在"）。取回成功后这一行立刻恢复正常。 */}
                      {!onDisk.has(row.file!.hash) ? (
                        <button
                          title="从服务器下载到本机"
                          disabled={fetching === row.file!.hash}
                          onClick={(e) => {
                            e.stopPropagation();
                            void fetchBytes(row.file!);
                          }}
                        >
                          {fetching === row.file!.hash ? "…" : "☁"}
                        </button>
                      ) : (
                        <button
                          title="下载"
                          onClick={(e) => {
                            e.stopPropagation();
                            downloadFile(row.file!);
                          }}
                        >
                          ⬇
                        </button>
                      )}
                      <button
                        title="在文件夹中显示"
                        onClick={(e) => {
                          e.stopPropagation();
                          revealFile(row.file!.path);
                        }}
                      >
                        📂
                      </button>
                      <button
                        title="移除文件"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeFile(row.file!.id);
                        }}
                      >
                        ×
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {visibleRows.length === 0 && (
              <tr>
                <td className="fm-empty" colSpan={7}>
                  {folderId === null
                    ? "还没有内容——新建页面/文件夹，或直接把文件拖进来（会放在根目录的「未整理」里）"
                    : "此文件夹为空，可上传文件"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        )}
      </div>

      {ctxMenu.row && (() => {
        const row = ctxMenu.row;
        const isFile = row.kind === "file" && !!row.file;
        const ctxItem = (icon: ReactNode, label: string, action: () => void, danger = false) => (
          <button className={`fm-ctx-item${danger ? " is-danger" : ""}`} onClick={action}>
            <span className="fm-ctx-ic">{icon}</span>
            <span className="fm-ctx-label">{label}</span>
          </button>
        );
        return (
          <div
            className={`fm-ctx${isSheet ? " is-sheet" : ""}`}
            style={isSheet ? undefined : { left: ctxMenu.x, top: ctxMenu.y }}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="fm-ctx-title" title={row.name}>{row.name || "未命名"}</div>
            <div className="fm-ctx-list">
              {isFile ? (
                <>
                  {ctxItem(<OpenIcon size={14} />, "打开", () => { openRow(row); closeCtx(); })}
                  {/* P6.2：字节不在本机时，右键里给的是"从服务器下载"，而不是会失败的 save-as。 */}
                  {row.file && !onDisk.has(row.file.hash)
                    ? ctxItem(<DownloadIcon width={14} height={14} />, "从服务器下载", () => { void fetchBytes(row.file!); closeCtx(); })
                    : ctxItem(<DownloadIcon width={14} height={14} />, "下载", () => { downloadFile(row.file!); closeCtx(); })}
                  {ctxItem(<FolderIcon width={14} height={14} />, "在文件夹中显示", () => { revealFile(row.file!.path); closeCtx(); })}
                  {/* 窄屏把行内那六个小按钮收进了这一份面板，所以面板必须**功能完整**：
                      少一项就等于"手机上某个动作消失了"——那比按钮小更糟。 */}
                  {row.file!.mime === "application/pdf" &&
                    ctxItem(<AnnotateIcon size={14} />, "阅读并标注", () => { void usePdfReader.getState().openPdf(row.file!.id, row.file!.name); closeCtx(); })}
                  {ctxItem(<MoveIcon size={14} />, "移动到文件夹", () => { setMoving(row.file!); closeCtx(); })}
                  {row.versions && row.versions.length > 0 &&
                    ctxItem(<HistoryIcon width={14} height={14} />, `${row.versions.length + 1} 个历史版本`, () => { setVersionTarget(row.file!); closeCtx(); })}
                </>
              ) : (
                ctxItem(<OpenIcon size={14} />, "打开", () => { openRow(row); closeCtx(); })
              )}
              {ctxItem(<EditIcon size={14} />, "改名", () => { renameRow(row); closeCtx(); })}
              {ctxItem(<TrashIcon width={14} height={14} />, "删除", () => { void deleteRow(row); closeCtx(); }, true)}
              {/* 插件命令：文件行给 `file.context`（入参是**被点的这个文件**的信息），
                  页面行给 `page.context`（"当前页"就是被点的那一页）。同一份组件，
                  两边都不会漏掉"只列启用中的插件"这类规矩。 */}
              {isFile ? (
                <PluginMenuItems
                  menuId="file.context"
                  pageId={row.pageId ?? null}
                  argsJson={fileContextArgs(row.file!)}
                  itemClass="fm-ctx-item"
                  onDone={closeCtx}
                />
              ) : (
                <PluginMenuItems
                  menuId="page.context"
                  pageId={row.pageId ?? null}
                  itemClass="fm-ctx-item"
                  onDone={closeCtx}
                />
              )}
            </div>
          </div>
        );
      })()}

      {versionTarget && (
        <div className="fm-version-overlay" onClick={() => setVersionTarget(null)}>
          <div className="fm-version-pop" onClick={(e) => e.stopPropagation()}>
            <div className="fm-version-head">
              <span className="fm-version-title">「{versionTarget.name}」的历史版本</span>
              <button className="fm-version-close" title="关闭" onClick={() => setVersionTarget(null)}>
                ×
              </button>
            </div>
            <div className="fm-version-list">
              <div className="fm-version-item fm-version-current">
                <span className="fm-version-badge">当前</span>
                <span className="fm-version-name">{versionTarget.name}</span>
                <span className="fm-version-meta">{formatSize(versionTarget.size)}</span>
                <span className="fm-version-hash">#{versionTarget.hash.slice(0, 8)}</span>
              </div>
              {(fileGroups.find((g) => g.current.id === versionTarget.id)?.versions ?? []).map(
                (v, i) => (
                  <div key={v.id} className="fm-version-item">
                    <span className="fm-version-badge fm-version-old">v{fileGroups.find((g) => g.current.id === versionTarget.id)!.versions.length - i}</span>
                    <span className="fm-version-name">{v.name}</span>
                    <span className="fm-version-meta">{formatSize(v.size)}</span>
                    <span className="fm-version-hash">#{v.hash.slice(0, 8)}</span>
                    <button
                      className="fm-version-restore"
                      onClick={() => restoreVersion(v.id)}
                      title="恢复到此版本（作为当前文件）"
                    >
                      恢复
                    </button>
                  </div>
                ),
              )}
              {(fileGroups.find((g) => g.current.id === versionTarget.id)?.versions.length ?? 0) === 0 && (
                <div className="fm-version-empty">暂无更早版本</div>
              )}
            </div>
          </div>
        </div>
      )}

      {dragging && (
        <div className="fm-drop-zone">松开鼠标，上传到当前文件夹</div>
      )}

      {moving && (
        <div className="fm-move-popover">
          <div className="fm-move-title">移动「{moving.name}」到</div>
          {folderTargets.length === 0 ? (
            <div className="fm-move-empty">没有其他文件夹</div>
          ) : (
            folderTargets.map((f) => (
              <button
                key={f.id}
                className="fm-move-item"
                onClick={() => moveTo(moving, f.id)}
              >
                <FolderIcon width={14} height={14} />
                <span>{f.title || "未命名"}</span>
              </button>
            ))
          )}
          <button className="fm-move-item fm-move-cancel" onClick={() => setMoving(null)}>
            取消
          </button>
        </div>
      )}
    </div>
  );
}
