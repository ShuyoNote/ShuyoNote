// App-level file preview dialog (read-only). Opened from the sidebar tree or the
// file manager by clicking a file name. Markdown is rendered in-app; images /
// video / audio / pdf render their asset. A markdown file also gets a "转为笔记"
// action. Shared so any view can open it. Rendered inside `.app` (not body) so it
// inherits the sidebar-width CSS var and never overlaps the sidebar.
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { platform } from "../lib/platform";
import { useFilePreview } from "../store/filePreview";
import { usePdfReader } from "../store/pdfReader";
import { useFileManagerStore } from "../store/fileManager";
import { hydrateMermaidBlocks } from "../lib/mdMermaid";
import { useResolvedTheme } from "../store/theme";

export function FilePreviewDialog() {
  const { target, mdHtml, mdLoading, mdImporting, close, importAsPage } = useFilePreview();
  const mdRef = useRef<HTMLDivElement>(null);
  const theme = useResolvedTheme(); // re-render mermaid when theme changes

  // Hydrate ```mermaid fenced blocks whenever their HTML (or the theme) changes.
  useEffect(() => {
    if (target?.mime === "text/markdown" && mdHtml && !mdLoading) {
      void hydrateMermaidBlocks(mdRef.current, theme === "dark" ? "dark" : "default");
    }
  }, [mdHtml, mdLoading, target, theme]);

  if (!target) return null;
  const folderId = useFileManagerStore.getState().folderId;

  const openPdf = () => {
    if (target.mime === "application/pdf") {
      usePdfReader.getState().openPdf(target.id, target.name);
      close();
    }
  };

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
            <img src={platform.asset.convertFileSrc(target.path)} alt={target.name} />
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
              <div className="fm-md-preview" ref={mdRef} dangerouslySetInnerHTML={{ __html: mdHtml }} />
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
