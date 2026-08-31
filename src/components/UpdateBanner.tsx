import { useEffect, useState } from "react";
import { useEditorStore } from "../store/editor";
import { APP_VERSION } from "../lib/links";
import { isDesktop } from "../lib/useUpdateChecker";

// Top banner shown when a newer version is detected. It sits in the app's layout
// flow (so it pushes the content down instead of covering the toolbar). The
// dismiss is remembered per-version: the same version won't nag again, but a NEW
// version re-shows it until the user refreshes / updates.
export function UpdateBanner() {
  const updateAvailable = useEditorStore((s) => s.updateAvailable);
  const latest = useEditorStore((s) => s.latestVersion);
  const [dismissed, setDismissed] = useState(false);

  // Reset the dismissed flag whenever the target version changes (new version →
  // re-check its own localStorage key).
  useEffect(() => {
    setDismissed(false);
    if (latest) {
      try { setDismissed(localStorage.getItem(`shuyo:update-banner:${latest}`) === "1"); } catch {}
    }
  }, [latest]);

  if (!updateAvailable || !latest || dismissed) return null;

  const isWeb = !isDesktop();
  const dismiss = () => {
    setDismissed(true);
    if (latest) {
      try { localStorage.setItem(`shuyo:update-banner:${latest}`, "1"); } catch {}
    }
  };

  return (
    <div className="update-banner" role="status">
      <span className="update-banner-icon" aria-hidden="true">🔔</span>
      <span className="update-banner-text">
        发现新版本 <b>v{latest}</b>，当前 v{APP_VERSION}
      </span>
      {isWeb ? (
        <button className="update-banner-action" onClick={() => window.location.reload()}>
          刷新页面
        </button>
      ) : (
        <button className="update-banner-action" onClick={() => useEditorStore.getState().openAbout()}>
          查看更新
        </button>
      )}
      <button className="update-banner-close" onClick={dismiss} aria-label="关闭">
        ×
      </button>
    </div>
  );
}
