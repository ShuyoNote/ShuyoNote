import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useEditorStore } from "../store/editor";
import { platform, isMobileUserAgent } from "../lib/platform";
import { useOverlayScrollLock } from "../hooks/useOverlayScrollLock";
import { useOverlayLayer } from "../hooks/useOverlayLayer";
import {
  APP_NAME,
  APP_VERSION,
  APP_LICENSE,
  linkItems,
  sanitizeExternalUrl,
  getAllowExternal,
  setAllowExternal,
} from "../lib/links";
import { fetchUpdateManifest, debugUpdateVersion, updateStatus, RELEASES_URL, type UpdateState } from "../lib/updates";
import { checkDesktopUpdate, fetchUpdateManifestNative, type UpdateProgress } from "../lib/updater";
import { isDesktop, detectFromDeployed } from "../lib/useUpdateChecker";

// M25 P2 — "关于" dialog. Shows version, license, and the "开源与反馈" external
// links (project home / docs / releases / issues) plus a privacy toggle for
// external navigation. Reuses the shortcuts-overlay modal pattern.
export function AboutDialog() {
  const open = useEditorStore((s) => s.aboutOpen);
  useOverlayScrollLock(open);
  // Android 返回键：优先关掉最上层浮层（见 lib/overlayStack.ts）。
  useOverlayLayer("about", open, () => useEditorStore.getState().closeAbout());
  const close = useEditorStore((s) => s.closeAbout);
  const [allowExternal, setAllow] = useState(true);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const [updateState, setUpdateState] = useState<UpdateState | null>(null);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [download, setDownload] = useState<{ run: (onProgress?: (p: UpdateProgress) => void) => Promise<void> } | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [releaseNotes, setReleaseNotes] = useState<string | null>(null);
  /** Android 发版件的下载地址（清单的 platforms["android-aarch64"].url）。 */
  const [androidApkUrl, setAndroidApkUrl] = useState<string | null>(null);
  const [declined, setDeclined] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);

  useEffect(() => {
    if (open) setAllow(getAllowExternal());
  }, [open]);

  // Web 版与桌面/移动版的更新形态不同：Web=刷新加载服务器新静态文件；
  // 桌面=in-app 下载并安装；**Android=下载 APK 交给系统**（见下面的「下载 APK」分支）。
  const isWeb = !isDesktop();
  const isAndroidDevice = isWeb ? false : isMobileUserAgent(navigator.userAgent);
  /** 有 Rust 内核的壳（桌面 + Android/iOS）：清单走 native reqwest 拉取（绕 CORS）。 */
  const nativeManifest = () => (isDesktop() ? fetchUpdateManifestNative() : fetchUpdateManifest());

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
    setAndroidApkUrl(null);
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
      const mf = await nativeManifest();
      setReleaseNotes(mf?.notes ?? null);
      setAndroidApkUrl(mf?.android_url ?? null);
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
        setCheckError(`未取到 version.json：${r.error ?? "离线或未部署"}`);
      }
      setChecked(true);
      setChecking(false);
      return;
    }
    // Android：**不接**桌面那套 in-app 下载安装（`tauri-plugin-updater` 只在桌面可用，
    // 且移动端装包要经系统安装器）。这里只做两件事：比对清单版本号 + 取出 APK 地址，
    // 有新版就给「下载 APK」入口，交给系统浏览器/DownloadManager 下载，用户自行安装。
    // 清单里没有 android-aarch64（老清单）时 androidApkUrl 为 null ⇒ 退回「前往发布页」。
    if (isAndroidDevice) {
      const mf = await fetchUpdateManifestNative();
      const latest = mf?.version ?? null;
      setLatestVersion(latest);
      setUpdateState(updateStatus(latest, APP_VERSION));
      setReleaseNotes(mf?.notes ?? null);
      setAndroidApkUrl(mf?.android_url ?? null);
      if (!latest) setCheckError("未取到发布清单：离线或发布通道不可达");
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
      const mf = await nativeManifest();
      if (mf?.notes) setReleaseNotes(mf.notes);
    } else {
      const mf = await nativeManifest();
      const latest = mf?.version ?? null;
      console.error("[updater] desktop updater unavailable; fallback latest ->", latest);
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
          <div className="about-name">{APP_NAME}</div>
          <div className="about-meta">
            <span className="about-pill about-pill-version">v{APP_VERSION}</span>
            <span className="about-pill about-pill-license">{APP_LICENSE}</span>
          </div>
        </div>

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
                  ) : isAndroidDevice ? (
                    // Android：不在这里装包——把 APK 地址交给系统（浏览器/DownloadManager），
                    // 下载完由用户自己安装（安装签名由 Android 系统安装器校验）。
                    <>
                      {androidApkUrl ? (
                        <button className="about-update-install" onClick={() => openExternal(androidApkUrl)}>
                          下载 APK
                        </button>
                      ) : (
                        <button className="about-update-later" onClick={() => openExternal(RELEASES_URL)}>前往发布页</button>
                      )}
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
                {/*
                  发行说明：以前只有「桌面 + 有下载句柄」才显示（条件里含 download），
                  Android 上 download 永远是空 ⇒ 明明拿到了 notes 却不显示。现在按
                  「有 notes 且没点稍后」显示；顺带修掉 Android 上的这一条。
                */}
                {!isWeb && !declined && releaseNotes && (
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
              className={`ui-toggle ${allowExternal ? "on" : ""}`}
              onClick={() => toggleExternal(!allowExternal)}
            >
              <span className="ui-toggle-knob" />
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
