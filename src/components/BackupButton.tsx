import { open, save } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import { useNotes } from "../store/notes";

export function BackupButton() {
  const { loadPages } = useNotes();

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

  const doImport = async () => {
    try {
      const path = await open({
        title: "选择备份文件",
        filters: [{ name: "ZIP", extensions: ["zip"] }],
        multiple: false,
      });
      if (!path) return;
      if (!confirm("导入将覆盖当前全部数据（页面、标签、附件），且不可撤销。确定继续？")) return;
      await api.importBackup(path as string);
      await loadPages();
      alert("备份导入完成");
    } catch (e) {
      alert(`导入失败：${e}`);
    }
  };

  return (
    <div className="backup-menu">
      <button className="btn-backup" onClick={doExport} title="导出整库备份">
        备份
      </button>
      <button className="btn-import" onClick={doImport} title="从备份恢复">
        恢复
      </button>
    </div>
  );
}
