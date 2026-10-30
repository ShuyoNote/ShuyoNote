// ⭐ M2e：空间包两个入口（按钮式，不新增浮层；成功/失败都走现成 toast）。
import { useState } from "react";
import { toast } from "../store/toast";
import { useSpaceStore } from "../store/space";
import { exportWorkspaceAsSpacePackage, importSpacePackageFromDialog, type TransferOutcome } from "../lib/docSpacePackTransfer";

export function SpacePackageActions() {
  const [busy, setBusy] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);

  const run = async (fn: () => Promise<TransferOutcome>) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fn();
      if (r.cancelled) {
        setWarnings([]);
        return;
      }
      setWarnings(r.warnings ?? []);
      toast(r.message, r.ok ? "success" : "error");
      if (r.ok && r.spaceId) {
        await useSpaceStore.getState().load();
        await useSpaceStore.getState().switchTo(r.spaceId);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-package-actions" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", position: "relative" }}>
      <button
        type="button"
        className="btn btn-ghost spa-wide"
        style={{ minHeight: 44 }}
        disabled={busy}
        title="导出当前空间为 .shuyospace"
        onClick={() => void run(exportWorkspaceAsSpacePackage)}
      >
        导出空间包
      </button>
      <button
        type="button"
        className="btn btn-ghost spa-wide"
        style={{ minHeight: 44 }}
        disabled={busy}
        title="从 .shuyospace 导入到新空间"
        onClick={() => void run(importSpacePackageFromDialog)}
      >
        导入空间包
      </button>

      <button
        type="button"
        className="spa-more"
        aria-label="空间包操作"
        aria-expanded={menuOpen}
        disabled={busy}
        onClick={() => setMenuOpen((v) => !v)}
      >
        ⋯
      </button>
      {menuOpen && (
        <div className="spa-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={() => {
              setMenuOpen(false);
              void run(exportWorkspaceAsSpacePackage);
            }}
          >
            导出空间包
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={() => {
              setMenuOpen(false);
              void run(importSpacePackageFromDialog);
            }}
          >
            导入空间包
          </button>
        </div>
      )}
      {warnings.length > 0 && (
        <span className="space-package-warnings" role="status" style={{ color: "var(--text-muted, #888)", fontSize: 12 }}>
          {warnings.map((w) => (
            <span key={w} style={{ display: "block" }}>
              ⚠ {w}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}
