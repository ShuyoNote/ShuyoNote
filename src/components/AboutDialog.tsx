import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useEditorStore } from "../store/editor";
import { platform } from "../lib/platform";
import {
  APP_NAME,
  APP_VERSION,
  APP_LICENSE,
  APP_DESCRIPTION,
  linkItems,
  sanitizeExternalUrl,
  getAllowExternal,
  setAllowExternal,
} from "../lib/links";

// M25 P2 — "关于" dialog. Shows version, license, and the "开源与反馈" external
// links (project home / docs / releases / issues) plus a privacy toggle for
// external navigation. Reuses the shortcuts-overlay modal pattern.
export function AboutDialog() {
  const open = useEditorStore((s) => s.aboutOpen);
  const close = useEditorStore((s) => s.closeAbout);
  const [allowExternal, setAllow] = useState(true);

  useEffect(() => {
    if (open) setAllow(getAllowExternal());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;

  const openExternal = async (url: string) => {
    const safe = sanitizeExternalUrl(url);
    if (!safe || !allowExternal) return;
    try {
      await platform.opener.openUrl(safe);
    } catch {
      // Opening in a browser can be blocked (e.g. no window) — fail quietly.
    }
  };

  const toggleExternal = (v: boolean) => {
    setAllow(v);
    setAllowExternal(v);
  };

  return createPortal(
    <div
      className="shortcuts-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="about">
        <div className="about-head">
          <span className="about-logo">📝</span>
          <div className="about-title">
            {APP_NAME}
            <span className="about-version">v{APP_VERSION}</span>
          </div>
        </div>

        <p className="about-desc">{APP_DESCRIPTION}</p>

        <div className="about-row">
          <span className="about-label">许可</span>
          <span className="about-license">{APP_LICENSE}</span>
          <span className="about-license-note">（附带的同步服务端在网络托管形态下同样需要开源）</span>
        </div>

        <div className="about-links-title">开源与反馈</div>
        <div className="about-links">
          {linkItems().map((l) => (
            <button key={l.id} className="about-link" onClick={() => openExternal(l.url)}>
              {l.label}
            </button>
          ))}
        </div>

        <label className="about-row about-toggle-row">
          <span className="about-label">允许跳转到外部项目网站</span>
          <button
            type="button"
            role="switch"
            aria-checked={allowExternal}
            className={`ai-toggle ${allowExternal ? "on" : ""}`}
            onClick={() => toggleExternal(!allowExternal)}
          >
            <span className="ai-toggle-knob" />
          </button>
        </label>
        <p className="about-hint">关闭后外链不跳转，不影响离线使用。外链不带跟踪参数。</p>

        <div className="about-actions">
          <button className="about-close" onClick={close}>
            关闭
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
