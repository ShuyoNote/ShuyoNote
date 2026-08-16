import { save } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";

export function BackupButton() {
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
      alert(`备份完成：${result.path}\n大小 ${(result.size / 1024).toFixed(1)} KB`);
    } catch (e) {
      alert(`导出失败：${e}`);
    }
  };

  return (
    <button className="btn-backup" onClick={doExport} title="导出整库备份">
      备份
    </button>
  );
}
