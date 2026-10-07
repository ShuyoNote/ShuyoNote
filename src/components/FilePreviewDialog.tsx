// App-level file preview dialog (read-only). Opened from the sidebar tree or the
// file manager by clicking a file name. Markdown is rendered in-app; images /
// video / audio / pdf render their asset. A markdown file also gets a "转为笔记"
// action. Shared so any view can open it. Rendered inside `.app` (not body) so it
// inherits the sidebar-width CSS var and never overlaps the sidebar.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { platform } from "../lib/platform";
import { api } from "../lib/api";
import { ensureAttachmentBytes } from "../lib/attachmentBytes";
import { useFilePreview } from "../store/filePreview";
import { useOverlayLayer } from "../hooks/useOverlayLayer";
import { useOverlayScrollLock } from "../hooks/useOverlayScrollLock";
import { usePdfReader } from "../store/pdfReader";
import { useFileManagerStore } from "../store/fileManager";
import { ConvertToPageIcon, FitWidthIcon, OutlineIcon, ReadAnnotateIcon } from "./icons";
import { hydrateMermaidBlocks } from "../lib/mdMermaid";
import { useResolvedTheme } from "../store/theme";
import { fitScaleOf, nextZoomFromWheel } from "../lib/imageZoom";

// 图片预览器：缩放（滚轮 + 按钮）、适应窗口、1:1 实际尺寸、放大镜、查看原图。
// 顶栏显示文件名 + 缩放百分比与适应/原图按钮。独立组件便于复用与调节。
function ImagePreview({ src, name, onOpenOriginal }: { src: string; name: string; onOpenOriginal?: () => void }) {
  const [zoom, setZoom] = useState(1); // 1 = 适应窗口基准
  const [tx, setTx] = useState(0); // 平移到屏幕像素
  const [ty, setTy] = useState(0);
  const [rot, setRot] = useState(0); // 旋转角度（仅 0/90/180/270）
  const [fit, setFit] = useState(true); // 适应窗口模式
  const dragRef = useRef<{ sx: number; sy: number; tx: number; ty: number } | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  // 原图尺寸（load 之后才知道 ✓）——用来算「适应窗口」实际缩了多少 ✓
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);

  const applyZoom = (z: number) => {
    setFit(false);
    setZoom(z);
  };
  /**
   * ⭐ 2026-10-06（owner：「滚轮放大缩小时，**不是从当前大小起步**，感觉不好」✗）：
   * **当前实际显示的比例** —— 适应窗口时是 CSS 缩出来的那个比例（4000px 的图在 900px 窗口里
   * 只有 0.22 ✓），其它时候就是 `zoom` ✓。滚轮必须**接着它**乘 ✓。
   * ⛔ 旧写法从 `zoom`（初始 1 = 原始尺寸）起步 ✗ ⇒ 第一下从 22% 直接跳到 115% ✗ —— 那正是"跳"。
   */
  const effectiveScale = () => {
    if (!fit) return zoom;
    const el = imgRef.current;
    if (!el || !natural) return zoom;
    const r = el.getBoundingClientRect();
    return fitScaleOf({ naturalW: natural.w, naturalH: natural.h, renderedW: r.width, renderedH: r.height, rot });
  };
  const rotate = (deg: number) => {
    // 旋转不改文件，仅预览视角。围绕中心累计，保持居中。
    // ⚠️ 顺带把"当前比例"落到 `zoom` 上 ✓（不然从适应窗口转一下会跳回 100% ✗）
    setZoom(effectiveScale());
    setRot((r) => (r + deg) % 360);
    setFit(false);
  };

  return (
    <div
      className="fm-img-view"
      onWheel={(e) => {
        e.preventDefault();
        // 从**当前显示尺寸**起步 ✓（见 effectiveScale 上面那段注释 ✓）
        applyZoom(nextZoomFromWheel(effectiveScale(), e.deltaY));
      }}
    >
      <img
        ref={imgRef}
        onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
        src={src}
        alt={name}
        className={`fm-img${fit ? "" : " is-zoomed"}`}
        style={
          fit
            ? {}
            : {
                // 以图片中心为缩放原点：放大围绕中心，不移位。translate 在
                // scale 之前用屏幕像素，拖拽量=鼠标增量，跟手。rotate 累加角度。
                transformOrigin: "center center",
                transform: `translate(${tx}px, ${ty}px) scale(${zoom}) rotate(${rot}deg)`,
                cursor: dragRef.current ? "grabbing" : "zoom-out",
              }
        }
        onPointerDown={(e) => {
          if (fit) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          dragRef.current = { sx: e.clientX, sy: e.clientY, tx, ty };
        }}
        onPointerMove={(e) => {
          const d = dragRef.current;
          if (!d || fit) return;
          setTx(d.tx + (e.clientX - d.sx));
          setTy(d.ty + (e.clientY - d.sy));
        }}
        onPointerUp={(e) => {
          if (dragRef.current) e.currentTarget.releasePointerCapture(e.pointerId);
          dragRef.current = null;
        }}
        onPointerCancel={() => (dragRef.current = null)}
        onDoubleClick={() => {
          setFit(true);
          setZoom(1);
          setTx(0);
          setTy(0);
          setRot(0);
        }}
      />
      {/* 顶栏：提示 ＋ （旋转 / 查看原图）按钮组**在同一条 flex 行里**。
          ⚠️ 别把它们改回两个各自 `position:absolute` 的角标：两者原来都钉在 `top:14px`、
          左边那个还按 `left:50%` 居中 ⇒ 窄屏（360px 实测重叠 ~106px）必然互相压，
          这正是 GitCode issue #12「窄屏时内置图片阅览的控制按钮重叠了」。
          几何判据在 `scripts/verify-mobile-overlays.mjs` 的 (6c)。 */}
      <div className="fm-img-bar">
        <div className="fm-img-hint">
          {fit
            ? `${Math.round(effectiveScale() * 100)}%（适应窗口）· 滚轮缩放 · 拖动平移`
            : `${Math.round(zoom * 100)}%`}
        </div>
        <div className="fm-img-actions">
          <button className="fm-img-btn" onClick={() => rotate(-90)} title="逆时针旋转 90°" aria-label="逆时针旋转">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 12a9 9 0 1 0 3.3-7" />
              <path d="M5.5 4v4.5H10" />
            </svg>
          </button>
          <button className="fm-img-btn" onClick={() => rotate(90)} title="顺时针旋转 90°" aria-label="顺时针旋转">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M21 12a9 9 0 1 1-3.3-7" />
              <path d="M18.5 4v4.5H14" />
            </svg>
          </button>
          {onOpenOriginal && (
            <button className="fm-img-original" onClick={onOpenOriginal}>查看原图</button>
          )}
        </div>
      </div>
    </div>
  );
}

