import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import { usePopover } from "../hooks/usePopover";
import { api } from "../lib/api";
import { useNotes } from "../store/notes";
import { toast } from "../store/toast";
import { DownloadIcon, UploadIcon } from "./icons";

export function BackupButton() {
  const { loadPages } = useNotes();
  const { open: openMenu, pos, triggerRef, contentRef, toggle, close } = usePopover<HTMLButtonElement>();

  const doExport = async () => {
    try {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const path = await save({
        title: "导出备份",
        defaultPath: `shuyonote-backup-${stamp}.zip`,
        filters: [{ name: "ZIP", extensions: ["zip"] }],
      });
      if (!path) return;
      const result = await api.exportBackup(path);
      toast(`备份完成：大小 ${(result.size / 1024).toFixed(1)} KB`, "success");
    } catch (e) {
      toast(`导出失败：${e}`, "error");
    }
  };

  const doImport = async () => {
    try {
      const path = await open({
        title: "选择备份文件",
        filters: [{ name: "ZIP", extensions: ["zip"] }],
        multiple: false,
      });
      if (!path) return;
      if (!(await confirm("导入将覆盖当前全部数据（页面、标签、附件），且不可撤销。确定继续？"))) return;
      await api.importBackup(path as string);
      await loadPages();
      toast("备份导入完成", "success");
    } catch (e) {
      toast(`导入失败：${e}`, "error");
    }
  };

  return (
    <div className="backup-menu">
      <button
        ref={triggerRef}
        className="btn-backup"
        onClick={toggle}
        title="备份 / 恢复"
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
            导出备份
          </button>
          <button
            onClick={() => {
              close();
              doImport();
            }}
          >
            <UploadIcon width={14} height={14} />
            从备份恢复
          </button>
        </div>
      )}
    </div>
  );
}
