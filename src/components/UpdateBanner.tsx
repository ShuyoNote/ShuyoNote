import { useState } from "react";
import { useEditorStore } from "../store/editor";
import { APP_VERSION } from "../lib/links";
import { isDesktop } from "../lib/useUpdateChecker";

// Top banner shown when a newer version is detected (Web = refresh to load the new
// deployed bundle; Desktop = open the About dialog to install). Dismissible for the
// current session; it naturally reappears while a newer version is still outstanding
// (until the user refreshes / updates).
export function UpdateBanner() {
  const updateAvailable = useEditorStore((s) => s.updateAvailable);
  const latest = useEditorStore((s) => s.latestVersion);
  const [dismissed, setDismissed] = useState(false);
  if (!updateAvailable || !latest || dismissed) return null;
  const isWeb = !isDesktop();
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
      <button className="update-banner-close" onClick={() => setDismissed(true)} aria-label="关闭">
        ×
      </button>
    </div>
  );
}
