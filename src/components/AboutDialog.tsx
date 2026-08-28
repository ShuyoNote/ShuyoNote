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
import { fetchLatestVersion, updateStatus, RELEASES_URL, type UpdateState } from "../lib/updates";
import { checkDesktopUpdate } from "../lib/updater";

// M25 P2 — "关于" dialog. Shows version, license, and the "开源与反馈" external
// links (project home / docs / releases / issues) plus a privacy toggle for
// external navigation. Reuses the shortcuts-overlay modal pattern.
export function AboutDialog() {
  const open = useEditorStore((s) => s.aboutOpen);
  const close = useEditorStore((s) => s.closeAbout);
  const [allowExternal, setAllow] = useState(true);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const [updateState, setUpdateState] = useState<UpdateState | null>(null);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [download, setDownload] = useState<(() => Promise<void>) | null>(null);

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

  const checkUpdate = async () => {
    setChecking(true);
    setChecked(false);
    setUpdateState(null);
    setLatestVersion(null);
    setDownload(null);
    // Prefer the in-app updater (desktop); fall back to the releases-page fetch.
    const up = await checkDesktopUpdate();
    if (up.state === "up-to-date") {
      setUpdateState("up-to-date");
    } else if (up.state === "update-available") {
      setLatestVersion(up.latest);
      setDownload(up.download);
      setUpdateState("update-available");
    } else {
      const latest = await fetchLatestVersion();
      setLatestVersion(latest);
      setUpdateState(updateStatus(latest, APP_VERSION));
    }
    setChecked(true);
    setChecking(false);
  };

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
        <div className="about-hero">
          <div className="about-logo-wrap">
            <img className="about-logo" src="/icons/mark.svg" alt={`${APP_NAME} logo`} />
          </div>
          <div className="about-name">{APP_NAME}</div>
          <div className="about-meta">
            <span className="about-pill about-pill-version">v{APP_VERSION}</span>
            <span className="about-pill about-pill-license">{APP_LICENSE}</span>
          </div>
        </div>

        <p className="about-desc">{APP_DESCRIPTION}</p>

        <div className="about-section about-update-row">
          <button className="about-link" onClick={checkUpdate} disabled={checking}>
            {checking ? "检查中…" : "检查更新"}
          </button>
          <span className="about-update-state">
            {checked && updateState === "update-available" && latestVersion ? (
              <>
                发现新版本 <b>v{latestVersion}</b>，
                {download ? (
                  <button className="about-update-install" onClick={() => void download()}>下载并安装</button>
                ) : (
                  <a onClick={() => openExternal(RELEASES_URL)}>前往发布页</a>
                )}
              </>
            ) : checked && updateState === "up-to-date" ? (
              <>v{APP_VERSION} 已是最新</>
            ) : checked ? (
              <>检查失败（离线）</>
            ) : (
              ""
            )}
          </span>
        </div>

        <div className="about-section">
          <div className="about-links-title">开源与反馈</div>
          <div className="about-links">
            {linkItems().map((l) => (
              <button key={l.id} className="about-link" onClick={() => openExternal(l.url)}>
                {l.label}
              </button>
            ))}
          </div>
          <p className="about-license-note">AGPL-3.0：附带的同步服务端在网络托管形态下同样需要开源。</p>
        </div>

        <div className="about-section">
          <div className="about-toggle-row">
            <div className="about-toggle-text">
              <div className="about-toggle-label">允许跳转到外部项目网站</div>
              <div className="about-hint">关闭后外链不跳转，不影响离线使用；外链不带跟踪参数。</div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={allowExternal}
              className={`ai-toggle ${allowExternal ? "on" : ""}`}
              onClick={() => toggleExternal(!allowExternal)}
            >
              <span className="ai-toggle-knob" />
            </button>
          </div>
        </div>

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
