import { useEffect, useRef, useState } from "react";
import { platform } from "../lib/platform";
import { usePopover } from "../hooks/usePopover";
import { useOverlayScrollLock } from "../hooks/useOverlayScrollLock";
import { useOverlayLayer } from "../hooks/useOverlayLayer";
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

// `label` 为空时渲染成侧栏那种小图标按钮；给了 label 就渲染成带文字的按钮，
// 供设置中心「数据」页使用——同一份备份/恢复逻辑，两种外壳，不复制实现。
export function BackupButton({ label }: { label?: string } = {}) {
  const { open: openMenu, pos, isSheet, triggerRef, contentRef, toggle, close } = usePopover<HTMLButtonElement>();
  useOverlayScrollLock(openMenu);
  // Android 返回键：优先关掉最上层浮层（见 lib/overlayStack.ts）。
  useOverlayLayer("backupMenu", openMenu, () => close());
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
      // ⭐⭐ **2026-10-19（owner：「全库备份的名称不对吧：shuyonote-数友标尺-…？（怎么带上了空间名称？）」）**：
      //   ⛔ 旧实现拿**当前活动空间的名字**（`api.getWorkspaceName()`）拼文件名 ✗ ——
      //   而这条命令（`export_backup`）导的是**整机全库**：`meta.db` ＋ **所有**空间库 ＋ 附件 ✓
      //   ⇒ 名字里出现「数友标尺」会让人以为"只备份了这一个空间" ✗（误导，不是小瑕疵 ✓）。
      //   ⇒ 改成中性名 `shuyonote-backup-<本地时刻>.zip`（与自动备份同前缀，一眼看得出是整套 ✓）。
      //   ⚠️ 时刻也换成**本地时间**：旧实现用 `toISOString()` ⇒ 北京时间 10:50 被写成 `02-50` ✗（差 8 小时）。
      const d = new Date();
      const p = (n: number) => String(n).padStart(2, "0");
      const stamp =
        `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
        `-${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
      const path = await platform.dialog.save({
        title: "导出备份",
        defaultPath: `shuyonote-backup-${stamp}.zip`,
        filters: [{ name: "ZIP", extensions: ["zip"] }],
      });
      if (!path) return;
      setBusying("正在导出备份…");
      const result = await api.exportBackup(path);
      try { localStorage.setItem("shuyonote:lastBackupAt", String(Date.now())); } catch { /* ignore */ }
      // ★ 少导了东西就必须明说（E1 下加密空间未解锁时就是这种情况）：给一个绿字
      //   「备份完成」会把用户哄过去，等到他要恢复时才发现少了空间。
      const skipped = result.skipped ?? [];
      if (skipped.length > 0) {
        toast(`备份完成，但有 ${skipped.length} 个空间没包含进去：${skipped.join("；")}`, "error");
      } else {
        toast(`备份完成：大小 ${(result.size / 1024).toFixed(1)} KB`, "success");
      }
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
      if (!(await confirmDialog({ title: "导入备份", message: "导入会把备份中的空间合并进来（作为新空间，不覆盖现有空间），附件按内容去重。确定继续？" }))) return;
      setBusying("正在导入备份…");
      const res = await api.importBackup(path as string);
      // loadPages 是 store 动作（引用恒定）：本组件不读 notes 的 state，走 getState() 现取。
      await useNotes.getState().loadPages();
      // Reload workspaces so the sidebar space name/list react to the imported
      // spaces (import_backup registers them in meta; it never overwrites).
      useSpaceStore.getState().load();
      toast(
        res.renamed > 0
          ? `备份导入完成：新增 ${res.imported} 个空间（其中 ${res.renamed} 个与现有冲突，已作为新空间导入）`
          : `备份导入完成：新增 ${res.imported} 个空间`,
        "success",
      );
    } catch (e) {
      toast(`导入失败：${e}`, "error");
    } finally {
      clearBusy();
    }
  };

  /** ⭐ **2026-10-28（owner：「本机备份 全空间打包，要能原样恢复」）**：
   *  **替换式**恢复 —— 与「导入（合并）」是两条不同的动作：
   *  · 合并：作为新空间导入、重名改 id、附件去重、meta 不动；
   *  · 原样恢复：整份替换（全部空间＋附件＋meta），**下次启动生效**；旧数据先另存到 `restore-prev-…/`。 */
  const doRestoreReplace = async () => {
    try {
      const path = await platform.dialog.open({
        title: "选择全库备份（原样恢复）",
        filters: [{ name: "ZIP", extensions: ["zip"] }],
        multiple: false,
      });
      if (!path) return;
      if (
        !(await confirmDialog({
          title: "原样恢复（替换）",
          message:
            "会用这份备份**替换**当前的所有数据（全部空间 ＋ 附件 ＋ 元数据），并**在下次启动时生效**。\n" +
            "当前数据不会删：会整份另存到应用数据目录的 restore-prev-…/。\n确定继续？",
        }))
      ) {
        return;
      }
      setBusying("正在准备原样恢复…");
      const res = await api.restoreBackupReplace(path as string);
      toast(res.note, "success");
    } catch (e) {
      toast(`原样恢复失败：${e}`, "error");
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
        className={label ? "set-btn" : "btn-backup"}
        onClick={toggle}
        title="备份 / 恢复"
        disabled={busy}
      >
        {label ?? <DownloadIcon />}
      </button>
      {openMenu && (
        <div ref={contentRef} className={`backup-dropdown${isSheet ? " is-sheet" : ""}`} style={{ top: pos.top, left: pos.left }}>
          <button
            onClick={() => {
              close();
              doExport();
            }}
          >
            <UploadIcon width={14} height={14} />
            导出完整备份（全库）
          </button>
          <button
            onClick={() => {
              close();
              doImport();
            }}
          >
            <DownloadIcon width={14} height={14} />
            导入备份（合并，不覆盖现有空间）
          </button>
          {/* ⭐ 2026-10-28（owner：「要能原样恢复」）：替换式恢复 —— 重启生效，旧数据另存一份 */}
          <button
            onClick={() => {
              close();
              doRestoreReplace();
            }}
            data-testid="restore-replace"
          >
            <DownloadIcon width={14} height={14} />
            原样恢复（替换全部数据，重启生效）
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

      {/* ⚠️⭐ **2026-10-11 搬走**：「自动备份」那一格原来挂在这里（原先是 `{label && <本面板 />}` ✗）——
          而这里是 `.backup-menu` 的**内部** ⇒ ⭐ 那个 wrapper 的 max-content 被整块面板撑到 **590px** ✗
          ⇒ CDP 实测同一行里 `.set-row-text` 的宽**恰好是 0** ⇒ 「备份 / 恢复（全库）」与那句说明
          **一个字一列** ✗（owner 截图 ✓）。⇒ ⭐ 改由**页面**在**行外**挂它（`SettingsDialog` ✓）：
          一行＝"左文字 ＋ 右按钮"，面板是它下面**另一块** ✓。⛔ 别再塞回 `.backup-menu` 里 ✗ ——
          判据就是那两条量出来的宽（`set-row-text` 不许是 0 ✗ ／ `.backup-menu` 不许是 590 ✗），
          外加 `BackupSettingsPanel.test.ts` 的接线收据（它钉的就是"这文件里不许再出现那个组件"✓）。
          ⚠️ 注释里**故意不写**那个组件的 JSX 字面写法 ⇒ 否则那条收据会被这段解释文字绊倒 ✗（踩过）。 */}
    </div>
  );
}
