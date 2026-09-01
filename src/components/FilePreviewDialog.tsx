// App-level file preview dialog (read-only). Opened from the sidebar tree or the
// file manager by clicking a file name. Markdown is rendered in-app; images /
// video / audio / pdf render their asset. A markdown file also gets a "转为笔记"
// action. Shared so any view can open it. Rendered inside `.app` (not body) so it
// inherits the sidebar-width CSS var and never overlaps the sidebar.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { platform } from "../lib/platform";
import { useFilePreview } from "../store/filePreview";
import { usePdfReader } from "../store/pdfReader";
import { useFileManagerStore } from "../store/fileManager";
import { hydrateMermaidBlocks } from "../lib/mdMermaid";
import { useResolvedTheme } from "../store/theme";

// 图片预览器：缩放（滚轮 + 按钮）、适应窗口、1:1 实际尺寸、放大镜、查看原图。
// 顶栏显示文件名 + 缩放百分比与适应/原图按钮。独立组件便于复用与调节。
function ImagePreview({ src, name, onOpenOriginal }: { src: string; name: string; onOpenOriginal?: () => void }) {
  const [zoom, setZoom] = useState(1); // 1 = 适应窗口
  const [fit, setFit] = useState(true); // 适应窗口模式
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  const clampZoom = (z: number) => Math.min(4, Math.max(0.1, z));

  // 适应窗口：根据容器与图片尺寸算 fit 缩放。简化：fit 视为 1（CSS object-fit 撑满）。
  // 这里用 CSS 缩放变换，fit=true 时让图片 fit 容器，否则按 zoom 叠加。
  return (
    <div
      className="fm-img-view"
      onWheel={(e) => {
        e.preventDefault();
        const delta = e.deltaY < 0 ? 1.15 : 0.87;
        setFit(false);
        setZoom((z) => clampZoom(z * delta));
      }}
    >
      <img
        src={src}
        alt={name}
        className={`fm-img${fit ? "" : " is-zoomed"}`}
        style={
          fit
            ? {}
            : {
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                cursor: dragRef.current ? "grabbing" : "zoom-out",
              }
        }
        onMouseDown={(e) => {
          if (fit) return;
          dragRef.current = { sx: e.clientX, sy: e.clientY, ox: pan.x, oy: pan.y };
        }}
        onMouseMove={(e) => {
          if (!dragRef.current || fit) return;
          setPan({ x: dragRef.current.ox + (e.clientX - dragRef.current.sx), y: dragRef.current.oy + (e.clientY - dragRef.current.sy) });
        }}
        onMouseUp={() => (dragRef.current = null)}
        onMouseLeave={() => (dragRef.current = null)}
        onDoubleClick={() => {
          // 双击回到适应窗口。
          setFit(true);
          setZoom(1);
          setPan({ x: 0, y: 0 });
        }}
      />
      <div className="fm-img-hint">
        {fit ? "滚轮缩放 · 拖动平移" : `${Math.round(zoom * 100)}%`}
      </div>
      {onOpenOriginal && (
        <button className="fm-img-original" onClick={onOpenOriginal}>查看原图</button>
      )}
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

export function FilePreviewDialog() {
  const { target, mdHtml, mdLoading, mdImporting, close, importAsPage } = useFilePreview();
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
  const [contentFull, setContentFull] = useState(false);
  const [dragging, setDragging] = useState(false);

  const isMd = target?.mime === "text/markdown";
  const folderId = useFileManagerStore.getState().folderId;

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

  // Hooks 之上已全部执行；target 为空则不渲染弹层。
  if (!target) return null;

  return createPortal(
    <div className="fm-preview-overlay" onClick={close}>
      <div className="fm-preview" onClick={(e) => e.stopPropagation()}>
        <div className="fm-preview-head">
          <span className="fm-preview-name">{target.name}</span>
          {target.mime === "application/pdf" && (
            <button className="fm-preview-read" onClick={openPdf}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
                <path d="M14 3v6h6" />
                <path d="M9 14l3-3 2.5 2.5-3 3z" />
                <path d="M17.5 17.5v-3M16 20l3-3 3 3" />
              </svg>
              <span>阅读并批注</span>
            </button>
          )}
          {isMd && (
            <button
              className={`fm-preview-read fm-width-toggle${contentFull ? " is-on" : ""}`}
              onClick={() => setContentFull((s) => !s)}
              title={contentFull ? "恢复文档宽度" : "适配窗口宽度"}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M4 5h16M4 12h16M4 19h16" />
                <rect x="7" y="9" width="10" height="6" rx="1" />
              </svg>
              <span>{contentFull ? "文档宽" : "适配宽"}</span>
            </button>
          )}
          {isMd && (
            <button
              className={`fm-preview-read fm-outline-toggle${outlineOpen ? " is-on" : ""}`}
              onClick={() => setOutlineOpen((s) => !s)}
              title="切换目录"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
              </svg>
              <span>目录</span>
            </button>
          )}
          {target.mime === "text/markdown" && (
            <button className="fm-preview-read" onClick={() => void importAsPage(folderId)} disabled={mdImporting}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
                <path d="M14 3v6h6" />
                <path d="M12 15v-6" />
                <path d="M9 12l3-3 3 3" />
              </svg>
              <span>{mdImporting ? "转为笔记…" : "转为笔记"}</span>
            </button>
          )}
          <button className="fm-preview-close" title="关闭" onClick={close}>
            ×
          </button>
        </div>
        <div className="fm-preview-body">
          {target.mime.startsWith("image/") && target.path ? (
            <ImagePreview src={platform.asset.convertFileSrc(target.path)} name={target.name} onOpenOriginal={() => window.open(platform.asset.convertFileSrc(target.path), "_blank")} />
          ) : target.mime.startsWith("video/") && target.path ? (
            <video src={platform.asset.convertFileSrc(target.path)} controls />
          ) : target.mime.startsWith("audio/") && target.path ? (
            <audio src={platform.asset.convertFileSrc(target.path)} controls />
          ) : target.mime === "application/pdf" && target.path ? (
            <iframe src={platform.asset.convertFileSrc(target.path)} title={target.name} />
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
          ) : target.mime.startsWith("text/") ? (
            <div className="fm-preview-unsupported">文本文件：请在文件夹中打开查看。</div>
          ) : (
            <div className="fm-preview-unsupported">该文件类型暂不支持内嵌预览，可在文件夹中打开或用系统打开。</div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