// MD 大纲：从渲染后的 .fm-md-preview 里收集 h1–h6 作为目录，点击滚动定位，
// 滚动时高亮当前章节。独立的（MD 预览是纯 HTML，复用不了编辑器 Lexical TOC）。
interface MdOutlineItem {
  text: string;
  level: number;
  idx: number;
}
function collectOutline(root: Element): MdOutlineItem[] {
  const out: MdOutlineItem[] = [];
  const heads = root.querySelectorAll("h1,h2,h3,h4,h5,h6");
  heads.forEach((el) => {
    const tag = el.tagName.toLowerCase();
    const text = (el.textContent || "").trim();
    if (text) out.push({ text, level: Number(tag[1]), idx: out.length });
  });
  return out;
}

export function FilePreviewDialog({ inline = false }: { inline?: boolean } = {}) {
  // ⚠️ **2026-10-04 加 `inline`**（owner：「pdf 和文件预览面板可否跟页面一个级别」）——
  //    ⭐ 与 `PdfReader` **同一个形状** ✓（那边是 `inline ? tree : createPortal(tree, body)` ✓）：
  //    · `inline === true` ⇒ ⭐ 它就是**主区里的一种视图** ✓（铺满 `.main` ✓，⭐ 不 portal ✓
  //      ／ ⭐ 不锁外壳滚动 ✓ ／ ⭐ 不登记返回栈 ✓）；
  //    · `false`（⭐ 默认 ✓）⇒ ⭐ 照旧是全屏浮层 ✓ ⇒ ⭐ **这一步不改变任何现有行为** ✓（接线在下一步 ✓）。
  // 逐字段订阅（`close`/`importAsPage` 是动作，引用恒定 ⇒ 选择器不产生额外重渲染）。
  const target = useFilePreview((s) => s.target);
  const mdHtml = useFilePreview((s) => s.mdHtml);
  const mdLoading = useFilePreview((s) => s.mdLoading);
  const mdImporting = useFilePreview((s) => s.mdImporting);
  const close = useFilePreview((s) => s.close);
  const importAsPage = useFilePreview((s) => s.importAsPage);
  const bodyRef = useRef<HTMLDivElement>(null);
  const theme = useResolvedTheme(); // re-render mermaid when theme changes
  const [outline, setOutline] = useState<MdOutlineItem[]>([]);
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [activeOut, setActiveOut] = useState<number | null>(null);
  // 目录栏宽度（可拖拽调节）。
  const [outlineW, setOutlineW] = useState(220);
  const outlineWRef = useRef(outlineW);
  outlineWRef.current = outlineW;
  // 内容是否适配窗口宽度（相对 --doc-width 文档宽）。
  // ⚠️ **2026-10-04 改**：默认从 `false`（文档宽 780px）改成 **`true`（适配窗口宽度）** ✓ ——
  //    owner 的诉求是"⭐ **像 PDF 阅读器那样自动跟着内容区变宽**" ✓。
  //    ⚠️ 原先两边默认档不同：⭐ PDF 默认 `fit-width`（跟容器 ✓）／ ⭐ md 默认"文档宽"（固定 780px ✗）
  //      ⇒ 收侧栏时"PDF 跟着变、md 不动" ✓（这正是 owner 报的现象 ✓）。
  //    ⭐ 现在两边一致：**默认都跟容器** ✓；⭐ 想看文档宽点顶部那个按钮即可切回 ✓
  //      （它加 `.fm-md-preview.is-full` ⇒ `max-width: none` ✓，接线见下面的 className ✓）。
  const [contentFull, setContentFull] = useState(true);
  const [dragging, setDragging] = useState(false);

  const isMd = target?.mime === "text/markdown";
  // ⚠️ 这里原先写的是 `const folderId = useFileManagerStore.getState().folderId`（**渲染期快照**）：
  // 它既不是订阅（folderId 变了本组件不会重渲染 ⇒ 用户点了"导入为页面"落到的还是旧目录），
  // 也不比"点击时现取"更好。动作里读 `getState()` 才是这份状态唯一正确的用法（见下面的按钮）。

  const openPdf = () => {
    if (target && target.mime === "application/pdf") {
      usePdfReader.getState().openPdf(target.id, target.name);
      close();
    }
  };

  // Hydrate ```mermaid fenced blocks whenever their HTML (or the theme) changes.
  useEffect(() => {
    if (isMd && mdHtml && !mdLoading) {
      const root = (bodyRef.current?.querySelector(".fm-md-preview") as HTMLElement | null) ?? null;
      void hydrateMermaidBlocks(root, theme === "dark" ? "dark" : "default");
    }
  }, [mdHtml, mdLoading, isMd, theme]);

  // 收集提纲：mdHtml 到位后从 bodyRef 容器里查标题。放到 useEffect（commit 后、
  // DOM 已写入），再补一帧让 mermaid 等异步结构稳定，避免「目录空」。
  useEffect(() => {
    if (!isMd || !mdHtml || mdLoading) return;
    const collect = () => {
      const root = bodyRef.current?.querySelector(".fm-md-preview");
      if (root) {
        setOutline(collectOutline(root));
        setActiveOut(null);
      }
    };
    collect();
    const raf = requestAnimationFrame(collect);
    return () => cancelAnimationFrame(raf);
  }, [isMd, mdHtml, mdLoading]);

  // 内容区滚动回顶部，避免「看不到头」。
  useEffect(() => {
    if (isMd && bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [isMd, target?.id, mdHtml]);

  const scrollToOutline = (item: MdOutlineItem) => {
    const root = bodyRef.current?.querySelector(".fm-md-preview");
    if (!root) return;
    const heads = root.querySelectorAll("h1,h2,h3,h4,h5,h6");
    const el = heads[item.idx];
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveOut(item.idx);
  };

  // 拖拽目录栏手柄改宽：记录起点 x 与初始宽，pointermove 里按差值更新。
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = outlineWRef.current;
    setDragging(true);
    const onMove = (ev: PointerEvent) => {
      // 手柄在左缘，向左拖 = 变宽。
      setOutlineW(Math.max(160, Math.min(480, startW + (startX - ev.clientX))));
    };
    const onUp = () => {
      setDragging(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // 解析媒体资产 URL：优先本地 path；path 缺失时按内容哈希读取字节（web/同步文件），
  // 避免「path 为空 → 误显示该文件类型暂不支持内嵌预览」。
  const [asset, setAsset] = useState<{ url: string; missing: boolean }>({ url: "", missing: false });
  /** P6.3 续：手动/自动取回字节后靠它重跑下面这个 effect（不用把 target 换掉）。 */
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    if (!target) { setAsset({ url: "", missing: false }); return; }
    if (target.path) { setAsset({ url: platform.asset.convertFileSrc(target.path), missing: false }); return; }
    if (target.hash) {
      let objUrl = "";
      setAsset({ url: "", missing: false });
      const readBytes = () => api.readAttachmentBytes(target.hash);
      readBytes()
        .catch(async (first) => {
          // P6.3 续：这里的 `missing` 以前**只写不读**（三处赋值、零处使用），
          // 所以字节缺失时只有一句"文件内容缺失"，没有任何动作。
          // 现在先**自动按需取回来**再读一次；取不回来才落到下面那个可操作的状态。
          if (!(await ensureAttachmentBytes(target.hash))) throw first;
          return readBytes();
        })
        .then((bytes) => {
          objUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: target.mime || "application/octet-stream" }));
          setAsset({ url: objUrl, missing: false });
        })
        .catch(() => setAsset({ url: "", missing: true }));
      return () => { if (objUrl) URL.revokeObjectURL(objUrl); };
    }
    setAsset({ url: "", missing: true });
  }, [target?.id, target?.hash, target?.mime, reloadKey]);

  // Android 返回键：应用级文件预览浮层（`useFilePreview` 驱动，点空白/× 关闭）。
  // 只有 `target` 在（= 浮层真的渲染出来）时才登记——见 lib/overlayStack.ts 与 §4.1.4。
  // Android 返回键：**只在它确实以浮层身份出现时才登记**（`inline` 时它是主区里的视图，
  // 没有"最上层浮层"可言 —— 与 `PdfReader` 里那句 `open && !inline` 同一口径）。
  useOverlayLayer("filePreview", !!target && !inline, close);
  // §4.1.2 第 4 条：打开时锁住"当前视图真实的那个滚动容器"。
  // 这一条此前**漏了**（是这一族里唯一没接锁的浮层）：实测只开着它时
  // `overlayScrollLockCount()` = 0，也就是浮层开着还能把背景正文拖走。
  // 验收脚本里它一度"通过"锁断言，靠的是**上一层泄漏的锁**（见 §4.1.4 的说明）。
  // ⚠️ **2026-10-04**：⭐ `inline` 时**不锁外壳** ✗ —— 它本身就是主区里的一块 ✓，
  // 锁外壳只会让"侧栏/别处滚不动"，那正是 owner 报的那个体感（同一处 PDF 也这么改过 ✓）。
  useOverlayScrollLock(!!target && !inline);

  // ⚠️ **2026-10-04 加**（owner：「把 htm/html/txt 加入文件预览支持」）：
  //   ⭐ 判据**照抄** `FileManagerView` 那处既有的 `isText`（`text/` 那一族 ／ `application/json` ／
  //   `application/xml` ✓）—— ⭐ 同一口径不写第二份 ✓（那边的网格文本预览也用这一套 ✓）。
  const isTextLike = !!target && (
    target.mime.startsWith("text/") || target.mime === "application/json" || target.mime === "application/xml"
  );
  // ⭐ **按 hash 读字节** ✓ —— ⚠️ **不能**用 `api.readTextFile(path)` ✗：
  //   `store/filePreview.ts` 里 md 那条路的注释逐字写着「`read_text_file` on the raw disk path would
  //   return **ciphertext** garbling the preview when E1 encryption is on」✓
  //   ⇒ ⭐ 加密空间下按路径读会拿到密文 ✓（⭐ `readAttachmentBytes(hash)` 才会让后端解密 ✓）。
  //   ⚠️ 顺带记下：`FileManagerView` 的网格文本预览用的正是 `readTextFile(f.path)` ✗ ——
  //   ⭐ 那处是既有的隐患（加密空间里会乱码 ✓），⭐ 不在这一笔的范围 ✓。
  const [textBody, setTextBody] = useState<string | null>(null);
  const [textError, setTextError] = useState("");
  // ⚠️ **2026-10-04**：⭐ html 的两种看法（owner 选了「两个都要」）——
  //   ⭐ 默认 **源码** ✓（最安全 ✓）；⭐ 点一下才在 ⭐ **沙箱 iframe** 里渲染 ✓。
  //   ⚠️ 沙箱用 ⭐ sandbox 空串（⭐ 最严那一档：⭐ 禁脚本 ＋ ⭐ 禁同源 ＋ ⭐ 禁表单 ＋ ⭐ 禁弹窗 ✓）——
  //   ⇒ ⭐⭐ 页面照常显示 ✓，⭐ 而它里面的脚本**一行都跑不了** ✓ ⇒ ⭐ 外来 html 碰不到应用 ✓。
  //   ⚠️ 内容走 `srcDoc`（⭐ 不落盘、不发请求 ✓）；⭐ CSP 是 default-src self ⇒ ⭐ 外部图片/样式被拦 ✓（⭐ 更安全 ✓）。
  const [htmlRendered, setHtmlRendered] = useState(false);
  const isHtml = !!target && (target.mime === "text/html" || /\.html?$/i.test(target.name || ""));
  useEffect(() => {
    if (!target || !isTextLike || isMd) { setTextBody(null); setTextError(""); return; }
    let alive = true;
    setTextBody(null);
    setTextError("");
    (async () => {
      try {
        const readBytes = () => api.readAttachmentBytes(target.hash);
        let bytes: ArrayBuffer;
        try {
          bytes = await readBytes();
        } catch (first) {
          // 与上面图片/video 那条同款：字节可能还没同步到本机 ⇒ 先按需取回来再读一次。
          if (!(await ensureAttachmentBytes(target.hash))) throw first;
          bytes = await readBytes();
        }
        if (!alive) return;
        // ⚠️ `fatal: false`：⭐ 二进制文件被当文本打开时**不该炸** ✓ —— 坏字节用替换符显示 ✓。
        setTextBody(new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes)));
      } catch (e) {
        if (alive) setTextError(String(e));
      }
    })();
    return () => { alive = false; };
  }, [target?.id, target?.hash, isTextLike, isMd]);

  // Hooks 之上已全部执行；target 为空则不渲染弹层。
  if (!target) return null;

  // P6.3 续（2026-09-15）：字节不在本机时的**可操作状态**。
  //
  // 这句话本身没错（"可能未同步到本机"），但它原来是**死胡同**——上面的 effect 已经
  // 自动试过一次按需取回，走到这里说明那次也失败了（离线 / 服务端没有这份字节 /
  // 没选空间），所以留一个手动重试入口，并把"为什么"说清楚。
  //
  // ⚠️ 这条**不影响 P6.1 的开关语义**：按需下载是用户显式动作，不受"每空间开关"与
  // C1 预算闸门限制（见 sync.rs::download_attachment 的注释）。
  const missingBlock = (
    <div className="fm-preview-unsupported">
      <p>这个文件的字节不在本机（可能关掉了该空间的附件同步、或被同步预算挡下了）。</p>
      <button
        className="fm-preview-fetch"
        onClick={async () => {
          if (!target.hash) return;
          if (await ensureAttachmentBytes(target.hash)) {
            // 取回来了 → 重跑读取 effect（换 key，不改 target，避免重建对象 URL 的引用问题）。
            setReloadKey((k) => k + 1);
          }
        }}
      >
        从服务器下载
      </button>
    </div>
  );

  // ⚠️ **2026-10-04**：`inline` 形态 ⭐ **不 portal** ✓（它就是主区里的一块 ✓）；
  //    而且 ⭐ 根上**不能**挂"点空白关闭" ✗ —— ⭐ 页面里没有"空白" ✓ ⇒ 关闭改走顶栏那颗 × ✓（见下）。
  // ⚠️⭐ 根类名**必须是字面量** ✗ —— `check-overlay-registry.mjs` 的判据是
  //    「JSX 里字面量写出来的、以 `-overlay`/`-popover` 结尾的 class token」✓
  //    ⇒ ⭐ 写成 `className={inline ? "a" : "b"}` 会让它报「幽灵条目：没有任何组件渲染」✓（实测撞过 ✓）。
  //    ⇒ ⭐ 所以恒为 `fm-preview-overlay` ✓ ＋ ⭐ 内联时**加**一个 `is-inline` ✓ ⇒ ⭐ 位置交给 CSS 覆盖 ✓。
  const tree = (
    <div className={`fm-preview-overlay ${inline ? "is-inline" : ""}`} onClick={inline ? undefined : close}>
      <div className="fm-preview" onClick={inline ? undefined : (e) => e.stopPropagation()}>
        <div className="fm-preview-head">
          <span className="fm-preview-name">{target.name}</span>
          {/* ⚠️ **2026-10-04 去掉**（owner：「去掉 md 文档的关闭按钮」）—— 这颗 × 是我上一批为
              `inline` 形态补的出口 ✗。
              ⭐ 去掉之后**还能怎么关**（都在，随时可用）：
                · 点左侧竖条切到别的活动（`ActivityBar` 里 `if (id !== activity) close()`）；
                · 点页面树里的一个页面（`openPage` 里会 `close()`）；
                · 切任何视图（`setView` 里会 `close()`，命令面板也算）；
                · ⚠️ 浮层形态（窄屏）另外还有"点空白"与 Android 返回键。 */}
          {target.mime === "application/pdf" && (
            <button className="fm-preview-read" onClick={openPdf} title="阅读并批注" aria-label="阅读并批注">
              <ReadAnnotateIcon aria-hidden />
            </button>
          )}
          {isMd && (
            <button
              className={`fm-preview-read fm-width-toggle${contentFull ? " is-on" : ""}`}
                aria-label="切换文档宽度 / 适配窗口宽度"
              onClick={() => setContentFull((s) => !s)}
              title={contentFull ? "恢复文档宽度" : "适配窗口宽度"}
            >
              <FitWidthIcon aria-hidden />
            </button>
          )}
          {isMd && (
            <button
              className={`fm-preview-read fm-outline-toggle${outlineOpen ? " is-on" : ""}`}
                aria-label="切换目录"
              onClick={() => setOutlineOpen((s) => !s)}
              title="切换目录"
            >
              <OutlineIcon aria-hidden />
            </button>
          )}
          {target.mime === "text/markdown" && (
            <button className="fm-preview-read" onClick={() => void importAsPage(useFileManagerStore.getState().folderId)} title="转为笔记" aria-label="转为笔记" disabled={mdImporting}>
              <ConvertToPageIcon aria-hidden />
            </button>
          )}
        </div>
        <div className="fm-preview-body">
          {target.mime.startsWith("image/") ? (
            asset.url ? (
              <ImagePreview src={asset.url} name={target.name} onOpenOriginal={() => void platform.opener.openPath(target.path)} />
            ) : (
              missingBlock
            )
          ) : target.mime.startsWith("video/") ? (
            asset.url ? (
              <div className="fm-video-view">
                <video src={asset.url} controls preload="metadata" />
              </div>
            ) : (
              missingBlock
            )
          ) : target.mime.startsWith("audio/") ? (
            asset.url ? (
              <div className="fm-audio-view">
                <div className="fm-audio-icon" aria-hidden>
                  <svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 18V5l12-2v13" />
                    <circle cx="6" cy="18" r="3" />
                    <circle cx="18" cy="16" r="3" />
                  </svg>
                </div>
                <div className="fm-audio-name" title={target.name}>{target.name}</div>
                <audio src={asset.url} controls />
              </div>
            ) : (
              missingBlock
            )
          ) : target.mime === "application/pdf" ? (
            asset.url ? (
              <iframe src={asset.url} title={target.name} />
            ) : (
              missingBlock
            )
          ) : target.mime === "text/markdown" ? (
            mdLoading ? (
              <div className="fm-preview-unsupported">加载 Markdown…</div>
            ) : mdHtml ? (
              <div className="fm-md-wrap">
                <div className="fm-md-body" ref={bodyRef}>
                  <div
                    className={`fm-md-preview${contentFull ? " is-full" : ""}`}
                    dangerouslySetInnerHTML={{ __html: mdHtml }}
                  />
                </div>
                {outlineOpen && outline.length > 0 && (
                  <div className="fm-md-outline" style={{ width: outlineW }}>
                    <div
                      className={`fm-md-outline-resizer${dragging ? " is-dragging" : ""}`}
                      onPointerDown={startResize}
                    />
                    <div className="fm-md-outline-inner">
                      <div className="fm-md-outline-title">目录</div>
                      {outline.map((it) => (
                        <button
                          key={it.idx}
                          className={`fm-md-outline-item ${activeOut === it.idx ? "active" : ""}`}
                          style={{ paddingLeft: `${(it.level - 1) * 12 + 6}px` }}
                          onClick={() => scrollToOutline(it)}
                          title={it.text}
                        >
                          {it.text}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="fm-preview-unsupported">无法渲染该 Markdown 文件。</div>
            )
          ) : isTextLike ? (
            /* ⚠️ **2026-10-04 改**（owner 要求）：⭐ txt / htm / html / json / xml 现在**能预览**了 ✓
                （原来这里只有一句「文本文件：请在文件夹中查看。」✗）。
                ⚠️⭐ **按源码显示，不渲染 HTML** ✗ —— 这类文件是从外面拿进来的 ⇔ 里面可能有脚本 ✓，
                而这里是 App 里的一块 ⇒ ⭐ **绝不能** `dangerouslySetInnerHTML`（⭐ 那是 XSS 入口 ✓）。
                ⭐ 想看渲染效果：用系统浏览器打开（⭐ 天然沙箱 ✓）／ ⭐ 或另开一条**沙箱 iframe** 的路 ✓。 */
            textError ? (
              <div className="fm-preview-unsupported">读不到这个文本文件：{textError}</div>
            ) : textBody === null ? (
              <div className="fm-preview-unsupported">正在读…</div>
            ) : (
              <div className="fm-text-wrap">
                {isHtml && (
                  <div className="fm-text-bar">
                    {/* ⭐ owner 选的「两个都要」：⭐ 源码 ⇄ ⭐ 沙箱渲染 ✓（⭐ 默认源码 ✓）。 */}
                    <button
                      className="fm-text-toggle"
                      onClick={() => setHtmlRendered(true)}
                      disabled={htmlRendered}
                    >
                      渲染网页
                    </button>
                    <span className="fm-text-note">沙箱渲染：脚本不会运行</span>
                  </div>
                )}
                {isHtml && htmlRendered ? (
                  /* ⭐ **沙箱渲染** ✓ —— sandbox 空串是最严那一档（⭐ 脚本一行都跑不了 ✓）。
                     ⚠️ title 是给读屏软件的可访问名 ✓（⭐ iframe 必须有 ✓）。 */
                  <iframe
                    className="fm-html-preview"
                    sandbox=""
                    srcDoc={textBody}
                    title={target.name}
                  />
                ) : (
                  <pre className="fm-text-preview">{textBody}</pre>
                )}
              </div>
            )
          ) : (
            <div className="fm-preview-unsupported">该文件类型暂不支持内嵌预览，可在文件夹中打开或用系统打开。</div>
          )}
        </div>
      </div>
    </div>
  );
  // ⭐ `inline` ⇒ 直接交回主区（`App.tsx` 那条 `.main` 分支 ✓）；
  // ⭐ 否则照旧 portal 到 body（全屏浮层 ✓）。
  return inline ? tree : createPortal(tree, document.body);
}
