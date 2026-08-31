import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useEditorStore } from "../store/editor";
import { platform } from "../lib/platform";
import {
  APP_NAME,
  APP_NAME_ZH,
  APP_VERSION,
  APP_LICENSE,
  APP_DESCRIPTION,
  linkItems,
  sanitizeExternalUrl,
  getAllowExternal,
  setAllowExternal,
} from "../lib/links";
import { fetchLatestVersion, fetchUpdateManifest, debugUpdateVersion, updateStatus, RELEASES_URL, type UpdateState } from "../lib/updates";
import { checkDesktopUpdate, type UpdateProgress } from "../lib/updater";
import { isDesktop, detectFromDeployed } from "../lib/useUpdateChecker";

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
  const [download, setDownload] = useState<{ run: (onProgress?: (p: UpdateProgress) => void) => Promise<void> } | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [releaseNotes, setReleaseNotes] = useState<string | null>(null);
  const [declined, setDeclined] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);

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
    setCheckError(null);
    setReleaseNotes(null);
    setDeclined(false);
    setUpdating(false);
    setProgress(null);
    setUpdateError(null);
    // Dev-only debug hook matches the red-dot path: force "update available" so
    // the button-driven check also previews the new version + release notes.
    const dbg = debugUpdateVersion();
    if (dbg) {
      setLatestVersion(dbg);
      setUpdateState("update-available");
      const mf = await fetchUpdateManifest();
      setReleaseNotes(mf?.notes ?? null);
      setChecked(true);
      setChecking(false);
      return;
    }
    // Web 版：对比服务器「部署版本」，有新版即提示「刷新页面」加载新静态文件。
    if (isWeb) {
      const r = await detectFromDeployed();
      if (r.latest) {
        setLatestVersion(r.latest);
        setUpdateState(updateStatus(r.latest, APP_VERSION));
        setCheckError(null);
      } else {
        setUpdateState("invalid");
        setCheckError("服务器未返回 version.json（离线或未部署）");
      }
      setChecked(true);
      setChecking(false);
      return;
    }
    // Prefer the in-app updater (desktop); fall back to the releases-page fetch.
    const up = await checkDesktopUpdate();
    if (up.state === "up-to-date") {
      setUpdateState("up-to-date");
    } else if (up.state === "update-available") {
      setLatestVersion(up.latest);
      setDownload({ run: up.download });
      setUpdateState("update-available");
      // Pull the release notes (best-effort) so the user can read what's new.
      const mf = await fetchUpdateManifest();
      if (mf?.notes) setReleaseNotes(mf.notes);
    } else {
      const latest = await fetchLatestVersion();
      console.error("[updater] desktop updater unavailable; fallback fetchLatestVersion ->", latest);
      setLatestVersion(latest);
      setUpdateState(updateStatus(latest, APP_VERSION));
      // Surface the real updater error (if any) so we can tell what happened.
      setCheckError(up.error ? `主更新通道错误：${up.error}` : "主更新通道不可用（已走页面降级）");
    }
    setChecked(true);
    setChecking(false);
  };

  // 打开「关于」时自动执行一次检查更新（每次打开都重新检查，看到的是最新状态）。
  useEffect(() => {
    if (open) void checkUpdate();
  }, [open]);

  const startUpdate = async () => {
    if (!download || updating) return;
    setUpdating(true);
    setUpdateError(null);
    setProgress({ phase: "downloading", percent: 0 });
    try {
      await download.run((p) => setProgress(p));
      // On success the installer relaunches the app; keep the final phase visible.
    } catch (e) {
      // Show the full stack when available so a minified "f is not a function"
      // can be traced; otherwise fall back to the message.
      setUpdateError(e instanceof Error ? (e.stack || e.message) : String(e));
      console.error("[update] 更新失败:", e);
      setUpdating(false);
      setProgress(null);
    }
  };

  const phaseLabel = (p: UpdateProgress): string => {
    if (p.phase === "downloading") {
      return p.percent == null ? "正在下载更新…" : `正在下载更新… ${p.percent}%`;
    }
    if (p.phase === "installing") return "正在安装更新…";
    return "更新完成，即将重启…";
  };

  // Web 版与桌面版更新形态不同：桌面=下载安装包，Web=刷新加载服务器新静态文件。
  const isWeb = !isDesktop();

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
            {/* 内联正式 App logo（mark），避免 /icons/mark.svg 绝对路径在桌面端取不到而丢图 */}
            <svg className="about-logo" viewBox="0 0 1024 1024" aria-label={`${APP_NAME} logo`} role="img">
              <defs><linearGradient id="aboutMarkBg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#4D8DFF"/><stop offset="1" stopColor="#2952CC"/></linearGradient></defs>
              <rect x="0" y="0" width="1024" height="1024" rx="230" fill="url(#aboutMarkBg)"/>
              <rect x="248" y="318" width="250" height="388" rx="42" fill="#FFFFFF"/>
              <rect x="526" y="318" width="250" height="388" rx="42" fill="#FFFFFF"/>
              <rect x="290" y="388" width="166" height="18" rx="9" fill="#C7D6FF"/>
              <rect x="290" y="450" width="166" height="18" rx="9" fill="#C7D6FF"/>
              <rect x="290" y="512" width="118" height="18" rx="9" fill="#C7D6FF"/>
              <rect x="568" y="388" width="166" height="18" rx="9" fill="#C7D6FF"/>
              <rect x="568" y="450" width="166" height="18" rx="9" fill="#C7D6FF"/>
              <rect x="568" y="512" width="118" height="18" rx="9" fill="#C7D6FF"/>
              <path d="M 770 238 Q 775.4 262.6, 800 268 Q 775.4 273.4, 770 298 Q 764.6 273.4, 740 268 Q 764.6 262.6, 770 238 Z" fill="#FFFFFF"/>
            </svg>
          </div>
          <div className="about-name">
            <span className="about-name-en">{APP_NAME}</span>
            {APP_NAME_ZH}
          </div>
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
                <span className="about-update-head">
                  <span className="about-update-avail">
                    发现新版本 <b>v{latestVersion}</b>，当前 v{APP_VERSION}
                  </span>
                  {isWeb ? (
                    <>
                      <button className="about-update-install" onClick={() => window.location.reload()}>
                        刷新页面
                      </button>
                      <button className="about-update-later" onClick={() => setDeclined(true)}>稍后再说</button>
                    </>
                  ) : updating && progress ? (
                    <div className="about-update-progress">
                      <div className="about-update-progress-text">{phaseLabel(progress)}</div>
                      <div className="about-update-progress-track">
                        <div
                          className={`about-update-progress-fill${progress.percent == null ? " indeterminate" : ""}`}
                          style={progress.percent != null ? { width: `${progress.percent}%` } : undefined}
                        />
                      </div>
                    </div>
                  ) : download ? (
                    <>
                      <button className="about-update-install" onClick={() => void startUpdate()}>下载并安装</button>
                      <button className="about-update-later" onClick={() => setDeclined(true)}>稍后再说</button>
                    </>
                  ) : (
                    <button className="about-update-later" onClick={() => openExternal(RELEASES_URL)}>前往发布页</button>
                  )}
                  {updateError && <span className="about-update-error">更新失败：{updateError}</span>}
                </span>
                {!isWeb && !declined && download && releaseNotes && (
                  <div className="about-release-notes">
                    <div className="about-release-notes-title">本次更新</div>
                    <pre className="about-release-notes-body">{releaseNotes}</pre>
                  </div>
                )}
                {declined && (
                  <span className="about-update-declined">已暂缓处理——可稍后再来「检查更新」。</span>
                )}
              </>
            ) : checked && updateState === "up-to-date" ? (
              <>v{APP_VERSION} 已是最新</>
            ) : checked ? (
              <>
                检查失败（离线）{checkError ? ` · ${checkError}` : ""}
                {latestVersion ? ` · 降级读到 v${latestVersion}` : ""}
              </>
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
