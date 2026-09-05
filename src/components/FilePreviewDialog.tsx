// App-level file preview dialog (read-only). Opened from the sidebar tree or the
// file manager by clicking a file name. Markdown is rendered in-app; images /
// video / audio / pdf render their asset. A markdown file also gets a "转为笔记"
// action. Shared so any view can open it. Rendered inside `.app` (not body) so it
// inherits the sidebar-width CSS var and never overlaps the sidebar.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { platform } from "../lib/platform";
import { api } from "../lib/api";
import { useFilePreview } from "../store/filePreview";
import { usePdfReader } from "../store/pdfReader";
import { useFileManagerStore } from "../store/fileManager";
import { hydrateMermaidBlocks } from "../lib/mdMermaid";
import { useResolvedTheme } from "../store/theme";

// 图片预览器：缩放（滚轮 + 按钮）、适应窗口、1:1 实际尺寸、放大镜、查看原图。
// 顶栏显示文件名 + 缩放百分比与适应/原图按钮。独立组件便于复用与调节。
const clampZoom = (z: number) => Math.min(4, Math.max(0.1, z));

function ImagePreview({ src, name, onOpenOriginal }: { src: string; name: string; onOpenOriginal?: () => void }) {
  const [zoom, setZoom] = useState(1); // 1 = 适应窗口基准
  const [tx, setTx] = useState(0); // 平移到屏幕像素
  const [ty, setTy] = useState(0);
  const [rot, setRot] = useState(0); // 旋转角度（仅 0/90/180/270）
  const [fit, setFit] = useState(true); // 适应窗口模式
  const dragRef = useRef<{ sx: number; sy: number; tx: number; ty: number } | null>(null);

  const applyZoom = (z: number) => {
    setFit(false);
    setZoom(z);
  };
  const rotate = (deg: number) => {
    // 旋转不改文件，仅预览视角。围绕中心累计，保持居中。
    setRot((r) => (r + deg) % 360);
    setFit(false);
  };

  return (
    <div
      className="fm-img-view"
      onWheel={(e) => {
        e.preventDefault();
        const next = clampZoom(zoom * (e.deltaY < 0 ? 1.15 : 0.87));
        applyZoom(next);
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
      <div className="fm-img-hint">
        {fit ? "滚轮缩放 · 拖动平移" : `${Math.round(zoom * 100)}%`}
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

  // 解析媒体资产 URL：优先本地 path；path 缺失时按内容哈希读取字节（web/同步文件），
  // 避免「path 为空 → 误显示该文件类型暂不支持内嵌预览」。
  const [asset, setAsset] = useState<{ url: string; missing: boolean }>({ url: "", missing: false });
  useEffect(() => {
    if (!target) { setAsset({ url: "", missing: false }); return; }
    if (target.path) { setAsset({ url: platform.asset.convertFileSrc(target.path), missing: false }); return; }
    if (target.hash) {
      let objUrl = "";
      setAsset({ url: "", missing: false });
      api.readAttachmentBytes(target.hash)
        .then((bytes) => {
          objUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: target.mime || "application/octet-stream" }));
          setAsset({ url: objUrl, missing: false });
        })
        .catch(() => setAsset({ url: "", missing: true }));
      return () => { if (objUrl) URL.revokeObjectURL(objUrl); };
    }
    setAsset({ url: "", missing: true });
  }, [target?.id, target?.hash, target?.mime]);

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
          {target.mime.startsWith("image/") ? (
            asset.url ? (
              <ImagePreview src={asset.url} name={target.name} onOpenOriginal={() => void platform.opener.openPath(target.path)} />
            ) : (
              <div className="fm-preview-unsupported">文件内容缺失（可能未同步到本机，或已被删除）。</div>
            )
          ) : target.mime.startsWith("video/") ? (
            asset.url ? (
              <div className="fm-video-view">
                <video src={asset.url} controls preload="metadata" />
              </div>
            ) : (
              <div className="fm-preview-unsupported">文件内容缺失（可能未同步到本机，或已被删除）。</div>
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
              <div className="fm-preview-unsupported">文件内容缺失（可能未同步到本机，或已被删除）。</div>
            )
          ) : target.mime === "application/pdf" ? (
            asset.url ? (
              <iframe src={asset.url} title={target.name} />
            ) : (
              <div className="fm-preview-unsupported">文件内容缺失（可能未同步到本机，或已被删除）。</div>
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
