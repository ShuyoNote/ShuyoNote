import { useEffect, useRef, useState } from "react";
import { platform } from "../lib/platform";
import { usePopover } from "../hooks/usePopover";
import { api } from "../lib/api";
import { useNotes } from "../store/notes";
import { useSpaceStore } from "../store/space";
import { toast } from "../store/toast";
import { confirmDialog } from "../store/confirm";
import { DownloadIcon, UploadIcon } from "./icons";

type BackupProgress = {
  phase: string;
  done: number;
  total: number;
  bytes: number;
  message: string;
};

export function BackupButton() {
  const { loadPages } = useNotes();
  const { open: openMenu, pos, triggerRef, contentRef, toggle, close } = usePopover<HTMLButtonElement>();
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState("");
  const [prog, setProg] = useState<BackupProgress | null>(null);
  const busyRef = useRef(false);

  // Live progress emitted by the backend during export/import.
  useEffect(() => {
    const un = platform.event.listen<BackupProgress>("backup-progress", (e) => setProg(e.payload));
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  const setBusying = (label: string) => {
    busyRef.current = true;
    setBusy(true);
    setBusyLabel(label);
    setProg(null);
  };
  const clearBusy = () => {
    busyRef.current = false;
    setBusy(false);
    setBusyLabel("");
    setProg(null);
  };

  const doExport = async () => {
    try {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      let spaceName = "backup";
      try {
        spaceName = (await api.getWorkspaceName()) || "backup";
      } catch {
        /* keep default */
      }
      // Sanitize for a filename (strip path-invalid chars, collapse spaces).
      const safe = spaceName
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
        .replace(/\s+/g, "-")
        .trim()
        .slice(0, 40);
      const path = await platform.dialog.save({
        title: "导出备份",
        defaultPath: `shuyonote-${safe || "space"}-${stamp}.zip`,
        filters: [{ name: "ZIP", extensions: ["zip"] }],
      });
      if (!path) return;
      setBusying("正在导出备份…");
      const result = await api.exportBackup(path);
      toast(`备份完成：大小 ${(result.size / 1024).toFixed(1)} KB`, "success");
    } catch (e) {
      toast(`导出失败：${e}`, "error");
    } finally {
      clearBusy();
    }
  };

  const doImport = async () => {
    try {
      const path = await platform.dialog.open({
        title: "选择备份文件",
        filters: [{ name: "ZIP", extensions: ["zip"] }],
        multiple: false,
      });
      if (!path) return;
      if (!(await confirmDialog({ title: "导入备份", message: "导入将覆盖当前全部数据（页面、标签、附件），且不可撤销。确定继续？", danger: true }))) return;
      setBusying("正在导入备份…");
      await api.importBackup(path as string);
      await loadPages();
      // Reload workspaces so the sidebar space name/list react to the restored DB
      // (import_backup may have changed the active workspace identity).
      useSpaceStore.getState().load();
      toast("备份导入完成", "success");
    } catch (e) {
      toast(`导入失败：${e}`, "error");
    } finally {
      clearBusy();
    }
  };

  // Determine progress percent (indeterminate when total == 0).
  const pct = prog && prog.total > 0 ? Math.min(100, Math.round((prog.done / prog.total) * 100)) : null;

  return (
    <div className="backup-menu">
      <button
        ref={triggerRef}
        className="btn-backup"
        onClick={toggle}
        title="备份 / 恢复"
        disabled={busy}
      >
        <DownloadIcon />
      </button>
      {openMenu && (
        <div ref={contentRef} className="backup-dropdown" style={{ top: pos.top, left: pos.left }}>
          <button
            onClick={() => {
              close();
              doExport();
            }}
          >
            <DownloadIcon width={14} height={14} />
            导出完整备份（全库）
          </button>
          <button
            onClick={() => {
              close();
              doImport();
            }}
          >
            <UploadIcon width={14} height={14} />
            从备份恢复（覆盖全库）
          </button>
        </div>
      )}

      {busy && (
        <div className="backup-progress">
          <div className="backup-progress-label">
            <span>{busyLabel}{prog ? ` · ${prog.message}` : ""}</span>
            {pct !== null && <span>{pct}%</span>}
          </div>
          <div className="backup-progress-track">
            <div
              className={`backup-progress-fill${pct === null ? " indeterminate" : ""}`}
              style={pct !== null ? { width: `${pct}%` } : undefined}
            />
          </div>
        </div>
      )}
    </div>
  );
}
